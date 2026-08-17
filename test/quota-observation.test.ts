import { describe, expect, it } from "vitest";
import {
  extractQuotaObservations,
  headroomPercent,
  mergeQuotaObservations,
  type QuotaObservation,
} from "../src/quota-observation.js";

const at = 1_700_000_000_000;

describe("typed quota observations", () => {
  it("accepts case-insensitive Headers and record input", () => {
    const fromHeaders = extractQuotaObservations(new Headers({
      "X-RateLimit-Limit-Requests-Day": "100",
      "x-ratelimit-remaining-requests-day": "25",
    }), { observedAt: at });
    const fromRecord = extractQuotaObservations({
      "X-Ratelimit-Limit-Requests-Day": "100",
      "X-Ratelimit-Remaining-Requests-Day": "25",
    }, { observedAt: at });
    expect(fromHeaders).toEqual(fromRecord);
    expect(fromHeaders[0]).toEqual({
      axis: "requests",
      period: "day",
      limit: 100,
      remaining: 25,
      resetsAt: null,
      observedAt: at,
      basis: "provider-stated",
    });
  });

  it("accepts singular request and token axis names", () => {
    const observations = extractQuotaObservations({
      "x-ratelimit-limit-request": "12",
      "x-ratelimit-remaining-request": "3",
      "x-ratelimit-limit-token-minute": "400",
      "x-ratelimit-remaining-token-minute": "100",
    }, { observedAt: at });
    expect(observations.map(({ axis, period, limit, remaining }) => ({ axis, period, limit, remaining })))
      .toEqual([
        { axis: "requests", period: "unknown", limit: 12, remaining: 3 },
        { axis: "tokens", period: "minute", limit: 400, remaining: 100 },
      ]);
  });

  it("returns every valid axis pair and preserves their periods", () => {
    const observations = extractQuotaObservations({
      "x-ratelimit-limit-requests-day": "100",
      "x-ratelimit-remaining-requests-day": "25",
      "x-ratelimit-limit-tokens-minute": "1000",
      "x-ratelimit-remaining-tokens-minute": "800",
    }, { observedAt: at });
    expect(observations).toHaveLength(2);
    expect(observations.map(({ axis, period, limit, remaining }) => ({ axis, period, limit, remaining })))
      .toEqual([
        { axis: "requests", period: "day", limit: 100, remaining: 25 },
        { axis: "tokens", period: "minute", limit: 1000, remaining: 800 },
      ]);
  });

  it("uses unknown for explicit unsuffixed axes and ignores generic pairs", () => {
    const observations = extractQuotaObservations({
      "x-ratelimit-limit-requests": "10",
      "x-ratelimit-remaining-requests": "5",
      "x-ratelimit-limit-tokens": "20",
      "x-ratelimit-remaining-tokens": "2",
      "x-ratelimit-limit": "999",
      "x-ratelimit-remaining": "1",
    }, { observedAt: at });
    expect(observations.map(({ axis, period }) => ({ axis, period }))).toEqual([
      { axis: "requests", period: "unknown" },
      { axis: "tokens", period: "unknown" },
    ]);
  });

  it("rejects incomplete, partial, non-finite, non-positive, and negative values", () => {
    const invalid = extractQuotaObservations({
      "x-ratelimit-limit-requests-day": "100rpm",
      "x-ratelimit-remaining-requests-day": "25",
      "x-ratelimit-limit-tokens-minute": "0",
      "x-ratelimit-remaining-tokens-minute": "0",
      "x-ratelimit-limit-requests-minute": "100",
      "x-ratelimit-remaining-requests-minute": "-1",
      "x-ratelimit-limit-tokens-day": "1e999",
      "x-ratelimit-remaining-tokens-day": "1",
      "x-ratelimit-limit-requests-month": "100",
    }, { observedAt: at });
    expect(invalid).toEqual([]);
  });

  it("parses only unambiguous paired reset formats", () => {
    const observations = extractQuotaObservations({
      "anthropic-ratelimit-requests-limit": "10",
      "anthropic-ratelimit-requests-remaining": "0",
      "anthropic-ratelimit-requests-reset": "30s",
      "x-ratelimit-limit-tokens-minute": "1000",
      "x-ratelimit-remaining-tokens-minute": "500",
      "x-ratelimit-reset-tokens-minute": "2023-11-14T22:13:20.000Z",
    }, { observedAt: at });
    expect(observations[0]!.resetsAt).toBe(at + 30_000);
    expect(observations[1]!.resetsAt).toBe(1_700_000_000_000);

    const ambiguous = extractQuotaObservations({
      "x-ratelimit-limit-requests-minute": "10",
      "x-ratelimit-remaining-requests-minute": "5",
      "x-ratelimit-limit-requests-day": "100",
      "x-ratelimit-remaining-requests-day": "5",
      "x-ratelimit-reset-requests": "30s",
    }, { observedAt: at });
    expect(ambiguous.every((observation) => observation.resetsAt === null)).toBe(true);

    const durations = extractQuotaObservations({
      "x-ratelimit-limit-requests": "10",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "1h 30m",
    }, { observedAt: at });
    expect(durations[0]!.resetsAt).toBe(at + 5_400_000);
    const malformedDuration = extractQuotaObservations({
      "x-ratelimit-limit-requests": "10",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "1 2s",
    }, { observedAt: at });
    expect(malformedDuration[0]!.resetsAt).toBeNull();
    expect(extractQuotaObservations({
      "x-ratelimit-limit-requests": "10",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "1/2/03",
    }, { observedAt: at })[0]!.resetsAt).toBeNull();
  });

  it("uses Retry-After only to fill reset on existing exhausted observations", () => {
    const observations = extractQuotaObservations({
      "x-ratelimit-limit-requests": "10",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-limit-tokens": "100",
      "x-ratelimit-remaining-tokens": "1",
      "retry-after": "12",
    }, { observedAt: at });
    expect(observations[0]!.resetsAt).toBe(at + 12_000);
    expect(observations[1]!.resetsAt).toBeNull();

    expect(extractQuotaObservations({ "retry-after": "12" }, { observedAt: at })).toEqual([]);
    expect(extractQuotaObservations({
      "x-ratelimit-limit-requests": "10",
      "x-ratelimit-remaining-requests": "0",
      "retry-after": "12.5",
    }, { observedAt: at })[0]!.resetsAt).toBeNull();
    expect(extractQuotaObservations({
      "x-ratelimit-limit-requests": "10",
      "x-ratelimit-remaining-requests": "0",
      "retry-after": "Tue, 14 Nov 2023 22:13:20 GMT",
    }, { observedAt: at })[0]!.resetsAt).toBe(1_700_000_000_000);
  });

  it("merges by axis and period, replacing only matching tuples", () => {
    const first = extractQuotaObservations({
      "x-ratelimit-limit-requests-day": "100",
      "x-ratelimit-remaining-requests-day": "25",
      "x-ratelimit-limit-tokens-minute": "1000",
      "x-ratelimit-remaining-tokens-minute": "800",
    }, { observedAt: at });
    const second = extractQuotaObservations({
      "x-ratelimit-limit-requests-day": "200",
      "x-ratelimit-remaining-requests-day": "150",
    }, { observedAt: at + 10 });
    expect(mergeQuotaObservations(first, second)).toEqual([
      second[0],
      first[1],
    ]);
  });

  it("derives headroom without storing a percent field", () => {
    const [observation] = extractQuotaObservations({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "25",
    }, { observedAt: at });
    expect(headroomPercent(observation!)).toBe(25);
    expect(JSON.stringify(observation)).not.toContain("percent");
    expect(Object.keys(observation!)).toEqual([
      "axis", "period", "limit", "remaining", "resetsAt", "observedAt", "basis",
    ]);
  });

  it("accepts a typed observation for render-time derivation", () => {
    const observation: QuotaObservation = {
      axis: "tokens",
      period: "month",
      limit: 10,
      remaining: 20,
      resetsAt: null,
      observedAt: at,
      basis: "provider-stated",
    };
    expect(headroomPercent(observation)).toBe(100);
  });
});
