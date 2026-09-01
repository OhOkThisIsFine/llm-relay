import { expect } from "vitest";
import {
  createAccountingRequest,
  type AccountingEvent,
  type AccountingPricePort,
  type AccountingRecorder,
  type RequestCompletedEvent,
  type TokenFactsInput,
} from "../../src/accounting.js";
import type { AccountingStore } from "../../src/accounting-store.js";

/** Published/reported price port: $2/M in, $4/M out. */
export const PORT_PUBLISHED: AccountingPricePort = () => ({
  pricePerMillionIn: 2,
  pricePerMillionOut: 4,
  priceSource: "provider",
});

/** Reference/in-only price port: $1/M in, no output price (partial coverage). */
export const PORT_REFERENCE: AccountingPricePort = () => ({
  pricePerMillionIn: 1,
  pricePerMillionOut: null,
  priceSource: "reference",
});

export function emptyAggregateTokenCell() {
  return { value: null, known: 0, unknown: 0, lost: 0, overflow: false, observedAt: null };
}

export function emptyAggregateTokens() {
  return {
    reported: {
      reportedInput: emptyAggregateTokenCell(),
      reportedOutput: emptyAggregateTokenCell(),
      reportedCachedInput: emptyAggregateTokenCell(),
      cacheCreationInputTokens: emptyAggregateTokenCell(),
      cacheReadInputTokens: emptyAggregateTokenCell(),
    },
    estimated: {
      estimatedInput: { ...emptyAggregateTokenCell(), method: null },
      estimatedOutput: { ...emptyAggregateTokenCell(), method: null },
    },
  };
}

export function emptyMetric() {
  return {
    sumMs: null,
    known: 0,
    unknown: 0,
    lost: 0,
    overflow: false,
    samples: [],
    samplesDropped: 0,
    observedAt: null,
  };
}

/** A minute cell in the LEGACY pre-spend shape (`spend: null`, no requestSpend). */
export function legacyMinuteCell() {
  return {
    schema: "accounting.minute.v1",
    version: 1,
    date: "2026-08-19",
    minute: "10:00",
    from: "2026-08-19T10:00:00.000Z",
    to: "2026-08-19T10:01:00.000Z",
    aggregate: {
      requests: 1,
      attempts: 0,
      served: 1,
      errored: 0,
      cancelled: 0,
      tokens: emptyAggregateTokens(),
      requestTokens: emptyAggregateTokens(),
      latency: emptyMetric(),
      commit: emptyMetric(),
      spend: null,
      unpricedRequests: 1,
    },
    rows: [],
    coverage: { state: "complete", reason: null, droppedRows: 0, losses: [] },
  };
}

let requestSequence = 0;
let attemptSequence = 0;

export function resetFixtureSequences(): void {
  requestSequence = 0;
  attemptSequence = 0;
}

export function requestId(): string {
  return `request-${(++requestSequence).toString().padStart(16, "0")}`;
}

export function attemptId(): string {
  return `attempt-${(++attemptSequence).toString().padStart(12, "0")}`;
}

export type Outcome = "success" | "error" | "cancelled" | "unknown";
export type Attribution = "relay_held" | "caller_operated" | "unknown";
export type FailureKind = "timeout" | "provider_error" | "auth_error" | "rate_limit" | "aborted" | "protocol" | "unknown" | null;

export interface AttemptPlan {
  readonly role?: "serve" | "repair";
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly outcome?: Outcome;
  readonly failureKind?: FailureKind;
  readonly attribution?: Attribution;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly credentialId?: string | null;
  readonly tokens?: TokenFactsInput | null;
  readonly latencyMs?: number | null;
  readonly commitMs?: number;
  /** The relay abandoned this attempt — a hedge loser (D3). Stated, never inferred. */
  readonly abandonedByRelay?: boolean;
}

export interface RequestPlan {
  readonly requestId?: string;
  /** Published-price lookup for the lifecycle; absent => unpriced. */
  readonly pricePort?: AccountingPricePort | undefined;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly client?: string | null;
  readonly attribution?: Attribution;
  readonly outcome?: Outcome;
  readonly failureKind?: FailureKind;
  readonly attempts?: readonly AttemptPlan[];
  readonly latencyMs?: number | null;
}

export interface RecordedRequest {
  readonly requestId: string;
  readonly attemptIds: readonly string[];
  readonly events: readonly AccountingEvent[];
  readonly terminal: RequestCompletedEvent;
}

export function recordRequest(store: AccountingStore, plan: RequestPlan): RecordedRequest {
  const events: AccountingEvent[] = [];
  const recorder: AccountingRecorder = {
    record(event) {
      events.push(event);
      store.record(event);
    },
  };
  const id = plan.requestId ?? requestId();
  const attribution = plan.attribution ?? "relay_held";
  const request = createAccountingRequest({
    recorder,
    idFactory: attemptId,
    requestId: id,
    startedAt: plan.startedAt,
    client: plan.client ?? "claude",
    attribution,
    pricePort: plan.pricePort,
  });
  const attemptIds: string[] = [];
  for (const attemptPlan of plan.attempts ?? []) {
    const role = attemptPlan.role ?? "serve";
    const attempt = request.startAttempt({
      role,
      startedAt: attemptPlan.startedAt ?? plan.startedAt,
      attribution: attemptPlan.attribution ?? attribution,
      provider: attemptPlan.provider ?? null,
      model: attemptPlan.model ?? null,
      credentialId: attemptPlan.credentialId ?? null,
    });
    attemptIds.push(attempt.attemptId);
    if (attemptPlan.commitMs !== undefined) {
      expect(attempt.markCommitted({ commitMs: attemptPlan.commitMs })).toBe(true);
    }
    const outcome = attemptPlan.outcome ?? "error";
    const completed = attempt.complete({
      outcome,
      ...(outcome === "success" ? {} : { failureKind: attemptPlan.failureKind ?? "provider_error" }),
      endedAt: attemptPlan.endedAt ?? plan.endedAt,
      latencyMs: attemptPlan.latencyMs ?? 10,
      ...(attemptPlan.tokens === undefined ? {} : { tokens: attemptPlan.tokens }),
      ...(attemptPlan.abandonedByRelay === undefined ? {} : { abandonedByRelay: attemptPlan.abandonedByRelay }),
    });
    if (completed === undefined) throw new Error("attempt completion was unexpectedly absent");
  }
  const terminal = request.complete({
    endedAt: plan.endedAt,
    ...(plan.outcome === undefined ? {} : { outcome: plan.outcome }),
    ...(plan.failureKind === undefined ? {} : { failureKind: plan.failureKind }),
    ...(plan.latencyMs === undefined ? {} : { latencyMs: plan.latencyMs }),
  });
  if (terminal === undefined) throw new Error("request completion was unexpectedly absent");
  return { requestId: id, attemptIds, events, terminal };
}
