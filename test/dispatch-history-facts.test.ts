/**
 * Lane history facts on the dispatch view after stopping became idle-only.
 *
 * Completed-run history still reports the usual time to answer, keyed by tier/mode with a legacy
 * fallback; own failure streaks still drive the `failing` ordering. Failed, timed-out and
 * abandoned attempts never enter a time-to-answer window.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import { buildDispatch, FAILING_LANE_STREAK, type DispatchLane } from "../src/dispatch.js";
import { parseTelemetryReport, recordLaneRun, type DispatchMode } from "../src/dispatch-lane-stats.js";

const dir = mkdtempSync(join(tmpdir(), "llm-relay-history-facts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function freshConfig(walk: Record<string, unknown> | boolean = {}): Config {
  const path = join(dir, `c-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({
    listen: "127.0.0.1:8791",
    providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" } },
    routing: {
      default: "anthropic",
      dispatchWalk: walk,
      ladder: [{ id: "slow", kind: "cli", command: "a", args: ["{task}"] }],
    },
  }));
  return loadConfig(path);
}

type Status = "completed" | "failed" | "timed_out" | "abandoned";
interface Run { status: Status; ms: number; mode?: DispatchMode; }
let seq = 0;

function runs(cfg: Config, list: readonly Run[]): void {
  for (const r of list) {
    seq += 1;
    const report = parseTelemetryReport({
      jobId: `run-${seq}`, laneId: "slow", kind: "cli",
      ...(r.mode === undefined ? {} : { mode: r.mode }),
      wallClockMs: r.ms,
      exitCode: r.status === "completed" ? 0 : r.status === "abandoned" ? null : 1,
      status: r.status, estimatedInputTokens: 1, estimatedOutputTokens: 1,
    });
    expect(report, "fixture report must parse").not.toBeNull();
    recordLaneRun(cfg, report!, 1_700_000_000_000 + seq);
  }
}

const done = (ms: number, mode?: DispatchMode): Run =>
  mode === undefined ? { status: "completed", ms } : { status: "completed", ms, mode };
const times = (n: number, run: Run): Run[] => Array.from({ length: n }, () => ({ ...run }));
function lane(cfg: Config, mode?: DispatchMode): DispatchLane | undefined {
  return buildDispatch(cfg, mode === undefined ? {} : { mode }).ladder.find((candidate) => candidate.id === "slow");
}

describe("time-to-answer history selection", () => {
  it("reads each mode's own completed runs", () => {
    const cfg = freshConfig({ attemptMinSamples: 3 });
    runs(cfg, [done(10_000, "answer"), done(11_000, "answer"), done(12_000, "answer")]);
    runs(cfg, [done(400_000, "agent"), done(410_000, "agent"), done(420_000, "agent")]);
    expect(lane(cfg, "answer")?.timeToAnswer).toEqual({ medianMs: 11_000, p80Ms: 12_000, samples: 3, mode: "answer" });
    expect(lane(cfg, "agent")?.timeToAnswer).toEqual({ medianMs: 410_000, p80Ms: 420_000, samples: 3, mode: "agent" });
  });

  it("falls back to one legacy window when the specific mode is below attemptMinSamples", () => {
    const cfg = freshConfig({ attemptMinSamples: 3 });
    runs(cfg, [done(300_000), done(310_000), done(320_000)]);
    runs(cfg, [done(5_000, "answer")]);
    expect(lane(cfg, "answer")?.timeToAnswer).toEqual({ medianMs: 310_000, p80Ms: 320_000, samples: 3, mode: null });
  });

  it("uses only completed runs for time to answer", () => {
    const cfg = freshConfig({ attemptMinSamples: 3 });
    runs(cfg, [done(20_000), done(21_000), done(22_000)]);
    runs(cfg, [
      { status: "timed_out", ms: 900_000 },
      { status: "failed", ms: 700_000 },
      { status: "abandoned", ms: 300_000 },
    ]);
    expect(lane(cfg)?.timeToAnswer).toEqual({ medianMs: 21_000, p80Ms: 22_000, samples: 3, mode: null });
  });

  it("is absent when no run ever answered", () => {
    const cfg = freshConfig();
    runs(cfg, [{ status: "failed", ms: 5_000 }]);
    expect(lane(cfg)?.timeToAnswer).toBeUndefined();
  });
});

describe("own failure streaks", () => {
  it("an abandonment is the walk's decision and does not increment consecutiveFailures", () => {
    const cfg = freshConfig();
    runs(cfg, [done(10_000), { status: "failed", ms: 5_000 }, { status: "abandoned", ms: 90_000 }, { status: "timed_out", ms: 1_800_000 }]);
    expect(lane(cfg)?.recentFailures).toBe(2);
    runs(cfg, [done(12_000)]);
    expect(lane(cfg)?.recentFailures).toBeUndefined();
  });

  it("FAILING_LANE_STREAK own failures mark the lane failing; one fewer does not", () => {
    const cfg = freshConfig();
    runs(cfg, times(FAILING_LANE_STREAK - 1, { status: "failed", ms: 1_000 }));
    expect(lane(cfg)?.failing).toBeUndefined();
    runs(cfg, [{ status: "failed", ms: 1_000 }]);
    expect(lane(cfg)?.failing?.streak).toBe(FAILING_LANE_STREAK);
    const view = buildDispatch(cfg);
    expect(view.next?.id).toBe("slow");
    expect(view.reason).toBe('every ready lane is demoted or failing; "slow" is first among them in the ladder');
  });
});
