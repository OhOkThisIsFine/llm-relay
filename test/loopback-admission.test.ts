import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import { buildForwardHeaders, createProxy, logSafePath } from "../src/server.js";
import type { Config } from "../src/config.js";
import { resolveAttempt } from "../src/resolved-attempt.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";
import { resetFacts } from "../src/target-facts.js";

const CONTROL_TOKEN = "test-control-capability";
const CONTROL_HEADERS = { [CONTROL_AUTHORIZATION_HEADER]: CONTROL_TOKEN };

/**
 * Pins ARC-c9155ca2: binding to loopback was doing the job of authorization.
 * Any web page the user visits could POST to 127.0.0.1 and, because the handler
 * JSON-parses whatever arrives regardless of declared content type, a text/plain
 * POST is a CORS *simple request* — no preflight — that flipped offload routing
 * and rewrote config.json on disk.
 */
function baseConfig(): Config {
  return {
    listen: "127.0.0.1:0",
    mode: "detect",
    providers: {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic", authHeader: "x-api-key" },
    },
    routing: { default: "anthropic", tiers: {}, pools: {}, offload: false },
    repair: { maxAttempts: 2, destructiveTools: ["rm", "delete"] },
    log: {},
  } as unknown as Config;
}

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  resetFacts();
});

async function boot(): Promise<string> {
  server = createProxy(baseConfig(), {
    controlAuthorization: { validate: (candidate) => candidate === CONTROL_TOKEN },
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("loopback admission (ARC-c9155ca2)", () => {
  it("rejects a cross-origin POST to /offload", async () => {
    const url = await boot();
    const res = await fetch(`${url}/offload`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json", ...CONTROL_HEADERS },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a text/plain POST — the CORS simple-request bypass", async () => {
    const url = await boot();
    // This is the exact shape that needed no preflight and therefore succeeded.
    const res = await fetch(`${url}/offload`, {
      method: "POST",
      headers: { "content-type": "text/plain", ...CONTROL_HEADERS },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a cross-origin POST to /dispatch", async () => {
    const url = await boot();
    const res = await fetch(`${url}/dispatch`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json", ...CONTROL_HEADERS },
      body: JSON.stringify({ exhausted: "pools" }),
    });
    expect(res.status).toBe(403);
  });

  it("allows a request with NO Origin — what a CLI sends", async () => {
    const url = await boot();
    const res = await fetch(`${url}/offload`, { method: "GET" });
    expect(res.status).toBe(200);
    // The no-restart behaviour the CLI depends on must survive the hardening.
    const body = (await res.json()) as { enabled?: boolean };
    expect(typeof body.enabled).toBe("boolean");
  });

  it("allows a same-origin loopback POST with a JSON content-type", async () => {
    const url = await boot();
    const res = await fetch(`${url}/offload`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json", ...CONTROL_HEADERS },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
  });

  it("requires the independent capability even for a same-origin control POST", async () => {
    const url = await boot();
    const missing = await fetch(`${url}/offload`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const wrong = await fetch(`${url}/offload`, {
      method: "POST",
      headers: {
        origin: url,
        "content-type": "application/json",
        [CONTROL_AUTHORIZATION_HEADER]: "wrong",
      },
      body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
  });

  it("rejects Origin: null, cross-port, and cross-scheme with a valid capability", async () => {
    const url = await boot();
    const crossPort = new URL(url);
    crossPort.port = String(Number(crossPort.port) + 1);
    for (const origin of ["null", crossPort.origin, url.replace("http:", "https:")]) {
      const res = await fetch(`${url}/offload`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", ...CONTROL_HEADERS },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status, origin).toBe(403);
    }
  });

  it("requires capability authorization before a probing GET", async () => {
    const url = await boot();
    const missing = await fetch(`${url}/ping`);
    expect(missing.status).toBe(403);
  });

  it("rejects a non-loopback Host header (DNS rebinding)", async () => {
    await boot();
    const { port } = server!.address() as AddressInfo;
    // fetch() treats Host as a forbidden header and silently rewrites it, so this
    // case has to be driven over a raw socket to actually exercise the check.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/offload", method: "GET", headers: { Host: "attacker.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("requires the exact listener authority, not another loopback spelling", async () => {
    await boot();
    const { port } = server!.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/offload", method: "GET", headers: { Host: `localhost:${port}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("rejects a cross-origin cooldown clear even with a valid capability", async () => {
    const url = await boot();
    const res = await fetch(`${url}/cooldowns/clear`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json", ...CONTROL_HEADERS },
      body: JSON.stringify({ provider: "anthropic" }),
    });
    expect(res.status).toBe(403);
  });

  it("requires JSON content-type for cooldown clears", async () => {
    const url = await boot();
    const missing = await fetch(`${url}/cooldowns/clear`, {
      method: "POST",
      headers: CONTROL_HEADERS,
    });
    const wrong = await fetch(`${url}/cooldowns/clear`, {
      method: "POST",
      headers: { "content-type": "text/plain", ...CONTROL_HEADERS },
      body: JSON.stringify({ provider: "anthropic" }),
    });
    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
  });

  it("requires a valid capability for cooldown clears", async () => {
    const url = await boot();
    const missing = await fetch(`${url}/cooldowns/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic" }),
    });
    const wrong = await fetch(`${url}/cooldowns/clear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CONTROL_AUTHORIZATION_HEADER]: "wrong",
      },
      body: JSON.stringify({ provider: "anthropic" }),
    });
    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
  });

  it("rejects a cooldown clear with a non-loopback Host header", async () => {
    await boot();
    const { port } = server!.address() as AddressInfo;
    const body = JSON.stringify({ provider: "anthropic" });
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/cooldowns/clear",
          method: "POST",
          headers: {
            Host: "attacker.example",
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            [CONTROL_AUTHORIZATION_HEADER]: CONTROL_TOKEN,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    expect(status).toBe(403);
  });

  it("allows an Origin-less authorized cooldown clear and is idempotent", async () => {
    const url = await boot();
    const request = () => fetch(`${url}/cooldowns/clear`, {
      method: "POST",
      headers: { "content-type": "application/json", ...CONTROL_HEADERS },
      body: JSON.stringify({ provider: "anthropic" }),
    });

    const first = await request();
    expect(first.status).toBe(200);
    expect((await first.json()) as unknown).toMatchObject({ target: { provider: "anthropic" } });

    const second = await request();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      target: { provider: "anthropic" },
      cleared: {
        breakerCells: { count: 0, items: [] },
        credentialFaults: { count: 0, items: [] },
        facts: { count: 0, items: [] },
      },
    });
  });

  it("rejects an unknown cooldown-clear provider and names it", async () => {
    const url = await boot();
    const res = await fetch(`${url}/cooldowns/clear`, {
      method: "POST",
      headers: { "content-type": "application/json", ...CONTROL_HEADERS },
      body: JSON.stringify({ provider: "typo-provider" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('no provider "typo-provider" configured');
  });

  it("bounds the ?task= query parameter", async () => {
    const url = await boot();
    const res = await fetch(`${url}/dispatch?task=${"x".repeat(5000)}`);
    expect(res.status).toBe(400);
  });

  it("rejects cross-origin requests across all proxy endpoints (/registry, /ping, /candidates, /v1/messages)", async () => {
    const url = await boot();
    const headers = { origin: "https://evil.example" };

    const resRegistry = await fetch(`${url}/registry`, { headers });
    expect(resRegistry.status).toBe(403);

    const resPing = await fetch(`${url}/ping`, { headers });
    expect(resPing.status).toBe(403);

    const resCandidates = await fetch(`${url}/candidates`, { headers });
    expect(resCandidates.status).toBe(403);

    const resMessages = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-3-5-sonnet", messages: [] }),
    });
    expect(resMessages.status).toBe(403);
  });
});

describe("logs stay metadata-only (INV-OB-1)", () => {
  it("never forwards the local control capability to a provider", () => {
    const forwarded = buildForwardHeaders(
      { [CONTROL_AUTHORIZATION_HEADER]: CONTROL_TOKEN, "content-type": "application/json" },
      resolveAttempt({
        provider: "anthropic",
        base: "https://api.anthropic.com",
        kind: "anthropic",
        authHeader: "x-api-key",
        timeoutMs: 1000,
      }),
    );
    expect(forwarded[CONTROL_AUTHORIZATION_HEADER]).toBeUndefined();
  });

  it("never writes a query-parameter VALUE into a log line", () => {
    // A ?task= carries user prose. The route and parameter names are metadata;
    // the values are content, and this project promises metadata-only logs.
    const safe = logSafePath("/dispatch?task=summarise%20the%20secret%20repo&lane=pools");
    expect(safe).toContain("/dispatch");
    expect(safe).toContain("task=");
    expect(safe).not.toContain("secret");
    expect(safe).not.toContain("summarise");
    expect(safe).toContain("lane=");
    expect(safe).not.toContain("pools");
  });

  it("leaves a path with no query string untouched", () => {
    expect(logSafePath("/v1/messages")).toBe("/v1/messages");
  });
});
