/**
 * MCP-side telemetry forwarding: the server forwards one metadata-only
 * `DispatchedTelemetryReport` per settled lane ATTEMPT — never for a cancelled job —
 * fire-and-forget so a bad reporter cannot touch the dispatch result, the job, or the stdio
 * protocol.
 *
 * ⚠ "Per attempt", not "per job", and answer-mode relay jobs ARE forwarded: both changed on
 * 2026-09-06 with the dispatch walk, because the daemon records the lane pin and the lane
 * demotion from these reports and the lane the walk exists to route around is a relay lane.
 * The reasoning is quoted in full above the flipped test below.
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
    order: next ? [next.id] : [],
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

  // ⚠ FLIPPED 2026-09-06, in the same change as the source, and the old assertion is quoted here
  // rather than deleted: this test used to be `forwards nothing for an answer-mode job` and
  // asserted `reports` was EMPTY. That was the right contract while telemetry existed only to
  // meter lanes — a `relay` lane's HTTP traffic is already metered by the daemon's own pipeline,
  // so a second row would have double counted.
  //
  // The dispatch WALK gave the same channel a second job: the daemon records the lane PIN and the
  // lane DEMOTION from these reports. The lane this feature exists to route around is `free-pool`,
  // a `relay` lane — so under the old contract the walk could never learn anything about its own
  // primary target, and the feature would have been inert on exactly the case the owner reported.
  //
  // Double counting is still prevented, but by the DAEMON rather than by silence here: its
  // `/dispatch/telemetry` route skips the accounting ledger for a `relay`-kind rung on its own
  // (`accounting: "skipped", reason: "relay-kind"`), while still recording lane stats and affinity.
  it("forwards a report for an answer-mode relay job, so the daemon can pin the lane", async () => {
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
    expect(reports).toHaveLength(1);
    expect(reports[0]!.kind).toBe("relay");
    expect(reports[0]!.laneId).toBe("free-pool");
    expect(reports[0]!.status).toBe("completed");
    // A relay lane in answer mode RAN in answer mode, so its run keys the answer-mode window.
    expect(reports[0]!.mode).toBe("answer");
    // Still metadata only, and still a shape the daemon's own validator accepts.
    expect(parseTelemetryReport(JSON.parse(JSON.stringify(reports[0])))).toEqual(reports[0]);
  });

  it("forwards exactly one kind:cli report for answer mode on a cli lane (P2)", async () => {
    // Only answer+RELAY takes the direct-HTTP path (`dispatchAnswer`, never forwarded). An
    // answer+cli rung falls through to the shared spawn path, whose settle forwards — a
    // future reader trusting the old "never answer mode" comment who gates the forward on
    // mode would silently drop every cli-answer ledger row, so this pins the fall-through.
    const reports: DispatchedTelemetryReport[] = [];
    const stdout = "the cli answer-mode answer";
    const task = "cli answer-mode probe task";
    const h = new Harness({
      buildView: async () => view({ next: lane({ id: "agy", kind: "cli", spec: "agy" }) }),
      spawn: fakeSpawner({ code: 0, stdout, stderr: "", timedOut: false }),
      reportTelemetry: (report) => { reports.push(report); },
    });
    const { text, isError } = await h.tool("dispatch", { task, mode: "answer" });
    expect(isError).toBe(false);
    expect(text).toContain(stdout);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.kind).toBe("cli");
    expect(reports[0]!.laneId).toBe("agy");
    expect(reports[0]!.status).toBe("completed");
    // ⚠ A cli lane asked for answer mode spawns its harness exactly as in agent mode, so its run is
    // an AGENT-mode sample: filing it under answer mode would put minutes into a seconds window.
    expect(reports[0]!.mode).toBe("agent");
    expect(parseTelemetryReport(JSON.parse(JSON.stringify(reports[0])))).toEqual(reports[0]);
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
        // Added 2026-09-06 with the dispatch walk. The daemon's routing memory is keyed by TIER —
        // each tier is its own ladder, so a pin recorded without it would let one lane's success on
        // a cheap tier steer every reasoning level. A configured ladder name is metadata like the
        // lane id beside it, never task content, which the value assertions below still enforce.
        "tier",
        // Added 2026-09-10: the mode the lane RAN in keys its stats window, because an agent-mode
        // run takes minutes and an answer-mode run seconds. A closed two-member vocabulary.
        "mode",
        "wallClockMs",
        "exitCode",
        "status",
        "estimatedInputTokens",
        "estimatedOutputTokens",
      ]),
    );
    expect(reports[0]!.mode).toBe("agent");
    for (const value of Object.values(reports[0]!)) {
      if (typeof value === "string") {
        expect(value).not.toContain(task);
        expect(value).not.toContain(stdout);
      }
    }
  });
});
