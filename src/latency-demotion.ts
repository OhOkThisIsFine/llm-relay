/**
 * Sustained LATENCY as a demotion term — the sibling of `quota-demotion.ts`.
 *
 * ⚠ **This deliberately reverses a rationale recorded in place, by OWNER DECISION (2026-08-30).**
 * `server.ts` argues against re-ranking on stability, in these words: a second ranking pass
 * "means neither decides the order", and "live health then PROMOTES on evidence that is often a
 * single request's latency". That objection was shown to the owner with this option's cost stated,
 * and the owner chose this option anyway. So a later reader must NOT treat this module as drift
 * and "restore" the old behaviour as a regression fix. The objection was also right about the
 * failure modes, and every bound below is a direct answer to one of them:
 *
 * - **Demote only.** Never promote, never drop, never re-sort. The objection is about a competing
 *   ranking PASS; a one-way term folded into `targetUsability` is not one. Fitness still decides
 *   the order, exactly as it does for quota.
 * - **Never act on one request's latency.** `p95` over at least `minSamples` MEASURABLE samples,
 *   which is the objection's own worst case ruled out by construction.
 * - **Unmeasured has NO effect whatsoever.** `getP95` answers `Infinity` when nothing measurable
 *   was sampled, and `Infinity` is not a slow deployment — it is an unmeasured one. Treating it as
 *   slow would demote every never-probed member, which is the "unknown stays null, never 0"
 *   invariant broken in the most damaging possible direction.
 *
 * WHY IT EXISTS. Measured 2026-08-30: an offload lane read as "stalled" was in fact paying the
 * relay's own candidate walk — single requests took 120-123 s across 2-6 attempts. Five top-ranked
 * `pool/medium` members carried an OPEN breaker, and `nim/deepseek-ai/deepseek-v4-flash` was
 * breaker-CLOSED with a p95 of 70364 ms. Because health banding read breaker state and nothing
 * else, that healthy-but-glacial member was walked AHEAD of every cooling one. Evidence:
 * `docs/backlog.md`.
 *
 * ⚠ **NO breaker cooldown is registered, and that is the design, not an omission.** Quota
 * demotion can register one because its evidence STATES a `resetsAt`. Latency states no reset, and
 * this relay never invents a cooldown duration — so instead the term is re-resolved from the
 * rolling sample window on every request, which means it lifts BY ITSELF as soon as the
 * measurement recovers, with no expiry anybody had to guess. The cost, stated: a latency demotion
 * is invisible to `/candidates`' cooldown column and to the dashboard Cooldowns panel, because
 * those read breaker state. The response header is its surface.
 *
 * Pure and bounded: no IO and no clock of its own beyond what the caller passes. The factory wraps
 * everything in try/catch — this runs on the request path, and a routing hint must never be able
 * to fail a request. It logs nothing: routing is not an error stream.
 */
import type { CircuitBreaker } from "./circuit-breaker.js";
import type { LatencyDemotionConfig } from "./config.js";
import type { ResolvedAttempt } from "./resolved-attempt.js";
import { getP95 } from "./ping/metrics.js";

/**
 * Tunable defaults. These are TUNABLES, not provider facts, which is the distinction the
 * "a guess must never be labelled a measurement" invariant draws — it forbids inventing an
 * unpublished provider limit, price or context ceiling, and explicitly permits a tunable default.
 *
 * The figures are nonetheless calibrated against real measurement rather than picked: in the
 * window that motivated this module the member that actually SERVED had a p95 of 23478 ms and
 * answered, while the member that burned the walk had 70364 ms. 30000 ms sits between them, so
 * the default demotes the one that was costing whole requests and leaves the one that was working.
 */
export const DEFAULT_LATENCY_P95_MS = 30_000;

/**
 * Minimum MEASURABLE samples before latency may demote anything. Five is the smallest count for
 * which a p95 is not simply "the worst of a handful", and it is the direct answer to the recorded
 * objection about acting on a single request's latency.
 */
export const DEFAULT_LATENCY_MIN_SAMPLES = 5;

/** One sustained-latency verdict — the smallest honest statement of "why this cell stepped aside". */
export interface LatencyDemotion {
  /** Measured 95th-percentile round-trip in ms. Finite by construction. */
  readonly p95Ms: number;
  /** The ceiling it exceeded. Operator-configured, or the tunable default above. */
  readonly thresholdMs: number;
  /** How many measurable samples backed the figure. Never below `minSamples`. */
  readonly samples: number;
}

export type LatencyDemotionFn = (attempt: ResolvedAttempt, now: number) => LatencyDemotion | null;

export interface LatencyDemotionDeps {
  readonly breaker: CircuitBreaker;
  /**
   * ⚠ The SHAPE is owned by `config.ts` (`LatencyDemotionConfig`) and imported, never re-declared
   * here. Two hand-written copies of one settings object is a defect class this codebase has hit
   * repeatedly — `dashboard-routes.ts` restated a closed union, `availability.ts` carried three
   * copies of one key format — and the copies always drift. `config.ts` also normalizes the
   * boolean shorthand away, so this module never has to decide what `false` means.
   */
  readonly settings?: LatencyDemotionConfig | undefined;
}

/** Resolve the three knobs once. Absent, or an empty object, means every default. */
function resolveSettings(settings: LatencyDemotionConfig | undefined): {
  enabled: boolean;
  p95Ms: number;
  minSamples: number;
} {
  return {
    enabled: settings?.enabled ?? true,
    p95Ms: settings?.p95Ms ?? DEFAULT_LATENCY_P95_MS,
    minSamples: settings?.minSamples ?? DEFAULT_LATENCY_MIN_SAMPLES,
  };
}

/**
 * ⚠ `getP95` counts only `MEASURABLE_CODES` (200/401), so `pings.length` is an OVERCOUNT of the
 * samples behind the figure — a deployment with fifty 429s and one 200 would clear a `minSamples`
 * test written against `pings.length` on the strength of a single measurement, which is exactly
 * the case the sample floor exists to exclude. Count the same set `getP95` measured.
 */
const MEASURABLE_CODES = new Set(["200", "401"]);

export function resolveLatencyDemotion(
  deps: LatencyDemotionDeps,
  attempt: ResolvedAttempt,
): LatencyDemotion | null {
  const { enabled, p95Ms, minSamples } = resolveSettings(deps.settings);
  if (!enabled) return null;

  const measurement = deps.breaker.getDeploymentMeasurement({
    provider: attempt.target.provider,
    // ⚠ `ProviderDeploymentIdentity.model` is `string | null`, and an ABSENT model is `null` here
    // rather than `undefined` — coercing it the other way would build an identity that matches no
    // stored cell, so the lookup would silently return an empty measurement and this term would
    // quietly never fire.
    model: attempt.target.model ?? null,
  });
  const samples = measurement.pings.filter((p) => MEASURABLE_CODES.has(p.code)).length;
  // Too little evidence is NOT slowness. Same direction as every other unknown here.
  if (samples < minSamples) return null;

  const p95 = getP95([...measurement.pings]);
  // Infinity means "nothing measurable was sampled", never "infinitely slow" — and treating it as
  // slow would demote every never-probed deployment at once.
  //
  // ⚠ Mutation-checked 2026-08-30, and the honest result is worth recording rather than dressing
  // up: this guard is UNREACHABLE as the code stands. The sample floor above already counts the
  // same MEASURABLE set `getP95` measures, so reaching this line guarantees at least `minSamples`
  // finite samples, and deleting the guard leaves the suite fully green. It is kept as defense in
  // depth because the two checks are only equivalent while the floor precedes it — reorder them,
  // or widen the floor to raw `pings.length`, and this becomes load-bearing in the one direction
  // that is unrecoverable. Do NOT read its green mutation as a weak test; read it as redundancy.
  if (!Number.isFinite(p95)) return null;
  if (p95 <= p95Ms) return null;

  return { p95Ms: p95, thresholdMs: p95Ms, samples };
}

/**
 * Build the request-path evaluator. The wrapper is the safety seam: NOTHING inside may throw into
 * the request path, and a failure degrades to "no opinion" — the pre-2026-08-30 behaviour — rather
 * than to a refused request. Deliberately silent: routing hints are not log-worthy events.
 */
export function createLatencyDemotionFn(deps: LatencyDemotionDeps): LatencyDemotionFn {
  return (attempt) => {
    try {
      return resolveLatencyDemotion(deps, attempt);
    } catch {
      return null;
    }
  };
}

/** `"<spec> (p95 70364ms > 30000ms over 12 samples)"` — bounded, metadata only. */
export function latencyDemotionLabel(spec: string, demotion: LatencyDemotion): string {
  return `${spec} (p95 ${demotion.p95Ms}ms > ${demotion.thresholdMs}ms over ${demotion.samples} samples)`;
}
