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

/** How much a basis is worth as a TIE-BREAK only. Never mixed into the score itself. */
const BASIS_CONFIDENCE: Record<StrengthBasis, number> = { snapshot: 2, telemetry: 1, neutral: 0 };

/** One target with the strength that ranked it, and the provenance of that strength. */
export interface RankedTarget {
  target: ResolvedTarget;
  spec: string;
  strength: Strength;
}

export function specOfTarget(t: ResolvedTarget): string {
  return t.model ? `${t.provider}/${t.model}` : t.provider;
}

/**
 * Rank targets strongest-first, KEEPING the provenance that produced each position.
 *
 * ⚠ The comparator used to read `getStrength(spec).score` and throw the rest away, which made a
 * `neutral` 50 — "nobody publishes anything about this model" — indistinguishable from a `snapshot`
 * 50 measured across five leaderboards (`ARC-31833353`). A provenance-free number was deciding
 * which backend serves a request, the one thing this module exists to prevent.
 *
 * Resolution order:
 *  1. score, highest first — the actual capability estimate, unchanged and never adjusted by basis;
 *  2. on an exact tie, the better-evidenced basis (snapshot > telemetry > neutral);
 *  3. still tied, the larger signal count — a 5-source consensus over a 1-source guess;
 *  4. still tied, config order (`sort` is stable), so a pool's declared order is the last word.
 *
 * Steps 2–3 are tie-breaks, never score adjustments: a model is not penalised for signals nobody
 * publishes, it just loses a coin-flip to one we actually know something about.
 */
export function rankTargetsWithProvenance(targets: ResolvedTarget[]): RankedTarget[] {
  const cache = new Map<string, Strength>();
  const ranked: RankedTarget[] = targets.map((target) => {
    const spec = specOfTarget(target);
    let strength = cache.get(spec);
    if (strength === undefined) {
      strength = getStrength(spec);
      cache.set(spec, strength);
    }
    return { target, spec, strength };
  });

  if (ranked.length <= 1) return ranked;

  return ranked.sort((a, b) => {
    if (b.strength.score !== a.strength.score) return b.strength.score - a.strength.score;
    const cb = BASIS_CONFIDENCE[b.strength.basis];
    const ca = BASIS_CONFIDENCE[a.strength.basis];
    if (cb !== ca) return cb - ca;
    return (b.strength.signalCount ?? 0) - (a.strength.signalCount ?? 0);
  });
}

/** Ranked targets only. Use `rankTargetsWithProvenance` when the caller can report WHY. */
export function rankTargetsByBenchmark(targets: ResolvedTarget[]): ResolvedTarget[] {
  if (targets.length <= 1) return [...targets];
  return rankTargetsWithProvenance(targets).map((r) => r.target);
}
