/**
 * Credential containment on the forward path is an ALLOW-LIST (contract review DR-006).
 *
 * A contained anthropic-kind target receives only `content-type`, `accept`, `anthropic-version`
 * and `anthropic-beta` from the caller, plus the relay's OWN credential header. Every other
 * inbound header — a `cookie`, an `x-goog-api-key`, an `api-key`, the caller's `authorization`
 * — is dropped. A passthrough target (no declared credential, `credentialMode: "passthrough"`)
 * keeps forwarding the caller's own credential and is deliberately not filtered.
 *
 * Both fronts reach `buildForwardHeaders` for an anthropic-kind target, so the OpenAI front is
 * covered by the SAME mock backend, not by an openai-kind target (which builds its headers from
 * scratch and never forwards an inbound one). Every walk uses ≥2 candidates.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import type { Config, ProviderConfig } from "../src/config.js";

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

function startProxy(c: Config): Promise<Server> {
  const s = createProxy(c, { catalog: new ModelCatalog({ cachePath: null }) });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

const ANTHROPIC_OK = JSON.stringify({
  id: "msg_1", type: "message", role: "assistant", model: "mock", stop_reason: "end_turn",
  content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 },
});

/** An anthropic-shaped mock backend that records the headers of its LAST request. */
function mockAnthropicBackend(status = 200, body = ANTHROPIC_OK): Promise<{ server: Server; seen: () => Record<string, string> }> {
  let last: Record<string, string> = {};
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      last = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") last[k.toLowerCase()] = v;
        else if (Array.isArray(v)) last[k.toLowerCase()] = v.join(", ");
      }
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(status, { "content-type": "application/json", ...(status === 429 ? { "retry-after": "1" } : {}) });
        res.end(body);
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, seen: () => last }));
  });
}

function cfg(providers: Record<string, ProviderConfig>, def: string): Config {
  return {
    host: "127.0.0.1", port: 0,
    providers, routing: { default: def, tiers: {} },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  } as unknown as Config;
}

/** The inbound header set every test sends: four allowed, three foreign credentials, two auth names. */
const INBOUND = {
  "content-type": "application/json",
  "accept": "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "some-beta",
  "cookie": "session=secret; other=value",
  "x-goog-api-key": "goog-secret",
  "api-key": "apikey-secret",
  "authorization": "Bearer CLIENT-SECRET",
  "x-api-key": "CLIENT-API-KEY",
};

function bodyFor(front: "anthropic" | "openai", model: string): string {
  return JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
}

function pathFor(front: "anthropic" | "openai"): string {
  return front === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
}

function expectContained(seen: Record<string, string>): void {
  expect(seen["content-type"]).toBe("application/json");
  expect(seen["accept"]).toBe("application/json");
  expect(seen["anthropic-version"]).toBe("2023-06-01");
  expect(seen["anthropic-beta"]).toBe("some-beta");
  expect(seen["cookie"]).toBeUndefined();
  expect(seen["x-goog-api-key"]).toBeUndefined();
  expect(seen["api-key"]).toBeUndefined();
  expect(seen["authorization"]).toBeUndefined();
  // The relay's OWN credential, never the caller's.
  expect(seen["x-api-key"]).toBe("sk-backend-xyz");
}

describe("forward headers — a contained anthropic-kind target receives only the allow-list", () => {
  let dir: string;
  const servers: Server[] = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "llm-relay-fwd-"));
  });
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    delete process.env.RP_FWD_KEY;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function contained(front: "anthropic" | "openai"): Promise<Record<string, string>> {
    process.env.RP_FWD_KEY = "sk-backend-xyz";
    const backend = await mockAnthropicBackend();
    servers.push(backend.server);
    const proxy = await startProxy(cfg({
      up: { base: `http://127.0.0.1:${port(backend.server)}`, kind: "anthropic", authHeader: "x-api-key", authEnv: "RP_FWD_KEY", timeoutMs: 5000 },
    }, "up/model"));
    servers.push(proxy);
    const resp = await fetch(`http://127.0.0.1:${port(proxy)}${pathFor(front)}`, {
      method: "POST", headers: INBOUND, body: bodyFor(front, "up/model"),
    });
    expect(resp.status).toBe(200);
    await resp.text();
    return backend.seen();
  }

  it("Anthropic front: cookie, x-goog-api-key, api-key and the caller's authorization never egress", async () => {
    expectContained(await contained("anthropic"));
  });

  it("OpenAI front to the same anthropic-kind target: the same allow-list applies", async () => {
    expectContained(await contained("openai"));
  });

  it("a PASSTHROUGH target keeps forwarding the caller's own credential and is not filtered", async () => {
    const backend = await mockAnthropicBackend();
    servers.push(backend.server);
    const proxy = await startProxy(cfg({
      up: { base: `http://127.0.0.1:${port(backend.server)}`, kind: "anthropic", authHeader: "x-api-key", credentialMode: "passthrough", timeoutMs: 5000 },
    }, "up/model"));
    servers.push(proxy);
    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
      method: "POST", headers: INBOUND, body: bodyFor("anthropic", "up/model"),
    });
    expect(resp.status).toBe(200);
    await resp.text();
    const seen = backend.seen();
    expect(seen["authorization"]).toBe("Bearer CLIENT-SECRET");
    expect(seen["x-api-key"]).toBe("CLIENT-API-KEY");
    expect(seen["cookie"]).toBe("session=secret; other=value");
    expect(seen["x-goog-api-key"]).toBe("goog-secret");
    expect(seen["api-key"]).toBe("apikey-secret");
  });

  it("a pool walk of two contained candidates applies the allow-list on BOTH hops", async () => {
    process.env.RP_FWD_KEY = "sk-backend-xyz";
    const first = await mockAnthropicBackend(429, JSON.stringify({ error: { type: "rate_limit_error", message: "rate limit" } }));
    const second = await mockAnthropicBackend();
    servers.push(first.server, second.server);
    const c = cfg({
      up: { base: `http://127.0.0.1:${port(first.server)}`, kind: "anthropic", authHeader: "x-api-key", authEnv: "RP_FWD_KEY", timeoutMs: 5000 },
      up2: { base: `http://127.0.0.1:${port(second.server)}`, kind: "anthropic", authHeader: "x-api-key", authEnv: "RP_FWD_KEY", timeoutMs: 5000 },
    }, "pool/test");
    c.routing.pools = { test: ["up/model", "up2/model"] };
    const proxy = await startProxy(c);
    servers.push(proxy);
    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
      method: "POST", headers: INBOUND, body: bodyFor("anthropic", "pool/test"),
    });
    expect(resp.status).toBe(200);
    await resp.text();
    expectContained(first.seen());
    expectContained(second.seen());
  });
});
