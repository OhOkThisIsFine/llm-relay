import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getAvg, getP95, getJitter, getSpikeRate, getUptime, getStabilityScore, getVerdict, type PingRecord } from "../src/ping/metrics.js";
import { extractQuotaPercent, buildPingRequest, pingProviderModel } from "../src/ping/ping.js";
import {
  BROKEN_PROBE_BACKOFF_BASE_MS,
  loadProbeCache,
  flushProbeCache,
  recordProbeResult,
  getModelsDueForProbe,
} from "../src/ping/probe-cache.js";
import { recordModelCall, getRealWorldScore, loadRuntimeTelemetry } from "../src/ping/runtime-telemetry.js";
import { PingLoop, collectRoutableModels } from "../src/ping/cadence.js";
import { createProxy } from "../src/server.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";
import type { Config, ProviderConfig } from "../src/config.js";
import type { ModelCatalog } from "../src/catalog.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";

/**
 * A probe-cache path no other test shares.
 *
 * ⚠ Required now that probe results actually PERSIST. Two tests here use the same
 * `testProv/model-1`, and with a shared cache the second one silently stopped probing at all:
 * `getModelsDueForProbe` saw the first test's fresh `ok` entry and skipped the model, so the
 * summary came from the first test's history instead of this test's mock. State that survives
 * the process has to be owned per test.
 */
let probeCacheSeq = 0;
function isolatedProbeCache(): string {
  return join(tmpdir(), `llm-relay-ping-${process.pid}-${probeCacheSeq++}`, "probe-cache.json");
}

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
    // Four fast successes and then a 401 is NOT "Perfect": the latest probe is the provider
    // stating a fact about the credential, and it will say the same thing next time. `getVerdict`
    // now derives down-ness from the history itself rather than from a flag the caller passes, so
    // calling it bare no longer skips that check. The latency metrics above are unaffected — a
    // 401 still times the network path, which is why it stays in avg/p95/jitter.
    expect(getVerdict(pings)).toBe("Unstable");
    // ...whereas a transient 503 in the same position is weather, and must not disqualify it.
    const blip: PingRecord[] = [...pings.slice(0, 4), { ms: 500, code: "503", timestamp: 5 }];
    expect(getVerdict(blip)).toBe("Perfect");
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
    // m1 is fresh + ok, m2 is broken but in backoff, and m3 has never been measured.
    expect(due).toEqual(["m3"]);
    expect(getModelsDueForProbe("prov1", ["m2"], {
      now: now + BROKEN_PROBE_BACKOFF_BASE_MS,
      path: tmpPath,
    })).toEqual(["m2"]);
  });

  // A 401 used to be recorded as `ok` here on the theory that the endpoint answered. It made a
  // provider with a revoked key look available AND stopped it being re-probed.
  it("records a 401 as broken, not as ok", () => {
    loadProbeCache({ path: tmpPath });
    const now = Date.now();

    const entry = recordProbeResult("prov1", "unauthorised", { code: "401", ms: 40, quotaPercent: null }, { now, path: tmpPath });
    expect(entry.status).toBe("broken");

    expect(getModelsDueForProbe("prov1", ["unauthorised"], { now, path: tmpPath })).toEqual([]);
    expect(getModelsDueForProbe("prov1", ["unauthorised"], {
      now: now + BROKEN_PROBE_BACKOFF_BASE_MS,
      path: tmpPath,
    })).toEqual(["unauthorised"]);
  });

  it("backs repeated failures off exponentially and lets passive success reset freshness", () => {
    loadProbeCache({ path: tmpPath });
    const now = Date.now();
    recordProbeResult("prov1", "flaky", { code: "500", ms: 10, quotaPercent: null }, { now, path: tmpPath });
    recordProbeResult("prov1", "flaky", { code: "500", ms: 10, quotaPercent: null }, {
      now: now + BROKEN_PROBE_BACKOFF_BASE_MS,
      path: tmpPath,
    });

    const secondFailureAt = now + BROKEN_PROBE_BACKOFF_BASE_MS;
    expect(getModelsDueForProbe("prov1", ["flaky"], {
      now: secondFailureAt + BROKEN_PROBE_BACKOFF_BASE_MS,
      path: tmpPath,
    })).toEqual([]);
    expect(getModelsDueForProbe("prov1", ["flaky"], {
      now: secondFailureAt + 2 * BROKEN_PROBE_BACKOFF_BASE_MS,
      path: tmpPath,
    })).toEqual(["flaky"]);

    const passiveAt = secondFailureAt + 1;
    expect(getModelsDueForProbe("prov1", ["flaky"], {
      now: passiveAt + 1_000,
      path: tmpPath,
      lastSuccessfulCallAt: () => passiveAt,
    })).toEqual([]);

    expect(getModelsDueForProbe("prov1", ["never-probed"], {
      now: passiveAt + 1_000,
      path: tmpPath,
      lastSuccessfulCallAt: () => passiveAt,
    })).toEqual([]);
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
  // `recordPing` persists through `recordProbeResult` with no explicit path, which resolves to
  // ~/.llm-relay/probe-cache.json — the developer's real machine. Redirect the cache root and
  // re-prime the module-level handle so the whole describe writes into a temp dir instead.
  let cacheRoot: string;
  let priorXdg: string | undefined;

  beforeEach(() => {
    priorXdg = process.env.XDG_CACHE_HOME;
    cacheRoot = mkdtempSync(join(tmpdir(), "rp-pingloop-"));
    process.env.XDG_CACHE_HOME = cacheRoot;
    loadProbeCache();
  });

  afterEach(() => {
    if (priorXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = priorXdg;
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("initializes in speed mode and steps through tickOnce", async () => {
    const pCfg: ProviderConfig = { base: "https://api.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
    const mockCatalog: ModelCatalog = {
      list: async () => ["model-1"],
    } as any;

    const mockFetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 });

    const loop = new PingLoop(testConfig({ testProv: pCfg }), mockCatalog, { fetchFn: mockFetch as any, probeCachePath: isolatedProbeCache() });
    expect(loop.getMode()).toBe("speed");

    await loop.tickOnce();
    const summary = loop.getModelSummary("testProv", "model-1");
    expect(summary.verdict).toBe("Perfect");
    expect(summary.lastPingCode).toBe("200");
  });

  // The availability verdict used to exclude 401 alongside 200, so a provider whose key had
  // been revoked reported "Perfect" — while getUptime() on the same pings said 0%.
  it("reports a 401-only model as down, not Perfect", async () => {
    const pCfg: ProviderConfig = { base: "https://api.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
    const mockCatalog: ModelCatalog = { list: async () => ["model-1"] } as any;
    const mockFetch = async () => new Response("{}", { status: 401 });

    const loop = new PingLoop(testConfig({ testProv: pCfg }), mockCatalog, { fetchFn: mockFetch as any, probeCachePath: isolatedProbeCache() });
    await loop.tickOnce();

    const summary = loop.getModelSummary("testProv", "model-1");
    expect(summary.lastPingCode).toBe("401");
    expect(summary.verdict).not.toBe("Perfect");
    expect(summary.uptimePct).toBe(0);
  });

  it("background scope probes only materialized routes, with pool leaders first", async () => {
    const pCfg: ProviderConfig = { base: "https://api.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
    const cfg = testConfig({ testProv: pCfg });
    cfg.routing.default = "testProv/routed-second";
    cfg.routing.pools = {
      useful: ["testProv/pool-leader", "testProv/routed-second"],
    };
    const mockCatalog: ModelCatalog = {
      list: async () => ["pool-leader", "routed-second", "catalog-only"],
    } as any;
    const probed: string[] = [];
    const mockFetch = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      probed.push(body.model);
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    };

    expect(collectRoutableModels(cfg).get("testProv")).toEqual(["pool-leader", "routed-second"]);
    const loop = new PingLoop(cfg, mockCatalog, {
      fetchFn: mockFetch as typeof fetch,
      probeCachePath: isolatedProbeCache(),
    });
    await loop.tickOnce("routable");
    expect(probed).toEqual(["pool-leader", "routed-second"]);
    expect(probed).not.toContain("catalog-only");
  });
});

describe("Proxy Health Endpoints", () => {
  it("exposes /ping and /health/stats on proxy server", async () => {
    const controlToken = "ping-test-control-token";
    // Probe timeout must be well under the test timeout: /ping probes this fake
    // host live, and how fast the connect fails depends on the machine's DNS.
    const pCfg: ProviderConfig = { base: "https://api.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 1000 };
    const mockCatalog: ModelCatalog = {
      list: async () => ["m1"],
    } as any;

    const proxy = createProxy(testConfig({ testProv: pCfg }), {
      catalog: mockCatalog,
      controlAuthorization: { validate: (candidate) => candidate === controlToken },
    });
    
    // Start listening on dynamic port
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const address = proxy.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const pingResp = await fetch(`${baseUrl}/ping`, { headers: { [CONTROL_AUTHORIZATION_HEADER]: controlToken } });
      expect(pingResp.status).toBe(200);
      const pingData = (await pingResp.json()) as { ok: boolean };
      expect(pingData.ok).toBe(true);

      const healthResp = await fetch(`${baseUrl}/health/stats`, { headers: { [CONTROL_AUTHORIZATION_HEADER]: controlToken } });
      expect(healthResp.status).toBe(200);
      const healthData = (await healthResp.json()) as { providers?: unknown };
      expect(healthData.providers).toBeDefined();
    } finally {
      proxy.close();
    }
  });
});
