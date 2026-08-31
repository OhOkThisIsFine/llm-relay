export interface PingRecord {
  ms: number;
  code: string;
  timestamp: number;
  /**
   * Output tokens this sample generated, when the provider reported them.
   *
   * ⚠ ABSENT means UNKNOWN, never zero — the standing provenance rule. Present only on
   * `source: "request"` samples: a probe asks for one token, so its rate would be pure fixed
   * overhead and is deliberately not comparable with a real generation.
   */
  tokens?: number;
  /**
   * Where the sample came from. ⚠ ABSENT means `"probe"` — that is every sample written before
   * 2026-08-30 and every sample the ping loop writes, so absence must never be read as "unknown
   * provenance". Only the request path writes `"request"`.
   */
  source?: "probe" | "request";
}

export type Verdict =
  | "Perfect"
  | "Normal"
  | "Slow"
  | "Spiky"
  | "Overloaded"
  | "Unstable"
  | "Not Active"
  | "Pending";

/**
 * Codes whose round-trip time is a real LATENCY sample. A 401 came back from the provider,
 * so it timed the network path and belongs in avg/p95/jitter/spike.
 *
 * ⚠ Latency only — this is NOT an availability set. Availability is decided by `getUptime()`
 * below, which counts `"200"` and nothing else, so a target answering only 401s reports 0%
 * uptime and `getStabilityScore` MULTIPLIES its composite to 0. That claim used to read "capped
 * accordingly" while the arithmetic merely subtracted a 20% term, which capped an all-401 target
 * at ~80 — above every all-success target with mediocre latency. The cap is real now because
 * availability scales the score rather than contributing a share of it. Two other sites used to
 * treat 401 as equivalent to 200 for availability (`probe-cache.ts`, `cadence.ts`) and a provider
 * with a revoked key read as healthy; both now follow the 200-only rule.
 */
export const MEASURABLE_CODES: ReadonlySet<string> = new Set(["200", "401"]);

/** Calculate average latency from measurable pings (HTTP 200/401). Returns Infinity if none. */
export function getAvg(pings: PingRecord[]): number {
  const measurable = pings.filter((p) => MEASURABLE_CODES.has(p.code));
  if (measurable.length === 0) return Infinity;
  const sum = measurable.reduce((acc, p) => acc + p.ms, 0);
  return Math.round(sum / measurable.length);
}

/**
 * The ONE quantile convention in this file: `ceil(n * q) - 1`, clamped, over an ascending array.
 *
 * ⚠ It was written out four times before this existed, and every copy was identical — which is the
 * "hand-copied" shape this repo keeps paying for. Sharing it also fixes the copies in lockstep if
 * the convention ever changes.
 *
 * ⚠ Worth knowing when reading any figure it produces: for `n <= 20` the index is `n - 1`, so a
 * "p95" over a small window IS the maximum sample. That is why one slow outlier moves these
 * statistics so far, and it is measured behaviour, not a rounding bug.
 */
function quantileOf(ascending: number[], q: number): number {
  if (ascending.length === 0) return Infinity;
  return ascending[Math.max(0, Math.ceil(ascending.length * q) - 1)]!;
}

/** Ascending measurable latencies. `MEASURABLE_CODES` is a LATENCY set, not a success set. */
function measurableMs(pings: PingRecord[]): number[] {
  return pings.filter((p) => MEASURABLE_CODES.has(p.code)).map((p) => p.ms).sort((a, b) => a - b);
}

/** Calculate 95th percentile latency from measurable pings. Returns Infinity if none. */
export function getP95(pings: PingRecord[]): number {
  return quantileOf(measurableMs(pings), 0.95);
}

/**
 * 90th percentile latency from measurable pings. Returns Infinity if none.
 *
 * Added for the hedge trigger, which asks "is this attempt slower than this deployment normally
 * is?" — a question p90 answers better than p95, because p95 over a short window is the worst
 * sample and would almost never be exceeded.
 */
export function getP90(pings: PingRecord[]): number {
  return quantileOf(measurableMs(pings), 0.9);
}

/**
 * 95th-percentile latency PER OUTPUT TOKEN, in ms — the only figure that compares a real
 * generation with anything else, because absolute latency scales with how much was generated.
 *
 * ⚠ REQUEST samples only, and only those carrying a reported token count. A probe sends
 * `max_tokens: 1`, so its ms/token is almost entirely fixed overhead (connect, queue, prompt
 * processing) and would read as catastrophically slow beside a 500-token answer that amortises
 * the same overhead. Mixing the two would not be a noisy measurement; it would be a wrong one.
 *
 * ⚠ Returns `Infinity` when nothing qualifies — "unmeasured", never "infinitely slow", exactly as
 * `getP95` does. Callers must test `Number.isFinite` rather than compare against a ceiling.
 *
 * Measured on this machine 2026-08-30 over 68 real requests, and this is what calibrates the
 * default ceiling: p50 40.4, p75 70.5, p90 292.0, p95 967.1 ms/token. Per deployment the
 * separation is clean — a healthy `nemotron-3-ultra` ran a median 36.3 while `gemini-3.6-flash`
 * ran 687.8.
 */
export function getP95MsPerToken(pings: PingRecord[]): number {
  return quantileOf(msPerTokenRates(pings), 0.95);
}

/**
 * 90th-percentile ms per output token — the hedge trigger's signal.
 *
 * Same filter and same convention as the p95 above, so the two can never describe different
 * populations. p90 rather than p95 because the question is "is THIS attempt slower than this
 * deployment normally is?", and a p95 taken over a short window is the worst sample ever seen,
 * which almost nothing exceeds.
 */
export function getP90MsPerToken(pings: PingRecord[]): number {
  return quantileOf(msPerTokenRates(pings), 0.9);
}

/**
 * The ONE definition of "which samples carry a per-token rate, and what is that rate" — ascending.
 *
 * ⚠ REQUEST samples only, and only those carrying a reported token count. A probe asks for one
 * token, so its ms/token is nearly all fixed overhead and is not comparable with a generation.
 *
 * ⚠ **`getP95MsPerToken`, `getP90MsPerToken` and `countMsPerTokenSamples` all read THIS**, rather
 * than repeating the filter. They used to repeat it, with a comment saying the copies "must stay
 * identical" — a requirement nothing enforced. Sharing one filter is what actually enforces it, and
 * it matters because a count taken over a WIDER set than the statistic it describes is how a sample
 * floor comes to admit a figure resting on one measurement.
 */
function msPerTokenRates(pings: PingRecord[]): number[] {
  const rates: number[] = [];
  for (const p of pings) {
    if (p.source !== "request") continue;
    if (!MEASURABLE_CODES.has(p.code)) continue;
    const tokens = p.tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) continue;
    if (typeof p.ms !== "number" || !Number.isFinite(p.ms) || p.ms < 0) continue;
    rates.push(p.ms / tokens);
  }
  return rates.sort((a, b) => a - b);
}

/**
 * How many samples actually back `getP95MsPerToken` and `getP90MsPerToken`.
 *
 * ⚠ It used to REPEAT their filter, under a comment saying the copies "must stay identical" — a
 * requirement nothing enforced. All three now read `msPerTokenRates`, which is what enforces it.
 * The reason is unchanged: a count taken over a WIDER set than the statistic it describes is how a
 * sample floor comes to admit a figure resting on one measurement.
 */
export function countMsPerTokenSamples(pings: PingRecord[]): number {
  return msPerTokenRates(pings).length;
}

/** Calculate latency standard deviation (jitter) in ms from measurable pings. */
export function getJitter(pings: PingRecord[]): number {
  const measurable = pings.filter((p) => MEASURABLE_CODES.has(p.code));
  if (measurable.length < 2) return 0;
  const mean = measurable.reduce((acc, p) => acc + p.ms, 0) / measurable.length;
  const variance =
    measurable.reduce((sum, p) => sum + (p.ms - mean) ** 2, 0) / measurable.length;
  return Math.round(Math.sqrt(variance));
}

/** Calculate spike rate: fraction (0–1) of measurable pings with latency > 3000ms. */
export function getSpikeRate(pings: PingRecord[]): number {
  const measurable = pings.filter((p) => MEASURABLE_CODES.has(p.code));
  if (measurable.length === 0) return 0;
  const spikes = measurable.filter((p) => p.ms > 3000).length;
  return spikes / measurable.length;
}

/** Calculate uptime percentage (0–100) of HTTP 200 pings over total pings. */
export function getUptime(pings: PingRecord[]): number {
  if (pings.length === 0) return 0;
  const successful = pings.filter((p) => p.code === "200").length;
  return Math.round((successful / pings.length) * 100);
}

/**
 * Composite Stability Score (0–100). Returns -1 only when the deployment has NEVER been probed.
 *
 * Shape: **latency quality, SCALED by availability** — not latency quality plus a fifth of
 * availability. The distinction is the whole point, because `MEASURABLE_CODES` is a latency set:
 * 403/404/429/5xx leave p95, jitter and spike entirely, so under the old additive form
 * (`0.3*p95 + 0.3*jitter + 0.2*spike + 0.2*uptime`) a failing deployment kept a clean latency
 * profile and paid only 20%. Measured on live probe data: 1 success in 12 scored **81** while
 * 3 of 3 scored **27**, and 27 zero-success deployments scored above 50 — on a machine whose
 * pools are all `{include: "free"}`, so this score IS the pool order. The comment above
 * `MEASURABLE_CODES` claimed such a target was "capped accordingly"; only a multiplier delivers
 * that cap.
 *
 * The latency weights are renormalized to sum to 1 across the three latency terms, so a
 * deployment at 100% uptime scores exactly its latency quality and nothing is silently rescaled.
 *
 * ⚠ 401 deliberately STAYS in the latency terms: the response came back from the provider, so it
 * really did time the network path. It contributes nothing to uptime, so the multiplier is what
 * stops a revoked key from reading as a fast healthy target — no need to discard real timing data.
 *
 * ⚠ `-1` means "no samples", not "no MEASURABLE samples". Twelve consecutive 402s is evidence that
 * this deployment fails, not absence of evidence: returning -1 there made every consumer read
 * "unmeasured" and the ordering substitute a neutral 50, which put a fully-exhausted deployment
 * above one that answered every probe.
 */
export function getStabilityScore(pings: PingRecord[]): number {
  if (pings.length === 0) return -1;

  const p95 = getP95(pings);
  const jitter = getJitter(pings);
  const uptime = getUptime(pings);
  const spikeRate = getSpikeRate(pings);

  // With no measurable sample `getP95` returns Infinity, so `p95Score` clamps to 0 rather than
  // producing NaN. Such a deployment also has 0% uptime, so the product is 0 either way.
  const p95Score = Math.max(0, Math.min(100, 100 * (1 - p95 / 5000)));
  const jitterScore = Math.max(0, Math.min(100, 100 * (1 - jitter / 2000)));
  const spikeScore = Math.max(0, 100 * (1 - spikeRate));

  const latencyQuality = 0.4 * p95Score + 0.4 * jitterScore + 0.2 * spikeScore;
  return Math.round(latencyQuality * (uptime / 100));
}

/**
 * How many of the MOST RECENT probes failed, consecutively.
 *
 * The unit of "is this thing broken" — one failure in a row is weather, five in a row is a
 * pattern. Anything reading the single last sample cannot tell those apart.
 */
export function trailingFailures(pings: PingRecord[]): number {
  let n = 0;
  for (let i = pings.length - 1; i >= 0 && pings[i]!.code !== "200"; i--) n++;
  return n;
}

/**
 * Consecutive recent failures before a target is called down rather than merely erratic.
 *
 * A VPN the provider blocks, a DNS hiccup, a rate-limit window, a laptop resuming from sleep —
 * all produce isolated failures against a model that is completely fine. Requiring a RUN of them
 * is what stops one such blip from disqualifying a model that has answered hundreds of times.
 */
export const DOWN_AFTER_CONSECUTIVE_FAILURES = 3;

/**
 * Codes that are a DETERMINISTIC refusal rather than weather.
 *
 * The line that matters: a 429, a 503, a DNS failure or a blocked VPN egress may all succeed on
 * the very next call, so one of them proves nothing. A 401/403 is the provider stating a fact
 * about the credential — it will answer 401 again next time, and no amount of patience changes
 * that. Tolerating transients must never become tolerating a revoked key: that was the exact
 * regression where a provider whose key had been revoked reported "Perfect" (fast 401s are still
 * fast) and could outrank a working target.
 */
const CREDENTIAL_CODES = new Set(["401", "403"]);

/**
 * Is this target persistently down, as opposed to having just had a bad moment?
 *
 * Three ways to be down, and only the last one is forgiving:
 *   1. the latest probe was a credential refusal — deterministic, see above;
 *   2. it has never once answered 200 — there is no good record to protect;
 *   3. a RUN of recent failures AND a poor overall record.
 *
 * (3) is what stops a blip disqualifying a model: one with 95% uptime that just hit three
 * rate-limited probes is rate-limited, not dead. The caller can still reach it, and the circuit
 * breaker will step over it independently if it really is failing.
 */
export function isPersistentlyDown(pings: PingRecord[]): boolean {
  if (pings.length === 0) return false;
  const last = pings[pings.length - 1]!;
  if (CREDENTIAL_CODES.has(last.code)) return true;
  if (!pings.some((p) => p.code === "200")) return true;
  return trailingFailures(pings) >= DOWN_AFTER_CONSECUTIVE_FAILURES && getUptime(pings) < 50;
}

/**
 * Determine human-readable health verdict for a model based on average latency and tail latency.
 *
 * ⚠ Down-ness is derived from the ACCUMULATED history, never from the caller's reading of the
 * most recent ping. `cadence.ts` used to pass `isDown: lastPing.code !== "200"`, so a single
 * transient 503 — a VPN block, a resumed laptop, one rate-limited probe — overrode fifty good
 * samples and reported a healthy model as `Not Active`/`Unstable`. `opts.isDown` is still
 * honoured when a caller genuinely knows better, but nothing has to supply it.
 */
export function getVerdict(
  pings: PingRecord[],
  opts: { httpCode?: string | null; isDown?: boolean } = {},
): Verdict {
  const down = opts.isDown ?? isPersistentlyDown(pings);

  // Rate limiting is a transient, self-describing condition, and it is not down-ness: report it
  // as such only when the recent record actually shows it, not because one probe caught a window.
  if (opts.httpCode === "429" && trailingFailures(pings) > 0) return "Overloaded";

  const wasUpBefore = pings.length > 0 && pings.some((p) => p.code === "200");
  if (down) {
    return wasUpBefore ? "Unstable" : "Not Active";
  }

  const avg = getAvg(pings);
  if (avg === Infinity) return "Pending";

  const measurable = pings.filter((p) => MEASURABLE_CODES.has(p.code));
  const p95 = getP95(pings);

  if (avg < 400) {
    if (measurable.length >= 3 && p95 > 3000) return "Spiky";
    return "Perfect";
  }
  if (avg < 1000) {
    if (measurable.length >= 3 && p95 > 5000) return "Spiky";
    return "Normal";
  }
  if (avg < 5000) return "Slow";
  return "Unstable";
}
