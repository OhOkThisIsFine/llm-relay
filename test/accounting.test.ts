import { describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_REQUEST_ID_PATTERN,
  type Attribution,
} from "../src/dashboard-contract.js";
import {
  ACCOUNTING_UNSPECIFIED_ESTIMATION_METHOD,
  createAccountingRequest,
  NOOP_ACCOUNTING_RECORDER,
  type AccountingEvent,
  type AccountingPricePort,
  type AccountingRecorder,
  type AttemptCompletedEvent,
  type TokenFactsInput,
} from "../src/accounting.js";

function deterministic(ids = ["request-id-123456", "attempt-id-123456", "attempt-id-234567"]): () => string {
  let index = 0;
  return () => ids[index++] ?? `generated-id-${index.toString().padStart(14, "0")}`;
}

function recorder(events: AccountingEvent[]): AccountingRecorder {
  return { record: (event) => events.push(event) };
}

/** A completed serve attempt's spend through the real lifecycle, with a fixed id. */
function pricedAttempt(
  pricePort: AccountingPricePort | undefined,
  tokens: TokenFactsInput,
  provider = "prov",
  model = "model-a",
): AttemptCompletedEvent {
  const request = createAccountingRequest({ idFactory: deterministic(), pricePort });
  const attempt = request.startAttempt({ provider, model });
  return attempt.complete({ outcome: "success", tokens })!;
}

const PORT_PUBLISHED: AccountingPricePort = () => ({
  pricePerMillionIn: 2,
  pricePerMillionOut: 8,
  priceSource: "provider",
});
const PORT_REFERENCE: AccountingPricePort = () => ({
  pricePerMillionIn: 2,
  pricePerMillionOut: 8,
  priceSource: "reference",
});

describe("spend pricing (Stage 4 / Gap 11)", () => {
  it("prices the reported cell from published prices, in exact integer micro-USD", () => {
    // 1_000 in x $2/M = 2_000 uUSD; 500 out x $8/M = 4_000 uUSD; total 6_000.
    const event = pricedAttempt(PORT_PUBLISHED, { reported: { inputTokens: 1_000, outputTokens: 500 } });
    expect(event.spend).toMatchObject({
      amountMicrousd: 6_000,
      priceSource: "provider_published",
      tokenBasis: "reported",
      source: "provider_reported",
      coverage: "full",
      pricesUsed: { perMillionIn: 2, perMillionOut: 8 },
    });
    expect(event.spend?.unpricedTokens).toEqual({ cacheRead: null, cacheCreation: null, cachedInput: null });
  });

  it("rounds HALF-UP per token kind and sums integers", () => {
    // 1 token x $0.5/M = 0.5 uUSD -> 1 (half-up); 1 token x $1.5/M = 1.5 -> 2.
    const port: AccountingPricePort = () => ({ pricePerMillionIn: 0.5, pricePerMillionOut: 1.5, priceSource: "provider" });
    const event = pricedAttempt(port, { reported: { inputTokens: 1, outputTokens: 1 } });
    expect(event.spend?.amountMicrousd).toBe(3);
  });

  it("rounds a true .5 product half-up even when the float product lands just below it", () => {
    // 100 x $0.145/M is exactly 14.5 uUSD, but IEEE754 computes it as
    // 14.499999999999998, so a float Math.round rounds DOWN to 14. The integer
    // path scales the price first (145000 x 100) and half-up must give 15.
    expect(Math.round(100 * 0.145)).toBe(14);
    const port: AccountingPricePort = () => ({ pricePerMillionIn: 0.145, pricePerMillionOut: null, priceSource: "provider" });
    const event = pricedAttempt(port, { reported: { inputTokens: 100 } });
    expect(event.spend?.amountMicrousd).toBe(15);
  });

  it("prices the estimated cell input-only and labels it, never mixing with reported", () => {
    const event = pricedAttempt(PORT_PUBLISHED, {
      estimated: { inputTokens: 2_000, outputTokens: 9_999, inputMethod: "chars/4" },
    });
    expect(event.spend).toMatchObject({
      amountMicrousd: 4_000,
      priceSource: "provider_published",
      tokenBasis: "estimated",
      source: "relay_estimated",
      coverage: "input_only",
    });
    // Estimated output is a separate metering fact; current spend policy must not price it.
    expect(event.spend?.amountMicrousd).not.toBe(2_000 + 9_999 * 8);
  });

  it("labels reference-priced spend as reference", () => {
    const event = pricedAttempt(PORT_REFERENCE, { reported: { inputTokens: 1_000, outputTokens: 0 } });
    expect(event.spend?.priceSource).toBe("reference");
    expect(event.spend?.amountMicrousd).toBe(2_000);
  });

  it("leaves an attempt UNPRICED (null, never $0) when no published price resolves", () => {
    const event = pricedAttempt(undefined, { reported: { inputTokens: 1_000, outputTokens: 500 } });
    expect(event.spend).toBeNull();
  });

  it("marks anthropic cache kinds unpriced beside the amount with partial coverage", () => {
    // Cache read/creation are NOT part of input_tokens; they ride unpriced.
    const event = pricedAttempt(PORT_PUBLISHED, {
      reported: { inputTokens: 1_000, outputTokens: 100, cacheReadInputTokens: 4_000, cacheCreationInputTokens: 500 },
    });
    expect(event.spend).toMatchObject({
      amountMicrousd: 2_000 + 800,
      coverage: "partial",
      unpricedTokens: { cacheRead: 4_000, cacheCreation: 500, cachedInput: null },
    });
  });

  it("subtracts openai cached tokens from prompt before pricing and records them unpriced", () => {
    // OpenAI INCLUDES cached tokens in prompt_tokens; the discount is unpublished.
    const event = pricedAttempt(PORT_PUBLISHED, { reported: { inputTokens: 1_000, outputTokens: 0, cachedInputTokens: 400 } });
    expect(event.spend).toMatchObject({
      amountMicrousd: 600 * 2,
      coverage: "partial",
      unpricedTokens: { cacheRead: null, cacheCreation: null, cachedInput: 400 },
    });
  });

  it("treats a malformed cache figure (cached > prompt) as absent, pricing prompt in full", () => {
    const event = pricedAttempt(PORT_PUBLISHED, { reported: { inputTokens: 1_000, outputTokens: 0, cachedInputTokens: 2_000 } });
    expect(event.spend).toMatchObject({
      amountMicrousd: 2_000,
      coverage: "full",
      unpricedTokens: { cacheRead: null, cacheCreation: null, cachedInput: null },
    });
  });

  it("marks a reported attempt partial when one kind has no published price", () => {
    const port: AccountingPricePort = () => ({ pricePerMillionIn: 2, pricePerMillionOut: null, priceSource: "provider" });
    const event = pricedAttempt(port, { reported: { inputTokens: 1_000, outputTokens: 700 } });
    expect(event.spend).toMatchObject({ amountMicrousd: 2_000, coverage: "partial" });
  });

  it("prices repair attempts on their own rows and projects only the winning serve at request level", () => {
    const events: AccountingEvent[] = [];
    const request = createAccountingRequest({ recorder: recorder(events), idFactory: deterministic(), pricePort: PORT_PUBLISHED });
    const repair = request.startAttempt({ role: "repair", provider: "prov", model: "model-a" });
    const repairEvent = repair.complete({
      outcome: "success",
      tokens: { reported: { inputTokens: 100, outputTokens: 0 } },
    })!;
    const serve = request.startAttempt({ provider: "prov", model: "model-a" });
    const serveEvent = serve.complete({
      outcome: "success",
      tokens: { reported: { inputTokens: 1_000, outputTokens: 0 } },
    })!;
    const done = request.complete({ winningAttemptId: serve.attemptId })!;
    // Repair is priced, on its own attempt row (C1).
    expect(repairEvent.spend?.amountMicrousd).toBe(200);
    expect(serveEvent.spend?.amountMicrousd).toBe(2_000);
    // Request-level spend mirrors request tokens: the WINNING serve only.
    expect(done.spend?.amountMicrousd).toBe(2_000);
    expect(done.spend?.tokenBasis).toBe("reported");
  });

  it("leaves a failed request (no winning serve) unpriced even when a price exists", () => {
    const request = createAccountingRequest({ idFactory: deterministic(), pricePort: PORT_PUBLISHED });
    const serve = request.startAttempt({ provider: "prov", model: "model-a" });
    serve.complete({ outcome: "error", failureKind: "rate_limit", tokens: { reported: { inputTokens: 5_000, outputTokens: 0 } } });
    const done = request.complete({ outcome: "error", failureKind: "rate_limit" })!;
    expect(done.spend).toBeNull();
  });
});

describe("canonical accounting primitive", () => {
  it("creates opaque valid unique IDs and links lifecycle events", () => {
    const events: AccountingEvent[] = [];
    const request = createAccountingRequest({ recorder: recorder(events), idFactory: deterministic(), clock: () => 1_000 });
    const serve = request.startAttempt({ role: "serve", provider: "p", model: "m", credentialId: "p#one" });
    serve.complete({ outcome: "success", endedAt: 2_000, tokens: { reported: { inputTokens: 0, outputTokens: 3, cachedInputTokens: 2 } } });
    const completed = request.complete({ winningAttemptId: serve.attemptId, endedAt: 3_000 });

    expect(DASHBOARD_REQUEST_ID_PATTERN.test(request.requestId)).toBe(true);
    expect(DASHBOARD_REQUEST_ID_PATTERN.test(serve.attemptId)).toBe(true);
    expect(request.requestId).not.toBe(serve.attemptId);
    expect(events.map((event) => event.type)).toEqual([
      "request-started",
      "attempt-started",
      "attempt-completed",
      "request-completed",
    ]);
    expect(events[1]).toMatchObject({ requestId: request.requestId, attemptId: serve.attemptId, role: "serve" });
    expect(completed?.winningAttemptId).toBe(serve.attemptId);
    expect(completed?.attemptCount).toBe(1);
  });

  it("freezes snapshots and separates reported, estimated, and Anthropic cache facts", () => {
    const events: AccountingEvent[] = [];
    const metadata = { client: "claude", attribution: "relay_held" as Attribution };
    const request = createAccountingRequest({ ...metadata, recorder: recorder(events), idFactory: deterministic() });
    const attempt = request.startAttempt({ provider: "anthropic", model: "m", credentialId: "anthropic#one" });
    const input = {
      reported: { inputTokens: 0, outputTokens: 4, cachedInputTokens: 2, cacheCreationInputTokens: 8, cacheReadInputTokens: 16 },
      estimated: { inputTokens: 99, outputTokens: 100, inputMethod: "chars/4" },
    };
    const event = attempt.complete({ outcome: "success", tokens: input });
    metadata.client = "changed";
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event?.tokens)).toBe(true);
    expect(event?.tokens.reported.reportedInput.value).toBe(0);
    expect(event?.tokens.reported.reportedOutput.value).toBe(4);
    expect(event?.tokens.reported.reportedCachedInput.value).toBe(2);
    expect(event?.tokens.reported.cacheCreationInputTokens.value).toBe(8);
    expect(event?.tokens.reported.cacheReadInputTokens.value).toBe(16);
    expect(event?.tokens.estimated.estimatedInput.value).toBe(99);
    expect(event?.tokens.estimated.estimatedInput.method).toBe("chars/4");
    expect(event?.tokens.estimated.estimatedOutput.value).toBe(100);
    expect(event?.tokens.estimated.estimatedOutput.method).toBe(ACCOUNTING_UNSPECIFIED_ESTIMATION_METHOD);
    expect(event?.spend).toBeNull();
    expect(events[0]).toMatchObject({ client: "claude", attribution: "relay_held" });
  });

  it("keeps repair attempts separate and projects only the winning serve tokens", () => {
    const events: AccountingEvent[] = [];
    const request = createAccountingRequest({ recorder: recorder(events), idFactory: deterministic() });
    const repair = request.startAttempt({ role: "repair", provider: "repair-p" });
    repair.complete({ outcome: "success", tokens: { reported: { outputTokens: 100 } } });
    const serve = request.startAttempt({ role: "serve", provider: "serve-p", model: "winner" });
    serve.complete({ outcome: "success", tokens: { reported: { inputTokens: 4, outputTokens: 5 } } });
    const done = request.complete({ winningAttemptId: serve.attemptId });
    expect(done).toMatchObject({ attemptCount: 2, repairIncluded: true, winningAttemptId: serve.attemptId, provider: "serve-p" });
    expect(done?.tokens.reported.reportedInput.value).toBe(4);
    expect(done?.tokens.reported.reportedOutput.value).toBe(5);
  });

  it("suppresses duplicate completion and commit markers", () => {
    const events: AccountingEvent[] = [];
    const request = createAccountingRequest({ recorder: recorder(events), idFactory: deterministic() });
    const attempt = request.startAttempt();
    expect(attempt.markCommitted({ commitMs: 12 })).toBe(true);
    expect(attempt.markCommitted({ commitMs: 14 })).toBe(false);
    const first = attempt.complete({ outcome: "success" });
    expect(attempt.complete({ outcome: "error", failureKind: "provider_error" })).toBe(first);
    const done = request.complete({ winningAttemptId: attempt.attemptId });
    expect(request.complete()).toBe(done);
    expect(events.filter((event) => event.type === "attempt-completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "request-completed")).toHaveLength(1);
    expect(done?.commitMs).toBe(12);
  });

  it("supports explicit cancellation/failure and rejects invalid transitions", () => {
    const request = createAccountingRequest({ idFactory: deterministic() });
    const attempt = request.startAttempt();
    expect(() => request.complete()).toThrow(/active/);
    const cancelled = attempt.complete({ outcome: "cancelled", failureKind: "aborted", latencyMs: null });
    expect(cancelled).toMatchObject({ outcome: "cancelled", failureKind: "aborted", latencyMs: null });
    expect(request.complete({ outcome: "cancelled" })).toMatchObject({ outcome: "cancelled", failureKind: null });
    expect(() => request.startAttempt()).toThrow(/after request completion/);
  });

  it("isolates a throwing recorder and supplies a no-op recorder", () => {
    const throwing: AccountingRecorder = { record: () => { throw new Error("sink down"); } };
    const request = createAccountingRequest({ recorder: throwing, idFactory: deterministic() });
    const attempt = request.startAttempt();
    expect(() => attempt.complete({ outcome: "error", failureKind: "timeout" })).not.toThrow();
    expect(() => request.complete({ outcome: "error" })).not.toThrow();
    expect(NOOP_ACCOUNTING_RECORDER).toBe(NOOP_ACCOUNTING_RECORDER);
  });

  it("records the first meaningful commit once", () => {
    const clock = vi.fn(() => 2_000);
    const request = createAccountingRequest({ clock, idFactory: deterministic() });
    const first = request.startAttempt({ startedAt: 1_000 });
    const second = request.startAttempt({ startedAt: 1_000 });
    expect(request.markCommitted(first.attemptId, { at: 1_025 })).toBe(true);
    expect(request.markCommitted(second.attemptId, { at: 1_030 })).toBe(false);
    first.complete({ outcome: "success" });
    second.complete({ outcome: "error", failureKind: "provider_error" });
    expect(request.complete({ winningAttemptId: first.attemptId })?.commitMs).toBe(25);
  });

  it("rejects non-canonical explicit timestamps before recording", () => {
    expect(() => createAccountingRequest({ startedAt: "2026-08-20 00:00:00Z", idFactory: deterministic() })).toThrow(/timestamp/);
    const events: AccountingEvent[] = [];
    const request = createAccountingRequest({ recorder: recorder(events), idFactory: deterministic() });
    expect(() => request.startAttempt({ startedAt: "2026-08-20T00:00:00+00:00" })).toThrow(/timestamp/);
    const attempt = request.startAttempt({ startedAt: "2026-08-20T00:00:00.000Z" });
    expect(() => attempt.complete({ outcome: "success", endedAt: "not-a-timestamp" })).toThrow(/timestamp/);
    expect(() => attempt.complete({
      outcome: "success",
      tokens: { observedAt: "2026-02-30T00:00:00.000Z" },
    })).toThrow(/observedAt/);
    expect(events.filter((event) => event.type === "attempt-completed")).toHaveLength(0);
  });

  it("does not latch invalid or repair commits and exposes the winning commit attempt", () => {
    const events: AccountingEvent[] = [];
    const request = createAccountingRequest({ recorder: recorder(events), idFactory: deterministic() });
    const repair = request.startAttempt({ role: "repair", startedAt: "2026-08-20T00:00:00.000Z" });
    expect(repair.markCommitted({ commitMs: 0, at: "2026-08-20T00:00:00.001Z" })).toBe(false);
    repair.complete({ outcome: "success", commitMs: 5 });
    const serve = request.startAttempt({ role: "serve", startedAt: "2026-08-20T00:00:00.000Z" });
    expect(serve.markCommitted({ commitMs: null })).toBe(false);
    expect(serve.markCommitted({ commitMs: -1 })).toBe(false);
    expect(serve.markCommitted({ commitMs: 1.5 })).toBe(false);
    expect(serve.markCommitted({ at: "2026-08-19T23:59:59.999Z" })).toBe(false);
    expect(serve.markCommitted({ at: "not-a-timestamp" })).toBe(false);
    expect(serve.markCommitted({ at: "2026-08-20T00:00:00.025Z" })).toBe(true);
    expect(serve.markCommitted({ commitMs: 30 })).toBe(false);
    serve.complete({ outcome: "success" });
    const done = request.complete();
    expect(done).toMatchObject({ winningAttemptId: serve.attemptId, commitAttemptId: serve.attemptId, commitMs: 25 });
    const repairEvent = events.find((event) => event.type === "attempt-completed" && event.role === "repair");
    expect(repairEvent?.type === "attempt-completed" ? repairEvent.commitMs : undefined).toBeNull();
  });

  it("does not manufacture the cached-input aggregate from Anthropic cache facts", () => {
    const request = createAccountingRequest({ idFactory: deterministic() });
    const attempt = request.startAttempt();
    const event = attempt.complete({
      outcome: "success",
      tokens: { reported: { cacheCreationInputTokens: 11, cacheReadInputTokens: 22 } },
    });
    expect(event?.tokens.reported.reportedCachedInput.value).toBeNull();
    expect(event?.tokens.reported.cacheCreationInputTokens.value).toBe(11);
    expect(event?.tokens.reported.cacheReadInputTokens.value).toBe(22);
  });

  it("requires successful winners and never infers missing request failure", () => {
    const request = createAccountingRequest({ idFactory: deterministic() });
    const failed = request.startAttempt();
    failed.complete({ outcome: "error", failureKind: "provider_error" });
    expect(() => request.complete()).toThrow(/outcome/);
    expect(() => request.complete({ winningAttemptId: failed.attemptId, outcome: "error" })).toThrow(/successful serve/);
    const done = request.complete({ outcome: "error", failureKind: null });
    expect(done).toMatchObject({ outcome: "error", failureKind: null, winningAttemptId: null, commitAttemptId: null });

    const successRequest = createAccountingRequest({ idFactory: deterministic() });
    const success = successRequest.startAttempt();
    expect(() => success.complete({ outcome: "success", failureKind: "unknown" })).toThrow(/failure kind/);
    success.complete({ outcome: "success" });
    expect(() => successRequest.complete({ outcome: "error", winningAttemptId: success.attemptId })).toThrow(/non-successful/);
    expect(() => successRequest.complete({ outcome: "success", failureKind: "unknown", winningAttemptId: success.attemptId })).toThrow(/failure kind/);
    expect(successRequest.complete({ outcome: "success", winningAttemptId: success.attemptId })).toMatchObject({ outcome: "success" });
  });

  it("derives implicit success before validating failure kind", () => {
    const request = createAccountingRequest({ idFactory: deterministic() });
    const serve = request.startAttempt();
    serve.complete({ outcome: "success" });

    expect(() => request.complete({ failureKind: "unknown" })).toThrow(/failure kind/);
    expect(request.completed).toBe(false);
  });

  it("keeps the first committed serve authoritative over an explicit mismatch", () => {
    const request = createAccountingRequest({ idFactory: deterministic() });
    const first = request.startAttempt();
    const second = request.startAttempt();
    expect(first.markCommitted({ commitMs: 7 })).toBe(true);
    first.complete({ outcome: "success", tokens: { reported: { outputTokens: 1 } } });
    second.complete({ outcome: "success", tokens: { reported: { outputTokens: 2 } } });

    expect(() => request.complete({ winningAttemptId: second.attemptId })).toThrow(/committed serve/);
    expect(request.completed).toBe(false);
    expect(request.complete({ winningAttemptId: first.attemptId })?.winningAttemptId).toBe(first.attemptId);
  });

  it("distinguishes an omitted winner from an explicitly null winner", () => {
    const request = createAccountingRequest({ idFactory: deterministic() });
    const serve = request.startAttempt();
    serve.complete({ outcome: "success", tokens: { reported: { outputTokens: 3 } } });

    expect(() => request.complete({ winningAttemptId: null })).toThrow(/outcome/);
    expect(() => request.complete({ winningAttemptId: null, outcome: "success" })).toThrow(/successful serve/);
    expect(request.complete({ winningAttemptId: null, outcome: "error", failureKind: "unknown" })).toMatchObject({
      outcome: "error",
      winningAttemptId: null,
      commitAttemptId: null,
    });
  });

  it.each([
    ["error", "provider_error"],
    ["cancelled", "aborted"],
  ] as const)("keeps a committed %s serve authoritative over a later successful serve", (attemptOutcome, failureKind) => {
    const request = createAccountingRequest({ idFactory: deterministic() });
    const committed = request.startAttempt({ provider: "committed", attribution: "relay_held" });
    const fallback = request.startAttempt({ provider: "fallback", attribution: "caller_operated" });
    expect(committed.markCommitted({ commitMs: 9 })).toBe(true);
    committed.complete({ outcome: attemptOutcome, failureKind, tokens: { reported: { outputTokens: 1 } } });
    fallback.complete({ outcome: "success", tokens: { reported: { outputTokens: 2 } } });

    expect(() => request.complete({
      outcome: attemptOutcome,
      failureKind,
      winningAttemptId: fallback.attemptId,
    })).toThrow(/committed serve/);
    const done = request.complete({ outcome: attemptOutcome, failureKind });
    expect(done).toMatchObject({
      outcome: attemptOutcome,
      winningAttemptId: committed.attemptId,
      commitAttemptId: committed.attemptId,
      commitMs: 9,
      provider: "committed",
      attribution: "relay_held",
    });
    expect(done?.tokens.reported.reportedOutput.value).toBe(1);
  });

  it("rejects a runtime null request outcome instead of treating it as omitted", () => {
    const request = createAccountingRequest({ idFactory: deterministic() });
    const serve = request.startAttempt();
    serve.complete({ outcome: "success" });

    expect(() => request.complete({ outcome: null as never })).toThrow(/outcome/);
    expect(request.completed).toBe(false);
  });

  it("derives terminal attribution from the winning serve after failover", () => {
    const events: AccountingEvent[] = [];
    const request = createAccountingRequest({
      attribution: "unknown",
      recorder: recorder(events),
      idFactory: deterministic(),
    });
    const failed = request.startAttempt({ attribution: "relay_held" });
    failed.complete({ outcome: "error", failureKind: "provider_error" });
    const served = request.startAttempt({ attribution: "caller_operated" });
    served.complete({ outcome: "success" });

    const done = request.complete();
    expect(done?.attribution).toBe("caller_operated");
    expect(events.find((event) => event.type === "attempt-started" && event.attemptId === failed.attemptId)).toMatchObject({
      attribution: "relay_held",
    });
    expect(events.find((event) => event.type === "attempt-completed" && event.attemptId === served.attemptId)).toMatchObject({
      attribution: "caller_operated",
    });
  });

  it("uses explicit attribution for a no-winner terminal request", () => {
    const request = createAccountingRequest({ attribution: "unknown", idFactory: deterministic() });
    const repair = request.startAttempt({ role: "repair", attribution: "relay_held" });
    repair.complete({ outcome: "error", failureKind: "provider_error" });

    const done = request.complete({ outcome: "error", attribution: "caller_operated" });
    expect(done).toMatchObject({ outcome: "error", winningAttemptId: null, attribution: "caller_operated" });
  });

  it("rejects invalid and conflicting attribution before emitting terminal events", () => {
    expect(() => createAccountingRequest({ attribution: null as never, idFactory: deterministic() })).toThrow(/attribution/);

    const events: AccountingEvent[] = [];
    const request = createAccountingRequest({ recorder: recorder(events), idFactory: deterministic() });
    expect(() => request.startAttempt({ attribution: null as never })).toThrow(/attribution/);
    expect(() => request.startAttempt({ attribution: "not-an-attribution" as never })).toThrow(/attribution/);
    expect(events.filter((event) => event.type === "attempt-started")).toHaveLength(0);
    const serve = request.startAttempt({ attribution: "relay_held" });
    serve.complete({ outcome: "success" });
    expect(() => request.complete({ attribution: "caller_operated" })).toThrow(/conflicts/);
    expect(() => request.complete({ outcome: "error", attribution: null as never })).toThrow(/attribution/);
    expect(events.filter((event) => event.type === "request-completed")).toHaveLength(0);
  });

  it("preserves and validates reported and estimated observation timestamps independently", () => {
    const request = createAccountingRequest({ idFactory: deterministic() });
    const attempt = request.startAttempt();
    const event = attempt.complete({
      outcome: "success",
      tokens: {
        reported: { inputTokens: 1, observedAt: "2026-08-20T00:00:01.000Z" },
        estimated: { inputTokens: 2, observedAt: "2026-08-20T00:00:02.000Z" },
      },
    });
    expect(event?.tokens.reported.reportedInput.observedAt).toBe("2026-08-20T00:00:01.000Z");
    expect(event?.tokens.estimated.estimatedInput.observedAt).toBe("2026-08-20T00:00:02.000Z");

    const invalid = createAccountingRequest({ idFactory: deterministic() }).startAttempt();
    expect(() => invalid.complete({
      outcome: "success",
      tokens: {
        reported: { inputTokens: 1, observedAt: "2026-08-20T00:00:01.000Z" },
        estimated: { inputTokens: 2, observedAt: "not-a-timestamp" },
      },
    })).toThrow(/observedAt/);
  });

  it("runtime-validates outcome/failure domains before mutating an attempt", () => {
    const events: AccountingEvent[] = [];
    const request = createAccountingRequest({ recorder: recorder(events), idFactory: deterministic() });
    const attempt = request.startAttempt();
    expect(() => attempt.complete({ outcome: "made-up" as never })).toThrow(/outcome/);
    expect(() => attempt.complete({ outcome: "error", failureKind: "made-up" as never })).toThrow(/failure kind/);
    expect(events.filter((event) => event.type === "attempt-completed")).toHaveLength(0);
    attempt.complete({ outcome: "error", failureKind: "unknown" });
    expect(() => request.complete({ outcome: "made-up" as never })).toThrow(/outcome/);
    expect(request.complete({ outcome: "error", failureKind: "unknown" })).toMatchObject({ outcome: "error", failureKind: "unknown" });
  });

  it("snapshots nested token and estimate-method inputs", () => {
    const request = createAccountingRequest({ idFactory: deterministic() });
    const attempt = request.startAttempt();
    const source = {
      reported: { inputTokens: 12, outputTokens: 4 },
      estimated: { inputTokens: 2, inputMethod: { kind: "chars/4", version: 1 } },
    } as unknown as TokenFactsInput;
    const event = attempt.complete({ outcome: "success", tokens: source });
    (source.reported as { inputTokens: number }).inputTokens = 999;
    (source.estimated as unknown as { inputMethod: { kind: string; version: number } }).inputMethod.kind = "changed";
    expect(event?.tokens.reported.reportedInput.value).toBe(12);
    expect(event?.tokens.estimated.estimatedInput.method).toBe('{"kind":"chars/4","version":1}');
    expect(Object.isFrozen(event?.tokens.reported.reportedInput)).toBe(true);
    expect(Object.isFrozen(event?.tokens.estimated.estimatedInput)).toBe(true);
  });

  it("refuses a method the day-shard LOADER would reject, instead of quarantining the shard later", () => {
    // The accept side must never be laxer than the load side. `isDashboardSafeId` bounds length
    // and bytes but permits C0/C1 control characters; the schema's `isSafeId` rejects them. A
    // method admitted here but refused on load would be merged into a cell, written to the day
    // shard, and then fail `parseAccountingDayShardV1` on the next read — quarantining the shard
    // and losing that day's ledger. Dropping one field now is strictly better than losing a day
    // later, so `methodSnapshot` admits through the LOADER's predicate.
    const request = createAccountingRequest({ idFactory: deterministic() });
    const attempt = request.startAttempt();
    const source = {
      estimated: { inputTokens: 2, inputMethod: "chars/4" },
    } as unknown as TokenFactsInput;
    const event = attempt.complete({ outcome: "success", tokens: source });
    // Dropped to the safe default rather than persisted — the control character never reaches the
    // shard, which is the whole point; what it degrades to is the pipeline's existing convention.
    const method = event?.tokens.estimated.estimatedInput.method;
    expect(method).not.toContain("");
    expect(method).toBe("unspecified");

    // ... and an ordinary method still lands, so this is a control-character rule, not a ban.
    const ok = createAccountingRequest({ idFactory: deterministic() }).startAttempt().complete({
      outcome: "success",
      tokens: { estimated: { inputTokens: 2, inputMethod: "relay_estimate" } } as unknown as TokenFactsInput,
    });
    expect(ok?.tokens.estimated.estimatedInput.method).toBe("relay_estimate");
  });

  it("isolates recorder getter and apply traps", () => {
    const getterTrap = new Proxy({}, { get: () => { throw new Error("getter down"); } }) as AccountingRecorder;
    expect(() => {
      const request = createAccountingRequest({ recorder: getterTrap, idFactory: deterministic() });
      request.complete({ outcome: "error" });
    }).not.toThrow();
    const applyTrap = new Proxy(() => undefined, { apply: () => { throw new Error("apply down"); } });
    const proxyRecorder = { record: applyTrap } as unknown as AccountingRecorder;
    expect(() => {
      const request = createAccountingRequest({ recorder: proxyRecorder, idFactory: deterministic() });
      request.complete({ outcome: "error" });
    }).not.toThrow();
  });
});
