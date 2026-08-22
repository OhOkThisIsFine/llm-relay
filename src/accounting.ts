import { randomBytes } from "node:crypto";
import {
  DASHBOARD_REQUEST_ID_PATTERN,
  isDashboardFailureKind,
  isDashboardOutcome,
  isDashboardSafeId,
  isDashboardUtcTimestamp,
  type AttemptRole,
  type Attribution,
  type FailureKind,
  type Outcome,
  type TokenTotalsV1,
} from "./dashboard-contract.js";

/** Explicit provenance for estimates whose method was omitted or unusable. */
export const ACCOUNTING_UNSPECIFIED_ESTIMATION_METHOD = "unspecified";

export type AccountingRequestId = string;
export type AccountingAttemptId = string;

export interface ReportedTokenFactsInput {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  /** The contract spelling is accepted as well as the observer spelling. */
  reportedInput?: number | null;
  reportedOutput?: number | null;
  reportedCachedInput?: number | null;
  observedAt?: string | null;
}

export interface EstimatedTokenFactsInput {
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedInput?: number | null;
  estimatedOutput?: number | null;
  inputMethod?: string | null;
  outputMethod?: string | null;
  observedAt?: string | null;
}

export interface TokenFactsInput {
  reported?: ReportedTokenFactsInput | null;
  estimated?: EstimatedTokenFactsInput | null;
  /** Direct fields make it safe to pass a UsageAccumulator snapshot. */
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  estimatedInputTokens?: number | null;
  estimatedOutputTokens?: number | null;
  estimatedInputMethod?: string | null;
  estimatedOutputMethod?: string | null;
  observedAt?: string | null;
}

/** Token totals with the two Anthropic cache facts kept as first-class facts. */
export type AccountingTokenTotals = TokenTotalsV1 & {
  readonly reported: TokenTotalsV1["reported"] & {
    readonly cacheCreationInputTokens: TokenTotalsV1["reported"]["reportedCachedInput"];
    readonly cacheReadInputTokens: TokenTotalsV1["reported"]["reportedCachedInput"];
  };
};

export interface AccountingRecorderEventBase {
  readonly requestId: AccountingRequestId;
}

export interface RequestStartedEvent extends AccountingRecorderEventBase {
  readonly type: "request-started";
  readonly startedAt: string;
  readonly client: string | null;
  readonly attribution: Attribution;
  readonly provider: string | null;
  readonly model: string | null;
  readonly credentialId: string | null;
}

export interface AttemptStartedEvent extends AccountingRecorderEventBase {
  readonly type: "attempt-started";
  readonly attemptId: AccountingAttemptId;
  readonly role: AttemptRole;
  readonly startedAt: string;
  readonly attribution: Attribution;
  readonly provider: string | null;
  readonly model: string | null;
  readonly credentialId: string | null;
}

export interface AttemptCompletedEvent extends AccountingRecorderEventBase {
  readonly type: "attempt-completed";
  readonly attemptId: AccountingAttemptId;
  readonly role: AttemptRole;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: Outcome;
  readonly failureKind: FailureKind | null;
  readonly attribution: Attribution;
  readonly latencyMs: number | null;
  readonly commitMs: number | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly credentialId: string | null;
  readonly tokens: AccountingTokenTotals;
  /** Pricing is deliberately not part of this packet. */
  readonly spend: null;
}

export interface RequestCompletedEvent extends AccountingRecorderEventBase {
  readonly type: "request-completed";
  readonly endedAt: string;
  readonly outcome: Outcome;
  readonly failureKind: FailureKind | null;
  readonly attribution: Attribution;
  readonly attemptCount: number;
  readonly repairIncluded: boolean;
  readonly winningAttemptId: AccountingAttemptId | null;
  readonly commitAttemptId: AccountingAttemptId | null;
  readonly latencyMs: number | null;
  readonly commitMs: number | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly credentialId: string | null;
  /** Only the winning serve attempt is projected here; repair is separate. */
  readonly tokens: AccountingTokenTotals;
  readonly spend: null;
}

export type AccountingEvent =
  | RequestStartedEvent
  | AttemptStartedEvent
  | AttemptCompletedEvent
  | RequestCompletedEvent;

export interface AccountingRecorder {
  record(event: AccountingEvent): void;
}

/** A recorder suitable as the default when no read model is mounted. */
export const NOOP_ACCOUNTING_RECORDER: AccountingRecorder = Object.freeze({
  record: () => undefined,
});

export type AccountingClockValue = number | Date | string;
export type AccountingClock = (() => AccountingClockValue) | { now(): AccountingClockValue };
export type AccountingIdFactory = () => string;

export interface AccountingRequestOptions {
  recorder?: AccountingRecorder;
  clock?: AccountingClock;
  idFactory?: AccountingIdFactory;
  requestId?: string;
  startedAt?: AccountingClockValue;
  client?: string | null;
  attribution?: Attribution;
  provider?: string | null;
  model?: string | null;
  credentialId?: string | null;
}

export interface AttemptStartOptions {
  role?: AttemptRole;
  startedAt?: AccountingClockValue;
  attribution?: Attribution;
  provider?: string | null;
  model?: string | null;
  credentialId?: string | null;
}

export interface AttemptCompletionOptions {
  outcome: Outcome;
  failureKind?: FailureKind | null;
  endedAt?: AccountingClockValue;
  latencyMs?: number | null;
  commitMs?: number | null;
  tokens?: TokenFactsInput | null;
}

export interface RequestCompletionOptions {
  outcome?: Outcome;
  failureKind?: FailureKind | null;
  attribution?: Attribution;
  endedAt?: AccountingClockValue;
  latencyMs?: number | null;
  commitMs?: number | null;
  winningAttemptId?: AccountingAttemptId | null;
}

export interface CommitOptions {
  at?: AccountingClockValue;
  commitMs?: number | null;
}

export interface AccountingAttempt {
  readonly requestId: AccountingRequestId;
  readonly attemptId: AccountingAttemptId;
  readonly role: AttemptRole;
  readonly startedAt: string;
  readonly attribution: Attribution;
  complete(options: AttemptCompletionOptions): AttemptCompletedEvent | undefined;
  markCommitted(options?: CommitOptions): boolean;
}

export interface AccountingRequest {
  readonly requestId: AccountingRequestId;
  readonly startedAt: string;
  startAttempt(options?: AttemptStartOptions): AccountingAttempt;
  complete(options?: RequestCompletionOptions): RequestCompletedEvent | undefined;
  markCommitted(attemptId: AccountingAttemptId, options?: CommitOptions): boolean;
  readonly completed: boolean;
}

interface AttemptState {
  readonly attemptId: AccountingAttemptId;
  readonly role: AttemptRole;
  readonly startedAt: string;
  readonly attribution: Attribution;
  readonly provider: string | null;
  readonly model: string | null;
  readonly credentialId: string | null;
  completed: AttemptCompletedEvent | undefined;
  committed: boolean;
  commitMs: number | null;
}

interface InternalOptions {
  readonly recorder: AccountingRecorder;
  readonly clock: AccountingClock;
  readonly idFactory: AccountingIdFactory;
}

function now(clock: AccountingClock): AccountingClockValue {
  return typeof clock === "function" ? clock() : clock.now();
}

function timestamp(value: AccountingClockValue): string {
  if (typeof value === "string") {
    if (!isDashboardUtcTimestamp(value)) throw new TypeError("Accounting timestamp must be a canonical UTC timestamp.");
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  throw new TypeError("Accounting timestamp must be an RFC3339 string, Date, or finite epoch number.");
}

function validInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateOutcome(value: unknown): asserts value is Outcome {
  if (!isDashboardOutcome(value)) throw new TypeError("Invalid accounting outcome.");
}

function validateFailureKind(value: unknown): asserts value is FailureKind | null {
  if (value !== null && !isDashboardFailureKind(value)) throw new TypeError("Invalid accounting failure kind.");
}

function validateAttribution(value: unknown): asserts value is Attribution {
  if (value !== "relay_held" && value !== "caller_operated" && value !== "unknown") {
    throw new TypeError("Invalid accounting attribution.");
  }
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : validInteger(value) ? value : null;
}

function nullableLatency(value: unknown): number | null {
  return nullableInteger(value);
}

function methodSnapshot(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return isDashboardSafeId(value) ? value : null;
  try {
    const serialized = JSON.stringify(value);
    return isDashboardSafeId(serialized) ? serialized : null;
  } catch {
    return null;
  }
}

function definedOr<T>(preferred: T | undefined, fallback: T | undefined): T | undefined {
  return preferred === undefined ? fallback : preferred;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}

function safeRecord(recorder: AccountingRecorder, event: AccountingEvent): void {
  try {
    recorder.record(event);
  } catch {
    // A metrics sink is never allowed to affect the request path.
  }
}

function makeId(factory: AccountingIdFactory, used: Set<string>): string {
  for (let i = 0; i < 128; i += 1) {
    const candidate = factory();
    if (typeof candidate === "string" && DASHBOARD_REQUEST_ID_PATTERN.test(candidate) && !used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error("Accounting ID factory did not produce a unique valid ID.");
}

function randomId(): string {
  return randomBytes(24).toString("base64url");
}

function normalizeTokens(input: TokenFactsInput | null | undefined, observedAt: string): AccountingTokenTotals {
  const source = input ?? {};
  const reported: ReportedTokenFactsInput = source.reported ?? {
    inputTokens: source.inputTokens,
    outputTokens: source.outputTokens,
    cachedInputTokens: source.cachedInputTokens,
    cacheCreationInputTokens: source.cacheCreationInputTokens,
    cacheReadInputTokens: source.cacheReadInputTokens,
  } as ReportedTokenFactsInput;
  const estimated: EstimatedTokenFactsInput = source.estimated ?? {
    inputTokens: source.estimatedInputTokens,
    outputTokens: source.estimatedOutputTokens,
    inputMethod: source.estimatedInputMethod,
    outputMethod: source.estimatedOutputMethod,
  } as EstimatedTokenFactsInput;
  const reportedInput = nullableInteger(definedOr(reported.reportedInput, reported.inputTokens));
  const reportedOutput = nullableInteger(definedOr(reported.reportedOutput, reported.outputTokens));
  const reportedCached = nullableInteger(definedOr(reported.reportedCachedInput, reported.cachedInputTokens));
  const cacheCreation = nullableInteger(
    reported.cacheCreationInputTokens !== undefined ? reported.cacheCreationInputTokens : source.cacheCreationInputTokens,
  );
  const cacheRead = nullableInteger(
    reported.cacheReadInputTokens !== undefined ? reported.cacheReadInputTokens : source.cacheReadInputTokens,
  );
  // Anthropic's cache creation/read facts remain distinct from OpenAI's cached
  // input fact. They are never summed or used to populate that aggregate.
  const cached = reportedCached;
  const estimatedInput = nullableInteger(
    definedOr(estimated.estimatedInput, definedOr(estimated.inputTokens, source.estimatedInputTokens)),
  );
  const estimatedOutput = nullableInteger(
    definedOr(estimated.estimatedOutput, definedOr(estimated.outputTokens, source.estimatedOutputTokens)),
  );
  const estimatedInputMethod = methodSnapshot(definedOr(estimated.inputMethod, source.estimatedInputMethod));
  const estimatedOutputMethod = methodSnapshot(definedOr(estimated.outputMethod, source.estimatedOutputMethod));
  const reportedObserved = reported.observedAt !== undefined
    ? reported.observedAt
    : source.observedAt !== undefined
      ? source.observedAt
      : observedAt;
  const estimatedObserved = estimated.observedAt !== undefined
    ? estimated.observedAt
    : source.observedAt !== undefined
      ? source.observedAt
      : observedAt;
  for (const observed of [reportedObserved, estimatedObserved]) {
    if (observed !== null && !isDashboardUtcTimestamp(observed)) {
      throw new TypeError("Accounting observedAt must be a canonical UTC timestamp or null.");
    }
  }
  const result: AccountingTokenTotals = {
    reported: {
      reportedInput: { value: reportedInput, source: "provider_reported", observedAt: reportedInput === null ? null : reportedObserved },
      reportedOutput: { value: reportedOutput, source: "provider_reported", observedAt: reportedOutput === null ? null : reportedObserved },
      reportedCachedInput: { value: cached, source: "provider_reported", observedAt: cached === null ? null : reportedObserved },
      cacheCreationInputTokens: { value: cacheCreation, source: "provider_reported", observedAt: cacheCreation === null ? null : reportedObserved },
      cacheReadInputTokens: { value: cacheRead, source: "provider_reported", observedAt: cacheRead === null ? null : reportedObserved },
    },
    estimated: {
      estimatedInput: {
        value: estimatedInput,
        source: "relay_estimated",
        observedAt: estimatedInput === null ? null : estimatedObserved,
        method: estimatedInput === null ? null : estimatedInputMethod ?? ACCOUNTING_UNSPECIFIED_ESTIMATION_METHOD,
      },
      estimatedOutput: {
        value: estimatedOutput,
        source: "relay_estimated",
        observedAt: estimatedOutput === null ? null : estimatedObserved,
        method: estimatedOutput === null ? null : estimatedOutputMethod ?? ACCOUNTING_UNSPECIFIED_ESTIMATION_METHOD,
      },
    },
  };
  return freezeDeep(result);
}

function deriveLatency(startedAt: string, endedAt: string, supplied: number | null | undefined): number | null {
  if (supplied !== undefined) return nullableLatency(supplied);
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function deriveCommitMs(startedAt: string, endedAt: string): number | null {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const result = end - start;
  return validInteger(result) ? result : null;
}

class AccountingRequestLifecycle implements AccountingRequest {
  readonly requestId: AccountingRequestId;
  readonly startedAt: string;
  private readonly options: InternalOptions;
  private readonly client: string | null;
  private readonly attribution: Attribution;
  private readonly provider: string | null;
  private readonly model: string | null;
  private readonly credentialId: string | null;
  private readonly attempts = new Map<string, AttemptState>();
  private readonly usedIds: Set<string>;
  private requestCompleted: RequestCompletedEvent | undefined;
  private requestCommitAttemptId: AccountingAttemptId | null = null;
  private requestCommitMs: number | null = null;

  constructor(options: AccountingRequestOptions = {}) {
    this.options = {
      recorder: options.recorder ?? NOOP_ACCOUNTING_RECORDER,
      clock: options.clock ?? (() => Date.now()),
      idFactory: options.idFactory ?? randomId,
    };
    this.usedIds = new Set<string>();
    this.requestId = options.requestId ?? makeId(this.options.idFactory, this.usedIds);
    if (!DASHBOARD_REQUEST_ID_PATTERN.test(this.requestId)) throw new TypeError("Invalid accounting request ID.");
    this.usedIds.add(this.requestId);
    this.startedAt = timestamp(options.startedAt ?? now(this.options.clock));
    this.client = options.client ?? null;
    this.attribution = options.attribution === undefined ? "unknown" : options.attribution;
    validateAttribution(this.attribution);
    this.provider = options.provider ?? null;
    this.model = options.model ?? null;
    this.credentialId = options.credentialId ?? null;
    const event = freezeDeep({
      type: "request-started" as const,
      requestId: this.requestId,
      startedAt: this.startedAt,
      client: this.client,
      attribution: this.attribution,
      provider: this.provider,
      model: this.model,
      credentialId: this.credentialId,
    });
    safeRecord(this.options.recorder, event);
  }

  get completed(): boolean { return this.requestCompleted !== undefined; }

  startAttempt(options: AttemptStartOptions = {}): AccountingAttempt {
    if (this.requestCompleted) throw new Error("Cannot start an attempt after request completion.");
    const role = options.role ?? "serve";
    if (role !== "serve" && role !== "repair") throw new TypeError("Invalid accounting attempt role.");
    const attribution = options.attribution === undefined ? this.attribution : options.attribution;
    validateAttribution(attribution);
    const attemptId = makeId(this.options.idFactory, this.usedIds);
    const startedAt = timestamp(options.startedAt ?? now(this.options.clock));
    const state: AttemptState = {
      attemptId,
      role,
      startedAt,
      attribution,
      provider: options.provider ?? null,
      model: options.model ?? null,
      credentialId: options.credentialId ?? null,
      completed: undefined,
      committed: false,
      commitMs: null,
    };
    this.attempts.set(attemptId, state);
    const event = freezeDeep({
      type: "attempt-started" as const,
      requestId: this.requestId,
      attemptId,
      role,
      startedAt,
      attribution: state.attribution,
      provider: state.provider,
      model: state.model,
      credentialId: state.credentialId,
    });
    safeRecord(this.options.recorder, event);
    return {
      requestId: this.requestId,
      attemptId,
      role,
      startedAt,
      attribution: state.attribution,
      complete: (completion) => this.completeAttempt(state, completion),
      markCommitted: (commit) => this.markAttemptCommitted(state, commit),
    };
  }

  markCommitted(attemptId: AccountingAttemptId, options?: CommitOptions): boolean {
    const state = this.attempts.get(attemptId);
    if (!state) throw new Error("Unknown accounting attempt.");
    return this.markAttemptCommitted(state, options);
  }

  private markAttemptCommitted(state: AttemptState, options: CommitOptions = {}): boolean {
    if (state.completed || state.role !== "serve" || state.committed || this.requestCommitAttemptId !== null) return false;
    let commitMs: number | null;
    try {
      // Validate an explicitly supplied timestamp even when a direct latency
      // is supplied; invalid input must never be allowed into an event.
      const explicitAt = options.at === undefined ? undefined : timestamp(options.at);
      if (options.commitMs !== undefined) {
        if (!validInteger(options.commitMs)) return false;
        commitMs = options.commitMs;
      } else {
        const at = explicitAt ?? timestamp(now(this.options.clock));
        commitMs = deriveCommitMs(state.startedAt, at);
      }
    } catch {
      return false;
    }
    if (commitMs === null) return false;
    state.committed = true;
    state.commitMs = commitMs;
    this.requestCommitAttemptId = state.attemptId;
    this.requestCommitMs = commitMs;
    return true;
  }

  private completeAttempt(state: AttemptState, completion: AttemptCompletionOptions): AttemptCompletedEvent | undefined {
    if (state.completed) return state.completed;
    if (this.requestCompleted) throw new Error("Cannot complete an attempt after request completion.");
    validateOutcome(completion.outcome);
    const failureKind = completion.failureKind === undefined ? null : completion.failureKind;
    validateFailureKind(failureKind);
    if (completion.outcome === "success" && failureKind !== null) {
      throw new Error("A successful accounting attempt cannot carry a failure kind.");
    }
    const endedAt = timestamp(completion.endedAt ?? now(this.options.clock));
    const tokens = normalizeTokens(completion.tokens, endedAt);
    if (completion.commitMs !== undefined && state.role === "serve" && !state.committed && this.requestCommitAttemptId === null) {
      // A direct completion commit is equivalent to a marker supplied at the
      // end of the attempt, but invalid values never latch.
      if (validInteger(completion.commitMs)) {
        state.committed = true;
        state.commitMs = completion.commitMs;
        this.requestCommitAttemptId = state.attemptId;
        this.requestCommitMs = completion.commitMs;
      }
    }
    const event = freezeDeep({
      type: "attempt-completed" as const,
      requestId: this.requestId,
      attemptId: state.attemptId,
      role: state.role,
      startedAt: state.startedAt,
      endedAt,
      outcome: completion.outcome,
      failureKind,
      attribution: state.attribution,
      latencyMs: deriveLatency(state.startedAt, endedAt, completion.latencyMs),
      commitMs: state.commitMs,
      provider: state.provider,
      model: state.model,
      credentialId: state.credentialId,
      tokens,
      spend: null,
    });
    state.completed = event;
    safeRecord(this.options.recorder, event);
    return event;
  }

  complete(completion: RequestCompletionOptions = {}): RequestCompletedEvent | undefined {
    if (this.requestCompleted) return this.requestCompleted;
    for (const attempt of this.attempts.values()) {
      if (!attempt.completed) throw new Error("Cannot complete request while an attempt is active.");
    }
    const endedAt = timestamp(completion.endedAt ?? now(this.options.clock));
    const successfulServes = [...this.attempts.values()].filter(
      (attempt) => attempt.role === "serve" && attempt.completed?.outcome === "success",
    );
    const hasWinningAttemptId = Object.prototype.hasOwnProperty.call(completion, "winningAttemptId");
    const hasExplicitWinner = hasWinningAttemptId
      && completion.winningAttemptId !== null
      && completion.winningAttemptId !== undefined;
    const commitWinner = this.requestCommitAttemptId === null
      ? undefined
      : this.attempts.get(this.requestCommitAttemptId);
    const explicitWinner = hasExplicitWinner ? this.attempts.get(completion.winningAttemptId as string) : undefined;
    if (hasExplicitWinner && !explicitWinner) {
      throw new Error("Winning attempt must be a completed successful serve attempt.");
    }
    if (explicitWinner && commitWinner && explicitWinner.attemptId !== commitWinner.attemptId) {
      throw new Error("Winning attempt must match the already committed serve attempt.");
    }
    if (
      explicitWinner
      && explicitWinner !== commitWinner
      && (explicitWinner.role !== "serve" || explicitWinner.completed?.outcome !== "success")
    ) {
      throw new Error("Winning attempt must be a completed successful serve attempt.");
    }
    const winner = commitWinner
      ?? explicitWinner
      ?? (hasWinningAttemptId ? undefined : successfulServes[0]);
    const explicitAttribution = completion.attribution === undefined
      ? undefined
      : completion.attribution;
    if (explicitAttribution !== undefined) validateAttribution(explicitAttribution);
    if (winner && explicitAttribution !== undefined && explicitAttribution !== winner.attribution) {
      throw new Error("Completion attribution conflicts with winning serve attribution.");
    }
    const terminalAttribution = winner?.attribution ?? explicitAttribution ?? this.attribution;
    const outcome = completion.outcome !== undefined
      ? completion.outcome
      : winner?.completed?.outcome;
    if (outcome === undefined) {
      throw new Error("Request outcome is required when no successful serve exists.");
    }
    validateOutcome(outcome);
    const suppliedFailureKind = completion.failureKind === undefined ? null : completion.failureKind;
    validateFailureKind(suppliedFailureKind);
    if (outcome === "success" && suppliedFailureKind !== null) {
      throw new Error("A successful accounting request cannot carry a failure kind.");
    }
    if (winner && outcome !== "success" && (winner !== commitWinner || winner.completed?.outcome !== outcome)) {
      throw new Error("A non-successful request cannot identify a winning serve attempt.");
    }
    if (!winner && outcome === "success") {
      throw new Error("A successful request requires a completed successful serve attempt.");
    }
    const tokens = winner?.completed?.tokens ?? normalizeTokens(null, endedAt);
    if (completion.commitMs !== undefined && winner && this.requestCommitAttemptId === null && validInteger(completion.commitMs)) {
      winner.committed = true;
      winner.commitMs = completion.commitMs;
      this.requestCommitAttemptId = winner.attemptId;
      this.requestCommitMs = completion.commitMs;
    }
    const failureKind = suppliedFailureKind;
    const event = freezeDeep({
      type: "request-completed" as const,
      requestId: this.requestId,
      endedAt,
      outcome,
      failureKind,
      attribution: terminalAttribution,
      attemptCount: this.attempts.size,
      repairIncluded: [...this.attempts.values()].some((attempt) => attempt.role === "repair"),
      winningAttemptId: winner?.attemptId ?? null,
      commitAttemptId: this.requestCommitAttemptId,
      latencyMs: deriveLatency(this.startedAt, endedAt, completion.latencyMs),
      commitMs: this.requestCommitMs,
      provider: winner?.provider ?? this.provider,
      model: winner?.model ?? this.model,
      credentialId: winner?.credentialId ?? this.credentialId,
      tokens,
      spend: null,
    });
    this.requestCompleted = event;
    safeRecord(this.options.recorder, event);
    return event;
  }
}

export function createAccountingRequest(options: AccountingRequestOptions = {}): AccountingRequest {
  return new AccountingRequestLifecycle(options);
}
