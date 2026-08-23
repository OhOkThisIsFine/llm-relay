import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAccountingRequest, type AccountingPricePort, type AccountingRecorder, type TokenFactsInput } from "../../src/accounting.js";
import { createAccountingStore, type AccountingReader } from "../../src/accounting-store.js";
import { isAccountingRequestPacketV1 } from "../../src/accounting-store-schema.js";
import type { AccountingDayShard } from "../../src/accounting-store-schema.js";
import { isDetailV1, isSnapshotV1, type CooldownRowV1, type QuotaRowV1 } from "../../src/dashboard-contract.js";
import { createDashboardSnapshotReadPort } from "../../src/dashboard-snapshot.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "llm-relay-dashboard-snapshot-"));
}

let nextRequest = 0;
let nextAttempt = 0;
function requestId(): string {
  nextRequest += 1;
  return `snapshot_request_${nextRequest.toString().padStart(8, "0")}`;
}
function attemptId(): string {
  nextAttempt += 1;
  return `snapshot_attempt_${nextAttempt.toString().padStart(8, "0")}`;
}

interface AttemptPlan {
  readonly role?: "serve" | "repair";
  readonly attribution?: "relay_held" | "caller_operated" | "unknown";
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly credentialId?: string | null;
  readonly outcome?: "success" | "error" | "cancelled" | "unknown";
  readonly failureKind?: "timeout" | "provider_error" | "auth_error" | "rate_limit" | "aborted" | "protocol" | "unknown";
  readonly tokens?: TokenFactsInput;
  readonly latencyMs?: number | null;
  readonly commitMs?: number;
}

function record(
  store: ReturnType<typeof createAccountingStore>,
  options: {
    readonly endedAt: string;
    readonly client?: string;
    /** Published-price lookup; absent ⇒ unpriced. */
    readonly pricePort?: AccountingPricePort | undefined;
    readonly attribution?: "relay_held" | "caller_operated" | "unknown";
    readonly outcome?: "success" | "error" | "cancelled" | "unknown";
    readonly failureKind?: "timeout" | "provider_error" | "auth_error" | "rate_limit" | "aborted" | "protocol" | "unknown";
    readonly attempts?: readonly AttemptPlan[];
    readonly latencyMs?: number | null;
  },
): string {
  const id = requestId();
  const recorder: AccountingRecorder = { record: (event) => store.record(event) };
  const request = createAccountingRequest({
    recorder,
    idFactory: attemptId,
    requestId: id,
    startedAt: options.endedAt,
    client: options.client ?? "cli",
    attribution: options.attribution ?? "relay_held",
    pricePort: options.pricePort,
  });
  for (const plan of options.attempts ?? []) {
    const attempt = request.startAttempt({
      role: plan.role ?? "serve",
      startedAt: options.endedAt,
      attribution: plan.attribution ?? options.attribution ?? "relay_held",
      provider: plan.provider ?? "openai",
      model: plan.model ?? "gpt-test",
      credentialId: plan.credentialId ?? "openai#primary",
    });
    if (plan.commitMs !== undefined) attempt.markCommitted({ commitMs: plan.commitMs });
    const outcome = plan.outcome ?? "success";
    attempt.complete({
      outcome,
      ...(outcome === "success" ? {} : { failureKind: plan.failureKind ?? "provider_error" }),
      endedAt: options.endedAt,
      latencyMs: plan.latencyMs ?? 20,
      ...(plan.tokens === undefined ? {} : { tokens: plan.tokens }),
    });
  }
  const outcome = options.outcome ?? "success";
  request.complete({
    outcome,
    ...(outcome === "success" ? {} : { failureKind: options.failureKind ?? "provider_error" }),
    endedAt: options.endedAt,
    latencyMs: options.latencyMs ?? 20,
  });
  return id;
}

function port(store: ReturnType<typeof createAccountingStore>, now = "2026-08-20T12:34:56.000Z") {
  return createDashboardSnapshotReadPort({ accounting: store, relayVersion: "test", now: () => now });
}

function readerWithDays(base: AccountingReader, days: readonly AccountingDayShard[], statusByDate: Readonly<Record<string, "ok" | "missing" | "corrupt">>): AccountingReader {
  return {
    ...base,
    readDays: (dates: readonly string[]) => ({
      status: "ok",
      days,
      results: dates.map((date) => {
        const status = statusByDate[date] ?? "missing";
        return status === "ok"
          ? { date, result: { status: "ok", value: days.find((day) => day.date === date) ?? null } }
          : status === "corrupt"
            ? { date, result: { status: "corrupt", value: null, error: "test corruption" } }
            : { date, result: { status: "missing", value: null } };
      }),
      missingDates: dates.filter((date) => (statusByDate[date] ?? "missing") === "missing"),
      corruptDates: dates.filter((date) => statusByDate[date] === "corrupt"),
      capped: false,
    }),
  } as unknown as AccountingReader;
}

describe("dashboard snapshot projection", () => {
  it("uses fixed UTC boundaries and bounded bucket counts", async () => {
    const store = createAccountingStore({ rootDir: root() });
    const read = port(store);
    const expectations: ReadonlyArray<readonly ["1h" | "24h" | "7d" | "30d" | "today" | "month", number]> = [
      ["1h", 60],
      ["24h", 96],
      ["7d", 168],
      ["30d", 120],
      ["today", 50],
      ["month", 19],
    ];
    for (const [window, count] of expectations) {
      const snapshot = await read.readSnapshot({ window, includeRepair: false });
      expect(snapshot.buckets).toHaveLength(count);
      expect(snapshot.buckets.every((bucket) => bucket.from < bucket.to)).toBe(true);
      expect(snapshot.buckets.at(-1)?.to).toBe(snapshot.to);
      expect(isSnapshotV1(snapshot)).toBe(true);
    }
    const today = await read.readSnapshot({ window: "today", includeRepair: false });
    expect(today.from).toBe("2026-08-20T00:00:00.000Z");
    expect(today.to).toBe("2026-08-20T12:30:00.000Z");
    store.close();
  });

  it("keeps request rows/tokens separate from repair attempts", async () => {
    const store = createAccountingStore({ rootDir: root() });
    const id = record(store, {
      endedAt: "2026-08-20T12:30:00.000Z",
      attempts: [
        { provider: "openai", tokens: { reported: { inputTokens: 11, outputTokens: 2 } }, commitMs: 8 },
        { role: "repair", provider: "repairer", tokens: { reported: { inputTokens: 99, outputTokens: 99 } } },
      ],
    });
    const read = port(store);
    const excluded = await read.readSnapshot({ window: "1h", includeRepair: false });
    const included = await read.readSnapshot({ window: "1h", includeRepair: true });
    expect(excluded.summary.requests).toBe(1);
    expect(excluded.summary.attempts).toBe(1);
    expect(included.summary.attempts).toBe(2);
    expect(excluded.summary.tokens.reported.reportedInput.value).toBe(11);
    expect(included.summary.tokens.reported.reportedInput.value).toBe(11);
    expect(excluded.recentRequests).toHaveLength(1);
    expect(excluded.recentRequests[0]?.repairIncluded).toBe(true);
    const detail = await read.readDetail({ requestId: id, includeRepair: false });
    expect(detail?.attempts.map((attempt) => attempt.role)).toEqual(["serve"]);
    expect(isDetailV1(detail)).toBe(true);
    store.close();
  });

  it("projects priced spend into the matching cell and unpriced requests into the counter", async () => {
    const store = createAccountingStore({ rootDir: root() });
    const publishedPort: AccountingPricePort = () => ({ pricePerMillionIn: 2, pricePerMillionOut: 4, priceSource: "provider" });
    // Priced: 1_000 in x $2/M + 250 out x $4/M = 3_000 micro-USD.
    record(store, {
      endedAt: "2026-08-20T12:30:00.000Z",
      pricePort: publishedPort,
      attempts: [{ provider: "openai", tokens: { reported: { inputTokens: 1_000, outputTokens: 250 } } }],
    });
    // Unpriced: no port ⇒ no spend figure.
    record(store, {
      endedAt: "2026-08-20T12:31:00.000Z",
      attempts: [{ provider: "nim", tokens: { reported: { inputTokens: 5_000, outputTokens: 100 } } }],
    });
    const snapshot = await port(store).readSnapshot({ window: "1h", includeRepair: false });
    const cells = snapshot.summary.spend;
    expect(cells.providerPublishedReported.amountMicrousd).toBe(3_000);
    expect(cells.providerPublishedReported.source).toBe("provider_reported");
    expect(cells.unpricedRequests).toBe(1);
    expect(cells.partiallyPricedRequests).toBe(0);
    // The recent row carries the same priced figure.
    const row = snapshot.recentRequests.find((candidate) => candidate.spend.providerPublishedReported.amountMicrousd === 3_000);
    expect(row).toBeDefined();
    store.close();
  });

  it("marks a partially priced request so the spend amounts read as lower bounds", async () => {
    const store = createAccountingStore({ rootDir: root() });
    const inOnlyPort: AccountingPricePort = () => ({ pricePerMillionIn: 2, pricePerMillionOut: null, priceSource: "provider" });
    // Cache kinds are unpriced AND output has no price ⇒ partial.
    record(store, {
      endedAt: "2026-08-20T12:30:00.000Z",
      pricePort: inOnlyPort,
      attempts: [{ provider: "openai", tokens: { reported: { inputTokens: 1_000, outputTokens: 100, cacheReadInputTokens: 800 } } }],
    });
    const detail = await port(store).readSnapshot({ window: "1h", includeRepair: false });
    expect(detail.summary.spend.partiallyPricedRequests).toBe(1);
    expect(detail.summary.spend.providerPublishedReported.amountMicrousd).toBe(2_000);
    store.close();
  });

  it("applies the full tuple filters before panels and uses empty coverage for a complete no-match", async () => {
    const store = createAccountingStore({ rootDir: root() });
    record(store, {
      endedAt: "2026-08-20T12:30:00.000Z",
      client: "codex",
      attempts: [{ provider: "provider-a", model: "model-a", credentialId: "provider-a#one" }],
    });
    record(store, {
      endedAt: "2026-08-20T12:31:00.000Z",
      client: "claude",
      attribution: "caller_operated",
      outcome: "error",
      failureKind: "timeout",
      attempts: [{ attribution: "caller_operated", provider: "provider-b", model: "model-b", credentialId: "provider-b#two", outcome: "error", failureKind: "timeout" }],
    });
    record(store, {
      endedAt: "2026-08-20T12:32:00.000Z",
      client: "claude",
      attribution: "caller_operated",
      attempts: [{ attribution: "caller_operated", provider: "provider-b", model: "model-b", credentialId: "provider-b#two" }],
    });
    const read = port(store);
    const filtered = await read.readSnapshot({
      window: "1h",
      includeRepair: true,
      attribution: "caller-operated",
      provider: "provider-b",
      model: "model-b",
      client: "claude",
      credentialId: "provider-b#two",
      outcome: "success",
    });
    expect(filtered.summary.requests).toBe(1);
    expect(filtered.providers.map((row) => row.provider)).toEqual(["provider-b"]);
    const failures = await read.readSnapshot({ window: "1h", includeRepair: true, attribution: "caller-operated", client: "claude", outcome: "error", failureKind: "timeout" });
    expect(failures.errors).toEqual([{ failureKind: "timeout", outcome: "error", requests: 1 }]);
    const noMatch = await read.readSnapshot({ window: "1h", includeRepair: false, provider: "missing" });
    expect(noMatch.summary.requests).toBe(0);
    expect(noMatch.panelCoverage.find((coverage) => coverage.panel === "summary")?.state).toBe("empty");
    store.close();
  });

  it("returns unavailable coverage for missing/corrupt reads and safe null detail", async () => {
    const store = createAccountingStore({ rootDir: root() });
    const read = port(store);
    const snapshot = await read.readSnapshot({ window: "1h", includeRepair: false });
    expect(snapshot.panelCoverage.find((coverage) => coverage.panel === "summary")?.state).toBe("unavailable");
    expect(await read.readDetail({ requestId: "snapshot_request_00000000", includeRepair: false })).toBeNull();
    store.close();
  });

  it("does not turn a corrupt reader result into a zero/complete measurement", async () => {
    const corruptReader = {
      readDay: () => ({ status: "corrupt", value: null, error: "private path" }),
      readDays: (dates: readonly string[]) => ({
        status: "corrupt" as const,
        days: [],
        results: dates.map((date) => ({ date, result: { status: "corrupt" as const, value: null, error: "private path" } })),
        missingDates: [],
        corruptDates: [...dates],
        capped: false,
      }),
      readLifetime: () => ({ status: "corrupt" as const, value: null, error: "private path" }),
      readRecent: () => ({ status: "missing" as const, value: null }),
      readDetail: () => ({ status: "corrupt" as const, value: null, error: "private path" }),
    };
    const read = createDashboardSnapshotReadPort({ accounting: corruptReader as never, relayVersion: "test", now: () => "2026-08-20T12:34:56.000Z" });
    const snapshot = await read.readSnapshot({ window: "1h", includeRepair: false });
    expect(snapshot.summary.requests).toBe(0);
    expect(snapshot.panelCoverage.find((coverage) => coverage.panel === "summary")?.state).toBe("unavailable");
    expect(await read.readDetail({ requestId: "snapshot_request_00000000", includeRepair: false })).toBeNull();
  });

  it("does not combine cache creation/read into the one cached-input field", async () => {
    const store = createAccountingStore({ rootDir: root() });
    record(store, {
      endedAt: "2026-08-20T12:30:00.000Z",
      attempts: [
        {
          tokens: {
            reported: { inputTokens: 10, cachedInputTokens: 3, cacheCreationInputTokens: 5, cacheReadInputTokens: 7 },
            estimated: { inputTokens: 2, inputMethod: "chars/4" },
          },
        },
      ],
    });
    const snapshot = await port(store).readSnapshot({ window: "1h", includeRepair: false });
    expect(snapshot.summary.tokens.reported.reportedCachedInput.value).toBeNull();
    expect(snapshot.summary.tokens.estimated.estimatedInput.value).toBe(2);
    expect(snapshot.summary.spend.unpricedRequests).toBe(1);
    store.close();
  });

  it("keeps summary complete on an exact 0/0 cache split -- nothing was cached, not a figure the store lost", async () => {
    // Anthropic sends cache_creation/cache_read on essentially every response, often as
    // an exact 0/0 when nothing was cached that turn. `known > 0` alone used to treat
    // that as "a split was observed" and force the panel partial forever for any
    // Anthropic-served traffic (review fix, finding 3).
    const store = createAccountingStore({ rootDir: root() });
    record(store, {
      endedAt: "2026-08-20T12:30:00.000Z",
      attempts: [{ commitMs: 5, tokens: { reported: { inputTokens: 10, cachedInputTokens: 4, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } } }],
    });
    const snapshot = await port(store).readSnapshot({ window: "1h", includeRepair: false });
    expect(snapshot.summary.tokens.reported.reportedCachedInput.value).toBe(4);
    expect(snapshot.panelCoverage.find((entry) => entry.panel === "summary")?.state).toBe("complete");
    store.close();
  });

  it("keeps summary partial on a real nonzero cache split, forcing the one cached field null", async () => {
    const store = createAccountingStore({ rootDir: root() });
    record(store, {
      endedAt: "2026-08-20T12:30:00.000Z",
      attempts: [{ commitMs: 5, tokens: { reported: { inputTokens: 10, cachedInputTokens: 4, cacheCreationInputTokens: 12, cacheReadInputTokens: 0 } } }],
    });
    const snapshot = await port(store).readSnapshot({ window: "1h", includeRepair: false });
    expect(snapshot.summary.tokens.reported.reportedCachedInput.value).toBeNull();
    const coverage = snapshot.panelCoverage.find((entry) => entry.panel === "summary");
    expect(coverage?.state).toBe("partial");
    expect(coverage?.provenance).toContain("unknown");
    store.close();
  });

  it("keeps summary/token-timeline complete when a request simply never reports a cache token kind", async () => {
    // Coverage-semantics fix: `unknown > 0` alone (no `lost`/`overflow`) is measurement
    // incompleteness — a host that never sends a cache-token field — not data the store
    // held and lost. It nulls the one cell with provenance "unknown"; it must NOT
    // degrade the panel to "partial".
    const store = createAccountingStore({ rootDir: root() });
    record(store, {
      endedAt: "2026-08-20T12:30:00.000Z",
      attempts: [{ commitMs: 5, tokens: { reported: { inputTokens: 10, outputTokens: 4 } } }],
    });
    const snapshot = await port(store).readSnapshot({ window: "1h", includeRepair: false });
    expect(snapshot.summary.tokens.reported.reportedInput.value).toBe(10);
    expect(snapshot.summary.tokens.reported.reportedOutput.value).toBe(4);
    expect(snapshot.summary.tokens.reported.reportedCachedInput.value).toBeNull();
    const summaryCoverage = snapshot.panelCoverage.find((entry) => entry.panel === "summary");
    const timelineCoverage = snapshot.panelCoverage.find((entry) => entry.panel === "token_timeline");
    expect(summaryCoverage?.state).toBe("complete");
    expect(timelineCoverage?.state).toBe("complete");
    // The gap is still visible in provenance — it is just not spent as a coverage flag.
    expect(summaryCoverage?.provenance).toContain("unknown");
    store.close();
  });

  it("keeps summary complete when a request carries no reported usage at all (estimate only)", async () => {
    const store = createAccountingStore({ rootDir: root() });
    record(store, {
      endedAt: "2026-08-20T12:30:00.000Z",
      attempts: [{ commitMs: 5, tokens: { estimated: { inputTokens: 6, inputMethod: "chars/4" } } }],
    });
    const snapshot = await port(store).readSnapshot({ window: "1h", includeRepair: false });
    expect(snapshot.summary.tokens.reported.reportedInput.value).toBeNull();
    expect(snapshot.summary.tokens.reported.reportedOutput.value).toBeNull();
    expect(snapshot.summary.tokens.reported.reportedCachedInput.value).toBeNull();
    expect(snapshot.summary.tokens.estimated.estimatedInput.value).toBe(6);
    expect(snapshot.panelCoverage.find((entry) => entry.panel === "summary")?.state).toBe("complete");
    store.close();
  });

  it("keeps summary partial on a genuine token loss, unlike a plain unmeasured kind", async () => {
    const store = createAccountingStore({ rootDir: root() });
    record(store, {
      endedAt: "2026-08-20T12:30:00.000Z",
      attempts: [{ commitMs: 5, tokens: { reported: { inputTokens: 10, outputTokens: 4 } } }],
    });
    const dayResult = store.readDay("2026-08-20");
    expect(dayResult.status).toBe("ok");
    if (dayResult.status !== "ok") throw new Error("test setup day missing");
    const day = structuredClone(dayResult.value);
    const minuteKey = Object.keys(day.cells)[0];
    if (minuteKey === undefined) throw new Error("test setup minute missing");
    const cell = day.cells[minuteKey]!;
    // Simulate the store itself losing a count it once held (e.g. a counter drop),
    // as opposed to a host simply never reporting the kind.
    const alteredDay = {
      ...day,
      cells: {
        ...day.cells,
        [minuteKey]: {
          ...cell,
          aggregate: {
            ...cell.aggregate,
            requestTokens: {
              ...cell.aggregate.requestTokens,
              reported: {
                ...cell.aggregate.requestTokens.reported,
                reportedOutput: { ...cell.aggregate.requestTokens.reported.reportedOutput, value: null, lost: 1 },
              },
            },
          },
        },
      },
    };
    const base = store.reader();
    const reader = readerWithDays(base, [alteredDay], { "2026-08-20": "ok" });
    const snapshot = await createDashboardSnapshotReadPort({ accounting: reader, relayVersion: "test", now: () => "2026-08-20T12:34:56.000Z" }).readSnapshot({ window: "1h", includeRepair: false });
    expect(snapshot.panelCoverage.find((entry) => entry.panel === "summary")?.state).toBe("partial");
    store.close();
  });

  it("retains valid totals when a requested day is missing, still partial when corrupt, unavailable when all days are unusable", async () => {
    // `commitMs` is set explicitly so this fixture isolates the day-status question:
    // an omitted commitMs on a "success" request is its own (correct) unexpected-loss
    // signal via hasUnexpectedMetricLoss and would confound a missing/corrupt
    // comparison that is supposed to be about the day read alone (review fix, finding 1).
    const store = createAccountingStore({ rootDir: root() });
    record(store, { endedAt: "2026-08-20T12:29:00.000Z", attempts: [{ commitMs: 5, tokens: { reported: { inputTokens: 4 } } }] });
    const dayResult = store.readDay("2026-08-20");
    expect(dayResult.status).toBe("ok");
    if (dayResult.status !== "ok") throw new Error("test setup day missing");
    const base = store.reader();

    // A MISSING day is the normal state of a window reaching past the store's history
    // (a fresh install, a window wider than retention) -- the store never held it, so
    // nothing was omitted from this report.
    const missingReader = readerWithDays(base, [dayResult.value], { "2026-08-19": "missing", "2026-08-20": "ok" });
    const missingSnapshot = await createDashboardSnapshotReadPort({ accounting: missingReader, relayVersion: "test", now: () => "2026-08-20T12:34:56.000Z" }).readSnapshot({ window: "24h", includeRepair: false });
    expect(missingSnapshot.summary.requests).toBe(1);
    expect(missingSnapshot.panelCoverage.find((entry) => entry.panel === "summary")?.state).toBe("complete");

    // A CORRUPT day is real data the store held that this report cannot show.
    const corruptReader = readerWithDays(base, [dayResult.value], { "2026-08-19": "corrupt", "2026-08-20": "ok" });
    const corruptSnapshot = await createDashboardSnapshotReadPort({ accounting: corruptReader, relayVersion: "test", now: () => "2026-08-20T12:34:56.000Z" }).readSnapshot({ window: "24h", includeRepair: false });
    const corruptCoverage = corruptSnapshot.panelCoverage.find((entry) => entry.panel === "summary");
    expect(corruptSnapshot.summary.requests).toBe(1);
    expect(corruptCoverage?.state).toBe("partial");
    expect(corruptCoverage?.provenance).toContain("unknown");

    const unusable = readerWithDays(base, [], { "2026-08-19": "corrupt", "2026-08-20": "missing" });
    const unavailable = await createDashboardSnapshotReadPort({ accounting: unusable, relayVersion: "test", now: () => "2026-08-20T12:34:56.000Z" }).readSnapshot({ window: "24h", includeRepair: false });
    expect(unavailable.summary.requests).toBe(0);
    expect(unavailable.panelCoverage.find((entry) => entry.panel === "summary")?.state).toBe("unavailable");
    store.close();
  });

  it("keeps uncertain detail tokens null, stays partial from the genuine lost/overflow cells (not the plain-unknown one), and preserves provider evidence provenance", async () => {
    const store = createAccountingStore({ rootDir: root() });
    const id = record(store, {
      endedAt: "2026-08-20T12:30:00.000Z",
      attempts: [{ tokens: { reported: { inputTokens: 7, cacheCreationInputTokens: 2, cacheReadInputTokens: 3 } } }],
    });
    const result = store.readDetail(id);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("test setup detail missing");
    const sourcePacket = structuredClone(result.value);
    const alteredTokens = {
        ...sourcePacket.tokens,
        reported: {
          ...sourcePacket.tokens.reported,
          reportedInput: { ...sourcePacket.tokens.reported.reportedInput, value: null, unknown: 1 },
          reportedOutput: { ...sourcePacket.tokens.reported.reportedOutput, value: null, lost: 1 },
          reportedCachedInput: { ...sourcePacket.tokens.reported.reportedCachedInput, value: null, overflow: true },
        },
      };
    const packet = {
      ...sourcePacket,
      tokens: alteredTokens,
      attempts: sourcePacket.attempts.map((attempt, index) => index === 0 ? { ...attempt, tokens: alteredTokens } : attempt),
    };
    expect(isAccountingRequestPacketV1(packet)).toBe(true);
    const base = store.reader();
    const reader = {
      readDay: base.readDay.bind(base),
      readDays: base.readDays.bind(base),
      readLifetime: base.readLifetime.bind(base),
      readRecent: base.readRecent.bind(base),
      readDetail: () => ({ status: "ok" as const, value: packet }),
    } as unknown as AccountingReader;
    const detail = await createDashboardSnapshotReadPort({ accounting: reader, relayVersion: "test" }).readDetail({ requestId: id, includeRepair: false });
    expect(detail).not.toBeNull();
    expect(detail?.request.tokens.reported.reportedInput.value).toBeNull();
    expect(detail?.request.tokens.reported.reportedOutput.value).toBeNull();
    expect(detail?.request.tokens.reported.reportedCachedInput.value).toBeNull();
    const coverage = detail?.panelCoverage[0];
    expect(coverage?.state).toBe("partial");
    expect(coverage?.provenance).toEqual(expect.arrayContaining(["provider_reported", "unknown"]));
    store.close();
  });

  it("flags a successful request with no commit measurement as partial in its own detail, matching the summary panel", async () => {
    // requestRow() must run the same unexpected-metric-loss check summaryFrom() applies
    // via finalizeHealth (hasUnexpectedMetricLoss), or the detail panel and the summary
    // panel disagree about the identical request (review fix, finding 2): before the
    // fix this request's own detail read "complete" while the summary panel over the
    // same request already read "partial".
    const store = createAccountingStore({ rootDir: root() });
    const id = record(store, {
      endedAt: "2026-08-20T12:30:00.000Z",
      attempts: [{ tokens: { reported: { inputTokens: 10, outputTokens: 4 } } }],
    });
    const detail = await port(store).readDetail({ requestId: id, includeRepair: false });
    expect(detail).not.toBeNull();
    expect(detail?.panelCoverage[0]?.state).toBe("partial");
    const snapshot = await port(store).readSnapshot({ window: "1h", includeRepair: false });
    expect(snapshot.panelCoverage.find((entry) => entry.panel === "summary")?.state).toBe("partial");
    store.close();
  });

  it("never fabricates retentionTo from a future or rollback retention cursor", async () => {
    const store = createAccountingStore({ rootDir: root() });
    record(store, { endedAt: "2026-08-20T12:29:00.000Z", attempts: [{}] });
    const dayResult = store.readDay("2026-08-20");
    expect(dayResult.status).toBe("ok");
    if (dayResult.status !== "ok") throw new Error("test setup day missing");
    const base = store.reader();
    for (const cursor of ["2026-08-21", "2026-08-19"]) {
      const day = { ...structuredClone(dayResult.value), coverage: { ...dayResult.value.coverage, retentionFrom: cursor } };
      const reader = readerWithDays(base, [day], { "2026-08-20": "ok" });
      const snapshot = await createDashboardSnapshotReadPort({ accounting: reader, relayVersion: "test", now: () => "2026-08-20T12:34:56.000Z" }).readSnapshot({ window: "1h", includeRepair: false });
      expect(snapshot.retentionTo).toBeNull();
    }
    store.close();
  });

  it("caps and filters injected availability snapshots without probing", async () => {
    const store = createAccountingStore({ rootDir: root() });
    let calls = 0;
    const quota: QuotaRowV1 = {
      credentialId: "openai#primary",
      label: "primary",
      provider: "openai",
      deployment: null,
      axis: "requests",
      period: "minute",
      limit: 100,
      remaining: 99,
      localUsed: 1,
      resetsAt: "2026-08-20T13:00:00.000Z",
      observedAt: "2026-08-20T12:30:00.000Z",
      limitBasis: "provider_stated",
      remainingBasis: "provider_stated",
      localUsedBasis: "reported",
      resetsAtBasis: null,
    };
    const cooldown: CooldownRowV1 = {
      credentialId: "openai#primary",
      provider: "openai",
      deployment: null,
      reason: "rate_limit",
      until: "2026-08-20T13:00:00.000Z",
      observedAt: "2026-08-20T12:30:00.000Z",
    };
    const availability = { quotas: [quota], cooldowns: [cooldown] };
    const read = createDashboardSnapshotReadPort({
      accounting: store,
      relayVersion: "test",
      now: () => "2026-08-20T12:34:56.000Z",
      availability: () => {
        calls += 1;
        return availability;
      },
    });
    const snapshot = await read.readSnapshot({ window: "1h", includeRepair: false, provider: "openai" });
    expect(calls).toBe(1);
    expect(snapshot.quotas).toEqual([quota]);
    expect(snapshot.cooldowns).toEqual([cooldown]);
    expect(snapshot.panelCoverage.find((coverage) => coverage.panel === "quotas")?.state).toBe("complete");
    availability.quotas[0]!.remaining = 0;
    expect(snapshot.quotas[0]?.remaining).toBe(99);
    await read.readDetail({ requestId: "snapshot_request_00000000", includeRepair: false });
    expect(calls).toBe(1);
    store.close();
  });

  it("caps availability before output ordering and marks the truncation partial", async () => {
    const store = createAccountingStore({ rootDir: root() });
    const quotas: QuotaRowV1[] = Array.from({ length: 101 }, (_, index) => ({
      credentialId: `provider#${index.toString().padStart(3, "0")}`,
      label: index.toString().padStart(3, "0"),
      provider: "provider",
      deployment: null,
      axis: "requests",
      period: "minute",
      limit: null,
      remaining: null,
      localUsed: null,
      resetsAt: null,
      observedAt: null,
      limitBasis: null,
      remainingBasis: null,
      localUsedBasis: null,
      resetsAtBasis: null,
    }));
    const snapshot = await createDashboardSnapshotReadPort({
      accounting: store,
      relayVersion: "test",
      now: () => "2026-08-20T12:34:56.000Z",
      availability: { quotas },
    }).readSnapshot({ window: "1h", includeRepair: false, provider: "provider" });
    expect(snapshot.quotas).toHaveLength(100);
    expect(snapshot.quotas[0]?.credentialId).toBe("provider#000");
    expect(snapshot.quotas.at(-1)?.credentialId).toBe("provider#099");
    expect(snapshot.panelCoverage.find((coverage) => coverage.panel === "quotas")?.state).toBe("partial");
    store.close();
  });

  it("filters availability before the bounded output cap", async () => {
    const store = createAccountingStore({ rootDir: root() });
    const makeQuota = (provider: string, index: number): QuotaRowV1 => ({
      credentialId: `${provider}#${index.toString().padStart(3, "0")}`,
      label: index.toString().padStart(3, "0"),
      provider,
      deployment: null,
      axis: "requests",
      period: "minute",
      limit: null,
      remaining: null,
      localUsed: null,
      resetsAt: null,
      observedAt: null,
      limitBasis: null,
      remainingBasis: null,
      localUsedBasis: null,
      resetsAtBasis: null,
    });
    const makeCooldown = (provider: string, index: number): CooldownRowV1 => ({
      credentialId: `${provider}#${index.toString().padStart(3, "0")}`,
      provider,
      deployment: null,
      reason: "rate_limit",
      until: null,
      observedAt: null,
    });
    const quotas = [...Array.from({ length: 101 }, (_, index) => makeQuota("other", index)), makeQuota("target", 0)];
    const cooldowns = [...Array.from({ length: 101 }, (_, index) => makeCooldown("other", index)), makeCooldown("target", 0)];
    const snapshot = await createDashboardSnapshotReadPort({
      accounting: store,
      relayVersion: "test",
      now: () => "2026-08-20T12:34:56.000Z",
      availability: { quotas, cooldowns },
    }).readSnapshot({ window: "1h", includeRepair: false, provider: "target" });
    expect(snapshot.quotas.map((row) => row.provider)).toEqual(["target"]);
    expect(snapshot.cooldowns.map((row) => row.provider)).toEqual(["target"]);
    expect(snapshot.panelCoverage.find((coverage) => coverage.panel === "quotas")?.state).toBe("complete");
    expect(snapshot.panelCoverage.find((coverage) => coverage.panel === "cooldowns")?.state).toBe("complete");
    store.close();
  });

  it("suppresses p95 when the bounded source sample has dropped observations", async () => {
    const store = createAccountingStore({ rootDir: root() });
    for (let index = 0; index < 26; index += 1) {
      record(store, {
        endedAt: "2026-08-20T12:30:00.000Z",
        latencyMs: index + 1,
        attempts: [{ tokens: { reported: { inputTokens: 1 } } }],
      });
    }
    const snapshot = await port(store).readSnapshot({ window: "1h", includeRepair: false });
    expect(snapshot.summary.p95LatencyMs).toBeNull();
    expect(snapshot.panelCoverage.find((coverage) => coverage.panel === "latency")?.state).toBe("partial");
    store.close();
  });

  it("keeps root totals truthful when compound dimension rows hit their cap", async () => {
    const store = createAccountingStore({ rootDir: root() });
    for (let index = 0; index < 257; index += 1) {
      record(store, {
        endedAt: "2026-08-20T12:30:00.000Z",
        attempts: [{ provider: `provider-${index}`, model: "model", credentialId: `provider-${index}#primary`, tokens: { reported: { inputTokens: 1 } } }],
      });
    }
    const snapshot = await port(store).readSnapshot({ window: "1h", includeRepair: true });
    expect(snapshot.summary.requests).toBe(257);
    expect(snapshot.summary.attempts).toBe(257);
    expect(snapshot.providers).toHaveLength(100);
    expect(snapshot.panelCoverage.find((coverage) => coverage.panel === "provider")?.state).toBe("partial");
    store.close();
  });

  it("uses bounded lifetime month rollups without day reads", async () => {
    const store = createAccountingStore({ rootDir: root() });
    record(store, { endedAt: "2026-07-01T12:00:00.000Z", attempts: [{ tokens: { reported: { inputTokens: 3 } } }] });
    record(store, { endedAt: "2026-08-01T12:00:00.000Z", attempts: [{ tokens: { reported: { inputTokens: 4 } } }] });
    const reader = store.reader();
    const snapshot = await createDashboardSnapshotReadPort({ accounting: reader, relayVersion: "test", now: () => "2026-08-20T12:00:00.000Z" }).readSnapshot({ window: "lifetime", includeRepair: true });
    expect(snapshot.buckets).toHaveLength(2);
    expect(snapshot.buckets.map((bucket) => bucket.from)).toEqual(["2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"]);
    expect(snapshot.summary.requests).toBe(2);
    expect(snapshot.panelCoverage.find((coverage) => coverage.panel === "provider")?.state).toBe("unavailable");
    const excludedRepair = await createDashboardSnapshotReadPort({ accounting: reader, relayVersion: "test", now: () => "2026-08-20T12:00:00.000Z" }).readSnapshot({ window: "lifetime", includeRepair: false });
    expect(excludedRepair.summary.requests).toBe(2);
    expect(excludedRepair.summary.attempts).toBe(0);
    expect(excludedRepair.panelCoverage.find((coverage) => coverage.panel === "summary")?.state).toBe("unavailable");
    const filtered = await createDashboardSnapshotReadPort({ accounting: reader, relayVersion: "test", now: () => "2026-08-20T12:00:00.000Z" }).readSnapshot({ window: "lifetime", includeRepair: true, provider: "openai" });
    expect(filtered.summary.requests).toBe(0);
    expect(filtered.panelCoverage.find((coverage) => coverage.panel === "summary")?.state).toBe("unavailable");
    store.close();
  });

  it("cost roll-up reports a THROWING day read as unavailable, never as an empty window", async () => {
    // readCostDays' catch used to report every date as merely absent, which the
    // all-shards-absent rule then rendered as coverage "empty" — a hard read failure
    // (a denied directory, a diagnostic fault) answering "No accounting data yet".
    const store = createAccountingStore({ rootDir: root() });
    const base = store.reader();
    const throwing = {
      readDay: (date: string) => base.readDay(date),
      readDays: (() => {
        throw new Error("denied");
      }) as typeof base.readDays,
      readLifetime: () => base.readLifetime(),
      readRecent: (options?: { readonly limit?: number } | number) => base.readRecent(options),
      readDetail: (requestId: string) => base.readDetail(requestId),
    };
    const port = createDashboardSnapshotReadPort({ accounting: throwing, relayVersion: "test", now: () => "2026-08-20T12:34:56.000Z" });
    const report = await port.readCostReport({ window: "24h", includeRepair: false });
    expect(report.coverage).toBe("unavailable");
    expect(report.coverageReason).toBe("meter_not_implemented");
    // No fabricated zero-total success either.
    expect(report.rows).toHaveLength(0);
    expect(report.total.requests).toBe(0);
    store.close();
  });

  it("cost roll-up treats a MISSING lifetime.json as empty and a corrupt one as unavailable", async () => {
    // Read-only stores throughout: that is exactly how `llm-relay cost` reads, and they
    // never quarantine, so the corrupt file stays put while being reported.
    const emptyStore = createAccountingStore({ rootDir: root(), readOnly: true });
    const empty = await createDashboardSnapshotReadPort({ accounting: emptyStore.reader(), relayVersion: "test", now: () => "2026-08-20T12:34:56.000Z" }).readCostReport({ window: "lifetime", includeRepair: false });
    expect(empty.coverage).toBe("empty");
    expect(empty.from).toBeNull();
    emptyStore.close();

    const corruptDir = mkdtempSync(join(tmpdir(), "llm-relay-dashboard-snapshot-corrupt-"));
    writeFileSync(join(corruptDir, "lifetime.json"), "{not json");
    const corruptStore = createAccountingStore({ rootDir: corruptDir, readOnly: true });
    const corrupt = await createDashboardSnapshotReadPort({ accounting: corruptStore.reader(), relayVersion: "test", now: () => "2026-08-20T12:34:56.000Z" }).readCostReport({ window: "lifetime", includeRepair: false });
    expect(corrupt.coverage).toBe("unavailable");
    corruptStore.close();
    rmSync(corruptDir, { recursive: true, force: true });
  });
});

describe("availability port - server-shaped construction", () => {
  it("yields non-empty quotas and cooldowns that pass the contract guards", async () => {
    const store = createAccountingStore({ rootDir: root() });
    const quota: QuotaRowV1 = {
      credentialId: "openai#primary",
      label: "primary",
      provider: "openai",
      deployment: null,
      axis: "requests",
      period: "minute",
      limit: 60,
      remaining: 40,
      localUsed: null,
      resetsAt: "2026-08-20T13:00:00.000Z",
      observedAt: "2026-08-20T12:30:00.000Z",
      limitBasis: "provider_stated",
      remainingBasis: "provider_stated",
      localUsedBasis: null,
      resetsAtBasis: null,
    };
    const cooldown: CooldownRowV1 = {
      credentialId: "openai#primary",
      provider: "openai",
      deployment: null,
      reason: "rate_limit",
      until: "2026-08-20T13:00:00.000Z",
      observedAt: "2026-08-20T12:30:00.000Z",
    };
    const snapshot = await createDashboardSnapshotReadPort({
      accounting: store,
      relayVersion: "test",
      now: () => "2026-08-20T12:34:56.000Z",
      // The shape the server's createAvailabilityProducer returns - an object with a snapshot().
      availability: { snapshot: () => ({ quotas: [quota], cooldowns: [cooldown] }) },
    }).readSnapshot({ window: "1h", includeRepair: false });
    expect(snapshot.quotas).toHaveLength(1);
    expect(snapshot.cooldowns).toHaveLength(1);
    expect(isSnapshotV1(snapshot)).toBe(true);
    store.close();
  });

  it("keeps an OVERSHOT quota row through the projection instead of dropping it as partial", async () => {
    // Rung 2 reports limit − localUsed UNCLAMPED; the contract's remaining guard must accept the
    // negative or the one state worth seeing never reaches the SPA (only an anonymous partial
    // flag would survive). Renderers clamp headroom to 0 and show the raw number as-is.
    const store = createAccountingStore({ rootDir: root() });
    const overshot: QuotaRowV1 = {
      credentialId: "openai#primary",
      label: "primary",
      provider: "openai",
      deployment: null,
      axis: "requests",
      period: "minute",
      limit: 60,
      remaining: -15,
      localUsed: 75,
      resetsAt: "2026-08-20T13:00:00.000Z",
      observedAt: null,
      limitBasis: "provider_stated",
      remainingBasis: "derived_provider_stated",
      localUsedBasis: "reported",
      resetsAtBasis: null,
    };
    const snapshot = await createDashboardSnapshotReadPort({
      accounting: store,
      relayVersion: "test",
      now: () => "2026-08-20T12:34:56.000Z",
      availability: { snapshot: () => ({ quotas: [overshot], cooldowns: [] }) },
    }).readSnapshot({ window: "1h", includeRepair: false });
    expect(snapshot.quotas).toEqual([overshot]);
    expect(snapshot.panelCoverage.find((coverage) => coverage.panel === "quotas")?.state).toBe("complete");
    expect(isSnapshotV1(snapshot)).toBe(true);
    store.close();
  });
});
