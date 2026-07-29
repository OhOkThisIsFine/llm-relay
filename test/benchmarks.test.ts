import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rankTargetsByBenchmark, getStrength } from "../src/benchmarks.js";
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
