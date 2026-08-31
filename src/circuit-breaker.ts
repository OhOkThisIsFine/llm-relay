import { sameProviderTarget } from "./kernel/contracts.js";
import type {
  AttemptBeginFailure,
  AttemptCompletionFailure,
  AttemptHandle,
  AttemptId,
  AttemptLifecyclePort,
  AttemptOutcome,
  CompletedAttempt,
  OutcomeProvenance,
  ProviderTargetIdentity,
  TransitionResult,
} from "./kernel/contracts.js";
import { AttemptLifecycle } from "./kernel/request-lifecycle.js";
import { getStabilityScore, type PingRecord } from "./ping/metrics.js";
import {
  mergeQuotaObservations,
  type QuotaObservation,
} from "./quota-observation.js";

/** A provider/model deployment, deliberately without a credential cell selector. */
export interface ProviderDeploymentIdentity {
  readonly provider: string;
  readonly model: string | null;
}

export interface CircuitState {
  /** The exact credential/model cell this in-memory state belongs to. */
  readonly target: ProviderTargetIdentity;
  consecutiveFailures: number;
  lastFailureTime: number;
  cooldownUntil: number;
  cooldownSource: CooldownSource | null;
  unexplained429s: number;
  lastStatus?: number | undefined;
  pings: PingRecord[];
  quotaObservations: QuotaObservation[];
  credentialFailures: number;
  lastCredentialStatus?: number | undefined;
  credentialFaultUntil: number;
}

/**
 * The COOLING half of one cell, in a shape that can be written to disk and read back.
 *
 * Declared here rather than in `breaker-persistence.ts` so the dependency runs one way only
 * (persistence imports the breaker, never the reverse) and `exportCooldowns`/`restoreCooldowns`
 * can stay IO-free. See that module for what is deliberately NOT carried.
 */
export interface BreakerCooldownRow {
  readonly provider: string;
  readonly model: string | null;
  readonly kind: string;
  readonly credentialId: string;
  readonly base?: string | undefined;
  /** Absolute epoch ms. A row whose value is not in the future is never restored. */
  readonly cooldownUntil: number;
  readonly cooldownSource: CooldownSource | null;
  /** Consecutive unexplained 429s — the ladder index that makes the next 429 escalate correctly. */
  readonly unexplained429s: number;
  readonly lastStatus?: number | undefined;
}

/** Provisional upstream metadata, committed only with a terminal attempt outcome. */
export interface HeaderObservation {
  readonly target: ProviderTargetIdentity;
  readonly status: number;
  readonly elapsedMs: number;
  readonly observedAt: number;
  readonly quotaObservations?: readonly QuotaObservation[] | undefined;
  readonly retryAfterMs?: number | undefined;
}

export type HeaderObservationFailure =
  AttemptCompletionFailure | { readonly kind: "duplicate-observation" };

interface BreakerAttemptRecord {
  readonly generation: number;
  readonly target: ProviderTargetIdentity;
  observation?: HeaderObservation | undefined;
  completedId?: AttemptId | undefined;
}

interface HealthOutcome {
  readonly ok: boolean;
  readonly status?: number | undefined;
  readonly elapsedMs: number;
  readonly at: number;
  readonly quotaObservations?: readonly QuotaObservation[] | undefined;
  readonly retryAfterMs?: number | undefined;
}

/** Deployment-level observations merged from its credential cells. */
export interface DeploymentMeasurement {
  readonly pings: readonly PingRecord[];
  readonly stabilityScore: number | null;
  /** Least-observed contributing cell: use this, never merged sample count, for confidence. */
  readonly minSamples: number;
}

/**
 * Every reason a cell may be cooling — the ONE definition.
 *
 * ⚠ The list is the source of truth and the type is DERIVED from it, deliberately.
 * `breaker-persistence.ts` used to re-state all five members by hand in `isCooldownSource`, which
 * is the "runtime list hand-copied from the type" defect this repo records against nine
 * `dashboard-contract.ts` unions and against `UNTIL_BASES`: the compiler cannot connect the two, so
 * a new member silently fails to load from disk while type-checking clean. It now imports this.
 */
export const COOLDOWN_SOURCES = [
  "default",
  "escalation",
  "retry-after",
  "loopback",
  "quota",
  "elapsed",
] as const;

export type CooldownSource = (typeof COOLDOWN_SOURCES)[number];

export interface CooldownClearSelector {
  readonly provider: string;
  readonly model?: string;
  readonly credentialId?: string;
}

export interface ClearedCircuitCell {
  readonly provider: string;
  readonly model: string | null;
  readonly credentialId: string;
}

export interface CircuitCooldownClearResult {
  readonly breakerCells: ClearedCircuitCell[];
  readonly credentialFaults: ClearedCircuitCell[];
}

const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Does this outcome provenance reach the provider-health path?
 *
 * ⚠ This table is a faithful TRANSCRIPTION of the single `provenance === "relay-mapper-defect"`
 * early return it replaced — not a fresh policy judgement. Its job is to force a maintainer adding
 * an `OutcomeProvenance` member to make a decision, because the old `if` silently defaulted every
 * unnamed member to `true` — charging the PROVIDER's breaker for what may be a relay-local fault.
 * That is why the values below are what they are, and why changing one is a routing change that
 * belongs in its own commit with its own evidence:
 *
 * - `upstream`, `invalid-upstream-envelope` — the provider answered badly. Real evidence.
 * - `deadline` — the provider did not answer in time. **Real evidence, and the paradigm case a
 *   circuit breaker exists for**: a hanging deployment must be demoted. Setting this `false` would
 *   make a timing-out provider permanently healthy.
 * - `client-cancellation` — kept `true` ONLY to preserve the prior behaviour exactly. It is
 *   unreachable in practice: `outcome.terminal === "cancelled"` returns before this table is
 *   consulted. Semantically a client hanging up says nothing about the provider, so if that early
 *   return ever moves, this is the entry to revisit.
 * - `relay-mapper-defect` — the relay's own bug. The one `false`, and the reason the guard exists.
 *
 * Consulted AFTER `recordQuotaObservations`, which runs even for a mapper defect: a header the
 * provider sent is still the provider's statement. Order: cancelled → quota → this table → health.
 */
const PROVENANCE_REACHES_HEALTH_PATH: Record<OutcomeProvenance, boolean> = {
  "upstream": true,
  "invalid-upstream-envelope": true,
  "deadline": true,
  "client-cancellation": true,
  "relay-mapper-defect": false,
} as const satisfies Record<OutcomeProvenance, boolean>;

const RATE_LIMIT_ESCALATION_MS = [
  120_000, 600_000, 3_600_000, 86_400_000,
] as const;
const LOOPBACK_RATE_LIMIT_COOLDOWN_MS = 5_000;
const QUOTA_EXHAUSTED_COOLDOWN_MS = 3_600_000;
const MAX_FAILURES_BEFORE_TRIP = 2;
const MAX_PING_HISTORY = 10;
const CREDENTIAL_FAULT_TTL_MS = 300_000;
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 900_000;
/** Ordering-only middle band retained for telemetry consumers during migration. */
export const UNMEASURED_STABILITY = 50;

function outcomeCode(outcome: {
  ok: boolean;
  status?: number | undefined;
}): string {
  if (outcome.status === undefined) return outcome.ok ? "200" : "500";
  return outcome.status >= 200 && outcome.status < 300
    ? "200"
    : String(outcome.status);
}

/**
 * How long a generic (non-429, non-402, no `Retry-After`) failure cools a cell.
 *
 * ⚠ **A cooldown must outlast the failure that caused it.** Measured 2026-08-30:
 * `nim/deepseek-ai/deepseek-v4-flash-0731` hung on **43 consecutive attempts**, each costing the
 * full 120000 ms provider timeout, and its breaker read `closed` every time anyone looked — so the
 * relay walked into the same 120-second hole on every request. Nothing was broken in the charging
 * path: a `deadline` provenance reaches the health path and a 504 passes the 4xx filter, so the
 * trip fired exactly as written. The CONSTANT was simply smaller than the failure it punished. A
 * 120 s waste bought a 60 s cooldown, and requests arrived 78-139 s apart, so the cell was always
 * closed again by the next walk.
 *
 * So `DEFAULT_COOLDOWN_MS` becomes a FLOOR, and a slow failure cools for the time it actually
 * wasted. That figure is MEASURED (`elapsedMs`), never invented, which is what permits setting a
 * duration at all under this relay's rule against inventing one — the same standing that lets a
 * provider-stated `Retry-After` set one. It takes the same `MAX_RETRY_AFTER_MS` ceiling, so a
 * 30-minute `timeoutMs` cannot buy a 30-minute cooldown off a single sample.
 *
 * ⚠ **Fast failures are unaffected by construction.** A 300 ms error keeps the 60 s default,
 * because the floor wins. Only a failure slow enough to hurt moves the number — which is why this
 * needs no failure-kind plumbing, no new configuration, and no change to any other branch of the
 * ladder: a `Retry-After`, a 429 escalation and a 402 all still win where they applied before.
 *
 * Pure, so it is pinned directly rather than through the breaker's state machine.
 * Evidence: `docs/latency-demotion-regression-2026-08-30.md` §3.
 */
export function failureCooldown(elapsedMs: number): { ms: number; source: CooldownSource } {
  const wasted = Number.isFinite(elapsedMs) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, elapsedMs)) : 0;
  return wasted > DEFAULT_COOLDOWN_MS
    ? { ms: wasted, source: "elapsed" }
    : { ms: DEFAULT_COOLDOWN_MS, source: "default" };
}

function isLoopbackTarget(target: ProviderTargetIdentity): boolean {
  if (target.base === undefined) return false;
  try {
    const hostname = new URL(target.base).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}

function sameDeployment(
  target: ProviderTargetIdentity,
  deployment: ProviderDeploymentIdentity,
): boolean {
  return (
    target.provider === deployment.provider && target.model === deployment.model
  );
}

function matchesClearSelector(
  target: ProviderTargetIdentity,
  selector: CooldownClearSelector,
): boolean {
  return target.provider === selector.provider &&
    (selector.model === undefined || target.model === selector.model) &&
    (selector.credentialId === undefined || target.credentialId === selector.credentialId);
}

function clearedCell(target: ProviderTargetIdentity): ClearedCircuitCell {
  return {
    provider: target.provider,
    model: target.model,
    credentialId: target.credentialId,
  };
}

function compareClearedCells(a: ClearedCircuitCell, b: ClearedCircuitCell): number {
  return a.provider.localeCompare(b.provider) ||
    a.credentialId.localeCompare(b.credentialId) ||
    (a.model ?? "").localeCompare(b.model ?? "");
}

const breakerHandleOwners = new WeakMap<object, object>();

export class CircuitBreaker implements AttemptLifecyclePort {
  private states = new Map<string, CircuitState>();
  /** Credential-domain leases are deliberately wider than a deployment cell. */
  private credentialInFlight = new Map<string, number>();
  readonly #owner = Object.freeze({});
  #generation = 1;
  #lifecycle = new AttemptLifecycle(this.#generation);
  #attempts = new WeakMap<object, BreakerAttemptRecord>();

  /** Cell key. This intentionally has no provider/model-string compatibility path. */
  private getKey(target: ProviderTargetIdentity): string {
    return target.model === null
      ? target.credentialId
      : `${target.credentialId}/${target.model}`;
  }

  private getOrCreate(target: ProviderTargetIdentity): CircuitState {
    const key = this.getKey(target);
    const existing = this.states.get(key);
    if (existing !== undefined) return existing;
    const state: CircuitState = {
      target: Object.freeze({ ...target }),
      consecutiveFailures: 0,
      lastFailureTime: 0,
      cooldownUntil: 0,
      cooldownSource: null,
      unexplained429s: 0,
      pings: [],
      quotaObservations: [],
      credentialFailures: 0,
      credentialFaultUntil: 0,
    };
    this.states.set(key, state);
    return state;
  }

  beginAttempt(
    target: ProviderTargetIdentity,
  ): TransitionResult<AttemptHandle, AttemptBeginFailure> {
    const begun = this.#lifecycle.beginAttempt(target);
    if (!begun.ok) return begun;
    const handle = begun.value;
    this.#attempts.set(handle as object, {
      generation: this.#generation,
      target: Object.freeze({ ...target }),
    });
    this.credentialInFlight.set(
      target.credentialId,
      (this.credentialInFlight.get(target.credentialId) ?? 0) + 1,
    );
    breakerHandleOwners.set(handle as object, this.#owner);
    return begun;
  }

  observeHeaders(
    handle: AttemptHandle,
    observation: HeaderObservation,
  ): TransitionResult<HeaderObservation, HeaderObservationFailure> {
    const record = this.getAttemptRecord(handle);
    if (!record.ok) return record;
    if (record.value.completedId !== undefined)
      return {
        ok: false,
        error: { kind: "duplicate-completion", id: record.value.completedId },
      };
    if (!sameProviderTarget(record.value.target, observation.target)) {
      return {
        ok: false,
        error: {
          kind: "cross-target",
          expected: record.value.target,
          received: observation.target,
        },
      };
    }
    if (record.value.observation !== undefined)
      return { ok: false, error: { kind: "duplicate-observation" } };
    const stableObservation = Object.freeze({
      ...observation,
      target: Object.freeze({ ...observation.target }),
      quotaObservations:
        observation.quotaObservations === undefined
          ? undefined
          : Object.freeze(
              observation.quotaObservations.map((quotaObservation) =>
                Object.freeze({ ...quotaObservation }),
              ),
            ),
    });
    record.value.observation = stableObservation;
    return { ok: true, value: stableObservation };
  }

  completeAttempt(
    handle: AttemptHandle,
    outcome: AttemptOutcome,
  ): TransitionResult<CompletedAttempt, AttemptCompletionFailure> {
    const record = this.getAttemptRecord(handle);
    if (!record.ok) return record;
    if (record.value.completedId !== undefined)
      return {
        ok: false,
        error: { kind: "duplicate-completion", id: record.value.completedId },
      };
    if (!sameProviderTarget(record.value.target, outcome.target)) {
      return {
        ok: false,
        error: {
          kind: "cross-target",
          expected: record.value.target,
          received: outcome.target,
        },
      };
    }
    const completed = this.#lifecycle.completeAttempt(handle, outcome);
    if (!completed.ok) return completed;
    record.value.completedId = completed.value.id;
    const inFlight = this.credentialInFlight.get(record.value.target.credentialId) ?? 0;
    if (inFlight <= 1) this.credentialInFlight.delete(record.value.target.credentialId);
    else this.credentialInFlight.set(record.value.target.credentialId, inFlight - 1);
    this.applyTerminalOutcome(
      record.value.target,
      outcome,
      record.value.observation,
    );
    return completed;
  }

  private getAttemptRecord(
    handle: AttemptHandle,
  ): TransitionResult<BreakerAttemptRecord, AttemptCompletionFailure> {
    if (typeof (handle as unknown) !== "object" || handle === null) {
      return { ok: false, error: { kind: "stale-handle" } };
    }
    const objectHandle = handle as object;
    const record = this.#attempts.get(objectHandle);
    if (record === undefined) {
      return {
        ok: false,
        error: {
          kind:
            breakerHandleOwners.has(objectHandle) &&
            breakerHandleOwners.get(objectHandle) !== this.#owner
              ? "foreign-handle"
              : "stale-handle",
        },
      };
    }
    if (record.generation !== this.#generation)
      return { ok: false, error: { kind: "stale-handle" } };
    return { ok: true, value: record };
  }

  private applyTerminalOutcome(
    target: ProviderTargetIdentity,
    outcome: AttemptOutcome,
    observation?: HeaderObservation,
  ): void {
    if (outcome.terminal === "cancelled") return;
    this.recordQuotaObservations(target, observation?.quotaObservations);
    // Consult the single provenance table. Quota observations were recorded above even for a
    // mapper defect (a header the provider sent is still the provider's statement). A `false`
    // entry means "return without touching provider health" — the fault is relay-local and must
    // not demote the provider.
    if (!PROVENANCE_REACHES_HEALTH_PATH[outcome.provenance]) return;
    if (outcome.terminal === "succeeded") {
      this.applyHealthOutcome(target, {
        ok: true,
        status: outcome.status,
        elapsedMs: outcome.elapsedMs,
        at: outcome.completedAt,
      });
      return;
    }
    if (outcome.status === 401 || outcome.status === 403) {
      this.applyCredentialFault(target, outcome.status, outcome.completedAt);
      return;
    }
    if (
      outcome.status !== null &&
      outcome.status >= 400 &&
      outcome.status < 500 &&
      outcome.status !== 400 &&
      outcome.status !== 402 &&
      outcome.status !== 404 &&
      outcome.status !== 429
    )
      return;
    this.applyHealthOutcome(target, {
      ok: false,
      status: outcome.status ?? undefined,
      elapsedMs: outcome.elapsedMs,
      at: outcome.completedAt,
      retryAfterMs: outcome.retryAfterMs ?? observation?.retryAfterMs,
    });
  }

  /** Exact-cell health only. A sibling credential never participates. */
  isHealthy(target: ProviderTargetIdentity, now = Date.now()): boolean {
    const state = this.states.get(this.getKey(target));
    return state === undefined || state.cooldownUntil <= now;
  }

  /** Typed non-request writer; it is still exact-cell only. */
  recordOutcome(
    target: ProviderTargetIdentity,
    outcome: {
      ok: boolean;
      elapsedMs: number;
      status?: number;
      quotaObservations?: readonly QuotaObservation[] | undefined;
      at?: number;
      retryAfterMs?: number | undefined;
    },
  ): void {
    this.applyHealthOutcome(target, {
      ...outcome,
      at: outcome.at ?? Date.now(),
    });
  }

  private applyHealthOutcome(
    target: ProviderTargetIdentity,
    outcome: HealthOutcome,
  ): void {
    const state = this.getOrCreate(target);
    const now = outcome.at;
    this.recordQuotaObservations(target, outcome.quotaObservations);
    state.lastStatus = outcome.status ?? (outcome.ok ? 200 : undefined);
    state.pings.push({
      ms: outcome.elapsedMs,
      code: outcomeCode(outcome),
      timestamp: now,
    });
    if (state.pings.length > MAX_PING_HISTORY) state.pings.shift();
    if (outcome.ok) {
      const wasCooling = state.cooldownUntil > now;
      state.consecutiveFailures = 0;
      state.cooldownUntil = 0;
      state.cooldownSource = null;
      state.unexplained429s = 0;
      // Only this successful credential/model cell is proven recovered.
      state.credentialFailures = 0;
      state.credentialFaultUntil = 0;
      delete state.lastCredentialStatus;
      // A success RETRACTS a persisted cooldown, so the file must be rewritten too. Skipping the
      // notify when nothing was cooling keeps a healthy relay from writing on every request.
      if (wasCooling) this.notifyCoolingChanged();
      return;
    }
    state.consecutiveFailures += 1;
    state.lastFailureTime = now;
    const asked =
      outcome.retryAfterMs === undefined
        ? null
        : Math.min(
            MAX_RETRY_AFTER_MS,
            Math.max(MIN_RETRY_AFTER_MS, outcome.retryAfterMs),
          );
    if (outcome.status === 429) {
      if (asked !== null) {
        state.cooldownUntil = now + asked;
        state.cooldownSource = "retry-after";
      } else if (isLoopbackTarget(target)) {
        state.cooldownUntil = now + LOOPBACK_RATE_LIMIT_COOLDOWN_MS;
        state.cooldownSource = "loopback";
      } else {
        state.unexplained429s += 1;
        const index = Math.min(
          state.unexplained429s - 1,
          RATE_LIMIT_ESCALATION_MS.length - 1,
        );
        state.cooldownUntil = now + RATE_LIMIT_ESCALATION_MS[index]!;
        state.cooldownSource =
          state.unexplained429s === 1 ? "default" : "escalation";
      }
    } else if (outcome.status === 402) {
      state.cooldownUntil = now + (asked ?? QUOTA_EXHAUSTED_COOLDOWN_MS);
      state.cooldownSource = asked === null ? "default" : "retry-after";
    } else if (asked !== null) {
      state.cooldownUntil = now + asked;
      state.cooldownSource = "retry-after";
    } else if (state.consecutiveFailures >= MAX_FAILURES_BEFORE_TRIP) {
      const cooling = failureCooldown(outcome.elapsedMs);
      state.cooldownUntil = now + cooling.ms;
      state.cooldownSource = cooling.source;
    }
    // One notify for the whole ladder above, whichever branch set the cooldown. A failure that
    // set none (below the trip threshold, no Retry-After) leaves nothing new to persist.
    if (state.cooldownUntil > now) this.notifyCoolingChanged();
  }

  /** Retain a fresh axis/period tuple without discarding another axis from an earlier response. */
  private recordQuotaObservations(
    target: ProviderTargetIdentity,
    observations: readonly QuotaObservation[] | undefined,
  ): void {
    if (observations === undefined || observations.length === 0) return;
    const state = this.getOrCreate(target);
    state.quotaObservations = mergeQuotaObservations(
      state.quotaObservations,
      observations,
    );
  }

  /** Record a credential fault on the explicit credential/model cell only. */
  recordCredentialFault(
    target: ProviderTargetIdentity,
    status: number,
    at = Date.now(),
  ): void {
    this.applyCredentialFault(target, status, at);
  }

  private applyCredentialFault(
    target: ProviderTargetIdentity,
    status: number,
    at: number,
  ): void {
    const state = this.getOrCreate(target);
    state.credentialFailures += 1;
    state.lastCredentialStatus = status;
    state.credentialFaultUntil = at + CREDENTIAL_FAULT_TTL_MS;
  }

  /** Clear faults only for the stated credential across its own model cells. */
  clearCredentialFaults(credentialId: string): number {
    let cleared = 0;
    for (const state of this.states.values()) {
      if (state.target.credentialId !== credentialId) continue;
      if (state.credentialFaultUntil === 0 && state.credentialFailures === 0)
        continue;
      state.credentialFaultUntil = 0;
      state.credentialFailures = 0;
      delete state.lastCredentialStatus;
      cleared += 1;
    }
    return cleared;
  }

  /** Clear only credential-fault fields inside an operator-addressed selection. */
  clearCredentialFaultState(selector: CooldownClearSelector): ClearedCircuitCell[] {
    const credentialFaults: ClearedCircuitCell[] = [];
    for (const state of this.states.values()) {
      if (!matchesClearSelector(state.target, selector)) continue;
      if (
        state.credentialFaultUntil === 0 &&
        state.credentialFailures === 0 &&
        state.lastCredentialStatus === undefined
      ) continue;
      state.credentialFaultUntil = 0;
      state.credentialFailures = 0;
      delete state.lastCredentialStatus;
      credentialFaults.push(clearedCell(state.target));
    }
    return credentialFaults.sort(compareClearedCells);
  }

  /**
   * Clear operator-addressed cooling state without manufacturing a successful observation.
   * Failure/stability history and quota measurements remain evidence; only the fields that
   * currently demote a cell, plus the unexplained-429 ladder, are reset.
   */
  clearCooldownState(selector: CooldownClearSelector): CircuitCooldownClearResult {
    const breakerCells: ClearedCircuitCell[] = [];
    const credentialFaults: ClearedCircuitCell[] = [];
    for (const state of this.states.values()) {
      if (!matchesClearSelector(state.target, selector)) continue;

      if (
        state.cooldownUntil !== 0 ||
        state.cooldownSource !== null ||
        state.unexplained429s !== 0
      ) {
        state.cooldownUntil = 0;
        state.cooldownSource = null;
        state.unexplained429s = 0;
        breakerCells.push(clearedCell(state.target));
      }

      if (
        state.credentialFaultUntil !== 0 ||
        state.credentialFailures !== 0 ||
        state.lastCredentialStatus !== undefined
      ) {
        state.credentialFaultUntil = 0;
        state.credentialFailures = 0;
        delete state.lastCredentialStatus;
        credentialFaults.push(clearedCell(state.target));
      }
    }
    breakerCells.sort(compareClearedCells);
    credentialFaults.sort(compareClearedCells);
    // `llm-relay cooldowns clear` must reach the FILE too. Without this a cleared cooldown would
    // come back on the next restart, which is exactly the state the operator just retracted.
    if (breakerCells.length > 0) this.notifyCoolingChanged();
    return { breakerCells, credentialFaults };
  }

  /** Exact-cell credential fault only. */
  hasCredentialFault(
    target: ProviderTargetIdentity,
    now = Date.now(),
  ): boolean {
    const state = this.states.get(this.getKey(target));
    return state !== undefined && state.credentialFaultUntil > now;
  }

  /**
   * A quota demotion is a cooldown with a KNOWN end: the `resetsAt` the evidence stated, or the
   * period boundary derived from it (availability's `derived-boundary` rung). It never touches the
   * failure counters — a spent allowance is not a sick backend — and it is cleared by any success
   * through the same path as every other cooldown (`applyHealthOutcome`), which also means it can
   * never trip the breaker or drop the candidate; `orderByUsability` only ever reads
   * `cooldownUntil`.
   *
   * `until <= now` is declined outright rather than clamped to some minimum: a reset already in
   * the past means the evidence is stale, and cooling a healthy cell on stale evidence is worse
   * than doing nothing.
   */
  recordQuotaCooldown(
    target: ProviderTargetIdentity,
    until: number,
    at = Date.now(),
  ): void {
    if (!Number.isFinite(until) || until <= at) return;
    const state = this.getOrCreate(target);
    if (state.cooldownUntil >= until) return; // an existing longer cooldown keeps its own source
    state.cooldownUntil = until;
    state.cooldownSource = "quota";
    this.notifyCoolingChanged();
  }

  /** Active backend attempts for one credential slot across all of its deployments. */
  inFlightCredential(credentialId: string): number {
    return this.credentialInFlight.get(credentialId) ?? 0;
  }

  /** Exact-cell state only. */
  getState(target: ProviderTargetIdentity): CircuitState | undefined {
    return this.states.get(this.getKey(target));
  }

  /** Process-local cell states; their identity is stored rather than decoded from keys. */
  getAllStates(): ReadonlyMap<string, CircuitState> {
    return this.states;
  }

  /**
   * The cooling half of every cell that is still cooling, for `breaker-persistence.ts`.
   *
   * Pure and IO-free on purpose: this module holds no file handles, so persistence stays a
   * separate concern that a bare programmatic proxy can simply not install. Cells that are not
   * cooling are omitted rather than written as empty rows.
   */
  exportCooldowns(now: number = Date.now()): BreakerCooldownRow[] {
    const rows: BreakerCooldownRow[] = [];
    for (const state of this.states.values()) {
      if (state.cooldownUntil <= now) continue;
      rows.push({
        provider: state.target.provider,
        model: state.target.model,
        kind: state.target.kind,
        credentialId: state.target.credentialId,
        ...(state.target.base === undefined ? {} : { base: state.target.base }),
        cooldownUntil: state.cooldownUntil,
        cooldownSource: state.cooldownSource,
        unexplained429s: state.unexplained429s,
        ...(state.lastStatus === undefined ? {} : { lastStatus: state.lastStatus }),
      });
    }
    return rows;
  }

  /**
   * Re-apply persisted cooling rows, returning how many were applied.
   *
   * ⚠ NEVER overwrites a cooldown this process has already learned. A restore runs at startup, but
   * making it defensive costs nothing and means a late or repeated call cannot shorten or extend
   * live state — the same rule `recordQuotaCooldown` follows ("a quota demotion never SHORTENS
   * someone else's cooldown"). Rows at or before `now` are already excluded by
   * `loadBreakerCooldowns`; the check is repeated here so a direct caller cannot bypass it.
   */
  restoreCooldowns(rows: readonly BreakerCooldownRow[], now: number = Date.now()): number {
    let applied = 0;
    for (const row of rows) {
      if (row.cooldownUntil <= now) continue;
      const target: ProviderTargetIdentity = {
        provider: row.provider,
        model: row.model,
        kind: row.kind as ProviderTargetIdentity["kind"],
        credentialId: row.credentialId as ProviderTargetIdentity["credentialId"],
        ...(row.base === undefined ? {} : { base: row.base }),
      };
      const state = this.getOrCreate(target);
      if (state.cooldownUntil > now) continue;
      state.cooldownUntil = row.cooldownUntil;
      state.cooldownSource = row.cooldownSource;
      state.unexplained429s = row.unexplained429s;
      if (row.lastStatus !== undefined) state.lastStatus = row.lastStatus;
      applied += 1;
    }
    return applied;
  }

  /**
   * Register the persistence listener. At most one: a second install would double every write,
   * and there is exactly one file.
   */
  onCoolingChanged(listener: () => void): void {
    this.#coolingChanged = listener;
  }

  /** Fired wherever cooling state changes; a no-op until persistence is installed. */
  #coolingChanged: (() => void) | null = null;

  private notifyCoolingChanged(): void {
    // Never let a persistence failure reach the request path — this runs inside outcome recording.
    try {
      this.#coolingChanged?.();
    } catch {
      /* best-effort persistence */
    }
  }

  /** Deployment measurement merges timestamp-sorted pings without inflating confidence. */
  getDeploymentMeasurement(
    deployment: ProviderDeploymentIdentity,
  ): DeploymentMeasurement {
    const cells = [...this.states.values()].filter(
      (state) =>
        sameDeployment(state.target, deployment) && state.pings.length > 0,
    );
    const pings = cells
      .flatMap((state) => state.pings)
      .sort((a, b) => a.timestamp - b.timestamp);
    const score = pings.length === 0 ? null : getStabilityScore(pings);
    return {
      pings,
      stabilityScore: score === null ? null : Math.max(0, score),
      minSamples:
        cells.length === 0
          ? 0
          : Math.min(...cells.map((state) => state.pings.length)),
    };
  }

  /** Demote unhealthy cells without deleting any candidate; preserve within-band order. */
  orderByUsability<T extends ProviderTargetIdentity>(
    targets: readonly T[],
    now = Date.now(),
  ): T[] {
    const ready: T[] = [];
    const credentialFaulted: T[] = [];
    const cooling: T[] = [];
    const coolingAndFaulted: T[] = [];
    for (const target of targets) {
      const healthy = this.isHealthy(target, now);
      const credentialFault = this.hasCredentialFault(target, now);
      if (healthy && !credentialFault) ready.push(target);
      else if (healthy) credentialFaulted.push(target);
      else if (!credentialFault) cooling.push(target);
      else coolingAndFaulted.push(target);
    }
    return [...ready, ...credentialFaulted, ...cooling, ...coolingAndFaulted];
  }

  reset(): void {
    this.states.clear();
    this.credentialInFlight.clear();
    this.#lifecycle.close();
    this.#generation += 1;
    this.#lifecycle = new AttemptLifecycle(this.#generation);
  }
}

export const globalCircuitBreaker = new CircuitBreaker();
