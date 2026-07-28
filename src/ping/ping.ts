import type { ProviderConfig } from "../config.js";

export const DEFAULT_PING_TIMEOUT_MS = 15000;
export const DEFAULT_BENCHMARK_TIMEOUT_MS = 20000;

const DISABLED_THINKING_RETRY_STATUSES = new Set([400, 422]);
const disabledThinkingUnsupportedProviders = new Set<string>();

export interface PingResult {
  code: string;
  ms: number;
  quotaPercent: number | null;
}

export interface BenchmarkResult {
  ok: boolean;
  code: string;
  totalMs: number;
  outputTokens: number;
  tokensPerSecond: number;
  answerPreview: string;
}

function getHeaderValue(headers: Headers | Record<string, string | undefined>, key: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(key);
  }
  const obj = headers as Record<string, string | undefined>;
  return obj[key] ?? obj[key.toLowerCase()] ?? null;
}

/** Parse rate-limit response headers to calculate remaining quota percentage (0–100). */
export function extractQuotaPercent(headers: Headers | Record<string, string | undefined>): number | null {
  const variants: Array<[string, string]> = [
    ["x-ratelimit-remaining", "x-ratelimit-limit"],
    ["x-ratelimit-remaining-requests", "x-ratelimit-limit-requests"],
    ["x-ratelimit-remaining-requests-day", "x-ratelimit-limit-requests-day"],
    ["x-ratelimit-remaining-tokens", "x-ratelimit-limit-tokens"],
    ["x-ratelimit-remaining-tokens-minute", "x-ratelimit-limit-tokens-minute"],
    ["ratelimit-remaining", "ratelimit-limit"],
    ["ratelimit-remaining-requests", "ratelimit-limit-requests"],
  ];

  for (const [remainingKey, limitKey] of variants) {
    const remainingRaw = getHeaderValue(headers, remainingKey);
    const limitRaw = getHeaderValue(headers, limitKey);
    if (remainingRaw !== null && limitRaw !== null) {
      const remaining = parseFloat(remainingRaw);
      const limit = parseFloat(limitRaw);

      if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
        const pct = Math.round((remaining / limit) * 100);
        return Math.max(0, Math.min(100, pct));
      }
    }
  }

  return null;
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
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (apiKey) {
    if (cfg.authHeader === "x-api-key" || cfg.kind === "anthropic") {
      headers["x-api-key"] = apiKey;
    } else {
      headers["authorization"] = apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
    }
  }

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
    const quotaPercent = extractQuotaPercent(resp.headers);

    return { code, ms, quotaPercent };
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      code: isTimeout ? "000" : "ERR",
      ms: isTimeout ? timeoutMs : Math.round(performance.now() - t0),
      quotaPercent: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Execute a benchmark prompt against a provider model to measure throughput (TPS). */
export async function benchmarkProviderModel(
  providerName: string,
  modelId: string,
  cfg: ProviderConfig,
  apiKey?: string,
  opts: { prompt?: string; maxTokens?: number; timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<BenchmarkResult> {
  const prompt = opts.prompt ?? "Why is the sky blue? Answer in exactly one paragraph of 80 to 100 words.";
  const maxTokens = opts.maxTokens ?? 140;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BENCHMARK_TIMEOUT_MS;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();

  try {
    const url = buildPingEndpoint(cfg.base, cfg.kind);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      if (cfg.authHeader === "x-api-key" || cfg.kind === "anthropic") {
        headers["x-api-key"] = apiKey;
      } else {
        headers["authorization"] = apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
      }
    }

    let body: Record<string, unknown>;
    if (cfg.kind === "openai") {
      body = {
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
      };
    } else {
      headers["anthropic-version"] = "2023-06-01";
      body = {
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
      };
    }

    const resp = await (opts.fetchFn ?? fetch)(url, {
      method: "POST",
      signal: ctrl.signal,
      headers,
      body: JSON.stringify(body),
    });

    const totalMs = Math.round(performance.now() - t0);
    const text = await resp.text();
    let data: Record<string, any> | null = null;
    try {
      data = JSON.parse(text);
    } catch {}

    if (!resp.ok) {
      return {
        ok: false,
        code: String(resp.status),
        totalMs,
        outputTokens: 0,
        tokensPerSecond: 0,
        answerPreview: "",
      };
    }

    let content = "";
    let outputTokens = 0;

    if (cfg.kind === "openai") {
      content = data?.choices?.[0]?.message?.content || "";
      outputTokens = data?.usage?.completion_tokens ?? Math.ceil(content.length / 4);
    } else {
      content = data?.content?.[0]?.text || "";
      outputTokens = data?.usage?.output_tokens ?? Math.ceil(content.length / 4);
    }

    const seconds = totalMs / 1000;
    const tokensPerSecond = seconds > 0 ? Math.round(outputTokens / seconds) : 0;

    return {
      ok: true,
      code: "200",
      totalMs,
      outputTokens,
      tokensPerSecond,
      answerPreview: content.slice(0, 60),
    };
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      code: isTimeout ? "TIMEOUT" : "ERR",
      totalMs: Math.round(performance.now() - t0),
      outputTokens: 0,
      tokensPerSecond: 0,
      answerPreview: "",
    };
  } finally {
    clearTimeout(timer);
  }
}
