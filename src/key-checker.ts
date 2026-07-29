import type { Config, ProviderConfig } from "./config.js";
import { fetchProviderQuota } from "./ping/quota.js";
import { candidateEnvNames } from "./authEnv.js";
import { splitSpec } from "./config.js";

/**
 * Per-request cap for key checking. Independent of a provider's own `timeoutMs`, which is
 * sized for real completions (minutes) — a status command must stay answerable even when a
 * configured host is black-holing connections.
 */
const KEY_CHECK_TIMEOUT_MS = 45_000;

function withTimeout(): { signal: AbortSignal } | Record<string, never> {
  return typeof AbortSignal?.timeout === "function" ? { signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS) } : {};
}

export interface KeyCheckResult {
  provider: string;
  authEnv?: string | undefined;
  hasEnvKey: boolean;
  status: "valid" | "invalid_key" | "rate_limited" | "missing_env" | "unreachable" | "unverified";
  httpStatus?: number | undefined;
  message: string;
  quotaPercent?: number | null | undefined;
  modelsFound?: number | undefined;
}

/**
 * Does this endpoint actually require credentials? Probed by calling it with none.
 * A 401/403 means the earlier authenticated 200 was real evidence about the key.
 * Anything else means the endpoint is public and tells us nothing.
 * On a network error we assume it IS gated — never downgrade a working key on a blip.
 */
async function isAuthGated(url: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const bare = await fetchFn(url, { method: "GET", headers: { "Content-Type": "application/json" }, ...withTimeout() });
    return bare.status === 401 || bare.status === 403;
  } catch {
    return true;
  }
}

/**
 * Ask an endpoint that definitely needs the key: a 1-token completion.
 *
 * `modelId` should be a REAL id from the provider's own catalogue. A throwaway id like
 * "probe" looks tidy but is unreliable: some providers reject the unknown model with a 401
 * (reported as a bad key when the key was fine) and others stall routing it until the
 * request times out. Both turn a healthy provider into a false alarm — the same class of
 * bug as the false VALID this check exists to fix, just pointing the other way.
 */
async function probeAuthenticated(
  p: ProviderConfig,
  apiKey: string,
  fetchFn: typeof fetch,
  modelId: string,
): Promise<{ status: KeyCheckResult["status"]; httpStatus: number | undefined; message: string }> {
  const isOpenAi = p.kind === "openai";
  const url = isOpenAi ? `${p.base}/chat/completions` : `${p.base}/v1/messages`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (p.authHeader === "x-api-key" || p.kind === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["authorization"] = apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
  }
  const body = JSON.stringify({
    model: modelId,
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  });

  try {
    const r = await fetchFn(url, { method: "POST", headers, body, ...withTimeout() });
    if (r.status === 429) {
      return { status: "rate_limited", httpStatus: 429, message: "Rate limited or quota exhausted (HTTP 429)" };
    }
    if (r.status !== 401 && r.status !== 403) {
      // 2xx, or a 400/404 rejecting the request on its contents — either way it got past auth.
      return { status: "valid", httpStatus: r.status, message: "Key verified (authenticated probe)" };
    }

    // A 401/403 is ambiguous: the key may be bad, OR the key may be fine and simply not
    // entitled to this particular model (premium tiers are common in a free-tier roster, and
    // the catalogue lists them alongside the free ones). Send the SAME request anonymously:
    // if the answer changes, the credential demonstrably did something and the wall is about
    // the model, not the key. If it does not change, we have learned nothing and must say so
    // rather than accuse a working key.
    const anon = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      ...withTimeout(),
    });
    if (anon.status !== r.status) {
      return {
        status: "valid",
        httpStatus: r.status,
        message: `Key authenticated (HTTP ${r.status} is the probe model not being available on this plan)`,
      };
    }
    return {
      status: "unverified",
      httpStatus: r.status,
      message: `Could not confirm — /models is public and the probe model answers HTTP ${r.status} with or without the key`,
    };
  } catch (e) {
    return { status: "unreachable", httpStatus: undefined, message: `Network error: ${(e as Error).message}` };
  }
}

/** First model id this config routes to each provider, across pools, tiers and default. */
function routedModelsByProvider(cfg: Config): Map<string, string> {
  const out = new Map<string, string>();
  const raw: (string | string[] | undefined)[] = [
    ...Object.values(cfg.routing.pools ?? {}),
    ...Object.values(cfg.routing.tiers ?? {}),
    cfg.routing.default,
  ];
  for (const entry of raw) {
    for (const spec of Array.isArray(entry) ? entry : entry ? [entry] : []) {
      const { provider, model } = splitSpec(spec);
      if (model && !out.has(provider)) out.set(provider, model);
    }
  }
  return out;
}

/**
 * Pre-flight check all configured provider API keys.
 *
 * Providers are checked CONCURRENTLY. A rich config can declare a dozen-plus providers, and
 * one unreachable host (a local daemon that isn't running) must not add its whole timeout to
 * everyone else's wait — checked serially that turns a status command into a minutes-long one.
 * Result order still follows config order.
 */
export async function validateProviderKeys(
  cfg: Config,
  fetchFn: typeof fetch = fetch,
): Promise<KeyCheckResult[]> {
  const entries = Object.entries(cfg.providers);
  const routed = routedModelsByProvider(cfg);

  const checkOne = async ([name, p]: [string, ProviderConfig]): Promise<KeyCheckResult> => {
    const envVarName = p.authEnv;
    const apiKey = envVarName ? process.env[envVarName] : undefined;

    if (envVarName && !apiKey) {
      return {
        provider: name,
        authEnv: envVarName,
        hasEnvKey: false,
        status: "missing_env",
        message: `No key found — set ${candidateEnvNames(name, envVarName).slice(0, 4).join(" or ")}`,
      };
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

      const resp = await fetchFn(url, { method: "GET", headers, ...withTimeout() });

      if (resp.status === 401 || resp.status === 403) {
        return {
          provider: name,
          authEnv: envVarName,
          hasEnvKey: true,
          status: "invalid_key",
          httpStatus: resp.status,
          message: `Authentication failed (HTTP ${resp.status})`,
        };
      } else if (resp.status === 429) {
        return {
          provider: name,
          authEnv: envVarName,
          hasEnvKey: true,
          status: "rate_limited",
          httpStatus: 429,
          message: "Rate limited or quota exhausted (HTTP 429)",
          quotaPercent: quota.quotaPercent,
        };
      } else if (resp.ok || resp.status === 400 || resp.status === 404 || resp.status === 405) {
        // 200 OK or endpoint-level expected response (e.g. GET on /messages returning 405 Method Not Allowed)
        let modelsCount: number | undefined;
        let firstModelId: string | undefined;
        if (resp.ok && url.endsWith("/models")) {
          try {
            const body = (await resp.json()) as { data?: { id?: unknown }[] };
            if (Array.isArray(body.data)) {
              modelsCount = body.data.length;
              const first = body.data.find((m) => typeof m?.id === "string");
              if (first) firstModelId = first.id as string;
            }
          } catch {
            /* ignore JSON parse */
          }
        }

        // A 200 from /models only proves the KEY works if that endpoint is actually
        // auth-gated. Several providers (OpenRouter among them) serve it publicly, so a
        // revoked key still returns the full catalogue and this check reported VALID while
        // every real request 401'd. Re-probe WITHOUT the key: if it still succeeds, the
        // endpoint proved nothing and we must ask an authenticated endpoint instead.
        // Needs a real model id to probe with; without one, escalation is less reliable
        // than the listing we already have, so keep the listing verdict.
        // Prefer a model this config actually ROUTES to the provider over the catalogue's
        // first entry. Free-tier rosters list premium models the key legitimately cannot
        // touch, and probing one of those produces a 401/403 that says nothing about the
        // key. The routed model is both the one the user cares about and the one most
        // likely to be reachable on their plan.
        const probeModel = routed.get(name) ?? firstModelId;
        if (resp.ok && apiKey && url.endsWith("/models") && probeModel) {
          const gated = await isAuthGated(url, fetchFn);
          if (!gated) {
            const verdict = await probeAuthenticated(p, apiKey, fetchFn, probeModel);
            return {
              provider: name,
              authEnv: envVarName,
              hasEnvKey: true,
              status: verdict.status,
              httpStatus: verdict.httpStatus,
              message: verdict.message,
              quotaPercent: quota.quotaPercent,
              modelsFound: modelsCount,
            };
          }
        }

        return {
          provider: name,
          authEnv: envVarName,
          hasEnvKey: true,
          status: "valid",
          httpStatus: resp.status,
          message: "Key verified & healthy",
          quotaPercent: quota.quotaPercent,
          modelsFound: modelsCount,
        };
      } else {
        return {
          provider: name,
          authEnv: envVarName,
          hasEnvKey: true,
          status: "unreachable",
          httpStatus: resp.status,
          message: `Provider returned HTTP ${resp.status}`,
        };
      }
    } catch (e) {
      return {
        provider: name,
        authEnv: envVarName,
        hasEnvKey: true,
        status: "unreachable",
        message: `Network error: ${(e as Error).message}`,
      };
    }
  };

  return Promise.all(entries.map(checkOne));
}
