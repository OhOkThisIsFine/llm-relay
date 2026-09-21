/**
 * MODULE CHARTER: Pure Credential Selector & Attempt Planner (credential-select.ts)
 *
 * 1. Domain Boundary & Responsibilities:
 *    - Implements deterministic, side-effect-free credential selection across provider fleets.
 *    - Encapsulates LRU tracking, credential health assessment, and quota-driven slot prioritization.
 *    - Isolates credential secrets from selection algorithms by operating exclusively on non-secret `CredentialId`s.
 *
 * 2. `AttemptPlan` Contract & Ranking Invariants:
 *    - `groupCredentialAttempts()` partitions candidates into discrete attempts ordered by availability and cost.
 *    - Prioritizes healthy, non-cooling slots with available quota before falling back to degraded or untested slots.
 *    - Applies LRU tie-breaking via `CredentialLru` to evenly distribute requests across equal-priority credentials.
 *
 * 3. Look-Ahead Re-offering & Cooldown Rules:
 *    - Credential slots marked saturated or cooling are suppressed until their backoff or reset periods expire.
 *    - Re-offering logic evaluates timestamps against `now` without mutating global clock state.
 *    - Permanent authentication failures (`credentialFault`) are excluded until explicitly cleared or rotated.
 *
 * 4. Learned Target Facts & Evidence:
 *    - Integrates observed rate limits and quota headers from `target-facts.ts` into live routing decisions.
 *    - Evidence lookup supports fine-grained attempt-level matching (provider × model × credential).
 */
import type { ResolvedAttempt } from "./resolved-attempt.js";
import type { CredentialId } from "./credential-id.js";
import type { FactScope } from "./target-facts.js";
import type { QuotaObservation } from "./quota-observation.js";
import { periodStart } from "./availability.js";

/** A non-secret learned fact, already materialized for the candidate being routed. */
export interface CredentialFact {
  readonly kind: string;
  readonly scope: FactScope;
}

/** Raw live dimensions used by the pure selector. All fields are optional and neutral when absent. */
export interface CredentialSelectionEvidence {
  readonly facts?: readonly CredentialFact[];
  readonly health?: "healthy" | "degraded" | "unhealthy" | "unknown";
  readonly credentialFault?: boolean;
  readonly cooling?: boolean;
  readonly saturated?: boolean;
  readonly quota?: readonly QuotaObservation[];
  readonly cost?: "free" | "paid" | "unknown";
}

export interface CredentialSelectionOptions {
  readonly evidence?: ReadonlyMap<CredentialId, CredentialSelectionEvidence>;
  /** Exact credential/model-cell evidence. Takes precedence over the legacy credential map. */
  readonly evidenceFor?: (attempt: ResolvedAttempt) => CredentialSelectionEvidence | undefined;
  readonly now?: number;
  /** Age after which a provider-stated quota observation is no longer fresh. */
  readonly quotaFreshnessMs?: number;
}

/** LRU state is deliberately credential-wide, not provider/model-wide. */
export class CredentialLru {
  readonly #lastUsed = new Map<CredentialId, number>();
  #sequence = 0;

  /** Called only when a backend egress is about to start. */
  touch(credentialId: CredentialId): void {
    this.#lastUsed.set(credentialId, ++this.#sequence);
  }

  lastUsed(credentialId: CredentialId): number | undefined {
    return this.#lastUsed.get(credentialId);
  }

  /** Lower values sort first: unseen, then least recently used. */
  rank(credentialId: CredentialId): number {
    return this.#lastUsed.get(credentialId) ?? 0;
  }

  snapshot(): ReadonlyMap<CredentialId, number> {
    return new Map(this.#lastUsed);
  }
}

type Ranked = { attempt: ResolvedAttempt; index: number; hard: boolean; absolute: boolean; key: string };

function targetKey(attempt: ResolvedAttempt): string {
  return `${attempt.target.provider}\u0000${attempt.target.base}\u0000${attempt.target.model ?? ""}`;
}

function scopeMatches(scope: FactScope, attempt: ResolvedAttempt): boolean {
  const provider = attempt.target.provider;
  const model = attempt.target.model ?? "";
  switch (scope.kind) {
    case "attempt":
      return scope.provider === provider && scope.credentialId === attempt.credentialId && scope.model === model;
    case "credential":
      return scope.provider === provider && scope.credentialId === attempt.credentialId;
    case "deployment":
      return scope.provider === provider && scope.model === model;
    case "provider":
      return scope.provider === provider;
    case "model":
      return scope.model === model;
    case "group":
      return scope.provider === provider && model.length > 0 && scope.members.includes(model) &&
        (scope.credentialId === undefined || scope.credentialId === attempt.credentialId);
  }
}

function factsFor(attempt: ResolvedAttempt, evidence: CredentialSelectionEvidence | undefined): CredentialFact[] {
  return evidence?.facts?.filter((fact) => scopeMatches(fact.scope, attempt)) ?? [];
}

function hasHardFact(facts: readonly CredentialFact[]): boolean {
  return facts.some((fact) => fact.kind === "not-servable" || fact.kind === "subscription-required");
}

function hasSecret(attempt: ResolvedAttempt): boolean {
  // `not-declared` is intentional for keyless providers and passthrough targets. A declared
  // environment slot with no value is the only missing-secret state.
  return attempt.credential.state !== "declared-missing";
}

function headroomBand(
  quota: readonly QuotaObservation[] | undefined,
  now: number,
  freshnessMs: number,
): number {
  const fresh = (quota ?? []).filter((observation) =>
    observation.basis === "provider-stated" &&
    Number.isFinite(observation.observedAt) &&
    observation.observedAt <= now &&
    now - observation.observedAt <= freshnessMs &&
    (observation.resetsAt === null || observation.resetsAt > now) &&
    Number.isFinite(observation.limit) && observation.limit > 0 &&
    Number.isFinite(observation.remaining) && observation.remaining >= 0 &&
    // The observation must describe the CURRENT period (UTC). An observation from a previous
    // minute/day period is stale even if its observedAt is within the freshness window —
    // the availability ladder (availability.ts) applies the same read-time eligibility test.
    (() => {
      const start = periodStart(now, observation.period);
      return start === null || observation.observedAt >= start;
    })(),
  );
  if (fresh.length === 0) return 1; // unknown
  const minimum = Math.min(...fresh.map((observation) => (observation.remaining / observation.limit) * 100));
  if (minimum <= 0) return 3; // spent
  if (minimum <= 10) return 2; // tight
  return 0; // ample
}

function demotionBand(evidence: CredentialSelectionEvidence | undefined): number {
  if (evidence?.health === "unhealthy") return 4;
  if (evidence?.cooling) return 3;
  if (evidence?.credentialFault) return 2;
  if (evidence?.saturated || evidence?.health === "degraded") return 1;
  return 0;
}

function costBand(cost: CredentialSelectionEvidence["cost"]): number {
  // Unknown pricing ties with paid rather than ranking after it.
  return cost === "free" ? 0 : 1;
}

function compare(
  a: Ranked,
  b: Ranked,
  lru: CredentialLru,
  evidenceFor: (attempt: ResolvedAttempt) => CredentialSelectionEvidence | undefined,
  now: number,
  freshnessMs: number,
): number {
  const ae = evidenceFor(a.attempt);
  const be = evidenceFor(b.attempt);
  const ar = [
    a.hard ? 1 : 0,
    demotionBand(ae),
    headroomBand(ae?.quota, now, freshnessMs),
    costBand(ae?.cost),
    lru.rank(a.attempt.credentialId),
    a.attempt.slot.configIndex,
    a.index,
  ];
  const br = [
    b.hard ? 1 : 0,
    demotionBand(be),
    headroomBand(be?.quota, now, freshnessMs),
    costBand(be?.cost),
    lru.rank(b.attempt.credentialId),
    b.attempt.slot.configIndex,
    b.index,
  ];
  for (let i = 0; i < ar.length; i++) {
    if (ar[i]! !== br[i]!) return ar[i]! - br[i]!;
  }
  return a.key.localeCompare(b.key);
}

/** Rank attempts without mutating LRU state or reading/logging secret material. */
export function rankCredentialAttempts(
  attempts: readonly ResolvedAttempt[],
  lru = new CredentialLru(),
  options: CredentialSelectionOptions = {},
): ResolvedAttempt[] {
  const evidence = options.evidence ?? new Map<CredentialId, CredentialSelectionEvidence>();
  const evidenceFor = options.evidenceFor ?? ((attempt: ResolvedAttempt) => evidence.get(attempt.credentialId));
  const now = options.now ?? Date.now();
  const freshnessMs = options.quotaFreshnessMs ?? 5 * 60_000;
  const rankOneDeployment = (deployment: readonly ResolvedAttempt[]): ResolvedAttempt[] => {
    const ranked = deployment.map((attempt, index) => {
      const facts = factsFor(attempt, evidenceFor(attempt));
      const modelAllowed = attempt.slot.models === null || (attempt.target.model !== undefined && attempt.slot.models.includes(attempt.target.model));
      const disabled = !attempt.slot.enabled;
      const absolute = disabled || !hasSecret(attempt) || !modelAllowed;
      return { attempt, index, hard: absolute || hasHardFact(facts), absolute, key: targetKey(attempt) };
    });
    const survivors = ranked.filter((candidate) => !candidate.absolute && !candidate.hard);
    const nonAbsolute = ranked.filter((candidate) => !candidate.absolute);
    // Hard learned facts have a survivor guard per deployment: if every slot for this target is
    // ruled out, keep only those slots as demoted diagnostics. Never let another deployment's
    // healthy credential make this deployment's hard-fact fallback global.
    const usable = survivors.length > 0 ? survivors : nonAbsolute;
    return [...usable].sort((a, b) => compare(a, b, lru, evidenceFor, now, freshnessMs)).map((candidate) => candidate.attempt);
  };
  // Pool/provider order is authoritative at deployment granularity. Only credentials within a
  // deployment are ranked, so a high-ranked credential cannot reorder unrelated deployments.
  return groupCredentialAttempts(attempts).flatMap((group) => rankOneDeployment(group.attempts));
}

export interface DeploymentCredentialGroup {
  readonly key: string;
  readonly attempts: readonly ResolvedAttempt[];
}

/** Group by deployment while retaining the first-seen target order and slot order. */
export function groupCredentialAttempts(attempts: readonly ResolvedAttempt[]): DeploymentCredentialGroup[] {
  const groups = new Map<string, ResolvedAttempt[]>();
  for (const attempt of attempts) {
    const key = targetKey(attempt);
    const group = groups.get(key);
    if (group) group.push(attempt);
    else groups.set(key, [attempt]);
  }
  return [...groups].map(([key, grouped]) => ({ key, attempts: grouped }));
}

export type CredentialWalkOutcome = {
  readonly status?: number;
  readonly kind?: "success" | "credential" | "deployment" | "provider-transport" | "timeout" | "protocol" | "unknown-refusal" | "local" | "client" | "cancelled";
  /** An accepted fact scope overrides the generic status scope. */
  readonly scope?: FactScope;
};

export interface CredentialWalkOptions extends Omit<CredentialSelectionOptions, "now"> {
  readonly lru?: CredentialLru;
  readonly walkBudgetMs?: number;
  readonly now?: () => number;
  readonly selectionNow?: number;
  readonly suppressedFacts?: readonly CredentialFact[];
  /**
   * How many attempts may be in flight at once. **Defaults to 1**, which is the walk's historical
   * behaviour exactly — one offered candidate, re-offered until it is recorded.
   *
   * ⚠ Above 1 is what makes a HEDGE possible: the walk can offer the next candidate while the
   * previous one is still running. It changes nothing on its own — the caller still decides whether
   * to ask — so a caller that never asks for a second candidate sees no difference at all.
   */
  readonly maxInFlight?: number;
}

export interface CredentialWalkStats {
  readonly started: number;
  readonly skipped: number;
  readonly stopped: boolean;
}

/**
 * An immutable attempt execution plan held in-flight by the candidate walk.
 */
export interface AttemptPlan {
  readonly attempt: ResolvedAttempt;
  readonly group: DeploymentCredentialGroup;
  readonly started: boolean;
}

/**
 * Request-local breadth-first credential walk. `next()` only offers a candidate. The caller must
 * call `recordStarted()` immediately before fetch/egress; that is the sole budget/LRU mutation
 * boundary. Pre-egress validation can call `recordRejected()` and consumes no start budget.
 */
export class CredentialWalk {
  readonly #groups: DeploymentCredentialGroup[];
  readonly #cursor = new Map<string, number>();
  readonly #queue: string[];
  readonly #providerSuppressed = new Set<string>();
  readonly #deploymentClosed = new Set<string>();
  #suppressedFacts: readonly CredentialFact[];
  readonly #lru: CredentialLru;
  readonly #clock: () => number;
  readonly #budgetMs: number;
  #started = 0;
  #skipped = 0;
  #stopped = false;
  #startedAt: number | undefined;
    /**
   * In-flight attempts in offer order. A map supports hedging while preserving the single-attempt
   * behavior when `maxInFlight` is 1.
   */

  readonly #pending = new Map<ResolvedAttempt, AttemptPlan>();
  readonly #maxInFlight: number;

  constructor(attempts: readonly ResolvedAttempt[], options: CredentialWalkOptions = {}) {
    const lru = options.lru ?? new CredentialLru();
    const selectionOptions: CredentialSelectionOptions = {
      ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
      ...(options.evidenceFor === undefined ? {} : { evidenceFor: options.evidenceFor }),
      ...(options.quotaFreshnessMs === undefined ? {} : { quotaFreshnessMs: options.quotaFreshnessMs }),
      ...(options.selectionNow === undefined ? {} : { now: options.selectionNow }),
    };
    const ranked = rankCredentialAttempts(attempts, lru, selectionOptions);
    this.#groups = groupCredentialAttempts(ranked);
    this.#queue = this.#groups.map((group) => group.key);
    this.#suppressedFacts = options.suppressedFacts ?? [];
    this.#lru = lru;
    this.#clock = options.now ?? (() => Date.now());
    this.#budgetMs = options.walkBudgetMs ?? 45_000;
    // A non-finite or sub-1 value degrades to the historical single slot rather than to zero, which
    // would offer nothing at all and fail every request.
    const cap = options.maxInFlight;
    this.#maxInFlight = typeof cap === "number" && Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : 1;
    for (const group of this.#groups) this.#cursor.set(group.key, 0);
  }

  get stats(): CredentialWalkStats {
    return { started: this.#started, skipped: this.#skipped, stopped: this.#stopped };
  }

  /**
   * The OLDEST attempt still in flight, or undefined.
   *
   * ⚠ Kept as a single-value getter because that is what callers already test against
   * (`walk.pending === resolvedAttempt`). At `maxInFlight` 1 it is exactly what it always was. Use
   * `isPending` when more than one may be live, or the check silently only ever asks about the
   * first.
   */
  get pending(): ResolvedAttempt | undefined {
    for (const attempt of this.#pending.keys()) return attempt;
    return undefined;
  }

  /** Is this exact attempt still in flight? The multi-attempt form of the `pending` check. */
  isPending(attempt: ResolvedAttempt): boolean {
    return this.#pending.has(attempt);
  }

  #budgetAllowsStart(): boolean {
    if (this.#started < 2 || this.#budgetMs === 0 || this.#startedAt === undefined) return true;
    return this.#clock() - this.#startedAt < this.#budgetMs;
  }

  #isSuppressed(attempt: ResolvedAttempt): boolean {
    return this.#suppressedFacts.some((fact) => scopeMatches(fact.scope, attempt));
  }

  next(): ResolvedAttempt | undefined {
    if (this.#stopped) return undefined;
    /**
     * ⚠⚠ **An attempt already OFFERED but not yet STARTED is re-offered, never passed over.**
     *
     * This is what makes the request loop's LOOK-AHEAD idiom safe at any `maxInFlight`. Both fronts
     * decide whether to fail over by asking for the next candidate, and then `continue`, and the
     * top of the loop asks AGAIN — so one candidate is offered twice and must come back twice.
     *
     * At `maxInFlight` 1 the saturation branch below did that by accident: one pending attempt made
     * the walk saturated, so the second ask re-offered it. Raising the cap to 2 for hedging broke
     * exactly that, and the failure is instructive — the walk silently handed out a THIRD candidate
     * while the second stayed pending and unstarted forever, so a two-candidate failover test hung
     * instead of failing. **Measured: 40 tests across both fronts, every one of them a multi-
     * candidate failover.**
     *
     * A HEDGE is unaffected because a hedge is asked for only while the primary is in flight, i.e.
     * already STARTED — so this scan finds nothing and a genuinely new candidate is taken.
     */
    for (const [attempt, held] of this.#pending) if (!held.started) return attempt;
    // Saturated with every slot STARTED: re-offer the oldest, which at `maxInFlight` 1 is the
    // single pending attempt and is byte-for-byte the historical behaviour.
    if (this.#pending.size >= this.#maxInFlight) return this.pending;
    if (!this.#budgetAllowsStart()) return undefined;
    while (this.#queue.length > 0) {
      const key = this.#queue.shift()!;
      const group = this.#groups.find((candidate) => candidate.key === key)!;
      if (this.#deploymentClosed.has(key) || this.#providerSuppressed.has(group.attempts[0]!.target.provider)) continue;
      const index = this.#cursor.get(key)!;
      const attempt = group.attempts[index];
      if (!attempt) { this.#deploymentClosed.add(key); continue; }
      this.#cursor.set(key, index + 1);
      // A suppressed slot consumes neither a round nor budget. Continue within this deployment
      // so a still-eligible sibling credential can be selected before moving to the next group.
      if (this.#isSuppressed(attempt)) { this.#skipped++; this.#queue.unshift(key); continue; }
      this.#pending.set(attempt, { attempt, group, started: false });
      return attempt;
    }
    return undefined;
  }

  /** The in-flight record for this exact attempt, or a thrown error naming what went wrong. */
  #inFlight(attempt: ResolvedAttempt, verb: string): AttemptPlan {
    const held = this.#pending.get(attempt);
    if (!held) throw new Error(`credential ${verb} does not match pending attempt`);
    return held;
  }

  /** Return this deployment to the queue, or close it when its credentials are exhausted. */
  #releaseGroup(group: DeploymentCredentialGroup): void {
    if ((this.#cursor.get(group.key) ?? 0) < group.attempts.length) this.#queue.push(group.key);
    else this.#deploymentClosed.add(group.key);
  }

  /** Mark the offered candidate as crossing the real backend-start boundary. */
  recordStarted(attempt: ResolvedAttempt): void {
    const held = this.#inFlight(attempt, "start");
    if (held.started) throw new Error("credential attempt already marked started");
    if (this.#startedAt === undefined) this.#startedAt = this.#clock();
    this.#started++;
    this.#lru.touch(attempt.credentialId);
    this.#pending.set(attempt, { ...held, started: true });
  }

  /** Discard an offered candidate after local/pre-egress validation; no LRU or budget mutation. */
  recordRejected(attempt: ResolvedAttempt): void {
    const held = this.#inFlight(attempt, "rejection");
    this.#pending.delete(attempt);
    this.#releaseGroup(held.group);
  }

  /**
   * Retire a HEDGE LOSER: an attempt this relay aborted because another one won.
   *
   * ⚠ **It deliberately does NOT go through `record`, and that is the second blocker hedging hit.**
   * `record` treats a `cancelled` outcome as terminal and sets `#stopped`, which is right for a
   * client hanging up and catastrophically wrong here — it would end the walk for a request the
   * hedge just rescued. An abandoned attempt proved NOTHING about its deployment, so it also must
   * not suppress a credential, close a deployment, or record an outcome of any kind.
   *
   * ⚠ The deployment goes BACK ON THE QUEUE. Burning it would silently shrink the candidate pool
   * on every hedged request, which is the opposite of what hedging is for. The start budget is
   * NOT refunded: the attempt really was started, and pretending otherwise would let concurrency
   * buy more of the walk budget than a serial walk could spend.
   */
  recordAbandoned(attempt: ResolvedAttempt): void {
    const held = this.#inFlight(attempt, "abandonment");
    if (!held.started) throw new Error("credential abandonment does not match pending attempt");
    this.#pending.delete(attempt);
    this.#releaseGroup(held.group);
  }

  record(attempt: ResolvedAttempt, outcome: CredentialWalkOutcome): void {
    const held = this.#inFlight(attempt, "walk outcome");
    if (!held.started) throw new Error("credential outcome recorded before backend start");
    const group = held.group;
    this.#pending.delete(attempt);
    const status = outcome.status;
    if (outcome.kind === "success" || (status !== undefined && status >= 200 && status < 400)) { this.#stopped = true; return; }
    if (outcome.kind === "local" || outcome.kind === "client" || outcome.kind === "cancelled") { this.#stopped = true; return; }
    if (outcome.kind === "provider-transport") {
      this.#providerSuppressed.add(attempt.target.provider);
      return;
    }
    const scope = outcome.scope;
    const credentialScoped = scope?.kind === "attempt" || scope?.kind === "credential" ||
      (scope?.kind === "group" && scope.credentialId !== undefined) || scope === undefined &&
      (status === 401 || status === 403 || status === 402 || status === 429 || outcome.kind === "credential");
    if (credentialScoped) {
      // A materialized scope can suppress siblings without changing the generic 401/403/402/429 rule.
      const exactScope: FactScope = scope ?? {
        kind: "attempt",
        provider: attempt.target.provider,
        credentialId: attempt.credentialId,
        model: attempt.target.model ?? "",
      };
      this.#suppressedFacts = [...this.#suppressedFacts, { kind: "accepted", scope: exactScope }];
      this.#releaseGroup(group);
      return;
    }
    if (scope) this.#suppressedFacts = [...this.#suppressedFacts, { kind: "accepted", scope }];
    this.#deploymentClosed.add(group.key);
  }
}
