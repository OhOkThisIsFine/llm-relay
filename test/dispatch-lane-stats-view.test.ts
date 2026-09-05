/**
 * Advisory lane stats on the dispatch ladder surfaces (`src/dispatch.ts` view fields).
 *
 * `buildDispatch` fills `stats` for every rung with a recorded run and OMITS the key
 * otherwise; the values match the recorded runs; and stats never change `next` or the ladder
 * order — they are columns, not inputs. The MCP `dispatch_lanes` surface renders the same
 * `stats:` segment the CLI prints (one `formatLaneStats` definition, `dispatch.ts`).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import { buildDispatch, formatLaneStats } from "../src/dispatch.js";
import {
  parseTelemetryReport,
  recordLaneRun,
  type DispatchedTelemetryReport,
} from "../src/dispatch-lane-stats.js";
import { McpDispatchServer, type DispatchViewBuilder } from "../src/mcp/server.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";
import type { LaneSpawner } from "../src/mcp/lane-runner.js";

const dir = mkdtempSync(join(tmpdir(), "llm-relay-lane-stats-view-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
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
          { id: "codex-sol", kind: "cli", command: "codex", args: ["exec", "{task}"] },
          { id: "relay-pool", kind: "relay", spec: "anthropic" },
        ],
      },
    }),
  );
  return loadConfig(path);
}

function report(
  laneId: string,
  status: DispatchedTelemetryReport["status"],
  wallClockMs: number,
  now: number,
): { report: DispatchedTelemetryReport; now: number } {
  const parsed = parseTelemetryReport({
    jobId: `job-${laneId}-${status}-${String(wallClockMs)}`,
    laneId,
    kind: "cli",
    wallClockMs,
    exitCode: status === "completed" ? 0 : 1,
    status,
    estimatedInputTokens: 10,
    estimatedOutputTokens: 20,
  });
  if (!parsed) throw new Error("fixture telemetry report rejected");
  return { report: parsed, now };
}

describe("buildDispatch lane stats columns", () => {
  it("omits `stats` for every rung with no recorded run", () => {
    const view = buildDispatch(freshConfig());
    expect(view.ladder).toHaveLength(2);
    for (const lane of view.ladder) {
      expect("stats" in lane).toBe(false);
      expect(lane.stats).toBeUndefined();
    }
  });

  it("carries `stats` for a rung with recorded runs, with values matching the runs", () => {
    const cfg = freshConfig();
    const first = report("codex-sol", "completed", 10_000, 1_700_000_000_000);
    recordLaneRun(cfg, first.report, first.now);
    const second = report("codex-sol", "failed", 30_000, 1_700_000_060_000);
    recordLaneRun(cfg, second.report, second.now);

    const view = buildDispatch(cfg);
    const lane = view.ladder.find((l) => l.id === "codex-sol");
    expect(lane?.stats).toEqual({
      calls: 2,
      successes: 1,
      failures: 1,
      timeouts: 0,
      medianWallClockMs: 20_000,
      lastAt: 1_700_000_060_000,
    });
    // The rung that never ran still omits the key.
    const other = view.ladder.find((l) => l.id === "relay-pool");
    expect(other && "stats" in other).toBe(false);
  });

  it("counts a timeout as a failure AND a timeout in the view", () => {
    const cfg = freshConfig();
    const run = report("relay-pool", "timed_out", 60_000, 1_700_000_000_000);
    recordLaneRun(cfg, run.report, run.now);

    const lane = buildDispatch(cfg).ladder.find((l) => l.id === "relay-pool");
    expect(lane?.stats).toMatchObject({ calls: 1, successes: 0, failures: 1, timeouts: 1 });
  });

  it("⚠ stats never change `next` or the ladder order — many failures on the first ready rung", () => {
    const cfg = freshConfig();
    for (let i = 0; i < 10; i++) {
      const run = report("codex-sol", "failed", 5_000 + i, 1_700_000_000_000 + i);
      recordLaneRun(cfg, run.report, run.now);
    }

    const view = buildDispatch(cfg);
    expect(view.ladder.map((l) => l.id)).toEqual(["codex-sol", "relay-pool"]);
    expect(view.next?.id).toBe("codex-sol");
    expect(view.reason).toBe("first lane in the ladder");
    expect(view.ladder[0]?.state).toBe("ready");
    expect(view.ladder[0]?.stats).toMatchObject({ calls: 10, failures: 10 });
  });
});

describe("formatLaneStats", () => {
  it("renders whole seconds without a decimal and fractions with one", () => {
    expect(
      formatLaneStats({ calls: 4, successes: 3, failures: 1, timeouts: 0, medianWallClockMs: 24_000, lastAt: null }),
    ).toBe("stats: 4 calls, 3 ok, 1 failed, 0 timed out, median 24s");
    expect(
      formatLaneStats({ calls: 1, successes: 1, failures: 0, timeouts: 0, medianWallClockMs: 24_321, lastAt: 1 }),
    ).toBe("stats: 1 calls, 1 ok, 0 failed, 0 timed out, median 24.3s");
  });

  it("prints `median n/a` when the window is empty (unknown, never 0)", () => {
    expect(
      formatLaneStats({ calls: 0, successes: 0, failures: 0, timeouts: 0, medianWallClockMs: null, lastAt: null }),
    ).toContain("median n/a");
  });
});

describe("dispatch_lanes stats segment", () => {
  function statsLane(over: Partial<DispatchLane> = {}): DispatchLane {
    return {
      id: "codex-sol",
      kind: "cli",
      position: 1,
      state: "ready",
      invoke: { command: "codex", args: ["exec", "{task}"] },
      stats: { calls: 4, successes: 3, failures: 1, timeouts: 0, medianWallClockMs: 24_000, lastAt: null },
      ...over,
    };
  }

  function lanesView(ladder: DispatchLane[]): DispatchView {
    const next = ladder[0] ?? null;
    return { tier: "medium", offload: false, client: "claude", host: "bypassed", ladder, next, reason: "first ready lane" };
  }

  class LanesHarness {
    readonly out: string[] = [];
    readonly server: McpDispatchServer;
    private id = 0;

    constructor(buildView: DispatchViewBuilder) {
      const neverSpawn: LaneSpawner = () => {
        throw new Error("dispatch_lanes must not spawn");
      };
      this.server = new McpDispatchServer({
        config: { host: "127.0.0.1", port: 8791 } as Config,
        buildView,
        spawn: neverSpawn,
        cwd: () => process.cwd(),
        write: (chunk) => this.out.push(chunk),
      });
    }

    async lanesText(): Promise<string> {
      this.id += 1;
      const before = this.out.length;
      await this.server.ingest(
        JSON.stringify({ jsonrpc: "2.0", id: this.id, method: "tools/call", params: { name: "dispatch_lanes", arguments: {} } }) + "\n",
      );
      const line = this.out[before];
      expect(line, "no response for dispatch_lanes").toBeDefined();
      const res = JSON.parse(line as string) as Record<string, unknown>;
      const result = res["result"] as { content: { text: string }[]; isError: boolean };
      return result.content[0]?.text ?? "";
    }
  }

  it("contains the `stats:` segment for a rung with stats and none for a rung without", async () => {
    const plain: DispatchLane = {
      id: "relay-pool",
      kind: "relay",
      position: 2,
      state: "ready",
      spec: "anthropic",
    };
    const h = new LanesHarness(async () => lanesView([statsLane(), plain]));
    const text = await h.lanesText();
    expect(text).toContain("stats: 4 calls, 3 ok, 1 failed, 0 timed out, median 24s");
    const lines = text.split("\n");
    const plainLine = lines.find((line) => line.startsWith("2. "));
    expect(plainLine).toBeDefined();
    expect(plainLine as string).not.toContain("stats:");
  });

  it("renders `median n/a` for a stats entry with an empty window", async () => {
    const h = new LanesHarness(async () =>
      lanesView([statsLane({ stats: { calls: 1, successes: 1, failures: 0, timeouts: 0, medianWallClockMs: null, lastAt: 1 } })]),
    );
    expect(await h.lanesText()).toContain("median n/a");
  });
});
