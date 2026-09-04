import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxy, type ProxyDeps } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import { markExhausted } from "../src/dispatch.js";
import { loadConfig, type Config } from "../src/config.js";
import { AUTO_HEADER } from "../src/backend.js";

const servers: Server[] = [];
function track(s: Server): Server {
  servers.push(s);
  return s;
}

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

function startProxy(c: Config, deps: ProxyDeps = {}): Promise<Server> {
  const s = createProxy(c, { catalog: new ModelCatalog({ cachePath: null }), breaker: globalCircuitBreaker, ...deps });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(track(s))));
}

/** Mock OpenAI-compatible backend capturing each request's received model and path */
function mockBackend(): Promise<{ server: Server; seen: () => Array<{ url?: string | undefined; model?: string | undefined }> }> {
  const seen: Array<{ url?: string | undefined; model?: string | undefined }> = [];
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {}
        seen.push({
          url: req.url,
          model: typeof body.model === "string" ? body.model : undefined,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "cmpl_auto",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "hello from backend" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: track(s), seen: () => seen }));
  });
}

function baseCfg(backendPort: number): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    providers: {
      up: {
        base: `http://127.0.0.1:${backendPort}`,
        kind: "openai",
        tierType: "free",
        authHeader: "authorization",
        timeoutMs: 5000,
      },
    },
    routing: {
      default: "up/fallback-model",
      tiers: {},
      pools: {
        medPool: ["up/med-pool-model"],
        highPool: ["up/high-pool-model"],
      },
      ladders: {
        medium: [
          { id: "cli-lane", kind: "cli", command: "agy", args: ["{task}"], enabled: true },
          { id: "rung-med", kind: "relay", spec: "pool/medPool", enabled: true },
        ],
        high: [
          { id: "rung-high", kind: "relay", spec: "pool/highPool", enabled: true },
        ],
      },
    },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

describe("auto model name", () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    globalCircuitBreaker.reset();
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    globalCircuitBreaker.reset();
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
      tempDir = null;
    }
  });

  it("(1) GET /v1/models lists auto", async () => {
    const backend = await mockBackend();
    const cfg = baseCfg(port(backend.server));
    const proxy = await startProxy(cfg);

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/models`);
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { data: Array<{ id: string }> };
    const ids = json.data.map((m) => m.id);
    expect(ids).toContain("auto");
  });

  it("(2) a /v1/messages request with model: 'auto' is served by a member of the ladder's first ready relay rung and carries x-llm-relay-auto", async () => {
    const backend = await mockBackend();
    const cfg = baseCfg(port(backend.server));
    const proxy = await startProxy(cfg);

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "auto", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get(AUTO_HEADER)).toBe("pool/medPool (medium)");
    const seen = backend.seen();
    expect(seen.length).toBe(1);
    expect(seen[0]?.model).toBe("med-pool-model");
  });

  it("(3) the same on /v1/chat/completions", async () => {
    const backend = await mockBackend();
    const cfg = baseCfg(port(backend.server));
    const proxy = await startProxy(cfg);

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get(AUTO_HEADER)).toBe("pool/medPool (medium)");
    const seen = backend.seen();
    expect(seen.length).toBe(1);
    expect(seen[0]?.model).toBe("med-pool-model");
  });

  it("(4) x-llm-relay-tier: high selects the high ladder", async () => {
    const backend = await mockBackend();
    const cfg = baseCfg(port(backend.server));
    const proxy = await startProxy(cfg);

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-llm-relay-tier": "high",
      },
      body: JSON.stringify({ model: "auto", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get(AUTO_HEADER)).toBe("pool/highPool (high)");
    const seen = backend.seen();
    expect(seen.length).toBe(1);
    expect(seen[0]?.model).toBe("high-pool-model");
  });

  it("(5) when the only relay rung is exhausted, auto falls back to routing.default", async () => {
    const backend = await mockBackend();
    const cfg = baseCfg(port(backend.server));
    markExhausted(cfg, "rung-med", 60_000, "medium");

    const proxy = await startProxy(cfg);

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "auto", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get(AUTO_HEADER)).toBe("up/fallback-model (medium)");
    const seen = backend.seen();
    expect(seen.length).toBe(1);
    expect(seen[0]?.model).toBe("fallback-model");
  });

  it("(6) a provider named auto fails config load with a message naming auto", () => {
    tempDir = mkdtempSync(join(tmpdir(), "auto-cfg-"));
    const cfgFile = join(tempDir, "config.json");
    const badConfig = {
      providers: {
        auto: {
          base: "https://auto.example.com/v1",
          kind: "openai",
          authHeader: "authorization",
        },
      },
      routing: {
        default: "auto/model",
      },
    };
    writeFileSync(cfgFile, JSON.stringify(badConfig, null, 2));

    expect(() => loadConfig(cfgFile)).toThrow(/auto/);
  });
});