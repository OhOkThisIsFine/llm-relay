import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  confidenceAdjustedScore,
  deploymentFitness,
  evidenceConfidence,
  getStrength,
  rankTargetsByBenchmark,
  rankTargetsWithProvenance,
  strengthAllowedForEffort,
} from "../src/benchmarks.js";
import { recordModelCall } from "../src/ping/runtime-telemetry.js";
import type { ResolvedTarget } from "../src/config.js";

describe("benchmarks", () => {
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

/**
 * ARC-31833353: the comparator read `getStrength(spec).score` and discarded basis/signals, so a
 * `neutral` 50 — nothing published about this model at all — ranked identically to a `snapshot` 50
 * measured across several leaderboards. A provenance-free number was choosing the backend.
 */
describe("ranking keeps the provenance that produced the order", () => {
  const t = (provider: string, model: string): ResolvedTarget => ({
    provider, base: "http://x", kind: "openai", model, authHeader: "authorization", timeoutMs: 1000,
  });

  it("reports the basis and signals behind every position", () => {
    const ranked = rankTargetsWithProvenance([
      t("nim", "z-ai/glm-5.2"),
      t("nim", "nobody/has-ever-heard-of-this-xyz"),
    ]);

    expect(ranked.map((r) => r.spec)).toEqual([
      "nim/z-ai/glm-5.2",
      "nim/nobody/has-ever-heard-of-this-xyz",
    ]);
    // The scalar never travels alone: each position carries how it was reached.
    expect(ranked[0]!.strength.basis).toBe("snapshot");
    expect(ranked[0]!.strength.signalCount).toBeGreaterThan(1);
    expect(ranked[1]!.strength.basis).toBe("neutral");
    expect(rankTargetsByBenchmark([t("nim", "z-ai/glm-5.2")]).length).toBe(1);
  });

  it("breaks an exact tie towards the better-evidenced basis, never by adjusting the score", () => {
    // Two models nothing is published about both sit at the neutral 50, so they tie on score
    // and on basis and keep config order — absence of a signal is not a penalty.
    const a = t("nim", "nobody/unknown-model-a-xyz");
    const b = t("nim", "nobody/unknown-model-b-xyz");
    const ranked = rankTargetsWithProvenance([a, b]);
    expect(ranked.map((r) => r.target)).toEqual([a, b]);
    expect(ranked.every((r) => r.strength.basis === "neutral")).toBe(true);
    expect(ranked.every((r) => r.strength.score === 50)).toBe(true);

    // Reversing the input reverses the output: the tie is resolved by config order, which is
    // only observable because the comparator does not fabricate a difference.
    expect(rankTargetsWithProvenance([b, a]).map((r) => r.target)).toEqual([b, a]);
  });
});

describe("strength — evidence hierarchy", () => {
  it("shrinks thin and fuzzy evidence toward neutral before it can steer routing", () => {
    expect(evidenceConfidence("snapshot", 1, "exact")).toBe(0.2);
    expect(evidenceConfidence("snapshot", 5, "exact")).toBe(1);
    expect(evidenceConfidence("snapshot", 2, "fuzzy")).toBe(0.2);
    expect(confidenceAdjustedScore(90, 0.2)).toBe(58);
    expect(confidenceAdjustedScore(80, 1)).toBe(80);
  });

  it("builds cumulative capability floors without excluding stronger models from lower effort", () => {
    const strength = (rawScore: number, score = rawScore) => ({
      score, rawScore, confidence: 1, basis: "snapshot" as const,
      match: "exact" as const, signalCount: 3,
    });
    expect(strengthAllowedForEffort(strength(49.5), "low")).toBe(true);
    expect(strengthAllowedForEffort(strength(49.4), "low")).toBe(false);
    expect(strengthAllowedForEffort(strength(65), "low")).toBe(true);
    expect(strengthAllowedForEffort(strength(65), "medium")).toBe(true);
    expect(strengthAllowedForEffort(strength(75), "high")).toBe(true);
    expect(strengthAllowedForEffort(strength(85), "high")).toBe(true);
    expect(strengthAllowedForEffort(strength(85), "xhigh")).toBe(true);
    expect(strengthAllowedForEffort(strength(75), "xhigh")).toBe(false);
    expect(strengthAllowedForEffort({ ...strength(90), basis: "neutral" }, "low")).toBe(false);
    expect(strengthAllowedForEffort({ ...strength(90), match: "fuzzy" }, "low")).toBe(false);
    expect(strengthAllowedForEffort({ ...strength(90), signalCount: 2 }, "low")).toBe(false);
    // Confidence affects ordering, not membership: raw 83 clears xhigh even if adjusted to 76.
    expect(strengthAllowedForEffort(strength(83, 76), "xhigh")).toBe(true);

    const fable = getStrength("openrouter/anthropic/claude-fable-5");
    expect(fable.rawScore).toBeGreaterThan(95);
    expect(strengthAllowedForEffort(fable, "low")).toBe(true);
    expect(strengthAllowedForEffort(fable, "xhigh")).toBe(true);
  });

  it("keeps the Gemini family in capability order and excludes 2.5 from xhigh", () => {
    const gemini36 = getStrength("gemini/models/gemini-3.6-flash");
    const gemini35 = getStrength("gemini/models/gemini-3.5-flash");
    const gemini25 = getStrength("gemini/models/gemini-2.5-flash");

    expect(gemini36.rawScore).toBeGreaterThan(gemini35.rawScore);
    expect(gemini35.rawScore).toBeGreaterThan(gemini25.rawScore);
    expect(strengthAllowedForEffort(gemini36, "xhigh")).toBe(true);
    expect(strengthAllowedForEffort(gemini35, "xhigh")).toBe(true);
    expect(strengthAllowedForEffort(gemini25, "high")).toBe(true);
    expect(strengthAllowedForEffort(gemini25, "xhigh")).toBe(false);
    expect(gemini25.imputedDimensions).toContain("coding");
  });

  it("orders by capability-led deployment fitness and treats missing metadata as neutral", () => {
    const strong = { score: 82, rawScore: 82, confidence: 1, basis: "snapshot" as const };
    const cold = deploymentFitness(strong);
    expect(cold.operational).toBe(50);
    expect(cold.metadata).toBe(50);

    const proven = deploymentFitness(strong, {
      stabilityScore: 95,
      stabilityConfidence: 1,
      runtimeScore: 90,
      supportsTools: true,
      contextLength: 1_048_576,
      contextConfidence: 1,
    });
    expect(proven.score).toBeGreaterThan(cold.score);
    expect(proven.capability).toBe(cold.capability);
  });

  it("prefers the synced snapshot, and says how many signals backed it", () => {
    const s = getStrength("nim/z-ai/glm-5.2");
    expect(s.basis).toBe("snapshot");
    expect(s.match).toBe("exact"); // OpenRouter ids join exactly — no borrowed-SKU guessing
    expect(s.signalCount).toBeGreaterThan(1);
    expect(s.signals!.length).toBe(s.signalCount);
    expect(s.score).toBeGreaterThan(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });

  it("keeps observed traffic operational and never lets it impersonate capability", () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-strength-"));
    const path = join(dir, "telemetry.json");
    try {
      // A model no leaderboard and no hardcoded row has ever heard of.
      const spec = "nim/private/unpublished-model-v1";
      expect(getStrength(spec).basis).toBe("neutral");

      // getRealWorldScore needs >=5 calls, so one lucky request cannot promote a model.
      for (let i = 0; i < 4; i++) {
        recordModelCall("nim", "private/unpublished-model-v1", { ok: true, latencyMs: 200 }, { path });
      }
      expect(getStrength(spec).basis).toBe("neutral");

      recordModelCall("nim", "private/unpublished-model-v1", { ok: true, latencyMs: 200 }, { path });
      const observed = rankTargetsWithProvenance([{
        provider: "nim",
        base: "http://x",
        kind: "openai",
        model: "private/unpublished-model-v1",
        authHeader: "authorization",
        timeoutMs: 1000,
      }], {
        telemetryPath: path,
      })[0]!;
      expect(observed.strength.basis).toBe("neutral");
      expect(observed.strength.score).toBe(50);
      expect(observed.fitness.operational).toBeGreaterThan(50);
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
