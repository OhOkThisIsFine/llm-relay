---
title: "Cross-Front Failover-Convergence Survey & Test Matrix Design"
date: 2026-08-14
status: advisory
authoring_lane: "Gemini 3.7 Flash"
caveat: "This is an ADVISORY lane deliverable. File:line claims must be re-verified at implementation time."
---

# Cross-Front Failover-Convergence Survey & Test Matrix Design

**Reference:** [docs/freellmapi-adoption-review-2026-08-13.md](freellmapi-adoption-review-2026-08-13.md) §6 Item 1
**Background:** [docs/pool-failover.md](pool-failover.md) (*"two paths, one policy empty"*)
**Source Fronts:** Anthropic front (`POST /v1/messages`) and OpenAI front (`POST /v1/chat/completions` and `POST /v1/responses`) in [src/server.ts](../src/server.ts#L474-L712).

---

## 1. Matrix of Failover-Relevant Behaviors Across Fronts

The table below surveys each failover-relevant behavior in the codebase, determining whether multi-candidate failover and policy enforcement are pinned by end-to-end tests on each request front.

| Behavior | Anthropic Front (`/v1/messages`) | OpenAI Front (`/v1/chat/completions` & `/v1/responses`) | Convergence Status |
| :--- | :--- | :--- | :--- |
| **401/403 Credential Fault** | **PINNED**<br>[test/pool-failover.test.ts:324](../test/pool-failover.test.ts#L324)<br>`Anthropic path — failover past a credential fault > a 401 on the top candidate no longer strands a pool that has 13 working members` | **PINNED**<br>[test/pool-failover.test.ts:153](../test/pool-failover.test.ts#L153)<br>`OpenAI front — failover across pool candidates > fails over past a 401 without recording it as a health failure` | **Converged** |
| **429 without Retry-After** | **UNPINNED (GAP)**<br>*(Only tested as single-candidate pass-through in [test/server.test.ts:794](../test/server.test.ts#L794) and all-429 exhaustion in [test/pool-failover.test.ts:375](../test/pool-failover.test.ts#L375); no test pins Candidate 1 (429) → Candidate 2 (200))* | **PINNED**<br>[test/pool-failover.test.ts:119](../test/pool-failover.test.ts#L119)<br>`OpenAI front — failover across pool candidates > steps over a rate-limited candidate and is served by the next one`<br>[test/pool-failover.test.ts:135](../test/pool-failover.test.ts#L135)<br>`records the 429 against the breaker, so the NEXT request skips that candidate entirely` | **OpenAI Only (Gap on Anthropic)** |
| **429 with Retry-After** | **UNPINNED (GAP)**<br>*(No test pins that a 429 on Candidate 1 with `retry-after: N` sets Candidate 1's breaker cooldown to $N$ seconds rather than the 120s default on `/v1/messages`)* | **PINNED**<br>[test/pool-failover.test.ts:192](../test/pool-failover.test.ts#L192)<br>`OpenAI front — failover across pool candidates > honours the provider's Retry-After for the cooldown instead of the flat 2-minute guess` | **OpenAI Only (Gap on Anthropic)** |
| **402 (Quota Exhaustion)** | **PINNED**<br>[test/pool-failover.test.ts:462](../test/pool-failover.test.ts#L462)<br>`402 is quota exhaustion > anthropic front: same policy — a 402 on the top candidate does not strand the pool` | **PINNED**<br>[test/pool-failover.test.ts:429](../test/pool-failover.test.ts#L429)<br>`402 is quota exhaustion > openai front: fails over past a 402 and is served by the next member`<br>[test/pool-failover.test.ts:441](../test/pool-failover.test.ts#L441)<br>`records the 402 on the breaker with a cooldown far LONGER than the 429 default` | **Converged** |
| **5xx (Server Error)** | **UNPINNED (GAP)**<br>*(Only tested with client socket abort in [test/pool-failover.test.ts:342](../test/pool-failover.test.ts#L342) or single-candidate in [test/server.test.ts:815](../test/server.test.ts#L815); no test pins Candidate 1 (500/503) → Candidate 2 (200))* | **UNPINNED (GAP)**<br>*(Only tested in an all-failing 500 → 429 walk in [test/pool-failover.test.ts:176](../test/pool-failover.test.ts#L176); no test pins Candidate 1 (500/503) → Candidate 2 (200))* | **Missing on Both Fronts** |
| **Transport Error (Socket Reset)** | **PINNED**<br>[test/pool-failover.test.ts:868](../test/pool-failover.test.ts#L868)<br>`request-scoped provider skip > anthropic front: same policy — one prune, both paths` | **PINNED**<br>[test/pool-failover.test.ts:843](../test/pool-failover.test.ts#L843)<br>`request-scoped provider skip > openai front: a socket reset skips the provider's remaining member for this walk` | **Converged** |
| **Timeout (`timeoutMs` deadline)** | **UNPINNED (GAP)**<br>*(Walk budget time cap is pinned in [test/pool-failover.test.ts:770](../test/pool-failover.test.ts#L770), but per-target `timeoutMs` socket hang abort and failover is not tested on `/v1/messages`)* | **PINNED**<br>[test/pool-failover.test.ts:855](../test/pool-failover.test.ts#L855)<br>`request-scoped provider skip > this proxy's own deadline does NOT widen — a slow model is not a dead host` | **OpenAI Only (Gap on Anthropic)** |
| **all-429 Earliest-Retry-After** | **PINNED**<br>[test/pool-failover.test.ts:375](../test/pool-failover.test.ts#L375)<br>`all-429 exhaustion > anthropic front: min Retry-After across an all-429 walk`<br>[test/pool-failover.test.ts:404](../test/pool-failover.test.ts#L404)<br>`a mixed walk does NOT override — a 500 in the middle says nothing about pool capacity` | **PINNED**<br>[test/pool-failover.test.ts:393](../test/pool-failover.test.ts#L393)<br>`all-429 exhaustion > openai front: min Retry-After across an all-429 walk` | **Converged** |
| **Degraded-Tail Header (`x-llm-relay-degraded`)** | **UNPINNED (GAP)**<br>*(Wired in [src/server.ts:1570](../src/server.ts#L1570), but 0 tests assert the wire header on `/v1/messages`)* | **UNPINNED (GAP)**<br>*(Wired in [src/server.ts:1487](../src/server.ts#L1487), but 0 tests assert the wire header on `/v1/chat/completions` or `/v1/responses`)* | **Missing on Both Fronts** |
| **Pool-Attempts Header (`x-llm-relay-pool-attempts`)** | **UNPINNED (GAP)**<br>*(Wired in [src/server.ts:694, 1574](../src/server.ts#L694), but 0 tests assert the header on `/v1/messages`)* | **PINNED**<br>[test/pool-failover.test.ts:498](../test/pool-failover.test.ts#L498)<br>`402 is quota exhaustion > reports the whole walk`<br>[test/pool-failover.test.ts:524](../test/pool-failover.test.ts#L524)<br>`reports a degrading pool even when the request succeeded` | **OpenAI Only (Gap on Anthropic)** |
| **Context Guardrail** | **PINNED**<br>[test/server.test.ts:925](../test/server.test.ts#L925)<br>`context guardrail > rejects with 400 when the SERVING provider published a limit the request exceeds`<br>[test/server.test.ts:939](../test/server.test.ts#L939)<br>`lets a request UNDER the published limit through` | **PINNED**<br>[test/openai-front.test.ts:415](../test/openai-front.test.ts#L415)<br>`OpenAI front context guardrail > prunes an undersized pool member and serves from the one that fits`<br>[test/openai-front.test.ts:459](../test/openai-front.test.ts#L459)<br>`guards the /v1/responses shape too — the estimator counts input` | **Converged** |
| **freeOnly Guard** | **PINNED**<br>[test/offload.test.ts:688](../test/offload.test.ts#L688)<br>`freeOnly offload guard > filters offloaded traffic to free-assessed candidates only`<br>[test/offload.test.ts:700](../test/offload.test.ts#L700)<br>`refuses loudly — clean 503, zero egress — when nothing free resolves` | **UNPINNED (GAP)**<br>*(Enforced at [src/server.ts:418-452](../src/server.ts#L418-L452) for all requests, but all tests in [test/offload.test.ts:677](../test/offload.test.ts#L677) target `/v1/messages`)* | **Anthropic Only (Gap on OpenAI)** |

---

## 2. Gaps and Asymmetries Identified

1. **429 Failover & Retry-After Cooldown Attribution (Gap on Anthropic front):**
   - On OpenAI front, [test/pool-failover.test.ts:119-204](../test/pool-failover.test.ts#L119-L204) verifies stepping over Candidate 1 (429) to Candidate 2 (200), demoting Candidate 1 for the next request, and setting breaker cooldown to the exact `Retry-After` seconds.
   - On Anthropic front (`/v1/messages`), there is no test verifying failover from a single 429 to a healthy candidate or asserting that `Retry-After` on candidate 1 configures the circuit breaker's cooldown.

2. **5xx Failover (500 / 502 / 503) (Gap on Both Fronts):**
   - Neither front has a positive failover test for standard server errors (e.g. Candidate 1 returns 500/503 → Candidate 2 returns 200). 5xx is only tested when the entire pool fails or when a client socket aborts.

3. **Per-Target Socket Timeout Failover (Gap on Anthropic front):**
   - [test/pool-failover.test.ts:855](../test/pool-failover.test.ts#L855) tests a hanging backend timing out (`timeoutMs: 250`) and stepping to the next candidate on `/v1/chat/completions`. No equivalent hanging socket timeout failover test exists on `/v1/messages`.

4. **Pool-Attempts Header (`x-llm-relay-pool-attempts`) (Gap on Anthropic front):**
   - [test/pool-failover.test.ts:498, 524, 535](../test/pool-failover.test.ts#L498) explicitly pins the header on OpenAI requests (`"2 tried, 1 served: 1x429, 1x200"`, `"3 tried, 0 served: 1x429, 1x403, 1x402"`). There are zero tests asserting this header on `/v1/messages`.

5. **Degraded-Tail Header (`x-llm-relay-degraded`) (Gap on Both Fronts):**
   - [src/server.ts:1487, 1570](../src/server.ts#L1487) emits `x-llm-relay-degraded: <target> (below <pool>)` when a request falls back to a candidate listed in `routing.poolDegraded`. [test/dynamic-pools.test.ts:180](../test/dynamic-pools.test.ts#L180) checks config generation, but neither front has an integration test asserting that the HTTP response carries the header.

6. **freeOnly Guardrail (Gap on OpenAI front):**
   - [test/offload.test.ts:612-782](../test/offload.test.ts#L612-L782) tests `freeOnly` filtering and 503 refusal exclusively using `POST /v1/messages`. The OpenAI front (`/v1/chat/completions` and `/v1/responses`) has zero coverage for `freeOnly` filtering or zero-egress 503 refusal.

---

## 3. Proposed Table-Driven Test Design

### Location Recommendation: Dedicated New Test File
**Recommended File:** `test/cross-front-convergence.test.ts`
**Rationale:**
- [test/pool-failover.test.ts](../test/pool-failover.test.ts) is already 984 lines long and acts as an incident-driven regression log.
- A new file implements the exact pattern highlighted in [docs/freellmapi-adoption-review-2026-08-13.md](../docs/freellmapi-adoption-review-2026-08-13.md) §6 Item 1 (`__tests__/routes/*-fallback-convergence.test.ts`).
- It allows clean matrix execution across all three front wire protocols:
  1. `anthropic` (`POST /v1/messages`)
  2. `openai-chat` (`POST /v1/chat/completions`)
  3. `openai-responses` (`POST /v1/responses`)

---

### Implementation Design

The proposed suite defines a uniform `FrontDriver` abstraction and parameterizes a test matrix across all three protocols using the repository's real-server style (`node:http`, ephemeral port 0, loopback 127.0.0.1, tracked cleanup in `afterEach`, hermetic breaker/facts resets).

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import {
  SERVED_BY_HEADER,
  POOL_ATTEMPTS_HEADER,
  DEGRADED_HEADER,
} from "../src/backend.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { Config, ProviderConfig } from "../src/config.js";

interface FrontDriver {
  name: string;
  post: (
    port: number,
    opts: {
      model: string;
      prompt?: string;
      headers?: Record<string, string>;
    }
  ) => Promise<Response>;
  extractContent: (res: Response) => Promise<string>;
}

const FRONTS: FrontDriver[] = [
  {
    name: "Anthropic front (/v1/messages)",
    post: (p, { model, prompt = "hi", headers = {} }) =>
      fetch(`http://127.0.0.1:${p}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          model,
          max_tokens: 32,
          messages: [{ role: "user", content: prompt }],
        }),
      }),
    extractContent: async (r) => {
      const j = (await r.json()) as any;
      return j.content?.[0]?.text ?? "";
    },
  },
  {
    name: "OpenAI front (/v1/chat/completions)",
    post: (p, { model, prompt = "hi", headers = {} }) =>
      fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          model,
          max_tokens: 32,
          messages: [{ role: "user", content: prompt }],
        }),
      }),
    extractContent: async (r) => {
      const j = (await r.json()) as any;
      return j.choices?.[0]?.message?.content ?? "";
    },
  },
  {
    name: "OpenAI front (/v1/responses)",
    post: (p, { model, prompt = "hi", headers = {} }) =>
      fetch(`http://127.0.0.1:${p}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          model,
          max_output_tokens: 32,
          input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        }),
      }),
    extractContent: async (r) => {
      const j = (await r.json()) as any;
      return j.output_text ?? "";
    },
  },
];

const servers: Server[] = [];
function track(s: Server): Server {
  servers.push(s);
  return s;
}

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

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

function scripted(
  reply: (n: number) => { status?: number; headers?: Record<string, string>; body: string }
): Promise<{ server: Server; calls: () => number }> {
  let n = 0;
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        const out = reply(++n);
        res.writeHead(out.status ?? 200, { "content-type": "application/json", ...out.headers });
        res.end(out.body);
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n }));
  });
}

function startProxy(c: Config, catalog = new ModelCatalog({ cachePath: null })): Promise<Server> {
  const s = createProxy(c, { catalog, breaker: globalCircuitBreaker });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(track(s))));
}

const OK_BODY = JSON.stringify({
  id: "cmpl_ok",
  object: "chat.completion",
  choices: [{ message: { role: "assistant", content: "ok-reply" }, finish_reason: "stop" }],
});

function poolConfig(bases: string[], overrides: Partial<Config["routing"]> = {}): Config {
  const providers: Record<string, ProviderConfig> = {};
  bases.forEach((base, i) => {
    providers[`p${i + 1}`] = { base, kind: "openai", tierType: "free", authHeader: "authorization", timeoutMs: 3000 };
  });
  return {
    host: "127.0.0.1",
    port: 0,
    providers,
    routing: {
      default: "pool/test",
      tiers: {},
      benchmarkSort: false,
      pools: { test: bases.map((_, i) => `p${i + 1}/m${i + 1}`) },
      ...overrides,
    },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}
```

---

### Parameterized Test Matrix Structure

```typescript
describe("Cross-Front Failover Convergence Matrix", () => {
  describe.each(FRONTS)("$name", (front) => {

    it("401/403: steps over credential fault and records fault without health penalty", async () => {
      const a = await scripted(() => ({ status: 401, body: JSON.stringify({ error: { message: "Invalid key" } }) }));
      const b = await scripted(() => ({ body: OK_BODY }));
      const p = port(await startProxy(poolConfig([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

      const res = await front.post(p, { model: "pool/test" });
      expect(res.status).toBe(200);
      expect(await front.extractContent(res)).toBe("ok-reply");
      expect(a.calls()).toBe(1);
      expect(b.calls()).toBe(1);
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
      expect(globalCircuitBreaker.getState("p1/m1")?.credentialFailures).toBe(1);
      expect(globalCircuitBreaker.getState("p1/m1")?.consecutiveFailures).toBe(0);
    });

    it("429: steps over rate-limited candidate and applies Retry-After to breaker", async () => {
      const a = await scripted(() => ({ status: 429, headers: { "retry-after": "5" }, body: JSON.stringify({ error: { message: "Rate limit" } }) }));
      const b = await scripted(() => ({ body: OK_BODY }));
      const p = port(await startProxy(poolConfig([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

      const res = await front.post(p, { model: "pool/test" });
      expect(res.status).toBe(200);
      expect(a.calls()).toBe(1);
      expect(b.calls()).toBe(1);
      const remaining = globalCircuitBreaker.getState("p1/m1")!.cooldownUntil - Date.now();
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(5000);
    });

    it("402: steps over quota exhaustion and sets extended cooldown", async () => {
      const a = await scripted(() => ({ status: 402, body: JSON.stringify({ error: { message: "Credits depleted" } }) }));
      const b = await scripted(() => ({ body: OK_BODY }));
      const p = port(await startProxy(poolConfig([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

      const res = await front.post(p, { model: "pool/test" });
      expect(res.status).toBe(200);
      expect(a.calls()).toBe(1);
      expect(b.calls()).toBe(1);
      const state = globalCircuitBreaker.getState("p1/m1")!;
      expect(state.lastStatus).toBe(402);
      expect(state.cooldownUntil - Date.now()).toBeGreaterThan(120000);
    });

    it("5xx: steps over 500/503 server error to next candidate", async () => {
      const a = await scripted(() => ({ status: 503, body: JSON.stringify({ error: { message: "Service Unavailable" } }) }));
      const b = await scripted(() => ({ body: OK_BODY }));
      const p = port(await startProxy(poolConfig([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

      const res = await front.post(p, { model: "pool/test" });
      expect(res.status).toBe(200);
      expect(a.calls()).toBe(1);
      expect(b.calls()).toBe(1);
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
      expect(globalCircuitBreaker.getState("p1/m1")?.consecutiveFailures).toBe(1);
    });

    it("Transport: socket reset skips remaining members of same provider", async () => {
      let resetCount = 0;
      const resetServer = track(createServer((req) => { resetCount++; req.socket.destroy(); }));
      await new Promise((r) => resetServer.listen(0, "127.0.0.1", () => r(null)));
      const ok = await scripted(() => ({ body: OK_BODY }));

      const cfg: Config = {
        host: "127.0.0.1",
        port: 0,
        providers: {
          p1: { base: `http://127.0.0.1:${port(resetServer)}`, kind: "openai", tierType: "free", authHeader: "authorization", timeoutMs: 3000 },
          p2: { base: `http://127.0.0.1:${port(ok.server)}`, kind: "openai", tierType: "free", authHeader: "authorization", timeoutMs: 3000 },
        },
        routing: {
          default: "pool/test",
          tiers: {},
          benchmarkSort: false,
          pools: { test: ["p1/m1", "p1/m2", "p2/m3"] },
        },
        mode: "detect",
        repair: { maxAttempts: 2, destructiveTools: [] },
        log: { level: "silent", file: null },
      };
      const p = port(await startProxy(cfg));

      const res = await front.post(p, { model: "pool/test" });
      expect(res.status).toBe(200);
      expect(resetCount).toBe(1); // p1/m2 pruned
      expect(ok.calls()).toBe(1);
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p2/m3");
    });

    it("Timeout: per-target timeoutMs expiration steps to next candidate", async () => {
      let hangCount = 0;
      const hangServer = track(createServer(() => { hangCount++; }));
      await new Promise((r) => hangServer.listen(0, "127.0.0.1", () => r(null)));
      const ok = await scripted(() => ({ body: OK_BODY }));

      const cfg = poolConfig([`http://127.0.0.1:${port(hangServer)}`, `http://127.0.0.1:${port(ok.server)}`]);
      cfg.providers["p1"]!.timeoutMs = 150;
      const p = port(await startProxy(cfg));

      const res = await front.post(p, { model: "pool/test" });
      expect(res.status).toBe(200);
      expect(hangCount).toBe(1);
      expect(ok.calls()).toBe(1);
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
    });

    it("all-429: serves minimum Retry-After across the walk on total exhaustion", async () => {
      const a = await scripted(() => ({ status: 429, headers: { "retry-after": "60" }, body: JSON.stringify({ error: { message: "RL a" } }) }));
      const b = await scripted(() => ({ status: 429, headers: { "retry-after": "10" }, body: JSON.stringify({ error: { message: "RL b" } }) }));
      const p = port(await startProxy(poolConfig([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

      const res = await front.post(p, { model: "pool/test" });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("10");
    });

    it("Headers: emits x-llm-relay-pool-attempts describing the walk", async () => {
      const a = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "RL" } }) }));
      const b = await scripted(() => ({ body: OK_BODY }));
      const p = port(await startProxy(poolConfig([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

      const res = await front.post(p, { model: "pool/test" });
      expect(res.status).toBe(200);
      expect(res.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1x429, 1x200");
    });

    it("Headers: emits x-llm-relay-degraded when falling back into degraded tail", async () => {
      const a = await scripted(() => ({ status: 500, body: JSON.stringify({ error: { message: "dead" } }) }));
      const b = await scripted(() => ({ body: OK_BODY }));
      const cfg = poolConfig([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`], {
        poolDegraded: { test: ["p2/m2"] },
      });
      const p = port(await startProxy(cfg));

      const res = await front.post(p, { model: "pool/test" });
      expect(res.status).toBe(200);
      expect(res.headers.get(DEGRADED_HEADER)).toBe("p2/m2 (below test)");
    });

    it("freeOnly guard: prunes non-free candidate and serves free member with zero egress to paid", async () => {
      const paid = await scripted(() => ({ body: OK_BODY }));
      const free = await scripted(() => ({ body: OK_BODY }));
      const cfg = poolConfig([`http://127.0.0.1:${port(paid.server)}`, `http://127.0.0.1:${port(free.server)}`], {
        offload: { codex: { enabled: true, scope: "all", freeOnly: true }, claude: { enabled: true, scope: "all", freeOnly: true } },
      });
      delete (cfg.providers["p1"] as any).tierType; // p1 assessed as paid / non-free
      const p = port(await startProxy(cfg));

      const res = await front.post(p, { model: "pool/test" });
      expect(res.status).toBe(200);
      expect(paid.calls()).toBe(0); // Zero egress
      expect(free.calls()).toBe(1);
    });

  });
});
```