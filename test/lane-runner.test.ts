import { describe, expect, it, vi } from "vitest";
import {
  createLaneSpawner,
  MAX_OUTPUT_BYTES,
  type LaneChildProcess,
  type LaneExecOptions,
  type LaneProcessApi,
  type LaneSpawnProcessOptions,
  type LaneSpawnedProcess,
} from "../src/mcp/lane-runner.js";

interface FakeChild {
  process: LaneChildProcess;
  stdinEndCount: () => number;
}

function fakeChild(): FakeChild {
  let stdinEndCount = 0;
  return {
    process: {
      stdin: { end: () => (stdinEndCount += 1) },
      kill: () => true,
    },
    stdinEndCount: () => stdinEndCount,
  };
}

interface FakeSpawnedChild {
  process: LaneSpawnedProcess;
  stdinEndCount: () => number;
  killCount: () => number;
  stdout: (chunk: string | Buffer) => void;
  stderr: (chunk: string | Buffer) => void;
  close: (code: number | null) => void;
}

function fakeSpawnedChild(): FakeSpawnedChild {
  let stdinEnds = 0;
  let kills = 0;
  let stdoutListener: ((chunk: string | Buffer) => void) | undefined;
  let stderrListener: ((chunk: string | Buffer) => void) | undefined;
  let closeListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  let errorListener: ((err: Error) => void) | undefined;
  const process = {
    stdin: { end: () => { stdinEnds += 1; } },
    stdout: { on: (_event: "data", listener: (chunk: string | Buffer) => void) => { stdoutListener = listener; } },
    stderr: { on: (_event: "data", listener: (chunk: string | Buffer) => void) => { stderrListener = listener; } },
    kill: () => { kills += 1; return true; },
    on: (event: "error" | "close", listener: ((err: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)) => {
      if (event === "error") errorListener = listener as (err: Error) => void;
      else closeListener = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
    },
  } as LaneSpawnedProcess;
  return {
    process,
    stdinEndCount: () => stdinEnds,
    killCount: () => kills,
    stdout: (chunk) => stdoutListener?.(chunk),
    stderr: (chunk) => stderrListener?.(chunk),
    close: (code) => closeListener?.(code, null),
  };
}
interface SpawnCall {
  command: string;
  args?: string[];
  opts: LaneExecOptions;
}

const laneOpts = {
  env: { LANE_TEST: "yes" },
  cwd: "C:\\work tree",
  timeoutMs: 45_000,
};

function expectHiddenLaneOptions(opts: LaneExecOptions): void {
  expect(opts).toEqual({
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: laneOpts.timeoutMs,
    windowsHide: true,
    env: laneOpts.env,
    cwd: laneOpts.cwd,
  });
}

describe("createLaneSpawner", () => {
  it("direct execFile hides the child, applies lane options, and closes stdin", async () => {
    const direct = fakeChild();
    const directCalls: SpawnCall[] = [];
    const shellCalls: SpawnCall[] = [];
    const processApi: LaneProcessApi = {
      platform: "win32",
      execFile: (command, args, opts, callback) => {
        directCalls.push({ command, args, opts });
        queueMicrotask(() => callback(null, "DIRECT_OK", ""));
        return direct.process;
      },
      exec: (command, opts, callback) => {
        shellCalls.push({ command, opts });
        queueMicrotask(() => callback(null, "FALLBACK_OK", ""));
        return fakeChild().process;
      },
    };

    const run = createLaneSpawner(processApi, {})("agy.exe", ["-p", "hello"], laneOpts);

    expect(direct.stdinEndCount()).toBe(1);
    expect(directCalls).toHaveLength(1);
    expect(directCalls[0]?.command).toBe("agy.exe");
    expect(directCalls[0]?.args).toEqual(["-p", "hello"]);
    expectHiddenLaneOptions(directCalls[0]!.opts);
    expect(await run.result).toEqual({
      code: 0,
      stdout: "DIRECT_OK",
      stderr: "",
      timedOut: false,
    });
    expect(shellCalls).toHaveLength(0);
  });

  it("starts POSIX lanes as owned process groups through spawn", async () => {
    const child = fakeSpawnedChild();
    const calls: Array<{ command: string; args: string[]; opts: LaneSpawnProcessOptions }> = [];
    const processApi: LaneProcessApi = {
      platform: "linux",
      execFile: () => {
        throw new Error("POSIX lane should use spawn, not execFile");
      },
      exec: () => {
        throw new Error("POSIX lane should not use the shell fallback");
      },
      spawn: (command, args, opts) => {
        calls.push({ command, args, opts });
        queueMicrotask(() => {
          child.stdout("OK");
          child.close(0);
        });
        return child.process;
      },
    };

    const run = createLaneSpawner(processApi, {})("node", ["script.js"], laneOpts);
    expect(await run.result).toMatchObject({ code: 0, stdout: "OK", timedOut: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts).toEqual({
      detached: true,
      windowsHide: true,
      env: laneOpts.env,
      cwd: laneOpts.cwd,
    });
    expect(child.stdinEndCount()).toBe(1);
  });

  it("routes a POSIX timeout through the owned-process kill path", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeSpawnedChild();
      const processApi: LaneProcessApi = {
        platform: "linux",
        execFile: () => {
          throw new Error("POSIX lane should use spawn, not execFile");
        },
        exec: () => {
          throw new Error("POSIX lane should not use the shell fallback");
        },
        spawn: () => child.process,
      };

      const run = createLaneSpawner(processApi, {})("node", ["script.js"], { ...laneOpts, timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      expect(child.killCount()).toBe(1);

      child.close(null);
      expect(await run.result).toMatchObject({ timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });
  it("Windows ENOENT fallback hides both children and closes both stdin pipes", async () => {
    const direct = fakeChild();
    const fallback = fakeChild();
    const directCalls: SpawnCall[] = [];
    const shellCalls: SpawnCall[] = [];
    const processApi: LaneProcessApi = {
      platform: "win32",
      execFile: (command, args, opts, callback) => {
        directCalls.push({ command, args, opts });
        queueMicrotask(() => {
          const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
          callback(missing, "", "");
        });
        return direct.process;
      },
      exec: (command, opts, callback) => {
        shellCalls.push({ command, opts });
        queueMicrotask(() => callback(null, "FALLBACK_OK", ""));
        return fallback.process;
      },
    };

    const run = createLaneSpawner(processApi, {})("tool.cmd", ["one", "two words"], laneOpts);
    const result = await run.result;

    expect(result).toEqual({
      code: 0,
      stdout: "FALLBACK_OK",
      stderr: "",
      timedOut: false,
    });
    expect(directCalls).toHaveLength(1);
    expect(shellCalls).toHaveLength(1);
    expectHiddenLaneOptions(directCalls[0]!.opts);
    expectHiddenLaneOptions(shellCalls[0]!.opts);
    expect(direct.stdinEndCount()).toBe(1);
    expect(fallback.stdinEndCount()).toBe(1);
  });
});
