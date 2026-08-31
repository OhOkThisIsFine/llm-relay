import { describe, expect, it } from "vitest";
import {
  createLaneSpawner,
  MAX_OUTPUT_BYTES,
  type LaneChildProcess,
  type LaneExecOptions,
  type LaneProcessApi,
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
