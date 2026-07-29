import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getBenchmarkScores, calculateQualityScore, rankTargetsByBenchmark, getStrength } from "../src/benchmarks.js";
import { recordModelCall } from "../src/ping/runtime-telemetry.js";
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

  it("ranks resolved target candidates strongest first", () => {
    const t = (provider: string, model: string): ResolvedTarget => ({
      provider, base: "http://x", kind: "openai", model, authHeader: "authorization", timeoutMs: 1000,
    });
    const ranked = rankTargetsByBenchmark([
      t("nim", "meta/llama-3.1-8b-instruct"),
      t("nim", "z-ai/glm-5.2"),
      t("nim", "openai/gpt-oss-20b"),
    ]);
    expect(ranked.map((r) => r.model)).toEqual([
      "z-ai/glm-5.2",
      "openai/gpt-oss-20b",
      "meta/llama-3.1-8b-instruct",
    ]);
  });
});

describe("strength — evidence hierarchy", () => {
  it("prefers the synced snapshot, and says how many signals backed it", () => {
    const s = getStrength("nim/z-ai/glm-5.2");
    expect(s.basis).toBe("snapshot");
    expect(s.match).toBe("exact"); // OpenRouter ids join exactly — no borrowed-SKU guessing
    expect(s.signalCount).toBeGreaterThan(1);
    expect(s.signals!.length).toBe(s.signalCount);
    expect(s.score).toBeGreaterThan(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });

  it("falls back to observed traffic before giving up, and never silently calls it a benchmark", () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-strength-"));
    const path = join(dir, "telemetry.json");
    try {
      // A model no leaderboard and no hardcoded row has ever heard of.
      const spec = "nim/private/unpublished-model-v1";
      expect(getStrength(spec, { telemetryPath: path }).basis).toBe("neutral");

      // getRealWorldScore needs >=5 calls, so one lucky request cannot promote a model.
      for (let i = 0; i < 4; i++) {
        recordModelCall("nim", "private/unpublished-model-v1", { ok: true, latencyMs: 200 }, { path });
      }
      expect(getStrength(spec, { telemetryPath: path }).basis).toBe("neutral");

      recordModelCall("nim", "private/unpublished-model-v1", { ok: true, latencyMs: 200 }, { path });
      const observed = getStrength(spec, { telemetryPath: path });
      expect(observed.basis).toBe("telemetry");
      expect(observed.score).toBeGreaterThan(0);
      // Basis is what stops an availability measurement being read as a capability one.
      expect(observed.signals).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claims nothing for a model with no evidence at all", () => {
    const s = getStrength("nim/nobody/has-ever-heard-of-this-xyz");
    expect(s.basis).toBe("neutral");
    expect(s.score).toBe(50);
  });
});
