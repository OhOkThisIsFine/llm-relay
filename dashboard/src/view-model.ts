import type { QuotaRowV1 } from "../../src/dashboard-contract.js";

export function quotaHeadroom(row: QuotaRowV1): number | null {
  if (row.limit === null || row.remaining === null || row.limit === 0) return null;
  return Math.max(0, Math.min(1, row.remaining / row.limit));
}

/**
 * Groups quota rows by `provider`, preserving each provider's first-appearance order and each
 * row's original order within its group — a stable, pure re-projection so the Quota panel can
 * render one provider's deployments together instead of one flat wall of rows.
 */
export function groupQuotaRowsByProvider(rows: readonly QuotaRowV1[]): ReadonlyArray<readonly [string, readonly QuotaRowV1[]]> {
  const order: string[] = [];
  const groups = new Map<string, QuotaRowV1[]>();
  for (const row of rows) {
    let group = groups.get(row.provider);
    if (group === undefined) { group = []; groups.set(row.provider, group); order.push(row.provider); }
    group.push(row);
  }
  return order.map((provider) => [provider, groups.get(provider)!] as const);
}

export type BasisTone = "strong" | "derived" | "weak" | "unknown";
/**
 * A coarse trust tier for a provenance/basis string, for a quick visual signal only — never a
 * judgement about whether the figure is usable. `strong` is first-party (the deployment or the
 * relay's own accounting stated it directly); `derived` is computed from a first-party figure
 * (a stated limit minus locally measured usage, or an operator-declared config value); everything
 * else (`learned`, `published`, `derived_learned`, `derived_published`, `estimated`, `mixed`) is
 * weaker evidence and reads as `weak`.
 */
export function basisTone(value: string | null): BasisTone {
  if (value === null) return "unknown";
  if (value === "provider_stated" || value === "reported") return "strong";
  if (value.startsWith("derived_") || value === "configured" || value === "relay_counted") return "derived";
  return "weak";
}
