/**
 * Pure contracts for the attempt lifecycle — the one kernel abstraction the relay
 * actually adopted.
 *
 * This module deliberately depends only on ECMAScript language types; wire adapters
 * must not leak Node, fetch, or feature-module types across this boundary
 * (test/kernel-architecture.test.ts enforces it).
 *
 * History note: this file once carried a much larger aspirational contract surface
 * (a canonical request IR, transport/credential/transcoder ports, attempt leases,
 * versioned view envelopes). None of it was ever implemented outside this
 * directory, and it was deleted rather than left as a second architecture for a
 * future maintainer to mistake for the intended one. The attempt lifecycle stayed
 * because it is load-bearing: CircuitBreaker implements `AttemptLifecyclePort`,
 * and the typed begin/complete handshake is what keeps both request paths from
 * drifting apart on breaker accounting again.
 */

export type TransitionResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type ProviderKind = "anthropic" | "openai";

/** The deployment identity used for attribution and lifecycle ownership. */
export interface ProviderTargetIdentity {
  readonly provider: string;
  readonly model: string | null;
  readonly kind: ProviderKind;
  /** Opaque configured credential-slot identity; never key material. */
  readonly credentialId: string;
  /** Optional routing metadata used by breaker policy; never part of target equality. */
  readonly base?: string;
}

/**
 * Target equality — the rule the type's own `base` comment states, in one place.
 *
 * ⚠ It lives beside the type rather than in either consumer because `circuit-breaker.ts` and
 * `kernel/request-lifecycle.ts` each held an identical private copy, and nothing in the type
 * system would have caught the two drifting: adding a field to `ProviderTargetIdentity` that ONE
 * copy compares makes the breaker and the lifecycle disagree about whether a handle belongs to the
 * attempt that issued it. Pure, so `test/kernel-architecture.test.ts` purity still holds.
 */
export function sameProviderTarget(a: ProviderTargetIdentity, b: ProviderTargetIdentity): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.kind === b.kind &&
    a.credentialId === b.credentialId
  );
}

declare const attemptHandleBrand: unique symbol;
declare const attemptIdBrand: unique symbol;

export type AttemptId = string & { readonly [attemptIdBrand]: true };

/** An opaque request-scoped health lifecycle handle. */
export interface AttemptHandle {
  readonly [attemptHandleBrand]: true;
}

export type OutcomeProvenance =
  | "upstream"
  | "invalid-upstream-envelope"
  | "relay-mapper-defect"
  | "client-cancellation"
  | "deadline";

interface AttemptOutcomeBase {
  readonly target: ProviderTargetIdentity;
  readonly provenance: OutcomeProvenance;
  readonly completedAt: number;
  readonly elapsedMs: number;
}

export interface AttemptSucceeded extends AttemptOutcomeBase {
  readonly terminal: "succeeded";
  readonly status: number;
}

export interface AttemptFailed extends AttemptOutcomeBase {
  readonly terminal: "failed";
  readonly failure: "http" | "transport" | "invalid-response" | "mapping" | "protocol";
  readonly status: number | null;
  readonly retryAfterMs: number | null;
}

/**
 * WHO abandoned a cancelled attempt, and on which side of the response commit.
 *
 * `reason` below is free text for a human reading a log. This is the closed vocabulary a POLICY may
 * branch on, and the two are not interchangeable: when a client disconnects mid-race the relay
 * retires the hedge with the reason string "hedge loser aborted" whatever the true cause, so a
 * discriminator read off that prose would misclassify exactly the case it exists to catch.
 *
 * - `client-gone-before-response` — the caller left and this deployment had committed NOTHING to it.
 *   The deployment produced no answer in the time it had.
 * - `client-gone-mid-response` — the caller left while this deployment's answer was already
 *   reaching it. The deployment was answering; the caller changed its mind.
 * - `relay-abandoned` — the RELAY aborted it (a hedge loser). It proves only that the relay stopped
 *   waiting, which is a statement about the relay's own policy, not about the deployment.
 */
export type AttemptCancellationCause =
  | "client-gone-before-response"
  | "client-gone-mid-response"
  | "relay-abandoned";

export interface AttemptCancelled extends AttemptOutcomeBase {
  readonly terminal: "cancelled";
  /** Required, so a new cancellation site must decide rather than inherit a default. */
  readonly cause: AttemptCancellationCause;
  readonly reason: string | null;
}

export type AttemptOutcome = AttemptSucceeded | AttemptFailed | AttemptCancelled;

export interface AttemptBeginFailure {
  readonly kind: "lifecycle-closed";
}

export type AttemptCompletionFailure =
  | { readonly kind: "duplicate-completion"; readonly id: AttemptId }
  | { readonly kind: "foreign-handle" }
  | { readonly kind: "stale-handle" }
  | {
      readonly kind: "cross-target";
      readonly expected: ProviderTargetIdentity;
      readonly received: ProviderTargetIdentity;
    };

export interface CompletedAttempt {
  readonly id: AttemptId;
  readonly target: ProviderTargetIdentity;
  readonly outcome: AttemptOutcome;
}

export interface AttemptLifecyclePort {
  beginAttempt(target: ProviderTargetIdentity): TransitionResult<AttemptHandle, AttemptBeginFailure>;
  completeAttempt(
    handle: AttemptHandle,
    outcome: AttemptOutcome,
  ): TransitionResult<CompletedAttempt, AttemptCompletionFailure>;
}
