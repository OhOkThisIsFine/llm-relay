import type { ResolvedAttempt } from "./resolved-attempt.js";
import type { CredentialId } from "./credential-id.js";
import type { FactScope } from "./target-facts.js";
import type { QuotaObservation } from "./quota-observation.js";

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
      return scope.provider === provider && model !== undefined && scope.members.includes(model) &&
        (scope.credentialId === undefined || scope.credentialId === attempt.credentialId);
  }
}

/** Public scope predicate for adapters that materialize accepted facts before a walk. */
export const credentialFactMatches = scopeMatches;

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
    Number.isFinite(observation.remaining) && observation.remaining >= 0,
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
}

export interface CredentialWalkStats {
  readonly started: number;
  readonly skipped: number;
  readonly stopped: boolean;
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
  #pending: { group: DeploymentCredentialGroup; attempt: ResolvedAttempt; started: boolean } | undefined;

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
    for (const group of this.#groups) this.#cursor.set(group.key, 0);
  }

  get stats(): CredentialWalkStats {
    return { started: this.#started, skipped: this.#skipped, stopped: this.#stopped };
  }

  get pending(): ResolvedAttempt | undefined { return this.#pending?.attempt; }

  #budgetAllowsStart(): boolean {
    if (this.#started < 2 || this.#budgetMs === 0 || this.#startedAt === undefined) return true;
    return this.#clock() - this.#startedAt < this.#budgetMs;
  }

  #isSuppressed(attempt: ResolvedAttempt): boolean {
    return this.#suppressedFacts.some((fact) => scopeMatches(fact.scope, attempt));
  }

  next(): ResolvedAttempt | undefined {
    if (this.#stopped) return undefined;
    if (this.#pending) return this.#pending.attempt;
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
      this.#pending = { group, attempt, started: false };
      return attempt;
    }
    return undefined;
  }

  /** Mark the offered candidate as crossing the real backend-start boundary. */
  recordStarted(attempt: ResolvedAttempt): void {
    if (this.#pending?.attempt !== attempt) throw new Error("credential start does not match pending attempt");
    if (this.#pending.started) throw new Error("credential attempt already marked started");
    if (this.#startedAt === undefined) this.#startedAt = this.#clock();
    this.#started++;
    this.#lru.touch(attempt.credentialId);
    this.#pending = { ...this.#pending, started: true };
  }

  /** Discard an offered candidate after local/pre-egress validation; no LRU or budget mutation. */
  recordRejected(attempt: ResolvedAttempt): void {
    if (this.#pending?.attempt !== attempt) throw new Error("credential rejection does not match pending attempt");
    const group = this.#pending.group;
    this.#pending = undefined;
    if ((this.#cursor.get(group.key) ?? 0) < group.attempts.length) this.#queue.push(group.key);
    else this.#deploymentClosed.add(group.key);
  }

  record(attempt: ResolvedAttempt, outcome: CredentialWalkOutcome): void {
    if (this.#pending?.attempt !== attempt) throw new Error("credential walk outcome does not match pending attempt");
    if (!this.#pending.started) throw new Error("credential outcome recorded before backend start");
    const group = this.#pending.group;
    this.#pending = undefined;
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
      if ((this.#cursor.get(group.key) ?? 0) < group.attempts.length) this.#queue.push(group.key);
      else this.#deploymentClosed.add(group.key);
      return;
    }
    if (scope) this.#suppressedFacts = [...this.#suppressedFacts, { kind: "accepted", scope }];
    this.#deploymentClosed.add(group.key);
  }
}

/** Short alias used by request-front adapters. */
export const selectCredentialAttempts = rankCredentialAttempts;
