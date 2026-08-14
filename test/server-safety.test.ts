import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import type { Config } from "../src/config.js";

/** Every listener opened here, closed after each test — see the note in test/server.test.ts. */
const openServers: Server[] = [];
function track<T extends Server>(s: T): T {
  openServers.push(s);
  return s;
}
afterEach(async () => {
  const servers = openServers.splice(0);
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function mockBackend(handler: (path: string, headers: Record<string, string>, reqRes: { res: any }) => { status?: number; headers: Record<string, string | string[]>; body: string }): Promise<Server> {
  const s = createServer((req, res) => {
    const out = handler(req.url ?? "/", req.headers as Record<string, string>, { res });
    res.writeHead(out.status ?? 200, out.headers);
    res.end(out.body);
  });
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(track(s))));
}

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

/**
 * `cachePath: null` keeps the proxy off the developer's real ~/.llm-relay/models-cache.json,
 * which `createProxy(cfg)` with no deps would otherwise read on the request path.
 */
function startProxy(cfg: Config): Promise<Server> {
  const s = createProxy(cfg, { catalog: new ModelCatalog({ cachePath: null }) });
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(track(s))));
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
      providers: { up: { base: `http://127.0.0.1:${port(backend)}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 } },
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
      providers: { up: { base: "http://127.0.0.1:9999", kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 } },
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

    // ⚠ The assertion MUST live outside the try. This test used to read
    //     try { … expect(resp.status).toBe(413) } catch (e) { expect(e).toBeDefined() }
    // — and a vitest assertion failure is just a thrown Error, so the catch swallowed it and
    // re-asserted that *something* was thrown. The test could not fail for any reason: a proxy
    // that answered 200, or 500, or crashed, was green. Capture the outcome, then judge it.
    let outcome: { kind: "status"; status: number } | { kind: "error"; err: unknown };
    try {
      const resp = await fetch(`http://127.0.0.1:${pPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyStr,
      });
      outcome = { kind: "status", status: resp.status };
    } catch (e) {
      outcome = { kind: "error", err: e };
    }

    if (outcome.kind === "status") {
      expect(outcome.status).toBe(413);
    } else {
      // readBody() destroys the socket as soon as the cap is passed, so the upload can die
      // before the 413 is read back. That is a TRANSPORT failure of this exact shape — not a
      // licence to accept any error at all.
      const detail = String((outcome.err as { cause?: unknown })?.cause ?? outcome.err);
      expect(detail).toMatch(/ECONNRESET|EPIPE|socket hang up|terminated|other side closed/i);
    }
  });

  it("package.json requires node >= 22 engine", () => {
    // Resolved from this file, not from cwd: a relative read silently picks up whichever
    // package.json the runner happened to be launched next to.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.engines?.node).toBe(">=22");
  });
});
