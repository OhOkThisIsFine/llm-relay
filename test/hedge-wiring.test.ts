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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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

  /**
   * Like `post`, but with a `content` long enough to control the request's ESTIMATED input token
   * count exactly — `estimateRequestTokens` is chars/4 over `"role":"user"` (4 chars) plus the
   * content, so `contentChars` is chosen by the caller such that `(4 + contentChars) / 4` lands on
   * a whole number: the owner direction 2026-09-04 test below wants an exact 1,000-token estimate,
   * so it passes 3,996.
   */
  async function postSized(p: number, kind: "anthropic" | "openai", contentChars: number): Promise<Response> {
    const path = kind === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
    const content = "x".repeat(contentChars);
    const body =
      kind === "anthropic"
        ? { model: "pool/coding", max_tokens: 20, messages: [{ role: "user", content }] }
        : { model: "pool/coding", messages: [{ role: "user", content }] };
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

  /**
   * An SSE backend that answers 200 + headers AT ONCE and sends its first content event only after
   * `contentDelayMs` — the wedge shape a race decided at header arrival could never see: the
   * primary had "resolved", and then nothing came. `closed()` settles when the relay drops the
   * connection, which is how a loser's abort is observed from the backend's side.
   */
  function sseBackend(
    contentDelayMs: number,
    dieAfterMs?: number,
  ): Promise<{ server: Server; calls: () => number; closed: () => Promise<void> }> {
    let n = 0;
    let markClosed: () => void = () => {};
    const closed = new Promise<void>((r) => {
      markClosed = r;
    });
    const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>): string =>
      `data: ${JSON.stringify({
        id: "cmpl",
        object: "chat.completion.chunk",
        model: "m",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      })}\n\n`;
    const sendContent = (res: ServerResponse): void => {
      if (res.writableEnded || res.destroyed) return;
      res.write(chunk({ role: "assistant", content: "ok" }, null));
      res.write(chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1 }));
      res.write("data: [DONE]\n\n");
      res.end();
    };
    /** An in-band error before any content: the probe classifies the stream dead, not committed. */
    const die = (res: ServerResponse): void => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`data: ${JSON.stringify({ error: { message: "boom", type: "server_error" } })}\n\n`);
      res.end();
    };
    const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
      req.on("data", () => {});
      req.on("end", () => {
        n += 1;
        open.push(res);
        res.on("close", () => markClosed());
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        // A role-only chunk at once, the way hidden-reasoning providers open a stream: a VALID data
        // event, so `fetchBackend`'s structural preflight resolves the attempt here — and then no
        // content until `contentDelayMs`. Without this preamble the preflight itself blocks on the
        // silence and a race decided at resolution already covers the case (measured: the wrapper
        // mutation check stayed green until this line existed).
        res.write(chunk({ role: "assistant" }, null));
        if (dieAfterMs !== undefined) timers.push(setTimeout(() => die(res), dieAfterMs));
        if (contentDelayMs === 0) sendContent(res);
        else timers.push(setTimeout(() => sendContent(res), contentDelayMs));
      });
    };
    return new Promise((resolve) => {
      const s = createServer(onRequest);
      s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n, closed: () => closed }));
    });
  }

  async function postStreaming(p: number, kind: "anthropic" | "openai"): Promise<Response> {
    const path = kind === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
    const body =
      kind === "anthropic"
        ? { model: "pool/coding", max_tokens: 20, stream: true, messages: [{ role: "user", content: "hi" }] }
        : { model: "pool/coding", stream: true, messages: [{ role: "user", content: "hi" }] };
    return fetch(`http://127.0.0.1:${p}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it.each(["anthropic", "openai"] as const)(
    "hedges a primary that sends headers and then stalls before any content — the wedge a resolution race could not see (%s front)",
    async (kind) => {
      // Owner direction 2026-09-04: the hedge exists for wedged requests. A provider that answers
      // 200 + headers at once and then produces nothing had "resolved", so a race decided at
      // response resolution never started a hedge and the request waited out the provider timeout.
      // The race now settles at COMMIT, the first meaningful content.
      const a = await sseBackend(3000);
      const b = await sseBackend(0);
      const p = portOf(await startProxy(poolCfg(basesOf(a, b))));

      const res = await postStreaming(p, kind);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("ok");
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
      expect(a.calls()).toBe(1);
      expect(b.calls()).toBe(1);
      expect(res.headers.get(HEDGED_HEADER)).toBe("p1/m1 -> p2/m2 (hedge won after 120ms, input-size 2 tokens)");
      // The loser's stalled stream is ABORTED, not left to run out its content timer.
      const closedBeforeContent = await Promise.race([
        a.closed().then(() => true),
        new Promise<boolean>((r) => timers.push(setTimeout(() => r(false), 1500))),
      ]);
      expect(closedBeforeContent).toBe(true);
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "a slow primary whose stream DIES before content is not a win, so the hedge still takes it (%s front)",
    async (kind) => {
      // The probe half of `attemptWon`: past the delay, a primary that settles with a DEAD stream
      // must not end the race — the walk was going to move on from it anyway, exactly as it does
      // from a 429. Under a status-only win test the dead primary "wins" at 500 ms, the hedge is
      // aborted as the loser, and the walk then has to reach p2 serially a second time.
      const a = await sseBackend(3000, 500);
      const b = await sseBackend(1500);
      const p = portOf(await startProxy(poolCfg(basesOf(a, b))));

      const res = await postStreaming(p, kind);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("ok");
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
      expect(a.calls()).toBe(1);
      expect(b.calls()).toBe(1);
      expect(res.headers.get(HEDGED_HEADER)).toBe("p1/m1 -> p2/m2 (hedge won after 120ms, input-size 2 tokens)");
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "does NOT hedge a stream that commits inside the delay — a healthy stream is a win at first content (%s front)",
    async (kind) => {
      const a = await sseBackend(0);
      const b = await sseBackend(0);
      const p = portOf(await startProxy(poolCfg(basesOf(a, b))));

      const res = await postStreaming(p, kind);
      expect(res.status).toBe(200);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");
      expect(res.headers.get(HEDGED_HEADER)).toBeNull();
      expect(b.calls()).toBe(0);
    },
  );

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
      // `"hi"` estimates to 2 input tokens (`estimateRequestTokens`); at the default
      // `msPerInputToken` that contributes ~0.3 ms, so the 120 ms `floorMs` override still decides
      // the DELAY — but the BASIS is now `input-size` (the flat-floor fallback's new name), and it
      // carries the token count that decided it, per owner direction 2026-09-04.
      expect(res.headers.get(HEDGED_HEADER)).toBe("p1/m1 -> p2/m2 (hedge won after 120ms, input-size 2 tokens)");
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
      // Both were really contacted — the same proof every positive case here carries. Without it
      // this passes on a relay that never hedged and simply failed over from the 429, which is a
      // DIFFERENT mechanism reaching the same header.
      expect(a.calls()).toBe(1);
      expect(b.calls()).toBe(1);
      expect(res.headers.get(HEDGED_HEADER)).toBe("p1/m1 -> p2/m2 (hedge won after 120ms, input-size 2 tokens)");
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
      expect(res.headers.get(HEDGED_HEADER)).toBe("p1/m1 -> p2/m2 (primary won after 120ms, input-size 2 tokens)");
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

  it.each(["anthropic", "openai"] as const)(
    "the floor grows with the request's own estimated input size, not just the flat minimum (%s front)",
    async (kind) => {
      // owner direction 2026-09-04. `msPerInputToken: 1` makes the size term dominate a tiny
      // `minFloorMs` override, so a ~1,000-token request is hedged at ~1,000 ms — proving the real
      // per-request estimate (`estimateRequestTokens`, computed once in `handle()` for the context
      // guardrail) actually reaches the hedge decision and its announced header, not just a unit
      // test's direct call into `hedge-trigger.ts`.
      const { a, b } = await twoBackends({ delayMs: 1_600 }, { delayMs: 0 });
      const p = portOf(
        await startProxy(poolCfg(basesOf(a, b), { hedge: { minFloorMs: 50, msPerInputToken: 1 } })),
      );

      const res = await postSized(p, kind, 3_996); // estimates to exactly 1,000 input tokens
      expect(res.status).toBe(200);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
      expect(a.calls()).toBe(1);
      expect(b.calls()).toBe(1);
      // floor = max(50, 1 ms/token x 1,000 tokens) = 1,000 ms — the size term, not the 50 ms flat
      // minimum, decided the delay, and the header states the estimate that set it.
      expect(res.headers.get(HEDGED_HEADER)).toBe("p1/m1 -> p2/m2 (hedge won after 1000ms, input-size 1000 tokens)");
    },
  );
});
