/**
 * A silent lane is REPORTED as silent.
 *
 * Measured 2026-09-10 (docs/backlog.md): Muse Spark `job-0017` logged `stream error` in OpenCode's
 * own log in its first second and produced nothing more. The process stayed alive, and
 * `dispatch_status` read `running` for nine minutes — with nothing on the status to tell it apart
 * from a lane still thinking — until it was cancelled by hand.
 *
 * ⚠ Silence is reported, never acted on: `claude -p` — the transposed form of every relay rung in
 * agent mode, i.e. the free pool — buffers its whole answer until exit, so a threshold on "zero
 * bytes after N seconds" would kill every healthy run on the most-used lane. The figure lets the
 * caller decide; the property's second branch.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  LaneJobStore,
  createLaneSpawner,
  type LaneChildProcess,
  type LaneProcessApi,
  type LaneSpawner,
} from "../src/mcp/lane-runner.js";
import { McpDispatchServer, describeActivity, type DispatchViewBuilder } from "../src/mcp/server.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";

describe("LaneJobStore output activity", () => {
  it("tracks bytes and the last-output time for the running attempt, and clears them when it ends", () => {
    const store = new LaneJobStore();
    const job = store.create("lane-a", "pool/medium", "C:/w");
    expect(job.activity).toBeUndefined();

    store.beginAttemptActivity(job.id, 1_000);
    expect(store.get(job.id)?.activity).toEqual({ attemptStartedAt: 1_000, lastOutputAt: null, stdoutBytes: 0, stderrBytes: 0 });

    store.noteOutput(job.id, "stdout", 40, 5_000);
    store.noteOutput(job.id, "stderr", 2, 7_000);
    expect(store.get(job.id)?.activity).toEqual({ attemptStartedAt: 1_000, lastOutputAt: 7_000, stdoutBytes: 40, stderrBytes: 2 });

    // A zero or garbage byte count is not output.
    store.noteOutput(job.id, "stdout", 0, 9_000);
    store.noteOutput(job.id, "stdout", Number.NaN, 9_000);
    expect(store.get(job.id)?.activity?.lastOutputAt).toBe(7_000);

    store.complete(job.id, { code: 0, stdout: "x", stderr: "", timedOut: false });
    expect(store.get(job.id)?.activity).toBeUndefined();
  });

  it("starts a fresh figure when the walk moves to the next lane — the previous lane's silence is not inherited", () => {
    const store = new LaneJobStore();
    const job = store.create("lane-a", "pool/medium", "C:/w");
    store.beginAttemptActivity(job.id, 1_000);
    store.noteOutput(job.id, "stdout", 10, 2_000);
    store.setCurrentLane(job.id, "lane-b", "agy");
    expect(store.get(job.id)?.activity).toBeUndefined();
    store.beginAttemptActivity(job.id, 3_000);
    expect(store.get(job.id)?.activity?.stdoutBytes).toBe(0);
  });
});

describe("describeActivity", () => {
  const base = () => new LaneJobStore().create("lane-a", "pool/medium", "C:/w");

  it("says how long a lane has been silent when it has written nothing, and why that alone proves nothing", () => {
    const job = base();
    job.activity = { attemptStartedAt: 10_000, lastOutputAt: null, stdoutBytes: 0, stderrBytes: 0 };
    const line = describeActivity(job, 550_000);
    expect(line).toContain("output: none yet");
    expect(line).toContain("silent for 540s");
    expect(line).toMatch(/claude -p/);
  });

  it("reports bytes so far and how long ago the last output arrived", () => {
    const job = base();
    job.activity = { attemptStartedAt: 10_000, lastOutputAt: 40_000, stdoutBytes: 1200, stderrBytes: 30 };
    expect(describeActivity(job, 100_000)).toBe("output: 1230 bytes so far (stdout 1200, stderr 30); last output 60s ago");
  });

  it("says nothing for a finished job, or for a job with no spawned attempt (answer mode)", () => {
    const job = base();
    expect(describeActivity(job, 1)).toBeNull();
    job.activity = { attemptStartedAt: 0, lastOutputAt: null, stdoutBytes: 0, stderrBytes: 0 };
    job.status = "completed";
    expect(describeActivity(job, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The spawner feeds it: a second `data` listener beside execFile's own buffering one.

interface StreamingChild extends LaneChildProcess {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function streamingChild(): StreamingChild {
  return {
    pid: 4321,
    stdin: { end: () => {} },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => true,
  };
}

describe("createLaneSpawner output observation", () => {
  it("reports every chunk's size on both streams, and the run result is unchanged", async () => {
    const child = streamingChild();
    let finish: () => void = () => {};
    const processApi: LaneProcessApi = {
      platform: "linux",
      execFile: (_command, _args, _opts, callback) => {
        finish = () => callback(null, "hello world", "warn");
        return child;
      },
      exec: () => {
        throw new Error("not reached");
      },
    };
    const seen: Array<{ stream: string; bytes: number }> = [];
    const run = createLaneSpawner(processApi, {})("claude", ["-p", "t"], {
      env: {},
      cwd: "C:/w",
      timeoutMs: 1_000,
      onOutput: (chunk) => seen.push(chunk),
    });
    child.stdout.emit("data", "hello ");
    child.stdout.emit("data", Buffer.from("wörld"));
    child.stderr.emit("data", "warn");
    finish();
    expect(await run.result).toEqual({ code: 0, stdout: "hello world", stderr: "warn", timedOut: false });
    expect(seen).toEqual([
      { stream: "stdout", bytes: 6 },
      { stream: "stdout", bytes: Buffer.byteLength("wörld") },
      { stream: "stderr", bytes: 4 },
    ]);
  });

  it("observes the Windows shell-fallback child too, and a throwing observer never fails the lane", async () => {
    const fallback = streamingChild();
    const processApi: LaneProcessApi = {
      platform: "win32",
      execFile: (_command, _args, _opts, callback) => {
        queueMicrotask(() => callback(Object.assign(new Error("nf"), { code: "ENOENT" }), "", ""));
        // A child that exposes no streams — the pre-existing test double shape.
        return { stdin: { end: () => {} }, kill: () => true };
      },
      exec: (_line, _opts, callback) => {
        queueMicrotask(() => {
          fallback.stdout.emit("data", "abc");
          callback(null, "abc", "");
        });
        return fallback;
      },
    };
    let calls = 0;
    const run = createLaneSpawner(processApi, {})("tool.cmd", ["x"], {
      env: {},
      cwd: "C:/w",
      timeoutMs: 1_000,
      onOutput: () => {
        calls += 1;
        throw new Error("observer bug");
      },
    });
    expect(await run.result).toEqual({ code: 0, stdout: "abc", stderr: "", timedOut: false });
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// End to end: dispatch_status carries the figure while a spawned lane runs.

const LANE: DispatchLane = {
  id: "opencode-muse-spark",
  kind: "cli",
  position: 1,
  state: "ready",
  invoke: { command: "opencode", args: ["run", "the task"] },
};

function viewOf(lane: DispatchLane): DispatchView {
  return { tier: "medium", offload: false, client: "claude", host: "bypassed", ladder: [lane], order: [lane.id], next: lane, reason: "first" };
}

describe("dispatch_status reports silence end to end", () => {
  it("shows a spawned lane that has written nothing as silent for N s, and a lane that wrote as having written", async () => {
    let clock = 100_000;
    let emit: (stream: "stdout" | "stderr", bytes: number) => void = () => {};
    const spawn: LaneSpawner = (_c, _a, opts) => {
      emit = (stream, bytes) => opts.onOutput?.({ stream, bytes });
      return { result: new Promise(() => {}), kill: () => {} };
    };
    const out: string[] = [];
    const buildView: DispatchViewBuilder = async () => viewOf(LANE);
    const server = new McpDispatchServer({
      config: { host: "127.0.0.1", port: 8791, routing: {} } as unknown as Config,
      buildView,
      spawn,
      now: () => clock,
      cwd: () => process.cwd(),
      write: (chunk) => out.push(chunk),
    });
    const call = async (id: number, name: string, args: Record<string, unknown>): Promise<string> => {
      const before = out.length;
      await server.ingest(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
      const body = JSON.parse(out[before] as string) as { result: { content: Array<{ text: string }> } };
      return body.result.content[0]?.text ?? "";
    };

    const first = await call(1, "dispatch", { task: "review", waitMs: 1 });
    const jobId = /job: (job-\d+)/.exec(first)?.[1] as string;

    clock += 540_000;
    const silent = await call(2, "dispatch_status", { jobId });
    // ⚠ RED before 2026-09-15: the status carried `running` and the elapsed time, and nothing else —
    // a lane dead in its first second and a lane still thinking read identically for nine minutes.
    expect(silent).toContain("status: running");
    expect(silent).toContain("output: none yet — silent for 540s");

    emit("stdout", 512);
    clock += 30_000;
    const wrote = await call(3, "dispatch_status", { jobId });
    expect(wrote).toContain("output: 512 bytes so far (stdout 512, stderr 0); last output 30s ago");

    server.shutdown();
  });
});
