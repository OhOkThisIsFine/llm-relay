/**
 * When is an in-flight attempt slow enough to start the NEXT candidate beside it?
 *
 * ⚠ **This is the decision layer only. Nothing in this file duplicates a request, and nothing in
 * `src/` calls it yet — that is a deliberate intermediate state, declared here so it is not read
 * later as dead code.** The walk integration is stage 2; both request paths in `server.ts` are
 * serial `while` loops built around a single `await`, and turning that into a race is a separate,
 * larger change. Landing the decision first means its constants can be calibrated and its edge
 * cases pinned before any request behaviour moves.
 *
 * ⚠⚠ **STAGE 2 IS BLOCKED ON `CredentialWalk`, and the blocker is structural — read this before
 * attempting the wiring (found 2026-08-30, during that attempt).** The walk holds exactly ONE
 * `#pending` slot, and that is its documented contract: *"`next()` only offers a candidate. The
 * caller must call `recordStarted()` immediately before fetch/egress; that is the sole budget/LRU
 * mutation boundary."* Concretely, in `credential-select.ts`:
 *   - `next()` opens with `if (this.#pending) return this.#pending.attempt;` — while an attempt is
 *     in flight it re-offers **that same attempt**, so asking for a hedge candidate hands back the
 *     primary and the relay would fetch one deployment twice;
 *   - `recordStarted()` throws `"credential attempt already marked started"` on the second call;
 *   - `recordOutcome()` throws when the outcome does not match the single pending attempt.
 *
 * So hedging is not a restructuring of the loop — it first needs `CredentialWalk` to carry N
 * in-flight attempts, with its start budget, LRU touch and breadth-first ordering all still
 * correct. That is a change to a component whose whole job is being the one mutation boundary, and
 * it must be designed rather than patched around. Attempting the loop first would produce requests
 * that THROW, which is why this was worth finding before any of `server.ts` was touched.
 *
 * ⚠ **Hedging DUPLICATES, it does not reorder** — the first behaviour in this relay that does. The
 * `CLAUDE.md` invariant reads *"Acting on counts is optional, always announced, and may only
 * reorder"*, so the duplication is bounded three ways, all of them owner decisions recorded in
 * `docs/hedged-attempts-design-2026-08-30.md` §7: it is confined to deployments `assessCost()`
 * calls FREE (D1), the loser is aborted the moment a winner commits, and the response announces it.
 *
 * WHY IT EXISTS. Measured 2026-08-30: `nim/deepseek-ai/deepseek-v4-flash-0731` hung on 43
 * consecutive attempts, each costing the full 120000 ms provider timeout. The obvious remedy — a
 * shorter timeout — was measured and REJECTED by the data: successful `nim` requests run from
 * 559 ms to 96959 ms, so the working band reaches almost to the timeout, and a 25000 ms cap would
 * have cut 22.5% of real successes. **A timeout must choose between abandoning a slow success and
 * waiting out a hang; here the two are indistinguishable by duration.** A hedge does not choose.
 */
import { getP90, getP90MsPerToken, countMsPerTokenSamples, type PingRecord } from "./ping/metrics.js";

/**
 * Tunables. ⚠ **These are PLACEHOLDERS awaiting calibration, and that is stated rather than
 * hidden.** `DEFAULT_LATENCY_MS_PER_TOKEN` earned its 250 from 68 real requests, and these have no
 * such backing yet — the population they need is "how long did an attempt run before it produced
 * its first token", which this relay does not record today. Do not quote them as measurements, and
 * calibrate them against real traffic before the walk integration ships.
 */
export const DEFAULT_HEDGE_FLOOR_MS = 20_000;
export const DEFAULT_HEDGE_MARGIN = 2;
export const DEFAULT_HEDGE_MIN_SAMPLES = 5;

/** One hedge decision, carrying the evidence that produced it so the header can state it. */
export interface HedgeVerdict {
  /** Which statistic decided. `floor` means no per-deployment evidence applied — see below. */
  readonly basis: "per-token" | "absolute" | "floor";
  /** The elapsed time that crossed the bar, in ms. */
  readonly elapsedMs: number;
  /** The bar it crossed, in ms. Always finite. */
  readonly thresholdMs: number;
  /** Output tokens seen so far. 0 for a buffered attempt, or a stream that has emitted nothing. */
  readonly tokensSeen: number;
}

export interface HedgeSettings {
  readonly enabled: boolean;
  readonly floorMs: number;
  readonly margin: number;
  readonly minSamples: number;
}

export function resolveHedgeSettings(settings?: Partial<HedgeSettings>): HedgeSettings {
  return {
    enabled: settings?.enabled ?? true,
    floorMs: settings?.floorMs ?? DEFAULT_HEDGE_FLOOR_MS,
    margin: settings?.margin ?? DEFAULT_HEDGE_MARGIN,
    minSamples: settings?.minSamples ?? DEFAULT_HEDGE_MIN_SAMPLES,
  };
}

export interface HedgeInput {
  /** How long this attempt has been running. */
  readonly elapsedMs: number;
  /** Output tokens the attempt has produced so far. 0 when it has produced nothing. */
  readonly tokensSeen: number;
  /** This deployment's sample window, exactly as `latency-demotion.ts` reads it. */
  readonly pings: readonly PingRecord[];
  /**
   * Is this deployment FREE, per `assessCost()`?
   *
   * ⚠ Owner decision D1: hedging is on by default but confined to free deployments. `assessCost()`
   * treats UNKNOWN as paid, so this is fail-safe — a duplicate can never land on a deployment whose
   * price we cannot establish. The stated cost is that it will silently not fire on many members
   * whose prices are simply unpublished, and that reach grows for free as catalog coverage improves.
   */
  readonly isFree: boolean;
}

/**
 * Should a hedge start now?
 *
 * The ladder, in order, and each rung's reason:
 *
 * 1. **Disabled, or not free ⇒ never.** D1's containment, checked before anything is measured.
 * 2. **Per-token, when the attempt has produced tokens AND the deployment has `minSamples` real
 *    request samples.** This is the owner's rule implemented literally:
 *    `expected = p90_ms_per_token × tokens_seen`, hedge when elapsed exceeds it by `margin`. It is
 *    self-correcting — a deployment producing a long answer earns more time as it produces it.
 * 3. **Absolute p90 over PROBE samples**, when there is no per-token evidence but there is probe
 *    evidence. ⚠ Probe-only is not an optimisation: v0.65.2 exists because feeding request latency
 *    into a probe-calibrated statistic demotes the busiest healthy deployment first, and the same
 *    arithmetic would make a hedge fire on the deployment doing the most work.
 * 4. **The floor**, when nothing about this deployment is measured.
 *
 * ⚠ **Rung 4 is why an unmeasured deployment still gets hedged, which is the opposite of the rule
 * `latency-demotion.ts` follows — and the difference is deliberate.** Demotion PUNISHES, so
 * unmeasured must mean "no opinion" or a cold cache would demote everything. A hedge only starts a
 * second attempt that the walk was going to make anyway; the cost of hedging a deployment that was
 * about to answer is one wasted free request, while the cost of NOT hedging the hang this feature
 * exists for is 120 seconds. The asymmetry runs the other way, so the fallback does too.
 *
 * ⚠ **Every threshold is floored by `floorMs`.** Without it a deployment with a tiny p90 would be
 * hedged on ordinary noise, and a fast pool would duplicate almost every request.
 */
export function shouldHedge(input: HedgeInput, settings: HedgeSettings): HedgeVerdict | null {
  if (!settings.enabled) return null;
  if (!input.isFree) return null;
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) return null;

  const tokensSeen = Number.isFinite(input.tokensSeen) && input.tokensSeen > 0 ? input.tokensSeen : 0;
  const { basis, thresholdMs } = hedgeThreshold([...input.pings], tokensSeen, settings);
  return input.elapsedMs > thresholdMs
    ? { basis, elapsedMs: input.elapsedMs, thresholdMs, tokensSeen }
    : null;
}

/**
 * The ladder itself: which statistic applies, and what bar it sets.
 *
 * Separated from the comparison on purpose. There is exactly ONE `elapsedMs > threshold` test in
 * this module, so a rung cannot acquire its own subtly different comparison — and each rung is
 * reachable from a test without driving the whole decision.
 *
 * ⚠ **The first rung that HAS evidence wins, and it is final.** A healthy per-token rate is not
 * then re-checked against the absolute bar. That is the same rule `latency-demotion.ts` had to
 * learn the hard way: without it, a deployment answering in 40 s with 1000 tokens — 40 ms/token,
 * squarely healthy — is judged slow anyway by a bar meant for one-token probes.
 */
function hedgeThreshold(
  pings: PingRecord[],
  tokensSeen: number,
  settings: HedgeSettings,
): { basis: HedgeVerdict["basis"]; thresholdMs: number } {
  if (tokensSeen > 0 && countMsPerTokenSamples(pings) >= settings.minSamples) {
    const rate = getP90MsPerToken(pings);
    if (Number.isFinite(rate)) {
      return { basis: "per-token", thresholdMs: Math.max(settings.floorMs, rate * tokensSeen * settings.margin) };
    }
  }

  // PROBE samples only — see the note on rung 3 above.
  const probes = pings.filter((p) => p.source !== "request");
  if (probes.length >= settings.minSamples) {
    const p90 = getP90(probes);
    if (Number.isFinite(p90)) {
      return { basis: "absolute", thresholdMs: Math.max(settings.floorMs, p90 * settings.margin) };
    }
  }

  return { basis: "floor", thresholdMs: settings.floorMs };
}

/**
 * How long to wait before starting the hedge, for an attempt that has produced NOTHING yet.
 *
 * ⚠ **The threshold IS the delay.** `shouldHedge` asks "has this attempt already run too long";
 * a race asks "how long should I wait before starting the second one". They are the same number
 * viewed from either side, so this returns it rather than letting a caller derive a second one.
 *
 * ⚠ `tokensSeen` is 0 by construction here, and that is the honest input for the case this serves:
 * a race decided at RESPONSE RESOLUTION has, by definition, seen no tokens — the response has not
 * arrived. The per-token rung therefore cannot apply, which is correct rather than a limitation:
 * the measured hang produced no tokens for 120 s, so per-token could never have fired on it.
 *
 * Returns null when hedging is off or the deployment is not free — the D1 containment, applied
 * once, here, so no caller repeats it.
 */
export function hedgeDelayMs(
  pings: readonly PingRecord[],
  isFree: boolean,
  settings: HedgeSettings,
): number | null {
  return hedgeDelayDecision(pings, isFree, settings)?.delayMs ?? null;
}

/**
 * The same decision as `hedgeDelayMs`, carrying the RUNG that produced it.
 *
 * ⚠ Split out rather than folded into `hedgeDelayMs` so the shipped scalar signature is untouched.
 * The basis exists for one reason: the three constants above are declared placeholders, and an
 * operator cannot calibrate them without knowing which rung actually fired. `HEDGED_HEADER` states
 * it, so a hedged pool is calibratable from its own responses.
 */
export function hedgeDelayDecision(
  pings: readonly PingRecord[],
  isFree: boolean,
  settings: HedgeSettings,
): { readonly delayMs: number; readonly basis: HedgeVerdict["basis"] } | null {
  if (!settings.enabled || !isFree) return null;
  const { basis, thresholdMs } = hedgeThreshold([...pings], 0, settings);
  return { delayMs: thresholdMs, basis };
}

/** `"<spec> (28.4s > 20.0s, floor, 0 tokens seen)"` — bounded, metadata only, never content. */
export function hedgeLabel(spec: string, verdict: HedgeVerdict): string {
  const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  return `${spec} (${s(verdict.elapsedMs)} > ${s(verdict.thresholdMs)}, ${verdict.basis}, ${verdict.tokensSeen} tokens seen)`;
}
