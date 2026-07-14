import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProxy } from "../src/server.js";
import type { Config } from "../src/config.js";

/** A mock Anthropic-ish backend the proxy forwards to. */
function mockBackend(handler: (path: string, body: string) => { status?: number; headers: Record<string, string>; body: string }): Promise<Server> {
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const out = handler(req.url ?? "/", Buffer.concat(chunks).toString("utf8"));
      res.writeHead(out.status ?? 200, out.headers);
      res.end(out.body);
    });
  });
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(s)));
}

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

function startProxy(cfg: Config): Promise<Server> {
  const s = createProxy(cfg);
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(s)));
}

function lastLogLine(file: string): Record<string, unknown> {
  const lines = readFileSync(file, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!);
}

const REQUEST_BODY = JSON.stringify({
  model: "mock-model",
  messages: [{ role: "user", content: "weather?" }],
  tools: [
    { name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  ],
});

describe("repair-proxy end-to-end (detect mode)", () => {
  let dir: string;
  let logFile: string;
  let backend: Server;
  let proxy: Server;
  let cfg: Config;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rp-"));
    logFile = join(dir, "log.jsonl");
  });
  afterAll(() => {
    backend?.close();
    proxy?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(handler: Parameters<typeof mockBackend>[0]): Promise<number> {
    backend = await mockBackend(handler);
    cfg = {
      host: "127.0.0.1",
      port: 0,
      backend: { base: `http://127.0.0.1:${port(backend)}`, authHeader: "x-api-key", timeoutMs: 5000 },
      mode: "detect",
      log: { level: "metadata", file: logFile },
    };
    proxy = await startProxy(cfg);
    return port(proxy);
  }

  it("forwards a non-streaming body unchanged AND detects a bad tool call", async () => {
    const badResponse = JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "mock-model",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: {} }], // missing required city
    });
    const p = await boot(() => ({ headers: { "content-type": "application/json" }, body: badResponse }));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: REQUEST_BODY,
    });
    const text = await resp.text();

    // transparency: client receives the backend's bytes verbatim
    expect(text).toBe(badResponse);
    // detection: logged as a failure with the schema violation
    const rec = lastLogLine(logFile);
    expect(rec.validated).toBe("fail");
    expect(rec.errorKinds).toContain("schema_violation");
    expect(rec.hadTools).toBe(true);
  });

  it("forwards a streaming SSE body unchanged AND detects a bad tool call", async () => {
    const sseBody =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather","input":{}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const p = await boot(() => ({ headers: { "content-type": "text/event-stream" }, body: sseBody }));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: REQUEST_BODY,
    });
    const text = await resp.text();

    expect(text).toBe(sseBody);
    const rec = lastLogLine(logFile);
    expect(rec.validated).toBe("fail");
    expect(rec.streamed).toBe(true);
    expect(rec.errorKinds).toContain("schema_violation");
  });

  it("passes a well-formed tool call", async () => {
    const good = JSON.stringify({
      id: "msg_2",
      type: "message",
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_2", name: "get_weather", input: { city: "Paris" } }],
    });
    const p = await boot(() => ({ headers: { "content-type": "application/json" }, body: good }));
    await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: REQUEST_BODY,
    });
    const rec = lastLogLine(logFile);
    expect(rec.validated).toBe("pass");
  });

  it("does NOT flag a built-in/typed tool (no input_schema) as unknown_tool", async () => {
    const resp = JSON.stringify({
      type: "message",
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_3", name: "bash", input: { command: "ls" } }],
    });
    const p = await boot(() => ({ headers: { "content-type": "application/json" }, body: resp }));
    await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // built-in tool: type present, NO input_schema
      body: JSON.stringify({ model: "m", messages: [], tools: [{ type: "bash_20250124", name: "bash" }] }),
    });
    const rec = lastLogLine(logFile);
    expect(rec.validated).toBe("uncheckable"); // known tool, no schema — not a fail
    expect(rec.errorKinds).not.toContain("unknown_tool");
  });

  it("does NOT silently pass an invalid call under a 2020-12 schema", async () => {
    const resp = JSON.stringify({
      type: "message",
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_4", name: "get_weather", input: {} }],
    });
    const p = await boot(() => ({ headers: { "content-type": "application/json" }, body: resp }));
    await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [],
        tools: [
          {
            name: "get_weather",
            input_schema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      }),
    });
    const rec = lastLogLine(logFile);
    expect(rec.validated).toBe("fail");
    expect(rec.errorKinds).toContain("schema_violation");
  });
});

describe("credential handling", () => {
  let dir: string;
  let logFile: string;
  let backend: Server;
  let proxy: Server;
  let received: Record<string, string | undefined> = {};

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rp-cred-"));
    logFile = join(dir, "log.jsonl");
  });
  afterAll(() => {
    backend?.close();
    proxy?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootEcho(authEnv?: string): Promise<number> {
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        received = {
          authorization: req.headers["authorization"] as string | undefined,
          "x-api-key": req.headers["x-api-key"] as string | undefined,
        };
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "message", role: "assistant", stop_reason: "end_turn", content: [] }));
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const cfg: Config = {
      host: "127.0.0.1",
      port: 0,
      backend: {
        base: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
        authHeader: "x-api-key",
        timeoutMs: 5000,
        ...(authEnv ? { authEnv } : {}),
      },
      mode: "detect",
      log: { level: "metadata", file: logFile },
    };
    proxy = createProxy(cfg);
    return new Promise((resolve) => proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as AddressInfo).port)));
  }

  it("strips inbound auth and injects the backend key when authEnv is set", async () => {
    process.env.RP_TEST_KEY = "sk-backend-xyz";
    const p = await bootEcho("RP_TEST_KEY");
    await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer CLIENT-SECRET", "x-api-key": "CLIENT-SECRET" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(received["x-api-key"]).toBe("sk-backend-xyz");
    expect(received.authorization).toBeUndefined(); // client bearer never reaches backend
    delete process.env.RP_TEST_KEY;
  });

  it("passes the caller's auth through when no authEnv is configured", async () => {
    const p = await bootEcho(undefined);
    await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer CLIENT-SECRET" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(received.authorization).toBe("Bearer CLIENT-SECRET");
  });
});

describe("streaming transparency across many chunks", () => {
  let backend: Server;
  let proxy: Server;
  afterAll(() => {
    backend?.close();
    proxy?.close();
  });

  it("forwards a large multi-write SSE stream byte-for-byte", async () => {
    // Build a >64KB SSE body and emit it in many small writes, splitting frames.
    const events: string[] = [];
    for (let i = 0; i < 2000; i++) {
      events.push(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"chunk-${i}-padding-padding-padding"}}\n\n`);
    }
    const full = events.join("");
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", async () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          // write in 300-byte slices to force many chunks + mid-frame splits
          for (let i = 0; i < full.length; i += 300) {
            res.write(full.slice(i, i + 300));
          }
          res.end();
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const cfg: Config = {
      host: "127.0.0.1",
      port: 0,
      backend: { base: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, authHeader: "x-api-key", timeoutMs: 5000 },
      mode: "detect",
      log: { level: "silent", file: null },
    };
    proxy = createProxy(cfg);
    const p: number = await new Promise((resolve) => proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as AddressInfo).port)));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [], tools: [{ name: "x", input_schema: { type: "object" } }] }),
    });
    const text = await resp.text();
    expect(text.length).toBe(full.length);
    expect(text).toBe(full);
  });
});
