/**
 * Pure contracts shared by relay features.
 *
 * This module deliberately depends only on ECMAScript language types.  In
 * particular, wire adapters must not leak Node, fetch, or feature-module types
 * across this boundary.
 */

export const CONTRACT_KERNEL_VERSION = "llm-relay/kernel/v1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type TransitionResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type ProviderKind = "anthropic" | "openai";

/** The deployment identity used for attribution and lifecycle ownership. */
export interface ProviderTargetIdentity {
  readonly provider: string;
  readonly model: string | null;
  readonly kind: ProviderKind;
}

export type CredentialMode = "passthrough" | "managed";
export type CredentialState = "not-declared" | "declared-missing" | "declared-present";

export interface CanonicalHeader {
  readonly name: string;
  readonly value: string;
}

export interface CredentialHeaders {
  readonly mode: CredentialMode;
  readonly state: CredentialState;
  readonly headers: readonly CanonicalHeader[];
}

export interface CredentialHeaderFailure {
  readonly kind: "credential-unavailable" | "invalid-header-configuration";
  readonly state: CredentialState;
}

/** Adapter-owned access to credentials and their single outbound header site. */
export interface CredentialHeaderPort {
  resolve(target: ProviderTargetIdentity): TransitionResult<CredentialHeaders, CredentialHeaderFailure>;
}

export interface CanonicalTextContent {
  readonly kind: "text";
  readonly text: string;
}

export interface CanonicalImageContent {
  readonly kind: "image";
  readonly mediaType: string;
  readonly data: Uint8Array;
}

export interface CanonicalDocument {
  readonly mediaType: string;
  readonly data: Uint8Array;
  readonly title?: string;
}

export interface CanonicalDocumentContent {
  readonly kind: "document";
  readonly document: CanonicalDocument;
}

export interface CanonicalToolCallContent {
  readonly kind: "tool-call";
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

export interface CanonicalToolResultContent {
  readonly kind: "tool-result";
  readonly toolCallId: string;
  readonly content: readonly (CanonicalTextContent | CanonicalImageContent)[];
  readonly isError: boolean;
}

export type CanonicalContent =
  | CanonicalTextContent
  | CanonicalImageContent
  | CanonicalDocumentContent
  | CanonicalToolCallContent
  | CanonicalToolResultContent;

export interface CanonicalMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: readonly CanonicalContent[];
}

export interface CanonicalTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
}

export interface CanonicalRequest {
  readonly model: string;
  readonly messages: readonly CanonicalMessage[];
  readonly tools: readonly CanonicalTool[];
  readonly maxOutputTokens: number;
  readonly stream: boolean;
}

export interface DocumentTranscodeFailure {
  readonly kind: "unsupported-document" | "invalid-document" | "transcode-failed";
  readonly message: string;
}

export interface DocumentTranscoder {
  transcode(
    document: CanonicalDocument,
  ): Promise<TransitionResult<CanonicalTextContent, DocumentTranscodeFailure>>;
}

export type RequestedCapability = "text" | "image" | "document" | "tools" | "streaming";

export interface CapabilityRequest {
  readonly target: ProviderTargetIdentity;
  readonly capabilities: readonly RequestedCapability[];
  readonly tokens: RequestTokenEstimate;
}

/** A single-source estimate; `exact: false` must never be presented as measured usage. */
export interface RequestTokenEstimate {
  readonly inputTokens: number;
  readonly reservedOutputTokens: number;
  readonly totalTokens: number;
  readonly exact: boolean;
}

export interface CancellationSignal {
  isCancelled(): boolean;
  reason(): string | undefined;
}

declare const attemptLeaseBrand: unique symbol;
declare const spentAttemptLeaseBrand: unique symbol;
declare const attemptHandleBrand: unique symbol;
declare const attemptIdBrand: unique symbol;

export type AttemptId = string & { readonly [attemptIdBrand]: true };

export interface AttemptLeaseView {
  readonly ordinal: number;
  readonly acquiredAt: number;
  readonly deadline: number;
  readonly spent: boolean;
}

export interface LeaseSpentFailure {
  readonly kind: "lease-spent";
  readonly ordinal: number;
}

/** A budget-issued, one-shot authority to start one egress attempt. */
export interface AttemptLease {
  readonly [attemptLeaseBrand]: true;
  readonly ordinal: number;
  readonly acquiredAt: number;
  readonly deadline: number;
  spend(): TransitionResult<SpentAttemptLease, LeaseSpentFailure>;
  view(): AttemptLeaseView;
}

/** Proof that a lease has been consumed; it has no public constructor. */
export interface SpentAttemptLease {
  readonly [spentAttemptLeaseBrand]: true;
  readonly ordinal: number;
  readonly acquiredAt: number;
  readonly deadline: number;
}

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

export interface ProviderTransportRequest {
  readonly target: ProviderTargetIdentity;
  readonly request: CanonicalRequest;
  readonly headers: readonly CanonicalHeader[];
  readonly lease: SpentAttemptLease;
  readonly attempt: AttemptHandle;
  readonly cancellation: CancellationSignal;
}

export type CanonicalResponseEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool-call"; readonly call: CanonicalToolCallContent }
  | { readonly kind: "completed"; readonly stopReason: string };

export interface CanonicalResponse {
  readonly status: number;
  readonly message: CanonicalMessage;
  readonly stopReason: string;
}

export type ProviderTransportResult =
  | {
      readonly kind: "buffered";
      readonly target: ProviderTargetIdentity;
      readonly attempt: AttemptHandle;
      readonly response: CanonicalResponse;
    }
  | {
      readonly kind: "stream";
      readonly target: ProviderTargetIdentity;
      readonly attempt: AttemptHandle;
      readonly events: AsyncIterable<CanonicalResponseEvent>;
    };

export interface ProviderTransportFailure {
  readonly kind: "unavailable" | "cancelled" | "deadline" | "transport" | "invalid-response";
  readonly target: ProviderTargetIdentity;
  readonly attempt: AttemptHandle;
  readonly provenance: OutcomeProvenance;
  readonly status: number | null;
}

export interface ProviderTransport {
  execute(
    request: ProviderTransportRequest,
  ): Promise<TransitionResult<ProviderTransportResult, ProviderTransportFailure>>;
}

/** Stable envelope for public projections whose schema evolves independently. */
export interface VersionedView<Name extends string, Version extends string, Data> {
  readonly contractVersion: typeof CONTRACT_KERNEL_VERSION;
  readonly view: Name;
  readonly version: Version;
  readonly generatedAt: string;
  readonly data: Data;
}
