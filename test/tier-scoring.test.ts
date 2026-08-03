import { describe, expect, it } from "vitest";
import {
  calibratedValue,
  deriveCalibration,
  effortEligibility,
  resolveCalibration,
  scoreModels,
} from "../scripts/tier-scoring.mjs";

type ScoringModel = Record<string, any> & { name: string; norm: string };

function completeModels(count = 16): ScoringModel[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `Model ${index}`,
    norm: `model-${index}`,
    aa_agentic: 10 + index * 2,
    aa_coding: 20 + index * 2.5,
    aa_intelligence: 15 + index * 2.2,
    bfcl_irrelevance: 50 + index,
  }));
}

describe("tier scoring policy", () => {
  it("uses stable persisted anchors when the leaderboard population changes", () => {
    const original = completeModels();
    const calibration = deriveCalibration(original, "2026-01-01T00:00:00.000Z");
    const expanded = [...original, {
      name: "Unrelated extreme",
      norm: "unrelated-extreme",
      aa_agentic: 10_000,
      aa_coding: 10_000,
      aa_intelligence: 10_000,
    }];
    const resolved = resolveCalibration(expanded, calibration, "2026-02-01T00:00:00.000Z");

    expect(resolved.fields).toEqual(calibration.fields);
    expect(resolved.generated_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("treats a constant benchmark as neutral instead of uniquely best or worst", () => {
    const calibration = deriveCalibration([
      { norm: "a", aa_agentic: 42 },
      { norm: "b", aa_agentic: 42 },
    ]);
    expect(calibratedValue(42, calibration.fields.aa_agentic)).toBe(0.5);
  });

  it("estimates a missing dimension while preserving fixed dimension weights", () => {
    const models = completeModels();
    const complete = models[12]!;
    const sparse: ScoringModel = {
      ...complete,
      name: "Sparse twin",
      norm: "sparse-twin",
      aa_coding: null,
    };
    models.push(sparse);
    const calibration = deriveCalibration(models);
    scoreModels(models, calibration);

    expect(sparse.direct_dimensions).toEqual(["agentic", "general"]);
    expect(sparse.imputed_dimensions).toEqual(["coding"]);
    expect(sparse.dimensions.coding).toBeTypeOf("number");
    expect(sparse.strength).toBeCloseTo(
      0.4 * sparse.dimensions.agentic +
      0.35 * sparse.dimensions.coding +
      0.25 * sparse.dimensions.general,
      3,
    );
    expect(Math.abs(sparse.strength - complete.strength)).toBeLessThan(0.08);
  });

  it("keeps specialized behavior out of raw capability", () => {
    const models = completeModels();
    models.push(
      {
        name: "Good behavior",
        norm: "good-behavior",
        aa_agentic: 30,
        aa_coding: 40,
        aa_intelligence: 35,
        bfcl_irrelevance: 99,
        design_arena_agents_elo_mean: 1400,
      },
      {
        name: "Poor behavior",
        norm: "poor-behavior",
        aa_agentic: 30,
        aa_coding: 40,
        aa_intelligence: 35,
        bfcl_irrelevance: 1,
        design_arena_agents_elo_mean: 900,
      },
    );
    const calibration = deriveCalibration(models);
    scoreModels(models, calibration);
    const good = models.find((model) => model.norm === "good-behavior")!;
    const poor = models.find((model) => model.norm === "poor-behavior")!;

    expect(good.strength).toBe(poor.strength);
    expect(good.task_fit_score).toBeGreaterThan(poor.task_fit_score);
  });

  it("uses whole-point entry and a two-point exit band", () => {
    expect(effortEligibility(0.798)).toContain("xhigh");
    expect(effortEligibility(0.794)).not.toContain("xhigh");
    expect(effortEligibility(0.779, ["xhigh"])).toContain("xhigh");
    expect(effortEligibility(0.774, ["xhigh"])).not.toContain("xhigh");
    expect(effortEligibility(0.85)).toEqual(["low", "medium", "high", "xhigh"]);
  });
});
