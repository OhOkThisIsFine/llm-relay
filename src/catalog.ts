import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ProviderConfig } from "./config.js";
import { buildAuthHeaders, readCredential } from "./authEnv.js";
import { WriteBehindTimer } from "./write-behind.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_CACHE = join(homedir(), ".llm-relay", "models-cache.json");

// Bounds on a /models response (adoption review §1.11). The byte cap is the load-bearing one:
// `AbortSignal.timeout` bounds time, not size, so a fast hostile stream could balloon this
// process within the window. The model-count cap is far above any real roster (OpenRouter lists
// ~500) — it exists only to stop pathological floods of tiny records that fit under the byte cap.
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_MODELS = 5000;
const MAX_MODEL_ID_CHARS = 256;

/** Read a response body with a hard byte ceiling, refusing a stated oversize before reading. */
async function readBoundedBody(res: Response, maxBytes: number): Promise<string> {
  const stated = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(stated) && stated > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`models response states ${stated} bytes; cap is ${maxBytes}`);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    // No stream (a synthetic Response in tests, or an empty body): text() cannot exceed what
    // already exists in memory, and the content-length check above covered the stated size.
    const text = await res.text();
    if (text.length > maxBytes) throw new Error(`models response exceeded the ${maxBytes}-byte cap`);
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`models response exceeded the ${maxBytes}-byte cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Limits a provider publishes about its OWN deployment of a model.
 *
 * Deliberately per-(provider, model): the same model id served by two providers is two different
 * deployments with different ceilings, so one provider's numbers must never be presented as
 * another's. Null means "this provider does not publish it" — NIM's /models returns only
 * id/object/created/owned_by, while Groq and Mistral publish real limits.
 */
export interface ModelLimits {
  contextLength: number | null;
  maxOutputTokens: number | null;
  /** Per-TOKEN price, as published. Per-provider for the same reason limits are. */
  pricePromptPerToken: number | null;
  priceCompletionPerToken: number | null;
}

interface Entry {
  fetchedAt: number;
  models: string[];
  /** model id → limits, for providers that publish them. Absent on older cache files. */
  limits?: Record<string, ModelLimits>;
}

/**
 * Field aliases across OpenAI-compatible `/models` implementations. Kept as a generic alias list
 * rather than a per-provider switch — a new provider that happens to publish `context_window` is
 * picked up with no code change, and no provider name is hardcoded.
 */
const CONTEXT_FIELDS = ["context_length", "context_window", "max_context_length", "max_model_len"];
const MAX_OUTPUT_FIELDS = ["max_completion_tokens", "max_output_length", "max_output_tokens", "max_tokens"];
const PRICE_IN_FIELDS = ["prompt", "input", "input_tokens"];
const PRICE_OUT_FIELDS = ["completion", "output", "output_tokens"];

/** Providers publish prices as numeric STRINGS ("0.00000015") as often as numbers. */
function pickNumber(rec: Record<string, unknown>, fields: string[], allowZero = false): number | null {
  for (const f of fields) {
    const raw = rec[f];
    // `Number("")` and `Number("   ")` are BOTH 0. With `allowZero` (prices, where 0 is a real free
    // tier) a blank published field therefore read as a measured price of zero — a fabricated
    // "this model is free", indistinguishable downstream from a provider that genuinely publishes 0.
    // A field a provider left blank is unpublished, and unpublished stays null.
    if (typeof raw === "string" && raw.trim() === "") continue;
    const v = typeof raw === "string" ? Number(raw) : raw;
    if (typeof v === "number" && Number.isFinite(v) && (allowZero ? v >= 0 : v > 0)) return v;
  }
  return null;
}

/** A figure we actually harvested, or null. A string, a NaN, or a field absent from an older cache
 *  schema is NOT a published number and must never be presented as one. */
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Read limits + pricing out of one `/models` record, including a nested `top_provider` (OpenRouter). */
export function limitsFromRecord(rec: Record<string, unknown>): ModelLimits {
  const obj = (v: unknown) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
  const top = obj(rec.top_provider);
  const pricing = obj(rec.pricing);
  return {
    contextLength: pickNumber(rec, CONTEXT_FIELDS) ?? pickNumber(top, CONTEXT_FIELDS),
    maxOutputTokens: pickNumber(rec, MAX_OUTPUT_FIELDS) ?? pickNumber(top, MAX_OUTPUT_FIELDS),
    // Zero is a real, meaningful price (free tiers) — not "unpublished".
    pricePromptPerToken: pickNumber(pricing, PRICE_IN_FIELDS, true),
    priceCompletionPerToken: pickNumber(pricing, PRICE_OUT_FIELDS, true),
  };
}

/**
 * True when a provider published nothing at all about a model.
 *
 * Tests for "not a number" rather than `=== null`: a record read back from an OLDER cache schema
 * has the newer fields simply absent (`undefined`), and an `=== null` check called that "publishes
 * something", so `limits()` returned an object of undefineds instead of the null its contract
 * promises.
 */
function isEmpty(l: ModelLimits): boolean {
  return ![l.contextLength, l.maxOutputTokens, l.pricePromptPerToken, l.priceCompletionPerToken].some(
    (v) => typeof v === "number",
  );
}

/**
 * Normalize the `limits` map read back off disk.
 *
 * The cache is a FILE — it can be stale from an older schema, half-written, or hand-edited — and
 * `cachedLimits()` feeds the request-path context guardrail. A non-numeric ceiling arriving from
 * disk must degrade to "unknown", never become a figure the proxy reports or enforces.
 */
function sanitizeLimits(raw: unknown): Record<string, ModelLimits> {
  const out: Record<string, ModelLimits> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const r = v as Record<string, unknown>;
    const l: ModelLimits = {
      contextLength: asNumber(r.contextLength),
      maxOutputTokens: asNumber(r.maxOutputTokens),
      pricePromptPerToken: asNumber(r.pricePromptPerToken),
      priceCompletionPerToken: asNumber(r.priceCompletionPerToken),
    };
    if (!isEmpty(l)) out[id] = l;
  }
  return out;
}

/**
 * Live per-provider model catalog — model ids are DISCOVERED from each provider's
 * OpenAI-compatible `/models` endpoint, never hand-maintained. In-memory TTL cache
 * backed by a small on-disk cache so restarts start warm. Fail-open everywhere: a
 * fetch failure serves the last-known list (or an empty one), never blocks routing.
 */
export class ModelCatalog {
  private mem = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly cachePath: string | null;
  private loaded = false;
  /** Providers with a background refresh in flight — dedups stampeding probes. */
  private refreshing = new Set<string>();
  /** In-flight blocking fetches (cold start / forced) — dedups concurrent requests. */
  private pending = new Map<string, Promise<string[]>>();
  private revision = 0;
  private readonly writeBehind: boolean;
  private readonly flushTimer = new WriteBehindTimer();

  constructor(opts: { ttlMs?: number; cachePath?: string | null; writeBehind?: boolean } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.cachePath = opts.cachePath === undefined ? DEFAULT_CACHE : opts.cachePath;
    // Custom paths are normally tests/diagnostics whose callers expect durability on return.
    this.writeBehind = opts.writeBehind ?? opts.cachePath === undefined;
  }

  private loadDisk(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.cachePath) return;
    try {
      const j = JSON.parse(readFileSync(this.cachePath, "utf8")) as Record<string, Entry>;
      for (const [k, v] of Object.entries(j)) {
        if (!v || typeof v.fetchedAt !== "number" || !Array.isArray(v.models)) continue;
        this.mem.set(k, {
          fetchedAt: v.fetchedAt,
          models: v.models.filter((m): m is string => typeof m === "string"),
          limits: sanitizeLimits(v.limits),
        });
        this.revision++;
      }
    } catch {
      /* no cache yet — first run */
    }
  }

  private saveDisk(): void {
    if (!this.cachePath) return;
    this.flushTimer.clear();
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const obj: Record<string, Entry> = {};
      for (const [k, v] of this.mem) obj[k] = v;
      writeFileSync(this.cachePath, JSON.stringify(obj, null, 2) + "\n");
    } catch {
      /* best-effort cache; never fatal */
    }
  }

  private persistSoon(): void {
    if (!this.cachePath) return;
    if (!this.writeBehind) {
      this.saveDisk();
      return;
    }
    this.flushTimer.touch(() => this.saveDisk());
  }

  /** Monotonic in-memory catalog revision used to invalidate routing snapshots cheaply. */
  getRevision(): number {
    this.loadDisk();
    return this.revision;
  }

  /** Force any write-behind catalog update to disk (graceful shutdown / explicit durability). */
  flushPersistence(): void {
    if (this.flushTimer.dirty) this.saveDisk();
  }

  /** Cached model ids for a provider; empty array if fetch fails and no prior cache. */
  private cached(name: string): string[] | undefined {
    this.loadDisk();
    return this.mem.get(name)?.models;
  }

  /** Already-cached model ids for synchronous routing decisions. Never performs network I/O. */
  cachedModels(name: string): string[] {
    return [...(this.cached(name) ?? [])];
  }

  /** Whether a provider has a successfully loaded catalog, including a legitimately empty one. */
  hasCachedCatalog(name: string): boolean {
    this.loadDisk();
    return this.mem.has(name);
  }

  /**
   * Live model ids for a provider, cached with TTL. `force` bypasses the TTL.
   *
   * STALE-WHILE-REVALIDATE: a fresh cache (within TTL) is served directly; a STALE
   * cache is ALSO served immediately while a background refresh updates it — so a
   * discovery/liveness probe (`GET /registry`) NEVER blocks on an upstream refetch.
   * Blocking `await` happens only on a genuine cold start (no prior at all, in memory
   * or on disk). Serves a stale cache if a blocking refresh fails; returns [] only
   * when there is no cache AND the fetch fails. `force` still awaits (explicit refresh).
   */
  async list(
    name: string,
    cfg: ProviderConfig,
    opts: { force?: boolean; now?: number; fetchFn?: typeof fetch } = {},
  ): Promise<string[]> {
    this.loadDisk();
    const now = opts.now ?? Date.now();
    const prior = this.mem.get(name);
    if (!opts.force && prior && now - prior.fetchedAt < this.ttlMs) return prior.models;
    // Stale cache present: serve it now, refresh in the background. A probe must
    // never pay a multi-second upstream fan-probe just because the TTL lapsed.
    if (!opts.force && prior) {
      this.refreshInBackground(name, cfg, opts.fetchFn);
      return prior.models;
    }
    // Cold (no prior) or forced: block once to obtain / renew the list. Deduplicate in-flight fetches.
    const existing = this.pending.get(name);
    if (existing) return existing;

    const p = (async () => {
      try {
        const { models, limits } = await this.fetch(name, cfg, opts.fetchFn ?? fetch);
        this.mem.set(name, { fetchedAt: now, models, limits });
        this.revision++;
        this.persistSoon();
        return models;
      } catch {
        return prior?.models ?? [];
      } finally {
        this.pending.delete(name);
      }
    })();
    this.pending.set(name, p);
    return await p;
  }

  /**
   * Fire-and-forget catalog refresh for a stale provider, deduped so repeated probes
   * during one refresh window spawn at most one upstream fetch. A failed refresh
   * leaves the stale entry in place (fail-open); it is retried on the next `list`.
   */
  private refreshInBackground(name: string, cfg: ProviderConfig, fetchFn?: typeof fetch): void {
    if (this.refreshing.has(name)) return;
    this.refreshing.add(name);
    void (async () => {
      try {
        const { models, limits } = await this.fetch(name, cfg, fetchFn ?? fetch);
        this.mem.set(name, { fetchedAt: Date.now(), models, limits });
        this.revision++;
        this.persistSoon();
      } catch {
        /* keep the stale entry; next list retries */
      } finally {
        this.refreshing.delete(name);
      }
    })();
  }

  /**
   * Whether a provider serves a model. Returns null when the catalog is
   * unavailable (no cache and fetch failed) — callers treat null as "unknown,
   * proceed" so routing never hard-fails on a catalog miss.
   */
  async has(
    name: string,
    cfg: ProviderConfig,
    model: string,
    opts: { force?: boolean; now?: number; fetchFn?: typeof fetch } = {},
  ): Promise<boolean | null> {
    const models = await this.list(name, cfg, opts);
    if (models.length === 0 && !this.cached(name)) return null;
    return models.includes(model);
  }

/**
   * Already-cached limits for a model — synchronous, never fetches.
   *
   * For the request hot path, where a blocking upstream fetch to learn a context window would be a
   * worse outcome than simply not enforcing a guardrail on the first request. Returns null until
   * the catalog has been warmed (startup does that), which callers must treat as "unknown".
   */
  cachedLimits(name: string, model: string): ModelLimits | null {
    this.loadDisk();
    const l = this.mem.get(name)?.limits?.[model];
    return l && !isEmpty(l) ? l : null;
  }

  /**
   * Limits this provider publishes for one of its own models, or null when it publishes none.
   *
   * Null is meaningful and must not be papered over with another provider's number — see
   * `resolveMetadata()` in metadata.ts, which decides what to fall back to and labels it.
   */
  async limits(
    name: string,
    cfg: ProviderConfig,
    model: string,
    opts: { force?: boolean; now?: number; fetchFn?: typeof fetch } = {},
  ): Promise<ModelLimits | null> {
    await this.list(name, cfg, opts);
    const l = this.mem.get(name)?.limits?.[model];
    if (!l) return null;
    return isEmpty(l) ? null : l;
  }

  /** Returned together so concurrent fetches for different providers can never cross-assign
   *  one provider's limits to another's cache entry (which shared mutable state used to allow). */
  private async fetch(
    name: string,
    cfg: ProviderConfig,
    fetchFn: typeof fetch,
  ): Promise<{ models: string[]; limits: Record<string, ModelLimits> }> {
    // Anthropic-kind backends have no OpenAI-style /models list we consume.
    if (cfg.kind !== "openai") return { models: [], limits: {} };
    const key = readCredential(cfg.authEnv, process.env, name);
    const headers: Record<string, string> = buildAuthHeaders(key, cfg.authHeader);
    const signal = cfg.timeoutMs && cfg.timeoutMs > 0 ? AbortSignal.timeout(cfg.timeoutMs) : undefined;
    const res = await fetchFn(cfg.base + "/models", { headers, ...(signal ? { signal } : {}) });
    if (!res.ok) throw new Error(`models fetch HTTP ${res.status}`);
    // A /models response is semi-trusted external content, and this is the one process fronting
    // every client session — `res.json()` buffered unboundedly, so a buggy or hostile endpoint
    // could balloon it within the timeout window (time bounds are not size bounds). Caps
    // fork-validated in freellmapi's model discovery; adoption review §1.11. The failure mode is
    // the same as any fetch error: this provider's catalog degrades, nothing else does.
    const body = await readBoundedBody(res, MAX_CATALOG_BYTES);
    const j = JSON.parse(body) as { data?: Array<Record<string, unknown>> };
    let records = Array.isArray(j.data) ? j.data : [];
    if (records.length > MAX_CATALOG_MODELS) {
      console.warn(
        `llm-relay: ${cfg.base} listed ${records.length} models; keeping the first ${MAX_CATALOG_MODELS}`,
      );
      records = records.slice(0, MAX_CATALOG_MODELS);
    }
    const limits: Record<string, ModelLimits> = {};
    for (const rec of records) {
      if (typeof rec?.id !== "string" || rec.id.length > MAX_MODEL_ID_CHARS) continue;
      const l = limitsFromRecord(rec);
      if (!isEmpty(l)) limits[rec.id] = l;
    }
    const models = records
      .map((m) => m.id)
      .filter((s): s is string => typeof s === "string" && s.length <= MAX_MODEL_ID_CHARS)
      .sort();
    return { models, limits };
  }
}
