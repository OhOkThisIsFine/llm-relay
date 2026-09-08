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
import { buildDispatch, formatAttemptBudget } from "../src/dispatch.js";
import { parseTelemetryReport, recordLaneRun, MAX_LANE_STAT_SAMPLES, quantileWallClockMs } from "../src/dispatch-lane-stats.js";

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

function budgetOf(cfg: Config): { ms: number; basis: string; samples: number } | undefined {
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
    expect(budgetOf(cfg)).toEqual({ ms: 90_000, basis: "history", samples: 4 });
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
