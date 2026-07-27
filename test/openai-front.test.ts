import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createProxy } from "../src/server.js";
import type { Config, ProviderConfig } from "../src/config.js";

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
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
        captured = { model: body.model, auth: req.headers["authorization"] as string | undefined };
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
  afterEach(() => { backend?.close(); proxy?.close(); });

  it("routes a namespaced model, rewrites to the backend id, injects the key, returns OpenAI verbatim", async () => {
    process.env.RP_FRONT_KEY = "sk-backend";
    const mock = await mockOpenAi();
    backend = mock.server;
    const c = cfg({ up: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", authHeader: "authorization", timeoutMs: 5000, authEnv: "RP_FRONT_KEY" } }, "up/fallback");
    proxy = createProxy(c);
    const p: number = await new Promise((r) => proxy.listen(0, "127.0.0.1", () => r(port(proxy))));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer CLIENT-SECRET" },
      body: JSON.stringify({ model: "up/real-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = (await resp.json()) as { choices: Array<{ message: { content: string } }> };

    expect(resp.status).toBe(200);
    expect(mock.seen().model).toBe("real-model");          // namespace stripped, backend id sent
    expect(mock.seen().auth).toBe("Bearer sk-backend");    // backend key injected (client secret dropped)
    expect(body.choices[0]!.message.content).toBe("hi from backend"); // OpenAI response passed through
    delete process.env.RP_FRONT_KEY;
  });

  it("serves the /chat/completions path without the /v1 prefix too", async () => {
    const mock = await mockOpenAi();
    backend = mock.server;
    const c = cfg({ up: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", authHeader: "authorization", timeoutMs: 5000 } }, "up/fallback");
    proxy = createProxy(c);
    const p: number = await new Promise((r) => proxy.listen(0, "127.0.0.1", () => r(port(proxy))));
    const resp = await fetch(`http://127.0.0.1:${p}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "up/m2", messages: [] }),
    });
    expect(resp.status).toBe(200);
    expect(mock.seen().model).toBe("m2");
  });

  it("returns a clean 400 (OpenAI-shaped) when the target is an anthropic provider", async () => {
    const c = cfg({ claude: { base: "https://api.anthropic.test", kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 } }, "claude");
    proxy = createProxy(c);
    const p: number = await new Promise((r) => proxy.listen(0, "127.0.0.1", () => r(port(proxy))));
    const resp = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude", messages: [] }),
    });
    expect(resp.status).toBe(400);
    const j = (await resp.json()) as { error?: { message?: string } };
    expect(j.error?.message).toMatch(/OpenAI front requires an openai-kind/);
  });
});
