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
    cb.recordFailure(targetA, 429, now);

    expect(cb.isHealthy(targetA, now + 1000)).toBe(false);
    expect(cb.isHealthy(targetA, now + 130000)).toBe(true); // after cooldown
  });

  it("trips circuit after consecutive failure threshold", () => {
    const cb = new CircuitBreaker();
    const now = 100000;
    cb.recordFailure(targetA, 502, now);
    expect(cb.isHealthy(targetA, now)).toBe(true);

    cb.recordFailure(targetA, 502, now);
    expect(cb.isHealthy(targetA, now + 1000)).toBe(false);
  });

  it("filters healthy targets", () => {
    const cb = new CircuitBreaker();
    const now = 100000;
    cb.recordFailure(targetA, 429, now);

    const healthy = cb.getHealthyTargets([targetA, targetB], now);
    expect(healthy).toHaveLength(1);
    expect(healthy[0]).toEqual(targetB);
  });
});
