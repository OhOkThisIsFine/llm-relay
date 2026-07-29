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

/** Determine human-readable health verdict for a model based on average latency and tail latency. */
export function getVerdict(
  pings: PingRecord[],
  opts: { httpCode?: string | null; isDown?: boolean } = {},
): Verdict {
  if (opts.httpCode === "429") return "Overloaded";

  const wasUpBefore = pings.length > 0 && pings.some((p) => p.code === "200");
  if (opts.isDown) {
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
