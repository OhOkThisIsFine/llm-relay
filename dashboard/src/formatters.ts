export function number(value: number | null, suffix = ""): string { return value === null ? "Unavailable" : `${new Intl.NumberFormat("en-US").format(value)}${suffix}`; }
export function percent(value: number | null): string { return value === null ? "Unavailable" : `${(value * 100).toFixed(1)}%`; }
export function duration(value: number | null): string { return value === null ? "Unavailable" : `${number(value)} ms`; }
export function stamp(value: string | null): string { return value === null ? "Unavailable" : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" }).format(new Date(value)); }
export function currencyMicrousd(value: number | null): string { return value === null ? "Unpriced" : `$${(value / 1_000_000).toFixed(4)}`; }
export function coverage(value: string): string { return value === "complete" ? "Complete" : value[0]!.toUpperCase() + value.slice(1); }
export function utcBucketLabel(from: string, window: string): string {
  const options: Intl.DateTimeFormatOptions = window === "1h" || window === "24h" || window === "today"
    ? { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }
    : { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false };
  return `${new Intl.DateTimeFormat("en-US", options).format(new Date(from))} UTC`;
}
