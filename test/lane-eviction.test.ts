import { describe, expect, it } from "vitest";
import { buildDispatch } from "../src/dispatch.js";
import type { LaneManifest } from "../src/lane-manifest.js";
import { loadConfig } from "../src/config.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const AGY = "C:\\agy\\agy.exe";

function cfgWithLadder() {
  const dir = mkdtempSync(join(tmpdir(), "rp-lane-evict-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    listen: "127.0.0.1:8791",
    providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" } },
    routing: {
      default: "anthropic",
      ladder: [
        { id: "agy-ghost", kind: "cli", command: AGY, args: ["-p", "{task}", "--model", "claude-opus-5", "--effort", "medium"] },
        { id: "agy-real", kind: "cli", command: AGY, args: ["-p", "{task}", "--model", "claude-opus-4-6-thinking", "--effort", "medium"] },
        { id: "anthropic", kind: "relay", spec: "anthropic" },
      ],
    },
  }));
  const cfg = loadConfig(path);
  rmSync(dir, { recursive: true, force: true });
  return cfg;
}

// FRESH on purpose: eviction demands a roster inside LANE_ROSTER_TTL_MS, and `buildDispatch`
// reads the real clock. A dated literal here rotted into staleness and turned these tests into
// pins of the pre-staleness behaviour.
const manifest: LaneManifest = {
  version: 1,
  lanes: {
    agy: {
      via: "agy models",
      probedAt: new Date().toISOString(),
      models: [{ id: "claude-opus-4-6-thinking" }],
      rejectedArgs: { "claude-opus-4-6-thinking": ["--effort"] },
    },
  },
};

describe("cli lane eviction from the dispatch ladder", () => {
  it("evicts a rung whose model the lane does not serve, and withholds its command", () => {
    // The measured failure: the ladder handed an agent `--model claude-opus-5`, which AGY does
    // not serve. A rung that cannot work must not be renderable.
    const view = buildDispatch(cfgWithLadder(), { task: "probe", manifest });
    const ghost = view.ladder.find((l) => l.id === "agy-ghost")!;
    expect(ghost.state).toBe("not-servable");
    expect(ghost.notServable).toContain("claude-opus-5");
    expect(ghost.invoke).toBeUndefined();
    // It stays LISTED with its reason — silently vanishing is its own debugging problem.
    expect(view.ladder.map((l) => l.id)).toContain("agy-ghost");
  });

  it("never selects an evicted rung as next", () => {
    const view = buildDispatch(cfgWithLadder(), { task: "probe", manifest });
    expect(view.next?.id).toBe("agy-real");
  });

  it("strips an argument the lane is known to reject, keeping the rung usable", () => {
    // `--effort` is rejected outright for AGY's Claude models. Dropping the flag is the fix; the
    // rung itself is fine.
    const view = buildDispatch(cfgWithLadder(), { task: "probe", manifest });
    const real = view.ladder.find((l) => l.id === "agy-real")!;
    expect(real.state).toBe("ready");
    expect(real.invoke!.args).not.toContain("--effort");
    expect(real.invoke!.args).not.toContain("medium");
    expect(real.invoke!.args).toEqual(["-p", "probe", "--model", "claude-opus-4-6-thinking"]);
    expect(real.droppedArgs!.join(" ")).toContain("observed");
  });

  it("⚠ a STALE roster evicts nothing — the rung stays ready with its command", () => {
    // The 2026-08-29 finding: both live rosters were 21 days old, and an eviction on that
    // evidence would have parked a healthy lane. Stale ⇒ unknown ⇒ untouched ladder.
    const stale: LaneManifest = {
      version: 1,
      lanes: {
        agy: { via: "agy models", probedAt: "2026-08-08T00:00:00Z", models: [{ id: "claude-opus-4-6-thinking" }] },
      },
    };
    const view = buildDispatch(cfgWithLadder(), { task: "probe", manifest: stale });
    const ghost = view.ladder.find((l) => l.id === "agy-ghost")!;
    expect(ghost.state).toBe("ready");
    expect(ghost.notServable).toBeUndefined();
    expect(ghost.invoke).toBeDefined();
  });

  it("⚠ changes NOTHING without a manifest — absence of evidence is not evidence of absence", () => {
    // The path that must never be able to empty the ladder: no manifest, so every rung is unknown
    // and the ladder renders exactly as it did before this feature existed.
    const view = buildDispatch(cfgWithLadder(), { task: "probe" });
    const ghost = view.ladder.find((l) => l.id === "agy-ghost")!;
    expect(ghost.state).toBe("ready");
    expect(ghost.notServable).toBeUndefined();
    expect(ghost.invoke!.args).toContain("--effort");
    expect(view.next?.id).toBe("agy-ghost");
  });

  it("leaves a lane the relay cannot probe entirely alone", () => {
    // An unrecognized command is UNKNOWN, never a candidate for eviction — the closed-set rule.
    const dir = mkdtempSync(join(tmpdir(), "rp-lane-unknown-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({
      listen: "127.0.0.1:8791",
      providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" } },
      routing: {
        default: "anthropic",
        ladder: [{ id: "other", kind: "cli", command: "some-other-cli", args: ["--model", "whatever", "{task}"] }],
      },
    }));
    const cfg = loadConfig(path);
    rmSync(dir, { recursive: true, force: true });

    const view = buildDispatch(cfg, { task: "probe", manifest });
    expect(view.ladder[0]!.state).toBe("ready");
    expect(view.ladder[0]!.notServable).toBeUndefined();
  });
});
