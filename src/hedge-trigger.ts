/**
 * When is an in-flight attempt slow enough to start the NEXT candidate beside it?
 *
 * ⚠ **This is the decision layer only: nothing in this file duplicates a request.** The race lives
 * in `hedge-race.ts` and is WIRED on both fronts through `candidate-runner.ts`
 * `runAttemptWithHedge`, which calls `hedgeDelayDecision` below — stage 2 landed 2026-08-30. The
 * paragraph that used to stand here still said "nothing in `src/` calls it yet" and "stage 2 is
 * blocked on `CredentialWalk`" until 2026-09-04 (audit finding DR-014: prose rotted at the module
 * it described). The blocker it named was real and is closed: `credential-select.ts` now carries
 * `maxInFlight` attempts, and `next()` re-offers a pending-but-unstarted attempt — see that file.
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
import {
  MEASURABLE_CODES,
  getP90,
  getP90MsPerToken,
  countMsPerTokenSamples,
  type PingRecord,
} from "./ping/metrics.js";

/**
 * Tunables. ⚠ `DEFAULT_HEDGE_MARGIN` and `DEFAULT_HEDGE_MIN_SAMPLES` are still PLACEHOLDERS
 * awaiting calibration — the population they need ("how long did an attempt run before it produced
 * its first token") is not recorded today. Do not quote them as measurements.
 *
 * `DEFAULT_HEDGE_MIN_FLOOR_MS` and `DEFAULT_HEDGE_MS_PER_INPUT_TOKEN` are the two halves of the
 * FLOOR, and the floor is no longer flat (owner direction 2026-09-04): a large prompt takes a
 * healthy deployment real, unavoidable time just to read, so a size-blind floor either hedges every
 * big-prompt request on ordinary size, or leaves a genuinely hung SMALL request unhedged for tens
 * of seconds. The floor now GROWS with the request's own estimated input size:
 *
 *     floorMs = max(minFloorMs, msPerInputToken × estimatedInputTokens)
 *
 * `estimatedInputTokens` is the caller's own chars/4 estimate (`estimateRequestTokens` in
 * `metadata.ts`, already computed once per request for the context guardrail) — never a figure this
 * module invents on its own.
 *
 * `DEFAULT_HEDGE_MS_PER_INPUT_TOKEN` (0.15 ms/token) is the CALIBRATED default —
 * `scripts/calibrate-hedge-floor.mjs`, run 2026-09-04 against this machine's
 * `~/.llm-relay/usage/recent.json` (100 successful serve attempts, 55 of them carrying ≥10,000
 * input tokens). The chosen method was the p25 of (latencyMs ÷ inputTokens) ratios among requests
 * with ≥10,000 input tokens — deliberately NOT a per-deployment "which one is fast" classification,
 * which this machine's window cannot support robustly (five deployments in that slice, two with
 * only 1-2 samples each; hand-picking a "fast" set would itself be a guess). The p25 rung of the
 * large-prompt population approximates a healthy deployment's throughput once per-request fixed
 * overhead is amortised over a big prompt, without naming a deployment. ⚠ **The fit came back OUT
 * OF the sane range and was REJECTED, exactly as designed**: p25 measured 0.036 ms/token, below the
 * accepted [0.05, 0.5] band, so the script fell back to 0.15 rather than shipping a number this thin
 * a sample cannot support — the same fail-safe direction as an unmeasured latency or an unpublished
 * context ceiling elsewhere in this relay. Re-run the script as traffic accumulates; it keeps
 * landing on 0.15 until a fit lands inside the band.
 */
export const DEFAULT_HEDGE_MIN_FLOOR_MS = 3_000;
export const DEFAULT_HEDGE_MS_PER_INPUT_TOKEN = 0.15;
export const DEFAULT_HEDGE_MARGIN = 2;
export const DEFAULT_HEDGE_MIN_SAMPLES = 5;

/** One hedge decision, carrying the evidence that produced it so the header can state it. */
export interface HedgeVerdict {
  /**
   * Which statistic decided. `input-size` means no per-deployment evidence applied — the bar came
   * from the size-scaled floor alone. See below.
   */
  readonly basis: "per-token" | "absolute" | "input-size";
  /** The elapsed time that crossed the bar, in ms. */
  readonly elapsedMs: number;
  /** The bar it crossed, in ms. Always finite. */
  readonly thresholdMs: number;
  /** Output tokens seen so far. 0 for a buffered attempt, or a stream that has emitted nothing. */
  readonly tokensSeen: number;
}

export interface HedgeSettings {
  readonly enabled: boolean;
  /** The floor's flat component, in ms — see `DEFAULT_HEDGE_MIN_FLOOR_MS` above. */
  readonly minFloorMs: number;
  /** The floor's size-scaled component, in ms per estimated INPUT token. */
  readonly msPerInputToken: number;
  readonly margin: number;
  readonly minSamples: number;
}

/**
 * What `resolveHedgeSettings` accepts. `floorMs` is the LEGACY spelling of `minFloorMs`, honoured
 * only when `minFloorMs` itself is absent — the alias `config.ts` `parseHedge` keeps loading
 * byte-for-byte so an operator config written before 2026-09-04 (`{"floorMs": 8000}`) keeps meaning
 * exactly what it always meant: the floor never drops below 8000 ms. An explicit `minFloorMs` wins
 * when both are present, because it is the name a NEW config would deliberately choose.
 */
export interface HedgeSettingsInput {
  readonly enabled?: boolean;
  readonly minFloorMs?: number;
  /** Legacy alias of `minFloorMs`, kept for backward compatibility. */
  readonly floorMs?: number;
  readonly msPerInputToken?: number;
  readonly margin?: number;
  readonly minSamples?: number;
}

export function resolveHedgeSettings(settings?: HedgeSettingsInput): HedgeSettings {
  return {
    enabled: settings?.enabled ?? true,
    minFloorMs: settings?.minFloorMs ?? settings?.floorMs ?? DEFAULT_HEDGE_MIN_FLOOR_MS,
    msPerInputToken: settings?.msPerInputToken ?? DEFAULT_HEDGE_MS_PER_INPUT_TOKEN,
    margin: settings?.margin ?? DEFAULT_HEDGE_MARGIN,
    minSamples: settings?.minSamples ?? DEFAULT_HEDGE_MIN_SAMPLES,
  } satisfies HedgeSettings;
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
  /**
   * The relay's own chars/4 estimate of this request's INPUT size (`estimateRequestTokens` in
   * `metadata.ts`) — grows the floor under every rung. Never negative in practice; a non-finite or
   * non-positive value is treated as 0, i.e. no size contribution, the same fail-safe direction as
   * an unmeasured deployment.
   */
  readonly estimatedInputTokens: number;
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
 * 4. **The size-scaled floor**, when nothing about this deployment is measured.
 *
 * ⚠ **Rung 4 is why an unmeasured deployment still gets hedged, which is the opposite of the rule
 * `latency-demotion.ts` follows — and the difference is deliberate.** Demotion PUNISHES, so
 * unmeasured must mean "no opinion" or a cold cache would demote everything. A hedge only starts a
 * second attempt that the walk was going to make anyway; the cost of hedging a deployment that was
 * about to answer is one wasted free request, while the cost of NOT hedging the hang this feature
 * exists for is 120 seconds. The asymmetry runs the other way, so the fallback does too.
 *
 * ⚠ **Every threshold is floored by `max(minFloorMs, msPerInputToken × estimatedInputTokens)`.**
 * Without the flat component a deployment with a tiny p90 would be hedged on ordinary noise, and a
 * fast pool would duplicate almost every request; without the size-scaled component a large prompt
 * would be hedged against the time it simply takes a healthy deployment to read it.
 */
export function shouldHedge(input: HedgeInput, settings: HedgeSettings): HedgeVerdict | null {
  if (!settings.enabled) return null;
  if (!input.isFree) return null;
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) return null;

  const tokensSeen = Number.isFinite(input.tokensSeen) && input.tokensSeen > 0 ? input.tokensSeen : 0;
  const { basis, thresholdMs } = hedgeThreshold([...input.pings], tokensSeen, input.estimatedInputTokens, settings);
  return input.elapsedMs > thresholdMs
    ? { basis, elapsedMs: input.elapsedMs, thresholdMs, tokensSeen }
    : null;
}

/**
 * The floor under every rung, in ms.
 *
 * Owner direction 2026-09-04: a large prompt takes a healthy deployment real, unavoidable time just
 * to read, so this is no longer the flat `minFloorMs` alone — it grows with the request's own
 * estimated INPUT size. `minFloorMs` bounds the small-prompt case (where the size term is
 * negligible); `msPerInputToken × estimatedInputTokens` bounds the large-prompt one. See the
 * constants' own doc comment for the calibration.
 *
 * A non-finite or non-positive `estimatedInputTokens` contributes nothing — the same fail-safe
 * direction as every other "unknown has no effect" rule in this relay — so a malformed estimate can
 * only ever fall back to the flat floor, never remove it.
 */
function inputSizeFloorMs(estimatedInputTokens: number, settings: HedgeSettings): number {
  const tokens = Number.isFinite(estimatedInputTokens) && estimatedInputTokens > 0 ? estimatedInputTokens : 0;
  return Math.max(settings.minFloorMs, settings.msPerInputToken * tokens);
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
 *
 * ⚠ **The size-scaled floor applies to EVERY rung, not only the unmeasured case.** A per-token or
 * absolute rung with evidence still reports its own basis even when the floor is what actually won
 * the `Math.max` — only the FALLBACK case (no evidence at all) changes its reported basis to
 * `input-size`. That is the honest reading of "the first rung that has evidence wins": evidence
 * decided the STATISTIC even when the request's own size decided the NUMBER.
 */
function hedgeThreshold(
  pings: PingRecord[],
  tokensSeen: number,
  estimatedInputTokens: number,
  settings: HedgeSettings,
): { basis: HedgeVerdict["basis"]; thresholdMs: number } {
  const floorMs = inputSizeFloorMs(estimatedInputTokens, settings);

  if (tokensSeen > 0 && countMsPerTokenSamples(pings) >= settings.minSamples) {
    const rate = getP90MsPerToken(pings);
    if (Number.isFinite(rate)) {
      return { basis: "per-token", thresholdMs: Math.max(floorMs, rate * tokensSeen * settings.margin) };
    }
  }

  // PROBE samples only — see the note on rung 3 above.
  const probes = pings.filter((p) => p.source !== "request");
  // ⚠ The floor counts the MEASURABLE probes — the same set `getP90` measures — never
  // `probes.length`. `MEASURABLE_CODES` is a LATENCY set (200/401), so a 503 contributes a record
  // and no measurement; counting records admits a p90 resting on one sample. Rung 2 above already
  // gets this right through `countMsPerTokenSamples`, and `latency-demotion.ts` states the rule for
  // its own identical rung. Measured harm: four 503s plus one slow 200 set the bar at that single
  // probe's p90, so a real hang ran past the floor unhedged — the defect SUPPRESSES a hedge.
  const measurableProbes = probes.filter((p) => MEASURABLE_CODES.has(p.code)).length;
  if (measurableProbes >= settings.minSamples) {
    const p90 = getP90(probes);
    if (Number.isFinite(p90)) {
      return { basis: "absolute", thresholdMs: Math.max(floorMs, p90 * settings.margin) };
    }
  }

  return { basis: "input-size", thresholdMs: floorMs };
}

/**
 * How long to wait before starting the hedge, for an attempt that has produced NOTHING yet.
 *
 * ⚠ **The threshold IS the delay.** `shouldHedge` asks "has this attempt already run too long";
 * a race asks "how long should I wait before starting the second one". They are the same number
 * viewed from either side, so this returns it rather than letting a caller derive a second one.
 *
 * ⚠ `tokensSeen` is 0 by construction here, and that is the honest input for the case this serves:
 * the race is decided at COMMIT — the first meaningful content (since 2026-09-04; it was decided at
 * response resolution before) — and by definition no output token exists before that point. The
 * per-token rung therefore cannot apply on the hedge path, which is correct rather than a
 * limitation: the measured hang produced no tokens for 120 s, and a provider that returns headers
 * and then nothing produces none either. Per-token is the PRIMARY rung only for a consumer that
 * can hand it output tokens; today no consumer does, and `CLAUDE.md` says so rather than calling
 * it primary in production.
 *
 * Returns null when hedging is off or the deployment is not free — the D1 containment, applied
 * once, here, so no caller repeats it.
 */
export function hedgeDelayMs(
  pings: readonly PingRecord[],
  isFree: boolean,
  estimatedInputTokens: number,
  settings: HedgeSettings,
): number | null {
  return hedgeDelayDecision(pings, isFree, estimatedInputTokens, settings)?.delayMs ?? null;
}

/**
 * The same decision as `hedgeDelayMs`, carrying the RUNG that produced it — and, when that rung is
 * the size-scaled floor, the estimate that set it.
 *
 * ⚠ Split out rather than folded into `hedgeDelayMs` so the shipped scalar signature is untouched.
 * The basis exists for one reason: `margin` and `minSamples` are declared placeholders, and an
 * operator cannot calibrate them without knowing which rung actually fired. `HEDGED_HEADER` states
 * it, so a hedged pool is calibratable from its own responses.
 *
 * `estimatedInputTokens` rides the decision ONLY when `basis === "input-size"` — carrying it on a
 * `per-token`/`absolute` verdict would claim request size decided a number the deployment's own
 * evidence actually set, which is exactly the provenance mistake this relay's provenance invariant
 * forbids.
 */
export interface HedgeDelayDecision {
  readonly delayMs: number;
  readonly basis: HedgeVerdict["basis"];
  /** Present only when `basis` is `"input-size"` — the estimate that set the floor. */
  readonly estimatedInputTokens?: number;
}

export function hedgeDelayDecision(
  pings: readonly PingRecord[],
  isFree: boolean,
  estimatedInputTokens: number,
  settings: HedgeSettings,
): HedgeDelayDecision | null {
  if (!settings.enabled || !isFree) return null;
  const { basis, thresholdMs } = hedgeThreshold([...pings], 0, estimatedInputTokens, settings);
  return basis === "input-size"
    ? {
        delayMs: thresholdMs,
        basis,
        estimatedInputTokens: Number.isFinite(estimatedInputTokens) && estimatedInputTokens > 0 ? estimatedInputTokens : 0,
      }
    : { delayMs: thresholdMs, basis };
}

/**
 * `"<spec> (28.4s > 3.0s, input-size, 0 tokens seen)"` — bounded, metadata only, never content.
 *
 * ⚠ For `shouldHedge`'s still-unwired decision layer only — `tokensSeen` here is OUTPUT tokens the
 * attempt has produced, a different number from the INPUT estimate that sizes the floor. The WIRED
 * announcement (`x-llm-relay-hedged`, `hedgedLabel` in `candidate-runner.ts`) is the one that
 * states the input-token count, because that is the value calibratable from real traffic.
 */
export function hedgeLabel(spec: string, verdict: HedgeVerdict): string {
  const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  return `${spec} (${s(verdict.elapsedMs)} > ${s(verdict.thresholdMs)}, ${verdict.basis}, ${verdict.tokensSeen} tokens seen)`;
}
