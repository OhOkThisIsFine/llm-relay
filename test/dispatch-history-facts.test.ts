/**
 * Each lane's history columns on the dispatch view (`laneHistoryFacts` in `src/dispatch.ts`,
 * 2026-09-10): the walk budget per MODE, the raise after abandoned runs, the usual time to answer,
 * and the streak of own failures — `docs/history/dispatch-giveup-diagnosis-2026-09-10.md` §3 and §9 (F2, F6,
 * F8).
 *
 * The three budget defects that section measured: agent-mode and answer-mode runs shared one window
 * and one 90 s floor; a timed-out run fed its whole wall clock into the window; and an abandoned run
 * left no sample, so the budget could never rise past the point where the walk kept stopping the
 * lane.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import { buildDispatch, FAILING_LANE_STREAK, formatAttemptBudget, type DispatchLane } from "../src/dispatch.js";
import { parseTelemetryReport, recordLaneRun, type DispatchMode } from "../src/dispatch-lane-stats.js";

const dir = mkdtempSync(join(tmpdir(), "llm-relay-history-facts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function freshConfig(walk: Record<string, unknown> | boolean = {}): Config {
  const path = join(dir, `c-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      listen: "127.0.0.1:8791",
      providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" } },
      routing: {
        default: "anthropic",
        dispatchWalk: walk,
        ladder: [{ id: "slow", kind: "cli", command: "a", args: ["{task}"] }],
      },
    }),
  );
  return loadConfig(path);
}

type Status = "completed" | "failed" | "timed_out" | "abandoned";
interface Run {
  status: Status;
  ms: number;
  mode?: DispatchMode;
}
let seq = 0;

/** Record runs against the one lane, each with its own job id, optionally in one mode. */
function runs(cfg: Config, list: readonly Run[]): void {
  for (const r of list) {
    seq += 1;
    const report = parseTelemetryReport({
      jobId: `run-${seq}`,
      laneId: "slow",
      kind: "cli",
      ...(r.mode === undefined ? {} : { mode: r.mode }),
      wallClockMs: r.ms,
      exitCode: r.status === "completed" ? 0 : 1,
      status: r.status,
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
    });
    expect(report, "fixture report must parse").not.toBeNull();
    recordLaneRun(cfg, report!, 1_700_000_000_000 + seq);
  }
}

const done = (ms: number, mode?: DispatchMode): Run =>
  mode === undefined ? { status: "completed", ms } : { status: "completed", ms, mode };
const times = (n: number, run: Run): Run[] => Array.from({ length: n }, () => ({ ...run }));

function lane(cfg: Config, mode?: DispatchMode): DispatchLane | undefined {
  return buildDispatch(cfg, mode === undefined ? {} : { mode }).ladder.find((l) => l.id === "slow");
}

describe("per-mode walk budgets (F2)", () => {
  it("an agent-mode dispatch is floored at agentAttemptMs, an answer-mode one at attemptMs", () => {
    // Measured 2026-09-10: free-pool's agent-mode runs took minutes and its answer-mode runs
    // seconds, so one flat 90 s floor stopped nearly every agent-mode run before it could answer.
    const cfg = freshConfig({ attemptMs: 90_000, agentAttemptMs: 600_000 });
    expect(lane(cfg, "agent")?.attemptBudget).toEqual({ ms: 600_000, basis: "floor", samples: 0 });
    expect(lane(cfg, "answer")?.attemptBudget).toEqual({ ms: 90_000, basis: "floor", samples: 0 });
    // A view that states no mode keeps the flat attemptMs, the behaviour before modes existed.
    expect(lane(cfg)?.attemptBudget).toEqual({ ms: 90_000, basis: "floor", samples: 0 });
  });

  it("each mode's budget reads that mode's own runs, never the other mode's", () => {
    const cfg = freshConfig({ attemptMs: 1_000, agentAttemptMs: 1_000, attemptMinSamples: 3 });
    runs(cfg, [done(10_000, "answer"), done(11_000, "answer"), done(12_000, "answer")]);
    runs(cfg, [done(400_000, "agent"), done(410_000, "agent"), done(420_000, "agent")]);
    expect(lane(cfg, "answer")?.attemptBudget).toEqual({ ms: 12_000, basis: "history", samples: 3 });
    expect(lane(cfg, "agent")?.attemptBudget).toEqual({ ms: 420_000, basis: "history", samples: 3 });
  });

  it("a mode with too few runs falls back to the legacy mode-less window — one window, never a merge", () => {
    const cfg = freshConfig({ attemptMs: 1_000, agentAttemptMs: 1_000, attemptMinSamples: 3 });
    runs(cfg, [done(300_000), done(310_000), done(320_000)]);
    runs(cfg, [done(5_000, "answer")]);
    expect(lane(cfg, "answer")?.attemptBudget).toEqual({ ms: 320_000, basis: "history", samples: 3 });
  });

  it("⚠ a timed-out or failed run adds NO duration: the window is the time to ANSWER", () => {
    // Measured 2026-09-10: a lane's window built from its own timeouts made the timeout itself its
    // p80 budget, so the lane that answered least was given the most time.
    const cfg = freshConfig({ attemptMs: 1_000, attemptMinSamples: 3 });
    runs(cfg, [done(20_000), done(21_000), done(22_000)]);
    runs(cfg, [{ status: "timed_out", ms: 900_000 }, { status: "timed_out", ms: 900_000 }, { status: "failed", ms: 700_000 }]);
    expect(lane(cfg)?.attemptBudget).toEqual({ ms: 22_000, basis: "history", samples: 3 });
  });
});

describe("the raise after abandoned runs (F2)", () => {
  it("each abandonment since the last answer doubles the budget, and the ladder says so", () => {
    const cfg = freshConfig({ attemptMs: 60_000, attemptMinSamples: 3 });
    runs(cfg, [{ status: "abandoned", ms: 60_000 }]);
    expect(lane(cfg)?.attemptBudget).toEqual({ ms: 120_000, basis: "floor", samples: 0, raisedBy: 1 });
    runs(cfg, [{ status: "abandoned", ms: 120_000 }]);
    const budget = lane(cfg)?.attemptBudget;
    expect(budget).toEqual({ ms: 240_000, basis: "floor", samples: 0, raisedBy: 2 });
    expect(formatAttemptBudget(budget!)).toBe(
      "budget: 240s (flat — too few recorded runs, 0; raised after 2 abandoned runs, ×2 each, at most 3600s)",
    );
  });

  it("one completed run resets the raise", () => {
    const cfg = freshConfig({ attemptMs: 60_000, attemptMinSamples: 3 });
    runs(cfg, [{ status: "abandoned", ms: 60_000 }, { status: "abandoned", ms: 120_000 }, done(200_000)]);
    expect(lane(cfg)?.attemptBudget).toEqual({ ms: 60_000, basis: "floor", samples: 1 });
  });

  it("the raise stops at one hour however long the streak, and never prints a multiplier it did not apply", () => {
    const cfg = freshConfig({ attemptMs: 60_000 });
    runs(cfg, times(40, { status: "abandoned", ms: 60_000 }));
    const budget = lane(cfg)?.attemptBudget;
    expect(budget).toMatchObject({ ms: 3_600_000, raisedBy: 40 });
    expect(formatAttemptBudget(budget!)).not.toMatch(/×\d{3,}/);
  });
});

describe("time to answer and the failure streak (F8, F1, F6)", () => {
  it("timeToAnswer is the median and p80 of COMPLETED runs, from the window the budget reads", () => {
    const cfg = freshConfig({ attemptMinSamples: 3 });
    runs(cfg, [done(20_000), done(40_000), { status: "failed", ms: 5_000 }]);
    expect(lane(cfg)?.timeToAnswer).toEqual({ medianMs: 30_000, p80Ms: 40_000, samples: 2, mode: null });
  });

  it("is absent when no run ever answered — unknown is never a zero", () => {
    const cfg = freshConfig();
    runs(cfg, [{ status: "failed", ms: 5_000 }]);
    expect(lane(cfg)?.timeToAnswer).toBeUndefined();
  });

  it("recentFailures counts own failures in a row; an abandonment is the walk's decision and is not one", () => {
    const cfg = freshConfig();
    runs(cfg, [done(10_000), { status: "failed", ms: 5_000 }, { status: "abandoned", ms: 90_000 }, { status: "timed_out", ms: 1_800_000 }]);
    expect(lane(cfg)?.recentFailures).toBe(2);
    runs(cfg, [done(12_000)]);
    expect(lane(cfg)?.recentFailures).toBeUndefined();
  });

  it("FAILING_LANE_STREAK own failures mark the lane `failing`; one fewer does not", () => {
    const cfg = freshConfig();
    runs(cfg, times(FAILING_LANE_STREAK - 1, { status: "failed", ms: 1_000 }));
    expect(lane(cfg)?.failing).toBeUndefined();
    runs(cfg, [{ status: "failed", ms: 1_000 }]);
    expect(lane(cfg)?.failing?.streak).toBe(FAILING_LANE_STREAK);
    // The only lane stays selectable — demoted, never dropped — and the reason says why it leads.
    const view = buildDispatch(cfg);
    expect(view.next?.id).toBe("slow");
    expect(view.reason).toBe('every ready lane is demoted or failing; "slow" is first among them in the ladder');
  });
});
