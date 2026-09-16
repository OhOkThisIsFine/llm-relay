import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProxy, type ProxyDeps } from "../src/server.js";
import { ModelCatalog, type ModelLimits } from "../src/catalog.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import { makeCredentialId } from "../src/credential-id.js";
import type { Config, ProviderCompatConfig, ProviderConfig } from "../src/config.js";
import type { Reshaper } from "../src/reshaper.js";
import { isToolUseBlock, type AssistantMessage } from "../src/anthropic.js";
import { reconstructFromSse } from "../src/sse.js";
import { reconstruct } from "../src/reshaper.js";
import { allFacts, resetFacts } from "../src/target-facts.js";
import { acceptInterpretation, pendingRefusals, proposeInterpretation, recordUnknownRefusal, refusalSignature, resetInterpretations } from "../src/refusal-interpretation.js";
import {
  SERVED_BY_HEADER,
  POOL_ATTEMPTS_HEADER,
  UNKNOWN_REFUSAL_HEADER,
} from "../src/backend.js";

const breakerIdentity = (provider: string, model: string | null) => ({
  provider,
  model,
  kind: "anthropic" as const,
  credentialId: makeCredentialId(provider),
});

/**
 * Every listener this file opens, closed after each test.
 *
 * HERMETICITY: the describes below reboot a backend + proxy per test into the SAME
 * `let backend` / `let proxy` binding, so an `afterAll` closing those two bindings closed
 * only the LAST pair — every earlier listener stayed bound for the whole run (5 tests in
 * the first describe alone leaked 4 backends and 4 proxies). Register here instead, so a
 * rebooted describe cannot orphan the handle it just overwrote.
 */
const openServers: Server[] = [];
function track<T extends Server>(s: T): T {
  openServers.push(s);
  return s;
}
async function closeTracked(): Promise<void> {
  const servers = openServers.splice(0);
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
}

/**
 * `globalCircuitBreaker` is a module singleton shared by every test in the process.
 *
 * HERMETICITY: only the breaker-accounting describe reset it, so any earlier test that
 * tripped provider "up" (they all use that name) left a cooldown behind, and the order
 * tests happened to run in decided whether a later one saw a healthy target. Reset
 * before AND after every test so neither direction of that leak survives.
 */
beforeEach(() => globalCircuitBreaker.reset());
afterEach(async () => {
  await closeTracked();
  globalCircuitBreaker.reset();
});

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
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(track(s))));
}

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

/**
 * A catalog that cannot read or write the developer's machine.
 *
 * HERMETICITY: `createProxy(cfg)` with no deps builds `new ModelCatalog()`, whose default
 * cache path is `~/.llm-relay/models-cache.json` — and the context guardrail calls
 * `cachedLimits()` on the REQUEST path, so every test here was reading the developer's real
 * cache. A machine that happened to hold limits for the provider/model a test routes to would
 * 400 the request the test expected to reach its mock backend. `cachePath: null` disables the
 * disk entirely; `catalogWithLimits` seeds from a temp file when a test needs real limits.
 */
function hermeticCatalog(): ModelCatalog {
  return new ModelCatalog({ cachePath: null });
}

/** A catalog seeded from a temp cache file — the only way to give `cachedLimits()` data without fetching. */
function catalogWithLimits(dir: string, seed: Record<string, Record<string, Partial<ModelLimits>>>): ModelCatalog {
  const file = join(dir, `cache-${Math.random().toString(36).slice(2)}.json`);
  const entries: Record<string, unknown> = {};
  for (const [provider, models] of Object.entries(seed)) {
    const limits: Record<string, ModelLimits> = {};
    for (const [model, l] of Object.entries(models)) {
      limits[model] = { contextLength: null, maxOutputTokens: null, pricePromptPerToken: null, priceCompletionPerToken: null, rateLimits: null, ...l };
    }
    entries[provider] = { fetchedAt: Date.now(), models: Object.keys(models), limits };
  }
  writeFileSync(file, JSON.stringify(entries));
  return new ModelCatalog({ cachePath: file });
}

/** Boot a proxy with a hermetic catalog unless the test supplies its own. */
function startProxy(cfg: Config, deps: ProxyDeps = {}): Promise<Server> {
  const s = createProxy(cfg, { catalog: hermeticCatalog(), breaker: globalCircuitBreaker, ...deps });
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(track(s))));
}

function lastLogLine(file: string): Record<string, unknown> {
  const lines = readFileSync(file, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!);
}

function allLogText(file: string): string {
  return readFileSync(file, "utf8");
}

const REQUEST_BODY = JSON.stringify({
  model: "mock-model",
  messages: [{ role: "user", content: "weather?" }],
  tools: [
    { name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  ],
});

const OK_BODY = JSON.stringify({
  id: "cmpl_ok",
  object: "chat.completion",
  choices: [{ message: { role: "assistant", content: "served" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 2, completion_tokens: 6 },
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
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(handler: Parameters<typeof mockBackend>[0]): Promise<number> {
    backend = await mockBackend(handler);
    cfg = {
      host: "127.0.0.1",
      port: 0,
      providers: { up: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 } },
      routing: { default: "up", tiers: {} },
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
    expect(rec.validated).toBe("fail"); // known tool, but no executable schema — fail closed
    expect(rec.errorKinds).toContain("schema_uncheckable");
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
    rmSync(dir, { recursive: true, force: true });
  });
  // The key is process-global: a failing assertion between `process.env.X = …` and the
  // `delete` at the end of a test body used to leak it into every later test in the run.
  afterEach(() => {
    delete process.env.RP_TEST_KEY;
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
      s.listen(0, "127.0.0.1", () => resolve(track(s)));
    });
    const cfg: Config = {
      host: "127.0.0.1",
      port: 0,
      providers: {
        up: {
          base: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
          kind: "anthropic",
          authHeader: "x-api-key",
          timeoutMs: 5000,
          ...(authEnv ? { authEnv } : {}),
        },
      },
      routing: { default: "up", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "metadata", file: logFile },
    };
    proxy = await startProxy(cfg);
    return port(proxy);
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

describe("repair mode", () => {
  let dir: string;
  let logFile: string;
  let backend: Server;
  let proxy: Server;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rp-rep-"));
    logFile = join(dir, "log.jsonl");
  });
  afterAll(() => {
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

  async function bootProxy(
    backendBody: { headers: Record<string, string>; body: string },
    reshaper: Reshaper,
    destructiveTools: string[] = [],
    maxAttempts = 2,
  ): Promise<number> {
    backend = await mockBackend(() => backendBody);
    const cfg: Config = {
      host: "127.0.0.1",
      port: 0,
      providers: { up: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 } },
      routing: { default: "up", tiers: {} },
      mode: "repair",
      repair: { maxAttempts, destructiveTools },
      log: { level: "metadata", file: logFile },
    };
    proxy = await startProxy(cfg, { reshaper });
    return port(proxy);
  }

  function reqBody(stream: boolean, tools: object[] = weatherTools): string {
    return JSON.stringify({ model: "m", stream, messages: [{ role: "user", content: "weather?" }], tools });
  }

  it("passes the candidate provider into a catalog-backed dynamic reshaper", async () => {
    const savedKey = process.env.CUSTOM_PROVIDER_API_KEY;
    process.env.CUSTOM_PROVIDER_API_KEY = "sk-dynamic-derived";
    let reshaperAuth: string | undefined;
    const reshaperBackend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        reshaperAuth = req.headers.authorization;
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ inputs: { t1: { city: "Paris" } } }) } }] }));
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(track(s)));
    });
    const frontBackend = await mockBackend(() => ({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "message",
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }],
      }),
    }));
    const reshaperProvider: ProviderConfig = {
      base: `http://127.0.0.1:${port(reshaperBackend)}`,
      kind: "openai",
      authEnv: "CUSTOM_DECLARED_KEY",
      authHeader: "authorization",
      timeoutMs: 5000,
      tierType: "free",
    };
    const catalog = new ModelCatalog({ cachePath: null });
    await catalog.list("custom-provider", reshaperProvider, {
      fetchFn: async () => new Response(JSON.stringify({ data: [{ id: "repair-model" }] }), { status: 200 }),
    });
    const cfg: Config = {
      host: "127.0.0.1",
      port: 0,
      providers: {
        up: {
          base: `http://127.0.0.1:${port(frontBackend)}`,
          kind: "anthropic",
          authHeader: "x-api-key",
          timeoutMs: 5000,
        },
        "custom-provider": reshaperProvider,
      },
      routing: {
        default: "up",
        tiers: {},
        pools: { medium: [] },
        poolPolicies: { medium: { preferred: [], include: "free" } },
      },
      mode: "repair",
      reshaperPool: { name: "medium", timeoutMs: 5000 },
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    };

    try {
      const p = port(await startProxy(cfg, { catalog }));
      const response = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: reqBody(false),
      });
      expect(response.status).toBe(200);
      expect(reshaperAuth).toBe("Bearer sk-dynamic-derived");
      const repaired = (await response.json()) as { content: AssistantMessage["content"] };
      expect(repaired.content.find(isToolUseBlock)?.input).toEqual({ city: "Paris" });
    } finally {
      if (savedKey === undefined) delete process.env.CUSTOM_PROVIDER_API_KEY;
      else process.env.CUSTOM_PROVIDER_API_KEY = savedKey;
    }
  });

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

  /**
   * A repair changes the tool INPUT and nothing else about the response's identity.
   *
   * The buffered path used to rebuild the message from scratch: a constant `id: "msg_repair"`
   * (so every repaired turn in a session was indistinguishable to anything keying off the id,
   * and disagreed with the id the provider would answer questions about), the model the CLIENT
   * asked for rather than the one that answered, and a zero-filled `usage` reporting a token
   * count nobody measured.
   */
  it("carries the backend's own id, model and usage through a buffered repair", async () => {
    const broken = JSON.stringify({
      id: "msg_backend_abc", type: "message", role: "assistant", model: "z-ai/glm-5.2",
      stop_reason: "tool_use", usage: { input_tokens: 91, output_tokens: 7 },
      content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }],
    });
    const p = await bootProxy({ headers: { "content-type": "application/json" }, body: broken }, fixer);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody(false) });
    const j = (await resp.json()) as { id: string; model: string; usage?: unknown; content: unknown[] };

    expect(j.id).toBe("msg_backend_abc");
    expect(j.id).not.toBe("msg_repair");
    expect(j.model).toBe("z-ai/glm-5.2"); // the model that ANSWERED, not the requested "m"
    expect(j.usage).toEqual({ input_tokens: 91, output_tokens: 7 });
    expect((j.content as AssistantMessage["content"]).find(isToolUseBlock)?.input).toEqual({ city: "Paris" });
  });

  /**
   * Same rule the streaming path and the metadata resolver follow: an absent measurement stays
   * absent. `{input_tokens: 0, output_tokens: 0}` is a claim that the call was free, which a
   * consumer metering off the response cannot tell apart from a call that genuinely was.
   */
  it("omits usage rather than zero-filling it when the backend reported none", async () => {
    const broken = JSON.stringify({
      type: "message", role: "assistant", stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }],
    });
    const p = await bootProxy({ headers: { "content-type": "application/json" }, body: broken }, fixer);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody(false) });
    const j = (await resp.json()) as Record<string, unknown>;

    expect(j).not.toHaveProperty("usage");
    // No id to carry: the fallback is the relay-marked synthetic one, never the old constant.
    expect(j.id as string).toMatch(/^msg_relay_/);
  });

  /**
   * `repair.maxAttempts` is parsed, validated and documented in config.ts — and both `repair()`
   * call sites passed a hardcoded 2, so the configured value was ignored on every request.
   */
  it("honours the CONFIGURED repair.maxAttempts instead of a hardcoded 2", async () => {
    let calls = 0;
    // Never actually fixes the call, so repair burns every attempt it is allowed.
    const useless: Reshaper = {
      reshape: async () => {
        calls++;
        return { kind: "message", message: { content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }], stop_reason: "tool_use" } as AssistantMessage };
      },
    };
    const broken = JSON.stringify({ type: "message", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }] });

    const p = await bootProxy({ headers: { "content-type": "application/json" }, body: broken }, useless, [], 3);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody(false) });

    expect(resp.status).toBe(502); // unrepairable → fail-clean
    expect(calls).toBe(3);
  });

  it("fail-closes (502) on a destructive tool call instead of fabricating it", async () => {
    const broken = JSON.stringify({ type: "message", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "delete_file", input: {} }] });
    const delTools = [{ name: "delete_file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
    const p = await bootProxy({ headers: { "content-type": "application/json" }, body: broken }, fixer, ["delete_file"]);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody(false, delTools) });
    expect(resp.status).toBe(502);
    expect(lastLogLine(logFile).repair).toBe("refused_destructive");
  });
});

describe("streaming repair: text-through, buffer-at-tool_use", () => {
  let dir: string;
  let logFile: string;
  let backend: Server;
  let proxy: Server;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rp-m4-"));
    logFile = join(dir, "log.jsonl");
  });
  afterAll(() => {
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
      providers: { up: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 } },
      routing: { default: "up", tiers: {} },
      mode: "repair",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "metadata", file: logFile },
    };
    proxy = await startProxy(cfg, { reshaper });
    return port(proxy);
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
  // Every path the backend was asked for, in order. The previous shape hung a `hits()`
  // closure off the `boot` FUNCTION OBJECT, which made the counter survive between tests
  // and could only answer "how many", never "which path" — and "which path" is the whole
  // invariant: an OpenAI backend has no count_tokens route, so mistranslating one into
  // /chat/completions would spend a real completion and return garbage.
  let seenPaths: string[] = [];

  async function boot(): Promise<number> {
    seenPaths = [];
    const backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        seenPaths.push(req.url ?? "/");
        req.on("data", () => {});
        req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
      });
      s.listen(0, "127.0.0.1", () => resolve(track(s)));
    });
    const cfg: Config = {
      host: "127.0.0.1", port: 0,
      providers: { up: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", authHeader: "authorization", timeoutMs: 5000 } },
      routing: { default: "up/m", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
    return port(await startProxy(cfg));
  }

  it("answers count_tokens locally with an estimate, never touching the backend", async () => {
    const p = await boot();
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages/count_tokens`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", system: "you are helpful", messages: [{ role: "user", content: "count these characters please" }] }),
    });
    expect(resp.status).toBe(200);
    const j = (await resp.json()) as { input_tokens: number };
    expect(j.input_tokens).toBeGreaterThan(0);
    expect(seenPaths).toEqual([]);                       // backend NOT called at all…
    expect(seenPaths).not.toContain("/chat/completions"); // …and specifically never mistranslated
  });

  it.each(["/", "/v1/messages-prefix-lookalike"])(
    "returns a clean 404 for the non-messages path %s instead of mistranslating it",
    async (pathname) => {
      const p = await boot();
      const resp = await fetch(`http://127.0.0.1:${p}${pathname}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      expect(resp.status).toBe(404);
      const j = (await resp.json()) as { error?: { message?: string } };
      expect(j.error?.message).toMatch(/not supported/);
      expect(seenPaths).toEqual([]); // a 404 the proxy answers itself, not one the backend produced
    },
  );

  it("does NOT hijack count_tokens for an ANTHROPIC backend — that one speaks the route", async () => {
    // The local answer exists because an openai backend has no such endpoint. An anthropic
    // target does, and its own count is authoritative; answering locally would substitute an
    // estimate for a real number.
    seenPaths = [];
    const backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        seenPaths.push(req.url ?? "/");
        req.on("data", () => {});
        req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 4242 })); });
      });
      s.listen(0, "127.0.0.1", () => resolve(track(s)));
    });
    const cfg: Config = {
      host: "127.0.0.1", port: 0,
      providers: { up: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 } },
      routing: { default: "up", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
    const p = port(await startProxy(cfg));
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages/count_tokens`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    expect((await resp.json()) as unknown).toEqual({ input_tokens: 4242 }); // the backend's number, not an estimate
    expect(seenPaths).toEqual(["/v1/messages/count_tokens"]);
  });
});

describe("streaming transparency across many chunks", () => {
  let backend: Server;

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
      s.listen(0, "127.0.0.1", () => resolve(track(s)));
    });
    const cfg: Config = {
      host: "127.0.0.1",
      port: 0,
      providers: { up: { base: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 } },
      routing: { default: "up", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
    const p = port(await startProxy(cfg));

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

describe("circuit breaker accounting", () => {
  /** Boot a single-candidate proxy whose only backend answers with `status` and `body`. */
  async function bootStatus(status: number, body: string, contentType = "application/json"): Promise<number> {
    const backend = await mockBackend(() => ({ status, headers: { "content-type": contentType }, body }));
    const cfg: Config = {
      host: "127.0.0.1",
      port: 0,
      providers: { up: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 } },
      routing: { default: "up", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
    return port(await startProxy(cfg));
  }

  it("records a FAILURE when the only candidate returns a retriable error (no false recordSuccess)", async () => {
    // The regression this pins: with no further candidate to fail over to, a 429/5xx used to
    // fall through to recordSuccess, resetting the breaker on every failing response.
    const p = await bootStatus(429, JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: REQUEST_BODY,
    });
    expect(resp.status).toBe(429); // the response itself still passes through untouched

    const state = globalCircuitBreaker.getState(breakerIdentity("up", null));
    expect(state?.consecutiveFailures).toBe(1);
    expect(state?.lastStatus).toBe(429);
    expect(state!.cooldownUntil).toBeGreaterThan(Date.now()); // 429 trips the cooldown immediately
  });

  // The invariant is "EVERY retriable error response, including on the last candidate" — but
  // only 429 was ever exercised, and 429 is the one status with its own immediate-trip branch.
  // A regression that recorded 400/404/5xx as successes would have gone unnoticed.
  for (const status of [400, 404, 500, 502, 503]) {
    it(`records a FAILURE for a last-candidate ${status}, not a success`, async () => {
      const p = await bootStatus(status, JSON.stringify({ type: "error", error: { message: "nope" } }));
      const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: REQUEST_BODY,
      });
      expect(resp.status).toBe(status); // upstream status reaches the client untouched
      const state = globalCircuitBreaker.getState(breakerIdentity("up", null));
      expect(state?.consecutiveFailures).toBe(1);
      expect(state?.lastStatus).toBe(status);
    });
  }

  it("records a SUCCESS for a 2xx, so an occasional error does not permanently demote a live target", async () => {
    const p = await bootStatus(200, JSON.stringify({ type: "message", role: "assistant", stop_reason: "end_turn", content: [] }));
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: REQUEST_BODY,
    });
    expect(resp.status).toBe(200);
    const state = globalCircuitBreaker.getState(breakerIdentity("up", null));
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.cooldownUntil).toBe(0);
  });

  /**
   * A credential fault is not health data.
   *
   * 401/403 are not retriable, so they fell into the else-branch and were recorded as
   * `ok: true`: a revoked or exhausted key cleared `consecutiveFailures` and refreshed the
   * stability score on every request, so the breaker could never trip and the target stayed
   * at the front of the ranking while failing 100% of calls. Recording a FAILURE would be the
   * opposite error — it would open the breaker on a config problem and hide the 401 behind a
   * "target unhealthy" skip. So the breaker is told nothing at all.
   */
  for (const status of [401, 403]) {
    it(`records neither success nor failure for a ${status}, and does not erase prior failures`, async () => {
      globalCircuitBreaker.recordOutcome(breakerIdentity("up", null), { ok: false, status: 500, elapsedMs: 10 });
      expect(globalCircuitBreaker.getState(breakerIdentity("up", null))?.consecutiveFailures).toBe(1);

      const p = await bootStatus(status, JSON.stringify({ type: "error", error: { message: "invalid x-api-key" } }));
      const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: REQUEST_BODY,
      });
      expect(resp.status).toBe(status); // the real error still reaches the client

      const state = globalCircuitBreaker.getState(breakerIdentity("up", null));
      expect(state?.consecutiveFailures).toBe(1); // not reset to 0 by a false success
      expect(state?.lastStatus).toBe(500); // and not overwritten by the auth status
    });
  }

  it("passes a 429 body through verbatim — the client's own backoff owns the retry", async () => {
    const body = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });
    const p = await bootStatus(429, body);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: REQUEST_BODY,
    });
    expect(resp.status).toBe(429);
    expect(await resp.text()).toBe(body); // not swallowed, not rewritten into a 502
  });
});

/**
 * INV: the context guardrail fires ONLY on a limit the SERVING provider published.
 *
 * Nothing pinned this. It reads `catalog.cachedLimits()`, which never fetches, and there must
 * be no invented fallback ceiling — a 400 built from a number the proxy made up rejects a
 * request the backend would have accepted, which is worse than a true upstream error.
 */
describe("context guardrail", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "rp-guard-")); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  /** A backend that records whether it was reached at all. */
  async function bootWithCatalog(catalog: ModelCatalog): Promise<{ p: number; reached: () => number }> {
    let hits = 0;
    const backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        hits++;
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "message", role: "assistant", stop_reason: "end_turn", content: [] }));
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(track(s)));
    });
    const cfg: Config = {
      host: "127.0.0.1", port: 0,
      providers: { up: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 } },
      routing: { default: "up/m", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
    return { p: port(await startProxy(cfg, { catalog })), reached: () => hits };
  }

  const bigBody = (chars: number) =>
    JSON.stringify({ model: "up/m", messages: [{ role: "user", content: "x".repeat(chars) }] });

  it("rejects with 400 when the SERVING provider published a limit the request exceeds", async () => {
    const { p, reached } = await bootWithCatalog(catalogWithLimits(dir, { up: { m: { contextLength: 100 } } }));
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: bigBody(40_000),
    });
    expect(resp.status).toBe(400);
    const j = (await resp.json()) as { error?: { message?: string } };
    // The message must name the provider whose figure it is — that is the whole point of
    // per-(provider, model) limits.
    expect(j.error?.message).toMatch(/"up" publishes for "m"/);
    expect(j.error?.message).toContain("100");
    expect(reached()).toBe(0); // rejected before any upstream spend
  });

  it("lets a request UNDER the published limit through", async () => {
    const { p, reached } = await bootWithCatalog(catalogWithLimits(dir, { up: { m: { contextLength: 100_000 } } }));
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: bigBody(40),
    });
    expect(resp.status).toBe(200);
    expect(reached()).toBe(1);
  });

  it("does NOT guard when the provider published nothing — no invented fallback ceiling", async () => {
    // A hardcoded 128k guess used to live here. An enormous prompt must now reach the backend
    // and get the backend's own authoritative answer.
    const { p, reached } = await bootWithCatalog(hermeticCatalog());
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: bigBody(600_000),
    });
    expect(resp.status).toBe(200);
    expect(reached()).toBe(1);
  });

  it("does NOT borrow ANOTHER provider's figure for the same model id", async () => {
    // Same model id, different deployment: `other` publishes a tiny ceiling, `up` publishes
    // none. Reaching across would 400 a request `up` would have served.
    const { p, reached } = await bootWithCatalog(catalogWithLimits(dir, { other: { m: { contextLength: 10 } } }));
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: bigBody(200_000),
    });
    expect(resp.status).toBe(200);
    expect(reached()).toBe(1);
  });

  it("never FETCHES on the request path — a cold cache degrades to no guardrail, not a round-trip", async () => {
    // `cachedLimits()` is the sync, disk-only reader. If the guardrail ever reached for the
    // fetching `limits()` instead, an unreachable provider would block every request on a
    // network timeout.
    class NoFetchCatalog extends ModelCatalog {
      async limits(): Promise<ModelLimits | null> {
        throw new Error("guardrail must not fetch on the request path");
      }
    }
    const { p, reached } = await bootWithCatalog(new NoFetchCatalog({ cachePath: null }));
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: bigBody(500),
    });
    expect(resp.status).toBe(200);
    expect(reached()).toBe(1);
  });
});

/**
 * INV: logs are metadata only — never a header value, never a body, never any substring of a key.
 *
 * `log.ts` enforces the field allow-list at the sink and `test/log.test.ts` pins that; what had
 * no coverage is the end-to-end claim, driven through a real request carrying real secrets.
 */
describe("logs stay metadata-only end to end", () => {
  let dir: string;
  let logFile: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rp-log-"));
    logFile = join(dir, "log.jsonl");
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const CLIENT_SECRET = "sk-ant-CLIENTSECRET0000";
  const BACKEND_KEY = "sk-backend-BACKENDSECRET0";
  const USER_PROSE = "the quarterly revenue figures are confidential";
  const BACKEND_PROSE = "assistant reply nobody should log";

  it("writes no header value, no request body and no response body — and no substring of either key", async () => {
    process.env.RP_LOG_KEY = BACKEND_KEY;
    try {
      const backend = await mockBackend(() => ({
        headers: { "content-type": "application/json", "x-backend-trace": "trace-value-should-not-be-logged" },
        body: JSON.stringify({ type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: BACKEND_PROSE }] }),
      }));
      const cfg: Config = {
        host: "127.0.0.1", port: 0,
        providers: { up: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000, authEnv: "RP_LOG_KEY" } },
        routing: { default: "up", tiers: {} },
        mode: "detect",
        repair: { maxAttempts: 2, destructiveTools: [] },
        log: { level: "metadata", file: logFile },
      };
      const p = port(await startProxy(cfg));

      const resp = await fetch(`http://127.0.0.1:${p}/v1/messages?task=${encodeURIComponent(USER_PROSE)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${CLIENT_SECRET}`,
          "x-api-key": CLIENT_SECRET,
          "x-custom-tracking": "tracking-value-should-not-be-logged",
        },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: USER_PROSE }] }),
      });
      expect(resp.status).toBe(200);

      const written = allLogText(logFile);
      expect(written.length).toBeGreaterThan(0); // something WAS logged — otherwise this proves nothing
      for (const forbidden of [
        CLIENT_SECRET, BACKEND_KEY,
        // Substrings too: a truncated or prefixed key is still a key.
        CLIENT_SECRET.slice(0, 12), BACKEND_KEY.slice(0, 12),
        USER_PROSE, BACKEND_PROSE,
        // Percent-encoded and word-level too: a raw `?task=` written into the log leaks the
        // prose in escaped form, which a whole-phrase match would sail straight past.
        encodeURIComponent(USER_PROSE), "quarterly", "confidential",
        "trace-value-should-not-be-logged", "tracking-value-should-not-be-logged",
        "Bearer",
      ]) {
        expect(written).not.toContain(forbidden);
      }
      // The metadata itself did survive — this is a metadata logger, not a silent one.
      const rec = lastLogLine(logFile);
      expect(rec.path).toBe("/v1/messages?task=<46c>"); // route + parameter NAME + value LENGTH
      expect(rec.backendStatus).toBe(200);
    } finally {
      delete process.env.RP_LOG_KEY;
    }
  });
});

/**
 * A custom Reshaper that starts an accounting attempt and DROPS the returned handle violates
 * the startRepair contract documented on ReshaperAccountingHooks / RequestAccountingState.
 * Without the sweep, that request never records `request-completed`; with it, finalization
 * happens at response finish and records error/unknown — the only honest statement about an
 * abandoned egress nobody observed ending. A REAL repair still in flight at "close" time is
 * deliberately NOT swept: its own cancelled/aborted completion lands within ticks.
 */
describe("repair accounting: dropped attempt handle", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rp-drop-"));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("sweeps a still-active repair attempt at finish so the request still finalizes", async () => {
    const backend = await mockBackend(() => ({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "message", role: "assistant", stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }],
      }),
    }));
    // Starts an accounting attempt through the real hooks, then drops the handle —
    // exactly the contract violation the sweep exists to contain.
    const dropper: Reshaper = {
      reshape: async (_req, hooks) => {
        hooks?.startRepairAttempt({
          resolvedAttempt: null,
          credentialState: "declared-present",
          provider: "up",
          model: "mock-model",
          credentialId: "up#default",
          startedAt: Date.now(),
        });
        return {
          kind: "message",
          message: { content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }], stop_reason: "tool_use" } as AssistantMessage,
        };
      },
    };
    const events: Array<Record<string, unknown>> = [];
    const recorder = { record: (event: unknown): void => { events.push(event as Record<string, unknown>); } };
    const cfg: Config = {
      host: "127.0.0.1", port: 0,
      providers: { up: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 } },
      routing: { default: "up", tiers: {} },
      mode: "repair",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
    const proxy = await startProxy(cfg, { reshaper: dropper, accountingRecorder: recorder });
    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: false, messages: [{ role: "user", content: "weather?" }], tools: weatherToolsForDropTest() }),
    });
    // Repair succeeded client-side; only accounting was affected by the dropped handle.
    expect(resp.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const types = events.map((event) => event["type"]);
    expect(types).toContain("request-completed");
    expect(events.find((event) => event["type"] === "attempt-completed" && event["role"] === "repair")).toMatchObject({
      outcome: "error",
      failureKind: "unknown",
    });
    // The serve attempt really succeeded, so the sweep did not relabel the turn itself.
    expect(events.find((event) => event["type"] === "request-completed")).toMatchObject({ outcome: "success" });
  });
});

/** Kept local so the new describe cannot drift from the shared fixtures above it. */
function weatherToolsForDropTest(): object[] {
  return [
    { name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  ];
}

/**
 * The streaming half of the id-minting pass, end to end.
 *
 * A stream cannot carry `x-llm-relay-tool-use-ids` — the headers are written long before the
 * first `content_block_start` exists — so the honest surface there is the metadata-only log
 * counter, written after the stream drains. This drives a real request through the proxy to pin
 * both: the client's SSE carries the minted id, and the log line carries the COUNT (never an id).
 */
describe("tool_use id minting on the streamed Messages front", () => {
  let dir: string;
  let logFile: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rp-toolid-"));
    logFile = join(dir, "log.jsonl");
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("rewrites a repeated streamed id and reports the count in the log, not in a header", async () => {
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "cmpl", model: "kimi", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const backend = await mockBackend(() => ({
      headers: { "content-type": "text/event-stream" },
      body: [
        chunk({ role: "assistant" }),
        chunk({ tool_calls: [{ index: 0, id: "Read:0", function: { name: "Read", arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"file":"README.md"}' } }] }),
        chunk({}, "tool_calls"),
        "data: [DONE]\n\n",
      ].join(""),
    }));
    const cfg: Config = {
      host: "127.0.0.1", port: 0,
      providers: { kimi: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", authHeader: "authorization", timeoutMs: 5000 } },
      routing: { default: "kimi/moonshotai-kimi-k3", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "metadata", file: logFile },
    };
    const p = port(await startProxy(cfg));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "kimi/moonshotai-kimi-k3",
        stream: true,
        max_tokens: 64,
        messages: [
          { role: "user", content: "read package.json" },
          { role: "assistant", content: [{ type: "tool_use", id: "Read:0", name: "Read", input: { file: "package.json" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "Read:0", content: "{}" }] },
          { role: "user", content: "now read README.md" },
        ],
        tools: [{ name: "Read", input_schema: { type: "object", properties: { file: { type: "string" } } } }],
      }),
    });
    const sse = await resp.text();

    expect(resp.status).toBe(200);
    expect(sse).toContain('"id":"Read:0_relay1"');
    expect(sse).not.toContain('"id":"Read:0"');
    // Headers precede the first tool call, so nothing is claimed there.
    expect(resp.headers.get("x-llm-relay-tool-use-ids")).toBeNull();

    const rec = lastLogLine(logFile);
    expect(rec["toolUseIdRewrites"]).toBe(1);
    expect(JSON.stringify(rec)).not.toContain("Read:0");
  });
});

/**
 * The OpenAI front's TRANSLATED lane inherits the mint (it runs through `fetchBackend`), so it
 * owes the same two announcements. This is the operator's codex→kimi offload shape: a
 * `/v1/responses` turn resolved to an openai-kind target. Before this test the served log record
 * on this front was the one site that did not carry the counter — a Codex lane reported the mint
 * only when the stream FAILED.
 */
describe("tool_use id minting on the OpenAI Responses front", () => {
  let dir: string;
  let logFile: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rp-toolid-front-"));
    logFile = join(dir, "log.jsonl");
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("mints a colliding id, announces it in the header and counts it in the served log line", async () => {
    const backend = await mockBackend(() => ({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "cmpl_1",
        model: "kimi",
        choices: [{
          finish_reason: "tool_calls",
          message: { role: "assistant", content: null, tool_calls: [{ id: "Read:0", function: { name: "Read", arguments: '{"file":"README.md"}' } }] },
        }],
      }),
    }));
    const cfg: Config = {
      host: "127.0.0.1", port: 0,
      providers: { kimi: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", authHeader: "authorization", timeoutMs: 5000 } },
      routing: { default: "kimi/moonshotai-kimi-k3", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "metadata", file: logFile },
    };
    const p = port(await startProxy(cfg));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "kimi/moonshotai-kimi-k3",
        max_output_tokens: 64,
        input: [
          { role: "user", content: [{ type: "input_text", text: "read package.json" }] },
          { type: "function_call", call_id: "Read:0", name: "Read", arguments: '{"file":"package.json"}' },
          { type: "function_call_output", call_id: "Read:0", output: "{}" },
          { role: "user", content: [{ type: "input_text", text: "now read README.md" }] },
        ],
        tools: [{ type: "function", name: "Read", parameters: { type: "object", properties: { file: { type: "string" } } } }],
      }),
    });
    const out = await resp.text();

    expect(resp.status).toBe(200);
    expect(out).toContain("Read:0_relay1");
    expect(resp.headers.get("x-llm-relay-tool-use-ids")).toBe("1 rewritten");

    const rec = lastLogLine(logFile);
    expect(rec["path"]).toBe("/v1/responses");
    expect(rec["toolUseIdRewrites"]).toBe(1);
    expect(JSON.stringify(rec)).not.toContain("Read:0");
  });
});

/**
 * The REQUEST-direction sibling, end to end on both fronts: outbound tool-call ids rewritten to
 * the shape the serving provider's own validator states.
 *
 * mistral-medium-2505 answers HTTP 400 `invalid_function_call` (code 3280) — "Tool call id was
 * toolu_01AAAAAAAAAAAAAAAAAAAAAA but must be a-z, A-Z, 0-9, with a length of 9" — for every id
 * shape this relay forwards. Unlike the response-direction mint the count is final BEFORE egress,
 * so a stream can announce it in a header honestly; the log counter is pinned alongside it.
 */
describe("outbound tool-call id rewriting (compat.toolCallIds strict9)", () => {
  let dir: string;
  let logFile: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rp-toolcallid-"));
    logFile = join(dir, "log.jsonl");
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const BUFFERED = JSON.stringify({
    id: "cmpl_1",
    model: "mistral-medium-2505",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
  });

  // Typed against the REAL config shapes: `compat` is the field under test, so casting the fixture
  // would exempt exactly the surface these tests exist to hold still.
  function cfgFor(backendPort: number, compat?: ProviderCompatConfig): Config {
    return {
      host: "127.0.0.1", port: 0,
      providers: {
        mistral: {
          base: `http://127.0.0.1:${backendPort}`, kind: "openai", authHeader: "authorization", timeoutMs: 5000,
          ...(compat !== undefined ? { compat } : {}),
        },
      },
      routing: { default: "mistral/mistral-medium-2505", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "metadata", file: logFile },
    };
  }

  const CONVERSATION = [
    { role: "user", content: "read it" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_01AAAAAAAAAAAAAAAAAAAAAA", name: "Read", input: { file: "a" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01AAAAAAAAAAAAAAAAAAAAAA", content: "ok" }] },
  ];

  it("announces in a header and counts in the log on the Messages front", async () => {
    let seen: any = null;
    const backend = await mockBackend((_path, raw) => {
      seen = JSON.parse(raw);
      return { headers: { "content-type": "application/json" }, body: BUFFERED };
    });
    const p = port(await startProxy(cfgFor(port(backend), { toolCallIds: "strict9" })));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "mistral/mistral-medium-2505", max_tokens: 64, messages: CONVERSATION,
        tools: [{ name: "Read", input_schema: { type: "object", properties: { file: { type: "string" } } } }],
      }),
    });
    await resp.text();

    expect(resp.status).toBe(200);
    expect(seen.messages[1].tool_calls[0].id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(resp.headers.get("x-llm-relay-tool-call-ids")).toBe("1 rewritten");
    const rec = lastLogLine(logFile);
    expect(rec["toolCallIdRewrites"]).toBe(1);
    // A COUNT, never an id — neither the caller's nor the one the relay produced.
    expect(JSON.stringify(rec)).not.toContain("toolu_01");
  });

  /** The Codex shape: a `function_call` and the `function_call_output` that answers it. */
  const RESPONSES_INPUT = [
    { role: "user", content: [{ type: "input_text", text: "read it" }] },
    { type: "function_call", call_id: "call_abc123", name: "Read", arguments: '{"file":"a"}' },
    { type: "function_call_output", call_id: "call_abc123", output: "ok" },
  ];
  const RESPONSES_TOOLS = [
    { type: "function", name: "Read", parameters: { type: "object", properties: { file: { type: "string" } } } },
  ];

  it("rewrites BOTH halves of the pair through the Responses front's two mappers", async () => {
    // ⚠ Two mappers chain here — `responses-request.ts` (Responses → Anthropic) then
    // `openai-request.ts` (Anthropic → Chat) — which is exactly where pair LINKAGE can break
    // while the count still reads 1. Asserting only the header would pass a regression that
    // rewrote the assistant id and left the answering `tool_call_id` behind, so the outbound
    // bytes are read here.
    let seen: any = null;
    const backend = await mockBackend((_path, raw) => {
      seen = JSON.parse(raw);
      return { headers: { "content-type": "application/json" }, body: BUFFERED };
    });
    const p = port(await startProxy(cfgFor(port(backend), { toolCallIds: "strict9" })));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mistral/mistral-medium-2505",
        max_output_tokens: 64,
        input: RESPONSES_INPUT,
        tools: RESPONSES_TOOLS,
      }),
    });
    await resp.text();

    expect(resp.status).toBe(200);
    const assistant = seen.messages.find((m: any) => m.role === "assistant");
    const tool = seen.messages.find((m: any) => m.role === "tool");
    expect(assistant.tool_calls[0].id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(tool.tool_call_id).toMatch(/^[a-zA-Z0-9]{9}$/);
    // The linkage IS the id — mistral-common v13 rejects a tool message answering an id no prior
    // `tool_calls` entry carries.
    expect(tool.tool_call_id).toBe(assistant.tool_calls[0].id);
    expect(JSON.stringify(seen)).not.toContain("call_abc123");
    // The Responses front re-enters `fetchBackend`, so it inherits the rewrite — and rebuilding
    // its response must not swallow the announcement.
    expect(resp.headers.get("x-llm-relay-tool-call-ids")).toBe("1 rewritten");
    const rec = lastLogLine(logFile);
    expect(rec["path"]).toBe("/v1/responses");
    expect(rec["toolCallIdRewrites"]).toBe(1);
  });

  it("carries the announcement across the STREAMED Responses rebuild — the shape Codex actually sends", async () => {
    // ⚠ The streamed rebuild is a SEPARATE `new Response(…)` from the buffered one, and every
    // other test on this front uses a non-streamed backend — so the branch that forwards the
    // header onto a translated SSE stream had no coverage at all, on the one path every real
    // Codex turn takes.
    let seen: any = null;
    const backend = await mockBackend((_path, raw) => {
      seen = JSON.parse(raw);
      return {
        headers: { "content-type": "text/event-stream" },
        body: [
          'data: {"id":"c","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
          'data: {"id":"c","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\n',
          'data: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
      };
    });
    const p = port(await startProxy(cfgFor(port(backend), { toolCallIds: "strict9" })));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mistral/mistral-medium-2505",
        max_output_tokens: 64,
        stream: true,
        input: RESPONSES_INPUT,
        tools: RESPONSES_TOOLS,
      }),
    });
    const sse = await resp.text();

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    expect(sse).toContain("done");
    // The count is a REQUEST fact, final before a byte was sent, so a stream can announce it
    // honestly — unlike the response-direction mint, whose header precedes its own evidence.
    expect(resp.headers.get("x-llm-relay-tool-call-ids")).toBe("1 rewritten");
    // …and the rewrite really did happen on the wire, on both halves of the pair.
    const assistant = seen.messages.find((m: any) => m.role === "assistant");
    expect(assistant.tool_calls[0].id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(seen.messages.find((m: any) => m.role === "tool").tool_call_id).toBe(assistant.tool_calls[0].id);
    const rec = lastLogLine(logFile);
    expect(rec["path"]).toBe("/v1/responses");
    expect(rec["toolCallIdRewrites"]).toBe(1);
  });

  it("says nothing at all for a provider that states no such rule", async () => {
    let seen: any = null;
    const backend = await mockBackend((_path, raw) => {
      seen = JSON.parse(raw);
      return { headers: { "content-type": "application/json" }, body: BUFFERED };
    });
    const p = port(await startProxy(cfgFor(port(backend))));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "mistral/mistral-medium-2505", max_tokens: 64, messages: CONVERSATION }),
    });
    await resp.text();

    expect(seen.messages[1].tool_calls[0].id).toBe("toolu_01AAAAAAAAAAAAAAAAAAAAAA");
    expect(resp.headers.get("x-llm-relay-tool-call-ids")).toBeNull();
    expect(Object.keys(lastLogLine(logFile))).not.toContain("toolCallIdRewrites");
  });
});

/**
 * The gemini thought-signature sentinel end to end (`compat.thoughtSignature: "sentinel"`).
 *
 * `models/gemini-3.6-flash` on generativelanguage.googleapis.com answers HTTP 400 — "Function call
 * is missing a thought_signature in functionCall parts…" — to a replayed assistant `tool_calls`
 * turn. Google's documented escape is the raw string `skip_thought_signature_validator` at
 * `tool_calls[N].extra_content.google.thought_signature`, verified accepted against the live
 * endpoint on 2026-08-23 for a single call and for both entries of a parallel pair.
 *
 * ⚠ Deliberately NO response header: this pass adds vendor-protocol padding to the relay's own
 * outbound shape rather than altering the caller's data, so the log counter is the whole
 * announcement. Both facts are pinned below.
 */
describe("gemini thought-signature sentinel (compat.thoughtSignature)", () => {
  let dir: string;
  let logFile: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rp-thoughtsig-"));
    logFile = join(dir, "log.jsonl");
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const BUFFERED = JSON.stringify({
    id: "cmpl_1",
    model: "models/gemini-3.6-flash",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
  });

  // Typed against the REAL config shapes — same reason as the sibling describe above.
  function cfgFor(backendPort: number, compat?: ProviderCompatConfig): Config {
    return {
      host: "127.0.0.1", port: 0,
      providers: {
        gemini: {
          base: `http://127.0.0.1:${backendPort}`, kind: "openai", authHeader: "authorization", timeoutMs: 5000,
          ...(compat !== undefined ? { compat } : {}),
        },
      },
      routing: { default: "gemini/models/gemini-3.6-flash", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "metadata", file: logFile },
    };
  }

  /** Two parallel calls in one assistant turn — the every-entry placement the live check verified. */
  const CONVERSATION = [
    { role: "user", content: "weather in Paris and Berlin?" },
    { role: "assistant", content: [
      { type: "tool_use", id: "toolu_01A", name: "get_weather", input: { city: "Paris" } },
      { type: "tool_use", id: "toolu_01B", name: "get_weather", input: { city: "Berlin" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_01A", content: "22C sunny" },
      { type: "tool_result", tool_use_id: "toolu_01B", content: "15C rain" },
    ] },
  ];

  it("stamps every replayed tool call and counts it in the log, with NO response header", async () => {
    let seen: any = null;
    const backend = await mockBackend((_path, raw) => {
      seen = JSON.parse(raw);
      return { headers: { "content-type": "application/json" }, body: BUFFERED };
    });
    const p = port(await startProxy(cfgFor(port(backend), { thoughtSignature: "sentinel" })));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "gemini/models/gemini-3.6-flash", max_tokens: 64, messages: CONVERSATION,
        tools: [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      }),
    });
    await resp.text();

    expect(resp.status).toBe(200);
    const calls = seen.messages[1].tool_calls;
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.extra_content).toEqual({ google: { thought_signature: "skip_thought_signature_validator" } });
    }
    // The ids the caller wrote are untouched — this pass adds a sibling field and nothing else.
    expect(calls.map((c: any) => c.id)).toEqual(["toolu_01A", "toolu_01B"]);
    expect(lastLogLine(logFile)["thoughtSignatureSentinels"]).toBe(2);
  });

  it("says nothing at all for a provider that states no such rule", async () => {
    let seen: any = null;
    const backend = await mockBackend((_path, raw) => {
      seen = JSON.parse(raw);
      return { headers: { "content-type": "application/json" }, body: BUFFERED };
    });
    const p = port(await startProxy(cfgFor(port(backend))));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "gemini/models/gemini-3.6-flash", max_tokens: 64, messages: CONVERSATION }),
    });
    await resp.text();

    // A loopback base host is not generativelanguage.googleapis.com, so the labelled default is
    // "none" and the outbound bytes carry no padding whatsoever.
    expect(JSON.stringify(seen)).not.toContain("thought_signature");
    expect(Object.keys(lastLogLine(logFile))).not.toContain("thoughtSignatureSentinels");
  });
});

/**
 * The wiring `observeEligibility` owes `recordFact`: the rung `resolveReset` selected must land on
 * the stored row as `untilBasis`, so the availability producer's reviewed-rule rung can read a
 * reset's provenance off the fact rather than re-deriving it from vendor prose in the read path.
 * Pure-function coverage for that already lives beside the store
 * (`test/target-facts.test.ts` "persists the reset's provenance"); this is the request-path half —
 * body reaches the wire, response is a refusal, and the fact the walk records is the readback.
 *
 * Hermetic note: the eligibility stores are process-global, so each test resets them on BOTH sides
 * of the assertion (`beforeEach` + `afterEach`); `allFacts()` uses the redirected vitest default
 * path, so no `~/.llm-relay/target-facts.json` is ever touched.
 */
describe("eligibility → untilBasis wiring", () => {
  beforeEach(() => {
    resetFacts();
    resetInterpretations();
  });
  afterEach(() => {
    resetFacts();
    resetInterpretations();
  });

  /**
   * Run one refusal through a single-candidate proxy and return the fact it recorded. The backend
   * status/body are parameterized so each case drives `resolveReset` to a different rung; the
   * routing spec is "up/m" (not bare "up") because `observeEligibility` declines a target with no
   * model — the embodied-unit gotcha, not a property under test.
   */
  async function refusalFact(
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<{ kind: string; untilBasis: string | undefined; until: number }> {
    const backend = await mockBackend(() => ({
      status,
      headers: { "content-type": "application/json", ...headers },
      body,
    }));
    const cfg: Config = {
      host: "127.0.0.1", port: 0,
      providers: { up: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 } },
      routing: { default: "up/m", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 1, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
    const p = port(await startProxy(cfg));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: REQUEST_BODY,
    });
    expect(resp.status).toBe(status);

    const facts = allFacts();
    expect(facts.length).toBeGreaterThan(0);
    const fact = facts.find((f) => f.scope.kind === "credential" && f.scope.provider === "up");
    expect(fact).toBeDefined();
    return { kind: fact!.kind, untilBasis: fact!.untilBasis, until: fact!.until };
  }

  it("labels a Retry-After-derived expiry 'retry-after'", async () => {
    // The rung-1 case: the response states the cooldown in its header, the strongest evidence
    // `resolveReset` can have. The seed account-scope rate-limit wording is what makes a 429
    // produce a fact at all (an ordinary 429 is the breaker's per-target business).
    const fact = await refusalFact(
      429,
      JSON.stringify({ error: { message: "rate limit for your account exceeded" } }),
      { "retry-after": "30" },
    );
    expect(fact.kind).toBe("rate-limited");
    expect(fact.untilBasis).toBe("retry-after");
    expect(fact.until).toBeGreaterThan(Date.now() + 29_000);
  });

  it("labels a body-stated expiry 'stated-body' when no header or field resolves", async () => {
    // Same seed, no Retry-After, but the body carries a JSON retry_after — the generic parse
    // (`parseStatedResetMs`) is `resolveReset`'s rung 3, above a reviewed fixed window and below
    // anything a header or reviewed field said.
    const fact = await refusalFact(
      429,
      JSON.stringify({ error: { message: "rate limit for your account exceeded", retry_after: 45 } }),
    );
    expect(fact.kind).toBe("rate-limited");
    expect(fact.untilBasis).toBe("stated-body");
    expect(fact.until).toBeGreaterThan(Date.now() + 44_000);
  });

  it("labels a reviewed-field reset 'reviewed-field' when the rule fires on this response", async () => {
    // The reviewer-recorded path: an interpretation carrying a `field` rule, so the reset is read
    // from THIS response at a place only a reviewer knew to look (google.rpc.RetryInfo's shape).
    const body = JSON.stringify({ error: { message: "quota exhausted, retry tomorrow", retryDelay: "120s" } });
    const signature = refusalSignature("up", "m", 429, body);
    recordUnknownRefusal("up", "m", 429, body);
    proposeInterpretation(signature, {
      class: "allowance-exhausted",
      scope: { kind: "credential" },
      rationale: "test fixture",
      reset: { kind: "field", field: "retryDelay" },
    });
    expect(acceptInterpretation(signature)).toBe(true);

    const fact = await refusalFact(429, body);
    expect(fact.kind).toBe("allowance-exhausted");
    expect(fact.untilBasis).toBe("reviewed-field");
    expect(fact.until).toBeGreaterThan(Date.now() + 119_000);
  });

  it("labels a reviewed-fixed reset 'reviewed-fixed' when the response says nothing itself", async () => {
    // The lowest reviewed rung: a fixed reviewer's window, which only binds because the body
    // genuinely said nothing about duration — no header, no field rule firing, no stated-body parse.
    const body = JSON.stringify({ error: { message: "quota exhausted, no timing stated" } });
    const signature = refusalSignature("up", "m", 429, body);
    recordUnknownRefusal("up", "m", 429, body);
    proposeInterpretation(signature, {
      class: "allowance-exhausted",
      scope: { kind: "credential" },
      rationale: "test fixture",
      reset: { kind: "fixed", ms: 90_000 },
    });
    expect(acceptInterpretation(signature)).toBe(true);

    const fact = await refusalFact(429, body);
    expect(fact.kind).toBe("allowance-exhausted");
    expect(fact.untilBasis).toBe("reviewed-fixed");
    expect(fact.until).toBeGreaterThan(Date.now() + 89_000);
  });

  it("leaves the kind's default TTL unattributed when nothing resolves the reset", async () => {
    // No header, no stated body, no reviewed rule: `resolveReset` returns null, `recordFact` is
    // called without `untilBasis`, and the fact inherits the kind's default TTL (2m for
    // rate-limited). Absence must stay absence — never a guessed basis.
    const fact = await refusalFact(
      429,
      JSON.stringify({ error: { message: "rate limit for your account exceeded" } }),
    );
    expect(fact.kind).toBe("rate-limited");
    expect(fact.untilBasis).toBeUndefined();
    expect(fact.until).toBeGreaterThan(Date.now() + 100_000);
    expect(fact.until).toBeLessThan(Date.now() + 150_000);
  });
});

/**
 * The backlog property: "the model catalog refreshes on a clock, not on evidence that it is
 * stale" — a 404 stating that a model this catalog LISTS does not exist re-fetches that provider's
 * roster at once, bounded so a burst costs one refresh.
 *
 * The CATALOG's half of this (the re-fetch, the cooldown, fail-open) is pinned in
 * `test/catalog.test.ts`. What is pinned HERE is the half that decides WHETHER to call it: which
 * refusals qualify, and the containment "on a model the catalog currently lists".
 *
 * Hermeticity: the mock backend serves BOTH the refusal (any path) and the `/models` roster, so a
 * refresh is a real HTTP round-trip to a loopback listener this file owns and counts. `up` must be
 * `kind: "openai"` for the catalog to have a roster at all — an anthropic-kind provider's `fetch`
 * returns an empty list by construction, and a test built on one would assert "no refresh" for a
 * reason that has nothing to do with what it means to test.
 */
describe("catalog staleness trigger on a stated model absence", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "rp-catstale-")); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => {
    resetFacts();
    resetInterpretations();
  });
  afterEach(() => {
    resetFacts();
    resetInterpretations();
  });

  /**
   * Boot a backend that answers `/models` with `roster` and every other path with `refusal`, then a
   * proxy routing `up/m` at it. Returns the proxy port and a counter for `/models` hits — the
   * observable the property is stated in.
   */
  async function bootStale(
    refusal: { status: number; body: string },
    roster: string[],
  ): Promise<{ p: number; modelsHits: () => number }> {
    let hits = 0;
    const backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          if ((req.url ?? "").endsWith("/models")) {
            hits++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ data: roster.map((id) => ({ id })) }));
            return;
          }
          res.writeHead(refusal.status, { "content-type": "application/json" });
          res.end(refusal.body);
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(track(s)));
    });
    const base = `http://127.0.0.1:${port(backend)}`;
    // `catalogWithLimits` seeds `models` from the seed's key list, so the roster the relay holds is
    // exactly `roster` without any fetch having to succeed first.
    const catalog = catalogWithLimits(dir, { up: Object.fromEntries(roster.map((m) => [m, {}])) });
    const cfg: Config = {
      host: "127.0.0.1", port: 0,
      providers: { up: { base, kind: "openai", authHeader: "authorization", timeoutMs: 5000 } },
      routing: { default: "up/m", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 1, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
    return { p: port(await startProxy(cfg, { catalog })), modelsHits: () => hits };
  }

  const body = (model: string) =>
    JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] });

  it("re-fetches the provider's roster when a 404 states a LISTED model does not exist", async () => {
    const { p, modelsHits } = await bootStale(
      { status: 404, body: JSON.stringify({ error: { message: "The requested model 'm' does not exist." } }) },
      ["m", "other"],
    );
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: body("up/m"),
    });
    expect(resp.status).toBe(404);
    // The refresh is fire-and-forget, so let its round-trip settle before reading the counter.
    await new Promise((r) => setTimeout(r, 50));
    expect(modelsHits()).toBe(1);
  });

  it("costs ONE re-fetch for a burst of such refusals inside the cooldown", async () => {
    const { p, modelsHits } = await bootStale(
      { status: 404, body: JSON.stringify({ error: { message: "model_not_found" } }) },
      ["m"],
    );
    for (let i = 0; i < 4; i++) {
      const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: body("up/m"),
      });
      expect(resp.status).toBe(404);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(modelsHits()).toBe(1);
  });

  it("does NOT re-fetch for a 404 on a model the catalog does not list", async () => {
    // Containment, not classification: the wording and status qualify, but the provider never
    // claimed to serve this model, so no roster has been contradicted. A caller naming a typo must
    // not be able to drive a provider's `/models` endpoint.
    const { p, modelsHits } = await bootStale(
      { status: 404, body: JSON.stringify({ error: { message: "The requested model 'nope' does not exist." } }) },
      ["m"],
    );
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: body("up/nope"),
    });
    expect(resp.status).toBe(404);
    await new Promise((r) => setTimeout(r, 50));
    expect(modelsHits()).toBe(0);
  });

  it("does NOT re-fetch for a 429, a 401/403, or a 5xx — none of them says a model is gone", async () => {
    // The negative controls the property is stated against.
    //
    // ⚠ EVERY body here carries model-absence WORDING on purpose. A control whose message could not
    // match the pattern anyway proves nothing about the status gate — it passes with the gate
    // removed, which is exactly what a first draft of these tests did. Putting the same wording on
    // statuses that are not a 404 isolates the one thing under test: that the STATUS is what makes
    // a model's absence evidence about a roster, and the phrase alone is not.
    const absence = "the requested model does not exist";
    const cases: Array<{ status: number; message: string }> = [
      { status: 429, message: `rate limit reached: ${absence}` },
      { status: 403, message: `invalid api key: ${absence}` },
      { status: 400, message: `invalid request: ${absence}` },
      { status: 500, message: `upstream error: ${absence}` },
    ];
    for (const c of cases) {
      const { p, modelsHits } = await bootStale(
        { status: c.status, body: JSON.stringify({ error: { message: c.message } }) },
        ["m"],
      );
      const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: body("up/m"),
      });
      expect(resp.status, `status ${c.status}`).toBe(c.status);
      await new Promise((r) => setTimeout(r, 30));
      expect(modelsHits(), `status ${c.status}`).toBe(0);
    }
  });

  it("does NOT re-fetch when a LISTED model's 404 states something else entirely", async () => {
    // A 404 with wording outside the absence family — a wrong path, a policy refusal, a provider
    // quirk. The status alone is not the signal; the provider must STATE the model is gone.
    const { p, modelsHits } = await bootStale(
      { status: 404, body: JSON.stringify({ error: { message: "the requested endpoint is not available on this plan" } }) },
      ["m"],
    );
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: body("up/m"),
    });
    expect(resp.status).toBe(404);
    await new Promise((r) => setTimeout(r, 50));
    expect(modelsHits()).toBe(0);
  });
});

/**
 * Regression: observeEligibility called twice for terminal buffered 4xx on Anthropic front.
 *
 * The bug: a terminal buffered 4xx (single-candidate walk, or the last candidate's response)
 * went through `inspectCandidateResponse` (which calls `observeEligibility`) AND then
 * `transparentPath` (which ALSO called `observeEligibility`). This doubled the signature's
 * occurrence count in the refusal-interpretation queue.
 *
 * The fix: `transparentPath` no longer calls `observeEligibility` — it was already observed
 * in `inspectCandidateResponse`. The OpenAI front never had this bug; this test pins the
 * Anthropic front's behaviour to match.
 */
describe("observeEligibility — no double-count on terminal buffered 4xx (Anthropic front)", () => {
  beforeEach(() => {
    resetFacts();
    resetInterpretations();
  });
  afterEach(() => {
    resetFacts();
    resetInterpretations();
  });

  // The observable is the unknown-refusal QUEUE's occurrence count. The fact store cannot see
  // this bug: recordFact keys by <kind>:<scope>, so a double observation lands on the same row
  // and the store looks identical either way — the first version of this test asserted facts
  // and passed on the UN-FIXED tree. pendingRefusals().count is what actually doubled.
  const UNSEEN_REFUSAL = JSON.stringify({ error: { message: "the flux capacitor declined this request" } });

  it("counts a terminal buffered 4xx exactly once in the unknown queue (single candidate, Anthropic front)", async () => {
    const backend = await mockBackend(() => ({
      status: 403,
      headers: { "content-type": "application/json" },
      body: UNSEEN_REFUSAL,
    }));
    const cfg: Config = {
      host: "127.0.0.1", port: 0,
      providers: { up: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 } },
      routing: { default: "up/m", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 1, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
    const p = port(await startProxy(cfg));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: REQUEST_BODY,
    });
    expect(resp.status).toBe(403);

    // Exactly one queue entry for this signature, seen exactly ONCE. The un-fixed tree
    // observed the terminal response in inspectCandidateResponse AND again in
    // transparentPath, so count was 2 here.
    const queue = pendingRefusals().filter((r) => r.provider === "up");
    expect(queue.length).toBe(1);
    expect(queue[0]?.count).toBe(1);
  });

  it("counts a mid-walk 4xx exactly once when failover succeeds (2 candidates, Anthropic front)", async () => {
    const ANTHROPIC_OK = JSON.stringify({
      id: "msg_ok", type: "message", role: "assistant", model: "m2",
      stop_reason: "end_turn", content: [{ type: "text", text: "served" }],
      usage: { input_tokens: 2, output_tokens: 6 },
    });
    const first = await mockBackend(() => ({ status: 403, headers: { "content-type": "application/json" }, body: UNSEEN_REFUSAL }));
    const second = await mockBackend(() => ({ headers: { "content-type": "application/json" }, body: ANTHROPIC_OK }));
    const p = port(await startProxy({
      host: "127.0.0.1", port: 0,
      providers: {
        p1: { base: `http://127.0.0.1:${port(first)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 },
        p2: { base: `http://127.0.0.1:${port(second)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 },
      },
      routing: { default: "pool/coding", tiers: {}, benchmarkSort: false, pools: { coding: ["p1/m1", "p2/m2"] } },
      mode: "detect",
      repair: { maxAttempts: 1, destructiveTools: [] },
      log: { level: "silent", file: null },
    }));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: REQUEST_BODY,
    });
    expect(resp.status).toBe(200);
    // The walked refusal is queued exactly once, and announced on the SERVED response.
    const queue = pendingRefusals().filter((r) => r.provider === "p1");
    expect(queue.length).toBe(1);
    expect(queue[0]?.count).toBe(1);
    expect(resp.headers.get(UNKNOWN_REFUSAL_HEADER)).toBe("1");
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
    const summary = resp.headers.get(POOL_ATTEMPTS_HEADER);
    expect(summary).toContain("2 tried, 1 served");
    expect(summary).toContain("1x403");
    expect(summary).toContain("1x200");
  });

  it("the OpenAI front counts once too (parity pin, 2 candidates)", async () => {
    const first = await mockBackend(() => ({ status: 403, headers: { "content-type": "application/json" }, body: UNSEEN_REFUSAL }));
    const second = await mockBackend(() => ({ headers: { "content-type": "application/json" }, body: OK_BODY }));
    const p = port(await startProxy({
      host: "127.0.0.1", port: 0,
      providers: {
        p1: { base: `http://127.0.0.1:${port(first)}`, kind: "openai", authHeader: "authorization", timeoutMs: 5000 },
        p2: { base: `http://127.0.0.1:${port(second)}`, kind: "openai", authHeader: "authorization", timeoutMs: 5000 },
      },
      routing: { default: "pool/coding", tiers: {}, benchmarkSort: false, pools: { coding: ["p1/m1", "p2/m2"] } },
      mode: "detect",
      repair: { maxAttempts: 1, destructiveTools: [] },
      log: { level: "silent", file: null },
    }));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(resp.status).toBe(200);
    const queue = pendingRefusals().filter((r) => r.provider === "p1");
    expect(queue.length).toBe(1);
    expect(queue[0]?.count).toBe(1);
    expect(resp.headers.get(UNKNOWN_REFUSAL_HEADER)).toBe("1");
  });
});
