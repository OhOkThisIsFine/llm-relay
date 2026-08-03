import { describe, expect, it } from "vitest";
import {
  TIER_SNAPSHOT_SCHEMA_VERSION,
  parseTierSnapshot,
  type TierSnapshot,
} from "../src/kernel/tier-snapshot.js";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function snapshot(overrides: Partial<TierSnapshot> = {}): TierSnapshot {
  return {
    schemaVersion: TIER_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: "2026-08-02T11:00:00.000Z",
    models: [
      {
        name: "Model A",
        norm: "model-a",
        sources: ["bfcl", "openrouter"],
        strength: 0.75,
        strengthRank: 1,
        signals: ["tool-use", "coding"],
        signalCount: 2,
        capabilities: { toolUse: 0.9, supportsTools: true, multimodal: null },
      },
    ],
    ...overrides,
  };
}

describe("parseTierSnapshot", () => {
  it("classifies valid snapshots as ready or stale from injected time", () => {
    const ready = parseTierSnapshot(snapshot(), { nowEpochMs: NOW, maxAgeMs: DAY });
    expect(ready.status).toBe("ready");
    if (ready.status === "ready") expect(ready.ageMs).toBe(60 * 60 * 1000);

    const stale = parseTierSnapshot(snapshot(), { nowEpochMs: NOW, maxAgeMs: 1000 });
    expect(stale.status).toBe("stale");
    if (stale.status === "stale") expect(stale.snapshot.models[0]?.norm).toBe("model-a");
  });

  it("distinguishes missing, incompatible, and malformed inputs", () => {
    expect(parseTierSnapshot(null, { nowEpochMs: NOW, maxAgeMs: DAY })).toEqual({ status: "missing" });
    expect(parseTierSnapshot(undefined, { nowEpochMs: NOW, maxAgeMs: DAY })).toEqual({ status: "missing" });
    expect(
      parseTierSnapshot(
        { ...snapshot(), schemaVersion: "llm-relay/tier-snapshot/v2" },
        { nowEpochMs: NOW, maxAgeMs: DAY },
      ),
    ).toEqual({
      status: "incompatible",
      expectedVersion: TIER_SNAPSHOT_SCHEMA_VERSION,
      actualVersion: "llm-relay/tier-snapshot/v2",
    });
    expect(parseTierSnapshot([], { nowEpochMs: NOW, maxAgeMs: DAY })).toEqual({
      status: "invalid",
      reason: "not-an-object",
      row: null,
    });
    expect(parseTierSnapshot({ models: [] }, { nowEpochMs: NOW, maxAgeMs: DAY })).toEqual({
      status: "invalid",
      reason: "missing-schema-version",
      row: null,
    });
  });

  it.each([
    ["null row", null],
    ["missing normalized identity", { ...snapshot().models[0], norm: "" }],
    ["non-normalized identity", { ...snapshot().models[0], norm: "Model-A" }],
    ["non-finite score", { ...snapshot().models[0], strength: Number.NaN }],
    ["invalid capability", { ...snapshot().models[0], capabilities: { score: Number.POSITIVE_INFINITY } }],
    ["signal-count drift", { ...snapshot().models[0], signalCount: 1 }],
  ])("fails closed on a %s", (_name, row) => {
    const result = parseTierSnapshot(snapshot({ models: [row] as never }), {
      nowEpochMs: NOW,
      maxAgeMs: DAY,
    });
    expect(result).toEqual({ status: "invalid", reason: "invalid-model-row", row: 0 });
    expect("snapshot" in result).toBe(false);
  });

  it("rejects duplicate model identities instead of choosing a row", () => {
    const row = snapshot().models[0]!;
    const result = parseTierSnapshot(snapshot({ models: [row, { ...row, name: "Other" }] }), {
      nowEpochMs: NOW,
      maxAgeMs: DAY,
    });
    expect(result).toEqual({ status: "invalid", reason: "duplicate-model", row: 1 });
    expect("snapshot" in result).toBe(false);
  });

  it("rejects invalid or future generation time", () => {
    expect(
      parseTierSnapshot(snapshot({ generatedAt: "not-a-date" }), {
        nowEpochMs: NOW,
        maxAgeMs: DAY,
      }),
    ).toEqual({ status: "invalid", reason: "invalid-generated-at", row: null });
    expect(
      parseTierSnapshot(snapshot({ generatedAt: "2026-08-02T13:00:00.000Z" }), {
        nowEpochMs: NOW,
        maxAgeMs: DAY,
      }),
    ).toEqual({ status: "invalid", reason: "invalid-generated-at", row: null });
  });

  it("returns an immutable clone rather than trusting caller-owned rows", () => {
    const input = snapshot();
    const result = parseTierSnapshot(input, { nowEpochMs: NOW, maxAgeMs: DAY });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.models)).toBe(true);
    expect(Object.isFrozen(result.snapshot.models[0]?.capabilities)).toBe(true);
    (input.models[0]!.capabilities as Record<string, number | boolean | null>).toolUse = 0;
    expect(result.snapshot.models[0]?.capabilities.toolUse).toBe(0.9);
  });
});
