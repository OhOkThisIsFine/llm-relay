/**
 * Per-lane execution stats for the dispatch ladder (`src/dispatch-lane-stats.ts`).
 *
 * Lane stats are the advisory half of a lane run (how often each rung was taken, how long it
 * took) beside the cooldown half in `dispatch.ts`. They never reorder the ladder and never
 * feed HTTP pool scoring — that separation is the whole point, so it is pinned here and in
 * `test/admin-dispatch-telemetry.test.ts` (the runtime-telemetry negative control).
 *
 * ⚠ Every persistence test here uses an explicit temp path — same rule as the
 * exhaustion-persistence suite.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CURRENT_DISPATCH_LANE_STATS_VERSION,
  MAX_LANE_STAT_SAMPLES,
  allLaneStats,
  exportLaneStatsRows,
  getDispatchLaneStatsPath,
  installDispatchLaneStatsPersistence,
  laneRoutesThroughRelay,
  laneStatsFor,
  loadLaneStatsRows,
  medianWallClockMs,
  parseTelemetryReport,
  recordLaneRun,
  restoreLaneStatsRows,
  saveLaneStatsRows,
  type DispatchedTelemetryReport,
  type LaneStatsRow,
} from "../src/dispatch-lane-stats.js";
import { loadConfig, type Config } from "../src/config.js";

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-relay-lane-stats-"));
  statePath = join(dir, "dispatch-lane-stats.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Lane stats are per-Config, so a fresh Config per call IS isolation. */
function freshConfig(): Config {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      listen: "127.0.0.1:8791",
      providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" } },
      routing: {
        default: "anthropic",
        ladder: [
          { id: "codex-sol", kind: "cli", quota: "codex-sol", command: "codex", args: ["exec", "{task}"] },
          { id: "anthropic", kind: "relay", spec: "anthropic" },
        ],
      },
    }),
  );
  return loadConfig(path);
}

function validReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: "job-0001",
    laneId: "codex-sol",
    kind: "cli",
    spec: "openai/gpt-5",
    wallClockMs: 12_500,
    exitCode: 0,
    status: "completed",
    estimatedInputTokens: 25,
    estimatedOutputTokens: 400,
    ...overrides,
  };
}

describe("parseTelemetryReport", () => {
  it("accepts a valid report, with and without the optional spec", () => {
    const parsed = parseTelemetryReport(validReport());
    expect(parsed).toEqual(validReport());
    const { spec: _dropped, ...withoutSpec } = validReport();
    const parsedWithoutSpec = parseTelemetryReport(withoutSpec);
    expect(parsedWithoutSpec).toEqual(withoutSpec);
    expect(parsedWithoutSpec).not.toHaveProperty("spec");
    const relay = parseTelemetryReport(validReport({ kind: "relay", spec: undefined, status: "timed_out", exitCode: null }));
    expect(relay?.kind).toBe("relay");
    expect(relay?.status).toBe("timed_out");
    expect(relay?.exitCode).toBeNull();
  });

  it("rejects a non-object body", () => {
    for (const body of [null, undefined, 42, "report", [], [{ ...validReport() }]]) {
      expect(parseTelemetryReport(body)).toBeNull();
    }
  });

  it("rejects an unknown key — providerKey/modelId travel nowhere on this route", () => {
    expect(parseTelemetryReport(validReport({ providerKey: "openai" }))).toBeNull();
    expect(parseTelemetryReport(validReport({ modelId: "gpt-5" }))).toBeNull();
    expect(parseTelemetryReport(validReport({ extra: 1 }))).toBeNull();
  });

  it("rejects a bad kind or status instead of guessing", () => {
    expect(parseTelemetryReport(validReport({ kind: "agent" }))).toBeNull();
    expect(parseTelemetryReport(validReport({ kind: "CLI" }))).toBeNull();
    expect(parseTelemetryReport(validReport({ status: "cancelled" }))).toBeNull();
    expect(parseTelemetryReport(validReport({ status: "succeeded" }))).toBeNull();
  });

  it("rejects negative, fractional, or non-numeric token counts", () => {
    expect(parseTelemetryReport(validReport({ estimatedInputTokens: -1 }))).toBeNull();
    expect(parseTelemetryReport(validReport({ estimatedOutputTokens: -1 }))).toBeNull();
    expect(parseTelemetryReport(validReport({ estimatedInputTokens: 2.5 }))).toBeNull();
    expect(parseTelemetryReport(validReport({ estimatedOutputTokens: "400" }))).toBeNull();
    expect(parseTelemetryReport(validReport({ estimatedInputTokens: Number.NaN }))).toBeNull();
    expect(parseTelemetryReport(validReport({ estimatedOutputTokens: Number.POSITIVE_INFINITY }))).toBeNull();
  });

  it("rejects a missing field", () => {
    for (const key of ["jobId", "laneId", "kind", "wallClockMs", "exitCode", "status", "estimatedInputTokens", "estimatedOutputTokens"]) {
      const { [key]: _dropped, ...rest } = validReport();
      expect(parseTelemetryReport(rest), key).toBeNull();
    }
  });

  it("rejects over-long, empty, or unsafe ids", () => {
    expect(parseTelemetryReport(validReport({ jobId: "x".repeat(65) }))).toBeNull();
    expect(parseTelemetryReport(validReport({ laneId: "x".repeat(201) }))).toBeNull();
    expect(parseTelemetryReport(validReport({ spec: "x".repeat(201) }))).toBeNull();
    expect(parseTelemetryReport(validReport({ jobId: "" }))).toBeNull();
    expect(parseTelemetryReport(validReport({ laneId: "" }))).toBeNull();
    expect(parseTelemetryReport(validReport({ spec: "" }))).toBeNull();
    // Control characters are not id characters — ids travel into file names and logs.
    expect(parseTelemetryReport(validReport({ jobId: "job-1\n2" }))).toBeNull();
    expect(parseTelemetryReport(validReport({ laneId: "lane\t1" }))).toBeNull();
    expect(parseTelemetryReport(validReport({ jobId: "x".repeat(64) }))).not.toBeNull();
    expect(parseTelemetryReport(validReport({ laneId: "x".repeat(200) }))).not.toBeNull();
  });

  it("rejects a bad wallClockMs or exitCode", () => {
    expect(parseTelemetryReport(validReport({ wallClockMs: -1 }))).toBeNull();
    expect(parseTelemetryReport(validReport({ wallClockMs: Number.NaN }))).toBeNull();
    expect(parseTelemetryReport(validReport({ wallClockMs: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(parseTelemetryReport(validReport({ wallClockMs: "12500" }))).toBeNull();
    expect(parseTelemetryReport(validReport({ exitCode: 1.5 }))).toBeNull();
    expect(parseTelemetryReport(validReport({ exitCode: "0" }))).toBeNull();
    expect(parseTelemetryReport(validReport({ exitCode: Number.NaN }))).toBeNull();
    // A signalled lane reports null; a nonzero exit is still a well-formed report.
    expect(parseTelemetryReport(validReport({ exitCode: 1, status: "failed" }))).not.toBeNull();
  });
});

describe("lane run counting", () => {
  function reportFor(laneId: string, status: DispatchedTelemetryReport["status"]): DispatchedTelemetryReport {
    return parseTelemetryReport(validReport({ jobId: `job-${laneId}-${status}`, laneId, status }))!;
  }

  it("counts completed as a success, failed as a failure, timed_out as both", () => {
    const cfg = freshConfig();
    recordLaneRun(cfg, reportFor("a", "completed"));
    recordLaneRun(cfg, reportFor("a", "completed"));
    recordLaneRun(cfg, reportFor("a", "failed"));
    recordLaneRun(cfg, reportFor("a", "timed_out"));
    expect(laneStatsFor(cfg, "a")).toMatchObject({
      calls: 4,
      successes: 2,
      failures: 2,
      timeouts: 1,
    });
  });

  it("keeps lanes separate and stamps lastAt", () => {
    const cfg = freshConfig();
    const before = Date.now();
    recordLaneRun(cfg, reportFor("a", "completed"), before);
    recordLaneRun(cfg, reportFor("b", "failed"), before + 10);
    expect(laneStatsFor(cfg, "a")).toMatchObject({ calls: 1, successes: 1, lastAt: before });
    expect(laneStatsFor(cfg, "b")).toMatchObject({ calls: 1, failures: 1, lastAt: before + 10 });
    expect(laneStatsFor(cfg, "ghost")).toBeUndefined();
    expect(allLaneStats(cfg).map((row) => row.laneId)).toEqual(["a", "b"]);
  });

  it("bounds the wall-clock window, oldest dropped", () => {
    const cfg = freshConfig();
    for (let i = 0; i < MAX_LANE_STAT_SAMPLES + 10; i++) {
      const report = reportFor("a", "completed");
      recordLaneRun(cfg, { ...report, wallClockMs: i });
    }
    const stats = laneStatsFor(cfg, "a")!;
    expect(stats.wallClockMs).toHaveLength(MAX_LANE_STAT_SAMPLES);
    expect(stats.wallClockMs[0]).toBe(10);
    expect(stats.wallClockMs[MAX_LANE_STAT_SAMPLES - 1]).toBe(MAX_LANE_STAT_SAMPLES + 9);
    expect(stats.calls).toBe(MAX_LANE_STAT_SAMPLES + 10);
  });

  it("hands out copies — a caller cannot mutate the live map", () => {
    const cfg = freshConfig();
    recordLaneRun(cfg, reportFor("a", "completed"));
    const seen = laneStatsFor(cfg, "a")!;
    seen.calls = 99;
    seen.wallClockMs.push(1);
    expect(laneStatsFor(cfg, "a")).toMatchObject({ calls: 1 });
    expect(laneStatsFor(cfg, "a")!.wallClockMs).toHaveLength(1);
  });

  it("⚠ restore never overwrites stats the live process already learned", () => {
    const cfg = freshConfig();
    recordLaneRun(cfg, reportFor("a", "completed"));
    const rows: LaneStatsRow[] = [
      { laneId: "a", calls: 99, successes: 99, failures: 0, timeouts: 0, wallClockMs: [1], lastAt: 1 },
      { laneId: "b", calls: 3, successes: 2, failures: 1, timeouts: 0, wallClockMs: [5, 6], lastAt: 2 },
    ];
    expect(restoreLaneStatsRows(cfg, rows)).toBe(1);
    expect(laneStatsFor(cfg, "a")).toMatchObject({ calls: 1, successes: 1 });
    expect(laneStatsFor(cfg, "b")).toMatchObject({ calls: 3, successes: 2, failures: 1 });
  });
});

describe("medianWallClockMs", () => {
  it("returns null for an empty window — unknown, never 0", () => {
    expect(medianWallClockMs([])).toBeNull();
  });

  it("returns the middle sample for an odd count", () => {
    expect(medianWallClockMs([30_000])).toBe(30_000);
    expect(medianWallClockMs([10, 30, 20])).toBe(20);
  });

  it("averages the two middle samples for an even count", () => {
    expect(medianWallClockMs([10, 30])).toBe(20);
    expect(medianWallClockMs([10, 20, 30, 40])).toBe(25);
  });

  it("sorts before picking — insertion order is not the answer", () => {
    expect(medianWallClockMs([50, 10, 30, 20, 40])).toBe(30);
  });
});

describe("laneRoutesThroughRelay", () => {
  const listener = { host: "127.0.0.1", port: 8791 };

  it("matches a closed-list env URL on the listener's own origin", () => {
    expect(laneRoutesThroughRelay({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8791" } }, listener)).toBe(true);
    expect(laneRoutesThroughRelay({ env: { OPENAI_BASE_URL: "http://127.0.0.1:8791/v1" } }, listener)).toBe(true);
  });

  it("rejects a different port, host, or scheme", () => {
    expect(laneRoutesThroughRelay({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8792" } }, listener)).toBe(false);
    expect(laneRoutesThroughRelay({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.2:8791" } }, listener)).toBe(false);
    expect(laneRoutesThroughRelay({ env: { ANTHROPIC_BASE_URL: "https://127.0.0.1:8791" } }, listener)).toBe(false);
    expect(laneRoutesThroughRelay({ env: { OPENAI_BASE_URL: "https://api.openai.com/v1" } }, listener)).toBe(false);
  });

  it("compares origins, not strings: IPv6 brackets and default ports", () => {
    const v6 = { host: "::1", port: 8791 };
    expect(laneRoutesThroughRelay({ env: { ANTHROPIC_BASE_URL: "http://[::1]:8791" } }, v6)).toBe(true);
    expect(laneRoutesThroughRelay({ env: { ANTHROPIC_BASE_URL: "http://[::1]:8792" } }, v6)).toBe(false);
    expect(
      laneRoutesThroughRelay({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1" } }, { host: "127.0.0.1", port: 80 }),
    ).toBe(true);
    expect(
      laneRoutesThroughRelay({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:80" } }, { host: "127.0.0.1", port: 80 }),
    ).toBe(true);
  });

  it("is false for an unset (null) value, an unparseable URL, or any other name", () => {
    expect(laneRoutesThroughRelay({ env: { ANTHROPIC_BASE_URL: null } }, listener)).toBe(false);
    expect(laneRoutesThroughRelay({ env: { ANTHROPIC_BASE_URL: "not a url at all" } }, listener)).toBe(false);
    expect(laneRoutesThroughRelay({ env: { ANTHROPIC_AUTH_TOKEN: "http://127.0.0.1:8791" } }, listener)).toBe(false);
    expect(laneRoutesThroughRelay({ env: { CLAUDE_CONFIG_DIR: "/home/me/.llm-relay-claude" } }, listener)).toBe(false);
    expect(laneRoutesThroughRelay({}, listener)).toBe(false);
  });
});

describe("lane stats persistence", () => {
  it("redirects its default path under vitest", () => {
    expect(getDispatchLaneStatsPath()).toContain("llm-relay-vitest");
    expect(getDispatchLaneStatsPath()).toContain("dispatch-lane-stats.json");
  });

  it("round-trips rows through an explicit path", () => {
    const cfg = freshConfig();
    recordLaneRun(cfg, parseTelemetryReport(validReport({ jobId: "job-1", laneId: "a" }))!);
    recordLaneRun(cfg, parseTelemetryReport(validReport({ jobId: "job-2", laneId: "b", status: "failed", exitCode: 1 }))!);
    const rows = exportLaneStatsRows(cfg);
    expect(rows).toHaveLength(2);

    const after = freshConfig();
    expect(restoreLaneStatsRows(after, rows)).toBe(2);
    expect(laneStatsFor(after, "a")).toEqual(laneStatsFor(cfg, "a"));
    expect(laneStatsFor(after, "b")).toEqual(laneStatsFor(cfg, "b"));
  });

  it("⚠ restores NOTHING from a corrupt file, wrong version, or wrong envelope", () => {
    writeFileSync(statePath, "not json");
    expect(loadLaneStatsRows({ path: statePath })).toEqual([]);
    writeFileSync(statePath, JSON.stringify({ version: 999, rows: [] }));
    expect(loadLaneStatsRows({ path: statePath })).toEqual([]);
    writeFileSync(statePath, JSON.stringify({ version: CURRENT_DISPATCH_LANE_STATS_VERSION, rows: "nope" }));
    expect(loadLaneStatsRows({ path: statePath })).toEqual([]);
    writeFileSync(statePath, JSON.stringify({ rows: [] }));
    expect(loadLaneStatsRows({ path: statePath })).toEqual([]);
  });

  it("⚠ drops ONE malformed row without taking the file down", () => {
    const good: LaneStatsRow = {
      laneId: "good",
      calls: 2,
      successes: 2,
      failures: 0,
      timeouts: 0,
      wallClockMs: [10],
      lastAt: 1_000,
    };
    writeFileSync(
      statePath,
      JSON.stringify({
        version: CURRENT_DISPATCH_LANE_STATS_VERSION,
        rows: [
          good,
          { laneId: "", calls: 1, successes: 1, failures: 0, timeouts: 0, wallClockMs: [], lastAt: null },
          { laneId: "bad-calls", calls: -1, successes: 0, failures: 0, timeouts: 0, wallClockMs: [], lastAt: null },
          { laneId: "bad-sample", calls: 1, successes: 1, failures: 0, timeouts: 0, wallClockMs: [-5], lastAt: null },
          { laneId: "bad-last", calls: 1, successes: 1, failures: 0, timeouts: 0, wallClockMs: [], lastAt: "soon" },
          null,
        ],
      }),
    );
    expect(loadLaneStatsRows({ path: statePath })).toEqual([good]);
  });

  it("⚠ drops a row whose sample window exceeds the bound the relay ever writes", () => {
    // The relay never writes more than MAX_LANE_STAT_SAMPLES, so a longer window is
    // corruption, not history — the loader drops the row alone (finding N3).
    const good: LaneStatsRow = {
      laneId: "good",
      calls: 1,
      successes: 1,
      failures: 0,
      timeouts: 0,
      wallClockMs: new Array(MAX_LANE_STAT_SAMPLES).fill(10),
      lastAt: null,
    };
    const oversized: LaneStatsRow = {
      laneId: "oversized",
      calls: MAX_LANE_STAT_SAMPLES + 1,
      successes: MAX_LANE_STAT_SAMPLES + 1,
      failures: 0,
      timeouts: 0,
      wallClockMs: new Array(MAX_LANE_STAT_SAMPLES + 1).fill(10),
      lastAt: null,
    };
    writeFileSync(
      statePath,
      JSON.stringify({ version: CURRENT_DISPATCH_LANE_STATS_VERSION, rows: [good, oversized] }),
    );
    expect(loadLaneStatsRows({ path: statePath })).toEqual([good]);
  });

  it("carries a lane's stats across a restart via install", () => {
    const before = freshConfig();
    installDispatchLaneStatsPersistence(before, { path: statePath });
    recordLaneRun(before, parseTelemetryReport(validReport({ jobId: "job-1", laneId: "a" }))!);
    // The write-behind timer is debounced, so force the flush the way a shutdown would.
    saveLaneStatsRows(exportLaneStatsRows(before), { path: statePath });

    // ── restart ─────────────────────────────────────────────────────────────────────────────
    const after = freshConfig();
    expect(installDispatchLaneStatsPersistence(after, { path: statePath })).toBe(1);
    expect(laneStatsFor(after, "a")).toMatchObject({ calls: 1, successes: 1 });
  });

  it("flushes mutations through the change listener (debounced), including a second lane", async () => {
    const cfg = freshConfig();
    installDispatchLaneStatsPersistence(cfg, { path: statePath });
    recordLaneRun(cfg, parseTelemetryReport(validReport({ jobId: "job-1", laneId: "a" }))!);
    recordLaneRun(cfg, parseTelemetryReport(validReport({ jobId: "job-2", laneId: "b", status: "failed", exitCode: 1 }))!);
    // DEFAULT_FLUSH_DELAY_MS is 250ms; wait past it so the coalesced write is on disk.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const rows = loadLaneStatsRows({ path: statePath });
    expect(rows.map((row) => row.laneId).sort()).toEqual(["a", "b"]);
  });
});
