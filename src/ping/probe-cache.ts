import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_PROBE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const CURRENT_PROBE_VERSION = 1;

export interface ProbeEntry {
  modelId: string;
  status: "ok" | "broken";
  lastProbedAt: number;
  probeVersion: number;
  ms: number;
  code: string;
  quotaPercent: number | null;
}

export interface ProbeCacheData {
  version: number;
  providers: Record<string, { models: Record<string, ProbeEntry> }>;
}

export function getProbeCachePath(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const baseDir = xdg && xdg.trim() ? join(xdg, "llm-relay") : join(homedir(), ".llm-relay");
  return join(baseDir, "probe-cache.json");
}

function emptyCache(): ProbeCacheData {
  return { version: CURRENT_PROBE_VERSION, providers: {} };
}

let _cache: ProbeCacheData | null = null;
let _cachePath: string | null = null;

export function loadProbeCache(opts: { path?: string } = {}): ProbeCacheData {
  const target = opts.path ?? getProbeCachePath();
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

  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmpPath = `${target}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(cacheData, null, 2) + "\n", "utf8");
    renameSync(tmpPath, target);
  } catch {
    /* best-effort persistence */
  }
}

export function getModelsDueForProbe(
  providerKey: string,
  modelIds: string[],
  opts: { ttlMs?: number; now?: number; probeVersion?: number; path?: string } = {},
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
    if (!entry) {
      due.push(id);
      continue;
    }
    if (entry.probeVersion !== probeVersion) {
      due.push(id);
      continue;
    }
    if (entry.status === "broken") {
      due.push(id);
      continue;
    }
    if (now - entry.lastProbedAt >= ttlMs) {
      due.push(id);
      continue;
    }
  }
  return due;
}

export function recordProbeResult(
  providerKey: string,
  modelId: string,
  result: { code: string; ms: number; quotaPercent: number | null },
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
  const entry: ProbeEntry = {
    modelId,
    status: isOk ? "ok" : "broken",
    lastProbedAt: now,
    probeVersion,
    ms: result.ms,
    code: result.code,
    quotaPercent: result.quotaPercent,
  };

  cache.providers[providerKey]!.models[modelId] = entry;
  flushProbeCache({ ...(opts.path ? { path: opts.path } : {}), cache });
  return entry;
}

