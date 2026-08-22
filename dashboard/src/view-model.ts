import type { QuotaRowV1 } from "../../src/dashboard-contract.js";

export function quotaHeadroom(row: QuotaRowV1): number | null {
  if (row.limit === null || row.remaining === null || row.limit === 0) return null;
  return Math.max(0, Math.min(1, row.remaining / row.limit));
}
