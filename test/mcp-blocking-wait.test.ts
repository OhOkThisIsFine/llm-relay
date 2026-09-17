/**
 * The blocking wait for a host that survives a long tool call (2026-09-17).
 *
 * A native subagent answers in ONE call. `dispatch` used to hand back a job id after 25 s on every
 * host, because Codex yields at 31 s and the Claude desktop chat client cancels at 60 s. Claude Code
 * (`clientInfo.name` "claude-code") was measured completing a 240 s call, so there `dispatch` now
 * waits for the answer and sends `notifications/progress` while it waits. Every other host, and a
 * Claude Code call that asked for no progress, keeps the 25 s ceiling.
 * Evidence: docs/mcp-host-timeouts-2026-09-17.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpDispatchServer, PROGRESS_INTERVAL_MS } from "../src/mcp/server.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";
import type { LaneRunResult, LaneSpawner } from "../src/mcp/lane-runner.js";
import { DEFAULT_MCP_BLOCKING_WAIT_MS, DEFAULT_MCP_MAX_WAIT_MS } from "../src/config-types.js";

const LANE_MS = 5 * 60_000;

function slowSpawner(stdout: string, delayMs: number): LaneSpawner {
  return () => {
    let settle: (r: LaneRunResult) => void = () => {};
    const result = new Promise<LaneRunResult>((resolve) => {
      settle = resolve;
      setTimeout(() => resolve({ code: 0, stdout, stderr: "", timedOut: false }), delayMs);
    });
    return { result, kill: () => settle({ code: null, stdout: "", stderr: "killed", timedOut: false }) };
  };
}

interface Wire {
  id?: number;
  method?: string;
  params?: { progressToken?: unknown; progress?: number; message?: string };
  result?: { content: Array<{ text: string }>; isError: boolean };
}

function harness(
  opts: { client?: string | undefined; blockingWaitMs?: number | undefined; laneMs?: number | undefined } = {},
) {
  const out: Wire[] = [];
  const lane: DispatchLane = {
    id: "agy",
    kind: "cli",
    position: 1,
    state: "ready",
    invoke: { command: "agy", args: ["{task}"] },
  };
  const view: DispatchView = {
    tier: "medium", offload: false, client: "claude", host: "bypassed", ladder: [lane], order: [lane.id], next: lane, reason: "r",
  };
  const mcp = opts.blockingWaitMs === undefined ? undefined : { blockingWaitMs: opts.blockingWaitMs };
  const server = new McpDispatchServer({
    config: { host: "127.0.0.1", port: 8791, routing: { default: "x", ...(mcp ? { mcp } : {}) } } as unknown as Config,
    buildView: async () => view,
    spawn: slowSpawner("the lane's answer", opts.laneMs ?? LANE_MS),
    cwd: () => process.cwd(),
    write: (chunk) => out.push(JSON.parse(chunk) as Wire),
  });
  let id = 0;
  const send = (message: Record<string, unknown>): Promise<void> => server.ingest(JSON.stringify(message) + "\n");
  const init = async (): Promise<void> => {
    if (opts.client === undefined) return;
    await send({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { clientInfo: { name: opts.client, version: "1" } } });
  };
  const dispatch = (meta?: Record<string, unknown>, args: Record<string, unknown> = {}) => {
    const reqId = ++id;
    const done = send({
      jsonrpc: "2.0",
      id: reqId,
      method: "tools/call",
      params: { name: "dispatch", arguments: { task: "do it", ...args }, ...(meta ? { _meta: meta } : {}) },
    });
    return { reqId, done };
  };
  const responseFor = (reqId: number): Wire | undefined => out.find((m) => m.id === reqId && m.result !== undefined);
  const progress = (): Wire[] => out.filter((m) => m.method === "notifications/progress");
  return { server, out, send, init, dispatch, responseFor, progress };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("blocking dispatch for Claude Code", () => {
  it("waits for the answer in ONE call and reports progress while it waits", async () => {
    const h = harness({ client: "claude-code" });
    await h.init();
    const call = h.dispatch({ progressToken: "tok-1" });

    // ⚠ RED before the change: the reply was a job handle at 25 s.
    await vi.advanceTimersByTimeAsync(DEFAULT_MCP_MAX_WAIT_MS + 1_000);
    expect(h.responseFor(call.reqId)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(LANE_MS);
    await call.done;
    const reply = h.responseFor(call.reqId);
    expect(reply?.result?.isError).toBe(false);
    expect(reply?.result?.content[0]?.text).toContain("the lane's answer");
    expect(reply?.result?.content[0]?.text).toContain("status: completed");

    const notes = h.progress();
    expect(notes.length).toBe(Math.floor(LANE_MS / PROGRESS_INTERVAL_MS) - 1);
    expect(notes.every((n) => n.params?.progressToken === "tok-1")).toBe(true);
    const values = notes.map((n) => n.params?.progress ?? 0);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
    expect(notes[0]?.params?.message).toMatch(/running on agy/);

    // No progress after the answer.
    const count = notes.length;
    await vi.advanceTimersByTimeAsync(5 * PROGRESS_INTERVAL_MS);
    expect(h.progress().length).toBe(count);
  });

  it("hands back the job at blockingWaitMs when the lane is still running", async () => {
    const h = harness({ client: "claude-code", blockingWaitMs: 120_000 });
    await h.init();
    const call = h.dispatch({ progressToken: 7 });
    await vi.advanceTimersByTimeAsync(120_000 + 500);
    await call.done;
    const text = h.responseFor(call.reqId)?.result?.content[0]?.text ?? "";
    expect(text).toContain("status: running");
    expect(text).toContain("Still running after 120s");
  });

  it("names the blocking ceiling when it clamps a larger waitMs", async () => {
    const h = harness({ client: "claude-code", blockingWaitMs: 60_000 });
    await h.init();
    const call = h.dispatch({ progressToken: "t" }, { waitMs: 90_000 });
    await vi.advanceTimersByTimeAsync(61_000);
    await call.done;
    expect(h.responseFor(call.reqId)?.result?.content[0]?.text).toContain(
      "waitMs 90000 clamped to routing.mcp.blockingWaitMs 60000",
    );
  });

  it("does not send a reply the host cancelled, and the job keeps running", async () => {
    const h = harness({ client: "claude-code" });
    await h.init();
    const call = h.dispatch({ progressToken: "tok" });
    await vi.advanceTimersByTimeAsync(40_000);
    await h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: call.reqId, reason: "user" } });
    await call.done;
    expect(h.responseFor(call.reqId)).toBeUndefined();

    await h.send({ jsonrpc: "2.0", id: 900, method: "tools/call", params: { name: "dispatch_status", arguments: {} } });
    expect(h.responseFor(900)?.result?.content[0]?.text).toMatch(/job-\d+ {2}running/);
  });
});

describe("hosts that keep the 25 s ceiling", () => {
  const cases: Array<{ name: string; client?: string; meta?: Record<string, unknown>; blockingWaitMs?: number }> = [
    { name: "Claude Code without a progress token", client: "claude-code" },
    { name: "the Claude desktop chat client", client: "claude-ai", meta: { progressToken: "t" } },
    { name: "Codex", client: "codex-mcp-client", meta: { progressToken: "t" } },
    { name: "a host that sent no initialize", meta: { progressToken: "t" } },
    { name: "Claude Code with blockingWaitMs 0", client: "claude-code", meta: { progressToken: "t" }, blockingWaitMs: 0 },
  ];
  for (const c of cases) {
    it(`${c.name} gets a job handle at maxWaitMs and no progress`, async () => {
      const h = harness({ client: c.client, blockingWaitMs: c.blockingWaitMs });
      await h.init();
      const call = h.dispatch(c.meta);
      await vi.advanceTimersByTimeAsync(DEFAULT_MCP_MAX_WAIT_MS + 500);
      await call.done;
      const text = h.responseFor(call.reqId)?.result?.content[0]?.text ?? "";
      expect(text).toContain("status: running");
      expect(text).toMatch(/jobId "job-\d+"/);
      expect(h.progress()).toHaveLength(0);
    });
  }

  it("keeps the default blocking cap between the two ceilings", () => {
    expect(DEFAULT_MCP_BLOCKING_WAIT_MS).toBeGreaterThan(DEFAULT_MCP_MAX_WAIT_MS);
  });
});
