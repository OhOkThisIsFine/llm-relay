import { relayStatePath } from "../state-paths.js";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { PingRecord } from "./metrics.js";
import { WriteBehindTimer } from "../write-behind.js";
import { mergeQuotaObservations, type QuotaObservation } from "../quota-observation.js";

export const DEFAULT_PROBE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const BROKEN_PROBE_BACKOFF_BASE_MS = 60_000;
/**
 * Bumped to 3 when probe quota changed from an ambiguous scalar percentage to typed observations.
 * A version mismatch marks a model due for probing (see `getModelsDueForProbe`), so old entries
 * refill naturally instead of migrating a scalar whose axis and period were already lost.
 */
export const CURRENT_PROBE_VERSION = 3;

/**
 * How many recent probes are kept per model.
 *
 * p95 and jitter need a DISTRIBUTION, so a rolling window is unavoidable; `totals` below carries
 * the long-run figures the window drops. 25 keeps a full roster's cache in the low hundreds of KB.
 */
export const MAX_SAMPLES = 25;

/**
 * Long-run counters that OUTLIVE the rolling window.
 *
 * The window answers "how does this model behave lately"; these answer "how has it behaved since
 * we first saw it". Keeping both is what stops a single bad afternoon from erasing a model's
 * record — and what makes uptime mean something after a restart.
 */
export interface ProbeTotals {
  probes: number;
  ok: number;
  sumMs: number;
  firstProbedAt: number;
}

export interface ProbeEntry {
  modelId: string;
  status: "ok" | "broken";
  lastProbedAt: number;
  probeVersion: number;
  ms: number;
  code: string;
  quotaObservations: QuotaObservation[];
  /** Rolling window, oldest first. Absent on v1 entries. */
  samples?: PingRecord[];
  /** Cumulative counters. Absent on v1 entries. */
  totals?: ProbeTotals;
}

export interface ProbeCacheData {
  version: number;
  providers: Record<string, { models: Record<string, ProbeEntry> }>;
}

export function getProbeCachePath(): string {
  // ⚠ Under vitest, never touch the developer's real cache. Any test that exercises `PingLoop`
  // calls `recordProbeResult`, and the user's file was found holding `openai_mock` /
  // `mock-model-a` entries written by the suite — test fixtures polluting live health data that
  // the router then ranks on. Tests needing persistence pass an explicit `path`.
  if (process.env.VITEST) return join(tmpdir(), "llm-relay-vitest", "probe-cache.json");
  const baseDir = relayStatePath("cache");
  return join(baseDir, "probe-cache.json");
}

function emptyCache(): ProbeCacheData {
  return { version: CURRENT_PROBE_VERSION, providers: {} };
}

let _cache: ProbeCacheData | null = null;
let _cachePath: string | null = null;
const _writeBehind = new WriteBehindTimer();

export function loadProbeCache(opts: { path?: string; reload?: boolean } = {}): ProbeCacheData {
  const target = opts.path ?? getProbeCachePath();
  if (!opts.reload && _cache && _cachePath === target) return _cache;
  _cachePath = target;

  try {
    const raw = readFileSync(target, "utf8");
    const parsed = JSON.parse(raw) as ProbeCacheData;
    if (parsed && typeof parsed === "object" && parsed.providers) {
      _cache = parsed;
      return parsed;
    }
  } catch {
    /* No cache or parse error */
  }

  _cache = emptyCache();
  return _cache;
}

export function flushProbeCache(opts: { path?: string; cache?: ProbeCacheData } = {}): void {
  const target = opts.path ?? _cachePath ?? getProbeCachePath();
  const cacheData = opts.cache ?? _cache ?? emptyCache();
  if (!opts.path) _writeBehind.clear();

  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmpPath = `${target}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(cacheData, null, 2) + "\n", "utf8");
    renameSync(tmpPath, target);
  } catch {
    /* best-effort persistence */
  }
}

function scheduleProbeCacheFlush(): void {
  const target = _cachePath ?? getProbeCachePath();
  const cache = _cache ?? emptyCache();
  _writeBehind.touch(() => flushProbeCache({ path: target, cache }));
}

function trailingBrokenSamples(entry: ProbeEntry): number {
  let count = 0;
  for (let i = (entry.samples?.length ?? 0) - 1; i >= 0; i--) {
    if (entry.samples?.[i]?.code === "200") break;
    count++;
  }
  return Math.max(1, count);
}

export function getModelsDueForProbe(
  providerKey: string,
  modelIds: string[],
  opts: {
    ttlMs?: number;
    now?: number;
    probeVersion?: number;
    path?: string;
    lastSuccessfulCallAt?: (modelId: string) => number | null;
  } = {},
): string[] {
  const ttlMs = opts.ttlMs ?? DEFAULT_PROBE_TTL_MS;
  const now = opts.now ?? Date.now();
  const probeVersion = opts.probeVersion ?? CURRENT_PROBE_VERSION;
  const cache = opts.path ? loadProbeCache({ path: opts.path }) : (_cache ?? loadProbeCache());

  const providerBucket = cache.providers[providerKey];
  const models = providerBucket?.models ?? {};

  const due: string[] = [];
  for (const id of modelIds) {
    const entry = models[id];
    const passiveSuccessAt = opts.lastSuccessfulCallAt?.(id) ?? null;
    if (!entry) {
      // A real successful call proves availability even before the first synthetic probe. The
      // probe can wait until that passive observation becomes stale.
      if (passiveSuccessAt === null || now - passiveSuccessAt >= ttlMs) due.push(id);
      continue;
    }
    if (entry.probeVersion !== probeVersion) {
      due.push(id);
      continue;
    }
    // A successful real request after the last synthetic failure is stronger evidence than the
    // probe. It resets freshness without needing a redundant write to the probe cache.
    if (passiveSuccessAt !== null && passiveSuccessAt > entry.lastProbedAt) {
      if (now - passiveSuccessAt >= ttlMs) due.push(id);
      continue;
    }
    if (entry.status === "broken") {
      const failures = trailingBrokenSamples(entry);
      const delay = Math.min(ttlMs, BROKEN_PROBE_BACKOFF_BASE_MS * 2 ** Math.min(10, failures - 1));
      if (now - entry.lastProbedAt >= delay) due.push(id);
      continue;
    }
    if (now - entry.lastProbedAt >= ttlMs) due.push(id);
  }
  return due;
}

export function recordProbeResult(
  providerKey: string,
  modelId: string,
  result: { code: string; ms: number; quotaObservations: QuotaObservation[] },
  opts: { now?: number; probeVersion?: number; path?: string } = {},
): ProbeEntry {
  const now = opts.now ?? Date.now();
  const probeVersion = opts.probeVersion ?? CURRENT_PROBE_VERSION;
  const cache = opts.path ? loadProbeCache({ path: opts.path }) : (_cache ?? loadProbeCache());

  if (!cache.providers[providerKey]) {
    cache.providers[providerKey] = { models: {} };
  }

  // A 401 is NOT ok. It used to count as ok here on the theory that the endpoint answered,
  // but `status` feeds `getModelsDueForProbe`, so a provider whose key was revoked stopped
  // being re-probed and kept reading as available — able to outrank a working target.
  // Reachability is not availability; only a 2xx (normalised to "200" by pingProviderModel)
  // proves this model will actually serve a request.
  const isOk = result.code === "200";
  const prev = cache.providers[providerKey]!.models[modelId];
  cache.version = CURRENT_PROBE_VERSION;

  // Append to the rolling window rather than replacing the single sample a v1 entry held.
  // One probe cannot describe latency: p95, jitter and spike rate are distribution statistics,
  // and a scalar `ms` made every one of them a restatement of the most recent request.
  // ⚠ Guard the WRITE side, not only the read helpers. `loadProbeCache` validates shallowly, so a
  // corrupt `samples` survives the load; spreading a string here would turn it into an array of
  // single characters and write that back as measurements. The read guard cannot recover from that
  // — by then the corruption IS an array. Degrade to empty: this cache is re-learnable.
  const prevSamples = Array.isArray(prev?.samples) ? prev.samples : [];
  const samples = [...prevSamples, { ms: result.ms, code: result.code, timestamp: now }];
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);

  const prevTotals = prev?.totals;
  const totals: ProbeTotals = {
    probes: (prevTotals?.probes ?? 0) + 1,
    ok: (prevTotals?.ok ?? 0) + (isOk ? 1 : 0),
    sumMs: (prevTotals?.sumMs ?? 0) + result.ms,
    firstProbedAt: prevTotals?.firstProbedAt ?? now,
  };

  const entry: ProbeEntry = {
    modelId,
    status: isOk ? "ok" : "broken",
    lastProbedAt: now,
    probeVersion,
    ms: result.ms,
    code: result.code,
    // Each response can mention only one quota axis. Keep older, unrelated tuples instead of
    // presenting partial metadata as a complete account balance.
    quotaObservations: mergeQuotaObservations(prev?.quotaObservations ?? [], result.quotaObservations),
    samples,
    totals,
  };

  cache.providers[providerKey]!.models[modelId] = entry;
  if (opts.path) flushProbeCache({ path: opts.path, cache });
  else scheduleProbeCacheFlush();
  return entry;
}

/**
 * Every persisted sample for a model, oldest first — the history a restarted process needs to
 * avoid starting from zero.
 *
 * `PingLoop` kept its history in an in-memory `Map` and read only that, while `recordProbeResult`
 * wrote to disk and nothing ever read it back. So every restart reset every model to `Pending`
 * with `p95: -1`, and a proxy that restarts (a laptop that sleeps, an upgrade, a crash) never
 * accumulated anything at all. This is the read side that was missing.
 */
export function loadPersistedSamples(
  providerKey: string,
  modelId: string,
  opts: { path?: string } = {},
): PingRecord[] {
  const cache = opts.path ? loadProbeCache({ path: opts.path }) : (_cache ?? loadProbeCache());
  const samples = cache.providers[providerKey]?.models[modelId]?.samples;
  return Array.isArray(samples) ? samples : [];
}

/** Long-run counters for a model, or null when it has never been probed. */
export function loadTotals(
  providerKey: string,
  modelId: string,
  opts: { path?: string } = {},
): ProbeTotals | null {
  const cache = opts.path ? loadProbeCache({ path: opts.path }) : (_cache ?? loadProbeCache());
  const totals = cache.providers[providerKey]?.models[modelId]?.totals;
  // Corrupt totals (non-object or array) degrade to null — re-learnable cache degrades to empty/unknown
  return totals && typeof totals === "object" && !Array.isArray(totals) ? totals as ProbeTotals : null;
}

/**
 * Typed quota observations persisted by the default synthetic probe, or none when this entry is
 * not current. In particular, a v2 scalar `quotaPercent` is intentionally never reconstructed.
 */
export function loadPersistedQuotaObservations(
  providerKey: string,
  modelId: string,
  opts: { path?: string } = {},
): QuotaObservation[] {
  const cache = opts.path ? loadProbeCache({ path: opts.path }) : (_cache ?? loadProbeCache());
  const entry = cache.providers[providerKey]?.models[modelId];
  if (!entry || entry.probeVersion !== CURRENT_PROBE_VERSION) return [];
  return entry.quotaObservations ? [...entry.quotaObservations] : [];
}

/** Every (provider, model) the cache holds samples for — what a restarting PingLoop rehydrates. */
export function persistedModels(opts: { path?: string } = {}): Array<{ provider: string; model: string }> {
  const cache = opts.path ? loadProbeCache({ path: opts.path }) : (_cache ?? loadProbeCache());
  const out: Array<{ provider: string; model: string }> = [];
  for (const [provider, bucket] of Object.entries(cache.providers)) {
    for (const model of Object.keys(bucket.models)) out.push({ provider, model });
  }
  return out;
}
