import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProxy } from "../src/server.js";
import type { Config } from "../src/config.js";

function mockBackend(handler: (path: string, headers: Record<string, string>, reqRes: { res: any }) => { status?: number; headers: Record<string, string | string[]>; body: string }): Promise<Server> {
  const s = createServer((req, res) => {
    const out = handler(req.url ?? "/", req.headers as Record<string, string>, { res });
    res.writeHead(out.status ?? 200, out.headers);
    res.end(out.body);
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

describe("server-safety features (CP-NODE-1)", () => {
  let dir: string;
  let logFile: string;
  let backend: Server;
  let proxy: Server;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rp-safety-"));
    logFile = join(dir, "log.jsonl");
  });
  afterAll(() => {
    backend?.close();
    proxy?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("properly preserves multiple Set-Cookie headers from backend", async () => {
    backend = await mockBackend(() => ({
      headers: {
        "content-type": "application/json",
        "set-cookie": ["cookie1=val1; Path=/", "cookie2=val2; Path=/"],
      },
      body: JSON.stringify({ id: "1", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }] }),
    }));
    const cfg: Config = {
      host: "127.0.0.1",
      port: 0,
      providers: { up: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", timeoutMs: 5000 } },
      routing: { default: "up", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "metadata", file: logFile },
    };
    proxy = await startProxy(cfg);
    const proxyPort = port(proxy);

    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-model", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(resp.status).toBe(200);
    // getSetCookie() should contain both cookies separately
    const cookies = resp.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("cookie1=val1");
    expect(cookies[1]).toContain("cookie2=val2");
  });

  it("enforces body size limit and returns 413 for oversized requests", async () => {
    const cfg: Config = {
      host: "127.0.0.1",
      port: 0,
      providers: { up: { base: "http://127.0.0.1:9999", kind: "anthropic", timeoutMs: 5000 } },
      routing: { default: "up", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "metadata", file: logFile },
    };
    const p = await startProxy(cfg);
    const pPort = port(p);

    // Send a payload exceeding 10MB
    const largeChunk = "a".repeat(1024 * 1024);
    const chunks = [];
    for (let i = 0; i < 11; i++) {
      chunks.push(largeChunk);
    }
    const bodyStr = JSON.stringify({ large: chunks.join("") });

    try {
      const resp = await fetch(`http://127.0.0.1:${pPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyStr,
      });
      expect(resp.status).toBe(413);
    } catch (e: any) {
      // Fetch might throw if socket was reset/destroyed during body upload
      expect(e).toBeDefined();
    } finally {
      p.close();
    }
  });

  it("package.json requires node >= 20 engine", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.engines?.node).toBe(">=20");
  });
});
