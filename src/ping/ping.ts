import type { ProviderConfig } from "../config.js";
import { buildAuthHeaders } from "../authEnv.js";
import {
  extractQuotaObservations,
  headroomPercent,
  type QuotaHeaders,
  type QuotaObservation,
} from "../quota-observation.js";

export const DEFAULT_PING_TIMEOUT_MS = 15000;

const DISABLED_THINKING_RETRY_STATUSES = new Set([400, 422]);
const disabledThinkingUnsupportedProviders = new Set<string>();

export interface PingResult {
  code: string;
  ms: number;
  quotaObservations: QuotaObservation[];
}

/**
 * @deprecated Quota has more than one independent axis. Use `extractQuotaObservations()` and
 * render each observation directly. This compatibility adapter declines ambiguous responses.
 */
export function extractQuotaPercent(headers: QuotaHeaders): number | null {
  const observations = extractQuotaObservations(headers);
  return observations.length === 1 ? headroomPercent(observations[0]!) : null;
}

export function markDisabledThinkingUnsupported(providerName: string): void {
  disabledThinkingUnsupportedProviders.add(providerName);
}

export function shouldUseDisabledThinkingForProvider(providerName: string): boolean {
  if (["cerebras", "mistral", "groq", "sambanova"].includes(providerName)) return false;
  return !disabledThinkingUnsupportedProviders.has(providerName);
}

export function buildPingEndpoint(base: string, kind: string): string {
  const cleanBase = base.endsWith("/") ? base.slice(0, -1) : base;
  if (kind === "openai") {
    return cleanBase.endsWith("/chat/completions") ? cleanBase : `${cleanBase}/chat/completions`;
  }
  return cleanBase.endsWith("/messages") ? cleanBase : `${cleanBase}/v1/messages`;
}

export function buildPingRequest(
  providerName: string,
  modelId: string,
  cfg: ProviderConfig,
  apiKey?: string,
  options: { disableThinking?: boolean } = {},
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const url = buildPingEndpoint(cfg.base, cfg.kind);
  // The credential header comes from the shared builder, which returns {} for an absent or
  // whitespace-only key. It obeys the DECLARED `authHeader` and does not force `x-api-key` on
  // an anthropic-kind provider the way this site used to — `config.ts` already defaults that,
  // so the only changed case is an explicit `authHeader: "authorization"`, where honouring the
  // config is the correct answer.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildAuthHeaders(apiKey, cfg.authHeader),
  };

  if (cfg.kind === "openai") {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    };
    const allowThinkingToggle = options.disableThinking ?? shouldUseDisabledThinkingForProvider(providerName);
    if (allowThinkingToggle) {
      body["thinking"] = { type: "disabled" };
    }
    return { url, headers, body };
  }

  // Anthropic Messages probe
  headers["anthropic-version"] = "2023-06-01";
  const body: Record<string, unknown> = {
    model: modelId,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1,
  };
  return { url, headers, body };
}

async function sendPingFetch(
  req: { url: string; headers: Record<string, string>; body: Record<string, unknown> },
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  return fetchFn(req.url, {
    method: "POST",
    redirect: "manual",
    signal,
    headers: req.headers,
    body: JSON.stringify(req.body),
  });
}

async function isDisabledThinkingRejected(resp: Response, req: { body: Record<string, unknown> }): Promise<boolean> {
  if (!req.body["thinking"] || !DISABLED_THINKING_RETRY_STATUSES.has(resp.status)) return false;
  try {
    const text = await resp.clone().text();
    return /thinking/i.test(text);
  } catch {
    return false;
  }
}

/** Execute a single async ping to measure latency and remaining quota. */
export async function pingProviderModel(
  providerName: string,
  modelId: string,
  cfg: ProviderConfig,
  apiKey?: string,
  opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<PingResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();

  try {
    let req = buildPingRequest(providerName, modelId, cfg, apiKey);
    let resp = await sendPingFetch(req, ctrl.signal, opts.fetchFn);

    if (await isDisabledThinkingRejected(resp, req)) {
      markDisabledThinkingUnsupported(providerName);
      req = buildPingRequest(providerName, modelId, cfg, apiKey, { disableThinking: false });
      resp = await sendPingFetch(req, ctrl.signal, opts.fetchFn);
    }

    const code = resp.status >= 200 && resp.status < 300 ? "200" : String(resp.status);
    const ms = Math.round(performance.now() - t0);
    const quotaObservations = extractQuotaObservations(resp.headers);

    return { code, ms, quotaObservations };
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      code: isTimeout ? "000" : "ERR",
      ms: isTimeout ? timeoutMs : Math.round(performance.now() - t0),
      quotaObservations: [],
    };
  } finally {
    clearTimeout(timer);
  }
}
