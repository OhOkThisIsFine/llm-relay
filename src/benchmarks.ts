import type { ResolvedTarget } from "./config.js";

export interface BenchmarkScores {
  sweBench?: number; // SWE-bench Verified pass@1 % (0-100)
  humanEval?: number; // HumanEval pass@1 % (0-100)
  liveCodeBench?: number; // LiveCodeBench score (0-100)
  arenaElo?: number; // Chatbot Arena / coding ELO
}

/** Built-in coding benchmark database for popular coding models. */
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

/** Rank an array of resolved targets by coding benchmark quality (descending). */
export function rankTargetsByBenchmark(targets: ResolvedTarget[]): ResolvedTarget[] {
  if (targets.length <= 1) return [...targets];

  return [...targets].sort((a, b) => {
    const specA = a.model ? `${a.provider}/${a.model}` : a.provider;
    const specB = b.model ? `${b.provider}/${b.model}` : b.provider;

    const scoreA = calculateQualityScore(getBenchmarkScores(specA));
    const scoreB = calculateQualityScore(getBenchmarkScores(specB));

    return scoreB - scoreA; // Highest score first
  });
}
