import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Access to the synced capability snapshot (`docs/tier-data.json`, written by
 * `npm run sync:tiers` from OpenRouter + BFCL + LMArena + Aider).
 *
 * Its own module so both `registry.ts` (the /registry view) and `benchmarks.ts` (pool ranking)
 * can read it without an import cycle — `config.ts` imports `benchmarks.ts`, so anything
 * `benchmarks.ts` pulls in must not reach back into `config.ts`.
 */
export interface TierModel extends Record<string, unknown> {
  name?: string;
  norm: string;
  sources?: string[];
  strength?: number | null;
  strength_rank?: number | null;
  signals?: string[];
  signal_count?: number;
  /** Fixed-weight capability dimensions, already calibrated to 0-1. */
  dimensions?: Partial<Record<"agentic" | "coding" | "general", number>>;
  direct_dimensions?: string[];
  imputed_dimensions?: string[];
  capability_confidence?: number;
  task_fit_score?: number | null;
  task_fit_signals?: string[];
  task_fit_signal_count?: number;
  /** Capability and behavioral publications combined; used only for the evidence minimum. */
  published_signal_count?: number;
  /** Capability-floor bands materialized by sync, including persisted exit hysteresis. */
  effort_eligibility?: string[];
}

export interface TierData {
  synced_at?: string;
  models: TierModel[];
  /** Lower-cased rows used only for fuzzy containment misses. */
  byNorm: Array<{ norm: string; rec: TierModel }>;
  /** Exact lower-cased SKU lookup. Optional so injected legacy snapshots remain valid. */
  exactByNorm?: ReadonlyMap<string, TierModel>;
  /** File revision behind this snapshot, for routing-cache invalidation. */
  revision?: string;
}

/**
 * Memoized on the file's mtime so `npm run sync:tiers` is picked up without a restart. The file is
 * ~770 rows and three endpoints need it per request; re-reading and re-indexing each time is pure
 * waste. Negative results are cached too, so a missing file is not a stat+throw per request.
 */
export const DEFAULT_TIER_RECHECK_MS = 30_000;

let _cache: { mtimeMs: number | null; checkedAt: number; data: TierData | null } | null = null;

export function loadTierData(
  opts: { now?: number; force?: boolean; recheckMs?: number } = {},
): TierData | null {
  const now = opts.now ?? Date.now();
  const recheckMs = opts.recheckMs ?? DEFAULT_TIER_RECHECK_MS;
  // `sync:tiers` is an operator action, not request traffic. A bounded recheck keeps that action
  // visible without paying a synchronous stat on every routing/candidates/registry call.
  if (!opts.force && _cache && now - _cache.checkedAt < recheckMs) return _cache.data;

  let mtimeMs: number | null = null;
  let path: string;
  try {
    path = fileURLToPath(new URL("../docs/tier-data.json", import.meta.url));
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    if (_cache && _cache.mtimeMs === null) {
      _cache.checkedAt = now;
      return _cache.data;
    }
    _cache = { mtimeMs: null, checkedAt: now, data: null };
    return null;
  }
  if (_cache && _cache.mtimeMs === mtimeMs) {
    _cache.checkedAt = now;
    return _cache.data;
  }

  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { synced_at?: string; models?: TierModel[] };
    const models = Array.isArray(j.models) ? j.models : [];
    const byNorm = models
      .filter((r) => typeof r.norm === "string")
      .map((r) => ({ norm: r.norm.toLowerCase(), rec: r }));
    const data: TierData = {
      ...(j.synced_at ? { synced_at: j.synced_at } : {}),
      models,
      byNorm,
      exactByNorm: new Map(byNorm.map(({ norm, rec }) => [norm, rec])),
      revision: `${mtimeMs}`,
    };
    _cache = { mtimeMs, checkedAt: now, data };
    return data;
  } catch {
    _cache = { mtimeMs, checkedAt: now, data: null };
    return null;
  }
}


export interface TierMatch {
  rec: TierModel;
  /** `fuzzy` means a DIFFERENT model's row whose name contains this one's — indicative, not measured. */
  match: "exact" | "fuzzy";
}

/**
 * Look a routing spec up in the snapshot. Matches on the id's last segment, which is exactly the
 * key `sync-tiers.mjs` stores for OpenRouter models — so a spec like `nim/z-ai/glm-5.2` hits the
 * `glm-5.2` row exactly rather than fuzzily landing on `glm-5.2-max`.
 *
 * Generic over the record type so callers holding looser row shapes (registry's raw
 * leaderboard records) can share this one matcher instead of reimplementing it.
 */
export function findTierModel<T = TierModel>(
  modelId: string,
  byNorm: Array<{ norm: string; rec: T }>,
  exactByNorm?: ReadonlyMap<string, T>,
): { rec: T; match: "exact" | "fuzzy" } | null {
  const seg = (modelId.split("/").pop() ?? modelId).toLowerCase().trim();
  if (!seg) return null;
  // Exact equality is tried FIRST and is deliberately not subject to the length floor below. An id
  // that equals a snapshot key cannot have borrowed a different SKU's row, however short it is —
  // the floor exists to protect the containment path, not this one. Gating it here silently threw
  // away measurements we hold: `o3` and `o1` are real snapshot rows carrying real published
  // signals, and every spec ending in one resolved to "nothing known" instead.
  const exact = exactByNorm?.get(seg) ?? byNorm.find((e) => e.norm === seg)?.rec;
  if (exact) return { rec: exact, match: "exact" };
  // Containment only: a short fragment matches promiscuously (`gpt` would land on whichever
  // `gpt-*` row happens to come first), so below the floor a miss beats a wrong SKU's scores.
  if (seg.length < 5) return null;
  const contained = byNorm.find((e) => e.norm.includes(seg));
  return contained ? { rec: contained.rec, match: "fuzzy" } : null;
}
