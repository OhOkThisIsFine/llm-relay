export function number(value: number | null, suffix = ""): string { return value === null ? "Unavailable" : `${new Intl.NumberFormat("en-US").format(value)}${suffix}`; }
export function percent(value: number | null): string { return value === null ? "Unavailable" : `${(value * 100).toFixed(1)}%`; }
export function duration(value: number | null): string { return value === null ? "Unavailable" : `${number(value)} ms`; }
export function stamp(value: string | null): string { return value === null ? "Unavailable" : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" }).format(new Date(value)); }
export function currencyMicrousd(value: number | null): string { return value === null ? "Unpriced" : `$${(value / 1_000_000).toFixed(4)}`; }
export function coverage(value: string): string { return value === "complete" ? "Complete" : value[0]!.toUpperCase() + value.slice(1); }
/**
 * A human-relative countdown/elapsed label ("in 3h", "12m ago") beside the absolute `stamp()`
 * value, so a reset time is legible without doing the subtraction in your head. `referenceMs` is
 * an explicit argument rather than a hidden `Date.now()` read so the result is reproducible in
 * tests; production call sites simply omit it.
 */
export function relativeTime(value: string | null, referenceMs: number = Date.now()): string {
  if (value === null) return "Unavailable";
  const targetMs = new Date(value).getTime();
  if (Number.isNaN(targetMs)) return "Unavailable";
  const diffMs = targetMs - referenceMs;
  const past = diffMs < 0;
  const absMs = Math.abs(diffMs);
  const minute = 60_000, hour = 3_600_000, day = 86_400_000;
  const [amount, unit] = absMs < minute ? [Math.round(absMs / 1000), "s"] as const
    : absMs < hour ? [Math.round(absMs / minute), "m"] as const
    : absMs < day ? [Math.round(absMs / hour), "h"] as const
    : [Math.round(absMs / day), "d"] as const;
  return past ? `${amount}${unit} ago` : `in ${amount}${unit}`;
}
/** Turns a snake_case provenance/basis value (e.g. "derived_provider_stated") into a readable label. */
export function basisLabel(value: string | null): string {
  return value === null ? "Unavailable" : value.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
export function utcBucketLabel(from: string, window: string): string {
  const options: Intl.DateTimeFormatOptions = window === "1h" || window === "24h" || window === "today"
    ? { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }
    : { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false };
  return `${new Intl.DateTimeFormat("en-US", options).format(new Date(from))} UTC`;
}
