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

export interface AttemptCancelled extends AttemptOutcomeBase {
  readonly terminal: "cancelled";
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
