import { describe, expect, it } from "vitest";
import {
  createLaneExecutionClient,
  createLaneExecutionId,
} from "../src/mcp/lane-execution-client.js";
import { LANE_EXECUTION_SCHEMA } from "../src/lane-execution-broker.js";
import type { Config } from "../src/config.js";

const cfg = {
  host: "127.0.0.1",
  port: 8791,
  sourcePath: "C:/relay/config.json",
} as Pick<Config, "host" | "port" | "sourcePath">;

const authorization = {
  attach(headers: Readonly<Record<string, string>> = {}) {
    return { ...headers, "x-llm-relay-control-token": "test-control" };
  },
};

function runningExecution(overrides: Record<string, unknown> = {}) {
  return {
    schema: LANE_EXECUTION_SCHEMA,
    executionId: "exec-00112233445566778899aabbccddeeff",
    jobId: "job-900000000000000000000000000000000000000000000001",
    laneId: "agy-gemini",
    status: "running",
    startedAt: 100,
    endedAt: null,
    stdoutBytes: 12,
    stderrBytes: 0,
    lastOutputAt: 110,
    ...overrides,
  };
}

describe("createLaneExecutionClient", () => {
  it("sends the exact broker request with control authorization and accepts a strict snapshot", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ execution: runningExecution() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = createLaneExecutionClient(cfg, { fetch: fetchFn, authorization });

    const request = {
      action: "status" as const,
      executionId: "exec-00112233445566778899aabbccddeeff",
    };
    const result = await client.request(request);

    expect(result).toEqual({ ok: true, execution: runningExecution() });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://127.0.0.1:8791/mcp/lane-execution");
    expect(seen[0]!.init?.method).toBe("POST");
    expect(new Headers(seen[0]!.init?.headers).get("x-llm-relay-control-token")).toBe("test-control");
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual(request);
  });

  it("distinguishes a reachable daemon's 404 from transport unavailability", async () => {
    const rejected = createLaneExecutionClient(cfg, {
      authorization,
      fetch: (async () =>
        new Response(JSON.stringify({ error: { type: "error", message: "unknown lane execution id" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    expect(await rejected.request({
      action: "status",
      executionId: "exec-00112233445566778899aabbccddeeff",
    })).toEqual({
      ok: false,
      kind: "rejected",
      status: 404,
      message: "unknown lane execution id",
    });

    const unavailable = createLaneExecutionClient(cfg, {
      authorization,
      fetch: (async () => { throw new Error("connection refused"); }) as typeof fetch,
    });
    expect(await unavailable.request({
      action: "status",
      executionId: "exec-00112233445566778899aabbccddeeff",
    })).toEqual({
      ok: false,
      kind: "unavailable",
      status: null,
      message: "running relay lane execution broker is unavailable",
    });
  });

  it("never turns malformed success JSON into an execution result", async () => {
    for (const payload of [
      { execution: { ...runningExecution(), schema: "future.v2" } },
      { execution: runningExecution(), extra: true },
      { execution: { ...runningExecution(), endedAt: 120 } }, // running must have null endedAt
      { execution: { ...runningExecution(), mystery: true } },
    ]) {
      const client = createLaneExecutionClient(cfg, {
        authorization,
        fetch: (async () => new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      });
      const result = await client.request({
        action: "status",
        executionId: "exec-00112233445566778899aabbccddeeff",
      });
      expect(result.ok, JSON.stringify(payload)).toBe(false);
      if (!result.ok) expect(result.kind).toBe("invalid-response");
    }
  });

  it("accepts cancelled-before-settlement without result fields and rejects partial result quartets", async () => {
    const good = {
      execution: runningExecution({ status: "cancelled", endedAt: 120 }),
    };
    const bad = {
      execution: runningExecution({
        status: "cancelled",
        endedAt: 120,
        stdout: "partial",
      }),
    };
    const make = (payload: unknown) => createLaneExecutionClient(cfg, {
      authorization,
      fetch: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    });

    expect((await make(good).request({
      action: "status",
      executionId: "exec-00112233445566778899aabbccddeeff",
    })).ok).toBe(true);
    expect((await make(bad).request({
      action: "status",
      executionId: "exec-00112233445566778899aabbccddeeff",
    })).ok).toBe(false);
  });

  it("does not perform a real HTTP request under vitest when no fetch seam is injected", async () => {
    const client = createLaneExecutionClient(cfg, { authorization });
    expect(await client.request({
      action: "status",
      executionId: "exec-00112233445566778899aabbccddeeff",
    })).toEqual({
      ok: false,
      kind: "unavailable",
      status: null,
      message: "running relay lane execution broker is unavailable",
    });
  });
});

describe("createLaneExecutionId", () => {
  it("encodes exactly 128 bits without task/lane material", () => {
    expect(createLaneExecutionId(new Uint8Array(16).fill(0xab)))
      .toBe("exec-abababababababababababababababab");
    expect(() => createLaneExecutionId(new Uint8Array(15))).toThrow(/exactly 16 bytes/);
  });
});
