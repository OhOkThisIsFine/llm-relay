/**
 * The dashboard availability producer: quota rows from breaker observations + configured +
 * learned limits, cooldown rows from breaker/credential-fault/target-fact sources, and the
 * never-throws guarantee that keeps a diagnostic panel from failing a read.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  isCooldownRowV1,
  isQuotaRowV1,
  type CooldownRowV1,
} from "../src/dashboard-contract.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { extractQuotaObservations } from "../src/quota-observation.js";
import { recordObservedRateLimit, resetObservedRateLimits } from "../src/rate-limits.js";
import { resetFacts, recordFact } from "../src/target-facts.js";
import { makeCredentialId } from "../src/credential-id.js";
import type { Config } from "../src/config.js";
import { createAvailabilityProducer } from "../src/availability-snapshot.js";
import { buildCandidates } from "../src/candidates.js";
import { formatCandidateAvailability } from "../src/cli.js";

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

  it("labels a relay-counted request total without borrowing the token basis", () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), { ok: true, elapsedMs: 5, at: NOW - 1_000 });
    const snapshot = createAvailabilityProducer({
      breaker,
      config: config({ rpm: 50 }),
      now: () => NOW,
      accounting: { usedInWindow: () => ({ requests: 12, tokens: null, basis: "mixed" }) },
    }).snapshot();
    const row = snapshot.quotas.find((candidate) => candidate.axis === "requests")!;
    expect(row.localUsed).toBe(12);
    expect(row.localUsedBasis).toBe("relay_counted");
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

  it("labels a derived-boundary reset with its contract basis", () => {
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
    const row = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().quotas[0]!;
    expect(row.resetsAt).not.toBeNull();
    expect(row.resetsAtBasis).toBe("derived_boundary");
  });

  it("feeds a REVIEWED fact's reset into a spent bucket as reviewed_rule", () => {
    // No header reset, a LOCAL-LEDGER-SPENT bucket, and a covering fact whose reset the request
    // path resolved through a reviewed rule — the rung the producer used to leave dormant.
    const breaker = new CircuitBreaker();
    const credentialId = makeCredentialId("nim", "primary");
    // A `rate-limited` fact — one of the two kinds QUOTA_RESET_FACT_KINDS admits — at the
    // credential scope it was resolved against on the request path.
    recordFact("rate-limited", { kind: "credential", provider: "nim", credentialId }, {
      now: NOW - 10_000, retryAfterMs: 25 * 60_000, untilBasis: "reviewed-field",
    });
    // Configured limit only (no header observation on the cell): an eligible observation would
    // win rung 1 and never spend — the ladder's ordinary precedence, covered by the other tests.
    breaker.recordOutcome(target(), { ok: true, elapsedMs: 5, at: NOW - 1_000 });
    const row = createAvailabilityProducer({
      breaker,
      config: config({ rpm: 60 }),
      now: () => NOW,
      accounting: { usedInWindow: () => ({ requests: 75, tokens: null, basis: "reported" }) },
    }).snapshot().quotas.find((candidate) => candidate.axis === "requests")!;
    expect(row.remaining).toBe(-15);
    expect(row.resetsAt).toBe(new Date(NOW + 25 * 60_000 - 10_000).toISOString());
    expect(row.resetsAtBasis).toBe("reviewed_rule");
    expect(isQuotaRowV1(row)).toBe(true);
  });

  it("lets a carrier observation reset beat the fact's reviewed reset (provider_stated wins)", () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), {
      ok: true,
      elapsedMs: 5,
      at: NOW - 1_000,
      quotaObservations: extractQuotaObservations({
        "x-ratelimit-requests-limit-minute": "60",
        "x-ratelimit-requests-remaining-minute": "0",
        "x-ratelimit-requests-reset-minute": String(Math.floor((NOW + 30_000) / 1000)),
      }, { observedAt: NOW - 1_000 }),
    });
    recordFact("allowance-exhausted", { kind: "credential", provider: "nim", credentialId: makeCredentialId("nim", "primary") }, {
      now: NOW - 10_000, retryAfterMs: 25 * 60_000, untilBasis: "reviewed-fixed",
    });
    const row = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().quotas[0]!;
    expect(row.resetsAt).toBe(new Date(NOW + 30_000).toISOString());
    expect(row.resetsAtBasis).toBe("provider_stated");
  });

  it("fills rung 1 from a retry-after/stated-body fact when the observation carries no reset", () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), {
      ok: true,
      elapsedMs: 5,
      at: NOW - 1_000,
      quotaObservations: extractQuotaObservations(
        { "x-ratelimit-requests-limit-minute": "60", "x-ratelimit-requests-remaining-minute": "0" },
        { observedAt: NOW - 1_000 },
      ),
    });
    recordFact("rate-limited", { kind: "credential", provider: "nim", credentialId: makeCredentialId("nim", "primary") }, {
      now: NOW - 5_000, retryAfterMs: 110_000, untilBasis: "retry-after",
    });
    const row = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().quotas[0]!;
    expect(row.resetsAt).toBe(new Date(NOW + 105_000).toISOString());
    expect(row.resetsAtBasis).toBe("provider_stated");
  });

  it("ignores a legacy fact (no basis) entirely — never a guessed rung", () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), {
      ok: true,
      elapsedMs: 5,
      at: NOW - 1_000,
      quotaObservations: extractQuotaObservations(
        { "x-ratelimit-requests-limit-minute": "60", "x-ratelimit-requests-remaining-minute": "0" },
        { observedAt: NOW - 1_000 },
      ),
    });
    recordFact("allowance-exhausted", { kind: "credential", provider: "nim", credentialId: makeCredentialId("nim", "primary") }, {
      now: NOW - 10_000, retryAfterMs: 25 * 60_000,
    });
    const row = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().quotas[0]!;
    expect(row.resetsAt).toBe(new Date(Date.UTC(2026, 7, 22, 12, 35)).toISOString()); // derived boundary
    expect(row.resetsAtBasis).toBe("derived_boundary");
  });

  // EVERY basis, not just the reviewed pair: a headroom gate that holds for one class and not the
  // other is the false-confidence shape — the test name states the general rule, so it has to
  // exercise the general rule. `retry-after` on a 94%-headroom day bucket was the shipped defect.
  for (const untilBasis of ["retry-after", "stated-body", "reviewed-field", "reviewed-fixed"] as const) {
    it(`never lets a ${untilBasis} fact invent a reset for a bucket with measured headroom`, () => {
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
      recordFact("allowance-exhausted", { kind: "credential", provider: "nim", credentialId: makeCredentialId("nim", "primary") }, {
        now: NOW - 10_000, retryAfterMs: 25 * 60_000, untilBasis,
      });
      const row = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().quotas[0]!;
      expect(row.remaining).toBe(40);
      expect(row.resetsAt).toBe(new Date(Date.UTC(2026, 7, 22, 12, 35)).toISOString());
      expect(row.resetsAtBasis).toBe("derived_boundary");
    });
  }

  it("leaves a bucket with UNKNOWN remaining on the derived boundary — unknown has no effect", () => {
    // No observation and no ledger, so `remaining` is null. Unknown is not "spent": the same rule
    // quota demotion follows, applied to the reset ladder.
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), { ok: true, elapsedMs: 5, at: NOW - 1_000 });
    recordFact("rate-limited", { kind: "credential", provider: "nim", credentialId: makeCredentialId("nim", "primary") }, {
      now: NOW - 10_000, retryAfterMs: 25 * 60_000, untilBasis: "reviewed-field",
    });
    const row = createAvailabilityProducer({ breaker, config: config({ rpm: 60 }), now: () => NOW })
      .snapshot().quotas.find((candidate) => candidate.axis === "requests")!;
    expect(row.remaining).toBeNull();
    expect(row.resetsAtBasis).toBe("derived_boundary");
  });

  // The quota vocabulary can only speak for the two kinds that mean "spent, refills at T".
  // An evicting condition or an auth fault expiring at T is a different question on a different
  // axis, and rendering it in a quota row's `resetsAt` is a category error dressed as a
  // measurement.
  for (const kind of ["not-servable", "subscription-required", "credential-invalid"] as const) {
    it(`declines a ${kind} fact — not a quota-reset condition`, () => {
      const breaker = new CircuitBreaker();
      breaker.recordOutcome(target(), {
        ok: true,
        elapsedMs: 5,
        at: NOW - 1_000,
        quotaObservations: extractQuotaObservations(
          { "x-ratelimit-requests-limit-minute": "60", "x-ratelimit-requests-remaining-minute": "0" },
          { observedAt: NOW - 1_000 },
        ),
      });
      recordFact(kind, { kind: "credential", provider: "nim", credentialId: makeCredentialId("nim", "primary") }, {
        now: NOW - 10_000, retryAfterMs: 25 * 60_000, untilBasis: "reviewed-field",
      });
      const row = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().quotas[0]!;
      expect(row.remaining).toBe(0);
      expect(row.resetsAtBasis).toBe("derived_boundary");
    });
  }

  it("takes the MOST-SPECIFIC covering fact, not the soonest one", () => {
    // Scope precedence is the store's own resolution order and it must survive the read: a broad
    // provider-scope fact that happens to expire sooner must not out-rank the attempt-scope fact
    // recorded about this exact deployment.
    const breaker = new CircuitBreaker();
    const credentialId = makeCredentialId("nim", "primary");
    breaker.recordOutcome(target(), {
      ok: true,
      elapsedMs: 5,
      at: NOW - 1_000,
      quotaObservations: extractQuotaObservations(
        { "x-ratelimit-requests-limit-minute": "60", "x-ratelimit-requests-remaining-minute": "0" },
        { observedAt: NOW - 1_000 },
      ),
    });
    recordFact("rate-limited", { kind: "attempt", provider: "nim", credentialId, model: "m-a" }, {
      now: NOW, retryAfterMs: 40 * 60_000, untilBasis: "reviewed-field",
    });
    recordFact("allowance-exhausted", { kind: "provider", provider: "nim" }, {
      now: NOW, retryAfterMs: 5 * 60_000, untilBasis: "reviewed-fixed",
    });
    const row = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().quotas[0]!;
    expect(row.resetsAt).toBe(new Date(NOW + 40 * 60_000).toISOString());
    expect(row.resetsAtBasis).toBe("reviewed_rule");
  });

  it("feeds both rung inputs independently — the ladder picks, recency does not", () => {
    // A reviewed fact expiring SOONER than a provider-stated one must not pre-empt rung 1: the
    // reviewed rung exists to answer when rung 1 is empty, not to race it.
    const breaker = new CircuitBreaker();
    const credentialId = makeCredentialId("nim", "primary");
    breaker.recordOutcome(target(), {
      ok: true,
      elapsedMs: 5,
      at: NOW - 1_000,
      quotaObservations: extractQuotaObservations(
        { "x-ratelimit-requests-limit-minute": "60", "x-ratelimit-requests-remaining-minute": "0" },
        { observedAt: NOW - 1_000 },
      ),
    });
    recordFact("rate-limited", { kind: "credential", provider: "nim", credentialId }, {
      now: NOW, retryAfterMs: 2 * 60_000, untilBasis: "reviewed-fixed",
    });
    recordFact("allowance-exhausted", { kind: "credential", provider: "nim", credentialId }, {
      now: NOW, retryAfterMs: 25 * 60_000, untilBasis: "stated-body",
    });
    const row = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().quotas[0]!;
    expect(row.resetsAt).toBe(new Date(NOW + 25 * 60_000).toISOString());
    expect(row.resetsAtBasis).toBe("provider_stated");
  });

  it("keeps quotas working when the facts reader throws, with the fact simply absent", () => {
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
    const snapshot = createAvailabilityProducer({
      breaker,
      config: config(),
      now: () => NOW,
      readFacts: () => { throw new Error("boom"); },
    }).snapshot();
    // The never-throws wrapper degrades gracelessly to EMPTY panels — deliberately not a partial
    // ladder: one broken read dependency must not sprout per-bucket fallbacks. Both halves go
    // through the injected seam, so this covers the cooldown reader too, not just the quota one.
    expect(snapshot.quotas).toEqual([]);
    expect(snapshot.cooldowns).toEqual([]);
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

/**
 * `llm-relay candidates` and the dashboard resolve the SAME cell from the same evidence, so a
 * fact-fed reset must read identically on both. They are separate producers over separate wire
 * shapes; sharing the evaluator (`factResetInputs`) is what keeps them from drifting into the
 * "two paths, one policy empty" shape CLAUDE.md warns about, and this is the pin on that.
 */
describe("candidates and the dashboard producer agree on one cell", () => {
  // `collectSpecs` walks pools and subagent tiers, so the deployment has to be named in one for
  // /candidates to have a row at all; the producer reaches it through the breaker either way.
  const poolConfig = (): Config => {
    const cfg = config() as unknown as { routing: { pools: Record<string, string[]> } };
    cfg.routing.pools = { low: ["nim/m-a"] };
    return cfg as unknown as Config;
  };
  const cell = () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(target(), {
      ok: true,
      elapsedMs: 5,
      at: NOW - 1_000,
      quotaObservations: extractQuotaObservations(
        { "x-ratelimit-requests-limit-minute": "60", "x-ratelimit-requests-remaining-minute": "0" },
        { observedAt: NOW - 1_000 },
      ),
    });
    return breaker;
  };

  it("both surface a reviewed fact's reset as the reviewed-rule rung", async () => {
    const breaker = cell();
    recordFact("rate-limited", { kind: "credential", provider: "nim", credentialId: makeCredentialId("nim", "primary") }, {
      now: NOW, retryAfterMs: 25 * 60_000, untilBasis: "reviewed-field",
    });
    const dashboard = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().quotas[0]!;
    const view = await buildCandidates(poolConfig(), { breaker, tierData: null, nowMs: NOW, telemetry: { version: 2, models: {} } });
    const cliRow = view.candidates.find((c) => c.provider === "nim")!.availability
      .find((row) => row.axis === "requests" && row.period === "minute")!;

    expect(dashboard.resetsAtBasis).toBe("reviewed_rule");
    expect(cliRow.resetsAtBasis).toBe("reviewed-rule");
    expect(cliRow.resetsAt).toBe(Date.parse(dashboard.resetsAt!));
    // The rendered line the operator actually reads.
    expect(formatCandidateAvailability([cliRow])).toContain("(reviewed-rule)");
  });

  it("both fall to the derived boundary when the covering fact carries no basis", async () => {
    const breaker = cell();
    recordFact("rate-limited", { kind: "credential", provider: "nim", credentialId: makeCredentialId("nim", "primary") }, {
      now: NOW, retryAfterMs: 25 * 60_000,
    });
    const dashboard = createAvailabilityProducer({ breaker, config: config(), now: () => NOW }).snapshot().quotas[0]!;
    const view = await buildCandidates(poolConfig(), { breaker, tierData: null, nowMs: NOW, telemetry: { version: 2, models: {} } });
    const cliRow = view.candidates.find((c) => c.provider === "nim")!.availability
      .find((row) => row.axis === "requests" && row.period === "minute")!;

    expect(dashboard.resetsAtBasis).toBe("derived_boundary");
    expect(cliRow.resetsAtBasis).toBe("derived-boundary");
    expect(cliRow.resetsAt).toBe(Date.parse(dashboard.resetsAt!));
  });
});
