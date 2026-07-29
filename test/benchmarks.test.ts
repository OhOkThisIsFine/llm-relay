import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rankTargetsByBenchmark, rankTargetsWithProvenance, getStrength } from "../src/benchmarks.js";
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
