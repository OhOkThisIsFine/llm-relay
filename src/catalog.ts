import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ProviderConfig } from "./config.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_CACHE = join(homedir(), ".repair-proxy", "models-cache.json");

interface Entry {
  fetchedAt: number;
  models: string[];
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

  constructor(opts: { ttlMs?: number; cachePath?: string | null } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.cachePath = opts.cachePath === undefined ? DEFAULT_CACHE : opts.cachePath;
  }

  private loadDisk(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.cachePath) return;
    try {
      const j = JSON.parse(readFileSync(this.cachePath, "utf8")) as Record<string, Entry>;
      for (const [k, v] of Object.entries(j)) {
        if (v && typeof v.fetchedAt === "number" && Array.isArray(v.models)) this.mem.set(k, v);
      }
    } catch {
      /* no cache yet — first run */
    }
  }

  private saveDisk(): void {
    if (!this.cachePath) return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const obj: Record<string, Entry> = {};
      for (const [k, v] of this.mem) obj[k] = v;
      writeFileSync(this.cachePath, JSON.stringify(obj, null, 2) + "\n");
    } catch {
      /* best-effort cache; never fatal */
    }
  }

  /** Cached model ids for a provider; empty array if fetch fails and no prior cache. */
  private cached(name: string): string[] | undefined {
    this.loadDisk();
    return this.mem.get(name)?.models;
  }

  /**
   * Live model ids for a provider, cached with TTL. `force` bypasses the TTL.
   * Serves a stale cache if the refresh fails; returns [] only if there is no
   * cache AND the fetch fails.
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
    try {
      const models = await this.fetch(cfg, opts.fetchFn ?? fetch);
      this.mem.set(name, { fetchedAt: now, models });
      this.saveDisk();
      return models;
    } catch {
      return prior?.models ?? [];
    }
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

  private async fetch(cfg: ProviderConfig, fetchFn: typeof fetch): Promise<string[]> {
    // Anthropic-kind backends have no OpenAI-style /models list we consume.
    if (cfg.kind !== "openai") return [];
    const key = cfg.authEnv ? process.env[cfg.authEnv]?.trim() : undefined;
    const headers: Record<string, string> = {};
    if (key) {
      if (cfg.authHeader === "authorization") headers["authorization"] = `Bearer ${key}`;
      else headers["x-api-key"] = key;
    }
    const res = await fetchFn(cfg.base + "/models", { headers });
    if (!res.ok) throw new Error(`models fetch HTTP ${res.status}`);
    const j = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (j.data ?? [])
      .map((m) => m.id)
      .filter((s): s is string => typeof s === "string")
      .sort();
  }
}
