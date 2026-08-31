/**
 * What a request spent on the attempt the relay ABANDONED — a hedge loser (owner decision D3).
 *
 * ⚠ **The whole design turns on one thing being kept APART.** `AccountingSpend` carries ONE
 * deployment's `pricesUsed`, `priceSource` and `tokenBasis`, so a winner's and a loser's amounts
 * may never be summed into one record. They are summed only in the four-cell aggregate, which is
 * keyed BY provenance and can therefore hold both honestly — and even there they land in their own
 * cells, never in `requestSpend`.
 *
 * ⚠ The negative controls carry the weight, and two of them guard a SILENT failure:
 *   - folding into `requestSpend` would flip `partiallyPricedRequests`, the wire contract's
 *     lower-bound marker, on for essentially every hedged request without one amount changing;
 *   - touching either counter risks `unpricedRequests + partiallyPricedRequests <= requests`, and
 *     breaching that does not throw — the snapshot build returns null and the store stops
 *     persisting while the relay keeps serving.
 */
import { describe, expect, it } from "vitest";
import {
  createAccountingRequest,
  type AccountingPricePort,
  type RequestCompletedEvent,
} from "../src/accounting.js";

const PORT: AccountingPricePort = () => ({
  pricePerMillionIn: 2,
  pricePerMillionOut: 8,
  priceSource: "provider",
});

function ids(): () => string {
  let index = 0;
  return () => {
    index += 1;
    return `generated-id-${index.toString().padStart(14, "0")}`;
  };
}

/** A hedged request: a winner, plus a loser the relay abandoned. */
function hedged(options: { abandonedByRelay: boolean }): RequestCompletedEvent {
  const request = createAccountingRequest({ idFactory: ids(), pricePort: PORT });
  const loser = request.startAttempt({ provider: "slow", model: "m-slow" });
  const winner = request.startAttempt({ provider: "fast", model: "m-fast" });
  loser.complete({
    outcome: "cancelled",
    failureKind: "aborted",
    tokens: { reported: { inputTokens: 500, outputTokens: 0 } },
    abandonedByRelay: options.abandonedByRelay,
  });
  winner.complete({
    outcome: "success",
    tokens: { reported: { inputTokens: 500, outputTokens: 100 } },
  });
  const completed = request.complete();
  if (!completed) throw new Error("request completion was unexpectedly absent");
  return completed;
}

describe("abandoned spend — the producer", () => {
  it("carries the loser's OWN priced record, apart from the winner's", () => {
    const event = hedged({ abandonedByRelay: true });

    expect(event.abandonedSpend).toHaveLength(1);
    const loser = event.abandonedSpend[0]!;
    expect(loser.amountMicrousd).toBeGreaterThan(0);
    // Its own prices, its own basis. Nothing was re-priced and nothing was merged.
    expect(loser.pricesUsed).toEqual({ perMillionIn: 2, perMillionOut: 8 });
    // And the winner's figure is untouched by it.
    expect(event.spend?.amountMicrousd).toBeGreaterThan(0);
    expect(event.spend?.amountMicrousd).not.toBe(
      (event.spend?.amountMicrousd ?? 0) + loser.amountMicrousd,
    );
  });

  it("does NOT claim a cancellation the relay did not abandon", () => {
    // The same shape with the flag unstated: a client disconnect. At this layer the two are
    // otherwise identical — both `cancelled`/`aborted` — which is exactly why the flag must be
    // STATED by the caller and never inferred from the attempts map.
    const event = hedged({ abandonedByRelay: false });

    expect(event.abandonedSpend).toEqual([]);
  });

  it("is empty for an ordinary request that ran no hedge", () => {
    const request = createAccountingRequest({ idFactory: ids(), pricePort: PORT });
    const attempt = request.startAttempt({ provider: "p", model: "m" });
    attempt.complete({ outcome: "success", tokens: { reported: { inputTokens: 10, outputTokens: 2 } } });

    expect(request.complete()?.abandonedSpend).toEqual([]);
  });

  it("keeps one entry per loser rather than one merged record", () => {
    // A merged record could not state whose prices produced it. A list can.
    const request = createAccountingRequest({ idFactory: ids(), pricePort: PORT });
    const first = request.startAttempt({ provider: "a", model: "m-a" });
    const second = request.startAttempt({ provider: "b", model: "m-b" });
    const winner = request.startAttempt({ provider: "c", model: "m-c" });
    for (const loser of [first, second]) {
      loser.complete({
        outcome: "cancelled",
        failureKind: "aborted",
        tokens: { reported: { inputTokens: 100, outputTokens: 0 } },
        abandonedByRelay: true,
      });
    }
    winner.complete({ outcome: "success", tokens: { reported: { inputTokens: 100, outputTokens: 5 } } });

    expect(request.complete()?.abandonedSpend).toHaveLength(2);
  });

  it("does not treat an abandoned REPAIR attempt as a serve loser", () => {
    // Repair is internal traffic and is metered on its own axis; D3 is about the serve the caller
    // never received.
    const request = createAccountingRequest({ idFactory: ids(), pricePort: PORT });
    const repair = request.startAttempt({ role: "repair", provider: "r", model: "m-r" });
    const winner = request.startAttempt({ provider: "c", model: "m-c" });
    repair.complete({
      outcome: "cancelled",
      failureKind: "aborted",
      tokens: { reported: { inputTokens: 50, outputTokens: 0 } },
      abandonedByRelay: true,
    });
    winner.complete({ outcome: "success", tokens: { reported: { inputTokens: 10, outputTokens: 2 } } });

    expect(request.complete()?.abandonedSpend).toEqual([]);
  });
});
