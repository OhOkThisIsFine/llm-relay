import type { Config, ProviderConfig } from "./config.js";
import { fetchProviderQuota } from "./ping/quota.js";

export interface KeyCheckResult {
  provider: string;
  authEnv?: string | undefined;
  hasEnvKey: boolean;
  status: "valid" | "invalid_key" | "rate_limited" | "missing_env" | "unreachable";
  httpStatus?: number | undefined;
  message: string;
  quotaPercent?: number | null | undefined;
  modelsFound?: number | undefined;
}

/** Pre-flight check all configured provider API keys. */
export async function validateProviderKeys(
  cfg: Config,
  fetchFn: typeof fetch = fetch,
): Promise<KeyCheckResult[]> {
  const results: KeyCheckResult[] = [];

  for (const [name, p] of Object.entries(cfg.providers)) {
    const envVarName = p.authEnv;
    const apiKey = envVarName ? process.env[envVarName] : undefined;

    if (envVarName && !apiKey) {
      results.push({
        provider: name,
        authEnv: envVarName,
        hasEnvKey: false,
        status: "missing_env",
        message: `Environment variable ${envVarName} is not set`,
      });
      continue;
    }

    try {
      // 1. Fetch quota if applicable
      const quota = await fetchProviderQuota(name, p, apiKey, fetchFn);

      // 2. Perform test probe to provider /models or completions endpoint
      const url = p.kind === "openai" ? `${p.base}/models` : `${p.base}/v1/messages`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        if (p.authHeader === "x-api-key" || p.kind === "anthropic") {
          headers["x-api-key"] = apiKey;
        } else {
          headers["authorization"] = apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
        }
      }

      const resp = await fetchFn(url, { method: "GET", headers });

      if (resp.status === 401 || resp.status === 403) {
        results.push({
          provider: name,
          authEnv: envVarName,
          hasEnvKey: true,
          status: "invalid_key",
          httpStatus: resp.status,
          message: `Authentication failed (HTTP ${resp.status})`,
        });
      } else if (resp.status === 429) {
        results.push({
          provider: name,
          authEnv: envVarName,
          hasEnvKey: true,
          status: "rate_limited",
          httpStatus: 429,
          message: "Rate limited or quota exhausted (HTTP 429)",
          quotaPercent: quota.quotaPercent,
        });
      } else if (resp.ok || resp.status === 400 || resp.status === 404 || resp.status === 405) {
        // 200 OK or endpoint-level expected response (e.g. GET on /messages returning 405 Method Not Allowed)
        let modelsCount: number | undefined;
        if (resp.ok && url.endsWith("/models")) {
          try {
            const body = (await resp.json()) as { data?: unknown[] };
            if (Array.isArray(body.data)) modelsCount = body.data.length;
          } catch {
            /* ignore JSON parse */
          }
        }
        results.push({
          provider: name,
          authEnv: envVarName,
          hasEnvKey: true,
          status: "valid",
          httpStatus: resp.status,
          message: "Key verified & healthy",
          quotaPercent: quota.quotaPercent,
          modelsFound: modelsCount,
        });
      } else {
        results.push({
          provider: name,
          authEnv: envVarName,
          hasEnvKey: true,
          status: "unreachable",
          httpStatus: resp.status,
          message: `Provider returned HTTP ${resp.status}`,
        });
      }
    } catch (e) {
      results.push({
        provider: name,
        authEnv: envVarName,
        hasEnvKey: true,
        status: "unreachable",
        message: `Network error: ${(e as Error).message}`,
      });
    }
  }

  return results;
}
