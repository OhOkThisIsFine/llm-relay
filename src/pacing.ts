/**
 * Self-pacing against a STATED rate limit — the relay holding its OWN request rate under a
 * ceiling a deployment told it about, BEFORE the next 429 (owner direction 2026-09-10: *"The relay
 * should be tracking requests from all IDEs on the machine, anything that runs through the relay,
 * so it can use rate-limited messages to calculate when it might need to slow something down."*).
 *
 * The third demotion term beside `quota-demotion.ts` and `latency-demotion.ts`, same shape — a
 * pure resolver, a `create…Fn` factory that can never throw into the request path, and a label —
 * folded into `targetUsability` as a one-way band. It answers a DIFFERENT question from quota
 * demotion, stated so the two are not read as one policy in two homes:
 *
 * - `quota-demotion.ts` is the ALLOWANCE view: a bucket whose `remaining` (stated, or a stated
 *   limit minus the ledger's usage in the current UTC-aligned period) is spent joins `cooling`
 *   until the reset the evidence stated.
 * - this module is the RATE view: how many attempts THIS relay itself started against the cell
 *   in the trailing window of the stated period, held against the stated ceiling. It reads the
 *   breaker's per-cell attempt-start log (`CircuitBreaker.attemptsInWindow`), which every egress on
 *   both fronts passes through, so every client on the machine that routes through the relay is
 *   counted — a Codex session and a Claude Code session share one cell's window.
 *
 * ⚠ A SLIDING window, deliberately: a count that never exceeds L in any trailing window cannot
 * exceed L in a provider's fixed window either, whichever alignment the provider uses — and the
 * relay is never told. The ledger's UTC-minute cell (what quota demotion reads) lets a burst at a
 * boundary run 2L in 61 seconds; this does not.
 *
 * ⚠ Three ceilings pace, ranked by `resolveLimit` (`availability.ts`): the provider's own header
 * `limit`, the operator's `limits` block, and a LEARNED `rate-limit-*` fact parsed from a 429 body
 * (`rate-limits.ts`). **The learned rung paces WITHOUT the `routing.quota.enforceLearned` opt-in.**
 * That is the owner's 2026-09-10 direction and the backlog property — "a 429 that states a window
 * updates that pacing without a human verdict" — and it is what makes the loop close live: the
 * request path records the fact at the 429, and the next `targetUsability` reads it. The M2 gate
 * inside `quota-demotion.ts` is untouched; it governs the allowance path, which can register a
 * breaker cooldown, while this term registers nothing and re-resolves per request. A `published`
 * (catalogue) figure never paces — `PACES_ON_LIMIT_BASIS` closes that decision.
 *
 * ⚠ **A limit nobody stated has NO EFFECT.** No bucket ⇒ null. A window the log cannot answer for
 * (a token sum with an unknown member, a saturated log below the ceiling) ⇒ null. There is no
 * tunable margin: the relay steps aside exactly at the stated figure, because "approaching" would
 * need a number nobody stated. Only `minute` and `day` periods are paced — the two a stated rate
 * limit names; `month` stays the allowance path's, and `unknown` has no window to count.
 *
 * ⚠ **Demote only; never drop, never refuse, never delay.** A paced cell joins the `paced` band
 * behind `live` and `slow` and ahead of the failure bands (`candidate-runner.ts`), so the next
 * request goes to another candidate while this one's window drains — and with no other candidate
 * it is still walked. Refusing on a count is the hard cap's business (`hard-cap.ts`), and only an
 * OPERATOR-declared figure may do that. Announced as `x-llm-relay-paced` when the walk's first
 * choice was displaced by it.
 *
 * ⚠ Stated residue: the count is the relay's own attempts. A probe (`ping/ping.ts`, one token) and
 * any traffic from outside the relay do not enter it, so the count is a floor of what the provider
 * meters — the fail-safe direction (less pacing), and the provider's 429 still teaches the cell.
 * Token windows sum the request's INPUT estimate only, for the same reason.
 */
import type { Config } from "./config.js";
import type { PacingConfig } from "./config-types.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import type { ProviderTargetIdentity } from "./kernel/contracts.js";
import type { ResolvedAttempt } from "./resolved-attempt.js";
import { parseCredentialId, type CredentialId } from "./credential-id.js";
import type { QuotaAxis, QuotaPeriod } from "./quota-observation.js";
import { resolveConfiguredLimits } from "./configured-limits.js";
import { observedRateLimits } from "./rate-limits.js";
import { collectQuotaBuckets, resolveLimit, type LimitProvenance } from "./availability.js";
import { bucketRank } from "./quota-demotion.js";

/** The two periods a stated rate limit names; `month` and `unknown` are never paced. */
export type PacingPeriod = Extract<QuotaPeriod, "minute" | "day">;

/** The trailing window each paced period reads — a total table, so a new period is a compile error. */
export const PACING_WINDOW_MS = {
  minute: 60_000,
  day: 86_400_000,
} as const satisfies Record<PacingPeriod, number>;

/**
 * Which limit provenances may PACE. ⚠ A total table closed with `satisfies`, not an `if` on the
 * two names it happened to know: `resolveLimit`'s basis union carries `published`, and an
 * unconditional fall-through would have paced on a catalogue figure — the closed-vocabulary
 * defect `CLAUDE.md` records eight times, falling to the STRONGER claim.
 */
const PACES_ON_LIMIT_BASIS = {
  "provider-stated": true,
  "configured": true,
  "learned": true,
  "published": false,
} as const satisfies Record<LimitProvenance, boolean>;

/** The basis a verdict may carry: exactly the provenances `PACES_ON_LIMIT_BASIS` admits. */
export type PacingLimitBasis = { [K in LimitProvenance]: (typeof PACES_ON_LIMIT_BASIS)[K] extends true ? K : never }[LimitProvenance];

/** One pacing verdict — the smallest honest statement of "why this cell steps aside for now". */
export interface PacingVerdict {
  readonly axis: QuotaAxis;
  readonly period: PacingPeriod;
  /** The stated ceiling. */
  readonly limit: number;
  /** Who stated it. */
  readonly limitBasis: PacingLimitBasis;
  /** Attempts this relay started (or their estimated INPUT tokens) inside the trailing window. ≥ `limit`. */
  readonly counted: number;
}

/** The per-request evaluator threaded through the walk-order helpers. Null ⇒ no opinion. */
export type PacingFn = (attempt: ResolvedAttempt, now: number) => PacingVerdict | null;

export interface PacingDeps {
  readonly cfg: Config;
  /** The breaker, narrowed to the two reads this term makes — it never writes to it. */
  readonly breaker: Pick<CircuitBreaker, "getState" | "attemptsInWindow">;
  /**
   * ⚠ The SHAPE is owned by `config-types.ts` (`PacingConfig`) and imported, never re-declared —
   * the `latency-demotion.ts` rule. `config/routing-parser.ts` normalizes the boolean shorthand
   * away, so this module never decides what `false` means.
   */
  readonly settings?: PacingConfig | undefined;
}

/** Resolve the knobs once. Absent, or an empty object, means the default — which is ON. */
export function resolvePacingSettings(settings: PacingConfig | undefined): { enabled: boolean } {
  return { enabled: settings?.enabled ?? true };
}

function isPacingPeriod(period: QuotaPeriod): period is PacingPeriod {
  return period === "minute" || period === "day";
}

/** The pacing verdict for ONE credential×deployment cell, from whatever ceilings were stated. */
export function resolvePacing(deps: PacingDeps, attempt: ResolvedAttempt, now: number): PacingVerdict | null {
  if (!resolvePacingSettings(deps.settings).enabled) return null;
  const { target } = attempt;
  const model = target.model ?? null;
  // No model means no deployment cell: nothing states a limit for it and nothing counts against it.
  if (model === null) return null;

  const identity: ProviderTargetIdentity = {
    provider: target.provider,
    model,
    kind: target.kind,
    credentialId: attempt.credentialId,
    ...(target.base ? { base: target.base } : {}),
  };
  const parsed = parseCredentialId(attempt.credentialId);
  const observations = deps.breaker.getState(identity)?.quotaObservations ?? [];
  const configured = resolveConfiguredLimits(deps.cfg, target.provider, parsed?.label ?? null, model);
  const learned = observedRateLimits(target.provider, attempt.credentialId as CredentialId, model, { now });
  const buckets = [...collectQuotaBuckets({ observations, learned, configured }).values()]
    .sort((a, b) => bucketRank(a.axis, a.period) - bucketRank(b.axis, b.period));

  for (const bucket of buckets) {
    if (!isPacingPeriod(bucket.period)) continue;
    const { limit, basis } = resolveLimit({
      observations: bucket.observations,
      axis: bucket.axis,
      period: bucket.period,
      limits: bucket.limits,
    });
    if (limit === null || basis === null || !PACES_ON_LIMIT_BASIS[basis]) continue;
    const window = deps.breaker.attemptsInWindow(identity, PACING_WINDOW_MS[bucket.period], now);
    const counted = bucket.axis === "requests" ? window.requests : window.estimatedInputTokens;
    // Unknown ⇒ no opinion: a token window with an unestimated member has no honest total, and a
    // saturated log below the ceiling is a floor that proves nothing about the ceiling.
    if (counted === null || !Number.isFinite(counted)) continue;
    if (counted < limit) continue;
    return {
      axis: bucket.axis,
      period: bucket.period,
      limit,
      // `basis` is narrowed by the table lookup above; the cast states what the guard proved.
      limitBasis: basis as PacingLimitBasis,
      counted,
    };
  }
  return null;
}

/**
 * Build the request-path evaluator. The wrapper is the safety seam: NOTHING inside may throw into
 * the request path, and a failure degrades to "no opinion" — the pre-pacing behaviour — rather
 * than to a refused request. Deliberately silent: routing hints are not log-worthy events.
 */
export function createPacingFn(deps: PacingDeps): PacingFn {
  return (attempt, now) => {
    try {
      return resolvePacing(deps, attempt, now);
    } catch {
      return null;
    }
  };
}

/**
 * `"<spec> (requests/minute 60 of 60 in the trailing minute, learned)"` — bounded, metadata only:
 * a spec, two counts and a provenance, never a prompt, a credential or an id. A token bucket says
 * so, because its count is an INPUT estimate and not what the provider metered.
 */
export function pacingLabel(spec: string, verdict: PacingVerdict): string {
  const unit = verdict.axis === "tokens" ? " estimated input tokens" : "";
  return `${spec} (${verdict.axis}/${verdict.period} ${verdict.counted} of ${verdict.limit}${unit} in the trailing ${verdict.period}, ${verdict.limitBasis})`;
}
