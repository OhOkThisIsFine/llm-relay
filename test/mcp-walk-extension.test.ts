/**
 * The walk stops a lane only when it is IDLE, and never moves a packet to a rung that declares a
 * lower capability (2026-09-17). Owner decision the same day: a lane is stopped after
 * `routing.dispatchWalk.idleMs` with no activity — no request the relay daemon serves with the
 * lane's tag, no output, no owned process CPU increase, no change in its working tree — never because it ran longer than its past
 * runs. Measured 2026-09-16: the old budget stopped `free-pool` at its 789 s p80 with +203 lines
 * written, then started a lane kept for short advisory work with the same implementation packet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_POLL_MS, McpDispatchServer, type LaneTraffic } from "../src/mcp/server.js";
import { newestChangeMs, sameTree, type TreeSnapshot, type TreeSnapshotReader } from "../src/mcp/tree-delta.js";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";
import type { LaneRunResult, LaneSpawnOptions, LaneSpawner } from "../src/mcp/lane-runner.js";
import { LANE_ACTIVITY_HEADER } from "../src/lane-activity.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IDLE_MS = 30_000;

interface LaneScript {
  /** When the lane answers, from its start. */
  answersAfterMs: number;
  /** Exit code at settlement; absent means a successful answer. */
  exitCode?: number | null;
  /** Root pids the injected spawn handle reports for process-tree CPU sampling. */
  pids?: number[];
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
    ...extra,
  } as DispatchLane;
}

function harness(opts: {
  lanes: DispatchLane[];
  scripts: Record<string, LaneScript>;
  tier?: string;
  readings?: Array<TreeSnapshot | null>;
  /** What the relay daemon reports for a tag; absent = no daemon. */
  traffic?: (tag: string, now: number) => LaneTraffic | null;
  /** Cumulative CPU milliseconds for the owned process tree; absent = no CPU reader. */
  cpu?: (pids: readonly number[], now: number) => number | null;
}) {
  const out: Array<{ id?: number; result?: { content: Array<{ text: string }> } }> = [];
  const started: string[] = [];
  const headers: string[] = [];
  const asked: string[] = [];
  const spawn: LaneSpawner = (command, _args, spawnOpts: LaneSpawnOptions) => {
    started.push(command);
    headers.push(spawnOpts.env["ANTHROPIC_CUSTOM_HEADERS"] ?? "");
    const script = opts.scripts[command] ?? { answersAfterMs: 1_000 };
    let settle: (r: LaneRunResult) => void = () => {};
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const result = new Promise<LaneRunResult>((resolve) => {
      settle = (r) => {
        for (const t of timers) clearTimeout(t);
        resolve(r);
      };
      timers.push(setTimeout(() => {
        const code = script.exitCode === undefined ? 0 : script.exitCode;
        settle({
          code,
          stdout: code === 0 ? `${command} answered` : "",
          stderr: code === 0 ? "" : `${command} failed`,
          timedOut: false,
        });
      }, script.answersAfterMs));
      if (script.outputEveryMs !== undefined) {
        const every = script.outputEveryMs;
        const tick = (): void => {
          spawnOpts.onOutput?.({ stream: "stderr", bytes: 10 });
          timers.push(setTimeout(tick, every));
        };
        timers.push(setTimeout(tick, every));
      }
    });
    return {
      result,
      kill: () => settle({ code: null, stdout: "", stderr: "killed", timedOut: false }),
      ...(script.pids === undefined ? {} : { pids: () => script.pids ?? [] }),
    };
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
  const traffic = opts.traffic;
  const cpu = opts.cpu;
  const server = new McpDispatchServer({
    config: {
      host: "127.0.0.1",
      port: 8791,
      routing: { default: "x", dispatchWalk: { enabled: true, idleMs: IDLE_MS, maxLanes: 5 } },
    } as unknown as Config,
    buildView: async () => view,
    spawn,
    treeSnapshot,
    ...(traffic === undefined
      ? {}
      : {
          readLaneActivity: async (tag: string) => {
            asked.push(tag);
            return traffic(tag, Date.now());
          },
        }),
    ...(cpu === undefined
      ? {}
      : {
          readProcessCpu: async (pids: readonly number[]) => cpu(pids, Date.now()),
        }),
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
  return { call, started, headers, asked };
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
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  const result = h.call("dispatch_result", { jobId });
  await result.done;
  return result.text();
}

describe("the walk stops a lane only when it is idle", () => {
  it("does not stop a slow lane that keeps writing output", async () => {
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      scripts: { slow: { answersAfterMs: 10 * IDLE_MS, outputEveryMs: 5_000 }, next: { answersAfterMs: 100 } },
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["slow"]);
    expect(text).toContain("slow answered");
  });

  it("stops a lane that shows no activity for idleMs, and names why", async () => {
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      scripts: { slow: { answersAfterMs: 10 * IDLE_MS }, next: { answersAfterMs: 100 } },
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["slow", "next"]);
    expect(text).toContain("next answered");
    expect(text).toContain("no activity for 30s (no relay traffic, output, process CPU or file change)");
  });

  it("keeps a silent lane while the relay serves a request with its tag", async () => {
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      scripts: { slow: { answersAfterMs: 10 * IDLE_MS }, next: { answersAfterMs: 100 } },
      traffic: () => ({ inFlight: 1, lastActivityAt: 0 }),
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["slow"]);
    expect(text).toContain("slow answered");
    // The tag the lane was launched with is the tag the walk asked the daemon about.
    const tag = new RegExp(`^${LANE_ACTIVITY_HEADER}: ([A-Za-z0-9]+)/**
 * The walk stops a lane only when it is IDLE, and never moves a packet to a rung that declares a
 * lower capability (2026-09-17). Owner decision the same day: a lane is stopped after
 * `routing.dispatchWalk.idleMs` with no activity — no request the relay daemon serves with the
 * lane's tag, no output, no change in its working tree — never because it ran longer than its past
 * runs. Measured 2026-09-16: the old budget stopped `free-pool` at its 789 s p80 with +203 lines
 * written, then started a lane kept for short advisory work with the same implementation packet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_POLL_MS, McpDispatchServer, type LaneTraffic } from "../src/mcp/server.js";
import { newestChangeMs, sameTree, type TreeSnapshot, type TreeSnapshotReader } from "../src/mcp/tree-delta.js";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";
import type { LaneRunResult, LaneSpawnOptions, LaneSpawner } from "../src/mcp/lane-runner.js";
import { LANE_ACTIVITY_HEADER } from "../src/lane-activity.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IDLE_MS = 30_000;

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
    ...extra,
  } as DispatchLane;
}

function harness(opts: {
  lanes: DispatchLane[];
  scripts: Record<string, LaneScript>;
  tier?: string;
  readings?: Array<TreeSnapshot | null>;
  /** What the relay daemon reports for a tag; absent = no daemon. */
  traffic?: (tag: string, now: number) => LaneTraffic | null;
}) {
  const out: Array<{ id?: number; result?: { content: Array<{ text: string }> } }> = [];
  const started: string[] = [];
  const headers: string[] = [];
  const asked: string[] = [];
  const spawn: LaneSpawner = (command, _args, spawnOpts: LaneSpawnOptions) => {
    started.push(command);
    headers.push(spawnOpts.env["ANTHROPIC_CUSTOM_HEADERS"] ?? "");
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
  const traffic = opts.traffic;
  const server = new McpDispatchServer({
    config: {
      host: "127.0.0.1",
      port: 8791,
      routing: { default: "x", dispatchWalk: { enabled: true, idleMs: IDLE_MS, maxLanes: 5 } },
    } as unknown as Config,
    buildView: async () => view,
    spawn,
    treeSnapshot,
    ...(traffic === undefined
      ? {}
      : {
          readLaneActivity: async (tag: string) => {
            asked.push(tag);
            return traffic(tag, Date.now());
          },
        }),
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
  return { call, started, headers, asked };
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
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  const result = h.call("dispatch_result", { jobId });
  await result.done;
  return result.text();
}

describe("the walk stops a lane only when it is idle", () => {
  it("does not stop a slow lane that keeps writing output", async () => {
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      scripts: { slow: { answersAfterMs: 10 * IDLE_MS, outputEveryMs: 5_000 }, next: { answersAfterMs: 100 } },
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["slow"]);
    expect(text).toContain("slow answered");
  });

  it("stops a lane that shows no activity for idleMs, and names why", async () => {
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      scripts: { slow: { answersAfterMs: 10 * IDLE_MS }, next: { answersAfterMs: 100 } },
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["slow", "next"]);
    expect(text).toContain("next answered");
    expect(text).toContain("no activity for 30s (no relay traffic, output, process CPU or file change)");
  });

).exec(h.headers[0] ?? "")?.[1];
    expect(tag).toMatch(/^[a-f0-9]{32}$/);
    expect(h.asked.length).toBeGreaterThan(0);
    expect(new Set(h.asked)).toEqual(new Set([tag]));
  });

  it("replaces an inherited activity header and preserves unrelated custom headers", async () => {
    const h = harness({
      lanes: [
        cliLane("slow", {
          invoke: {
            command: "slow",
            args: ["{task}"],
            env: {
              ANTHROPIC_CUSTOM_HEADERS:
                "x-parent: keep\r\nX-LLM-Relay-Lane-Activity: stale-parent-tag\r\nx-other: also-keep",
            },
          },
        }),
      ],
      scripts: { slow: { answersAfterMs: 100 } },
    });
    await finish(h, {});

    const lines = (h.headers[0] ?? "").split("\n");
    expect(lines).toContain("x-parent: keep");
    expect(lines).toContain("x-other: also-keep");
    expect(lines).not.toContain("X-LLM-Relay-Lane-Activity: stale-parent-tag");
    const activity = lines.filter((line) => line.toLowerCase().startsWith(`${LANE_ACTIVITY_HEADER}:`));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatch(new RegExp(`^${LANE_ACTIVITY_HEADER}: [a-f0-9]{32}/**
 * The walk stops a lane only when it is IDLE, and never moves a packet to a rung that declares a
 * lower capability (2026-09-17). Owner decision the same day: a lane is stopped after
 * `routing.dispatchWalk.idleMs` with no activity — no request the relay daemon serves with the
 * lane's tag, no output, no change in its working tree — never because it ran longer than its past
 * runs. Measured 2026-09-16: the old budget stopped `free-pool` at its 789 s p80 with +203 lines
 * written, then started a lane kept for short advisory work with the same implementation packet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_POLL_MS, McpDispatchServer, type LaneTraffic } from "../src/mcp/server.js";
import { newestChangeMs, sameTree, type TreeSnapshot, type TreeSnapshotReader } from "../src/mcp/tree-delta.js";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";
import type { LaneRunResult, LaneSpawnOptions, LaneSpawner } from "../src/mcp/lane-runner.js";
import { LANE_ACTIVITY_HEADER } from "../src/lane-activity.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IDLE_MS = 30_000;

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
    ...extra,
  } as DispatchLane;
}

function harness(opts: {
  lanes: DispatchLane[];
  scripts: Record<string, LaneScript>;
  tier?: string;
  readings?: Array<TreeSnapshot | null>;
  /** What the relay daemon reports for a tag; absent = no daemon. */
  traffic?: (tag: string, now: number) => LaneTraffic | null;
}) {
  const out: Array<{ id?: number; result?: { content: Array<{ text: string }> } }> = [];
  const started: string[] = [];
  const headers: string[] = [];
  const asked: string[] = [];
  const spawn: LaneSpawner = (command, _args, spawnOpts: LaneSpawnOptions) => {
    started.push(command);
    headers.push(spawnOpts.env["ANTHROPIC_CUSTOM_HEADERS"] ?? "");
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
  const traffic = opts.traffic;
  const server = new McpDispatchServer({
    config: {
      host: "127.0.0.1",
      port: 8791,
      routing: { default: "x", dispatchWalk: { enabled: true, idleMs: IDLE_MS, maxLanes: 5 } },
    } as unknown as Config,
    buildView: async () => view,
    spawn,
    treeSnapshot,
    ...(traffic === undefined
      ? {}
      : {
          readLaneActivity: async (tag: string) => {
            asked.push(tag);
            return traffic(tag, Date.now());
          },
        }),
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
  return { call, started, headers, asked };
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
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  const result = h.call("dispatch_result", { jobId });
  await result.done;
  return result.text();
}

describe("the walk stops a lane only when it is idle", () => {
  it("does not stop a slow lane that keeps writing output", async () => {
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      scripts: { slow: { answersAfterMs: 10 * IDLE_MS, outputEveryMs: 5_000 }, next: { answersAfterMs: 100 } },
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["slow"]);
    expect(text).toContain("slow answered");
  });

  it("stops a lane that shows no activity for idleMs, and names why", async () => {
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      scripts: { slow: { answersAfterMs: 10 * IDLE_MS }, next: { answersAfterMs: 100 } },
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["slow", "next"]);
    expect(text).toContain("next answered");
    expect(text).toContain("no activity for 30s (no relay traffic, output, process CPU or file change)");
  });

));
  });

  it("keeps a silent lane while its relay traffic is recent, and stops it once the traffic ends", async () => {
    const trafficUntil = Date.now() + 3 * IDLE_MS;
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      scripts: { slow: { answersAfterMs: 20 * IDLE_MS }, next: { answersAfterMs: 100 } },
      traffic: (_tag, now) => ({ inFlight: 0, lastActivityAt: Math.min(now, trafficUntil) }),
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["slow", "next"]);
    // Traffic stops at 90 s, so the lane is stopped at the first poll 30 s later: 120 s.
    expect(text).toContain("1. slow: abandoned after 120s");
  });

  it("treats no record at the daemon as no signal, not as activity", async () => {
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      scripts: { slow: { answersAfterMs: 10 * IDLE_MS }, next: { answersAfterMs: 100 } },
      traffic: () => null,
    });
    await finish(h, {});
    expect(h.started).toEqual(["slow", "next"]);
  });

  it("keeps a silent non-relay lane while its owned process tree accumulates CPU time", async () => {
    let cpuMs = 0;
    const seenPids: number[][] = [];
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      scripts: {
        slow: { answersAfterMs: 10 * IDLE_MS, pids: [101] },
        next: { answersAfterMs: 100 },
      },
      cpu: (pids) => {
        seenPids.push([...pids]);
        cpuMs += 1_000;
        return cpuMs;
      },
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["slow"]);
    expect(text).toContain("slow answered");
    expect(seenPids.length).toBeGreaterThan(1);
    expect(seenPids.every((pids) => pids.length === 1 && pids[0] === 101)).toBe(true);
  });

  it("does not treat a flat process CPU reading as activity", async () => {
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      scripts: {
        slow: { answersAfterMs: 10 * IDLE_MS, pids: [202] },
        next: { answersAfterMs: 100 },
      },
      cpu: () => 5_000,
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["slow", "next"]);
    expect(text).toContain("next answered");
    expect(text).toContain("1. slow: abandoned after 30s");
  });

  it("treats an unavailable process CPU reading as no signal", async () => {
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      scripts: {
        slow: { answersAfterMs: 10 * IDLE_MS, pids: [303] },
        next: { answersAfterMs: 100 },
      },
      cpu: () => null,
    });
    await finish(h, {});
    expect(h.started).toEqual(["slow", "next"]);
  });

  it("does not sample process CPU while newer output already proves activity", async () => {
    let cpuReads = 0;
    const h = harness({
      lanes: [cliLane("slow")],
      scripts: { slow: { answersAfterMs: 3 * IDLE_MS, outputEveryMs: 5_000, pids: [404] } },
      cpu: () => {
        cpuReads += 1;
        return 0;
      },
    });
    const text = await finish(h, {});
    expect(text).toContain("slow answered");
    expect(cpuReads).toBe(0);
  });

  it("keeps a silent lane whose git tree changed, and stops it once the tree stops changing", async () => {
    const start: TreeSnapshot = { prefix: "", entries: new Map() };
    const changed: TreeSnapshot = { prefix: "", entries: new Map([["gone/never-on-disk.ts", "??"]]) };
    const h = harness({
      lanes: [cliLane("slow"), cliLane("next")],
      // Start; then one reading per poll: changed once, then the same (the file cannot be stat-ed).
      readings: [start, start, changed, changed, changed, changed, changed, changed],
      scripts: { slow: { answersAfterMs: 20 * IDLE_MS }, next: { answersAfterMs: 100 } },
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["slow", "next"]);
    expect(text).toContain("next answered");
    // Active at the 30 s poll (the change), so stopped at 60 s rather than 30 s.
    expect(text).toContain("1. slow: abandoned after 60s");
  });

  it("does not credit a later lane with a previous lane's unpolled tree change", async () => {
    const start: TreeSnapshot = { prefix: "", entries: new Map() };
    const changed: TreeSnapshot = { prefix: "", entries: new Map([["first-lane-only.ts", "??"]]) };
    const h = harness({
      lanes: [cliLane("first"), cliLane("second"), cliLane("next")],
      // first fails before the 15 s poll, after changing the tree. The reset before second must
      // absorb that edit into second's baseline rather than report it as second's activity.
      readings: [start, changed, changed, changed, changed, changed],
      scripts: {
        first: { answersAfterMs: 100, exitCode: 1 },
        second: { answersAfterMs: 20 * IDLE_MS },
        next: { answersAfterMs: 100 },
      },
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["first", "second", "next"]);
    expect(text).toContain("next answered");
    expect(text).toContain("2. second: abandoned after 30s");
  });

  it("never stops the last lane, however long it is idle", async () => {
    const h = harness({
      lanes: [cliLane("only")],
      scripts: { only: { answersAfterMs: 10 * IDLE_MS } },
    });
    const text = await finish(h, {});
    expect(h.started).toEqual(["only"]);
    expect(text).toContain("only answered");
  });

  it("checks for activity every 15 s", () => {
    expect(IDLE_POLL_MS).toBe(15_000);
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
