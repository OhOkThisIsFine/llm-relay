/**
 * The dashboard availability producer: quota rows from breaker observations + configured +
 * learned limits, cooldown rows from breaker/credential-fault/target-fact sources, and the
 * never-throws guarantee that keeps a diagnostic panel from failing a read.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isCooldownRowV1,
  isQuotaRowV1,
  type CooldownRowV1,
  type QuotaRowV1,
} from "../src/dashboard-contract.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { extractQuotaObservations } from "../src/quota-observation.js";
import { recordObservedRateLimit, resetObservedRateLimits } from "../src/rate-limits.js";
import { resetFacts, recordFact } from "../src/target-facts.js";
import { makeCredentialId } from "../src/credential-id.js";
import type { Config } from "../src/config.js";
import { createAvailabilityProducer } from "../src/availability-snapshot.js";

// 2026-08-22T12:34:56Z.
const NOW = Date.UTC(2026, 7, 22, 12, 34, 56);

function target(overrides: Partial<Parameters<CircuitBreaker["getState"]>[0]> = {}) {
  return {
    provider: "nim",
    credentialId: "nim#primary",
    kind: "openai" as const,
    model: "m-a" as string | null,
    base: "http://nim",
    ...overrides,
  };
}

/** Minimal config the producer reads: one provider with one declared slot. */
function config(limits?: Record<string, unknown>): Config {
  return {
    providers: {
      nim: {
        base: "http://nim",
        kind: "openai",
        credentials: [{ label: "primary", authEnv: "NIM_API_KEY" }],
        ...(limits !== undefined ? { limits } : {}),
      },
    },
    routing: { default: "nim/m-a", tiers: {}, pools: {} },
    backend: { kind: "anthropic" },
    repair: { maxAttempts: 1, destructiveTools: [] },
  } as unknown as Config;
}

afterEach(() => {
  resetFacts();
  resetObservedRateLimits();
});

describe("createAvailabilityProducer — quotas", () => {
  it("emits a provider-stated row for an observed header bucket", () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), {
      ok: true,
      elapsedMs: 5,
      at: NOW - 1_000,
      quotaObservations: extractQuotaObservations(
        { "x-ratelimit-requests-limit-minute": "60", "x-ratelimit-requests-remaining-minute": "40" },
        { observedAt: NOW - 1_000 },
      ),
    });
    const snapshot = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot();
    expect(snapshot.quotas).toHaveLength(1);
    const row = snapshot.quotas[0]!;
    expect(isQuotaRowV1(row)).toBe(true);
    expect(row).toMatchObject({
      credentialId: "nim#primary",
      label: "primary",
      provider: "nim",
      deployment: "m-a",
      axis: "requests",
      period: "minute",
      limit: 60,
      remaining: 40,
      limitBasis: "provider_stated",
      remainingBasis: "provider_stated",
    });
  });

  it("derives from a configured limit and labels it derived_configured", () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), { ok: true, elapsedMs: 5, at: NOW - 1_000 });
    // No header observation — only the operator's declaration.
    const snapshot = createAvailabilityProducer({
      breaker,
      config: config({ rpm: 50 }),
      now: () => NOW,
    }).snapshot();
    const row = snapshot.quotas.find((candidate) => candidate.axis === "requests");
    expect(row?.limit).toBe(50);
    expect(row?.limitBasis).toBe("configured");
    expect(row?.remainingBasis ?? null).toBeNull(); // no ledger wired ⇒ localUsed null ⇒ rung 3
  });

  it("derives from a learned fact when nothing else states a limit", () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), { ok: true, elapsedMs: 5, at: NOW - 1_000 });
    recordObservedRateLimit("nim", makeCredentialId("nim", "primary"), "m-a", { axis: "requests", period: "day", limit: 2_000 }, { now: NOW - 3_600_000 });
    const snapshot = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot();
    const row = snapshot.quotas.find((candidate) => candidate.period === "day");
    expect(row?.limit).toBe(2_000);
    expect(row?.limitBasis).toBe("learned");
    expect(row?.remainingBasis ?? null).toBeNull();
  });

  it("carries localUsed through when a store is supplied", () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), { ok: true, elapsedMs: 5, at: NOW - 1_000 });
    const snapshot = createAvailabilityProducer({
      breaker,
      config: config({ rpm: 50 }),
      now: () => NOW,
      accounting: { usedInWindow: () => ({ requests: 12, tokens: null, basis: "reported" }) },
    }).snapshot();
    const row = snapshot.quotas.find((candidate) => candidate.axis === "requests")!;
    expect(row.localUsed).toBe(12);
    expect(row.localUsedBasis).toBe("reported");
    expect(row.remaining).toBe(38);
    expect(row.remainingBasis).toBe("derived_configured");
  });

  it("keeps an OVERSHOT row (localUsed above limit) with its NEGATIVE remaining, unclamped", () => {
    // "Overshoot is information": rung 2 must not clamp, and the contract guard must accept the
    // negative — otherwise the projection drops the row and only an anonymous partial survives.
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), { ok: true, elapsedMs: 5, at: NOW - 1_000 });
    const snapshot = createAvailabilityProducer({
      breaker,
      config: config({ rpm: 50 }),
      now: () => NOW,
      accounting: { usedInWindow: () => ({ requests: 75, tokens: null, basis: "reported" }) },
    }).snapshot();
    const row = snapshot.quotas.find((candidate) => candidate.axis === "requests")!;
    expect(row.remaining).toBe(-25); // 50 − 75
    expect(row.limit).toBe(50);
    expect(isQuotaRowV1(row)).toBe(true);
  });

  it("produces nothing without a breaker (the bare in-memory proxy)", () => {
    const snapshot = createAvailabilityProducer({ config: config(), now: () => NOW }).snapshot();
    expect(snapshot.quotas).toEqual([]);
  });
});

describe("createAvailabilityProducer — cooldowns", () => {
  it("maps a retry-after cooldown to rate_limit with the real failure time", () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), { ok: false, status: 429, elapsedMs: 5, at: NOW - 60_000, retryAfterMs: 120_000 });
    const rows = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().cooldowns;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(isCooldownRowV1(row)).toBe(true);
    expect(row.reason).toBe("rate_limit");
    expect(row.until).toBe(new Date(NOW + 60_000).toISOString());
    expect(row.observedAt).toBe(new Date(NOW - 60_000).toISOString());
  });

  it("maps a generic failure cooldown to provider_error and a credential fault to auth_error", () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), { ok: false, status: 500, elapsedMs: 5, at: NOW - 10_000 }); // ×1 no trip
    breaker.recordOutcome(target(), { ok: false, status: 500, elapsedMs: 5, at: NOW - 9_000 });
    breaker.recordCredentialFault(target(), 401, NOW - 8_000);
    const rows = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().cooldowns;
    const reasons = rows.map((row) => row.reason).sort();
    expect(reasons).toEqual(["auth_error", "provider_error"]);
  });

  it("renders target-fact cooling conditions as cooldown rows", () => {
    const breaker = new CircuitBreaker();
    recordFact("allowance-exhausted", { kind: "attempt", provider: "nim", credentialId: makeCredentialId("nim", "primary"), model: "m-a" }, { now: NOW - 30_000, retryAfterMs: 300_000 });
    const rows = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().cooldowns;
    expect(rows.some((row) => row.reason === "rate_limit" && row.deployment === "m-a")).toBe(true);
  });

  it("keeps the LONGEST window per cell/reason instead of the first seen", () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), { ok: false, status: 429, elapsedMs: 5, at: NOW - 200_000, retryAfterMs: 100_000 });
    breaker.recordOutcome(target(), { ok: false, status: 429, elapsedMs: 5, at: NOW - 50_000, retryAfterMs: 150_000 });
    const rows = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().cooldowns;
    expect(rows.filter((row) => row.reason === "rate_limit")).toHaveLength(1);
    expect(rows[0]?.until).toBe(new Date(NOW + 100_000).toISOString());
  });

  it("never fabricates an observation time for fact-derived rows", () => {
    const breaker = new CircuitBreaker();
    recordFact("rate-limited", { kind: "deployment", provider: "nim", model: "m-a" }, { now: NOW - 10_000, retryAfterMs: 60_000 });
    const rows = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().cooldowns;
    const factRows = rows.filter((row) => row.deployment === "m-a");
    expect(factRows.every((row) => row.observedAt === null)).toBe(true);
  });

  it("returns empty panels rather than throwing when a dependency explodes", () => {
    const hostileBreaker = {
      getAllStates() {
        throw new Error("boom");
      },
    };
    const producer = createAvailabilityProducer({
      breaker: hostileBreaker as unknown as CircuitBreaker,
      config: config(),
      now: () => NOW,
    });
    expect(producer.snapshot()).toEqual({ quotas: [], cooldowns: [] });
  });

  it("rows survive the contract guards verbatim", () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), {
      ok: false,
      status: 401,
      elapsedMs: 5,
      at: NOW - 5_000,
      quotaObservations: extractQuotaObservations(
        { "x-ratelimit-tokens-limit-day": "900", "x-ratelimit-tokens-remaining-day": "700" },
        { observedAt: NOW - 5_000 },
      ),
    });
    const snapshot = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot();
    expect(snapshot.quotas.every(isQuotaRowV1)).toBe(true);
    expect(snapshot.cooldowns.every((row: CooldownRowV1) => isCooldownRowV1(row))).toBe(true);
    expect(snapshot.quotas[0]?.axis).toBe("tokens");
    expect(snapshot.quotas[0]?.period).toBe("day");
  });
});
