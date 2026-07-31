import type { ResolvedTarget } from "./config.js";
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
  /** Failure count prior to an eager success, so a mid-stream failure can restore and increment it. */
  prevConsecutiveFailures?: number | undefined;
}

const DEFAULT_COOLDOWN_MS = 60000; // 1 minute cooldown after consecutive failures
const RATE_LIMIT_COOLDOWN_MS = 120000; // 2 minutes cooldown on 429
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
function outcomeCode(outcome: { ok: boolean; status?: number }): string {
  if (outcome.status === undefined) return outcome.ok ? "200" : "500";
  if (outcome.status >= 200 && outcome.status < 300) return "200";
  return String(outcome.status);
}

export class CircuitBreaker {
  private states = new Map<string, CircuitState>();

  private getKey(target: ResolvedTarget | string): string {
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

  /** Check if a target spec or ResolvedTarget is healthy to receive traffic. */
  isHealthy(target: ResolvedTarget | string, now = Date.now()): boolean {
    const key = this.getKey(target);
    const state = this.states.get(key);
    if (!state) return true;

    if (state.cooldownUntil > now) {
      return false; // Circuit open (cooling down)
    }

    return true; // Healthy or cooldown expired
  }

  /**
   * Record one request outcome with its MEASURED elapsed time.
   *
   * ⚠ This is the ONLY writer, and `elapsedMs` is required, so a caller cannot
   * fall back to a fabricated constant. The deleted `recordSuccess`/
   * `recordFailure` pair defaulted `ms` to 500/1000 and every real call site in
   * `server.ts` omitted it, so p95/jitter/spike-rate — the numbers that decide
   * which backend serves a request — were computed over parameter defaults
   * rather than over measurements. Do not reintroduce a defaulted entry point:
   * `tsc` over `src/` is what now enforces the measured-latency invariant.
   */
  recordOutcome(
    target: ResolvedTarget | string,
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
    const now = outcome.at ?? Date.now();
    const state = this.getOrCreate(this.getKey(target));

    if (outcome.quotaPercent !== undefined) state.quotaPercent = outcome.quotaPercent;
    state.lastStatus = outcome.status ?? (outcome.ok ? 200 : undefined);
    state.pings.push({ ms: outcome.elapsedMs, code: outcomeCode(outcome), timestamp: now });
    if (state.pings.length > MAX_PING_HISTORY) state.pings.shift();

    if (outcome.ok) {
      state.prevConsecutiveFailures = state.consecutiveFailures;
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
    } else if (asked !== null) {
      // A 503 with a Retry-After is the provider scheduling us; honour it on the first
      // failure rather than waiting for a second one to trip the generic cooldown.
      state.cooldownUntil = now + asked;
    } else if (state.consecutiveFailures >= MAX_FAILURES_BEFORE_TRIP) {
      state.cooldownUntil = now + DEFAULT_COOLDOWN_MS;
    }
  }

  /**
   * Correct an eager 200 success outcome to a failure when a stream breaks mid-response.
   *
   * When HTTP status 200 headers arrive, `recordAttempt` eagerly records success (`ok: true`).
   * If reading the response body subsequently fails (socket reset / network drop mid-stream),
   * calling `recordMidStreamFailure` replaces the eager success ping with a 502 failure ping
   * and increments `consecutiveFailures` from its pre-request count rather than resetting it,
   * allowing repeated mid-stream resets to trip the breaker.
   */
  recordMidStreamFailure(
    target: ResolvedTarget | string,
    outcome: { elapsedMs: number; status?: number; at?: number },
  ): void {
    const key = this.getKey(target);
    const state = this.states.get(key);
    const now = outcome.at ?? Date.now();
    const status = outcome.status ?? 502;

    if (!state) {
      this.recordOutcome(target, { ok: false, status, elapsedMs: outcome.elapsedMs, at: now });
      return;
    }

    if (state.pings.length > 0 && state.pings[state.pings.length - 1]!.code === "200") {
      state.pings.pop();
    }

    state.lastStatus = status;
    state.pings.push({ ms: outcome.elapsedMs, code: String(status), timestamp: now });
    if (state.pings.length > MAX_PING_HISTORY) state.pings.shift();

    state.consecutiveFailures = (state.prevConsecutiveFailures ?? 0) + 1;
    state.prevConsecutiveFailures = 0;
    state.lastFailureTime = now;

    if (state.consecutiveFailures >= MAX_FAILURES_BEFORE_TRIP) {
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
  recordCredentialFault(target: ResolvedTarget | string, status: number, at = Date.now()): void {
    const state = this.getOrCreate(this.getKey(target));
    state.credentialFailures += 1;
    state.lastCredentialStatus = status;
    state.credentialFaultUntil = at + CREDENTIAL_FAULT_TTL_MS;
  }

  /** True while a recent 401/403 makes this target a last resort. Expires, so a fixed key recovers. */
  hasCredentialFault(target: ResolvedTarget | string, now = Date.now()): boolean {
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
  getMeasuredStability(target: ResolvedTarget | string): number | null {
    const state = this.states.get(this.getKey(target));
    if (!state || state.pings.length === 0) return null;
    const score = getStabilityScore(state.pings);
    return score >= 0 ? score : 0;
  }

  /** True only when this target has at least one recorded observation. */
  hasObservations(target: ResolvedTarget | string): boolean {
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
  getState(target: ResolvedTarget | string): CircuitState | undefined {
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
   * the incoming (benchmark-ranked) order untouched — that is the intended
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
  }
}

export const globalCircuitBreaker = new CircuitBreaker();
