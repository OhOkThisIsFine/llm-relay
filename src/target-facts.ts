import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { WriteBehindTimer } from "./write-behind.js";

/**
 * Learned facts about routing targets, each carrying the SCOPE it actually applies to.
 *
 * The problem this exists to stop recurring: a fact's natural scope and its storage keying kept
 * drifting apart, independently, in every store that learned something. Measured 2026-08-08:
 *
 *   - a HuggingFace credit balance is stated per ACCOUNT, and was being rediscovered once per
 *     model — six pool members, six round-trips, six expiries, to learn one number;
 *   - a revoked key is a fact about the CREDENTIAL, and `credentialFaultUntil` is keyed per
 *     deployment, so every model on that provider must independently discover the same 401;
 *   - an account-level 429 is the same shape again.
 *
 * Each was a separate patch waiting to be written. So scope is now part of the fact rather than a
 * property of whichever module happened to record it, and every lookup resolves MOST SPECIFIC
 * FIRST with its provenance attached — the shape `metadata.ts` already uses for limits and prices
 * (serving provider's own figure → another provider's figure for the same id → null).
 *
 * ⚠ **Scope comes from EVIDENCE, never from inference.** "Three models on this provider returned
 * 401" is not proof the key is bad — it is equally three gated models under a working credential,
 * which is the false accusation `key-checker.ts` exists to avoid. A provider-scoped fact requires
 * something that *states* an account-level condition; when a situation is ambiguous it goes to the
 * offline review tier in `refusal-interpretation.ts` and binds only once accepted. Nothing here
 * promotes a fact by counting failures.
 */

/**
 * What was learned. Deliberately one enum across fact kinds, because the consequence of a fact is
 * a property of the fact and not of the store it came from.
 *
 * ⚠ `allowance-exhausted` is TEMPORAL, not a cost verdict — a free lane that has spent this
 * period's credits is the normal state of a working free lane. It demotes and expires; it must
 * never evict anything from a free pool, or the eviction outlives the exhaustion. `isCostBlocked`
 * is the enforcement of that and deliberately cannot see it.
 */
export type FactKind =
  /** The deployment does not exist (404/400 "does not exist", "not found for account"). */
  | "not-servable"
  /** It exists, but is not covered by the plan we hold (403 naming a subscription). */
  | "subscription-required"
  /** Free, and spent until the allowance refreshes (402 naming a credit balance). */
  | "allowance-exhausted"
  /** The credential itself is rejected — stated, e.g. "invalid api key". NOT inferred from 401s. */
  | "credential-invalid"
  /**
   * Rate limited at a scope the response STATED — "your account has exceeded its rate limit".
   *
   * ⚠ This is not where ordinary 429s go. A bare 429 is one deployment's back-pressure and belongs
   * to the breaker's per-target cooldown, which already handles it well. This kind exists only for
   * the case the breaker cannot express: a limit the provider says belongs to the ACCOUNT, where
   * every sibling is equally throttled and discovering that once per model is the waste.
   */
  | "rate-limited";

/**
 * Who a fact applies to, specific → general. Resolution walks this order and stops at the first
 * live hit, so a deployment's own verdict always beats its provider's.
 *
 *   deployment — this (provider, model) alone.
 *   group      — an explicit set of models on one provider. ⚠ The membership travels WITH the
 *                fact rather than being inferred from id prefixes: prefix matching is the
 *                heuristic `authEnv.ts` refuses, and one bad match evicts a working family. A
 *                group verdict is reviewed with its member list visible before it binds.
 *   provider   — every deployment behind that credential. Balances, revoked keys, account rate
 *                limits. This is the scope that turns N discoveries into one.
 *   model      — the same model id wherever it is served. Reference-grade only, and never used for
 *                cost or availability: the same id on two providers is two deployments with
 *                different ceilings, prices and entitlements (see `metadata.ts`).
 */
export type FactScope =
  | { kind: "deployment"; provider: string; model: string }
  | { kind: "group"; provider: string; members: string[] }
  | { kind: "provider"; provider: string }
  | { kind: "model"; model: string };

/** Scope names in resolution order. Exported so callers cannot invent a different precedence. */
export const SCOPE_PRECEDENCE: Array<FactScope["kind"]> = ["deployment", "group", "provider", "model"];

interface StoredFact {
  kind: FactKind;
  scope: FactScope;
  /** Epoch ms of the observation, for TTL. */
  at: number;
  /** Epoch ms this fact stops applying, when the evidence stated a reset. */
  until?: number;
}

interface FactStore {
  version: 1;
  facts: Record<string, StoredFact>;
}

/**
 * How long each kind is believed without re-checking. All expire, because all are reversible: a
 * de-listed model returns, a plan is upgraded, an allowance refreshes, a key is rotated.
 *
 * `allowance-exhausted` is deliberately the SHORTEST despite monthly credit cycles — cooling a
 * whole provider for a month on one 402 would be catastrophic if the balance were topped up an
 * hour later, and one re-probe an hour is cheap and self-correcting. It also matches the breaker's
 * `QUOTA_EXHAUSTED_COOLDOWN_MS`, so the two cannot disagree about when to try again.
 * `credential-invalid` is short for the same reason from the other direction: a rotated key must
 * recover quickly, and any success clears it outright.
 */
export const FACT_TTL_MS: Record<FactKind, number> = {
  "not-servable": 6 * 60 * 60 * 1000,
  "subscription-required": 24 * 60 * 60 * 1000,
  "allowance-exhausted": 60 * 60 * 1000,
  "credential-invalid": 15 * 60 * 1000,
  // Short, and almost always superseded by a stated reset: a rate limit window is minutes, and
  // believing a stale one keeps working capacity idle. `RATE_LIMIT_COOLDOWN_MS` in the breaker is
  // the same figure for the same reason — the two must not disagree about when to try again.
  "rate-limited": 2 * 60 * 1000,
};

/** Facts that make a target unfit for a FREE pool — a statement about cost or existence. */
const COST_BLOCKING: ReadonlySet<FactKind> = new Set<FactKind>(["not-servable", "subscription-required"]);
/** Facts that make a target temporarily unusable but leave its pool membership intact. */
const COOLING: ReadonlySet<FactKind> = new Set<FactKind>(["allowance-exhausted", "credential-invalid", "rate-limited"]);

let _store: FactStore | null = null;
let _path: string | null = null;
const writer = new WriteBehindTimer();

function defaultPath(): string {
  // ⚠ Redirected under vitest for the same reason probe-cache and context-limits are: a test's
  // synthetic fact persisted here would evict a real deployment from the user's live pools.
  if (process.env.VITEST !== undefined) {
    return join(tmpdir(), `llm-relay-test-target-facts-${process.pid}.json`);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const baseDir = xdg && xdg.trim() ? join(xdg, "llm-relay") : join(homedir(), ".llm-relay");
  return join(baseDir, "target-facts.json");
}

/** The storage key for a scope. Groups hash their sorted membership so two differ iff they cover
 *  different models — a group is defined by who is in it, not by a name somebody chose. */
function keyOf(scope: FactScope): string {
  switch (scope.kind) {
    case "deployment":
      return `d:${scope.provider}/${scope.model}`;
    case "group":
      return `g:${scope.provider}/${[...scope.members].sort().join(",")}`;
    case "provider":
      return `p:${scope.provider}`;
    case "model":
      return `m:${scope.model}`;
  }
}

function load(path: string): FactStore {
  if (_store && _path === path) return _store;
  _path = path;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FactStore>;
    if (parsed && typeof parsed === "object" && parsed.facts && typeof parsed.facts === "object") {
      _store = { version: 1, facts: parsed.facts as Record<string, StoredFact> };
      return _store;
    }
  } catch {
    // Unreadable or corrupt: start clean. Everything here is re-learnable — the worst consequence
    // is one wasted round-trip per target.
  }
  _store = { version: 1, facts: {} };
  return _store;
}

function persist(path: string): void {
  if (!_store) return;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(_store, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  } catch {
    /* storage problem, never a request failure — same contract as every other store here */
  }
}

function expiryOf(fact: StoredFact): number {
  return fact.until ?? fact.at + (FACT_TTL_MS[fact.kind] ?? 0);
}

/** Does this stored fact cover this deployment? */
function covers(fact: StoredFact, provider: string, model: string | null): boolean {
  switch (fact.scope.kind) {
    case "deployment":
      return fact.scope.provider === provider && model !== null && fact.scope.model === model;
    case "group":
      return fact.scope.provider === provider && model !== null && fact.scope.members.includes(model);
    case "provider":
      return fact.scope.provider === provider;
    case "model":
      return model !== null && fact.scope.model === model;
  }
}

/**
 * Record a fact at the scope its evidence supports.
 *
 * A fresh observation replaces an older one at the SAME scope: the target is the authority on
 * itself, and one that changed its answer is telling us so. Facts at different scopes coexist —
 * a deployment can be `subscription-required` while its provider is `allowance-exhausted`, and
 * resolution decides which applies.
 */
export function recordFact(
  kind: FactKind,
  scope: FactScope,
  opts: { path?: string; now?: number; retryAfterMs?: number | null } = {},
): void {
  const path = opts.path ?? defaultPath();
  const store = load(path);
  const now = opts.now ?? Date.now();
  const stated = typeof opts.retryAfterMs === "number" && opts.retryAfterMs > 0 ? opts.retryAfterMs : null;
  store.facts[keyOf(scope)] = {
    kind,
    scope,
    at: now,
    // A vendor-stated reset beats our TTL, exactly as it does for the breaker's cooldown: the
    // provider knows when its own allowance refreshes and we are guessing.
    ...(stated !== null ? { until: now + stated } : {}),
  };
  writer.touch(() => persist(path));
}

/** Every live fact covering a deployment, most specific first. */
export function factsFor(
  provider: string,
  model: string | null | undefined,
  opts: { path?: string; now?: number } = {},
): Array<{ kind: FactKind; scope: FactScope; until: number }> {
  const store = load(opts.path ?? defaultPath());
  const now = opts.now ?? Date.now();
  const m = typeof model === "string" ? model : null;
  const hits: Array<{ kind: FactKind; scope: FactScope; until: number }> = [];
  for (const fact of Object.values(store.facts)) {
    const until = expiryOf(fact);
    if (now >= until) continue;
    if (!covers(fact, provider, m)) continue;
    hits.push({ kind: fact.kind, scope: fact.scope, until });
  }
  hits.sort((a, b) => SCOPE_PRECEDENCE.indexOf(a.scope.kind) - SCOPE_PRECEDENCE.indexOf(b.scope.kind));
  return hits;
}

/**
 * Has this deployment been PROVEN unfit for a free pool?
 *
 * ⚠ True only for facts in `COST_BLOCKING`. `allowance-exhausted` is deliberately excluded and
 * must stay excluded — see the `FactKind` note. `credential-invalid` is excluded too: a bad key is
 * a configuration problem, not a statement that the deployment costs money, and removing members
 * from a pool over it would empty the pool on a mistake that a rotation fixes in seconds.
 */
export function isCostBlocked(
  provider: string,
  model: string | null | undefined,
  opts: { path?: string; now?: number } = {},
): boolean {
  return factsFor(provider, model, opts).some((f) => COST_BLOCKING.has(f.kind));
}

/**
 * When a temporarily-unusable target is worth trying again, or null when nothing is cooling it.
 * Only `COOLING` kinds produce this — the others are exclusions, not cooldowns, and a caller that
 * wants those wants `isCostBlocked`.
 */
export function cooldownUntil(
  provider: string,
  model: string | null | undefined,
  opts: { path?: string; now?: number } = {},
): number | null {
  let soonest: number | null = null;
  for (const f of factsFor(provider, model, opts)) {
    if (!COOLING.has(f.kind)) continue;
    // The LATEST expiry among covering facts: a target under both an account exhaustion and its
    // own is usable only once both have cleared.
    soonest = soonest === null ? f.until : Math.max(soonest, f.until);
  }
  return soonest;
}

/**
 * A success clears every fact covering this deployment — including its PROVIDER-scoped ones.
 *
 * A served request is first-party proof that the deployment exists, the credential authenticates,
 * and the allowance is not spent. That is strictly better evidence than any stored refusal, and it
 * covers the cases that matter most: credits topped up, a key rotated, a month rolled over, all
 * well before the TTL would have expired. Same contract as the breaker clearing a credential fault
 * on success.
 *
 * ⚠ A group fact is cleared only if this model is IN the group — one member serving says nothing
 * about the others, and dropping the whole verdict would re-admit models that are genuinely gated.
 */
export function clearFacts(
  provider: string,
  model: string | null | undefined,
  opts: { path?: string } = {},
): FactKind[] {
  const path = opts.path ?? defaultPath();
  const store = load(path);
  const m = typeof model === "string" ? model : null;
  const cleared: FactKind[] = [];
  let changed = false;
  for (const [key, fact] of Object.entries(store.facts)) {
    if (!covers(fact, provider, m)) continue;
    changed = true;
    // Reported back so the caller can clear the SYMPTOMS of a fact that has just been disproved.
    // A stated bad credential leaves a per-deployment 401 on the breaker for every model that
    // tried during the outage; when the key starts working, those are stale evidence about a
    // problem that no longer exists, and expiring them one by one keeps the pool narrow.
    if (fact.scope.kind === "provider") cleared.push(fact.kind);
    delete store.facts[key];
  }
  if (changed) writer.touch(() => persist(path));
  return cleared;
}

/** Every live fact, for `llm-relay eligibility`. Expired entries are omitted, not reported. */
export function allFacts(
  opts: { path?: string; now?: number } = {},
): Array<{ kind: FactKind; scope: FactScope; at: number; until: number }> {
  const store = load(opts.path ?? defaultPath());
  const now = opts.now ?? Date.now();
  const out: Array<{ kind: FactKind; scope: FactScope; at: number; until: number }> = [];
  for (const fact of Object.values(store.facts)) {
    const until = expiryOf(fact);
    if (now >= until) continue;
    out.push({ kind: fact.kind, scope: fact.scope, at: fact.at, until });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** A human-readable label for a scope — used by the CLI and by nothing that makes decisions. */
export function describeScope(scope: FactScope): string {
  switch (scope.kind) {
    case "deployment":
      return `${scope.provider}/${scope.model}`;
    case "group":
      return `${scope.provider}/{${scope.members.length} models}`;
    case "provider":
      return `${scope.provider}/* (whole account)`;
    case "model":
      return `*/${scope.model}`;
  }
}

/** Flush pending writes. Called on shutdown, like the other write-behind stores. */
export function flushFacts(opts: { path?: string } = {}): void {
  if (!writer.dirty) return;
  writer.clear();
  persist(opts.path ?? defaultPath());
}

/** Test seam: drop the in-memory store so a suite can point at a fresh path. */
export function resetFacts(): void {
  _store = null;
  _path = null;
  writer.clear();
}
