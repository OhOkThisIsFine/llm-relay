import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";
import {
  LANE_EXECUTION_SCHEMA,
  type LaneExecutionBrokerRequest,
  type LaneExecutionSnapshot,
} from "../src/lane-execution-broker.js";
import type {
  LaneExecutionClient,
  LaneExecutionClientResult,
} from "../src/mcp/lane-execution-client.js";
import {
  BROKER_STATUS_POLL_MS,
  McpDispatchServer,
  type McpServerDeps,
} from "../src/mcp/server.js";
import type { LaneSpawner } from "../src/mcp/lane-runner.js";

function lane(id = "lane-a", position = 1): DispatchLane {
  return {
    id,
    kind: "cli",
    position,
    state: "ready",
    invoke: { command: "codex", args: ["exec", "{task}"] },
  };
}

function view(lanes: DispatchLane[] = [lane()]): DispatchView {
  return {
    tier: "high",
    offload: false,
    client: "claude",
    host: "bypassed",
    ladder: lanes,
    order: lanes.map((l) => l.id),
    next: lanes[0] ?? null,
    reason: "test",
    source: "daemon",
  };
}

function snapshot(
  request: Extract<LaneExecutionBrokerRequest, { action: "start" }>,
  overrides: Partial<LaneExecutionSnapshot> = {},
): LaneExecutionSnapshot {
  return {
    schema: LANE_EXECUTION_SCHEMA,
    executionId: request.executionId,
    jobId: request.jobId,
    laneId: request.laneId,
    status: "completed",
    startedAt: 100,
    endedAt: 200,
    stdoutBytes: 6,
    stderrBytes: 0,
    lastOutputAt: 190,
    code: 0,
    stdout: "answer",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

class BrokerHarness {
  readonly out: string[] = [];
  readonly requests: LaneExecutionBrokerRequest[] = [];
  readonly localCalls: Parameters<LaneSpawner>[] = [];
  readonly server: McpDispatchServer;
  private id = 0;

  constructor(
    broker: (request: LaneExecutionBrokerRequest) => LaneExecutionClientResult | Promise<LaneExecutionClientResult>,
    lanes: DispatchLane[] = [lane()],
    over: Partial<McpServerDeps> = {},
  ) {
    const client: LaneExecutionClient = {
      request: async (request) => {
        this.requests.push(request);
        return broker(request);
      },
    };
    const local: LaneSpawner = (command, args, opts) => {
      this.localCalls.push([command, args, opts]);
      return {
        result: Promise.resolve({ code: 0, stdout: "local answer", stderr: "", timedOut: false }),
        kill: () => {},
      };
    };
    this.server = new McpDispatchServer({
      config: {
        host: "127.0.0.1",
        port: 8791,
        routing: {
          default: "x",
          dispatchWalk: { enabled: true, idleMs: 300_000, maxLanes: 4 },
          mcp: { maxWaitMs: 25_000 },
        },
      } as unknown as Config,
      buildView: async () => view(lanes),
      spawn: local,
      cwd: () => process.cwd(),
      laneExecutionClient: client,
      write: (chunk) => this.out.push(chunk),
      ...over,
    });
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    this.id += 1;
    const before = this.out.length;
    await this.server.ingest(
      JSON.stringify({ jsonrpc: "2.0", id: this.id, method: "tools/call", params: { name, arguments: args } }) + "\n",
    );
    const result = JSON.parse(this.out[before]!)["result"] as {
      content: Array<{ text: string }>;
      isError: boolean;
    };
    return { text: result.content[0]?.text ?? "", isError: result.isError };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("D1 fresh-dispatch ownership switchover", () => {
  it("runs a fresh agent attempt through the daemon broker and never invokes the local spawner", async () => {
    let started: Extract<LaneExecutionBrokerRequest, { action: "start" }> | undefined;
    const h = new BrokerHarness((request) => {
      if (request.action === "status") {
        return { ok: false, kind: "rejected", status: 404, message: "unknown lane execution id" };
      }
      if (request.action === "start") {
        started = request;
        return { ok: true, execution: snapshot(request) };
      }
      throw new Error("unexpected cancel");
    });

    const result = await h.tool("dispatch", { task: "do the work", tier: "high" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("answer");
    expect(result.text).toContain("execution-owner: relay-daemon");
    expect(h.localCalls).toHaveLength(0);
    expect(started).toMatchObject({
      laneId: "lane-a",
      task: "do the work",
      tier: "high",
      host: "bypassed",
      depth: 0,
    });
  });

  it("falls back locally only when broker preflight fails before any start request", async () => {
    const h = new BrokerHarness((request) => {
      expect(request.action).toBe("status");
      return { ok: false, kind: "unavailable", status: null, message: "daemon unavailable" };
    });

    const result = await h.tool("dispatch", { task: "do the work" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("local answer");
    expect(result.text).toContain("execution-owner: local-fallback");
    expect(h.localCalls).toHaveLength(1);
    expect(h.requests.every((request) => request.action !== "start")).toBe(true);
  });

  it("retries an ambiguous start with the same execution id and never falls back locally", async () => {
    vi.useFakeTimers();
    let startCount = 0;
    let executionId = "";
    const h = new BrokerHarness((request) => {
      if (request.action === "status") {
        return { ok: false, kind: "rejected", status: 404, message: "unknown lane execution id" };
      }
      if (request.action === "start") {
        startCount += 1;
        executionId ||= request.executionId;
        expect(request.executionId).toBe(executionId);
        if (startCount === 1) {
          return { ok: false, kind: "unavailable", status: null, message: "reply lost" };
        }
        return { ok: true, execution: snapshot(request) };
      }
      throw new Error("unexpected cancel");
    });

    const pending = h.tool("dispatch", { task: "do the work" });
    await vi.advanceTimersByTimeAsync(BROKER_STATUS_POLL_MS);
    const result = await pending;
    expect(result.text).toContain("answer");
    expect(startCount).toBe(2);
    expect(h.localCalls).toHaveLength(0);
  });

  it("continues the walk after a brokered lane fails instead of terminalizing the whole job", async () => {
    const starts: string[] = [];
    const lanes = [lane("lane-a", 1), lane("lane-b", 2)];
    const h = new BrokerHarness((request) => {
      if (request.action === "status") {
        return { ok: false, kind: "rejected", status: 404, message: "unknown lane execution id" };
      }
      if (request.action === "start") {
        starts.push(request.laneId);
        return {
          ok: true,
          execution: snapshot(
            request,
            request.laneId === "lane-a"
              ? {
                  status: "failed",
                  code: 2,
                  stdout: "",
                  stderr: "first failed",
                  timedOut: false,
                }
              : { stdout: "second answered", stdoutBytes: 15 },
          ),
        };
      }
      throw new Error("unexpected cancel");
    }, lanes);

    const result = await h.tool("dispatch", { task: "do the work" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("second answered");
    expect(starts).toEqual(["lane-a", "lane-b"]);
    expect(h.localCalls).toHaveLength(0);
  });

  it("MCP shutdown leaves a running daemon-owned execution untouched", async () => {
    vi.useFakeTimers();
    const actions: string[] = [];
    const h = new BrokerHarness((request) => {
      actions.push(request.action);
      if (request.action === "status") {
        return { ok: false, kind: "rejected", status: 404, message: "unknown lane execution id" };
      }
      if (request.action === "start") {
        return {
          ok: true,
          execution: snapshot(request, {
            status: "running",
            endedAt: null,
            code: undefined,
            stdout: undefined,
            stderr: undefined,
            timedOut: undefined,
          }),
        };
      }
      return { ok: false, kind: "unavailable", status: null, message: "should not cancel on shutdown" };
    }, [lane()], {
      config: {
        host: "127.0.0.1",
        port: 8791,
        routing: {
          default: "x",
          dispatchWalk: { enabled: false, idleMs: 300_000, maxLanes: 1 },
          mcp: { maxWaitMs: 1 },
        },
      } as unknown as Config,
    });

    const pending = h.tool("dispatch", { task: "keep working", waitMs: 1 });
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.text).toContain("execution-owner: relay-daemon");
    h.server.shutdown();
    expect(actions).not.toContain("cancel");
  });
});
