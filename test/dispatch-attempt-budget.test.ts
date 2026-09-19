/**
 * Legacy dispatch attempt-budget configuration after the idle-only stopping change (v0.84).
 *
 * The old keys still load so existing configs are not broken, but no DispatchLane carries an
 * attemptBudget and changing those keys cannot change history-derived time-to-answer facts.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import { buildDispatch } from "../src/dispatch.js";
import { exportLaneStatsRows, laneStatsFor, parseTelemetryReport, recordLaneRun } from "../src/dispatch-lane-stats.js";

const dir = mkdtempSync(join(tmpdir(), "llm-relay-legacy-attempt-budget-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function freshConfig(attempt: Record<string, unknown>): Config {
  const path = join(dir, `c-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({
    listen: "127.0.0.1:8791",
    providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" } },
    routing: {
      default: "anthropic",
      dispatchWalk: { attemptMinSamples: 3, ...attempt },
      ladder: [{ id: "slow", kind: "cli", command: "a", args: ["{task}"] }],
    },
  }));
  return loadConfig(path);
}

function recordCompleted(cfg: Config, durations: readonly number[]): void {
  durations.forEach((wallClockMs, i) => {
    const report = parseTelemetryReport({
      jobId: `job-${i}`, laneId: "slow", kind: "cli", wallClockMs, exitCode: 0,
      status: "completed", estimatedInputTokens: 1, estimatedOutputTokens: 1,
    });
    expect(report).not.toBeNull();
    recordLaneRun(cfg, report!, 1_700_000_000_000 + i);
  });
}

describe("legacy dispatch attempt-budget settings", () => {
  it("remain parseable but no longer materialize an attemptBudget on a lane", () => {
    const cfg = freshConfig({ attemptMs: 1_000, agentAttemptMs: 2_000, attemptQuantile: 0.51 });
    const lane = buildDispatch(cfg).ladder.find((candidate) => candidate.id === "slow");
    expect(lane).not.toHaveProperty("attemptBudget");
    expect(cfg.warnings ?? []).toEqual(expect.arrayContaining([
      expect.stringContaining("config.routing.dispatchWalk.attemptMs"),
      expect.stringContaining("config.routing.dispatchWalk.agentAttemptMs"),
      expect.stringContaining("config.routing.dispatchWalk.attemptQuantile"),
    ]));
  });

  it("changing the legacy knobs cannot change the lane's time-to-answer history", () => {
    const low = freshConfig({ attemptMs: 1_000, agentAttemptMs: 1_000, attemptQuantile: 0.1 });
    const high = freshConfig({ attemptMs: 3_600_000, agentAttemptMs: 3_600_000, attemptQuantile: 0.99 });
    const runs = [10_000, 20_000, 30_000, 40_000];
    recordCompleted(low, runs);
    recordCompleted(high, runs);
    const lowLane = buildDispatch(low).ladder.find((candidate) => candidate.id === "slow");
    const highLane = buildDispatch(high).ladder.find((candidate) => candidate.id === "slow");
    expect(lowLane?.timeToAnswer).toEqual(highLane?.timeToAnswer);
    expect(lowLane?.timeToAnswer).toEqual({ medianMs: 25_000, p80Ms: 40_000, samples: 4, mode: null });
  });

  it("an idle-stop remains a failure count but creates no duration or dead abandonment counter", () => {
    const cfg = freshConfig({});
    recordCompleted(cfg, [10_000, 20_000, 30_000]);
    const abandoned = parseTelemetryReport({
      jobId: "abandoned", laneId: "slow", kind: "cli", wallClockMs: 300_000, exitCode: null,
      status: "abandoned", estimatedInputTokens: 1, estimatedOutputTokens: 1,
    });
    expect(abandoned).not.toBeNull();
    recordLaneRun(cfg, abandoned!);
    const live = laneStatsFor(cfg, "slow");
    expect(live).toMatchObject({ calls: 4, successes: 3, failures: 1, wallClockMs: [10_000, 20_000, 30_000] });
    expect(live).not.toHaveProperty("abandonedSinceSuccess");
    expect(exportLaneStatsRows(cfg)[0]).not.toHaveProperty("abandonedSinceSuccess");
  });
});
