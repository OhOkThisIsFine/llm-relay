import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  writeSync,
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
  type TokenFactsInput,
} from "../src/accounting.js";
import {
  ACCOUNTING_MAX_DAY_ROWS,
  ACCOUNTING_MAX_DEDUP_IDS,
  ACCOUNTING_MAX_DETAIL_ATTEMPTS,
  ACCOUNTING_MAX_ROWS_PER_CELL,
  createAccountingStore,
  type AccountingStore,
} from "../src/accounting-store.js";
import { SNAPSHOT_IO_HARD_MAX_JOURNAL_BYTES } from "../src/accounting-store-io.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "llm-relay-accounting-store-"));
}

let requestSequence = 0;
let attemptSequence = 0;

function requestId(): string {
  return `request-${(++requestSequence).toString().padStart(16, "0")}`;
}

function attemptId(): string {
  return `attempt-${(++attemptSequence).toString().padStart(12, "0")}`;
}

type Outcome = "success" | "error" | "cancelled" | "unknown";
type Attribution = "relay_held" | "caller_operated" | "unknown";
type FailureKind = "timeout" | "provider_error" | "auth_error" | "rate_limit" | "aborted" | "protocol" | "unknown" | null;

interface AttemptPlan {
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
}

interface RequestPlan {
  readonly requestId?: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly client?: string | null;
  readonly attribution?: Attribution;
  readonly outcome?: Outcome;
  readonly failureKind?: FailureKind;
  readonly attempts?: readonly AttemptPlan[];
  readonly latencyMs?: number | null;
}

interface RecordedRequest {
  readonly requestId: string;
  readonly attemptIds: readonly string[];
  readonly events: readonly AccountingEvent[];
  readonly terminal: RequestCompletedEvent;
}

function recordRequest(store: AccountingStore, plan: RequestPlan): RecordedRequest {
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
    });
    if (completed === undefined) throw new Error("attempt completion was unexpectedly absent");
  }
  const terminal = request.complete({
    endedAt: plan.endedAt,
    ...(plan.outcome === undefined ? {} : { outcome: plan.outcome }),
    ...(plan.outcome === "success" || plan.outcome === undefined ? {} : { failureKind: plan.failureKind ?? "provider_error" }),
    ...(plan.latencyMs === undefined ? {} : { latencyMs: plan.latencyMs }),
  });
  if (terminal === undefined) throw new Error("request completion was unexpectedly absent");
  return { requestId: id, attemptIds, events, terminal };
}

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
    expect(aggregate.spend).toBeNull();
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
  });

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
    const store = createAccountingStore({ rootDir: root(), recentLimit: 1, detailLimit: 1 });
    const endedAt = "2026-08-21T00:00:00.000Z";
    for (let index = 0; index <= ACCOUNTING_MAX_DEDUP_IDS; index += 1) {
      store.record(terminalOnly(`dedup-${index.toString().padStart(16, "0")}`, endedAt));
    }
    const dedup = day(store, "2026-08-21").dedup;
    expect(dedup.requestIds).toHaveLength(ACCOUNTING_MAX_DEDUP_IDS);
    expect(dedup.complete).toBe(false);
    expect(dedup.dropped).toBe(1);
    store.record(terminalOnly(`dedup-${ACCOUNTING_MAX_DEDUP_IDS.toString().padStart(16, "0")}`, endedAt));
    expect(day(store, "2026-08-21").dedup.dropped).toBe(2);
    store.close();
  });

  it.each(["malformed", "truncated", "oversize"] as const)("quarantines a %s journal as lower-bound loss and remains writable", (kind) => {
    const directory = root();
    const journal = join(directory, "snapshot-journal.json");
    if (kind === "oversize") {
      const descriptor = openSync(journal, "w");
      try {
        writeSync(descriptor, Buffer.from("x"), 0, 1, SNAPSHOT_IO_HARD_MAX_JOURNAL_BYTES);
      } finally {
        closeSync(descriptor);
      }
    } else {
      writeFileSync(journal, kind === "malformed" ? "not-json" : "{\"schema\":");
    }
    const store = createAccountingStore({ rootDir: directory });
    const recovered = lifetime(store);
    expect(recovered.coverage.reason).toBe("corrupt_recovery");
    expect(store.lastWrite?.lowerBoundLoss).toBe(true);
    expect(store.flush().status).toBe("committed");
    expect(existsSync(journal)).toBe(false);
    recordRequest(store, {
      startedAt: "2026-08-20T06:00:00.000Z",
      endedAt: "2026-08-20T06:00:01.000Z",
      attempts: [{ outcome: "success", commitMs: 1 }],
    });
    expect(store.flush().status).toBe("committed");
    expect(day(store, "2026-08-20").coverage.state).toBe("partial");
    store.close();
  });

  it("retries one transient journal write deterministically and flushes during shutdown", () => {
    vi.useFakeTimers();
    try {
      const directory = root();
      let fail = true;
      const store = createAccountingStore({
        rootDir: directory,
        ioHooks: {
          beforeStep(step) {
            if (fail && step.phase === "target" && step.target !== null) {
              fail = false;
              throw new Error("transient target write");
            }
          },
        },
      });
      recordRequest(store, {
        startedAt: "2026-08-20T07:00:00.000Z",
        endedAt: "2026-08-20T07:00:01.000Z",
        attempts: [{ outcome: "success", commitMs: 1 }],
      });
      expect(store.flush().status).toBe("failed");
      vi.advanceTimersByTime(25);
      expect(day(store, "2026-08-20").cells["07:00"]!.aggregate.requests).toBe(1);
      expect(store.close().status).toBe("none");

      const shutdownDirectory = root();
      const shutdown = createAccountingStore({ rootDir: shutdownDirectory });
      recordRequest(shutdown, {
        startedAt: "2026-08-20T07:01:00.000Z",
        endedAt: "2026-08-20T07:01:01.000Z",
        attempts: [{ outcome: "success", commitMs: 1 }],
      });
      expect(shutdown.close().status).toBe("committed");
      expect(existsSync(join(shutdownDirectory, "2026-08-20.json"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps close retryable after one transient flush failure", () => {
    const directory = root();
    let failOnce = true;
    const store = createAccountingStore({
      rootDir: directory,
      ioHooks: {
        beforeStep(step) {
          if (failOnce && step.phase === "journal" && step.step === "before-temp-write") {
            failOnce = false;
            throw new Error("transient close flush");
          }
        },
      },
    });
    recordRequest(store, {
      startedAt: "2026-08-20T07:10:00.000Z",
      endedAt: "2026-08-20T07:10:01.000Z",
      attempts: [{ outcome: "success", commitMs: 1 }],
    });

    const failed = store.close();
    expect(failed).toMatchObject({ status: "failed", retryable: true });
    expect(store.closed).toBe(false);
    expect(store.close().status).toBe("committed");
    expect(store.closed).toBe(true);

    const restarted = createAccountingStore({ rootDir: directory });
    expect(lifetime(restarted).aggregate.requests).toBe(1);
    restarted.close();
  });

  it("does not let a second live same-root writer overwrite the first store", () => {
    const directory = root();
    const first = createAccountingStore({ rootDir: directory });
    const initial = recordRequest(first, {
      startedAt: "2026-08-20T08:00:00.000Z",
      endedAt: "2026-08-20T08:00:01.000Z",
      attempts: [{ outcome: "success", commitMs: 1 }],
    });
    const second = createAccountingStore({ rootDir: directory });
    expect(second.writerStatus.status).toBe("busy");
    second.record(terminalOnly(requestId(), "2026-08-20T08:01:00.000Z"));
    expect(second.flush().status).toBe("failed");
    expect(first.flush().status).toBe("committed");
    expect(first.close().status).toBe("none");

    const reader = createAccountingStore({ rootDir: directory });
    expect(reader.readDetail(initial.requestId).status).toBe("ok");
    expect(reader.readRecent().status).toBe("ok");
    reader.close();
    second.close();
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
    expect(capped.missingDates).toEqual(["2026-08-20", "2026-08-21"]);
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

  it("retries a pre-journal retention failure after fact snapshots are already durable", () => {
    vi.useFakeTimers();
    try {
      const directory = root();
      let journals = 0;
      const now = Date.parse("2026-08-20T12:00:00.000Z");
      const store = createAccountingStore({ rootDir: directory, retentionDays: 1, now: () => now, ioHooks: {
        beforeStep(step) {
          if (step.phase !== "journal" || step.step !== "before-temp-write") return;
          journals += 1;
          if (journals === 2) throw new Error("retention journal unavailable");
        },
      } });
      recordRequest(store, { startedAt: "2026-08-01T00:00:00.000Z", endedAt: "2026-08-01T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
      recordRequest(store, { startedAt: "2026-08-20T00:00:00.000Z", endedAt: "2026-08-20T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });

      expect(store.flush().status).toBe("failed");
      expect(existsSync(join(directory, "2026-08-01.json"))).toBe(true);
      expect((JSON.parse(readFileSync(join(directory, "lifetime.json"), "utf8")) as { coverage: { retentionFrom: string | null } }).coverage.retentionFrom).toBeNull();

      vi.advanceTimersByTime(25);
      expect(existsSync(join(directory, "2026-08-01.json"))).toBe(false);
      expect(store.readDay("2026-08-01").status).toBe("missing");
      expect(lifetime(store).coverage.retentionFrom).toBe("2026-08-20");
      expect((JSON.parse(readFileSync(join(directory, "lifetime.json"), "utf8")) as { coverage: { retentionFrom: string | null } }).coverage.retentionFrom).toBe("2026-08-20");

      expect(store.close().status).toBe("none");
      const restarted = createAccountingStore({ rootDir: directory, retentionDays: 1, now: () => now });
      expect(restarted.readDay("2026-08-01").status).toBe("missing");
      expect(lifetime(restarted).coverage.retentionFrom).toBe("2026-08-20");
      restarted.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a durable retention journal without discarding newer in-memory facts", () => {
    vi.useFakeTimers();
    try {
      const directory = root();
      const now = Date.parse("2026-08-20T12:00:00.000Z");
      let durableJournals = 0;
      let failTarget = true;
      const store = createAccountingStore({ rootDir: directory, retentionDays: 1, now: () => now, ioHooks: {
        afterStep(step) {
          if (step.phase === "journal" && step.step === "after-directory-fsync") durableJournals += 1;
        },
        beforeStep(step) {
          if (failTarget && durableJournals >= 2 && step.phase === "target" && step.step === "before-delete" && step.target === "2026-08-01.json") {
            failTarget = false;
            throw new Error("retention target unavailable");
          }
        },
      } });
      recordRequest(store, { startedAt: "2026-08-01T00:00:00.000Z", endedAt: "2026-08-01T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
      recordRequest(store, { startedAt: "2026-08-20T00:00:00.000Z", endedAt: "2026-08-20T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });

      expect(store.flush().status).toBe("failed");
      expect(existsSync(join(directory, "snapshot-journal.json"))).toBe(true);
      expect(store.readDay("2026-08-01").status).toBe("ok");
      recordRequest(store, { startedAt: "2026-08-20T01:00:00.000Z", endedAt: "2026-08-20T01:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });

      vi.advanceTimersByTime(25);
      expect(existsSync(join(directory, "snapshot-journal.json"))).toBe(false);
      expect(existsSync(join(directory, "2026-08-01.json"))).toBe(false);
      expect(store.readDay("2026-08-01").status).toBe("missing");
      expect(lifetime(store).aggregate.requests).toBe(3);
      expect(lifetime(store).coverage.retentionFrom).toBe("2026-08-20");

      expect(store.close().status).toBe("none");
      const restarted = createAccountingStore({ rootDir: directory, retentionDays: 1, now: () => now });
      expect(restarted.readDay("2026-08-01").status).toBe("missing");
      expect(lifetime(restarted).aggregate.requests).toBe(3);
      expect(lifetime(restarted).coverage.retentionFrom).toBe("2026-08-20");
      restarted.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances a bounded durable retention cursor and retries close continuation", () => {
    vi.useFakeTimers();
    try {
      const directory = root();
      const now = Date.parse("2026-06-01T12:00:00.000Z");
      let blockContinuation = false;
      const store = createAccountingStore({ rootDir: directory, retentionDays: 1, now: () => now, ioHooks: {
        beforeStep(step) {
          if (blockContinuation && step.phase === "journal" && step.step === "before-temp-write") throw new Error("stop after first retention batch");
        },
      } });
      recordRequest(store, { startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
      recordRequest(store, { startedAt: "2026-06-01T00:00:00.000Z", endedAt: "2026-06-01T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });

      expect(store.flush().status).toBe("committed");
      expect(lifetime(store).coverage.retentionFrom).toBe("2026-05-08");
      expect(existsSync(join(directory, "2026-01-01.json"))).toBe(false);
    blockContinuation = true;
    expect(store.close().status).toBe("failed");
    expect(store.closed).toBe(false);
    blockContinuation = false;
    expect(store.close().status).toBe("committed");

    const restarted = createAccountingStore({ rootDir: directory, retentionDays: 1, now: () => now });
    expect(restarted.flush().status).toBe("none");
      expect(lifetime(restarted).coverage.retentionFrom).toBe("2026-06-01");
      expect(restarted.readDay("2026-01-01").status).toBe("missing");
      expect(restarted.readDay("2026-06-01").status).toBe("ok");
      restarted.close();
    } finally {
      vi.useRealTimers();
    }
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

  it("does not overwrite fixed snapshots while a transient initial read is pending", () => {
    vi.useFakeTimers();
    try {
      const directory = root();
      const seeded = createAccountingStore({ rootDir: directory });
      const first = recordRequest(seeded, { startedAt: "2026-08-20T00:00:00.000Z", endedAt: "2026-08-20T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
      expect(seeded.close().status).toBe("committed");
      const beforeLifetime = readFileSync(join(directory, "lifetime.json"), "utf8");
      const beforeRecent = readFileSync(join(directory, "recent.json"), "utf8");
      let failLifetimeRead = true;
      const store = createAccountingStore({ rootDir: directory, ioHooks: {
        beforeRead(path) {
          if (failLifetimeRead && path.endsWith("lifetime.json")) throw new Error("transient lifetime read");
        },
      } });
      expect(store.readLifetime().status).toBe("corrupt");
      expect(store.readDetail(first.requestId).status).toBe("corrupt");
      const second = recordRequest(store, { startedAt: "2026-08-20T01:00:00.000Z", endedAt: "2026-08-20T01:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
      expect(store.flush().status).toBe("failed");
      expect(readFileSync(join(directory, "lifetime.json"), "utf8")).toBe(beforeLifetime);
      expect(readFileSync(join(directory, "recent.json"), "utf8")).toBe(beforeRecent);

      failLifetimeRead = false;
      vi.advanceTimersByTime(50);
      expect(lifetime(store).aggregate.requests).toBe(2);
      expect(store.readDetail(first.requestId).status).toBe("ok");
      expect(store.readDetail(second.requestId).status).toBe("ok");
      expect(store.close().status).toBe("none");
      const restarted = createAccountingStore({ rootDir: directory });
      expect(lifetime(restarted).aggregate.requests).toBe(2);
      restarted.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps dirty facts when an ordinary journal recovery read is transiently unavailable", () => {
    vi.useFakeTimers();
    try {
      const directory = root();
      let failJournalRead = false;
      let failTarget = false;
      const store = createAccountingStore({ rootDir: directory, ioHooks: {
        beforeRead(path) {
          if (failJournalRead && path.endsWith("snapshot-journal.json")) throw new Error("transient journal read");
        },
        beforeStep(step) {
          if (failTarget && step.phase === "target" && step.target === "2026-08-20.json") {
            failTarget = false;
            throw new Error("leave a durable fact journal");
          }
        },
      } });
      recordRequest(store, { startedAt: "2026-08-20T00:00:00.000Z", endedAt: "2026-08-20T00:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
      expect(store.flush().status).toBe("committed");
      recordRequest(store, { startedAt: "2026-08-20T01:00:00.000Z", endedAt: "2026-08-20T01:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
      failTarget = true;
      expect(store.flush().status).toBe("failed");
      expect(existsSync(join(directory, "snapshot-journal.json"))).toBe(true);
      recordRequest(store, { startedAt: "2026-08-20T02:00:00.000Z", endedAt: "2026-08-20T02:00:01.000Z", attempts: [{ outcome: "success", commitMs: 1 }] });
      failJournalRead = true;
      expect(store.flush().status).toBe("failed");
      expect(lifetime(store).aggregate.requests).toBe(3);

      failJournalRead = false;
      vi.advanceTimersByTime(50);
      expect(lifetime(store).aggregate.requests).toBe(3);
      expect(store.close().status).toBe("none");
      const restarted = createAccountingStore({ rootDir: directory });
      expect(lifetime(restarted).aggregate.requests).toBe(3);
      restarted.close();
    } finally {
      vi.useRealTimers();
    }
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
});
