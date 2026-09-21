/**
 * D1 Phase 1: the daemon lane-execution route is an admitted control-plane endpoint, not a model
 * route and not arbitrary process execution. Production MCP does not use it yet; these tests pin
 * the protocol/admission seam against an injected broker.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import { createProxy } from "../src/server.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";
import {
  LANE_EXECUTION_SCHEMA,
  type LaneExecutionBrokerPort,
  type LaneExecutionBrokerRequest,
  type LaneExecutionBrokerResult,
} from "../src/lane-execution-broker.js";

const root = mkdtempSync(join(tmpdir(), "llm-relay-broker-route-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const token = "broker-route-control-token";

function cfg(): Config {
  const path = join(root, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({
    listen: "127.0.0.1:8791",
    providers: {
      anthropic: {
        base: "http://127.0.0.1:1",
        kind: "anthropic",
      },
    },
    routing: {
      default: "anthropic",
      ladder: [
        { id: "agy-gemini", kind: "cli", command: "agy", args: ["-p", "{task}"] },
      ],
    },
    mode: "detect",
    log: { level: "silent", file: null },
  }));
  return loadConfig(path);
}

function startBody() {
  return {
    action: "start",
    executionId: "exec_1234567890abcdef",
    jobId: "job-900000000000000000000000000000000000000000000001",
    laneId: "agy-gemini",
    task: "inspect the repository",
    cwd: "C:/Code/worktree",
    timeoutMs: 60_000,
    depth: 0,
  };
}

function fakeBroker(
  calls: LaneExecutionBrokerRequest[],
  result?: LaneExecutionBrokerResult,
): LaneExecutionBrokerPort {
  return {
    async handle(request) {
      calls.push(request);
      return result ?? {
        ok: true,
        execution: {
          schema: LANE_EXECUTION_SCHEMA,
          executionId: request.executionId,
          jobId: request.action === "start" ? request.jobId : "job-existing",
          laneId: request.action === "start" ? request.laneId : "agy-gemini",
          status: "running",
          startedAt: 100,
          endedAt: null,
          stdoutBytes: 0,
          stderrBytes: 0,
          lastOutputAt: null,
        },
      };
    },
  };
}

async function withProxy<T>(
  broker: LaneExecutionBrokerPort | null | undefined,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const proxy = createProxy(cfg(), {
    controlAuthorization: { validate: (candidate) => candidate === token },
    ...(broker === undefined ? {} : { laneExecutionBroker: broker }),
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as { port: number };
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}

function post(base: string, body: unknown, authorized = true): Promise<Response> {
  return fetch(`${base}/mcp/lane-execution`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { [CONTROL_AUTHORIZATION_HEADER]: token } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /mcp/lane-execution", () => {
  it("requires the existing control capability before the broker sees the request", async () => {
    const calls: LaneExecutionBrokerRequest[] = [];
    await withProxy(fakeBroker(calls), async (base) => {
      const response = await post(base, startBody(), false);
      expect(response.status).toBe(403);
    });
    expect(calls).toEqual([]);
  });

  it("parses a valid closed request and returns only the broker execution snapshot", async () => {
    const calls: LaneExecutionBrokerRequest[] = [];
    await withProxy(fakeBroker(calls), async (base) => {
      const response = await post(base, startBody());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        execution: {
          schema: LANE_EXECUTION_SCHEMA,
          executionId: startBody().executionId,
          jobId: startBody().jobId,
          laneId: "agy-gemini",
          status: "running",
          startedAt: 100,
          endedAt: null,
          stdoutBytes: 0,
          stderrBytes: 0,
          lastOutputAt: null,
        },
      });
    });
    expect(calls).toEqual([startBody()]);
  });

  it("rejects malformed/unknown request keys before calling the broker", async () => {
    const calls: LaneExecutionBrokerRequest[] = [];
    await withProxy(fakeBroker(calls), async (base) => {
      const response = await post(base, { ...startBody(), command: "powershell.exe" });
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain("powershell.exe");
    });
    expect(calls).toEqual([]);
  });

  it("fails closed when no broker is installed", async () => {
    await withProxy(null, async (base) => {
      const response = await post(base, startBody());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { message: "lane execution broker is unavailable" },
      });
    });
  });

  it("preserves broker conflict/not-found statuses without echoing the task", async () => {
    const calls: LaneExecutionBrokerRequest[] = [];
    const broker = fakeBroker(calls, {
      ok: false,
      status: 409,
      message: "lane execution id already exists with a different start request",
    });
    await withProxy(broker, async (base) => {
      const response = await post(base, startBody());
      expect(response.status).toBe(409);
      const text = await response.text();
      expect(text).toContain("already exists");
      expect(text).not.toContain(startBody().task);
    });
  });

  it("does not let GET/HEAD fall through into model routing or the broker", async () => {
    const calls: LaneExecutionBrokerRequest[] = [];
    await withProxy(fakeBroker(calls), async (base) => {
      const response = await fetch(`${base}/mcp/lane-execution`, {
        method: "GET",
        headers: { [CONTROL_AUTHORIZATION_HEADER]: token },
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("POST a broker action");
    });
    expect(calls).toEqual([]);
  });

  it("a model-front body that resembles a broker action never reaches the broker", async () => {
    const calls: LaneExecutionBrokerRequest[] = [];
    await withProxy(fakeBroker(calls), async (base) => {
      const response = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        // Deliberately no model/messages shape: the model route should reject this itself.
        body: JSON.stringify(startBody()),
      });
      expect(response.status).not.toBe(200);
    });
    expect(calls).toEqual([]);
  });
});
