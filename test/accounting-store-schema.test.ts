import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_DAY_SCHEMA,
  ACCOUNTING_DEDUP_SCHEMA,
  ACCOUNTING_LIFETIME_SCHEMA,
  ACCOUNTING_MINUTE_SCHEMA,
  ACCOUNTING_MAX_DEDUP_IDS,
  ACCOUNTING_MAX_DAY_ROWS,
  ACCOUNTING_MAX_DETAIL_ATTEMPTS,
  ACCOUNTING_MAX_FILE_BYTES,
  ACCOUNTING_MAX_ROWS_PER_CELL,
  ACCOUNTING_MAX_SAMPLES,
  ACCOUNTING_RECENT_SCHEMA,
  ACCOUNTING_STORE_VERSION,
  accountingSerializedBytes,
  type AccountingAggregateTokenTotalsV1,
  type AccountingAttemptPacketV1,
  type AccountingCoverageV1,
  type AccountingDimensionRowV1,
  type AccountingMetricCellV1,
  type AccountingRequestPacketV1,
  isAccountingAggregateV1,
  isAccountingAggregateTokenCellV1,
  isAccountingAggregateTokenTotalsV1,
  isAccountingAttemptPacketV1,
  isAccountingCompletedRequestDedupV1,
  isAccountingDayShardV1,
  isAccountingDimensionRowV1,
  isAccountingLifetimeV1,
  isAccountingMetricCellV1,
  isAccountingRecentV1,
  isAccountingRequestPacketV1,
  mergeAccountingEstimatedTokenCells,
  mergeAccountingMetricCells,
  mergeAccountingTokenCells,
  parseAccountingAggregateTokenCellV1,
} from "../src/accounting-store-schema.js";

const START = "2026-08-20T01:02:03.000Z";
const END = "2026-08-20T01:02:04.000Z";
const REQUEST_ID = "req_000000000000001";
const ATTEMPT_ID = "attempt-0000000001";
const PROVIDER = "provider-a";
const MODEL = "model-a";
const CREDENTIAL = "credential-a";

function reportedCell(value: number | null = null, known = 0, unknown = 0, lost = 0, observedAt: string | null = null) {
  return { value, known, unknown, lost, overflow: false, observedAt };
}

function estimatedCell(value: number | null = null, known = 0, unknown = 0, lost = 0, observedAt: string | null = null, method: string | null = null) {
  return { value, known, unknown, lost, overflow: false, observedAt, method };
}

function tokens(): AccountingAggregateTokenTotalsV1 {
  return {
    reported: {
      reportedInput: reportedCell(),
      reportedOutput: reportedCell(),
      reportedCachedInput: reportedCell(),
      cacheCreationInputTokens: reportedCell(),
      cacheReadInputTokens: reportedCell(),
    },
    estimated: { estimatedInput: estimatedCell(), estimatedOutput: estimatedCell() },
  };
}

function metric(): AccountingMetricCellV1 {
  return { sumMs: null, known: 0, unknown: 0, lost: 0, overflow: false, samples: [], samplesDropped: 0, observedAt: null };
}

type AggregateOverrides = Partial<Record<"requests" | "attempts" | "served" | "errored" | "cancelled" | "unpricedRequests", number>> & {
  tokens?: AccountingAggregateTokenTotalsV1;
  requestTokens?: AccountingAggregateTokenTotalsV1;
};

function aggregate(overrides: AggregateOverrides = {}) {
  return {
    requests: 0,
    attempts: 0,
    served: 0,
    errored: 0,
    cancelled: 0,
    tokens: tokens(),
    requestTokens: tokens(),
    latency: metric(),
    commit: metric(),
    spend: null,
    unpricedRequests: 0,
    ...overrides,
  };
}

function coverage(overrides: Partial<AccountingCoverageV1> = {}): AccountingCoverageV1 {
  return {
    state: "complete",
    reason: null,
    droppedRows: 0,
    droppedRecent: 0,
    droppedDetails: 0,
    droppedDedup: 0,
    retentionFrom: null,
    retentionDays: null,
    losses: [],
    ...overrides,
  };
}

function attempt(overrides: Partial<AccountingAttemptPacketV1> = {}): AccountingAttemptPacketV1 {
  return {
    requestId: REQUEST_ID,
    attemptId: ATTEMPT_ID,
    role: "serve",
    startedAt: START,
    endedAt: END,
    outcome: "success",
    failureKind: null,
    attribution: "relay_held",
    latencyMs: 1_000,
    commitMs: null,
    provider: PROVIDER,
    model: MODEL,
    credentialId: CREDENTIAL,
    tokens: tokens(),
    spend: null,
    ...overrides,
  };
}

function packet(overrides: Partial<AccountingRequestPacketV1> = {}): AccountingRequestPacketV1 {
  const one = attempt();
  return {
    requestId: REQUEST_ID,
    startedAt: START,
    endedAt: END,
    client: "client-a",
    attribution: "relay_held",
    outcome: "success",
    failureKind: null,
    attemptCount: 1,
    repairIncluded: false,
    winningAttemptId: ATTEMPT_ID,
    commitAttemptId: null,
    latencyMs: 1_000,
    commitMs: null,
    provider: PROVIDER,
    model: MODEL,
    credentialId: CREDENTIAL,
    tokens: one.tokens,
    spend: null,
    attempts: [one],
    attemptMetadata: { total: 1, stored: 1, dropped: 0 },
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}): AccountingDimensionRowV1 {
  return {
    ...aggregate({ requests: 1, attempts: 0, served: 1 }),
    kind: "request",
    role: "request",
    provider: PROVIDER,
    model: MODEL,
    client: "client-a",
    credentialId: CREDENTIAL,
    attribution: "relay_held",
    outcome: "success",
    failureKind: null,
    ...overrides,
  } as AccountingDimensionRowV1;
}

describe("accounting persisted schema", () => {
  it("publishes distinct versioned shards and hard caps", () => {
    expect(ACCOUNTING_STORE_VERSION).toBe(1);
    expect(ACCOUNTING_DAY_SCHEMA).toBe("accounting.day.v1");
    expect(ACCOUNTING_MINUTE_SCHEMA).toBe("accounting.minute.v1");
    expect(ACCOUNTING_RECENT_SCHEMA).toBe("accounting.recent.v1");
    expect(ACCOUNTING_LIFETIME_SCHEMA).toBe("accounting.lifetime.v1");
    expect(ACCOUNTING_DEDUP_SCHEMA).toBe("accounting.dedup.v1");
    expect(ACCOUNTING_MAX_DETAIL_ATTEMPTS).toBe(32);
    expect(ACCOUNTING_MAX_SAMPLES).toBeGreaterThan(0);
    expect(ACCOUNTING_MAX_ROWS_PER_CELL).toBeGreaterThan(ACCOUNTING_MAX_DETAIL_ATTEMPTS);
    expect(ACCOUNTING_MAX_DEDUP_IDS).toBeGreaterThan(ACCOUNTING_MAX_ROWS_PER_CELL);
  });

  it("keeps null and provenance counters instead of fabricating zero", () => {
    const unknown = reportedCell(null, 0, 1, 0, null);
    expect(isAccountingAggregateTokenCellV1(unknown)).toBe(true);
    const result = parseAccountingAggregateTokenCellV1(unknown);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBeNull();
      expect(result.value.unknown).toBe(1);
      expect(Object.isFrozen(result.value)).toBe(true);
    }

    const badZero = { ...unknown, value: 0 };
    expect(isAccountingAggregateTokenCellV1(badZero)).toBe(false);
    const emptyWithTime = { ...reportedCell(), observedAt: START };
    expect(isAccountingAggregateTokenCellV1(emptyWithTime)).toBe(false);

    const estimatedUnknown = estimatedCell(null, 0, 2, 0, null, "unknown");
    const estimatedMixed = estimatedCell(null, 1, 1, 0, START, "mixed");
    expect(isAccountingAggregateTokenTotalsV1({ ...tokens(), estimated: { estimatedInput: estimatedUnknown, estimatedOutput: estimatedMixed } })).toBe(true);
    expect(isAccountingAggregateTokenTotalsV1({ ...tokens(), estimated: { estimatedInput: { ...estimatedUnknown, method: null }, estimatedOutput: estimatedMixed } })).toBe(false);
  });

  it("rejects hostile token cells recursively and returns a frozen copy", () => {
    const source = reportedCell(7, 1, 0, 0, START);
    const parsed = parseAccountingAggregateTokenCellV1(source);
    source.value = 999;
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.value).toBe(7);
      expect(Object.isFrozen(parsed.value)).toBe(true);
    }
    expect(isAccountingAggregateTokenCellV1({ ...reportedCell(), extra: 1 })).toBe(false);
    const missing = { ...reportedCell() } as Record<string, unknown>;
    delete missing.lost;
    expect(isAccountingAggregateTokenCellV1(missing)).toBe(false);
    expect(isAccountingAggregateTokenCellV1({ ...reportedCell(), observedAt: "2026-08-20T01:02:03Z" })).toBe(false);
    expect(isAccountingAggregateTokenCellV1({ ...reportedCell(), known: Number.MAX_SAFE_INTEGER, value: 1, observedAt: START })).toBe(true);
    expect(isAccountingAggregateTokenCellV1({ ...reportedCell(), known: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    expect(isAccountingAggregateTokenCellV1({ ...reportedCell(), value: -1 })).toBe(false);
    const hidden = { ...reportedCell() };
    Object.defineProperty(hidden, "value", { value: null, enumerable: false });
    expect(isAccountingAggregateTokenCellV1(hidden)).toBe(false);
    const throwing = { ...reportedCell() } as Record<string, unknown>;
    Object.defineProperty(throwing, "value", { get: () => { throw new Error("hostile getter"); }, enumerable: true, configurable: true });
    expect(isAccountingAggregateTokenCellV1(throwing)).toBe(false);
    expect(mergeAccountingTokenCells(throwing as never, reportedCell())).toBeNull();
  });

  it("merges cells with checked sums and explicit mixed methods", () => {
    const a = reportedCell(4, 1, 0, 0, START);
    const b = reportedCell(6, 1, 0, 0, END);
    expect(mergeAccountingTokenCells(a, b)).toMatchObject({ value: 10, known: 2, observedAt: END });
    expect(mergeAccountingTokenCells(a, { ...b, unknown: 1, value: null })).toMatchObject({ value: null, known: 2, unknown: 1 });
    expect(mergeAccountingTokenCells({ ...a, value: Number.MAX_SAFE_INTEGER }, b)).toMatchObject({ value: null, overflow: true });

    const first = estimatedCell(2, 1, 0, 0, START, "ratio");
    const second = estimatedCell(3, 1, 0, 0, END, "heuristic");
    expect(mergeAccountingEstimatedTokenCells(first, second)).toMatchObject({ value: 5, method: "mixed" });
    expect(mergeAccountingEstimatedTokenCells(estimatedCell(null, 0, 1, 0, null, "unknown"), estimatedCell())).toMatchObject({ method: "unknown" });
    const emptyMerge = mergeAccountingEstimatedTokenCells(estimatedCell(), estimatedCell());
    expect(emptyMerge).toMatchObject({ value: null, method: null });
    expect(emptyMerge && isAccountingAggregateTokenTotalsV1({ ...tokens(), estimated: { estimatedInput: emptyMerge, estimatedOutput: estimatedCell() } })).toBe(true);
    const throwingEstimated = estimatedCell(1, 1, 0, 0, START, "ratio") as Record<string, unknown>;
    Object.defineProperty(throwingEstimated, "method", { get: () => { throw new Error("hostile getter"); }, enumerable: true, configurable: true });
    expect(mergeAccountingEstimatedTokenCells(throwingEstimated as never, estimatedCell())).toBeNull();
  });

  it("bounds metric samples and preserves loss/null semantics", () => {
    const valid = { ...metric(), sumMs: 10, known: 1, samples: [10], observedAt: START };
    expect(isAccountingMetricCellV1(valid)).toBe(true);
    expect(isAccountingMetricCellV1({ ...valid, samples: Array.from({ length: ACCOUNTING_MAX_SAMPLES + 1 }, () => 1) })).toBe(false);
    expect(isAccountingMetricCellV1({ ...valid, sumMs: 10, unknown: 1 })).toBe(false);
    expect(isAccountingMetricCellV1({ ...valid, samples: [10, 11] })).toBe(false);
    const merged = mergeAccountingMetricCells(valid, { ...valid, sumMs: 20, samples: [20], observedAt: END });
    expect(merged).toMatchObject({ sumMs: 30, known: 2, samples: [10, 20], observedAt: END });
    const sampleChunk = { ...metric(), sumMs: 325, known: 25, samples: Array.from({ length: ACCOUNTING_MAX_SAMPLES }, (_, index) => index + 1), observedAt: START };
    const mergedChunks = mergeAccountingMetricCells(sampleChunk, sampleChunk);
    expect(mergedChunks).not.toBeNull();
    expect(mergedChunks && isAccountingMetricCellV1(mergedChunks)).toBe(true);
    expect(mergedChunks).toMatchObject({ sumMs: 650, known: 50, samplesDropped: 25 });
    expect(mergeAccountingMetricCells(valid, { ...valid, sumMs: Number.MAX_SAFE_INTEGER })).toMatchObject({ sumMs: null, overflow: true });
    const throwingMetric = { ...valid } as Record<string, unknown>;
    Object.defineProperty(throwingMetric, "known", { get: () => { throw new Error("hostile getter"); }, enumerable: true, configurable: true });
    expect(mergeAccountingMetricCells(throwingMetric as never, valid)).toBeNull();
  });

  it("checks aggregate relationships and compound dimension discriminants", () => {
    const valid = aggregate({ requests: 3, attempts: 3, served: 1, errored: 1, cancelled: 1 });
    expect(isAccountingAggregateV1(valid)).toBe(true);
    expect(isAccountingAggregateV1(aggregate({ requests: 1, attempts: 0, served: 1 }))).toBe(true);
    expect(isAccountingAggregateV1({ ...valid, served: 4 })).toBe(false);
    expect(isAccountingAggregateV1({ ...valid, attempts: 1 })).toBe(true);
    expect(isAccountingAggregateV1({ ...valid, unpricedRequests: 4 })).toBe(false);
    expect(isAccountingDimensionRowV1(row())).toBe(true);
    const attemptTokens = tokens();
    const attemptAggregate = aggregate({
      requests: 0,
      attempts: 1,
      served: 1,
      tokens: { ...attemptTokens, reported: { ...attemptTokens.reported, reportedInput: reportedCell(1, 1, 0, 0, START) } },
    });
    expect(isAccountingDimensionRowV1(row({ ...attemptAggregate, kind: "attempt", role: "repair" }))).toBe(true);
    expect(isAccountingDimensionRowV1(row({ kind: "request", role: "serve" }))).toBe(false);
    expect(isAccountingDimensionRowV1(row({ provider: "unsafe\nprovider" }))).toBe(false);
    expect(isAccountingDimensionRowV1(row({ outcome: "error", failureKind: null, served: 0, errored: 1 }))).toBe(true);
    expect(isAccountingDimensionRowV1(row({ outcome: "error", failureKind: null }))).toBe(false);
    expect(isAccountingDimensionRowV1(row({ outcome: "cancelled", failureKind: null, served: 0, errored: 0, cancelled: 1 }))).toBe(true);
    expect(isAccountingDimensionRowV1(row({ outcome: "unknown", failureKind: null, served: 0, errored: 0, cancelled: 0 }))).toBe(true);
    expect(isAccountingDimensionRowV1(row({ served: 0 }))).toBe(false);
    expect(isAccountingDimensionRowV1({ ...row(), extra: true })).toBe(false);
  });

  it("rejects a bad value in every field of the shared envelope tail, on BOTH packet kinds", () => {
    // ⚠ These seven checks were entirely uncovered until 2026-09-05: disabling the whole tail guard
    // left all 126 accounting tests green. Found while extracting it as `validateCommonEnvelopeTail`
    // (CLONE-21) — the extraction was correct, and the suite could not have told anyone either way.
    // Each case below fails if the guard stops running, which is the point.
    const badTails = {
      latencyMs: ["1000", -1, 1.5, Number.NaN],
      commitMs: ["0", -1, 1.5],
      provider: [1, "bad\nprovider", {}],
      model: [1, "bad\nmodel"],
      credentialId: [1, "bad\ncredential"],
      tokens: [null, {}, "tokens"],
      spend: [1, "spend", {}],
    } as const;

    for (const [field, values] of Object.entries(badTails)) {
      for (const bad of values) {
        expect(isAccountingAttemptPacketV1({ ...attempt(), [field]: bad }), `attempt.${field} = ${JSON.stringify(bad)}`).toBe(false);
        expect(isAccountingRequestPacketV1({ ...packet(), [field]: bad }), `request.${field} = ${JSON.stringify(bad)}`).toBe(false);
      }
    }

    // And the two values the tail deliberately ADMITS, so the cases above cannot pass by rejecting
    // everything. `spend: null` is every pre-2026-08-22 shard; a null duration is an unmeasured one.
    expect(isAccountingAttemptPacketV1({ ...attempt(), spend: null, latencyMs: null })).toBe(true);
    expect(isAccountingAttemptPacketV1({ ...attempt(), provider: null, model: null, credentialId: null })).toBe(true);
  });

  it("requires complete terminal packet lifecycle and attribution", () => {
    const valid = packet();
    expect(isAccountingAttemptPacketV1(valid.attempts[0])).toBe(true);
    expect(isAccountingRequestPacketV1(valid)).toBe(true);
    expect(isAccountingRequestPacketV1({ ...valid, attribution: "caller_operated", attempts: [attempt()] })).toBe(false);
    expect(isAccountingRequestPacketV1({ ...valid, winningAttemptId: null })).toBe(false);
    expect(isAccountingRequestPacketV1({ ...valid, tokens: { ...tokens(), reported: { ...tokens().reported, reportedInput: reportedCell(1, 1, 0, 0, START) } } })).toBe(false);
    expect(isAccountingRequestPacketV1({ ...valid, attempts: [{ ...valid.attempts[0], attribution: "unknown" }] })).toBe(false);
    expect(isAccountingRequestPacketV1({
      ...valid,
      attempts: [
        valid.attempts[0],
        attempt({ attemptId: "repair-0000000001", role: "repair", attribution: "caller_operated" }),
      ],
      attemptCount: 2,
      repairIncluded: true,
      attemptMetadata: { total: 2, stored: 2, dropped: 0 },
    })).toBe(true);
    const noWinner = packet({
      outcome: "error",
      failureKind: null,
      winningAttemptId: null,
      commitAttemptId: null,
      attempts: [attempt({ outcome: "error", failureKind: null, attribution: "caller_operated" })],
    });
    expect(isAccountingRequestPacketV1(noWinner)).toBe(true);
    expect(isAccountingRequestPacketV1({ ...valid, endedAt: START })).toBe(false);
    expect(isAccountingRequestPacketV1({ ...valid, attemptMetadata: { total: 2, stored: 1, dropped: 1 } })).toBe(false);
    expect(isAccountingAttemptPacketV1({ ...valid.attempts[0], role: "repair", commitMs: 1 })).toBe(false);
  });

  it("retains winner and commit references when detail attempts are capped", () => {
    const winner = attempt({ attemptId: "winner-0000000001", commitMs: 3 });
    const detail = packet({
      winningAttemptId: winner.attemptId,
      commitAttemptId: winner.attemptId,
      commitMs: 3,
      attempts: [winner],
      attemptMetadata: { total: 40, stored: 1, dropped: 39 },
      attemptCount: 40,
    });
    expect(isAccountingRequestPacketV1(detail)).toBe(true);
    expect(isAccountingRequestPacketV1({ ...detail, attempts: [], attemptMetadata: { total: 40, stored: 0, dropped: 40 } })).toBe(false);
    expect(isAccountingRequestPacketV1({ ...detail, winningAttemptId: "missing-000000001", commitAttemptId: null, commitMs: null })).toBe(false);
    expect(isAccountingRequestPacketV1({ ...detail, repairIncluded: true })).toBe(true);
    expect(isAccountingRequestPacketV1({ ...detail, attemptMetadata: { total: 40, stored: 33, dropped: 7 }, attempts: Array.from({ length: 33 }, (_, index) => attempt({ attemptId: `attempt-${String(index).padStart(10, "0")}`, role: index === 32 ? "repair" : "serve" })) })).toBe(false);
  });

  it("allows a committed failed/cancelled serve attempt but keeps winner/commit coherent", () => {
    const failed = attempt({ outcome: "error", failureKind: "provider_error", commitMs: 4, latencyMs: 1_000 });
    const committedFailure = packet({
      outcome: "error",
      failureKind: "provider_error",
      winningAttemptId: failed.attemptId,
      commitAttemptId: failed.attemptId,
      latencyMs: 1_000,
      commitMs: 4,
      attempts: [failed],
    });
    expect(isAccountingRequestPacketV1(committedFailure)).toBe(true);
    const committedCancelledAttempt = attempt({ outcome: "cancelled", failureKind: "aborted", commitMs: 4, latencyMs: 1_000 });
    const committedCancelled = packet({
      outcome: "cancelled",
      failureKind: "aborted",
      winningAttemptId: committedCancelledAttempt.attemptId,
      commitAttemptId: committedCancelledAttempt.attemptId,
      latencyMs: 1_000,
      commitMs: 4,
      tokens: committedCancelledAttempt.tokens,
      attempts: [committedCancelledAttempt],
    });
    expect(isAccountingRequestPacketV1(committedCancelled)).toBe(true);
    expect(isAccountingRequestPacketV1({ ...committedFailure, provider: "other-provider" })).toBe(false);
    expect(isAccountingRequestPacketV1({ ...committedFailure, attribution: "caller_operated" })).toBe(false);
    expect(isAccountingRequestPacketV1({ ...committedFailure, tokens: { ...tokens(), reported: { ...tokens().reported, reportedInput: reportedCell(1, 1, 0, 0, START) } } })).toBe(false);
    expect(isAccountingRequestPacketV1({ ...committedFailure, commitAttemptId: null, commitMs: null })).toBe(false);
    expect(isAccountingRequestPacketV1({ ...committedFailure, outcome: "cancelled", failureKind: "aborted" })).toBe(false);
    expect(isAccountingAttemptPacketV1({ ...failed, outcome: "cancelled", failureKind: "aborted", commitMs: 4 })).toBe(true);
    expect(isAccountingAttemptPacketV1({ ...failed, outcome: "unknown", failureKind: null, commitMs: 4, latencyMs: 1_000 })).toBe(true);
  });

  it("rejects duplicate attempts, impossible chronology, and extra packet keys", () => {
    const valid = packet();
    expect(isAccountingRequestPacketV1({ ...valid, attempts: [valid.attempts[0], valid.attempts[0]], attemptCount: 2, attemptMetadata: { total: 2, stored: 2, dropped: 0 } })).toBe(false);
    expect(isAccountingRequestPacketV1({ ...valid, attempts: [{ ...valid.attempts[0], startedAt: "2026-08-20T01:02:05.000Z" }] })).toBe(false);
    expect(isAccountingRequestPacketV1({ ...valid, attemptMetadata: { total: 1, stored: 1, dropped: 0 }, extra: true })).toBe(false);
    expect(isAccountingAttemptPacketV1({ ...valid.attempts[0], requestId: "unsafe\nrequest" })).toBe(false);
  });

  it("validates minute/day, month/lifetime, recent/detail, and durable dedup bounds", () => {
    const minute = {
      schema: "accounting.minute.v1" as const,
      version: ACCOUNTING_STORE_VERSION,
      date: "2026-08-20",
      minute: "01:02",
      from: "2026-08-20T01:02:00.000Z",
      to: "2026-08-20T01:03:00.000Z",
      aggregate: aggregate({ requests: 1, attempts: 1, served: 1 }),
      rows: [row()],
      coverage: { state: "complete" as const, reason: null, droppedRows: 0, losses: [] },
    };
    const dedup = {
      schema: ACCOUNTING_DEDUP_SCHEMA,
      version: ACCOUNTING_STORE_VERSION,
      date: "2026-08-20",
      requestIds: [REQUEST_ID],
      dropped: 0,
      complete: true,
    };
    const day = {
      schema: ACCOUNTING_DAY_SCHEMA,
      version: ACCOUNTING_STORE_VERSION,
      date: "2026-08-20",
      cells: { "01:02": minute },
      dedup,
      coverage: coverage(),
    };
    expect(isAccountingDayShardV1(day)).toBe(true);
    expect(isAccountingDayShardV1({ ...day, cells: { "24:00": minute } })).toBe(false);
    const hiddenCells: Record<string, unknown> = {};
    Object.defineProperty(hiddenCells, "hidden", { value: minute, enumerable: false });
    expect(isAccountingDayShardV1({ ...day, cells: hiddenCells })).toBe(false);
    expect(isAccountingDayShardV1({ ...day, dedup: { ...dedup, requestIds: [REQUEST_ID, REQUEST_ID] } })).toBe(false);
    expect(isAccountingDayShardV1({ ...day, dedup: { ...dedup, dropped: 1, complete: false }, coverage: coverage({ state: "partial", reason: "dedup_cap", droppedDedup: 1, losses: [{ kind: "dedup", count: 1, field: "requestIds" }] }) })).toBe(true);
    expect(isAccountingCompletedRequestDedupV1({ ...dedup, complete: false })).toBe(false);

    const month = { month: "2026-08", aggregate: aggregate(), coverage: coverage() };
    const lifetime = {
      schema: ACCOUNTING_LIFETIME_SCHEMA,
      version: ACCOUNTING_STORE_VERSION,
      firstRequestAt: null,
      lastRequestAt: null,
      aggregate: aggregate(),
      months: { "2026-08": month },
      coverage: coverage(),
    };
    expect(isAccountingLifetimeV1(lifetime)).toBe(true);
    expect(isAccountingLifetimeV1({ ...lifetime, months: { "2026-00": { ...month, month: "2026-00" } } })).toBe(false);
    expect(isAccountingLifetimeV1({ ...lifetime, aggregate: aggregate({ requests: 1 }) })).toBe(false);

    const recent = { schema: ACCOUNTING_RECENT_SCHEMA, version: ACCOUNTING_STORE_VERSION, rows: [packet()], details: { [REQUEST_ID]: packet() }, coverage: coverage() };
    expect(isAccountingRecentV1(recent)).toBe(true);
    expect(isAccountingRecentV1({ ...recent, details: { wrong: packet() } })).toBe(false);
    expect(isAccountingRecentV1({ ...recent, rows: [packet(), packet()] })).toBe(false);
    expect(isAccountingRecentV1({ ...recent, rows: Array.from({ length: 101 }, () => packet()) })).toBe(false);
  });

  it("enforces coverage/loss marker state and all recursive caps", () => {
    const marker = { kind: "truncated" as const, count: 1, field: "rows" };
    expect(isAccountingAggregateV1({ ...aggregate(), latency: { ...metric(), losses: [marker] } })).toBe(false);
    const validCoverage = coverage({ state: "partial", reason: "row_cap", droppedRows: 1, losses: [marker] });
    expect(isAccountingDayShardV1({
      schema: ACCOUNTING_DAY_SCHEMA,
      version: ACCOUNTING_STORE_VERSION,
      date: "2026-08-20",
      cells: {},
      dedup: { schema: ACCOUNTING_DEDUP_SCHEMA, version: ACCOUNTING_STORE_VERSION, date: "2026-08-20", requestIds: [], dropped: 0, complete: true },
      coverage: validCoverage,
    })).toBe(true);
    expect(isAccountingDayShardV1({
      schema: ACCOUNTING_DAY_SCHEMA,
      version: ACCOUNTING_STORE_VERSION,
      date: "2026-08-20",
      cells: {},
      dedup: { schema: ACCOUNTING_DEDUP_SCHEMA, version: ACCOUNTING_STORE_VERSION, date: "2026-08-20", requestIds: [], dropped: 1, complete: false },
      coverage: coverage(),
    })).toBe(false);
    expect(isAccountingDayShardV1({
      schema: ACCOUNTING_DAY_SCHEMA,
      version: ACCOUNTING_STORE_VERSION,
      date: "2026-08-20",
      cells: Object.fromEntries(Array.from({ length: 1_441 }, (_, index) => [`${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`, {}])),
      dedup: { schema: ACCOUNTING_DEDUP_SCHEMA, version: ACCOUNTING_STORE_VERSION, date: "2026-08-20", requestIds: [], dropped: 0, complete: true },
      coverage: coverage(),
    })).toBe(false);
    expect(isAccountingCompletedRequestDedupV1({
      schema: ACCOUNTING_DEDUP_SCHEMA,
      version: ACCOUNTING_STORE_VERSION,
      date: "2026-08-20",
      requestIds: Array.from({ length: ACCOUNTING_MAX_DEDUP_IDS + 1 }, (_, index) => `req_${String(index).padStart(15, "0")}`),
      dropped: 0,
      complete: true,
    })).toBe(false);
  });

  describe("authoritative-attempt coherence guard compares spend", () => {
    function validSpend(): { amountMicrousd: number; priceSource: "provider_published" | "reference"; tokenBasis: "reported" | "estimated"; source: "provider_reported" | "relay_estimated"; coverage: "full" | "input_only" | "partial"; unpricedTokens: { cacheRead: number | null; cacheCreation: number | null; cachedInput: number | null }; pricesUsed: { perMillionIn: number | null; perMillionOut: number | null }; observedAt: string } {
      return {
        amountMicrousd: 1_234,
        priceSource: "provider_published",
        tokenBasis: "reported",
        source: "provider_reported",
        coverage: "full",
        unpricedTokens: { cacheRead: 0, cacheCreation: 0, cachedInput: 0 },
        pricesUsed: { perMillionIn: 1.0, perMillionOut: 2.0 },
        observedAt: "2026-08-20T01:02:03.000Z",
      };
    }

    it("legacy shard with attempt spend: null and no requestSpend loads", () => {
      const legacyPacket = {
        ...packet(),
        // Legacy pre-spend shape: attempt spend is null, no request-side spend at all
        attempts: [{ ...attempt(), spend: null }],
        spend: null, // absent entirely on legacy shards per schema comment
      };
      expect(isAccountingRequestPacketV1(legacyPacket)).toBe(true);
    });

    it("legacy shard with attempt spend: null and request spend: null loads", () => {
      const legacyPacket = {
        ...packet(),
        attempts: [{ ...attempt(), spend: null }],
        spend: null,
      };
      expect(isAccountingRequestPacketV1(legacyPacket)).toBe(true);
    });

    it("shard whose request spend disagrees with winner spend FAILS the guard", () => {
      const winnerSpend = validSpend();
      const differentSpend = { ...winnerSpend, amountMicrousd: 5_678 }; // Different amount

      const badPacket = {
        ...packet(),
        winningAttemptId: ATTEMPT_ID,
        attempts: [{ ...attempt(), spend: winnerSpend }],
        spend: differentSpend, // Mismatched!
      };
      expect(isAccountingRequestPacketV1(badPacket)).toBe(false);
    });

    it("shard with matching spend on winner and request passes", () => {
      const matchingSpend = validSpend();

      const goodPacket = {
        ...packet(),
        winningAttemptId: ATTEMPT_ID,
        attempts: [{ ...attempt(), spend: matchingSpend }],
        spend: matchingSpend,
      };
      expect(isAccountingRequestPacketV1(goodPacket)).toBe(true);
    });

    it("shard with null winner spend and non-null request spend LOADS (null = no claim, never conflicts)", () => {
      const someSpend = validSpend();

      const packetWithNullWinner = {
        ...packet(),
        winningAttemptId: ATTEMPT_ID,
        attempts: [{ ...attempt(), spend: null }],
        spend: someSpend,
      };
      // null means "no claim" — it never conflicts with anything per the schema design
      expect(isAccountingRequestPacketV1(packetWithNullWinner)).toBe(true);
    });

    it("shard with non-null winner spend and null request spend LOADS (null = no claim, never conflicts)", () => {
      const winnerSpend = validSpend();

      const packetWithNullRequest = {
        ...packet(),
        winningAttemptId: ATTEMPT_ID,
        attempts: [{ ...attempt(), spend: winnerSpend }],
        spend: null,
      };
      // null means "no claim" — it never conflicts with anything per the schema design
      expect(isAccountingRequestPacketV1(packetWithNullRequest)).toBe(true);
    });
  });

  it("keeps the global day-row and serialized-file budgets explicit", () => {
    expect(ACCOUNTING_MAX_DAY_ROWS).toBeGreaterThan(ACCOUNTING_MAX_ROWS_PER_CELL);
    expect(ACCOUNTING_MAX_FILE_BYTES).toBe(16 * 1024 * 1024);

    const fullRows = Array.from({ length: ACCOUNTING_MAX_DAY_ROWS }, (_, index) =>
      row({
        client: `client-${String(index).padStart(5, "0")}`,
      }),
    );
    const minute = {
      schema: ACCOUNTING_MINUTE_SCHEMA,
      version: ACCOUNTING_STORE_VERSION,
      date: "2026-08-20",
      minute: "01:02",
      from: "2026-08-20T01:02:00.000Z",
      to: "2026-08-20T01:03:00.000Z",
      aggregate: aggregate({ requests: 1, attempts: 1, served: 1 }),
      rows: fullRows.slice(0, ACCOUNTING_MAX_ROWS_PER_CELL),
      coverage: { state: "partial" as const, reason: "row_cap" as const, droppedRows: ACCOUNTING_MAX_DAY_ROWS, losses: [{ kind: "truncated" as const, count: ACCOUNTING_MAX_DAY_ROWS, field: "rows" }] },
    };
    const tooManyRowsDay = {
      schema: ACCOUNTING_DAY_SCHEMA,
      version: ACCOUNTING_STORE_VERSION,
      date: "2026-08-20",
      cells: Object.fromEntries(Array.from({ length: 9 }, (_, index) => {
        const key = `${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`;
        const from = `2026-08-20T${key}:00.000Z`;
        const to = new Date(Date.parse(from) + 60_000).toISOString();
        return [key, { ...minute, minute: key, from, to }];
      })),
      dedup: { schema: ACCOUNTING_DEDUP_SCHEMA, version: ACCOUNTING_STORE_VERSION, date: "2026-08-20", requestIds: [], dropped: 0, complete: true },
      coverage: coverage({ state: "partial", reason: "row_cap", droppedRows: 1, losses: [{ kind: "truncated", count: 1, field: "rows" }] }),
    };
    expect(isAccountingDayShardV1(tooManyRowsDay)).toBe(false);

    const maxRecentPackets = Array.from({ length: 100 }, (_, index) => {
      const requestId = `req_${String(index).padStart(15, "0")}`;
      const attempts = Array.from({ length: ACCOUNTING_MAX_DETAIL_ATTEMPTS }, (_, attemptIndex) =>
        attempt({ requestId, attemptId: `attempt-${String(index).padStart(6, "0")}-${String(attemptIndex).padStart(6, "0")}` }),
      );
      return packet({ requestId, winningAttemptId: attempts[0]?.attemptId ?? null, attempts, attemptCount: attempts.length, attemptMetadata: { total: attempts.length, stored: attempts.length, dropped: 0 } });
    });
    const recent = {
      schema: ACCOUNTING_RECENT_SCHEMA,
      version: ACCOUNTING_STORE_VERSION,
      rows: maxRecentPackets,
      details: Object.fromEntries(maxRecentPackets.map((item) => [item.requestId, item])),
      coverage: coverage(),
    };
    const bytes = accountingSerializedBytes(recent);
    expect(bytes).not.toBeNull();
    expect(bytes ?? Infinity).toBeLessThanOrEqual(ACCOUNTING_MAX_FILE_BYTES);
    expect(isAccountingRecentV1(recent)).toBe(true);
    expect(accountingSerializedBytes({ ...recent, padding: "x".repeat(ACCOUNTING_MAX_FILE_BYTES) })).toBeGreaterThan(ACCOUNTING_MAX_FILE_BYTES);
  });
});
