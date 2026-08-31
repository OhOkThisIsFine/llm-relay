import { describe, expect, it } from "vitest";
import { makeCredentialId, type CredentialId } from "../src/credential-id.js";
import { implicitCredentialSlot, type CredentialSlot } from "../src/credential-fleet.js";
import { CredentialLru, CredentialWalk, groupCredentialAttempts, rankCredentialAttempts, type CredentialFact } from "../src/credential-select.js";
import type { ResolvedAttempt } from "../src/resolved-attempt.js";

const present = { state: "declared-present" as const, value: "secret", envName: "KEY", source: "env" as const };
const missing = { state: "declared-missing" as const, value: undefined, envName: "KEY", source: undefined };

function attempt(provider: string, model: string, label = "default", opts: { missing?: boolean; base?: string; configIndex?: number } = {}): ResolvedAttempt {
  const implicit = implicitCredentialSlot(provider, "KEY");
  const slot: CredentialSlot = Object.freeze({
    ...implicit,
    credentialId: makeCredentialId(provider, label),
    label,
    configIndex: opts.configIndex ?? 0,
  });
  return Object.freeze({
    target: {
      provider,
      base: opts.base ?? `https://${provider}.test`,
      kind: "openai" as const,
      model,
      authHeader: "authorization" as const,
      timeoutMs: 1000,
    },
    credentialId: slot.credentialId,
    credential: opts.missing ? missing : present,
    slot,
  });
}

function facts(...items: Array<{ kind: string; scope: CredentialFact["scope"] }>): CredentialFact[] {
  return items;
}

describe("credential selection", () => {
  it("excludes disabled, model-scoped-out and missing-secret slots", () => {
    const disabledBase = attempt("p", "m", "disabled");
    const disabled = Object.freeze({ ...disabledBase, slot: Object.freeze({ ...disabledBase.slot, enabled: false }) });
    const out = attempt("p", "m", "out");
    const noKey = attempt("p", "m", "missing", { missing: true });
    const enabledOut = Object.freeze({ ...out, slot: Object.freeze({ ...out.slot, models: ["other"] }) });
    const ranked = rankCredentialAttempts([disabled, enabledOut, noKey, attempt("p", "m", "good")]);
    expect(ranked.map((x) => x.credentialId)).toEqual(["p#good"]);
  });

  it("uses survivor fallback when every slot has a learned hard fact", () => {
    const a = attempt("p", "m", "a");
    const b = attempt("p", "m", "b");
    const evidence = new Map<CredentialId, { facts: CredentialFact[] }>([
      [a.credentialId, { facts: facts({ kind: "not-servable", scope: { kind: "credential", provider: "p", credentialId: a.credentialId } }) }],
      [b.credentialId, { facts: facts({ kind: "subscription-required", scope: { kind: "credential", provider: "p", credentialId: b.credentialId } }) }],
    ]);
    expect(rankCredentialAttempts([a, b], new CredentialLru(), { evidence }).map((x) => x.credentialId)).toEqual(["p#a", "p#b"]);
  });

  it("keeps first-seen deployment order and applies survivor fallback per deployment", () => {
    const a1 = attempt("a", "m", "one");
    const a2 = attempt("a", "m", "two", { configIndex: 1 });
    const b1 = attempt("b", "m", "one", { configIndex: 0 });
    const evidence = new Map<CredentialId, { facts?: CredentialFact[]; cost?: "free" | "paid" | "unknown" }>([
      [a1.credentialId, { facts: facts({ kind: "not-servable", scope: { kind: "credential", provider: "a", credentialId: a1.credentialId } }) }],
      [a2.credentialId, { facts: facts({ kind: "subscription-required", scope: { kind: "credential", provider: "a", credentialId: a2.credentialId } }) }],
      [b1.credentialId, { cost: "free" }],
    ]);
    // B is cheaper, but A was the first deployment and its learned-fact fallback is local to A.
    expect(rankCredentialAttempts([a1, b1, a2], new CredentialLru(), { evidence }).map((x) => x.credentialId)).toEqual([
      "a#one", "a#two", "b#one",
    ]);
  });

  it("never turns an all-missing fleet into an egress attempt", () => {
    expect(rankCredentialAttempts([attempt("p", "m", "a", { missing: true })])).toEqual([]);
  });

  it("orders fresh quota by minimum typed headroom and leaves stale observations neutral", () => {
    const ample = attempt("p", "m", "ample");
    const tight = attempt("p", "m", "tight");
    const spent = attempt("p", "m", "spent");
    const stale = attempt("p", "m", "stale");
    const now = 100_000;
    const quota = (remaining: number, observedAt = now) => [{ axis: "requests" as const, period: "minute" as const, limit: 100, remaining, resetsAt: null, observedAt, basis: "provider-stated" as const }];
    const evidence = new Map([
      [ample.credentialId, { quota: quota(90) }],
      [tight.credentialId, { quota: quota(5) }],
      [spent.credentialId, { quota: quota(0) }],
      [stale.credentialId, { quota: quota(1, now - 600_001) }],
    ]);
    expect(rankCredentialAttempts([tight, stale, spent, ample], new CredentialLru(), { evidence, now }).map((x) => x.credentialId)).toEqual([
      "p#ample", "p#stale", "p#tight", "p#spent",
    ]);
  });

  it("declines a minute-period observation from the previous minute even within freshness window", () => {
    const prevMinute = attempt("p", "m", "prev-minute");
    const currentMinute = attempt("p", "m", "current-minute");
    // now = 120_100 (2 minutes + 100ms). Current minute window: [120_000, 180_000)
    // Previous minute window: [60_000, 120_000)
    // observedAt = 119_000 (in previous minute, but only 1_100 ms ago = within 5 min freshness)
    // observedAt = 120_050 (in current minute, just inside)
    const now = 120_100;
    const freshnessMs = 5 * 60_000;
    const quota = (label: string, observedAt: number) => [{ axis: "requests" as const, period: "minute" as const, limit: 100, remaining: 50, resetsAt: null, observedAt, basis: "provider-stated" as const }];
    const evidence = new Map([
      [prevMinute.credentialId, { quota: quota("prev", 119_000) }], // previous minute
      [currentMinute.credentialId, { quota: quota("current", 120_050) }], // current minute (just inside)
    ]);
    // prev-minute should be declined (band=1 neutral), current-minute should rank (band=0 ample)
    expect(rankCredentialAttempts([prevMinute, currentMinute], new CredentialLru(), { evidence, now, quotaFreshnessMs: freshnessMs }).map((x) => x.credentialId)).toEqual([
      "p#current-minute", "p#prev-minute",
    ]);
  });

  it("ranks a minute-period observation inside the current minute", () => {
    const early = attempt("p", "m", "early");
    const late = attempt("p", "m", "late");
    // now = 100_000. Current minute window: [60_000, 120_000)
    const now = 100_000;
    const quota = (observedAt: number) => [{ axis: "requests" as const, period: "minute" as const, limit: 100, remaining: 50, resetsAt: null, observedAt, basis: "provider-stated" as const }];
    const evidence = new Map([
      [early.credentialId, { quota: quota(60_500) }], // early in current minute
      [late.credentialId, { quota: quota(119_900) }], // late in current minute
    ]);
    // Both should rank (band=0 ample), tie-broken by configIndex
    expect(rankCredentialAttempts([early, late], new CredentialLru(), { evidence, now }).map((x) => x.credentialId)).toEqual([
      "p#early", "p#late",
    ]);
  });

  it("ranks an unknown-period observation with a future resetsAt (v0.53.0 regression pin)", () => {
    const unknownPeriod = attempt("p", "m", "unknown-period");
    const noQuota = attempt("p", "m", "no-quota");
    const now = 100_000;
    const futureReset = now + 60_000; // 1 minute in future
    const evidence = new Map([
      [unknownPeriod.credentialId, { quota: [{ axis: "requests" as const, period: "unknown" as const, limit: 100, remaining: 50, resetsAt: futureReset, observedAt: now, basis: "provider-stated" as const }] }],
      [noQuota.credentialId, {}],
    ]);
    // unknown-period with future resetsAt should still rank (band=0 ample)
    expect(rankCredentialAttempts([noQuota, unknownPeriod], new CredentialLru(), { evidence, now }).map((x) => x.credentialId)).toEqual([
      "p#unknown-period", "p#no-quota",
    ]);
  });

  it("treats an expired reset as stale and ties unknown pricing with paid", () => {
    const expired = attempt("p", "m", "expired", { configIndex: 0 });
    const paid = attempt("p", "m", "paid", { configIndex: 2 });
    const unknown = attempt("p", "m", "unknown", { configIndex: 1 });
    const evidence = new Map([
      [expired.credentialId, { quota: [{ axis: "requests" as const, period: "minute" as const, limit: 100, remaining: 90, resetsAt: 99, observedAt: 100, basis: "provider-stated" as const }] }],
      [paid.credentialId, { cost: "paid" as const }],
      [unknown.credentialId, { cost: "unknown" as const }],
    ]);
    expect(rankCredentialAttempts([unknown, paid, expired], new CredentialLru(), { evidence, now: 100 }).map((x) => x.credentialId)).toEqual([
      "p#expired", "p#unknown", "p#paid",
    ]);
  });

  it("uses deterministic LRU and config-index tie breaks without touching LRU", () => {
    const lru = new CredentialLru();
    const old = attempt("p", "m", "old", { configIndex: 1 });
    const never = attempt("p", "m", "never", { configIndex: 0 });
    const recent = attempt("p", "m", "recent", { configIndex: 2 });
    lru.touch(recent.credentialId);
    lru.touch(old.credentialId);
    expect(rankCredentialAttempts([recent, old, never], lru).map((x) => x.credentialId)).toEqual(["p#never", "p#recent", "p#old"]);
    expect(lru.lastUsed(never.credentialId)).toBeUndefined();
  });

  it("uses exact credential/model-cell evidence when one credential serves multiple models", () => {
    const m1c2 = attempt("p", "m1", "two");
    const m1c1 = attempt("p", "m1", "one");
    const m2c2 = attempt("p", "m2", "two");
    const m2c1 = attempt("p", "m2", "one");
    const evidenceFor = (candidate: ResolvedAttempt) => {
      const healthy = candidate.target.model === "m1" ? candidate.credentialId.endsWith("#one") : candidate.credentialId.endsWith("#two");
      return { health: healthy ? "healthy" as const : "unhealthy" as const };
    };
    expect(rankCredentialAttempts([m1c2, m1c1, m2c2, m2c1], new CredentialLru(), { evidenceFor }).map((x) => x.credentialId)).toEqual([
      "p#one", "p#two", "p#two", "p#one",
    ]);
  });
});

describe("CredentialWalk", () => {
  it("groups deployments while preserving first-seen ordering", () => {
    const a1 = attempt("a", "m", "one");
    const b1 = attempt("b", "m", "one");
    const a2 = attempt("a", "m", "two");
    expect(groupCredentialAttempts([a1, b1, a2]).map((g) => g.attempts.map((x) => x.credentialId))).toEqual([["a#one", "a#two"], ["b#one"]]);
  });

  it.each([401, 403, 402, 429])("unlocks next credential for generic %s", (status) => {
    const a1 = attempt("a", "m", "one");
    const a2 = attempt("a", "m", "two");
    const b1 = attempt("b", "m", "one");
    const walk = new CredentialWalk([a1, a2, b1], { walkBudgetMs: 0 });
    expect(walk.next()?.credentialId).toBe("a#one");
    walk.recordStarted(a1);
    walk.record(a1, { status });
    expect(walk.next()?.credentialId).toBe("b#one");
    walk.recordStarted(b1);
    walk.record(b1, { status: 503 });
    expect(walk.next()?.credentialId).toBe("a#two");
  });

  it.each([
    ["5xx", { status: 503 }],
    ["timeout", { kind: "timeout" as const }],
    ["protocol", { kind: "protocol" as const }],
    ["unknown", { kind: "unknown-refusal" as const }],
    ["deployment fact", { scope: { kind: "deployment" as const, provider: "a", model: "m" } }],
  ])("does not unlock sibling credential after %s", (_name, outcome) => {
    const a1 = attempt("a", "m", "one");
    const a2 = attempt("a", "m", "two");
    const b1 = attempt("b", "m", "one");
    const walk = new CredentialWalk([a1, a2, b1], { walkBudgetMs: 0 });
    expect(walk.next()).toBe(a1);
    walk.recordStarted(a1);
    walk.record(a1, outcome);
    expect(walk.next()).toBe(b1);
    walk.recordStarted(b1);
    walk.record(b1, { kind: "client" });
    expect(walk.next()).toBeUndefined();
  });

  it("suppresses accepted credential, group and provider scopes", () => {
    const a1 = attempt("a", "m1", "one");
    const a2 = attempt("a", "m2", "one");
    const a3 = attempt("a", "m3", "one");
    const b1 = attempt("b", "m1", "one");
    const walk = new CredentialWalk([a1, a2, a3, b1], { walkBudgetMs: 0 });
    expect(walk.next()).toBe(a1);
    walk.recordStarted(a1);
    walk.record(a1, { status: 401, scope: { kind: "credential", provider: "a", credentialId: a1.credentialId } });
    expect(walk.next()).toBe(b1); // a2/a3 are skipped by the credential-wide accepted fact.
    walk.recordStarted(b1);
    walk.record(b1, { kind: "provider-transport" });
    expect(walk.next()).toBeUndefined();
  });

  it("uses credential-bound group facts across member deployments but requeues the current deployment", () => {
    const first = attempt("a", "m1", "one");
    const firstBackup = attempt("a", "m1", "two");
    const memberOne = attempt("a", "m2", "one", { base: "https://a-member.test" });
    const memberTwo = attempt("a", "m2", "two", { base: "https://a-member.test" });
    const walk = new CredentialWalk([first, memberOne, firstBackup, memberTwo], { walkBudgetMs: 0 });
    expect(walk.next()).toBe(first);
    walk.recordStarted(first);
    walk.record(first, { status: 403, scope: { kind: "group", provider: "a", credentialId: first.credentialId, members: ["m1", "m2"] } });
    // Member deployment's credential one is suppressed, while credential two remains eligible.
    expect(walk.next()).toBe(memberTwo);
    walk.recordStarted(memberTwo);
    walk.record(memberTwo, { status: 503 });
    expect(walk.next()).toBe(firstBackup);
  });

  it("does not consume budget or LRU until recordStarted, and rejection consumes nothing", () => {
    let now = 10;
    const lru = new CredentialLru();
    const a = attempt("a", "m");
    const b = attempt("b", "m");
    const walk = new CredentialWalk([a, b], { lru, walkBudgetMs: 1, now: () => now });
    expect(walk.next()).toBe(a);
    expect(walk.stats.started).toBe(0);
    expect(lru.lastUsed(a.credentialId)).toBeUndefined();
    walk.recordRejected(a);
    now = 1000;
    expect(walk.next()).toBe(b);
    expect(walk.stats.started).toBe(0);
    walk.recordStarted(b);
    expect(walk.stats.started).toBe(1);
    expect(lru.lastUsed(b.credentialId)).toBe(1);
  });

  it("stops on local/client/cancelled outcomes and suppresses provider transport", () => {
    const a = attempt("a", "m");
    const b = attempt("b", "m");
    const local = new CredentialWalk([a, b], { walkBudgetMs: 0 });
    expect(local.next()).toBe(a);
    local.recordStarted(a);
    local.record(a, { kind: "local" });
    expect(local.next()).toBeUndefined();
    const transport = new CredentialWalk([a, b], { walkBudgetMs: 0 });
    expect(transport.next()).toBe(a);
    transport.recordStarted(a);
    transport.record(a, { kind: "provider-transport" });
    expect(transport.next()).toBe(b);
  });

  it("counts actual starts, starts its clock at first start, and guarantees two starts", () => {
    let now = 0;
    const a = attempt("a", "m");
    const b = attempt("b", "m");
    const c = attempt("c", "m");
    const walk = new CredentialWalk([a, b, c], { walkBudgetMs: 10, now: () => now });
    expect(walk.next()).toBe(a);
    walk.recordStarted(a);
    walk.record(a, { status: 503 });
    now = 100;
    expect(walk.next()).toBe(b); // second actual start is always allowed.
    walk.recordStarted(b);
    walk.record(b, { status: 503 });
    expect(walk.next()).toBeUndefined();
    expect(walk.stats).toEqual({ started: 2, skipped: 0, stopped: false });
  });

  it("does not count skipped candidates as starts", () => {
    const a = attempt("a", "m");
    const b = attempt("b", "m");
    const walk = new CredentialWalk([a, b], {
      walkBudgetMs: 1,
      suppressedFacts: [{ kind: "accepted", scope: { kind: "provider", provider: "a" } }],
    });
    expect(walk.next()).toBe(b);
    walk.recordStarted(b);
    expect(walk.stats.started).toBe(1);
    expect(walk.stats.skipped).toBe(1);
  });
});

/**
 * More than one attempt in flight — the prerequisite for hedging.
 *
 * ⚠ **`maxInFlight` defaults to 1, and at 1 every behaviour above must be byte-for-byte what it
 * was.** That is the load-bearing property of this whole change: the walk is "the sole budget/LRU
 * mutation boundary", so a regression here is a regression in every request the relay serves. The
 * existing suite above IS the guard for it, and it is deliberately left untouched.
 *
 * Two things blocked hedging before this, both found by attempting the wiring:
 *   1. `next()` re-offered the SAME pending attempt while one was in flight, so asking for a hedge
 *      candidate handed back the primary and would have fetched one deployment twice.
 *   2. `record(..., { kind: "cancelled" })` STOPS the walk — so retiring an aborted hedge loser
 *      through the ordinary path would have ended the request's walk entirely.
 */
describe("CredentialWalk — more than one attempt in flight", () => {
  it("still offers only one at a time by default", () => {
    // The regression guard, stated explicitly rather than left implicit in the suite above.
    const a = attempt("a", "m");
    const b = attempt("b", "m");
    const walk = new CredentialWalk([a, b]);
    const first = walk.next();
    expect(first).toBe(a);
    walk.recordStarted(a);
    expect(walk.next()).toBe(a); // re-offers the SAME pending attempt, exactly as before
  });

  it("offers a SECOND candidate while the first is still in flight when allowed", () => {
    const a = attempt("a", "m");
    const b = attempt("b", "m");
    const walk = new CredentialWalk([a, b], { maxInFlight: 2 });
    expect(walk.next()).toBe(a);
    walk.recordStarted(a);
    expect(walk.next()).toBe(b); // the hedge candidate, and it is NOT the primary
    walk.recordStarted(b);
    expect(walk.isPending(a)).toBe(true);
    expect(walk.isPending(b)).toBe(true);
    expect(walk.stats.started).toBe(2);
  });

  it("re-offers the oldest in-flight attempt once the cap is reached", () => {
    const a = attempt("a", "m");
    const b = attempt("b", "m");
    const c = attempt("c", "m");
    const walk = new CredentialWalk([a, b, c], { maxInFlight: 2 });
    walk.recordStarted(walk.next()!);
    walk.recordStarted(walk.next()!);
    expect(walk.next()).toBe(a); // saturated: same shape as the single-slot case at its cap
  });

  it("keys every lifecycle call by attempt, so the two cannot be confused", () => {
    const a = attempt("a", "m");
    const b = attempt("b", "m");
    const walk = new CredentialWalk([a, b], { maxInFlight: 2 });
    walk.recordStarted(walk.next()!);
    walk.recordStarted(walk.next()!);
    // Recording the SECOND one must not disturb the first.
    walk.record(b, { status: 503 });
    expect(walk.isPending(a)).toBe(true);
    expect(walk.isPending(b)).toBe(false);
    expect(() => walk.recordStarted(a)).toThrow(/already marked started/);
    expect(() => walk.record(b, { status: 503 })).toThrow(/does not match/);
  });

  it("ABANDONS a hedge loser without stopping the walk", () => {
    // The second blocker. A loser is aborted by the relay, not proven bad by the provider, so it
    // must not carry the terminal semantics `record` gives a cancellation — that would end the
    // walk for a request the hedge just rescued.
    const a = attempt("a", "m");
    const b = attempt("b", "m");
    const walk = new CredentialWalk([a, b], { maxInFlight: 2 });
    walk.recordStarted(walk.next()!);
    walk.recordStarted(walk.next()!);
    walk.recordAbandoned(a);
    expect(walk.isPending(a)).toBe(false);
    expect(walk.stats.stopped).toBe(false);
  });

  it("abandoning returns the deployment to the queue and suppresses nothing", () => {
    // An aborted attempt proved NOTHING about its deployment, so unlike `record` with a 401/429 it
    // must not suppress the credential or close the group. With a second slot on the same
    // deployment, that slot must still be reachable.
    //
    // ⚠ It releases the group by the walk's EXISTING rule, the same one `recordRejected` uses: the
    // cursor has already advanced past the offered slot, so a group with only one slot is closed.
    // Rewinding the cursor would be a different and riskier behaviour — an attempt could be
    // offered and abandoned indefinitely — and hedging does not need it, because the winner's
    // own `record` stops the walk anyway.
    const first = attempt("a", "m", "default");
    const second = attempt("a", "m", "second");
    const walk = new CredentialWalk([first, second], { maxInFlight: 2 });
    const offered = walk.next()!;
    walk.recordStarted(offered);
    walk.recordAbandoned(offered);
    expect(walk.stats.stopped).toBe(false);
    const after = walk.next();
    expect(after).toBeDefined();
    expect(after).not.toBe(offered); // the sibling slot, not a re-offer of the abandoned one
  });

  it("does not let abandoning launder a real outcome", () => {
    const a = attempt("a", "m");
    const walk = new CredentialWalk([a], { maxInFlight: 2 });
    expect(() => walk.recordAbandoned(a)).toThrow(/does not match/); // never started
  });

  it("counts each concurrent start against the budget", () => {
    // Concurrency must not become a way to spend more of the walk budget than a serial walk could.
    const a = attempt("a", "m");
    const b = attempt("b", "m");
    const walk = new CredentialWalk([a, b], { maxInFlight: 2 });
    walk.recordStarted(walk.next()!);
    walk.recordStarted(walk.next()!);
    expect(walk.stats.started).toBe(2);
  });
});
