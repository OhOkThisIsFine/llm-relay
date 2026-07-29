import type { ResolvedTarget } from "./config.js";
import { loadTierData, findTierModel } from "./tier-data.js";
import { getRealWorldScore } from "./ping/runtime-telemetry.js";

/** Where a strength score came from. Ranking is only as trustworthy as its basis. */
export type StrengthBasis = "snapshot" | "telemetry" | "neutral";

export interface Strength {
  /** 0-100, comparable across bases. Higher is better. */
  score: number;
  basis: StrengthBasis;
  /** snapshot only: which signals backed it, and how many. 1 signal is a guess, 5 is a consensus. */
  signals?: string[];
  signalCount?: number;
  /** snapshot only: `fuzzy` means the row belongs to a similarly-named, DIFFERENT model. */
  match?: "exact" | "fuzzy";
  /** snapshot only: the row actually used. */
  matchedName?: string;
}

const NEUTRAL = 50;

/**
 * Strength of one target, from the best evidence available, in this order:
 *
 *  1. the synced multi-source snapshot — real published capability, refreshed by `sync:tiers`;
 *  2. observed runtime telemetry — not capability, but this deployment's own evidence that the
 *     model answers successfully and quickly. Needs ≥5 real calls, so a brand-new model does not
 *     get ranked off one lucky request;
 *  3. neutral — nothing is known, so claim nothing.
 *
 * The basis travels with the score precisely so a telemetry-derived number is never mistaken for
 * a benchmark one.
 *
 * There is deliberately no hardcoded-table rung. `BENCHMARK_DB` used to sit here; every pattern it
 * carried is present in the snapshot, so it contributed nothing but a stale, provenance-free number
 * that outranked the synced data for any model it happened to substring-match.
 */
export function getStrength(spec: string, opts: { telemetryPath?: string } = {}): Strength {
  const hit = findTierModel(spec, loadTierData()?.byNorm ?? []);
  if (hit && typeof hit.rec.strength === "number") {
    return {
      score: Math.round(hit.rec.strength * 1000) / 10, // 0-1 → 0-100
      basis: "snapshot",
      signals: hit.rec.signals ?? [],
      signalCount: hit.rec.signal_count ?? 0,
      match: hit.match,
      matchedName: hit.rec.norm,
    };
  }

  const i = spec.indexOf("/");
  if (i !== -1) {
    const observed = getRealWorldScore(
      spec.slice(0, i),
      spec.slice(i + 1),
      opts.telemetryPath ? { path: opts.telemetryPath } : {},
    );
    if (observed !== null) return { score: observed, basis: "telemetry" };
  }

  return { score: NEUTRAL, basis: "neutral" };
}

/**
 * Rank targets strongest-first. Ties are left in config order (`sort` is stable), which is what
 * makes a pool's declared order the tie-breaker when nothing distinguishes two candidates.
 */
export function rankTargetsByBenchmark(targets: ResolvedTarget[]): ResolvedTarget[] {
  if (targets.length <= 1) return [...targets];

  const specOf = (t: ResolvedTarget) => (t.model ? `${t.provider}/${t.model}` : t.provider);
  const cache = new Map<string, number>();
  const score = (t: ResolvedTarget) => {
    const spec = specOf(t);
    let v = cache.get(spec);
    if (v === undefined) {
      v = getStrength(spec).score;
      cache.set(spec, v);
    }
    return v;
  };

  return [...targets].sort((a, b) => score(b) - score(a));
}
