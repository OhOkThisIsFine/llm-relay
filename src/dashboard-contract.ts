import { hasExactKeys as isExactRecord, isRecord } from "./json-shape.js";

/**
 * Server-safe wire contract shared by the analytics dashboard and relay.
 *
 * This module deliberately has no platform imports.  It contains only the
 * versioned media/schema vocabulary and the bounded read-model shapes; route,
 * authentication, retention, and pricing decisions belong to their owners.
 */

export const DASHBOARD_MEDIA_TYPE_BASE = "application/vnd.llm-relay.dashboard+json";
export const DASHBOARD_MEDIA_VERSION = 1;
export const DASHBOARD_MEDIA_TYPE = `${DASHBOARD_MEDIA_TYPE_BASE}; version=${DASHBOARD_MEDIA_VERSION}`;

export const DASHBOARD_SNAPSHOT_SCHEMA = "dashboard.snapshot.v1";
export const DASHBOARD_DETAIL_SCHEMA = "dashboard.detail.v1";
export const DASHBOARD_COST_SCHEMA = "dashboard.cost.v1";
export const DASHBOARD_ERROR_SCHEMA = "dashboard.error.v1";

/** The request/query and response body bounds are intentionally explicit. */
export const DASHBOARD_MAX_REQUEST_BYTES = 16 * 1024;
export const DASHBOARD_MAX_BODY_BYTES = DASHBOARD_MAX_REQUEST_BYTES;
export const DASHBOARD_MAX_BUCKETS = 720;
export const DASHBOARD_MAX_DIMENSION_ROWS = 100;
export const DASHBOARD_MAX_ERROR_ROWS = 40;
export const DASHBOARD_MAX_RECENT_ROWS = 100;
export const DASHBOARD_MAX_DETAIL_ATTEMPTS = 32;
export const DASHBOARD_REQUEST_ID_MIN_LENGTH = 16;
export const DASHBOARD_REQUEST_ID_MAX_LENGTH = 128;
export const DASHBOARD_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const DASHBOARD_ATTEMPT_ID_MIN_LENGTH = 1;
export const DASHBOARD_MAX_QUERY_BYTES = DASHBOARD_MAX_REQUEST_BYTES;
export const DASHBOARD_SAFE_ID_MAX_BYTES = 256;
export const DASHBOARD_ATTEMPT_ID_MAX_BYTES = DASHBOARD_SAFE_ID_MAX_BYTES;

/** Query spelling is deliberately distinct from response attribution spelling. */
export const DASHBOARD_QUERY_INCLUDE_REPAIR_VALUES = Object.freeze(["0", "1"] as const);
export type DashboardQueryIncludeRepair = (typeof DASHBOARD_QUERY_INCLUDE_REPAIR_VALUES)[number];
export const DASHBOARD_QUERY_ATTRIBUTION_VALUES = Object.freeze(["relay-held", "caller-operated", "all"] as const);
export type DashboardQueryAttribution = (typeof DASHBOARD_QUERY_ATTRIBUTION_VALUES)[number];
export const DASHBOARD_QUERY_PARAMETER_NAMES = Object.freeze([
  "window",
  "includeRepair",
  "attribution",
  "provider",
  "model",
  "client",
  "credentialId",
  "outcome",
  "failureKind",
] as const);
export type DashboardQueryParameterName = (typeof DASHBOARD_QUERY_PARAMETER_NAMES)[number];
export const DASHBOARD_QUERY_FILTER_NAMES = Object.freeze([
  "attribution",
  "provider",
  "model",
  "client",
  "credentialId",
  "outcome",
  "failureKind",
] as const);
export type DashboardQueryFilterName = (typeof DASHBOARD_QUERY_FILTER_NAMES)[number];

export const WINDOW_IDS = Object.freeze(["1h", "24h", "7d", "30d", "today", "month", "lifetime"] as const);
export type WindowId = (typeof WINDOW_IDS)[number];

/**
 * The `llm-relay cost --by` grouping axis. Closed here so the CLI's flag validation, the
 * roll-up projection, and the wire guard cannot drift apart.
 */
export const COST_BY_VALUES = Object.freeze(["provider", "model", "client", "credential"] as const);
export type CostBy = (typeof COST_BY_VALUES)[number];

export const QUOTA_AXES = Object.freeze(["requests", "tokens"] as const);
export type QuotaAxis = (typeof QUOTA_AXES)[number];

export const QUOTA_PERIODS = Object.freeze(["minute", "day", "month", "unknown"] as const);
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];

export const COVERAGE_STATES = Object.freeze(["complete", "partial", "unavailable", "stale", "empty"] as const);
export type Coverage = (typeof COVERAGE_STATES)[number];

export const PANEL_IDS = Object.freeze([
  "summary",
  "request_timeline",
  "token_timeline",
  "spend",
  "provider",
  "model",
  "client",
  "credential",
  "latency",
  "commit",
  "errors",
  "recent",
  "quotas",
  "cooldowns",
] as const);
export type PanelId = (typeof PANEL_IDS)[number];

export const OUTCOMES = Object.freeze(["success", "error", "cancelled", "unknown"] as const);
export type Outcome = (typeof OUTCOMES)[number];

export const FAILURE_KINDS = Object.freeze([
  "timeout",
  "provider_error",
  "auth_error",
  "rate_limit",
  "aborted",
  "protocol",
  "unknown",
] as const);
export type FailureKind = (typeof FAILURE_KINDS)[number];

export const ATTRIBUTIONS = Object.freeze(["relay_held", "caller_operated", "unknown"] as const);
export type Attribution = (typeof ATTRIBUTIONS)[number];

export const ATTRIBUTION_POLICIES = Object.freeze([
  "exclude_caller_operated_from_relay_held_caps",
  "include_all_labeled",
  "unknown",
] as const);
export type AttributionPolicy = (typeof ATTRIBUTION_POLICIES)[number];

export const COOLDOWN_REASONS = Object.freeze(["rate_limit", "auth_error", "provider_error", "manual", "unknown"] as const);
export type CooldownReason = (typeof COOLDOWN_REASONS)[number];

export const COVERAGE_REASONS = Object.freeze([
  "meter_not_implemented",
  "retention_pruned",
  "upstream_unavailable",
  "projection_lag",
  "no_matching_rows",
  "unknown",
] as const);
export type CoverageReason = (typeof COVERAGE_REASONS)[number];

export const PROVENANCE_VALUES = Object.freeze([
  "provider_reported",
  "relay_observed",
  "relay_estimated",
  "unknown",
  "mixed",
] as const);
export type Provenance = (typeof PROVENANCE_VALUES)[number];

export const ATTEMPT_ROLES = Object.freeze(["serve", "repair"] as const);
export type AttemptRole = (typeof ATTEMPT_ROLES)[number];

export const DASHBOARD_ERROR_CODES = Object.freeze([
  "malformed_query",
  "invalid_auth",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "unsupported_version",
  "replay",
  "oversized",
  "unsupported_content_type",
  "internal",
] as const);
export type DashboardErrorCode = (typeof DASHBOARD_ERROR_CODES)[number];

export const DASHBOARD_ERROR_MESSAGES = Object.freeze([
  "Request could not be completed.",
  "Dashboard session is unavailable.",
  "Requested dashboard data was not found.",
] as const);
export type DashboardErrorMessage = (typeof DASHBOARD_ERROR_MESSAGES)[number];

export type TokenSource = "provider_reported" | "relay_estimated";
export type SpendPriceSource = "provider_published" | "reference";
export type TokenBasis = "reported" | "estimated";
export type SpendSource = "provider_reported" | "relay_estimated" | "unknown";
// `published` / `derived_published` were added 2026-08-22 when the availability producer landed:
// a catalog-harvested rate limit (spec Gap 13) is a fourth limit provenance, and collapsing it
// onto `configured` or `learned` would mislabel where the number came from.
export type LimitBasis = "provider_stated" | "configured" | "learned" | "published";
export type RemainingBasis =
  | "provider_stated"
  | "derived_provider_stated"
  | "derived_configured"
  | "derived_learned"
  | "derived_published";
/** `relay_counted` is a completed-request total observed by the relay, not provider reporting. */
export type LocalUsedBasis = "reported" | "estimated" | "mixed" | "relay_counted";
/**
 * Where a quota row's `resetsAt` came from (spec §5.2 ladder). `provider_stated` is the response's
 * own header/observation; `reviewed_rule` is a persisted reviewed refusal-interpretation rule
 * (added 2026-08-23, additive — the rung existed unfed until the fact store started persisting
 * reset provenance); `derived_boundary` is the UTC period boundary this relay computed.
 */
export type ResetsAtBasis = "provider_stated" | "reviewed_rule" | "derived_boundary";
export const TOKEN_SOURCES = Object.freeze(["provider_reported", "relay_estimated"] as const);
export const SPEND_PRICE_SOURCES = Object.freeze(["provider_published", "reference"] as const);
export const TOKEN_BASES = Object.freeze(["reported", "estimated"] as const);
export const SPEND_SOURCES = Object.freeze(["provider_reported", "relay_estimated", "unknown"] as const);
export const LIMIT_BASES = Object.freeze(["provider_stated", "configured", "learned", "published"] as const);
export const REMAINING_BASES = Object.freeze(["provider_stated", "derived_provider_stated", "derived_configured", "derived_learned", "derived_published"] as const);
export const LOCAL_USED_BASES = Object.freeze(["reported", "estimated", "mixed", "relay_counted"] as const);
export const RESETS_AT_BASES = Object.freeze(["provider_stated", "reviewed_rule", "derived_boundary"] as const);

export type ResponseAttribution = Attribution | "all";
export const RESPONSE_ATTRIBUTIONS = Object.freeze(["relay_held", "caller_operated", "unknown", "all"] as const);

/**
 * Map a snapshot query's attribution filter onto the response attribution it selects.
 *
 * Both spellings are owned by this contract (DASHBOARD_QUERY_ATTRIBUTION_VALUES vs
 * ATTRIBUTIONS), so the pairing lives here too — a route validating a query and a
 * projection labelling its rows must not re-derive it separately and drift.
 */
export function mapDashboardQueryAttribution(value: DashboardQueryAttribution | undefined): Attribution | "all" {
  if (value === "relay-held") return "relay_held";
  if (value === "caller-operated") return "caller_operated";
  return "all";
}

export interface PanelCoverageV1 {
  panel: PanelId;
  state: Coverage;
  reason: CoverageReason | null;
  provenance: Provenance[];
  observedAt: string | null;
}

export interface ReportedTokenCell {
  value: number | null;
  source: "provider_reported";
  observedAt: string | null;
}

export interface EstimatedTokenCell {
  value: number | null;
  source: "relay_estimated";
  observedAt: string | null;
  method: string | null;
}

export interface ReportedTokenTotals {
  reportedInput: ReportedTokenCell;
  reportedOutput: ReportedTokenCell;
  reportedCachedInput: ReportedTokenCell;
}

export interface EstimatedTokenTotals {
  estimatedInput: EstimatedTokenCell;
  estimatedOutput: EstimatedTokenCell;
}

export interface TokenTotalsV1 {
  reported: ReportedTokenTotals;
  estimated: EstimatedTokenTotals;
}

export interface ProviderPublishedReported {
  amountMicrousd: number | null;
  priceSource: "provider_published";
  tokenBasis: "reported";
  source: "provider_reported" | "unknown";
  observedAt: string | null;
}

export interface ProviderPublishedEstimated {
  amountMicrousd: number | null;
  priceSource: "provider_published";
  tokenBasis: "estimated";
  source: "relay_estimated" | "unknown";
  observedAt: string | null;
}

export interface ReferenceReported {
  amountMicrousd: number | null;
  priceSource: "reference";
  tokenBasis: "reported";
  source: "provider_reported" | "unknown";
  observedAt: string | null;
}

export interface ReferenceEstimated {
  amountMicrousd: number | null;
  priceSource: "reference";
  tokenBasis: "estimated";
  source: "relay_estimated" | "unknown";
  observedAt: string | null;
}

export interface SpendTotalsV1 {
  providerPublishedReported: ProviderPublishedReported;
  providerPublishedEstimated: ProviderPublishedEstimated;
  referenceReported: ReferenceReported;
  referenceEstimated: ReferenceEstimated;
  /**
   * Requests that projected NO spend: never served, or served by a deployment that
   * publishes no price for either token kind. Deliberately NOT every request — a
   * free-model request is fully priced at $0 and must not read as a gap.
   */
  unpricedRequests: number;
  /**
   * Requests WITH a spend figure that also carried token kinds no published price covers
   * (Anthropic cache creation/read, OpenAI cached input, or an unpublished output price).
   * Every amount above is a LOWER BOUND while this is greater than zero.
   */
  partiallyPricedRequests: number;
}

/**
 * One row of the `llm-relay cost` roll-up (open-decisions C1): a dimension value's
 * REQUEST-scoped spend in the four provenance-labelled cells, plus the counters the
 * provenance story needs. Deliberately NOT a blended total — cells are printed side by
 * side; a caller wanting one number must pick ONE cell (provider_published × reported)
 * and say so.
 */
export interface CostRowV1 {
  /** The dimension value this row aggregates: a provider, model id, client name, or credential id. */
  readonly key: string;
  readonly requests: number;
  /** Requests minus {@link SpendTotalsV1.unpricedRequests}: a figure existed for the rest. */
  readonly pricedRequests: number;
  readonly spend: SpendTotalsV1;
}

/**
 * The repair-attempt share of a cost report, present only under `--include-repair`.
 *
 * This is C1's direct answer to "what did tool-call repair cost me", and it is NOT
 * derivable by subtracting serve-side figures: failed serve attempts also carry
 * attempt-side spend, so only a direct fold of role:"repair" rows gives the true share.
 * Its counters are ATTEMPT-scoped (unlike SpendTotalsV1's request-scoped ones) because
 * that is what the persisted attempt aggregates can prove; per-attempt price coverage
 * is not persisted, so this shape deliberately carries no lower-bound count — the
 * renderer states the cache-token caveat in prose instead.
 */
export interface RepairShareV1 {
  readonly attempts: number;
  /** Repair attempts that produced no priced figure at all — never rendered as $0. */
  readonly unpricedAttempts: number;
  readonly spend: Omit<SpendTotalsV1, "unpricedRequests" | "partiallyPricedRequests">;
}

/** One window's roll-up as emitted by `llm-relay cost --json` (`dashboard.cost.v1`). */
export interface CostReportV1 {
  readonly schema: typeof DASHBOARD_COST_SCHEMA;
  readonly generatedAt: string;
  /** UTC start of the window; null exactly when the window has no bounded start. */
  readonly from: string | null;
  readonly to: string;
  readonly window: WindowId;
  /** Repair attempts were folded into the totals (C1's `--include-repair`). */
  readonly includeRepair: boolean;
  /** Which grouping produced {@link CostRowV1.key}. */
  readonly by: CostBy;
  /** Rows sorted by descending requests; capped at DASHBOARD_MAX_DIMENSION_ROWS. */
  readonly rows: readonly CostRowV1[];
  /** The all-dimensions total for this same period. Root aggregates, exact under row caps. */
  readonly total: CostRowV1;
  /**
   * The repair-attempt share of the SAME period, present ONLY under includeRepair.
   * Null also for the `lifetime` window: its month rollups mix serve and repair
   * attempt spend in one figure, so the split cannot be proven there.
   */
  readonly repair: RepairShareV1 | null;
  /** Same coverage vocabulary as the dashboard panels; `empty` = no accounting data yet. */
  readonly coverage: Coverage;
  readonly coverageReason: CoverageReason | null;
  /**
   * True when the store was read from disk while a relay process may still hold
   * unflushed in-memory deltas: the last minutes of the window can lag until flush.
   */
  readonly recentMinutesMayLag: boolean;
}

export interface SummaryV1 {
  requests: number;
  attempts: number;
  served: number;
  errored: number;
  cancelled: number;
  successRate: number | null;
  tokens: TokenTotalsV1;
  spend: SpendTotalsV1;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  avgCommitMs: number | null;
}

export interface BucketV1 {
  from: string;
  to: string;
  requests: number;
  attempts: number;
  served: number;
  errored: number;
  cancelled: number;
  successRate: number | null;
  tokens: TokenTotalsV1;
  spend: SpendTotalsV1;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  avgCommitMs: number | null;
}

export interface DimensionSummaryV1 {
  requests: number;
  attempts: number;
  served: number;
  errored: number;
  cancelled: number;
  successRate: number | null;
  tokens: TokenTotalsV1;
  spend: SpendTotalsV1;
  avgLatencyMs: number | null;
  avgCommitMs: number | null;
  coverage: Coverage;
}

export interface ProviderDimensionRowV1 extends DimensionSummaryV1 {
  dimension: "provider";
  provider: string;
}

export interface ModelDimensionRowV1 extends DimensionSummaryV1 {
  dimension: "model";
  provider: string;
  model: string;
}

export interface ClientDimensionRowV1 extends DimensionSummaryV1 {
  dimension: "client";
  client: string;
}

export interface CredentialDimensionRowV1 extends DimensionSummaryV1 {
  dimension: "credential";
  provider: string;
  credentialId: string;
  label: string;
}

export type DimensionRowV1 =
  | ProviderDimensionRowV1
  | ModelDimensionRowV1
  | ClientDimensionRowV1
  | CredentialDimensionRowV1;

export interface ErrorDistributionRowV1 {
  failureKind: FailureKind;
  outcome: Outcome;
  requests: number;
}

export interface RequestRowV1 {
  requestId: string;
  occurredAt: string;
  client: string | null;
  attribution: Attribution;
  outcome: Outcome;
  failureKind: FailureKind | null;
  attemptCount: number;
  latencyMs: number | null;
  commitMs: number | null;
  provider: string | null;
  model: string | null;
  credentialId: string | null;
  tokens: TokenTotalsV1;
  spend: SpendTotalsV1;
  repairIncluded: boolean;
}

export interface AttemptRowV1 {
  attemptId: string;
  role: AttemptRole;
  startedAt: string;
  endedAt: string | null;
  status: Outcome;
  latencyMs: number | null;
  commitMs: number | null;
  provider: string | null;
  model: string | null;
  credentialId: string | null;
  failureKind: FailureKind | null;
  tokens: TokenTotalsV1 | null;
  spend: SpendTotalsV1 | null;
}

export interface QuotaRowV1 {
  credentialId: string;
  label: string;
  provider: string;
  deployment: string | null;
  axis: QuotaAxis;
  period: QuotaPeriod;
  limit: number | null;
  remaining: number | null;
  localUsed: number | null;
  resetsAt: string | null;
  observedAt: string | null;
  limitBasis: LimitBasis | null;
  remainingBasis: RemainingBasis | null;
  localUsedBasis: LocalUsedBasis | null;
  /**
   * Where `resetsAt` came from (spec §5.2 ladder); null when the row has no reset at all. Added
   * 2026-08-23, additive — the rung existed unfed until the fact store persisted reset provenance.
   */
  resetsAtBasis: ResetsAtBasis | null;
}

export interface CooldownRowV1 {
  credentialId: string;
  provider: string;
  deployment: string | null;
  reason: CooldownReason;
  until: string | null;
  observedAt: string | null;
}

export interface SnapshotV1 {
  schema: typeof DASHBOARD_SNAPSHOT_SCHEMA;
  relayVersion: string;
  window: WindowId;
  includeRepair: boolean;
  attribution: Attribution | "all";
  attributionPolicy: AttributionPolicy;
  generatedAt: string;
  asOf: string;
  from: string | null;
  to: string;
  retentionFrom: string | null;
  /** Reserved at null until the accounting store exposes a retention end cursor. */
  retentionTo: string | null;
  panelCoverage: PanelCoverageV1[];
  summary: SummaryV1;
  buckets: BucketV1[];
  providers: ProviderDimensionRowV1[];
  models: ModelDimensionRowV1[];
  clients: ClientDimensionRowV1[];
  credentials: CredentialDimensionRowV1[];
  errors: ErrorDistributionRowV1[];
  quotas: QuotaRowV1[];
  cooldowns: CooldownRowV1[];
  recentRequests: RequestRowV1[];
}

export interface DetailV1 {
  schema: typeof DASHBOARD_DETAIL_SCHEMA;
  request: RequestRowV1;
  attempts: AttemptRowV1[];
  panelCoverage: PanelCoverageV1[];
}

export interface DashboardErrorV1 {
  schema: typeof DASHBOARD_ERROR_SCHEMA;
  code: DashboardErrorCode;
  message: DashboardErrorMessage;
  requestId: string | null;
}

const isValueIn = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export const isDashboardMediaType = (value: unknown): value is typeof DASHBOARD_MEDIA_TYPE =>
  value === DASHBOARD_MEDIA_TYPE;
export const isDashboardWindowId = (value: unknown): value is WindowId => isValueIn(WINDOW_IDS, value);
export const isDashboardQuotaAxis = (value: unknown): value is QuotaAxis => isValueIn(QUOTA_AXES, value);
export const isDashboardQuotaPeriod = (value: unknown): value is QuotaPeriod => isValueIn(QUOTA_PERIODS, value);
export const isDashboardCoverage = (value: unknown): value is Coverage => isValueIn(COVERAGE_STATES, value);
export const isDashboardPanelId = (value: unknown): value is PanelId => isValueIn(PANEL_IDS, value);
export const isDashboardOutcome = (value: unknown): value is Outcome => isValueIn(OUTCOMES, value);
export const isDashboardFailureKind = (value: unknown): value is FailureKind => isValueIn(FAILURE_KINDS, value);
export const isDashboardAttribution = (value: unknown): value is Attribution => isValueIn(ATTRIBUTIONS, value);
export const isDashboardResponseAttribution = (value: unknown): value is ResponseAttribution =>
  isValueIn(RESPONSE_ATTRIBUTIONS, value);
export const isDashboardAttributionPolicy = (value: unknown): value is AttributionPolicy =>
  isValueIn(ATTRIBUTION_POLICIES, value);
export const isDashboardCooldownReason = (value: unknown): value is CooldownReason =>
  isValueIn(COOLDOWN_REASONS, value);
export const isDashboardCoverageReason = (value: unknown): value is CoverageReason =>
  isValueIn(COVERAGE_REASONS, value);
export const isDashboardProvenance = (value: unknown): value is Provenance => isValueIn(PROVENANCE_VALUES, value);
export const isDashboardAttemptRole = (value: unknown): value is AttemptRole => isValueIn(ATTEMPT_ROLES, value);
export const isDashboardTokenSource = (value: unknown): value is TokenSource => isValueIn(TOKEN_SOURCES, value);
export const isDashboardSpendPriceSource = (value: unknown): value is SpendPriceSource =>
  isValueIn(SPEND_PRICE_SOURCES, value);
export const isDashboardTokenBasis = (value: unknown): value is TokenBasis => isValueIn(TOKEN_BASES, value);
export const isDashboardSpendSource = (value: unknown): value is SpendSource => isValueIn(SPEND_SOURCES, value);
export const isDashboardLimitBasis = (value: unknown): value is LimitBasis => isValueIn(LIMIT_BASES, value);
export const isDashboardRemainingBasis = (value: unknown): value is RemainingBasis =>
  isValueIn(REMAINING_BASES, value);
export const isDashboardLocalUsedBasis = (value: unknown): value is LocalUsedBasis =>
  isValueIn(LOCAL_USED_BASES, value);
export const isDashboardResetsAtBasis = (value: unknown): value is ResetsAtBasis =>
  isValueIn(RESETS_AT_BASES, value);
export const isDashboardErrorCode = (value: unknown): value is DashboardErrorCode =>
  isValueIn(DASHBOARD_ERROR_CODES, value);
export const isDashboardErrorMessage = (value: unknown): value is DashboardErrorMessage =>
  isValueIn(DASHBOARD_ERROR_MESSAGES, value);
export const isDashboardQueryIncludeRepair = (value: unknown): value is DashboardQueryIncludeRepair =>
  isValueIn(DASHBOARD_QUERY_INCLUDE_REPAIR_VALUES, value);
export const isDashboardQueryAttribution = (value: unknown): value is DashboardQueryAttribution =>
  isValueIn(DASHBOARD_QUERY_ATTRIBUTION_VALUES, value);
export const isDashboardQueryParameterName = (value: unknown): value is DashboardQueryParameterName =>
  isValueIn(DASHBOARD_QUERY_PARAMETER_NAMES, value);
export const isDashboardQueryFilterName = (value: unknown): value is DashboardQueryFilterName =>
  isValueIn(DASHBOARD_QUERY_FILTER_NAMES, value);

export const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * UTF-8 byte length of a string, or null when it carries control characters or an
 * unpaired surrogate. Exported because the routes module gates the SAME query budget
 * with it before decoding — one implementation, so the limit's logic cannot drift.
 */
export const utf8ByteLength = (value: string): number | null => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) return null;
    let codePoint = codeUnit;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return null;
      codePoint = 0x10000 + ((codeUnit - 0xd800) << 10) + (next - 0xdc00);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return null;
    }
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
};

export const isDashboardSafeId = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const bytes = utf8ByteLength(value);
  return value.length >= 1 && bytes !== null && bytes <= DASHBOARD_SAFE_ID_MAX_BYTES;
};
export const isDashboardAttemptId = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const bytes = utf8ByteLength(value);
  return value.length >= DASHBOARD_ATTEMPT_ID_MIN_LENGTH && bytes !== null && bytes <= DASHBOARD_ATTEMPT_ID_MAX_BYTES;
};

export const isDashboardQueryWithinLimit = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const bytes = utf8ByteLength(value);
  return bytes !== null && bytes <= DASHBOARD_MAX_QUERY_BYTES;
};
export const isDashboardRequestBytesWithinLimit = (value: unknown): value is number =>
  isNonNegativeInteger(value) && value <= DASHBOARD_MAX_REQUEST_BYTES;

export const DASHBOARD_REQUEST_ID_PATTERN_SOURCE = DASHBOARD_REQUEST_ID_PATTERN.source;
export const isDashboardRequestId = (value: unknown): value is string =>
  typeof value === "string" && DASHBOARD_REQUEST_ID_PATTERN.test(value);

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNullable = <T>(value: unknown, guard: (candidate: unknown) => candidate is T): value is T | null =>
  value === null || guard(value);
const isBoundedArray = <T>(
  value: unknown,
  maxLength: number,
  guard: (candidate: unknown) => candidate is T,
): value is T[] => Array.isArray(value) && value.length <= maxLength && value.every(guard);

const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
export const isDashboardUtcTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= (daysInMonth ?? 0);
};

const isNullableTimestamp = (value: unknown): value is string | null =>
  isNullable(value, isDashboardUtcTimestamp);
const isNullableNonNegativeInteger = (value: unknown): value is number | null =>
  isNullable(value, isNonNegativeInteger);
/**
 * A safe integer of either sign. Deliberately NOT folded into the non-negative guard above:
 * only `QuotaRowV1.remaining` accepts negatives today (2026-08-22, additive semantics) — a
 * credential that overshot its ceiling reports limit − used < 0, which IS the information; a
 * producer that clamps it to zero would turn overshoot into a plausible-looking "exactly empty".
 * Renderers clamp for display; this contract carries the measurement.
 */
const isNullableSafeInteger = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value));
const isSuccessRate = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
const isNullableString = (value: unknown): value is string | null => isNullable(value, isString);
const isNullableSafeId = (value: unknown): value is string | null => isNullable(value, isDashboardSafeId);

export const isReportedTokenCell = (value: unknown): value is ReportedTokenCell =>
  isExactRecord(value, ["value", "source", "observedAt"]) &&
  isNullableNonNegativeInteger(value.value) &&
  value.source === "provider_reported" &&
  isNullableTimestamp(value.observedAt);
export const isEstimatedTokenCell = (value: unknown): value is EstimatedTokenCell =>
  isExactRecord(value, ["value", "source", "observedAt", "method"]) &&
  isNullableNonNegativeInteger(value.value) &&
  value.source === "relay_estimated" &&
  isNullableTimestamp(value.observedAt) &&
  isNullableString(value.method);
export const isReportedTokenTotals = (value: unknown): value is ReportedTokenTotals =>
  isExactRecord(value, ["reportedInput", "reportedOutput", "reportedCachedInput"]) &&
  isReportedTokenCell(value.reportedInput) &&
  isReportedTokenCell(value.reportedOutput) &&
  isReportedTokenCell(value.reportedCachedInput);
export const isEstimatedTokenTotals = (value: unknown): value is EstimatedTokenTotals =>
  isExactRecord(value, ["estimatedInput", "estimatedOutput"]) &&
  isEstimatedTokenCell(value.estimatedInput) &&
  isEstimatedTokenCell(value.estimatedOutput);
export const isTokenTotalsV1 = (value: unknown): value is TokenTotalsV1 =>
  isExactRecord(value, ["reported", "estimated"]) &&
  isReportedTokenTotals(value.reported) &&
  isEstimatedTokenTotals(value.estimated);

const isSpendCell = (
  value: unknown,
  priceSource: SpendPriceSource,
  tokenBasis: TokenBasis,
  sources: readonly SpendSource[],
): boolean =>
  isExactRecord(value, ["amountMicrousd", "priceSource", "tokenBasis", "source", "observedAt"]) &&
  isNullableNonNegativeInteger(value.amountMicrousd) &&
  value.priceSource === priceSource &&
  value.tokenBasis === tokenBasis &&
  isValueIn(sources, value.source) &&
  isNullableTimestamp(value.observedAt);
export const isProviderPublishedReported = (value: unknown): value is ProviderPublishedReported =>
  isSpendCell(value, "provider_published", "reported", ["provider_reported", "unknown"]);
export const isProviderPublishedEstimated = (value: unknown): value is ProviderPublishedEstimated =>
  isSpendCell(value, "provider_published", "estimated", ["relay_estimated", "unknown"]);
export const isReferenceReported = (value: unknown): value is ReferenceReported =>
  isSpendCell(value, "reference", "reported", ["provider_reported", "unknown"]);
export const isReferenceEstimated = (value: unknown): value is ReferenceEstimated =>
  isSpendCell(value, "reference", "estimated", ["relay_estimated", "unknown"]);
export const isSpendTotalsV1 = (value: unknown): value is SpendTotalsV1 =>
  isExactRecord(value, [
    "providerPublishedReported",
    "providerPublishedEstimated",
    "referenceReported",
    "referenceEstimated",
    "unpricedRequests",
    // Required, not tolerated-absent: the producer (dashboard-snapshot.ts) and this
    // validator ship in the same package, so a reader that silently accepted the
    // pre-spend shape would report every priced request as unpriced.
    "partiallyPricedRequests",
  ]) &&
  isProviderPublishedReported(value.providerPublishedReported) &&
  isProviderPublishedEstimated(value.providerPublishedEstimated) &&
  isReferenceReported(value.referenceReported) &&
  isReferenceEstimated(value.referenceEstimated) &&
  isNonNegativeInteger(value.unpricedRequests) &&
  isNonNegativeInteger(value.partiallyPricedRequests);

export const isCostRowV1 = (value: unknown): value is CostRowV1 =>
  isExactRecord(value, ["key", "requests", "pricedRequests", "spend"]) &&
  isDashboardSafeId(value.key) &&
  isNonNegativeInteger(value.requests) &&
  isNonNegativeInteger(value.pricedRequests) &&
  value.pricedRequests <= value.requests &&
  isSpendTotalsV1(value.spend);

const isSpendCellOnly = (
  value: unknown,
  priceSource: SpendPriceSource,
  tokenBasis: TokenBasis,
): boolean =>
  isExactRecord(value, ["amountMicrousd", "priceSource", "tokenBasis", "source", "observedAt"]) &&
  isNullableNonNegativeInteger(value.amountMicrousd) &&
  value.priceSource === priceSource &&
  value.tokenBasis === tokenBasis;
const isRepairShareV1 = (value: unknown): value is RepairShareV1 =>
  isExactRecord(value, ["attempts", "unpricedAttempts", "spend"]) &&
  isNonNegativeInteger(value.attempts) &&
  isNonNegativeInteger(value.unpricedAttempts) &&
  value.unpricedAttempts <= value.attempts &&
  isExactRecord(value.spend, ["providerPublishedReported", "providerPublishedEstimated", "referenceReported", "referenceEstimated"]) &&
  isSpendCellOnly(value.spend.providerPublishedReported, "provider_published", "reported") &&
  isSpendCellOnly(value.spend.providerPublishedEstimated, "provider_published", "estimated") &&
  isSpendCellOnly(value.spend.referenceReported, "reference", "reported") &&
  isSpendCellOnly(value.spend.referenceEstimated, "reference", "estimated");
export const isCostReportV1 = (value: unknown): value is CostReportV1 =>
  isExactRecord(value, [
    "schema",
    "generatedAt",
    "from",
    "to",
    "window",
    "includeRepair",
    "by",
    "rows",
    "total",
    "repair",
    "coverage",
    "coverageReason",
    "recentMinutesMayLag",
  ]) &&
  value.schema === DASHBOARD_COST_SCHEMA &&
  isDashboardUtcTimestamp(value.generatedAt) &&
  isNullableTimestamp(value.from) &&
  isDashboardUtcTimestamp(value.to) &&
  isDashboardWindowId(value.window) &&
  isBoolean(value.includeRepair) &&
  isValueIn(COST_BY_VALUES, value.by) &&
  isBoundedArray(value.rows, DASHBOARD_MAX_DIMENSION_ROWS, isCostRowV1) &&
  isCostRowV1(value.total) &&
  isNullable(value.repair, isRepairShareV1) &&
  isDashboardCoverage(value.coverage) &&
  isNullable(value.coverageReason, isDashboardCoverageReason) &&
  isBoolean(value.recentMinutesMayLag);

export const isPanelCoverageV1 = (value: unknown): value is PanelCoverageV1 =>
  isExactRecord(value, ["panel", "state", "reason", "provenance", "observedAt"]) &&
  isDashboardPanelId(value.panel) &&
  isDashboardCoverage(value.state) &&
  isNullable(value.reason, isDashboardCoverageReason) &&
  isBoundedArray(value.provenance, PROVENANCE_VALUES.length, isDashboardProvenance) &&
  isNullableTimestamp(value.observedAt);

const isCounterSummary = (value: Record<string, unknown>): boolean =>
  isNonNegativeInteger(value.requests) &&
  isNonNegativeInteger(value.attempts) &&
  isNonNegativeInteger(value.served) &&
  isNonNegativeInteger(value.errored) &&
  isNonNegativeInteger(value.cancelled) &&
  isSuccessRate(value.successRate) &&
  isTokenTotalsV1(value.tokens) &&
  isSpendTotalsV1(value.spend) &&
  isNullableNonNegativeInteger(value.avgLatencyMs) &&
  isNullableNonNegativeInteger(value.avgCommitMs);

export const isSummaryV1 = (value: unknown): value is SummaryV1 =>
  isExactRecord(value, [
    "requests",
    "attempts",
    "served",
    "errored",
    "cancelled",
    "successRate",
    "tokens",
    "spend",
    "avgLatencyMs",
    "p95LatencyMs",
    "avgCommitMs",
  ]) &&
  isCounterSummary(value) &&
  isNullableNonNegativeInteger(value.p95LatencyMs);
export const isBucketV1 = (value: unknown): value is BucketV1 =>
  isExactRecord(value, [
    "from",
    "to",
    "requests",
    "attempts",
    "served",
    "errored",
    "cancelled",
    "successRate",
    "tokens",
    "spend",
    "avgLatencyMs",
    "p95LatencyMs",
    "avgCommitMs",
  ]) &&
  isDashboardUtcTimestamp(value.from) &&
  isDashboardUtcTimestamp(value.to) &&
  isCounterSummary(value) &&
  isNullableNonNegativeInteger(value.p95LatencyMs);
export const isDimensionSummaryV1 = (value: unknown): value is DimensionSummaryV1 =>
  isExactRecord(value, [
    "requests",
    "attempts",
    "served",
    "errored",
    "cancelled",
    "successRate",
    "tokens",
    "spend",
    "avgLatencyMs",
    "avgCommitMs",
    "coverage",
  ]) &&
  isCounterSummary(value) &&
  isDashboardCoverage(value.coverage);

export const isProviderDimensionRowV1 = (value: unknown): value is ProviderDimensionRowV1 =>
  isExactRecord(value, [
    "requests",
    "attempts",
    "served",
    "errored",
    "cancelled",
    "successRate",
    "tokens",
    "spend",
    "avgLatencyMs",
    "avgCommitMs",
    "coverage",
    "dimension",
    "provider",
  ]) &&
  isCounterSummary(value) &&
  isDashboardCoverage(value.coverage) &&
  value.dimension === "provider" &&
  isDashboardSafeId(value.provider);
export const isModelDimensionRowV1 = (value: unknown): value is ModelDimensionRowV1 =>
  isExactRecord(value, [
    "requests",
    "attempts",
    "served",
    "errored",
    "cancelled",
    "successRate",
    "tokens",
    "spend",
    "avgLatencyMs",
    "avgCommitMs",
    "coverage",
    "dimension",
    "provider",
    "model",
  ]) &&
  isCounterSummary(value) &&
  isDashboardCoverage(value.coverage) &&
  value.dimension === "model" &&
  isDashboardSafeId(value.provider) &&
  isDashboardSafeId(value.model);
export const isClientDimensionRowV1 = (value: unknown): value is ClientDimensionRowV1 =>
  isExactRecord(value, [
    "requests",
    "attempts",
    "served",
    "errored",
    "cancelled",
    "successRate",
    "tokens",
    "spend",
    "avgLatencyMs",
    "avgCommitMs",
    "coverage",
    "dimension",
    "client",
  ]) &&
  isCounterSummary(value) &&
  isDashboardCoverage(value.coverage) &&
  value.dimension === "client" &&
  isDashboardSafeId(value.client);
export const isCredentialDimensionRowV1 = (value: unknown): value is CredentialDimensionRowV1 =>
  isExactRecord(value, [
    "requests",
    "attempts",
    "served",
    "errored",
    "cancelled",
    "successRate",
    "tokens",
    "spend",
    "avgLatencyMs",
    "avgCommitMs",
    "coverage",
    "dimension",
    "provider",
    "credentialId",
    "label",
  ]) &&
  isCounterSummary(value) &&
  isDashboardCoverage(value.coverage) &&
  value.dimension === "credential" &&
  isDashboardSafeId(value.provider) &&
  isDashboardSafeId(value.credentialId) &&
  isDashboardSafeId(value.label);
export const isDimensionRowV1 = (value: unknown): value is DimensionRowV1 =>
  isProviderDimensionRowV1(value) ||
  isModelDimensionRowV1(value) ||
  isClientDimensionRowV1(value) ||
  isCredentialDimensionRowV1(value);

export const isErrorDistributionRowV1 = (value: unknown): value is ErrorDistributionRowV1 =>
  isExactRecord(value, ["failureKind", "outcome", "requests"]) &&
  isDashboardFailureKind(value.failureKind) &&
  isDashboardOutcome(value.outcome) &&
  isNonNegativeInteger(value.requests);
export const isRequestRowV1 = (value: unknown): value is RequestRowV1 =>
  isExactRecord(value, [
    "requestId",
    "occurredAt",
    "client",
    "attribution",
    "outcome",
    "failureKind",
    "attemptCount",
    "latencyMs",
    "commitMs",
    "provider",
    "model",
    "credentialId",
    "tokens",
    "spend",
    "repairIncluded",
  ]) &&
  isDashboardRequestId(value.requestId) &&
  isDashboardUtcTimestamp(value.occurredAt) &&
  isNullableSafeId(value.client) &&
  isDashboardAttribution(value.attribution) &&
  isDashboardOutcome(value.outcome) &&
  isNullable(value.failureKind, isDashboardFailureKind) &&
  isNonNegativeInteger(value.attemptCount) &&
  isNullableNonNegativeInteger(value.latencyMs) &&
  isNullableNonNegativeInteger(value.commitMs) &&
  isNullableSafeId(value.provider) &&
  isNullableSafeId(value.model) &&
  isNullableSafeId(value.credentialId) &&
  isTokenTotalsV1(value.tokens) &&
  isSpendTotalsV1(value.spend) &&
  isBoolean(value.repairIncluded);
export const isAttemptRowV1 = (value: unknown): value is AttemptRowV1 =>
  isExactRecord(value, [
    "attemptId",
    "role",
    "startedAt",
    "endedAt",
    "status",
    "latencyMs",
    "commitMs",
    "provider",
    "model",
    "credentialId",
    "failureKind",
    "tokens",
    "spend",
  ]) &&
  isDashboardAttemptId(value.attemptId) &&
  isDashboardAttemptRole(value.role) &&
  isDashboardUtcTimestamp(value.startedAt) &&
  isNullableTimestamp(value.endedAt) &&
  isDashboardOutcome(value.status) &&
  isNullableNonNegativeInteger(value.latencyMs) &&
  isNullableNonNegativeInteger(value.commitMs) &&
  isNullableSafeId(value.provider) &&
  isNullableSafeId(value.model) &&
  isNullableSafeId(value.credentialId) &&
  isNullable(value.failureKind, isDashboardFailureKind) &&
  isNullable(value.tokens, isTokenTotalsV1) &&
  isNullable(value.spend, isSpendTotalsV1);
export const isQuotaRowV1 = (value: unknown): value is QuotaRowV1 =>
  isExactRecord(value, [
    "credentialId",
    "label",
    "provider",
    "deployment",
    "axis",
    "period",
    "limit",
    "remaining",
    "localUsed",
    "resetsAt",
    "observedAt",
    "limitBasis",
    "remainingBasis",
    "localUsedBasis",
    "resetsAtBasis",
  ]) &&
  isDashboardSafeId(value.credentialId) &&
  isDashboardSafeId(value.label) &&
  isDashboardSafeId(value.provider) &&
  isNullableSafeId(value.deployment) &&
  isDashboardQuotaAxis(value.axis) &&
  isDashboardQuotaPeriod(value.period) &&
  isNullableNonNegativeInteger(value.limit) &&
  // Negative remaining = overshoot (limit − used < 0), kept as information; see the guard above.
  isNullableSafeInteger(value.remaining) &&
  isNullableNonNegativeInteger(value.localUsed) &&
  isNullableTimestamp(value.resetsAt) &&
  isNullableTimestamp(value.observedAt) &&
  isNullable(value.limitBasis, isDashboardLimitBasis) &&
  isNullable(value.remainingBasis, isDashboardRemainingBasis) &&
  isNullable(value.localUsedBasis, isDashboardLocalUsedBasis) &&
  isNullable(value.resetsAtBasis, isDashboardResetsAtBasis);
export const isCooldownRowV1 = (value: unknown): value is CooldownRowV1 =>
  isExactRecord(value, ["credentialId", "provider", "deployment", "reason", "until", "observedAt"]) &&
  isDashboardSafeId(value.credentialId) &&
  isDashboardSafeId(value.provider) &&
  isNullableSafeId(value.deployment) &&
  isDashboardCooldownReason(value.reason) &&
  isNullableTimestamp(value.until) &&
  isNullableTimestamp(value.observedAt);

export const isSnapshotV1 = (value: unknown): value is SnapshotV1 =>
  isExactRecord(value, [
    "schema",
    "relayVersion",
    "window",
    "includeRepair",
    "attribution",
    "attributionPolicy",
    "generatedAt",
    "asOf",
    "from",
    "to",
    "retentionFrom",
    "retentionTo",
    "panelCoverage",
    "summary",
    "buckets",
    "providers",
    "models",
    "clients",
    "credentials",
    "errors",
    "quotas",
    "cooldowns",
    "recentRequests",
  ]) &&
  value.schema === DASHBOARD_SNAPSHOT_SCHEMA &&
  isString(value.relayVersion) &&
  isDashboardWindowId(value.window) &&
  isBoolean(value.includeRepair) &&
  isDashboardResponseAttribution(value.attribution) &&
  isDashboardAttributionPolicy(value.attributionPolicy) &&
  isDashboardUtcTimestamp(value.generatedAt) &&
  isDashboardUtcTimestamp(value.asOf) &&
  isNullableTimestamp(value.from) &&
  isDashboardUtcTimestamp(value.to) &&
  isNullableTimestamp(value.retentionFrom) &&
  isNullableTimestamp(value.retentionTo) &&
  isBoundedArray(value.panelCoverage, PANEL_IDS.length, isPanelCoverageV1) &&
  isSummaryV1(value.summary) &&
  isBoundedArray(value.buckets, DASHBOARD_MAX_BUCKETS, isBucketV1) &&
  isBoundedArray(value.providers, DASHBOARD_MAX_DIMENSION_ROWS, isProviderDimensionRowV1) &&
  isBoundedArray(value.models, DASHBOARD_MAX_DIMENSION_ROWS, isModelDimensionRowV1) &&
  isBoundedArray(value.clients, DASHBOARD_MAX_DIMENSION_ROWS, isClientDimensionRowV1) &&
  isBoundedArray(value.credentials, DASHBOARD_MAX_DIMENSION_ROWS, isCredentialDimensionRowV1) &&
  isBoundedArray(value.errors, DASHBOARD_MAX_ERROR_ROWS, isErrorDistributionRowV1) &&
  isBoundedArray(value.quotas, DASHBOARD_MAX_DIMENSION_ROWS, isQuotaRowV1) &&
  isBoundedArray(value.cooldowns, DASHBOARD_MAX_DIMENSION_ROWS, isCooldownRowV1) &&
  isBoundedArray(value.recentRequests, DASHBOARD_MAX_RECENT_ROWS, isRequestRowV1);

export const isDetailV1 = (value: unknown): value is DetailV1 =>
  isExactRecord(value, ["schema", "request", "attempts", "panelCoverage"]) &&
  value.schema === DASHBOARD_DETAIL_SCHEMA &&
  isRequestRowV1(value.request) &&
  isBoundedArray(value.attempts, DASHBOARD_MAX_DETAIL_ATTEMPTS, isAttemptRowV1) &&
  isBoundedArray(value.panelCoverage, PANEL_IDS.length, isPanelCoverageV1);

export const isDashboardErrorV1 = (value: unknown): value is DashboardErrorV1 =>
  isExactRecord(value, ["schema", "code", "message", "requestId"]) &&
  value.schema === DASHBOARD_ERROR_SCHEMA &&
  isDashboardErrorCode(value.code) &&
  isDashboardErrorMessage(value.message) &&
  isNullable(value.requestId, isDashboardRequestId);

export const isDashboardSnapshotV1 = isSnapshotV1;
export const isDashboardDetailV1 = isDetailV1;

export function assertSnapshotV1(value: unknown): asserts value is SnapshotV1 {
  if (!isSnapshotV1(value)) throw new TypeError("Invalid dashboard.snapshot.v1 payload.");
}
export function assertDetailV1(value: unknown): asserts value is DetailV1 {
  if (!isDetailV1(value)) throw new TypeError("Invalid dashboard.detail.v1 payload.");
}
export function assertCostReportV1(value: unknown): asserts value is CostReportV1 {
  if (!isCostReportV1(value)) throw new TypeError("Invalid dashboard.cost.v1 payload.");
}
export function assertDashboardErrorV1(value: unknown): asserts value is DashboardErrorV1 {
  if (!isDashboardErrorV1(value)) throw new TypeError("Invalid dashboard.error.v1 payload.");
}
