import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getAvg, getP95, getJitter, getSpikeRate, getUptime, getStabilityScore, getVerdict, type PingRecord } from "../src/ping/metrics.js";
import { extractQuotaPercent, buildPingRequest, pingProviderModel } from "../src/ping/ping.js";
import { loadProbeCache, flushProbeCache, recordProbeResult, getModelsDueForProbe } from "../src/ping/probe-cache.js";
import { recordModelCall, getRealWorldScore, loadRuntimeTelemetry } from "../src/ping/runtime-telemetry.js";
import { PingLoop } from "../src/ping/cadence.js";
import { createProxy } from "../src/server.js";
import type { Config, ProviderConfig } from "../src/config.js";
import type { ModelCatalog } from "../src/catalog.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";

function testConfig(providers: Record<string, ProviderConfig>): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    providers,
    routing: { default: "test/model-a", tiers: {} },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

describe("Ping Metrics", () => {
  it("calculates avg, p95, jitter, uptime, and stability score correctly", () => {
    const pings: PingRecord[] = [
      { ms: 100, code: "200", timestamp: 1 },
      { ms: 200, code: "200", timestamp: 2 },
      { ms: 300, code: "200", timestamp: 3 },
      { ms: 400, code: "200", timestamp: 4 },
      { ms: 500, code: "401", timestamp: 5 },
    ];

    expect(getAvg(pings)).toBe(300);
    expect(getP95(pings)).toBe(500);
    expect(getJitter(pings)).toBe(141);
    expect(getSpikeRate(pings)).toBe(0);
    expect(getUptime(pings)).toBe(80); // 4 out of 5 are 200

    const score = getStabilityScore(pings);
    expect(score).toBeGreaterThan(80);
    expect(getVerdict(pings)).toBe("Perfect");
  });

  it("returns Spiky verdict for fast avg but high p95", () => {
    const pings: PingRecord[] = [
      { ms: 100, code: "200", timestamp: 1 },
      { ms: 100, code: "200", timestamp: 2 },
      { ms: 100, code: "200", timestamp: 3 },
      { ms: 100, code: "200", timestamp: 4 },
      { ms: 100, code: "200", timestamp: 5 },
      { ms: 100, code: "200", timestamp: 6 },
      { ms: 100, code: "200", timestamp: 7 },
      { ms: 100, code: "200", timestamp: 8 },
      { ms: 100, code: "200", timestamp: 9 },
      { ms: 6000, code: "200", timestamp: 10 },
    ];
    expect(getAvg(pings)).toBe(690);
    expect(getP95(pings)).toBe(6000);
    expect(getVerdict(pings)).toBe("Spiky");
  });
});


describe("Header Quota Parsing", () => {
  it("parses x-ratelimit-remaining / limit headers", () => {
    const headers = {
      "x-ratelimit-remaining": "45",
      "x-ratelimit-limit": "100",
    };
    expect(extractQuotaPercent(headers)).toBe(45);
  });

  it("returns null when rate limit headers are absent", () => {
    expect(extractQuotaPercent({})).toBeNull();
  });
});

describe("Ping Requests", () => {
  it("builds OpenAI-compatible probe body with disabled thinking toggle", () => {
    const pCfg: ProviderConfig = { base: "https://api.openai.com/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
    const req = buildPingRequest("openai", "gpt-4o", pCfg, "sk-key");
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers["authorization"]).toBe("Bearer sk-key");
    expect(req.body["thinking"]).toEqual({ type: "disabled" });
  });

  it("pings provider and extracts code and latency", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "x-ratelimit-remaining": "80", "x-ratelimit-limit": "100" },
      });

    const pCfg: ProviderConfig = { base: "https://api.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
    const res = await pingProviderModel("test", "model-a", pCfg, "sk-test", { fetchFn: mockFetch as any });

    expect(res.code).toBe("200");
    expect(res.quotaPercent).toBe(80);
    expect(res.ms).toBeGreaterThanOrEqual(0);
  });
});

describe("Probe Cache Persistence", () => {
  const tmpPath = join(tmpdir(), `probe-cache-test-${Date.now()}.json`);

  afterEach(() => {
    try { unlinkSync(tmpPath); } catch {}
  });

  it("tracks models due for probing based on TTL and status", () => {
    loadProbeCache({ path: tmpPath });
    const now = Date.now();

    recordProbeResult("prov1", "m1", { code: "200", ms: 100, quotaPercent: 90 }, { now, path: tmpPath });
    recordProbeResult("prov1", "m2", { code: "500", ms: 500, quotaPercent: null }, { now, path: tmpPath });

    const due = getModelsDueForProbe("prov1", ["m1", "m2", "m3"], { now, path: tmpPath });
    // m1 is fresh + ok (skipped), m2 is broken (always due), m3 is missing (due)
    expect(due).toEqual(["m2", "m3"]);
  });
});

describe("Runtime Telemetry", () => {
  const tmpPath = join(tmpdir(), `telemetry-test-${Date.now()}.json`);

  afterEach(() => {
    try { unlinkSync(tmpPath); } catch {}
  });

  it("records model calls and calculates real world scores", () => {
    for (let i = 0; i < 6; i++) {
      recordModelCall("prov1", "m1", { ok: true, latencyMs: 200, completionTokens: 50 }, { path: tmpPath });
    }
    const score = getRealWorldScore("prov1", "m1", { minCalls: 5, path: tmpPath });
    expect(score).not.toBeNull();
    expect(score).toBeGreaterThan(70);
  });
});

describe("PingLoop Cadence", () => {
  it("initializes in speed mode and steps through tickOnce", async () => {
    const pCfg: ProviderConfig = { base: "https://api.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
    const mockCatalog: ModelCatalog = {
      list: async () => ["model-1"],
    } as any;

    const mockFetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 });

    const loop = new PingLoop(testConfig({ testProv: pCfg }), mockCatalog, { fetchFn: mockFetch as any });
    expect(loop.getMode()).toBe("speed");

    await loop.tickOnce();
    const summary = loop.getModelSummary("testProv", "model-1");
    expect(summary.verdict).toBe("Perfect");
    expect(summary.lastPingCode).toBe("200");
  });
});

describe("Proxy Health Endpoints", () => {
  it("exposes /ping and /health/stats on proxy server", async () => {
    const pCfg: ProviderConfig = { base: "https://api.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
    const mockCatalog: ModelCatalog = {
      list: async () => ["m1"],
    } as any;

    const proxy = createProxy(testConfig({ testProv: pCfg }), { catalog: mockCatalog });
    
    // Start listening on dynamic port
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const address = proxy.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const pingResp = await fetch(`${baseUrl}/ping`);
      expect(pingResp.status).toBe(200);
      const pingData = await pingResp.json();
      expect(pingData.ok).toBe(true);

      const healthResp = await fetch(`${baseUrl}/health/stats`);
      expect(healthResp.status).toBe(200);
      const healthData = await healthResp.json();
      expect(healthData.providers).toBeDefined();
    } finally {
      proxy.close();
    }
  });
});
