/**
 * Quota as a DEMOTION term — spec §5.4 "Enforcement (routing input)", reconciliation Gap 12.
 *
 * The §5.1 ladder (`availability.ts`) already resolves `remaining` per (scope, axis, period); this
 * module decides what routing DOES with it, and the answer is deliberately narrow: when a
 * trustworthy figure says a cell is spent, the cell joins the COOLING band of the walk order —
 * demoted behind live members, never dropped, expiring at the very `resetsAt` the evidence
 * stated. Three gates keep it from becoming a guess-driven throttle:
 *
 * - `provider-stated`, `derived:provider-stated` and `derived:configured` gate by default
 *   (decision M1: on by default). `derived:provider-stated` is a STALE observation's stated
 *   limit minus this period's locally measured usage — the limit was first-party, only the
 *   subtraction is ours, so it is first-party enough to gate (same rule as
 *   `availability.ts` `routingEligible`).
 * - `derived:learned` gates ONLY under `routing.quota.enforceLearned` (decision M2): the limit
 *   came from a regex over vendor prose, and a mis-parsed axis would throttle a healthy
 *   deployment on a number nobody stated. It stays display-only until the operator opts in.
 *   `derived:published` (a catalogue figure) NEVER gates.
 * - unknown ⇒ NO EFFECT WHATSOEVER — same rule as the context guardrail. A bucket with neither
 *   an eligible observation nor a resolvable limit-plus-usage produces no opinion here.
 *
 * Pure and bounded: no IO, no clock of its own, a handful of (axis, period) pairs per cell, and
 * the one ledger read it may make (`usedInWindow`) is the store's IN-MEMORY window read. The
 * factory wraps everything in try/catch — this runs on the request path, and a routing hint must
 * never be able to fail a request. It logs nothing: routing is not an error stream.
 */
import type { Config } from "./config.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import type { ProviderTargetIdentity } from "./kernel/contracts.js";
import type { ResolvedAttempt } from "./resolved-attempt.js";
import { parseCredentialId } from "./credential-id.js";
import type { CredentialId } from "./credential-id.js";
import type { QuotaAxis, QuotaObservation, QuotaPeriod } from "./quota-observation.js";
import { CONFIGURED_LIMIT_AXES, configuredLimitQuotaShape, resolveConfiguredLimits } from "./configured-limits.js";
import { observedRateLimits } from "./rate-limits.js";
import { resolveRemaining, resolveResetsAt, type LimitInputs, type LocalUsedReading, type RemainingResolution } from "./availability.js";

/** One spent, gateable bucket — the smallest honest statement of "why this cell steps aside". */
export interface QuotaDemotion {
  readonly axis: QuotaAxis;
  /** Never "unknown": a bucket without a known period cannot reach a boundary to expire at. */
  readonly period: Exclude<QuotaPeriod, "unknown">;
  /** ≤ 0 by construction; preserved rather than clamped — overshoot is information. */
  readonly remaining: number;
  /** `provider-stated` | `derived:provider-stated` | `derived:configured` | `derived:learned` — never a guess label. */
  readonly basis: RemainingResolution["basis"];
  /** When the band lifts; non-null by construction (see resolveQuotaDemotion). */
  readonly resetsAt: number;
  readonly resetsAtBasis: "provider-stated" | "reviewed-rule" | "derived-boundary";
}

/** The per-request evaluator threaded through the walk-order helpers. Null ⇒ no demotion. */
export type QuotaDemotionFn = (attempt: ResolvedAttempt, now: number) => QuotaDemotion | null;

export interface QuotaDemotionDeps {
  readonly cfg: Config;
  readonly breaker: CircuitBreaker;
  /**
   * The accounting store, narrowed to its in-memory `usedInWindow` read — the SAME seam packet
   * D's dashboard producer takes. Absent (a bare programmatic proxy, or no store handed to the
   * server) ⇒ `localUsed` is null ⇒ every derived rung produces null ⇒ the term has no effect.
   * Never a disk read.
   */
  readonly accounting?: Pick<import("./accounting-store.js").AccountingStore, "usedInWindow"> | null;
}

/**
 * Canonical bucket order, so "first gating bucket" is deterministic across calls.
 *
 * Exported for `hard-cap.ts`, which orders the same (axis, period) buckets for the same reason:
 * one definition of "requests before tokens, minute before day" rather than two to keep in step.
 */
export function bucketRank(axis: QuotaAxis, period: QuotaPeriod): number {
  const axisRank = axis === "requests" ? 0 : 1;
  const periodRank = period === "minute" ? 0 : period === "day" ? 1 : 2;
  return axisRank * 10 + periodRank;
}

const EMPTY_USED: LocalUsedReading = { value: null, basis: null };

/** The §5.4 verdict for ONE credential×deployment cell, from whatever evidence exists. */
function resolveQuotaDemotion(deps: QuotaDemotionDeps, attempt: ResolvedAttempt, now: number): QuotaDemotion | null {
  const quotaCfg = deps.cfg.routing.quota;
  if (quotaCfg?.enforce === false) return null;
  const enforceLearned = quotaCfg?.enforceLearned === true;

  const { target } = attempt;
  const model = target.model ?? null;
  const parsed = parseCredentialId(attempt.credentialId);

  // Buckets gather every (axis, period) with ANY admissible evidence. Learned ceilings are
  // consulted only when the operator opted in — resolving them otherwise would be work whose
  // only possible outcome is a demotion M2 forbids.
  const buckets = new Map<string, { axis: QuotaAxis; period: Exclude<QuotaPeriod, "unknown">; observations: QuotaObservation[]; limits: LimitInputs }>();
  const bucketFor = (axis: QuotaAxis, period: Exclude<QuotaPeriod, "unknown">) => {
    const key = `${axis}:${period}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { axis, period, observations: [], limits: {} };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const identity: ProviderTargetIdentity = {
    provider: target.provider,
    model,
    kind: target.kind,
    credentialId: attempt.credentialId,
    ...(target.base ? { base: target.base } : {}),
  };
  for (const observation of deps.breaker.getState(identity)?.quotaObservations ?? []) {
    if (observation.period === "unknown") continue;
    bucketFor(observation.axis, observation.period).observations.push(observation);
  }

  const configured = resolveConfiguredLimits(deps.cfg, target.provider, parsed?.label ?? null, model);
  if (configured !== null) {
    for (const axis of CONFIGURED_LIMIT_AXES) {
      const value = configured[axis];
      if (value === undefined) continue;
      const shape = configuredLimitQuotaShape(axis);
      bucketFor(shape.axis, shape.period).limits.configured = value;
    }
  }

  if (enforceLearned && model !== null) {
    for (const entry of observedRateLimits(target.provider, attempt.credentialId as CredentialId, model, { now })) {
      bucketFor(entry.axis, entry.period).limits.learned = entry.limit;
    }
  }

  // The ledger read is keyed by PERIOD, not axis, so at most one read per period serves every
  // bucket of that period — the bound that keeps this term flat as evidence accumulates.
  const windowCache = new Map<string, LocalUsedReading>();
  const localUsedFor = (period: Exclude<QuotaPeriod, "unknown">, axis: QuotaAxis): LocalUsedReading => {
    let reading = windowCache.get(period);
    if (reading === undefined) {
      const window =
        deps.accounting === undefined || deps.accounting === null
          ? null
          : deps.accounting.usedInWindow({
              credentialId: attempt.credentialId,
              ...(model !== null ? { model } : {}),
              period,
              now,
            });
      reading =
        window === null
          ? EMPTY_USED
          : { value: axis === "tokens" ? window.tokens : window.requests, basis: window.basis };
      windowCache.set(period, reading);
    }
    return reading;
  };

  let best: QuotaDemotion | null = null;
  for (const bucket of [...buckets.values()].sort((a, b) => bucketRank(a.axis, a.period) - bucketRank(b.axis, b.period))) {
    const resolution = resolveRemaining({
      observations: bucket.observations,
      axis: bucket.axis,
      period: bucket.period,
      ...(bucket.limits.configured !== undefined || bucket.limits.learned !== undefined
        ? { limits: bucket.limits }
        : {}),
      localUsed: localUsedFor(bucket.period, bucket.axis),
      now,
    });
    if (resolution.remaining === null || resolution.remaining > 0) continue;
    // Gateable = what the provider itself stated, what the operator declared, or (opt-in only)
    // a learned parse. `routingEligible` already encodes the first two; the learned basis is
    // impossible here unless enforceLearned gathered it above.
    if (!(resolution.routingEligible || resolution.basis === "derived:learned")) continue;
    const resets = resolveResetsAt({
      providerStated: resolution.eligibleObservation?.resetsAt ?? null,
      reviewedRule: null,
      period: bucket.period,
      now,
    });
    // A demotion IS a cooldown expiring at resetsAt. No stated reset AND no derivable boundary
    // means there is nothing to expire against — refuse to invent a duration, and let the cell
    // keep its ordinary place (the walk will learn the truth from the provider's own 429).
    if (resets.resetsAt === null || resets.basis === null) continue;
    if (
      best === null ||
      // Soonest lift wins the announcement: it is the actionable bound. Ties keep the
      // canonically-first bucket, so the choice is stable for identical evidence.
      resets.resetsAt < best.resetsAt
    ) {
      best = {
        axis: bucket.axis,
        period: bucket.period,
        remaining: resolution.remaining,
        basis: resolution.basis,
        resetsAt: resets.resetsAt,
        resetsAtBasis: resets.basis,
      };
    }
  }
  return best;
}

/**
 * Build the request-path evaluator. The wrapper is the safety seam: NOTHING inside may throw into
 * the request path, and a failure degrades to "no opinion" — the pre-Gap-12 behaviour — rather
 * than to a refused request. Deliberately silent: routing hints are not log-worthy events.
 */
export function createQuotaDemotionFn(deps: QuotaDemotionDeps): QuotaDemotionFn {
  return (attempt, now) => {
    try {
      return resolveQuotaDemotion(deps, attempt, now);
    } catch {
      return null;
    }
  };
}

/** `"<spec> (requests/minute remaining 0, provider-stated)"` — bounded, metadata only. */
export function quotaDemotionLabel(spec: string, demotion: QuotaDemotion): string {
  return `${spec} (${demotion.axis}/${demotion.period} remaining ${demotion.remaining}, ${demotion.basis})`;
}
