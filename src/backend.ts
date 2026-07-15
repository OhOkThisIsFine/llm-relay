import { translateBetweenProviders, handleUniversalStreamRequest } from "llm-bridge";
import { type ResolvedTarget } from "./config.js";

/**
 * Fetch the resolved provider target and return an ANTHROPIC-shaped `Response`,
 * regardless of the backend's native wire format. For kind="anthropic" this is a
 * passthrough. For kind="openai" (NIM/vLLM/OpenRouter/Gemini) the request is
 * translated Anthropic→OpenAI and the response translated back (streaming via
 * llm-bridge's SSE re-encoder, non-streaming via a direct mapper) — so the rest
 * of the proxy (validate/repair) always sees Anthropic Messages.
 */
export async function fetchBackend(
  target: ResolvedTarget,
  args: {
    path: string;
    method: string;
    reqBuf: Buffer;
    reqJson: unknown;
    anthropicHeaders: Record<string, string>;
    wantsStream: boolean;
    signal: AbortSignal;
  },
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  if (target.kind === "anthropic") {
    const init: RequestInit = { method: args.method, headers: args.anthropicHeaders, signal: args.signal };
    if (args.reqBuf.length) init.body = args.reqBuf;
    return fetchFn(target.base + args.path, init);
  }

  // kind === "openai"
  let openaiBody: Record<string, unknown>;
  try {
    openaiBody = translateBetweenProviders("anthropic", "openai", (args.reqJson ?? {}) as never) as Record<string, unknown>;
  } catch (e) {
    return anthropicError(502, `request translation failed: ${(e as Error).message}`);
  }
  openaiBody.model = target.model;
  openaiBody.stream = args.wantsStream;

  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = target.authEnv ? process.env[target.authEnv]?.trim() : undefined;
  if (key) {
    if (target.authHeader === "authorization") headers["authorization"] = `Bearer ${key}`;
    else headers["x-api-key"] = key;
  }

  const res = await fetchFn(target.base + "/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(openaiBody),
    signal: args.signal,
  });

  if (!res.ok) {
    const body = await res.text();
    return anthropicError(res.status, `openai backend HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  if (args.wantsStream && res.body) {
    const anthStream = handleUniversalStreamRequest(res.body, "openai", "anthropic");
    return new Response(anthStream, { status: res.status, headers: { "content-type": "text/event-stream" } });
  }

  let anthropicJson: object;
  try {
    anthropicJson = openAiResponseToAnthropic((await res.json()) as Record<string, unknown>, target.model ?? "");
  } catch (e) {
    return anthropicError(502, `response translation failed: ${(e as Error).message}`);
  }
  return new Response(JSON.stringify(anthropicJson), { status: 200, headers: { "content-type": "application/json" } });
}

/** Map a non-streaming OpenAI chat completion into an Anthropic message. */
export function openAiResponseToAnthropic(j: Record<string, unknown>, model: string): object {
  const choice = (j.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
  const msg = (choice.message as Record<string, unknown> | undefined) ?? {};
  const content: object[] = [];
  if (typeof msg.content === "string" && msg.content.length > 0) content.push({ type: "text", text: msg.content });
  const toolCalls = (msg.tool_calls as Array<Record<string, unknown>> | undefined) ?? [];
  for (const tc of toolCalls) {
    const fn = (tc.function as Record<string, unknown> | undefined) ?? {};
    let input: unknown;
    try { input = JSON.parse((fn.arguments as string) ?? "{}"); } catch { input = fn.arguments ?? {}; }
    content.push({ type: "tool_use", id: (tc.id as string) ?? "tu", name: (fn.name as string) ?? "", input });
  }
  const finish = choice.finish_reason as string | undefined;
  const stopReason =
    toolCalls.length > 0 ? "tool_use" : finish === "length" ? "max_tokens" : finish === "stop" ? "end_turn" : finish ?? "end_turn";
  const usage = (j.usage as Record<string, number> | undefined) ?? {};
  return {
    id: (j.id as string) ?? "msg_translated",
    type: "message",
    role: "assistant",
    model: model || ((j.model as string) ?? ""),
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 },
  };
}

function anthropicError(status: number, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openaiError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * OpenAI-compatible FRONT: an OpenAI `/chat/completions` request comes in, its `model`
 * has already been resolved to a provider target by namespace/tier routing. For an
 * openai-kind target this is a routing reverse-proxy — rewrite `model` to the backend
 * id, inject the backend key, and stream the upstream OpenAI response straight back
 * (OpenAI in, OpenAI out — no translation). This is the transport a dispatcher (e.g.
 * audit-tools) consumes to reach many backends behind one endpoint.
 *
 * anthropic-kind targets are not served on the OpenAI front (they need OpenAI↔Anthropic
 * translation and are not the dispatcher use case) — a clean 400, never a mistranslation.
 */
export async function fetchOpenAiFront(
  target: ResolvedTarget,
  args: { reqJson: unknown; wantsStream: boolean; signal: AbortSignal },
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  if (target.kind !== "openai") {
    return openaiError(400, `repair-proxy: OpenAI front requires an openai-kind provider; "${target.provider}" is ${target.kind}`);
  }
  const base = (args.reqJson ?? {}) as Record<string, unknown>;
  const body = { ...base, model: target.model, stream: args.wantsStream };
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = target.authEnv ? process.env[target.authEnv]?.trim() : undefined;
  if (key) {
    if (target.authHeader === "authorization") headers["authorization"] = `Bearer ${key}`;
    else headers["x-api-key"] = key;
  }
  return fetchFn(target.base + "/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: args.signal,
  });
}
