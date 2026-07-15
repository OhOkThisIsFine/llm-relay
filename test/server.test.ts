import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProxy } from "../src/server.js";
import type { Config } from "../src/config.js";
import type { Reshaper } from "../src/reshaper.js";
import { isToolUseBlock, type AssistantMessage } from "../src/anthropic.js";
import { reconstructFromSse } from "../src/sse.js";
import { reconstruct } from "../src/reshaper.js";

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
      backend: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
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
        kind: "anthropic",
        authHeader: "x-api-key",
        timeoutMs: 5000,
        ...(authEnv ? { authEnv } : {}),
      },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
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

describe("repair mode (M2)", () => {
  let dir: string;
  let logFile: string;
  let backend: Server;
  let proxy: Server;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rp-rep-"));
    logFile = join(dir, "log.jsonl");
  });
  afterAll(() => {
    backend?.close();
    proxy?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const weatherTools = [
    { name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  ];
  const fixer: Reshaper = {
    reshape: async () => ({
      kind: "message",
      message: { content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }], stop_reason: "tool_use" } as AssistantMessage,
    }),
  };

  async function bootProxy(backendBody: { headers: Record<string, string>; body: string }, reshaper: Reshaper, destructiveTools: string[] = []): Promise<number> {
    backend = await mockBackend(() => backendBody);
    const cfg: Config = {
      host: "127.0.0.1",
      port: 0,
      backend: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 },
      mode: "repair",
      repair: { maxAttempts: 2, destructiveTools },
      log: { level: "metadata", file: logFile },
    };
    proxy = createProxy(cfg, { reshaper });
    return new Promise((resolve) => proxy.listen(0, "127.0.0.1", () => resolve(port(proxy))));
  }

  function reqBody(stream: boolean, tools: object[] = weatherTools): string {
    return JSON.stringify({ model: "m", stream, messages: [{ role: "user", content: "weather?" }], tools });
  }

  it("replaces a broken NON-streaming tool call with the reshaped one", async () => {
    const broken = JSON.stringify({ type: "message", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }] });
    const p = await bootProxy({ headers: { "content-type": "application/json" }, body: broken }, fixer);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody(false) });
    const j = (await resp.json()) as { content: unknown[] };
    const tu = (j.content as AssistantMessage["content"]).find(isToolUseBlock);
    expect(tu?.input).toEqual({ city: "Paris" }); // client got the repaired call, not the empty one
    expect(lastLogLine(logFile).repair).toBe("fixed");
  });

  it("replaces a broken STREAMING tool call and re-emits valid SSE", async () => {
    const brokenSse =
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"get_weather","input":{}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n';
    const p = await bootProxy({ headers: { "content-type": "text/event-stream" }, body: brokenSse }, fixer);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody(true) });
    const text = await resp.text();
    const round = reconstructFromSse(text);
    const tu = round.content.find(isToolUseBlock);
    expect(tu?.input).toEqual({ city: "Paris" }); // re-emitted SSE carries the fix
    expect(lastLogLine(logFile).repair).toBe("fixed");
  });

  it("passes a VALID tool call through untouched in repair mode", async () => {
    const good = JSON.stringify({ type: "message", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Rome" } }] });
    const p = await bootProxy({ headers: { "content-type": "application/json" }, body: good }, fixer);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody(false) });
    expect(await resp.text()).toBe(good); // byte-identical passthrough
    expect(lastLogLine(logFile).repair).toBe("none");
  });

  it("fail-closes (502) on a destructive tool call instead of fabricating it", async () => {
    const broken = JSON.stringify({ type: "message", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "delete_file", input: {} }] });
    const delTools = [{ name: "delete_file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
    const p = await bootProxy({ headers: { "content-type": "application/json" }, body: broken }, fixer, ["delete"]);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody(false, delTools) });
    expect(resp.status).toBe(502);
    expect(lastLogLine(logFile).repair).toBe("refused_destructive");
  });
});

describe("streaming repair (M4): text-through, buffer-at-tool_use", () => {
  let dir: string;
  let logFile: string;
  let backend: Server;
  let proxy: Server;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rp-m4-"));
    logFile = join(dir, "log.jsonl");
  });
  afterAll(() => {
    backend?.close();
    proxy?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const weatherTools = [
    { name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  ];
  // A reshaper that mirrors the real one: reconstruct the SAME message (blocks +
  // order + indices preserved) with each failing tool's input set to {city:"Paris"}.
  const parisFixer: Reshaper = {
    reshape: async (req) => {
      const inputs: Record<string, unknown> = {};
      for (const b of req.rawAssistant.content) if (isToolUseBlock(b)) inputs[b.id] = { city: "Paris" };
      return { kind: "message", message: reconstruct(req.rawAssistant, inputs) };
    },
  };

  async function boot(body: { headers: Record<string, string>; body: string }, reshaper: Reshaper): Promise<number> {
    backend = await mockBackend(() => body);
    const cfg: Config = {
      host: "127.0.0.1",
      port: 0,
      backend: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 },
      mode: "repair",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "metadata", file: logFile },
    };
    proxy = createProxy(cfg, { reshaper });
    return new Promise((resolve) => proxy.listen(0, "127.0.0.1", () => resolve(port(proxy))));
  }

  function reqBody(): string {
    return JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "weather?" }], tools: weatherTools });
  }

  const frame = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
  const MSG_START = frame("message_start", { message: { usage: { input_tokens: 3 } } });
  const MSG_END =
    frame("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }) +
    frame("message_stop", {});
  const textBlock = (index: number, text: string) =>
    frame("content_block_start", { index, content_block: { type: "text", text: "" } }) +
    frame("content_block_delta", { index, delta: { type: "text_delta", text } }) +
    frame("content_block_stop", { index });
  const toolBlock = (index: number, id: string, input: object) =>
    frame("content_block_start", { index, content_block: { type: "tool_use", id, name: "get_weather", input: {} } }) +
    frame("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
    frame("content_block_stop", { index });

  it("streams leading text through, repairs the trailing tool_use, one coherent stream", async () => {
    const sse = MSG_START + textBlock(0, "Let me check the weather.") + toolBlock(1, "t1", {}) + MSG_END;
    const p = await boot({ headers: { "content-type": "text/event-stream" }, body: sse }, parisFixer);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody() });
    const text = await resp.text();

    expect(text.startsWith(MSG_START)).toBe(true);              // message_start reached the client
    expect(text).toContain("Let me check the weather.");        // leading text preserved verbatim
    const round = reconstructFromSse(text);
    expect(round.content[0]).toEqual({ type: "text", text: "Let me check the weather." });
    const tu = round.content.find(isToolUseBlock);
    expect(tu?.input).toEqual({ city: "Paris" });               // trailing tool_use repaired
    expect(round.content.findIndex(isToolUseBlock)).toBe(1);    // index preserved (still block 1)
    expect(lastLogLine(logFile).repair).toBe("fixed");
  });

  it("passes a pure-text streaming response through byte-for-byte (no buffering)", async () => {
    const sse = MSG_START + textBlock(0, "No tool needed here.") + frame("message_delta", { delta: { stop_reason: "end_turn" } }) + frame("message_stop", {});
    const p = await boot({ headers: { "content-type": "text/event-stream" }, body: sse }, parisFixer);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody() });
    expect(await resp.text()).toBe(sse);                        // zero-touch passthrough
    const rec = lastLogLine(logFile);
    expect(rec.validated).toBe("pass");
    expect(rec.repair).toBe("none");
  });

  it("passes a VALID streaming tool call through byte-for-byte (withheld frames flushed verbatim)", async () => {
    const sse = MSG_START + textBlock(0, "Checking.") + toolBlock(1, "t1", { city: "Rome" }) + MSG_END;
    const p = await boot({ headers: { "content-type": "text/event-stream" }, body: sse }, parisFixer);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody() });
    expect(await resp.text()).toBe(sse);                        // byte-identical, reshaper never invoked
    expect(lastLogLine(logFile).repair).toBe("none");
  });

  it("repairs INTERLEAVED text/tool_use blocks, preserving every block and index", async () => {
    const sse =
      MSG_START + textBlock(0, "First,") + toolBlock(1, "t1", {}) + textBlock(2, "and also") + toolBlock(3, "t2", {}) + MSG_END;
    const p = await boot({ headers: { "content-type": "text/event-stream" }, body: sse }, parisFixer);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody() });
    const round = reconstructFromSse(await resp.text());
    expect(round.content.map((b) => b.type)).toEqual(["text", "tool_use", "text", "tool_use"]);
    expect((round.content[2] as { text: string }).text).toBe("and also");   // interior text preserved
    const tus = round.content.filter(isToolUseBlock);
    expect(tus.map((b) => b.input)).toEqual([{ city: "Paris" }, { city: "Paris" }]);
    expect(lastLogLine(logFile).repair).toBe("fixed");
  });

  it("handles CRLF-delimited SSE frames (repairs across \\r\\n\\r\\n boundaries)", async () => {
    const crlf = (MSG_START + textBlock(0, "Hi") + toolBlock(1, "t1", {}) + MSG_END).replace(/\n\n/g, "\r\n\r\n");
    const p = await boot({ headers: { "content-type": "text/event-stream" }, body: crlf }, parisFixer);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody() });
    const round = reconstructFromSse(await resp.text());
    expect(round.content.find(isToolUseBlock)?.input).toEqual({ city: "Paris" });
    expect(lastLogLine(logFile).repair).toBe("fixed");
  });

  it("preserves multibyte UTF-8 in streamed-through text while repairing the tool", async () => {
    const msg = "Weather in 東京 — brrr ❄️ let me check";
    const sse = MSG_START + textBlock(0, msg) + toolBlock(1, "t1", {}) + MSG_END;
    const p = await boot({ headers: { "content-type": "text/event-stream" }, body: sse }, parisFixer);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody() });
    const text = await resp.text();
    expect(text).toContain(msg);                                // no mojibake from byte-level frame splitting
    expect(reconstructFromSse(text).content.find(isToolUseBlock)?.input).toEqual({ city: "Paris" });
  });

  it("emits a mid-stream SSE error (not a fabricated call) when repair fails after the head is sent", async () => {
    const refuser: Reshaper = { reshape: async () => ({ kind: "refuse", reason: "ambiguous" }) };
    const sse = MSG_START + textBlock(0, "Trying") + toolBlock(1, "t1", {}) + MSG_END;
    const p = await boot({ headers: { "content-type": "text/event-stream" }, body: sse }, refuser);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody() });
    expect(resp.status).toBe(200);                              // head already committed as a 200 stream
    const text = await resp.text();
    expect(text).toContain("Trying");                          // leading text still delivered
    expect(text).toContain("event: error");                    // failure surfaced as an SSE error event
    expect(text).not.toContain('"city"');                      // no fabricated tool input
    expect(lastLogLine(logFile).repair).toBe("refused");
  });
});

describe("OpenAI backend: count_tokens + non-messages paths", () => {
  let backend: Server;
  let proxy: Server;
  afterAll(() => { backend?.close(); proxy?.close(); });

  async function boot(): Promise<number> {
    let backendHits = 0;
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        backendHits++;
        req.on("data", () => {});
        req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    (boot as unknown as { hits: () => number }).hits = () => backendHits;
    const cfg: Config = {
      host: "127.0.0.1", port: 0,
      backend: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", model: "m", authHeader: "authorization", timeoutMs: 5000 },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
    proxy = createProxy(cfg);
    return new Promise((resolve) => proxy.listen(0, "127.0.0.1", () => resolve(port(proxy))));
  }

  it("answers count_tokens locally with an estimate, never touching the backend", async () => {
    const p = await boot();
    const before = (boot as unknown as { hits: () => number }).hits();
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages/count_tokens`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", system: "you are helpful", messages: [{ role: "user", content: "count these characters please" }] }),
    });
    expect(resp.status).toBe(200);
    const j = (await resp.json()) as { input_tokens: number };
    expect(j.input_tokens).toBeGreaterThan(0);
    expect((boot as unknown as { hits: () => number }).hits()).toBe(before); // backend NOT called
  });

  it("returns a clean 404 for a non-messages path instead of mistranslating it", async () => {
    const p = await boot();
    const resp = await fetch(`http://127.0.0.1:${p}/`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(resp.status).toBe(404);
    const j = (await resp.json()) as { error?: { message?: string } };
    expect(j.error?.message).toMatch(/not supported/);
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
      backend: { base: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
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
