import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxy } from "../src/server.js";
import { ModelCatalog, type ModelLimits } from "../src/catalog.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import { resetFacts } from "../src/target-facts.js";
import type { Config, ProviderConfig } from "../src/config.js";

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

/**
 * `cachePath: null` keeps the proxy off the developer's real ~/.llm-relay/models-cache.json.
 * The front resolves concrete target models, so the context guardrail calls `cachedLimits()` on
 * this path too — with the default catalog these tests read that file, and a machine holding a
 * real entry for the provider/model id a test uses would 400 the request it expects to serve.
 * (This comment predates the behaviour: until 0.17.0 the guardrail was gated to /v1/messages
 * and never ran here, so the hermeticity it describes was one code move away from mattering.)
 */
function startProxy(c: Config, catalog: ModelCatalog = new ModelCatalog({ cachePath: null })): Promise<Server> {
  const s = createProxy(c, { catalog });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
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

/** Mock OpenAI /chat/completions backend capturing the model + auth it received. */
function mockOpenAi(content = "hi from backend"): Promise<{ server: Server; seen: () => { model?: string; auth?: string } }> {
  let captured: { model?: string; auth?: string } = {};
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        captured = {
          ...(typeof body.model === "string" ? { model: body.model } : {}),
          ...(typeof req.headers["authorization"] === "string" ? { auth: req.headers["authorization"] } : {}),
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "cmpl_1", object: "chat.completion", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, seen: () => captured }));
  });
}

function cfg(providers: Record<string, ProviderConfig>, def: string): Config {
  return {
    host: "127.0.0.1", port: 0,
    providers, routing: { default: def, tiers: {} },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

describe("OpenAI front (/chat/completions)", () => {
  let backend: Server;
  let proxy: Server;
  afterEach(() => {
    backend?.close();
    proxy?.close();
    // The key is process-global: an assertion that failed before the in-body `delete` used to
    // leak it into every later test, so a test meant to run WITHOUT a key silently had one.
    delete process.env.RP_FRONT_KEY;
  });

  it("routes a namespaced model, rewrites to the backend id, injects the key, returns OpenAI verbatim", async () => {
    process.env.RP_FRONT_KEY = "sk-backend";
    const directContent = "<think>direct OpenAI bytes stay exact</think>hi from backend";
    const mock = await mockOpenAi(directContent);
    backend = mock.server;
    const c = cfg({ up: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", tierType: "free", authHeader: "authorization", timeoutMs: 5000, authEnv: "RP_FRONT_KEY" } }, "up/fallback");
    proxy = await startProxy(c);
    const p = port(proxy);

    const resp = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer CLIENT-SECRET" },
      body: JSON.stringify({ model: "up/real-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = (await resp.json()) as { choices: Array<{ message: { content: string } }> };

    expect(resp.status).toBe(200);
    expect(mock.seen().model).toBe("real-model");          // namespace stripped, backend id sent
    expect(mock.seen().auth).toBe("Bearer sk-backend");    // backend key injected (client secret dropped)
    expect(mock.seen().auth).not.toContain("CLIENT-SECRET"); // and the caller's own credential never egressed
    expect(body.choices[0]!.message.content).toBe(directContent); // direct OpenAI response stays byte-exact, tags included
  });

  it("serves the /chat/completions path without the /v1 prefix too", async () => {
    const mock = await mockOpenAi();
    backend = mock.server;
    const c = cfg({ up: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", tierType: "free", authHeader: "authorization", timeoutMs: 5000 } }, "up/fallback");
    proxy = await startProxy(c);
    const p = port(proxy);
    const resp = await fetch(`http://127.0.0.1:${p}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "up/m2", messages: [] }),
    });
    expect(resp.status).toBe(200);
    expect(mock.seen().model).toBe("m2");
  });

  it("translates Chat Completions to an Anthropic target", async () => {
    process.env.RP_FRONT_KEY = "sk-anthropic";
    let seenPath = "";
    let seenAuth = "";
    let seen: any;
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        seenPath = req.url ?? "";
        seenAuth = String(req.headers["x-api-key"] ?? "");
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          seen = JSON.parse(Buffer.concat(chunks).toString());
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "msg_1",
            model: "claude-sonnet",
            content: [{ type: "text", text: "hello from Claude" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 2, output_tokens: 3 },
          }));
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const c = cfg({ claude: {
      base: `http://127.0.0.1:${port(backend)}`,
      kind: "anthropic",
      authHeader: "x-api-key",
      timeoutMs: 5000,
      authEnv: "RP_FRONT_KEY",
    } }, "claude");
    proxy = await startProxy(c);
    const p = port(proxy);
    const resp = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer CLIENT-SECRET" },
      body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hello" }] }),
    });
    const j = (await resp.json()) as any;
    expect(resp.status).toBe(200);
    expect(seenPath).toBe("/v1/messages");
    expect(seenAuth).toBe("sk-anthropic");
    expect(seen.messages[0].content[0].text).toBe("hello");
    expect(j.choices[0].message.content).toBe("hello from Claude");
    expect(j.usage.total_tokens).toBe(5);
  });

  it("folds Anthropic cache traffic into the Chat Completions usage it hands the client", async () => {
    // An anthropic-kind backend reports input/output/cache separately; an OpenAI client reads
    // ONE prompt figure that includes the cached subset plus `prompt_tokens_details`. Passing
    // input_tokens straight through would understate the prompt by the whole cache read.
    process.env.RP_FRONT_KEY = "sk-anthropic";
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_cache",
          model: "claude-sonnet",
          content: [{ type: "text", text: "cached answer" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 20,
            output_tokens: 4,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 300,
          },
        }));
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const c = cfg({ claude: {
      base: `http://127.0.0.1:${port(backend)}`,
      kind: "anthropic",
      authHeader: "x-api-key",
      timeoutMs: 5000,
      authEnv: "RP_FRONT_KEY",
    } }, "claude");
    proxy = await startProxy(c);
    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer CLIENT-SECRET" },
      body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hello" }] }),
    });
    const j = (await resp.json()) as any;
    expect(resp.status).toBe(200);
    // 20 uncached + 300 written + 5000 read from cache = the prompt the client asked about.
    expect(j.usage.prompt_tokens).toBe(5320);
    expect(j.usage.completion_tokens).toBe(4);
    expect(j.usage.total_tokens).toBe(5324);
    // Only a cache READ becomes cached_tokens — a write is billed work, not a cache hit.
    expect(j.usage.prompt_tokens_details).toEqual({ cached_tokens: 5000 });
  });

  it("serves Codex-style Responses requests through an Anthropic target", async () => {
    let seen: any;
    let seenCodexMetadata: string | string[] | undefined;
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        seenCodexMetadata = req.headers["x-codex-turn-metadata"];
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          seen = JSON.parse(Buffer.concat(chunks).toString());
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "msg_2",
            model: "claude-sonnet",
            content: [{ type: "text", text: "response from Claude" }],
            stop_reason: "end_turn",
          }));
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const c = cfg({ claude: {
      base: `http://127.0.0.1:${port(backend)}`,
      kind: "anthropic",
      authHeader: "x-api-key",
      timeoutMs: 5000,
    } }, "claude");
    proxy = await startProxy(c);
    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/responses`, {
      method: "POST", headers: {
        "content-type": "application/json",
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }),
      },
      body: JSON.stringify({
        model: "claude",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        max_output_tokens: 64,
      }),
    });
    const j = await resp.json() as any;
    expect(resp.status).toBe(200);
    expect(seen.messages[0].content[0].text).toBe("hello");
    expect(seen.max_tokens).toBe(64);
    expect(seenCodexMetadata).toBeUndefined();
    expect(j.object).toBe("response");
    expect(j.output_text).toBe("response from Claude");
  });

  it("adapts Responses requests to an OpenAI-compatible backend", async () => {
    let seen: any;
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          seen = JSON.parse(Buffer.concat(chunks).toString());
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "cmpl_2",
            model: "target-model",
            choices: [{
              finish_reason: "stop",
              message: { role: "assistant", content: "response from OpenAI" },
            }],
            usage: { prompt_tokens: 4, completion_tokens: 6 },
          }));
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const c = cfg({ up: {
      base: `http://127.0.0.1:${port(backend)}`,
      kind: "openai", tierType: "free",
      authHeader: "authorization",
      timeoutMs: 5000,
    } }, "up/target-model");
    proxy = await startProxy(c);
    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "up/target-model",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        max_output_tokens: 64,
      }),
    });
    const j = await resp.json() as any;
    expect(resp.status).toBe(200);
    expect(seen.model).toBe("target-model");
    expect(seen.messages[0].content).toBe("hello");
    expect(seen.max_tokens).toBe(64);
    expect(j.object).toBe("response");
    expect(j.output_text).toBe("response from OpenAI");
    expect(j.usage.total_tokens).toBe(10);
  });

  it("carries a Responses-front tool round-trip into an openai-kind backend as a linked role:\"tool\"", async () => {
    // Both request directions are relay-owned now: `responses-request.ts` maps the Codex body to
    // Anthropic Messages, then `anthropicRequestToOpenAi` maps that to Chat Completions. A
    // Codex-through-relay tool turn crosses both, and the `call_id` must survive unchanged.
    let seen: any;
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          seen = JSON.parse(Buffer.concat(chunks).toString());
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "cmpl_tool",
            model: "target-model",
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "found it" } }],
          }));
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const c = cfg({ up: {
      base: `http://127.0.0.1:${port(backend)}`,
      kind: "openai", tierType: "free",
      authHeader: "authorization",
      timeoutMs: 5000,
    } }, "up/target-model");
    proxy = await startProxy(c);

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "up/target-model",
        input: [
          { role: "user", content: [{ type: "input_text", text: "find it" }] },
          { type: "function_call", call_id: "call_1", name: "Grep", arguments: JSON.stringify({ pattern: "protocol" }) },
          { type: "function_call_output", call_id: "call_1", output: "SECRET-RESULT" },
        ],
        tools: [{ type: "function", name: "Grep", description: "g", parameters: { type: "object", properties: { pattern: { type: "string" } } } }],
        max_output_tokens: 64,
      }),
    });

    expect(resp.status).toBe(200);
    // The tool result reaches the backend as a LINKED OpenAI tool message, exactly once.
    expect(seen.messages.filter((m: any) => m.role === "tool")).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "SECRET-RESULT", name: "Grep" },
    ]);
    expect(JSON.stringify(seen).split("SECRET-RESULT").length - 1).toBe(1);
    // The granted tool survives as an OpenAI function declaration.
    expect(seen.tools).toEqual([{
      type: "function",
      function: { name: "Grep", description: "g", parameters: { type: "object", properties: { pattern: { type: "string" } } } },
    }]);
    // The anti-regression, on this front too: no relay IR envelope in the prompt.
    expect(JSON.stringify(seen)).not.toContain("_original");
    expect((await resp.json() as any).output_text).toBe("found it");

    // ⚠ THE FLIP. This line used to pin the gap: llm-bridge's `openaiResponsesToUniversal` has no
    // case for a `function_call` INPUT item, so the assistant's own tool call was flattened into
    // an empty user turn and no `tool_calls` could ever be emitted from this front. The relay owns
    // that direction now, so exactly one assistant message carries the call — before the tool
    // message that answers it, with the id the caller sent.
    const assistants = seen.messages.filter((m: any) => m.tool_calls);
    expect(assistants).toEqual([{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "Grep", arguments: JSON.stringify({ pattern: "protocol" }) },
      }],
    }]);
    const roles = seen.messages.map((m: any) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool"]);
  });

  it("routes a Codex child Responses turn through routing.subagents", async () => {
    const seenModels: string[] = [];
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: unknown };
          if (typeof body.model === "string") seenModels.push(body.model);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "cmpl_codex_subagent",
            model: "coding-model",
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "from coding pool" } }],
          }));
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });

    const c = cfg({ up: {
      base: `http://127.0.0.1:${port(backend)}`,
      kind: "openai", tierType: "free",
      authHeader: "authorization",
      timeoutMs: 5000,
    } }, "up/main-model");
    c.routing.pools = { coding: ["up/coding-model"] };
    c.routing.subagents = { default: "pool/coding" };
    c.routing.offload = true;
    proxy = await startProxy(c);

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "subagent" }),
      },
      body: JSON.stringify({
        model: "up/main-model",
        input: [{ role: "user", content: [{ type: "input_text", text: "inspect this" }] }],
      }),
    });

    expect(resp.status).toBe(200);
    expect(seenModels).toEqual(["coding-model"]);
    expect((await resp.json() as { output_text?: string }).output_text).toBe("from coding pool");
  });

  it("routes a Codex main Responses conversation only when codex scope is all", async () => {
    const seenModels: string[] = [];
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: unknown };
          if (typeof body.model === "string") seenModels.push(body.model);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "cmpl_codex_main",
            model: "coding-model",
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "from coding pool" } }],
          }));
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });

    const c = cfg({ up: {
      base: `http://127.0.0.1:${port(backend)}`,
      kind: "openai", tierType: "free",
      authHeader: "authorization",
      timeoutMs: 5000,
    } }, "up/main-model");
    c.routing.pools = { coding: ["up/coding-model"] };
    c.routing.subagents = { default: "pool/coding" };
    c.routing.offload = {
      claude: { enabled: false, scope: "subagents" },
      codex: { enabled: true, scope: "all" },
    };
    proxy = await startProxy(c);

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "up/main-model",
        input: [{ role: "user", content: [{ type: "input_text", text: "continue here" }] }],
      }),
    });

    expect(resp.status).toBe(200);
    expect(seenModels).toEqual(["coding-model"]);
    expect((await resp.json() as { output_text?: string }).output_text).toBe("from coding pool");
  });

  it("passes a backend 429 through with its status and body — the client's backoff owns the retry", async () => {
    // The front is a reverse proxy: rewriting a rate limit into a 502 would strip the
    // Retry-After semantics the caller needs, and hide a quota problem as a proxy fault.
    const upstreamBody = JSON.stringify({ error: { message: "rate limit exceeded", type: "rate_limit_error" } });
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "42" });
          res.end(upstreamBody);
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const c = cfg({ up: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", tierType: "free", authHeader: "authorization", timeoutMs: 5000 } }, "up/fallback");
    proxy = await startProxy(c);
    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "up/m", messages: [] }),
    });
    expect(resp.status).toBe(429);
    expect(await resp.text()).toBe(upstreamBody);
    expect(resp.headers.get("retry-after")).toBe("42");
  });
});

/**
 * INV: the context guardrail covers the OpenAI front, with the same policy as /v1/messages —
 * prune candidates whose SERVING-provider-published limit the estimate exceeds, fail closed
 * only when nothing survives, and never guard on an unpublished limit.
 *
 * Until 0.17.0 the guardrail was gated to /v1/messages, so front requests reached backends
 * with no context pre-check — while this file's hermeticity comment claimed otherwise. The
 * same "two paths, two policies, one of them empty" shape as the pool-failover incident.
 */
describe("OpenAI front context guardrail", () => {
  let dir: string;
  let backend: Server;
  let proxy: Server;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "rp-front-guard-")); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  afterEach(() => {
    backend?.close();
    proxy?.close();
  });

  // ~4000 chars ≈ 1000 estimated tokens — far over a 200-token limit, far under a 1M one.
  const chatBody = JSON.stringify({ model: "pool/duo", messages: [{ role: "user", content: "x".repeat(4000) }] });

  function duoConfig(backendPort: number): Config {
    const c = cfg({ up: { base: `http://127.0.0.1:${backendPort}`, kind: "openai", tierType: "free", authHeader: "authorization", timeoutMs: 5000 } }, "up/fallback");
    c.routing.pools = { duo: ["up/small", "up/big"] };
    return c;
  }

  it("prunes an undersized pool member and serves from the one that fits", async () => {
    const mock = await mockOpenAi();
    backend = mock.server;
    const catalog = catalogWithLimits(dir, { up: { small: { contextLength: 200 }, big: { contextLength: 1_000_000 } } });
    proxy = await startProxy(duoConfig(port(backend)), catalog);

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: chatBody,
    });
    expect(resp.status).toBe(200);
    expect(mock.seen().model).toBe("big"); // "small" stepped aside before any upstream spend
  });

  it("fails closed with 400 naming the provider's published limit when every candidate is pruned", async () => {
    const mock = await mockOpenAi();
    backend = mock.server;
    const catalog = catalogWithLimits(dir, { up: { small: { contextLength: 200 }, big: { contextLength: 300 } } });
    proxy = await startProxy(duoConfig(port(backend)), catalog);

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: chatBody,
    });
    expect(resp.status).toBe(400);
    const j = (await resp.json()) as { error?: { message?: string } };
    expect(j.error?.message).toMatch(/"up" publishes for "small"/);
    expect(j.error?.message).toContain("200");
    expect(mock.seen().model).toBeUndefined(); // nothing reached a backend
  });

  it("does NOT guard when the provider published nothing — no invented fallback ceiling", async () => {
    const mock = await mockOpenAi();
    backend = mock.server;
    // Default hermetic catalog: no limits known, so an enormous prompt must reach the backend
    // and get the backend's own authoritative answer.
    proxy = await startProxy(duoConfig(port(backend)));

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/duo", messages: [{ role: "user", content: "x".repeat(600_000) }] }),
    });
    expect(resp.status).toBe(200);
    expect(mock.seen().model).toBe("small");
  });

  it("guards the /v1/responses shape too — the estimator counts `input`", async () => {
    const mock = await mockOpenAi();
    backend = mock.server;
    const catalog = catalogWithLimits(dir, { up: { small: { contextLength: 200 } } });
    const c = cfg({ up: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", tierType: "free", authHeader: "authorization", timeoutMs: 5000 } }, "up/fallback");
    proxy = await startProxy(c, catalog);

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "up/small",
        input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(4000) }] }],
      }),
    });
    expect(resp.status).toBe(400);
    const j = (await resp.json()) as { error?: { message?: string } };
    expect(j.error?.message).toMatch(/"up" publishes for "small"/);
    expect(mock.seen().model).toBeUndefined();
  });
});

/**
 * INV: the Responses REQUEST direction is relay-owned (`src/responses-request.ts`), on both
 * backend kinds.
 *
 * llm-bridge's `openaiResponsesToUniversal` modelled `function_call_output` and nothing else, so
 * a Codex multi-turn tool conversation arrived at the backend with the assistant's own tool call
 * flattened into an empty user turn and its prior `output_text` stringified as JSON — the
 * Responses-front sibling of the IR leak v0.39.0 fixed on the Chat direction. These pin the shape
 * that reaches each backend kind, and that an unrepresentable item is refused with ZERO egress.
 */
describe("Responses front — relay-owned request translation", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    globalCircuitBreaker.reset();
    resetFacts();
  });

  function track(s: Server): Server {
    servers.push(s);
    return s;
  }

  /** A backend that records every request body it was handed. */
  function recording(
    reply: () => { status?: number; body: string; headers?: Record<string, string> },
  ): Promise<{ server: Server; seen: () => any[] }> {
    const seen: any[] = [];
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          seen.push(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
          const r = reply();
          res.writeHead(r.status ?? 200, { "content-type": "application/json", ...(r.headers ?? {}) });
          res.end(r.body);
        });
      });
      track(s).listen(0, "127.0.0.1", () => resolve({ server: s, seen: () => seen }));
    });
  }

  const chatOk = (content: string) => JSON.stringify({
    id: "cmpl_r",
    model: "target-model",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
  });

  function openaiCfg(backendPort: number): Config {
    return cfg({ up: {
      base: `http://127.0.0.1:${backendPort}`,
      kind: "openai", tierType: "free", authHeader: "authorization", timeoutMs: 5000,
    } }, "up/target-model");
  }

  it("carries an assistant output_text as assistant TEXT, and drops a reasoning item", async () => {
    // Both halves of the llm-bridge gap in one request: `parseResponsesContent` had no
    // `output_text` case (fall-through => `JSON.stringify(part)`, so the assistant's own prior
    // answer reached the model as a JSON string), and a `reasoning` item became a bogus user turn.
    const backend = await recording(() => ({ body: chatOk("continued") }));
    const proxy = track(await startProxy(openaiCfg(port(backend.server))));

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "up/target-model",
        instructions: "be terse",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          { type: "reasoning", summary: [{ type: "summary_text", text: "thinking about it" }], encrypted_content: "opaque" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "prior answer" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "go on" }] },
        ],
        max_output_tokens: 32,
      }),
    });

    expect(resp.status).toBe(200);
    const seen = backend.seen()[0];
    expect(seen.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "prior answer" },
      { role: "user", content: "go on" },
    ]);
    // The reasoning item left no turn, and no Responses vocabulary reached the prompt.
    const wire = JSON.stringify(seen);
    expect(wire).not.toContain("output_text");
    expect(wire).not.toContain("thinking about it");
    expect(wire).not.toContain("_original");
  });

  it("refuses an unmodelled input item, naming the type, with zero egress", async () => {
    const backend = await recording(() => ({ body: chatOk("never") }));
    const proxy = track(await startProxy(openaiCfg(port(backend.server))));

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "up/target-model",
        input: [
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
          { type: "local_shell_call", call_id: "ls_1", action: { type: "exec", command: ["ls"] } },
        ],
      }),
    });

    expect(resp.status).toBe(400);
    const j = await resp.json() as { error?: { message?: string } };
    expect(j.error?.message).toContain("local_shell_call");
    expect(backend.seen()).toEqual([]);
  });

  it("refuses previous_response_id rather than silently dropping the prefix it names", async () => {
    const backend = await recording(() => ({ body: chatOk("never") }));
    const proxy = track(await startProxy(openaiCfg(port(backend.server))));

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "up/target-model",
        previous_response_id: "resp_abc",
        input: [{ role: "user", content: [{ type: "input_text", text: "and then?" }] }],
      }),
    });

    expect(resp.status).toBe(400);
    expect((await resp.json() as any).error.message).toContain("previous_response_id");
    expect(backend.seen()).toEqual([]);
  });

  it("hands an anthropic-kind target a linked tool_use/tool_result pair, system and max_tokens", async () => {
    const backend = await recording(() => ({
      body: JSON.stringify({
        id: "msg_r", model: "claude-sonnet", role: "assistant", type: "message",
        content: [{ type: "text", text: "done" }], stop_reason: "end_turn",
      }),
    }));
    const c = cfg({ claude: {
      base: `http://127.0.0.1:${port(backend.server)}`,
      kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000,
    } }, "claude");
    const proxy = track(await startProxy(c));

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude",
        instructions: "you are a grep",
        input: [
          { role: "user", content: [{ type: "input_text", text: "find it" }] },
          { type: "function_call", call_id: "call_1", name: "Grep", arguments: JSON.stringify({ pattern: "p" }) },
          { type: "function_call_output", call_id: "call_1", output: "3 matches" },
        ],
        tools: [{ type: "function", name: "Grep", description: "g", parameters: { type: "object", properties: { pattern: { type: "string" } } }, strict: true }],
        tool_choice: "required",
        max_output_tokens: 128,
      }),
    });

    expect(resp.status).toBe(200);
    const seen = backend.seen()[0];
    expect(seen.system).toBe("you are a grep");
    expect(seen.max_tokens).toBe(128);
    expect(seen.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "find it" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Grep", input: { pattern: "p" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "3 matches" }] },
    ]);
    expect(seen.tools).toEqual([{
      name: "Grep", description: "g",
      input_schema: { type: "object", properties: { pattern: { type: "string" } } },
    }]);
    // OpenAI's "required" is Anthropic's "any"; `strict` has no Anthropic spelling and is dropped.
    expect(seen.tool_choice).toEqual({ type: "any" });
    expect(JSON.stringify(seen)).not.toContain("strict");
  });

  it("maps the same shape on the FAILOVER candidate — the mapper runs per candidate", async () => {
    // >=2 candidates on purpose: with one, "maps correctly on failover" and "never failed over"
    // are the same observation.
    const dead = await recording(() => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) }));
    const alive = await recording(() => ({ body: chatOk("second served") }));
    const c = cfg({
      a: { base: `http://127.0.0.1:${port(dead.server)}`, kind: "openai", tierType: "free", authHeader: "authorization", timeoutMs: 5000 },
      b: { base: `http://127.0.0.1:${port(alive.server)}`, kind: "openai", tierType: "free", authHeader: "authorization", timeoutMs: 5000 },
    }, "pool/duo");
    c.routing.pools = { duo: ["a/target-model", "b/target-model"] };
    const proxy = track(await startProxy(c));

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "pool/duo",
        input: [
          { role: "user", content: [{ type: "input_text", text: "find it" }] },
          { type: "function_call", call_id: "call_9", name: "Grep", arguments: '{"pattern":"p"}' },
          { type: "function_call_output", call_id: "call_9", output: "hit" },
        ],
        tools: [{ type: "function", name: "Grep", parameters: { type: "object", properties: {} } }],
        max_output_tokens: 32,
      }),
    });

    expect(resp.status).toBe(200);
    const bodies = [...dead.seen(), ...alive.seen()];
    expect(bodies.length).toBe(2);
    for (const seen of bodies) {
      expect(seen.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool"]);
      expect(seen.messages[1].tool_calls[0].id).toBe("call_9");
      expect(seen.messages[2]).toEqual({ role: "tool", tool_call_id: "call_9", content: "hit", name: "Grep" });
    }
  });

  it("maps the request body on the STREAMING path too", async () => {
    const sse = [
      `data: ${JSON.stringify({ id: "c", model: "target-model", choices: [{ index: 0, delta: { role: "assistant", content: "streamed" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c", model: "target-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const seen: any[] = [];
    const backend = track(await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          seen.push(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(sse);
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    }));
    const proxy = track(await startProxy(openaiCfg(port(backend))));

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "up/target-model",
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: "find it" }] },
          { type: "function_call", call_id: "call_s", name: "Grep", arguments: "{}" },
          { type: "function_call_output", call_id: "call_s", output: "hit" },
        ],
        tools: [{ type: "function", name: "Grep", parameters: { type: "object", properties: {} } }],
        max_output_tokens: 32,
      }),
    });

    const text = await resp.text();
    expect(resp.status).toBe(200);
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("streamed");
    expect(text).toContain("response.completed");
    expect(seen[0].messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(seen[0].messages[1].tool_calls[0]).toEqual({
      id: "call_s", type: "function", function: { name: "Grep", arguments: "{}" },
    });
  });
});
