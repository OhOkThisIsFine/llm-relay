import type { ProviderConfig } from "../config.js";

/**
 * Is this base URL OpenRouter's — the EXACT host `openrouter.ai`, not a substring.
 * Deliberately the config.ts `isGoogleGenerativeLanguageHost` shape (one exact host),
 * not the mistral suffix form: the auth/key endpoint exists only on `openrouter.ai`,
 * and a suffix test would admit `openrouter.ai.evil.test`. An unparseable base fails
 * closed: do not send this provider's credential anywhere.
 */
function isOpenRouterBase(base: string): boolean {
  try {
    return new URL(base).hostname.toLowerCase() === "openrouter.ai";
  } catch {
    return false;
  }
}

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

  // OpenRouter key management API. Recognition is an EXACT-host test against the
  // provider's own configured base (the authEnv.ts precedent: never a substring
  // heuristic, which could ship one provider's credential to another's endpoint),
  // and the auth-key request is built from that same parsed origin, so the
  // credential can never egress to a host the operator did not configure.
  if (isOpenRouterBase(cfg.base)) {
    try {
      const quotaUrl = new URL(cfg.base);
      quotaUrl.pathname = "/api/v1/auth/key";
      quotaUrl.search = "";
      quotaUrl.hash = "";
      quotaUrl.username = "";
      quotaUrl.password = "";
      const resp = await fetchFn(quotaUrl.toString(), {
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
