import { sameProviderTarget } from "./kernel/contracts.js";
import type {
  AttemptBeginFailure,
  AttemptCancellationCause,
  AttemptCancelled,
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
 * One started attempt: when, and the relay's own chars/4 estimate of its input size — an entry in
 * the per-cell attempt-start log `pacing.ts` counts its trailing window over (2026-09-15).
 *
 * ⚠ The log is NOT part of `CircuitState`, deliberately. It is recorded in `beginAttempt` — the
 * one choke point every egress on both fronts passes through — and creating HEALTH state there
 * would surface a deployment in `/candidates`, telemetry and the breaker export before any
 * outcome existed, and would break the pinned rule that a relay-local fault creates no provider
 * health state (`test/closed-vocabulary-routing.test.ts`). So it lives in its own map keyed by the
 * same cell, in memory only and NOT carried by `breaker-persistence.ts`: a restart forgets at most
 * one window of pacing memory, and the failure direction is LESS pacing (the provider's own 429
 * then teaches the cell, as before), never more. Bounded by `ATTEMPT_START_WINDOW_MS` and
 * `MAX_ATTEMPT_STARTS`.
 */
export interface AttemptStart {
  readonly at: number;
  /**
   * `estimateRequestTokens` for the request — INPUT only, an estimate, and a LOWER bound of what a
   * provider meters (it counts output too). Null when the caller had no estimate; a null never
   * contributes to a token count, so a window holding one is reported as partial, never as 0.
   */
  readonly estimatedInputTokens: number | null;
}

/** What `CircuitBreaker.attemptsInWindow` answers about one cell's trailing window. */
export interface AttemptWindow {
  /** Attempts started inside the window. A LOWER bound while `saturated` is true. */
  readonly requests: number;
  /**
   * Sum of the estimated INPUT tokens of those attempts, or null when any attempt in the window
   * carried no estimate — an unknown must not read as 0 (the provenance invariant).
   */
  readonly estimatedInputTokens: number | null;
  /**
   * True when the log was capped at `MAX_ATTEMPT_STARTS` with every retained entry inside the
   * window, so the true count is unknowable from here and `requests` is only a floor.
   */
  readonly saturated: boolean;
}

/** The narrowest handle that names one breaker cell: exactly what `getKey` reads. */
export type BreakerCellSelector = Pick<ProviderTargetIdentity, "credentialId" | "model">;

/** One cell cooling on a relay-invented rung that the ping loop may re-test. */
export interface RateLimitCoolingCell {
  readonly provider: string;
  readonly model: string | null;
  readonly credentialId: string;
  readonly cooldownUntil: number;
  readonly source: CooldownSource;
}

/**
 * One whole circuit-breaker cell, in a shape that can be written to disk and read back.
 *
 * Declared here rather than in `breaker-persistence.ts` so the dependency runs one way only
 * (persistence imports the breaker, never the reverse) and `exportState`/`restoreState`
 * can stay IO-free.
 *
 * All fields are OPTIONAL on the wire; absent means the value a fresh cell has.
 */
export interface BreakerCellRow {
  readonly provider: string;
  readonly model: string | null;
  readonly kind: string;
  readonly credentialId: string;
  readonly base?: string | undefined;
  /** Absolute epoch ms. A row whose value is not in the future restores as lapsed. */
  readonly cooldownUntil: number;
  readonly cooldownSource: CooldownSource | null;
  /** Consecutive unexplained 429s — the ladder index that makes the next 429 escalate correctly. */
  readonly unexplained429s: number;
  readonly lastStatus?: number | undefined;
  // ── Added 2026-09-08 (owner decision: the WHOLE cell survives a restart). Every field below is
  // optional on the wire so a file written before that date still loads, with fresh-cell defaults.
  /** Failures since the last success on this cell; `MAX_FAILURES_BEFORE_TRIP` reads it. */
  readonly consecutiveFailures?: number;
  /** Epoch ms of the last failure; the dashboard's Cooldowns panel shows it as `observedAt`. */
  readonly lastFailureTime?: number;
  /** 401/403 count on this credential×model cell — the credential axis, never health. */
  readonly credentialFailures?: number;
  readonly lastCredentialStatus?: number | undefined;
  /** Epoch ms; the fault is active only while this is in the future (`CREDENTIAL_FAULT_TTL_MS`). */
  readonly credentialFaultUntil?: number;
  /** The served-request window (`MAX_PING_HISTORY` newest); `telemetry.ts` scores stability from it. */
  readonly pings?: PingRecord[];
  /** Provider-stated quota headers; `availability.ts` discards a stale one at read time. */
  readonly quotaObservations?: QuotaObservation[];
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
  "failure-escalation",
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

/**
 * Does this cancellation cause reach the provider-health path?
 *
 * ⚠ The sibling of `PROVENANCE_REACHES_HEALTH_PATH`, and it exists because that table cannot answer
 * this question: every cancellation carries `provenance: "client-cancellation"`, so one entry there
 * would have to speak for a caller who hung up AND for a hedge loser the relay itself aborted.
 *
 * - `client-gone-before-response` — the only `true`. The caller waited, this deployment committed
 *   nothing, and the caller left. That is the same evidence a `deadline` carries — a deployment
 *   that did not answer in the time it had — cut short by the client rather than by the relay's own
 *   timer. ⚠ It is admitted only ABOVE `CANCELLATION_EVIDENCE_MS`; see that constant.
 * - `client-gone-mid-response` — `false`. This deployment's answer was already reaching the caller,
 *   so the caller changed its mind about an answer it was receiving. Charging it would demote a
 *   deployment for being interrupted while working.
 * - `relay-abandoned` — `false`. A hedge loser. It proves the RELAY stopped waiting, which is a
 *   statement about `routing.hedge`'s own delay and not about the deployment; the loser might have
 *   answered a millisecond later. `server.ts` `retireHedgeLoser` records this as a stated cost of
 *   hedging, and this entry is where that cost is kept — do not flip it without owner instruction.
 */
const CANCELLATION_REACHES_HEALTH_PATH: Record<AttemptCancellationCause, boolean> = {
  "client-gone-before-response": true,
  "client-gone-mid-response": false,
  "relay-abandoned": false,
} as const satisfies Record<AttemptCancellationCause, boolean>;

/**
 * How long a client-abandoned attempt must have run before it is EVIDENCE about the deployment.
 *
 * ⚠ Without a floor this term would charge a deployment every time a caller changed its mind
 * quickly, which is the half of the backlog property that says a caller who simply changed their
 * mind must stay distinguishable. A cancellation at 200 ms says nothing: no deployment owes an
 * answer that fast.
 *
 * ⚠ It is DERIVED from `DEFAULT_COOLDOWN_MS` rather than picked, so there is one tunable number
 * here and not two, and so the rule carries a property worth stating: an admitted cancellation has
 * by construction wasted more than the default cooldown, so when it does trip the cell,
 * `failureCooldown` necessarily returns `source: "elapsed"` and the cooldown equals the measured
 * waste. A cooldown shorter than the failure that earned it is the v0.65.3 defect.
 *
 * ⚠ It is a threshold on TIME WASTED, not a latency ceiling, and it is deliberately far above the
 * `latency-demotion.ts` band: this term must fire on a hang, never on a slow answer. The measured
 * incident it exists for is a 65-second probe against a hanging member that taught the breaker
 * nothing at all, and 43 consecutive 120-second hangs on the same deployment.
 */
const CANCELLATION_EVIDENCE_MS = DEFAULT_COOLDOWN_MS;

const RATE_LIMIT_ESCALATION_MS = [
  120_000, 600_000, 3_600_000, 86_400_000,
] as const;
/**
 * Repeated generic failures (including 5xx) and 402s escalate only AFTER the existing two-failure
 * trip threshold. Index = consecutiveFailures - (MAX_FAILURES_BEFORE_TRIP + 1):
 * failures 1–2 keep today's behaviour; 3, 4, 5, 6+ add 10m, 1h, 6h, 24h floors.
 */
const FAILURE_ESCALATION_MS = [
  600_000, 3_600_000, 21_600_000, 86_400_000,
] as const;
const LOOPBACK_RATE_LIMIT_COOLDOWN_MS = 5_000;
const QUOTA_EXHAUSTED_COOLDOWN_MS = 3_600_000;
const MAX_FAILURES_BEFORE_TRIP = 2;
const MAX_PING_HISTORY = 10;
const CREDENTIAL_FAULT_TTL_MS = 300_000;
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 900_000;
/**
 * The widest trailing window `pacing.ts` may ask for — one day, the longest period a stated
 * rate limit names (`rpd`/`tpd`). An older start can never be inside any window, so it is dropped
 * at the next append.
 */
export const ATTEMPT_START_WINDOW_MS = 86_400_000;
/**
 * Hard cap on retained starts per cell. Ten thousand covers every daily free-tier ceiling this
 * relay has met (the largest measured was 1,500 RPD) with room; above it the count is a FLOOR
 * (`AttemptWindow.saturated`) and pacing declines rather than guess.
 */
export const MAX_ATTEMPT_STARTS = 10_000;

/**
 * Which cooldown SOURCES a successful probe may end early (`endRateLimitCooldown`).
 *
 * ⚠ A total table, closed with `satisfies`, so a new `CooldownSource` is a compile error here
 * rather than a member that silently falls to either side. The values are a policy, stated:
 *
 * - `default` / `escalation` — the relay's OWN guessed 429 rungs (2 m → 10 m → 1 h → 24 h). A
 *   probe that answers proves the guess overshot; end it. (`default` is also the generic-failure
 *   floor and the 402 rung — `endRateLimitCooldown` disambiguates by `lastStatus`.)
 * - `retry-after` — a stated figure, but a probe that ANSWERED is first-party evidence the window
 *   already lifted; a statement about the future does not outrank an observation of the present.
 * - `loopback` — a 5 s rung on a local daemon; harmless to end.
 * - `quota` — a spent allowance with a stated `resetsAt`; re-registered by `cooledByQuota` on the
 *   next request anyway, and a one-token probe does not disprove a spent token allowance.
 * - `elapsed` — a slow failure's measured waste; a fast probe says nothing about a slow request.
 * - `failure-escalation` — the relay's repeated-5xx/402 floor. A successful probe directly
 *   disproves that guessed recovery window, but only when `lastStatus` is 402 or 5xx.
 */
const PROBE_SUCCESS_ENDS_COOLDOWN = {
  "default": true,
  "escalation": true,
  "retry-after": true,
  "loopback": true,
  "quota": false,
  "elapsed": false,
  "failure-escalation": true,
} as const satisfies Record<CooldownSource, boolean>;

/**
 * Which cooldown SOURCES the ping loop SPENDS a probe on (`rateLimitCoolingCells`). Narrower than
 * the table above on purpose: ending a cooldown a probe happened to disprove costs nothing, but
 * choosing to send a request against a limit the provider just stated does — so only the rungs
 * the relay itself invented are re-tested: guessed 429s and repeated-failure escalation. Same
 * total-table discipline.
 */
const REPROBE_TARGETS_COOLDOWN = {
  "default": true,
  "escalation": true,
  "retry-after": false,
  "loopback": false,
  "quota": false,
  "elapsed": false,
  "failure-escalation": true,
} as const satisfies Record<CooldownSource, boolean>;
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
 * Evidence: `docs/history/latency-demotion-regression-2026-08-30.md` §3.
 */
export function failureCooldown(elapsedMs: number): { ms: number; source: CooldownSource } {
  const wasted = Number.isFinite(elapsedMs) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, elapsedMs)) : 0;
  return wasted > DEFAULT_COOLDOWN_MS
    ? { ms: wasted, source: "elapsed" }
    : { ms: DEFAULT_COOLDOWN_MS, source: "default" };
}

/** Escalation floor for this consecutive-failure count; null before failure 3. */
function failureEscalationMs(consecutiveFailures: number): number | null {
  const index = consecutiveFailures - (MAX_FAILURES_BEFORE_TRIP + 1);
  if (index < 0) return null;
  return FAILURE_ESCALATION_MS[Math.min(index, FAILURE_ESCALATION_MS.length - 1)]!;
}

/** Does a successful probe directly disprove this relay-invented cooldown? */
function probeDisprovesCooldown(source: CooldownSource, status: number | undefined): boolean {
  if (source === "failure-escalation") {
    return status === 402 || (status !== undefined && status >= 500 && status <= 599);
  }
  return status === 429;
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
  /** Per-cell attempt-start log, same key as `states` — pacing's dataset, not health (see `AttemptStart`). */
  private attemptStarts = new Map<string, AttemptStart[]>();
  readonly #owner = Object.freeze({});
  #generation = 1;
  #lifecycle = new AttemptLifecycle(this.#generation);
  #attempts = new WeakMap<object, BreakerAttemptRecord>();

  /** Cell key. This intentionally has no provider/model-string compatibility path. */
  private getKey(target: BreakerCellSelector): string {
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

  /**
   * Begin an attempt. `start` is optional so the `AttemptLifecyclePort` contract is unchanged;
   * the request path passes its egress instant and the request's own input estimate so the
   * cell's attempt-start log (`pacing.ts`'s dataset) records the same clock the walk runs on.
   */
  beginAttempt(
    target: ProviderTargetIdentity,
    start: { at?: number; estimatedInputTokens?: number | null } = {},
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
    this.recordAttemptStart(target, start.at ?? Date.now(), start.estimatedInputTokens ?? null);
    return begun;
  }

  /**
   * Append one start to the cell's log and prune it: entries older than the widest window
   * `pacing.ts` reads (`ATTEMPT_START_WINDOW_MS`) fall off, then the newest `MAX_ATTEMPT_STARTS`
   * are kept. Pruning at both bounds keeps a hot cell at a fixed cost and a quiet one empty.
   */
  private recordAttemptStart(
    target: ProviderTargetIdentity,
    at: number,
    estimatedInputTokens: number | null,
  ): void {
    if (!Number.isFinite(at)) return;
    const key = this.getKey(target);
    let log = this.attemptStarts.get(key);
    if (log === undefined) {
      log = [];
      this.attemptStarts.set(key, log);
    }
    const tokens =
      typeof estimatedInputTokens === "number" && Number.isFinite(estimatedInputTokens) && estimatedInputTokens >= 0
        ? estimatedInputTokens
        : null;
    log.push({ at, estimatedInputTokens: tokens });
    const floor = at - ATTEMPT_START_WINDOW_MS;
    let drop = 0;
    while (drop < log.length && log[drop]!.at < floor) drop += 1;
    const overflow = log.length - drop - MAX_ATTEMPT_STARTS;
    if (overflow > 0) drop += overflow;
    if (drop > 0) log.splice(0, drop);
  }

  /**
   * The attempts this relay started against ONE cell inside the trailing `windowMs` — the
   * sliding-window count `pacing.ts` holds against a stated ceiling. Exact-cell only, like every
   * other reader here: a sibling credential's starts are that credential's own rate.
   *
   * ⚠ A sliding window is the conservative reading on purpose. A count that never exceeds L in
   * ANY trailing window cannot exceed L in a provider's fixed window either (a fixed window is
   * one position of the sliding one), so this bound holds whichever window shape the provider
   * runs — which the relay is never told.
   */
  attemptsInWindow(cell: BreakerCellSelector, windowMs: number, now: number): AttemptWindow {
    const log = this.attemptStarts.get(this.getKey(cell));
    if (log === undefined || !Number.isFinite(windowMs) || windowMs <= 0) {
      return { requests: 0, estimatedInputTokens: 0, saturated: false };
    }
    const since = now - windowMs;
    let requests = 0;
    let tokens: number | null = 0;
    // Newest last, so walk from the end and stop at the first entry outside the window.
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const start = log[i]!;
      if (start.at <= since) break;
      if (start.at > now) continue;
      requests += 1;
      if (tokens !== null) tokens = start.estimatedInputTokens === null ? null : tokens + start.estimatedInputTokens;
    }
    const saturated = log.length >= MAX_ATTEMPT_STARTS && requests === log.length;
    return { requests, estimatedInputTokens: tokens, saturated };
  }

  /**
   * A PROBE answered 200 for this exact cell: end a relay-invented recovery cooldown it disproves.
   *
   * Two gates, both required: `PROBE_SUCCESS_ENDS_COOLDOWN` names which SOURCES a probe may end,
   * then `probeDisprovesCooldown` checks the status that earned it. The legacy guessed 429 sources
   * still require `lastStatus === 429`; `failure-escalation` accepts only 402 or 5xx. A stated
   * quota, credential fault, operator hard cap, ordinary generic-failure floor, or slow measured
   * failure is left exactly as it was.
   *
   * ⚠ `unexplained429s` — the escalation ladder's index — is deliberately NOT reset. A probe is a
   * one-token completion; the ladder counts what REAL traffic saw, and only a real success (the
   * ordinary `applyHealthOutcome` path) resets it. So a cell that keeps 429ing real requests while
   * passing probes still escalates its nominal rung, and the probe cadence sets the effective
   * floor — that is the stated cost of polling for recovery.
   */
  endRateLimitCooldown(cell: BreakerCellSelector, at = Date.now()): boolean {
    const state = this.states.get(this.getKey(cell));
    if (state === undefined || state.cooldownUntil <= at) return false;
    if (state.cooldownSource === null) return false;
    if (!PROBE_SUCCESS_ENDS_COOLDOWN[state.cooldownSource]) return false;
    if (!probeDisprovesCooldown(state.cooldownSource, state.lastStatus)) return false;
    state.cooldownUntil = 0;
    state.cooldownSource = null;
    this.notifyStateChanged();
    return true;
  }

  /**
   * Every cell on a relay-invented recovery rung worth spending a probe on: guessed 429 escalation
   * plus repeated-failure escalation for 402/5xx. A deployment that recovered should not stay
   * parked for the rest of a window the relay itself invented.
   *
   * A stated `Retry-After` is still honoured rather than second-guessed; loopback is only 5 s;
   * quota/elapsed are not proactive re-probe targets. `probeDisprovesCooldown` keeps the status
   * constraint aligned with `endRateLimitCooldown`. Sorted by soonest lift so the bounded probe
   * budget reaches the cells closest to recovery first.
   */
  rateLimitCoolingCells(now = Date.now()): RateLimitCoolingCell[] {
    const out: RateLimitCoolingCell[] = [];
    for (const state of this.states.values()) {
      if (state.cooldownUntil <= now || state.cooldownSource === null) continue;
      if (!REPROBE_TARGETS_COOLDOWN[state.cooldownSource]) continue;
      if (!probeDisprovesCooldown(state.cooldownSource, state.lastStatus)) continue;
      out.push({
        provider: state.target.provider,
        model: state.target.model,
        credentialId: state.target.credentialId,
        cooldownUntil: state.cooldownUntil,
        source: state.cooldownSource,
      });
    }
    return out.sort((a, b) => a.cooldownUntil - b.cooldownUntil);
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
    if (outcome.terminal === "cancelled") {
      this.applyCancelledOutcome(target, outcome);
      return;
    }
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

  /**
   * A cancelled attempt: teach the cell only what the cancellation actually proves.
   *
   * ⚠ This is the ONE place the old flat `if (outcome.terminal === "cancelled") return;` used to
   * be, and its two guards are why that line could not simply be deleted. Deleting it would have
   * charged provider health for every ordinary client disconnect — `PROVENANCE_REACHES_HEALTH_PATH`
   * already answers `true` for `client-cancellation` — and for every hedge loser, silently
   * repealing a documented hedging invariant. Two routing changes nobody asked for, from one line.
   *
   * ⚠ No quota observations are recorded here. The `HeaderObservation` a cancelled attempt carries
   * is not passed on: a walk that was abandoned may hold a partially-read response, and the
   * ordinary path records observations only alongside an outcome it also charges.
   */
  private applyCancelledOutcome(
    target: ProviderTargetIdentity,
    outcome: AttemptCancelled,
  ): void {
    if (!CANCELLATION_REACHES_HEALTH_PATH[outcome.cause]) return;
    // The finite test is explicit rather than folded into the comparison: `NaN <= x` is FALSE, so
    // a non-finite elapsed would fall through and CHARGE. An unusable measurement must fall to the
    // weaker claim, which here is charging nothing.
    if (!Number.isFinite(outcome.elapsedMs) || outcome.elapsedMs <= CANCELLATION_EVIDENCE_MS) return;
    // `status` is deliberately absent: no provider status was ever received, so `outcomeCode`
    // records this as a statusless failure exactly as a transport failure is. That keeps it OUT of
    // `MEASURABLE_CODES`, so an attempt whose true duration is unknown never enters a latency
    // statistic — it moves uptime, which is the thing it actually measured.
    this.applyHealthOutcome(target, {
      ok: false,
      elapsedMs: outcome.elapsedMs,
      at: outcome.completedAt,
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
      state.consecutiveFailures = 0;
      state.cooldownUntil = 0;
      state.cooldownSource = null;
      state.unexplained429s = 0;
      // Only this successful credential/model cell is proven recovered.
      state.credentialFailures = 0;
      state.credentialFaultUntil = 0;
      delete state.lastCredentialStatus;
      this.notifyStateChanged();
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
      if (asked !== null) {
        state.cooldownUntil = now + asked;
        state.cooldownSource = "retry-after";
      } else {
        const escalated = failureEscalationMs(state.consecutiveFailures);
        const ms = Math.max(QUOTA_EXHAUSTED_COOLDOWN_MS, escalated ?? 0);
        state.cooldownUntil = now + ms;
        state.cooldownSource =
          escalated !== null && escalated > QUOTA_EXHAUSTED_COOLDOWN_MS
            ? "failure-escalation"
            : "default";
      }
    } else if (asked !== null) {
      state.cooldownUntil = now + asked;
      state.cooldownSource = "retry-after";
    } else if (state.consecutiveFailures >= MAX_FAILURES_BEFORE_TRIP) {
      const cooling = failureCooldown(outcome.elapsedMs);
      const escalated = failureEscalationMs(state.consecutiveFailures);
      if (escalated !== null && escalated > cooling.ms) {
        state.cooldownUntil = now + escalated;
        state.cooldownSource = "failure-escalation";
      } else {
        state.cooldownUntil = now + cooling.ms;
        state.cooldownSource = cooling.source;
      }
    }
    // One unconditional notify for the whole ladder above — every outcome now dirties the file,
    // and the WriteBehindTimer bounds writes to one per 250 ms of quiet and one per 2 s under
    // sustained load.
    this.notifyStateChanged();
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
    this.notifyStateChanged();
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
    if (cleared > 0) this.notifyStateChanged();
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
    if (credentialFaults.length > 0) this.notifyStateChanged();
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
    if (breakerCells.length > 0 || credentialFaults.length > 0) this.notifyStateChanged();
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
    this.notifyStateChanged();
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
   * Every cell — cooling or not — with every persisted field, for `breaker-persistence.ts`.
   *
   * Pure and IO-free on purpose: this module holds no file handles, so persistence stays a
   * separate concern that a bare programmatic proxy can simply not install. An optional field is
   * omitted only when it is `undefined` (`lastStatus`, `lastCredentialStatus`, `base`); `pings`
   * is written as held, already capped at `MAX_PING_HISTORY`.
   */
  exportState(): BreakerCellRow[] {
    const rows: BreakerCellRow[] = [];
    for (const state of this.states.values()) {
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
        consecutiveFailures: state.consecutiveFailures,
        lastFailureTime: state.lastFailureTime,
        credentialFailures: state.credentialFailures,
        ...(state.lastCredentialStatus === undefined ? {} : { lastCredentialStatus: state.lastCredentialStatus }),
        credentialFaultUntil: state.credentialFaultUntil,
        pings: state.pings,
        quotaObservations: state.quotaObservations,
      });
    }
    return rows;
  }

  /**
   * Re-apply persisted rows, returning how many were applied.
   *
   * ⚠ NEVER touches a cell this process has already created. A restore runs at startup, where that
   * is every row; making it defensive costs nothing and means a late or repeated call cannot
   * shorten, extend or overwrite live state — the `recordQuotaCooldown` rule ("a quota demotion
   * never SHORTENS someone else's cooldown"), generalised to the whole cell.
   *
   * ⚠ FAITHFUL, not future-only. Every field is copied as it was, `cooldownUntil` included even when
   * it is already in the past: a lapsed cooldown restores as lapsed and the cell reads ready,
   * exactly as in memory. The old rule — restore only while the cooldown is still in the future —
   * reset the escalation ladder on every restart, a behaviour the running process does not have.
   * In memory a lapsed cooldown keeps its `unexplained429s`; the counter alone demotes nothing,
   * only a FRESH 429 applies it, and that 429 is a fresh measurement of the same condition. A
   * restart is not a success. Absent optional fields take the fresh-cell defaults; `pings` is
   * trimmed to the newest `MAX_PING_HISTORY` defensively. Nothing here notifies persistence —
   * rewriting the file with what was just read from it would be a pointless write.
   */
  restoreState(rows: readonly BreakerCellRow[]): number {
    let applied = 0;
    for (const row of rows) {
      const target: ProviderTargetIdentity = {
        provider: row.provider,
        model: row.model,
        kind: row.kind as ProviderTargetIdentity["kind"],
        credentialId: row.credentialId as ProviderTargetIdentity["credentialId"],
        ...(row.base === undefined ? {} : { base: row.base }),
      };
      const key = this.getKey(target);
      if (this.states.has(key)) continue;
      const state = this.getOrCreate(target);
      state.cooldownUntil = row.cooldownUntil;
      state.cooldownSource = row.cooldownSource;
      state.unexplained429s = row.unexplained429s;
      if (row.lastStatus !== undefined) state.lastStatus = row.lastStatus;
      state.consecutiveFailures = row.consecutiveFailures ?? 0;
      state.lastFailureTime = row.lastFailureTime ?? 0;
      state.credentialFailures = row.credentialFailures ?? 0;
      if (row.lastCredentialStatus !== undefined) state.lastCredentialStatus = row.lastCredentialStatus;
      state.credentialFaultUntil = row.credentialFaultUntil ?? 0;
      state.pings = row.pings ? row.pings.slice(-MAX_PING_HISTORY) : [];
      state.quotaObservations = row.quotaObservations ?? [];
      applied += 1;
    }
    return applied;
  }

  /**
   * Register the persistence listener. At most one: a second install would double every write,
   * and there is exactly one file.
   */
  onStateChanged(listener: () => void): void {
    this.#stateChanged = listener;
  }

  /** Fired wherever persisted state changes; a no-op until persistence is installed. */
  #stateChanged: (() => void) | null = null;

  private notifyStateChanged(): void {
    // Never let a persistence failure reach the request path — this runs inside outcome recording.
    // Every outcome now dirties the file, and the WriteBehindTimer bounds writes to one per 250 ms
    // of quiet and one per 2 s under sustained load.
    try {
      this.#stateChanged?.();
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
    this.attemptStarts.clear();
    this.#lifecycle.close();
    this.#generation += 1;
    this.#lifecycle = new AttemptLifecycle(this.#generation);
  }
}

export const globalCircuitBreaker = new CircuitBreaker();
