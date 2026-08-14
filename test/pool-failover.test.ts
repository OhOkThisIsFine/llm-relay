import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { CircuitBreaker, globalCircuitBreaker } from "../src/circuit-breaker.js";
import { SERVED_BY_HEADER, POOL_ATTEMPTS_HEADER, UNKNOWN_REFUSAL_HEADER } from "../src/backend.js";
import { orderByUsability } from "../src/server.js";
import { resetFacts, isCostBlocked, cooldownUntil } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { Config, ProviderConfig, ResolvedTarget } from "../src/config.js";
import type { ProviderTargetIdentity } from "../src/kernel/contracts.js";

/**
 * Pool failover, measured end to end.
 *
 * The defect these pin, from a nightly batch job against a real 14-member `pool/coding`:
 * 8 sequential requests, 6 consecutive 429s, ZERO other candidates tried, and the offending
 * candidate's breaker reading `lastStatus: null` throughout. Two independent causes —
 * `/v1/chat/completions` was handed one target and returned before the failover loop, and it
 * reported outcomes to runtime telemetry but never to the circuit breaker — so a rate-limited
 * member was neither stepped over within a request nor demoted for the next one.
 *
 * ⚠ Every test here needs at least TWO candidates. Every pre-existing test of these paths used a
 * single-candidate config, which is exactly why a total absence of failover went unseen: with one
 * candidate, "fails over correctly" and "cannot fail over at all" are the same observation.
 */

const servers: Server[] = [];
function track(s: Server): Server {
  servers.push(s);
  return s;
}

beforeEach(() => {
  globalCircuitBreaker.reset();
  // ⚠ The learned-eligibility stores are process-global too, and this file's `QUOTA_BODY` is the
  // REAL HuggingFace message — so the first 402 test records an account-scoped exhaustion for
  // provider `p1`, and every later test reusing that provider name found its first candidate
  // already demoted. Reset them for the same reason the breaker is reset: shared learned state
  // across tests is a hermeticity bug, not a routing one.
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

/** A backend whose every response is scripted, recording how many times it was called. */
function scripted(
  reply: (n: number) => { status?: number; headers?: Record<string, string>; body: string },
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

const OK_BODY = JSON.stringify({
  id: "cmpl_ok",
  object: "chat.completion",
  choices: [{ message: { role: "assistant", content: "served" }, finish_reason: "stop" }],
});

/**
 * A two-member pool. `benchmarkSort: false` keeps CONFIG order, so the test asserts failover
 * rather than whatever the synced capability snapshot happens to rank higher today.
 */
function poolCfg(bases: string[], kind: "openai" | "anthropic" = "openai"): Config {
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
    },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

function startProxy(c: Config): Promise<Server> {
  const s = createProxy(c, { catalog: new ModelCatalog({ cachePath: null }), breaker: globalCircuitBreaker });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(track(s))));
}

function chat(p: number, model = "pool/coding"): Promise<Response> {
  return fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("OpenAI front — failover across pool candidates", () => {
  it("steps over a rate-limited candidate and is served by the next one", async () => {
    const a = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "TPM exceeded", type: "rate_limit_exceeded" } }) }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await chat(p);
    expect(resp.status).toBe(200);
    const j = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    expect(j.choices[0]!.message.content).toBe("served"); // the SECOND candidate answered
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    // And the client is told who actually served it — previously unanswerable without
    // correlating the proxy's own log by timestamp.
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
  });

  it("records the 429 against the breaker, so the NEXT request skips that candidate entirely", async () => {
    // The measured bug in one assertion: 122 observed calls through this path and the breaker
    // still read `lastStatus: null`, because the front recorded runtime telemetry and nothing else.
    const a = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "slow down" } }) }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    expect((await chat(p)).status).toBe(200);
    const state = globalCircuitBreaker.getState("p1/m1");
    expect(state?.lastStatus).toBe(429);
    expect(state?.consecutiveFailures).toBe(1);
    expect(state!.cooldownUntil).toBeGreaterThan(Date.now()); // 429 trips immediately

    expect((await chat(p)).status).toBe(200);
    expect(a.calls()).toBe(1); // cooling — not retried at all on the second request
    expect(b.calls()).toBe(2);
  });

  it("fails over past a 401 without recording it as a health failure", async () => {
    // A credential fault is not a sick backend. It must not trip the breaker (that would hide the
    // 401 behind a "target unhealthy" skip) and must not clear failures (that would launder a
    // permanently broken member into a healthy one) — but it must not block the pool either.
    const a = await scripted(() => ({ status: 401, body: JSON.stringify({ error: { message: "Wrong API Key" } }) }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    expect((await chat(p)).status).toBe(200);

    const state = globalCircuitBreaker.getState("p1/m1")!;
    expect(state.consecutiveFailures).toBe(0); // NOT health data
    expect(state.cooldownUntil).toBe(0);
    expect(state.credentialFailures).toBe(1); // its own axis
    expect(state.lastCredentialStatus).toBe(401);
    expect(globalCircuitBreaker.hasCredentialFault("p1/m1")).toBe(true);

    // Demoted, so the next request does not pay its round-trip first.
    expect((await chat(p)).status).toBe(200);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(2);
  });

  it("returns the last real upstream error when EVERY candidate fails, naming all of them", async () => {
    // Not a synthesized 502: the providers' own statuses are the informative answer, and a
    // 429 rewritten into a proxy error is how a transient rate limit reads as a proxy bug.
    const a = await scripted(() => ({ status: 500, body: JSON.stringify({ error: { message: "boom" } }) }));
    const b = await scripted(() => ({ status: 429, headers: { "retry-after": "7" }, body: JSON.stringify({ error: { message: "TPM exceeded" } }) }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await chat(p);
    expect(resp.status).toBe(429); // the LAST candidate's real status
    expect(((await resp.json()) as { error: { message: string } }).error.message).toContain("TPM exceeded");
    expect(resp.headers.get("retry-after")).toBe("7"); // the caller can still honour it
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p1/m1, p2/m2"); // everything that was tried
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  it("honours the provider's Retry-After for the cooldown instead of the flat 2-minute guess", async () => {
    // "Please try again in 20.4525s" was in the payload and nothing anywhere acted on it. The
    // provider is the only party that knows when it will serve again; 120s is as likely to be
    // far too long as far too short.
    const a = await scripted(() => ({ status: 429, headers: { "retry-after": "5" }, body: JSON.stringify({ error: { message: "slow down" } }) }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    expect((await chat(p)).status).toBe(200);
    const remaining = globalCircuitBreaker.getState("p1/m1")!.cooldownUntil - Date.now();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5000); // the 5s asked for, not the 120s default
  });

  it("does not fail over on a genuine client 4xx — 14 candidates would reject it identically", async () => {
    const a = await scripted(() => ({ status: 422, body: JSON.stringify({ error: { message: "bad request shape" } }) }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    expect((await chat(p)).status).toBe(422);
    expect(b.calls()).toBe(0); // the second candidate is never asked
  });
});

describe("Anthropic front — local failures do not walk the provider pool", () => {
  it("does not create another target attempt for a deterministic relay-local failure", async () => {
    class CountingBreaker extends CircuitBreaker {
      begins = 0;
      override beginAttempt(target: ProviderTargetIdentity) {
        this.begins += 1;
        return super.beginAttempt(target);
      }
    }
    const breaker = new CountingBreaker();
    const cfg = poolCfg(["https://first.invalid", "https://second.invalid"]);
    const proxy = createProxy(cfg, { catalog: new ModelCatalog({ cachePath: null }), breaker });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    track(proxy);

    const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "pool/coding",
        messages: [{ role: "user", content: [{ type: "document", source: { type: "url", url: "https://example.invalid/a.pdf" } }] }],
      }),
    });

    expect(response.status).toBe(400);
    expect(breaker.begins).toBe(1);
    expect(breaker.getAllStates().size).toBe(0);
  });
});

describe("OpenAI front — error envelope shape", () => {
  it("unwraps an array-wrapped error (gemini) into the OpenAI envelope", async () => {
    // `[{"error":{…}}]` has no `choices`, so a client reading `response.choices[0]` gets
    // `undefined` and reports a malformed completion — which is how a plain 429 cost two days
    // of debugging as "the model returned garbage".
    const a = await scripted(() => ({
      status: 503,
      body: JSON.stringify([{ error: { code: 503, message: "This model is currently experiencing high demand", status: "UNAVAILABLE" } }]),
    }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`])));

    const resp = await chat(p);
    expect(resp.status).toBe(503);
    const j = (await resp.json()) as { error?: { message?: string; code?: number } };
    expect(Array.isArray(j)).toBe(false);
    expect(j.error?.message).toContain("high demand"); // the provider's own words, preserved
    expect(j.error?.code).toBe(503);
  });

  it("wraps a non-JSON error body (an HTML gateway page) rather than passing it through as JSON", async () => {
    const a = await scripted(() => ({
      status: 502,
      headers: { "content-type": "text/html" },
      body: "<html><body>502 Bad Gateway</body></html>",
    }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`])));

    const resp = await chat(p);
    expect(resp.status).toBe(502);
    // Exactly ONE content-type, and it describes what we actually sent. The upstream's
    // `text/html` is spread in before the override, so a casing mismatch between the two would
    // emit both headers and leave the client guessing.
    expect(resp.headers.get("content-type")).toBe("application/json");
    const j = (await resp.json()) as { error: { message: string; code: number } };
    expect(j.error.message).toContain("502 Bad Gateway");
    expect(j.error.code).toBe(502);
  });
});

describe("orderByUsability — demotes, never drops", () => {
  const t = (n: string): ResolvedTarget => ({ provider: n, base: `http://${n}`, kind: "openai", model: "m", authHeader: "authorization", timeoutMs: 1000 });
  const [a, b, c] = [t("a"), t("b"), t("c")];

  it("keeps config/benchmark order among equals", () => {
    expect(orderByUsability([a, b, c], new CircuitBreaker()).map((x) => x.provider)).toEqual(["a", "b", "c"]);
  });

  it("sinks a cooling target to the back instead of removing it from the pool", () => {
    // The old `filter(isHealthy)` DELETED cooling candidates whenever any healthy one remained,
    // so a 14-member pool could be narrowed to one member and then have nothing left when that
    // member failed too. A demoted target is only reached after every better one has actually
    // failed on this request — which costs nothing and preserves all 14 chances.
    const cb = new CircuitBreaker();
    cb.recordOutcome(a, { ok: false, status: 429, elapsedMs: 5 });
    const out = orderByUsability([a, b, c], cb);
    expect(out.map((x) => x.provider)).toEqual(["b", "c", "a"]);
    expect(out).toHaveLength(3); // nothing dropped
  });

  it("orders live before credential-faulted before cooling", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(a, { ok: false, status: 429, elapsedMs: 5 }); // cooling
    cb.recordCredentialFault(b, 401); // unusable, but not sick
    expect(orderByUsability([a, b, c], cb).map((x) => x.provider)).toEqual(["c", "b", "a"]);
  });
});

describe("Anthropic path — failover past a credential fault", () => {
  const ANTHROPIC_OK = JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "m2",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  it("a 401 on the top candidate no longer strands a pool that has 13 working members", async () => {
    const a = await scripted(() => ({ status: 401, body: JSON.stringify({ type: "error", error: { message: "invalid x-api-key" } }) }));
    const b = await scripted(() => ({ body: ANTHROPIC_OK }));
    const cfg = poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`], "anthropic");
    const p = port(await startProxy(cfg));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(resp.status).toBe(200);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(globalCircuitBreaker.getState("p1/m1")?.credentialFailures).toBe(1);
    expect(globalCircuitBreaker.getState("p1/m1")?.consecutiveFailures).toBe(0);
  });

  it("does not failover to subsequent candidates if client socket is destroyed (res.destroyed)", async () => {
    const a = await scripted(() => ({ status: 500, body: JSON.stringify({ type: "error", error: { message: "server error" } }) }));
    const b = await scripted(() => ({ body: ANTHROPIC_OK }));
    const cfg = poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`], "anthropic");
    const p = port(await startProxy(cfg));

    const controller = new AbortController();
    const fetchPromise = fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    }).catch(() => {});

    // Abort client request immediately
    controller.abort();
    await fetchPromise;

    // Allow async turn to resolve
    await new Promise((r) => setTimeout(r, 100));

    // Candidate B should NOT be called if socket was destroyed/aborted
    expect(b.calls()).toBe(0);
  });
});

describe("all-429 exhaustion serves the pool's earliest reset, not the last candidate's", () => {
  // The served error body stays the LAST candidate's real 429 (a true upstream error beats a
  // synthesized one) — but its Retry-After is one deployment's answer. When every candidate
  // 429'd, the earliest reset among them is when the POOL next has capacity, and that is the
  // number an honest backoff needs. ≥2 candidates throughout, per this file's header warning.
  const RATE_BODY = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });

  it("anthropic front: min Retry-After across an all-429 walk", async () => {
    const a = await scripted(() => ({ status: 429, headers: { "retry-after": "60" }, body: RATE_BODY }));
    const b = await scripted(() => ({ status: 429, headers: { "retry-after": "7" }, body: RATE_BODY }));
    const c = await scripted(() => ({ status: 429, headers: { "retry-after": "120" }, body: RATE_BODY }));
    const bases = [a, b, c].map((x) => `http://127.0.0.1:${port(x.server)}`);
    const p = port(await startProxy(poolCfg(bases, "anthropic")));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(resp.status).toBe(429);
    expect([a, b, c].map((x) => x.calls())).toEqual([1, 1, 1]);
    // The last candidate said 120s; the pool frees up in 7s.
    expect(resp.headers.get("retry-after")).toBe("7");
  });

  it("openai front: min Retry-After across an all-429 walk", async () => {
    const a = await scripted(() => ({ status: 429, headers: { "retry-after": "45" }, body: RATE_BODY }));
    const b = await scripted(() => ({ status: 429, headers: { "retry-after": "90" }, body: RATE_BODY }));
    const bases = [a, b].map((x) => `http://127.0.0.1:${port(x.server)}`);
    const p = port(await startProxy(poolCfg(bases)));

    const resp = await chat(p);
    expect(resp.status).toBe(429);
    expect(resp.headers.get("retry-after")).toBe("45");
  });

  it("a mixed walk does NOT override — a 500 in the middle says nothing about pool capacity", async () => {
    const a = await scripted(() => ({ status: 500, body: JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }) }));
    const b = await scripted(() => ({ status: 429, headers: { "retry-after": "300" }, body: RATE_BODY }));
    const bases = [a, b].map((x) => `http://127.0.0.1:${port(x.server)}`);
    const p = port(await startProxy(poolCfg(bases, "anthropic")));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(resp.status).toBe(429);
    // The last candidate's own header passes through untouched.
    expect(resp.headers.get("retry-after")).toBe("300");
  });
});

describe("402 is quota exhaustion — a monthly-window 429, not a client error", () => {
  // Observed live 2026-08-04: HuggingFace's router answers 402 "You have depleted your monthly
  // included credits" while other pool members serve fine — and the relay returned it to the
  // client, because 402 fell into the "client" class and never failed over. Requests then
  // hard-errored intermittently, depending on whether the depleted member ranked first.
  // ≥2 candidates throughout, per this file's header warning.
  const QUOTA_BODY = JSON.stringify({ error: { message: "You have depleted your monthly included credits.", type: "insufficient_quota" } });

  it("openai front: fails over past a 402 and is served by the next member", async () => {
    const a = await scripted(() => ({ status: 402, body: QUOTA_BODY }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await chat(p);
    expect(resp.status).toBe(200);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
  });

  it("records the 402 on the breaker with a cooldown far LONGER than the 429 default", async () => {
    // Monthly credits do not reset in the 2-minute rate-limit window; retrying on that cadence
    // pays a round-trip per request for the rest of the billing period to hear the same answer.
    const a = await scripted(() => ({ status: 402, body: QUOTA_BODY }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    expect((await chat(p)).status).toBe(200);
    const state = globalCircuitBreaker.getState("p1/m1")!;
    expect(state.lastStatus).toBe(402);
    expect(state.consecutiveFailures).toBe(1); // health data, unlike a 401
    const remaining = state.cooldownUntil - Date.now();
    expect(remaining).toBeGreaterThan(120000); // longer than the 429 default cooldown
    expect(remaining).toBeLessThanOrEqual(3600000); // the 1-hour quota cooldown

    // Demoted for the next request — the depleted member is not asked again.
    expect((await chat(p)).status).toBe(200);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(2);
  });

  it("anthropic front: same policy — a 402 on the top candidate does not strand the pool", async () => {
    const a = await scripted(() => ({ status: 402, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "You have depleted your monthly included credits." } }) }));
    const b = await scripted(() => ({
      body: JSON.stringify({
        id: "msg_1", type: "message", role: "assistant", model: "m2",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    }));
    const cfg = poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`], "anthropic");
    const p = port(await startProxy(cfg));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(resp.status).toBe(200);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(globalCircuitBreaker.getState("p1/m1")?.lastStatus).toBe(402);
  });

  it("all-402 exhaustion still returns the last candidate's real error body, naming everyone tried", async () => {
    const a = await scripted(() => ({ status: 402, body: JSON.stringify({ error: { message: "credits gone on a", type: "insufficient_quota" } }) }));
    const b = await scripted(() => ({ status: 402, body: JSON.stringify({ error: { message: "credits gone on b", type: "insufficient_quota" } }) }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await chat(p);
    expect(resp.status).toBe(402); // the LAST candidate's real status, not a synthesized proxy error
    expect(((await resp.json()) as { error: { message: string } }).error.message).toContain("credits gone on b");
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p1/m1, p2/m2");
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  it("reports the whole walk, not just the error the last candidate happened to return", async () => {
    // The diagnosis problem: a pool's error is ONE member's error. An audit run against a
    // 13-member pool was handed HuggingFace's 402 and sent to a billing page, when four distinct
    // causes were in play and the correct action was "use another pool". The body must stay the
    // real upstream error, so the aggregate rides alongside it.
    const a = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) }));
    const b = await scripted(() => ({ status: 403, body: JSON.stringify({ error: { message: "needs a subscription" } }) }));
    const c = await scripted(() => ({ status: 402, body: JSON.stringify({ error: { message: "credits depleted" } }) }));
    const p = port(await startProxy(poolCfg([
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
      `http://127.0.0.1:${port(c.server)}`,
    ])));

    const resp = await chat(p);
    expect(resp.status).toBe(402);
    // Unchanged: a true upstream error beats a synthesized one.
    expect(((await resp.json()) as { error: { message: string } }).error.message).toContain("credits depleted");
    // New: what actually happened to the other two.
    const summary = resp.headers.get(POOL_ATTEMPTS_HEADER);
    expect(summary).toContain("3 tried, 0 served");
    expect(summary).toContain("1x429");
    expect(summary).toContain("1x403");
    expect(summary).toContain("1x402");
  });

  it("reports a degrading pool even when the request succeeded", async () => {
    const a = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await chat(p);
    expect(resp.status).toBe(200);
    // A 200 that took two candidates to get is worth knowing about before the pool runs out.
    expect(resp.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1x429, 1x200");
  });

  it("emits no aggregate for a single-candidate walk", async () => {
    // With one candidate the response IS the walk; an aggregate would dress an ordinary
    // passthrough error up as a pool exhaustion.
    const a = await scripted(() => ({ status: 402, body: JSON.stringify({ error: { message: "credits gone" } }) }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`])));

    const resp = await chat(p);
    expect(resp.status).toBe(402);
    expect(resp.headers.get(POOL_ATTEMPTS_HEADER)).toBeNull();
  });

  it("a stated credit balance demotes the account's OTHER members, which were never tried", async () => {
    // The shared-quota-domain problem, end to end. A 15-member pool here resolved to only four
    // independent quota domains, so failover was spending one round-trip per member to rediscover
    // one balance. HuggingFace states the balance, and a balance belongs to the credential — so
    // one member's 402 is already the answer for its siblings.
    //
    // ⚠ Demoted, NOT evicted: the deployment is still free, just spent. `p1/m1` stays in the pool
    // and is tried again once nothing better is left, which is why `b` answers rather than the
    // request failing.
    const a = await scripted(() => ({ status: 402, body: QUOTA_BODY }));
    const b = await scripted(() => ({ body: OK_BODY }));
    // Two models on the SAME provider, so the account-scoped observation covers the second.
    const cfg = poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`]);
    cfg.routing.pools = { coding: ["p1/m1", "p1/m-sibling", "p2/m2"] };
    cfg.providers["p1"]!.base = `http://127.0.0.1:${port(a.server)}`;
    const p = port(await startProxy(cfg));

    expect((await chat(p)).status).toBe(200);
    const firstRoundCalls = a.calls();

    // Second request: p1's members are now cooling on a fact learned from ONE of them.
    expect((await chat(p)).status).toBe(200);
    expect(a.calls()).toBe(firstRoundCalls); // neither p1/m1 nor p1/m-sibling was tried again
    expect(b.calls()).toBe(2);
  });

  it("an exhausted allowance never becomes a cost verdict", async () => {
    // The distinction this design must not lose: a free-tier account that has spent this period's
    // credits is the normal state of a working free lane, not a discovery about its price. If a
    // 402 could mark a deployment "paid", it would be evicted from every free pool and the
    // eviction would outlive the exhaustion that caused it.
    const a = await scripted(() => ({ status: 402, body: QUOTA_BODY }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    expect((await chat(p)).status).toBe(200);
    expect(isCostBlocked("p1", "m1")).toBe(false);
    expect(cooldownUntil("p1", "m1")).not.toBeNull(); // cooling, which expires on its own
  });

  it("flags refusals it could not interpret, so the queue is pushed rather than polled", async () => {
    // The learned store converges only as fast as somebody explains the messages it does not
    // recognise, and a pull-only queue is a backlog nobody works. The caller — usually an agent
    // about to report this failure to a human — finds out at the moment it matters.
    const odd = `{"error":{"message":"your organization is not permitted to use this model in this region"}}`;
    const a = await scripted(() => ({ status: 403, body: odd }));
    const b = await scripted(() => ({ status: 402, body: QUOTA_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await chat(p);
    // One unrecognized (the 403); the 402 matches a seed and is understood.
    expect(resp.headers.get(UNKNOWN_REFUSAL_HEADER)).toBe("1");
    // ⚠ A COUNT, never the message: the body is untrusted text from an external service, and a
    // response header is exactly the field an agent tends to trust.
    expect(resp.headers.get(UNKNOWN_REFUSAL_HEADER)).not.toContain("region");
  });

  it("says nothing when every refusal was understood", async () => {
    const a = await scripted(() => ({ status: 402, body: QUOTA_BODY }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await chat(p);
    expect(resp.status).toBe(200);
    expect(resp.headers.get(UNKNOWN_REFUSAL_HEADER)).toBeNull();
  });

  it("a rotated key recovers the WHOLE provider, not one model per expiry", async () => {
    // While a key is bad, every model that happens to be tried records its own credential fault
    // with its own clock — so after a rotation the pool stayed artificially narrow until the last
    // of them aged out. A served request proves the shared credential works, so the symptoms go
    // together with the cause.
    const cb = new CircuitBreaker();
    cb.recordCredentialFault("p1/m1", 401);
    cb.recordCredentialFault("p1/m2", 401);
    cb.recordCredentialFault("p2/m1", 401);
    expect(cb.hasCredentialFault("p1/m1")).toBe(true);
    expect(cb.hasCredentialFault("p1/m2")).toBe(true);

    expect(cb.clearProviderCredentialFaults("p1")).toBe(2);
    expect(cb.hasCredentialFault("p1/m1")).toBe(false);
    expect(cb.hasCredentialFault("p1/m2")).toBe(false);
    // ...and says nothing about a different credential.
    expect(cb.hasCredentialFault("p2/m1")).toBe(true);
  });

  it("a success clears the quota cooldown — a mid-month top-up recovers without a restart", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome("p/m", { ok: false, status: 402, elapsedMs: 5 });
    expect(cb.isHealthy("p/m")).toBe(false); // cooling, demoted behind live members
    cb.recordOutcome("p/m", { ok: true, status: 200, elapsedMs: 5 });
    expect(cb.isHealthy("p/m")).toBe(true);
    expect(cb.getState("p/m")!.cooldownUntil).toBe(0);
  });
});


describe("410 Gone is a fact about one member — fail over, and learn only stated EOL", () => {
  // Observed live 2026-08-07: NVIDIA answered 410 End-of-Life for retired deepseek models while
  // sibling deployments served fine. 410 sat in the non-retriable "client" class, so the
  // retirement returned straight to the client with healthy pool members standing by — and the
  // discard path never read the body, so nothing was learned either (adoption review §1.4).
  // ≥2 candidates throughout, per this file's header warning.
  const EOL_BODY = JSON.stringify({
    error: { message: "Model deepseek-ai/deepseek-v4-flash has reached end of life.", type: "gone" },
  });

  it("openai front: fails over past a 410 and records not-servable from stated EOL wording", async () => {
    const a = await scripted(() => ({ status: 410, body: EOL_BODY }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await chat(p);
    expect(resp.status).toBe(200);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
    // Status + wording agreed the deployment is gone → excluded from free pools…
    expect(isCostBlocked("p1", "m1")).toBe(true);
    // …and the verdict cannot leak to the sibling that served.
    expect(isCostBlocked("p2", "m2")).toBe(false);
  });

  it("anthropic front: same policy — one classifyStatus, both paths", async () => {
    const a = await scripted(() => ({ status: 410, body: EOL_BODY }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(resp.status).toBe(200);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(isCostBlocked("p1", "m1")).toBe(true);
  });

  it("a bare 410 fails over but teaches NOTHING — status alone is not a statement", async () => {
    const a = await scripted(() => ({ status: 410, body: JSON.stringify({ error: { message: "Gone" } }) }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await chat(p);
    expect(resp.status).toBe(200);
    expect(b.calls()).toBe(1);
    expect(isCostBlocked("p1", "m1")).toBe(false);
  });
});

describe("wall-clock walk budget — bounds the walk, never the answer", () => {
  // A deep pool could legitimately spend members x timeoutMs on one request. The budget stops
  // STARTING further attempts once spent; the first two attempts are always allowed (a
  // slow-failing first candidate must not starve the request of its one retry) and an attempt in
  // flight is never aborted. Adoption review §1.5. ≥2 candidates throughout.
  const RL_BODY = JSON.stringify({ error: { message: "TPM exceeded", type: "rate_limit_exceeded" } });

  /** A 429 backend that takes `delayMs` to answer, so the walk measurably spends the budget. */
  function slow429(delayMs: number): Promise<{ server: Server; calls: () => number }> {
    let n = 0;
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          n++;
          setTimeout(() => {
            res.writeHead(429, { "content-type": "application/json" });
            res.end(RL_BODY);
          }, delayMs);
        });
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n }));
    });
  }

  it("openai front: stops starting attempts once the budget is spent — after the guaranteed two", async () => {
    const a = await slow429(25);
    const b = await slow429(25);
    const c = await scripted(() => ({ body: OK_BODY }));
    const cfg = poolCfg([
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
      `http://127.0.0.1:${port(c.server)}`,
    ]);
    cfg.walkBudgetMs = 20;
    const p = port(await startProxy(cfg));

    const resp = await chat(p);
    expect(resp.status).toBe(429); // the second candidate's REAL error, not a synthesized one
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(c.calls()).toBe(0); // never started: ~50ms elapsed > 20ms budget
  });

  it("the first two attempts are always allowed, however slow the first", async () => {
    const a = await slow429(25);
    const b = await scripted(() => ({ body: OK_BODY }));
    const cfg = poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`]);
    cfg.walkBudgetMs = 1; // long gone after attempt 1 — attempt 2 must start anyway
    const p = port(await startProxy(cfg));

    const resp = await chat(p);
    expect(resp.status).toBe(200);
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
  });

  it("0 disables the budget entirely", async () => {
    const a = await slow429(25);
    const b = await slow429(25);
    const c = await scripted(() => ({ body: OK_BODY }));
    const cfg = poolCfg([
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
      `http://127.0.0.1:${port(c.server)}`,
    ]);
    cfg.walkBudgetMs = 0;
    const p = port(await startProxy(cfg));

    const resp = await chat(p);
    expect(resp.status).toBe(200);
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p3/m3");
  });

  it("anthropic front: same policy — one budget, both paths", async () => {
    const a = await slow429(25);
    const b = await slow429(25);
    const c = await scripted(() => ({ body: OK_BODY }));
    const cfg = poolCfg([
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
      `http://127.0.0.1:${port(c.server)}`,
    ]);
    cfg.walkBudgetMs = 20;
    const p = port(await startProxy(cfg));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(resp.status).toBe(429);
    expect(c.calls()).toBe(0);
  });
});

describe("request-scoped provider skip — transport evidence condemns the host, not the model", () => {
  // A provider-wide outage used to burn one hop per member of that provider in the same walk
  // (the transport half of docs/pool-eligibility.md's 13-round-trips pathology). A genuine
  // transport failure — thrown before any HTTP response existed — now prunes the provider's
  // remaining members from THIS walk only. Deliberately narrow: a 5xx status or this proxy's own
  // deadline must NOT widen (a slow model is not a dead host). Adoption review §1.6.

  /** A backend that resets the connection at the socket level — a real transport failure. */
  function resetting(): Promise<{ server: Server; calls: () => number }> {
    let n = 0;
    return new Promise((resolve) => {
      const s = createServer((req) => {
        n++;
        req.socket.destroy();
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n }));
    });
  }

  /** A backend that never answers, so only this proxy's own per-target deadline ends the attempt. */
  function hanging(): Promise<{ server: Server; calls: () => number }> {
    let n = 0;
    return new Promise((resolve) => {
      const s = createServer(() => {
        n++;
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n }));
    });
  }

  /** p1 owns TWO pool members; p2 owns the third. Config order preserved. */
  function twoOnOneProvider(p1Base: string, p2Base: string, p1TimeoutMs = 5000): Config {
    return {
      host: "127.0.0.1",
      port: 0,
      providers: {
        p1: { base: p1Base, kind: "openai", authHeader: "authorization", timeoutMs: p1TimeoutMs },
        p2: { base: p2Base, kind: "openai", authHeader: "authorization", timeoutMs: 5000 },
      },
      routing: {
        default: "pool/coding",
        tiers: {},
        benchmarkSort: false,
        pools: { coding: ["p1/m1", "p1/m2", "p2/m3"] },
      },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
  }

  it("openai front: a socket reset skips the provider's remaining member for this walk", async () => {
    const broken = await resetting();
    const ok = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(twoOnOneProvider(`http://127.0.0.1:${port(broken.server)}`, `http://127.0.0.1:${port(ok.server)}`)));

    const resp = await chat(p);
    expect(resp.status).toBe(200);
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p2/m3");
    expect(broken.calls()).toBe(1); // p1/m2 was pruned, not re-attempted against the same dead host
    expect(ok.calls()).toBe(1);
  });

  it("this proxy's own deadline does NOT widen — a slow model is not a dead host", async () => {
    const slow = await hanging();
    const ok = await scripted(() => ({ body: OK_BODY }));
    const p = port(
      await startProxy(twoOnOneProvider(`http://127.0.0.1:${port(slow.server)}`, `http://127.0.0.1:${port(ok.server)}`, 250)),
    );

    const resp = await chat(p);
    expect(resp.status).toBe(200);
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p2/m3");
    expect(slow.calls()).toBe(2); // both p1 members were tried: timeouts stay per-deployment
  });

  it("anthropic front: same policy — one prune, both paths", async () => {
    const broken = await resetting();
    const ok = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(twoOnOneProvider(`http://127.0.0.1:${port(broken.server)}`, `http://127.0.0.1:${port(ok.server)}`)));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(resp.status).toBe(200);
    expect(broken.calls()).toBe(1);
    expect(ok.calls()).toBe(1);
  });
});

describe("live-traffic quota headers reach the breaker (adoption review §1.9)", () => {
  // The breaker's observation shape always carried quotaPercent, but only synthetic probes ever
  // supplied it — every real response's x-ratelimit-* headers were dropped, so /telemetry showed
  // probe-aged quota beside fresh live health.
  it("a served response's x-ratelimit headers set the breaker's quotaPercent", async () => {
    const a = await scripted(() => ({
      headers: { "x-ratelimit-remaining-requests": "25", "x-ratelimit-limit-requests": "100" },
      body: OK_BODY,
    }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`])));

    expect((await chat(p)).status).toBe(200);
    expect(globalCircuitBreaker.getState("p1/m1")?.quotaPercent).toBe(25);
  });

  it("a 429's stated zero-remaining is recorded too — exhaustion is quota data", async () => {
    const a = await scripted(() => ({
      status: 429,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "50" },
      body: JSON.stringify({ error: { message: "TPM exceeded", type: "rate_limit_exceeded" } }),
    }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    expect((await chat(p)).status).toBe(200);
    expect(globalCircuitBreaker.getState("p1/m1")?.quotaPercent).toBe(0);
  });

  it("no rate-limit headers ⇒ the field stays unset — never guessed", async () => {
    const a = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`])));

    expect((await chat(p)).status).toBe(200);
    expect(globalCircuitBreaker.getState("p1/m1")?.quotaPercent ?? null).toBeNull();
  });
});

describe("first-event in-band error frames fail over pre-commit (adoption review §1.1)", () => {
  // A 200 SSE stream whose FIRST event is an error frame used to pass preflight as a "real
  // protocol envelope" and reach the client — spending the whole pool's walk on one member's
  // error inside a 200. Pre-commit it now fails over; POST-commit (any bytes after a valid
  // first event) the frame still streams through untouched, because honesty beats replay once
  // the client has seen bytes. ≥2 candidates throughout.
  const SSE_HEADERS = { "content-type": "text/event-stream" };
  const ERROR_FRAME =
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
  const START_FRAME =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
  const STOP_FRAME = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

  const streamReq = (p: number) =>
    fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", stream: true, max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    });

  it("an error frame as the FIRST event fails over invisibly to the next member", async () => {
    const a = await scripted(() => ({ headers: SSE_HEADERS, body: ERROR_FRAME }));
    const b = await scripted(() => ({ headers: SSE_HEADERS, body: START_FRAME + STOP_FRAME }));
    const p = port(
      await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`], "anthropic")),
    );

    const resp = await streamReq(p);
    const body = await resp.text();
    expect(resp.status).toBe(200);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(body).toContain("message_stop");
    expect(body).not.toContain("Overloaded"); // the first member's error never reached the client
  });

  it("an error frame AFTER a valid first event streams through — post-commit honesty is unchanged", async () => {
    const a = await scripted(() => ({ headers: SSE_HEADERS, body: START_FRAME + ERROR_FRAME }));
    const b = await scripted(() => ({ headers: SSE_HEADERS, body: START_FRAME + STOP_FRAME }));
    const p = port(
      await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`], "anthropic")),
    );

    const resp = await streamReq(p);
    const body = await resp.text();
    expect(resp.status).toBe(200);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(0); // committed to the first stream; no replay behind the client's back
    expect(body).toContain("Overloaded");
  });

  it("last candidate: the synthesized 502 carries the upstream's own message excerpt", async () => {
    const a = await scripted(() => ({ headers: SSE_HEADERS, body: ERROR_FRAME }));
    const b = await scripted(() => ({ headers: SSE_HEADERS, body: ERROR_FRAME }));
    const p = port(
      await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`], "anthropic")),
    );

    const resp = await streamReq(p);
    expect(resp.status).toBe(502);
    expect(await resp.text()).toContain("Overloaded");
  });
});
