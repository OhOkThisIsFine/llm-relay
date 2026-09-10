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
  flushDispatchLaneStatsPersistence,
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

  it("the shutdown flush writes a run recorded inside the write-behind window", () => {
    // Until 2026-09-08 the installer's timer lived in a closure nothing could reach, so a lane
    // run recorded in the last two seconds before a graceful stop never reached the file.
    const cfg = freshConfig();
    installDispatchLaneStatsPersistence(cfg, { path: statePath });
    recordLaneRun(cfg, parseTelemetryReport(validReport({ jobId: "job-1", laneId: "a" }))!);
    // Same tick: the debounced timer has not fired, so the file does not carry the row yet.
    expect(loadLaneStatsRows({ path: statePath })).toEqual([]);

    expect(flushDispatchLaneStatsPersistence()).toBeGreaterThanOrEqual(1);
    expect(loadLaneStatsRows({ path: statePath }).map((row) => row.laneId)).toEqual(["a"]);
    // Nothing is dirty any more: a second shutdown pass writes nothing for this store.
    expect(flushDispatchLaneStatsPersistence()).toBe(0);
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

describe("tier-keyed windows (backlog item 4)", () => {
  function tieredReport(
    laneId: string,
    tier: string | null,
    wallClockMs: number,
    jobId: string,
  ): DispatchedTelemetryReport {
    const parsed = parseTelemetryReport(
      validReport({ jobId, laneId, wallClockMs, ...(tier === null ? {} : { tier }) }),
    );
    if (!parsed) throw new Error("fixture telemetry report rejected");
    return parsed;
  }

  it("a v0.77.1-shaped file restores with the same counts — rows with no `tier`, samples with no `at`", () => {
    // ⚠ The fixture MUST be raw JSON text (the `catalog.ts` precedent): it pins what the
    // previous release wrote — no `tier` key on the row, bare numbers for samples — so a
    // change to the writer cannot silently rewrite the past it claims to load.
    writeFileSync(
      statePath,
      '{"version":1,"rows":[' +
        '{"laneId":"a","calls":2,"successes":2,"failures":0,"timeouts":0,"wallClockMs":[10000,12000],"lastAt":1700000000000},' +
        '{"laneId":"b","calls":1,"successes":0,"failures":1,"timeouts":0,"wallClockMs":[30000],"lastAt":null}' +
        "]}",
    );
    const rows = loadLaneStatsRows({ path: statePath });
    expect(rows).toHaveLength(2);
    const cfg = freshConfig();
    expect(restoreLaneStatsRows(cfg, rows)).toBe(2);
    // A legacy row loads unchanged, as the tier-less window: nothing is rewritten or copied.
    expect(laneStatsFor(cfg, "a")).toMatchObject({ calls: 2, successes: 2 });
    expect(laneStatsFor(cfg, "a")!.wallClockMs).toEqual([10000, 12000]);
    expect(laneStatsFor(cfg, "b")).toMatchObject({ calls: 1, failures: 1 });
    expect(allLaneStats(cfg)).toMatchObject([
      { laneId: "a", tier: null },
      { laneId: "b", tier: null },
    ]);
  });

  it("⚠ a pre-2026-09-10 row whose samples outnumber its successes restores with an EMPTY window", () => {
    // Before 2026-09-10 a failed or timed-out run added its duration too, so a row holding more
    // samples than successes provably holds the duration of a run that did not answer — and which
    // one is unknown. Measured on the live store: `anthropic` read "usually answers in 0s" at 0 of 24.
    writeFileSync(
      statePath,
      '{"version":1,"rows":[' +
        '{"laneId":"dead","calls":24,"successes":0,"failures":24,"timeouts":0,"wallClockMs":[300,200,250],"lastAt":null},' +
        '{"laneId":"mixed","calls":13,"successes":1,"failures":12,"timeouts":4,"wallClockMs":[270000,1034000],"lastAt":null},' +
        '{"laneId":"clean","calls":5,"successes":5,"failures":0,"timeouts":0,"wallClockMs":[10000,12000],"lastAt":null}' +
        "]}",
    );
    const cfg = freshConfig();
    expect(restoreLaneStatsRows(cfg, loadLaneStatsRows({ path: statePath }))).toBe(3);
    expect(laneStatsFor(cfg, "dead")!.wallClockMs).toEqual([]);
    expect(laneStatsFor(cfg, "dead")!.wallClockAt).toEqual([]);
    expect(laneStatsFor(cfg, "mixed")!.wallClockMs).toEqual([]);
    // The counts are evidence and are kept whole; only the durations go.
    expect(laneStatsFor(cfg, "mixed")).toMatchObject({ calls: 13, successes: 1, failures: 12, timeouts: 4 });
    // A window that could hold only answers is kept: its counts cannot prove it clean, and dropping it
    // would throw away real history.
    expect(laneStatsFor(cfg, "clean")!.wallClockMs).toEqual([10000, 12000]);
  });

  it("negative control: a row written since 2026-09-10 restores its window exactly, whatever its counts", () => {
    writeFileSync(
      statePath,
      '{"version":1,"rows":[' +
        '{"laneId":"new","calls":1,"successes":0,"failures":1,"timeouts":0,"consecutiveFailures":1,"abandonedSinceSuccess":0,"lastSuccessAt":null,"wallClockMs":[5000],"lastAt":null}' +
        "]}",
    );
    const cfg = freshConfig();
    expect(restoreLaneStatsRows(cfg, loadLaneStatsRows({ path: statePath }))).toBe(1);
    expect(laneStatsFor(cfg, "new")!.wallClockMs).toEqual([5000]);
  });

  it("records under the report's tier and keeps one tier's runs out of another's window", () => {
    const cfg = freshConfig();
    for (let i = 0; i < 3; i++) recordLaneRun(cfg, tieredReport("a", "low", 10_000 + i, `low-${i}`));
    for (let i = 0; i < 2; i++) recordLaneRun(cfg, tieredReport("a", "high", 500_000 + i, `high-${i}`));
    recordLaneRun(cfg, tieredReport("a", null, 30_000, "legacy-0"));
    expect(laneStatsFor(cfg, "a", "low")).toMatchObject({ calls: 3, successes: 3 });
    expect(laneStatsFor(cfg, "a", "low")!.wallClockMs).toEqual([10000, 10001, 10002]);
    expect(laneStatsFor(cfg, "a", "high")).toMatchObject({ calls: 2, successes: 2 });
    expect(laneStatsFor(cfg, "a", "high")!.wallClockMs).toEqual([500000, 500001]);
    expect(laneStatsFor(cfg, "a")).toMatchObject({ calls: 1, successes: 1 });
    expect(laneStatsFor(cfg, "a", "ghost")).toBeUndefined();
  });

  it("stamps each sample's ISO time and keeps the parallel window in step", () => {
    const cfg = freshConfig();
    recordLaneRun(cfg, tieredReport("a", "low", 10_000, "job-1"), 1_700_000_000_000);
    recordLaneRun(cfg, tieredReport("a", "low", 20_000, "job-2"), 1_700_000_060_000);
    const stats = laneStatsFor(cfg, "a", "low")!;
    expect(stats.wallClockAt).toEqual(["2023-11-14T22:13:20.000Z", "2023-11-14T22:14:20.000Z"]);
    // An abandoned run contributes no duration AND no timestamp — the two windows stay aligned.
    recordLaneRun(
      cfg,
      parseTelemetryReport(validReport({ jobId: "job-3", laneId: "a", tier: "low", status: "abandoned", exitCode: null }))!,
      1_700_000_120_000,
    );
    const after = laneStatsFor(cfg, "a", "low")!;
    expect(after.calls).toBe(3);
    expect(after.wallClockMs).toHaveLength(2);
    expect(after.wallClockAt).toHaveLength(2);
    // A legacy sample carries a null timestamp, never a guess.
    expect(laneStatsFor(cfg, "ghost", "low")).toBeUndefined();
  });

  it("⚠ drops a row whose `tier` is a number, alone", () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: CURRENT_DISPATCH_LANE_STATS_VERSION,
        rows: [
          { laneId: "good", calls: 1, successes: 1, failures: 0, timeouts: 0, wallClockMs: [10], lastAt: null },
          { laneId: "bad-tier", tier: 42, calls: 1, successes: 1, failures: 0, timeouts: 0, wallClockMs: [10], lastAt: null },
        ],
      }),
    );
    const rows = loadLaneStatsRows({ path: statePath });
    expect(rows.map((row) => row.laneId)).toEqual(["good"]);
  });

  it("round-trips tiered rows through an explicit path", () => {
    const cfg = freshConfig();
    recordLaneRun(cfg, tieredReport("a", "low", 10_000, "job-1"), 1_700_000_000_000);
    recordLaneRun(cfg, tieredReport("a", null, 30_000, "job-2"), 1_700_000_060_000);
    const rows = exportLaneStatsRows(cfg);
    expect(rows).toHaveLength(2);

    const after = freshConfig();
    expect(restoreLaneStatsRows(after, rows)).toBe(2);
    expect(laneStatsFor(after, "a", "low")).toEqual(laneStatsFor(cfg, "a", "low"));
    expect(laneStatsFor(after, "a", null)).toEqual(laneStatsFor(cfg, "a", null));
  });
});
