/**
 * The dispatch walk's PER-LANE attempt budget, derived from each lane's own recorded runs
 * (`attemptBudget` in `src/dispatch.ts`, owner direction 2026-09-08).
 *
 * The shipped budget was a flat 90 seconds. Measured against the live store the same day, that sat
 * BELOW the median run of two of the three working lanes, and below the free pool's median by a
 * factor of six — so the relay would have abandoned the free pool on nearly every dispatch, which
 * is the opposite of what the walk exists to do. The fix is the owner's own request-path mechanism:
 * a threshold read off what THIS endpoint has actually done.
 *
 * ⚠ What does NOT carry over is the token-normalised half of that ladder. A walk budget fires
 * BEFORE any answer arrives, so there is no output token to normalise by — the same reason
 * `hedge-trigger.ts`'s per-token rung is inert on the hedge path. Nothing here reads a request-path
 * number; only the method is shared.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import { buildDispatch, formatAttemptBudget, type DispatchLane } from "../src/dispatch.js";
import { parseTelemetryReport, recordLaneRun, laneStatsFor, MAX_LANE_STAT_SAMPLES, quantileWallClockMs } from "../src/dispatch-lane-stats.js";

const dir = mkdtempSync(join(tmpdir(), "llm-relay-attempt-budget-"));
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

/** Record `n` runs of the given durations against the one lane. */
function record(cfg: Config, durationsMs: readonly number[]): void {
  durationsMs.forEach((ms, i) => {
    const report = parseTelemetryReport({
      jobId: `job-${i}`,
      laneId: "slow",
      kind: "cli",
      wallClockMs: ms,
      exitCode: 0,
      status: "completed",
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
    });
    expect(report, "fixture report must parse").not.toBeNull();
    recordLaneRun(cfg, report!, 1_700_000_000_000 + i);
  });
}

/** Record `n` runs the WALK killed at `budgetMs` — the samples that must never enter the window. */
function recordAbandoned(cfg: Config, budgetMs: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const report = parseTelemetryReport({
      jobId: `abandoned-${i}`,
      laneId: "slow",
      kind: "cli",
      wallClockMs: budgetMs,
      exitCode: null,
      status: "abandoned",
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
    });
    expect(report, "fixture report must parse").not.toBeNull();
    recordLaneRun(cfg, report!, 1_700_000_100_000 + i);
  }
}

// ⚠ Derived from the field, never re-declared. A hand-written local shape here would have hidden
// the `clamped` basis and `quantileMs` from every assertion in this file.
function budgetOf(cfg: Config): DispatchLane["attemptBudget"] {
  return buildDispatch(cfg).ladder.find((l) => l.id === "slow")?.attemptBudget;
}

describe("per-lane attempt budget", () => {
  it("a lane with no history takes the FLAT budget, never a guess", () => {
    // ⚠ Unmeasured is "no opinion", never "slow" — the same asymmetry `latency-demotion.ts` states.
    expect(budgetOf(freshConfig())).toEqual({ ms: 90_000, basis: "floor", samples: 0 });
  });

  it("below the sample floor it is still FLAT, however slow those few runs were", () => {
    const cfg = freshConfig({ attemptMinSamples: 5 });
    record(cfg, [600_000, 600_000, 600_000, 600_000]);
    // Four very slow runs, one short of the floor: a quantile over four samples is not a
    // distribution, and treating it as one would hand a new lane a ceiling from its unluckiest run.
    expect(budgetOf(cfg)).toEqual({ ms: 90_000, basis: "floor", samples: 4 });
  });

  it("at the sample floor it switches to the lane's OWN quantile", () => {
    const cfg = freshConfig({ attemptMinSamples: 5, attemptQuantile: 0.8 });
    // Ten runs: p80 by nearest rank is the 8th value when sorted.
    const runs = [100_000, 110_000, 120_000, 130_000, 140_000, 150_000, 160_000, 170_000, 900_000, 900_000];
    record(cfg, runs);
    const sorted = [...runs].sort((a, b) => a - b);
    expect(budgetOf(cfg)).toEqual({ ms: sorted[7], basis: "history", samples: 10 });
    // And that is what `quantileWallClockMs` says independently — one definition, not two.
    expect(quantileWallClockMs(runs, 0.8)).toBe(sorted[7]);
  });

  it("⚠ never drops BELOW the flat budget, however fast the lane's history is", () => {
    // The flat figure is what the operator declared a lane is always worth waiting for. A lane
    // whose runs happen to be quick must not earn a smaller budget than that, or one fast streak
    // would make the relay permanently impatient with it.
    const cfg = freshConfig({ attemptMs: 90_000, attemptMinSamples: 3 });
    record(cfg, [1_000, 1_200, 1_400, 1_600]);
    expect(budgetOf(cfg)?.ms).toBe(90_000);
  });

  it("⚠ a clamped budget is labelled `clamped`, NOT `history` — it is the operator's number", () => {
    // ⚠ This assertion was `basis: "history"` until 2026-09-08, i.e. it PINNED the defect it should
    // have caught: the served figure is the operator's configured floor, and calling it `history`
    // reports a configuration value as a measurement of this lane's runs. Flipped in the same
    // commit as the source fix, which is this repository's standing protocol.
    const cfg = freshConfig({ attemptMs: 90_000, attemptMinSamples: 3 });
    record(cfg, [1_000, 1_200, 1_400, 1_600]);
    expect(budgetOf(cfg)).toEqual({ ms: 90_000, basis: "clamped", samples: 4, quantileMs: 1_600 });
  });

  it("a clamped budget carries the lane's OWN quantile, because that is the figure being hidden", () => {
    // The whole point of a per-lane budget is to expose what this lane actually takes. When the
    // floor wins, `ms` is not that number, so the number travels beside it or it is lost.
    const cfg = freshConfig({ attemptMs: 90_000, attemptMinSamples: 3, attemptQuantile: 0.8 });
    const runs = [6_000, 7_000, 8_000, 9_000, 10_000];
    record(cfg, runs);
    const budget = budgetOf(cfg);
    expect(budget?.quantileMs).toBe(quantileWallClockMs(runs, 0.8));
    expect(budget?.quantileMs).toBeLessThan(budget?.ms ?? 0);
  });

  it("renders a clamped budget as the floor AND the lane's own figure, never as 'recorded runs'", () => {
    const cfg = freshConfig({ attemptMs: 90_000, attemptMinSamples: 3 });
    record(cfg, [1_000, 1_200, 1_400, 1_600]);
    const budget = budgetOf(cfg);
    expect(budget).toBeDefined();
    const line = formatAttemptBudget(budget!);
    expect(line).toContain("flat floor");
    expect(line).toContain("1.6s");
    // The defect's user-visible face: "90s (from 4 recorded runs)" when no run took 90s.
    expect(line).not.toContain("recorded runs");
  });

  it("⚠⚠ an ABANDONED run contributes no duration — the budget must not measure itself", () => {
    // ⚠ The walk kills an abandoned lane AT its budget, so that wall clock IS the budget. Feeding
    // it back would make the next budget a measurement of the relay's own impatience, and it
    // ratchets: a lane slower than its budget is killed at B, B enters the window, the quantile is
    // pulled toward B, and the lane can never show it needed longer. That would lock out exactly
    // the slow-but-working lane the walk exists to route around.
    const cfg = freshConfig({ attemptMs: 1_000, attemptMinSamples: 3, attemptQuantile: 0.8 });
    record(cfg, [300_000, 310_000, 320_000, 330_000]);
    const before = budgetOf(cfg);
    // Ten abandonments at the 1 s budget. Under the old code these ten 1 000 ms samples would
    // dominate the window and collapse the quantile.
    recordAbandoned(cfg, 1_000, 10);
    const after = budgetOf(cfg);
    expect(after?.ms).toBe(before?.ms);
    expect(after?.samples).toBe(before?.samples);
  });

  it("an abandoned run still counts as a FAILURE — only its duration is withheld", () => {
    // Negative control in the other direction: that a lane did not answer IS evidence about the
    // lane, and the affinity memory acts on it. Withholding the count would hide a real signal.
    const cfg = freshConfig({ attemptMinSamples: 3 });
    record(cfg, [10_000, 11_000, 12_000]);
    const callsBefore = laneStatsFor(cfg, "slow")?.calls ?? 0;
    recordAbandoned(cfg, 1_000, 2);
    const stats = laneStatsFor(cfg, "slow");
    expect(stats?.calls).toBe(callsBefore + 2);
    expect(stats?.failures).toBe(2);
    expect(stats?.wallClockMs).toHaveLength(3);
  });

  it("a quantile ABOVE the floor keeps basis `history` and carries no quantileMs", () => {
    // Negative control: the clamp branch must not swallow the ordinary case.
    const cfg = freshConfig({ attemptMs: 1_000, attemptMinSamples: 3, attemptQuantile: 0.8 });
    record(cfg, [50_000, 60_000, 70_000, 80_000]);
    const budget = budgetOf(cfg);
    expect(budget?.basis).toBe("history");
    expect(budget?.quantileMs).toBeUndefined();
    expect(budget?.ms).toBeGreaterThan(1_000);
  });

  it("the quantile is configurable, and a higher one yields a longer budget", () => {
    const runs = [10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000, 1_000_000];
    const low = freshConfig({ attemptMs: 1_000, attemptMinSamples: 3, attemptQuantile: 0.5 });
    const high = freshConfig({ attemptMs: 1_000, attemptMinSamples: 3, attemptQuantile: 0.95 });
    record(low, runs);
    record(high, runs);
    const lowMs = budgetOf(low)!.ms;
    const highMs = budgetOf(high)!.ms;
    expect(highMs).toBeGreaterThan(lowMs);
    // Nearest-rank, so both answers are runs that actually happened — never an interpolation
    // between two, which would be a duration nothing ever took presented as a measurement.
    expect(runs).toContain(lowMs);
    expect(runs).toContain(highMs);
  });

  it("carries NO budget at all when the walk is off — the field says nothing rather than a default", () => {
    expect(budgetOf(freshConfig(false))).toBeUndefined();
  });

  it("renders its basis, because the two figures mean different things", () => {
    expect(formatAttemptBudget({ ms: 224_000, basis: "history", samples: 25 })).toBe(
      "budget: 224s (from 25 recorded runs)",
    );
    expect(formatAttemptBudget({ ms: 90_000, basis: "floor", samples: 2 })).toBe(
      "budget: 90s (flat — too few recorded runs, 2)",
    );
  });
});

describe("the rolling window is long enough for a quantile to mean something", () => {
  it("holds 100 samples, so a p80 rests on the 80th value rather than the 20th", () => {
    // Raised from 25 on owner direction 2026-09-08, when the window stopped being advisory and
    // started deciding how long a lane is waited for.
    expect(MAX_LANE_STAT_SAMPLES).toBe(100);
  });

  it("keeps the newest samples when the window overflows", () => {
    const cfg = freshConfig({ attemptMinSamples: 1, attemptQuantile: 0.999 });
    // One very slow run first, then a full window of fast ones: the slow one must age out, so the
    // budget must not still be reporting it.
    record(cfg, [5_000_000]);
    record(cfg, new Array(MAX_LANE_STAT_SAMPLES).fill(10_000));
    expect(budgetOf(cfg)!.ms).toBeLessThan(5_000_000);
  });
});
