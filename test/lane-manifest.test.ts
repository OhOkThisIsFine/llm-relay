import { describe, expect, it } from "vitest";
import {
  laneOfCommand,
  recordRejectedArg,
  unsupportedArgValues,
  verifyModel,
  type LaneManifest,
} from "../src/lane-manifest.js";

const manifest = (): LaneManifest => ({
  version: 1,
  lanes: {
    agy: {
      via: "agy models",
      probedAt: "2026-08-08T00:00:00Z",
      models: [{ id: "claude-opus-4-6-thinking" }, { id: "gemini-3.6-flash-medium" }],
    },
    codex: {
      via: "codex debug models",
      probedAt: "2026-08-08T00:00:00Z",
      models: [
        { id: "gpt-5.6-sol", supports: { model_reasoning_effort: ["low", "medium", "high", "xhigh", "max", "ultra"] } },
        { id: "gpt-5.3-codex-spark", supports: { model_reasoning_effort: ["low", "medium", "high", "xhigh"] } },
      ],
    },
  },
});

describe("lane manifest", () => {
  it("maps a command path to its lane, and an unknown command to null", () => {
    expect(laneOfCommand("C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.exe")).toBe("agy");
    expect(laneOfCommand("codex")).toBe("codex");
    // ⚠ Closed set. An unrecognized command is UNKNOWN — never a candidate for eviction.
    expect(laneOfCommand("some-other-cli")).toBeNull();
  });

  it("evicts a model the lane's roster omits", () => {
    // The measured failure: the ladder named a model AGY does not serve.
    const v = verifyModel(manifest(), "agy.exe", "claude-opus-5");
    expect(v.status).toBe("not-servable");
    expect(v.status === "not-servable" && v.reason).toContain("agy's roster");
  });

  it("accepts a model the roster lists", () => {
    expect(verifyModel(manifest(), "agy.exe", "claude-opus-4-6-thinking").status).toBe("servable");
  });

  it("⚠ returns UNKNOWN, never not-servable, without positive evidence", () => {
    // These are the paths that must not be able to empty the ladder. A stale, missing, corrupt or
    // never-probed manifest is an absence of knowledge, not knowledge of absence — same fail-safe
    // as a signature miss in refusal-interpretation.ts.
    expect(verifyModel(null, "agy.exe", "anything").status).toBe("unknown");
    expect(verifyModel(manifest(), "unknown-cli", "anything").status).toBe("unknown");

    const neverProbed: LaneManifest = { version: 1, lanes: {} };
    expect(verifyModel(neverProbed, "agy.exe", "anything").status).toBe("unknown");

    const emptyRoster: LaneManifest = {
      version: 1,
      lanes: { agy: { via: "agy models", probedAt: "2026-08-08T00:00:00Z", models: [] } },
    };
    expect(verifyModel(emptyRoster, "agy.exe", "anything").status).toBe("unknown");
  });

  it("uses a STATED support list to reject an argument value", () => {
    // Codex publishes supported_reasoning_levels per model, so this needs no failed call.
    expect(unsupportedArgValues(manifest(), "codex", "gpt-5.6-sol", "model_reasoning_effort", "ultra").unsupported)
      .toBe(false);
    const spark = unsupportedArgValues(manifest(), "codex", "gpt-5.3-codex-spark", "model_reasoning_effort", "ultra");
    expect(spark.unsupported).toBe(true);
    expect(spark.reason).toContain("supports model_reasoning_effort");
  });

  it("treats an absent support list as unknown rather than unsupported", () => {
    // AGY states nothing about flags. Silence is not a rejection.
    expect(unsupportedArgValues(manifest(), "agy.exe", "claude-opus-4-6-thinking", "--effort", "medium").unsupported)
      .toBe(false);
  });

  it("learns an argument rejection that the tool never published", () => {
    // AGY's roster carries no flag data, so `--effort is not supported for model X` can only be
    // learned from the observed failure.
    const m = recordRejectedArg(manifest(), "agy", "claude-opus-4-6-thinking", "--effort");
    const out = unsupportedArgValues(m, "agy.exe", "claude-opus-4-6-thinking", "--effort", "medium");
    expect(out.unsupported).toBe(true);
    expect(out.reason).toContain("observed");
    // Scoped to the model that rejected it — a sibling is unaffected.
    expect(unsupportedArgValues(m, "agy.exe", "gemini-3.6-flash-medium", "--effort", "medium").unsupported).toBe(false);
  });
});
