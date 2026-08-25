import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNTING_UNSPECIFIED_ESTIMATION_METHOD,
  type AccountingEvent,
  type AccountingRecorder,
  type AccountingTokenTotals,
  type AttemptCompletedEvent,
  type AttemptStartedEvent,
  type RequestCompletedEvent,
  type RequestStartedEvent,
} from "./accounting.js";
import {
  createSnapshotJournalIo,
  SNAPSHOT_IO_HARD_MAX_JOURNAL_BYTES,
  type SnapshotJournalHooks,
  type SnapshotMutationResult,
  type SnapshotWriterResult,
} from "./accounting-store-io.js";
import {
  emptyAccountingAggregateSpend,
  emptyAccountingSpendCell,
  mergeAccountingSpendCells,
  ACCOUNTING_DAY_SCHEMA,
  ACCOUNTING_DEDUP_SCHEMA,
  ACCOUNTING_LIFETIME_SCHEMA,
  ACCOUNTING_MAX_DAY_ROWS,
  ACCOUNTING_MAX_DEDUP_IDS,
  ACCOUNTING_MAX_DETAIL_ATTEMPTS,
  ACCOUNTING_MAX_FILE_BYTES,
  ACCOUNTING_MAX_LOSS_MARKERS,
  ACCOUNTING_MAX_MONTHS,
  ACCOUNTING_MAX_PACKET_ATTEMPTS,
  ACCOUNTING_MAX_RECENT_ROWS,
  ACCOUNTING_MAX_ROWS_PER_CELL,
  ACCOUNTING_MAX_SAMPLES,
  ACCOUNTING_MINUTE_SCHEMA,
  ACCOUNTING_RECENT_SCHEMA,
  ACCOUNTING_STORE_VERSION,
  freezeDeep,
  parseAccountingAttemptPacketV1,
  parseAccountingDayShardV1,
  parseAccountingLifetimeV1,
  parseAccountingRecentV1,
  parseAccountingRequestPacketV1,
  type AccountingAggregateTokenCellV1,
  type AccountingAggregateTokenTotalsV1,
  type AccountingAggregateSpendCellV1,
  type AccountingAggregateSpendV1,
  type AccountingAttribution,
  type AccountingAttemptPacketV1,
  type AccountingAttemptRole,
  type AccountingCoverageReason,
  type AccountingCoverageV1,
  type AccountingDayShard,
  type AccountingFailureKind,
  type AccountingLifetime,
  type AccountingLossKind,
  type AccountingOutcome,
  type AccountingRecentV1,
  type AccountingRequestPacket,
  type AccountingSpendV1,
  isLoadableId,
} from "./accounting-store-schema.js";
import {
  DASHBOARD_REQUEST_ID_PATTERN,
  isDashboardAttemptId,
  isDashboardFailureKind,
  isDashboardOutcome,
  isDashboardSafeId,
  isDashboardUtcTimestamp,
} from "./dashboard-contract.js";
import { DEFAULT_FLUSH_DELAY_MS, MAX_FLUSH_DELAY_MS, WriteBehindTimer } from "./write-behind.js";

export {
  ACCOUNTING_DAY_SCHEMA,
  ACCOUNTING_DEDUP_SCHEMA,
  ACCOUNTING_LIFETIME_SCHEMA,
  ACCOUNTING_MAX_DAY_ROWS,
  ACCOUNTING_MAX_DEDUP_IDS,
  ACCOUNTING_MAX_DETAIL_ATTEMPTS,
  ACCOUNTING_MAX_FILE_BYTES,
  ACCOUNTING_MAX_LOSS_MARKERS,
  ACCOUNTING_MAX_MONTHS,
  ACCOUNTING_MAX_PACKET_ATTEMPTS,
  ACCOUNTING_MAX_RECENT_ROWS,
  ACCOUNTING_MAX_ROWS_PER_CELL,
  ACCOUNTING_MAX_SAMPLES,
  ACCOUNTING_MINUTE_SCHEMA,
  ACCOUNTING_RECENT_SCHEMA,
  ACCOUNTING_STORE_VERSION,
} from "./accounting-store-schema.js";
export type {
  AccountingAggregateTokenCellV1 as AggregateTokenCell,
  AccountingAggregateTokenTotalsV1 as AggregateTokenTotals,
  AccountingAggregateV1 as AccountingAggregate,
  AccountingAttemptPacketV1 as AccountingAttemptPacket,
  AccountingCoverageV1 as AccountingCoverage,
  AccountingDayShard,
  AccountingDimensionRowV1 as AccountingAggregateRow,
  AccountingLifetime,
  AccountingMetricCellV1 as AggregateMetric,
  AccountingMinuteShardV1 as AccountingMinuteCell,
  AccountingRequestPacket,
} from "./accounting-store-schema.js";

/** Sized for a Claude Code session holding many parallel subagent streams in flight. */
export const ACCOUNTING_MAX_PENDING_REQUESTS = 256;
export const ACCOUNTING_MAX_PENDING_ATTEMPTS_PER_REQUEST = ACCOUNTING_MAX_PACKET_ATTEMPTS;
export const ACCOUNTING_MAX_READ_DAYS = 31;
export const ACCOUNTING_DEFAULT_RECENT_ROWS = ACCOUNTING_MAX_RECENT_ROWS;
export const ACCOUNTING_DEFAULT_DETAIL_ROWS = ACCOUNTING_MAX_RECENT_ROWS;

const LIFETIME_TARGET = "lifetime.json";
const RECENT_TARGET = "recent.json";
const DAY_TARGET = /^(\d{4}-\d{2}-\d{2})\.json$/;
const RETRY_MIN_MS = 25;

export type AccountingReadResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "missing"; readonly value: null }
  | { readonly status: "corrupt"; readonly value: null; readonly error: string };

export interface AccountingDaysRead {
  readonly status: "ok" | "missing" | "corrupt" | "capped";
  readonly days: readonly AccountingDayShard[];
  readonly results: readonly { readonly date: string; readonly result: AccountingReadResult<AccountingDayShard> }[];
  readonly missingDates: readonly string[];
  readonly corruptDates: readonly string[];
  readonly capped: boolean;
}

export interface AccountingReader {
  readDay(date: string): AccountingReadResult<AccountingDayShard>;
  readDays(dates: readonly string[], options?: { readonly cap?: number }): AccountingDaysRead;
  readDays(from: string, to: string, options?: { readonly cap?: number }): AccountingDaysRead;
  readLifetime(): AccountingReadResult<AccountingLifetime>;
  readRecent(options?: { readonly limit?: number } | number): AccountingReadResult<readonly AccountingRequestPacket[]>;
  readDetail(requestId: string): AccountingReadResult<AccountingRequestPacket>;
}

/**
 * What one credential (optionally narrowed to one deployment) consumed in the CURRENT period,
 * read straight from in-memory state. Basis vocabulary shared with the dashboard contract's
 * `localUsedBasis`.
 */
export interface UsedInWindowReading {
  /** Completed requests attributed to this credential in the window; null when not visible. */
  readonly requests: number | null;
  /** Reported-or-estimated input+output tokens; null when nothing (or something uncertain) is visible. */
  readonly tokens: number | null;
  /** How the token figure was obtained; null alongside a null token figure. */
  readonly basis: "reported" | "estimated" | "mixed" | null;
}

export interface UsedInWindowOptions {
  readonly credentialId: string;
  readonly model?: string | null;
  readonly period: "minute" | "day" | "month";
  /** Injected for deterministic tests; defaults to Date.now. */
  readonly now?: number;
}

export interface AccountingStoreOptions {
  readonly rootDir?: string;
  readonly directory?: string;
  readonly path?: string;
  readonly retentionDays?: number | null;
  readonly recentLimit?: number;
  readonly detailLimit?: number;
  /**
   * Test seam for the durable per-day dedup cap, the `recentLimit` pattern: filling the real
   * 16,384-entry cap costs seconds of insert-sorting, which put the cap test's worst case over
   * vitest's budget under full-suite load. Bounded by ACCOUNTING_MAX_DEDUP_IDS, which stays the
   * default — production callers pass nothing.
   */
  readonly dedupLimit?: number;
  readonly readDaysCap?: number;
  readonly pendingRequestLimit?: number;
  readonly pendingAttemptLimit?: number;
  readonly now?: () => number;
  readonly ioHooks?: SnapshotJournalHooks;
  /**
   * Out-of-process readers only (`llm-relay cost`): construct without the writer lease,
   * without journal recovery, and without quarantine renames. Every one of those is a
   * WRITE against a directory a live relay may be committing to, and cross-process
   * writers are unsupported by the journal primitive — a reader observes only the
   * committed snapshots and reports the resulting lag rather than repairing it.
   */
  readonly readOnly?: boolean;
}

export interface AccountingStore extends AccountingRecorder, AccountingReader {
  readonly directory: string;
  readonly closed: boolean;
  readonly writerStatus: SnapshotWriterResult;
  readonly lastWrite: SnapshotMutationResult | null;
  flush(): SnapshotMutationResult;
  close(): SnapshotMutationResult;
  reader(): AccountingReader;
  /** The availability lane's narrow in-memory window read (see usedInWindow below). */
  usedInWindow(options: UsedInWindowOptions): UsedInWindowReading;
}

type MutableTokenCell = {
  value: number | null;
  known: number;
  unknown: number;
  lost: number;
  overflow: boolean;
  observedAt: string | null;
};
type MutableEstimatedTokenCell = MutableTokenCell & { method: string | null };
interface MutableTokens {
  reported: {
    reportedInput: MutableTokenCell;
    reportedOutput: MutableTokenCell;
    reportedCachedInput: MutableTokenCell;
    cacheCreationInputTokens: MutableTokenCell;
    cacheReadInputTokens: MutableTokenCell;
  };
  estimated: { estimatedInput: MutableEstimatedTokenCell; estimatedOutput: MutableEstimatedTokenCell };
}
interface MutableMetric {
  sumMs: number | null;
  known: number;
  unknown: number;
  lost: number;
  overflow: boolean;
  samples: number[];
  samplesDropped: number;
  observedAt: string | null;
}
type MutableSpendCell = {
  amountMicrousd: number | null;
  known: number;
  observedAt: string | null;
};
type MutableSpend = {
  providerPublishedReported: MutableSpendCell;
  providerPublishedEstimated: MutableSpendCell;
  referenceReported: MutableSpendCell;
  referenceEstimated: MutableSpendCell;
};
/**
 * In-memory aggregate. `spend` stays nullable because a LEGACY shard loads with
 * `spend: null`; the add functions normalize lazily on first touch.
 * `requestSpend`/`partiallyPricedRequests` are attached ONLY to request-owned
 * aggregates (cell roots, request rows, lifetime/month roots) by `addRequest`;
 * attempt rows deliberately never carry them, matching the schema guard that
 * rejects request-scoped facts on attempt rows.
 */
interface MutableAggregate {
  requests: number;
  attempts: number;
  served: number;
  errored: number;
  cancelled: number;
  tokens: MutableTokens;
  requestTokens: MutableTokens;
  latency: MutableMetric;
  commit: MutableMetric;
  spend: MutableSpend | null;
  requestSpend?: MutableSpend;
  partiallyPricedRequests?: number;
  unpricedRequests: number;
}
interface MutableRow extends MutableAggregate {
  kind: "request" | "attempt";
  role: "request" | AccountingAttemptRole;
  provider: string | null;
  model: string | null;
  client: string | null;
  credentialId: string | null;
  attribution: AccountingAttribution;
  outcome: AccountingOutcome;
  failureKind: AccountingFailureKind | null;
}
interface MutableLoss {
  kind: AccountingLossKind;
  count: number;
  field: string | null;
}
interface MutableCoverage {
  state: "complete" | "partial" | "unavailable" | "stale" | "empty";
  reason: AccountingCoverageReason;
  droppedRows: number;
  droppedRecent: number;
  droppedDetails: number;
  droppedDedup: number;
  retentionFrom: string | null;
  retentionDays: number | null;
  losses: MutableLoss[];
}
interface MutableCellCoverage {
  state: "complete" | "partial" | "unavailable" | "stale" | "empty";
  reason: AccountingCoverageReason;
  droppedRows: number;
  losses: MutableLoss[];
}
interface MutableCell {
  schema: typeof ACCOUNTING_MINUTE_SCHEMA;
  version: typeof ACCOUNTING_STORE_VERSION;
  date: string;
  minute: string;
  from: string;
  to: string;
  aggregate: MutableAggregate;
  rows: MutableRow[];
  coverage: MutableCellCoverage;
}
interface MutableDedup {
  schema: typeof ACCOUNTING_DEDUP_SCHEMA;
  version: typeof ACCOUNTING_STORE_VERSION;
  date: string;
  requestIds: string[];
  dropped: number;
  complete: boolean;
}
interface MutableDay {
  schema: typeof ACCOUNTING_DAY_SCHEMA;
  version: typeof ACCOUNTING_STORE_VERSION;
  date: string;
  cells: Record<string, MutableCell>;
  dedup: MutableDedup;
  coverage: MutableCoverage;
}
interface MutableMonth {
  month: string;
  aggregate: MutableAggregate;
  coverage: MutableCoverage;
}
interface MutableLifetime {
  schema: typeof ACCOUNTING_LIFETIME_SCHEMA;
  version: typeof ACCOUNTING_STORE_VERSION;
  firstRequestAt: string | null;
  lastRequestAt: string | null;
  aggregate: MutableAggregate;
  months: Record<string, MutableMonth>;
  coverage: MutableCoverage;
}
interface MutableRecent {
  schema: typeof ACCOUNTING_RECENT_SCHEMA;
  version: typeof ACCOUNTING_STORE_VERSION;
  rows: AccountingRequestPacket[];
  details: Record<string, AccountingRequestPacket>;
  coverage: MutableCoverage;
}
interface PendingRequest {
  started: RequestStartedEvent | null;
  attempts: Map<string, AccountingAttemptPacketV1>;
  startedAttempts: Map<string, AttemptStartedEvent>;
  droppedAttempts: number;
}
interface TerminalWork {
  event: RequestCompletedEvent;
  pending: PendingRequest | null;
}
interface RetentionPlan {
  /** Desired policy cutoff; retained while a bounded tombstone batch continues. */
  readonly cutoff: string;
  /** Exact shards named by the durable journal, used to reconcile recovery safely. */
  readonly candidates: readonly string[];
  readonly next: MutableLifetime;
  readonly truncated: boolean;
}
interface DeferredGlobalLoss {
  reason: Exclude<AccountingCoverageReason, null>;
  kind: AccountingLossKind;
  field: string | null;
  count: number;
}

function result(status: SnapshotMutationResult["status"], error: string | null = null, retryable = false, lowerBoundLoss = false): SnapshotMutationResult {
  return { status, transactionId: null, lowerBoundLoss, error, quarantinedPath: null, retryable };
}
function clone<T>(value: T): T { return structuredClone(value); }
function frozenClone<T>(value: T): T { return freezeDeep(clone(value)); }
function positiveLimit(value: unknown, fallback: number, hard: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, hard) : fallback;
}
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function nextDate(value: string): string | null {
  if (!validDate(value)) return null;
  const next = new Date(Date.parse(`${value}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
  return validDate(next) ? next : null;
}
function validTimestamp(value: unknown): value is string { return typeof value === "string" && isDashboardUtcTimestamp(value); }
function dayFor(value: string): string | null { return validTimestamp(value) ? value.slice(0, 10) : null; }
function minuteFor(value: string): string | null { return validTimestamp(value) ? value.slice(11, 16) : null; }
function monthFor(value: string): string | null { return validTimestamp(value) ? value.slice(0, 7) : null; }
function dayTarget(value: string): boolean { const match = DAY_TARGET.exec(value); return match !== null && validDate(match[1]); }
function targetForDay(date: string): string { return `${date}.json`; }
function defaultDirectory(): string {
  if (process.env.VITEST !== undefined) return join(tmpdir(), "llm-relay-vitest", `accounting-${process.pid}-${randomBytes(8).toString("hex")}`);
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg !== undefined && xdg.trim() !== "" ? join(xdg, "llm-relay", "usage") : join(homedir(), ".llm-relay", "usage");
}
function safeAttribution(value: unknown): AccountingAttribution { return value === "relay_held" || value === "caller_operated" || value === "unknown" ? value : "unknown"; }
function safeOutcome(value: unknown): AccountingOutcome { return isDashboardOutcome(value) ? value : "unknown"; }
function safeFailure(value: unknown, outcome: AccountingOutcome): AccountingFailureKind | null { return outcome === "success" ? null : isDashboardFailureKind(value) ? value : null; }
function safeId(value: unknown): string | null { return value === null || value === undefined ? null : isDashboardSafeId(value) ? value : null; }
function safeCounter(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function latest(left: string | null, right: string | null): string | null { return left === null ? right : right === null ? left : left >= right ? left : right; }
function earlier(left: string | null, right: string | null): string | null { return left === null ? right : right === null ? left : left <= right ? left : right; }
function increase(object: Record<string, number>, key: string, amount = 1): boolean {
  const current = object[key] ?? 0;
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(amount) || amount < 0 || current > Number.MAX_SAFE_INTEGER - amount) return false;
  object[key] = current + amount;
  return true;
}
function emptyCoverage(): MutableCoverage {
  return { state: "complete", reason: null, droppedRows: 0, droppedRecent: 0, droppedDetails: 0, droppedDedup: 0, retentionFrom: null, retentionDays: null, losses: [] };
}
function emptyCellCoverage(): MutableCellCoverage { return { state: "complete", reason: null, droppedRows: 0, losses: [] }; }
function addLoss(losses: MutableLoss[], kind: AccountingLossKind, field: string | null, count = 1): void {
  const current = losses.find((loss) => loss.kind === kind && loss.field === field);
  if (current !== undefined) { if (!increase(current as unknown as Record<string, number>, "count", count)) current.count = Number.MAX_SAFE_INTEGER; return; }
  if (losses.length < ACCOUNTING_MAX_LOSS_MARKERS) losses.push({ kind, count, field });
}
function markCoverage(coverage: MutableCoverage, reason: Exclude<AccountingCoverageReason, null>, kind: AccountingLossKind, field: string | null, count = 1): void {
  coverage.state = "partial";
  if (coverage.reason === null || coverage.reason === "unknown") coverage.reason = reason;
  addLoss(coverage.losses, kind, field, count);
}
function markDroppedRows(coverage: MutableCoverage, count: number): void {
  if (count < 1) return;
  increase(coverage as unknown as Record<string, number>, "droppedRows", count);
  markCoverage(coverage, "row_cap", "truncated", "rows", count);
}
function markCellCoverage(coverage: MutableCellCoverage, reason: Exclude<AccountingCoverageReason, null>, kind: AccountingLossKind, field: string | null): void {
  coverage.state = "partial";
  if (coverage.reason === null || coverage.reason === "unknown") coverage.reason = reason;
  addLoss(coverage.losses, kind, field);
}
function emptyTokenCell(): MutableTokenCell { return { value: null, known: 0, unknown: 0, lost: 0, overflow: false, observedAt: null }; }
function emptyTokens(): MutableTokens {
  return { reported: { reportedInput: emptyTokenCell(), reportedOutput: emptyTokenCell(), reportedCachedInput: emptyTokenCell(), cacheCreationInputTokens: emptyTokenCell(), cacheReadInputTokens: emptyTokenCell() }, estimated: { estimatedInput: { ...emptyTokenCell(), method: null }, estimatedOutput: { ...emptyTokenCell(), method: null } } };
}
function emptyMetric(): MutableMetric { return { sumMs: null, known: 0, unknown: 0, lost: 0, overflow: false, samples: [], samplesDropped: 0, observedAt: null }; }
function emptyAggregate(): MutableAggregate {
  return { requests: 0, attempts: 0, served: 0, errored: 0, cancelled: 0, tokens: emptyTokens(), requestTokens: emptyTokens(), latency: emptyMetric(), commit: emptyMetric(), spend: emptySpend(), unpricedRequests: 0 };
}

// Cell keys are owned by the schema module's SPEND_CELL_KEYS; the adders below
// reach them through emptyAccountingAggregateSpend() rather than a second list.
function emptySpend(): MutableSpend {
  return {
    providerPublishedReported: emptyAccountingSpendCell(),
    providerPublishedEstimated: emptyAccountingSpendCell(),
    referenceReported: emptyAccountingSpendCell(),
    referenceEstimated: emptyAccountingSpendCell(),
  };
}

/** Route one priced spend to its aggregate cell by (priceSource, tokenBasis). */
function spendCell(spend: MutableSpend, record: AccountingSpendV1): MutableSpendCell {
  if (record.priceSource === "provider_published") {
    return record.tokenBasis === "reported" ? spend.providerPublishedReported : spend.providerPublishedEstimated;
  }
  return record.tokenBasis === "reported" ? spend.referenceReported : spend.referenceEstimated;
}

/**
 * Fold one priced spend into an aggregate's ATTEMPT-side cells. First contributor
 * seeds the cell; later ones merge through the schema's checked integer adder so a
 * safe-integer overflow degrades the amount to null (announced by the caller's
 * exact flag) rather than wrapping.
 */
function addAttemptSpend(target: MutableAggregate, record: AccountingSpendV1 | null): boolean {
  if (record === null) return true;
  target.spend ??= emptySpend();
  return addSpendIntoCells(target.spend, record);
}

/** Cell-level fold shared by both scopes. */
function addSpendIntoCells(cells: MutableSpend, record: AccountingSpendV1): boolean {
  const cell = spendCell(cells, record);
  const knownBefore = cell.known;
  if (!increase(cell as unknown as Record<string, number>, "known")) return false;
  if (knownBefore === 0) {
    cell.amountMicrousd = record.amountMicrousd;
    cell.observedAt = record.observedAt;
    return true;
  }
  const merged = mergeAccountingSpendCells(cell, { amountMicrousd: record.amountMicrousd, known: 1, observedAt: record.observedAt });
  if (merged === null) return false;
  cell.amountMicrousd = merged.amountMicrousd;
  cell.observedAt = merged.observedAt;
  return true;
}
function emptyDay(date: string): MutableDay {
  return { schema: ACCOUNTING_DAY_SCHEMA, version: ACCOUNTING_STORE_VERSION, date, cells: {}, dedup: { schema: ACCOUNTING_DEDUP_SCHEMA, version: ACCOUNTING_STORE_VERSION, date, requestIds: [], dropped: 0, complete: true }, coverage: emptyCoverage() };
}
function emptyLifetime(): MutableLifetime { return { schema: ACCOUNTING_LIFETIME_SCHEMA, version: ACCOUNTING_STORE_VERSION, firstRequestAt: null, lastRequestAt: null, aggregate: emptyAggregate(), months: {}, coverage: emptyCoverage() }; }
function emptyRecent(): MutableRecent { return { schema: ACCOUNTING_RECENT_SCHEMA, version: ACCOUNTING_STORE_VERSION, rows: [], details: {}, coverage: emptyCoverage() }; }

// ── usedInWindow: the availability lane's narrow in-memory read ────────────────────────────────
// One accumulating side of a token split (reported vs estimated).
interface UsageSide { seen: boolean; exact: boolean; value: number; }
function newUsageSide(): UsageSide { return { seen: false, exact: true, value: 0 }; }

/**
 * Fold one token cell into a side. Any uncertainty marker (unknown/lost/overflow, or a null
 * value despite evidence) poisons the WHOLE side rather than being dropped: presenting a partial
 * sum as a measurement is exactly what the provenance invariant forbids.
 * Returns whether THIS cell carried a measured amount (drives the estimated-only detection below).
 */
function noteUsageCell(side: UsageSide, cell: { readonly value: number | null; readonly known: number; readonly unknown: number; readonly lost: number; readonly overflow: boolean }): boolean {
  // Only a MEASURED amount counts as usage. An all-unknown cell (the store's way of saying "no
  // token facts arrived") is absence of evidence, not evidence of consumption — counting it
  // would turn every unreported request into a phantom "mixed" reading.
  if (!(cell.known > 0)) return false;
  side.seen = true;
  if (cell.unknown > 0 || cell.lost > 0 || cell.overflow || typeof cell.value !== "number") side.exact = false;
  else side.value += cell.value;
  return true;
}

/** Input + output only: cache creation/read cells are deliberately excluded from this figure. */
function noteUsageTokens(
  side: UsageSide,
  input: AccountingAggregateTokenCellV1,
  output: AccountingAggregateTokenCellV1,
): boolean {
  const inputMeasured = noteUsageCell(side, input);
  const outputMeasured = noteUsageCell(side, output);
  return inputMeasured || outputMeasured;
}

/** Non-negative safe-integer counter, else 0 (callers convert a 0 total back to null). */
function windowCounter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

const USED_WINDOW_EMPTY: UsedInWindowReading = { requests: null, tokens: null, basis: null };

/**
 * Combine the sides under the contract's reported/estimated/mixed vocabulary.
 *
 * Decision (review fix 2026-08-22): a window holding BOTH bases never sums them into one
 * scalar — the accounting invariant keeps reported and estimated accumulators separate precisely
 * so no total can quietly blend them, and a lone figure tagged "mixed" names the mix without
 * showing its split. Instead:
 * - every measured request carried reported tokens ⇒ the REPORTED figure stands alone, labelled
 *   `reported` (the estimated cells on those same requests cover unreported halves of the same
 *   requests, so the reported figure is a true measurement, merely narrower);
 * - any ESTIMATED-ONLY request sits beside reported ones ⇒ no number: `tokens: null`,
 *   `basis: "mixed"` — returning the reported figure alone would understate the window by every
 *   estimated-only request, and the sum would blend bases. Naming the mix without inventing the
 *   number is the provenance-safe direction.
 */
function usageReading(
  requests: number | null,
  reported: UsageSide,
  estimated: UsageSide,
  estimatedOnlyRequest: boolean,
): UsedInWindowReading {
  if (!reported.seen && !estimated.seen) return { requests, tokens: null, basis: null };
  const blended = reported.seen && estimated.seen;
  if (blended && estimatedOnlyRequest) return { requests, tokens: null, basis: "mixed" };
  if (blended || reported.seen) {
    return {
      requests,
      tokens: reported.exact ? reported.value : null,
      basis: "reported",
    };
  }
  return {
    requests,
    tokens: estimated.exact ? estimated.value : null,
    basis: "estimated",
  };
}

interface SourceCell { value: number | null; observedAt: string | null; method: string | null; }
function sourceCell(value: unknown): SourceCell {
  if (value === null || typeof value !== "object") return { value: null, observedAt: null, method: null };
  const source = value as { value?: unknown; observedAt?: unknown; method?: unknown };
  return {
    value: safeCounter(source.value),
    observedAt: validTimestamp(source.observedAt) ? source.observedAt : null,
    // `isLoadableId`, not `isDashboardSafeId` — see `methodSnapshot`: the accept side must not
    // admit what the loader will reject, or the whole day shard is quarantined on the next read.
    method: typeof source.method === "string" && isLoadableId(source.method) && Buffer.byteLength(source.method, "utf8") <= 256 ? source.method : null,
  };
}
function addRawTokenCell(target: MutableTokenCell, source: SourceCell, fallback: string): boolean {
  if (source.value === null) {
    if (!increase(target as unknown as Record<string, number>, "unknown")) { target.overflow = true; target.value = null; return false; }
    target.value = null;
    return true;
  }
  const knownBefore = target.known;
  if (!increase(target as unknown as Record<string, number>, "known")) {
    target.overflow = true; target.value = null; increase(target as unknown as Record<string, number>, "lost"); return false;
  }
  target.observedAt = latest(target.observedAt, source.observedAt ?? fallback);
  if (target.unknown > 0 || target.lost > 0 || target.overflow) { target.value = null; return true; }
  if (knownBefore === 0 || target.value === null) { target.value = source.value; return true; }
  if (target.value > Number.MAX_SAFE_INTEGER - source.value) {
    target.value = null; target.overflow = true; increase(target as unknown as Record<string, number>, "lost"); return false;
  }
  target.value += source.value;
  return true;
}
function updateMethod(target: MutableEstimatedTokenCell, incoming: string | null): void {
  if (target.known === 0) { target.method = target.unknown > 0 || target.lost > 0 || target.overflow ? "unknown" : null; return; }
  const method = incoming ?? ACCOUNTING_UNSPECIFIED_ESTIMATION_METHOD;
  if (target.method === null || target.method === "unknown") { target.method = method; return; }
  if (method !== "unknown" && target.method !== method) target.method = "mixed";
}
function addRawTokens(target: MutableTokens, source: AccountingTokenTotals | null | undefined, fallback: string): boolean {
  const reported = source?.reported;
  const estimated = source?.estimated;
  let exact = true;
  exact &&= addRawTokenCell(target.reported.reportedInput, sourceCell(reported?.reportedInput), fallback);
  exact &&= addRawTokenCell(target.reported.reportedOutput, sourceCell(reported?.reportedOutput), fallback);
  exact &&= addRawTokenCell(target.reported.reportedCachedInput, sourceCell(reported?.reportedCachedInput), fallback);
  exact &&= addRawTokenCell(target.reported.cacheCreationInputTokens, sourceCell(reported?.cacheCreationInputTokens), fallback);
  exact &&= addRawTokenCell(target.reported.cacheReadInputTokens, sourceCell(reported?.cacheReadInputTokens), fallback);
  const input = sourceCell(estimated?.estimatedInput);
  const output = sourceCell(estimated?.estimatedOutput);
  exact &&= addRawTokenCell(target.estimated.estimatedInput, input, fallback);
  updateMethod(target.estimated.estimatedInput, input.method);
  exact &&= addRawTokenCell(target.estimated.estimatedOutput, output, fallback);
  updateMethod(target.estimated.estimatedOutput, output.method);
  return exact;
}
function addAggregateTokenCell(target: MutableTokenCell, source: MutableTokenCell): boolean {
  const knownBefore = target.known;
  const uncertainBefore = target.unknown > 0 || target.lost > 0 || target.overflow;
  const sourceUncertain = source.unknown > 0 || source.lost > 0 || source.overflow;
  const fields: Array<keyof Pick<MutableTokenCell, "known" | "unknown" | "lost">> = ["known", "unknown", "lost"];
  let exact = true;
  for (const field of fields) {
    if (!increase(target as unknown as Record<string, number>, field, source[field])) { target.overflow = true; exact = false; }
  }
  target.overflow ||= source.overflow;
  target.observedAt = latest(target.observedAt, source.observedAt);
  if (knownBefore === 0 && !uncertainBefore && !sourceUncertain) target.value = source.value;
  else if (target.value === null || source.value === null || uncertainBefore || sourceUncertain || target.value > Number.MAX_SAFE_INTEGER - source.value) {
    if (target.value !== null && source.value !== null && target.value > Number.MAX_SAFE_INTEGER - source.value) { target.overflow = true; exact = false; }
    target.value = null;
  } else target.value += source.value;
  if (target.unknown > 0 || target.lost > 0 || target.overflow) target.value = null;
  return exact;
}
function addAggregateTokens(target: MutableTokens, source: AccountingAggregateTokenTotalsV1): boolean {
  let exact = true;
  exact &&= addAggregateTokenCell(target.reported.reportedInput, source.reported.reportedInput as MutableTokenCell);
  exact &&= addAggregateTokenCell(target.reported.reportedOutput, source.reported.reportedOutput as MutableTokenCell);
  exact &&= addAggregateTokenCell(target.reported.reportedCachedInput, source.reported.reportedCachedInput as MutableTokenCell);
  exact &&= addAggregateTokenCell(target.reported.cacheCreationInputTokens, source.reported.cacheCreationInputTokens as MutableTokenCell);
  exact &&= addAggregateTokenCell(target.reported.cacheReadInputTokens, source.reported.cacheReadInputTokens as MutableTokenCell);
  exact &&= addAggregateTokenCell(target.estimated.estimatedInput, source.estimated.estimatedInput as MutableTokenCell);
  updateMethod(target.estimated.estimatedInput, source.estimated.estimatedInput.method);
  exact &&= addAggregateTokenCell(target.estimated.estimatedOutput, source.estimated.estimatedOutput as MutableTokenCell);
  updateMethod(target.estimated.estimatedOutput, source.estimated.estimatedOutput.method);
  return exact;
}
function tokenSnapshot(source: AccountingTokenTotals | null | undefined, fallback: string): AccountingAggregateTokenTotalsV1 {
  const target = emptyTokens();
  addRawTokens(target, source, fallback);
  return target as AccountingAggregateTokenTotalsV1;
}
function addMetric(target: MutableMetric, value: number | null, observedAt: string): boolean {
  if (value === null) {
    if (!increase(target as unknown as Record<string, number>, "unknown")) { target.overflow = true; target.sumMs = null; return false; }
    target.sumMs = null;
    return true;
  }
  const knownBefore = target.known;
  if (!increase(target as unknown as Record<string, number>, "known")) { target.overflow = true; target.sumMs = null; increase(target as unknown as Record<string, number>, "lost"); return false; }
  target.observedAt = latest(target.observedAt, observedAt);
  if (target.unknown > 0 || target.lost > 0 || target.overflow) target.sumMs = null;
  else if (knownBefore === 0 || target.sumMs === null) target.sumMs = value;
  else if (target.sumMs > Number.MAX_SAFE_INTEGER - value) { target.sumMs = null; target.overflow = true; increase(target as unknown as Record<string, number>, "lost"); return false; }
  else target.sumMs += value;
  target.samples.push(value);
  if (target.samples.length > ACCOUNTING_MAX_SAMPLES) {
    target.samples.shift();
    if (!increase(target as unknown as Record<string, number>, "samplesDropped")) { target.overflow = true; return false; }
  }
  return true;
}
function addOutcome(target: MutableAggregate, outcome: AccountingOutcome): boolean {
  if (outcome === "success") return increase(target as unknown as Record<string, number>, "served");
  if (outcome === "error") return increase(target as unknown as Record<string, number>, "errored");
  if (outcome === "cancelled") return increase(target as unknown as Record<string, number>, "cancelled");
  return true;
}
function addRequest(target: MutableAggregate, event: RequestCompletedEvent, outcome: AccountingOutcome): boolean {
  let exact = increase(target as unknown as Record<string, number>, "requests");
  exact &&= addOutcome(target, outcome);
  exact &&= addMetric(target.latency, outcome === "cancelled" ? null : safeCounter(event.latencyMs), event.endedAt);
  exact &&= addMetric(target.commit, outcome === "success" ? safeCounter(event.commitMs) : null, event.endedAt);
  exact &&= addRawTokens(target.requestTokens, event.tokens, event.endedAt);
  // Request spend mirrors request tokens: the WINNING serve only, so a
  // retried-elsewhere request never double-counts its failed attempts.
  if (event.spend !== null) {
    target.requestSpend ??= emptySpend();
    exact &&= addSpendIntoCells(target.requestSpend, event.spend);
    // A partial figure (unpriced cache kinds etc.) is priced but a lower bound.
    if (event.spend.coverage !== "full") {
      exact &&= increase(target as unknown as Record<string, number>, "partiallyPricedRequests");
    }
  } else {
    exact &&= increase(target as unknown as Record<string, number>, "unpricedRequests");
  }
  return exact;
}
function addRootAttempt(target: MutableAggregate, attempt: AccountingAttemptPacketV1): boolean {
  let exact = increase(target as unknown as Record<string, number>, "attempts");
  // Root aggregates accumulate BOTH attempt-side axes, exactly as the dimension
  // attempt rows do: dropping the token fold made every root disagree with its
  // own rows while the spend fold looked complete.
  exact &&= addAggregateTokens(target.tokens, attempt.tokens);
  exact &&= addAttemptSpend(target, attempt.spend);
  return exact;
}
function addAttempt(target: MutableAggregate, attempt: AccountingAttemptPacketV1): boolean {
  let exact = increase(target as unknown as Record<string, number>, "attempts");
  exact &&= addOutcome(target, attempt.outcome);
  exact &&= addMetric(target.latency, attempt.outcome === "cancelled" ? null : attempt.latencyMs, attempt.endedAt);
  exact &&= addMetric(target.commit, attempt.outcome === "success" && attempt.role === "serve" ? attempt.commitMs : null, attempt.endedAt);
  exact &&= addAggregateTokens(target.tokens, attempt.tokens);
  exact &&= addAttemptSpend(target, attempt.spend);
  return exact;
}
function rowKey(row: Pick<MutableRow, "kind" | "role" | "provider" | "model" | "client" | "credentialId" | "attribution" | "outcome" | "failureKind">): string {
  return JSON.stringify([row.kind, row.role, row.provider, row.model, row.client, row.credentialId, row.attribution, row.outcome, row.failureKind]);
}

/**
 * Dimension fields are fixed when a row is created (only aggregate counters move
 * afterwards), so its serialized key is memoized rather than re-derived per scan.
 */
const rowKeys = new WeakMap<object, string>();
function cachedRowKey(
  row: Pick<MutableRow, "kind" | "role" | "provider" | "model" | "client" | "credentialId" | "attribution" | "outcome" | "failureKind">,
): string {
  const existing = rowKeys.get(row);
  if (existing !== undefined) return existing;
  const key = rowKey(row);
  rowKeys.set(row, key);
  return key;
}

/**
 * In-memory membership index for a day's dedup array; the SORTED ARRAY remains
 * the persisted form. Keyed weakly so an evicted or pruned day drops its index.
 */
const dedupMembership = new WeakMap<object, Set<string>>();
function dedupSet(day: MutableDay): Set<string> {
  let ids = dedupMembership.get(day);
  if (ids === undefined) {
    ids = new Set(day.dedup.requestIds);
    dedupMembership.set(day, ids);
  }
  return ids;
}
interface DayRowBudget { remaining: number; }

function countDayRows(day: MutableDay): number {
  let count = 0;
  for (const cell of Object.values(day.cells)) count += cell.rows.length;
  return count;
}

function findRow(
  cell: MutableCell,
  row: Omit<MutableRow, keyof MutableAggregate>,
  budget: DayRowBudget,
): MutableRow | null {
  const key = rowKey(row);
  const found = cell.rows.find((candidate) => cachedRowKey(candidate) === key);
  if (found !== undefined) return found;
  if (cell.rows.length >= ACCOUNTING_MAX_ROWS_PER_CELL || budget.remaining <= 0) {
    increase(cell.coverage as unknown as Record<string, number>, "droppedRows");
    markCellCoverage(cell.coverage, "row_cap", "truncated", "rows");
    return null;
  }
  const created: MutableRow = { ...emptyAggregate(), ...row };
  cell.rows.push(created);
  budget.remaining -= 1;
  return created;
}
function cellFor(day: MutableDay, endedAt: string): MutableCell | null {
  const minute = minuteFor(endedAt);
  if (minute === null) return null;
  const existing = day.cells[minute];
  if (existing !== undefined) return existing;
  const from = `${day.date}T${minute}:00.000Z`;
  const created: MutableCell = { schema: ACCOUNTING_MINUTE_SCHEMA, version: ACCOUNTING_STORE_VERSION, date: day.date, minute, from, to: new Date(Date.parse(from) + 60_000).toISOString(), aggregate: emptyAggregate(), rows: [], coverage: emptyCellCoverage() };
  day.cells[minute] = created;
  return created;
}
function sortedAttempts(attempts: Iterable<AccountingAttemptPacketV1>): AccountingAttemptPacketV1[] {
  return [...attempts].sort((left, right) => left.startedAt === right.startedAt ? left.attemptId.localeCompare(right.attemptId) : left.startedAt.localeCompare(right.startedAt));
}
function makeAttempt(event: AttemptCompletedEvent): AccountingAttemptPacketV1 | null {
  if (!DASHBOARD_REQUEST_ID_PATTERN.test(event.requestId) || !isDashboardAttemptId(event.attemptId) || !validTimestamp(event.startedAt) || !validTimestamp(event.endedAt) || event.startedAt > event.endedAt) return null;
  const outcome = safeOutcome(event.outcome);
  const value = {
    requestId: event.requestId,
    attemptId: event.attemptId,
    role: event.role === "repair" ? "repair" : "serve",
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    outcome,
    failureKind: safeFailure(event.failureKind, outcome),
    attribution: safeAttribution(event.attribution),
    latencyMs: safeCounter(event.latencyMs),
    commitMs: event.role === "serve" ? safeCounter(event.commitMs) : null,
    provider: safeId(event.provider),
    model: safeId(event.model),
    credentialId: safeId(event.credentialId),
    tokens: tokenSnapshot(event.tokens, event.endedAt),
    // The lifecycle already validated this record's provenance fields; a
    // re-validation through the packet guard below keeps that guarantee total.
    spend: event.spend,
  } satisfies AccountingAttemptPacketV1;
  const parsed = parseAccountingAttemptPacketV1(value);
  return parsed.ok ? parsed.value : null;
}
function mutableDay(value: AccountingDayShard): MutableDay { return clone(value) as MutableDay; }
function mutableLifetime(value: AccountingLifetime): MutableLifetime { return clone(value) as MutableLifetime; }
function mutableRecent(value: AccountingRecentV1): MutableRecent { return clone(value) as MutableRecent; }
function parsedDay(value: MutableDay): AccountingDayShard | null { const parsed = parseAccountingDayShardV1(value); return parsed.ok ? parsed.value : null; }
function parsedLifetime(value: MutableLifetime): AccountingLifetime | null { const parsed = parseAccountingLifetimeV1(value); return parsed.ok ? parsed.value : null; }
function parsedRecent(value: MutableRecent): AccountingRecentV1 | null { const parsed = parseAccountingRecentV1(value); return parsed.ok ? parsed.value : null; }

class AccountingStoreImpl implements AccountingStore {
  readonly directory: string;
  private readonly io;
  private readonly timer = new WriteBehindTimer();
  private readonly retentionDays: number | null;
  private readonly recentLimit: number;
  private readonly detailLimit: number;
  private readonly dedupLimit: number;
  private readonly readDaysCap: number;
  private readonly knownDaysCap: number;
  private readonly pendingRequestLimit: number;
  private readonly pendingAttemptLimit: number;
  private readonly now: () => number;
  private readonly readOnly: boolean;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queued = new Array<TerminalWork>();
  private readonly days = new Map<string, MutableDay>();
  private readonly knownDays = new Set<string>();
  private readonly dirtyDays = new Set<string>();
  private lifetime = emptyLifetime();
  private recent = emptyRecent();
  private lifetimeReadState: "ok" | "missing" | "corrupt" = "missing";
  private recentReadState: "ok" | "missing" | "corrupt" = "missing";
  private dirtyLifetime = false;
  private dirtyRecent = false;
  /** Fixed snapshots were not safely loaded yet; terminal facts must queue. */
  private fixedLoadPending = false;
  /** Quarantine/lower-bound evidence observed before both fixed reads complete. */
  private pendingFixedLoss = false;
  private pendingJournalLoss = false;
  /** Losses observed before fixed snapshots load must not dirty empty state. */
  private readonly deferredGlobalLosses: DeferredGlobalLoss[] = [];
  /**
   * Retention is its own post-fact transaction.  Keep its intent separately so
   * a fact commit followed by a failed tombstone commit cannot turn a retry
   * into an apparently clean no-op.
   */
  private pendingRetention: string | null = null;
  /** The exact pending journal shape, retained only to merge a later recovery. */
  private pendingRetentionPlan: RetentionPlan | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay = RETRY_MIN_MS;
  private _closed = false;
  private writer: SnapshotWriterResult;
  private last: SnapshotMutationResult | null = null;
  private lowerBoundLoss = false;
  private trustedDate: string | null = null;

  constructor(options: AccountingStoreOptions) {
    this.directory = options.rootDir ?? options.directory ?? options.path ?? defaultDirectory();
    this.retentionDays = typeof options.retentionDays === "number" && Number.isSafeInteger(options.retentionDays) && options.retentionDays > 0 ? options.retentionDays : null;
    this.recentLimit = positiveLimit(options.recentLimit, ACCOUNTING_DEFAULT_RECENT_ROWS, ACCOUNTING_MAX_RECENT_ROWS);
    this.detailLimit = positiveLimit(options.detailLimit, ACCOUNTING_DEFAULT_DETAIL_ROWS, ACCOUNTING_MAX_RECENT_ROWS);
    this.dedupLimit = positiveLimit(options.dedupLimit, ACCOUNTING_MAX_DEDUP_IDS, ACCOUNTING_MAX_DEDUP_IDS);
    this.readDaysCap = positiveLimit(options.readDaysCap, ACCOUNTING_MAX_READ_DAYS, ACCOUNTING_MAX_READ_DAYS);
    this.knownDaysCap = this.readDaysCap;
    this.pendingRequestLimit = positiveLimit(options.pendingRequestLimit, ACCOUNTING_MAX_PENDING_REQUESTS, ACCOUNTING_MAX_PENDING_REQUESTS);
    this.pendingAttemptLimit = positiveLimit(options.pendingAttemptLimit, ACCOUNTING_MAX_PENDING_ATTEMPTS_PER_REQUEST, ACCOUNTING_MAX_PENDING_ATTEMPTS_PER_REQUEST);
    this.now = options.now ?? (() => Date.now());
    this.readOnly = options.readOnly === true;
    this.io = createSnapshotJournalIo({
      rootDir: this.directory,
      targets: [LIFETIME_TARGET, RECENT_TARGET],
      acceptTarget: dayTarget,
      maxFileBytes: ACCOUNTING_MAX_FILE_BYTES,
      maxJournalBytes: SNAPSHOT_IO_HARD_MAX_JOURNAL_BYTES,
      maxTargets: 128,
      ...(options.ioHooks === undefined ? {} : { hooks: options.ioHooks }),
    });
    // A read-only store never takes the writer lease and never replays or quarantines
    // anything — every one of those is a write against a directory a live relay may be
    // committing to. It observes committed snapshots only; unflushed in-memory deltas of
    // the running process stay invisible, which the CLI reports as lag rather than repairing.
    if (this.readOnly) {
      this.writer = { status: "released", error: null, retryable: false };
      this.last = result("none", null, false, false);
      this.loadFixedSnapshotsReadOnly();
      return;
    }
    this.writer = this.io.acquireWriter();
    if (this.writer.status === "acquired") this.recoverAndLoad();
    else {
      this.last = result("failed", this.writer.error ?? "writer-busy", this.writer.retryable);
      this.markGlobalLoss("unknown", "truncated", "writer");
    }
  }

  get closed(): boolean { return this._closed; }
  get writerStatus(): SnapshotWriterResult { return this.writer; }
  get lastWrite(): SnapshotMutationResult | null { return this.last; }
  reader(): AccountingReader { return this; }

  record(event: AccountingEvent): void {
    if (this._closed || event === null || typeof event !== "object") return;
    try {
      if (event.type === "request-started") this.onRequestStarted(event);
      else if (event.type === "attempt-started") this.onAttemptStarted(event);
      else if (event.type === "attempt-completed") this.onAttemptCompleted(event);
      else if (event.type === "request-completed") this.onRequestCompleted(event);
    } catch {
      this.markGlobalLoss("unknown", "truncated", "event");
    }
  }

  flush(): SnapshotMutationResult {
    if (this._closed) return result("invalid", "closed");
    // Read-only: flushing is a write. Nothing is ever dirty here anyway because no
    // record path runs; keep the answer explicit rather than relying on that accident.
    if (this.readOnly) return result("none", null, false, false);
    this.timer.clear();
    this.clearRetry();
    if (this.writer.status !== "acquired") return this.setLast(result("failed", this.writer.error ?? "writer-busy", this.writer.retryable));
    const recovered = this.io.recover();
    if (recovered.status === "failed" || recovered.status === "invalid") return this.fail(recovered);
    if (this.fixedLoadPending) {
      this.recoverAndLoad();
      if (this.fixedLoadPending) return this.last ?? result("failed", "snapshot-read", true, this.lowerBoundLoss);
    }
    if (recovered.lowerBoundLoss || recovered.status === "recovery-loss") this.consumeRecoveryLoss(recovered);
    if (recovered.status === "recovered" && this.pendingRetentionPlan !== null) {
      // Never replace current memory with the journal's saved lifetime: records
      // may have arrived after the failed retention write.  Reconcile only the
      // durable pruning effects, then let the ordinary fact commit persist any
      // newer in-memory facts.
      this.reconcileRecoveredRetention(this.pendingRetentionPlan);
    }
    this.drainQueued();
    if (this.queued.length > 0) return this.fail(result("failed", "day-read", true, this.lowerBoundLoss));
    if (this.dirtyDays.size === 0 && !this.dirtyLifetime && !this.dirtyRecent) {
      return this.commitRetention([]) ?? this.setLast(result("none", null, false, this.lowerBoundLoss));
    }
    if (this.dirtyDays.size + 2 > (this.io.maxTargets ?? 0)) return this.fail(result("invalid", "transaction-targets", false, this.lowerBoundLoss));
    const snapshots = this.factSnapshots();
    if (snapshots === null) return this.fail(result("invalid", "schema-or-size", false, this.lowerBoundLoss));
    const committedDates = [...this.dirtyDays];
    const written = this.io.commit(snapshots);
    this.last = written;
    if (written.status !== "committed" && written.status !== "recovered") return this.fail(written);
    this.dirtyDays.clear();
    this.dirtyLifetime = false;
    this.dirtyRecent = false;
    if (Object.hasOwn(snapshots, LIFETIME_TARGET)) this.lifetimeReadState = "ok";
    if (Object.hasOwn(snapshots, RECENT_TARGET)) this.recentReadState = "ok";
    this.retryDelay = RETRY_MIN_MS;
    const retention = this.commitRetention(committedDates);
    // A write-loaded shard stays outside the clean cache until this commit has
    // made it durable. Re-admit it now, or evict it if every cache slot is
    // still protected by dirty/in-flight facts.
    for (const date of [...committedDates].sort()) this.rememberKnownDay(date);
    return retention ?? written;
  }

  close(): SnapshotMutationResult {
    if (this._closed) return result("none");
    this.timer.clear();
    this.clearRetry();
    const flushed = this.flush();
    // Dirty facts and a recoverable journal still belong to this store. Keep
    // it open so a later close can retry instead of irreversibly discarding
    // the only in-process copy after one transient failure.
    if (flushed.retryable) return flushed;
    const closed = this.io.close();
    this._closed = closed.status === "closed";
    if (closed.status === "failed") return this.setLast(result("failed", closed.error, closed.retryable, flushed.lowerBoundLoss));
    return flushed;
  }

  readDay(date: string): AccountingReadResult<AccountingDayShard> {
    if (!validDate(date)) return { status: "corrupt", value: null, error: "date" };
    const cached = this.days.get(date);
    if (cached !== undefined) {
      const parsed = parsedDay(cached);
      return parsed === null ? { status: "corrupt", value: null, error: "schema" } : { status: "ok", value: this.withDayLoss(parsed) };
    }
    // Quarantine renames a file; an out-of-process reader reports corruption instead of
    // touching a shard a live relay may be about to rewrite.
    const read = this.io.readJson(targetForDay(date), (value): value is AccountingDayShard => parseAccountingDayShardV1(value).ok, { quarantineCorrupt: !this.readOnly });
    if (read.status === "missing") return { status: "missing", value: null };
    if (read.status !== "ok" || read.value === null) return { status: "corrupt", value: null, error: read.error ?? read.status };
    const parsed = parseAccountingDayShardV1(read.value);
    if (!parsed.ok) return { status: "corrupt", value: null, error: "schema" };
    this.days.set(date, mutableDay(parsed.value));
    this.rememberKnownDay(date);
    return { status: "ok", value: this.withDayLoss(parsed.value) };
  }

  readDays(dates: readonly string[], options?: { readonly cap?: number }): AccountingDaysRead;
  readDays(from: string, to: string, options?: { readonly cap?: number }): AccountingDaysRead;
  readDays(datesOrFrom: readonly string[] | string, toOrOptions?: string | { readonly cap?: number }, maybeOptions?: { readonly cap?: number }): AccountingDaysRead {
    const options = typeof toOrOptions === "object" ? toOrOptions : maybeOptions;
    const cap = positiveLimit(options?.cap, this.readDaysCap, this.readDaysCap);
    let dates: string[];
    let capped = false;
    if (Array.isArray(datesOrFrom)) {
      const length = Math.min(datesOrFrom.length, cap);
      dates = new Array<string>(length);
      for (let index = 0; index < length; index += 1) dates[index] = datesOrFrom[index]!;
      capped = datesOrFrom.length > cap;
    }
    else if (typeof toOrOptions === "string" && validDate(datesOrFrom) && validDate(toOrOptions)) {
      dates = [];
      for (let at = Date.parse(`${datesOrFrom}T00:00:00.000Z`), end = Date.parse(`${toOrOptions}T00:00:00.000Z`); at <= end; at += 86_400_000) {
        if (dates.length >= cap) { capped = true; break; }
        dates.push(new Date(at).toISOString().slice(0, 10));
      }
    } else dates = [typeof datesOrFrom === "string" ? datesOrFrom : ""];
    const results = dates.map((date) => ({ date, result: this.readDay(date) }));
    const days = results.flatMap((entry) => entry.result.status === "ok" ? [entry.result.value] : []);
    const missingDates = results.filter((entry) => entry.result.status === "missing").map((entry) => entry.date);
    const corruptDates = results.filter((entry) => entry.result.status === "corrupt").map((entry) => entry.date);
    const status: AccountingDaysRead["status"] = capped ? "capped" : corruptDates.length > 0 ? "corrupt" : missingDates.length > 0 ? "missing" : "ok";
    return frozenClone({ status, days, results, missingDates, corruptDates, capped });
  }

  readLifetime(): AccountingReadResult<AccountingLifetime> {
    if (this.lifetimeReadState === "missing" && !this.dirtyLifetime) return { status: "missing", value: null };
    if (this.lifetimeReadState === "corrupt" && !this.dirtyLifetime) return { status: "corrupt", value: null, error: "snapshot" };
    const parsed = parsedLifetime(this.lifetime);
    return parsed === null ? { status: "corrupt", value: null, error: "schema" } : { status: "ok", value: this.withLifetimeLoss(parsed) };
  }

  readRecent(options?: { readonly limit?: number } | number): AccountingReadResult<readonly AccountingRequestPacket[]> {
    if (this.recentReadState === "missing" && !this.dirtyRecent) return { status: "missing", value: null };
    if (this.recentReadState === "corrupt" && !this.dirtyRecent) return { status: "corrupt", value: null, error: "snapshot" };
    const parsed = parsedRecent(this.recent);
    if (parsed === null) return { status: "corrupt", value: null, error: "schema" };
    const requested = typeof options === "number" ? options : options?.limit;
    // Unlike the constructor options, an EXPLICIT read limit is honoured exactly:
    // 0 asks for zero rows, and only an omitted limit falls back to the default.
    const limit = typeof requested === "number" && Number.isSafeInteger(requested)
      ? Math.min(Math.max(requested, 0), this.recentLimit)
      : this.recentLimit;
    return { status: "ok", value: frozenClone(parsed.rows.slice(0, limit)) };
  }

  readDetail(requestId: string): AccountingReadResult<AccountingRequestPacket> {
    if (!DASHBOARD_REQUEST_ID_PATTERN.test(requestId)) return { status: "missing", value: null };
    if (this.fixedLoadPending || (this.recentReadState === "corrupt" && !this.dirtyRecent)) {
      return { status: "corrupt", value: null, error: "snapshot" };
    }
    if (this.recentReadState === "missing" && !this.dirtyRecent) return { status: "missing", value: null };
    const parsed = parsedRecent(this.recent);
    if (parsed === null) return { status: "corrupt", value: null, error: "schema" };
    const packet = parsed.details[requestId];
    return packet === undefined ? { status: "missing", value: null } : { status: "ok", value: frozenClone(packet) };
  }

  /**
   * Local usage for one credential in the CURRENT period — the `localUsed` half of spec §5.1
   * rung 2. Reads ONLY in-memory state and never touches disk:
   *
   * - minute/day → this process's in-memory day shard (`this.days`, which holds today's shard
   *   once any terminal request has been applied; a shard evicted from the read cache or not yet
   *   reloaded after restart is invisible ⇒ null, never 0).
   * - month → in-memory lifetime months only. Reading 31 day shards would put disk IO on the
   *   availability path, so a month whose rollup was dropped by ACCOUNTING_MAX_MONTHS reports
   *   null rather than a partial sum.
   *
   * Included: every TERMINAL event already applied to memory, including ones still awaiting the
   * write-behind flush. NOT included: in-flight requests that have not completed, and anything
   * recorded before this store instance loaded. Tokens are reported input+output when every
   * measured request carried a provider report, estimated-only otherwise; a window holding both
   * bases reports NO number (`basis: "mixed"`, tokens null) — see usageReading. An uncertain cell
   * poisons its whole side instead of being silently dropped from the sum.
   */
  usedInWindow(options: UsedInWindowOptions): UsedInWindowReading {
    const at = options.now ?? Date.now();
    if (!Number.isFinite(at)) return USED_WINDOW_EMPTY;
    const iso = new Date(at).toISOString();
    const date = iso.slice(0, 10);
    const minute = iso.slice(11, 16);
    const model = options.model ?? null;

    let requests: number | null = null;
    const reported = newUsageSide();
    const estimated = newUsageSide();
    // True when at least one counted request carried ONLY estimated tokens — the case that turns
    // a reported figure into an understatement and forces basis "mixed" with no value.
    let estimatedOnlyRequest = false;

    if (options.period !== "month") {
      // Request rows carry kind "request"; their aggregate counts requests exactly once per row.
      const day = this.days.get(date);
      if (day !== undefined) {
        // Both sides are bare HH:MM strings, so lexicographic order is chronological. The day
        // shard only contains THIS date's cells; the bound just drops clock-skewed future ones.
        const minuteKeys =
          options.period === "minute" ? [minute] : Object.keys(day.cells).filter((cellMinute) => cellMinute <= minute);
        let total = 0;
        for (const cellMinute of minuteKeys) {
          const cell = day.cells[cellMinute];
          if (cell === undefined) continue;
          for (const row of cell.rows) {
            if (row.kind !== "request" || row.credentialId !== options.credentialId) continue;
            // Unattributable traffic cannot be claimed by a named credential; a model filter
            // narrows further when given.
            if (row.credentialId === null || (model !== null && row.model !== model)) continue;
            total += windowCounter(row.requests);
            const reportedMeasured = noteUsageTokens(reported, row.requestTokens.reported.reportedInput, row.requestTokens.reported.reportedOutput);
            const estimatedMeasured = noteUsageTokens(estimated, row.requestTokens.estimated.estimatedInput, row.requestTokens.estimated.estimatedOutput);
            if (!reportedMeasured && estimatedMeasured) estimatedOnlyRequest = true;
          }
        }
        if (total > 0) requests = total;
      }
    } else {
      // The lifetime month rollup carries ROOT aggregates across ALL credentials — it cannot be
      // narrowed to one slot. Feeding it to a per-credential rung-2 subtraction would charge every
      // key's traffic to the one credential whose ceiling is being resolved, so BOTH figures
      // decline until the rollup is per-credential: requests as well as tokens. A whole-relay
      // count on a per-slot row is not "exact with stated scope" — the wire row has no scope
      // marker to state it with, and a reader cannot tell. Null is the honest reading here; same
      // fail-safe direction as everywhere else in this method.
      return USED_WINDOW_EMPTY;
    }

    return usageReading(requests, reported, estimated, estimatedOnlyRequest);
  }

  /** Read paths may touch arbitrary dates; retain only a deterministic bounded hint. */
  private rememberKnownDay(date: string): void {
    if (!this.days.has(date) || this.knownDays.has(date) || this.knownDaysCap < 1) return;
    while (this.knownDays.size >= this.knownDaysCap) {
      let evicted = false;
      for (const candidate of this.knownDays) {
        if (this.dirtyDays.has(candidate) || this.hasPendingDay(candidate)) continue;
        this.knownDays.delete(candidate);
        this.days.delete(candidate);
        evicted = true;
        break;
      }
      if (!evicted) {
        // Cache pressure may never discard a fact that is dirty or still has
        // in-flight work. Those states are independently bounded by the
        // transaction and pending-work caps; only a clean, unprotected read
        // cache entry may be dropped here.
        if (!this.dirtyDays.has(date) && !this.hasPendingDay(date)) this.days.delete(date);
        return;
      }
    }
    this.knownDays.add(date);
  }

  private hasPendingDay(date: string): boolean {
    for (const work of this.queued) if (dayFor(work.event.endedAt) === date) return true;
    for (const pending of this.pending.values()) {
      if (pending.started !== null && dayFor(pending.started.startedAt) === date) return true;
      for (const attempt of pending.startedAttempts.values()) if (dayFor(attempt.startedAt) === date) return true;
      for (const attempt of pending.attempts.values()) {
        if (dayFor(attempt.startedAt) === date || dayFor(attempt.endedAt) === date) return true;
      }
    }
    return false;
  }

  private onRequestStarted(event: RequestStartedEvent): void {
    if (!DASHBOARD_REQUEST_ID_PATTERN.test(event.requestId) || !validTimestamp(event.startedAt)) return;
    const pending = this.ensurePending(event.requestId);
    if (pending !== null) pending.started ??= event;
  }

  private onAttemptStarted(event: AttemptStartedEvent): void {
    if (!DASHBOARD_REQUEST_ID_PATTERN.test(event.requestId) || !isDashboardAttemptId(event.attemptId) || !validTimestamp(event.startedAt)) return;
    const pending = this.ensurePending(event.requestId);
    if (pending === null || pending.attempts.has(event.attemptId) || pending.startedAttempts.has(event.attemptId)) return;
    if (pending.startedAttempts.size >= this.pendingAttemptLimit) {
      this.markGlobalLoss("detail_cap", "truncated", "pending_attempt_starts");
      return;
    }
    pending.startedAttempts.set(event.attemptId, event);
  }

  private onAttemptCompleted(event: AttemptCompletedEvent): void {
    const attempt = makeAttempt(event);
    if (attempt === null) {
      // A packet that fails validation is a measurement quietly disappearing
      // unless the loss is announced like every other drop path.
      this.markGlobalLoss("unknown", "truncated", "attempt_packet");
      return;
    }
    const pending = this.ensurePending(event.requestId);
    if (pending === null) return;
    pending.startedAttempts.delete(attempt.attemptId);
    if (pending.attempts.has(attempt.attemptId)) return;
    if (pending.attempts.size >= this.pendingAttemptLimit) {
      increase(pending as unknown as Record<string, number>, "droppedAttempts");
      this.markGlobalLoss("unknown", "truncated", "pending_attempts");
      return;
    }
    pending.attempts.set(attempt.attemptId, attempt);
  }

  private onRequestCompleted(event: RequestCompletedEvent): void {
    if (!DASHBOARD_REQUEST_ID_PATTERN.test(event.requestId) || !validTimestamp(event.endedAt)) return;
    const pending = this.pending.get(event.requestId) ?? null;
    this.pending.delete(event.requestId);
    const work: TerminalWork = { event, pending };
    if (!this.fixedLoadPending && this.applyTerminal(work)) return;
    if (this.queued.length >= this.pendingRequestLimit) {
      this.markGlobalLoss("unknown", "truncated", "pending_terminals");
      return;
    }
    this.queued.push(work);
  }

  private ensurePending(requestId: string): PendingRequest | null {
    const existing = this.pending.get(requestId);
    if (existing !== undefined) return existing;
    if (this.pending.size >= this.pendingRequestLimit) {
      // Evict the OLDEST-STARTED in-flight request, not merely the first
      // inserted: parallel subagent streams do not start in insertion order.
      // An entry whose start event has not arrived carries the least identity,
      // so it is treated as older than every dated entry.
      let victim: string | null = null;
      let victimStartedAt: string | null = null;
      for (const [key, entry] of this.pending) {
        const startedAt = entry.started?.startedAt ?? null;
        if (victim === null || startedAt === null || (victimStartedAt !== null && startedAt < victimStartedAt)) {
          victim = key;
          victimStartedAt = startedAt;
        }
      }
      if (victim !== null) this.pending.delete(victim);
      this.markGlobalLoss("unknown", "truncated", "pending_requests");
    }
    if (this.pending.size >= this.pendingRequestLimit) return null;
    const created: PendingRequest = { started: null, attempts: new Map(), startedAttempts: new Map(), droppedAttempts: 0 };
    this.pending.set(requestId, created);
    return created;
  }

  private drainQueued(): void {
    if (this.fixedLoadPending || this.queued.length === 0) return;
    const pending = this.queued.splice(0);
    for (const work of pending) if (!this.applyTerminal(work)) this.queued.push(work);
  }

  private applyTerminal(work: TerminalWork): boolean {
    if (this.fixedLoadPending) return false;
    const date = dayFor(work.event.endedAt);
    if (date === null || !this.ensureTransactionRoom(date)) return false;
    const day = this.loadDayForWrite(date);
    if (day === null) return false;
    if (dedupSet(day).has(work.event.requestId)) {
      this.rememberKnownDay(date);
      return true;
    }
    const attempts = sortedAttempts(work.pending?.attempts.values() ?? []);
    const packet = this.packetFor(work.event, work.pending, attempts);
    const outcome = safeOutcome(work.event.outcome);
    const failureKind = safeFailure(work.event.failureKind, outcome);
    const cell = cellFor(day, work.event.endedAt);
    if (cell === null) {
      this.rememberKnownDay(date);
      return true;
    }
    const rowBudget: DayRowBudget = {
      remaining: Math.max(0, ACCOUNTING_MAX_DAY_ROWS - countDayRows(day)),
    };
    const droppedRowsBefore = cell.coverage.droppedRows;
    const client = safeId(work.pending?.started?.client);
    let exact = addRequest(cell.aggregate, work.event, outcome);
    const requestRow = findRow(cell, {
      kind: "request",
      role: "request",
      provider: packet?.provider ?? safeId(work.event.provider),
      model: packet?.model ?? safeId(work.event.model),
      client,
      credentialId: packet?.credentialId ?? safeId(work.event.credentialId),
      attribution: packet?.attribution ?? safeAttribution(work.event.attribution),
      outcome,
      failureKind,
    }, rowBudget);
    if (requestRow !== null) exact &&= addRequest(requestRow, work.event, outcome);
    for (const attempt of attempts) {
      exact &&= addRootAttempt(cell.aggregate, attempt);
      const attemptRow = findRow(cell, {
        kind: "attempt",
        role: attempt.role,
        provider: attempt.provider,
        model: attempt.model,
        client,
        credentialId: attempt.credentialId,
        attribution: attempt.attribution,
        outcome: attempt.outcome,
        failureKind: attempt.failureKind,
      }, rowBudget);
      if (attemptRow !== null) exact &&= addAttempt(attemptRow, attempt);
    }
    this.addLifetime(work.event, outcome, attempts, work.pending?.started?.startedAt ?? null);
    this.revisitLateRetentionDate(date);
    const droppedRows = Math.max(0, cell.coverage.droppedRows - droppedRowsBefore);
    if (droppedRows > 0) this.propagateRowCap(day, work.event.endedAt, droppedRows);
    if (packet !== null) this.addRecent(packet);
    else this.markGlobalLoss("unknown", "truncated", "detail_packet");
    if (!this.addDedup(day, work.event.requestId)) this.markGlobalLoss("dedup_cap", "dedup", "dedup");
    if ((work.pending?.droppedAttempts ?? 0) > 0) this.markGlobalLoss("unknown", "truncated", "pending_attempts", work.pending?.droppedAttempts ?? 0);
    if (!exact) {
      markCoverage(day.coverage, "counter_overflow", "overflow", "counters");
      markCoverage(this.lifetime.coverage, "counter_overflow", "overflow", "counters");
    }
    this.dirtyDays.add(date);
    this.knownDays.delete(date);
    this.dirtyLifetime = true;
    this.dirtyRecent = true;
    this.scheduleFlush();
    return true;
  }

  private propagateRowCap(day: MutableDay, endedAt: string, count: number): void {
    markDroppedRows(day.coverage, count);
    markDroppedRows(this.lifetime.coverage, count);
    const month = monthFor(endedAt);
    if (month === null) return;
    const target = this.lifetime.months[month];
    if (target !== undefined) markDroppedRows(target.coverage, count);
  }

  private packetFor(event: RequestCompletedEvent, pending: PendingRequest | null, allAttempts: readonly AccountingAttemptPacketV1[]): AccountingRequestPacket | null {
    const startedAt = pending?.started?.startedAt;
    if (startedAt === undefined || !validTimestamp(startedAt) || startedAt > event.endedAt) return null;
    const declared = Math.min(safeCounter(event.attemptCount) ?? 0, ACCOUNTING_MAX_PACKET_ATTEMPTS);
    const total = Math.max(declared, Math.min(allAttempts.length, ACCOUNTING_MAX_PACKET_ATTEMPTS));
    const byId = new Map(allAttempts.map((attempt) => [attempt.attemptId, attempt]));
    const winner = event.winningAttemptId === null ? undefined : byId.get(event.winningAttemptId);
    const committed = event.commitAttemptId === null ? undefined : byId.get(event.commitAttemptId);
    const forced = new Set<string>();
    if (winner !== undefined) forced.add(winner.attemptId);
    if (committed !== undefined) forced.add(committed.attemptId);
    const retained = allAttempts.filter((attempt) => forced.has(attempt.attemptId));
    for (const attempt of allAttempts) {
      if (retained.length >= ACCOUNTING_MAX_DETAIL_ATTEMPTS) break;
      if (!forced.has(attempt.attemptId)) retained.push(attempt);
    }
    retained.sort((left, right) => left.startedAt === right.startedAt ? left.attemptId.localeCompare(right.attemptId) : left.startedAt.localeCompare(right.startedAt));
    if (retained.length > total) retained.splice(total);
    const outcome = safeOutcome(event.outcome);
    const winnerPresent = event.winningAttemptId === null || retained.some((attempt) => attempt.attemptId === event.winningAttemptId);
    const commitPresent = event.commitAttemptId === null || retained.some((attempt) => attempt.attemptId === event.commitAttemptId);
    if (!winnerPresent || !commitPresent || (outcome === "success" && winner === undefined)) return null;
    const authoritative = winner ?? committed;
    const value = {
      requestId: event.requestId,
      startedAt,
      endedAt: event.endedAt,
      client: safeId(pending?.started?.client),
      attribution: authoritative?.attribution ?? safeAttribution(event.attribution),
      outcome,
      failureKind: safeFailure(event.failureKind, outcome),
      attemptCount: total,
      repairIncluded: event.repairIncluded === true,
      winningAttemptId: winner?.attemptId ?? null,
      commitAttemptId: committed?.attemptId ?? null,
      latencyMs: safeCounter(event.latencyMs),
      commitMs: committed?.commitMs ?? null,
      provider: authoritative?.provider ?? safeId(event.provider),
      model: authoritative?.model ?? safeId(event.model),
      credentialId: authoritative?.credentialId ?? safeId(event.credentialId),
      tokens: authoritative?.tokens ?? tokenSnapshot(event.tokens, event.endedAt),
      // The WINNING serve's spend mirrors its tokens. Repair spend stays on the
      // repair attempt rows (C1) so a later roll-up can add it back exactly once.
      spend: authoritative?.spend ?? null,
      attempts: retained,
      attemptMetadata: { total, stored: retained.length, dropped: total - retained.length },
    } satisfies AccountingRequestPacket;
    const parsed = parseAccountingRequestPacketV1(value);
    return parsed.ok ? parsed.value : null;
  }

  private addLifetime(
    event: RequestCompletedEvent,
    outcome: AccountingOutcome,
    attempts: readonly AccountingAttemptPacketV1[],
    requestStartedAt: string | null,
  ): void {
    let exact = addRequest(this.lifetime.aggregate, event, outcome);
    for (const attempt of attempts) exact &&= addRootAttempt(this.lifetime.aggregate, attempt);
    const firstAt = requestStartedAt !== null && validTimestamp(requestStartedAt) && requestStartedAt <= event.endedAt
      ? requestStartedAt
      : event.endedAt;
    this.lifetime.firstRequestAt = earlier(this.lifetime.firstRequestAt, firstAt);
    this.lifetime.lastRequestAt = latest(this.lifetime.lastRequestAt, event.endedAt);
    const month = monthFor(event.endedAt);
    if (month !== null) {
      let target = this.lifetime.months[month];
      if (target === undefined && Object.keys(this.lifetime.months).length < ACCOUNTING_MAX_MONTHS) {
        target = { month, aggregate: emptyAggregate(), coverage: emptyCoverage() };
        this.lifetime.months[month] = target;
      }
      if (target === undefined) markCoverage(this.lifetime.coverage, "unknown", "truncated", "months");
      else {
        exact &&= addRequest(target.aggregate, event, outcome);
        for (const attempt of attempts) exact &&= addRootAttempt(target.aggregate, attempt);
      }
    }
    if (!exact) markCoverage(this.lifetime.coverage, "counter_overflow", "overflow", "counters");
  }

  private addRecent(packet: AccountingRequestPacket): void {
    this.recent.rows = this.recent.rows.filter((row) => row.requestId !== packet.requestId);
    this.recent.rows.push(packet);
    this.recent.rows.sort((left, right) => left.endedAt === right.endedAt ? right.requestId.localeCompare(left.requestId) : right.endedAt.localeCompare(left.endedAt));
    while (this.recent.rows.length > this.recentLimit) {
      const dropped = this.recent.rows.pop();
      if (dropped !== undefined) {
        increase(this.recent.coverage as unknown as Record<string, number>, "droppedRecent");
        markCoverage(this.recent.coverage, "detail_cap", "truncated", "recent");
      }
    }
    this.recent.details[packet.requestId] = packet;
    const active = new Set(this.recent.rows.map((row) => row.requestId));
    for (const requestId of Object.keys(this.recent.details)) {
      if (active.has(requestId)) continue;
      delete this.recent.details[requestId];
      increase(this.recent.coverage as unknown as Record<string, number>, "droppedDetails");
      markCoverage(this.recent.coverage, "detail_cap", "truncated", "details");
    }
    while (Object.keys(this.recent.details).length > this.detailLimit) {
      const oldest = [...this.recent.rows].reverse().find((row) => this.recent.details[row.requestId] !== undefined);
      if (oldest === undefined) break;
      delete this.recent.details[oldest.requestId];
      increase(this.recent.coverage as unknown as Record<string, number>, "droppedDetails");
      markCoverage(this.recent.coverage, "detail_cap", "truncated", "details");
    }
  }

  private addDedup(day: MutableDay, requestId: string): boolean {
    const ids = dedupSet(day);
    if (ids.has(requestId)) return true;
    if (day.dedup.requestIds.length >= this.dedupLimit) {
      increase(day.dedup as unknown as Record<string, number>, "dropped");
      day.dedup.complete = false;
      increase(day.coverage as unknown as Record<string, number>, "droppedDedup");
      markCoverage(day.coverage, "dedup_cap", "dedup", "dedup");
      return false;
    }
    day.dedup.requestIds.push(requestId);
    day.dedup.requestIds.sort();
    ids.add(requestId);
    return true;
  }

  /** Keep a fact transaction within the journal's bounded target set. */
  private ensureTransactionRoom(date: string): boolean {
    if (this.dirtyDays.has(date)) return true;
    const maximum = this.io.maxTargets;
    if (maximum === null || maximum < 3) return false;
    if (this.dirtyDays.size + 3 <= maximum) return true;

    // A terminal request owns a day + lifetime + recent atomically.  Commit the
    // previous bounded batch before accepting a new day rather than allowing an
    // unrepresentable journal transaction to accumulate.
    const flushed = this.flush();
    return (flushed.status === "committed" || flushed.status === "recovered" || flushed.status === "none")
      && this.dirtyDays.size + 3 <= maximum;
  }

  /** Read one named day through the namespace-restricted journal I/O only. */
  private loadDayForWrite(date: string): MutableDay | null {
    const cached = this.days.get(date);
    if (cached !== undefined) return cached;
    const read = this.io.readJson(
      targetForDay(date),
      (value): value is AccountingDayShard => parseAccountingDayShardV1(value).ok,
      { quarantineCorrupt: true },
    );
    if (read.status === "missing") {
      const created = emptyDay(date);
      this.days.set(date, created);
      return created;
    }
    if (read.status !== "ok" || read.value === null) {
      // A quarantined day is intentionally restarted as a lower bound on the
      // next queued pass.  A transient read failure remains queued and cannot
      // overwrite an unreadable existing shard.
      if (read.status === "corrupt" || read.status === "oversize") {
        this.markGlobalLoss("corrupt_recovery", "corrupt", "day");
      }
      return null;
    }
    const parsed = parseAccountingDayShardV1(read.value);
    if (!parsed.ok) {
      this.markGlobalLoss("corrupt_recovery", "corrupt", "day");
      return null;
    }
    const mutable = mutableDay(parsed.value);
    this.days.set(date, mutable);
    return mutable;
  }

  /** Keep unread fixed snapshots immutable until a retry has loaded both safely. */
  private deferFixedLoad(value: SnapshotMutationResult): void {
    this.fixedLoadPending = true;
    this.lifetimeReadState = "corrupt";
    this.recentReadState = "corrupt";
    this.last = value;
    if (value.retryable) this.scheduleRetry();
  }

  private flushDeferredGlobalLosses(): void {
    const losses = this.deferredGlobalLosses.splice(0);
    for (const loss of losses) this.markGlobalLoss(loss.reason, loss.kind, loss.field, loss.count);
  }

  /**
   * Read-only constructor load: read the two fixed snapshots WITHOUT the writer lease and
   * without any recovery/quarantine write. A corrupt or unreadable snapshot stays corrupt
   * (reported by `readLifetime`/`readRecent`) rather than being renamed aside. Day shards
   * are deliberately NOT preloaded — `readDay` reads them on demand through the same
   * no-write readJson path.
   */
  private loadFixedSnapshotsReadOnly(): void {
    const lifetime = this.io.readJson(
      LIFETIME_TARGET,
      (value): value is AccountingLifetime => parseAccountingLifetimeV1(value).ok,
      { quarantineCorrupt: false },
    );
    this.lifetimeReadState = lifetime.status === "ok" && lifetime.value !== null
      ? "ok"
      : lifetime.status === "missing" ? "missing" : "corrupt";
    if (this.lifetimeReadState === "ok") this.lifetime = mutableLifetime(lifetime.value!);

    const recent = this.io.readJson(
      RECENT_TARGET,
      (value): value is AccountingRecentV1 => parseAccountingRecentV1(value).ok,
      { quarantineCorrupt: false },
    );
    this.recentReadState = recent.status === "ok" && recent.value !== null
      ? "ok"
      : recent.status === "missing" ? "missing" : "corrupt";
    if (this.recentReadState === "ok") this.recent = mutableRecent(recent.value!);
  }

  /** Recover a committed journal first, then load the two fixed snapshots. */
  private recoverAndLoad(): void {
    const recovered = this.io.recover();
    if (recovered.status === "failed" || recovered.status === "invalid") {
      this.pendingJournalLoss ||= recovered.lowerBoundLoss;
      this.deferFixedLoad(recovered);
      return;
    }

    let fixedLoss = false;
    let fixedReadFailed = false;
    const lifetime = this.io.readJson(
      LIFETIME_TARGET,
      (value): value is AccountingLifetime => parseAccountingLifetimeV1(value).ok,
      { quarantineCorrupt: true },
    );
    if (lifetime.status === "ok" && lifetime.value !== null) {
      const parsed = parseAccountingLifetimeV1(lifetime.value);
      if (parsed.ok) {
        this.lifetime = mutableLifetime(parsed.value);
        this.lifetimeReadState = "ok";
      } else {
        this.lifetimeReadState = "corrupt";
        fixedLoss = true;
      }
    } else if (lifetime.status === "missing") {
      this.lifetimeReadState = "missing";
    } else if (lifetime.status === "failed") {
      this.lifetimeReadState = "corrupt";
      fixedReadFailed = true;
    } else {
      this.lifetimeReadState = "corrupt";
      fixedLoss = true;
    }

    const recent = this.io.readJson(
      RECENT_TARGET,
      (value): value is AccountingRecentV1 => parseAccountingRecentV1(value).ok,
      { quarantineCorrupt: true },
    );
    if (recent.status === "ok" && recent.value !== null) {
      const parsed = parseAccountingRecentV1(recent.value);
      if (parsed.ok) {
        this.recent = mutableRecent(parsed.value);
        this.recentReadState = "ok";
      } else {
        this.recentReadState = "corrupt";
        fixedLoss = true;
      }
    } else if (recent.status === "missing") {
      this.recentReadState = "missing";
    } else if (recent.status === "failed") {
      this.recentReadState = "corrupt";
      fixedReadFailed = true;
    } else {
      this.recentReadState = "corrupt";
      fixedLoss = true;
    }

    if (fixedReadFailed) {
      this.pendingFixedLoss ||= fixedLoss;
      this.pendingJournalLoss ||= recovered.lowerBoundLoss || recovered.status === "recovery-loss";
      this.deferFixedLoad(result("failed", "snapshot-read", true, this.lowerBoundLoss || this.pendingJournalLoss));
      return;
    }
    fixedLoss ||= this.pendingFixedLoss;
    const journalLoss = this.pendingJournalLoss || recovered.lowerBoundLoss || recovered.status === "recovery-loss";
    this.pendingFixedLoss = false;
    this.pendingJournalLoss = false;
    this.fixedLoadPending = false;
    this.flushDeferredGlobalLosses();
    if (journalLoss) this.consumeRecoveryLoss(recovered);
    if (fixedLoss) this.markGlobalLoss("corrupt_recovery", "corrupt", "snapshot");
    this.seedTrustedDateFromLifetime();
    this.queueRecoveredRetention();
    this.last = recovered;
  }

  /** Validate every outgoing canonical object before handing it to the journal. */
  private factSnapshots(): Record<string, string> | null {
    const snapshots: Record<string, string> = {};
    const encode = (name: string, value: unknown): boolean => {
      let text: string;
      try {
        text = JSON.stringify(value);
      } catch {
        return false;
      }
      const ceiling = this.io.maxFileBytes;
      if (ceiling === null || Buffer.byteLength(text, "utf8") > ceiling) return false;
      snapshots[name] = text;
      return true;
    };

    if (this.dirtyLifetime) {
      const lifetime = parsedLifetime(this.lifetime);
      if (lifetime === null || !encode(LIFETIME_TARGET, lifetime)) return null;
    }
    if (this.dirtyRecent) {
      const recent = parsedRecent(this.recent);
      if (recent === null || !encode(RECENT_TARGET, recent)) return null;
    }
    for (const date of [...this.dirtyDays].sort()) {
      const day = this.days.get(date);
      const parsed = day === undefined ? null : parsedDay(day);
      if (parsed === null || !encode(targetForDay(date), parsed)) return null;
    }
    return snapshots;
  }

  /**
   * Retention never shares the fact transaction: a fact must be durable before
   * its day can become eligible for a tombstone transaction.
   */
  private commitRetention(committedDates: readonly string[]): SnapshotMutationResult | null {
    if (this.retentionDays === null) return null;
    // A clock that previously rolled back may have caught the durable frontier
    // since construction. Re-evaluate it on every flush, not only at startup.
    this.queueRecoveredRetention();
    const eligible = this.advanceTrustedDate(committedDates);
    if (eligible !== null) this.queueRetentionForDate(eligible);
    const cutoff = this.pendingRetention;
    if (cutoff === null) return null;

    // A recovered or already-completed transaction can leave a stale in-memory
    // intent, but it must not cause an endless no-op retry.
    if (!this.retentionNeedsWork(cutoff)) {
      this.pendingRetention = null;
      this.pendingRetentionPlan = null;
      return null;
    }

    const maximum = this.io.maxTargets;
    if (maximum === null || maximum < 1) return this.fail(result("invalid", "retention-targets", false, this.lowerBoundLoss));

    const current = parsedLifetime(this.lifetime);
    if (current === null) return this.fail(result("invalid", "lifetime-schema", false, this.lowerBoundLoss));
    const progress = validDate(current.coverage.retentionFrom) ? current.coverage.retentionFrom : null;
    const start = progress ?? dayFor(current.firstRequestAt ?? "");
    const retention = this.retentionCandidates(start, cutoff, Math.max(0, maximum - 1));
    const candidates = retention.dates;
    // One target is consumed by lifetime.  Do not claim retention can make
    // progress if a caller has configured no room for a tombstone at all.
    if (retention.truncated && candidates.length === 0) {
      return this.fail(result("invalid", "retention-targets", false, this.lowerBoundLoss));
    }

    const next = mutableLifetime(current);
    const lastCandidate = candidates.at(-1) ?? null;
    const advanced = lastCandidate === null ? null : nextDate(lastCandidate);
    // `retentionFrom` is the durable cursor: it may reach the policy cutoff
    // only once every bounded tombstone batch before it has committed.  This
    // lets a restarted store continue without discovering directory entries.
    next.coverage.retentionFrom = advanced ?? (retention.truncated
      ? progress
      : progress === null || progress < cutoff ? cutoff : progress);
    next.coverage.retentionDays = this.retentionDays;
    markCoverage(next.coverage, "retention_pruned", "truncated", "retention");
    if (retention.truncated) {
      markCoverage(next.coverage, "unknown", "truncated", "retention");
    }

    const plan: RetentionPlan = { cutoff, candidates, next, truncated: retention.truncated };

    const snapshots: Record<string, string | null> = {};
    const retainedLifetime = parsedLifetime(next);
    if (retainedLifetime === null) return this.fail(result("invalid", "retention-schema-or-size", false, this.lowerBoundLoss));
    const serialized = JSON.stringify(retainedLifetime);
    const ceiling = this.io.maxFileBytes;
    if (serialized === undefined || ceiling === null || Buffer.byteLength(serialized, "utf8") > ceiling) {
      return this.fail(result("invalid", "retention-schema-or-size", false, this.lowerBoundLoss));
    }
    snapshots[LIFETIME_TARGET] = serialized;
    for (const date of candidates) snapshots[targetForDay(date)] = null;

    this.pendingRetentionPlan = plan;
    const written = this.io.commit(snapshots);
    this.last = written;
    if (written.status !== "committed" && written.status !== "recovered") return this.fail(written);
    this.applyRetentionPlan(plan);
    this.pendingRetentionPlan = null;
    if (plan.truncated) {
      // A complete transaction can still have more bounded work.  This is a
      // continuation, not a dirty fact write, so wake it explicitly.
      this.pendingRetention = plan.cutoff;
      this.retryDelay = RETRY_MIN_MS;
      this.scheduleRetry();
    } else {
      this.pendingRetention = null;
    }
    return written;
  }

  /**
   * A restart cannot scan a directory to rediscover old shards.  The durable
   * lifetime lower date lets us name a bounded, deterministic tombstone range
   * instead; absent days are harmless no-op tombstones.
   */
  private retentionCandidates(start: string | null, cutoff: string, limit: number): { readonly dates: readonly string[]; readonly truncated: boolean } {
    const dates = new Set<string>();
    let truncated = false;
    const add = (date: string): boolean => {
      if (date >= cutoff || this.dirtyDays.has(date)) return true;
      if (dates.has(date)) return true;
      if (dates.size >= limit) {
        truncated = true;
        return false;
      }
      dates.add(date);
      return true;
    };

    if (start !== null && start < cutoff) {
      const end = Date.parse(`${cutoff}T00:00:00.000Z`);
      for (let at = Date.parse(`${start}T00:00:00.000Z`); at < end; at += 86_400_000) {
        if (!add(new Date(at).toISOString().slice(0, 10))) break;
      }
    }
    if (start === null) {
      // Only this bounded fallback needs ordering.  Normal retained data has a
      // lifetime first-request date, so it names its whole deterministic range
      // without retaining or sorting arbitrary read-path dates.
      for (const date of [...this.knownDays].sort()) add(date);
    }
    return { dates: [...dates].sort(), truncated };
  }

  /** Apply a retention transaction known to have committed in this process. */
  private applyRetentionPlan(plan: RetentionPlan): void {
    this.lifetime = plan.next;
    this.lifetimeReadState = "ok";
    for (const date of plan.candidates) {
      this.days.delete(date);
      this.knownDays.delete(date);
    }
  }

  /**
   * A retry may recover a durable retention journal after subsequent records
   * have already changed memory.  Merge only its coverage cursor and exact
   * tombstones; a later fact transaction writes the current aggregate rather
   * than replacing it with the journal's stale lifetime payload.
   */
  private reconcileRecoveredRetention(plan: RetentionPlan): void {
    this.pendingRetentionPlan = null;
    const current = parsedLifetime(this.lifetime);
    if (current === null) return;
    const next = mutableLifetime(current);
    const currentProgress = validDate(next.coverage.retentionFrom) ? next.coverage.retentionFrom : null;
    const recoveredProgress = validDate(plan.next.coverage.retentionFrom) ? plan.next.coverage.retentionFrom : null;
    if (recoveredProgress !== null && (currentProgress === null || recoveredProgress > currentProgress)) {
      next.coverage.retentionFrom = recoveredProgress;
    }
    next.coverage.retentionDays = this.retentionDays;
    markCoverage(next.coverage, "retention_pruned", "truncated", "retention");
    if (plan.truncated) markCoverage(next.coverage, "unknown", "truncated", "retention");
    this.lifetime = next;
    this.lifetimeReadState = "ok";
    // It is harmless to rewrite an unchanged lifetime once; doing so is what
    // makes the recovered durable state and any unflushed newer facts converge.
    this.dirtyLifetime = true;
    for (const date of plan.candidates) {
      if (this.dirtyDays.has(date)) continue;
      this.days.delete(date);
      this.knownDays.delete(date);
    }
    this.pendingRetention = plan.truncated ? plan.cutoff : null;
  }

  private retentionNeedsWork(cutoff: string): boolean {
    if (this.retentionDays === null || !validDate(cutoff)) return false;
    const current = parsedLifetime(this.lifetime);
    if (current === null) return true;
    const progress = validDate(current.coverage.retentionFrom) ? current.coverage.retentionFrom : null;
    return current.coverage.retentionDays !== this.retentionDays || progress === null || progress < cutoff;
  }

  /**
   * Backfilling a shard behind the durable cursor invalidates that cursor,
   * including after a wall-clock rollback. Rewind coverage in the fact
   * transaction, then queue pruning when the shard is already expired under
   * the current clock.
   */
  private revisitLateRetentionDate(date: string): void {
    if (this.retentionDays === null || !validDate(date)) return;
    const progress = validDate(this.lifetime.coverage.retentionFrom)
      ? this.lifetime.coverage.retentionFrom
      : null;
    if (progress === null || date >= progress) return;
    this.lifetime.coverage.retentionFrom = date;
    const nowDate = this.clockDate();
    const cutoff = nowDate === null ? null : this.retentionCutoff(nowDate);
    if (cutoff !== null && date < cutoff) this.pendingRetention = latest(this.pendingRetention, cutoff);
  }

  private queueRetentionForDate(date: string): void {
    const cutoff = this.retentionCutoff(date);
    if (cutoff === null || !this.retentionNeedsWork(cutoff)) return;
    this.pendingRetention = latest(this.pendingRetention, cutoff);
  }

  /**
   * `lastRequestAt` is durable evidence of the previous trusted frontier.  Do
   * not derive it from a retention cursor: a partial cursor merely says where a
   * tombstone batch stopped.  Keep a future frontier too, so a clock rollback
   * cannot let a late fact move retention backwards before the clock catches up.
   */
  private seedTrustedDateFromLifetime(): void {
    const last = dayFor(this.lifetime.lastRequestAt ?? "");
    if (last !== null) this.trustedDate = latest(this.trustedDate, last);
  }

  /** Resume an incomplete durable cursor only when its fact frontier is clock-eligible. */
  private queueRecoveredRetention(): void {
    if (this.retentionDays === null || this.trustedDate === null) return;
    const nowDate = this.clockDate();
    if (nowDate === null || this.trustedDate > nowDate) return;
    this.queueRetentionForDate(this.trustedDate);
  }

  /** A clock-gated, monotonic date: future and late facts cannot advance pruning. */
  private advanceTrustedDate(committedDates: readonly string[]): string | null {
    const nowDate = this.clockDate();
    if (nowDate === null) return null;
    let newest: string | null = null;
    for (const date of committedDates) {
      if (validDate(date) && date <= nowDate) newest = latest(newest, date);
    }
    if (newest === null || (this.trustedDate !== null && newest <= this.trustedDate)) return null;
    this.trustedDate = newest;
    return newest;
  }

  private clockDate(): string | null {
    try {
      const value = this.now();
      if (!Number.isFinite(value)) return null;
      return new Date(value).toISOString().slice(0, 10);
    } catch {
      return null;
    }
  }

  private retentionCutoff(date: string): string | null {
    if (this.retentionDays === null || !validDate(date)) return null;
    const at = Date.parse(`${date}T00:00:00.000Z`);
    const cutoff = new Date(at - (this.retentionDays - 1) * 86_400_000).toISOString().slice(0, 10);
    return validDate(cutoff) ? cutoff : null;
  }

  private consumeRecoveryLoss(_recovered: SnapshotMutationResult): void {
    if (this.lowerBoundLoss) return;
    this.lowerBoundLoss = true;
    this.markGlobalLoss("corrupt_recovery", "corrupt", "journal");
    this.scheduleFlush();
  }

  /** Record a loss where it can be surfaced without claiming an exact total. */
  private markGlobalLoss(
    reason: Exclude<AccountingCoverageReason, null>,
    kind: AccountingLossKind,
    field: string | null,
    count = 1,
  ): void {
    if (this.fixedLoadPending) {
      const existing = this.deferredGlobalLosses.find((loss) => loss.reason === reason && loss.kind === kind && loss.field === field);
      if (existing !== undefined) {
        if (!increase(existing as unknown as Record<string, number>, "count", count)) existing.count = Number.MAX_SAFE_INTEGER;
      } else if (this.deferredGlobalLosses.length < ACCOUNTING_MAX_LOSS_MARKERS) {
        this.deferredGlobalLosses.push({ reason, kind, field, count });
      } else {
        const summary = this.deferredGlobalLosses.find((loss) => loss.field === "deferred_loss");
        if (summary !== undefined) {
          if (!increase(summary as unknown as Record<string, number>, "count", count)) summary.count = Number.MAX_SAFE_INTEGER;
        } else {
          this.deferredGlobalLosses[this.deferredGlobalLosses.length - 1] = { reason: "unknown", kind: "truncated", field: "deferred_loss", count };
        }
      }
      return;
    }
    if (reason === "corrupt_recovery") this.lowerBoundLoss = true;
    markCoverage(this.lifetime.coverage, reason, kind, field, count);
    markCoverage(this.recent.coverage, reason, kind, field, count);
    this.dirtyLifetime = true;
    this.dirtyRecent = true;
  }

  private withDayLoss(value: AccountingDayShard): AccountingDayShard {
    if (!this.lowerBoundLoss) return frozenClone(value);
    const decorated = mutableDay(value);
    markCoverage(decorated.coverage, "corrupt_recovery", "corrupt", "journal");
    const parsed = parsedDay(decorated);
    return parsed === null ? frozenClone(value) : frozenClone(parsed);
  }

  private withLifetimeLoss(value: AccountingLifetime): AccountingLifetime {
    if (!this.lowerBoundLoss) return frozenClone(value);
    const decorated = mutableLifetime(value);
    markCoverage(decorated.coverage, "corrupt_recovery", "corrupt", "journal");
    const parsed = parsedLifetime(decorated);
    return parsed === null ? frozenClone(value) : frozenClone(parsed);
  }

  private scheduleFlush(): void {
    if (this._closed || this.writer.status !== "acquired") return;
    let now: number;
    try {
      now = this.now();
    } catch {
      now = Date.now();
    }
    this.timer.touch(() => { this.flush(); }, Number.isFinite(now) ? now : Date.now());
  }

  private scheduleRetry(): void {
    if (this._closed || this.retryTimer !== null || this.writer.status !== "acquired") return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(MAX_FLUSH_DELAY_MS, Math.max(RETRY_MIN_MS, this.retryDelay * 2));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flush();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private fail(value: SnapshotMutationResult): SnapshotMutationResult {
    this.last = value;
    if (value.retryable) this.scheduleRetry();
    return value;
  }

  private setLast(value: SnapshotMutationResult): SnapshotMutationResult {
    this.last = value;
    return value;
  }
}

/** Accounting shares the common write-behind cadence, exported for callers/tests. */
export const ACCOUNTING_FLUSH_DELAY_MS = DEFAULT_FLUSH_DELAY_MS;
export const ACCOUNTING_MAX_FLUSH_DELAY_MS = MAX_FLUSH_DELAY_MS;

export function createAccountingStore(options: AccountingStoreOptions = {}): AccountingStore {
  return new AccountingStoreImpl(options);
}
