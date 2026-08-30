import { describe, expect, it } from "vitest";
import {
  LANE_ROSTER_TTL_MS,
  laneOfCommand,
  laneOfRung,
  recordRejectedArg,
  rosterIsStale,
  unsupportedArgValues,
  verifyModel,
  type LaneManifest,
} from "../src/lane-manifest.js";

/** A clock inside the roster's freshness window — roster age is its own test dimension below. */
const FRESH_NOW = Date.parse("2026-08-09T00:00:00Z");
/** A clock one day past the roster TTL. */
const STALE_NOW = Date.parse("2026-08-08T00:00:00Z") + LANE_ROSTER_TTL_MS + 86_400_000;

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

  it("evicts a model a FRESH roster omits", () => {
    // The measured failure: the ladder named a model AGY does not serve.
    const v = verifyModel(manifest(), "agy.exe", "claude-opus-5", { now: FRESH_NOW });
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

  it("⚠ corrupt manifests degrade to UNKNOWN (loader validates deeply, returns null)", async () => {
    const { loadLaneManifest } = await import("../src/lane-manifest.js");
    const { tmpdir } = await import("node:os");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "lane-corrupt-"));

    // models: ["string"] — string.id is undefined, would silently evict as not-servable
    const corruptStrings = join(dir, "corrupt-strings.json");
    writeFileSync(corruptStrings, JSON.stringify({
      version: 1,
      lanes: { agy: { via: "agy models", probedAt: "2026-08-08T00:00:00Z", models: ["x"] } }
    }));
    expect(loadLaneManifest(corruptStrings)).toBeNull();

    // models: [null] — would throw in verifyModel
    const corruptNull = join(dir, "corrupt-null.json");
    writeFileSync(corruptNull, JSON.stringify({
      version: 1,
      lanes: { agy: { via: "agy models", probedAt: "2026-08-08T00:00:00Z", models: [null] } }
    }));
    expect(loadLaneManifest(corruptNull)).toBeNull();

    // models: 5 — not an array, would throw
    const corruptNumber = join(dir, "corrupt-number.json");
    writeFileSync(corruptNumber, JSON.stringify({
      version: 1,
      lanes: { agy: { via: "agy models", probedAt: "2026-08-08T00:00:00Z", models: 5 } }
    }));
    expect(loadLaneManifest(corruptNumber)).toBeNull();

    // Also: verifyModel returns unknown when manifest is null (loader returns null)
    const { verifyModel } = await import("../src/lane-manifest.js");
    expect(verifyModel(null, "agy.exe", "anything").status).toBe("unknown");
  });

  it("uses a STATED support list from a FRESH roster to reject an argument value", () => {
    // Codex publishes supported_reasoning_levels per model, so this needs no failed call.
    expect(
      unsupportedArgValues(manifest(), "codex", "gpt-5.6-sol", "model_reasoning_effort", "ultra", { now: FRESH_NOW })
        .unsupported,
    ).toBe(false);
    const spark = unsupportedArgValues(manifest(), "codex", "gpt-5.3-codex-spark", "model_reasoning_effort", "ultra", {
      now: FRESH_NOW,
    });
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

describe("roster staleness (LANE_ROSTER_TTL_MS)", () => {
  it("⚠ a STALE roster may no longer evict — omission degrades to unknown", () => {
    // The parked-lane failure mode this lap exists for: both live rosters were 21 days old, and
    // a vendor rename plus a config update would have evicted a healthy lane on that evidence.
    const v = verifyModel(manifest(), "agy.exe", "claude-opus-5", { now: STALE_NOW });
    expect(v.status).toBe("unknown");
    expect(v.status === "unknown" && v.reason).toContain("stale");
  });

  it("a stale roster still answers servable for a model it LISTS", () => {
    // Age weakens eviction evidence; it does not disprove presence. Safe direction only.
    expect(verifyModel(manifest(), "agy.exe", "claude-opus-4-6-thinking", { now: STALE_NOW }).status).toBe("servable");
  });

  it("an unparseable probedAt counts as stale, not as fresh", () => {
    const m: LaneManifest = {
      version: 1,
      lanes: { agy: { via: "agy models", probedAt: "not-a-date", models: [{ id: "listed" }] } },
    };
    expect(verifyModel(m, "agy.exe", "missing", { now: FRESH_NOW }).status).toBe("unknown");
  });

  it("age exactly at the TTL boundary is still fresh (strict >)", () => {
    const at = Date.parse("2026-08-08T00:00:00Z");
    const entry = { via: "agy models", probedAt: "2026-08-08T00:00:00Z", models: [{ id: "x" }] };
    expect(rosterIsStale(entry, at + LANE_ROSTER_TTL_MS)).toBe(false);
    expect(rosterIsStale(entry, at + LANE_ROSTER_TTL_MS + 1)).toBe(true);
  });

  it("a stale STATED support list stops rejecting argument values; observed rejections never age", () => {
    // Dropping an argument on a stated list is the same eviction move as not-servable — it
    // demands the same freshness. An OBSERVED rejection is an existence fact and stands.
    const stale = unsupportedArgValues(manifest(), "codex", "gpt-5.3-codex-spark", "model_reasoning_effort", "ultra", {
      now: STALE_NOW,
    });
    expect(stale.unsupported).toBe(false);
    const m = recordRejectedArg(manifest(), "agy", "claude-opus-4-6-thinking", "--effort");
    expect(
      unsupportedArgValues(m, "agy.exe", "claude-opus-4-6-thinking", "--effort", "medium", { now: STALE_NOW })
        .unsupported,
    ).toBe(true);
  });
});

describe("laneOfRung (wrapper-aware recognition)", () => {
  it("resolves a direct lane command exactly like laneOfCommand", () => {
    expect(laneOfRung("codex", ["exec", "{task}"])).toEqual({ lane: "codex", binary: "codex" });
  });

  it("sees through a wrapper command to the lane binary in args", () => {
    // The live agy rungs: command "pwsh", the real binary several args in. Before this existed,
    // recognition returned null and the agy roster could never refresh again.
    const match = laneOfRung("pwsh", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\Users\\x\\.llm-relay\\bin\\lane-launch.ps1",
      "--timeout",
      "2100",
      "C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.exe",
      "-p",
      "{task}",
    ]);
    expect(match).toEqual({ lane: "agy", binary: "C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.exe" });
  });

  it("⚠ never matches a lane name embedded in a longer token", () => {
    // "gpt-5.3-codex-spark" contains "codex" but IS a model id — a substring match would claim
    // rungs for lanes they do not belong to. Exact basename only.
    expect(laneOfRung("claude", ["-p", "{task}", "--model", "gpt-5.3-codex-spark"])).toBeNull();
  });
});
