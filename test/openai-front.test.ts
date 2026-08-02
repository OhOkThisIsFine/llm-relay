import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import type { Config, ProviderConfig } from "../src/config.js";

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

/**
 * `cachePath: null` keeps the proxy off the developer's real ~/.llm-relay/models-cache.json.
 * The front resolves a concrete target model, so the context guardrail calls `cachedLimits()`
 * on this path too — with the default catalog these tests read that file, and a machine holding
 * a real entry for the provider/model id a test uses would 400 the request it expects to serve.
 */
function startProxy(c: Config): Promise<Server> {
  const s = createProxy(c, { catalog: new ModelCatalog({ cachePath: null }) });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

/** Mock OpenAI /chat/completions backend capturing the model + auth it received. */
function mockOpenAi(): Promise<{ server: Server; seen: () => { model?: string; auth?: string } }> {
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
        res.end(JSON.stringify({ id: "cmpl_1", object: "chat.completion", choices: [{ message: { role: "assistant", content: "hi from backend" }, finish_reason: "stop" }] }));
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
    const mock = await mockOpenAi();
    backend = mock.server;
    const c = cfg({ up: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", authHeader: "authorization", timeoutMs: 5000, authEnv: "RP_FRONT_KEY" } }, "up/fallback");
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
    expect(body.choices[0]!.message.content).toBe("hi from backend"); // OpenAI response passed through
  });

  it("serves the /chat/completions path without the /v1 prefix too", async () => {
    const mock = await mockOpenAi();
    backend = mock.server;
    const c = cfg({ up: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", authHeader: "authorization", timeoutMs: 5000 } }, "up/fallback");
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
      kind: "openai",
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
      kind: "openai",
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
      kind: "openai",
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
    const c = cfg({ up: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", authHeader: "authorization", timeoutMs: 5000 } }, "up/fallback");
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
