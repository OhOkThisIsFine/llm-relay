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
