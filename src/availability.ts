/**
 * Availability ladders — spec §5.1-5.3 of docs/quota-metering-spec-2026-08-16.md.
 *
 * `remaining` and `resetsAt` are resolved per (scope, axis, period) through fixed rungs, and
 * staleness is handled HERE, at read time, as a pure function of the caller's clock — never by a
 * repair write. freellmapi runs an UPDATE inside its GET path to restore `remaining` once a reset
 * passes; the same correctness falls out of simply declining an observation that predates the
 * current period boundary, because rung 2 recomputes from the ledger and rung 3 is null. A read
 * path that never mutates cannot invent a replenished number.
 *
 * Provenance (repo invariant): every figure carries its basis; unknown stays null, never 0;
 * no published limit, ceiling or multiplier is invented anywhere in this module. The one
 * arithmetic step — rung 2's limit − localUsed — is labelled with WHERE its inputs came from
 * ("derived:<limit-provenance>"), so a reader can always tell a stated figure from a computed one.
 *
 * Pure: no IO, no clock of its own (`now` is an argument), no imports from server.ts. The next
 * packet (Gap 12) calls `resolveRemaining` from the routing path under `routingEligible`; nothing
 * here reorders or refuses anything today.
 */
import type { QuotaAxis, QuotaObservation, QuotaPeriod } from "./quota-observation.js";

/** Where a rung-2 limit may come from, in precedence order (see resolveRemaining). */
export type LimitProvenance = "provider-stated" | "configured" | "learned" | "published";

export interface LocalUsedReading {
  /** Tokens or requests consumed in the current period by THIS credential/deployment. */
  readonly value: number | null;
  /** How the ledger obtained it; null when there is no reading at all. */
  readonly basis: "reported" | "estimated" | "mixed" | null;
}

/** The limits a caller has already resolved, each optional — absent until its gap lands. */
export interface LimitInputs {
  configured?: number | null;
  learned?: number | null;
  /**
   * A catalog-published rate limit (Gap 13). Absent/undefined until then; accepted now so this
   * ladder does not need to change shape when the rung lands.
   */
  published?: number | null;
}

export interface ResolveRemainingInput {
  /** Provider-stated observations for exactly this (scope, axis, period); newest wins per tuple. */
  observations: readonly QuotaObservation[];
  axis: QuotaAxis;
  period: QuotaPeriod;
  limits?: LimitInputs;
  localUsed: LocalUsedReading;
  now: number;
}

/** The §5.1 output: a remaining figure plus everything needed to say where it came from. */
export interface RemainingResolution {
  remaining: number | null;
  /**
   * `derived:provider-stated` covers rung 2 against a header-observed limit whose REMAINING half
   * went stale: the limit was stated, the arithmetic was ours, and neither label alone is true.
   */
  basis: "provider-stated" | "derived:provider-stated" | "derived:configured" | "derived:learned" | "derived:published" | null;
  limit: number | null;
  limitBasis: "provider-stated" | "configured" | "learned" | "published" | null;
  localUsed: number | null;
  localUsedBasis: "reported" | "estimated" | "mixed" | null;
  /** The observation rung 1 used, when it did. Staleness and eligibility live here, not in data. */
  eligibleObservation: QuotaObservation | null;
  staleObservations: number;
  /**
   * May this figure gate routing (spec §5.4 / decision M2)? Only what the provider itself stated,
   * or what the operator asserted in config, qualifies. A derived:learned remaining comes from a
   * regex over vendor prose — displayed from day one, never allowed to throttle on its own.
   */
  routingEligible: boolean;
}

/** Rung-2 remaining basis for each limit provenance; a null basis never reaches this map. */
const DERIVED_BASIS = {
  "provider-stated": "derived:provider-stated",
  configured: "derived:configured",
  learned: "derived:learned",
  published: "derived:published",
} as const;

/**
 * UTC period boundaries (spec §5.2 ⚠ C4): providers overwhelmingly reset on UTC or a fixed vendor
 * timezone, so EVERY provider-facing boundary here cuts on UTC. No local time anywhere. Month
 * boundaries use real month lengths (leap years included) via Date.UTC normalization.
 */
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function periodStart(now: number, period: QuotaPeriod): number | null {
  if (!Number.isFinite(now)) return null;
  const at = new Date(now);
  switch (period) {
    case "minute":
      return Math.floor(now / MINUTE_MS) * MINUTE_MS;
    case "day":
      return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
    case "month":
      return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
    case "unknown":
      return null;
  }
}

export function periodEnd(now: number, period: QuotaPeriod): number | null {
  const start = periodStart(now, period);
  if (start === null) return null;
  const at = new Date(start);
  switch (period) {
    // Next minute/day boundaries are simple offsets; month length varies, so let Date.UTC
    // normalize month+1 day-1 → the first instant of the NEXT month.
    case "minute":
      return start + MINUTE_MS;
    case "day":
      return start + DAY_MS;
    case "month":
      return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
    case "unknown":
      return null;
  }
}

function withinCurrentPeriod(observedAt: number, now: number, period: QuotaPeriod): boolean {
  if (!Number.isFinite(observedAt) || observedAt > now) return false;
  const start = periodStart(now, period);
  return start !== null && observedAt >= start;
}

/**
 * Rung 1 eligibility: the observation must have been made WITHIN THE CURRENT PERIOD (UTC) and not
 * in the future. An observation from yesterday's minute window says nothing about this one — but
 * its `limit` half remains durable knowledge and feeds rung 2 below, which is why staleness is
 * reported as a count instead of discarding the row.
 */
function eligibleObservation(
  observations: readonly QuotaObservation[],
  now: number,
  axis: QuotaAxis,
  period: QuotaPeriod,
): { eligible: QuotaObservation | null; staleCount: number } {
  let eligible: QuotaObservation | null = null;
  let staleCount = 0;
  for (const candidate of observations) {
    // The bucket is (axis, period): a tokens/minute observation must never answer a
    // requests/minute question even when it is the freshest thing on the cell.
    if (candidate.axis === axis && candidate.period === period) {
      // Newest-wins per tuple; ties keep the first seen (callers merge newest-first).
      if (withinCurrentPeriod(candidate.observedAt, now, period)) {
        eligible ??= candidate;
      } else {
        staleCount += 1;
      }
    }
  }
  return { eligible, staleCount };
}

/**
 * Rung 2's LIMIT, when several provenances offer one.
 *
 * provider-stated > configured > learned > published, justified:
 * - A limit read off THIS deployment's response header is first-party evidence about the exact
 *   quota window being resolved. Even an old observation's limit stays usable — a header limit is
 *   a statement about entitlement, not point-in-time state, and nothing fresher contradicts it.
 * - An operator-declared figure outranks a parsed one because the operator can see their plan;
 *   `configured` is also the only rung whose wording was validated against a closed axis list.
 * - `learned` came from a regex over refusal prose — real evidence, but parse-risky, so it ranks
 *   below both statements.
 * - `published` (Gap 13) ranks last: catalogue figures are generic and frequently stale for free
 *   rosters (the context-window measurement recorded 0 of 29 pool/high members publishing any).
 */
export function resolveLimit(
  input: Pick<ResolveRemainingInput, "observations" | "axis" | "period" | "limits">,
): { limit: number | null; basis: RemainingResolution["limitBasis"] } {
  // Same tuple rule as rung 1: a limit stated for the tokens axis is not this requests-axis
  // bucket's ceiling, however fresh it is.
  const bucket = input.observations.find(
    (observation) => observation.axis === input.axis && observation.period === input.period,
  );
  if (
    bucket?.limit !== undefined &&
    Number.isFinite(bucket.limit) &&
    bucket.limit > 0
  ) {
    return { limit: bucket.limit, basis: "provider-stated" };
  }
  const candidates: ReadonlyArray<{ value: number | undefined | null; basis: Exclude<LimitProvenance, "provider-stated"> }> = [
    { value: input.limits?.configured, basis: "configured" },
    { value: input.limits?.learned, basis: "learned" },
    { value: input.limits?.published, basis: "published" },
  ];
  for (const candidate of candidates) {
    if (typeof candidate.value === "number" && Number.isFinite(candidate.value) && candidate.value > 0) {
      return { limit: candidate.value, basis: candidate.basis };
    }
  }
  return { limit: null, basis: null };
}

/** The spec §5.1 ladder, one call per (scope, axis, period). */
export function resolveRemaining(input: ResolveRemainingInput): RemainingResolution {
  const localUsedValue =
    typeof input.localUsed.value === "number" && Number.isFinite(input.localUsed.value)
      ? input.localUsed.value
      : null;

  const { eligible, staleCount } = eligibleObservation(input.observations, input.now, input.axis, input.period);
  if (eligible !== null) {
    return {
      remaining: eligible.remaining,
      basis: "provider-stated",
      limit: eligible.limit,
      limitBasis: "provider-stated",
      localUsed: localUsedValue,
      localUsedBasis: input.localUsed.basis,
      eligibleObservation: eligible,
      staleObservations: staleCount,
      routingEligible: true,
    };
  }

  const { limit, basis: limitBasis } = resolveLimit(input);
  if (limit !== null && localUsedValue !== null) {
    // NOT clamped: a negative remaining is information — it says this credential overshot its
    // ceiling — and clamping would turn that into a plausible-looking zero. Renderers clamp.
    return {
      remaining: limit - localUsedValue,
      // limitBasis is non-null here because `limit` is.
      basis: DERIVED_BASIS[limitBasis!],
      limit,
      limitBasis,
      localUsed: localUsedValue,
      localUsedBasis: input.localUsed.basis,
      eligibleObservation: null,
      staleObservations: staleCount,
      // M2: only figures derived from a STATEMENT (header or operator config) are trustworthy
      // enough to act on. Learned prose-parses and catalog borrowings stay display-only.
      routingEligible: limitBasis === "configured" || limitBasis === "provider-stated",
    };
  }

  // Rung 3: unknown means NO OPINION — never 0, never "unlimited".
  return {
    remaining: null,
    basis: null,
    limit,
    limitBasis,
    localUsed: localUsedValue,
    localUsedBasis: input.localUsed.basis,
    eligibleObservation: null,
    staleObservations: staleCount,
    routingEligible: false,
  };
}

export type ResetsAtResolution = {
  resetsAt: number | null;
  basis: "provider-stated" | "reviewed-rule" | "derived-boundary" | null;
};

/**
 * The §5.2 ladder. Rung 1 (provider-stated) carries the same read-time eligibility rule as §5.1:
 * a stated reset must still be in the future, else it is declined and the next rung answers.
 *
 * `providerStated` / `reviewedRule` arrive pre-resolved: the request path already applies
 * ResetRules beside header parses (`server.ts` resolveResetMs), and re-parsing vendor prose here
 * would risk two readers disagreeing about one response. This module only decides WHICH rung wins
 * and computes the fallback boundary.
 */
export function resolveResetsAt(input: {
  providerStated: number | null;
  reviewedRule: number | null;
  period: QuotaPeriod;
  now: number;
}): ResetsAtResolution {
  // A provider-stated reset must still be IN THE FUTURE to be authoritative. A skewed header or
  // an observation whose reset passed while the period had not (freellmapi's UPDATE-on-read makes
  // this observable) would otherwise render a reset time that has already passed — ranked ABOVE
  // the correct derived-boundary rung. Non-future ⇒ ineligible, same read-time eligibility shape
  // as rung 1; the ladder falls through rather than repairing the value.
  if (input.providerStated !== null && Number.isFinite(input.providerStated) && input.providerStated > input.now) {
    return { resetsAt: input.providerStated, basis: "provider-stated" };
  }
  if (input.reviewedRule !== null && Number.isFinite(input.reviewedRule)) {
    return { resetsAt: input.reviewedRule, basis: "reviewed-rule" };
  }
  const end = periodEnd(input.now, input.period);
  if (end !== null) return { resetsAt: end, basis: "derived-boundary" };
  return { resetsAt: null, basis: null };
}

// ── Dashboard-contract vocabulary mapping ───────────────────────────────────────────────────────

import type { LimitBasis, LocalUsedBasis, RemainingBasis } from "./dashboard-contract.js";

/**
 * Map internal bases onto the dashboard wire vocabulary in ONE place, so the producer and the
 * contract cannot drift. `derived:published` maps onto `derived_configured`'s sibling spelling
 * `derived_published`, added to the contract additively (see the design-doc note dated 2026-08-22).
 */
export function mapRemainingBasis(basis: RemainingResolution["basis"]): RemainingBasis | null {
  switch (basis) {
    case "provider-stated":
      return "provider_stated";
    case "derived:provider-stated":
      return "derived_provider_stated";
    case "derived:configured":
      return "derived_configured";
    case "derived:published":
      return "derived_published";
    case "derived:learned":
      return "derived_learned";
    default:
      return null;
  }
}

export function mapLimitBasis(basis: RemainingResolution["limitBasis"]): LimitBasis | null {
  switch (basis) {
    case "provider-stated":
      return "provider_stated";
    case "configured":
      return "configured";
    case "learned":
      return "learned";
    case "published":
      return "published";
    default:
      return null;
  }
}

export type { LimitBasis, LocalUsedBasis, RemainingBasis };
