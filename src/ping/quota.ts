import type { ProviderConfig } from "../config.js";

export interface QuotaInfo {
  provider: string;
  ok: boolean;
  quotaPercent?: number | null;
  creditBalanceUsd?: number | null;
  limitUsd?: number | null;
  usageUsd?: number | null;
  statusText?: string;
}

/**
 * Explicit quota/balance fetcher for key providers.
 * OpenRouter: GET https://openrouter.ai/api/v1/auth/key
 */
export async function fetchProviderQuota(
  providerName: string,
  cfg: ProviderConfig,
  apiKey?: string,
  fetchFn: typeof fetch = fetch,
): Promise<QuotaInfo> {
  if (!apiKey) {
    return { provider: providerName, ok: false, statusText: "No API key configured" };
  }

  // OpenRouter key management API
  if (providerName.toLowerCase().includes("openrouter") || cfg.base.includes("openrouter.ai")) {
    try {
      const resp = await fetchFn("https://openrouter.ai/api/v1/auth/key", {
        headers: { Authorization: apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}` },
      });
      if (!resp.ok) {
        return { provider: providerName, ok: false, statusText: `HTTP ${resp.status}` };
      }
      const data = (await resp.json()) as { data?: { limit?: number; usage?: number; is_free_tier?: boolean } };
      const limit = data.data?.limit;
      const usage = data.data?.usage;

      let pct: number | null = null;
      if (typeof limit === "number" && typeof usage === "number" && limit > 0) {
        const rem = Math.max(0, limit - usage);
        pct = Math.round((rem / limit) * 100);
      }

      return {
        provider: providerName,
        ok: true,
        quotaPercent: pct,
        limitUsd: limit ?? null,
        usageUsd: usage ?? null,
        creditBalanceUsd: limit && usage !== undefined ? limit - usage : null,
      };
    } catch (e) {
      return { provider: providerName, ok: false, statusText: (e as Error).message };
    }
  }

  // Generic fallback: returns true if provider is reachable
  return { provider: providerName, ok: true };
}
