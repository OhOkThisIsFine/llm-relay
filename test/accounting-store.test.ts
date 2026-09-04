import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAccountingRequest,
  type AccountingEvent,
  type AccountingRecorder,
  type AttemptCompletedEvent,
  type RequestCompletedEvent,
} from "../src/accounting.js";
import {
  ACCOUNTING_MAX_DAY_ROWS,
  ACCOUNTING_MAX_DETAIL_ATTEMPTS,
  ACCOUNTING_MAX_ROWS_PER_CELL,
  createAccountingStore,
  type AccountingStore,
} from "../src/accounting-store.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "llm-relay-accounting-store-"));
}
import {
  PORT_PUBLISHED,
  PORT_REFERENCE,
  emptyAggregateTokens,
  emptyMetric,
  legacyMinuteCell,
  requestId,
  attemptId,
  recordRequest,
  type AttemptPlan,
} from "./helpers/accounting-fixtures.js";

function terminalOnly(id: string, endedAt: string): RequestCompletedEvent {
  return {
    type: "request-completed",
    requestId: id,
    endedAt,
    outcome: "error",
    failureKind: "provider_error",
    attribution: "unknown",
    attemptCount: 0,
    repairIncluded: false,
    winningAttemptId: null,
    commitAttemptId: null,
    latencyMs: null,
    commitMs: null,
    provider: null,
    model: null,
    credentialId: null,
    tokens: {} as RequestCompletedEvent["tokens"],
    spend: null,
    abandonedSpend: [],
  };
}

function startedOnly(id: string, startedAt: string): AccountingEvent {
  return {
    type: "request-started",
    requestId: id,
    startedAt,
    client: "claude",
    attribution: "relay_held",
    provider: null,
    model: null,
    credentialId: null,
  };
}

function day(store: AccountingStore, date: string) {
  const read = store.readDay(date);
  expect(read.status).toBe("ok");
  if (read.status !== "ok") throw new Error(`day ${date} was not readable`);
  return read.value;
}

function lifetime(store: AccountingStore) {
  const read = store.readLifetime();
  expect(read.status).toBe("ok");
  if (read.status !== "ok") throw new Error("lifetime was not readable");
  return read.value;
}

/** Losses announced on the persisted recent snapshot's coverage. */
function recentLosses(directory: string) {
  const raw = JSON.parse(readFileSync(join(directory, "recent.json"), "utf8")) as { coverage: { losses: readonly { kind: string; count: number; field: string | null }[] } };
  return raw.coverage.losses;
}

describe("durable canonical accounting store", () => {
  it("keeps request and attempt ownership separate while preserving full failover tuples", () => {
    const store = createAccountingStore({ rootDir: root() });
    const packet = recordRequest(store, {
      startedAt: "2026-08-20T01:02:00.000Z",
      endedAt: "2026-08-20T01:02:03.000Z",
      attempts: [
        {
          outcome: "error",
          provider: "provider-a",
          model: "model-a",
          credentialId: "provider-a#one",
          attribution: "caller_operated",
          tokens: { reported: { inputTokens: 10 } },
        },
        {
          role: "repair",
          outcome: "success",
          provider: "repairer",
          model: "repair-model",
          credentialId: "repairer#one",
          tokens: { estimated: { inputTokens: 3, inputMethod: "chars/4" } },
        },
        {
          outcome: "success",
          provider: "provider-b",
          model: "model-b",
          credentialId: "provider-b#two",
          attribution: "relay_held",
          commitMs: 7,
          tokens: {
            reported: {
              inputTokens: 100,
              outputTokens: 20,
              cachedInputTokens: 4,
              cacheCreationInputTokens: 7,
              cacheReadInputTokens: 9,
            },
            estimated: { inputTokens: 3, outputTokens: 5, inputMethod: "chars/4", outputMethod: "bytes/4" },
          },
        },
      ],
    });

    const recent = store.readRecent();
    expect(recent.status).toBe("ok");
    if (recent.status !== "ok") return;
    const detail = recent.value[0]!;
    expect(detail.requestId).toBe(packet.requestId);
    expect(detail.provider).toBe("provider-b");
    expect(detail.model).toBe("model-b");
    expect(detail.credentialId).toBe("provider-b#two");
    expect(detail.attribution).toBe("relay_held");
    expect(detail.attempts.map((attempt) => [attempt.role, attempt.provider, attempt.outcome])).toEqual([
      ["serve", "provider-a", "error"],
      ["repair", "repairer", "success"],
      ["serve", "provider-b", "success"],
    ]);
    expect(detail.tokens.reported.reportedCachedInput.value).toBe(4);
    expect(detail.tokens.reported.cacheCreationInputTokens.value).toBe(7);
    expect(detail.tokens.reported.cacheReadInputTokens.value).toBe(9);
    expect(detail.tokens.estimated.estimatedInput.method).toBe("chars/4");

    const cell = day(store, "2026-08-20").cells["01:02"]!;
    expect(cell.aggregate.requests).toBe(1);
    expect(cell.aggregate.attempts).toBe(3);
    expect(cell.aggregate.served).toBe(1);
    expect(cell.aggregate.requestTokens.reported.reportedInput.value).toBe(100);
    expect(cell.aggregate.tokens.reported.reportedInput.value).toBeNull();
    expect(cell.rows.filter((row) => row.kind === "attempt")).toHaveLength(3);
    expect(cell.rows.find((row) => row.kind === "request")?.provider).toBe("provider-b");
    store.close();
  });

  it("accounts a terminal pre-egress request without inventing an attempt or token fact", () => {
    const store = createAccountingStore({ rootDir: root() });
    recordRequest(store, {
      startedAt: "2026-08-20T02:00:00.000Z",
      endedAt: "2026-08-20T02:00:01.000Z",
      outcome: "error",
      failureKind: "auth_error",
    });
    const cell = day(store, "2026-08-20").cells["02:00"]!;
    expect(cell.aggregate.requests).toBe(1);
    expect(cell.aggregate.attempts).toBe(0);
    expect(cell.aggregate.errored).toBe(1);
    expect(cell.aggregate.requestTokens.reported.reportedInput.value).toBeNull();
    expect(cell.aggregate.requestTokens.reported.reportedInput.unknown).toBe(1);
    expect(cell.rows.filter((row) => row.kind === "attempt")).toHaveLength(0);
    expect(cell.aggregate.unpricedRequests).toBe(1);
    store.close();
  });

  it("uses the terminal UTC minute and is exactly once across a closed-store replay", () => {
    const directory = root();
    const first = createAccountingStore({ rootDir: directory });
    const recorded = recordRequest(first, {
      startedAt: "2026-08-19T23:59:00.000Z",
      endedAt: "2026-08-19T23:59:59.000Z",
      attempts: [{ outcome: "success", provider: "provider", model: "model", credentialId: "provider#one", commitMs: 4 }],
    });
    recordRequest(first, {
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:00:01.000Z",
      attempts: [{ outcome: "success", provider: "provider", model: "model", credentialId: "provider#one", commitMs: 4 }],
    });
    expect(first.flush().status).toBe("committed");
    expect(first.close().status).toBe("none");

    const restarted = createAccountingStore({ rootDir: directory });
    for (const event of recorded.events) restarted.record(event);
    expect(restarted.flush().status).toBe("none");
    const replayed = day(restarted, "2026-08-19");
    expect(Object.keys(replayed.cells)).toEqual(["23:59"]);
    expect(replayed.cells["23:59"]!.aggregate.requests).toBe(1);
    expect(replayed.dedup.requestIds).toEqual([recorded.requestId]);
    expect(lifetime(restarted).months["2026-08"]?.aggregate.requests).toBe(1);
    expect(lifetime(restarted).months["2026-09"]?.aggregate.requests).toBe(1);
    expect(lifetime(restarted).aggregate.requests).toBe(2);
    restarted.close();
  });

  it("aggregates every terminal attempt while detail packets cap and force-retain winner and commit", () => {
    const store = createAccountingStore({ rootDir: root() });
    const attempts: AttemptPlan[] = Array.from({ length: ACCOUNTING_MAX_DETAIL_ATTEMPTS + 5 }, (_, index) => ({
      outcome: index === ACCOUNTING_MAX_DETAIL_ATTEMPTS + 4 ? "success" : "error",
      provider: `provider-${index}`,
      model: `model-${index}`,
      credentialId: `provider-${index}#credential`,
      ...(index === ACCOUNTING_MAX_DETAIL_ATTEMPTS + 4 ? { commitMs: 9 } : {}),
    }));
    const recorded = recordRequest(store, {
      startedAt: "2026-08-20T03:00:00.000Z",
      endedAt: "2026-08-20T03:00:05.000Z",
      attempts,
    });
    const detail = store.readDetail(recorded.requestId);
    expect(detail.status).toBe("ok");
    if (detail.status !== "ok") return;
    expect(detail.value.attemptMetadata).toEqual({
      total: attempts.length,
      stored: ACCOUNTING_MAX_DETAIL_ATTEMPTS,
      dropped: attempts.length - ACCOUNTING_MAX_DETAIL_ATTEMPTS,
    });
    expect(detail.value.attempts.some((attempt) => attempt.attemptId === recorded.attemptIds.at(-1))).toBe(true);
    expect(detail.value.winningAttemptId).toBe(recorded.attemptIds.at(-1));
    expect(detail.value.commitAttemptId).toBe(recorded.attemptIds.at(-1));
    const cell = day(store, "2026-08-20").cells["03:00"]!;
    expect(cell.aggregate.attempts).toBe(attempts.length);
    store.close();
  });

  it("keeps recent rows and detail packets independently bounded with truthful coverage", () => {
    const directory = root();
    const store = createAccountingStore({ rootDir: directory, recentLimit: 2, detailLimit: 1 });
    const first = recordRequest(store, { startedAt: "2026-08-20T04:00:00.000Z", endedAt: "2026-08-20T04:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    const second = recordRequest(store, { startedAt: "2026-08-20T04:01:00.000Z", endedAt: "2026-08-20T04:01:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    const third = recordRequest(store, { startedAt: "2026-08-20T04:02:00.000Z", endedAt: "2026-08-20T04:02:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    const recent = store.readRecent();
    expect(recent.status).toBe("ok");
    if (recent.status !== "ok") return;
    expect(recent.value.map((packet) => packet.requestId)).toEqual([third.requestId, second.requestId]);
    expect(store.readDetail(first.requestId).status).toBe("missing");
    expect(store.readDetail(second.requestId).status).toBe("missing");
    expect(store.readDetail(third.requestId).status).toBe("ok");
    expect(store.flush().status).toBe("committed");
    const raw = JSON.parse(readFileSync(join(directory, "recent.json"), "utf8")) as { coverage: { droppedRecent: number; droppedDetails: number } };
    expect(raw.coverage.droppedRecent).toBe(1);
    expect(raw.coverage.droppedDetails).toBeGreaterThanOrEqual(2);
    store.close();
  });

  it("treats an explicit zero recent limit as zero rows, reserving the default for omission", () => {
    const store = createAccountingStore({ rootDir: root() });
    recordRequest(store, { startedAt: "2026-08-20T04:30:00.000Z", endedAt: "2026-08-20T04:30:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    recordRequest(store, { startedAt: "2026-08-20T04:31:00.000Z", endedAt: "2026-08-20T04:31:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });

    const defaulted = store.readRecent();
    expect(defaulted.status).toBe("ok");
    if (defaulted.status === "ok") expect(defaulted.value).toHaveLength(2);

    const explicitZero = store.readRecent({ limit: 0 });
    expect(explicitZero.status).toBe("ok");
    if (explicitZero.status === "ok") expect(explicitZero.value).toHaveLength(0);

    const positionalZero = store.readRecent(0);
    expect(positionalZero.status).toBe("ok");
    if (positionalZero.status === "ok") expect(positionalZero.value).toHaveLength(0);

    const cappedToOne = store.readRecent({ limit: 1 });
    expect(cappedToOne.status).toBe("ok");
    if (cappedToOne.status === "ok") expect(cappedToOne.value).toHaveLength(1);

    // A non-finite garbage limit is not a count; fall back to the default.
    const nonsense = store.readRecent({ limit: Number.NaN });
    expect(nonsense.status).toBe("ok");
    if (nonsense.status === "ok") expect(nonsense.value).toHaveLength(2);
    store.close();
  });

  it("announces an unparseable attempt packet as a loss instead of dropping it silently", () => {
    const directory = root();
    const store = createAccountingStore({ rootDir: directory });
    const invalid: AttemptCompletedEvent = {
      type: "attempt-completed",
      requestId: "unsafe\nrequest",
      attemptId: "attempt-0000000001",
      role: "serve",
      startedAt: "2026-08-20T09:00:00.000Z",
      endedAt: "2026-08-20T09:00:01.000Z",
      outcome: "error",
      failureKind: "provider_error",
      attribution: "relay_held",
      latencyMs: 10,
      commitMs: null,
      provider: "provider-a",
      model: "model-a",
      credentialId: null,
      tokens: {} as AttemptCompletedEvent["tokens"],
      spend: null,
    };
    store.record(invalid);
    expect(store.flush().status).toBe("committed");
    // The same drop is announced on BOTH fixed snapshots, like every other
    // markGlobalLoss path, so no reader sees a silently smaller measurement.
    expect(lifetime(store).coverage.state).toBe("partial");
    expect(lifetime(store).coverage.losses.some((loss) => loss.field === "attempt_packet")).toBe(true);
    expect(recentLosses(directory).some((loss) => loss.field === "attempt_packet")).toBe(true);
    store.close();
  });

  it("evicts the oldest-started pending request rather than the first-inserted", () => {
    const store = createAccountingStore({ rootDir: root(), pendingRequestLimit: 2 });
    const lateStart = requestId();
    const earlyStart = requestId();
    const third = requestId();
    // Insertion order is deliberately the REVERSE of start order.
    store.record(startedOnly(lateStart, "2026-08-20T09:10:20.000Z"));
    store.record(startedOnly(earlyStart, "2026-08-20T09:10:10.000Z"));
    store.record(startedOnly(third, "2026-08-20T09:10:30.000Z"));
    // The eviction this forces must take the EARLIEST-STARTED entry
    // (earlyStart), so the later-started first-inserted one keeps its detail.
    store.record(terminalOnly(lateStart, "2026-08-20T09:11:00.000Z"));
    expect(store.readDetail(lateStart).status).toBe("ok");
    expect(lifetime(store).coverage.losses.some((loss) => loss.field === "pending_requests")).toBe(true);
    store.close();
  });

  it("does not turn unknown token facts into zeroes", () => {
    const store = createAccountingStore({ rootDir: root() });
    recordRequest(store, {
      startedAt: "2026-08-20T04:10:00.000Z",
      endedAt: "2026-08-20T04:10:01.000Z",
      outcome: "error",
      failureKind: "provider_error",
    });
    const aggregate = day(store, "2026-08-20").cells["04:10"]!.aggregate;
    expect(aggregate.requestTokens.reported.reportedInput.value).toBeNull();
    expect(aggregate.requestTokens.reported.reportedInput.unknown).toBe(1);
    expect(aggregate.requestTokens.estimated.estimatedOutput.value).toBeNull();
    expect(aggregate.requestTokens.estimated.estimatedOutput.method).toBe("unknown");
    // Spend is now real aggregate cells; an unpriced request contributes NOTHING
    // to them (amount null AND known 0) rather than a fabricated $0.
    for (const cell of Object.values(aggregate.requestSpend ?? {})) {
      expect(cell.amountMicrousd).toBeNull();
      expect(cell.known).toBe(0);
    }
    expect(aggregate.unpricedRequests).toBe(1);
    store.close();
  });

  it("persists estimated values with explicit fallback provenance", () => {
    const directory = root();
    const store = createAccountingStore({ rootDir: directory });
    const recorded = recordRequest(store, {
      startedAt: "2026-08-20T04:20:00.000Z",
      endedAt: "2026-08-20T04:20:01.000Z",
      attempts: [{
        outcome: "success",
        commitMs: 1,
        tokens: { estimated: { inputTokens: 7 } },
      }],
    });

    expect(store.flush().status).toBe("committed");
    const detail = store.readDetail(recorded.requestId);
    expect(detail.status).toBe("ok");
    if (detail.status === "ok") {
      expect(detail.value.tokens.estimated.estimatedInput).toMatchObject({
        value: 7,
        method: "unspecified",
      });
    }
    expect(store.close().status).toBe("none");

    const restarted = createAccountingStore({ rootDir: directory });
    expect(restarted.readDetail(recorded.requestId).status).toBe("ok");
    restarted.close();
  });

  it("marks pending and compound-row caps while retaining aggregate lower bounds", () => {
    const store = createAccountingStore({ rootDir: root(), pendingRequestLimit: 1, recentLimit: 1, detailLimit: 1 });
    store.record(startedOnly(requestId(), "2026-08-20T05:00:00.000Z"));
    store.record(startedOnly(requestId(), "2026-08-20T05:00:01.000Z"));
    store.record(terminalOnly(requestId(), "2026-08-20T05:00:02.000Z"));

    const rows = Array.from({ length: ACCOUNTING_MAX_ROWS_PER_CELL + 2 }, (_, index): AttemptPlan => ({
      outcome: index === ACCOUNTING_MAX_ROWS_PER_CELL + 1 ? "success" : "error",
      provider: `row-provider-${index}`,
      model: "shared-model",
      credentialId: `row-provider-${index}#credential`,
      ...(index === ACCOUNTING_MAX_ROWS_PER_CELL + 1 ? { commitMs: 1 } : {}),
    }));
    recordRequest(store, {
      startedAt: "2026-08-20T05:01:00.000Z",
      endedAt: "2026-08-20T05:01:01.000Z",
      attempts: rows,
    });
    const rowCell = day(store, "2026-08-20").cells["05:01"]!;
    expect(rowCell.aggregate.attempts).toBe(rows.length);
    expect(rowCell.rows).toHaveLength(ACCOUNTING_MAX_ROWS_PER_CELL);
    expect(rowCell.coverage.reason).toBe("row_cap");
    expect(lifetime(store).coverage.state).toBe("partial");
    store.close();
  });

  // This exercises all 4,096 mutations deliberately. It normally finishes near one second, but
  // the suite runs file workers concurrently and Windows I/O contention can exceed Vitest's 5s
  // default without changing the behavior under test.
  it("enforces the whole-day row cap during mutation without poisoning the shard", () => {
    const directory = root();
    const store = createAccountingStore({ rootDir: directory });
    const date = "2026-08-20";

    for (let index = 0; index < ACCOUNTING_MAX_DAY_ROWS; index += 1) {
      const minute = Math.floor(index / ACCOUNTING_MAX_ROWS_PER_CELL).toString().padStart(2, "0");
      const id = requestId();
      store.record({
        ...terminalOnly(id, `${date}T06:${minute}:01.000Z`),
        provider: `day-row-provider-${index}`,
      });
    }
    const overflowId = requestId();
    store.record({
      ...terminalOnly(overflowId, `${date}T06:08:01.000Z`),
      provider: "day-row-provider-overflow",
    });

    const shard = day(store, date);
    const rows = Object.values(shard.cells).reduce((sum, cell) => sum + cell.rows.length, 0);
    expect(rows).toBe(ACCOUNTING_MAX_DAY_ROWS);
    expect(shard.cells["06:08"]?.aggregate.requests).toBe(1);
    expect(shard.cells["06:08"]?.rows).toHaveLength(0);
    expect(shard.coverage).toMatchObject({ state: "partial", reason: "row_cap", droppedRows: 1 });
    expect(lifetime(store).coverage).toMatchObject({ state: "partial", reason: "row_cap", droppedRows: 1 });
    expect(store.flush().status).toBe("committed");
    expect(store.close().status).toBe("none");

    const restarted = createAccountingStore({ rootDir: directory });
    const persisted = day(restarted, date);
    expect(Object.values(persisted.cells).reduce((sum, cell) => sum + cell.rows.length, 0)).toBe(ACCOUNTING_MAX_DAY_ROWS);
    expect(persisted.coverage.droppedRows).toBe(1);
    restarted.close();
  }, 15_000);

  it("propagates dimension row caps to day, lifetime, and month coverage", () => {
    const store = createAccountingStore({ rootDir: root() });
    const attempts = Array.from({ length: ACCOUNTING_MAX_ROWS_PER_CELL + 2 }, (_, index): AttemptPlan => ({
      outcome: index === ACCOUNTING_MAX_ROWS_PER_CELL + 1 ? "success" : "error",
      provider: `row-cap-provider-${index}`,
      model: "shared-model",
      credentialId: `row-cap-provider-${index}#credential`,
      ...(index === ACCOUNTING_MAX_ROWS_PER_CELL + 1 ? { commitMs: 1 } : {}),
    }));
    recordRequest(store, {
      startedAt: "2026-08-20T05:20:00.000Z",
      endedAt: "2026-08-20T05:20:01.000Z",
      attempts,
    });
    expect(store.flush().status).toBe("committed");

    const shard = day(store, "2026-08-20");
    const cell = shard.cells["05:20"]!;
    expect(cell.coverage.reason).toBe("row_cap");
    expect(shard.coverage.reason).toBe("row_cap");
    expect(shard.coverage.droppedRows).toBeGreaterThan(0);

    const aggregate = lifetime(store);
    expect(aggregate.coverage.reason).toBe("row_cap");
    expect(aggregate.coverage.droppedRows).toBe(shard.coverage.droppedRows);
    const month = aggregate.months["2026-08"];
    expect(month).toBeDefined();
    expect(month?.coverage.reason).toBe("row_cap");
    expect(month?.coverage.droppedRows).toBe(shard.coverage.droppedRows);
    store.close();
  });

  it("caps pending attempt starts without dropping later completion facts", () => {
    const store = createAccountingStore({ rootDir: root(), pendingAttemptLimit: 1 });
    const recorder: AccountingRecorder = { record(event) { store.record(event); } };
    const request = createAccountingRequest({
      recorder,
      idFactory: attemptId,
      requestId: requestId(),
      startedAt: "2026-08-20T05:30:00.000Z",
      client: "claude",
      attribution: "relay_held",
    });
    const retainedStart = request.startAttempt({
      role: "serve",
      startedAt: "2026-08-20T05:30:00.000Z",
      attribution: "relay_held",
      provider: "retained-start",
      model: "shared-model",
      credentialId: "retained-start#credential",
    });
    const cappedStart = request.startAttempt({
      role: "serve",
      startedAt: "2026-08-20T05:30:00.000Z",
      attribution: "relay_held",
      provider: "capped-start",
      model: "shared-model",
      credentialId: "capped-start#credential",
    });
    expect(cappedStart.complete({
      outcome: "error",
      failureKind: "provider_error",
      endedAt: "2026-08-20T05:30:01.000Z",
      latencyMs: 1,
    })).toBeDefined();
    expect(retainedStart.complete({
      outcome: "error",
      failureKind: "provider_error",
      endedAt: "2026-08-20T05:30:01.000Z",
      latencyMs: 1,
    })).toBeDefined();
    expect(request.complete({ endedAt: "2026-08-20T05:30:01.000Z", outcome: "error", failureKind: "provider_error" })).toBeDefined();

    const cell = day(store, "2026-08-20").cells["05:30"]!;
    expect(cell.aggregate.attempts).toBe(1);
    expect(cell.rows.some((row) => row.kind === "attempt" && row.provider === "capped-start")).toBe(true);
    expect(lifetime(store).coverage.reason).toBe("detail_cap");
    expect(lifetime(store).coverage.losses.some((loss) => loss.field === "pending_attempt_starts")).toBe(true);
    store.close();
  });

  it("caps buffered terminal attempts explicitly instead of silently treating them as complete detail", () => {
    const store = createAccountingStore({ rootDir: root(), pendingAttemptLimit: 1 });
    const request = recordRequest(store, {
      startedAt: "2026-08-20T05:10:00.000Z",
      endedAt: "2026-08-20T05:10:01.000Z",
      attempts: [
        { outcome: "error", provider: "first", model: "model", credentialId: "first#one" },
        { outcome: "success", provider: "winner", model: "model", credentialId: "winner#one", commitMs: 1 },
      ],
    });
    const cell = day(store, "2026-08-20").cells["05:10"]!;
    expect(cell.aggregate.attempts).toBe(1);
    expect(store.readDetail(request.requestId).status).toBe("missing");
    expect(lifetime(store).coverage.state).toBe("partial");
    store.close();
  });

  it("splits dirty day batches at the journal target cap without losing a terminal fact", () => {
    const store = createAccountingStore({ rootDir: root(), recentLimit: 1, detailLimit: 1 });
    const first = Date.parse("2026-01-01T00:00:00.000Z");
    for (let index = 0; index < 127; index += 1) {
      const endedAt = new Date(first + index * 86_400_000).toISOString();
      store.record(terminalOnly(requestId(), endedAt));
    }
    expect(store.flush().status).toBe("committed");
    expect(day(store, "2026-01-01").cells["00:00"]!.aggregate.requests).toBe(1);
    expect(day(store, "2026-05-07").cells["00:00"]!.aggregate.requests).toBe(1);
    expect(lifetime(store).aggregate.requests).toBe(127);
    store.close();
  });

  it("stops claiming exact replay suppression after the durable dedup index cap", () => {
    // The cap POLICY is what this pins, so it runs against the injected `dedupLimit` seam:
    // filling the real 16,384-entry cap re-sorts the id array on every insert, and that worst
    // case overran vitest's budget under full-suite load. Production passes no dedupLimit and
    // keeps ACCOUNTING_MAX_DEDUP_IDS.
    const cap = 64;
    const store = createAccountingStore({ rootDir: root(), recentLimit: 1, detailLimit: 1, dedupLimit: cap });
    const endedAt = "2026-08-21T00:00:00.000Z";
    for (let index = 0; index <= cap; index += 1) {
      store.record(terminalOnly(`dedup-${index.toString().padStart(16, "0")}`, endedAt));
    }
    const dedup = day(store, "2026-08-21").dedup;
    expect(dedup.requestIds).toHaveLength(cap);
    expect(dedup.complete).toBe(false);
    expect(dedup.dropped).toBe(1);
    store.record(terminalOnly(`dedup-${cap.toString().padStart(16, "0")}`, endedAt));
    expect(day(store, "2026-08-21").dedup.dropped).toBe(2);
    store.close();
  });



  it("keeps default retention disabled and applies positive retention only from committed clock-eligible days", () => {
    const keepDirectory = root();
    const keep = createAccountingStore({ rootDir: keepDirectory });
    recordRequest(keep, { startedAt: "2026-08-01T00:00:00.000Z", endedAt: "2026-08-01T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    recordRequest(keep, { startedAt: "2026-08-20T00:00:00.000Z", endedAt: "2026-08-20T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    expect(keep.flush().status).toBe("committed");
    expect(readdirSync(keepDirectory)).toEqual(expect.arrayContaining(["2026-08-01.json", "2026-08-20.json"]));
    keep.close();

    const restartDirectory = root();
    const seed = createAccountingStore({ rootDir: restartDirectory });
    recordRequest(seed, { startedAt: "2026-08-01T00:00:00.000Z", endedAt: "2026-08-01T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    expect(seed.close().status).toBe("committed");
    const restartPrune = createAccountingStore({
      rootDir: restartDirectory,
      retentionDays: 1,
      now: () => Date.parse("2026-08-20T12:00:00.000Z"),
    });
    recordRequest(restartPrune, { startedAt: "2026-08-20T00:00:00.000Z", endedAt: "2026-08-20T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    expect(restartPrune.flush().status).toBe("committed");
    expect(existsSync(join(restartDirectory, "2026-08-01.json"))).toBe(false);
    restartPrune.close();

    const directory = root();
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const prune = createAccountingStore({ rootDir: directory, retentionDays: 1, now: () => now });
    recordRequest(prune, { startedAt: "2026-08-01T00:00:00.000Z", endedAt: "2026-08-01T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    recordRequest(prune, { startedAt: "2026-08-20T00:00:00.000Z", endedAt: "2026-08-20T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    expect(prune.flush().status).toBe("committed");
    expect(existsSync(join(directory, "2026-08-01.json"))).toBe(false);
    expect(lifetime(prune).coverage.reason).toBe("retention_pruned");
    expect(lifetime(prune).coverage.retentionFrom).toBe("2026-08-20");

    recordRequest(prune, { startedAt: "2026-08-05T00:00:00.000Z", endedAt: "2026-08-05T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    expect(prune.flush().status).toBe("committed");
    expect(existsSync(join(directory, "2026-08-05.json"))).toBe(false);
    recordRequest(prune, { startedAt: "2026-08-21T00:00:00.000Z", endedAt: "2026-08-21T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    expect(prune.flush().status).toBe("committed");
    expect(existsSync(join(directory, "2026-08-05.json"))).toBe(false);
    prune.close();
  });

  it("returns exact missing/corrupt statuses and does not discover unrelated files by scanning", () => {
    const directory = root();
    const foreign = join(directory, "unrelated.json");
    writeFileSync(foreign, "not a store shard");
    const store = createAccountingStore({ rootDir: directory, readDaysCap: 2 });
    expect(store.readLifetime().status).toBe("missing");
    expect(store.readRecent().status).toBe("missing");
    expect(store.readDay("2026-08-20").status).toBe("missing");
    writeFileSync(join(directory, "2026-08-21.json"), "{\"schema\":\"wrong\"}");
    expect(store.readDay("2026-08-21").status).toBe("corrupt");
    expect(store.readDay("not-a-date").status).toBe("corrupt");
    const capped = store.readDays(["2026-08-20", "2026-08-21", "2026-08-22"]);
    expect(capped.status).toBe("capped");
    expect(capped.results).toHaveLength(2);
    expect(capped.missingDates).toEqual(["2026-08-20"]);
    expect(capped.corruptDates).toEqual(["2026-08-21"]);
    expect(existsSync(foreign)).toBe(true);
    store.close();
  });

  it("bounds clean day caches without evicting dirty day facts", () => {
    const directory = root();
    const cachedDates = ["2026-08-01", "2026-08-02", "2026-08-03"] as const;
    const seed = createAccountingStore({ rootDir: directory });
    for (const date of cachedDates) {
      recordRequest(seed, {
        startedAt: `${date}T00:00:00.000Z`,
        endedAt: `${date}T00:00:01.000Z`,
        attempts: [{ outcome: "success", commitMs: 1 }],
      });
    }
    expect(seed.flush().status).toBe("committed");
    seed.close();

    const reads = new Map<string, number>();
    const reader = createAccountingStore({
      rootDir: directory,
      readDaysCap: 2,
      ioHooks: {
        beforeRead(path) {
          for (const date of cachedDates) {
            if (!path.endsWith(`${date}.json`)) continue;
            reads.set(date, (reads.get(date) ?? 0) + 1);
          }
        },
      },
    });
    for (const date of cachedDates) expect(reader.readDay(date).status).toBe("ok");
    expect(reader.readDay(cachedDates[0]).status).toBe("ok");
    expect(reads.get(cachedDates[0])).toBe(2);
    reader.close();

    const active = createAccountingStore({ rootDir: directory, readDaysCap: 1 });
    recordRequest(active, {
      startedAt: "2026-08-04T00:00:00.000Z",
      endedAt: "2026-08-04T00:00:01.000Z",
      attempts: [{ outcome: "success", commitMs: 1 }],
    });
    expect(active.readDay(cachedDates[0]).status).toBe("ok");
    expect(active.readDay(cachedDates[1]).status).toBe("ok");
    expect(active.flush().status).toBe("committed");
    active.close();

    const restarted = createAccountingStore({ rootDir: directory });
    expect(day(restarted, "2026-08-04").cells["00:00"]?.aggregate.requests).toBe(1);
    restarted.close();
  });

  it("preserves a terminal day when every bounded cache entry is in flight", () => {
    const directory = root();
    const protectedDates = ["2026-08-01", "2026-08-02"] as const;
    const terminalDate = "2026-08-03";
    const seed = createAccountingStore({ rootDir: directory });
    for (const date of protectedDates) {
      recordRequest(seed, {
        startedAt: `${date}T00:00:00.000Z`,
        endedAt: `${date}T00:00:01.000Z`,
        attempts: [{ outcome: "success", commitMs: 1 }],
      });
    }
    expect(seed.close().status).toBe("committed");

    let terminalReads = 0;
    const store = createAccountingStore({
      rootDir: directory,
      readDaysCap: 2,
      ioHooks: {
        beforeRead(path) {
          if (path.endsWith(`${terminalDate}.json`)) terminalReads += 1;
        },
      },
    });
    for (const date of protectedDates) expect(store.readDay(date).status).toBe("ok");
    for (const date of protectedDates) store.record(startedOnly(requestId(), `${date}T12:00:00.000Z`));

    recordRequest(store, {
      startedAt: `${terminalDate}T00:00:00.000Z`,
      endedAt: `${terminalDate}T00:00:01.000Z`,
      attempts: [{ outcome: "success", commitMs: 1 }],
    });
    expect(store.flush().status).toBe("committed");
    terminalReads = 0;
    expect(day(store, terminalDate).cells["00:00"]?.aggregate.requests).toBe(1);
    expect(terminalReads).toBe(1);
    expect(store.close().status).toBe("none");

    const restarted = createAccountingStore({ rootDir: directory });
    expect(day(restarted, terminalDate).cells["00:00"]?.aggregate.requests).toBe(1);
    restarted.close();
  });



  it("revisits an expired late shard behind the cursor after clock rollback", () => {
    const directory = root();
    const currentNow = Date.parse("2026-08-20T12:00:00.000Z");
    const initial = createAccountingStore({ rootDir: directory, retentionDays: 1, now: () => currentNow });
    recordRequest(initial, { startedAt: "2026-08-01T00:00:00.000Z", endedAt: "2026-08-01T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    recordRequest(initial, { startedAt: "2026-08-20T00:00:00.000Z", endedAt: "2026-08-20T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    expect(initial.flush().status).toBe("committed");
    expect(initial.close().status).toBe("none");

    const rolledBack = createAccountingStore({ rootDir: directory, retentionDays: 1, now: () => Date.parse("2026-08-10T12:00:00.000Z") });
    recordRequest(rolledBack, { startedAt: "2026-08-05T00:00:00.000Z", endedAt: "2026-08-05T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
    expect(rolledBack.flush().status).toBe("committed");
    expect(lifetime(rolledBack).coverage.retentionFrom).toBe("2026-08-10");
    expect(existsSync(join(directory, "2026-08-05.json"))).toBe(false);
    expect(rolledBack.readDay("2026-08-05").status).toBe("missing");
    expect(rolledBack.close().status).toBe("none");

    const restarted = createAccountingStore({ rootDir: directory, retentionDays: 1, now: () => Date.parse("2026-08-10T12:00:00.000Z") });
    expect(restarted.readDay("2026-08-05").status).toBe("missing");
    restarted.close();
  });

  it("uses request start for lifetime first-seen while retaining terminal time for retention", () => {
    const now = Date.parse("2026-08-21T12:00:00.000Z");
    const store = createAccountingStore({ rootDir: root(), retentionDays: 1, now: () => now });

    recordRequest(store, {
      startedAt: "2026-08-19T23:59:00.000Z",
      endedAt: "2026-08-20T00:00:01.000Z",
      attempts: [{ outcome: "success", commitMs: 1 }],
    });
    expect(store.flush().status).toBe("committed");
    expect(lifetime(store).firstRequestAt).toBe("2026-08-19T23:59:00.000Z");
    expect(lifetime(store).lastRequestAt).toBe("2026-08-20T00:00:01.000Z");
    expect(lifetime(store).coverage.retentionFrom).toBe("2026-08-20");

    recordRequest(store, {
      startedAt: "2026-08-18T23:59:00.000Z",
      endedAt: "2026-08-21T00:00:01.000Z",
      attempts: [{ outcome: "success", commitMs: 1 }],
    });
    expect(store.flush().status).toBe("committed");
    expect(lifetime(store).firstRequestAt).toBe("2026-08-18T23:59:00.000Z");
    expect(lifetime(store).lastRequestAt).toBe("2026-08-21T00:00:01.000Z");
    expect(lifetime(store).coverage.retentionFrom).toBe("2026-08-21");
    store.close();
  });


  it("caps array reads before indexing arbitrary later entries", () => {
    const store = createAccountingStore({ rootDir: root(), readDaysCap: 2 });
    const dates = new Proxy(["2026-08-20", "2026-08-21", "2026-08-22"], {
      get(target, property, receiver) {
        if (property === "2") throw new Error("uncapped array access");
        return Reflect.get(target, property, receiver);
      },
    });
    const result = store.readDays(dates);
    expect(result.status).toBe("capped");
    expect(result.results).toHaveLength(2);
    store.close();
  });

  it("loads a LEGACY pre-spend shard with spend: null as empty cells, not zeros or quarantine", () => {
    const directory = root();
    const legacyDay = {
      schema: "accounting.day.v1",
      version: 1,
      date: "2026-08-19",
      cells: {
        "10:00": legacyMinuteCell(),
      },
      dedup: { schema: "accounting.dedup.v1", version: 1, date: "2026-08-19", requestIds: [], dropped: 0, complete: true },
      coverage: { state: "complete", reason: null, droppedRows: 0, droppedRecent: 0, droppedDetails: 0, droppedDedup: 0, retentionFrom: null, retentionDays: null, losses: [] },
    };
    writeFileSync(join(directory, "2026-08-19.json"), JSON.stringify(legacyDay));
    const store = createAccountingStore({ rootDir: directory });
    const read = store.readDay("2026-08-19");
    expect(read.status).toBe("ok");
    if (read.status !== "ok") throw new Error("legacy day was not readable");
    // The persisted form keeps the legacy null; readers normalize to empty cells.
    expect(read.value.cells["10:00"]!.aggregate.spend).toBeNull();
    // A NEW terminal event on the same day still lands beside the legacy cell.
    recordRequest(store, {
      requestId: requestId(),
      startedAt: "2026-08-19T11:00:00.000Z",
      endedAt: "2026-08-19T11:00:01.000Z",
      outcome: "success",
      pricePort: PORT_PUBLISHED,
      attempts: [{ provider: "prov", model: "model-a", outcome: "success", tokens: { reported: { inputTokens: 1_000, outputTokens: 0 } } }],
    });
    expect(store.flush().status).toBe("committed");
    const updated = store.readDay("2026-08-19");
    if (updated.status !== "ok") throw new Error("updated day was not readable");
    expect(updated.value.cells["11:00"]!.aggregate.requestSpend?.providerPublishedReported.amountMicrousd).toBe(2_000);
    store.close();
  });
});

describe("spend aggregation into the four cells (Stage 4 / Gap 11)", () => {
  // Regression: a diff hunk replaced addRootAttempt's attempt-TOKEN fold with the
  // spend fold, so root/day-cell/lifetime/month aggregates stopped accumulating
  // attempt-side tokens while the spend cells looked complete. Two attempts, one of
  // them the reported-input serve, must sum in BOTH the day cell and the lifetime.
  it("folds attempt tokens into root aggregates beside attempt spend", () => {
    const store = createAccountingStore({ rootDir: root() });
    recordRequest(store, {
      startedAt: "2026-08-20T07:00:00.000Z",
      endedAt: "2026-08-20T07:00:02.000Z",
      outcome: "success",
      pricePort: PORT_PUBLISHED,
      attempts: [
        { outcome: "error", provider: "prov", model: "model-a", tokens: { reported: { inputTokens: 100, outputTokens: 0 } } },
        { provider: "prov", model: "model-a", outcome: "success", tokens: { reported: { inputTokens: 900, outputTokens: 50 } } },
      ],
    });
    store.flush();
    // Day cell root: 100 + 900 reported input, 0 + 50 reported output.
    const cell = day(store, "2026-08-20").cells["07:00"]!.aggregate;
    expect(cell.attempts).toBe(2);
    expect(cell.tokens.reported.reportedInput).toMatchObject({ value: 1_000, known: 2 });
    expect(cell.tokens.reported.reportedOutput).toMatchObject({ value: 50, known: 2 });
    // Attempt-side spend still folds beside the tokens (both axes, one walk):
    // 100x$2 + (900x$2 + 50x$4) at PORT_PUBLISHED.
    expect(cell.spend?.providerPublishedReported.amountMicrousd).toBe(100 * 2 + 900 * 2 + 50 * 4);
    expect(cell.spend?.providerPublishedReported.known).toBe(2);
    // Lifetime root sums the same two attempts.
    const life = lifetime(store).aggregate;
    expect(life.tokens.reported.reportedInput).toMatchObject({ value: 1_000, known: 2 });
    expect(life.tokens.reported.reportedOutput.value).toBe(50);
    expect(life.spend?.providerPublishedReported.amountMicrousd).toBe(100 * 2 + 900 * 2 + 50 * 4);
    // Request-side axis untouched: only the winning serve's tokens/spend.
    expect(life.requestTokens.reported.reportedInput.value).toBe(900);
    expect(life.requestSpend?.providerPublishedReported.amountMicrousd).toBe(900 * 2 + 50 * 4);
    store.close();
  });

  it("aggregates priced requests into the matching request-side cells and counts partial coverage", () => {
    const store = createAccountingStore({ rootDir: root() });
    // Two fully-priced provider-published/reported requests.
    recordRequest(store, {
      startedAt: "2026-08-20T04:00:00.000Z",
      endedAt: "2026-08-20T04:00:01.000Z",
      outcome: "success",
      pricePort: PORT_PUBLISHED,
      attempts: [{ provider: "prov", model: "model-a", outcome: "success", tokens: { reported: { inputTokens: 500, outputTokens: 250 } } }],
    });
    recordRequest(store, {
      startedAt: "2026-08-20T04:01:00.000Z",
      endedAt: "2026-08-20T04:01:01.000Z",
      outcome: "success",
      pricePort: PORT_PUBLISHED,
      attempts: [{ provider: "prov", model: "model-a", outcome: "success", tokens: { reported: { inputTokens: 1_000, outputTokens: 250 } } }],
    });
    // One partially priced (reference, in-only) request in a different minute.
    recordRequest(store, {
      startedAt: "2026-08-20T04:02:00.000Z",
      endedAt: "2026-08-20T04:02:01.000Z",
      outcome: "success",
      pricePort: PORT_REFERENCE,
      attempts: [{ provider: "prov", model: "model-a", outcome: "success", tokens: { reported: { inputTokens: 2_000, outputTokens: 0 } } }],
    });
    store.flush();
    // Minute cell holds only its own request's spend.
    const firstMinute = day(store, "2026-08-20").cells["04:00"]!.aggregate;
    expect(firstMinute.requestSpend?.providerPublishedReported).toEqual({
      amountMicrousd: 2_000,
      known: 1,
      observedAt: "2026-08-20T04:00:01.000Z",
    });
    expect(firstMinute.requestSpend?.referenceReported.known).toBe(0);
    // The lifetime carries all three.
    const life = lifetime(store).aggregate;
    expect(life.requestSpend?.providerPublishedReported.amountMicrousd).toBe(2_000 + 3_000);
    expect(life.requestSpend?.referenceReported.amountMicrousd).toBe(2_000);
    expect(life.partiallyPricedRequests).toBe(1);
    expect(life.unpricedRequests).toBe(0);
    store.close();
  });

  it("folds an abandoned hedge loser into its OWN cells, leaving requestSpend and every counter alone", () => {
    const store = createAccountingStore({ rootDir: root() });
    recordRequest(store, {
      startedAt: "2026-08-20T05:00:00.000Z",
      endedAt: "2026-08-20T05:00:01.000Z",
      outcome: "success",
      pricePort: PORT_PUBLISHED,
      attempts: [
        {
          provider: "slow", model: "model-slow", outcome: "cancelled", failureKind: "aborted",
          abandonedByRelay: true,
          tokens: { reported: { inputTokens: 1_000, outputTokens: 0 } },
        },
        {
          provider: "fast", model: "model-fast", outcome: "success",
          tokens: { reported: { inputTokens: 1_000, outputTokens: 250 } },
        },
      ],
    });
    store.flush();

    const life = lifetime(store).aggregate;
    // The loser's spend is recorded, and it is its own figure.
    expect(life.abandonedSpend?.providerPublishedReported.amountMicrousd).toBe(2_000);
    expect(life.abandonedSpend?.providerPublishedReported.known).toBe(1);
    // The winner's request-side figure is EXACTLY what it is without D3: 1000 input and 250 output
    // priced by this file's PORT_PUBLISHED. Folding the loser in here would have changed a shipped
    // number's meaning, so this assertion is the one that would catch it.
    expect(life.requestSpend?.providerPublishedReported.amountMicrousd).toBe(3_000);
    // ⚠ The counters are the silent-failure guard: the persisted schema enforces
    // `unpriced + partiallyPriced <= requests`, and breaching it makes the store stop writing to
    // disk without throwing. The loser touches neither.
    expect(life.unpricedRequests).toBe(0);
    expect(life.partiallyPricedRequests ?? 0).toBe(0);
    expect(life.requests).toBe(1);
    store.close();
  });

  it("keeps an abandoned loser off the request row's own aggregate counters after a reload", () => {
    // The shard must round-trip: a rejected shape does not throw, it silently stops persistence.
    const dir = root();
    const first = createAccountingStore({ rootDir: dir });
    recordRequest(first, {
      startedAt: "2026-08-20T06:00:00.000Z",
      endedAt: "2026-08-20T06:00:01.000Z",
      outcome: "success",
      pricePort: PORT_PUBLISHED,
      attempts: [
        {
          provider: "slow", model: "model-slow", outcome: "cancelled", failureKind: "aborted",
          abandonedByRelay: true,
          tokens: { reported: { inputTokens: 500, outputTokens: 0 } },
        },
        { provider: "fast", model: "model-fast", outcome: "success", tokens: { reported: { inputTokens: 500, outputTokens: 100 } } },
      ],
    });
    first.flush();
    first.close();

    const reopened = createAccountingStore({ rootDir: dir });
    const life = lifetime(reopened).aggregate;
    expect(life.abandonedSpend?.providerPublishedReported.amountMicrousd).toBe(1_000);
    expect(life.requests).toBe(1);
    reopened.close();
  });

  it("counts an unpriced request only in unpricedRequests, never as $0 spend", () => {
    const store = createAccountingStore({ rootDir: root() });
    recordRequest(store, {
      startedAt: "2026-08-20T05:00:00.000Z",
      endedAt: "2026-08-20T05:00:01.000Z",
      outcome: "success",
      attempts: [{ outcome: "success", tokens: { reported: { inputTokens: 900, outputTokens: 0 } } }],
    });
    store.flush();
    const aggregate = day(store, "2026-08-20").cells["05:00"]!.aggregate;
    expect(aggregate.unpricedRequests).toBe(1);
    for (const cell of Object.values(aggregate.requestSpend ?? {})) {
      expect(cell.amountMicrousd).toBeNull();
      expect(cell.known).toBe(0);
    }
    store.close();
  });

  it("keeps repair spend on attempt-side cells without double-counting request-side cells", () => {
    const store = createAccountingStore({ rootDir: root() });
    recordRequest(store, {
      startedAt: "2026-08-20T06:00:00.000Z",
      endedAt: "2026-08-20T06:00:02.000Z",
      outcome: "success",
      pricePort: PORT_PUBLISHED,
      attempts: [
        { role: "repair", provider: "prov", model: "model-a", outcome: "success", tokens: { reported: { inputTokens: 100, outputTokens: 0 } } },
        { role: "serve", provider: "prov", model: "model-a", outcome: "success", tokens: { reported: { inputTokens: 1_000, outputTokens: 0 } } },
      ],
    });
    store.flush();
    const aggregate = day(store, "2026-08-20").cells["06:00"]!.aggregate;
    // Request side: the winning serve ONLY (same rule as request tokens).
    expect(aggregate.requestSpend?.providerPublishedReported).toEqual({
      amountMicrousd: 2_000,
      known: 1,
      observedAt: "2026-08-20T06:00:02.000Z",
    });
    // Attempt side: repair + serve both counted there (C1 keeps rows separate).
    expect(aggregate.spend?.providerPublishedReported.amountMicrousd).toBe(2_200);
    expect(aggregate.spend?.providerPublishedReported.known).toBe(2);
    store.close();
  });

  describe("atomic store backward compatibility and stale journal isolation (DR-020)", () => {
    it("loads pre-existing shards in the OLD on-disk layout", () => {
      const seedDir = root();
      const seedStore = createAccountingStore({ rootDir: seedDir });
      recordRequest(seedStore, {
        requestId: "preexisting-req-1",
        startedAt: "2026-08-20T10:00:00.000Z",
        endedAt: "2026-08-20T10:00:01.000Z",
        outcome: "success",
        attempts: [{ outcome: "success", commitMs: 1 }],
      });
      expect(seedStore.flush().status).toBe("committed");
      seedStore.close();

      const directory = root();
      writeFileSync(join(directory, "lifetime.json"), readFileSync(join(seedDir, "lifetime.json"), "utf8"));
      writeFileSync(join(directory, "recent.json"), readFileSync(join(seedDir, "recent.json"), "utf8"));
      writeFileSync(join(directory, "2026-08-20.json"), readFileSync(join(seedDir, "2026-08-20.json"), "utf8"));

      const store = createAccountingStore({ rootDir: directory });

      const readLifetime = store.readLifetime();
      expect(readLifetime.status).toBe("ok");
      if (readLifetime.status !== "ok") throw new Error("lifetime not ok");
      expect(readLifetime.value.firstRequestAt).toBe("2026-08-20T10:00:00.000Z");
      expect(readLifetime.value.aggregate.requests).toBe(1);

      const readRecent = store.readRecent();
      expect(readRecent.status).toBe("ok");
      if (readRecent.status !== "ok") throw new Error("recent not ok");
      expect(readRecent.value).toHaveLength(1);
      expect(readRecent.value[0]!.requestId).toBe("preexisting-req-1");

      const readDay = store.readDay("2026-08-20");
      expect(readDay.status).toBe("ok");
      if (readDay.status !== "ok") throw new Error("day not ok");
      expect(readDay.value.cells["10:00"]?.aggregate.requests).toBe(1);

      store.close();
    });

    it("ignores a stale snapshot-journal.json from an older version without replaying or quarantining it", () => {
      const seedDir = root();
      const seedStore = createAccountingStore({ rootDir: seedDir });
      recordRequest(seedStore, {
        requestId: "preexisting-req-1",
        startedAt: "2026-08-20T10:00:00.000Z",
        endedAt: "2026-08-20T10:00:01.000Z",
        outcome: "success",
        attempts: [{ outcome: "success", commitMs: 1 }],
      });
      expect(seedStore.flush().status).toBe("committed");
      seedStore.close();

      const directory = root();
      writeFileSync(join(directory, "lifetime.json"), readFileSync(join(seedDir, "lifetime.json"), "utf8"));

      const staleJournal = JSON.stringify({
        schema: "llm-relay.snapshot-journal.v1",
        version: 1,
        transactionId: "legacy-uncommitted-001",
        createdAtMs: Date.now() - 60000,
        targets: [
          {
            name: "lifetime.json",
            operation: "replace",
            bytes: 12,
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            data: Buffer.from("mutated-data").toString("base64"),
          },
        ],
      });
      writeFileSync(join(directory, "snapshot-journal.json"), staleJournal);

      const store = createAccountingStore({ rootDir: directory });

      // Stale journal is ignored: lifetime is NOT overwritten with mutated-data or marked corrupt
      const read = store.readLifetime();
      expect(read.status).toBe("ok");
      if (read.status !== "ok") throw new Error("lifetime should be ok");
      expect(read.value.aggregate.requests).toBe(1);

      // Stale journal is NOT quarantined or deleted: it remains intact as-is
      expect(existsSync(join(directory, "snapshot-journal.json"))).toBe(true);
      expect(readFileSync(join(directory, "snapshot-journal.json"), "utf8")).toBe(staleJournal);
      const corruptFiles = readdirSync(directory).filter((f) => f.includes(".corrupt-"));
      expect(corruptFiles).toEqual([]);

      // Flushes/writes do not produce or touch snapshot-journal.json
      recordRequest(store, {
        startedAt: "2026-08-20T11:00:00.000Z",
        endedAt: "2026-08-20T11:00:01.000Z",
        attempts: [{ outcome: "success", commitMs: 1 }],
      });
      expect(store.flush().status).toBe("committed");
      store.close();

      expect(readFileSync(join(directory, "snapshot-journal.json"), "utf8")).toBe(staleJournal);
    });
  });
});

