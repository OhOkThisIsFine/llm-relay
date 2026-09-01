/** The finite set of quota dimensions understood by the relay. */
export type QuotaAxis = "requests" | "tokens";

export type QuotaPeriod = "minute" | "day" | "month" | "unknown";

export interface QuotaObservation {
  axis: QuotaAxis;
  period: QuotaPeriod;
  limit: number;
  remaining: number;
  resetsAt: number | null;
  observedAt: number;
  basis: "provider-stated";
}

/** Options are deliberately small so observations can be deterministic in tests. */
export interface QuotaObservationOptions {
  observedAt?: number;
}

export type QuotaHeaders = Headers | Readonly<Record<string, string | undefined>>;

interface QuotaBucket {
  axis: QuotaAxis;
  period: QuotaPeriod;
  limit?: number;
  remaining?: number;
  reset?: string;
  resetHasExplicitPeriod: boolean;
  order: number;
}

type HeaderMetric = "limit" | "remaining" | "reset";

const AXES = new Set(["request", "requests", "token", "tokens"]);
const PERIODS = new Set<QuotaPeriod>(["minute", "day", "month"]);
const UNSUPPORTED_PERIOD_WORDS = new Set([
  "second", "seconds", "hour", "hours", "week", "weeks", "quarter", "year", "years",
]);

function headerEntries(headers: QuotaHeaders): Array<[string, string]> {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const result: Array<[string, string]> = [];
    headers.forEach((value, name) => result.push([name, value]));
    return result;
  }

  const result: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result.push([name, value]);
  }
  return result;
}

function parseStrictNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0 || value.trim() !== value) return undefined;
  // Number() accepts whitespace and several non-decimal spellings. Header quota values are
  // intentionally narrower: one complete decimal number, with no trailing provider text.
  if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function metricAndDimension(name: string): {
  metric: HeaderMetric;
  axis: QuotaAxis;
  period: QuotaPeriod;
  hasExplicitPeriod: boolean;
} | undefined {
  const parts = name.toLowerCase().replaceAll("_", "-").split("-").filter(Boolean);
  const metrics = parts.filter(
    (part): part is HeaderMetric => part === "limit" || part === "remaining" || part === "reset",
  );
  const axes = parts.filter((part) => AXES.has(part));
  const periods = parts.filter((part): part is Exclude<QuotaPeriod, "unknown"> =>
    PERIODS.has(part as Exclude<QuotaPeriod, "unknown">),
  );

  // A generic `limit`/`remaining` pair is not attributable to either axis. Likewise, a
  // malformed header mentioning two dimensions must not be guessed into one observation.
  if (metrics.length !== 1 || axes.length !== 1 || periods.length > 1 ||
    parts.some((part) => UNSUPPORTED_PERIOD_WORDS.has(part))) return undefined;
  const period = periods[0] ?? "unknown";
  return {
    metric: metrics[0]!,
    axis: axes[0]!.startsWith("request") ? "requests" : "tokens",
    period,
    hasExplicitPeriod: periods.length === 1,
  };
}

function durationMilliseconds(value: string): number | undefined {
  // Whitespace is allowed only between complete components. In particular, do not
  // turn `1 2s` into `12s`; that loses the provider's malformed input boundary.
  const pieces = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi)];
  if (pieces.length === 0 || pieces.map((piece) => piece[0]).join("") !== value.replace(/\s+/g, "") ||
    !/^\d+(?:\.\d+)?(?:ms|s|m|h|d)(?:\s*\d+(?:\.\d+)?(?:ms|s|m|h|d))*$/i.test(value)) {
    return undefined;
  }
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  let total = 0;
  for (const piece of pieces) {
    const amount = Number(piece[1]);
    const multiplier = multipliers[piece[2]!.toLowerCase()];
    if (!Number.isFinite(amount) || multiplier === undefined) return undefined;
    total += amount * multiplier;
  }
  return Number.isFinite(total) ? total : undefined;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const HTTP_DATE = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4}))$/;
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function validDate(year: number, month: number, day: number, hour: number, minute: number, second: number): number | undefined {
  if (month < 0 || month > 11 || hour > 23 || minute > 59 || second > 59) return undefined;
  const timestamp = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(timestamp);
  return Number.isFinite(timestamp) && date.getUTCFullYear() === year && date.getUTCMonth() === month &&
    date.getUTCDate() === day && date.getUTCHours() === hour && date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second ? timestamp : undefined;
}

function parseIsoTimestamp(value: string): number | undefined {
  if (!ISO_TIMESTAMP.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseHttpDate(value: string): number | undefined {
  const match = HTTP_DATE.exec(value);
  if (!match) return undefined;
  if (match[1] !== undefined) {
    return validDate(Number(match[3]), MONTHS[match[2]!]!, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6]));
  }
  if (match[7] !== undefined) {
    const year = Number(match[9]) + (Number(match[9]) >= 50 ? 1900 : 2000);
    return validDate(year, MONTHS[match[8]!]!, Number(match[7]), Number(match[10]), Number(match[11]), Number(match[12]));
  }
  return validDate(Number(match[18]), MONTHS[match[13]!]!, Number(match[14]), Number(match[15]), Number(match[16]), Number(match[17]));
}

/** Parse only reset forms whose units or epoch width make their meaning unambiguous. */
function parseReset(value: string | undefined, observedAt: number): number | undefined {
  if (value === undefined || value.length === 0 || value.trim() !== value) return undefined;
  const duration = durationMilliseconds(value);
  if (duration !== undefined) return observedAt + duration;

  // Providers commonly use ten-digit Unix seconds or thirteen-digit Unix milliseconds.
  if (/^\d{10}$/.test(value)) return Number(value) * 1_000;
  if (/^\d{13}$/.test(value)) return Number(value);

  return parseIsoTimestamp(value);
}

function parseRetryAfter(value: string | undefined, observedAt: number): number | undefined {
  if (value === undefined || value.length === 0 || value.trim() !== value) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? observedAt + seconds * 1_000 : undefined;
  }
  return parseHttpDate(value);
}

export function bucketKey(axis: QuotaAxis, period: QuotaPeriod): string {
  return `${axis}:${period}`;
}

function canonicalBucketOrder(a: QuotaBucket, b: QuotaBucket): number {
  const axisOrder = a.axis === b.axis ? 0 : a.axis === "requests" ? -1 : 1;
  if (axisOrder !== 0) return axisOrder;
  const periodOrder: Record<QuotaPeriod, number> = { minute: 0, day: 1, month: 2, unknown: 3 };
  return periodOrder[a.period] - periodOrder[b.period] || a.order - b.order;
}

/**
 * Extracts all complete, explicitly attributed limit/remaining pairs from response headers.
 * Header names are case-insensitive; supported forms put `limit`, `remaining`, and optionally
 * `reset` alongside `requests` or `tokens`, with an optional `minute`, `day`, or `month` token.
 * This covers both `x-ratelimit-limit-requests-day` and
 * `anthropic-ratelimit-requests-limit`-style names.
 */
export function extractQuotaObservations(
  headers: QuotaHeaders,
  options: QuotaObservationOptions = {},
): QuotaObservation[] {
  const configuredObservedAt = options.observedAt;
  const observedAt = configuredObservedAt !== undefined && Number.isFinite(configuredObservedAt)
    ? configuredObservedAt
    : Date.now();
  const buckets = new Map<string, QuotaBucket>();
  let order = 0;
  let retryAfter: string | undefined;

  for (const [rawName, rawValue] of headerEntries(headers)) {
    const name = rawName.toLowerCase().trim();
    if (name === "retry-after") {
      retryAfter = rawValue;
      continue;
    }
    const dimensions = metricAndDimension(name);
    if (dimensions === undefined) continue;
    const key = bucketKey(dimensions.axis, dimensions.period);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        axis: dimensions.axis,
        period: dimensions.period,
        resetHasExplicitPeriod: dimensions.hasExplicitPeriod,
        order: order++,
      };
      buckets.set(key, bucket);
    }
    if (dimensions.metric === "reset") {
      bucket.reset = rawValue;
      bucket.resetHasExplicitPeriod = dimensions.hasExplicitPeriod;
    } else {
      const numeric = parseStrictNumber(rawValue);
      if (numeric !== undefined) {
        if (dimensions.metric === "limit") bucket.limit = numeric;
        else bucket.remaining = numeric;
      }
    }
  }

  const parsedRetryAfter = parseRetryAfter(retryAfter, observedAt);
  const allBuckets = [...buckets.values()];
  allBuckets.sort(canonicalBucketOrder);
  const observations: QuotaObservation[] = [];
  for (const bucket of allBuckets) {
    if (bucket.limit === undefined || bucket.remaining === undefined) continue;
    if (!Number.isFinite(bucket.limit) || bucket.limit <= 0) continue;
    if (!Number.isFinite(bucket.remaining) || bucket.remaining < 0) continue;

    let resetsAt = parseReset(bucket.reset, observedAt) ?? null;
    if (resetsAt === null && bucket.remaining === 0 && parsedRetryAfter !== undefined) {
      resetsAt = parsedRetryAfter;
    }
    observations.push({
      axis: bucket.axis,
      period: bucket.period,
      limit: bucket.limit,
      remaining: bucket.remaining,
      resetsAt,
      observedAt,
      basis: "provider-stated",
    });
  }

  // An axis-only reset header can be paired with one unambiguous complete bucket, but never
  // with multiple periods. The normal bucket map already handles explicit reset periods.
  for (const bucket of allBuckets) {
    // If this bucket itself has a complete unknown-period pair, its reset already belongs to it;
    // only a reset-only bucket needs the single-candidate fallback below.
    if (bucket.reset === undefined || bucket.resetHasExplicitPeriod ||
      (bucket.limit !== undefined && bucket.remaining !== undefined)) continue;
    const candidates = allBuckets.filter(
      (candidate) => candidate.axis === bucket.axis &&
        candidate !== bucket && candidate.limit !== undefined && candidate.remaining !== undefined,
    );
    if (candidates.length !== 1) continue;
    const candidate = candidates[0]!;
    const index = observations.findIndex(
      (observation) => observation.axis === candidate.axis && observation.period === candidate.period,
    );
    const parsed = parseReset(bucket.reset, observedAt);
    if (index >= 0 && parsed !== undefined && observations[index]!.resetsAt === null) {
      observations[index] = { ...observations[index]!, resetsAt: parsed };
    }
  }

  return observations;
}

/** Merge observations by their typed identity; later sets replace only matching tuples. */
export function mergeQuotaObservations(...sets: readonly (readonly QuotaObservation[])[]): QuotaObservation[] {
  const merged = new Map<string, QuotaObservation>();
  for (const set of sets) {
    for (const observation of set) {
      merged.set(bucketKey(observation.axis, observation.period), { ...observation });
    }
  }
  return [...merged.values()];
}

/** Render-time derivation. The ratio is intentionally absent from QuotaObservation itself. */
export function headroomPercent(observation: QuotaObservation): number {
  const ratio = (observation.remaining / observation.limit) * 100;
  return Math.max(0, Math.min(100, ratio));
}
