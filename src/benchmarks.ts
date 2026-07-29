import type { ResolvedTarget } from "./config.js";
import { loadTierData, findTierModel } from "./tier-data.js";
import { getRealWorldScore } from "./ping/runtime-telemetry.js";

export interface BenchmarkScores {
  sweBench?: number; // SWE-bench Verified pass@1 % (0-100)
  humanEval?: number; // HumanEval pass@1 % (0-100)
  liveCodeBench?: number; // LiveCodeBench score (0-100)
  arenaElo?: number; // Chatbot Arena / coding ELO
}

/**
 * ⚠ LEGACY FALLBACK ONLY — do not add rows here.
 *
 * Hand-typed scores for a 2025-era roster, matched by substring. It was the ONLY ranking input
 * until 0.5.0, which meant pool order came from a table nobody had updated: models it never heard
 * of all collapsed to the flat 50.0 baseline and therefore tied, so `sort` silently fell back to
 * config order. Capability now comes from `docs/tier-data.json` (`npm run sync:tiers`, multi-source,
 * ~770 models); this survives only to score the handful of models no source has published on.
 *
 * It has no provenance: `glm-5` here matches `glm-5.2`, so its numbers can be a different SKU's.
 */
const BENCHMARK_DB: Array<{ pattern: RegExp | string; scores: BenchmarkScores }> = [
  // Anthropic / Claude models
  { pattern: "claude-3-7-sonnet", scores: { sweBench: 70.3, humanEval: 92.0, liveCodeBench: 64.5, arenaElo: 1320 } },
  { pattern: "claude-3-5-sonnet", scores: { sweBench: 49.0, humanEval: 93.7, liveCodeBench: 58.2, arenaElo: 1280 } },
  { pattern: "claude-3-opus", scores: { sweBench: 38.0, humanEval: 84.9, liveCodeBench: 45.0, arenaElo: 1250 } },
  { pattern: "claude-3-5-haiku", scores: { sweBench: 40.6, humanEval: 88.1, liveCodeBench: 48.0, arenaElo: 1220 } },

  // OpenAI / GPT models
  { pattern: "o3-mini", scores: { sweBench: 71.0, humanEval: 94.5, liveCodeBench: 66.0, arenaElo: 1330 } },
  { pattern: "o1", scores: { sweBench: 48.9, humanEval: 92.4, liveCodeBench: 61.5, arenaElo: 1310 } },
  { pattern: "gpt-4o", scores: { sweBench: 38.8, humanEval: 90.2, liveCodeBench: 52.1, arenaElo: 1286 } },
  { pattern: "gpt-4o-mini", scores: { sweBench: 29.0, humanEval: 87.2, liveCodeBench: 41.5, arenaElo: 1200 } },

  // DeepSeek models
  { pattern: "deepseek-r1", scores: { sweBench: 49.2, humanEval: 96.1, liveCodeBench: 65.9, arenaElo: 1350 } },
  { pattern: "deepseek-v3", scores: { sweBench: 42.0, humanEval: 90.0, liveCodeBench: 58.0, arenaElo: 1310 } },
  { pattern: "deepseek-coder", scores: { sweBench: 38.5, humanEval: 90.2, liveCodeBench: 53.0, arenaElo: 1240 } },

  // Qwen models
  { pattern: "qwen-2.5-coder-32b", scores: { sweBench: 41.2, humanEval: 92.7, liveCodeBench: 56.4, arenaElo: 1250 } },
  { pattern: "qwen-2.5-72b", scores: { sweBench: 37.0, humanEval: 86.6, liveCodeBench: 51.0, arenaElo: 1240 } },
  { pattern: "qwq-32b", scores: { sweBench: 44.0, humanEval: 93.0, liveCodeBench: 59.0, arenaElo: 1270 } },

  // GLM / Z-AI / Nemotron / Llama / Mistral models
  { pattern: "glm-4", scores: { sweBench: 35.0, humanEval: 85.0, liveCodeBench: 47.0, arenaElo: 1200 } },
  { pattern: "glm-5", scores: { sweBench: 42.0, humanEval: 89.0, liveCodeBench: 53.0, arenaElo: 1240 } },
  { pattern: "nemotron", scores: { sweBench: 36.5, humanEval: 86.0, liveCodeBench: 48.0, arenaElo: 1210 } },
  { pattern: "llama-3.3-70b", scores: { sweBench: 36.0, humanEval: 88.6, liveCodeBench: 49.2, arenaElo: 1230 } },
  { pattern: "mistral-large", scores: { sweBench: 34.0, humanEval: 84.0, liveCodeBench: 45.0, arenaElo: 1210 } },
  { pattern: "codestral", scores: { sweBench: 33.5, humanEval: 81.1, liveCodeBench: 46.0, arenaElo: 1200 } },
];

/** Find benchmark scores for a model ID or provider/model spec. */
export function getBenchmarkScores(modelId: string): BenchmarkScores {
  const norm = modelId.toLowerCase();
  for (const entry of BENCHMARK_DB) {
    if (typeof entry.pattern === "string") {
      if (norm.includes(entry.pattern)) return entry.scores;
    } else if (entry.pattern.test(norm)) {
      return entry.scores;
    }
  }
  return {};
}

/** Calculate a single composite quality score (0-100) for ranking targets. */
export function calculateQualityScore(scores: BenchmarkScores): number {
  let totalWeight = 0;
  let weightedSum = 0;

  if (scores.sweBench !== undefined) {
    weightedSum += scores.sweBench * 3.0; // Primary coding agent benchmark
    totalWeight += 3.0;
  }
  if (scores.liveCodeBench !== undefined) {
    weightedSum += scores.liveCodeBench * 2.0;
    totalWeight += 2.0;
  }
  if (scores.humanEval !== undefined) {
    weightedSum += scores.humanEval * 1.0;
    totalWeight += 1.0;
  }

  if (totalWeight > 0) {
    return Math.round((weightedSum / totalWeight) * 10) / 10;
  }
  if (scores.arenaElo !== undefined) {
    return Math.max(0, Math.min(100, Math.round((scores.arenaElo - 1000) / 4)));
  }

  return 50.0; // Default baseline score for unlisted models
}

/** Where a strength score came from. Ranking is only as trustworthy as its basis. */
export type StrengthBasis = "snapshot" | "static-table" | "telemetry" | "neutral";

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
 *  2. the legacy hardcoded table — stale, but still a capability measurement;
 *  3. observed runtime telemetry — not capability, but this deployment's own evidence that the
 *     model answers successfully and quickly. Needs ≥5 real calls, so a brand-new model does not
 *     get ranked off one lucky request;
 *  4. neutral — nothing is known, so claim nothing.
 *
 * The basis travels with the score precisely so a telemetry-derived number is never mistaken for
 * a benchmark one.
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

  const scores = getBenchmarkScores(spec);
  if (Object.keys(scores).length > 0) {
    return { score: calculateQualityScore(scores), basis: "static-table" };
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
