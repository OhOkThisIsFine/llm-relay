/**
 * MCP-side telemetry forwarding (packet 2): the server forwards one metadata-only
 * `DispatchedTelemetryReport` per settled agent-mode job — never for answer-mode jobs,
 * never for cancelled jobs — fire-and-forget so a bad reporter cannot touch the dispatch
 * result, the job, or the stdio protocol.
 *
 * Harness and fixtures follow the `test/mcp-server.test.ts` pattern; `reportTelemetry`
 * is injected as a recording fake.
 */
import { describe, expect, it, vi } from "vitest";
import {
  McpDispatchServer,
  type DispatchViewBuilder,
  type McpServerDeps,
} from "../src/mcp/server.js";
import {
  parseTelemetryReport,
  type DispatchedTelemetryReport,
} from "../src/dispatch-lane-stats.js";
import { estimateTokensFromCharacters } from "../src/metadata.js";
import type {
  LaneRunResult,
  LaneSpawner,
} from "../src/mcp/lane-runner.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";

// ---------------------------------------------------------------------------------------------
// Harness (mirrors test/mcp-server.test.ts)

function lane(over: Partial<DispatchLane> = {}): DispatchLane {
  return {
    id: "agy",
    kind: "cli",
    position: 1,
    state: "ready",
    spec: "agy",
    invoke: { command: "agy", args: ["-p", "the task"] },
    ...over,
  };
}

function view(over: Partial<DispatchView> = {}): DispatchView {
  const next = over.next === undefined ? lane() : over.next;
  return {
    tier: "medium",
    offload: false,
    client: "claude",
    host: "bypassed",
    ladder: next ? [next] : [],
    next,
    reason: "first ready lane",
    ...over,
  };
}

/** A spawner that resolves with a fixed result, and records what it was called with. */
function fakeSpawner(result: LaneRunResult, delayMs = 0): LaneSpawner & { calls: Parameters<LaneSpawner>[] } {
  const calls: Parameters<LaneSpawner>[] = [];
  const fn: LaneSpawner = (command, args, opts) => {
    calls.push([command, args, opts]);
    let settle: (r: LaneRunResult) => void = () => {};
    const promise = new Promise<LaneRunResult>((resolve) => {
      settle = resolve;
      if (delayMs === 0) resolve(result);
      else setTimeout(() => resolve(result), delayMs).unref?.();
    });
    return { result: promise, kill: () => settle({ code: null, stdout: "", stderr: "killed", timedOut: false }) };
  };
  return Object.assign(fn, { calls });
}

class Harness {
  readonly out: string[] = [];
  readonly server: McpDispatchServer;
  private id = 0;

  constructor(over: Partial<McpServerDeps> = {}) {
    const builder: DispatchViewBuilder = async () => view();
    this.server = new McpDispatchServer({
      config: { host: "127.0.0.1", port: 8791 } as Config,
      buildView: over.buildView ?? builder,
      spawn: over.spawn ?? fakeSpawner({ code: 0, stdout: "lane answer", stderr: "", timedOut: false }),
      cwd: over.cwd ?? (() => process.cwd()),
      write: (chunk) => this.out.push(chunk),
      ...over,
    });
  }

  async request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    this.id += 1;
    const before = this.out.length;
    await this.server.ingest(JSON.stringify({ jsonrpc: "2.0", id: this.id, method, params }) + "\n");
    const line = this.out[before];
    expect(line, `no response for ${method}`).toBeDefined();
    return JSON.parse(line as string) as Record<string, unknown>;
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const res = await this.request("tools/call", { name, arguments: args });
    const result = res["result"] as { content: { text: string }[]; isError: boolean };
    return { text: result.content[0]?.text ?? "", isError: result.isError };
  }
}

function assistantTextResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------------------------

describe("mcp telemetry forwarding", () => {
  it("forwards exactly ONE report on agent-mode completion, through the daemon's own validator", async () => {
    const reports: DispatchedTelemetryReport[] = [];
    const stdout = "the lane's answer";
    const task = "telemetry completion probe task";
    const h = new Harness({
      spawn: fakeSpawner({ code: 0, stdout, stderr: "", timedOut: false }),
      reportTelemetry: (report) => { reports.push(report); },
    });
    const { text, isError } = await h.tool("dispatch", { task });
    expect(isError).toBe(false);
    expect(text).toContain(stdout);
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.laneId).toBe("agy");
    expect(report.kind).toBe("cli");
    expect(report.status).toBe("completed");
    expect(report.exitCode).toBe(0);
    expect(report.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(report.wallClockMs)).toBe(true);
    expect(report.estimatedInputTokens).toBe(estimateTokensFromCharacters(task.length));
    expect(report.estimatedOutputTokens).toBe(estimateTokensFromCharacters(stdout.length));
    // A round trip through the daemon's own validator — what the server forwards, the route accepts.
    expect(parseTelemetryReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  it("forwards nothing for an answer-mode job", async () => {
    const reports: DispatchedTelemetryReport[] = [];
    const fetchImpl = (async () => assistantTextResponse("the direct answer")) as unknown as typeof fetch;
    const h = new Harness({
      buildView: async () => view({ next: lane({ id: "free-pool", kind: "relay", spec: "pool/medium" }) }),
      fetch: fetchImpl,
      reportTelemetry: (report) => { reports.push(report); },
    });
    const { text, isError } = await h.tool("dispatch", { task: "answer-mode probe task", mode: "answer" });
    expect(isError).toBe(false);
    expect(text).toContain("the direct answer");
    expect(reports).toHaveLength(0);
  });

  it("forwards nothing for a cancelled job", async () => {
    vi.useFakeTimers();
    try {
      const reports: DispatchedTelemetryReport[] = [];
      const h = new Harness({
        spawn: fakeSpawner({ code: 0, stdout: "too late", stderr: "", timedOut: false }, 5000),
        reportTelemetry: (report) => { reports.push(report); },
      });
      const call = h.tool("dispatch", { task: "cancellable probe task", waitMs: 100 });
      await vi.advanceTimersByTimeAsync(150);
      const jobId = /job: (job-\d+)/.exec((await call).text)?.[1] as string;
      const cancelled = await h.tool("dispatch_cancel", { jobId });
      expect(cancelled.text).toContain("cancelled");
      await vi.advanceTimersByTimeAsync(6000);
      const after = await h.tool("dispatch_status", { jobId });
      expect(after.text).toContain("status: cancelled");
      expect(reports).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["throwing", () => { throw new Error("telemetry down"); }],
    ["rejecting", async () => { throw new Error("telemetry down"); }],
  ])("a %s reporter is swallowed: dispatch result unchanged, protocol stays up", async (_kind, reporter) => {
    const h = new Harness({
      spawn: fakeSpawner({ code: 0, stdout: "lane answer", stderr: "", timedOut: false }),
      reportTelemetry: reporter as (report: DispatchedTelemetryReport) => Promise<void> | void,
    });
    const { text, isError } = await h.tool("dispatch", { task: "swallow probe task" });
    expect(isError).toBe(false);
    expect(text).toContain("lane answer");
    expect(text).toContain("status: completed");
    // The stdio protocol keeps working after the reporter failed.
    const list = await h.request("tools/list", {});
    expect((list["result"] as { tools: unknown[] }).tools).toHaveLength(5);
  });

  it("forwards status timed_out for a timed-out run", async () => {
    const reports: DispatchedTelemetryReport[] = [];
    const h = new Harness({
      spawn: fakeSpawner({ code: null, stdout: "partial output", stderr: "", timedOut: true }),
      reportTelemetry: (report) => { reports.push(report); },
    });
    const { isError } = await h.tool("dispatch", { task: "timeout probe task" });
    expect(isError).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.status).toBe("timed_out");
    expect(parseTelemetryReport(JSON.parse(JSON.stringify(reports[0])))).toEqual(reports[0]);
  });

  it("forwards status failed with exitCode null and zero output tokens when the spawner throws", async () => {
    const reports: DispatchedTelemetryReport[] = [];
    const h = new Harness({
      spawn: (() => { throw new Error("spawn refused"); }) as unknown as LaneSpawner,
      reportTelemetry: (report) => { reports.push(report); },
    });
    const { isError } = await h.tool("dispatch", { task: "spawn-throw probe task" });
    expect(isError).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.status).toBe("failed");
    expect(reports[0]!.exitCode).toBeNull();
    expect(reports[0]!.estimatedOutputTokens).toBe(0);
    expect(parseTelemetryReport(JSON.parse(JSON.stringify(reports[0])))).toEqual(reports[0]);
  });

  it("forwards kind relay for a relay-kind lane run in agent mode", async () => {
    const reports: DispatchedTelemetryReport[] = [];
    const h = new Harness({
      buildView: async () => view({ next: lane({ id: "free-pool", kind: "relay", spec: "pool/medium" }) }),
      spawn: fakeSpawner({ code: 0, stdout: "relay agent answer", stderr: "", timedOut: false }),
      reportTelemetry: (report) => { reports.push(report); },
    });
    const { text, isError } = await h.tool("dispatch", { task: "relay agent probe task" });
    expect(isError).toBe(false);
    expect(text).toContain("relay agent answer");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.kind).toBe("relay");
    expect(reports[0]!.laneId).toBe("free-pool");
    expect(parseTelemetryReport(JSON.parse(JSON.stringify(reports[0])))).toEqual(reports[0]);
  });

  it("never carries the task text or the output: exact key set, metadata only", async () => {
    const reports: DispatchedTelemetryReport[] = [];
    const task = "secrecy probe task alpha bravo 98765";
    const stdout = "output delta gamma 12345";
    const h = new Harness({
      buildView: async () => view({ next: lane({ id: "agy", kind: "cli", spec: "agy" }) }),
      spawn: fakeSpawner({ code: 0, stdout, stderr: "", timedOut: false }),
      reportTelemetry: (report) => { reports.push(report); },
    });
    await h.tool("dispatch", { task });
    expect(reports).toHaveLength(1);
    expect(new Set(Object.keys(reports[0]!))).toEqual(
      new Set([
        "jobId",
        "laneId",
        "kind",
        "spec",
        "wallClockMs",
        "exitCode",
        "status",
        "estimatedInputTokens",
        "estimatedOutputTokens",
      ]),
    );
    for (const value of Object.values(reports[0]!)) {
      if (typeof value === "string") {
        expect(value).not.toContain(task);
        expect(value).not.toContain(stdout);
      }
    }
  });
});
