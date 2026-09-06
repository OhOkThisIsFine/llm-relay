import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { getAvg, getP95, getJitter, getSpikeRate, getUptime, getStabilityScore, getVerdict, type PingRecord } from "../src/ping/metrics.js";
import { buildPingRequest, pingProviderModel } from "../src/ping/ping.js";
import {
  BROKEN_PROBE_BACKOFF_BASE_MS,
  loadProbeCache,
  recordProbeResult,
  getModelsDueForProbe,
} from "../src/ping/probe-cache.js";
import { recordModelCall, getRealWorldScore, loadRuntimeTelemetry } from "../src/ping/runtime-telemetry.js";
import { PingLoop, collectRoutableModels } from "../src/ping/cadence.js";
import { makeCredentialId } from "../src/credential-id.js";
import { recordFact, factsFor, resetFacts } from "../src/target-facts.js";
import { createProxy } from "../src/server.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";
import type { Config, ProviderConfig } from "../src/config.js";
import type { ModelCatalog } from "../src/catalog.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

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

    // Excellent latency, but one probe in five was a 401 — so availability is 80% and the score
    // cannot exceed 80. This used to assert `> 80` and passed at 91, because uptime was a 20%
    // additive term rather than the scale factor. The latency half is still near-perfect: the
    // score sits just under its 80% ceiling, not near the floor.
    const score = getStabilityScore(pings);
    expect(score).toBeLessThanOrEqual(getUptime(pings));
    expect(score).toBeGreaterThan(70);
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

  /**
   * The composite must never rank a deployment that mostly FAILS above one that always succeeds.
   *
   * `MEASURABLE_CODES` is a LATENCY set — 403/404/429/5xx leave p95, jitter and spike entirely —
   * so under the old additive shape (`0.3*p95 + 0.3*jitter + 0.2*spike + 0.2*uptime`) a failing
   * deployment kept a clean latency profile and paid only the 20% availability term. Measured on
   * this operator's live probe cache: `openrouter/x-ai/grok-build-0.1` at 1 success in 12 scored
   * **81**, while `gemini/models/gemini-3.5-flash` at 3 of 3 scored **27**; 27 deployments with
   * ZERO successes scored above 50. All four pools here are `{include: "free"}`, so this score
   * IS the pool order (`dynamic-pools.ts` -> `benchmarks.ts`).
   *
   * Availability now SCALES the composite instead of contributing a fifth of it, so a score can
   * never exceed what the deployment's success rate supports.
   */
  it("never ranks a mostly-failing deployment above an always-succeeding one", () => {
    // The grok shape: one fast success, then eleven 403s that the latency terms cannot see.
    const mostlyFailing: PingRecord[] = [
      { ms: 120, code: "200", timestamp: 1 },
      ...Array.from({ length: 11 }, (_, i) => ({ ms: 90, code: "403", timestamp: i + 2 })),
    ];
    // The gemini shape: every probe succeeded, but slowly.
    const alwaysSucceedingButSlow: PingRecord[] = [
      { ms: 4200, code: "200", timestamp: 1 },
      { ms: 4600, code: "200", timestamp: 2 },
      { ms: 4400, code: "200", timestamp: 3 },
    ];

    expect(getUptime(mostlyFailing)).toBe(8);
    expect(getUptime(alwaysSucceedingButSlow)).toBe(100);
    expect(getStabilityScore(alwaysSucceedingButSlow)).toBeGreaterThan(getStabilityScore(mostlyFailing));
  });

  it("caps a zero-success deployment below the midpoint, whatever its latency looked like", () => {
    // The `opencode/*` block: twelve 401s, fast. A 401 is a real latency sample and stays in the
    // latency terms deliberately — the network path WAS timed — but it is not availability, so
    // the multiplier is what stops a revoked key from reading as a healthy fast target.
    const allUnauthorized: PingRecord[] = Array.from({ length: 12 }, (_, i) => ({
      ms: 80,
      code: "401",
      timestamp: i + 1,
    }));
    expect(getUptime(allUnauthorized)).toBe(0);
    expect(getStabilityScore(allUnauthorized)).toBe(0);
  });

  /**
   * ⚠ The other face of the same defect. An all-402 deployment has NO measurable latency sample,
   * so the composite used to return -1, which every consumer maps to "unmeasured" and the ordering
   * maps to a NEUTRAL 50 — above the all-success gemini rows. Twelve consecutive 402s is evidence,
   * not absence of evidence. `-1` now means only "never probed".
   */
  it("distinguishes 'never probed' from 'probed and always failed'", () => {
    expect(getStabilityScore([])).toBe(-1);
    const allPaymentRequired: PingRecord[] = Array.from({ length: 12 }, (_, i) => ({
      ms: 70,
      code: "402",
      timestamp: i + 1,
    }));
    expect(getStabilityScore(allPaymentRequired)).toBe(0);
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


describe("Ping Requests", () => {
  it("builds OpenAI-compatible probe body with disabled thinking toggle", () => {
    const pCfg: ProviderConfig = { base: "https://api.openai.com/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
    const req = buildPingRequest("openai", "gpt-4o", pCfg, "sk-key");
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers["authorization"]).toBe("Bearer sk-key");
    expect(req.body["thinking"]).toEqual({ type: "disabled" });
  });

  it("pings provider and extracts every typed quota axis", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: {
          "x-ratelimit-remaining-requests-day": "80",
          "x-ratelimit-limit-requests-day": "100",
          "x-ratelimit-remaining-tokens-minute": "800",
          "x-ratelimit-limit-tokens-minute": "1000",
        },
      });

    const pCfg: ProviderConfig = { base: "https://api.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
    const res = await pingProviderModel("test", "model-a", pCfg, "sk-test", { fetchFn: mockFetch as any });

    expect(res.code).toBe("200");
    expect(res.quotaObservations.map(({ axis, period, remaining, limit }) => ({ axis, period, remaining, limit })))
      .toEqual([
        { axis: "requests", period: "day", remaining: 80, limit: 100 },
        { axis: "tokens", period: "minute", remaining: 800, limit: 1000 },
      ]);
    expect(res.ms).toBeGreaterThanOrEqual(0);
  });

  it("reports a redirect without following it or forwarding probe credentials", async () => {
    let redirectTargetHits = 0;
    const redirectTarget = createServer((_req, response) => {
      redirectTargetHits++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const redirectingBackend = createServer((_req, response) => {
      const targetPort = (redirectTarget.address() as AddressInfo).port;
      response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/credential-target` });
      response.end();
    });
    const listen = (server: Server) => new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const close = (server: Server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });

    await listen(redirectTarget);
    await listen(redirectingBackend);
    try {
      const backendPort = (redirectingBackend.address() as AddressInfo).port;
      const pCfg: ProviderConfig = {
        base: `http://127.0.0.1:${backendPort}/v1`,
        kind: "openai",
        authHeader: "x-api-key",
        timeoutMs: 5000,
      };

      const result = await pingProviderModel("test", "model-a", pCfg, "secret-key");

      expect(result.code).toBe("302");
      expect(result.code).not.toBe("200");
      expect(redirectTargetHits).toBe(0);
    } finally {
      await Promise.all([close(redirectingBackend), close(redirectTarget)]);
    }
  });

  describe("response body cancellation", () => {
    it("cancels the body on the success path", async () => {
      const pCfg: ProviderConfig = { base: "https://api.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
      let cancelCalls = 0;
      let lastCancelPath: string | null = null;

      // Helper to create a stream that stays open until cancelled
      function makeStream(onCancel: () => void) {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{}"));
            // Don't close - leave stream open so cancel() gets called
          },
          cancel() {
            onCancel();
          },
        });
      }

      const mockFetch = async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.model === "success-model") {
          return new Response(makeStream(() => { cancelCalls++; lastCancelPath = "success"; }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      };

      // Success path
      cancelCalls = 0;
      lastCancelPath = null;
      const res1 = await pingProviderModel("test", "success-model", pCfg, "sk-test", { fetchFn: mockFetch as any, timeoutMs: 1000 });
      expect(res1.code).toBe("200");
      expect(cancelCalls).toBe(1);
      expect(lastCancelPath).toBe("success");
    });

    it("cancels the body on the non-2xx path", async () => {
      const pCfg: ProviderConfig = { base: "https://api.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
      let cancelCalls = 0;
      let lastCancelPath: string | null = null;

      function makeStream(onCancel: () => void) {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{}"));
          },
          cancel() {
            onCancel();
          },
        });
      }

      const mockFetch = async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.model === "error-model") {
          return new Response(makeStream(() => { cancelCalls++; lastCancelPath = "error"; }), { status: 500 });
        }
        return new Response("{}", { status: 200 });
      };

      // Non-2xx path
      cancelCalls = 0;
      lastCancelPath = null;
      const res2 = await pingProviderModel("test", "error-model", pCfg, "sk-test", { fetchFn: mockFetch as any, timeoutMs: 1000 });
      expect(res2.code).toBe("500");
      expect(cancelCalls).toBe(1);
      expect(lastCancelPath).toBe("error");
    });

    it("cancels the body on the disabled-thinking retry path (second response body)", async () => {
      const pCfg: ProviderConfig = { base: "https://api.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
      let cancelCalls = 0;
      let lastCancelPath: string | null = null;

      function makeStream(bodyText: string, onCancel: () => void) {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(bodyText));
            controller.close();
          },
          cancel() {
            onCancel();
          },
        });
      }

      const mockFetch = async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.model === "retry-model" && body.thinking) {
          // First request with thinking enabled - returns 400 with "thinking" in body
          // This body is fully consumed by isDisabledThinkingRejected via clone().text(),
          // so cancelling it afterwards is a no-op (stream already closed).
          return new Response(
            makeStream('{"error":"thinking not supported"}', () => { cancelCalls++; lastCancelPath = "retry-first"; }),
            { status: 400 }
          );
        }
        // Second request after retry (no thinking) - body is never read, only headers.
        // This body SHOULD be cancelled.
        return new Response(makeStream("{}", () => { cancelCalls++; lastCancelPath = "retry-second"; }), { status: 200 });
      };

      // Disabled-thinking retry path: first response body consumed by clone().text(),
      // second response body cancelled because never read.
      cancelCalls = 0;
      lastCancelPath = null;
      const res3 = await pingProviderModel("test", "retry-model", pCfg, "sk-test", { fetchFn: mockFetch as any, timeoutMs: 1000 });
      expect(res3.code).toBe("200");
      expect(cancelCalls).toBe(1); // only the second (served) response body is cancellable
      expect(lastCancelPath).toBe("retry-second");
    });

    it("a throwing cancel() still yields the normal result", async () => {
      const pCfg: ProviderConfig = { base: "https://api.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
      let cancelCalled = false;

      function makeThrowingStream() {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{}"));
            // Don't close - leave stream open
          },
          cancel() {
            cancelCalled = true;
            throw new Error("cancel failed");
          },
        });
      }

      const mockFetch = async () => {
        return new Response(makeThrowingStream(), { status: 200 });
      };

      const res = await pingProviderModel("test", "model-a", pCfg, "sk-test", { fetchFn: mockFetch as any });
      expect(res.code).toBe("200");
      expect(cancelCalled).toBe(true); // cancel was attempted
    });
  });
});

describe("Probe Cache Persistence", () => {
  const tmpPath = join(tmpdir(), `probe-cache-test-${Date.now()}.json`);

  afterEach(() => {
    rmSync(tmpPath, { force: true });
  });

  it("tracks models due for probing based on TTL and status", () => {
    loadProbeCache({ path: tmpPath });
    const now = Date.now();

    recordProbeResult("prov1", "m1", { code: "200", ms: 100, quotaObservations: [] }, { now, path: tmpPath });
    recordProbeResult("prov1", "m2", { code: "500", ms: 500, quotaObservations: [] }, { now, path: tmpPath });

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

    const entry = recordProbeResult("prov1", "unauthorised", { code: "401", ms: 40, quotaObservations: [] }, { now, path: tmpPath });
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
    recordProbeResult("prov1", "flaky", { code: "500", ms: 10, quotaObservations: [] }, { now, path: tmpPath });
    recordProbeResult("prov1", "flaky", { code: "500", ms: 10, quotaObservations: [] }, {
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
    rmSync(tmpPath, { force: true });
  });

  it("records model calls and calculates real world scores", () => {
    for (let i = 0; i < 6; i++) {
      recordModelCall("prov1", "m1", { ok: true, latencyMs: 200, completionTokens: 50 }, { path: tmpPath });
    }
    const score = getRealWorldScore("prov1", "m1", { minCalls: 5, path: tmpPath });
    expect(score).not.toBeNull();
    expect(score).toBeGreaterThan(70);
  });

  it("counts reported zero as covered, but missing usage as uncovered", () => {
    recordModelCall("prov-zero", "m1", { ok: true, latencyMs: 10, completionTokens: 0 }, { path: tmpPath });
    recordModelCall("prov-zero", "m1", { ok: true, latencyMs: 10 }, { path: tmpPath });
    const model = loadRuntimeTelemetry({ path: tmpPath, reload: true }).models["prov-zero/m1"]!;
    expect(model.totalCalls).toBe(2);
    expect(model.totalCompletionTokens).toBe(0);
    expect(model.completionTokenCalls).toBe(1);
  });

  it("migrates valid v1 call data while resetting unwired token totals", () => {
    writeFileSync(tmpPath, JSON.stringify({
      version: 1,
      models: {
        "prov-v1/m1": {
          providerKey: "prov-v1", modelId: "m1", totalCalls: 2, successCalls: 1,
          totalLatencyMs: 30, totalCompletionTokens: 999, lastCalledAt: 10,
          recentCalls: [{ timestamp: 10, ok: true, latencyMs: 15, tokens: "legacy-corrupt" }],
        },
      },
    }));
    const data = loadRuntimeTelemetry({ path: tmpPath, reload: true });
    expect(data.version).toBe(2);
    expect(data.models["prov-v1/m1"]).toMatchObject({ totalCalls: 2, successCalls: 1, totalLatencyMs: 30, totalCompletionTokens: 0, completionTokenCalls: 0 });
    expect(data.models["prov-v1/m1"]?.recentCalls).toHaveLength(1);
    recordModelCall("prov-v1", "m1", { ok: true, latencyMs: 1, completionTokens: 4 }, { path: tmpPath });
    expect(JSON.parse(readFileSync(tmpPath, "utf8")).version).toBe(2);
  });

  it("drops malformed telemetry rows and counters without throwing", () => {
    writeFileSync(tmpPath, JSON.stringify({
      version: 2,
      models: {
        good: {
          providerKey: "p", modelId: "m", totalCalls: 1, successCalls: 1, totalLatencyMs: 2,
          totalCompletionTokens: 0, completionTokenCalls: 1, lastCalledAt: 3,
          recentCalls: [{ timestamp: 3, ok: true, latencyMs: 2 }, { timestamp: "bad", ok: true, latencyMs: 2 }],
        },
        bad: { providerKey: "p", modelId: "bad", totalCalls: -1, successCalls: 0, totalLatencyMs: 0, totalCompletionTokens: 0, completionTokenCalls: 0, lastCalledAt: 0, recentCalls: [] },
      },
    }));
    const data = loadRuntimeTelemetry({ path: tmpPath, reload: true });
    expect(data.version).toBe(2);
    expect(data.models.good?.recentCalls).toHaveLength(1);
    expect(data.models.bad).toBeUndefined();
  });

  it("rejects finite timestamps outside the JavaScript Date range", () => {
    writeFileSync(tmpPath, JSON.stringify({
      version: 2,
      models: {
        huge: {
          providerKey: "p", modelId: "huge", totalCalls: 1, successCalls: 1, totalLatencyMs: 2,
          totalCompletionTokens: 0, completionTokenCalls: 0, lastCalledAt: Number.MAX_VALUE,
          recentCalls: [{ timestamp: Number.MAX_VALUE, ok: true, latencyMs: 2 }],
        },
      },
    }));
    const data = loadRuntimeTelemetry({ path: tmpPath, reload: true });
    expect(data.models.huge).toBeUndefined();
  });

  it("ignores invalid recorder timing inputs without creating telemetry rows", () => {
    const invalid = [
      { model: "negative-latency", result: { ok: false, latencyMs: -1 }, now: 1 },
      { model: "nan-latency", result: { ok: false, latencyMs: Number.NaN }, now: 1 },
      { model: "infinite-latency", result: { ok: false, latencyMs: Number.POSITIVE_INFINITY }, now: 1 },
      { model: "negative-time", result: { ok: false, latencyMs: 1 }, now: -1 },
      { model: "nan-time", result: { ok: false, latencyMs: 1 }, now: Number.NaN },
      { model: "infinite-time", result: { ok: false, latencyMs: 1 }, now: Number.POSITIVE_INFINITY },
      { model: "out-of-date-time", result: { ok: false, latencyMs: 1 }, now: 8_640_000_000_000_001 },
    ];
    for (const row of invalid) recordModelCall("invalid", row.model, row.result, { path: tmpPath, now: row.now });
    const data = loadRuntimeTelemetry({ path: tmpPath, reload: true });
    expect(Object.keys(data.models).filter((key) => key.startsWith("invalid/"))).toEqual([]);
  });

  it("keeps saturated counters and latency aggregates within the persisted v2 schema", () => {
    writeFileSync(tmpPath, JSON.stringify({
      version: 2,
      models: {
        "limits/calls": {
          providerKey: "limits", modelId: "calls",
          totalCalls: Number.MAX_SAFE_INTEGER, successCalls: Number.MAX_SAFE_INTEGER,
          totalLatencyMs: Number.MAX_VALUE,
          totalCompletionTokens: Number.MAX_SAFE_INTEGER,
          completionTokenCalls: Number.MAX_SAFE_INTEGER,
          lastCalledAt: 1, recentCalls: [],
        },
        "limits/latency": {
          providerKey: "limits", modelId: "latency",
          totalCalls: 1, successCalls: 1, totalLatencyMs: Number.MAX_VALUE,
          totalCompletionTokens: Number.MAX_SAFE_INTEGER - 1, completionTokenCalls: 0,
          lastCalledAt: 1, recentCalls: [],
        },
      },
    }));
    loadRuntimeTelemetry({ path: tmpPath, reload: true });

    recordModelCall("limits", "calls", { ok: true, latencyMs: 1, completionTokens: 1 }, { path: tmpPath, now: 2 });
    recordModelCall("limits", "latency", { ok: true, latencyMs: Number.MAX_VALUE, completionTokens: 2 }, { path: tmpPath, now: 2 });

    const data = loadRuntimeTelemetry({ path: tmpPath, reload: true });
    expect(data.models["limits/calls"]).toMatchObject({
      totalCalls: Number.MAX_SAFE_INTEGER,
      successCalls: Number.MAX_SAFE_INTEGER,
      totalCompletionTokens: Number.MAX_SAFE_INTEGER,
      completionTokenCalls: Number.MAX_SAFE_INTEGER,
    });
    expect(data.models["limits/latency"]).toMatchObject({
      totalCalls: 2,
      successCalls: 2,
      totalLatencyMs: Number.MAX_VALUE,
      totalCompletionTokens: Number.MAX_SAFE_INTEGER - 1,
      completionTokenCalls: 0,
    });
  });
});

describe("PingLoop Cadence", () => {
  // `recordPing` persists through `recordProbeResult` with no explicit path, which resolves to
  // ~/.llm-relay/probe-cache.json — the developer's real machine. Redirect the cache root and
  // re-prime the module-level handle so the whole describe writes into a temp dir instead.
  let cacheRoot: string;
  let priorXdg: string | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    priorXdg = process.env.XDG_CACHE_HOME;
    cacheRoot = mkdtempSync(join(tmpdir(), "rp-pingloop-"));
    process.env.XDG_CACHE_HOME = cacheRoot;
    loadProbeCache();
  });

  afterEach(() => {
    vi.useRealTimers();
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
    let resolveProbed!: () => void;
    const probeDone = new Promise<void>((resolve) => {
      resolveProbed = resolve;
    });
    const mockFetch = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      probed.push(body.model);
      if (probed.length >= 2) resolveProbed();
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    };

    expect(collectRoutableModels(cfg).get("testProv")).toEqual(["pool-leader", "routed-second"]);
    const loop = new PingLoop(cfg, mockCatalog, {
      fetchFn: mockFetch as typeof fetch,
      probeCachePath: isolatedProbeCache(),
    });
    await loop.tickOnce("routable");
    await probeDone;
    expect(probed).toEqual(["pool-leader", "routed-second"]);
    expect(probed).not.toContain("catalog-only");
  });

  it("⚠ a direct tickOnce call NEVER fires the lane-cadence hook — only the self-scheduled loop does", async () => {
    // The 2026-08-30 closeout audit caught the leak this pins: the admitted GET /ping route
    // calls tickOnce directly, so a hook inside tickOnce let an HTTP request initiate lane
    // work — crossing the "request path never spawns a lane" boundary. The hook now fires only
    // from start()'s own loop iteration.
    const mockCatalog: ModelCatalog = { list: async () => [] } as any;
    let fired = 0;
    const loop = new PingLoop(testConfig({}), mockCatalog, {
      probeCachePath: isolatedProbeCache(),
      onTick: () => {
        fired++;
      },
    });
    await loop.tickOnce();
    await loop.tickOnce("routable");
    expect(fired).toBe(0);

    // start()'s first iteration runs synchronously up to its first await, and the hook fires
    // before the tick — one firing, then stop() before the timer re-arms.
    loop.start();
    expect(fired).toBe(1);
    loop.stop();
  });

  it("keeps quota isolated by exact credential and model", () => {
    const loop = new PingLoop(testConfig({}), {} as ModelCatalog, { probeCachePath: isolatedProbeCache() });
    const personal = makeCredentialId("testProv");
    const work = makeCredentialId("testProv", "work");
    const requestsDay = [{
      axis: "requests" as const,
      period: "day" as const,
      limit: 100,
      remaining: 25,
      resetsAt: null,
      observedAt: 1,
      basis: "provider-stated" as const,
    }];
    const tokensMinute = [{
      axis: "tokens" as const,
      period: "minute" as const,
      limit: 1000,
      remaining: 800,
      resetsAt: null,
      observedAt: 2,
      basis: "provider-stated" as const,
    }];

    loop.recordPing("testProv", "model-a", { code: "200", ms: 1, quotaObservations: requestsDay }, 1, personal);
    loop.recordPing("testProv", "model-a", { code: "200", ms: 1, quotaObservations: tokensMinute }, 2, work);
    loop.recordPing("testProv", "model-b", { code: "200", ms: 1, quotaObservations: tokensMinute }, 3, personal);

    expect(loop.getQuotaObservations(personal, "model-a")).toEqual(requestsDay);
    expect(loop.getQuotaObservations(work, "model-a")).toEqual(tokensMinute);
    expect(loop.getQuotaObservations(personal, "model-b")).toEqual(tokensMinute);
    expect(loop.getQuotaObservations(work, "model-b")).toEqual([]);
  });

  /**
   * The background probe is a REAL completion, so its success is the same first-party evidence a
   * served request is. Before 2026-08-30 `clearFacts` had exactly ONE caller (`server.ts`), so a
   * long-window `allowance-exhausted` fact survived its whole window unless real traffic happened
   * to reach the demoted candidate — which made an operator-asserted multi-day reset unsafe to
   * record, because nothing could retract it early.
   */
  describe("probe success retracts cooling facts", () => {
    beforeEach(() => resetFacts());
    afterEach(() => resetFacts());

    const slot = makeCredentialId("testProv");
    const newLoop = () =>
      new PingLoop(testConfig({}), {} as ModelCatalog, { probeCachePath: isolatedProbeCache() });

    it("clears a credential-scoped allowance-exhausted on a 200", () => {
      recordFact("allowance-exhausted", { kind: "credential", provider: "testProv", credentialId: slot });
      expect(factsFor("testProv", slot, "model-a").map((f) => f.kind)).toContain("allowance-exhausted");

      newLoop().recordPing("testProv", "model-a", { code: "200", ms: 1, quotaObservations: [] }, 1, slot);

      expect(factsFor("testProv", slot, "model-a").map((f) => f.kind)).not.toContain("allowance-exhausted");
    });

    // Negative control. Without it, a test that only asserts the clearing would still pass on an
    // implementation that cleared unconditionally — which would retract a live condition every
    // time the probe FAILED, the exact inverse of the intent.
    it("leaves the fact intact when the probe did not answer 200", () => {
      recordFact("allowance-exhausted", { kind: "credential", provider: "testProv", credentialId: slot });

      newLoop().recordPing("testProv", "model-a", { code: "429", ms: 1, quotaObservations: [] }, 1, slot);

      expect(factsFor("testProv", slot, "model-a").map((f) => f.kind)).toContain("allowance-exhausted");
    });

    // Second negative control: a success disproves a CONDITION, never a MEASUREMENT.
    it("never retracts a measurement", () => {
      recordFact("max-output", { kind: "deployment", provider: "testProv", model: "model-a" }, { value: 4096 });

      newLoop().recordPing("testProv", "model-a", { code: "200", ms: 1, quotaObservations: [] }, 1, slot);

      expect(factsFor("testProv", slot, "model-a").map((f) => f.kind)).toContain("max-output");
    });

    // Scope containment: a probe of one credential must not speak for another's allowance.
    it("does not clear another credential's fact", () => {
      const other = makeCredentialId("testProv", "work");
      recordFact("allowance-exhausted", { kind: "credential", provider: "testProv", credentialId: other });

      newLoop().recordPing("testProv", "model-a", { code: "200", ms: 1, quotaObservations: [] }, 1, slot);

      expect(factsFor("testProv", other, "model-a").map((f) => f.kind)).toContain("allowance-exhausted");
    });
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

describe("real-world score freshness (adoption review §1.10)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-rt-window-"));
  const path = join(dir, "runtime-telemetry.json");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("a model that degrades today cannot hide behind its lifetime average", () => {
    // 60 good calls, then 50 recent failures: the lifetime success rate is still ~55%, but the
    // rolling window — which is what the score now reads — is all failures.
    for (let i = 0; i < 60; i++) recordModelCall("prov", "m", { ok: true, latencyMs: 200 }, { path });
    for (let i = 0; i < 50; i++) recordModelCall("prov", "m", { ok: false, latencyMs: 200 }, { path });

    const score = getRealWorldScore("prov", "m", { minCalls: 5, path });
    expect(score).not.toBeNull();
    // Lifetime-average scoring put this at ~72; windowed scoring collapses the success term.
    expect(score!).toBeLessThan(45);
  });

  it("…and recovers just as fast when the window refills with successes", () => {
    for (let i = 0; i < 50; i++) recordModelCall("prov", "m", { ok: true, latencyMs: 200 }, { path });
    const score = getRealWorldScore("prov", "m", { minCalls: 5, path });
    expect(score!).toBeGreaterThan(70);
  });
});
