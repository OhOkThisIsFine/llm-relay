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
 * - **Never act on one request's latency.** Every figure is a p95 over at least `minSamples`
 *   qualifying samples — the objection's own worst case, ruled out by construction.
 * - **Unmeasured has NO effect whatsoever.** Both statistics answer `Infinity` when nothing
 *   qualifies, and `Infinity` is an UNMEASURED deployment, never an infinitely slow one. Treating
 *   it as slow would demote every never-probed member, which is the "unknown stays null, never 0"
 *   invariant broken in the most damaging possible direction.
 *
 * WHY IT EXISTS. Measured 2026-08-30: an offload lane read as "stalled" was in fact paying the
 * relay's own candidate walk — single requests took 120-123 s across 2-6 attempts. Five top-ranked
 * `pool/medium` members carried an OPEN breaker, and `nim/deepseek-ai/deepseek-v4-flash` was
 * breaker-CLOSED with a p95 of 70364 ms. Because health banding read breaker state and nothing
 * else, that healthy-but-glacial member was walked AHEAD of every cooling one. Evidence:
 * `docs/backlog.md`.
 *
 * ⚠ **WHICH DATASET — the answer changed once already, so it is stated plainly.** This reads the
 * PROBE dataset (`probe-cache.json`, through the injected `readPings` seam), which is what
 * `llm-relay candidates` displays and which SURVIVES A RESTART. It briefly read the BREAKER's
 * pings instead; those are request-path only, in memory only, and never written by `PingLoop`, so
 * the term went inert after every restart and could disagree with the surface an operator reads.
 * Owner decision, same day: use the probe dataset, and EXPAND it to carry request latency too
 * (`probe-cache.ts` `recordRequestSample`).
 *
 * ⚠ **TWO STATISTICS, because absolute latency alone cannot compare a probe with a generation.**
 * A probe asks for one token; a real request may generate hundreds, amortising the same fixed
 * overhead. So:
 *   - **per-token** (`getP95MsPerToken`) is the primary signal, over REQUEST samples only. It is
 *     what the owner asked for, and the only figure that is fair across sample kinds.
 *   - **absolute** (`getP95`) is the fallback, over measurable **PROBE** samples only. It still
 *     catches a deployment that is slow before it emits anything, and it works before any request
 *     sample exists.
 * Per-token is tested FIRST, so a deployment with real traffic is judged on the better evidence
 * rather than on whichever ceiling happens to trip first.
 *
 * ⚠ **The absolute fallback reads PROBE samples ONLY, and that split is load-bearing
 * (2026-08-30).** It briefly read every measurable sample, request samples included, which put a
 * probe-calibrated ceiling in front of generation data — the exact comparison the paragraph above
 * says cannot be made. Measured live: `nim/nvidia/nemotron-3-ultra-550b-a55b`, which had served 59
 * of this machine's 62 successful requests, answered one request with 632 tokens in 34863 ms. That
 * is **55.2 ms/token** against a 250 ceiling — healthy by the primary signal — yet it pushed the
 * mixed absolute p95 to 34863 and DEMOTED the deployment. Probe-only, the same deployment reads
 * 23478 ms and is not demoted. The per-token guard could not save it, because per-token engages
 * only at `minSamples` REQUEST samples and it had three. So a deployment demoted itself by
 * succeeding, inside a window every deployment passes through on its way to being measured.
 * ⚠ A request sample with NO token count therefore reaches NEITHER statistic. That is deliberate:
 * it is a generation of unknown length, so it is not normalisable and not what `p95Ms` describes.
 * Evidence: `docs/latency-demotion-regression-2026-08-30.md`.
 *
 * ⚠ **NO breaker cooldown is registered, and that is the design, not an omission.** Quota demotion
 * can register one because its evidence STATES a `resetsAt`. Latency states no reset, and this
 * relay never invents a cooldown duration — so instead the term is re-resolved from the rolling
 * sample window on every request, which means it lifts BY ITSELF as soon as the measurement
 * recovers, with no expiry anybody had to guess. The cost, stated: a latency demotion is invisible
 * to `/candidates`' cooldown column and to the dashboard Cooldowns panel, because those read
 * breaker state. The response header is its surface.
 *
 * Pure and bounded: no IO and no clock of its own. The factory wraps everything in try/catch —
 * this runs on the request path, and a routing hint must never be able to fail a request. It logs
 * nothing: routing is not an error stream.
 */
import type { LatencyDemotionConfig } from "./config.js";
import type { ResolvedAttempt } from "./resolved-attempt.js";
import {
  MEASURABLE_CODES,
  countMsPerTokenSamples,
  getP95,
  getP95MsPerToken,
  type PingRecord,
} from "./ping/metrics.js";

/**
 * Tunable defaults. These are TUNABLES, not provider facts, which is the distinction the
 * "a guess must never be labelled a measurement" invariant draws — it forbids inventing an
 * unpublished provider limit, price or context ceiling, and explicitly permits a tunable default.
 *
 * ⚠ Both are nonetheless CALIBRATED against this machine's own traffic rather than picked, and the
 * measurement is recorded here so it can be re-run:
 *
 * - **`msPerToken` = 250.** Over 68 real requests (2026-08-30) the population ran p50 40.4,
 *   p75 70.5, p90 292.0, p95 967.1 ms/token. Per deployment the separation was clean: a healthy
 *   `nemotron-3-ultra` at a median 36.3 and `minimax-m3` at 57.3, against `gemini-3.6-flash` at
 *   687.8. 250 sits about 3.5x above the healthy band and well under the bad one, so it demotes
 *   the deployment that was costing whole requests and leaves the ones that were working.
 * - **`p95Ms` = 30000.** The fallback ceiling, from the same window: the member that actually
 *   SERVED had an absolute p95 of 23478 ms, the one that burned the walk 70364 ms.
 */
export const DEFAULT_LATENCY_MS_PER_TOKEN = 250;
export const DEFAULT_LATENCY_P95_MS = 30_000;

/**
 * Minimum qualifying samples before latency may demote anything, applied to EACH statistic against
 * its own sample set. Five is the smallest count for which a p95 is not simply "the worst of a
 * handful", and it is the direct answer to the recorded objection about acting on a single
 * request's latency.
 */
export const DEFAULT_LATENCY_MIN_SAMPLES = 5;

/** One sustained-latency verdict — the smallest honest statement of "why this cell stepped aside". */
export interface LatencyDemotion {
  /** Which statistic crossed its ceiling. Per-token wins when it has enough evidence. */
  readonly basis: "per-token" | "absolute";
  /** The measured figure: ms/token for `per-token`, ms for `absolute`. Finite by construction. */
  readonly measured: number;
  /** The ceiling it exceeded, in the same unit. */
  readonly threshold: number;
  /** Qualifying samples behind `measured`. Never below `minSamples`. */
  readonly samples: number;
}

export type LatencyDemotionFn = (attempt: ResolvedAttempt, now: number) => LatencyDemotion | null;

/**
 * How this module reads latency samples.
 *
 * ⚠ A plain function, NOT a `PingLoop`. Keeping the seam narrow is what lets this module stay pure
 * and testable, and it means nothing here can reach into probe scheduling or quota state. The
 * server passes `PingLoop.getModelPings`; the suite passes an array.
 */
export type PingReader = (provider: string, model: string) => readonly PingRecord[];

export interface LatencyDemotionDeps {
  readonly readPings: PingReader;
  /**
   * ⚠ The SHAPE is owned by `config.ts` (`LatencyDemotionConfig`) and imported, never re-declared
   * here. Two hand-written copies of one settings object is a defect class this codebase has hit
   * repeatedly, and the copies always drift. `config.ts` also normalizes the boolean shorthand
   * away, so this module never has to decide what `false` means.
   */
  readonly settings?: LatencyDemotionConfig | undefined;
}

/** Resolve the knobs once. Absent, or an empty object, means every default. */
function resolveSettings(settings: LatencyDemotionConfig | undefined): {
  enabled: boolean;
  p95Ms: number;
  msPerToken: number;
  minSamples: number;
} {
  return {
    enabled: settings?.enabled ?? true,
    p95Ms: settings?.p95Ms ?? DEFAULT_LATENCY_P95_MS,
    msPerToken: settings?.msPerToken ?? DEFAULT_LATENCY_MS_PER_TOKEN,
    minSamples: settings?.minSamples ?? DEFAULT_LATENCY_MIN_SAMPLES,
  };
}

export function resolveLatencyDemotion(
  deps: LatencyDemotionDeps,
  attempt: ResolvedAttempt,
): LatencyDemotion | null {
  const { enabled, p95Ms, msPerToken, minSamples } = resolveSettings(deps.settings);
  if (!enabled) return null;

  // No model means no deployment key, so there are no samples to read and no opinion to give.
  const model = attempt.target.model;
  if (typeof model !== "string" || model.length === 0) return null;
  const pings = [...deps.readPings(attempt.target.provider, model)];

  // PER-TOKEN FIRST: it is the fair comparison across probe and request samples, so a deployment
  // carrying real traffic is judged on the better evidence.
  const perTokenSamples = countMsPerTokenSamples(pings);
  if (perTokenSamples >= minSamples) {
    const rate = getP95MsPerToken(pings);
    // `Infinity` means "nothing qualified", never "infinitely slow". Unreachable while the count
    // above uses the SAME filter — kept because the two are only equivalent while that holds.
    if (Number.isFinite(rate)) {
      // ⚠ **Per-token is FINAL when it has evidence — it does not fall through to the absolute
      // ceiling.** Caught by a test: a member answering in 40 s with 1000 tokens is 40 ms/token,
      // squarely healthy, yet the absolute ceiling of 30000 ms would still have demoted it. Then
      // "primary signal" would mean nothing, and the very case per-token exists to protect — a
      // fast deployment that simply produced a long answer — would be demoted anyway.
      return rate > msPerToken
        ? { basis: "per-token", measured: rate, threshold: msPerToken, samples: perTokenSamples }
        : null;
    }
  }

  // ABSOLUTE FALLBACK: catches a deployment that is slow before it emits anything, and it works
  // before any request sample exists at all.
  //
  // ⚠ PROBE samples only. `p95Ms` is calibrated on a `max_tokens: 1` probe, so measuring a real
  // generation against it compares two different things — see the units note in the module header
  // and the measured regression it caused. ABSENT `source` means "probe", so this is the
  // documented test and it keeps every pre-2026-08-30 sample in scope.
  const probeSamples = pings.filter((p) => p.source !== "request");
  const absoluteSamples = probeSamples.filter((p) => MEASURABLE_CODES.has(p.code)).length;
  if (absoluteSamples < minSamples) return null;
  const p95 = getP95(probeSamples);
  if (!Number.isFinite(p95)) return null;
  if (p95 <= p95Ms) return null;
  return { basis: "absolute", measured: p95, threshold: p95Ms, samples: absoluteSamples };
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

/**
 * `"<spec> (p95 687.8ms/token > 250ms/token over 8 request samples)"`, or the absolute form.
 * Bounded, metadata only — a rate and a count, never a prompt, a credential or an id.
 */
export function latencyDemotionLabel(spec: string, demotion: LatencyDemotion): string {
  const perToken = demotion.basis === "per-token";
  const unit = perToken ? "ms/token" : "ms";
  const kind = perToken ? "request samples" : "samples";
  const measured = perToken ? demotion.measured.toFixed(1) : String(demotion.measured);
  return `${spec} (p95 ${measured}${unit} > ${demotion.threshold}${unit} over ${demotion.samples} ${kind})`;
}
