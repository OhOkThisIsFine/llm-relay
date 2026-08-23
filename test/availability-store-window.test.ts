/**
 * The availability lane's in-memory window read: minute/day/month scoping, credential and model
 * narrowing, reported/estimated/mixed basis, and the never-claim-unattributable rule.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAccountingRequest,
  type AccountingRecorder,
  type TokenFactsInput,
} from "../src/accounting.js";
import { createAccountingStore, type AccountingStore } from "../src/accounting-store.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "llm-relay-used-in-window-"));
}

let requestSequence = 0;
let attemptSequence = 0;

function requestId(): string {
  return `request-${(++requestSequence).toString().padStart(16, "0")}`;
}

function attemptId(): string {
  return `attempt-${(++attemptSequence).toString().padStart(12, "0")}`;
}

interface Plan {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome?: "success" | "error" | "cancelled" | "unknown";
  readonly provider?: string;
  readonly model?: string;
  readonly credentialId?: string;
  readonly tokens?: TokenFactsInput;
}

/** Record one terminal request with one serve attempt through the store's event pipeline. */
function record(store: AccountingStore, plan: Plan): void {
  const recorder: AccountingRecorder = { record(event) { store.record(event); } };
  const request = createAccountingRequest({
    recorder,
    idFactory: attemptId,
    requestId: requestId(),
    startedAt: plan.startedAt,
    client: "claude",
    attribution: "relay_held",
  });
  const attempt = request.startAttempt({
    role: "serve",
    startedAt: plan.startedAt,
    attribution: "relay_held",
    provider: plan.provider ?? null,
    model: plan.model ?? null,
    credentialId: plan.credentialId ?? null,
  });
  attempt.complete({
    outcome: plan.outcome ?? "success",
    endedAt: plan.endedAt,
    latencyMs: 10,
    ...(plan.tokens === undefined ? {} : { tokens: plan.tokens }),
  });
  const terminal = request.complete({ endedAt: plan.endedAt });
  if (terminal === undefined) throw new Error("request completion was unexpectedly absent");
}

// 2026-08-22T12:34:56Z.
const NOW = Date.UTC(2026, 7, 22, 12, 34, 56);
const NOW_ISO = "2026-08-22T12:34:56.000Z";
const EARLIER_MINUTE_ISO = "2026-08-22T12:31:00.000Z";
const YESTERDAY_ISO = "2026-08-21T23:59:59.000Z";

const REPORTED: TokenFactsInput = { reported: { inputTokens: 100, outputTokens: 40 } };
const ESTIMATED: TokenFactsInput = { estimated: { inputTokens: 50, outputTokens: 25 } };

describe("usedInWindow", () => {
  it("returns nulls when nothing is recorded — never zeros", () => {
    const store = createAccountingStore({ directory: root() });
    expect(store.usedInWindow({ credentialId: "nim#a", period: "minute", now: NOW })).toEqual({ requests: null, tokens: null, basis: null });
    expect(store.usedInWindow({ credentialId: "nim#a", period: "day", now: NOW })).toEqual({ requests: null, tokens: null, basis: null });
    expect(store.usedInWindow({ credentialId: "nim#a", period: "month", now: NOW })).toEqual({ requests: null, tokens: null, basis: null });
    store.close();
  });

  it("scopes minute to the current UTC minute and excludes earlier traffic and yesterday", () => {
    const store = createAccountingStore({ directory: root() });
    record(store, { startedAt: EARLIER_MINUTE_ISO, endedAt: EARLIER_MINUTE_ISO, provider: "nim", credentialId: "nim#a", model: "m-a" });
    record(store, { startedAt: YESTERDAY_ISO, endedAt: YESTERDAY_ISO, provider: "nim", credentialId: "nim#a", model: "m-a" });
    expect(store.usedInWindow({ credentialId: "nim#a", period: "minute", now: NOW })).toEqual({ requests: null, tokens: null, basis: null });
    // But the DAY window sees both.
    // The DAY window is the current UTC DAY, so yesterday's 23:59:59 request is out of it too.
    expect(store.usedInWindow({ credentialId: "nim#a", period: "day", now: NOW }).requests).toBe(1);
    store.close();
  });

  it("narrows by credential and by model", () => {
    const store = createAccountingStore({ directory: root() });
    record(store, { startedAt: NOW_ISO, endedAt: NOW_ISO, provider: "nim", credentialId: "nim#a", model: "m-a", tokens: REPORTED });
    record(store, { startedAt: NOW_ISO, endedAt: NOW_ISO, provider: "nim", credentialId: "nim#b", model: "m-a" });
    record(store, { startedAt: NOW_ISO, endedAt: NOW_ISO, provider: "nim", credentialId: "nim#a", model: "m-z", tokens: REPORTED });

    const a = store.usedInWindow({ credentialId: "nim#a", period: "minute", now: NOW });
    expect(a.requests).toBe(2);
    expect(a.tokens).toBe(280); // two rows x (100 in + 40 out); nim#b contributes nothing
    expect(a.basis).toBe("reported");

    const aOnlyModelA = store.usedInWindow({ credentialId: "nim#a", model: "m-a", period: "minute", now: NOW });
    expect(aOnlyModelA.requests).toBe(1);
    expect(aOnlyModelA.tokens).toBe(140);
    store.close();
  });

  it("reports estimated when only estimates exist, mixed when both bases appear on different rows", () => {
    const store = createAccountingStore({ directory: root() });
    record(store, { startedAt: NOW_ISO, endedAt: NOW_ISO, provider: "nim", credentialId: "nim#est", model: "m-a", tokens: ESTIMATED });
    expect(store.usedInWindow({ credentialId: "nim#est", period: "minute", now: NOW })).toMatchObject({ tokens: 75, basis: "estimated" });

    // Two rows, two bases: the reported figure alone would understate by the estimated-only row,
    // and summing would blend measurement bases into one scalar — so NO number is reported.
    record(store, { startedAt: NOW_ISO, endedAt: NOW_ISO, provider: "nim", credentialId: "nim#mix", model: "m-a", tokens: REPORTED });
    record(store, { startedAt: NOW_ISO, endedAt: NOW_ISO, provider: "nim", credentialId: "nim#mix", model: "m-b", tokens: ESTIMATED });
    const mixed = store.usedInWindow({ credentialId: "nim#mix", period: "minute", now: NOW });
    expect(mixed.basis).toBe("mixed");
    expect(mixed.tokens).toBeNull(); // the mix is named; the number is not invented
    expect(mixed.requests).toBe(2);
    store.close();
  });

  it("keeps the reported figure when both bases exist but only on the SAME requests", () => {
    // One request whose input was reported and output only estimated: every measured request DID
    // carry a report, so the reported half stands alone as a true (narrower) measurement.
    const store = createAccountingStore({ directory: root() });
    record(store, {
      startedAt: NOW_ISO,
      endedAt: NOW_ISO,
      provider: "nim",
      credentialId: "nim#half",
      model: "m-a",
      tokens: { reported: { inputTokens: 100 }, estimated: { outputTokens: 25 } },
    });
    expect(store.usedInWindow({ credentialId: "nim#half", period: "minute", now: NOW })).toEqual({ requests: 1, tokens: 100, basis: "reported" });
    store.close();
  });

  it("declines BOTH figures at month until the lifetime rollup is per-credential", () => {
    const store = createAccountingStore({ directory: root() });
    record(store, { startedAt: NOW_ISO, endedAt: NOW_ISO, provider: "nim", credentialId: "nim#a", model: "m-a", tokens: REPORTED });
    record(store, { startedAt: NOW_ISO, endedAt: NOW_ISO, provider: "other", credentialId: "other#x", model: "m-x", tokens: REPORTED });
    const month = store.usedInWindow({ credentialId: "nim#a", period: "month", now: NOW });
    // The lifetime month rollup is ROOT-aggregate across all credentials. Returning it on a
    // per-slot row would subtract every key's traffic from this one slot's ceiling; the wire row
    // has no scope marker a reader could check, so neither figure is claimed.
    expect(month.requests).toBeNull();
    expect(month.tokens).toBeNull();
    expect(month.basis).toBeNull();
    store.close();
  });

  it("sees unflushed in-memory events and answers nothing for another day", () => {
    const store = createAccountingStore({ directory: root() });
    record(store, { startedAt: NOW_ISO, endedAt: NOW_ISO, provider: "nim", credentialId: "nim#a", model: "m-a" });
    // No flush(): the event sits in memory behind write-behind, and must still be visible.
    expect(store.usedInWindow({ credentialId: "nim#a", period: "day", now: NOW }).requests).toBe(1);
    expect(store.usedInWindow({ credentialId: "nim#a", period: "day", now: Date.UTC(2026, 7, 21) }).requests).toBeNull();
    store.close();
  });
});
