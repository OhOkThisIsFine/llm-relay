import { describe, expect, it } from "vitest";
import { findTierModel, PRICE_SUFFIXES } from "../src/tier-data.js";

/**
 * Price-suffix resolution (packet P13, half a).
 *
 * A `-free` / `-contributor-free` tail names what a deployment COSTS, not what the model can
 * do — unlike an effort suffix, which `normName()` rightly never strips. So `findTierModel`
 * resolves a suffixed id through its base SKU's row (same weights, the deployment's own price)
 * while an effort suffix is never treated as a price suffix.
 *
 * ⚠ Tier rows are INJECTED here, never read from the live snapshot — the
 * "never pin a REAL model's band membership" gotcha. Effort floors move when the population
 * does; these assertions must not.
 */

interface Row {
  norm: string;
  strength?: number;
  signal_count?: number;
  published_signal_count?: number;
  effort_eligibility?: string[];
}

function index(rows: Row[]) {
  return {
    byNorm: rows.map((rec) => ({ norm: rec.norm, rec })),
    exactByNorm: new Map(rows.map((rec) => [rec.norm, rec])),
  };
}

const BASE = {
  norm: "muse-spark-1.3",
  strength: 0.8,
  signal_count: 4,
  published_signal_count: 4,
  effort_eligibility: ["low", "medium", "high"],
};

describe("findTierModel price-suffix resolution", () => {
  it("resolves a -contributor-free id to the injected base row, exact, naming the suffix", () => {
    const { byNorm, exactByNorm } = index([BASE]);
    const hit = findTierModel("opencode/muse-spark-1.3-contributor-free", byNorm, exactByNorm);
    expect(hit?.rec).toBe(BASE);
    expect(hit?.match).toBe("exact");
    expect(hit?.priceSuffix).toBe("-contributor-free");
  });

  it("resolves a -free id to the injected base row, exact, naming the suffix", () => {
    const { byNorm, exactByNorm } = index([BASE]);
    const hit = findTierModel("someone/muse-spark-1.3-free", byNorm, exactByNorm);
    expect(hit?.rec).toBe(BASE);
    expect(hit?.match).toBe("exact");
    expect(hit?.priceSuffix).toBe("-free");
  });

  it("leaves an unsuffixed exact hit with a null priceSuffix", () => {
    const { byNorm, exactByNorm } = index([BASE]);
    const hit = findTierModel("opencode/muse-spark-1.3", byNorm, exactByNorm);
    expect(hit?.rec).toBe(BASE);
    expect(hit?.match).toBe("exact");
    expect(hit?.priceSuffix).toBeNull();
  });

  it("keeps a fuzzy hit at priceSuffix null — a borrowed row is not a price resolution", () => {
    const { byNorm, exactByNorm } = index([{ norm: "muse-spark-1.3-extended-edition" }]);
    const hit = findTierModel("x/muse-spark-1.3-extended", byNorm, exactByNorm);
    expect(hit?.match).toBe("fuzzy");
    expect(hit?.priceSuffix).toBeNull();
  });

  it("leaves x-free unresolved when no x row exists — no fabricated row", () => {
    const { byNorm, exactByNorm } = index([BASE]);
    expect(findTierModel("someone/x-free", byNorm, exactByNorm)).toBeNull();
  });

  it("never strips an effort suffix: gpt-5-high is not resolved to the gpt-5 row", () => {
    // Negative control. An effort suffix names a different capability; treating it as a price
    // suffix would lend the base model's scores to a different variant — the borrowed-score bug.
    const { byNorm, exactByNorm } = index([{ norm: "gpt-5", strength: 0.9 }]);
    expect(findTierModel("openai/gpt-5-high", byNorm, exactByNorm)).toBeNull();
  });

  it("resolves an effort-suffixed id exactly when its own row is injected", () => {
    const rows = [{ norm: "gpt-5", strength: 0.9 }, { norm: "gpt-5-high", strength: 0.92 }];
    const { byNorm, exactByNorm } = index(rows);
    const hit = findTierModel("openai/gpt-5-high", byNorm, exactByNorm);
    expect(hit?.rec).toBe(rows[1]);
    expect(hit?.match).toBe("exact");
    expect(hit?.priceSuffix).toBeNull();
  });

  it("does not strip from the middle: foo-free-high is not resolved through foo or foo-free", () => {
    const rows = [{ norm: "foo" }, { norm: "foo-free" }];
    const { byNorm, exactByNorm } = index(rows);
    expect(findTierModel("someone/foo-free-high", byNorm, exactByNorm)).toBeNull();
  });

  it("prefers the longest suffix: -contributor-free wins over -free", () => {
    expect(PRICE_SUFFIXES).toEqual(["-contributor-free", "-free"]);
    const rows = [{ norm: "m" }, { norm: "m-contributor" }];
    const { byNorm, exactByNorm } = index(rows);
    // "m-contributor-free" strips "-contributor-free" to "m" — not "-free" to "m-contributor".
    const hit = findTierModel("x/m-contributor-free", byNorm, exactByNorm);
    expect(hit?.rec).toBe(rows[0]);
    expect(hit?.priceSuffix).toBe("-contributor-free");
  });
});
