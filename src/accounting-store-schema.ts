import {
  DASHBOARD_ATTEMPT_ID_MAX_BYTES,
  DASHBOARD_MAX_DETAIL_ATTEMPTS,
  DASHBOARD_REQUEST_ID_PATTERN,
  isDashboardAttemptId,
  isDashboardSafeId,
  isDashboardUtcTimestamp,
} from "./dashboard-contract.js";

/** The persisted accounting format is deliberately separate from the dashboard wire format. */
export const ACCOUNTING_STORE_VERSION = 1 as const;
export const ACCOUNTING_DAY_SCHEMA = "accounting.day.v1" as const;
export const ACCOUNTING_MINUTE_SCHEMA = "accounting.minute.v1" as const;
export const ACCOUNTING_RECENT_SCHEMA = "accounting.recent.v1" as const;
export const ACCOUNTING_LIFETIME_SCHEMA = "accounting.lifetime.v1" as const;
export const ACCOUNTING_DEDUP_SCHEMA = "accounting.dedup.v1" as const;
export const ACCOUNTING_STORE_SCHEMA = "accounting.store.v1" as const;

export const ACCOUNTING_MAX_SAMPLES = 25;
export const ACCOUNTING_MAX_ROWS_PER_CELL = 512;
export const ACCOUNTING_MAX_MINUTE_CELLS = 1_440;
/** Aggregate rows across all UTC minute cells in one day. */
export const ACCOUNTING_MAX_DAY_ROWS = 4_096;
export const ACCOUNTING_MAX_MONTHS = 720;
export const ACCOUNTING_MAX_RECENT_ROWS = 100;
export const ACCOUNTING_MAX_DETAIL_ATTEMPTS = DASHBOARD_MAX_DETAIL_ATTEMPTS;
export const ACCOUNTING_MAX_DEDUP_IDS = 16_384;
export const ACCOUNTING_MAX_LOSS_MARKERS = 32;
export const ACCOUNTING_MAX_PACKET_ATTEMPTS = 10_000;
export const ACCOUNTING_MAX_METHOD_BYTES = 256;
export const ACCOUNTING_MAX_COUNTER = Number.MAX_SAFE_INTEGER;
/** Maximum JSON UTF-8 size accepted for any persisted shard/document. */
export const ACCOUNTING_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const ACCOUNTING_MAX_SERIALIZED_BYTES = ACCOUNTING_MAX_FILE_BYTES;

export type AccountingOutcome = "success" | "error" | "cancelled" | "unknown";
export type AccountingFailureKind =
  | "timeout"
  | "provider_error"
  | "auth_error"
  | "rate_limit"
  | "aborted"
  | "protocol"
  | "unknown";
export type AccountingAttribution = "relay_held" | "caller_operated" | "unknown";
export type AccountingAttemptRole = "serve" | "repair";

export type AccountingParseResult<T> =
  | { readonly ok: true; readonly value: Readonly<T> }
  | { readonly ok: false; readonly error: string };

export type AccountingAggregateKind = "request" | "attempt";
export type AccountingDimension = "provider" | "model" | "client" | "credential";
export type AccountingCoverageState =
  | "complete"
  | "partial"
  | "unavailable"
  | "stale"
  | "empty";
export type AccountingCoverageReason =
  | "retention_pruned"
  | "row_cap"
  | "detail_cap"
  | "dedup_cap"
  | "counter_overflow"
  | "corrupt_recovery"
  | "unknown"
  | null;
export type AccountingLossKind =
  | "unknown"
  | "overflow"
  | "truncated"
  | "dedup"
  | "corrupt";

export interface AccountingAggregateTokenCellV1 {
  readonly value: number | null;
  readonly known: number;
  readonly unknown: number;
  readonly lost: number;
  readonly overflow: boolean;
  readonly observedAt: string | null;
}

export interface AccountingEstimatedTokenCellV1
  extends AccountingAggregateTokenCellV1 {
  /** A safe method label, or the explicit aggregate states mixed/unknown. */
  readonly method: string | null;
}

export interface AccountingAggregateTokenTotalsV1 {
  readonly reported: {
    readonly reportedInput: AccountingAggregateTokenCellV1;
    readonly reportedOutput: AccountingAggregateTokenCellV1;
    readonly reportedCachedInput: AccountingAggregateTokenCellV1;
    readonly cacheCreationInputTokens: AccountingAggregateTokenCellV1;
    readonly cacheReadInputTokens: AccountingAggregateTokenCellV1;
  };
  readonly estimated: {
    readonly estimatedInput: AccountingEstimatedTokenCellV1;
    readonly estimatedOutput: AccountingEstimatedTokenCellV1;
  };
}

export interface AccountingMetricCellV1 {
  readonly sumMs: number | null;
  readonly known: number;
  readonly unknown: number;
  readonly lost: number;
  readonly overflow: boolean;
  readonly samples: readonly number[];
  readonly samplesDropped: number;
  readonly observedAt: string | null;
}

export interface AccountingAggregateV1 {
  readonly requests: number;
  readonly attempts: number;
  readonly served: number;
  readonly errored: number;
  readonly cancelled: number;
  /** Attempt-side totals. Request-side totals are kept separately below. */
  readonly tokens: AccountingAggregateTokenTotalsV1;
  readonly requestTokens: AccountingAggregateTokenTotalsV1;
  readonly latency: AccountingMetricCellV1;
  readonly commit: AccountingMetricCellV1;
  /** Pricing is intentionally not guessed by the accounting layer. */
  readonly spend: null;
  readonly unpricedRequests: number;
}

interface AccountingDimensionRowBaseV1 extends AccountingAggregateV1 {
  readonly kind: AccountingAggregateKind;
  readonly role: "request" | AccountingAttemptRole;
  /** Full compound tuple. P2 derives provider/model/client/credential views later. */
  readonly provider: string | null;
  readonly model: string | null;
  readonly client: string | null;
  readonly credentialId: string | null;
  readonly attribution: AccountingAttribution;
  readonly outcome: AccountingOutcome;
  readonly failureKind: AccountingFailureKind | null;
}

export interface AccountingRequestDimensionRowV1
  extends AccountingDimensionRowBaseV1 {
  readonly kind: "request";
  readonly role: "request";
}

export interface AccountingAttemptDimensionRowV1
  extends AccountingDimensionRowBaseV1 {
  readonly kind: "attempt";
  readonly role: AccountingAttemptRole;
}

export type AccountingDimensionRowV1 =
  | AccountingRequestDimensionRowV1
  | AccountingAttemptDimensionRowV1;

export type AccountingCompoundDimensionRowV1 = AccountingDimensionRowV1;

/** Compatibility alias used by the store implementation. */
export type AccountingAggregateRowV1 = AccountingDimensionRowV1;
export type AccountingAggregate = AccountingAggregateV1;
export type AccountingAggregateRow = AccountingDimensionRowV1;
export type AggregateTokenCell = AccountingAggregateTokenCellV1;
export type AggregateTokenTotals = AccountingAggregateTokenTotalsV1;
export type AggregateMetric = AccountingMetricCellV1;

export interface AccountingLossMarkerV1 {
  readonly kind: AccountingLossKind;
  readonly count: number;
  readonly field: string | null;
}

export interface AccountingCoverageV1 {
  readonly state: AccountingCoverageState;
  readonly reason: AccountingCoverageReason;
  readonly droppedRows: number;
  readonly droppedRecent: number;
  readonly droppedDetails: number;
  readonly droppedDedup: number;
  readonly retentionFrom: string | null;
  readonly retentionDays: number | null;
  readonly losses: readonly AccountingLossMarkerV1[];
}

export type AccountingCellCoverageV1 = Pick<
  AccountingCoverageV1,
  "state" | "reason" | "droppedRows" | "losses"
>;

export interface AccountingMinuteShardV1 {
  readonly schema: "accounting.minute.v1";
  readonly version: typeof ACCOUNTING_STORE_VERSION;
  readonly date: string;
  readonly minute: string;
  readonly from: string;
  readonly to: string;
  readonly aggregate: AccountingAggregateV1;
  readonly rows: readonly AccountingDimensionRowV1[];
  readonly coverage: AccountingCellCoverageV1;
}

/** Compatibility name for callers that call a minute a cell. */
export type AccountingMinuteCellV1 = AccountingMinuteShardV1;
export type AccountingMinuteCell = AccountingMinuteShardV1;

export interface AccountingCompletedRequestDedupV1 {
  readonly schema: typeof ACCOUNTING_DEDUP_SCHEMA;
  readonly version: typeof ACCOUNTING_STORE_VERSION;
  readonly date: string;
  /** Sorted, unique IDs retained for exact replay suppression. */
  readonly requestIds: readonly string[];
  /** IDs older than the bounded set are not claimed to be deduplicated. */
  readonly dropped: number;
  readonly complete: boolean;
}

/** Compatibility alias for a store's per-day dedup index. */
export type AccountingDedupMetadataV1 = AccountingCompletedRequestDedupV1;

export interface AccountingDayShardV1 {
  readonly schema: typeof ACCOUNTING_DAY_SCHEMA;
  readonly version: typeof ACCOUNTING_STORE_VERSION;
  readonly date: string;
  /** Sparse UTC minute cells; absent keys mean no observed data. */
  readonly cells: Readonly<Record<string, AccountingMinuteShardV1>>;
  readonly dedup: AccountingCompletedRequestDedupV1;
  readonly coverage: AccountingCoverageV1;
}

export type AccountingDayShard = AccountingDayShardV1;

export interface AccountingMonthAggregateV1 {
  readonly month: string;
  readonly aggregate: AccountingAggregateV1;
  readonly coverage: AccountingCoverageV1;
}

export interface AccountingLifetimeV1 {
  readonly schema: typeof ACCOUNTING_LIFETIME_SCHEMA;
  readonly version: typeof ACCOUNTING_STORE_VERSION;
  readonly firstRequestAt: string | null;
  readonly lastRequestAt: string | null;
  readonly aggregate: AccountingAggregateV1;
  readonly months: Readonly<Record<string, AccountingMonthAggregateV1>>;
  readonly coverage: AccountingCoverageV1;
}

export type AccountingLifetime = AccountingLifetimeV1;

export interface AccountingAttemptPacketV1 {
  readonly requestId: string;
  readonly attemptId: string;
  readonly role: AccountingAttemptRole;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: AccountingOutcome;
  readonly failureKind: AccountingFailureKind | null;
  readonly attribution: AccountingAttribution;
  readonly latencyMs: number | null;
  readonly commitMs: number | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly credentialId: string | null;
  readonly tokens: AccountingAggregateTokenTotalsV1;
  readonly spend: null;
}

export type AccountingAttemptPacket = AccountingAttemptPacketV1;

export interface AccountingDetailAttemptMetadataV1 {
  readonly total: number;
  readonly stored: number;
  readonly dropped: number;
}

export interface AccountingRequestPacketV1 {
  readonly requestId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly client: string | null;
  readonly attribution: AccountingAttribution;
  readonly outcome: AccountingOutcome;
  readonly failureKind: AccountingFailureKind | null;
  readonly attemptCount: number;
  readonly repairIncluded: boolean;
  readonly winningAttemptId: string | null;
  readonly commitAttemptId: string | null;
  readonly latencyMs: number | null;
  readonly commitMs: number | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly credentialId: string | null;
  readonly tokens: AccountingAggregateTokenTotalsV1;
  readonly spend: null;
  readonly attempts: readonly AccountingAttemptPacketV1[];
  readonly attemptMetadata: AccountingDetailAttemptMetadataV1;
}

export type AccountingRequestPacket = AccountingRequestPacketV1;

export interface AccountingRecentV1 {
  readonly schema: typeof ACCOUNTING_RECENT_SCHEMA;
  readonly version: typeof ACCOUNTING_STORE_VERSION;
  readonly rows: readonly AccountingRequestPacketV1[];
  readonly details: Readonly<Record<string, AccountingRequestPacketV1>>;
  readonly coverage: AccountingCoverageV1;
}

export interface AccountingStoreEnvelopeV1 {
  readonly schema: typeof ACCOUNTING_STORE_SCHEMA;
  readonly version: typeof ACCOUNTING_STORE_VERSION;
  readonly day: AccountingDayShardV1;
  readonly lifetime: AccountingLifetimeV1;
  readonly recent: AccountingRecentV1;
}

const MINUTE_SCHEMA = ACCOUNTING_MINUTE_SCHEMA;
const MAX_ID_BYTES = 256;
const UTC_CANONICAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/;
const DATE_CANONICAL = /^(\d{4})-(\d{2})-(\d{2})$/;
const MINUTE_CANONICAL = /^(\d{2}):(\d{2})$/;
const MONTH_CANONICAL = /^(\d{4})-(\d{2})$/;
const METHOD_SPECIAL = new Set(["mixed", "unknown"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  const names = Object.getOwnPropertyNames(value);
  const enumerableNames = Object.keys(value);
  return (
    names.length === keys.length &&
    enumerableNames.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function hasExactArray<T>(value: unknown, max: number, guard: (item: unknown) => item is T): value is T[] {
  if (!Array.isArray(value) || value.length > max || Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || !names.includes("length")) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index)) || !guard(value[index])) return false;
  }
  return true;
}

function hasOnlyEnumerableStringKeys(value: Record<string, unknown>): boolean {
  return Object.getOwnPropertySymbols(value).length === 0 && Object.getOwnPropertyNames(value).length === Object.keys(value).length;
}

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : null;
  } catch {
    return null;
  }
}

export function accountingSerializedBytes(value: unknown): number | null {
  return serializedByteLength(value);
}

function withinFileCeiling(value: unknown): boolean {
  const bytes = serializedByteLength(value);
  return bytes !== null && bytes <= ACCOUNTING_MAX_FILE_BYTES;
}

function isSafeId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return isDashboardSafeId(value);
}

function isRequestId(value: unknown): value is string {
  return isSafeId(value) && DASHBOARD_REQUEST_ID_PATTERN.test(value);
}

function isAttemptId(value: unknown): value is string {
  return (
    isSafeId(value) &&
    Buffer.byteLength(value, "utf8") <= DASHBOARD_ATTEMPT_ID_MAX_BYTES &&
    isDashboardAttemptId(value)
  );
}

function isTimestamp(value: unknown): value is string {
  if (!isDashboardUtcTimestamp(value) || !UTC_CANONICAL.test(value)) return false;
  return new Date(value).toISOString() === value;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_CANONICAL.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= (days ?? 0);
}

function isMinute(value: unknown): value is string {
  const match = typeof value === "string" ? MINUTE_CANONICAL.exec(value) : null;
  return match !== null && Number(match[1]) < 24 && Number(match[2]) < 60;
}

function isMonth(value: unknown): value is string {
  if (typeof value !== "string" || !MONTH_CANONICAL.test(value)) return false;
  return isDate(`${value}-01`);
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= ACCOUNTING_MAX_COUNTER;
}

function isNullableCounter(value: unknown): value is number | null {
  return value === null || isCounter(value);
}

function isNullableId(value: unknown): value is string | null {
  return value === null || isSafeId(value);
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isOutcome(value: unknown): value is AccountingOutcome {
  return value === "success" || value === "error" || value === "cancelled" || value === "unknown";
}

function isFailure(value: unknown): value is AccountingFailureKind {
  return (
    value === "timeout" ||
    value === "provider_error" ||
    value === "auth_error" ||
    value === "rate_limit" ||
    value === "aborted" ||
    value === "protocol" ||
    value === "unknown"
  );
}

function isAttribution(value: unknown): value is AccountingAttribution {
  return value === "relay_held" || value === "caller_operated" || value === "unknown";
}

function isRole(value: unknown): value is AccountingAttemptRole {
  return value === "serve" || value === "repair";
}

function isFailureCoherent(outcome: AccountingOutcome, failure: AccountingFailureKind | null): boolean {
  if (outcome === "success") return failure === null;
  return failure === null || isFailure(failure);
}

function isAggregateTokenCell(value: unknown): value is AccountingAggregateTokenCellV1 {
  if (
    !hasExactKeys(value, ["value", "known", "unknown", "lost", "overflow", "observedAt"]) ||
    !isNullableCounter(value.value) ||
    !isCounter(value.known) ||
    !isCounter(value.unknown) ||
    !isCounter(value.lost) ||
    typeof value.overflow !== "boolean" ||
    !isNullableTimestamp(value.observedAt)
  ) return false;

  const uncertain = value.unknown > 0 || value.lost > 0 || value.overflow;
  if (value.value !== null && (value.known === 0 || uncertain)) return false;
  if (value.value === null && value.known > 0 && !uncertain) return false;
  if (value.known === 0 && value.observedAt !== null) return false;
  if (value.known > 0 && value.observedAt === null) return false;
  return true;
}

function isSafeMethod(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= ACCOUNTING_MAX_METHOD_BYTES && isSafeId(value);
}

function isEstimatedTokenCell(value: unknown): value is AccountingEstimatedTokenCellV1 {
  if (!hasExactKeys(value, ["value", "known", "unknown", "lost", "overflow", "observedAt", "method"])) return false;
  const base = {
    value: value.value,
    known: value.known,
    unknown: value.unknown,
    lost: value.lost,
    overflow: value.overflow,
    observedAt: value.observedAt,
  };
  if (!isAggregateTokenCell(base)) return false;
  if (value.method !== null && !isSafeMethod(value.method)) return false;
  const observed = base.known > 0 || base.unknown > 0 || base.lost > 0 || base.overflow;
  if (!observed) return value.method === null;
  if (base.known === 0) return value.method === "unknown";
  return value.method !== null && value.method !== "unknown";
}

function isAggregateTokens(value: unknown): value is AccountingAggregateTokenTotalsV1 {
  if (
    !hasExactKeys(value, ["reported", "estimated"]) ||
    !hasExactKeys(value.reported, [
      "reportedInput",
      "reportedOutput",
      "reportedCachedInput",
      "cacheCreationInputTokens",
      "cacheReadInputTokens",
    ]) ||
    !hasExactKeys(value.estimated, ["estimatedInput", "estimatedOutput"])
  ) return false;
  return (
    isAggregateTokenCell(value.reported.reportedInput) &&
    isAggregateTokenCell(value.reported.reportedOutput) &&
    isAggregateTokenCell(value.reported.reportedCachedInput) &&
    isAggregateTokenCell(value.reported.cacheCreationInputTokens) &&
    isAggregateTokenCell(value.reported.cacheReadInputTokens) &&
    isEstimatedTokenCell(value.estimated.estimatedInput) &&
    isEstimatedTokenCell(value.estimated.estimatedOutput)
  );
}

function isEmptyAggregateTokenCell(value: unknown): boolean {
  if (isEstimatedTokenCell(value)) {
    return value.method === null && value.value === null && value.known === 0 && value.unknown === 0 && value.lost === 0 && !value.overflow && value.observedAt === null;
  }
  if (!isAggregateTokenCell(value)) return false;
  return value.value === null && value.known === 0 && value.unknown === 0 && value.lost === 0 && !value.overflow && value.observedAt === null;
}

function isEmptyAggregateTokens(value: unknown): boolean {
  if (!isAggregateTokens(value)) return false;
  return (
    isEmptyAggregateTokenCell(value.reported.reportedInput) &&
    isEmptyAggregateTokenCell(value.reported.reportedOutput) &&
    isEmptyAggregateTokenCell(value.reported.reportedCachedInput) &&
    isEmptyAggregateTokenCell(value.reported.cacheCreationInputTokens) &&
    isEmptyAggregateTokenCell(value.reported.cacheReadInputTokens) &&
    isEmptyAggregateTokenCell(value.estimated.estimatedInput) &&
    isEmptyAggregateTokenCell(value.estimated.estimatedOutput)
  );
}

function isMetric(value: unknown): value is AccountingMetricCellV1 {
  if (
    !hasExactKeys(value, ["sumMs", "known", "unknown", "lost", "overflow", "samples", "samplesDropped", "observedAt"]) ||
    !isNullableCounter(value.sumMs) ||
    !isCounter(value.known) ||
    !isCounter(value.unknown) ||
    !isCounter(value.lost) ||
    typeof value.overflow !== "boolean" ||
    !isCounter(value.samplesDropped) ||
    !isNullableTimestamp(value.observedAt) ||
    !hasExactArray(value.samples, ACCOUNTING_MAX_SAMPLES, isCounter)
  ) return false;
  if (value.samples.length + value.samplesDropped > value.known) return false;
  const uncertain = value.unknown > 0 || value.lost > 0 || value.overflow;
  if (value.sumMs !== null && (value.known === 0 || uncertain)) return false;
  if (value.sumMs === null && value.known > 0 && !uncertain) return false;
  if (value.known === 0 && value.observedAt !== null) return false;
  if (value.known > 0 && value.observedAt === null) return false;
  return true;
}

type AggregateOwner = "general" | "request" | "attempt";

function isAggregateFields(value: Record<string, unknown>, owner: AggregateOwner = "general"): boolean {
  if (
    !isCounter(value.requests) ||
    !isCounter(value.attempts) ||
    !isCounter(value.served) ||
    !isCounter(value.errored) ||
    !isCounter(value.cancelled) ||
    !isAggregateTokens(value.tokens) ||
    !isAggregateTokens(value.requestTokens) ||
    !isMetric(value.latency) ||
    !isMetric(value.commit) ||
    value.spend !== null ||
    !isCounter(value.unpricedRequests)
  ) return false;
  if (owner === "request") {
    if (value.attempts !== 0 || !isEmptyAggregateTokens(value.tokens)) return false;
    if (value.served + value.errored + value.cancelled > value.requests) return false;
  } else if (owner === "attempt") {
    if (value.requests !== 0 || !isEmptyAggregateTokens(value.requestTokens)) return false;
    if (value.served + value.errored + value.cancelled > value.attempts) return false;
  } else {
    if (value.served + value.errored + value.cancelled > value.requests) return false;
  }
  if (owner !== "general") {
    const count = owner === "request" ? value.requests : value.attempts;
    if (!isOutcome(value.outcome) || count === 0) return false;
    if (value.outcome === "success" && (value.served !== count || value.errored !== 0 || value.cancelled !== 0)) return false;
    if (value.outcome === "error" && (value.served !== 0 || value.errored !== count || value.cancelled !== 0)) return false;
    if (value.outcome === "cancelled" && (value.served !== 0 || value.errored !== 0 || value.cancelled !== count)) return false;
    if (value.outcome === "unknown" && (value.served !== 0 || value.errored !== 0 || value.cancelled !== 0)) return false;
  }
  return value.unpricedRequests <= value.requests;
}

function isAggregate(value: unknown): value is AccountingAggregateV1 {
  return (
    hasExactKeys(value, [
      "requests",
      "attempts",
      "served",
      "errored",
      "cancelled",
      "tokens",
      "requestTokens",
      "latency",
      "commit",
      "spend",
      "unpricedRequests",
    ]) && isAggregateFields(value)
  );
}

function isDimensionRow(value: unknown): value is AccountingDimensionRowV1 {
  if (
    !hasExactKeys(value, [
      "requests",
      "attempts",
      "served",
      "errored",
      "cancelled",
      "tokens",
      "requestTokens",
      "latency",
      "commit",
      "spend",
      "unpricedRequests",
      "kind",
      "role",
      "provider",
      "model",
      "client",
      "credentialId",
      "attribution",
      "outcome",
      "failureKind",
    ]) ||
    (value.kind !== "request" && value.kind !== "attempt") ||
    (value.kind === "request" && value.role !== "request") ||
    (value.kind === "attempt" && !isRole(value.role)) ||
    !isNullableId(value.provider) ||
    !isNullableId(value.model) ||
    !isNullableId(value.client) ||
    !isNullableId(value.credentialId) ||
    !isAttribution(value.attribution) ||
    !isOutcome(value.outcome) ||
    (value.failureKind !== null && !isFailure(value.failureKind)) ||
    !isFailureCoherent(value.outcome, value.failureKind)
  ) return false;
  if (!isAggregateFields(value, value.kind === "request" ? "request" : "attempt")) return false;
  return true;
}

function isLossMarker(value: unknown): value is AccountingLossMarkerV1 {
  return (
    hasExactKeys(value, ["kind", "count", "field"]) &&
    (value.kind === "unknown" || value.kind === "overflow" || value.kind === "truncated" || value.kind === "dedup" || value.kind === "corrupt") &&
    isCounter(value.count) &&
    value.count > 0 &&
    (value.field === null || isSafeId(value.field))
  );
}

function isCoverage(value: unknown): value is AccountingCoverageV1 {
  if (
    !hasExactKeys(value, [
      "state",
      "reason",
      "droppedRows",
      "droppedRecent",
      "droppedDetails",
      "droppedDedup",
      "retentionFrom",
      "retentionDays",
      "losses",
    ]) ||
    (value.state !== "complete" && value.state !== "partial" && value.state !== "unavailable" && value.state !== "stale" && value.state !== "empty") ||
    (value.reason !== null && value.reason !== "retention_pruned" && value.reason !== "row_cap" && value.reason !== "detail_cap" && value.reason !== "dedup_cap" && value.reason !== "counter_overflow" && value.reason !== "corrupt_recovery" && value.reason !== "unknown") ||
    !isCounter(value.droppedRows) ||
    !isCounter(value.droppedRecent) ||
    !isCounter(value.droppedDetails) ||
    !isCounter(value.droppedDedup) ||
    !isNullableCounter(value.retentionDays) ||
    (value.retentionDays !== null && value.retentionDays === 0) ||
    !(value.retentionFrom === null || isDate(value.retentionFrom)) ||
    !hasExactArray(value.losses, ACCOUNTING_MAX_LOSS_MARKERS, isLossMarker)
  ) return false;

  const hasLoss = value.droppedRows + value.droppedRecent + value.droppedDetails + value.droppedDedup > 0 || value.losses.length > 0;
  if (value.state === "complete" && (value.reason !== null || hasLoss)) return false;
  if (value.state === "empty" && (value.reason !== null || hasLoss)) return false;
  if ((value.state === "partial" || value.state === "unavailable" || value.state === "stale") && value.reason === null && !hasLoss) return false;
  return true;
}

function isCellCoverage(value: unknown): value is AccountingCellCoverageV1 {
  if (
    !hasExactKeys(value, ["state", "reason", "droppedRows", "losses"]) ||
    (value.state !== "complete" && value.state !== "partial" && value.state !== "unavailable" && value.state !== "stale" && value.state !== "empty") ||
    (value.reason !== null && value.reason !== "retention_pruned" && value.reason !== "row_cap" && value.reason !== "detail_cap" && value.reason !== "dedup_cap" && value.reason !== "counter_overflow" && value.reason !== "corrupt_recovery" && value.reason !== "unknown") ||
    !isCounter(value.droppedRows) ||
    !hasExactArray(value.losses, ACCOUNTING_MAX_LOSS_MARKERS, isLossMarker)
  ) return false;
  const hasLoss = value.droppedRows > 0 || value.losses.length > 0;
  if (value.state === "complete" && (value.reason !== null || hasLoss)) return false;
  if (value.state === "empty" && (value.reason !== null || hasLoss)) return false;
  if ((value.state === "partial" || value.state === "unavailable" || value.state === "stale") && value.reason === null && !hasLoss) return false;
  return true;
}

function isMinuteShard(value: unknown): value is AccountingMinuteShardV1 {
  if (
    !hasExactKeys(value, ["schema", "version", "date", "minute", "from", "to", "aggregate", "rows", "coverage"]) ||
    value.schema !== MINUTE_SCHEMA ||
    value.version !== ACCOUNTING_STORE_VERSION ||
    !isDate(value.date) ||
    !isMinute(value.minute) ||
    !isTimestamp(value.from) ||
    !isTimestamp(value.to) ||
    !isAggregate(value.aggregate) ||
    !hasExactArray(value.rows, ACCOUNTING_MAX_ROWS_PER_CELL, isDimensionRow) ||
    !isCellCoverage(value.coverage)
  ) return false;
  const expectedFrom = `${value.date}T${value.minute}:00.000Z`;
  const expectedTo = new Date(Date.parse(expectedFrom) + 60_000).toISOString();
  return value.from === expectedFrom && value.to === expectedTo && withinFileCeiling(value);
}

function isDedup(value: unknown): value is AccountingCompletedRequestDedupV1 {
  if (
    !hasExactKeys(value, ["schema", "version", "date", "requestIds", "dropped", "complete"]) ||
    value.schema !== ACCOUNTING_DEDUP_SCHEMA ||
    value.version !== ACCOUNTING_STORE_VERSION ||
    !isDate(value.date) ||
    !isCounter(value.dropped) ||
    typeof value.complete !== "boolean" ||
    !hasExactArray(value.requestIds, ACCOUNTING_MAX_DEDUP_IDS, isRequestId)
  ) return false;
  for (let index = 1; index < value.requestIds.length; index += 1) {
    const previous = value.requestIds[index - 1];
    const current = value.requestIds[index];
    if (previous === undefined || current === undefined || previous >= current) return false;
  }
  return value.complete === (value.dropped === 0) && withinFileCeiling(value);
}

function isDay(value: unknown): value is AccountingDayShardV1 {
  if (
    !hasExactKeys(value, ["schema", "version", "date", "cells", "dedup", "coverage"]) ||
    value.schema !== ACCOUNTING_DAY_SCHEMA ||
    value.version !== ACCOUNTING_STORE_VERSION ||
    !isDate(value.date) ||
    !isPlainRecord(value.cells) ||
    !hasOnlyEnumerableStringKeys(value.cells) ||
    Object.keys(value.cells).length > ACCOUNTING_MAX_MINUTE_CELLS ||
    !isDedup(value.dedup) ||
    value.dedup.date !== value.date ||
    !isCoverage(value.coverage)
  ) return false;
  if (value.dedup.dropped > 0 && (value.coverage.state === "complete" || value.coverage.droppedDedup < value.dedup.dropped)) return false;
  let rowCount = 0;
  for (const [key, cell] of Object.entries(value.cells)) {
    if (!isMinute(key) || !isMinuteShard(cell) || cell.date !== value.date || cell.minute !== key) return false;
    rowCount += cell.rows.length;
    if (rowCount > ACCOUNTING_MAX_DAY_ROWS) return false;
  }
  return withinFileCeiling(value);
}

function isMonthAggregate(value: unknown): value is AccountingMonthAggregateV1 {
  return hasExactKeys(value, ["month", "aggregate", "coverage"]) && isMonth(value.month) && isAggregate(value.aggregate) && isCoverage(value.coverage);
}

function isLifetime(value: unknown): value is AccountingLifetimeV1 {
  if (
    !hasExactKeys(value, ["schema", "version", "firstRequestAt", "lastRequestAt", "aggregate", "months", "coverage"]) ||
    value.schema !== ACCOUNTING_LIFETIME_SCHEMA ||
    value.version !== ACCOUNTING_STORE_VERSION ||
    !isNullableTimestamp(value.firstRequestAt) ||
    !isNullableTimestamp(value.lastRequestAt) ||
    !isAggregate(value.aggregate) ||
    !isPlainRecord(value.months) ||
    !hasOnlyEnumerableStringKeys(value.months) ||
    Object.keys(value.months).length > ACCOUNTING_MAX_MONTHS ||
    !Object.entries(value.months).every(([key, month]) => isMonth(key) && isMonthAggregate(month) && month.month === key) ||
    !isCoverage(value.coverage)
  ) return false;
  if (value.firstRequestAt !== null && value.lastRequestAt !== null && value.firstRequestAt > value.lastRequestAt) return false;
  if (value.aggregate.requests === 0 && (value.firstRequestAt !== null || value.lastRequestAt !== null)) return false;
  if (value.aggregate.requests > 0 && (value.firstRequestAt === null || value.lastRequestAt === null)) return false;
  return withinFileCeiling(value);
}

function isAttemptPacket(value: unknown): value is AccountingAttemptPacketV1 {
  if (
    !hasExactKeys(value, [
      "requestId",
      "attemptId",
      "role",
      "startedAt",
      "endedAt",
      "outcome",
      "failureKind",
      "attribution",
      "latencyMs",
      "commitMs",
      "provider",
      "model",
      "credentialId",
      "tokens",
      "spend",
    ]) ||
    !isRequestId(value.requestId) ||
    !isAttemptId(value.attemptId) ||
    !isRole(value.role) ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.endedAt) ||
    value.startedAt > value.endedAt ||
    !isOutcome(value.outcome) ||
    (value.failureKind !== null && !isFailure(value.failureKind)) ||
    !isFailureCoherent(value.outcome, value.failureKind) ||
    !isAttribution(value.attribution) ||
    !isNullableCounter(value.latencyMs) ||
    !isNullableCounter(value.commitMs) ||
    !isNullableId(value.provider) ||
    !isNullableId(value.model) ||
    !isNullableId(value.credentialId) ||
    !isAggregateTokens(value.tokens) ||
    value.spend !== null
  ) return false;
  if (value.commitMs !== null && value.role !== "serve") return false;
  return true;
}

function tokenTotalsEqual(a: AccountingAggregateTokenTotalsV1, b: AccountingAggregateTokenTotalsV1): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isAttemptMetadata(value: unknown): value is AccountingDetailAttemptMetadataV1 {
  return hasExactKeys(value, ["total", "stored", "dropped"]) && isCounter(value.total) && isCounter(value.stored) && isCounter(value.dropped) && value.total <= ACCOUNTING_MAX_PACKET_ATTEMPTS && value.stored <= ACCOUNTING_MAX_DETAIL_ATTEMPTS && value.dropped === value.total - value.stored;
}

function isRequestPacket(value: unknown): value is AccountingRequestPacketV1 {
  if (
    !hasExactKeys(value, [
      "requestId",
      "startedAt",
      "endedAt",
      "client",
      "attribution",
      "outcome",
      "failureKind",
      "attemptCount",
      "repairIncluded",
      "winningAttemptId",
      "commitAttemptId",
      "latencyMs",
      "commitMs",
      "provider",
      "model",
      "credentialId",
      "tokens",
      "spend",
      "attempts",
      "attemptMetadata",
    ]) ||
    !isRequestId(value.requestId) ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.endedAt) ||
    value.startedAt > value.endedAt ||
    !isNullableId(value.client) ||
    !isAttribution(value.attribution) ||
    !isOutcome(value.outcome) ||
    (value.failureKind !== null && !isFailure(value.failureKind)) ||
    !isFailureCoherent(value.outcome, value.failureKind) ||
    !isCounter(value.attemptCount) ||
    typeof value.repairIncluded !== "boolean" ||
    !(value.winningAttemptId === null || isAttemptId(value.winningAttemptId)) ||
    !(value.commitAttemptId === null || isAttemptId(value.commitAttemptId)) ||
    !isNullableCounter(value.latencyMs) ||
    !isNullableCounter(value.commitMs) ||
    !isNullableId(value.provider) ||
    !isNullableId(value.model) ||
    !isNullableId(value.credentialId) ||
    !isAggregateTokens(value.tokens) ||
    value.spend !== null ||
    !hasExactArray(value.attempts, ACCOUNTING_MAX_DETAIL_ATTEMPTS, isAttemptPacket) ||
    !isAttemptMetadata(value.attemptMetadata)
  ) return false;

  if (value.attemptMetadata.total !== value.attemptCount || value.attemptMetadata.stored !== value.attempts.length) return false;
  if (value.attempts.length === 0 && value.attemptMetadata.total === 0 && value.repairIncluded) return false;
  const ids = new Set<string>();
  let sawRepair = false;
  let previousStartedAt = "";
  for (const attempt of value.attempts) {
    if (attempt.requestId !== value.requestId || ids.has(attempt.attemptId)) return false;
    if (previousStartedAt > attempt.startedAt) return false;
    previousStartedAt = attempt.startedAt;
    if (attempt.startedAt < value.startedAt || attempt.endedAt > value.endedAt) return false;
    ids.add(attempt.attemptId);
    sawRepair ||= attempt.role === "repair";
  }
  if (value.attemptMetadata.dropped === 0 && value.repairIncluded !== sawRepair) return false;
  if (value.attemptMetadata.dropped === 0 && value.attemptMetadata.total !== value.attempts.length) return false;

  let authoritative: AccountingAttemptPacketV1 | undefined;
  if (value.winningAttemptId !== null) {
    const winner = value.attempts.find((attempt) => attempt.attemptId === value.winningAttemptId);
    if (!winner) return false;
    authoritative = winner;
    if (value.outcome === "success") {
      if (winner.role !== "serve" || winner.outcome !== "success" || winner.failureKind !== null) return false;
    }
    if (value.outcome !== "success" && value.commitAttemptId === null) return false;
  } else if (value.outcome === "success") {
    return false;
  }

  if (value.commitAttemptId !== null) {
    if (value.winningAttemptId !== value.commitAttemptId) return false;
    const committed = value.attempts.find((attempt) => attempt.attemptId === value.commitAttemptId);
    if (!committed || committed.role !== "serve" || committed.commitMs === null || value.commitMs !== committed.commitMs) return false;
    if (value.outcome !== committed.outcome) return false;
    if (value.outcome === "success" && committed.failureKind !== null) return false;
    authoritative = committed;
  } else if (value.commitMs !== null) {
    return false;
  }

  if (authoritative !== undefined) {
    if (
      authoritative.provider !== value.provider ||
      authoritative.model !== value.model ||
      authoritative.credentialId !== value.credentialId ||
      authoritative.attribution !== value.attribution ||
      !tokenTotalsEqual(authoritative.tokens, value.tokens)
    ) return false;
  }

  if (value.attemptMetadata.dropped > 0) {
    if (value.winningAttemptId !== null && !ids.has(value.winningAttemptId)) return false;
    if (value.commitAttemptId !== null && !ids.has(value.commitAttemptId)) return false;
  }
  const committedAttempts = value.attempts.filter((attempt) => attempt.commitMs !== null);
  if (committedAttempts.length > 1) return false;
  if (committedAttempts.length === 1 && value.commitAttemptId !== committedAttempts[0]?.attemptId) return false;
  return true;
}

function isRecent(value: unknown): value is AccountingRecentV1 {
  if (
    !hasExactKeys(value, ["schema", "version", "rows", "details", "coverage"]) ||
    value.schema !== ACCOUNTING_RECENT_SCHEMA ||
    value.version !== ACCOUNTING_STORE_VERSION ||
    !hasExactArray(value.rows, ACCOUNTING_MAX_RECENT_ROWS, isRequestPacket) ||
    !isPlainRecord(value.details) ||
    !hasOnlyEnumerableStringKeys(value.details) ||
    Object.keys(value.details).length > ACCOUNTING_MAX_RECENT_ROWS ||
    !Object.entries(value.details).every(([key, packet]) => isRequestId(key) && isRequestPacket(packet) && packet.requestId === key) ||
    !isCoverage(value.coverage)
  ) return false;
  const rowIds = new Set<string>();
  for (const row of value.rows) {
    if (rowIds.has(row.requestId)) return false;
    rowIds.add(row.requestId);
  }
  return withinFileCeiling(value);
}

function isEnvelope(value: unknown): value is AccountingStoreEnvelopeV1 {
  return hasExactKeys(value, ["schema", "version", "day", "lifetime", "recent"]) && value.schema === ACCOUNTING_STORE_SCHEMA && value.version === ACCOUNTING_STORE_VERSION && isDay(value.day) && isLifetime(value.lifetime) && isRecent(value.recent) && withinFileCeiling(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (isPlainRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = cloneValue(item);
    return copy as T;
  }
  return value;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}

function parse<T>(value: unknown, guard: (candidate: unknown) => candidate is T, label: string): AccountingParseResult<T> {
  try {
    if (!guard(value)) return Object.freeze({ ok: false as const, error: label });
    const copy = cloneValue(value);
    if (!guard(copy)) return Object.freeze({ ok: false as const, error: label });
    return Object.freeze({ ok: true as const, value: freezeDeep(copy) });
  } catch {
    return Object.freeze({ ok: false as const, error: label });
  }
}

export const isAccountingAggregateTokenCellV1 = (value: unknown): value is AccountingAggregateTokenCellV1 => {
  try { return isAggregateTokenCell(value); } catch { return false; }
};
export const isAccountingEstimatedTokenCellV1 = (value: unknown): value is AccountingEstimatedTokenCellV1 => {
  try { return isEstimatedTokenCell(value); } catch { return false; }
};
export const isAccountingAggregateTokenTotalsV1 = (value: unknown): value is AccountingAggregateTokenTotalsV1 => {
  try { return isAggregateTokens(value); } catch { return false; }
};
export const isAccountingMetricCellV1 = (value: unknown): value is AccountingMetricCellV1 => {
  try { return isMetric(value); } catch { return false; }
};
export const isAccountingAggregateV1 = (value: unknown): value is AccountingAggregateV1 => {
  try { return isAggregate(value); } catch { return false; }
};
export const isAccountingDimensionRowV1 = (value: unknown): value is AccountingDimensionRowV1 => {
  try { return isDimensionRow(value); } catch { return false; }
};
export const isAccountingCoverageV1 = (value: unknown): value is AccountingCoverageV1 => {
  try { return isCoverage(value); } catch { return false; }
};
export const isAccountingMinuteShardV1 = (value: unknown): value is AccountingMinuteShardV1 => {
  try { return isMinuteShard(value); } catch { return false; }
};
export const isAccountingCompletedRequestDedupV1 = (value: unknown): value is AccountingCompletedRequestDedupV1 => {
  try { return isDedup(value); } catch { return false; }
};
export const isAccountingDayShardV1 = (value: unknown): value is AccountingDayShardV1 => {
  try { return isDay(value); } catch { return false; }
};
export const isAccountingMonthAggregateV1 = (value: unknown): value is AccountingMonthAggregateV1 => {
  try { return isMonthAggregate(value); } catch { return false; }
};
export const isAccountingLifetimeV1 = (value: unknown): value is AccountingLifetimeV1 => {
  try { return isLifetime(value); } catch { return false; }
};
export const isAccountingAttemptPacketV1 = (value: unknown): value is AccountingAttemptPacketV1 => {
  try { return isAttemptPacket(value); } catch { return false; }
};
export const isAccountingRequestPacketV1 = (value: unknown): value is AccountingRequestPacketV1 => {
  try { return isRequestPacket(value); } catch { return false; }
};
export const isAccountingRecentV1 = (value: unknown): value is AccountingRecentV1 => {
  try { return isRecent(value); } catch { return false; }
};
export const isAccountingStoreEnvelopeV1 = (value: unknown): value is AccountingStoreEnvelopeV1 => {
  try { return isEnvelope(value); } catch { return false; }
};

export const parseAccountingAggregateTokenCellV1 = (value: unknown): AccountingParseResult<AccountingAggregateTokenCellV1> => parse(value, isAggregateTokenCell, "token-cell");
export const parseAccountingEstimatedTokenCellV1 = (value: unknown): AccountingParseResult<AccountingEstimatedTokenCellV1> => parse(value, isEstimatedTokenCell, "estimated-token-cell");
export const parseAccountingAggregateTokenTotalsV1 = (value: unknown): AccountingParseResult<AccountingAggregateTokenTotalsV1> => parse(value, isAggregateTokens, "token-totals");
export const parseAccountingMetricCellV1 = (value: unknown): AccountingParseResult<AccountingMetricCellV1> => parse(value, isMetric, "metric-cell");
export const parseAccountingAggregateV1 = (value: unknown): AccountingParseResult<AccountingAggregateV1> => parse(value, isAggregate, "aggregate");
export const parseAccountingDimensionRowV1 = (value: unknown): AccountingParseResult<AccountingDimensionRowV1> => parse(value, isDimensionRow, "dimension-row");
export const parseAccountingCoverageV1 = (value: unknown): AccountingParseResult<AccountingCoverageV1> => parse(value, isCoverage, "coverage");
export const parseAccountingMinuteShardV1 = (value: unknown): AccountingParseResult<AccountingMinuteShardV1> => parse(value, isMinuteShard, "minute-shard");
export const parseAccountingCompletedRequestDedupV1 = (value: unknown): AccountingParseResult<AccountingCompletedRequestDedupV1> => parse(value, isDedup, "dedup");
export const parseAccountingDayShardV1 = (value: unknown): AccountingParseResult<AccountingDayShardV1> => parse(value, isDay, "day-shard");
export const parseAccountingMonthAggregateV1 = (value: unknown): AccountingParseResult<AccountingMonthAggregateV1> => parse(value, isMonthAggregate, "month-aggregate");
export const parseAccountingLifetimeV1 = (value: unknown): AccountingParseResult<AccountingLifetimeV1> => parse(value, isLifetime, "lifetime");
export const parseAccountingAttemptPacketV1 = (value: unknown): AccountingParseResult<AccountingAttemptPacketV1> => parse(value, isAttemptPacket, "attempt-packet");
export const parseAccountingRequestPacketV1 = (value: unknown): AccountingParseResult<AccountingRequestPacketV1> => parse(value, isRequestPacket, "request-packet");
export const parseAccountingRecentV1 = (value: unknown): AccountingParseResult<AccountingRecentV1> => parse(value, isRecent, "recent");
export const parseAccountingStoreEnvelopeV1 = (value: unknown): AccountingParseResult<AccountingStoreEnvelopeV1> => parse(value, isEnvelope, "store-envelope");

export const parseAccountingTokenCell = parseAccountingAggregateTokenCellV1;
export const parseAccountingEstimatedTokenCell = parseAccountingEstimatedTokenCellV1;
export const parseAccountingTokenTotals = parseAccountingAggregateTokenTotalsV1;
export const parseAccountingMetricCell = parseAccountingMetricCellV1;
export const parseAccountingAggregate = parseAccountingAggregateV1;
export const parseAccountingDimensionRow = parseAccountingDimensionRowV1;
export const parseAccountingCoverage = parseAccountingCoverageV1;
export const parseAccountingMinuteShard = parseAccountingMinuteShardV1;
export const parseAccountingDayShard = parseAccountingDayShardV1;
export const parseAccountingLifetime = parseAccountingLifetimeV1;
export const parseAccountingAttemptPacket = parseAccountingAttemptPacketV1;
export const parseAccountingRequestPacket = parseAccountingRequestPacketV1;
export const parseAccountingRecent = parseAccountingRecentV1;

/** Checked addition for counters. null means the exact safe-integer domain overflowed. */
export function checkedAddAccountingCounter(left: number, right: number): number | null {
  if (!isCounter(left) || !isCounter(right) || left > ACCOUNTING_MAX_COUNTER - right) return null;
  return left + right;
}

function latestTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

function mergeMethod(a: AccountingEstimatedTokenCellV1, b: AccountingEstimatedTokenCellV1, known: number): string | null {
  if (known === 0) return a.unknown + b.unknown + a.lost + b.lost + (a.overflow ? 1 : 0) + (b.overflow ? 1 : 0) > 0 ? "unknown" : null;
  const methods = [a.method, b.method].filter((method): method is string => method !== null && method !== "unknown");
  if (methods.length === 0) return "unknown";
  return methods.every((method) => method === methods[0]) ? methods[0] ?? "unknown" : "mixed";
}

function mergeCell<T extends AccountingAggregateTokenCellV1>(a: T, b: T, method: string | null = null, includeMethod = false): T | null {
  const aBase: AccountingAggregateTokenCellV1 = {
    value: a.value,
    known: a.known,
    unknown: a.unknown,
    lost: a.lost,
    overflow: a.overflow,
    observedAt: a.observedAt,
  };
  const bBase: AccountingAggregateTokenCellV1 = {
    value: b.value,
    known: b.known,
    unknown: b.unknown,
    lost: b.lost,
    overflow: b.overflow,
    observedAt: b.observedAt,
  };
  if (!isAggregateTokenCell(aBase) || !isAggregateTokenCell(bBase)) return null;
  const known = checkedAddAccountingCounter(aBase.known, bBase.known);
  const unknown = checkedAddAccountingCounter(aBase.unknown, bBase.unknown);
  const lost = checkedAddAccountingCounter(aBase.lost, bBase.lost);
  if (known === null || unknown === null || lost === null) return null;
  const uncertain = aBase.overflow || bBase.overflow || unknown > 0 || lost > 0;
  let value: number | null = null;
  let overflow = aBase.overflow || bBase.overflow;
  if (!uncertain && aBase.value !== null && bBase.value !== null) {
    if (aBase.value > ACCOUNTING_MAX_COUNTER - bBase.value) overflow = true;
    else value = aBase.value + bBase.value;
  }
  const result = {
    value: overflow || uncertain ? null : value,
    known,
    unknown,
    lost,
    overflow,
    observedAt: latestTimestamp(aBase.observedAt, bBase.observedAt),
    ...(includeMethod || method !== null ? { method } : {}),
  } as T;
  return freezeDeep(result);
}

export function mergeAccountingTokenCells(
  left: AccountingAggregateTokenCellV1,
  right: AccountingAggregateTokenCellV1,
): AccountingAggregateTokenCellV1 | null {
  try {
    return mergeCell(left, right);
  } catch {
    return null;
  }
}

export function mergeAccountingEstimatedTokenCells(
  left: AccountingEstimatedTokenCellV1,
  right: AccountingEstimatedTokenCellV1,
): AccountingEstimatedTokenCellV1 | null {
  try {
    if (!isEstimatedTokenCell(left) || !isEstimatedTokenCell(right)) return null;
    const known = checkedAddAccountingCounter(left.known, right.known);
    if (known === null) return null;
    const method = mergeMethod(left, right, known);
    const merged = mergeCell(left, right, method, true);
    return merged as AccountingEstimatedTokenCellV1 | null;
  } catch {
    return null;
  }
}

export function mergeAccountingMetricCells(
  left: AccountingMetricCellV1,
  right: AccountingMetricCellV1,
): AccountingMetricCellV1 | null {
  try {
    if (!isMetric(left) || !isMetric(right)) return null;
    const known = checkedAddAccountingCounter(left.known, right.known);
    const unknown = checkedAddAccountingCounter(left.unknown, right.unknown);
    const lost = checkedAddAccountingCounter(left.lost, right.lost);
    const dropped = checkedAddAccountingCounter(left.samplesDropped, right.samplesDropped);
    if (known === null || unknown === null || lost === null || dropped === null) return null;
    const overflow = left.overflow || right.overflow;
    let sumMs: number | null = null;
    let sumOverflow = overflow;
    if (!sumOverflow && left.sumMs !== null && right.sumMs !== null) {
      if (left.sumMs > ACCOUNTING_MAX_COUNTER - right.sumMs) sumOverflow = true;
      else sumMs = left.sumMs + right.sumMs;
    }
    const samples = [...left.samples, ...right.samples];
    const kept = samples.slice(Math.max(0, samples.length - ACCOUNTING_MAX_SAMPLES));
    const extraDropped = samples.length - kept.length;
    const totalDropped = checkedAddAccountingCounter(dropped, extraDropped);
    if (totalDropped === null) return null;
    const result: AccountingMetricCellV1 = {
      sumMs: sumOverflow || unknown > 0 || lost > 0 ? null : sumMs,
      known,
      unknown,
      lost,
      overflow: sumOverflow,
      samples: kept,
      samplesDropped: totalDropped,
      observedAt: latestTimestamp(left.observedAt, right.observedAt),
    };
    return freezeDeep(result);
  } catch {
    return null;
  }
}

// Short aliases make the codec convenient in the store without weakening its explicit v1 names.
export const isAggregateTokenTotals = isAccountingAggregateTokenTotalsV1;
export const isMetricCell = isAccountingMetricCellV1;
export const isAccountingAggregate = isAccountingAggregateV1;
export const isAccountingAggregateRow = isAccountingDimensionRowV1;
export const isAccountingCoverage = isAccountingCoverageV1;
export const isAccountingDay = isAccountingDayShardV1;
export const isAccountingLifetime = isAccountingLifetimeV1;
export const isAccountingRecent = isAccountingRecentV1;
export const isAccountingDetailPacket = isAccountingRequestPacketV1;
