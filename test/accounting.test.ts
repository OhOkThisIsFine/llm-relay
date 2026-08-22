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
  type AccountingRecorder,
  type TokenFactsInput,
} from "../src/accounting.js";

function deterministic(ids = ["request-id-123456", "attempt-id-123456", "attempt-id-234567"]): () => string {
  let index = 0;
  return () => ids[index++] ?? `generated-id-${index.toString().padStart(14, "0")}`;
}

function recorder(events: AccountingEvent[]): AccountingRecorder {
  return { record: (event) => events.push(event) };
}

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
