import { describe, expect, it } from "vitest";
import {
  LANE_EXECUTION_SCHEMA,
  LaneExecutionBroker,
  parseLaneExecutionBrokerRequest,
  type LaneExecutionLaunchHandle,
  type LaneExecutionRunResult,
  type LaneExecutionStartRequest,
} from "../src/lane-execution-broker.js";

function start(overrides: Partial<LaneExecutionStartRequest> = {}): LaneExecutionStartRequest {
  return {
    action: "start",
    executionId: "exec_1234567890abcdef",
    jobId: "job-900000000000000000000000000000000000000000000001",
    laneId: "agy-gemini",
    task: "inspect the repository",
    cwd: "C:/Code/worktree",
    timeoutMs: 60_000,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

describe("parseLaneExecutionBrokerRequest", () => {
  it("accepts the closed start/status/cancel vocabulary", () => {
    expect(parseLaneExecutionBrokerRequest(start())).toEqual(start());
    expect(parseLaneExecutionBrokerRequest({
      action: "status",
      executionId: "exec_1234567890abcdef",
    })).toEqual({
      action: "status",
      executionId: "exec_1234567890abcdef",
    });
    expect(parseLaneExecutionBrokerRequest({
      action: "cancel",
      executionId: "exec_1234567890abcdef",
    })).toEqual({
      action: "cancel",
      executionId: "exec_1234567890abcdef",
    });
  });

  it("rejects unknown keys, malformed ids, empty tasks and unsafe timeout values", () => {
    expect(parseLaneExecutionBrokerRequest({ ...start(), command: "powershell" })).toBeNull();
    expect(parseLaneExecutionBrokerRequest({ ...start(), executionId: "bad id" })).toBeNull();
    expect(parseLaneExecutionBrokerRequest({ ...start(), task: "" })).toBeNull();
    expect(parseLaneExecutionBrokerRequest({ ...start(), timeoutMs: 0 })).toBeNull();
    expect(parseLaneExecutionBrokerRequest({ ...start(), timeoutMs: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseLaneExecutionBrokerRequest({
      action: "status",
      executionId: "exec_1234567890abcdef",
      extra: true,
    })).toBeNull();
  });
});

describe("LaneExecutionBroker", () => {
  it("starts once and makes an identical transport retry idempotent", async () => {
    const run = deferred<LaneExecutionRunResult>();
    let launches = 0;
    const broker = new LaneExecutionBroker(() => {
      launches += 1;
      return { result: run.promise, cancel: () => {} };
    }, () => 100);

    const first = await broker.handle(start());
    const retry = await broker.handle(start());

    expect(first).toMatchObject({
      ok: true,
      execution: {
        schema: LANE_EXECUTION_SCHEMA,
        status: "running",
        executionId: start().executionId,
      },
    });
    expect(retry).toEqual(first);
    expect(launches).toBe(1);

    run.resolve({ code: 0, stdout: "done", stderr: "", timedOut: false });
    await Promise.resolve();
    expect(await broker.handle({ action: "status", executionId: start().executionId }))
      .toMatchObject({ ok: true, execution: { status: "completed", stdout: "done", code: 0 } });
  });

  it("refuses an execution-id collision with a different start identity", async () => {
    const never = new Promise<LaneExecutionRunResult>(() => {});
    const broker = new LaneExecutionBroker(() => ({ result: never, cancel: () => {} }));

    expect((await broker.handle(start())).ok).toBe(true);
    expect(await broker.handle(start({ task: "different task" }))).toEqual({
      ok: false,
      status: 409,
      message: "lane execution id already exists with a different start request",
    });
  });

  it("reports injected activity while running without exposing process ids or task text", async () => {
    const run = deferred<LaneExecutionRunResult>();
    const handle: LaneExecutionLaunchHandle = {
      result: run.promise,
      cancel: () => {},
      activity: () => ({
        stdoutBytes: 12,
        stderrBytes: 3,
        lastOutputAt: 55,
        cpuMs: 1234,
      }),
    };
    const broker = new LaneExecutionBroker(() => handle, () => 50);
    await broker.handle(start());

    const status = await broker.handle({ action: "status", executionId: start().executionId });
    expect(status).toMatchObject({
      ok: true,
      execution: {
        status: "running",
        stdoutBytes: 12,
        stderrBytes: 3,
        lastOutputAt: 55,
        cpuMs: 1234,
      },
    });
    expect(JSON.stringify(status)).not.toContain("inspect the repository");
    expect(JSON.stringify(status)).not.toContain("pid");
  });

  it("cancellation is terminal immediately and its kill callback runs once", async () => {
    const run = deferred<LaneExecutionRunResult>();
    let cancelled = 0;
    const broker = new LaneExecutionBroker(() => ({
      result: run.promise,
      cancel: () => { cancelled += 1; },
    }), () => 100);

    await broker.handle(start());
    const first = await broker.handle({ action: "cancel", executionId: start().executionId });
    const second = await broker.handle({ action: "cancel", executionId: start().executionId });

    expect(first).toMatchObject({ ok: true, execution: { status: "cancelled", endedAt: 100 } });
    expect(second).toMatchObject({ ok: true, execution: { status: "cancelled" } });
    expect(cancelled).toBe(1);

    // A child settling after cancellation may add bounded output but never changes the terminal
    // cancellation verdict back to failed/completed.
    run.resolve({ code: 1, stdout: "partial", stderr: "stopped", timedOut: false });
    await Promise.resolve();
    expect(await broker.handle({ action: "status", executionId: start().executionId }))
      .toMatchObject({ ok: true, execution: { status: "cancelled", stdout: "partial" } });
  });

  it("never prunes a cancelled execution while its child handle is still unsettled", async () => {
    const run = deferred<LaneExecutionRunResult>();
    const broker = new LaneExecutionBroker(
      () => ({ result: run.promise, cancel: () => {} }),
      () => 100,
      0,
    );
    await broker.handle(start());
    await broker.handle({ action: "cancel", executionId: start().executionId });

    // maxTerminal=0 would normally remove every terminal row, but this one still owns the child.
    expect(await broker.handle({ action: "status", executionId: start().executionId }))
      .toMatchObject({ ok: true, execution: { status: "cancelled" } });

    run.resolve({ code: 1, stdout: "", stderr: "stopped", timedOut: false });
    await Promise.resolve();
    expect(await broker.handle({ action: "status", executionId: start().executionId }))
      .toMatchObject({ ok: false, status: 404 });
  });

  it("maps process outcomes without inventing semantic lane judgments", async () => {
    for (const [result, status] of [
      [{ code: 0, stdout: "#", stderr: "", timedOut: false }, "completed"],
      [{ code: 2, stdout: "", stderr: "bad", timedOut: false }, "failed"],
      [{ code: null, stdout: "", stderr: "", timedOut: true }, "timed_out"],
    ] as const) {
      const d = deferred<LaneExecutionRunResult>();
      const id = `exec_1234567890abcdef_${status}`;
      const broker = new LaneExecutionBroker(() => ({ result: d.promise, cancel: () => {} }));
      await broker.handle(start({ executionId: id }));
      d.resolve(result);
      await Promise.resolve();
      expect(await broker.handle({ action: "status", executionId: id }))
        .toMatchObject({ ok: true, execution: { status } });
    }
  });

  it("prunes only oldest terminal rows, never a running execution", async () => {
    const pending = deferred<LaneExecutionRunResult>();
    const terminals = new Map<string, ReturnType<typeof deferred<LaneExecutionRunResult>>>();
    const broker = new LaneExecutionBroker((request) => {
      if (request.executionId === "exec_running_12345678") {
        return { result: pending.promise, cancel: () => {} };
      }
      const d = deferred<LaneExecutionRunResult>();
      terminals.set(request.executionId, d);
      return { result: d.promise, cancel: () => {} };
    }, Date.now, 2);

    await broker.handle(start({ executionId: "exec_running_12345678" }));
    for (const id of ["exec_terminal_11111111", "exec_terminal_22222222", "exec_terminal_33333333"]) {
      await broker.handle(start({ executionId: id }));
      terminals.get(id)!.resolve({ code: 0, stdout: id, stderr: "", timedOut: false });
      await Promise.resolve();
    }

    expect((await broker.handle({ action: "status", executionId: "exec_running_12345678" })).ok).toBe(true);
    expect(await broker.handle({ action: "status", executionId: "exec_terminal_11111111" }))
      .toMatchObject({ ok: false, status: 404 });
    expect((await broker.handle({ action: "status", executionId: "exec_terminal_22222222" })).ok).toBe(true);
    expect((await broker.handle({ action: "status", executionId: "exec_terminal_33333333" })).ok).toBe(true);
  });

  it("returns a bounded refusal and never creates a row when the configured launcher refuses", async () => {
    const broker = new LaneExecutionBroker(() => ({ refusal: "configured lane is not executable" }));
    expect(await broker.handle(start())).toEqual({
      ok: false,
      status: 400,
      message: "configured lane is not executable",
    });
    expect(await broker.handle({ action: "status", executionId: start().executionId }))
      .toMatchObject({ ok: false, status: 404 });
  });
});
