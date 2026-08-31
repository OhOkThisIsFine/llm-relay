/**
 * Hedged attempts, WIRED — the request path, both fronts.
 *
 * `hedge-trigger.test.ts` pins the decision and `hedge-race.test.ts` pins the concurrency. This
 * file answers the question neither of them can: does a real request actually duplicate onto the
 * next candidate, and does it stop doing so under every bound the owner attached to that permission?
 *
 * ⚠ **The negative controls are the point.** Hedging is the first behaviour in this relay that does
 * not merely reorder, so "it fires" is the easy half. Each `does not hedge` case below is one of the
 * three bounds D1 rests on, and a version of this feature that quietly ignored any of them would
 * still pass a test that only proved a hedge can win.
 *
 * ⚠ A feature like this can also be silently INERT — the v0.65.1 lesson, where a routing term read
 * the wrong dataset and did nothing after a restart while every test agreed with the code. So every
 * positive case asserts the SECOND backend was really contacted (`calls()`), never just a header.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createProxy, type ProxyDeps } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import { HEDGED_HEADER, SERVED_BY_HEADER } from "../src/backend.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { PingLoop } from "../src/ping/cadence.js";
import type { Config, ProviderConfig } from "../src/config.js";

describe("hedged attempts — end to end on both fronts", () => {
  const servers: Server[] = [];
  const open: ServerResponse[] = [];
  const timers: NodeJS.Timeout[] = [];
  const track = (s: Server): Server => (servers.push(s), s);
  const portOf = (s: Server): number => (s.address() as AddressInfo).port;

  beforeEach(() => {
    globalCircuitBreaker.reset();
    resetFacts();
    resetInterpretations();
  });
  afterEach(async () => {
    // Release anything a slow backend is still holding, or `close` waits on a live socket.
    for (const t of timers.splice(0)) clearTimeout(t);
    for (const r of open.splice(0)) if (!r.writableEnded) r.destroy();
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    globalCircuitBreaker.reset();
    resetFacts();
    resetInterpretations();
  });

  /** Only the members `createProxy` calls. An unimplemented one must fail loudly, not return undefined. */
  function stubPingLoop(): PingLoop {
    return {
      start: () => {},
      stop: () => {},
      noteUserActivity: () => {},
      recordRequestLatency: () => {},
      // No samples anywhere: the trigger falls to its FLOOR rung, which is the rung that matters
      // here — an unmeasured deployment IS hedged, the deliberate opposite of latency demotion.
      getModelPings: () => [],
      getModelSummary: () => null,
      getQuotaObservations: () => [],
    } as unknown as PingLoop;
  }

  /** Every backend here is openai-kind, so one shape serves both fronts. */
  function okBody(): string {
    return JSON.stringify({
      id: "cmpl",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  }

  /** Answer one request, unless the relay already aborted it. */
  function answer(res: ServerResponse, status: number, body: string): void {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  }

  /** A backend that answers after `delayMs` with `status`. `delayMs: 0` answers immediately. */
  function backend(
    body: string,
    { delayMs = 0, status = 200 }: { delayMs?: number; status?: number } = {},
  ): Promise<{ server: Server; calls: () => number }> {
    let n = 0;
    const onEnd = (res: ServerResponse): void => {
      n += 1;
      open.push(res);
      if (delayMs === 0) answer(res, status, body);
      else timers.push(setTimeout(() => answer(res, status, body), delayMs));
    };
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => onEnd(res));
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n }));
    });
  }

  /**
   * Two free deployments in one pool.
   *
   * ⚠ `tierType: "free"` is LOAD-BEARING, not scenery: D1 confines hedging to deployments
   * `assessCost()` calls free, and an unpriced model on a provider with no tier type resolves to
   * `unknown`, which counts as paid. Without this line every case below would silently not hedge.
   */
  function poolCfg(bases: string[], opts: { hedge?: unknown; free?: boolean } = {}): Config {
    const providers: Record<string, ProviderConfig> = {};
    bases.forEach((base, i) => {
      providers[`p${i + 1}`] = {
        base,
        // ⚠ ALWAYS openai-kind, on BOTH fronts, and that is the realistic shape rather than a
        // convenience: `costClassOf` answers "paid" for every anthropic-kind target because the
        // vendor passthrough spends primary quota, so an anthropic-kind deployment can never be
        // hedged. What varies below is the FRONT the caller speaks, not the backend it reaches.
        kind: "openai",
        authHeader: "authorization",
        timeoutMs: 4000,
        ...(opts.free === false ? {} : { tierType: "free" }),
      } as ProviderConfig;
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
        // A small floor so the race is decided in milliseconds. The shipped default is 20000 ms and
        // is a declared placeholder; a test must never wait on it.
        hedge: (opts.hedge === undefined ? { floorMs: 120 } : opts.hedge) as never,
        // Off: an unmeasured deployment must not also be latency-demoted out of the walk, which
        // would move the candidate order and prove nothing about hedging.
        latency: { enabled: false } as never,
      },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    } as Config;
  }

  function startProxy(c: Config, deps: ProxyDeps = {}): Promise<Server> {
    const s = createProxy(c, {
      catalog: new ModelCatalog({ cachePath: null }),
      breaker: globalCircuitBreaker,
      pingLoop: stubPingLoop(),
      ...deps,
    });
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

  async function twoBackends(
    first: { delayMs?: number; status?: number },
    second: { delayMs?: number; status?: number } = {},
  ): Promise<{ a: { server: Server; calls: () => number }; b: { server: Server; calls: () => number } }> {
    return { a: await backend(okBody(), first), b: await backend(okBody(), second) };
  }

  const basesOf = (a: { server: Server }, b: { server: Server }): string[] => [
    `http://127.0.0.1:${portOf(a.server)}`,
    `http://127.0.0.1:${portOf(b.server)}`,
  ];

  it.each(["anthropic", "openai"] as const)(
    "starts the next candidate beside a slow primary, and the hedge answers (%s front)",
    async (kind) => {
      // The primary is slower than the floor and would eventually answer. That is exactly the shape
      // a timeout cannot handle — abandoning it is wrong, waiting it out is wrong — and it is the
      // whole argument for hedging.
      const { a, b } = await twoBackends({ delayMs: 3000 }, { delayMs: 0 });
      const p = portOf(await startProxy(poolCfg(basesOf(a, b))));

      const res = await post(p, kind);
      expect(res.status).toBe(200);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
      // BOTH were really contacted. A header alone would not distinguish a working hedge from a
      // label written by an ordinary failover.
      expect(a.calls()).toBe(1);
      expect(b.calls()).toBe(1);
      expect(res.headers.get(HEDGED_HEADER)).toBe("p1/m1 -> p2/m2 (hedge won after 120ms, floor)");
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "does NOT hedge when the primary answers inside the delay — a healthy pool never duplicates (%s front)",
    async (kind) => {
      const { a, b } = await twoBackends({ delayMs: 0 });
      const p = portOf(await startProxy(poolCfg(basesOf(a, b))));

      const res = await post(p, kind);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");
      expect(res.headers.get(HEDGED_HEADER)).toBeNull();
      expect(b.calls()).toBe(0);
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "does NOT hedge a deployment assessCost cannot call free — D1's containment (%s front)",
    async (kind) => {
      // Same slow primary, same small floor. The ONLY difference is the missing free tier, and it
      // must be enough on its own to stop the duplication.
      const { a, b } = await twoBackends({ delayMs: 300 });
      const p = portOf(await startProxy(poolCfg(basesOf(a, b), { free: false })));

      const res = await post(p, kind);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");
      expect(res.headers.get(HEDGED_HEADER)).toBeNull();
      expect(b.calls()).toBe(0);
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "routing.hedge false restores the pre-hedge behaviour exactly (%s front)",
    async (kind) => {
      const { a, b } = await twoBackends({ delayMs: 300 });
      const p = portOf(await startProxy(poolCfg(basesOf(a, b), { hedge: false })));

      const res = await post(p, kind);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");
      expect(res.headers.get(HEDGED_HEADER)).toBeNull();
      expect(b.calls()).toBe(0);
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "a SLOW primary that fails is not a win, so the hedge still takes it (%s front)",
    async (kind) => {
      // The subtle rule: `isWin` asks what the WALK would do, not merely whether a response arrived.
      // A 429 the walk would fail over from must not abort a hedge that is about to answer 200.
      const { a, b } = await twoBackends({ delayMs: 400, status: 429 }, { delayMs: 0 });
      const p = portOf(await startProxy(poolCfg(basesOf(a, b))));

      const res = await post(p, kind);
      expect(res.status).toBe(200);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
      expect(res.headers.get(HEDGED_HEADER)).toBe("p1/m1 -> p2/m2 (hedge won after 120ms, floor)");
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "announces a hedge the PRIMARY won, because the duplication happened either way (%s front)",
    async (kind) => {
      // The primary crosses the floor, so a hedge starts — then the primary answers first anyway.
      // A header that appeared only on a win would hide exactly this case: a pool duplicating
      // requests for no benefit, which is what an operator needs to see before turning it off.
      const { a, b } = await twoBackends({ delayMs: 250 }, { delayMs: 3000 });
      const p = portOf(await startProxy(poolCfg(basesOf(a, b))));

      const res = await post(p, kind);
      expect(res.status).toBe(200);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");
      expect(b.calls()).toBe(1);
      expect(res.headers.get(HEDGED_HEADER)).toBe("p1/m1 -> p2/m2 (primary won after 120ms, floor)");
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "a hedge with nowhere to go degrades to the ordinary serial wait (%s front)",
    async (kind) => {
      // One candidate only. `startHedge` finds no next offer, the race awaits the primary, and the
      // request behaves exactly as it always did — including no announcement, because nothing was
      // duplicated.
      const a = await backend(okBody(), { delayMs: 300 });
      const p = portOf(await startProxy(poolCfg([`http://127.0.0.1:${portOf(a.server)}`])));

      const res = await post(p, kind);
      expect(res.status).toBe(200);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");
      expect(res.headers.get(HEDGED_HEADER)).toBeNull();
      expect(a.calls()).toBe(1);
    },
  );
});
