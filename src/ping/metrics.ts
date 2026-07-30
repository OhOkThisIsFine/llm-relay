export interface PingRecord {
  ms: number;
  code: string;
  timestamp: number;
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
 * uptime and its composite score is capped accordingly. Two other sites used to treat 401 as
 * equivalent to 200 for availability (`probe-cache.ts`, `cadence.ts`) and a provider with a
 * revoked key read as healthy; both now follow the 200-only rule.
 */
const MEASURABLE_CODES = new Set(["200", "401"]);

/** Calculate average latency from measurable pings (HTTP 200/401). Returns Infinity if none. */
export function getAvg(pings: PingRecord[]): number {
  const measurable = pings.filter((p) => MEASURABLE_CODES.has(p.code));
  if (measurable.length === 0) return Infinity;
  const sum = measurable.reduce((acc, p) => acc + p.ms, 0);
  return Math.round(sum / measurable.length);
}

/** Calculate 95th percentile latency from measurable pings. Returns Infinity if none. */
export function getP95(pings: PingRecord[]): number {
  const measurable = pings.filter((p) => MEASURABLE_CODES.has(p.code));
  if (measurable.length === 0) return Infinity;
  const sorted = measurable.map((p) => p.ms).sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)]!;
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

/** Calculate composite Stability Score (0–100). Returns -1 if no measurable pings exist. */
export function getStabilityScore(pings: PingRecord[]): number {
  const measurable = pings.filter((p) => MEASURABLE_CODES.has(p.code));
  if (measurable.length === 0) return -1;

  const p95 = getP95(pings);
  const jitter = getJitter(pings);
  const uptime = getUptime(pings);
  const spikeRate = getSpikeRate(pings);

  const p95Score = Math.max(0, Math.min(100, 100 * (1 - p95 / 5000)));
  const jitterScore = Math.max(0, Math.min(100, 100 * (1 - jitter / 2000)));
  const spikeScore = Math.max(0, 100 * (1 - spikeRate));
  const reliabilityScore = uptime;

  const score = 0.3 * p95Score + 0.3 * jitterScore + 0.2 * spikeScore + 0.2 * reliabilityScore;
  return Math.round(score);
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
