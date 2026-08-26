import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_POLICIES,
  ATTRIBUTIONS,
  ATTEMPT_ROLES,
  COOLDOWN_REASONS,
  COVERAGE_REASONS,
  COVERAGE_STATES,
  DASHBOARD_DETAIL_SCHEMA,
  DASHBOARD_ERROR_CODES,
  DASHBOARD_ERROR_MESSAGES,
  DASHBOARD_ERROR_SCHEMA,
  DASHBOARD_MAX_BUCKETS,
  DASHBOARD_ATTEMPT_ID_MAX_BYTES,
  DASHBOARD_ATTEMPT_ID_MIN_LENGTH,
  DASHBOARD_MAX_BODY_BYTES,
  DASHBOARD_MAX_DETAIL_ATTEMPTS,
  DASHBOARD_MAX_DIMENSION_ROWS,
  DASHBOARD_MAX_ERROR_ROWS,
  DASHBOARD_MAX_QUERY_BYTES,
  DASHBOARD_MAX_RECENT_ROWS,
  DASHBOARD_MAX_REQUEST_BYTES,
  DASHBOARD_REQUEST_ID_MAX_LENGTH,
  DASHBOARD_REQUEST_ID_MIN_LENGTH,
  DASHBOARD_MEDIA_TYPE,
  DASHBOARD_MEDIA_TYPE_BASE,
  DASHBOARD_MEDIA_VERSION,
  DASHBOARD_QUERY_ATTRIBUTION_VALUES,
  DASHBOARD_QUERY_FILTER_NAMES,
  DASHBOARD_QUERY_INCLUDE_REPAIR_VALUES,
  DASHBOARD_QUERY_PARAMETER_NAMES,
  DASHBOARD_SAFE_ID_MAX_BYTES,
  DASHBOARD_SNAPSHOT_SCHEMA,
  FAILURE_KINDS,
  LIMIT_BASES,
  LOCAL_USED_BASES,
  OUTCOMES,
  PANEL_IDS,
  PROVENANCE_VALUES,
  QUOTA_AXES,
  QUOTA_PERIODS,
  REMAINING_BASES,
  RESETS_AT_BASES,
  RESPONSE_ATTRIBUTIONS,
  SPEND_PRICE_SOURCES,
  SPEND_SOURCES,
  TOKEN_BASES,
  TOKEN_SOURCES,
  WINDOW_IDS,
  assertDashboardErrorV1,
  assertDetailV1,
  assertSnapshotV1,
  isDashboardAttemptId,
  isDashboardAttemptRole,
  isDashboardAttributionPolicy,
  isDashboardCooldownReason,
  isDashboardCoverage,
  isDashboardCoverageReason,
  isDashboardErrorCode,
  isDashboardErrorMessage,
  isDashboardFailureKind,
  isDashboardLimitBasis,
  isDashboardLocalUsedBasis,
  isDashboardPanelId,
  isDashboardProvenance,
  isDashboardQuotaAxis,
  isDashboardQuotaPeriod,
  isDashboardRemainingBasis,
  isDashboardResetsAtBasis,
  isDashboardResponseAttribution,
  isDashboardSpendPriceSource,
  isDashboardSpendSource,
  isDashboardAttribution,
  isDetailV1,
  isDashboardDetailV1,
  isDashboardErrorV1,
  isDashboardMediaType,
  isDashboardOutcome,
  isDashboardQueryAttribution,
  isDashboardQueryFilterName,
  isDashboardQueryIncludeRepair,
  isDashboardQueryParameterName,
  isDashboardQueryWithinLimit,
  isDashboardRequestBytesWithinLimit,
  isDashboardRequestId,
  isDashboardSafeId,
  isDashboardSnapshotV1,
  isDashboardTokenBasis,
  isDashboardTokenSource,
  isDashboardWindowId,
  isDashboardUtcTimestamp,
  isNonNegativeInteger,
  isSnapshotV1,
  type AttemptRowV1,
  type BucketV1,
  type ClientDimensionRowV1,
  type CooldownRowV1,
  type CredentialDimensionRowV1,
  type DetailV1,
  type ErrorDistributionRowV1,
  type ModelDimensionRowV1,
  type PanelCoverageV1,
  type ProviderDimensionRowV1,
  type QuotaRowV1,
  type RequestRowV1,
  type SnapshotV1,
  type SpendTotalsV1,
  type SummaryV1,
  type TokenTotalsV1,
} from "../../src/dashboard-contract.js";

const now = "2026-08-20T12:00:00Z";
const later = "2026-08-20T12:01:00.123Z";
const validRequestId = "request_123456789";
const validAttemptId = "attempt_123456789";

const tokenTotals = (): TokenTotalsV1 => ({
  reported: {
    reportedInput: { value: 0, source: "provider_reported", observedAt: now },
    reportedOutput: { value: 12, source: "provider_reported", observedAt: null },
    reportedCachedInput: { value: null, source: "provider_reported", observedAt: null },
  },
  estimated: {
    estimatedInput: { value: 3, source: "relay_estimated", observedAt: now, method: "bounded-counter" },
    estimatedOutput: { value: null, source: "relay_estimated", observedAt: null, method: null },
  },
});

const spendTotals = (): SpendTotalsV1 => ({
  providerPublishedReported: {
    amountMicrousd: 0,
    priceSource: "provider_published",
    tokenBasis: "reported",
    source: "provider_reported",
    observedAt: now,
  },
  providerPublishedEstimated: {
    amountMicrousd: null,
    priceSource: "provider_published",
    tokenBasis: "estimated",
    source: "relay_estimated",
    observedAt: null,
  },
  referenceReported: {
    amountMicrousd: 2,
    priceSource: "reference",
    tokenBasis: "reported",
    source: "unknown",
    observedAt: now,
  },
  referenceEstimated: {
    amountMicrousd: null,
    priceSource: "reference",
    tokenBasis: "estimated",
    source: "relay_estimated",
    observedAt: null,
  },
  unpricedRequests: 0,
  partiallyPricedRequests: 0,
});

const summary = (): SummaryV1 => ({
  requests: 1,
  attempts: 1,
  served: 1,
  errored: 0,
  cancelled: 0,
  successRate: 1,
  tokens: tokenTotals(),
  spend: spendTotals(),
  avgLatencyMs: 100,
  p95LatencyMs: 100,
  avgCommitMs: null,
});

const panelCoverage = (): PanelCoverageV1 => ({
  panel: "summary",
  state: "complete",
  reason: null,
  provenance: ["relay_observed"],
  observedAt: now,
});

const bucket = (): BucketV1 => ({
  from: now,
  to: later,
  requests: 1,
  attempts: 1,
  served: 1,
  errored: 0,
  cancelled: 0,
  successRate: 1,
  tokens: tokenTotals(),
  spend: spendTotals(),
  avgLatencyMs: 100,
  p95LatencyMs: 100,
  avgCommitMs: null,
});

const dimensionSummary = () => ({
  requests: 1,
  attempts: 1,
  served: 1,
  errored: 0,
  cancelled: 0,
  successRate: 1,
  tokens: tokenTotals(),
  spend: spendTotals(),
  avgLatencyMs: 100,
  avgCommitMs: null,
  coverage: "complete" as const,
});

const provider = (): ProviderDimensionRowV1 => ({ ...dimensionSummary(), dimension: "provider", provider: "openai" });
const model = (): ModelDimensionRowV1 => ({
  ...dimensionSummary(),
  dimension: "model",
  provider: "openai",
  model: "gpt-test",
});
const client = (): ClientDimensionRowV1 => ({ ...dimensionSummary(), dimension: "client", client: "cli" });
const credential = (): CredentialDimensionRowV1 => ({
  ...dimensionSummary(),
  dimension: "credential",
  provider: "openai",
  credentialId: "openai#primary",
  label: "primary",
});

const request = (): RequestRowV1 => ({
  requestId: validRequestId,
  occurredAt: now,
  client: "cli",
  attribution: "relay_held",
  outcome: "success",
  failureKind: null,
  attemptCount: 1,
  latencyMs: 100,
  commitMs: null,
  provider: "openai",
  model: "gpt-test",
  credentialId: "openai#primary",
  tokens: tokenTotals(),
  spend: spendTotals(),
  repairIncluded: false,
});

const attempt = (): AttemptRowV1 => ({
  attemptId: validAttemptId,
  role: "serve",
  startedAt: now,
  endedAt: later,
  status: "success",
  latencyMs: 100,
  commitMs: null,
  provider: "openai",
  model: "gpt-test",
  credentialId: "openai#primary",
  failureKind: null,
  tokens: tokenTotals(),
  spend: spendTotals(),
});

const quota = (): QuotaRowV1 => ({
  credentialId: "openai#primary",
  label: "primary",
  provider: "openai",
  deployment: null,
  axis: "requests",
  period: "minute",
  limit: 100,
  remaining: 99,
  localUsed: 1,
  resetsAt: later,
  observedAt: now,
  limitBasis: "provider_stated",
  remainingBasis: "derived_configured",
  localUsedBasis: "reported",
  resetsAtBasis: null,
});

const cooldown = (): CooldownRowV1 => ({
  credentialId: "openai#primary",
  provider: "openai",
  deployment: null,
  reason: "rate_limit",
  until: later,
  observedAt: now,
});

const errorRow = (): ErrorDistributionRowV1 => ({ failureKind: "provider_error", outcome: "error", requests: 1 });

const snapshot = (): SnapshotV1 => ({
  schema: DASHBOARD_SNAPSHOT_SCHEMA,
  relayVersion: "0.36.1",
  window: "1h",
  includeRepair: false,
  attribution: "relay_held",
  attributionPolicy: "include_all_labeled",
  generatedAt: now,
  asOf: later,
  from: now,
  to: later,
  retentionFrom: null,
  retentionTo: null,
  panelCoverage: [panelCoverage()],
  summary: summary(),
  buckets: [bucket()],
  providers: [provider()],
  models: [model()],
  clients: [client()],
  credentials: [credential()],
  errors: [errorRow()],
  quotas: [quota()],
  cooldowns: [cooldown()],
  recentRequests: [request()],
});

const detail = (): DetailV1 => ({
  schema: DASHBOARD_DETAIL_SCHEMA,
  request: request(),
  attempts: [attempt()],
  panelCoverage: [panelCoverage()],
});

const dashboardError = () => ({
  schema: DASHBOARD_ERROR_SCHEMA,
  code: "malformed_query" as const,
  message: "Request could not be completed." as const,
  requestId: validRequestId,
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("dashboard v1 contract", () => {
  it("pins exact media/version and schema constants", () => {
    expect(DASHBOARD_MEDIA_TYPE_BASE).toBe("application/vnd.llm-relay.dashboard+json");
    expect(DASHBOARD_MEDIA_VERSION).toBe(1);
    expect(DASHBOARD_MEDIA_TYPE).toBe("application/vnd.llm-relay.dashboard+json; version=1");
    expect(DASHBOARD_SNAPSHOT_SCHEMA).toBe("dashboard.snapshot.v1");
    expect(DASHBOARD_DETAIL_SCHEMA).toBe("dashboard.detail.v1");
    expect(DASHBOARD_ERROR_SCHEMA).toBe("dashboard.error.v1");
    expect(isDashboardMediaType(DASHBOARD_MEDIA_TYPE)).toBe(true);
    expect(isDashboardMediaType("application/vnd.llm-relay.dashboard+json; version=2")).toBe(false);
  });

  it("pins every closed response and basis domain, including guards", () => {
    expect(WINDOW_IDS).toEqual(["1h", "24h", "7d", "30d", "today", "month", "lifetime"]);
    expect(QUOTA_AXES).toEqual(["requests", "tokens"]);
    expect(QUOTA_PERIODS).toEqual(["minute", "day", "month", "unknown"]);
    expect(COVERAGE_STATES).toEqual(["complete", "partial", "unavailable", "stale", "empty"]);
    expect(PANEL_IDS).toEqual([
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
    ]);
    expect(ATTRIBUTIONS).toEqual(["relay_held", "caller_operated", "unknown"]);
    expect(ATTRIBUTION_POLICIES).toEqual([
      "exclude_caller_operated_from_relay_held_caps",
      "include_all_labeled",
      "unknown",
    ]);
    expect(OUTCOMES).toEqual(["success", "error", "cancelled", "unknown"]);
    expect(FAILURE_KINDS).toEqual(["timeout", "provider_error", "auth_error", "rate_limit", "aborted", "protocol", "unknown"]);
    expect(COOLDOWN_REASONS).toEqual(["rate_limit", "auth_error", "provider_error", "manual", "unknown"]);
    expect(COVERAGE_REASONS).toEqual([
      "meter_not_implemented",
      "retention_pruned",
      "upstream_unavailable",
      "projection_lag",
      "no_matching_rows",
      "unknown",
    ]);
    expect(PROVENANCE_VALUES).toEqual(["provider_reported", "relay_observed", "relay_estimated", "unknown", "mixed"]);
    expect(ATTEMPT_ROLES).toEqual(["serve", "repair"]);
    expect(TOKEN_SOURCES).toEqual(["provider_reported", "relay_estimated"]);
    expect(SPEND_PRICE_SOURCES).toEqual(["provider_published", "reference"]);
    expect(TOKEN_BASES).toEqual(["reported", "estimated"]);
    expect(SPEND_SOURCES).toEqual(["provider_reported", "relay_estimated", "unknown"]);
    expect(LIMIT_BASES).toEqual(["provider_stated", "configured", "learned", "published"]);
    expect(REMAINING_BASES).toEqual(["provider_stated", "derived_provider_stated", "derived_configured", "derived_learned", "derived_published"]);
    expect(LOCAL_USED_BASES).toEqual(["reported", "estimated", "mixed"]);
    expect(RESETS_AT_BASES).toEqual(["provider_stated", "reviewed_rule", "derived_boundary"]);
    expect(RESPONSE_ATTRIBUTIONS).toEqual(["relay_held", "caller_operated", "unknown", "all"]);
    expect(isDashboardAttribution("relay_held")).toBe(true);
    expect(isDashboardAttribution("relay-held")).toBe(false);
    expect(DASHBOARD_ERROR_CODES).toEqual([
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
    ]);
    expect(DASHBOARD_ERROR_MESSAGES).toEqual([
      "Request could not be completed.",
      "Dashboard session is unavailable.",
      "Requested dashboard data was not found.",
    ]);

    const guardCases: ReadonlyArray<readonly [readonly string[], (value: unknown) => boolean]> = [
      [WINDOW_IDS, isDashboardWindowId],
      [QUOTA_AXES, isDashboardQuotaAxis],
      [QUOTA_PERIODS, isDashboardQuotaPeriod],
      [COVERAGE_STATES, isDashboardCoverage],
      [PANEL_IDS, isDashboardPanelId],
      [OUTCOMES, isDashboardOutcome],
      [FAILURE_KINDS, isDashboardFailureKind],
      [ATTRIBUTIONS, isDashboardAttribution],
      [RESPONSE_ATTRIBUTIONS, isDashboardResponseAttribution],
      [ATTRIBUTION_POLICIES, isDashboardAttributionPolicy],
      [COOLDOWN_REASONS, isDashboardCooldownReason],
      [COVERAGE_REASONS, isDashboardCoverageReason],
      [PROVENANCE_VALUES, isDashboardProvenance],
      [ATTEMPT_ROLES, isDashboardAttemptRole],
      [TOKEN_SOURCES, isDashboardTokenSource],
      [SPEND_PRICE_SOURCES, isDashboardSpendPriceSource],
      [TOKEN_BASES, isDashboardTokenBasis],
      [SPEND_SOURCES, isDashboardSpendSource],
      [LIMIT_BASES, isDashboardLimitBasis],
      [REMAINING_BASES, isDashboardRemainingBasis],
      [LOCAL_USED_BASES, isDashboardLocalUsedBasis],
      [RESETS_AT_BASES, isDashboardResetsAtBasis],
      [DASHBOARD_ERROR_CODES, isDashboardErrorCode],
      [DASHBOARD_ERROR_MESSAGES, isDashboardErrorMessage],
    ];
    for (const [values, guard] of guardCases) {
      expect(values.every(guard)).toBe(true);
      expect(guard("__not_in_domain__")).toBe(false);
    }
  });

  it("the error-code vocabulary has ONE definition — routes must not restate it", async () => {
    // `src/dashboard-routes.ts` used to declare its own local union of all ten codes. Two
    // definitions of one closed set, drifting invisibly: add a code to the contract and the routes
    // file silently cannot name it; drop one there and a route emits a code the validator rejects.
    // The same rule and the same mechanical guard as `test/destructive-coverage.test.ts`'s
    // "cli.ts no longer hand-copies the list".
    const { readFileSync } = await import("node:fs");
    const routes = readFileSync("src/dashboard-routes.ts", "utf8");
    expect(routes).toContain("type DashboardErrorCode,");
    expect(routes).not.toMatch(/^type DashboardErrorCode =/mu);
    // And every code the contract owns is still reachable from the routes module's own type.
    for (const code of DASHBOARD_ERROR_CODES) {
      expect(isDashboardErrorCode(code)).toBe(true);
    }
  });

  it("keeps query vocabulary separate from response enums and pins byte boundaries", () => {
    expect(DASHBOARD_QUERY_INCLUDE_REPAIR_VALUES).toEqual(["0", "1"]);
    expect(DASHBOARD_QUERY_ATTRIBUTION_VALUES).toEqual(["relay-held", "caller-operated", "all"]);
    expect(DASHBOARD_QUERY_PARAMETER_NAMES).toEqual([
      "window",
      "includeRepair",
      "attribution",
      "provider",
      "model",
      "client",
      "credentialId",
      "outcome",
      "failureKind",
    ]);
    expect(DASHBOARD_QUERY_FILTER_NAMES).toEqual([
      "attribution",
      "provider",
      "model",
      "client",
      "credentialId",
      "outcome",
      "failureKind",
    ]);
    expect(isDashboardQueryIncludeRepair("0")).toBe(true);
    expect(isDashboardQueryIncludeRepair("2")).toBe(false);
    expect(isDashboardQueryAttribution("relay-held")).toBe(true);
    expect(isDashboardQueryAttribution("relay_held")).toBe(false);
    expect(isDashboardQueryParameterName("credentialId")).toBe(true);
    expect(isDashboardQueryParameterName("credential_id")).toBe(false);
    expect(isDashboardQueryFilterName("credentialId")).toBe(true);
    expect(isDashboardQueryFilterName("window")).toBe(false);
    expect(isDashboardSafeId("é".repeat(128))).toBe(true);
    expect(isDashboardSafeId("é".repeat(129))).toBe(false);
    expect(isDashboardSafeId("")).toBe(false);
    expect(isDashboardSafeId(`ok\u0000`)).toBe(false);
    expect(isDashboardSafeId("bad\ud800")).toBe(false);
    expect(DASHBOARD_SAFE_ID_MAX_BYTES).toBe(256);
    expect(DASHBOARD_MAX_QUERY_BYTES).toBe(16 * 1024);
    expect(DASHBOARD_MAX_BODY_BYTES).toBe(16 * 1024);
    expect(DASHBOARD_MAX_REQUEST_BYTES).toBe(16 * 1024);
    expect(isDashboardQueryWithinLimit("a".repeat(DASHBOARD_MAX_QUERY_BYTES))).toBe(true);
    expect(isDashboardQueryWithinLimit("a".repeat(DASHBOARD_MAX_QUERY_BYTES + 1))).toBe(false);
    expect(isDashboardRequestBytesWithinLimit(DASHBOARD_MAX_REQUEST_BYTES)).toBe(true);
    expect(isDashboardRequestBytesWithinLimit(DASHBOARD_MAX_REQUEST_BYTES + 1)).toBe(false);
  });

  it("carries the reviewed_rule reset basis additively and guards it", () => {
    // 2026-08-23 additive contract change: the availability ladder's reviewed-rule rung is fed by
    // persisted fact provenance, so its spelling must round-trip the wire and stay a closed enum.
    const reviewed = clone(snapshot());
    reviewed.quotas[0]!.resetsAtBasis = "reviewed_rule";
    expect(isSnapshotV1(reviewed)).toBe(true);
    const misspelt = clone(snapshot());
    (misspelt.quotas[0] as unknown as Record<string, unknown>).resetsAtBasis = "reviewed-rule";
    expect(isSnapshotV1(misspelt)).toBe(false);
    const missing = clone(snapshot()) as unknown as { quotas: Array<Record<string, unknown>> };
    delete missing.quotas[0]!.resetsAtBasis;
    expect(isSnapshotV1(missing)).toBe(false);
  });

  it("accepts complete bounded snapshot/detail/error fixtures", () => {
    expect(isSnapshotV1(snapshot())).toBe(true);
    expect(isDashboardSnapshotV1(snapshot())).toBe(true);
    expect(isDetailV1(detail())).toBe(true);
    expect(isDashboardDetailV1(detail())).toBe(true);
    expect(isDashboardErrorV1(dashboardError())).toBe(true);
    expect(() => assertSnapshotV1(snapshot())).not.toThrow();
    expect(() => assertDetailV1(detail())).not.toThrow();
    expect(() => assertDashboardErrorV1(dashboardError())).not.toThrow();
  });

  it("rejects schema, required, nullable, provenance, timestamp, integer, and ID defects", () => {
    const wrongSchema = clone(snapshot());
    wrongSchema.schema = "dashboard.snapshot.v2" as SnapshotV1["schema"];
    expect(isSnapshotV1(wrongSchema)).toBe(false);
    expect(() => assertSnapshotV1(wrongSchema)).toThrow(/dashboard\.snapshot\.v1/);

    const missingRequired = clone(snapshot()) as unknown as Record<string, unknown>;
    delete missingRequired.summary;
    expect(isSnapshotV1(missingRequired)).toBe(false);

    const nullableAllowed = clone(snapshot());
    nullableAllowed.summary.avgLatencyMs = null;
    nullableAllowed.summary.avgCommitMs = null;
    nullableAllowed.summary.tokens.reported.reportedInput.value = null;
    expect(isSnapshotV1(nullableAllowed)).toBe(true);

    const nullRequired = clone(snapshot());
    (nullRequired.summary as unknown as Record<string, unknown>).requests = null;
    expect(isSnapshotV1(nullRequired)).toBe(false);
    const wrongSource = clone(snapshot());
    (wrongSource.summary.tokens.reported.reportedInput as unknown as Record<string, unknown>).source = "relay_estimated";
    expect(isSnapshotV1(wrongSource)).toBe(false);
    const wrongTimestamp = clone(snapshot());
    wrongTimestamp.generatedAt = "2026-08-20T12:00:00+00:00";
    expect(isSnapshotV1(wrongTimestamp)).toBe(false);
    const badInteger = clone(snapshot());
    badInteger.summary.requests = -1;
    expect(isSnapshotV1(badInteger)).toBe(false);
    const fractionalInteger = clone(snapshot());
    fractionalInteger.summary.requests = 1.5;
    expect(isSnapshotV1(fractionalInteger)).toBe(false);
    const badId = clone(snapshot());
    badId.recentRequests[0]!.requestId = "too-short";
    expect(isSnapshotV1(badId)).toBe(false);
    const emptyCanonicalId = clone(snapshot());
    emptyCanonicalId.providers[0]!.provider = "";
    expect(isSnapshotV1(emptyCanonicalId)).toBe(false);
    const nullableCanonicalId = clone(snapshot());
    nullableCanonicalId.recentRequests[0]!.provider = null;
    nullableCanonicalId.recentRequests[0]!.model = null;
    nullableCanonicalId.recentRequests[0]!.credentialId = null;
    expect(isSnapshotV1(nullableCanonicalId)).toBe(true);

    const badDetail = clone(detail());
    badDetail.request.tokens.estimated.estimatedInput.method = 3 as unknown as string;
    expect(isDetailV1(badDetail)).toBe(false);
    const badError = dashboardError();
    badError.requestId = "bad";
    expect(isDashboardErrorV1(badError)).toBe(false);
  });

  it("rejects unexpected fields at top level and in every nested object family", () => {
    const withExtra = <T extends object>(value: T): T => ({ ...value, unexpected: true }) as T;
    const snapshotCases: ReadonlyArray<readonly [string, (value: SnapshotV1) => void]> = [
      ["snapshot", (value) => Object.assign(value, { unexpected: true })],
      ["panel coverage", (value) => (value.panelCoverage[0] = withExtra(value.panelCoverage[0]!))],
      ["summary", (value) => (value.summary = withExtra(value.summary))],
      ["bucket", (value) => (value.buckets[0] = withExtra(value.buckets[0]!))],
      ["provider row", (value) => (value.providers[0] = withExtra(value.providers[0]!))],
      ["model row", (value) => (value.models[0] = withExtra(value.models[0]!))],
      ["client row", (value) => (value.clients[0] = withExtra(value.clients[0]!))],
      ["credential row", (value) => (value.credentials[0] = withExtra(value.credentials[0]!))],
      ["error row", (value) => (value.errors[0] = withExtra(value.errors[0]!))],
      ["quota row", (value) => (value.quotas[0] = withExtra(value.quotas[0]!))],
      ["cooldown row", (value) => (value.cooldowns[0] = withExtra(value.cooldowns[0]!))],
      ["recent request", (value) => (value.recentRequests[0] = withExtra(value.recentRequests[0]!))],
      ["token totals", (value) => (value.summary.tokens = withExtra(value.summary.tokens))],
      ["reported token totals", (value) => (value.summary.tokens.reported = withExtra(value.summary.tokens.reported))],
      ["reported token cell", (value) => (value.summary.tokens.reported.reportedInput = withExtra(value.summary.tokens.reported.reportedInput))],
      ["estimated token totals", (value) => (value.summary.tokens.estimated = withExtra(value.summary.tokens.estimated))],
      ["estimated token cell", (value) => (value.summary.tokens.estimated.estimatedInput = withExtra(value.summary.tokens.estimated.estimatedInput))],
      ["spend totals", (value) => (value.summary.spend = withExtra(value.summary.spend))],
      ["provider spend cell", (value) => (value.summary.spend.providerPublishedReported = withExtra(value.summary.spend.providerPublishedReported))],
      ["estimated provider spend cell", (value) => (value.summary.spend.providerPublishedEstimated = withExtra(value.summary.spend.providerPublishedEstimated))],
      ["reference reported spend cell", (value) => (value.summary.spend.referenceReported = withExtra(value.summary.spend.referenceReported))],
      ["reference estimated spend cell", (value) => (value.summary.spend.referenceEstimated = withExtra(value.summary.spend.referenceEstimated))],
    ];
    for (const [family, mutate] of snapshotCases) {
      const candidate = snapshot();
      mutate(candidate);
      expect(isSnapshotV1(candidate), family).toBe(false);
    }

    const detailCases: ReadonlyArray<readonly [string, (value: DetailV1) => void]> = [
      ["detail", (value) => Object.assign(value, { unexpected: true })],
      ["detail request", (value) => (value.request = withExtra(value.request))],
      ["detail attempt", (value) => (value.attempts[0] = withExtra(value.attempts[0]!))],
      ["detail panel coverage", (value) => (value.panelCoverage[0] = withExtra(value.panelCoverage[0]!))],
    ];
    for (const [family, mutate] of detailCases) {
      const candidate = detail();
      mutate(candidate);
      expect(isDetailV1(candidate), family).toBe(false);
    }

    expect(isDashboardErrorV1({ ...dashboardError(), unexpected: true })).toBe(false);
  });

  it("enforces every bounded snapshot array at cap and cap plus one", () => {
    const expectSnapshotCap = (field: string, cap: number, item: unknown) => {
      const atLimit = snapshot() as unknown as Record<string, unknown>;
      atLimit[field] = Array.from({ length: cap }, () => item);
      expect(isSnapshotV1(atLimit)).toBe(true);
      const overLimit = snapshot() as unknown as Record<string, unknown>;
      overLimit[field] = Array.from({ length: cap + 1 }, () => item);
      expect(isSnapshotV1(overLimit)).toBe(false);
    };
    expectSnapshotCap("panelCoverage", PANEL_IDS.length, panelCoverage());
    expectSnapshotCap("buckets", DASHBOARD_MAX_BUCKETS, bucket());
    expectSnapshotCap("providers", DASHBOARD_MAX_DIMENSION_ROWS, provider());
    expectSnapshotCap("models", DASHBOARD_MAX_DIMENSION_ROWS, model());
    expectSnapshotCap("clients", DASHBOARD_MAX_DIMENSION_ROWS, client());
    expectSnapshotCap("credentials", DASHBOARD_MAX_DIMENSION_ROWS, credential());
    expectSnapshotCap("errors", DASHBOARD_MAX_ERROR_ROWS, errorRow());
    expectSnapshotCap("quotas", DASHBOARD_MAX_DIMENSION_ROWS, quota());
    expectSnapshotCap("cooldowns", DASHBOARD_MAX_DIMENSION_ROWS, cooldown());
    expectSnapshotCap("recentRequests", DASHBOARD_MAX_RECENT_ROWS, request());

    const expectDetailCap = (cap: number) => {
      const atLimit = detail();
      atLimit.attempts = Array.from({ length: cap }, attempt);
      expect(isDetailV1(atLimit)).toBe(true);
      const overLimit = detail();
      overLimit.attempts = Array.from({ length: cap + 1 }, attempt);
      expect(isDetailV1(overLimit)).toBe(false);
    };
    expectDetailCap(DASHBOARD_MAX_DETAIL_ATTEMPTS);
  });

  it("validates UTC timestamps, integer semantics, and request IDs directly", () => {
    expect(isDashboardUtcTimestamp(now)).toBe(true);
    expect(isDashboardUtcTimestamp("2026-02-29T00:00:00Z")).toBe(false);
    expect(isDashboardUtcTimestamp("2026-08-20T12:00:00+00:00")).toBe(false);
    expect(isDashboardUtcTimestamp("2026-08-20T12:00:60Z")).toBe(false);
    expect(DASHBOARD_REQUEST_ID_MIN_LENGTH).toBe(16);
    expect(DASHBOARD_REQUEST_ID_MAX_LENGTH).toBe(128);
    expect(isDashboardRequestId("a".repeat(DASHBOARD_REQUEST_ID_MIN_LENGTH))).toBe(true);
    expect(isDashboardRequestId("a".repeat(DASHBOARD_REQUEST_ID_MAX_LENGTH))).toBe(true);
    expect(isDashboardRequestId("a".repeat(DASHBOARD_REQUEST_ID_MIN_LENGTH - 1))).toBe(false);
    expect(isDashboardRequestId("a".repeat(DASHBOARD_REQUEST_ID_MAX_LENGTH + 1))).toBe(false);
    expect(DASHBOARD_ATTEMPT_ID_MIN_LENGTH).toBe(1);
    expect(DASHBOARD_ATTEMPT_ID_MAX_BYTES).toBe(256);
    const longAttemptId = "é".repeat(128);
    expect(isDashboardAttemptId(longAttemptId)).toBe(true);
    expect(isDashboardRequestId(longAttemptId)).toBe(false);
    expect(isDashboardAttemptId("é".repeat(129))).toBe(false);
    expect(isNonNegativeInteger(0)).toBe(true);
    expect(isNonNegativeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isNonNegativeInteger(-1)).toBe(false);
    expect(isNonNegativeInteger(1.5)).toBe(false);
    expect(isNonNegativeInteger(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isNonNegativeInteger("1")).toBe(false);
  });

  it("imports only shared platform-free shape guards and has no platform globals", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/dashboard-contract.ts");
    const source = readFileSync(sourcePath, "utf8");
    const withoutJsonShapeImport = source.replace(
      /^import \{ hasExactKeys as isExactRecord, isRecord \} from "\.\/json-shape\.js";\r?\n/m,
      "",
    );
    expect(withoutJsonShapeImport).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\b(?:document|window|globalThis|HTMLElement|HTML\w+|DOM\w*|fetch|localStorage|sessionStorage)\s*[.(\[]/);
    // The platform-free invariant is transitive: json-shape.ts is bundled into the browser SPA
    // through this import, so the file it admits must itself stay import-free and global-free —
    // otherwise this test's title claims a property nothing checks.
    const shapeSource = readFileSync(resolve(dirname(sourcePath), "json-shape.ts"), "utf8");
    expect(shapeSource).not.toMatch(/^\s*import\s/m);
    expect(shapeSource).not.toMatch(/\b(?:document|window|globalThis|HTMLElement|HTML\w+|DOM\w*|fetch|localStorage|sessionStorage)\s*[.(\[]/);
    const tsconfig = JSON.parse(readFileSync(resolve(dirname(sourcePath), "../tsconfig.json"), "utf8")) as {
      compilerOptions?: { lib?: string[] };
    };
    expect(tsconfig.compilerOptions?.lib ?? []).not.toContain("DOM");
  });
});
