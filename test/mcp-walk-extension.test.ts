/**
 * The walk keeps a lane that is still WORKING past its attempt budget, and never moves a packet to a
 * rung that declares a lower capability (2026-09-17, `docs/backlog.md`). Measured 2026-09-16: the
 * walk stopped `free-pool` at its 789 s p80 with +203 lines written, then started a lane kept for
 * short advisory work with the same implementation packet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANE_ACTIVITY_WINDOW_MS, McpDispatchServer } from "../src/mcp/server.js";
import { newestChangeMs, sameTree, type TreeSnapshot, type TreeSnapshotReader } from "../src/mcp/tree-delta.js";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";
import type { LaneRunResult, LaneSpawnOptions, LaneSpawner } from "../src/mcp/lane-runner.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUDGET_MS = 10_000;

interface LaneScript {
  /** When the lane answers, from its start. */
  answersAfterMs: number;
  /** Emit output every this many ms while it runs; absent = silent. */
  outputEveryMs?: number;
}

function cliLane(id: string, extra: Partial<DispatchLane> = {}): DispatchLane {
  return {
    id,
    kind: "cli",
    position: 1,
    state: "ready",
    invoke: { command: id, args: ["{task}"] },
    attemptBudget: { ms: BUDGET_MS, basis: "floor", samples: 0 },
    ...extra,
  } as DispatchLane;
}

function harness(opts: {
  lanes: DispatchLane[];
  scripts: Record<string, LaneScript>;
  tier?: string;
  readings?: Array<TreeSnapshot | null>;
}) {
  const out: Array<{ id?: number; result?: { content: Array<{ text: string }> } }> = [];
  const started: string[] = [];
  const spawn: LaneSpawner = (command, _args, spawnOpts: LaneSpawnOptions) => {
    started.push(command);
    const script = opts.scripts[command] ?? { answersAfterMs: 1_000 };
    let settle: (r: LaneRunResult) => void = () => {};
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const result = new Promise<LaneRunResult>((resolve) => {
      settle = (r) => {
        for (const t of timers) clearTimeout(t);
        resolve(r);
      };
      timers.push(setTimeout(() => settle({ code: 0, stdout: `${command} answered`, stderr: "", timedOut: false }), script.answersAfterMs));
      if (script.outputEveryMs !== undefined) {
        const every = script.outputEveryMs;
        const tick = (): void => {
          spawnOpts.onOutput?.({ stream: "stderr", bytes: 10 });
          timers.push(setTimeout(tick, every));
        };
        timers.push(setTimeout(tick, every));
      }
    });
    return { result, kill: () => settle({ code: null, stdout: "", stderr: "killed", timedOut: false }) };
  };
  const view: DispatchView = {
    tier: (opts.tier ?? "high") as DispatchView["tier"],
    offload: false,
    client: "claude",
    host: "bypassed",
    ladder: opts.lanes,
    order: opts.lanes.map((l) => l.id),
    next: opts.lanes[0] ?? null,
    reason: "r",
  } as DispatchView;
  const readings = opts.readings;
  const treeSnapshot: TreeSnapshotReader = async () => (readings === undefined ? null : (readings.shift() ?? null));
  const server = new McpDispatchServer({
    config: {
      host: "127.0.0.1",
      port: 8791,
      routing: { default: "x", dispatchWalk: { enabled: true, attemptMs: BUDGET_MS, maxLanes: 5 } },
    } as unknown as Config,
    buildView: async () => view,
    spawn,
    treeSnapshot,
    cwd: () => process.cwd(),
    write: (chunk) => out.push(JSON.parse(chunk) as (typeof out)[number]),
  });
  let id = 0;
  const call = (name: string, args: Record<string, unknown>) => {
    const reqId = ++id;
    const done = server.ingest(
      JSON.stringify({ jsonrpc: "2.0", id: reqId, method: "tools/call", params: { name, arguments: args } }) + "\n",
    );
    const text = (): string => out.find((m) => m.id === reqId)?.result?.content[0]?.text ?? "";
    return { done, text };
  };
  return { call, started };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function finish(h: ReturnType<typeof harness>, args: Record<string, unknown>): Promise<string> {
  const first = h.call("dispatch", { task: "t", waitMs: 1_000, ...args });
  await vi.advanceTimersByTimeAsync(1_500);
  await first.done;
  const jobId = /jobId "(job-\d+)"/.exec(first.text())?.[1] ?? /job: (job-\d+)/.exec(first.text())?.[1];
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  const result = h.call("dispatch_result", { jobId });
  await result.done;
  return result.text();
}

describe("the walk keeps a working lane past its budget", () => {
  it("does not stop a lane that keeps writing output, and names the extension", async () => {
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      scripts: { slow: { answersAfterMs: 3 * BUDGET_MS, outputEveryMs: 5_000 }, next: { answersAfterMs: 100 } },
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["slow"]);
    expect(text).toContain("slow answered");
    expect(text).toMatch(/extended: slow kept past its 10s budget because it wrote output \d+s ago/);
  });

  it("stops a silent lane at its budget and moves on, as before", async () => {
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      scripts: { slow: { answersAfterMs: 3 * BUDGET_MS }, next: { answersAfterMs: 100 } },
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["slow", "next"]);
    expect(text).toContain("next answered");
    expect(text).not.toContain("extended:");
  });

  it("keeps a silent lane whose git tree changed, and stops it once the tree stops changing", async () => {
    const start: TreeSnapshot = { prefix: "", entries: new Map() };
    const changed: TreeSnapshot = { prefix: "", entries: new Map([["gone/never-on-disk.ts", "??"]]) };
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      // Start; first budget check (changed); second check (same, and the file cannot be stat-ed);
      // the terminal reading.
      readings: [start, changed, changed, changed],
      scripts: { slow: { answersAfterMs: 20 * BUDGET_MS }, next: { answersAfterMs: 100 } },
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["slow", "next"]);
    expect(text).toContain("extended: slow kept past its 10s budget because its working tree changed");
    expect(text).toContain("next answered");
  });

  it("extends in steps of the activity window", () => {
    expect(LANE_ACTIVITY_WINDOW_MS).toBe(60_000);
  });
});

describe("the walk never moves a packet to a lower-capability rung", () => {
  const lanes = (): DispatchLane[] => [
    cliLane("weak", { capability: "medium" }),
    cliLane("strong", { capability: "xhigh" }),
    cliLane("plain"),
  ];

  it("skips a rung that declares a capability below the dispatch tier", async () => {
    const h = harness({ lanes: lanes(), tier: "high", scripts: {} });
    const text = await finish(h, {});
    expect(h.started).toEqual(["strong"]);
    expect(text).toContain('lane "weak" declares capability medium, below this high dispatch');
  });

  it("runs the rung for a tier at or below its capability", async () => {
    const h = harness({ lanes: lanes(), tier: "medium", scripts: {} });
    await finish(h, {});
    expect(h.started).toEqual(["weak"]);
  });

  it("runs the rung when the caller named it", async () => {
    const h = harness({ lanes: [cliLane("weak", { capability: "low" })], tier: "xhigh", scripts: {} });
    const text = await finish(h, { lane: "weak" });
    expect(h.started).toEqual(["weak"]);
    expect(text).toContain("weak answered");
  });
});

describe("rung capability in config", () => {
  const base = (rung: Record<string, unknown>) => ({
    providers: { a: { base: "http://127.0.0.1:1", kind: "openai" } },
    routing: {
      default: "a/m",
      ladder: [{ id: "r", kind: "cli", command: "x", args: ["{task}"], ...rung }],
    },
    repair: { maxAttempts: 1, destructiveTools: [] },
  });

  it("parses a known tier and refuses anything else by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "capability-"));
    try {
      const good = join(dir, "good.json");
      writeFileSync(good, JSON.stringify(base({ capability: "medium" })));
      expect(loadConfig(good).routing.ladder?.[0]?.capability).toBe("medium");
      const bad = join(dir, "bad.json");
      writeFileSync(bad, JSON.stringify(base({ capability: "hi" })));
      expect(() => loadConfig(bad)).toThrow(/routing\.ladder\[0\]\.capability must be one of low, medium, high, xhigh \(rung "r"\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tree activity helpers", () => {
  it("compares readings by path and status", () => {
    const a: TreeSnapshot = { prefix: "", entries: new Map([["x", " M"]]) };
    expect(sameTree(a, { prefix: "", entries: new Map([["x", " M"]]) })).toBe(true);
    expect(sameTree(a, { prefix: "", entries: new Map([["x", "M "]]) })).toBe(false);
    expect(sameTree(a, { prefix: "", entries: new Map() })).toBe(false);
  });

  it("reads the newest mtime from the repository root, above a subdirectory cwd", () => {
    const seen: string[] = [];
    const stat = (p: string) => {
      seen.push(p.replace(/\\/g, "/"));
      if (p.endsWith("missing.ts")) throw new Error("ENOENT");
      return { mtimeMs: p.endsWith("b.ts") ? 200 : 100 };
    };
    const reading: TreeSnapshot = {
      prefix: "pkg/sub/",
      entries: new Map([["pkg/a.ts", " M"], ["pkg/b.ts", "??"], ["missing.ts", " D"]]),
    };
    expect(newestChangeMs(join("/repo", "pkg", "sub"), reading, stat)).toBe(200);
    expect(seen[0]).toMatch(/\/repo\/pkg\/a\.ts$/);
  });
});
