/**
 * Bounded, side-effect-free dashboard read projection.
 *
 * This module deliberately knows only the persisted accounting read model.  It
 * neither owns the store nor reaches into live provider/circuit-breaker state:
 * quota and cooldown facts are injected as one already-captured snapshot.
 */
import type { AccountingReader } from "./accounting-store.js";
import {
  parseAccountingDayShardV1,
  parseAccountingLifetimeV1,
  parseAccountingRequestPacketV1,
  type AccountingAggregateSpendCellV1,
  type AccountingAggregateSpendV1,
  type AccountingAggregateTokenCellV1,
  type AccountingAggregateTokenTotalsV1,
  type AccountingAggregateV1,
  type AccountingCoverageV1,
  type AccountingDayShard,
  type AccountingLifetime,
  type AccountingMetricCellV1,
  type AccountingRequestPacket,
  type AccountingSpendV1,
} from "./accounting-store-schema.js";
import {
  DASHBOARD_COST_SCHEMA,
  DASHBOARD_DETAIL_SCHEMA,
  DASHBOARD_MAX_BUCKETS,
  DASHBOARD_MAX_DETAIL_ATTEMPTS,
  DASHBOARD_MAX_DIMENSION_ROWS,
  DASHBOARD_MAX_ERROR_ROWS,
  DASHBOARD_MAX_RECENT_ROWS,
  DASHBOARD_SNAPSHOT_SCHEMA,
  PANEL_IDS,
  assertCostReportV1,
  assertDetailV1,
  assertSnapshotV1,
  isCooldownRowV1,
  isDashboardAttributionPolicy,
  isQuotaRowV1,
  mapDashboardQueryAttribution,
  type Attribution,
  type AttributionPolicy,
  type AttemptRowV1,
  type BucketV1,
  type ClientDimensionRowV1,
  type CooldownRowV1,
  type CostBy,
  type CostReportV1,
  type CostRowV1,
  type RepairShareV1,
  type Coverage,
  type CoverageReason,
  type CredentialDimensionRowV1,
  type DetailV1,
  type ErrorDistributionRowV1,
  type EstimatedTokenCell,
  type FailureKind,
  type ModelDimensionRowV1,
  type Outcome,
  type PanelCoverageV1,
  type PanelId,
  type Provenance,
  type ProviderDimensionRowV1,
  type QuotaRowV1,
  type ReportedTokenCell,
  type RequestRowV1,
  type SnapshotV1,
  type SpendTotalsV1,
  type SummaryV1,
  type TokenTotalsV1,
  type WindowId,
} from "./dashboard-contract.js";
import type { DashboardDetailQuery, DashboardReadPort, DashboardSnapshotQuery } from "./dashboard-routes.js";

/** What the cost roll-up accepts: the window, whether repair joins, and the grouping axis. */
export interface CostReportQuery {
  readonly window: WindowId;
  /** Fold role:"repair" attempts into the report as their own labelled share (C1). */
  readonly includeRepair: boolean;
  readonly by?: CostBy;
}

/**
 * The cost roll-up surface beside {@link DashboardReadPort}. Declared here rather than in
 * `dashboard-routes.ts` because only producers and the CLI consume it; the dashboard API
 * routes deliberately stay unaware of it (Gap 7: no HTTP endpoint for cost).
 */
export interface CostReportingPort {
  readCostReport(query: CostReportQuery): Promise<CostReportV1>;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_READ_DAYS = 31;
const PROVENANCE_ORDER: readonly Provenance[] = [
  "provider_reported",
  "relay_observed",
  "relay_estimated",
  "unknown",
  "mixed",
];

/** A point-in-time, already-read availability view.  No provider probe belongs here. */
export interface DashboardAvailabilitySnapshot {
  readonly quotas?: readonly unknown[];
  readonly cooldowns?: readonly unknown[];
}

/** Narrow read-only availability dependency for the snapshot path. */
export interface DashboardAvailabilityPort {
  snapshot(): DashboardAvailabilitySnapshot;
}

export interface DashboardSnapshotReadOptions {
  /** The only persistence dependency used by the projector. */
  readonly accounting: AccountingReader;
  readonly relayVersion: string;
  /** Inject for deterministic tests; defaults to Date.now. */
  readonly now?: () => number | Date | string;
  /** Already-captured facts, or a narrow synchronous snapshot reader. */
  readonly availability?: DashboardAvailabilitySnapshot | DashboardAvailabilityPort | (() => DashboardAvailabilitySnapshot);
  /** The caller-owned policy label; unknown is the only safe default. */
  readonly attributionPolicy?: AttributionPolicy;
}

export type DashboardSnapshotOptions = DashboardSnapshotReadOptions;

interface WindowPlan {
  readonly window: WindowId;
  readonly from: Date | null;
  readonly to: Date;
  readonly asOf: Date;
  readonly bucketMs: number;
  readonly bucketCount: number;
}

interface ProjectionHealth {
  readable: boolean;
  partial: boolean;
  stale: boolean;
  retention: boolean;
  noMatchingRows: boolean;
  observedAt: string | null;
  readonly provenance: Set<Provenance>;
}

interface MutableTokenCell {
  seen: boolean;
  value: number | null;
  known: number;
  unknown: number;
  lost: number;
  overflow: boolean;
  observedAt: string | null;
  method: string | null;
}

interface MutableTokens {
  readonly reportedInput: MutableTokenCell;
  readonly reportedOutput: MutableTokenCell;
  readonly reportedCachedInput: MutableTokenCell;
  readonly estimatedInput: MutableTokenCell;
  readonly estimatedOutput: MutableTokenCell;
  cacheSplitObserved: boolean;
}

interface MutableMetric {
  seen: boolean;
  sumMs: number | null;
  known: number;
  unknown: number;
  lost: number;
  overflow: boolean;
  samples: number[];
  samplesDropped: number;
  observedAt: string | null;
}

interface MutableSpendCell {
  seen: boolean;
  amountMicrousd: number | null;
  known: number;
  observedAt: string | null;
}

interface MutableSpend {
  providerPublishedReported: MutableSpendCell;
  providerPublishedEstimated: MutableSpendCell;
  referenceReported: MutableSpendCell;
  referenceEstimated: MutableSpendCell;
}

interface MutableStats {
  requests: number;
  attempts: number;
  served: number;
  errored: number;
  cancelled: number;
  unpricedRequests: number;
  partiallyPricedRequests: number;
  readonly tokens: MutableTokens;
  readonly spend: MutableSpend;
  readonly latency: MutableMetric;
  readonly commit: MutableMetric;
  readonly health: ProjectionHealth;
}

interface DimensionState {
  readonly stats: MutableStats;
  readonly key: string;
  readonly values: readonly string[];
}

interface ReadDaysResult {
  readonly days: readonly AccountingDayShard[];
  readonly health: ProjectionHealth;
}

function newHealth(): ProjectionHealth {
  return {
    readable: true,
    partial: false,
    stale: false,
    retention: false,
    noMatchingRows: false,
    observedAt: null,
    provenance: new Set<Provenance>(["relay_observed"]),
  };
}

function cloneHealth(source: ProjectionHealth): ProjectionHealth {
  return {
    readable: source.readable,
    partial: source.partial,
    stale: source.stale,
    retention: source.retention,
    noMatchingRows: source.noMatchingRows,
    observedAt: source.observedAt,
    provenance: new Set(source.provenance),
  };
}

function noteTimestamp(target: { observedAt: string | null }, value: string | null): void {
  if (value !== null && (target.observedAt === null || value > target.observedAt)) target.observedAt = value;
}

function noteProvenance(target: ProjectionHealth, value: Provenance): void {
  target.provenance.add(value);
}

function mergeHealth(target: ProjectionHealth, source: ProjectionHealth): void {
  target.readable &&= source.readable;
  target.partial ||= source.partial;
  target.stale ||= source.stale;
  target.retention ||= source.retention;
  target.noMatchingRows ||= source.noMatchingRows;
  noteTimestamp(target, source.observedAt);
  for (const provenance of source.provenance) target.provenance.add(provenance);
}

function noteAccountingCoverage(target: ProjectionHealth, coverage: AccountingCoverageV1): void {
  if (coverage.state === "unavailable") target.readable = false;
  if (coverage.state === "partial") target.partial = true;
  if (coverage.state === "stale") target.stale = true;
  if (coverage.state === "empty") target.noMatchingRows = true;
  if (coverage.reason === "retention_pruned") target.retention = true;
  // Every non-null AccountingCoverageReason the store emits (row_cap, detail_cap,
  // dedup_cap, counter_overflow, corrupt_recovery, or the truncated-months/retention
  // "unknown" fallback in accounting-store.ts markCoverage()) names a genuine drop or
  // corruption at the STORE layer — never "a request lacked a token kind", which is
  // tracked per-cell via `unknown` counters instead. So flipping partial here is
  // already the correct classification and needs no change (audited 2026-08-23).
  if (coverage.reason !== null && coverage.reason !== "retention_pruned") target.partial = true;
  if (coverage.droppedRows > 0 || coverage.droppedRecent > 0 || coverage.droppedDetails > 0 || coverage.droppedDedup > 0) {
    target.partial = true;
  }
  if (coverage.losses.length > 0) target.partial = true;
  if (coverage.reason !== null || coverage.losses.length > 0) noteProvenance(target, "unknown");
}

function safeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function boundedAdd(left: number, right: number, health: ProjectionHealth): number {
  if (!Number.isSafeInteger(right) || right < 0 || left > Number.MAX_SAFE_INTEGER - right) {
    health.partial = true;
    noteProvenance(health, "unknown");
    return Number.MAX_SAFE_INTEGER;
  }
  return left + right;
}

function newTokenCell(): MutableTokenCell {
  return { seen: false, value: null, known: 0, unknown: 0, lost: 0, overflow: false, observedAt: null, method: null };
}

function newTokens(): MutableTokens {
  return {
    reportedInput: newTokenCell(),
    reportedOutput: newTokenCell(),
    reportedCachedInput: newTokenCell(),
    estimatedInput: newTokenCell(),
    estimatedOutput: newTokenCell(),
    cacheSplitObserved: false,
  };
}

function newMetric(): MutableMetric {
  return { seen: false, sumMs: null, known: 0, unknown: 0, lost: 0, overflow: false, samples: [], samplesDropped: 0, observedAt: null };
}

function newSpendCell(): MutableSpendCell {
  return { seen: false, amountMicrousd: null, known: 0, observedAt: null };
}

function newSpend(): MutableSpend {
  return {
    providerPublishedReported: newSpendCell(),
    providerPublishedEstimated: newSpendCell(),
    referenceReported: newSpendCell(),
    referenceEstimated: newSpendCell(),
  };
}

function newStats(): MutableStats {
  return {
    requests: 0,
    attempts: 0,
    served: 0,
    errored: 0,
    cancelled: 0,
    unpricedRequests: 0,
    partiallyPricedRequests: 0,
    tokens: newTokens(),
    spend: newSpend(),
    latency: newMetric(),
    commit: newMetric(),
    health: newHealth(),
  };
}

function cellHasEvidence(cell: AccountingAggregateTokenCellV1): boolean {
  return cell.known > 0 || cell.unknown > 0 || cell.lost > 0 || cell.overflow || cell.value !== null;
}

/**
 * True only when this cache creation/read cell actually carries a split the wire's
 * single cached field cannot represent: a real non-zero figure, or a figure the store
 * held but could not sum (`value === null` despite `known > 0`, i.e. lost/overflow on
 * this specific cell). `known === 0` means the field was never reported at all — the
 * ordinary "unknown token kind" case already handled by `mergeTokenCell`, not a split
 * to flag here. Anthropic sends both fields on essentially every response, often as an
 * exact 0/0 when nothing was cached; that is not a figure to lose, so it must not read
 * as partial (review fix, coverage-semantics packet finding 3).
 */
function cacheCellIndicatesSplit(cell: AccountingAggregateTokenCellV1): boolean {
  if (cell.known === 0) return false;
  return cell.value === null || cell.value !== 0;
}

function mergeMethod(target: MutableTokenCell, source: string | null): void {
  if (source === null) return;
  if (target.method === null) target.method = source;
  else if (target.method !== source) target.method = source === "unknown" || target.method === "unknown" ? "unknown" : "mixed";
}

function mergeTokenCell(
  target: MutableTokenCell,
  source: AccountingAggregateTokenCellV1,
  health: ProjectionHealth,
  provenance: Provenance,
  method: string | null = null,
): void {
  if (!cellHasEvidence(source)) return;
  target.seen = true;
  target.known = boundedAdd(target.known, safeInteger(source.known), health);
  target.unknown = boundedAdd(target.unknown, safeInteger(source.unknown), health);
  target.lost = boundedAdd(target.lost, safeInteger(source.lost), health);
  target.overflow ||= source.overflow === true;
  noteTimestamp(target, source.observedAt);
  mergeMethod(target, method);
  if (source.value === null || source.unknown > 0 || source.lost > 0 || source.overflow) {
    target.value = null;
    if (source.lost > 0 || source.overflow) {
      // The store held this count and either dropped or could not sum it — a real
      // gap in what this report can show, so the panel is a lower bound.
      health.partial = true;
      noteProvenance(health, "unknown");
    } else {
      // `unknown` alone means no host reported this token kind for these requests
      // (e.g. an openai-kind backend never sends cache tokens) — nothing the store
      // held went missing. The cell renders null with provenance "unknown"; the
      // panel around it stays "complete".
      noteProvenance(health, "unknown");
    }
  } else if (target.value === null && target.known === safeInteger(source.known)) {
    target.value = source.value;
  } else if (target.value === null || target.value > Number.MAX_SAFE_INTEGER - source.value) {
    target.value = null;
    health.partial = true;
    noteProvenance(health, "unknown");
  } else {
    target.value += source.value;
  }
  noteProvenance(health, provenance);
}

function mergeTokens(target: MutableTokens, source: AccountingAggregateTokenTotalsV1, health: ProjectionHealth): void {
  mergeTokenCell(target.reportedInput, source.reported.reportedInput, health, "provider_reported");
  mergeTokenCell(target.reportedOutput, source.reported.reportedOutput, health, "provider_reported");
  mergeTokenCell(target.reportedCachedInput, source.reported.reportedCachedInput, health, "provider_reported");
  if (
    cacheCellIndicatesSplit(source.reported.cacheCreationInputTokens) ||
    cacheCellIndicatesSplit(source.reported.cacheReadInputTokens)
  ) {
    target.cacheSplitObserved = true;
    // The dashboard wire format intentionally has one cached field.  It would
    // be false precision to add Anthropic creation/read values into it. Unlike a
    // plain unmeasured kind, the store DOES hold a real figure here (split in two,
    // or lost while summing one side of the split); the wire shape is what can't
    // carry it, so this stays partial rather than merely "unknown". A 0/0 split
    // (nothing was cached) is excluded by `cacheCellIndicatesSplit` — there is
    // nothing held to lose (review fix, coverage-semantics packet finding 3).
    noteProvenance(health, "unknown");
    health.partial = true;
  }
  mergeTokenCell(target.estimatedInput, source.estimated.estimatedInput, health, "relay_estimated", source.estimated.estimatedInput.method);
  mergeTokenCell(target.estimatedOutput, source.estimated.estimatedOutput, health, "relay_estimated", source.estimated.estimatedOutput.method);
}

function mergeMetric(target: MutableMetric, source: AccountingMetricCellV1, health: ProjectionHealth): void {
  const evidence = source.known > 0 || source.unknown > 0 || source.lost > 0 || source.overflow || source.samples.length > 0 || source.sumMs !== null;
  if (!evidence) return;
  target.seen = true;
  target.known = boundedAdd(target.known, safeInteger(source.known), health);
  target.unknown = boundedAdd(target.unknown, safeInteger(source.unknown), health);
  target.lost = boundedAdd(target.lost, safeInteger(source.lost), health);
  target.samplesDropped = boundedAdd(target.samplesDropped, safeInteger(source.samplesDropped), health);
  target.overflow ||= source.overflow === true;
  noteTimestamp(target, source.observedAt);
  if (source.sumMs === null || source.unknown > 0 || source.lost > 0 || source.overflow) {
    target.sumMs = null;
  } else if (target.sumMs === null && target.known === safeInteger(source.known)) {
    target.sumMs = source.sumMs;
  } else if (target.sumMs === null || target.sumMs > Number.MAX_SAFE_INTEGER - source.sumMs) {
    target.sumMs = null;
    health.partial = true;
    noteProvenance(health, "unknown");
  } else {
    target.sumMs += source.sumMs;
  }
  for (const sample of source.samples) {
    if (target.samples.length >= DASHBOARD_MAX_BUCKETS || !Number.isSafeInteger(sample) || sample < 0) {
      target.samplesDropped = boundedAdd(target.samplesDropped, 1, health);
      health.partial = true;
      noteProvenance(health, "unknown");
    } else {
      target.samples.push(sample);
    }
  }
  if (source.lost > 0 || source.overflow || source.samplesDropped > 0) {
    // Dropped rows, an overflowed sum, or bucket-capped samples are data the store
    // held that this report cannot show. A plain `unknown` count (a request that
    // never got a latency/commit measurement at all) is noted below without
    // flipping the panel partial; `finalizeHealth`/`hasUnexpectedMetricLoss` still
    // catches unknown counts that exceed the EXPECTED amount (cancelled requests
    // have no latency; unserved requests have no commit time) as real loss.
    health.partial = true;
    noteProvenance(health, "unknown");
  } else if (source.unknown > 0) {
    noteProvenance(health, "unknown");
  }
}

/**
 * Fold one persisted spend cell into the projection accumulator. Amounts are
 * integer micro-USD and stay null once any contributor is uncertain (overflow),
 * mirroring how token sums degrade; `known` still counts every contribution so a
 * degraded cell is distinguishable from an empty one.
 */
function mergeSpendCell(target: MutableSpendCell, source: AccountingAggregateSpendCellV1, health: ProjectionHealth): void {
  if (source.known === 0 && source.amountMicrousd === null && source.observedAt === null) return;
  target.seen = true;
  const knownBefore = target.known;
  target.known = boundedAdd(target.known, safeInteger(source.known), health);
  noteTimestamp(target, source.observedAt);
  if (source.amountMicrousd === null) {
    // A contributor that lost its own sum poisons the combined one. This is never the
    // "unpriced" case (an individual AccountingSpendV1 record always carries a real
    // amount; an unpriced request contributes no record at all, so its cell arrives
    // empty and is skipped above) — a null amount here can only mean the STORE's own
    // running sum overflowed, i.e. a real loss (audited 2026-08-23).
    if (knownBefore > 0) { target.amountMicrousd = null; health.partial = true; noteProvenance(health, "unknown"); }
    return;
  }
  if (knownBefore === 0) {
    target.amountMicrousd = source.amountMicrousd;
    return;
  }
  if (target.amountMicrousd === null || target.amountMicrousd > Number.MAX_SAFE_INTEGER - source.amountMicrousd) {
    target.amountMicrousd = null;
    health.partial = true;
    noteProvenance(health, "unknown");
    return;
  }
  target.amountMicrousd += source.amountMicrousd;
}

type SpendCellDefinition = {
  [K in keyof MutableSpend]: readonly [K, SpendTotalsV1[K]["priceSource"], SpendTotalsV1[K]["tokenBasis"], Exclude<SpendTotalsV1[K]["source"], "unknown">];
}[keyof MutableSpend];

const SPEND_CELLS = [
  ["providerPublishedReported", "provider_published", "reported", "provider_reported"],
  ["providerPublishedEstimated", "provider_published", "estimated", "relay_estimated"],
  ["referenceReported", "reference", "reported", "provider_reported"],
  ["referenceEstimated", "reference", "estimated", "relay_estimated"],
] as const satisfies readonly SpendCellDefinition[];
type SpendCellKey = (typeof SPEND_CELLS)[number][0];
type ProjectedSpendCell = Pick<SpendTotalsV1[SpendCellKey], "amountMicrousd" | "source" | "observedAt">;

function mergeSpend(target: MutableSpend, source: AccountingAggregateSpendV1 | null | undefined, health: ProjectionHealth): void {
  if (!source) return;
  for (const [key] of SPEND_CELLS) {
    mergeSpendCell(target[key], source[key], health);
  }
}

function addRequestAggregate(target: MutableStats, aggregate: AccountingAggregateV1): void {
  target.requests = boundedAdd(target.requests, safeInteger(aggregate.requests), target.health);
  target.served = boundedAdd(target.served, safeInteger(aggregate.served), target.health);
  target.errored = boundedAdd(target.errored, safeInteger(aggregate.errored), target.health);
  target.cancelled = boundedAdd(target.cancelled, safeInteger(aggregate.cancelled), target.health);
  target.unpricedRequests = boundedAdd(target.unpricedRequests, safeInteger(aggregate.unpricedRequests), target.health);
  target.partiallyPricedRequests = boundedAdd(
    target.partiallyPricedRequests,
    safeInteger(aggregate.partiallyPricedRequests ?? 0),
    target.health,
  );
  mergeTokens(target.tokens, aggregate.requestTokens, target.health);
  // Request-scoped spend cells ride beside request tokens; a legacy shard without
  // them contributes nothing rather than implying zero.
  mergeSpend(target.spend, aggregate.requestSpend, target.health);
  mergeMetric(target.latency, aggregate.latency, target.health);
  mergeMetric(target.commit, aggregate.commit, target.health);
}

function addAttemptAggregate(target: MutableStats, aggregate: AccountingAggregateV1): void {
  target.attempts = boundedAdd(target.attempts, safeInteger(aggregate.attempts), target.health);
}

function reportedCell(source: MutableTokenCell, forceNull = false): ReportedTokenCell {
  return {
    value: forceNull || !source.seen || source.unknown > 0 || source.lost > 0 || source.overflow ? null : source.value,
    source: "provider_reported",
    observedAt: source.observedAt,
  };
}

function estimatedCell(source: MutableTokenCell): EstimatedTokenCell {
  return {
    value: !source.seen || source.unknown > 0 || source.lost > 0 || source.overflow ? null : source.value,
    source: "relay_estimated",
    observedAt: source.observedAt,
    method: source.method,
  };
}

function tokenTotals(source: MutableTokens): TokenTotalsV1 {
  return {
    reported: {
      reportedInput: reportedCell(source.reportedInput),
      reportedOutput: reportedCell(source.reportedOutput),
      reportedCachedInput: reportedCell(source.reportedCachedInput, source.cacheSplitObserved),
    },
    estimated: {
      estimatedInput: estimatedCell(source.estimatedInput),
      estimatedOutput: estimatedCell(source.estimatedOutput),
    },
  };
}

/**
 * Project one aggregate spend cell onto its wire shape. A cell nobody contributed
 * to stays amount-null — "Unpriced" in the SPA, never "$0" — and an overflowed sum
 * degrades to null exactly like an overflowed token sum does.
 */
function projectedSpendCell<T extends "provider_reported" | "relay_estimated">(
  cell: MutableSpendCell,
  source: T,
): { amountMicrousd: number | null; source: T; observedAt: string | null } {
  return {
    amountMicrousd: cell.seen && cell.known > 0 ? cell.amountMicrousd : null,
    source,
    observedAt: cell.observedAt,
  };
}

function spendTotals(stats: MutableStats): SpendTotalsV1 {
  const unknown = () => ({ amountMicrousd: null, source: "unknown" as const, observedAt: null });
  const cells = Object.fromEntries(SPEND_CELLS.map(([key, priceSource, tokenBasis, source]) => {
    let projected: ProjectedSpendCell = unknown();
    if (stats.spend[key].seen) {
      projected = projectedSpendCell(stats.spend[key], source);
    }
    return [key, { ...projected, priceSource, tokenBasis }];
  })) as Pick<SpendTotalsV1, SpendCellKey>;
  return {
    ...cells,
    unpricedRequests: stats.unpricedRequests,
    partiallyPricedRequests: stats.partiallyPricedRequests,
  };
}

function average(metric: MutableMetric, toleratedUnknown: number): number | null {
  if (!metric.seen || metric.sumMs === null || metric.known < 1 || metric.unknown > toleratedUnknown || metric.lost > 0 || metric.overflow) return null;
  return Math.round(metric.sumMs / metric.known);
}

function percentile95(metric: MutableMetric, toleratedUnknown: number): number | null {
  if (
    !metric.seen ||
    metric.samplesDropped > 0 ||
    metric.unknown > toleratedUnknown ||
    metric.lost > 0 ||
    metric.overflow ||
    metric.samples.length < 1
  ) {
    return null;
  }
  const samples = [...metric.samples].sort((left, right) => left - right);
  return samples[Math.ceil(samples.length * 0.95) - 1] ?? null;
}

function hasUnexpectedMetricLoss(stats: MutableStats): boolean {
  const latencyAllowedUnknown = stats.cancelled;
  const commitAllowedUnknown = Math.max(0, stats.requests - stats.served);
  return (
    stats.latency.unknown > latencyAllowedUnknown ||
    stats.latency.lost > 0 ||
    stats.latency.overflow ||
    stats.latency.samplesDropped > 0 ||
    stats.commit.unknown > commitAllowedUnknown ||
    stats.commit.lost > 0 ||
    stats.commit.overflow
  );
}

function finalizeHealth(stats: MutableStats): void {
  if (hasUnexpectedMetricLoss(stats)) {
    stats.health.partial = true;
    noteProvenance(stats.health, "unknown");
  }
}

function summaryFrom(stats: MutableStats): SummaryV1 {
  finalizeHealth(stats);
  const denominator = stats.served + stats.errored;
  return {
    requests: stats.requests,
    attempts: stats.attempts,
    served: stats.served,
    errored: stats.errored,
    cancelled: stats.cancelled,
    successRate: denominator === 0 ? null : stats.served / denominator,
    tokens: tokenTotals(stats.tokens),
    spend: spendTotals(stats),
    avgLatencyMs: average(stats.latency, stats.cancelled),
    p95LatencyMs: percentile95(stats.latency, stats.cancelled),
    avgCommitMs: average(stats.commit, Math.max(0, stats.requests - stats.served)),
  };
}

function bucketFrom(from: Date, to: Date, stats: MutableStats): BucketV1 {
  const summary = summaryFrom(stats);
  return { from: from.toISOString(), to: to.toISOString(), ...summary };
}

function coverageFor(panel: PanelId, health: ProjectionHealth): PanelCoverageV1 {
  let state: Coverage;
  let reason: CoverageReason | null;
  if (!health.readable) {
    state = "unavailable";
    reason = health.retention ? "retention_pruned" : "meter_not_implemented";
  } else if (health.retention || health.partial) {
    state = "partial";
    reason = health.retention ? "retention_pruned" : "unknown";
  } else if (health.stale) {
    state = "stale";
    reason = null;
  } else if (health.noMatchingRows) {
    state = "empty";
    reason = "no_matching_rows";
  } else {
    state = "complete";
    reason = null;
  }
  const provenance = PROVENANCE_ORDER.filter((value) => health.provenance.has(value));
  return { panel, state, reason, provenance, observedAt: health.observedAt };
}

function unavailableCoverageFor(panel: PanelId, health: ProjectionHealth): PanelCoverageV1 {
  const unavailable = cloneHealth(health);
  unavailable.readable = false;
  unavailable.noMatchingRows = false;
  noteProvenance(unavailable, "unknown");
  return coverageFor(panel, unavailable);
}

function checkedDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.valueOf()) ? new Date(value.valueOf()) : null;
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value) : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  }
  return null;
}

function clockDate(clock: DashboardSnapshotReadOptions["now"]): Date {
  try {
    const parsed = checkedDate(clock === undefined ? Date.now() : clock());
    if (parsed !== null) return parsed;
  } catch {
    // A read endpoint must remain safe when an injected diagnostic clock fails.
  }
  return new Date(0);
}

function floorUtc(value: Date, unitMs: number): Date {
  return new Date(Math.floor(value.valueOf() / unitMs) * unitMs);
}

function utcMonthStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function addUtcMonths(value: Date, months: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));
}

function utcDaysInMonth(value: Date): number {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
}

function rollingPlan(window: WindowId, now: Date, bucketMs: number, bucketCount: number): WindowPlan {
  const to = floorUtc(now, bucketMs);
  return { window, from: new Date(to.valueOf() - bucketMs * bucketCount), to, asOf: to, bucketMs, bucketCount };
}

function windowPlan(window: WindowId, now: Date, lifetimeFirstAt: string | null = null): WindowPlan {
  if (window === "1h") return rollingPlan(window, now, MINUTE_MS, 60);
  if (window === "24h") return rollingPlan(window, now, 15 * MINUTE_MS, 96);
  if (window === "7d") return rollingPlan(window, now, 60 * MINUTE_MS, 168);
  if (window === "30d") return rollingPlan(window, now, 6 * 60 * MINUTE_MS, 120);
  if (window === "today") {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const to = floorUtc(now, 15 * MINUTE_MS);
    const count = Math.max(0, Math.min(96, Math.floor((to.valueOf() - from.valueOf()) / (15 * MINUTE_MS))));
    return { window, from, to, asOf: to, bucketMs: 15 * MINUTE_MS, bucketCount: count };
  }
  if (window === "month") {
    const from = utcMonthStart(now);
    const to = floorUtc(now, DAY_MS);
    const count = Math.max(0, Math.min(utcDaysInMonth(now), Math.floor((to.valueOf() - from.valueOf()) / DAY_MS)));
    return { window, from, to, asOf: to, bucketMs: DAY_MS, bucketCount: count };
  }
  const parsedFirst = checkedDate(lifetimeFirstAt);
  if (parsedFirst === null || parsedFirst.valueOf() > now.valueOf()) {
    return { window, from: null, to: now, asOf: now, bucketMs: DAY_MS, bucketCount: 0 };
  }
  const firstMonth = utcMonthStart(parsedFirst);
  const currentMonth = utcMonthStart(now);
  const months = (currentMonth.getUTCFullYear() - firstMonth.getUTCFullYear()) * 12 + currentMonth.getUTCMonth() - firstMonth.getUTCMonth() + 1;
  const count = Math.min(DASHBOARD_MAX_BUCKETS, Math.max(0, months));
  const from = addUtcMonths(currentMonth, 1 - count);
  return { window, from, to: now, asOf: now, bucketMs: DAY_MS, bucketCount: count };
}

function datesFor(plan: WindowPlan): string[] {
  if (plan.from === null || plan.to.valueOf() <= plan.from.valueOf()) return [];
  const dates: string[] = [];
  const last = new Date(plan.to.valueOf() - 1);
  let cursor = new Date(Date.UTC(plan.from.getUTCFullYear(), plan.from.getUTCMonth(), plan.from.getUTCDate()));
  const end = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate()));
  while (cursor.valueOf() <= end.valueOf() && dates.length < MAX_READ_DAYS) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.valueOf() + DAY_MS);
  }
  return dates;
}

function bucketBounds(plan: WindowPlan): Array<{ from: Date; to: Date }> {
  if (plan.from === null || plan.bucketCount === 0) return [];
  if (plan.window === "lifetime") {
    const result: Array<{ from: Date; to: Date }> = [];
    for (let index = 0; index < plan.bucketCount; index += 1) {
      const from = addUtcMonths(plan.from, index);
      const next = addUtcMonths(from, 1);
      result.push({ from, to: index === plan.bucketCount - 1 ? plan.to : next });
    }
    return result;
  }
  const result: Array<{ from: Date; to: Date }> = [];
  for (let index = 0; index < plan.bucketCount; index += 1) {
    const from = new Date(plan.from.valueOf() + index * plan.bucketMs);
    result.push({ from, to: new Date(from.valueOf() + plan.bucketMs) });
  }
  return result;
}

interface TupleFact {
  readonly provider: string | null;
  readonly model: string | null;
  readonly client: string | null;
  readonly credentialId: string | null;
  readonly attribution: Attribution;
  readonly outcome: Outcome;
  readonly failureKind: FailureKind | null;
}

function matchesTuple(fact: TupleFact, query: DashboardSnapshotQuery): boolean {
  const attribution = mapDashboardQueryAttribution(query.attribution);
  return (
    (attribution === "all" || fact.attribution === attribution) &&
    (query.provider === undefined || fact.provider === query.provider) &&
    (query.model === undefined || fact.model === query.model) &&
    (query.client === undefined || fact.client === query.client) &&
    (query.credentialId === undefined || fact.credentialId === query.credentialId) &&
    (query.outcome === undefined || fact.outcome === query.outcome) &&
    (query.failureKind === undefined || fact.failureKind === query.failureKind)
  );
}

function hasTupleFilter(query: DashboardSnapshotQuery): boolean {
  return (
    (query.attribution !== undefined && query.attribution !== "all") ||
    query.provider !== undefined ||
    query.model !== undefined ||
    query.client !== undefined ||
    query.credentialId !== undefined ||
    query.outcome !== undefined ||
    query.failureKind !== undefined
  );
}

function rowTuple(row: { provider: string | null; model: string | null; client: string | null; credentialId: string | null; attribution: Attribution; outcome: Outcome; failureKind: FailureKind | null }): TupleFact {
  return row;
}

function addDimension(
  target: Map<string, DimensionState>,
  values: readonly string[] | null,
  row: { kind: "request" | "attempt"; role: "request" | "serve" | "repair" } & AccountingAggregateV1,
  health: ProjectionHealth,
): void {
  if (values === null) return;
  const key = values.join("\u0000");
  let current = target.get(key);
  if (current === undefined) {
    if (target.size >= DASHBOARD_MAX_DIMENSION_ROWS) {
      health.partial = true;
      noteProvenance(health, "unknown");
      return;
    }
    current = { key, values, stats: newStats() };
    target.set(key, current);
  }
  if (row.kind === "request") addRequestAggregate(current.stats, row);
  else addAttemptAggregate(current.stats, row);
}

function credentialLabel(credentialId: string): string {
  const separator = credentialId.indexOf("#");
  const label = separator >= 0 ? credentialId.slice(separator + 1) : credentialId;
  return label.length > 0 ? label : credentialId;
}

/** The row each dimension kind produces, so the kind and the row type cannot be paired wrongly. */
interface DimensionRowByKind {
  provider: ProviderDimensionRowV1;
  model: ModelDimensionRowV1;
  client: ClientDimensionRowV1;
  credential: CredentialDimensionRowV1;
}

/**
 * ⚠ Generic over the kind on purpose. This used to declare a UNION of the four array types while
 * the body produced an array of the four ROW types — not assignable, so it ended in
 * `as unknown as …` and each of the four call sites re-cast the result. That laundered away the
 * one correlation worth checking: pass `models` with `"provider"`, or swap two call sites, and
 * tsc said nothing while `state.values[1]!` handed back `undefined` through a non-null assertion.
 * `assertSnapshotV1` would have caught it at runtime as a thrown read, which is a poor substitute
 * for a compile error — and this repo already has a scar about type-level assertions that assert
 * nothing (the inert `@ts-expect-error`, CLAUDE.md). No runtime change; five casts removed.
 */
function materializeDimensions<K extends keyof DimensionRowByKind>(
  source: Map<string, DimensionState>,
  kind: K,
): DimensionRowByKind[K][] {
  const states = [...source.values()];
  states.sort((left, right) => {
    const requestDelta = right.stats.requests - left.stats.requests;
    if (requestDelta !== 0) return requestDelta;
    const attemptDelta = right.stats.attempts - left.stats.attempts;
    return attemptDelta !== 0 ? attemptDelta : left.key.localeCompare(right.key);
  });
  return states.map((state) => {
    const { p95LatencyMs: _p95LatencyMs, ...summary } = summaryFrom(state.stats);
    const coverage = coverageFor(kind, state.stats.health).state;
    if (kind === "provider") return { ...summary, coverage, dimension: "provider", provider: state.values[0]! } satisfies ProviderDimensionRowV1;
    if (kind === "model") return { ...summary, coverage, dimension: "model", provider: state.values[0]!, model: state.values[1]! } satisfies ModelDimensionRowV1;
    if (kind === "client") return { ...summary, coverage, dimension: "client", client: state.values[0]! } satisfies ClientDimensionRowV1;
    return {
      ...summary,
      coverage,
      dimension: "credential",
      provider: state.values[0]!,
      credentialId: state.values[1]!,
      label: credentialLabel(state.values[1]!),
    } satisfies CredentialDimensionRowV1;
    // One cast remains and it is the irreducible one: TypeScript cannot narrow the RETURN type
    // from a runtime `kind` comparison inside `map`. It is scoped to this line rather than
    // laundering the whole function's signature, and the four `satisfies` above still check every
    // row's shape.
  }) as DimensionRowByKind[K][];
}

function emptyAvailabilityHealth(): ProjectionHealth {
  const health = newHealth();
  health.readable = false;
  health.provenance.clear();
  health.provenance.add("unknown");
  return health;
}

function resolveAvailability(input: DashboardSnapshotReadOptions["availability"]): { snapshot: DashboardAvailabilitySnapshot | null; health: ProjectionHealth } {
  if (input === undefined) return { snapshot: null, health: emptyAvailabilityHealth() };
  try {
    const snapshot: unknown = typeof input === "function" ? input() : "snapshot" in input ? input.snapshot() : input;
    if (snapshot === null || typeof snapshot !== "object") return { snapshot: null, health: emptyAvailabilityHealth() };
    return { snapshot: snapshot as DashboardAvailabilitySnapshot, health: newHealth() };
  } catch {
    return { snapshot: null, health: emptyAvailabilityHealth() };
  }
}

function availabilityMatches(
  row: { provider: string; credentialId: string },
  query: DashboardSnapshotQuery,
): boolean {
  if (query.provider !== undefined && row.provider !== query.provider) return false;
  if (query.credentialId !== undefined && row.credentialId !== query.credentialId) return false;
  // These facts have no client/outcome/attribution tuple.  Showing them under
  // such a filter would silently bypass the query, so they intentionally do
  // not match it.
  return (
    query.model === undefined &&
    query.client === undefined &&
    query.outcome === undefined &&
    query.failureKind === undefined &&
    (query.attribution === undefined || query.attribution === "all")
  );
}

function availabilityRows(
  snapshot: DashboardAvailabilitySnapshot | null,
  query: DashboardSnapshotQuery,
  initial: ProjectionHealth,
): { quotas: QuotaRowV1[]; cooldowns: CooldownRowV1[]; quotaHealth: ProjectionHealth; cooldownHealth: ProjectionHealth } {
  const quotaHealth = cloneHealth(initial);
  const cooldownHealth = cloneHealth(initial);
  const quotas: QuotaRowV1[] = [];
  const cooldowns: CooldownRowV1[] = [];
  if (snapshot === null) return { quotas, cooldowns, quotaHealth, cooldownHealth };
  const quotaValue = snapshot.quotas;
  const cooldownValue = snapshot.cooldowns;
  const rawQuotas = quotaValue === undefined ? [] : Array.isArray(quotaValue) ? quotaValue : [];
  const rawCooldowns = cooldownValue === undefined ? [] : Array.isArray(cooldownValue) ? cooldownValue : [];
  if (quotaValue !== undefined && !Array.isArray(quotaValue)) {
    quotaHealth.partial = true;
    noteProvenance(quotaHealth, "unknown");
  }
  if (cooldownValue !== undefined && !Array.isArray(cooldownValue)) {
    cooldownHealth.partial = true;
    noteProvenance(cooldownHealth, "unknown");
  }
  for (const candidate of rawQuotas) {
    if (!isQuotaRowV1(candidate)) {
      quotaHealth.partial = true;
      noteProvenance(quotaHealth, "unknown");
      continue;
    }
    if (!availabilityMatches(candidate, query)) continue;
    if (quotas.length >= DASHBOARD_MAX_DIMENSION_ROWS) {
      quotaHealth.partial = true;
      noteProvenance(quotaHealth, "unknown");
      continue;
    }
    quotas.push({ ...candidate });
    noteTimestamp(quotaHealth, candidate.observedAt);
  }
  for (const candidate of rawCooldowns) {
    if (!isCooldownRowV1(candidate)) {
      cooldownHealth.partial = true;
      noteProvenance(cooldownHealth, "unknown");
      continue;
    }
    if (!availabilityMatches(candidate, query)) continue;
    if (cooldowns.length >= DASHBOARD_MAX_DIMENSION_ROWS) {
      cooldownHealth.partial = true;
      noteProvenance(cooldownHealth, "unknown");
      continue;
    }
    cooldowns.push({ ...candidate });
    noteTimestamp(cooldownHealth, candidate.observedAt);
  }
  if (quotas.length === 0 && quotaHealth.readable && !quotaHealth.partial) quotaHealth.noMatchingRows = true;
  if (cooldowns.length === 0 && cooldownHealth.readable && !cooldownHealth.partial) cooldownHealth.noMatchingRows = true;
  quotas.sort((left, right) => [left.provider, left.credentialId, left.deployment ?? "", left.axis, left.period].join("\u0000").localeCompare([right.provider, right.credentialId, right.deployment ?? "", right.axis, right.period].join("\u0000")));
  cooldowns.sort((left, right) => [left.provider, left.credentialId, left.deployment ?? "", left.reason].join("\u0000").localeCompare([right.provider, right.credentialId, right.deployment ?? "", right.reason].join("\u0000")));
  return { quotas, cooldowns, quotaHealth, cooldownHealth };
}

/**
 * Read the window's day shards WITHOUT quarantining anything and report how many were
 * simply absent. Deliberately separate from `safeReadDays`: the cost roll-up must
 * distinguish "this store has never recorded anything" (a friendly empty state) from
 * "shards were unreadable" (a partial-coverage warning), which the snapshot path folds
 * into one health flag because its panels can say it with more structure. A THROWN read
 * is reported as `failed` so it can never masquerade as the absent case either — see the
 * catch below.
 */
function readCostDays(reader: AccountingReader, dates: readonly string[]): {
  days: AccountingDayShard[];
  missing: number;
  corrupt: number;
  capped: boolean;
  /** The read itself threw — a hard failure, distinct from every shard being absent. */
  failed: boolean;
} {
  if (dates.length === 0) return { days: [], missing: 0, corrupt: 0, capped: false, failed: false };
  try {
    const result = reader.readDays(dates, { cap: MAX_READ_DAYS });
    let missing = 0;
    let corrupt = 0;
    const days: AccountingDayShard[] = [];
    const entries = new Map<string, unknown>();
    for (const entry of result.results) {
      if (entry === undefined || typeof entry.date !== "string") continue;
      if (!entries.has(entry.date)) entries.set(entry.date, entry.result);
    }
    for (const date of dates) {
      const entry = entries.get(date) as { status?: unknown; value?: unknown } | undefined;
      if (entry === undefined || entry.status === "missing") {
        missing += 1;
        continue;
      }
      if (entry.status !== "ok" || entry.value === null || entry.value === undefined) {
        corrupt += 1;
        continue;
      }
      const parsed = parseAccountingDayShardV1(entry.value);
      if (!parsed.ok) {
        corrupt += 1;
        continue;
      }
      days.push(parsed.value);
    }
    return { days, missing, corrupt, capped: result.capped || result.status === "capped", failed: false };
  } catch {
    // A throwing reader is a hard read failure (a denied directory, a diagnostic fault),
    // never "all shards absent": folding it into `missing` rendered EACCES as the friendly
    // "No accounting data yet" state. Corrupt + failed drives readable:false ⇒ unavailable,
    // the same verdict the port's other readers give a throw.
    return { days: [], missing: 0, corrupt: dates.length, capped: false, failed: true };
  }
}

/** Which persisted row a cost dimension groups by, as its composite parts; null = ungroupable. */
function costDimensionValues(
  by: CostBy,
  row: { provider: string | null; model: string | null; client: string | null; credentialId: string | null },
): readonly string[] | null {
  if (by === "provider") return row.provider === null ? null : [row.provider];
  if (by === "model") return row.provider === null || row.model === null ? null : [row.provider, row.model];
  if (by === "client") return row.client === null ? null : [row.client];
  return row.provider === null || row.credentialId === null ? null : [row.provider, row.credentialId];
}

/** Render a dimension's composite parts as the spelling an operator routes with. */
function costDimensionLabel(by: CostBy, values: readonly string[]): string {
  if (by === "model") return `${values[0]}/${values[1]}`;
  if (by === "credential") return `${values[0]}#${values[1]}`;
  return values[0]!;
}

/**
 * Accumulator for role:"repair" attempts. Kept apart from `MutableStats` because its
 * counters are ATTEMPT-scoped and its lower-bound question differs: a repair attempt
 * either produced a priced figure (it raised one cell's `known`) or did not, so
 * `unpricedAttempts` is derivable per row as attempts minus priced contributions.
 */
interface RepairAccumulator {
  attempts: number;
  unpricedAttempts: number;
  readonly spend: MutableSpend;
}

function newRepairAccumulator(): RepairAccumulator {
  return { attempts: 0, unpricedAttempts: 0, spend: newSpend() };
}

function foldRepairAttempt(target: RepairAccumulator, row: AccountingAggregateV1 & { attempts: number }, health: ProjectionHealth): void {
  target.attempts = boundedAdd(target.attempts, safeInteger(row.attempts), health);
  const pricedContributions = SPEND_CELLS.reduce(
    (sum, [key]) => sum + safeInteger((row.spend as AccountingAggregateSpendV1 | null)?.[key]?.known ?? 0),
    0,
  );
  target.unpricedAttempts = boundedAdd(
    target.unpricedAttempts,
    Math.max(0, safeInteger(row.attempts) - pricedContributions),
    health,
  );
  mergeSpend(target.spend, row.spend, health);
}

function repairShareCells(spend: MutableSpend): RepairShareV1["spend"] {
  return {
    providerPublishedReported: {
      ...projectedSpendCell(spend.providerPublishedReported, "provider_reported"),
      priceSource: "provider_published",
      tokenBasis: "reported",
    },
    providerPublishedEstimated: {
      ...projectedSpendCell(spend.providerPublishedEstimated, "relay_estimated"),
      priceSource: "provider_published",
      tokenBasis: "estimated",
    },
    referenceReported: {
      ...projectedSpendCell(spend.referenceReported, "provider_reported"),
      priceSource: "reference",
      tokenBasis: "reported",
    },
    referenceEstimated: {
      ...projectedSpendCell(spend.referenceEstimated, "relay_estimated"),
      priceSource: "reference",
      tokenBasis: "estimated",
    },
  };
}

function costRowFrom(key: string, stats: MutableStats): CostRowV1 {
  const summary = summaryFrom(stats);
  return {
    key,
    requests: summary.requests,
    pricedRequests: Math.max(0, summary.requests - summary.spend.unpricedRequests),
    spend: summary.spend,
  };
}

function materializeCostRows(source: Map<string, DimensionState>, by: CostBy, health: ProjectionHealth): CostRowV1[] {
  const states = [...source.values()];
  states.sort((left, right) => {
    const requestDelta = right.stats.requests - left.stats.requests;
    if (requestDelta !== 0) return requestDelta;
    const attemptDelta = right.stats.attempts - left.stats.attempts;
    return attemptDelta !== 0 ? attemptDelta : left.key.localeCompare(right.key);
  });
  const rows: CostRowV1[] = [];
  for (const state of states) {
    if (rows.length >= DASHBOARD_MAX_DIMENSION_ROWS) {
      // The root total stays exact; only this dimension's tail is withheld.
      health.partial = true;
      noteProvenance(health, "unknown");
      break;
    }
    rows.push(costRowFrom(costDimensionLabel(by, state.values), state.stats));
  }
  return rows;
}

/** Route one priced spend record onto its single wire cell inside a fresh aggregate. */
function spendAggregateFor(record: AccountingSpendV1 | null): AccountingAggregateSpendV1 {
  const emptyCell = (): AccountingAggregateSpendCellV1 => ({ amountMicrousd: null, known: 0, observedAt: null });
  const cells: Record<keyof AccountingAggregateSpendV1, AccountingAggregateSpendCellV1> = {
    providerPublishedReported: emptyCell(),
    providerPublishedEstimated: emptyCell(),
    referenceReported: emptyCell(),
    referenceEstimated: emptyCell(),
  };
  if (record !== null) {
    const key = record.priceSource === "provider_published"
      ? (record.tokenBasis === "reported" ? "providerPublishedReported" : "providerPublishedEstimated")
      : (record.tokenBasis === "reported" ? "referenceReported" : "referenceEstimated");
    cells[key] = { amountMicrousd: record.amountMicrousd, known: 1, observedAt: record.observedAt };
  }
  return cells;
}

function requestRow(packet: AccountingRequestPacket, coverage?: ProjectionHealth): RequestRowV1 {
  const stats = newStats();
  // A priced request counts as partially priced unless EVERY kind it reported was
  // priced in full; an unpriced request counts only in `unpricedRequests`.
  const partial = packet.spend !== null && packet.spend.coverage !== "full" ? 1 : 0;
  const aggregate: AccountingAggregateV1 = {
    requests: 1,
    attempts: 0,
    served: packet.outcome === "success" ? 1 : 0,
    errored: packet.outcome === "error" ? 1 : 0,
    cancelled: packet.outcome === "cancelled" ? 1 : 0,
    tokens: packet.tokens,
    requestTokens: packet.tokens,
    latency: {
      sumMs: packet.latencyMs,
      known: packet.latencyMs === null ? 0 : 1,
      unknown: packet.latencyMs === null && packet.outcome !== "cancelled" ? 1 : 0,
      lost: 0,
      overflow: false,
      samples: packet.latencyMs === null ? [] : [packet.latencyMs],
      samplesDropped: 0,
      observedAt: packet.endedAt,
    },
    commit: {
      sumMs: packet.commitMs,
      known: packet.commitMs === null ? 0 : 1,
      unknown: packet.commitMs === null && packet.outcome === "success" ? 1 : 0,
      lost: 0,
      overflow: false,
      samples: packet.commitMs === null ? [] : [packet.commitMs],
      samplesDropped: 0,
      observedAt: packet.endedAt,
    },
    spend: null,
    requestSpend: spendAggregateFor(packet.spend),
    ...(partial > 0 ? { partiallyPricedRequests: partial } : {}),
    unpricedRequests: packet.spend === null ? 1 : 0,
  };
  addRequestAggregate(stats, aggregate);
  // Same unexpected-vs-expected metric-loss check summaryFrom() applies via
  // finalizeHealth: a success with no commit time, or a non-cancelled request with
  // no latency, is real loss here too — otherwise the detail panel and the summary
  // panel disagree about the identical request (review fix, finding 2). Harmless on
  // the recent-rows call site, which passes no `coverage` to merge into.
  finalizeHealth(stats);
  if (coverage !== undefined) mergeHealth(coverage, stats.health);
  return {
    requestId: packet.requestId,
    occurredAt: packet.endedAt,
    client: packet.client,
    attribution: packet.attribution,
    outcome: packet.outcome,
    failureKind: packet.failureKind,
    attemptCount: packet.attemptCount,
    latencyMs: packet.latencyMs,
    commitMs: packet.commitMs,
    provider: packet.provider,
    model: packet.model,
    credentialId: packet.credentialId,
    tokens: tokenTotals(stats.tokens),
    spend: spendTotals(stats),
    repairIncluded: packet.repairIncluded,
  };
}

function attemptRow(packet: AccountingRequestPacket["attempts"][number], coverage?: ProjectionHealth): AttemptRowV1 {
  const stats = newStats();
  mergeTokens(stats.tokens, packet.tokens, stats.health);
  mergeSpend(stats.spend, spendAggregateFor(packet.spend), stats.health);
  if (coverage !== undefined) mergeHealth(coverage, stats.health);
  return {
    attemptId: packet.attemptId,
    role: packet.role,
    startedAt: packet.startedAt,
    endedAt: packet.endedAt,
    status: packet.outcome,
    latencyMs: packet.latencyMs,
    commitMs: packet.commitMs,
    provider: packet.provider,
    model: packet.model,
    credentialId: packet.credentialId,
    failureKind: packet.failureKind,
    tokens: tokenTotals(stats.tokens),
    spend: spendTotals(stats),
  };
}

function safeReadDays(reader: AccountingReader, dates: readonly string[]): ReadDaysResult {
  const health = newHealth();
  if (dates.length === 0) return { days: [], health };
  try {
    const result = reader.readDays(dates, { cap: MAX_READ_DAYS });
    if (result.capped || result.status === "capped") {
      health.partial = true;
      noteProvenance(health, "unknown");
    }
    if (!Array.isArray(result.results)) {
      health.readable = false;
      noteProvenance(health, "unknown");
      return { days: [], health };
    }
    const entries = new Map<string, unknown>();
    const resultLimit = Math.min(result.results.length, MAX_READ_DAYS);
    if (result.results.length > MAX_READ_DAYS) {
      health.partial = true;
      noteProvenance(health, "unknown");
    }
    for (let index = 0; index < resultLimit; index += 1) {
      const entry = result.results[index];
      if (entry === undefined || typeof entry.date !== "string") {
        health.partial = true;
        noteProvenance(health, "unknown");
        continue;
      }
      if (entries.has(entry.date)) {
        health.partial = true;
        noteProvenance(health, "unknown");
        continue;
      }
      entries.set(entry.date, entry.result);
    }
    const days: AccountingDayShard[] = [];
    for (const date of dates) {
      const entry = entries.get(date) as { status?: unknown; value?: unknown } | undefined;
      if (entry === undefined || entry.status === "missing") {
        // A day shard simply doesn't exist yet (a fresh install, or a window reaching
        // before the store's history) — the store never held this day, so nothing was
        // omitted. Mirrors readCostDays's identical missing/corrupt split (review fix,
        // coverage-semantics packet finding 1): only a genuinely corrupt/unreadable
        // entry below is a real gap.
        continue;
      }
      if (entry.status !== "ok" || entry.value === null || entry.value === undefined) {
        health.partial = true;
        noteProvenance(health, "unknown");
        continue;
      }
      const parsed = parseAccountingDayShardV1(entry.value);
      if (!parsed.ok) {
        health.partial = true;
        noteProvenance(health, "unknown");
        continue;
      }
      days.push(parsed.value);
      noteAccountingCoverage(health, parsed.value.coverage);
    }
    if (days.length === 0) health.readable = false;
    else if (health.partial || !health.readable) {
      health.readable = true;
      health.partial = true;
      noteProvenance(health, "unknown");
    }
    return { days, health };
  } catch {
    health.readable = false;
    noteProvenance(health, "unknown");
    return { days: [], health };
  }
}

/**
 * Read the lifetime rollup, carrying its underlying status so a caller can tell "this
 * store has never recorded anything" (`missing`) from a broken one (`corrupt`/throw).
 * The snapshot path ignores the distinction — its panels render both as unavailable — but
 * `readCostReport` needs it, because coverageFor maps readable:false onto unavailable and
 * a MISSING file is not a broken store.
 */
function safeReadLifetime(reader: AccountingReader): {
  lifetime: AccountingLifetime | null;
  status: "ok" | "missing" | "corrupt";
  health: ProjectionHealth;
} {
  let status: "ok" | "missing" | "corrupt" = "corrupt";
  const health = newHealth();
  try {
    const result = reader.readLifetime();
    if (result.status === "missing") status = "missing";
    if (result.status !== "ok") {
      health.readable = false;
      noteProvenance(health, "unknown");
      return { lifetime: null, status, health };
    }
    const parsed = parseAccountingLifetimeV1(result.value);
    if (!parsed.ok) {
      health.readable = false;
      noteProvenance(health, "unknown");
      return { lifetime: null, status: "corrupt", health };
    }
    noteAccountingCoverage(health, parsed.value.coverage);
    return { lifetime: parsed.value, status: "ok", health };
  } catch {
    health.readable = false;
    noteProvenance(health, "unknown");
    return { lifetime: null, status: "corrupt", health };
  }
}

function safeRecent(reader: AccountingReader): { packets: AccountingRequestPacket[]; health: ProjectionHealth } {
  const health = newHealth();
  // Reader intentionally exposes a bounded recent view rather than a raw scan.
  health.partial = true;
  noteProvenance(health, "unknown");
  try {
    const result = reader.readRecent({ limit: DASHBOARD_MAX_RECENT_ROWS });
    if (result.status !== "ok") {
      health.readable = false;
      return { packets: [], health };
    }
    const packets: AccountingRequestPacket[] = [];
    for (const candidate of result.value) {
      if (packets.length >= DASHBOARD_MAX_RECENT_ROWS) {
        health.partial = true;
        break;
      }
      const parsed = parseAccountingRequestPacketV1(candidate);
      if (!parsed.ok) {
        health.partial = true;
        continue;
      }
      packets.push(parsed.value);
    }
    return { packets, health };
  } catch {
    health.readable = false;
    return { packets: [], health };
  }
}

function requestMatches(packet: AccountingRequestPacket, query: DashboardSnapshotQuery): boolean {
  return matchesTuple(packet, query);
}

function packetWithinWindow(packet: AccountingRequestPacket, plan: WindowPlan): boolean {
  if (plan.from === null) return false;
  const at = Date.parse(packet.endedAt);
  return Number.isFinite(at) && at >= plan.from.valueOf() && at < plan.to.valueOf();
}

function processRows(
  days: readonly AccountingDayShard[],
  plan: WindowPlan,
  query: DashboardSnapshotQuery,
  buckets: readonly MutableStats[],
  total: MutableStats,
  providers: Map<string, DimensionState>,
  models: Map<string, DimensionState>,
  clients: Map<string, DimensionState>,
  credentials: Map<string, DimensionState>,
  errors: Map<string, ErrorDistributionRowV1>,
  health: ProjectionHealth,
): void {
  if (plan.from === null || plan.to.valueOf() <= plan.from.valueOf()) {
    if (health.readable && !health.partial) health.noMatchingRows = true;
    return;
  }
  const seenCells = new Set<string>();
  const useRootAggregates = !hasTupleFilter(query);
  for (const day of days) {
    for (const minute of Object.keys(day.cells).sort()) {
      const cell = day.cells[minute];
      if (cell === undefined) continue;
      const at = Date.parse(cell.from);
      if (!Number.isFinite(at) || at < plan.from.valueOf() || at >= plan.to.valueOf()) continue;
      const cellKey = `${day.date}\u0000${cell.from}`;
      if (seenCells.has(cellKey)) {
        health.partial = true;
        noteProvenance(health, "unknown");
        continue;
      }
      seenCells.add(cellKey);
      const bucketIndex = Math.floor((at - plan.from.valueOf()) / plan.bucketMs);
      const bucket = buckets[bucketIndex];
      if (bucket === undefined) continue;
      noteAccountingCoverage(health, {
        state: cell.coverage.state,
        reason: cell.coverage.reason,
        droppedRows: cell.coverage.droppedRows,
        droppedRecent: 0,
        droppedDetails: 0,
        droppedDedup: 0,
        retentionFrom: null,
        retentionDays: null,
        losses: cell.coverage.losses,
      });
      if (useRootAggregates) {
        addRequestAggregate(bucket, cell.aggregate);
        addRequestAggregate(total, cell.aggregate);
        if (query.includeRepair) {
          addAttemptAggregate(bucket, cell.aggregate);
          addAttemptAggregate(total, cell.aggregate);
        }
      }
      for (const row of cell.rows) {
        if (!matchesTuple(rowTuple(row), query)) continue;
        if (row.kind === "attempt" && row.role === "repair" && !query.includeRepair) continue;
        const bucketStats = bucket;
        if (!useRootAggregates) {
          if (row.kind === "request") {
            addRequestAggregate(bucketStats, row);
            addRequestAggregate(total, row);
          } else {
            addAttemptAggregate(bucketStats, row);
            addAttemptAggregate(total, row);
          }
        } else if (row.kind === "attempt" && !query.includeRepair) {
          // Root aggregates retain repair and serve attempts together.  With
          // repair hidden, use only the role-separated attempt rows for that
          // one scalar; request facts stay exact in the root aggregate.
          addAttemptAggregate(bucketStats, row);
          addAttemptAggregate(total, row);
        }
        const values: Record<"provider" | "model" | "client" | "credential", readonly string[] | null> = {
          provider: row.provider === null ? null : [row.provider],
          model: row.provider === null || row.model === null ? null : [row.provider, row.model],
          client: row.client === null ? null : [row.client],
          credential: row.provider === null || row.credentialId === null ? null : [row.provider, row.credentialId],
        };
        if (values.provider === null || values.model === null || values.client === null || values.credential === null) {
          // A row missing one of its own identity fields (e.g. a synthesized all-capped
          // 429 carries no credentialId) is genuinely omitted from that dimension's
          // panel, not a token kind nobody reported — kept as partial (audited 2026-08-23).
          health.partial = true;
          noteProvenance(health, "unknown");
        }
        addDimension(providers, values.provider, row, health);
        addDimension(models, values.model, row, health);
        addDimension(clients, values.client, row, health);
        addDimension(credentials, values.credential, row, health);
        if (row.kind === "request" && row.failureKind !== null) {
          const errorKey = `${row.failureKind}\u0000${row.outcome}`;
          const current = errors.get(errorKey);
          if (current !== undefined) {
            current.requests = boundedAdd(current.requests, safeInteger(row.requests), health);
          } else if (errors.size < DASHBOARD_MAX_ERROR_ROWS) {
            errors.set(errorKey, { failureKind: row.failureKind, outcome: row.outcome, requests: safeInteger(row.requests) });
          } else {
            health.partial = true;
            noteProvenance(health, "unknown");
          }
        }
      }
    }
  }
  if (total.requests > 0 || total.attempts > 0) health.noMatchingRows = false;
  else if (health.readable && !health.partial) health.noMatchingRows = true;
}

function processLifetime(
  lifetime: AccountingLifetime,
  plan: WindowPlan,
  query: DashboardSnapshotQuery,
  buckets: readonly MutableStats[],
  total: MutableStats,
  health: ProjectionHealth,
): void {
  if (plan.from === null) {
    if (health.readable && !health.partial) health.noMatchingRows = true;
    return;
  }
  if (hasTupleFilter(query)) return;
  // The root total remains the authoritative lifetime total even when the
  // bounded month map has overflowed.  Any bucket/total divergence remains
  // coverage-labelled by the store's overflow/loss state.
  addRequestAggregate(total, lifetime.aggregate);
  if (query.includeRepair) addAttemptAggregate(total, lifetime.aggregate);
  for (let index = 0; index < buckets.length; index += 1) {
    const month = addUtcMonths(plan.from, index).toISOString().slice(0, 7);
    const source = lifetime.months[month];
    if (source === undefined) continue;
    noteAccountingCoverage(health, source.coverage);
    addRequestAggregate(buckets[index]!, source.aggregate);
    if (query.includeRepair) {
      addAttemptAggregate(buckets[index]!, source.aggregate);
    }
  }
  if (total.requests > 0 || total.attempts > 0) health.noMatchingRows = false;
  else if (health.readable && !health.partial) health.noMatchingRows = true;
}

function retentionTimestamp(value: string | null): string | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Create the read port consumed by dashboard routes.  The returned object has
 * no mutable aliases into the accounting reader or availability snapshot.
 */
export function createDashboardSnapshotReadPort(options: DashboardSnapshotReadOptions): DashboardReadPort & CostReportingPort {
  const reader = options.accounting;
  const relayVersion = typeof options.relayVersion === "string" ? options.relayVersion : "unknown";
  const attributionPolicy = isDashboardAttributionPolicy(options.attributionPolicy) ? options.attributionPolicy : "unknown";

  return Object.freeze({
    /**
     * The `llm-relay cost` roll-up (open-decisions C1). One aggregation, one policy: the
     * window plan and day reads come from the SAME functions the snapshot uses, the TOTAL
     * comes from the root minute-cell aggregates (exact under every row cap), and only the
     * per-value rows walk dimension rows (capped, and marked partial when capped).
     * Repair spend is folded from role:"repair" attempt rows — never derived by
     * subtraction, because failed serve attempts also carry attempt-side spend.
     */
    async readCostReport(query: CostReportQuery): Promise<CostReportV1> {
      const by: CostBy = query.by ?? "provider";
      const includeRepair = query.includeRepair === true;
      const generatedAt = clockDate(options.now);
      const health = newHealth();
      const total = newStats();
      const dimensions = new Map<string, DimensionState>();
      // The lifetime window declines the serve/repair split (month rollups mix both roles
      // in one figure), so its accumulator is never built — leaving it built-but-unfilled
      // would emit a zeroed share that reads as a measurement ("repair cost $0") when the
      // truth is that the split cannot be proven there.
      const repair = includeRepair && query.window !== "lifetime" ? newRepairAccumulator() : null;

      let lifetimeResult: ReturnType<typeof safeReadLifetime> | null = null;
      if (query.window === "lifetime") lifetimeResult = safeReadLifetime(reader);
      const plan = windowPlan(query.window, generatedAt, lifetimeResult?.lifetime?.firstRequestAt ?? null);

      if (query.window === "lifetime") {
        // Month rollups mix serve and repair attempt spend in one root figure and carry no
        // dimension rows, so this window reports only the exact request-scoped total; the
        // repair split and the per-value rows decline rather than guess.
        const lifetime = lifetimeResult?.lifetime ?? null;
        if (lifetime !== null && plan.from !== null) {
          noteAccountingCoverage(health, lifetime.coverage);
          addRequestAggregate(total, lifetime.aggregate);
          if (includeRepair) addAttemptAggregate(total, lifetime.aggregate);
        } else if (lifetimeResult?.status === "missing") {
          // A MISSING lifetime.json is an empty store, not a broken one: the cost report
          // must reach the friendly "no accounting data yet" state, which coverageFor
          // reaches only with readable intact and noMatchingRows set. Corrupt/throw keeps
          // readable:false ⇒ unavailable.
          health.noMatchingRows = true;
        } else {
          health.readable = false;
        }
      } else if (plan.from !== null && plan.to.valueOf() > plan.from.valueOf()) {
        const dates = datesFor(plan);
        const read = readCostDays(reader, dates);
        for (const day of read.days) {
          noteAccountingCoverage(health, day.coverage);
          for (const minute of Object.keys(day.cells).sort()) {
            const cell = day.cells[minute];
            if (cell === undefined) continue;
            const at = Date.parse(cell.from);
            if (!Number.isFinite(at) || at < plan.from.valueOf() || at >= plan.to.valueOf()) continue;
            noteAccountingCoverage(health, {
              state: cell.coverage.state,
              reason: cell.coverage.reason,
              droppedRows: cell.coverage.droppedRows,
              droppedRecent: 0,
              droppedDetails: 0,
              droppedDedup: 0,
              retentionFrom: null,
              retentionDays: null,
              losses: cell.coverage.losses,
            });
            // Total: the root aggregate. Exact even when dimension rows hit their caps.
            addRequestAggregate(total, cell.aggregate);
            if (includeRepair) addAttemptAggregate(total, cell.aggregate);
            for (const row of cell.rows) {
              if (row.kind === "attempt") {
                if (row.role === "repair" && repair !== null) foldRepairAttempt(repair, row, health);
                continue;
              }
              const values = costDimensionValues(by, row);
              if (values === null) {
                // Ungroupable traffic still sits in the exact total above; naming the gap
                // beats letting the per-value rows quietly fail to sum to it.
                health.partial = true;
                noteProvenance(health, "unknown");
                continue;
              }
              addDimension(dimensions, values, row, health);
            }
          }
        }
        if (read.failed) {
          // A thrown read is a hard failure, not an absent window — same verdict as
          // safeReadLifetime/safeReadDays give a throw (unavailable, not empty).
          health.readable = false;
          noteProvenance(health, "unknown");
        }
        if (read.capped || read.corrupt > 0) {
          health.partial = true;
          noteProvenance(health, "unknown");
        }
        // Every shard ABSENT is an empty window, not a broken store: the cost report must be
        // able to say "no accounting data yet", which coverageFor reaches only when readable
        // stays true and noMatchingRows is set. Only a read failure or a corrupt shard means
        // unavailable/partial — a missing file is the normal state of a fresh install.
        if (read.days.length === 0 && read.missing === dates.length) health.noMatchingRows = true;
      } else {
        health.readable = false;
      }

      finalizeHealth(total);
      mergeHealth(health, total.health);
      const rows = materializeCostRows(dimensions, by, health);
      const value: CostReportV1 = {
        schema: DASHBOARD_COST_SCHEMA,
        generatedAt: generatedAt.toISOString(),
        from: plan.from?.toISOString() ?? null,
        to: plan.to.toISOString(),
        window: query.window,
        includeRepair,
        by,
        rows,
        total: costRowFrom("(total)", total),
        repair: repair === null ? null : {
          attempts: repair.attempts,
          unpricedAttempts: repair.unpricedAttempts,
          spend: repairShareCells(repair.spend),
        },
        coverage: coverageFor("spend", health).state,
        coverageReason: coverageFor("spend", health).reason,
        recentMinutesMayLag: true,
      };
      assertCostReportV1(value);
      return deepFreeze(value);
    },

    async readSnapshot(query: DashboardSnapshotQuery): Promise<SnapshotV1> {
      const generatedAt = clockDate(options.now);
      let lifetimeResult: ReturnType<typeof safeReadLifetime> | null = null;
      if (query.window === "lifetime") lifetimeResult = safeReadLifetime(reader);
      const plan = windowPlan(query.window, generatedAt, lifetimeResult?.lifetime?.firstRequestAt ?? null);
      const bounds = bucketBounds(plan);
      const buckets = bounds.map(() => newStats());
      const total = newStats();
      const providers = new Map<string, DimensionState>();
      const models = new Map<string, DimensionState>();
      const clients = new Map<string, DimensionState>();
      const credentials = new Map<string, DimensionState>();
      const errors = new Map<string, ErrorDistributionRowV1>();
      let dataHealth: ProjectionHealth;
      let retentionFrom: string | null = null;
      // Reserved at null: the accounting store exposes a retention start cursor but no end
      // cursor, so this stays null until that exists. Never read it as "no pruning happened".
      let retentionTo: string | null = null;

      if (query.window === "lifetime") {
        dataHealth = lifetimeResult?.health ?? emptyAvailabilityHealth();
        if (lifetimeResult?.lifetime !== null && lifetimeResult?.lifetime !== undefined) {
      retentionFrom = retentionTimestamp(lifetimeResult.lifetime.coverage.retentionFrom);
      processLifetime(lifetimeResult.lifetime, plan, query, buckets, total, dataHealth);
        }
      } else {
        const read = safeReadDays(reader, datesFor(plan));
        dataHealth = read.health;
        for (const day of read.days) {
          const candidate = retentionTimestamp(day.coverage.retentionFrom);
          if (candidate !== null && (retentionFrom === null || candidate < retentionFrom)) retentionFrom = candidate;
        }
      processRows(read.days, plan, query, buckets, total, providers, models, clients, credentials, errors, dataHealth);
      }
      finalizeHealth(total);
      mergeHealth(dataHealth, total.health);

      const recent = safeRecent(reader);
      const recentRows = recent.packets
        .filter((packet) => packetWithinWindow(packet, plan) && requestMatches(packet, query))
        .slice(0, DASHBOARD_MAX_RECENT_ROWS)
        .map((packet) => requestRow(packet));
      if (recentRows.length === 0 && recent.health.readable && !recent.health.partial) recent.health.noMatchingRows = true;
      recentRows.sort((left, right) => right.occurredAt === left.occurredAt ? left.requestId.localeCompare(right.requestId) : right.occurredAt.localeCompare(left.occurredAt));

      const availability = resolveAvailability(options.availability);
      const availabilityOutput = availabilityRows(availability.snapshot, query, availability.health);
      const summary = summaryFrom(total);
      const bucketRows = bounds.map((bound, index) => bucketFrom(bound.from, bound.to, buckets[index]!));
      const errorRows = [...errors.values()];
      errorRows.sort((left, right) => right.requests === left.requests ? `${left.failureKind}\u0000${left.outcome}`.localeCompare(`${right.failureKind}\u0000${right.outcome}`) : right.requests - left.requests);

      const lifetimeUnavailablePanels = new Set<PanelId>();
      if (query.window === "lifetime") {
        if (hasTupleFilter(query)) {
          for (const panel of PANEL_IDS) {
            if (panel !== "recent" && panel !== "quotas" && panel !== "cooldowns") lifetimeUnavailablePanels.add(panel);
          }
        } else {
          for (const panel of ["provider", "model", "client", "credential", "errors"] as const) lifetimeUnavailablePanels.add(panel);
          if (!query.includeRepair) {
            // Role-separated attempt values are absent from month rollups.  The
            // numeric fields stay structural zero/null, with no claim that the
            // excluded repair work was measured as zero.
            lifetimeUnavailablePanels.add("summary");
            lifetimeUnavailablePanels.add("request_timeline");
          }
        }
      }
      const panelCoverage = PANEL_IDS.map((panel) => {
        if (panel === "recent") return coverageFor(panel, recent.health);
        if (panel === "quotas") return coverageFor(panel, availabilityOutput.quotaHealth);
        if (panel === "cooldowns") return coverageFor(panel, availabilityOutput.cooldownHealth);
        if (lifetimeUnavailablePanels.has(panel)) return unavailableCoverageFor(panel, dataHealth);
        return coverageFor(panel, dataHealth);
      });
      const value: SnapshotV1 = {
        schema: DASHBOARD_SNAPSHOT_SCHEMA,
        relayVersion,
        window: query.window,
        includeRepair: query.includeRepair === true,
        attribution: mapDashboardQueryAttribution(query.attribution),
        attributionPolicy,
        generatedAt: generatedAt.toISOString(),
        asOf: plan.asOf.toISOString(),
        from: plan.from?.toISOString() ?? null,
        to: plan.to.toISOString(),
        retentionFrom,
        retentionTo,
        panelCoverage,
        summary,
        buckets: bucketRows,
        providers: materializeDimensions(providers, "provider"),
        models: materializeDimensions(models, "model"),
        clients: materializeDimensions(clients, "client"),
        credentials: materializeDimensions(credentials, "credential"),
        errors: errorRows,
        quotas: availabilityOutput.quotas,
        cooldowns: availabilityOutput.cooldowns,
        recentRequests: recentRows,
      };
      assertSnapshotV1(value);
      return deepFreeze(value);
    },

    async readDetail(query: DashboardDetailQuery): Promise<DetailV1 | null> {
      let packet: AccountingRequestPacket;
      try {
        const result = reader.readDetail(query.requestId);
        if (result.status !== "ok") return null;
        const parsed = parseAccountingRequestPacketV1(result.value);
        if (!parsed.ok) return null;
        packet = parsed.value;
      } catch {
        return null;
      }
    const health = newHealth();
    const request = requestRow(packet, health);
    const attempts = packet.attempts
        .filter((attempt) => query.includeRepair || attempt.role !== "repair")
        .slice(0, DASHBOARD_MAX_DETAIL_ATTEMPTS)
      .map((attempt) => attemptRow(attempt, health));
      attempts.sort((left, right) => left.startedAt === right.startedAt ? left.attemptId.localeCompare(right.attemptId) : left.startedAt.localeCompare(right.startedAt));
      if (packet.attemptMetadata.dropped > 0 || packet.attemptMetadata.stored < packet.attemptMetadata.total) {
        health.partial = true;
        noteProvenance(health, "unknown");
      }
      const value: DetailV1 = {
        schema: DASHBOARD_DETAIL_SCHEMA,
      request,
        attempts,
        panelCoverage: [coverageFor("recent", health)],
      };
      assertDetailV1(value);
      return deepFreeze(value);
    },
  });
}
