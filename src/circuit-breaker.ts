import type { ResolvedTarget } from "./config.js";
import type {
  AttemptBeginFailure,
  AttemptCompletionFailure,
  AttemptHandle,
  AttemptId,
  AttemptLifecyclePort,
  AttemptOutcome,
  CompletedAttempt,
  ProviderTargetIdentity,
  TransitionResult,
} from "./kernel/contracts.js";
import { AttemptLifecycle } from "./kernel/request-lifecycle.js";
import { getStabilityScore, type PingRecord } from "./ping/metrics.js";

export interface CircuitState {
  consecutiveFailures: number;
  lastFailureTime: number;
  cooldownUntil: number;
  lastStatus?: number | undefined;
  pings: PingRecord[];
  quotaPercent?: number | null | undefined;
  /**
   * Credential faults (401/403), counted SEPARATELY from health failures.
   *
   * A revoked key is not a sick backend: recording it as a failure would open the breaker on
   * a configuration problem and hide the 401 the operator has to see behind a "target
   * unhealthy" skip, and recording it as a success would launder a permanently broken
   * candidate into a healthy one. So it is neither — it is its own dimension, which is what
   * lets a pool step over the candidate while `/candidates` still reports exactly why.
   */
  credentialFailures: number;
  lastCredentialStatus?: number | undefined;
  /** While in the future, this target is demoted (never dropped) as unusable-for-now. */
  credentialFaultUntil: number;
}

/**
 * Response metadata observed before an attempt reaches its terminal state.
 *
 * An observation is deliberately provisional. In particular, a 2xx status does not prove a
 * streamed response reached EOF or passed validation, so observing it never changes circuit
 * health. Metadata which remains meaningful at completion is committed with the terminal
 * outcome.
 */
export interface HeaderObservation {
  readonly target: ProviderTargetIdentity;
  readonly status: number;
  readonly elapsedMs: number;
  readonly observedAt: number;
  readonly quotaPercent?: number | null | undefined;
  readonly retryAfterMs?: number | null | undefined;
}

export type HeaderObservationFailure =
  | AttemptCompletionFailure
  | { readonly kind: "duplicate-observation" };

interface BreakerAttemptRecord {
  readonly generation: number;
  readonly target: ProviderTargetIdentity;
  observation?: HeaderObservation;
  completedId?: AttemptId;
}

interface HealthOutcome {
  readonly ok: boolean;
  readonly elapsedMs: number;
  readonly status?: number | undefined;
  readonly quotaPercent?: number | null | undefined;
  readonly at: number;
  readonly retryAfterMs?: number | undefined;
}

type CircuitTarget = ResolvedTarget | ProviderTargetIdentity | string;

const DEFAULT_COOLDOWN_MS = 60000; // 1 minute cooldown after consecutive failures
const RATE_LIMIT_COOLDOWN_MS = 120000; // 2 minutes cooldown on 429

/**
 * Cooldown for HTTP 402 — depleted credits on a free/router provider, i.e. a rate limit whose
 * window is a MONTH. The 429 default would retry it every 2 minutes for the rest of the billing
 * period, paying a round-trip per request to hear the same answer. An hour (the same default
 * `dispatch.ts` uses for a host-reported `quota_exhausted`) demotes it without permanently hiding
 * it: `orderByUsability` still walks cooling members last, so it is retried when everything
 * better has failed, and any success — a mid-month top-up — clears it immediately.
 */
const QUOTA_EXHAUSTED_COOLDOWN_MS = 3600000; // 1 hour
const MAX_FAILURES_BEFORE_TRIP = 2;
const MAX_PING_HISTORY = 10;

/**
 * How long a 401/403 demotes a candidate before it is tried again.
 *
 * Deliberately finite: a rotated key must recover without restarting the proxy. Deliberately
 * not zero: without it, a pool holding seven keyless members pays seven round-trips of 401
 * latency on EVERY request before reaching a live one.
 */
const CREDENTIAL_FAULT_TTL_MS = 300000; // 5 minutes

/** Clamp for a provider-supplied Retry-After, so a hostile or absurd value cannot park a target. */
const MIN_RETRY_AFTER_MS = 1000;
const MAX_RETRY_AFTER_MS = 900000; // 15 minutes

/**
 * The ordering value for a target nothing has been measured about.
 *
 * NOT a score, and deliberately NOT 100. `getStabilityScore()` used to return 100
 * for an unseen key, so three untracked targets all scored 100, the comparator
 * returned 0, `Array.prototype.sort` is stable, and an "order is preserved"
 * assertion passed with a competing re-sort fully intact (INV-TS-7).
 *
 * It is the neutral mid-band rather than 0 for the same reason `benchmarks.ts`
 * uses a neutral 50: absence of evidence is not evidence of badness. A target
 * measured at 30 is KNOWN to be erratic and must not be preferred over one nobody
 * has probed; a target measured at 90 is known good and must outrank it.
 */
export const UNMEASURED_STABILITY = 50;

/**
 * The ping code an outcome contributes to the health history.
 *
 * Any 2xx collapses to "200"; every other status is recorded under its OWN code.
 * The previous writer hardcoded "200" for anything the caller called successful,
 * and `server.ts` does not classify 401/403 as retriable — so a provider with a
 * revoked key had a wall of synthetic "200" pings and read as available. A 401 is
 * never an availability signal.
 */
function outcomeCode(outcome: { ok: boolean; status?: number | undefined }): string {
  if (outcome.status === undefined) return outcome.ok ? "200" : "500";
  if (outcome.status >= 200 && outcome.status < 300) return "200";
  return String(outcome.status);
}

function sameTarget(a: ProviderTargetIdentity, b: ProviderTargetIdentity): boolean {
  return a.provider === b.provider && a.model === b.model && a.kind === b.kind;
}

// Shared only to distinguish a genuine handle issued by another breaker from an arbitrary or
// expired object. Weak keys keep ownership per instance without extending a handle's lifetime.
const breakerHandleOwners = new WeakMap<object, object>();

export class CircuitBreaker implements AttemptLifecyclePort {
  private states = new Map<string, CircuitState>();
  readonly #owner = Object.freeze({});
  #generation = 1;
  #lifecycle = new AttemptLifecycle(this.#generation);
  #attempts = new WeakMap<object, BreakerAttemptRecord>();

  private getKey(target: CircuitTarget): string {
    if (typeof target === "string") return target;
    return target.model ? `${target.provider}/${target.model}` : target.provider;
  }

  private getOrCreate(key: string): CircuitState {
    const existing = this.states.get(key);
    if (existing) return existing;
    const fresh: CircuitState = {
      consecutiveFailures: 0,
      lastFailureTime: 0,
      cooldownUntil: 0,
      pings: [],
      credentialFailures: 0,
      credentialFaultUntil: 0,
    };
    this.states.set(key, fresh);
    return fresh;
  }

  /** Begin one target-bound health lifecycle owned by this breaker instance. */
  beginAttempt(
    target: ProviderTargetIdentity,
  ): TransitionResult<AttemptHandle, AttemptBeginFailure> {
    const begun = this.#lifecycle.beginAttempt(target);
    if (!begun.ok) return begun;

    const handle = begun.value;
    const stableTarget = Object.freeze({ ...target });
    this.#attempts.set(handle as object, {
      generation: this.#generation,
      target: stableTarget,
    });
    breakerHandleOwners.set(handle as object, this.#owner);
    return begun;
  }

  /**
   * Attach provisional response metadata to an attempt without changing circuit health.
   *
   * This is intentionally one-shot. Rejected observations do not create a circuit state or
   * alter the accepted observation, so stale/foreign/cross-target/duplicate calls are inert.
   */
  observeHeaders(
    handle: AttemptHandle,
    observation: HeaderObservation,
  ): TransitionResult<HeaderObservation, HeaderObservationFailure> {
    const record = this.getAttemptRecord(handle);
    if (!record.ok) return record;
    if (record.value.completedId !== undefined) {
      return {
        ok: false,
        error: { kind: "duplicate-completion", id: record.value.completedId },
      };
    }
    if (!sameTarget(record.value.target, observation.target)) {
      return {
        ok: false,
        error: {
          kind: "cross-target",
          expected: record.value.target,
          received: observation.target,
        },
      };
    }
    if (record.value.observation !== undefined) {
      return { ok: false, error: { kind: "duplicate-observation" } };
    }

    const stableObservation = Object.freeze({
      ...observation,
      target: Object.freeze({ ...observation.target }),
    });
    record.value.observation = stableObservation;
    return { ok: true, value: stableObservation };
  }

  /**
   * Commit exactly one terminal result for an attempt.
   *
   * `AttemptLifecycle` performs the authoritative one-shot transition. Circuit health is
   * mutated only after that transition succeeds, synchronously preserving call order for all
   * completions of the same target.
   */
  completeAttempt(
    handle: AttemptHandle,
    outcome: AttemptOutcome,
  ): TransitionResult<CompletedAttempt, AttemptCompletionFailure> {
    const record = this.getAttemptRecord(handle);
    if (!record.ok) return record;
    if (record.value.completedId !== undefined) {
      return {
        ok: false,
        error: { kind: "duplicate-completion", id: record.value.completedId },
      };
    }
    if (!sameTarget(record.value.target, outcome.target)) {
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
    this.applyTerminalOutcome(record.value.target, outcome, record.value.observation);
    return completed;
  }

  private getAttemptRecord(
    handle: AttemptHandle,
  ): TransitionResult<BreakerAttemptRecord, AttemptCompletionFailure> {
    if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
      return { ok: false, error: { kind: "stale-handle" } };
    }

    const objectHandle = handle as object;
    const record = this.#attempts.get(objectHandle);
    if (!record) {
      return {
        ok: false,
        error:
          breakerHandleOwners.has(objectHandle) &&
          breakerHandleOwners.get(objectHandle) !== this.#owner
            ? { kind: "foreign-handle" }
            : { kind: "stale-handle" },
      };
    }
    if (record.generation !== this.#generation) {
      return { ok: false, error: { kind: "stale-handle" } };
    }
    return { ok: true, value: record };
  }

  private applyTerminalOutcome(
    target: ProviderTargetIdentity,
    outcome: AttemptOutcome,
    observation?: HeaderObservation,
  ): void {
    if (outcome.terminal === "cancelled") return;

    // Relay translation/configuration failures are local defects. The provider may have
    // returned a valid response, so poisoning its health from our own failure would route
    // around the wrong component and hide the bug operators need to fix.
    if (outcome.provenance === "relay-mapper-defect") return;

    if (outcome.terminal === "succeeded") {
      this.applyHealthOutcome(target, {
        ok: true,
        status: outcome.status,
        elapsedMs: outcome.elapsedMs,
        at: outcome.completedAt,
        quotaPercent: observation?.quotaPercent,
      });
      return;
    }

    if (outcome.status === 401 || outcome.status === 403) {
      this.applyCredentialFault(target, outcome.status, outcome.completedAt);
      return;
    }

    // A genuine client-side 4xx says nothing about deployment health. The request lifecycle
    // still reaches its one terminal state, but it must not manufacture a failure ping. The
    // historically retriable 400/404/429 statuses remain health failures, and 402 joins them:
    // depleted credits is a fact about the deployment's availability, not the request's shape.
    if (
      outcome.status !== null &&
      outcome.status >= 400 &&
      outcome.status < 500 &&
      outcome.status !== 400 &&
      outcome.status !== 402 &&
      outcome.status !== 404 &&
      outcome.status !== 429
    ) {
      return;
    }

    this.applyHealthOutcome(target, {
      ok: false,
      status: outcome.status ?? undefined,
      elapsedMs: outcome.elapsedMs,
      at: outcome.completedAt,
      quotaPercent: observation?.quotaPercent,
      retryAfterMs:
        outcome.retryAfterMs ?? observation?.retryAfterMs ?? undefined,
    });
  }

  /** Check if a target spec or ResolvedTarget is healthy to receive traffic. */
  isHealthy(target: CircuitTarget, now = Date.now()): boolean {
    const key = this.getKey(target);
    const state = this.states.get(key);
    if (!state) return true;

    if (state.cooldownUntil > now) {
      return false; // Circuit open (cooling down)
    }

    return true; // Healthy or cooldown expired
  }

  /**
   * Compatibility adapter for probes and other non-request callers.
   *
   * Request traffic must use the attempt lifecycle above. `elapsedMs` remains required so a
   * compatibility caller cannot fall back to a fabricated latency; both paths converge on
   * `applyHealthOutcome`, the sole health-state writer.
   */
  recordOutcome(
    target: CircuitTarget,
    outcome: {
      ok: boolean;
      elapsedMs: number;
      status?: number;
      quotaPercent?: number | null;
      at?: number;
      /**
       * The provider's own `Retry-After`, in ms, when it published one. It replaces the flat
       * cooldown guess: the provider is the only party that knows when it will serve again,
       * and 2 minutes is as likely to be far too long (a 20-second groq TPM window) as far
       * too short. Clamped, because the value is attacker-adjacent input.
       */
      retryAfterMs?: number | undefined;
    },
  ): void {
    this.applyHealthOutcome(target, {
      ...outcome,
      at: outcome.at ?? Date.now(),
    });
  }

  /** The single circuit/quota/latency transition shared by lifecycle and compatibility calls. */
  private applyHealthOutcome(target: CircuitTarget, outcome: HealthOutcome): void {
    const now = outcome.at;
    const state = this.getOrCreate(this.getKey(target));

    if (outcome.quotaPercent !== undefined) state.quotaPercent = outcome.quotaPercent;
    state.lastStatus = outcome.status ?? (outcome.ok ? 200 : undefined);
    state.pings.push({ ms: outcome.elapsedMs, code: outcomeCode(outcome), timestamp: now });
    if (state.pings.length > MAX_PING_HISTORY) state.pings.shift();

    if (outcome.ok) {
      state.consecutiveFailures = 0;
      state.cooldownUntil = 0;
      // A call that actually succeeded is proof the credential works now — that is the
      // recovery path for a key fixed while the proxy is running.
      state.credentialFailures = 0;
      state.credentialFaultUntil = 0;
      return;
    }

    state.consecutiveFailures += 1;
    state.lastFailureTime = now;

    const asked =
      outcome.retryAfterMs !== undefined
        ? Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, outcome.retryAfterMs))
        : null;

    // HTTP 429 (Rate Limit) trips immediately — for exactly as long as the provider asked,
    // or 2 minutes when it did not say.
    if (outcome.status === 429) {
      state.cooldownUntil = now + (asked ?? RATE_LIMIT_COOLDOWN_MS);
    } else if (outcome.status === 402) {
      // Depleted monthly credits also trips immediately, but for much longer: no provider has
      // been observed to send a Retry-After on a 402 (the observed HuggingFace one carries
      // none), and the 2-minute guess is off by roughly the length of a billing period.
      state.cooldownUntil = now + (asked ?? QUOTA_EXHAUSTED_COOLDOWN_MS);
    } else if (asked !== null) {
      // A 503 with a Retry-After is the provider scheduling us; honour it on the first
      // failure rather than waiting for a second one to trip the generic cooldown.
      state.cooldownUntil = now + asked;
    } else if (state.consecutiveFailures >= MAX_FAILURES_BEFORE_TRIP) {
      state.cooldownUntil = now + DEFAULT_COOLDOWN_MS;
    }
  }

  /**
   * Record a 401/403 — a credential fault, which is NOT health data.
   *
   * This deliberately does not touch `consecutiveFailures`, `cooldownUntil` or the ping
   * history, so `isHealthy()` keeps answering the question it is named for and a revoked key
   * never masquerades as a flaky backend (or vice versa). What it does do is mark the target
   * unusable-for-now, which `hasCredentialFault()` reports and the router uses to DEMOTE it —
   * so a pool stops paying a round-trip per request for a member that cannot authenticate,
   * while `/candidates` still shows the operator the 401 and its count.
   */
  /** Compatibility adapter for non-request credential checks. */
  recordCredentialFault(target: CircuitTarget, status: number, at = Date.now()): void {
    this.applyCredentialFault(target, status, at);
  }

  private applyCredentialFault(
    target: CircuitTarget,
    status: number,
    at: number,
  ): void {
    const state = this.getOrCreate(this.getKey(target));
    state.credentialFailures += 1;
    state.lastCredentialStatus = status;
    state.credentialFaultUntil = at + CREDENTIAL_FAULT_TTL_MS;
  }

  /** True while a recent 401/403 makes this target a last resort. Expires, so a fixed key recovers. */
  hasCredentialFault(target: CircuitTarget, now = Date.now()): boolean {
    const state = this.states.get(this.getKey(target));
    return !!state && state.credentialFaultUntil > now;
  }

  /**
   * Stability for a target whose behaviour has actually been observed, or
   * `null` when NOTHING has been measured.
   *
   * `null` means unknown and callers must render it as such, never as healthy.
   * A target that HAS been observed but never returned a usable response scores
   * 0, not null — that is evidence, and conflating it with "unknown" is what let
   * a target whose every probe failed sort level with a proven-healthy one.
   */
  getMeasuredStability(target: CircuitTarget): number | null {
    const state = this.states.get(this.getKey(target));
    if (!state || state.pings.length === 0) return null;
    const score = getStabilityScore(state.pings);
    return score >= 0 ? score : 0;
  }

  /** True only when this target has at least one recorded observation. */
  hasObservations(target: CircuitTarget): boolean {
    const state = this.states.get(this.getKey(target));
    return !!state && state.pings.length > 0;
  }

  // `getStabilityScore(target)` — the wrapper that returned `getMeasuredStability() ??
  // UNMEASURED_STABILITY` — is DELETED. It existed only for `telemetry.ts`, which reported a
  // bare `number` and has since migrated, and its whole hazard was that a `number` return
  // cannot say "nothing was measured": every caller received a plausible score and none could
  // tell a guess from an observation. `getMeasuredStability()` + `hasObservations()` are the
  // pair that can. The one place the mid-band placeholder is legitimate is ORDERING, where it
  // is applied locally in `getHealthyTargets`. Don't reintroduce a scalar accessor.

  /** Get full state for a target. */
  getState(target: CircuitTarget): CircuitState | undefined {
    return this.states.get(this.getKey(target));
  }

  /** Get all tracked circuit states. */
  getAllStates(): Map<string, CircuitState> {
    return this.states;
  }

  /**
   * Filter an array of targets to healthy candidates, best-first.
   *
   * Ordering is measured stability descending, with an UNTRACKED target placed at
   * `UNMEASURED_STABILITY` — so it sinks below a target proven fast and rises
   * above one proven erratic, and never compares EQUAL to a measured-healthy one
   * (INV-TS-7). On an exact tie the measured target wins, because a real
   * observation beats a mid-band placeholder that happens to land on the same
   * number. Untracked targets tie with each other, so a fully cold breaker leaves
   * the incoming fitness order untouched — that is the intended
   * behaviour, not the accident the old all-100 comparator produced.
   */
  getHealthyTargets(targets: ResolvedTarget[], now = Date.now()): ResolvedTarget[] {
    const healthy = targets.filter((t) => this.isHealthy(t, now));
    const candidates = healthy.length > 0 ? healthy : targets;
    return [...candidates].sort((a, b) => {
      const sa = this.getMeasuredStability(a);
      const sb = this.getMeasuredStability(b);
      const ra = sa ?? UNMEASURED_STABILITY;
      const rb = sb ?? UNMEASURED_STABILITY;
      if (ra !== rb) return rb - ra;
      if ((sa === null) !== (sb === null)) return sa === null ? 1 : -1;
      return 0;
    });
  }

  /** Reset all circuit states. */
  reset(): void {
    this.states.clear();
    this.#lifecycle.close();
    this.#generation += 1;
    this.#lifecycle = new AttemptLifecycle(this.#generation);
  }
}

export const globalCircuitBreaker = new CircuitBreaker();
