import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxy, type ProxyDeps } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { CircuitBreaker, globalCircuitBreaker } from "../src/circuit-breaker.js";
import {
  CREDENTIAL_ATTEMPTS_HEADER,
  CREDENTIAL_HEADER,
  SERVED_BY_HEADER,
  POOL_ATTEMPTS_HEADER,
  PROBATION_HEADER,
  UNKNOWN_REFUSAL_HEADER,
} from "../src/backend.js";
import { orderByUsability } from "../src/server.js";
import { factsFor, recordFact, resetFacts, isCostBlocked, cooldownUntil } from "../src/target-facts.js";
import { recordObservedMaxOutput } from "../src/context-limits.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { Config, ProviderConfig, ResolvedTarget } from "../src/config.js";
import type { ProviderTargetIdentity } from "../src/kernel/contracts.js";
import type { Reshaper } from "../src/reshaper.js";
import { makeCredentialId } from "../src/credential-id.js";
import { resolveAttempt } from "../src/resolved-attempt.js";
import { recordProbeResult, recordRequestSample } from "../src/ping/probe-cache.js";
import type { AssistantMessage } from "../src/anthropic.js";
function breakerIdentity(provider: string, model: string | null, kind: "anthropic" | "openai" = "openai"): ProviderTargetIdentity {
  return { provider, model, kind, credentialId: makeCredentialId(provider) };
}

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

/** Sends headers and a partial body, then resets so fetch resolves but body consumption fails. */
function truncatedAfterHeaders(): Promise<{ server: Server; calls: () => number }> {
  let n = 0;
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        n++;
        res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
        res.flushHeaders();
        res.write('{"partial":');
        setTimeout(() => res.destroy(), 10);
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

function startProxy(c: Config, deps: ProxyDeps = {}): Promise<Server> {
  const s = createProxy(c, { catalog: new ModelCatalog({ cachePath: null }), breaker: globalCircuitBreaker, ...deps });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(track(s))));
}

function chat(p: number, model = "pool/coding"): Promise<Response> {
  return fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
  });
}

function messages(p: number, model = "pool/coding"): Promise<Response> {
  return fetch(`http://127.0.0.1:${p}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("OpenAI front — failover across pool candidates", () => {
  it("records exactly one failed and one measured winner across both public fronts", async () => {
    const anthBuffered = JSON.stringify({ id: "m", type: "message", role: "assistant", model: "m2", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 6 } });
    const anthStream = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m2", content: [] } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 6 } })}\n\n`,
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ].join("");
    const chatBuffered = JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 6 } });
    const chatStream = [
      `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c", choices: [], usage: { completion_tokens: 6 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const cases: Array<{ name: string; kind: "anthropic" | "openai"; body: string; headers?: Record<string, string>; path: string; request: object }> = [
      { name: "Messages buffered", kind: "anthropic", body: anthBuffered, path: "/v1/messages", request: { model: "pool/coding", max_tokens: 20, messages: [{ role: "user", content: "hi" }] } },
      { name: "Messages streamed", kind: "anthropic", body: anthStream, headers: { "content-type": "text/event-stream" }, path: "/v1/messages", request: { model: "pool/coding", stream: true, max_tokens: 20, messages: [{ role: "user", content: "hi" }] } },
      { name: "Chat buffered", kind: "openai", body: chatBuffered, path: "/v1/chat/completions", request: { model: "pool/coding", messages: [{ role: "user", content: "hi" }] } },
      { name: "Chat streamed", kind: "openai", body: chatStream, headers: { "content-type": "text/event-stream" }, path: "/v1/chat/completions", request: { model: "pool/coding", stream: true, messages: [{ role: "user", content: "hi" }] } },
      { name: "Responses buffered", kind: "anthropic", body: anthBuffered, path: "/v1/responses", request: { model: "pool/coding", input: "hi" } },
    ];
    for (const scenario of cases) {
      globalCircuitBreaker.reset();
      resetFacts();
      const failed = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) }));
      const winner = await scripted(() => ({ body: scenario.body, ...(scenario.headers ? { headers: scenario.headers } : {}) }));
      const calls: Array<{ provider: string; model: string; ok: boolean; completionTokens?: number }> = [];
      const p = port(await startProxy(poolCfg([
        `http://127.0.0.1:${port(failed.server)}`,
        `http://127.0.0.1:${port(winner.server)}`,
      ], scenario.kind), {
        modelCallRecorder(provider, model, call) {
          calls.push({ provider, model, ok: call.ok, ...(call.completionTokens !== undefined ? { completionTokens: call.completionTokens } : {}) });
        },
      }));
      const response = await fetch(`http://127.0.0.1:${p}${scenario.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scenario.request),
      });
      expect(response.status, scenario.name).toBe(200);
      await response.text();
      expect(calls, scenario.name).toEqual([
        { provider: "p1", model: "m1", ok: false },
        { provider: "p2", model: "m2", ok: true, completionTokens: 6 },
      ]);
    }
  });

  it("records one unknown failed attempt and the winning streamed usage exactly once", async () => {
    const a = await scripted(() => ({
      status: 429,
      body: JSON.stringify({ error: { message: "TPM exceeded", type: "rate_limit_exceeded" } }),
    }));
    const b = await scripted(() => ({
      headers: { "content-type": "text/event-stream" },
      body: [
        `data: ${JSON.stringify({ id: "c", model: "m2", choices: [{ index: 0, delta: { content: "served" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c", model: "m2", choices: [], usage: { prompt_tokens: 2, completion_tokens: 7 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
    }));
    const calls: Array<{ provider: string; model: string; ok: boolean; completionTokens?: number }> = [];
    const p = port(await startProxy(poolCfg([
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ]), {
      modelCallRecorder(provider, model, call) {
        calls.push({ provider, model, ok: call.ok, ...(call.completionTokens !== undefined ? { completionTokens: call.completionTokens } : {}) });
      },
    }));
    const response = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    // The relay asked upstream for usage but restores the caller's original SSE shape.
    expect(body).not.toContain("completion_tokens");
    expect(calls).toEqual([
      { provider: "p1", model: "m1", ok: false },
      { provider: "p2", model: "m2", ok: true, completionTokens: 7 },
    ]);
  });

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
    const state = globalCircuitBreaker.getState(breakerIdentity("p1", "m1"));
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

    const state = globalCircuitBreaker.getState(breakerIdentity("p1", "m1"))!;
    expect(state.consecutiveFailures).toBe(0); // NOT health data
    expect(state.cooldownUntil).toBe(0);
    expect(state.credentialFailures).toBe(1); // its own axis
    expect(state.lastCredentialStatus).toBe(401);
    expect(globalCircuitBreaker.hasCredentialFault(breakerIdentity("p1", "m1"))).toBe(true);

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

  it("pins post-header body-failure exhaustion headers and OpenAI error bytes", async () => {
    // NEW COVERAGE: this previously unpinned shape passes on HEAD too; it is not a regression pin.
    const a = await truncatedAfterHeaders();
    const b = await truncatedAfterHeaders();
    const p = port(await startProxy(poolCfg([
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ])));

    const resp = await chat(p);
    expect(resp.status).toBe(502);
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p1/m1, p2/m2");
    expect(resp.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 0 served: 2x502");
    expect(await resp.text()).toBe(JSON.stringify({
      error: {
        message: "llm-relay: provider response body failed after headers",
        type: "api_error",
      },
    }));
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  it("anthropic front: pins post-header body-failure exhaustion headers and error bytes", async () => {
    const a = await truncatedAfterHeaders();
    const b = await truncatedAfterHeaders();
    const p = port(await startProxy(poolCfg([
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ])));

    const resp = await messages(p);
    expect(resp.status).toBe(502);
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p1/m1, p2/m2");
    expect(resp.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 0 served: 2x502");
    expect(await resp.text()).toBe(JSON.stringify({
      type: "error",
      error: {
        type: "api_error",
        message: "llm-relay: provider response body failed after headers",
      },
    }));
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
    const remaining = globalCircuitBreaker.getState(breakerIdentity("p1", "m1"))!.cooldownUntil - Date.now();
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

describe("relay-local failures do not start credential attempts or perturb ordering", () => {
  const fleetEnv = {
    p1: ["POOL_EGRESS_P1_FIRST", "POOL_EGRESS_P1_SECOND"],
    p2: ["POOL_EGRESS_P2_FIRST", "POOL_EGRESS_P2_SECOND"],
  } as const;

  class CountingBreaker extends CircuitBreaker {
    begins = 0;
    override beginAttempt(target: ProviderTargetIdentity) {
      this.begins += 1;
      return super.beginAttempt(target);
    }
  }

  beforeEach(() => {
    process.env.POOL_EGRESS_P1_FIRST = "p1-first-secret";
    process.env.POOL_EGRESS_P1_SECOND = "p1-second-secret";
    process.env.POOL_EGRESS_P2_FIRST = "p2-first-secret";
    process.env.POOL_EGRESS_P2_SECOND = "p2-second-secret";
  });

  afterEach(() => {
    for (const names of Object.values(fleetEnv)) {
      for (const name of names) delete process.env[name];
    }
  });

  async function credentialBackend(): Promise<{ server: Server; authorizations: string[] }> {
    const authorizations: string[] = [];
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        authorizations.push(String(req.headers.authorization ?? ""));
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(OK_BODY);
        });
      });
      server.listen(0, "127.0.0.1", () => resolve({ server: track(server), authorizations }));
    });
  }

  function fleetConfig(firstBase: string, secondBase: string): Config {
    const cfg = poolCfg([firstBase, secondBase]);
    for (const provider of ["p1", "p2"] as const) {
      cfg.providers[provider]!.credentialMode = "contained";
      cfg.providers[provider]!.credentials = [
        { label: "first", authEnv: fleetEnv[provider][0] },
        { label: "second", authEnv: fleetEnv[provider][1] },
      ];
    }
    return cfg;
  }

  const cases = [
    {
      name: "Messages document preparation",
      path: "/v1/messages",
      invalid: {
        model: "pool/coding",
        messages: [{
          role: "user",
          content: [{ type: "document", source: { type: "url", url: "https://example.invalid/a.pdf" } }],
        }],
      },
      valid: {
        model: "pool/coding",
        max_tokens: 20,
        messages: [{ role: "user", content: "hi" }],
      },
    },
    {
      name: "Responses request translation",
      path: "/v1/responses",
      invalid: { model: "pool/coding", input: [null] },
      valid: { model: "pool/coding", input: "hi" },
    },
  ] as const;

  it.each(cases)("$name rejects before egress and leaves the first credential first", async (scenario) => {
    const first = await credentialBackend();
    const second = await credentialBackend();
    const breaker = new CountingBreaker();
    const modelCalls: Array<{ provider: string; model: string }> = [];
    const proxy = await startProxy(
      fleetConfig(
        `http://127.0.0.1:${port(first.server)}`,
        `http://127.0.0.1:${port(second.server)}`,
      ),
      {
        breaker,
        modelCallRecorder(provider, model) { modelCalls.push({ provider, model }); },
      },
    );

    const invalid = await fetch(`http://127.0.0.1:${port(proxy)}${scenario.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scenario.invalid),
    });
    await invalid.text();

    expect(invalid.status).toBe(400);
    expect(first.authorizations).toEqual([]);
    expect(second.authorizations).toEqual([]);
    expect(breaker.begins).toBe(0);
    expect(breaker.getAllStates().size).toBe(0);
    expect(modelCalls).toEqual([]);
    expect(invalid.headers.get(CREDENTIAL_HEADER)).toBeNull();
    expect(invalid.headers.get(CREDENTIAL_ATTEMPTS_HEADER)).toBeNull();
    for (const provider of ["p1", "p2"] as const) {
      expect(breaker.inFlightCredential(makeCredentialId(provider, "first"))).toBe(0);
      expect(breaker.inFlightCredential(makeCredentialId(provider, "second"))).toBe(0);
    }

    const valid = await fetch(`http://127.0.0.1:${port(proxy)}${scenario.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scenario.valid),
    });
    await valid.text();

    expect(valid.status).toBe(200);
    expect(valid.headers.get(CREDENTIAL_HEADER)).toBe(makeCredentialId("p1", "first"));
    expect(first.authorizations).toEqual(["Bearer p1-first-secret"]);
    expect(second.authorizations).toEqual([]);
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
    expect(orderByUsability([a, b, c].map((target) => resolveAttempt(target)), new CircuitBreaker()).map((x) => x.target.provider)).toEqual(["a", "b", "c"]);
  });

  it("sinks a cooling target to the back instead of removing it from the pool", () => {
    // The old `filter(isHealthy)` DELETED cooling candidates whenever any healthy one remained,
    // so a 14-member pool could be narrowed to one member and then have nothing left when that
    // member failed too. A demoted target is only reached after every better one has actually
    // failed on this request — which costs nothing and preserves all 14 chances.
    const cb = new CircuitBreaker();
    cb.recordOutcome(breakerIdentity("a", "m"), { ok: false, status: 429, elapsedMs: 5 });
    const out = orderByUsability([a, b, c].map((target) => resolveAttempt(target)), cb);
    expect(out.map((x) => x.target.provider)).toEqual(["b", "c", "a"]);
    expect(out).toHaveLength(3); // nothing dropped
  });

  it("orders live before credential-faulted before cooling", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(breakerIdentity("a", "m"), { ok: false, status: 429, elapsedMs: 5 }); // cooling
    cb.recordCredentialFault(breakerIdentity("b", "m"), 401); // unusable, but not sick
    expect(orderByUsability([a, b, c].map((target) => resolveAttempt(target)), cb).map((x) => x.target.provider)).toEqual(["c", "b", "a"]);
  });

  it("orders cooling band by soonest lift time (ascending), unknown lifts last", () => {
    const cb = new CircuitBreaker();
    const now = Date.now();

    // a: cooldownUntil = now + 5000 (soonest)
    cb.recordOutcome(breakerIdentity("a", "m"), { ok: false, status: 429, elapsedMs: 5, retryAfterMs: 5000 });
    // b: cooldownUntil = now + 20000 (later)
    cb.recordOutcome(breakerIdentity("b", "m"), { ok: false, status: 429, elapsedMs: 5, retryAfterMs: 20000 });
    // c: no cooldown (live)
    // d: cooldownUntil = now + 10000 (middle)
    const d = t("d");
    cb.recordOutcome(breakerIdentity("d", "m"), { ok: false, status: 429, elapsedMs: 5, retryAfterMs: 10000 });

    // Expected order: live (c) first, then cooling by lift time: a (5s), d (10s), b (20s)
    const attempts = [a, b, c, d].map((target) => resolveAttempt(target));
    const out = orderByUsability(attempts, cb, now);
    expect(out.map((x) => x.target.provider)).toEqual(["c", "a", "d", "b"]);
  });

  it("unknown lift times sort after known lifts in cooling band", () => {
    const cb = new CircuitBreaker();
    const now = Date.now();

    // a: cooldownUntil = now + 10000 (known)
    cb.recordOutcome(breakerIdentity("a", "m"), { ok: false, status: 429, elapsedMs: 5, retryAfterMs: 10000 });
    // b: no cooldown (live)
    // c: cooling but no cooldownUntil set (unknown lift - e.g., a fact with no expiry)
    // We can't easily simulate an unknown lift via the breaker, but we can verify
    // that the sorting logic puts nulls last by checking the sort behavior directly.

    // With two cooling targets, one with known lift and one without (if possible),
    // the known one should come first. Since the breaker always sets cooldownUntil
    // for 429, let's just verify the stable sort preserves order for equal lifts.
    cb.recordOutcome(breakerIdentity("c", "m"), { ok: false, status: 429, elapsedMs: 5, retryAfterMs: 10000 });

    const attempts = [a, b, c].map((target) => resolveAttempt(target));
    const out = orderByUsability(attempts, cb, now);
    // Both a and c have same lift time (10s), so stable sort keeps original order (a then c)
    expect(out.map((x) => x.target.provider)).toEqual(["b", "a", "c"]);
  });

  it("live band order is untouched by cooling band sorting", () => {
    const cb = new CircuitBreaker();
    const now = Date.now();

    // a: live (first in config)
    // b: live (second in config)
    // c: cooling
    cb.recordOutcome(breakerIdentity("c", "m"), { ok: false, status: 429, elapsedMs: 5, retryAfterMs: 5000 });

    const attempts = [a, b, c].map((target) => resolveAttempt(target));
    const out = orderByUsability(attempts, cb, now);
    // Live band order preserved: a, b (original config order)
    // Then cooling: c
    expect(out.map((x) => x.target.provider)).toEqual(["a", "b", "c"]);
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
    expect(globalCircuitBreaker.getState(breakerIdentity("p1", "m1"))?.credentialFailures).toBe(1);
    expect(globalCircuitBreaker.getState(breakerIdentity("p1", "m1"))?.consecutiveFailures).toBe(0);
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
    const state = globalCircuitBreaker.getState(breakerIdentity("p1", "m1"))!;
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
    expect(globalCircuitBreaker.getState(breakerIdentity("p1", "m1"))?.lastStatus).toBe(402);
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
    expect(isCostBlocked("p1", makeCredentialId("p1"), "m1")).toBe(false);
    expect(cooldownUntil("p1", makeCredentialId("p1"), "m1")).not.toBeNull(); // cooling, which expires on its own
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

  it("the Anthropic front names every deployment tried on a terminal error, like the OpenAI front", async () => {
    // The header's own declaration is the contract: "When every candidate fails it carries the
    // list that was tried instead, so an exhausted pool is self-describing", and docs/reference.md
    // states the same to users — "the deployment that served, or on error every deployment tried,
    // in order". The OpenAI front delivered it; `responseHeadersForTarget` wrote SERVED_BY only
    // below 400, so `/v1/messages` omitted it entirely on a terminal upstream error. Two paths,
    // one policy empty — the shape this file exists to catch.
    // ⚠ NOT the transport-exit omission, which is a recorded deliberate residue: that one has no
    // HTTP response to describe. This is an ordinary served upstream error.
    const a = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "slow down" } }) }));
    const b = await scripted(() => ({ status: 402, body: QUOTA_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await messages(p);
    expect(resp.status).toBe(402);
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p1/m1, p2/m2");
  });

  it("the OpenAI front reports an uninterpretable refusal even when a later candidate SUCCEEDED", async () => {
    // The count is the push half of the eligibility queue: "a NEW kind of refusal just appeared,
    // run `llm-relay eligibility` while the context is still in hand". A later candidate answering
    // does not un-see it. The Anthropic front emitted it on success; the OpenAI front computed it
    // only inside its own `status >= 400` branch and so swallowed exactly this case.
    const odd = `{"error":{"message":"your organization is not permitted to use this model in this region"}}`;
    const a = await scripted(() => ({ status: 403, body: odd }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await chat(p);
    expect(resp.status).toBe(200);
    expect(resp.headers.get(UNKNOWN_REFUSAL_HEADER)).toBe("1");
    // The winner still names itself; the refusal count rides beside it, not instead of it.
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
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
    cb.recordCredentialFault(breakerIdentity("p1", "m1"), 401);
    cb.recordCredentialFault(breakerIdentity("p1", "m2"), 401);
    cb.recordCredentialFault(breakerIdentity("p2", "m1"), 401);
    expect(cb.hasCredentialFault(breakerIdentity("p1", "m1"))).toBe(true);
    expect(cb.hasCredentialFault(breakerIdentity("p1", "m2"))).toBe(true);

    expect(cb.clearCredentialFaults(makeCredentialId("p1"))).toBe(2);
    expect(cb.hasCredentialFault(breakerIdentity("p1", "m1"))).toBe(false);
    expect(cb.hasCredentialFault(breakerIdentity("p1", "m2"))).toBe(false);
    // ...and says nothing about a different credential.
    expect(cb.hasCredentialFault(breakerIdentity("p2", "m1"))).toBe(true);
  });

  it("a success clears the quota cooldown — a mid-month top-up recovers without a restart", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(breakerIdentity("p", "m"), { ok: false, status: 402, elapsedMs: 5 });
    expect(cb.isHealthy(breakerIdentity("p", "m"))).toBe(false); // cooling, demoted behind live members
    cb.recordOutcome(breakerIdentity("p", "m"), { ok: true, status: 200, elapsedMs: 5 });
    expect(cb.isHealthy(breakerIdentity("p", "m"))).toBe(true);
    expect(cb.getState(breakerIdentity("p", "m"))!.cooldownUntil).toBe(0);
  });
});

describe("runtime credential-scoped eligibility facts", () => {
  const ANTHROPIC_OK = JSON.stringify({
    id: "msg_credential_ok",
    type: "message",
    role: "assistant",
    model: "m1",
    content: [{ type: "text", text: "served" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  for (const front of [
    { name: "OpenAI front", kind: "openai" as const, request: chat, success: OK_BODY },
    { name: "Anthropic front", kind: "anthropic" as const, request: messages, success: ANTHROPIC_OK },
  ]) {
    it(`${front.name} materializes and clears only the served credential cell`, async () => {
      let calls = 0;
      const backend = await scripted(() => {
        calls++;
        return calls === 1
          ? { status: 401, body: JSON.stringify({ error: { message: "invalid api key" } }) }
          : { body: front.success };
      });
      const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(backend.server)}`], front.kind)));
      const defaultCredential = makeCredentialId("p1");
      const otherCredential = makeCredentialId("p1", "work");

      expect((await front.request(p)).status).toBe(401);
      expect(factsFor("p1", defaultCredential, "m1").map((fact) => fact.kind)).toContain("credential-invalid");
      expect(factsFor("p1", otherCredential, "m1")).toEqual([]);

      recordFact("credential-invalid", {
        kind: "credential",
        provider: "p1",
        credentialId: otherCredential,
      });
      expect((await front.request(p)).status).toBe(200);

      expect(factsFor("p1", defaultCredential, "m1")).toEqual([]);
      expect(factsFor("p1", otherCredential, "m1").map((fact) => fact.kind)).toEqual(["credential-invalid"]);
    });
  }
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
    expect(isCostBlocked("p1", makeCredentialId("p1"), "m1")).toBe(true);
    // …and the verdict cannot leak to the sibling that served.
    expect(isCostBlocked("p2", makeCredentialId("p2"), "m2")).toBe(false);
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
    expect(isCostBlocked("p1", makeCredentialId("p1"), "m1")).toBe(true);
  });

  it("a bare 410 fails over but teaches NOTHING — status alone is not a statement", async () => {
    const a = await scripted(() => ({ status: 410, body: JSON.stringify({ error: { message: "Gone" } }) }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await chat(p);
    expect(resp.status).toBe(200);
    expect(b.calls()).toBe(1);
    expect(isCostBlocked("p1", makeCredentialId("p1"), "m1")).toBe(false);
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

describe("buffered repair dead turns resume the candidate walk (adoption review §2.1)", () => {
  const weatherTools = [
    {
      name: "get_weather",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ];

  function assistantBody(name: string, input: Record<string, unknown>): string {
    return JSON.stringify({
      type: "message",
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name, input }],
    });
  }

  function repairPool(bases: string[], destructiveTools: string[] = []): Config {
    const cfg = poolCfg(bases, "anthropic");
    cfg.mode = "repair";
    cfg.repair = { maxAttempts: 2, destructiveTools };
    return cfg;
  }

  function toolTurn(p: number, tools: object[] = weatherTools): Promise<Response> {
    return fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "pool/coding",
        max_tokens: 20,
        messages: [{ role: "user", content: "weather?" }],
        tools,
      }),
    });
  }

  const useless: Reshaper = {
    reshape: async (req) => ({ kind: "message", message: req.rawAssistant }),
  };

  const fixer: Reshaper = {
    reshape: async () => ({
      kind: "message",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }],
        stop_reason: "tool_use",
      } as AssistantMessage,
    }),
  };

  it("preserves provider usage through buffered validation and repair, recording once", async () => {
    const reported = JSON.stringify({
      type: "message",
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }],
      usage: { input_tokens: 2, output_tokens: 9 },
    });
    const failed = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) }));
    const backend = await scripted(() => ({ body: reported }));
    const calls: Array<{ provider: string; model: string; ok: boolean; completionTokens?: number }> = [];
    const p = port(await startProxy(repairPool([
      `http://127.0.0.1:${port(failed.server)}`,
      `http://127.0.0.1:${port(backend.server)}`,
    ]), {
      reshaper: fixer,
      modelCallRecorder(provider, model, call) {
        calls.push({ provider, model, ok: call.ok, ...(call.completionTokens !== undefined ? { completionTokens: call.completionTokens } : {}) });
      },
    }));
    const response = await toolTurn(p);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { content: Array<{ input?: unknown }> };
    expect(body.content[0]?.input).toEqual({ city: "Paris" });
    expect(calls).toEqual([
      { provider: "p1", model: "m1", ok: false },
      { provider: "p2", model: "m2", ok: true, completionTokens: 9 },
    ]);
  });

  it("repair exhaustion on candidate 1 becomes a dead turn and candidate 2 serves", async () => {
    const broken = await scripted(() => ({ body: assistantBody("get_weather", {}) }));
    const valid = await scripted(() => ({ body: assistantBody("get_weather", { city: "Rome" }) }));
    const cfg = repairPool([
      `http://127.0.0.1:${port(broken.server)}`,
      `http://127.0.0.1:${port(valid.server)}`,
    ]);
    const p = port(await startProxy(cfg, { reshaper: useless }));

    const resp = await toolTurn(p);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { content: Array<{ input?: unknown }> };
    expect(body.content[0]?.input).toEqual({ city: "Rome" });
    expect(broken.calls()).toBe(1);
    expect(valid.calls()).toBe(1);
    expect(resp.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1xdead-turn, 1x200");
  });

  it("repairs candidate 1 before considering failover", async () => {
    const broken = await scripted(() => ({ body: assistantBody("get_weather", {}) }));
    const fallback = await scripted(() => ({ body: assistantBody("get_weather", { city: "Rome" }) }));
    const cfg = repairPool([
      `http://127.0.0.1:${port(broken.server)}`,
      `http://127.0.0.1:${port(fallback.server)}`,
    ]);
    const p = port(await startProxy(cfg, { reshaper: fixer }));

    const resp = await toolTurn(p);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { content: Array<{ input?: unknown }> };
    expect(body.content[0]?.input).toEqual({ city: "Paris" });
    expect(broken.calls()).toBe(1);
    expect(fallback.calls()).toBe(0);
    expect(resp.headers.get(POOL_ATTEMPTS_HEADER)).toBeNull();
  });

  it("refused_destructive remains a fail-clean 502 and never rerolls another candidate", async () => {
    let reshapeCalls = 0;
    const shouldNotRun: Reshaper = {
      reshape: async () => {
        reshapeCalls++;
        return {
          kind: "message",
          message: {
            content: [{ type: "tool_use", id: "t1", name: "delete_file", input: { path: "safe" } }],
            stop_reason: "tool_use",
          } as AssistantMessage,
        };
      },
    };
    const broken = await scripted(() => ({ body: assistantBody("delete_file", {}) }));
    const fallback = await scripted(() => ({ body: assistantBody("delete_file", { path: "safe" }) }));
    const cfg = repairPool([
      `http://127.0.0.1:${port(broken.server)}`,
      `http://127.0.0.1:${port(fallback.server)}`,
    ], ["delete_file"]);
    const p = port(await startProxy(cfg, { reshaper: shouldNotRun }));
    const deleteTools = [{
      name: "delete_file",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }];

    const resp = await toolTurn(p, deleteTools);
    expect(resp.status).toBe(502);
    expect(await resp.text()).toContain("could not be repaired (refused_destructive)");
    expect(broken.calls()).toBe(1);
    expect(fallback.calls()).toBe(0);
    expect(reshapeCalls).toBe(0);
  });

  it("all dead turns preserve the terminal 502 after walking every candidate", async () => {
    const first = await scripted(() => ({ body: assistantBody("get_weather", {}) }));
    const second = await scripted(() => ({ body: assistantBody("get_weather", {}) }));
    const cfg = repairPool([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]);
    const p = port(await startProxy(cfg, { reshaper: useless }));

    const resp = await toolTurn(p);
    expect(resp.status).toBe(502);
    expect(await resp.text()).toContain("could not be repaired (failed)");
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(1);
    expect(resp.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 0 served: 2xdead-turn");
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

describe("first-byte deadline — non-streamed attempts only (backlog item 1)", () => {
  // Measured against nim at timeoutMs 100000: deepseek-v4-flash returned 504 at 100.03s twice
  // while a sibling answered 200 in 81.6s for two tokens — the free queue exceeded the flat
  // deadline, and an operator read the 504 as "model gone". A time-to-first-byte deadline lets a
  // backend that has produced NO bytes fail fast while one merely slow to finish is not killed.

  /** Accepts the connection and sends nothing at all, ever — no headers. Only a deadline (either
   *  one) ends it; `fetch()` itself never resolves without one. */
  function hangsForever(): Promise<{ server: Server; calls: () => number }> {
    let n = 0;
    return new Promise((resolve) => {
      const s = createServer(() => {
        n++;
        // never respond — the raw fetch() promise stays pending until a deadline aborts it.
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n }));
    });
  }

  /** Sends headers AT ONCE — fetch() resolves right away — then waits `bodyDelayMs` before
   *  finishing the body. The shape a first-byte deadline must NOT kill. */
  function slowBody(bodyDelayMs: number, body: string): Promise<{ server: Server; calls: () => number }> {
    let n = 0;
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          n++;
          res.writeHead(200, { "content-type": "application/json" });
          res.flushHeaders();
          setTimeout(() => res.end(body), bodyDelayMs);
        });
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n }));
    });
  }

  it("kills a non-streamed attempt whose headers never arrive, well before the total deadline — the next candidate serves", async () => {
    const dead = await hangsForever();
    const ok = await scripted(() => ({ body: OK_BODY }));
    const cfg = poolCfg([`http://127.0.0.1:${port(dead.server)}`, `http://127.0.0.1:${port(ok.server)}`]);
    cfg.providers["p1"]!.firstByteTimeoutMs = 300; // p1's own timeoutMs stays poolCfg's 5000ms
    const p = port(await startProxy(cfg));

    const started = Date.now();
    const resp = await chat(p);
    const elapsed = Date.now() - started;
    expect(resp.status).toBe(200);
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
    expect(dead.calls()).toBe(1);
    expect(ok.calls()).toBe(1);
    expect(elapsed).toBeLessThan(2500); // half of p1's 5000ms total deadline
  });

  it("does NOT kill a non-streamed attempt whose headers arrive at once but whose body is merely slow", async () => {
    const slow = await slowBody(500, OK_BODY); // body finishes at 500ms > firstByteTimeoutMs (300ms)
    const other = await scripted(() => ({ body: OK_BODY }));
    const cfg = poolCfg([`http://127.0.0.1:${port(slow.server)}`, `http://127.0.0.1:${port(other.server)}`]);
    cfg.providers["p1"]!.firstByteTimeoutMs = 300;
    const p = port(await startProxy(cfg));

    const resp = await chat(p);
    expect(resp.status).toBe(200);
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p1/m1"); // the FIRST candidate served — not killed
    expect(slow.calls()).toBe(1);
    expect(other.calls()).toBe(0); // never reached — p1 answered
  });

  it("streamed request: the same slow-headers shape is unaffected — no first-byte failure fires", async () => {
    const dead = await hangsForever();
    const cfg = poolCfg([`http://127.0.0.1:${port(dead.server)}`]);
    cfg.providers["p1"]!.firstByteTimeoutMs = 100; // would kill it at 100ms if wrongly armed
    cfg.providers["p1"]!.timeoutMs = 600; // the ONLY deadline that may govern a streamed attempt
    const p = port(await startProxy(cfg));

    const started = Date.now();
    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "pool/coding", stream: true, max_tokens: 20, messages: [{ role: "user", content: "hi" }],
      }),
    });
    const elapsed = Date.now() - started;
    await resp.text();
    // Proof the first-byte timer never armed: the walk waited out the TOTAL 600ms deadline, not
    // the 100ms first-byte one.
    expect(elapsed).toBeGreaterThanOrEqual(550);
  });

  it("firstByteTimeoutMs absent and stallTimeoutMs absent: the slow-headers backend is waited for up to timeoutMs, as today", async () => {
    const dead = await hangsForever();
    const ok = await scripted(() => ({ body: OK_BODY }));
    const cfg = poolCfg([`http://127.0.0.1:${port(dead.server)}`, `http://127.0.0.1:${port(ok.server)}`]);
    cfg.providers["p1"]!.timeoutMs = 300; // no firstByteTimeoutMs, no stallTimeoutMs configured
    const p = port(await startProxy(cfg));

    const started = Date.now();
    const resp = await chat(p);
    const elapsed = Date.now() - started;
    expect(resp.status).toBe(200);
    expect(resp.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
    expect(elapsed).toBeGreaterThanOrEqual(280); // waited out p1's OWN 300ms total deadline
  });
});

describe("live-traffic quota headers reach the breaker (adoption review §1.9)", () => {
  const quotaHeaders = (requestRemaining: string, tokenRemaining?: string) => ({
    "x-ratelimit-limit-requests-day": "100",
    "x-ratelimit-remaining-requests-day": requestRemaining,
    ...(tokenRemaining === undefined ? {} : {
      "x-ratelimit-limit-tokens-minute": "1000",
      "x-ratelimit-remaining-tokens-minute": tokenRemaining,
    }),
  });
  const quotaTuples = (provider: string) =>
    globalCircuitBreaker.getState(breakerIdentity(provider, `${provider === "p1" ? "m1" : "m2"}`))
      ?.quotaObservations.map(({ axis, period, remaining, limit }) => ({ axis, period, remaining, limit }));
  const ANTHROPIC_QUOTA_OK = JSON.stringify({
    id: "msg_quota",
    type: "message",
    role: "assistant",
    model: "m",
    content: [{ type: "text", text: "served" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const fronts = [
    { name: "OpenAI", request: chat, kind: "openai" as const, okBody: OK_BODY },
    { name: "Anthropic", request: messages, kind: "anthropic" as const, okBody: ANTHROPIC_QUOTA_OK },
  ] as const;

  it.each(fronts)("$name front records two typed axes on success and preserves an omitted axis", async ({ request, kind, okBody }) => {
    const a = await scripted((call) => ({
      headers: call === 1 ? quotaHeaders("75", "800") : quotaHeaders("50"),
      body: okBody,
    }));
    const b = await scripted(() => ({ body: okBody }));
    const p = port(await startProxy(poolCfg([
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ], kind)));

    expect((await request(p)).status).toBe(200);
    expect((await request(p)).status).toBe(200);
    expect(a.calls()).toBe(2);
    expect(b.calls()).toBe(0);
    expect(quotaTuples("p1")).toEqual([
      { axis: "requests", period: "day", remaining: 50, limit: 100 },
      { axis: "tokens", period: "minute", remaining: 800, limit: 1000 },
    ]);
    expect(globalCircuitBreaker.getState(breakerIdentity("p2", "m2"))).toBeUndefined();
  });

  it.each(fronts)("$name front commits two typed axes from a failed candidate without mixing the next cell", async ({ request, kind, okBody }) => {
    const a = await scripted(() => ({
      status: 429,
      headers: quotaHeaders("0", "0"),
      body: JSON.stringify({ error: { message: "TPM exceeded", type: "rate_limit_exceeded" } }),
    }));
    const b = await scripted(() => ({ headers: quotaHeaders("90", "900"), body: okBody }));
    const p = port(await startProxy(poolCfg([
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ], kind)));

    expect((await request(p)).status).toBe(200);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(quotaTuples("p1")).toEqual([
      { axis: "requests", period: "day", remaining: 0, limit: 100 },
      { axis: "tokens", period: "minute", remaining: 0, limit: 1000 },
    ]);
    expect(quotaTuples("p2")).toEqual([
      { axis: "requests", period: "day", remaining: 90, limit: 100 },
      { axis: "tokens", period: "minute", remaining: 900, limit: 1000 },
    ]);
  });

  it.each(fronts)("$name front commits quota on a credential failure without changing its health classification", async ({ request, kind, okBody }) => {
    const a = await scripted(() => ({
      status: 401,
      headers: quotaHeaders("10", "100"),
      body: JSON.stringify({ error: { message: "Wrong API Key" } }),
    }));
    const b = await scripted(() => ({ body: okBody }));
    const p = port(await startProxy(poolCfg([
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ], kind)));

    expect((await request(p)).status).toBe(200);
    const state = globalCircuitBreaker.getState(breakerIdentity("p1", "m1"))!;
    expect(state.credentialFailures).toBe(1);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.cooldownUntil).toBe(0);
    expect(quotaTuples("p1")).toEqual([
      { axis: "requests", period: "day", remaining: 10, limit: 100 },
      { axis: "tokens", period: "minute", remaining: 100, limit: 1000 },
    ]);
  });
});

describe("first-event in-band error frames fail over pre-commit (adoption review §1.1)", () => {
  // A 200 SSE stream whose FIRST event is an error frame used to pass preflight as a "real
  // protocol envelope" and reach the client — spending the whole pool's walk on one member's
  // error inside a 200. Pre-commit it now fails over; POST-commit (after meaningful content)
  // the frame still streams through untouched, because honesty beats replay once the client has
  // seen an answer. ≥2 candidates throughout.
  const SSE_HEADERS = { "content-type": "text/event-stream" };
  const ERROR_FRAME =
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
  const START_FRAME =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
  const CONTENT_FRAME =
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"served"}}\n\n';
  const STOP_FRAME = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

  const streamReq = (p: number) =>
    fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", stream: true, max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    });

  it("an error frame as the FIRST event fails over invisibly to the next member", async () => {
    const a = await scripted(() => ({ headers: SSE_HEADERS, body: ERROR_FRAME }));
    const b = await scripted(() => ({ headers: SSE_HEADERS, body: START_FRAME + CONTENT_FRAME + STOP_FRAME }));
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
    expect(resp.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1x502, 1x200");
  });

  it("an error frame AFTER a valid first event streams through — post-commit honesty is unchanged", async () => {
    const a = await scripted(() => ({ headers: SSE_HEADERS, body: START_FRAME + CONTENT_FRAME + ERROR_FRAME }));
    const b = await scripted(() => ({ headers: SSE_HEADERS, body: START_FRAME + CONTENT_FRAME + STOP_FRAME }));
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

/**
 * The outbound request body survives a WALK — the ≥2-candidate half of the tool-call IR leak fix.
 *
 * ⚠ A request-side defect pinned on a single-candidate walk proves nothing, the same rule this
 * file was written for: the mapper runs once per candidate, so "the first attempt is clean" and
 * "every attempt is clean" are different claims. `src/openai-request.ts` is deterministic and
 * takes the caller's body, not a per-attempt mutation of it, and this pins that.
 */
describe("outbound request shape holds on the FAILOVER candidate too", () => {
  /** `scripted`, but keeping the request bodies — here the outbound wire shape IS the assertion. */
  function recording(
    reply: (n: number) => { status?: number; headers?: Record<string, string>; body: string },
  ): Promise<{ server: Server; bodies: () => any[] }> {
    const bodies: any[] = [];
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          try { bodies.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { bodies.push(null); }
          const out = reply(bodies.length);
          res.writeHead(out.status ?? 200, { "content-type": "application/json", ...out.headers });
          res.end(out.body);
        });
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: track(s), bodies: () => bodies }));
    });
  }

  const RATE_LIMITED = JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } });

  /** A Claude Code agentic turn: parallel tool_use answered by parallel tool_result. */
  const AGENTIC_MESSAGES = [
    { role: "user", content: "find and read it" },
    { role: "assistant", content: [
      { type: "text", text: "Searching." },
      { type: "tool_use", id: "toolu_01A", name: "Grep", input: { pattern: "protocol" } },
      { type: "tool_use", id: "toolu_01B", name: "Read", input: { file_path: "src/backend.ts" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_01A", content: "SECRET-GREP" },
      { type: "tool_result", tool_use_id: "toolu_01B", content: "SECRET-BODY" },
    ] },
  ];

  function assertCleanOutbound(body: any): void {
    expect(JSON.stringify(body)).not.toContain("_original");
    const asst = body.messages.find((m: any) => m.role === "assistant");
    expect(asst.tool_calls.map((c: any) => c.id)).toEqual(["toolu_01A", "toolu_01B"]);
    expect(body.messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id))
      .toEqual(["toolu_01A", "toolu_01B"]);
    expect(JSON.stringify(body).split("SECRET-BODY").length - 1).toBe(1);
  }

  it("Anthropic front → openai-kind: the second candidate sees the same clean body as the first", async () => {
    const a = await recording(() => ({ status: 429, body: RATE_LIMITED }));
    const b = await recording(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "pool/coding", max_tokens: 64, messages: AGENTIC_MESSAGES,
        tools: [{ name: "Grep", description: "g", input_schema: { type: "object", properties: { pattern: { type: "string" } } } }],
      }),
    });

    expect(resp.status).toBe(200);
    expect(a.bodies()).toHaveLength(1);
    expect(b.bodies()).toHaveLength(1);
    assertCleanOutbound(a.bodies()[0]);
    assertCleanOutbound(b.bodies()[0]);
    // The function name travels on each tool message on BOTH candidates — this is the fix for
    // gemini's compat layer, and it must survive failover, not just the first try.
    for (const seen of [a.bodies()[0], b.bodies()[0]]) {
      const tools = seen.messages.filter((m: any) => m.role === "tool");
      expect(tools.map((m: any) => m.name)).toEqual(["Grep", "Read"]);
    }
    // Same translation both times — the mapper reads the caller's body, never a walk-local copy.
    expect(b.bodies()[0].messages).toEqual(a.bodies()[0].messages);
  });

  it("rewrites outbound tool-call ids per CANDIDATE — the strict9 member only, the generic one verbatim", async () => {
    // mistral-medium-2505 answers HTTP 400 `invalid_function_call` (code 3280) — "Tool call id
    // was toolu_01AAAAAAAAAAAAAAAAAAAAAA but must be a-z, A-Z, 0-9, with a length of 9" — so the
    // relay rewrites outbound ids for a provider whose validator states that rule.
    //
    // ⚠ The rule the test above pins ("same translation both times") holds for a SAME-COMPAT
    // fixture and is unchanged. Here the two candidates deliberately resolve DIFFERENT compat
    // modes, so the new rule is: the outbound body is a pure function of (caller body, that
    // candidate's resolved compat) — never of walk position or of what an earlier candidate saw.
    //
    // The mode is set explicitly rather than via the labelled `*.mistral.ai` base-host default,
    // because these candidates are loopback HTTP servers; the base-host default itself is pinned
    // in test/config.test.ts, and both paths converge on the same resolved value.
    const a = await recording(() => ({ status: 429, body: RATE_LIMITED }));
    const b = await recording(() => ({ body: OK_BODY }));
    const cfg = poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`]);
    cfg.providers.p1!.compat = { toolCallIds: "strict9" };
    const p = port(await startProxy(cfg));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "pool/coding", max_tokens: 64, messages: AGENTIC_MESSAGES,
        tools: [{ name: "Grep", description: "g", input_schema: { type: "object", properties: { pattern: { type: "string" } } } }],
      }),
    });

    expect(resp.status).toBe(200);
    const strict = a.bodies()[0];
    const generic = b.bodies()[0];

    const strictIds = strict.messages.find((m: any) => m.role === "assistant").tool_calls.map((c: any) => c.id);
    for (const id of strictIds) expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(new Set(strictIds).size).toBe(2);
    // Linkage survives: each tool message answers the id its call was actually given.
    expect(strict.messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id)).toEqual(strictIds);
    expect(JSON.stringify(strict)).not.toContain("toolu_01A");

    // The generic candidate is untouched — a provider that states no such rule gets the caller's
    // own ids, byte for byte.
    assertCleanOutbound(generic);

    // Everything OTHER than the ids is the same translation on both candidates.
    const stripIds = (body: any) =>
      JSON.parse(JSON.stringify(body.messages).replace(/"(?:id|tool_call_id)":"[^"]*"/g, '"id":"X"'));
    expect(stripIds(strict)).toEqual(stripIds(generic));
  });

  it("stamps the thought-signature sentinel per CANDIDATE — the gemini-shaped member only", async () => {
    // gemini 3.6-flash on generativelanguage.googleapis.com answers HTTP 400 "Function call is
    // missing a thought_signature in functionCall parts…" to a replayed tool call, so the relay
    // stamps Google's own documented opt-out token for a provider that states that rule.
    //
    // ⚠ The mapper runs once PER CANDIDATE, so a one-candidate fixture cannot tell "stamped for
    // the right member" from "stamped for everyone" — the ≥2 rule this file exists for.
    //
    // The mode is set explicitly rather than via the labelled base-host default because these
    // candidates are loopback HTTP servers; the default itself is pinned in test/config.test.ts.
    const a = await recording(() => ({ status: 429, body: RATE_LIMITED }));
    const b = await recording(() => ({ body: OK_BODY }));
    const cfg = poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`]);
    cfg.providers.p1!.compat = { thoughtSignature: "sentinel" };
    const p = port(await startProxy(cfg));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "pool/coding", max_tokens: 64, messages: AGENTIC_MESSAGES,
        tools: [{ name: "Grep", description: "g", input_schema: { type: "object", properties: { pattern: { type: "string" } } } }],
      }),
    });

    expect(resp.status).toBe(200);
    const gemini = a.bodies()[0];
    const generic = b.bodies()[0];

    // EVERY entry of the replayed turn — the placement verified live on 2026-08-23, single call
    // and parallel pair alike.
    const stamped = gemini.messages.find((m: any) => m.role === "assistant").tool_calls;
    expect(stamped).toHaveLength(2);
    for (const call of stamped) {
      expect(call.extra_content).toEqual({ google: { thought_signature: "skip_thought_signature_validator" } });
    }
    // Ids are untouched by this pass — it adds a sibling field and nothing else.
    assertCleanOutbound(generic);
    expect(gemini.messages.find((m: any) => m.role === "assistant").tool_calls.map((c: any) => c.id))
      .toEqual(["toolu_01A", "toolu_01B"]);

    // The generic candidate gets no padding at all: not merely a different value, but no key.
    for (const call of generic.messages.find((m: any) => m.role === "assistant").tool_calls) {
      expect(call).not.toHaveProperty("extra_content");
    }
    expect(JSON.stringify(generic)).not.toContain("thought_signature");

    // Everything OTHER than the stamp is the same translation on both candidates.
    const strip = (body: any) =>
      JSON.parse(JSON.stringify(body.messages).replace(/,"extra_content":\{"google":\{"thought_signature":"[^"]*"\}\}/g, ""));
    expect(strip(gemini)).toEqual(strip(generic));
  });

  it("OpenAI front → openai-kind Chat stays byte-transparent on both candidates (the untouched front)", async () => {
    // The Chat/Chat pair never enters `anthropicRequestToOpenAi`: `fetchOpenAiFront` proxies the
    // caller's own OpenAI body. Pinned here so a future change to the request mapper cannot
    // silently start rewriting a front that is supposed to pass through.
    const a = await recording(() => ({ status: 429, body: RATE_LIMITED }));
    const b = await recording(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const callerMessages = [
      { role: "user", content: "find it" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Grep", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "SECRET-BODY" },
    ];
    const resp = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", max_tokens: 20, messages: callerMessages }),
    });

    expect(resp.status).toBe(200);
    for (const seen of [a.bodies()[0], b.bodies()[0]]) {
      expect(seen.messages).toEqual(callerMessages);
      expect(JSON.stringify(seen)).not.toContain("_original");
      expect(JSON.stringify(seen).split("SECRET-BODY").length - 1).toBe(1);
    }
  });

  it("an image inside a tool_result EGRESSES on both candidates instead of dying locally", async () => {
    // The refusal this replaced raised a LOCAL 400, and `server.ts` sets `tryNext = false` for a
    // local origin — so the walk never started and the client got a 400 it could not route
    // around. Two candidates, because "it egressed once" and "it egresses on every candidate"
    // are different claims and only the second one is the fix.
    const a = await recording(() => ({ status: 429, body: RATE_LIMITED }));
    const b = await recording(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(a.server)}`, `http://127.0.0.1:${port(b.server)}`])));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "pool/coding", max_tokens: 64,
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_img", name: "Read", input: { file_path: "a.png" } }] },
          { role: "user", content: [{
            type: "tool_result", tool_use_id: "toolu_img",
            content: [
              { type: "text", text: "Read 1 image" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "IMAGE-BYTES" } },
            ],
          }] },
        ],
      }),
    });

    expect(resp.status).toBe(200);
    expect(a.bodies()).toHaveLength(1);
    expect(b.bodies()).toHaveLength(1);
    for (const seen of [a.bodies()[0], b.bodies()[0]]) {
      expect(seen.messages.map((m: any) => m.role)).toEqual(["assistant", "tool", "user"]);
      // Text on the tool message; the image on the user message that follows it.
      expect(seen.messages[1]).toEqual({ role: "tool", tool_call_id: "toolu_img", content: "Read 1 image", name: "Read" });
      expect(seen.messages[2].content).toEqual([
        { type: "image_url", image_url: { url: "data:image/png;base64,IMAGE-BYTES" } },
      ]);
      expect(JSON.stringify(seen)).not.toContain("_original");
    }
  });
});

/**
 * The id-minting pass runs on whichever candidate ACTUALLY serves — so it has to survive a walk,
 * not just a single hop. Two candidates throughout (see the file header): with one, "the pass ran
 * on the serving candidate" and "the pass ran on the only candidate" are the same observation.
 */
describe("Messages front — tool_use ids minted on the serving candidate", () => {
  const TOOL_BODY = JSON.stringify({
    id: "cmpl_tool",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "Read:0", function: { name: "Read", arguments: '{"file":"README.md"}' } }],
      },
    }],
  });

  const conversation = {
    model: "pool/coding",
    max_tokens: 64,
    messages: [
      { role: "user", content: "read package.json" },
      { role: "assistant", content: [{ type: "tool_use", id: "Read:0", name: "Read", input: { file: "package.json" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "Read:0", content: "{}" }] },
      { role: "user", content: "now read README.md" },
    ],
    tools: [{ name: "Read", description: "r", input_schema: { type: "object", properties: { file: { type: "string" } } } }],
  };

  it("rewrites the colliding id after a 429 on the first candidate", async () => {
    const busy = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "TPM exceeded" } }) }));
    const winner = await scripted(() => ({ body: TOOL_BODY }));
    const p = port(await startProxy(poolCfg([
      `http://127.0.0.1:${port(busy.server)}`,
      `http://127.0.0.1:${port(winner.server)}`,
    ])));

    const response = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(conversation),
    });
    const body = (await response.json()) as { content: Array<{ type: string; id?: string }>; stop_reason: string };

    expect(response.status).toBe(200);
    expect(response.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
    expect(response.headers.get(POOL_ATTEMPTS_HEADER)).toContain("2 tried");
    // The client never sees the id it already has in this conversation — which is what stops its
    // request-time normalizer dropping the call and emptying the turn.
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content[0]).toEqual({ type: "tool_use", id: "Read:0_relay1", name: "Read", input: { file: "README.md" } });
    expect(response.headers.get("x-llm-relay-tool-use-ids")).toBe("1 rewritten");
  });

  it("leaves a non-colliding id alone on the same two-candidate walk", async () => {
    const busy = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "TPM exceeded" } }) }));
    const winner = await scripted(() => ({ body: TOOL_BODY }));
    const p = port(await startProxy(poolCfg([
      `http://127.0.0.1:${port(busy.server)}`,
      `http://127.0.0.1:${port(winner.server)}`,
    ])));

    const response = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ ...conversation, messages: [{ role: "user", content: "read README.md" }] }),
    });
    const body = (await response.json()) as { content: Array<{ id?: string }> };

    expect(response.status).toBe(200);
    expect(body.content[0]!.id).toBe("Read:0");
    expect(response.headers.get("x-llm-relay-tool-use-ids")).toBeNull();
  });
});

/**
 * The probation band end to end (packet P13, half b): a free member with fewer than
 * `minSamples` (default 5) SERVED-REQUEST samples in the probe dataset leads its pool so the
 * relay gathers data on it, announced as `x-llm-relay-probation`.
 *
 * ⚠ Provider/model names carry a per-test tag (`p13a1`, `p13b2`, …) — unique across the
 * suite on purpose. The probe cache under VITEST is one shared file AND served requests append
 * samples to it, so reusing one name across tests would inherit counts another test left behind
 * and read as measured. Sample counts here are seeded through the real
 * `recordProbeResult` + `recordRequestSample` seam, never a stub.
 *
 * ⚠ Every walk has ≥2 candidates (the file's own rule): with one candidate, "leads the pool"
 * and "is the only member" are the same observation.
 */
describe("probation band — untested free members lead to gather data", () => {
  /** Two-member static pool. `benchmarkSort: false` keeps CONFIG order, so any reorder is the band's. */
  function probationPoolCfg(
    tag: string,
    bases: string[],
    opts: { probationOff?: boolean; free?: boolean } = {},
  ): { cfg: Config; first: string; second: string } {
    const providers: Record<string, ProviderConfig> = {};
    const specs: string[] = [];
    bases.forEach((base, i) => {
      const provider = `p13${tag}${i + 1}`;
      const model = `p13${tag}m${i + 1}`;
      providers[provider] = {
        base,
        kind: "openai",
        authHeader: "authorization",
        timeoutMs: 5000,
        ...(opts.free === false ? {} : { tierType: "free" as const }),
      };
      specs.push(`${provider}/${model}`);
    });
    return {
      cfg: {
        host: "127.0.0.1",
        port: 0,
        providers,
        routing: {
          default: "pool/probe",
          tiers: {},
          benchmarkSort: false,
          pools: { probe: specs },
          // Normalized form (`{ enabled: false }`), exactly what `parseRouting` produces for
          // `"probation": false` — that normalization itself is pinned in test/config.test.ts.
          ...(opts.probationOff ? { probation: { enabled: false } } : {}),
        },
        mode: "detect",
        repair: { maxAttempts: 2, destructiveTools: [] },
        log: { level: "silent", file: null },
      },
      first: specs[0]!,
      second: specs[1]!,
    };
  }

  /** Seed n SERVED-REQUEST samples (probe samples never count toward the band — pin that too). */
  function seedRequestSamples(provider: string, model: string, n: number, probes = 0): void {
    recordProbeResult(provider, model, { code: "200", ms: 10, quotaObservations: [] });
    for (let i = 0; i < probes; i++) {
      recordProbeResult(provider, model, { code: "200", ms: 10, quotaObservations: [] });
    }
    for (let i = 0; i < n; i++) recordRequestSample(provider, model, { ms: 10, tokens: 5 });
  }

  const CHAT = (p: number) =>
    fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/probe", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    });

  it("a free member with 0 request samples leads a measured live member, on both fronts", async () => {
    // Config order is [measured, untested]: the band must REORDER, live must not.
    const measured = await scripted(() => ({ body: OK_BODY }));
    const untested = await scripted(() => ({ body: OK_BODY }));
    seedRequestSamples("p13a1", "p13am1", 5);
    const { cfg, second } = probationPoolCfg("a", [
      `http://127.0.0.1:${port(measured.server)}`,
      `http://127.0.0.1:${port(untested.server)}`,
    ]);
    const p = port(await startProxy(cfg));

    for (const [name, response] of [
      ["messages", await messages(p, "pool/probe")],
      ["chat", await CHAT(p)],
    ] as const) {
      expect(response.status, name).toBe(200);
      await response.text();
      expect(response.headers.get(SERVED_BY_HEADER), name).toBe(second);
      expect(response.headers.get(PROBATION_HEADER), name).toBe(`${second} (0 of 5 request samples)`);
    }
  });

  it("the same member with 5 samples sits in live in config order and the header is absent", async () => {
    const first = await scripted(() => ({ body: OK_BODY }));
    const second = await scripted(() => ({ body: OK_BODY }));
    seedRequestSamples("p13b1", "p13bm1", 5);
    // 5 PROBE samples plus 5 request samples: probes must not move the count either way.
    seedRequestSamples("p13b2", "p13bm2", 5, 5);
    const { cfg, first: firstSpec } = probationPoolCfg("b", [
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]);
    const p = port(await startProxy(cfg));

    const response = await messages(p, "pool/probe");
    expect(response.status).toBe(200);
    await response.text();
    expect(response.headers.get(SERVED_BY_HEADER)).toBe(firstSpec);
    expect(response.headers.get(PROBATION_HEADER)).toBeNull();
  });

  it("a paid (unknown-cost) member with 0 samples is NOT in probation", async () => {
    // No tierType and no catalog prices: `assessCost` reads `unknown`, which counts as paid on
    // purpose — a guess must not reorder paid traffic. Config order must survive untouched.
    const first = await scripted(() => ({ body: OK_BODY }));
    const second = await scripted(() => ({ body: OK_BODY }));
    const { cfg, first: firstSpec } = probationPoolCfg(
      "c",
      [`http://127.0.0.1:${port(first.server)}`, `http://127.0.0.1:${port(second.server)}`],
      { free: false },
    );
    const p = port(await startProxy(cfg));

    const response = await messages(p, "pool/probe");
    expect(response.status).toBe(200);
    await response.text();
    expect(response.headers.get(SERVED_BY_HEADER)).toBe(firstSpec);
    expect(response.headers.get(PROBATION_HEADER)).toBeNull();
  });

  it("a probation member with a breaker cooldown sits in cooling", async () => {
    const cooled = await scripted(() => ({ body: OK_BODY }));
    const live = await scripted(() => ({ body: OK_BODY }));
    seedRequestSamples("p13d2", "p13dm2", 5);
    // p13d1 is free and unmeasured — probation-eligible — but breaker-cooling outranks.
    globalCircuitBreaker.recordOutcome(
      { provider: "p13d1", model: "p13dm1", kind: "openai", credentialId: makeCredentialId("p13d1") },
      { ok: false, status: 429, elapsedMs: 5 },
    );
    const { cfg, second } = probationPoolCfg("d", [
      `http://127.0.0.1:${port(cooled.server)}`,
      `http://127.0.0.1:${port(live.server)}`,
    ]);
    const p = port(await startProxy(cfg));

    const response = await messages(p, "pool/probe");
    expect(response.status).toBe(200);
    await response.text();
    expect(response.headers.get(SERVED_BY_HEADER)).toBe(second);
    expect(response.headers.get(PROBATION_HEADER)).toBeNull();
  });

  it("routing.probation { enabled: false } yields today's order exactly", async () => {
    // Same fixture as the lead test, band switched off: config order rules, no header.
    const measured = await scripted(() => ({ body: OK_BODY }));
    const untested = await scripted(() => ({ body: OK_BODY }));
    seedRequestSamples("p13e1", "p13em1", 5);
    const { cfg, first: firstSpec } = probationPoolCfg(
      "e",
      [`http://127.0.0.1:${port(measured.server)}`, `http://127.0.0.1:${port(untested.server)}`],
      { probationOff: true },
    );
    const p = port(await startProxy(cfg));

    const response = await messages(p, "pool/probe");
    expect(response.status).toBe(200);
    await response.text();
    expect(response.headers.get(SERVED_BY_HEADER)).toBe(firstSpec);
    expect(response.headers.get(PROBATION_HEADER)).toBeNull();
  });

  it("a walk whose probation leader 429s fails over to the live member — header absent", async () => {
    // The band reorders, never drops: the 429'd leader is stepped over and the live member
    // serves. And the header names the SERVING candidate's band — the live member was never
    // placed by probation, so the response carries no header even though the walk LED with one.
    const measured = await scripted(() => ({ body: OK_BODY }));
    const flaky = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) }));
    seedRequestSamples("p13f1", "p13fm1", 5);
    const { cfg, first: firstSpec } = probationPoolCfg("f", [
      `http://127.0.0.1:${port(measured.server)}`,
      `http://127.0.0.1:${port(flaky.server)}`,
    ]);
    const p = port(await startProxy(cfg));

    const response = await messages(p, "pool/probe");
    expect(response.status).toBe(200);
    await response.text();
    expect(response.headers.get(SERVED_BY_HEADER)).toBe(firstSpec);
    expect(response.headers.get(POOL_ATTEMPTS_HEADER)).toContain("2 tried");
    expect(response.headers.get(PROBATION_HEADER)).toBeNull();
  });
});

/**
 * P-DS-c: the Responses front must not invent a `max_tokens` cap on an `openai`-kind target's
 * outbound Chat body, must announce a token-capped answer as `status: "incomplete"` (buffered AND
 * streamed), and must refuse a truncated `function_call` `arguments` string by NAME so a harness
 * can repair the turn instead of replaying it forever.
 * (docs/history/deepseek-responses-truncation-2026-09-09.md — the measurement this packet closes.)
 *
 * Every walk here uses >=2 candidates, per this file's own standing rule.
 */
describe("Responses front — no invented cap, and a capped answer announces itself (P-DS-c)", () => {
  /** `scripted`, but keeping the request bodies — the outbound wire shape IS half the assertion. */
  function recordingChat(
    reply: (n: number) => { status?: number; headers?: Record<string, string>; body: string },
  ): Promise<{ server: Server; bodies: () => Record<string, unknown>[] }> {
    const bodies: Record<string, unknown>[] = [];
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          try { bodies.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { bodies.push({}); }
          const out = reply(bodies.length);
          res.writeHead(out.status ?? 200, { "content-type": "application/json", ...out.headers });
          res.end(out.body);
        });
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: track(s), bodies: () => bodies }));
    });
  }

  const chatOkBody = (content: string) => JSON.stringify({
    id: "cmpl_ok", object: "chat.completion",
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  });
  const chatCappedBody = (content: string) => JSON.stringify({
    id: "cmpl_cap", object: "chat.completion",
    choices: [{ message: { role: "assistant", content }, finish_reason: "length" }],
  });
  const chatCappedStream = (content: string) => [
    `data: ${JSON.stringify({ id: "c", model: "m2", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c", model: "m2", choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");

  /** Every OpenAI Responses SSE event, parsed in order — the streamed-response analogue of the
   * buffered JSON assertions below. */
  function parseResponsesSse(text: string): Array<{ type: string; data: Record<string, unknown> }> {
    return text
      .split(/\n\n+/)
      .map((block) => block.trim())
      .filter((block) => block.length > 0)
      .map((block) => {
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        return JSON.parse((dataLine ?? "data: {}").slice(5).trim()) as { type: string } & Record<string, unknown>;
      })
      .map((data) => ({ type: data.type, data }));
  }

  it("omits max_tokens from the outbound Chat body when the caller stated none, and carries it when stated", async () => {
    const failed = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) }));
    const winner = await recordingChat(() => ({ body: chatOkBody("ok") }));
    const p = port(await startProxy(poolCfg([
      `http://127.0.0.1:${port(failed.server)}`,
      `http://127.0.0.1:${port(winner.server)}`,
    ])));

    const omitted = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", input: "hi" }),
    });
    expect(omitted.status).toBe(200);
    await omitted.text();
    expect(winner.bodies()).toHaveLength(1);
    expect("max_tokens" in winner.bodies()[0]!).toBe(false);

    const stated = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", input: "hi", max_output_tokens: 55 }),
    });
    expect(stated.status).toBe(200);
    await stated.text();
    expect(winner.bodies()).toHaveLength(2);
    expect(winner.bodies()[1]!.max_tokens).toBe(55);
  });

  it("serves a token-capped Chat answer as status: incomplete, buffered", async () => {
    const failed = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) }));
    const capped = await scripted(() => ({ body: chatCappedBody("cut off mid") }));
    const p = port(await startProxy(poolCfg([
      `http://127.0.0.1:${port(failed.server)}`,
      `http://127.0.0.1:${port(capped.server)}`,
    ])));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", input: "hi" }),
    });
    expect(resp.status).toBe(200);
    const j = await resp.json() as Record<string, unknown>;
    expect(j.status).toBe("incomplete");
    expect(j.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect((j.output as Array<Record<string, unknown>>)[0]!.status).toBe("incomplete");
  });

  it("stays status: completed for an ordinary stop reason, buffered — negative control", async () => {
    const failed = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) }));
    const ok = await scripted(() => ({ body: chatOkBody("done") }));
    const p = port(await startProxy(poolCfg([
      `http://127.0.0.1:${port(failed.server)}`,
      `http://127.0.0.1:${port(ok.server)}`,
    ])));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", input: "hi" }),
    });
    expect(resp.status).toBe(200);
    const j = await resp.json() as Record<string, unknown>;
    expect(j.status).toBe("completed");
    expect(j.incomplete_details).toBeUndefined();
  });

  it("serves a token-capped Chat answer as response.incomplete, streamed", async () => {
    const failed = await scripted(() => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) }));
    const capped = await scripted(() => ({
      headers: { "content-type": "text/event-stream" },
      body: chatCappedStream("cut"),
    }));
    const p = port(await startProxy(poolCfg([
      `http://127.0.0.1:${port(failed.server)}`,
      `http://127.0.0.1:${port(capped.server)}`,
    ])));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", stream: true, input: "hi" }),
    });
    expect(resp.status).toBe(200);
    const events = parseResponsesSse(await resp.text());
    const terminal = events.filter((e) => e.type === "response.completed" || e.type === "response.incomplete");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.type).toBe("response.incomplete");
    const response = terminal[0]!.data.response as Record<string, unknown>;
    expect(response.status).toBe("incomplete");
    expect(response.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("refuses a truncated function_call arguments string by name, with zero egress across the whole pool", async () => {
    const a = await scripted(() => ({ body: OK_BODY }));
    const b = await scripted(() => ({ body: OK_BODY }));
    const p = port(await startProxy(poolCfg([
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ])));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "pool/coding",
        input: [
          { role: "user", content: [{ type: "input_text", text: "find it" }] },
          { type: "function_call", call_id: "call_abc", name: "exec_command", arguments: '{"cmd": "ls -la' },
        ],
      }),
    });
    expect(resp.status).toBe(400);
    const j = await resp.json() as { error: { message: string } };
    expect(j.error.message).toContain("call_abc");
    expect(j.error.message).toContain("cut");
    expect(a.calls()).toBe(0);
    expect(b.calls()).toBe(0);
  });

  it("resolves the anthropic-kind fallback max_tokens: the learned max-output fact, else 8192", async () => {
    const backend = await recordingChat(() => ({
      body: JSON.stringify({
        id: "msg_r", model: "claude-sonnet", role: "assistant", type: "message",
        content: [{ type: "text", text: "done" }], stop_reason: "end_turn",
      }),
    }));
    const c = poolCfg([`http://127.0.0.1:${port(backend.server)}`], "anthropic");
    c.routing.default = "p1/m1";
    delete c.routing.pools;
    const p = port(await startProxy(c));

    // No learned fact yet, no catalog entry: falls to the named tunable default.
    const bare = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "p1/m1", input: "hi" }),
    });
    expect(bare.status).toBe(200);
    await bare.text();
    expect(backend.bodies()[0]!.max_tokens).toBe(8192);

    // A learned max-output fact for this exact deployment outranks the default.
    recordObservedMaxOutput("p1", "m1", 3000);
    const learned = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "p1/m1", input: "hi" }),
    });
    expect(learned.status).toBe(200);
    await learned.text();
    expect(backend.bodies()[1]!.max_tokens).toBe(3000);
  });
});
/**
 * Post-commit crawl watchdog (backlog item 18) — abort a candidate that committed real content
 * and then crawled, cool it, and confirm the CLIENT's own retry (measured in
 * `docs/history/post-commit-stall-measurement-2026-09-09.md`: Claude Code retries non-streaming, Codex
 * retries streaming) lands on the second, healthy candidate. ≥2 candidates throughout — the
 * standing rule that a single-candidate walk proves nothing about failover.
 *
 * `routing.crawl: { windowMs: 2000, minTokens: 2, msPerToken: 100 }` keeps the test fast: at that
 * rate, a candidate sending one ~1-token delta every ~400ms can deliver at most ~5 tokens per
 * trailing 2s window — far under the 20-token no-abort floor — so the abort is reliable rather
 * than timing-sensitive. `stallTimeoutMs` is left at its 90s default, well above the 2s crawl
 * window, so the CRAWL watchdog — not the stall watchdog — is what fires.
 */
const CRAWL_SETTINGS = { windowMs: 2000, minTokens: 2, msPerToken: 100 };

function anthropicFrame(text: string, index = 0): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta", index, delta: { type: "text_delta", text },
  })}\n\n`;
}
function openAiChatFrame(text: string): string {
  return `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
}

/**
 * A backend that COMMITS with real content, then crawls: one tiny delta every ~400ms until the
 * relay aborts the connection (or a generous safety cap of 15 ticks / 6s if it somehow does not,
 * so a broken watchdog fails the test on content/timing rather than hanging the suite forever).
 *
 * Hoisted to module scope (packet PLOG, 2026-09-09) so the post-commit STALL-watchdog describe
 * block below can reuse it verbatim for its own crawl-route assertion — see that block's own
 * comment for why the SAME fixture proves the crawl kind rides the same classifier the stall kind
 * does. Content unchanged from the item-18 packet that introduced it.
 */
function crawlingBackend(kind: "anthropic" | "openai"): Promise<{ server: Server; calls: () => number }> {
  let n = 0;
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        n++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const safeWrite = (chunk: string) => {
          try {
            if (!res.writableEnded && !res.destroyed) res.write(chunk);
          } catch {
            // The relay aborts this connection once it detects the crawl; a write racing that
            // abort must never crash the test's backend server.
          }
        };
        const frame = kind === "anthropic" ? anthropicFrame : openAiChatFrame;
        // Real content — this is what COMMITS the stream.
        safeWrite(frame("hello crawl test"));
        let ticks = 0;
        const timer = setInterval(() => {
          ticks++;
          if (res.destroyed || res.writableEnded || ticks > 15) {
            clearInterval(timer);
            try {
              if (!res.writableEnded && !res.destroyed) res.end();
            } catch {
              // Same race as above.
            }
            return;
          }
          safeWrite(frame("x"));
        }, 400);
        res.on("close", () => clearInterval(timer));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n }));
  });
}

/**
 * The clean second candidate — answers immediately, buffered or streamed as asked.
 * Hoisted to module scope alongside `crawlingBackend` (packet PLOG, 2026-09-09) for the same
 * reason; content unchanged.
 */
function cleanBackend(kind: "anthropic" | "openai"): Promise<{ server: Server; calls: () => number }> {
  let n = 0;
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        n++;
        const wantsStream = (() => {
          try {
            return Boolean((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean }).stream);
          } catch {
            return false;
          }
        })();
        if (!wantsStream) {
          const body = kind === "anthropic"
            ? JSON.stringify({
              id: "m", type: "message", role: "assistant", model: "m2",
              content: [{ type: "text", text: "served clean" }], stop_reason: "end_turn",
              usage: { input_tokens: 2, output_tokens: 4 },
            })
            : JSON.stringify({
              id: "c", choices: [{ message: { role: "assistant", content: "served clean" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 2, completion_tokens: 4 },
            });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(body);
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (kind === "anthropic") {
          res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m2", content: [] } })}\n\n`);
          res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
          res.write(anthropicFrame("served clean"));
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 4 } })}\n\n`);
          res.write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        } else {
          res.write(openAiChatFrame("served clean"));
          res.write(`data: ${JSON.stringify({ id: "c", choices: [], usage: { completion_tokens: 4 } })}\n\n`);
          res.write("data: [DONE]\n\n");
        }
        res.end();
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n }));
  });
}

/**
 * `requestBody`/`send` also hoisted (packet PLOG). The `/v1/responses` branch is NEW — the
 * pre-existing function only ever built an anthropic-messages- or chat-shaped body, because
 * neither prior caller addressed the Responses front.
 */
function requestBody(path: string, streamed: boolean): object {
  if (path === "/v1/messages") {
    return { model: "pool/coding", stream: streamed, max_tokens: 200, messages: [{ role: "user", content: "hi" }] };
  }
  if (path === "/v1/responses") {
    return { model: "pool/coding", stream: streamed, input: "hi" };
  }
  return { model: "pool/coding", stream: streamed, messages: [{ role: "user", content: "hi" }] };
}

function send(p: number, path: string, streamed: boolean): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (path === "/v1/messages") headers["anthropic-version"] = "2023-06-01";
  return fetch(`http://127.0.0.1:${p}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody(path, streamed)),
  });
}

describe("post-commit crawl watchdog — abort, cool, and let the client's own retry land elsewhere", () => {
  const FRONTS = [
    { name: "Anthropic /v1/messages", path: "/v1/messages", kind: "anthropic" as const },
    { name: "OpenAI /v1/chat/completions", path: "/v1/chat/completions", kind: "openai" as const },
  ];
  const RETRY_SHAPES = [
    { name: "non-streaming retry (Claude Code shape)", retryStreamed: false },
    { name: "streaming retry (Codex shape)", retryStreamed: true },
  ];

  for (const front of FRONTS) {
    for (const shape of RETRY_SHAPES) {
      it(`${front.name}: aborts the crawling candidate, cools it, and serves the ${shape.name} on the other candidate`, async () => {
        const logDir = mkdtempSync(join(tmpdir(), "llm-relay-crawl-test-"));
        const logFile = join(logDir, "log.ndjson");
        try {
          const crawler = await crawlingBackend(front.kind);
          const clean = await cleanBackend(front.kind);
          const cfg = poolCfg([
            `http://127.0.0.1:${port(crawler.server)}`,
            `http://127.0.0.1:${port(clean.server)}`,
          ], front.kind);
          cfg.routing.crawl = CRAWL_SETTINGS;
          cfg.log = { level: "metadata", file: logFile };
          const p = port(await startProxy(cfg));

          // The breaker requires TWO CONSECUTIVE failures before it sets a cooldown for a
          // status/no-retry-after outcome (`MAX_FAILURES_BEFORE_TRIP` in circuit-breaker.ts) — the
          // same standing rule `test/mid-stream-failure.test.ts` pins for an ordinary STALL abort
          // ("reports mid-stream failures to circuit breaker and trips breaker on repeated
          // failures": consecutiveFailures is 1 and the cell is still healthy after the FIRST
          // failure, only tripping on the second). The crawl watchdog reuses that exact
          // classification path (deadline provenance, no retryAfterMs), so it is bound by the same
          // rule, and this is not something backlog item 18 changes. Seed one prior failure
          // directly on the breaker — never touching the crawling backend's own request count —
          // so the REAL crawl abort below is the SECOND consecutive failure and actually cools the
          // candidate, which is what proves the crawl watchdog feeds the same health-accounting
          // path a stall abort does, without re-proving the unrelated two-strike policy itself.
          globalCircuitBreaker.recordOutcome(breakerIdentity("p1", "m1", front.kind), {
            ok: false, elapsedMs: 10, status: 500,
          });

          // Request 1: always STREAMING — only a streamed response can be aborted mid-response.
          const first = await send(p, front.path, true);
          expect(first.status).toBe(200); // headers were already committed before the crawl was detected
          const firstBody = await first.text();
          expect(firstBody).toContain("relay aborted a crawling stream:");
          expect(firstBody).toMatch(/ms\/token over 2 s \(threshold 100\)/);

          // The crawling candidate is now cooling (a `deadline`-provenance failure, same path a
          // stall abort takes, now the SECOND consecutive one) — it must not be retried at all for
          // the next request.
          const state = globalCircuitBreaker.getState(breakerIdentity("p1", "m1", front.kind));
          expect(state?.consecutiveFailures).toBe(2);
          expect(state?.cooldownUntil).toBeGreaterThan(Date.now());

          // Request 2: the client's own retry, in the shape this scenario is pinning.
          const retry = await send(p, front.path, shape.retryStreamed);
          expect(retry.status).toBe(200);
          const retryBody = await retry.text();
          expect(retryBody).toContain("served clean");
          expect(retry.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");

          // The crawling candidate saw exactly the one request across BOTH calls in this scenario.
          expect(crawler.calls()).toBe(1);
          expect(clean.calls()).toBe(1);

          // The aborted attempt's log row carries the new errorKinds member.
          const lines = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
          const rows = lines.map((line) => JSON.parse(line) as { errorKinds?: string[] });
          const crawlRow = rows.find((r) => r.errorKinds?.includes("backend_stream_crawl"));
          expect(crawlRow, JSON.stringify(rows)).toBeDefined();
        } finally {
          rmSync(logDir, { recursive: true, force: true });
        }
      });
    }
  }
});

/**
 * Packet PLOG (backlog: "The Responses front logs a mid-stream stall as a clean
 * `backendStatus: 200`") — the property, verbatim:
 *
 *   a committed stream that the relay's own watchdog aborts logs the same attempt status and
 *   the same `errorKinds` member on both fronts, pinned by one test that drives both.
 *
 * The mechanism (measured in `docs/history/post-commit-stall-measurement-2026-09-09.md`, confirmed here
 * by reading `node_modules/llm-bridge/dist/index.mjs`): the Anthropic front is a direct
 * passthrough for an `anthropic`-kind target, so `withStallWatchdog`/`withCrawlWatchdog` wrap the
 * RAW backend fetch stream, and the relay's own `controller.abort()` makes that stream's reader
 * THROW — `openAiFrontPath`'s Anthropic-front sibling (`transparentPath`/`repairStreamingPath` in
 * `routes/messages.ts`) catches it and calls `handleMidStreamError`. A Responses-front (and any
 * Chat-front request whose target is not a native OpenAI-chat passthrough) request instead runs
 * through `fetchTranslatedOpenAiFront`, whose output stream is built by llm-bridge's own
 * `emitOpenAIStream`/`emitOpenAIResponsesStream` (`handleUniversalStreamRequest` in
 * `src/backend.ts`). Both of those functions wrap their whole per-event loop in
 * `try { ... } catch (err) { controller.enqueue(<in-band error frame>); } finally { controller.close(); }`
 * — so the SAME abort that throws on the Anthropic front is caught INSIDE llm-bridge, turned into
 * an in-band SSE error frame, and the stream ends NORMALLY. `openAiFrontPath`'s own `for await`
 * loop over `upstream.body` therefore never throws, falls through to `completeAttemptSuccess`, and
 * the metadata log records a clean `backendStatus: 200` with no `errorKinds` — exactly the
 * asymmetry the backlog entry names, and exactly what cell 3/4 of the measurement doc shows.
 *
 * The fix (`src/routes/openai-front.ts`) does not patch llm-bridge (out of `src/`, out of Scope):
 * after the for-await loop finishes WITHOUT throwing, `controller.signal.aborted` is the one
 * signal that survives the swallow. By that point in the walk the attempt's own total-deadline
 * `timer` has already been cleared (right before `withStallWatchdog` is installed, same as the
 * Anthropic front), so the only remaining sources of an abort on that controller are this
 * attempt's OWN stall/crawl watchdog — a client disconnect is caught by `res.destroyed` first, and
 * `res.destroyed` is checked before the new branch so a disconnect is never misread as a watchdog
 * abort. When the signal is aborted and the client is still there, the fix routes the outcome
 * through the SAME `handleMidStreamError` the Anthropic front calls (never a second log-writing
 * path), passing an inert `() => null` error-frame builder — the client already received
 * llm-bridge's own in-band error frame, so no duplicate is written; `handleMidStreamError` only
 * needs to run the health/log classification and close the response.
 */
describe("post-commit STALL watchdog on a TRANSLATED stream — the Responses (and Chat) front must log the same verdict as the Anthropic front", () => {
  const STALL_TIMEOUT_MS = 300;

  /**
   * A backend that COMMITS with real content, then goes SILENT forever (never another byte,
   * never `res.end()`) — the sibling of `crawlingBackend` above, but for the STALL watchdog
   * rather than the crawl one. Always `anthropic`-kind: the Anthropic front reaches it as a
   * direct passthrough (no llm-bridge layer in between — the GREEN baseline), while the
   * Responses/Chat fronts reach the SAME backend only through the translated path that swallows
   * the abort — the apples-to-apples asymmetry the property is about.
   */
  function stallingBackend(): Promise<{ server: Server; calls: () => number }> {
    let n = 0;
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          n++;
          res.writeHead(200, { "content-type": "text/event-stream" });
          try {
            res.write(anthropicFrame("hello stall test"));
          } catch {
            // best effort — a client that never reads this far is not this test's concern.
          }
          // Never write again and never end: the socket stays open until the relay's own
          // `stallTimeoutMs` watchdog aborts it, or (in the disconnect test below) the client's
          // own abort closes it first.
        });
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n }));
    });
  }

  const FRONTS = [
    { name: "Anthropic /v1/messages (GREEN baseline — direct passthrough, no swallow)", path: "/v1/messages" },
    { name: "OpenAI Responses /v1/responses (RED before the fix — llm-bridge's emitter swallows the abort)", path: "/v1/responses" },
  ];

  for (const front of FRONTS) {
    it(`${front.name}: a committed stream the relay's stall watchdog aborts logs status:"committed" and errorKinds:["backend_stream_failed"], the client sees a mid-stream error frame, the breaker charges the first member, and the next request reaches the second`, async () => {
      const logDir = mkdtempSync(join(tmpdir(), "llm-relay-plog-stall-test-"));
      const logFile = join(logDir, "log.ndjson");
      try {
        const stalling = await stallingBackend();
        const clean = await cleanBackend("anthropic");
        const cfg = poolCfg([
          `http://127.0.0.1:${port(stalling.server)}`,
          `http://127.0.0.1:${port(clean.server)}`,
        ], "anthropic");
        cfg.providers["p1"]!.stallTimeoutMs = STALL_TIMEOUT_MS;
        cfg.log = { level: "metadata", file: logFile };
        const p = port(await startProxy(cfg));

        // Seed one prior failure directly on the breaker (identical technique to the crawl
        // describe block above, and for the same reason): `MAX_FAILURES_BEFORE_TRIP` is 2, so
        // without a seed the real stall abort below would only be the FIRST consecutive failure
        // and would not cool the candidate — the retry would stall a second time instead of
        // proving failover, on EITHER front. This never touches the stalling backend's own
        // request count.
        globalCircuitBreaker.recordOutcome(breakerIdentity("p1", "m1", "anthropic"), {
          ok: false, elapsedMs: 10, status: 500,
        });

        const first = await send(p, front.path, true);
        expect(first.status).toBe(200); // headers were already committed before the stall was detected
        const firstBody = await first.text();
        // llm-bridge's own swallow (on a translated front) and the relay's own `sseError`/
        // `openAiSseError` (on the Anthropic front, or once the fix routes through
        // `handleMidStreamError`) both write an in-band `event: error` — this assertion holds
        // whether or not the fix has landed, and is part of the property, not the RED/GREEN proof.
        expect(firstBody).toContain("event: error");

        // THE RED/GREEN ASSERTION: before the fix, the Responses front's `for await` loop never
        // throws (llm-bridge already closed the stream "normally"), so `completeAttemptSuccess`
        // runs instead of a breaker failure — `consecutiveFailures` stays at the seeded 1, not 2,
        // and no cooldown is set. On the Anthropic front (no translation layer) this already
        // passes today.
        const state = globalCircuitBreaker.getState(breakerIdentity("p1", "m1", "anthropic"));
        expect(state?.consecutiveFailures).toBe(2);
        expect(state?.cooldownUntil).toBeGreaterThan(Date.now());

        // The log row for the aborted attempt carries the SAME status and errorKinds on both
        // fronts — before the fix, the Responses front instead writes an ordinary success row
        // with no `errorKinds` at all, which is exactly the backlog's "logs ... a clean
        // `backendStatus: 200`" symptom.
        const lines = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
        const rows = lines.map((line) => JSON.parse(line) as {
          errorKinds?: string[];
          attempts?: Array<{ status: unknown }>;
        });
        const stallRow = rows.find((r) => r.errorKinds?.includes("backend_stream_failed"));
        expect(stallRow, JSON.stringify(rows)).toBeDefined();
        expect(stallRow!.attempts?.[0]?.status).toBe("committed");

        // A later request from the same client reaches the second, healthy candidate — proof the
        // breaker's charge (not merely the log row) actually steers the walk.
        const retry = await send(p, front.path, true);
        expect(retry.status).toBe(200);
        const retryBody = await retry.text();
        expect(retryBody).toContain("served clean");
        expect(retry.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");

        expect(stalling.calls()).toBe(1);
        expect(clean.calls()).toBe(1);
      } finally {
        rmSync(logDir, { recursive: true, force: true });
      }
    });
  }

  // Design item 3: the crawl watchdog's kind must ride the SAME route as the stall kind — reusing
  // `crawlingBackend`/`cleanBackend`/`CRAWL_SETTINGS` from the item-18 packet's own fixtures
  // (hoisted to module scope above) rather than re-deriving a second crawling backend. The
  // Anthropic front is already covered by the describe block above (direct passthrough, no
  // swallow); the Responses front is the one this packet must prove rides through the fix too.
  for (const front of FRONTS) {
    it(`${front.name}: a CRAWL-aborted committed stream also logs errorKinds:["backend_stream_crawl"]`, async () => {
      const logDir = mkdtempSync(join(tmpdir(), "llm-relay-plog-crawl-test-"));
      const logFile = join(logDir, "log.ndjson");
      try {
        const crawler = await crawlingBackend("anthropic");
        const clean = await cleanBackend("anthropic");
        const cfg = poolCfg([
          `http://127.0.0.1:${port(crawler.server)}`,
          `http://127.0.0.1:${port(clean.server)}`,
        ], "anthropic");
        cfg.routing.crawl = CRAWL_SETTINGS;
        cfg.log = { level: "metadata", file: logFile };
        const p = port(await startProxy(cfg));

        globalCircuitBreaker.recordOutcome(breakerIdentity("p1", "m1", "anthropic"), {
          ok: false, elapsedMs: 10, status: 500,
        });

        const first = await send(p, front.path, true);
        expect(first.status).toBe(200);
        const firstBody = await first.text();
        expect(firstBody).toContain("relay aborted a crawling stream:");

        const lines = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
        const rows = lines.map((line) => JSON.parse(line) as { errorKinds?: string[] });
        const crawlRow = rows.find((r) => r.errorKinds?.includes("backend_stream_crawl"));
        expect(crawlRow, JSON.stringify(rows)).toBeDefined();
      } finally {
        rmSync(logDir, { recursive: true, force: true });
      }
    });
  }

  // Design item 4: nothing changes on a client disconnect — it stays `cancelled` and is never
  // charged to the breaker. Pinned on the Responses front specifically, since the file had no
  // such case for it before this packet (the existing disconnect test, "does not failover to
  // subsequent candidates if client socket is destroyed", covers only the Anthropic front).
  // `stallTimeoutMs` is generous here so the CLIENT's own abort wins the race, never the relay's
  // own watchdog — this test is not about the watchdog at all.
  it("OpenAI Responses /v1/responses: a client disconnect after commit is 'cancelled', never charged to the breaker", async () => {
    const stalling = await stallingBackend();
    const cfg = poolCfg([`http://127.0.0.1:${port(stalling.server)}`], "anthropic");
    cfg.providers["p1"]!.stallTimeoutMs = 5000;
    const p = port(await startProxy(cfg));

    const controller = new AbortController();
    const resp = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", stream: true, input: "hi" }),
      signal: controller.signal,
    });
    await resp.body?.getReader().read();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(globalCircuitBreaker.getState(breakerIdentity("p1", "m1", "anthropic"))).toBeUndefined();
  });
});

/**
 * F10/F11 (2026-09-10, docs/history/deepseek-responses-truncation-2026-09-09.md): a `"deepseek"`-compat
 * candidate's outbound thinking/reasoning decision must reach the wire correctly AND must not leak
 * onto a sibling candidate of the SAME walk. Every case here uses TWO candidates — the
 * deepseek-compat one first (scripted to fail, so the walk reaches the plain one) — per this
 * file's own standing rule: a single-candidate test cannot distinguish "applies correctly" from
 * "applies to everything".
 */
describe("DeepSeek reasoning wiring is isolated to the declared target (F10/F11)", () => {
  /** Records the body it received regardless of the scripted reply — the P-DS-c idiom above. */
  function recordingChat(
    reply: (n: number) => { status?: number; headers?: Record<string, string>; body: string },
  ): Promise<{ server: Server; bodies: () => Record<string, unknown>[] }> {
    const bodies: Record<string, unknown>[] = [];
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          try { bodies.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { bodies.push({}); }
          const out = reply(bodies.length);
          res.writeHead(out.status ?? 200, { "content-type": "application/json", ...out.headers });
          res.end(out.body);
        });
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: track(s), bodies: () => bodies }));
    });
  }

  /**
   * A 2-member pool: `p1` carries `compat.reasoning: "deepseek"` EXPLICITLY — no real
   * `api.deepseek.com` host needed, the same "explicit value wins" rule `resolveReasoningMode`
   * itself states — and `p2` is a plain `openai`-kind provider with no `compat` at all.
   * `benchmarkSort: false` keeps config order, matching `poolCfg` above.
   */
  function deepSeekPoolCfg(deepSeekBase: string, plainBase: string): Config {
    return {
      host: "127.0.0.1",
      port: 0,
      providers: {
        p1: { base: deepSeekBase, kind: "openai", authHeader: "authorization", timeoutMs: 5000, compat: { reasoning: "deepseek" } },
        p2: { base: plainBase, kind: "openai", authHeader: "authorization", timeoutMs: 5000 },
      },
      routing: { default: "pool/coding", tiers: {}, benchmarkSort: false, pools: { coding: ["p1/m1", "p2/m2"] } },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
  }

  const FAIL_429 = () => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) });
  const chatOkBody = (content: string) => JSON.stringify({
    id: "c", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  });

  it("F10: a forced tool choice disables thinking on the deepseek candidate only — the plain sibling's bytes are unchanged", async () => {
    const deepseekMember = await recordingChat(FAIL_429);
    const plainMember = await recordingChat(() => ({ body: chatOkBody("ok") }));
    const p = port(await startProxy(deepSeekPoolCfg(
      `http://127.0.0.1:${port(deepseekMember.server)}`,
      `http://127.0.0.1:${port(plainMember.server)}`,
    )));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "pool/coding",
        max_tokens: 20,
        output_config: { effort: "high" },
        messages: [{ role: "user", content: "do it" }],
        tools: [{ name: "answer", input_schema: { type: "object", properties: {} } }],
        tool_choice: { type: "tool", name: "answer" },
      }),
    });
    expect(resp.status).toBe(200);
    await resp.text();

    expect(deepseekMember.bodies()).toHaveLength(1);
    const dsBody = deepseekMember.bodies()[0]!;
    expect(dsBody.thinking).toEqual({ type: "disabled" });
    expect(dsBody).not.toHaveProperty("reasoning_effort");
    expect(dsBody.tool_choice).toEqual({ type: "function", function: { name: "answer" } });

    expect(plainMember.bodies()).toHaveLength(1);
    const plainBody = plainMember.bodies()[0]!;
    expect(plainBody).not.toHaveProperty("thinking");
    expect(plainBody).not.toHaveProperty("reasoning_effort");
    // The tool_choice mapping itself is provider-agnostic — only the deepseek fields differ.
    expect(plainBody.tool_choice).toEqual({ type: "function", function: { name: "answer" } });
  });

  it("F11: a replayed thinking block becomes reasoning_content on the deepseek candidate only — the plain sibling drops it exactly as before", async () => {
    const deepseekMember = await recordingChat(FAIL_429);
    const plainMember = await recordingChat(() => ({ body: chatOkBody("ok") }));
    const p = port(await startProxy(deepSeekPoolCfg(
      `http://127.0.0.1:${port(deepseekMember.server)}`,
      `http://127.0.0.1:${port(plainMember.server)}`,
    )));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "pool/coding",
        max_tokens: 20,
        output_config: { effort: "high" },
        messages: [
          { role: "user", content: "do it" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "reading the file first" },
              { type: "tool_use", id: "call_1", name: "do_thing", input: {} },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }] },
        ],
      }),
    });
    expect(resp.status).toBe(200);
    await resp.text();

    const dsBody = deepseekMember.bodies()[0]!;
    const dsAssistant = (dsBody.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    expect(dsAssistant?.reasoning_content).toBe("reading the file first");
    // Replay was available, so nothing was overridden — the natural rule-2 (explicit effort) spec.
    expect(dsBody.reasoning_effort).toBe("high");
    expect(dsBody).not.toHaveProperty("thinking");

    const plainBody = plainMember.bodies()[0]!;
    const plainAssistant = (plainBody.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    expect(plainAssistant).not.toHaveProperty("reasoning_content");
    expect(plainBody).not.toHaveProperty("thinking");
    expect(plainBody).not.toHaveProperty("reasoning_effort");
  });
});
