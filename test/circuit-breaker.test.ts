import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import type { ResolvedTarget } from "../src/config.js";

describe("CircuitBreaker", () => {
  const targetA: ResolvedTarget = {
    provider: "nim",
    base: "http://nim",
    kind: "openai",
    model: "model-a",
    authHeader: "authorization",
    timeoutMs: 1000,
  };
  const targetB: ResolvedTarget = {
    provider: "openrouter",
    base: "http://or",
    kind: "openai",
    model: "model-b",
    authHeader: "authorization",
    timeoutMs: 1000,
  };

  it("initially marks all targets as healthy", () => {
    const cb = new CircuitBreaker();
    expect(cb.isHealthy(targetA)).toBe(true);
    expect(cb.isHealthy(targetB)).toBe(true);
  });

  it("trips circuit immediately on HTTP 429 rate limit", () => {
    const cb = new CircuitBreaker();
    const now = 100000;
    cb.recordOutcome(targetA, { ok: false, status: 429, elapsedMs: 40, at: now });

    expect(cb.isHealthy(targetA, now + 1000)).toBe(false);
    expect(cb.isHealthy(targetA, now + 130000)).toBe(true); // after cooldown
  });

  it("trips circuit after consecutive failure threshold", () => {
    const cb = new CircuitBreaker();
    const now = 100000;
    cb.recordOutcome(targetA, { ok: false, status: 502, elapsedMs: 40, at: now });
    expect(cb.isHealthy(targetA, now)).toBe(true);

    cb.recordOutcome(targetA, { ok: false, status: 502, elapsedMs: 40, at: now });
    expect(cb.isHealthy(targetA, now + 1000)).toBe(false);
  });

  it("a success resets the consecutive-failure count", () => {
    const cb = new CircuitBreaker();
    const now = 100000;
    cb.recordOutcome(targetA, { ok: false, status: 502, elapsedMs: 40, at: now });
    cb.recordOutcome(targetA, { ok: true, status: 200, elapsedMs: 80, at: now + 1 });
    cb.recordOutcome(targetA, { ok: false, status: 502, elapsedMs: 40, at: now + 2 });
    // One failure either side of a success must not add up to the trip threshold.
    expect(cb.isHealthy(targetA, now + 1000)).toBe(true);
    expect(cb.getState(targetA)!.consecutiveFailures).toBe(1);
  });

  it("filters healthy targets", () => {
    const cb = new CircuitBreaker();
    const now = 100000;
    cb.recordOutcome(targetA, { ok: false, status: 429, elapsedMs: 40, at: now });

    const healthy = cb.getHealthyTargets([targetA, targetB], now);
    expect(healthy).toHaveLength(1);
    expect(healthy[0]).toEqual(targetB);
  });

  it("keeps the incoming order when NOTHING has been measured", () => {
    const cb = new CircuitBreaker();
    // Both untracked, so the health dimension says nothing and must not reorder the
    // benchmark-ranked list it was handed. This holds because untracked targets tie
    // with each other — not because every comparison returns 0.
    expect(cb.getHealthyTargets([targetB, targetA], 100000)).toEqual([targetB, targetA]);
  });
});

/**
 * A credential fault is its own dimension — neither health nor success.
 *
 * Recording a 401 as a failure would open the breaker on a CONFIG problem and hide the 401 the
 * operator must see behind a "target unhealthy" skip; recording it as a success would launder a
 * permanently broken member into a healthy one (that was the pre-0.10 bug). Neither answer lets
 * a pool step over the member, which is how half of a real 14-member pool sat in the routing
 * order answering 401 while `/candidates` showed every row `closed`.
 */
describe("CircuitBreaker — credential faults", () => {
  const t: ResolvedTarget = { provider: "p", base: "http://p", kind: "openai", model: "m", authHeader: "authorization", timeoutMs: 1000 };

  it("does not touch health state, and does not open the breaker", () => {
    const cb = new CircuitBreaker();
    cb.recordCredentialFault(t, 401);
    const s = cb.getState(t)!;
    expect(s.credentialFailures).toBe(1);
    expect(s.lastCredentialStatus).toBe(401);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.cooldownUntil).toBe(0);
    expect(s.pings.length).toBe(0); // not a latency observation either
    expect(cb.isHealthy(t)).toBe(true); // "healthy" keeps meaning what it says
    expect(cb.hasCredentialFault(t)).toBe(true); // but it IS reported, and demotes
  });

  it("expires, so a rotated key recovers without restarting the proxy", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    cb.recordCredentialFault(t, 401, at);
    expect(cb.hasCredentialFault(t, at + 60_000)).toBe(true);
    expect(cb.hasCredentialFault(t, at + 400_000)).toBe(false);
  });

  it("clears on a real success — proof the credential works now", () => {
    const cb = new CircuitBreaker();
    cb.recordCredentialFault(t, 403);
    cb.recordOutcome(t, { ok: true, status: 200, elapsedMs: 12 });
    expect(cb.hasCredentialFault(t)).toBe(false);
    expect(cb.getState(t)!.credentialFailures).toBe(0);
  });
});

describe("CircuitBreaker — Retry-After drives the cooldown", () => {
  const t: ResolvedTarget = { provider: "p", base: "http://p", kind: "openai", model: "m", authHeader: "authorization", timeoutMs: 1000 };

  it("honours the provider's own figure over the flat 2-minute guess", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    cb.recordOutcome(t, { ok: false, status: 429, elapsedMs: 5, at, retryAfterMs: 20_000 });
    expect(cb.getState(t)!.cooldownUntil).toBe(at + 20_000);
  });

  it("falls back to the flat cooldown when the provider said nothing", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    cb.recordOutcome(t, { ok: false, status: 429, elapsedMs: 5, at });
    expect(cb.getState(t)!.cooldownUntil).toBe(at + 120_000);
  });

  it("trips a 503 immediately when it carries a Retry-After, without waiting for a second failure", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    cb.recordOutcome(t, { ok: false, status: 503, elapsedMs: 5, at, retryAfterMs: 30_000 });
    expect(cb.getState(t)!.cooldownUntil).toBe(at + 30_000);
  });

  it("clamps an absurd or hostile value at both ends", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    cb.recordOutcome(t, { ok: false, status: 429, elapsedMs: 5, at, retryAfterMs: 999_999_999 });
    expect(cb.getState(t)!.cooldownUntil).toBe(at + 900_000); // 15 min ceiling
    const cb2 = new CircuitBreaker();
    cb2.recordOutcome(t, { ok: false, status: 429, elapsedMs: 5, at, retryAfterMs: 0 });
    expect(cb2.getState(t)!.cooldownUntil).toBe(at + 1000); // 1s floor — never a busy loop
  });
});

describe("CircuitBreaker — mid-stream failures", () => {
  const t: ResolvedTarget = { provider: "p", base: "http://p", kind: "openai", model: "m", authHeader: "authorization", timeoutMs: 1000 };

  it("replaces eager 200 ping with failure ping and trips circuit after consecutive mid-stream failures", () => {
    const cb = new CircuitBreaker();
    const now = 100000;

    // First request: 200 OK headers arrive eagerly
    cb.recordOutcome(t, { ok: true, status: 200, elapsedMs: 10, at: now });
    expect(cb.getState(t)!.consecutiveFailures).toBe(0);

    // Stream fails mid-response
    cb.recordMidStreamFailure(t, { elapsedMs: 50, status: 502, at: now + 50 });
    expect(cb.getState(t)!.consecutiveFailures).toBe(1);
    expect(cb.getState(t)!.pings[0]!.code).toBe("502");
    expect(cb.isHealthy(t, now + 100)).toBe(true);

    // Second request: 200 OK headers arrive eagerly
    cb.recordOutcome(t, { ok: true, status: 200, elapsedMs: 10, at: now + 1000 });
    // Stream fails mid-response again
    cb.recordMidStreamFailure(t, { elapsedMs: 50, status: 502, at: now + 1050 });

    expect(cb.getState(t)!.consecutiveFailures).toBe(2);
    expect(cb.isHealthy(t, now + 1100)).toBe(false); // Circuit is open!
  });
});
