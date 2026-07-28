import { describe, it, expect } from "vitest";
import { getBenchmarkScores, calculateQualityScore, rankTargetsByBenchmark } from "../src/benchmarks.js";
import type { ResolvedTarget } from "../src/config.js";

describe("benchmarks", () => {
  it("looks up benchmark scores for known model IDs", () => {
    const sonnet = getBenchmarkScores("claude-3-7-sonnet");
    expect(sonnet.sweBench).toBe(70.3);
    expect(sonnet.humanEval).toBe(92.0);

    const qwen = getBenchmarkScores("qwen-2.5-coder-32b");
    expect(qwen.sweBench).toBe(41.2);
  });

  it("calculates quality score from benchmark metrics", () => {
    const score = calculateQualityScore({ sweBench: 50.0, liveCodeBench: 60.0, humanEval: 90.0 });
    // weighted mean: (50*3 + 60*2 + 90*1) / 6 = 360 / 6 = 60
    expect(score).toBe(60);
  });

  it("ranks resolved target candidates by benchmark quality score", () => {
    const targets: ResolvedTarget[] = [
      { provider: "nim", base: "http://nim", kind: "openai", model: "llama-3.3-70b", authHeader: "authorization", timeoutMs: 1000 },
      { provider: "openrouter", base: "http://or", kind: "openai", model: "claude-3-7-sonnet", authHeader: "authorization", timeoutMs: 1000 },
      { provider: "nim", base: "http://nim", kind: "openai", model: "deepseek-r1", authHeader: "authorization", timeoutMs: 1000 },
    ];

    const ranked = rankTargetsByBenchmark(targets);
    expect(ranked[0]?.model).toBe("claude-3-7-sonnet"); // highest score (70.3 SWE-bench)
    expect(ranked[1]?.model).toBe("deepseek-r1");
    expect(ranked[2]?.model).toBe("llama-3.3-70b");
  });
});
