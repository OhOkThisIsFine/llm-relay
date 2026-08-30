/**
 * Sustained-latency demotion. The interesting assertions here are the NEGATIVE ones: this term
 * reverses a rationale recorded in `server.ts` by owner decision, and every bound that made the
 * reversal safe is a case where it must do NOTHING. A test file that only proved it demotes would
 * be testing the easy half.
 *
 * The sharpest claim is that PROBE samples never reach the per-token statistic. A probe asks for
 * one token, so its ms/token is nearly all fixed overhead; letting one into the rate would demote
 * healthy deployments on arithmetic, not on evidence.
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
import type { PingLoop } from "../src/ping/cadence.js";
import type { Config, ProviderConfig } from "../src/config.js";
import { countMsPerTokenSamples, getP95MsPerToken, type PingRecord } from "../src/ping/metrics.js";
import type { ResolvedAttempt } from "../src/resolved-attempt.js";
import {
  DEFAULT_LATENCY_MIN_SAMPLES,
  DEFAULT_LATENCY_MS_PER_TOKEN,
  DEFAULT_LATENCY_P95_MS,
  createLatencyDemotionFn,
  latencyDemotionLabel,
  resolveLatencyDemotion,
} from "../src/latency-demotion.js";

/** The whole seam: a function from (provider, model) to samples. */
function reader(pings: PingRecord[]): (p: string, m: string) => readonly PingRecord[] {
  return () => pings;
}

function attempt(provider = "nim", model = "deepseek-ai/deepseek-v4-flash"): ResolvedAttempt {
  return { target: { provider, model } } as unknown as ResolvedAttempt;
}

/** n PROBE samples at `ms` — no token count, so they can never reach the per-token statistic. */
function probes(n: number, ms: number, code = "200"): PingRecord[] {
  return Array.from({ length: n }, (_, i) => ({ ms, code, timestamp: 1000 + i }));
}

/** n REQUEST samples, each generating `tokens` output tokens in `ms`. */
function requests(n: number, ms: number, tokens: number, code = "200"): PingRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    ms,
    code,
    timestamp: 2000 + i,
    tokens,
    source: "request" as const,
  }));
}

/**
 * The two per-token statistics, tested DIRECTLY.
 *
 * WARNING: these exist because an independent auditor mutation-checked the module and found the
 * `source !== "request"` guard was NOT pinned by anything. Every probe fixture in this file lacks a
 * token count, so the separate `tokens > 0` check already excluded them and the source guard could
 * be deleted with the whole suite still green. Worse, the two guards live in two functions that
 * shield each other through `resolveLatencyDemotion`: mutating either one alone is absorbed, so no
 * end-to-end test can pin them. Only a direct test of each function can.
 *
 * Production probes never carry a token count today, so nothing was broken - but the module's
 * sharpest claim was resting on an accident of the fixtures rather than on the code.
 */
describe("per-token statistics — the guards, pinned one at a time", () => {
  /** A probe that DOES carry a token count. Nothing writes this today; the guard is why. */
  const probeWithTokens: PingRecord[] = Array.from({ length: 20 }, (_, i) => ({
    ms: 5_000,
    code: "200",
    timestamp: 1_000 + i,
    tokens: 1,
  }));

  it("getP95MsPerToken excludes a probe sample even when it carries a token count", () => {
    // 5000 ms for 1 token would read as 5000 ms/token - catastrophic, and pure fixed overhead.
    // Admitting it would demote every healthy deployment that has probe history.
    expect(getP95MsPerToken(probeWithTokens)).toBe(Number.POSITIVE_INFINITY);
  });

  it("countMsPerTokenSamples excludes it too, so the sample floor cannot be widened by probes", () => {
    // The count and the statistic MUST agree. A count over a wider set is exactly how a floor
    // comes to admit a figure resting on too few real measurements.
    expect(countMsPerTokenSamples(probeWithTokens)).toBe(0);
  });

  it("both accept a request sample, so the guards are not simply rejecting everything", () => {
    // The negative control for the two assertions above.
    const real: PingRecord[] = Array.from({ length: 6 }, (_, i) => ({
      ms: 5_000,
      code: "200",
      timestamp: 2_000 + i,
      tokens: 1,
      source: "request" as const,
    }));
    expect(countMsPerTokenSamples(real)).toBe(6);
    expect(getP95MsPerToken(real)).toBe(5_000);
  });
});

describe("latency demotion — per-token, the primary signal", () => {
  it("demotes a deployment whose measured ms/token exceeds the ceiling", () => {
    // The measured case: gemini-3.6-flash ran a median 687.8 ms/token on 2026-08-30.
    const d = resolveLatencyDemotion({ readPings: reader(requests(8, 68_780, 100)) }, attempt());
    expect(d?.basis).toBe("per-token");
    expect(d?.measured).toBeCloseTo(687.8, 1);
    expect(d?.threshold).toBe(DEFAULT_LATENCY_MS_PER_TOKEN);
    expect(d?.samples).toBe(8);
  });

  it("does NOTHING for a deployment that is slow in total but fast per token", () => {
    // 40 s of wall time, but 1000 tokens — 40 ms/token, the healthy band. This is the whole point
    // of measuring per token: absolute latency alone would demote a member that is working well
    // and merely answered a long question.
    const d = resolveLatencyDemotion({ readPings: reader(requests(8, 40_000, 1000)) }, attempt());
    expect(d).toBeNull();
  });

  it("NEVER lets a probe sample into the per-token rate", () => {
    // ⚠ The sharpest claim in this module. A probe asks for one token, so if a probe were admitted
    // with an assumed token count of 1 its rate would be its whole round-trip — 5000 ms/token here
    // — and every healthy deployment with probe history would be demoted instantly.
    const mixed = [...probes(20, 5_000), ...requests(8, 4_000, 100)];
    const d = resolveLatencyDemotion({ readPings: reader(mixed) }, attempt());
    // 4000/100 = 40 ms/token: healthy. The 20 probes at 5000 ms must not change that.
    expect(d).toBeNull();
  });

  it("does NOTHING on too few request samples, however slow they are", () => {
    // The direct answer to the recorded objection about acting on one request's latency.
    expect(resolveLatencyDemotion({ readPings: reader(requests(1, 600_000, 1)) }, attempt())).toBeNull();
    const justUnder = requests(DEFAULT_LATENCY_MIN_SAMPLES - 1, 600_000, 1);
    expect(resolveLatencyDemotion({ readPings: reader(justUnder) }, attempt())).toBeNull();
  });

  it("ignores request samples with no reported token count", () => {
    // Unknown is never zero. Such a sample still measures absolute latency, but it cannot say
    // anything about throughput, so it must not be counted toward the per-token floor.
    const noTokens: PingRecord[] = Array.from({ length: 8 }, (_, i) => ({
      ms: 90_000,
      code: "200",
      timestamp: 3000 + i,
      source: "request" as const,
    }));
    const d = resolveLatencyDemotion({ readPings: reader(noTokens) }, attempt());
    // It falls through to the ABSOLUTE ceiling, which 90 s does exceed.
    expect(d?.basis).toBe("absolute");
  });

  it("honours an operator ms/token ceiling", () => {
    const fast = { readPings: reader(requests(8, 4_000, 100)) }; // 40 ms/token
    expect(resolveLatencyDemotion(fast, attempt())).toBeNull();
    const d = resolveLatencyDemotion({ ...fast, settings: { msPerToken: 20 } }, attempt());
    expect(d?.basis).toBe("per-token");
    expect(d?.threshold).toBe(20);
  });
});

describe("latency demotion — absolute fallback", () => {
  it("fires when there are no request samples at all", () => {
    const d = resolveLatencyDemotion({ readPings: reader(probes(12, 70_364)) }, attempt());
    expect(d?.basis).toBe("absolute");
    expect(d?.measured).toBe(70_364);
    expect(d?.threshold).toBe(DEFAULT_LATENCY_P95_MS);
    expect(d?.samples).toBe(12);
  });

  it("does NOTHING when the deployment is merely slow but under the ceiling", () => {
    // 23478 ms is the member that actually SERVED in the measured window. The default ceiling is
    // calibrated to leave it alone, so this pins the calibration and not just the comparison.
    expect(resolveLatencyDemotion({ readPings: reader(probes(12, 23_478)) }, attempt())).toBeNull();
  });

  it("does NOTHING when there is no measurement at all", () => {
    // `getP95` answers Infinity here. Infinity is an UNMEASURED deployment, never an infinitely
    // slow one — treating it as slow would demote every never-probed member at once.
    expect(resolveLatencyDemotion({ readPings: reader([]) }, attempt())).toBeNull();
  });

  it("counts only MEASURABLE samples toward the floor, never the raw ping count", () => {
    // Fifty 429s and one slow 200: counting raw length would clear a floor of 5 on the strength of
    // a single measurement, which is exactly what the floor exists to exclude.
    const noisy = [...probes(50, 1, "429"), ...probes(1, 600_000)];
    expect(resolveLatencyDemotion({ readPings: reader(noisy) }, attempt())).toBeNull();
  });
});

describe("latency demotion — bounds and safety", () => {
  it("does NOTHING when the operator switched it off", () => {
    const slow = { readPings: reader(probes(12, 70_364)) };
    expect(resolveLatencyDemotion({ ...slow, settings: { enabled: false } }, attempt())).toBeNull();
    // …and absent settings, or an empty object, mean every default — i.e. ON.
    expect(resolveLatencyDemotion(slow, attempt())).not.toBeNull();
    expect(resolveLatencyDemotion({ ...slow, settings: {} }, attempt())).not.toBeNull();
  });

  it("gives no opinion when the target has no model", () => {
    // No model means no deployment key, so there are no samples to read. It must not fall back to
    // some provider-wide figure — that would attribute one model's slowness to its siblings.
    const d = resolveLatencyDemotion(
      { readPings: reader(probes(12, 600_000)) },
      { target: { provider: "nim" } } as unknown as ResolvedAttempt,
    );
    expect(d).toBeNull();
  });

  it("never throws into the request path", () => {
    const fn = createLatencyDemotionFn({
      readPings: () => {
        throw new Error("probe cache exploded");
      },
    });
    expect(fn(attempt(), 1)).toBeNull();
  });

  it("labels each basis in its own unit", () => {
    expect(
      latencyDemotionLabel("gemini/models/gemini-3.6-flash", {
        basis: "per-token",
        measured: 687.8,
        threshold: 250,
        samples: 8,
      }),
    ).toBe("gemini/models/gemini-3.6-flash (p95 687.8ms/token > 250ms/token over 8 request samples)");
    expect(
      latencyDemotionLabel("nim/deepseek-ai/deepseek-v4-flash", {
        basis: "absolute",
        measured: 70364,
        threshold: 30000,
        samples: 12,
      }),
    ).toBe("nim/deepseek-ai/deepseek-v4-flash (p95 70364ms > 30000ms over 12 samples)");
  });
});

/**
 * End to end, on BOTH fronts. The unit tests prove the resolver; this proves the term is actually
 * WIRED — that a slow member loses the lead in a real walk and that the displacement is announced.
 * Two candidates throughout: with one, "was demoted" and "had nowhere to go" are the same
 * observation, which is the trap `test/pool-failover.test.ts` exists to avoid.
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

  /**
   * A stand-in for `PingLoop` holding seeded samples.
   *
   * ⚠ Injected rather than driving a real loop on purpose: a real one would probe live providers
   * and write the operator's own `probe-cache.json`. Only the members `createProxy` actually calls
   * are implemented, so an unimplemented one fails loudly instead of silently returning undefined.
   */
  function stubPingLoop(samples: Record<string, PingRecord[]>): PingLoop {
    return {
      start: () => {},
      stop: () => {},
      noteUserActivity: () => {},
      recordRequestLatency: () => {},
      getModelPings: (provider: string, model: string) => samples[`${provider}/${model}`] ?? [],
      getModelSummary: () => null,
      getQuotaObservations: () => [],
    } as unknown as PingLoop;
  }

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

  it.each(["anthropic", "openai"] as const)(
    "a slow ms/token demotes candidate 1 behind candidate 2, and says so (%s front)",
    async (kind) => {
      const a = await backend(okBody(kind, "m1"));
      const b = await backend(okBody(kind, "m2"));
      const p = portOf(
        await startProxy(
          poolCfg([`http://127.0.0.1:${portOf(a.server)}`, `http://127.0.0.1:${portOf(b.server)}`], kind),
          { pingLoop: stubPingLoop({ "p1/m1": requests(8, 68_780, 100) }) },
        ),
      );

      const res = await post(p, kind);
      expect(res.status).toBe(200);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
      expect(res.headers.get(LATENCY_DEMOTED_HEADER)).toBe(
        "p1/m1 (p95 687.8ms/token > 250ms/token over 8 request samples)",
      );
      // Demoted, never DROPPED: it simply was not tried ahead of the live one.
      expect(a.calls()).toBe(0);
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "leaves the order alone when the measurement is healthy (%s front)",
    async (kind) => {
      const a = await backend(okBody(kind, "m1"));
      const b = await backend(okBody(kind, "m2"));
      const p = portOf(
        await startProxy(
          poolCfg([`http://127.0.0.1:${portOf(a.server)}`, `http://127.0.0.1:${portOf(b.server)}`], kind),
          // 40 ms/token, and 40 s of absolute latency: slow in total, healthy per token. The whole
          // reason the primary signal is per-token.
          { pingLoop: stubPingLoop({ "p1/m1": requests(8, 40_000, 1000) }) },
        ),
      );

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
      const p = portOf(
        await startProxy(
          poolCfg(
            [`http://127.0.0.1:${portOf(a.server)}`, `http://127.0.0.1:${portOf(b.server)}`],
            kind,
            { enabled: false },
          ),
          { pingLoop: stubPingLoop({ "p1/m1": requests(8, 68_780, 100) }) },
        ),
      );

      const res = await post(p, kind);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");
      expect(res.headers.get(LATENCY_DEMOTED_HEADER)).toBeNull();
    },
  );
});
