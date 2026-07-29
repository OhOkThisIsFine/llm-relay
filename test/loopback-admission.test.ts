import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import { createProxy, logSafePath } from "../src/server.js";
import type { Config } from "../src/config.js";

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
});

async function boot(): Promise<string> {
  server = createProxy(baseConfig());
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("loopback admission (ARC-c9155ca2)", () => {
  it("rejects a cross-origin POST to /offload", async () => {
    const url = await boot();
    const res = await fetch(`${url}/offload`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a text/plain POST — the CORS simple-request bypass", async () => {
    const url = await boot();
    // This is the exact shape that needed no preflight and therefore succeeded.
    const res = await fetch(`${url}/offload`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a cross-origin POST to /dispatch", async () => {
    const url = await boot();
    const res = await fetch(`${url}/dispatch`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
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
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
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

  it("bounds the ?task= query parameter", async () => {
    const url = await boot();
    const res = await fetch(`${url}/dispatch?task=${"x".repeat(5000)}`);
    expect(res.status).toBe(400);
  });
});

describe("logs stay metadata-only (INV-OB-1)", () => {
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
