/**
 * Sustained-latency demotion. The interesting assertions here are the NEGATIVE ones: this term
 * reverses a rationale recorded in `server.ts` by owner decision, and every bound that made the
 * reversal safe is a case where it must do NOTHING. A test file that only proved it demotes would
 * be testing the easy half.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createProxy, type ProxyDeps } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import { LATENCY_DEMOTED_HEADER, SERVED_BY_HEADER } from "../src/backend.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { Config, ProviderConfig } from "../src/config.js";
import type { CircuitBreaker } from "../src/circuit-breaker.js";
import type { PingRecord } from "../src/ping/metrics.js";
import type { ResolvedAttempt } from "../src/resolved-attempt.js";
import {
  DEFAULT_LATENCY_MIN_SAMPLES,
  DEFAULT_LATENCY_P95_MS,
  createLatencyDemotionFn,
  latencyDemotionLabel,
  resolveLatencyDemotion,
} from "../src/latency-demotion.js";

/** Only `getDeploymentMeasurement` is reached, so only it is stubbed. */
function breakerWith(pings: PingRecord[]): CircuitBreaker {
  return {
    getDeploymentMeasurement: () => ({ pings, stabilityScore: null, minSamples: pings.length }),
  } as unknown as CircuitBreaker;
}

function attempt(provider = "nim", model = "deepseek-ai/deepseek-v4-flash"): ResolvedAttempt {
  return { target: { provider, model } } as unknown as ResolvedAttempt;
}

/** n samples at `ms`, all HTTP 200 — i.e. all MEASURABLE. */
function samples(n: number, ms: number, code = "200"): PingRecord[] {
  return Array.from({ length: n }, (_, i) => ({ ms, code, timestamp: 1000 + i }));
}

describe("latency demotion", () => {
  it("demotes a deployment whose measured p95 exceeds the ceiling", () => {
    // The case that motivated the module: measured 2026-08-30, breaker-CLOSED and 70364 ms.
    const d = resolveLatencyDemotion({ breaker: breakerWith(samples(12, 70364)) }, attempt());
    expect(d).not.toBeNull();
    expect(d?.p95Ms).toBe(70364);
    expect(d?.thresholdMs).toBe(DEFAULT_LATENCY_P95_MS);
    expect(d?.samples).toBe(12);
  });

  it("does NOTHING when the deployment is merely slow but under the ceiling", () => {
    // 23478 ms is the member that actually SERVED in that same window. The default ceiling is
    // calibrated to leave it alone, so this pins the calibration and not just the comparison.
    expect(resolveLatencyDemotion({ breaker: breakerWith(samples(12, 23478)) }, attempt())).toBeNull();
  });

  it("does NOTHING when there is no measurement at all", () => {
    // `getP95` answers Infinity here. Infinity is an UNMEASURED deployment, never an infinitely
    // slow one — treating it as slow would demote every never-probed member at once.
    expect(resolveLatencyDemotion({ breaker: breakerWith([]) }, attempt())).toBeNull();
  });

  it("does NOTHING on too few samples, however slow they are", () => {
    // The direct answer to the recorded objection: "live health then PROMOTES on evidence that is
    // often a single request's latency".
    const one = resolveLatencyDemotion({ breaker: breakerWith(samples(1, 600_000)) }, attempt());
    expect(one).toBeNull();
    const justUnder = resolveLatencyDemotion(
      { breaker: breakerWith(samples(DEFAULT_LATENCY_MIN_SAMPLES - 1, 600_000)) },
      attempt(),
    );
    expect(justUnder).toBeNull();
  });

  it("counts only MEASURABLE samples toward the floor, never the raw ping count", () => {
    // ⚠ The trap this pins: `getP95` measures 200/401 only, so a deployment with fifty 429s and
    // ONE slow 200 has a p95 of that single sample. Counting `pings.length` would clear the floor
    // at 51 and demote on one measurement — exactly the case the floor exists to exclude.
    const noisy = [...samples(50, 1, "429"), ...samples(1, 600_000)];
    expect(resolveLatencyDemotion({ breaker: breakerWith(noisy) }, attempt())).toBeNull();
  });

  it("ignores non-measurable codes when computing the figure", () => {
    // Same set, but now with enough real measurements. The 429s must not drag the p95 down.
    const mixed = [...samples(50, 1, "429"), ...samples(10, 70_000)];
    const d = resolveLatencyDemotion({ breaker: breakerWith(mixed) }, attempt());
    expect(d?.samples).toBe(10);
    expect(d?.p95Ms).toBe(70_000);
  });

  it("does NOTHING when the operator switched it off", () => {
    const slow = { breaker: breakerWith(samples(12, 70_364)) };
    expect(resolveLatencyDemotion({ ...slow, settings: { enabled: false } }, attempt())).toBeNull();
    // …and absent settings, or an empty object, mean every default — i.e. ON.
    expect(resolveLatencyDemotion(slow, attempt())).not.toBeNull();
    expect(resolveLatencyDemotion({ ...slow, settings: {} }, attempt())).not.toBeNull();
  });

  it("honours an operator ceiling and sample floor", () => {
    const slow = { breaker: breakerWith(samples(6, 9_000)) };
    expect(resolveLatencyDemotion(slow, attempt())).toBeNull();
    const d = resolveLatencyDemotion({ ...slow, settings: { p95Ms: 5_000 } }, attempt());
    expect(d?.thresholdMs).toBe(5_000);
    expect(resolveLatencyDemotion({ ...slow, settings: { p95Ms: 5_000, minSamples: 20 } }, attempt())).toBeNull();
  });

  it("never throws into the request path", () => {
    const exploding = {
      getDeploymentMeasurement: () => {
        throw new Error("breaker exploded");
      },
    } as unknown as CircuitBreaker;
    const fn = createLatencyDemotionFn({ breaker: exploding });
    expect(fn(attempt(), 1)).toBeNull();
  });

  it("asks about the DEPLOYMENT, passing null rather than undefined for an absent model", () => {
    // `ProviderDeploymentIdentity.model` is `string | null`. Handing it `undefined` would build an
    // identity matching no stored cell, so the lookup would return an empty measurement and the
    // whole term would silently never fire.
    let seen: unknown;
    const breaker = {
      getDeploymentMeasurement: (id: unknown) => {
        seen = id;
        return { pings: [], stabilityScore: null, minSamples: 0 };
      },
    } as unknown as CircuitBreaker;
    resolveLatencyDemotion({ breaker }, { target: { provider: "nim" } } as unknown as ResolvedAttempt);
    expect(seen).toEqual({ provider: "nim", model: null });
  });

  it("labels the demotion with the figure, the ceiling and the sample count", () => {
    const label = latencyDemotionLabel("nim/deepseek-ai/deepseek-v4-flash", {
      p95Ms: 70364,
      thresholdMs: 30000,
      samples: 12,
    });
    expect(label).toBe("nim/deepseek-ai/deepseek-v4-flash (p95 70364ms > 30000ms over 12 samples)");
  });
});

/**
 * End to end, on BOTH fronts. The unit tests above prove the resolver; this proves the term is
 * actually WIRED — that a slow member loses the lead in a real walk and that the displacement is
 * announced. Two candidates throughout: with one, "was demoted" and "had nowhere to go" are the
 * same observation, which is the trap `test/pool-failover.test.ts` exists to avoid.
 */
describe("latency demotion — end to end", () => {
  const servers: Server[] = [];
  const track = (s: Server): Server => (servers.push(s), s);
  const portOf = (s: Server): number => (s.address() as AddressInfo).port;

  beforeEach(() => {
    globalCircuitBreaker.reset();
    resetFacts();
    resetInterpretations();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    globalCircuitBreaker.reset();
    resetFacts();
    resetInterpretations();
  });

  function backend(body: string): Promise<{ server: Server; calls: () => number }> {
    let n = 0;
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          n += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(body);
        });
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n }));
    });
  }

  function okBody(kind: "anthropic" | "openai", model: string): string {
    return kind === "anthropic"
      ? JSON.stringify({ id: "msg", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })
      : JSON.stringify({ id: "cmpl", object: "chat.completion", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  }

  function poolCfg(bases: string[], kind: "anthropic" | "openai", latency?: unknown): Config {
    const providers: Record<string, ProviderConfig> = {};
    bases.forEach((base, i) => {
      providers[`p${i + 1}`] = { base, kind, authHeader: "authorization", timeoutMs: 5000 };
    });
    return {
      host: "127.0.0.1",
      port: 0,
      providers,
      routing: {
        default: "pool/coding",
        tiers: {},
        benchmarkSort: false,
        pools: { coding: bases.map((_, i) => `p${i + 1}/m${i + 1}`) },
        ...(latency === undefined ? {} : { latency: latency as never }),
      },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    } as Config;
  }

  function startProxy(c: Config, deps: ProxyDeps = {}): Promise<Server> {
    const s = createProxy(c, { catalog: new ModelCatalog({ cachePath: null }), breaker: globalCircuitBreaker, ...deps });
    return new Promise((r) => s.listen(0, "127.0.0.1", () => r(track(s))));
  }

  async function post(p: number, kind: "anthropic" | "openai"): Promise<Response> {
    const path = kind === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
    const body =
      kind === "anthropic"
        ? { model: "pool/coding", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }
        : { model: "pool/coding", messages: [{ role: "user", content: "hi" }] };
    return fetch(`http://127.0.0.1:${p}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * Teach the breaker that p1/m1 answers, but glacially. Successes, so nothing else demotes it.
   *
   * ⚠ The breaker keeps at most `MAX_PING_HISTORY` (10, `src/circuit-breaker.ts`) samples PER CELL
   * and shifts the oldest out, so seeding 12 leaves 10 — which is why the announcement below says
   * 10. Found by this test rather than by reading, and it bounds the feature: `minSamples` must
   * stay at or under 10 per cell or latency could never demote a single-credential deployment at
   * all. The default is 5. (`getDeploymentMeasurement` aggregates across a deployment's credential
   * cells, so a multi-credential deployment can exceed 10 in total.)
   */
  function seedSlow(provider: string, model: string, kind: "anthropic" | "openai", ms: number, n = 12): void {
    // ⚠ A full `ProviderTargetIdentity`, not just provider+model — `tsconfig.test.json` catches
    // the short literal, which is exactly the class of drift CLAUDE.md says the test typecheck
    // exists for. `kind` and `credentialId` play no part in the DEPLOYMENT lookup
    // (`getDeploymentMeasurement` matches provider+model across every credential cell), but a
    // fixture that states a shape the source does not have is a test asserting against fiction.
    for (let i = 0; i < n; i += 1) {
      globalCircuitBreaker.recordOutcome(
        { provider, model, kind, credentialId: `${provider}#default` },
        { ok: true, elapsedMs: ms, status: 200, at: 1000 + i },
      );
    }
  }

  it.each(["anthropic", "openai"] as const)(
    "a sustained slow p95 demotes candidate 1 behind candidate 2, and says so (%s front)",
    async (kind) => {
      const a = await backend(okBody(kind, "m1"));
      const b = await backend(okBody(kind, "m2"));
      seedSlow("p1", "m1", kind, 70_364);
      const p = portOf(await startProxy(poolCfg([
        `http://127.0.0.1:${portOf(a.server)}`,
        `http://127.0.0.1:${portOf(b.server)}`,
      ], kind)));

      const res = await post(p, kind);
      expect(res.status).toBe(200);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
      // 10, not the 12 seeded — see `seedSlow` on the breaker's per-cell history cap.
      expect(res.headers.get(LATENCY_DEMOTED_HEADER)).toBe("p1/m1 (p95 70364ms > 30000ms over 10 samples)");
      // Demoted, never DROPPED: it simply was not tried ahead of the live one.
      expect(a.calls()).toBe(0);
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "leaves the order alone when the measurement is under the ceiling (%s front)",
    async (kind) => {
      const a = await backend(okBody(kind, "m1"));
      const b = await backend(okBody(kind, "m2"));
      // 23478 ms is the member that actually SERVED in the measured window — it must keep the lead.
      seedSlow("p1", "m1", kind, 23_478);
      const p = portOf(await startProxy(poolCfg([
        `http://127.0.0.1:${portOf(a.server)}`,
        `http://127.0.0.1:${portOf(b.server)}`,
      ], kind)));

      const res = await post(p, kind);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");
      expect(res.headers.get(LATENCY_DEMOTED_HEADER)).toBeNull();
      expect(b.calls()).toBe(0);
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "an operator who switched it off keeps the pre-2026-08-30 order exactly (%s front)",
    async (kind) => {
      const a = await backend(okBody(kind, "m1"));
      const b = await backend(okBody(kind, "m2"));
      seedSlow("p1", "m1", kind, 70_364);
      const p = portOf(await startProxy(poolCfg([
        `http://127.0.0.1:${portOf(a.server)}`,
        `http://127.0.0.1:${portOf(b.server)}`,
      ], kind, { enabled: false })));

      const res = await post(p, kind);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");
      expect(res.headers.get(LATENCY_DEMOTED_HEADER)).toBeNull();
    },
  );
});
