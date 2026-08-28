/**
 * Spec §5.1-5.3 ladders: rung order, read-time staleness, negative remaining preservation,
 * unknown → null, and the UTC boundary arithmetic everything else leans on.
 */
import { describe, expect, it } from "vitest";
import {
  collectQuotaBuckets,
  mapLimitBasis,
  mapRemainingBasis,
  periodEnd,
  periodStart,
  resolveRemaining,
  resolveResetsAt,
} from "../src/availability.js";
import type { QuotaObservation } from "../src/quota-observation.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** A minute-period observation stated at a fixed instant. */
function observation(at: number, remaining = 40, limit = 60): QuotaObservation {
  return {
    axis: "requests",
    period: "minute",
    limit,
    remaining,
    resetsAt: at + MINUTE_MS,
    observedAt: at,
    basis: "provider-stated",
  };
}

// 2026-08-22T12:34:56Z — mid-minute, mid-day, mid-month.
const NOW = Date.UTC(2026, 7, 22, 12, 34, 56);

const NO_USED = { value: null as number | null, basis: null as null };

function resolutionFor(overrides: Partial<Parameters<typeof resolveRemaining>[0]>): ReturnType<typeof resolveRemaining> {
  return resolveRemaining({
    observations: [],
    axis: "requests",
    period: "minute",
    localUsed: NO_USED,
    now: NOW,
    ...overrides,
  });
}

describe("collectQuotaBuckets — the one bucket builder", () => {
  it("keeps month observations, drops a resetless unknown period, and keeps learned and configured apart", () => {
    // Month-period observations had no pin anywhere before the builder existed; the consumer
    // suites exercise minute/day only, so a builder that dropped "month" would have passed them.
    const monthObservation: QuotaObservation = {
      axis: "requests",
      period: "month",
      limit: 1_000,
      remaining: 5,
      resetsAt: NOW + DAY_MS,
      observedAt: NOW,
      basis: "provider-stated",
    };
    // An unknown period with NO stated reset stays dropped: there is no boundary in reach and no
    // period to derive one from, so nothing downstream could ever expire against it.
    const unknownPeriod: QuotaObservation = { ...observation(NOW), period: "unknown", resetsAt: null };

    const buckets = collectQuotaBuckets({
      observations: [monthObservation, unknownPeriod, observation(NOW)],
      learned: [{ axis: "requests", period: "day", limit: 2_000 }],
      configured: { rpm: 50 },
    });

    expect([...buckets.keys()]).toEqual(["requests:month", "requests:minute", "requests:day"]);
    expect(buckets.get("requests:month")!.observations).toEqual([monthObservation]);
    // Learned and configured are DISJOINT assignment sites — a swap here would relabel a
    // display-only learned ceiling as an operator declaration downstream.
    expect(buckets.get("requests:day")!.limits).toEqual({ learned: 2_000 });
    expect(buckets.get("requests:minute")!.limits.configured).toBe(50);
    expect(buckets.get("requests:minute")!.limits.learned).toBeUndefined();
  });

  /**
   * The groq shape: `x-ratelimit-limit-requests` names no period, so the parser records
   * `period: "unknown"` — but the same response states the reset. The row is admissible on that
   * reset alone, which is why the drop above is conditional rather than blanket.
   */
  it("admits an unknown period when the observation states its own reset", () => {
    const stated: QuotaObservation = { ...observation(NOW), period: "unknown", resetsAt: NOW + 86_000 };
    const buckets = collectQuotaBuckets({ observations: [stated], learned: [], configured: null });

    expect([...buckets.keys()]).toEqual(["requests:unknown"]);
    expect(buckets.get("requests:unknown")!.observations).toEqual([stated]);
  });

  it("an admitted unknown-period bucket resolves rung 1 and expires at the stated reset", () => {
    const stated: QuotaObservation = { ...observation(NOW), period: "unknown", remaining: 0, resetsAt: NOW + 86_000 };
    const resolution = resolveRemaining({
      observations: [stated],
      axis: "requests",
      period: "unknown",
      localUsed: NO_USED,
      now: NOW,
    });
    expect(resolution.remaining).toBe(0);
    expect(resolution.basis).toBe("provider-stated");
    expect(resolution.routingEligible).toBe(true);
    expect(resolution.staleObservations).toBe(0);

    const resets = resolveResetsAt({
      providerStated: resolution.eligibleObservation?.resetsAt ?? null,
      reviewedRule: null,
      period: "unknown",
      now: NOW,
    });
    expect(resets.resetsAt).toBe(NOW + 86_000);
    expect(resets.basis).toBe("provider-stated");
  });

  /**
   * ⚠ The stated reset is the admission ticket, so it is also the staleness test. Past it the
   * window has rolled over and the figure describes a window that no longer exists — the same
   * fail-safe direction as a named period whose UTC boundary has passed.
   */
  it("an unknown-period observation past its stated reset is stale, and derives nothing", () => {
    const expired: QuotaObservation = { ...observation(NOW), period: "unknown", remaining: 0, resetsAt: NOW - 1 };
    const resolution = resolveRemaining({
      observations: [expired],
      axis: "requests",
      period: "unknown",
      // A ledger figure must not rescue it: an unknown period has no window to count, so rung 2
      // is unreachable no matter what a caller passes.
      localUsed: { value: 99, basis: "relay-counted" },
      now: NOW,
    });
    expect(resolution.remaining).toBeNull();
    expect(resolution.basis).toBeNull();
    expect(resolution.staleObservations).toBe(1);
    expect(resolution.routingEligible).toBe(false);
  });
});

describe("periodStart / periodEnd (UTC only)", () => {
  it("floors minutes and days on UTC", () => {
    expect(periodStart(NOW, "minute")).toBe(Date.UTC(2026, 7, 22, 12, 34));
    expect(periodEnd(NOW, "minute")).toBe(Date.UTC(2026, 7, 22, 12, 35));
    // The host may sit west of UTC; these boundaries must not move with it.
    expect(periodStart(NOW, "day")).toBe(Date.UTC(2026, 7, 22));
    expect(periodEnd(NOW, "day")).toBe(Date.UTC(2026, 7, 23));
  });

  it("uses real month lengths — month end and leap years", () => {
    expect(periodEnd(Date.UTC(2026, 7, 31, 23), "month")).toBe(Date.UTC(2026, 8, 1)); // Aug has 31 days
    expect(periodEnd(Date.UTC(2026, 1, 10), "month")).toBe(Date.UTC(2026, 2, 1)); // Feb 2026: 28
    expect(periodEnd(Date.UTC(2024, 1, 10), "month")).toBe(Date.UTC(2024, 2, 1)); // Feb 2024: 29
    expect(periodStart(Date.UTC(2026, 7, 22), "month")).toBe(Date.UTC(2026, 7, 1));
  });

  it("has no opinion about an unknown period", () => {
    expect(periodStart(NOW, "unknown")).toBeNull();
    expect(periodEnd(NOW, "unknown")).toBeNull();
  });
});

describe("resolveRemaining — §5.1 ladder", () => {
  it("rung 1 wins with an observation made inside the current minute", () => {
    const r = resolutionFor({ observations: [observation(NOW - 5_000)], localUsed: { value: 3, basis: "reported" } });
    expect(r.remaining).toBe(40);
    expect(r.basis).toBe("provider-stated");
    expect(r.limit).toBe(60);
    expect(r.limitBasis).toBe("provider-stated");
    expect(r.eligibleObservation).not.toBeNull();
    expect(r.staleObservations).toBe(0);
    expect(r.routingEligible).toBe(true);
  });

  it("a stale observation is NOT eligible for rung 1 but its limit still feeds rung 2", () => {
    const stale = observation(NOW - 2 * MINUTE_MS); // previous minute window
    const r = resolutionFor({ observations: [stale], localUsed: { value: 25, basis: "reported" } });
    expect(r.eligibleObservation).toBeNull();
    expect(r.staleObservations).toBe(1);
    // The stale observation's LIMIT is durable knowledge, so rung 2 derives from it — and the
    // derived-from-provider-stated case reports that provenance honestly rather than claiming
    // a fresh statement.
    expect(r.remaining).toBe(35);
    expect(r.basis).toBe("derived:provider-stated");
    expect(r.limitBasis).toBe("provider-stated");
    expect(r.routingEligible).toBe(true);
  });

  it("rung 2 preserves a NEGATIVE remaining instead of clamping to zero", () => {
    const stale = observation(NOW - DAY_MS - MINUTE_MS);
    const r = resolutionFor({ observations: [stale], localUsed: { value: 75, basis: "reported" } });
    expect(r.remaining).toBe(-15); // 60 − 75, overshoot is information
    expect(r.limitBasis).toBe("provider-stated");
    expect(r.routingEligible).toBe(true);
  });

  it("rung 2 prefers configured over learned over published when no observation carries a limit", () => {
    const configuredOnly = resolutionFor({ limits: { configured: 100, learned: 50, published: 30 }, localUsed: { value: 10, basis: "estimated" } });
    expect(configuredOnly.remaining).toBe(90);
    expect(configuredOnly.limitBasis).toBe("configured");
    expect(configuredOnly.basis).toBe("derived:configured");
    expect(configuredOnly.routingEligible).toBe(true);

    const learnedFirst = resolutionFor({ limits: { learned: 50, published: 30 }, localUsed: { value: 10, basis: "estimated" } });
    expect(learnedFirst.remaining).toBe(40);
    expect(learnedFirst.limitBasis).toBe("learned");

    const publishedLast = resolutionFor({ limits: { published: 30 }, localUsed: { value: 10, basis: "estimated" } });
    expect(publishedLast.remaining).toBe(20);
    expect(publishedLast.limitBasis).toBe("published");
  });

  it("a derived:learned remaining is display-only (routingEligible false)", () => {
    const r = resolutionFor({ limits: { learned: 50 }, localUsed: { value: 10, basis: "reported" } });
    expect(r.remaining).toBe(40);
    expect(r.basis).toBe("derived:learned");
    expect(r.routingEligible).toBe(false);
  });

  it("rung 2 needs BOTH a limit and a non-null localUsed; otherwise unknown stays null", () => {
    const limitNoUse = resolutionFor({ limits: { configured: 100 } });
    expect(limitNoUse.remaining).toBeNull();
    expect(limitNoUse.basis).toBeNull();
    expect(limitNoUse.localUsed).toBeNull();

    const useNoLimit = resolutionFor({ localUsed: { value: 12, basis: "reported" } });
    expect(useNoLimit.remaining).toBeNull();
    expect(useNoLimit.limit).toBeNull();
    expect(useNoLimit.limitBasis).toBeNull();
  });

  it("an observation for a DIFFERENT tuple never answers this bucket", () => {
    const tokensMinute: QuotaObservation = { ...observation(NOW - 1_000), axis: "tokens" };
    const r = resolutionFor({ observations: [tokensMinute], limits: { configured: 10 }, localUsed: { value: 4, basis: "reported" } });
    expect(r.eligibleObservation).toBeNull();
    // Falls through to rung 2 on the requests axis.
    expect(r.remaining).toBe(6);
  });

  it("an observation timestamped in the future is not eligible", () => {
    const r = resolutionFor({ observations: [observation(NOW + MINUTE_MS)] });
    expect(r.eligibleObservation).toBeNull();
    expect(r.staleObservations).toBe(1);
    expect(r.remaining).toBeNull();
  });
});

describe("resolveResetsAt — §5.2 ladder", () => {
  it("provider-stated beats reviewed-rule beats derived-boundary", () => {
    // All three figures are in the future relative to `now` (the rung-1 eligibility gate).
    const future = NOW + MINUTE_MS;
    expect(resolveResetsAt({ providerStated: future + 1, reviewedRule: future + 2, period: "minute", now: NOW })).toEqual({
      resetsAt: future + 1,
      basis: "provider-stated",
    });
    expect(resolveResetsAt({ providerStated: null, reviewedRule: future + 2, period: "minute", now: NOW })).toEqual({
      resetsAt: future + 2,
      basis: "reviewed-rule",
    });
    expect(resolveResetsAt({ providerStated: null, reviewedRule: null, period: "minute", now: NOW })).toEqual({
      resetsAt: Date.UTC(2026, 7, 22, 12, 35),
      basis: "derived-boundary",
    });
  });

  it("a NON-FUTURE provider-stated reset is ineligible and falls through to the next rung", () => {
    // A skewed header (or an observation whose reset passed inside the period) must not render
    // a reset time that has already passed, ranked ABOVE the correct derived boundary.
    expect(resolveResetsAt({ providerStated: NOW - MINUTE_MS, reviewedRule: null, period: "minute", now: NOW })).toEqual({
      resetsAt: Date.UTC(2026, 7, 22, 12, 35),
      basis: "derived-boundary",
    });
    expect(resolveResetsAt({ providerStated: NOW, reviewedRule: null, period: "minute", now: NOW })).toEqual({
      resetsAt: Date.UTC(2026, 7, 22, 12, 35),
      basis: "derived-boundary",
    });
    // A future reviewed-rule outranks nothing but still beats the boundary when rung 1 declined.
    expect(resolveResetsAt({ providerStated: NOW - 1, reviewedRule: NOW + MINUTE_MS, period: "minute", now: NOW })).toEqual({
      resetsAt: NOW + MINUTE_MS,
      basis: "reviewed-rule",
    });
  });

  it("unknown period yields null rather than an invented boundary", () => {
    expect(resolveResetsAt({ providerStated: null, reviewedRule: null, period: "unknown", now: NOW })).toEqual({ resetsAt: null, basis: null });
  });
});

describe("contract vocabulary mapping", () => {
  it("maps every basis onto the dashboard spellings in one place", () => {
    expect(mapRemainingBasis("provider-stated")).toBe("provider_stated");
    expect(mapRemainingBasis("derived:provider-stated")).toBe("derived_provider_stated");
    expect(mapRemainingBasis("derived:configured")).toBe("derived_configured");
    expect(mapRemainingBasis("derived:learned")).toBe("derived_learned");
    expect(mapRemainingBasis("derived:published")).toBe("derived_published");
    expect(mapRemainingBasis(null)).toBeNull();

    expect(mapLimitBasis("provider-stated")).toBe("provider_stated");
    expect(mapLimitBasis("configured")).toBe("configured");
    expect(mapLimitBasis("learned")).toBe("learned");
    expect(mapLimitBasis("published")).toBe("published");
    expect(mapLimitBasis(null)).toBeNull();
  });
});
