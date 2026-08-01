import { translateBetweenProviders, handleUniversalStreamRequest } from "llm-bridge";
import { buildAuthHeaders, readCredential } from "./authEnv.js";
import { type ResolvedTarget } from "./config.js";
import { DocumentError, transcodeDocuments } from "./documents.js";

/**
 * Response header stating who produced an error status: the provider, or this proxy.
 *
 * Every failure out of `fetchBackend` is a synthesized `Response` — a refused document, a
 * translation bug and a genuinely dead provider all arrived as a bare status code, so a
 * caller counting backend failures (the circuit breaker) charged our own local bugs to the
 * provider and failed over to a second provider that would have failed identically. The
 * marker is what makes them separable; `fetchBackend` states it, the caller decides.
 */
export const ERROR_ORIGIN_HEADER = "x-llm-relay-error-origin";

/** `upstream` = the provider answered with this status. `local` = the proxy produced it without asking. */
export type ErrorOrigin = "upstream" | "local";

/** Read the origin marker off a Response, when it carries one. */
export function errorOrigin(res: Response): ErrorOrigin | null {
  const v = res.headers.get(ERROR_ORIGIN_HEADER);
  return v === "upstream" || v === "local" ? v : null;
}

/**
 * Response header naming the deployment that actually answered — the (provider, model) left
 * standing after pool expansion, benchmark ranking, breaker demotion and failover.
 *
 * A pool request's most basic debugging question is "who served this?", and until now the only
 * way to answer it was to correlate timestamps against the proxy's own log. When every candidate
 * fails it carries the list that was tried instead, so an exhausted pool is self-describing.
 */
export const SERVED_BY_HEADER = "x-llm-relay-served-by";

/**
 * The provider's `Retry-After` in milliseconds, or null.
 *
 * Accepts both RFC 9110 forms — delta-seconds and an HTTP-date — because providers use both
 * (groq sends seconds, some CDNs in front of a provider send a date). A date in the past, a
 * negative delta or an unparseable value yields null rather than 0: "the provider said nothing
 * usable" and "the provider said retry immediately" call for different cooldowns, and treating
 * garbage as 0 would silently disable the backoff this exists to honour.
 */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0) return null;

  // delta-seconds — integer per the RFC, but providers do emit fractions ("20.45").
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const ms = Math.round(Number(raw) * 1000);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  }

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  const delta = at - now;
  return delta > 0 ? delta : null;
}

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
  // llm-bridge stringifies any block type it doesn't know, which would put a document's
  // whole base64 payload in the prompt. Convert documents to markdown first, or refuse.
  let reqJson = args.reqJson;
  try {
    reqJson = await transcodeDocuments(reqJson);
  } catch (e) {
    // Local, both of them: the provider was never asked. Charging these to the provider's
    // failure budget fails over to a second provider that would refuse the same document.
    if (e instanceof DocumentError) return anthropicError(400, `llm-relay: ${e.message}`, "local");
    return anthropicError(502, `document conversion failed: ${(e as Error).message}`, "local");
  }

  let openaiBody: Record<string, unknown>;
  try {
    openaiBody = translateBetweenProviders("anthropic", "openai", (reqJson ?? {}) as never) as Record<string, unknown>;
  } catch (e) {
    return anthropicError(502, `request translation failed: ${(e as Error).message}`, "local");
  }
  openaiBody.model = target.model;
  openaiBody.stream = args.wantsStream;
  // OpenAI-compatible backends omit usage from streamed responses unless asked. Without
  // this the translated `message_delta` reports output_tokens: 0 and anything metering
  // off the stream undercounts. Not universally supported — see the 400 retry below.
  if (args.wantsStream) openaiBody.stream_options = { include_usage: true };

  const post = (body: Record<string, unknown>) =>
    fetchFn(target.base + "/chat/completions", {
      method: "POST",
      headers: buildTargetHeaders(target),
      body: JSON.stringify(body),
      signal: args.signal,
    });

  let res = await post(openaiBody);

  // A backend that doesn't know `stream_options` rejects the whole request (400/422).
  // Drop the hint and retry once rather than failing a request over telemetry.
  if (!res.ok && openaiBody.stream_options && (res.status === 400 || res.status === 422)) {
    await res.body?.cancel().catch(() => {});
    const { stream_options: _omit, ...withoutUsage } = openaiBody;
    res = await post(withoutUsage);
  }

  if (!res.ok) {
    const body = await res.text();
    // A 404 here is nearly always the model id, not the route — and a provider's
    // /models catalog is not proof: several ids NIM lists return 404 from
    // /chat/completions. Say so, or this reads as a proxy bug.
    const hint =
      res.status === 404
        ? ` — model "${target.model}" is not served by provider "${target.provider}" (a model can be listed in /models and still 404 here)`
        : "";
    // The provider really answered with this status — the body is reworded, the origin is not.
    // `Retry-After` is carried onto the synthesized error: this response is a NEW Response, so
    // without this the one header stating when the provider will serve again was destroyed here,
    // and neither the breaker's cooldown nor the client's backoff could ever honour it.
    return anthropicError(res.status, `openai backend HTTP ${res.status}${hint}: ${body.slice(0, 300)}`, "upstream", {
      ...retryAfterHeader(res.headers),
    });
  }

  if (args.wantsStream && res.body) {
    const anthStream = handleUniversalStreamRequest(res.body, "openai", "anthropic");
    return new Response(anthStream, { status: res.status, headers: { "content-type": "text/event-stream" } });
  }

  let anthropicJson: object;
  try {
    anthropicJson = openAiResponseToAnthropic((await res.json()) as Record<string, unknown>, target.model ?? "");
  } catch (e) {
    // The provider answered 200; this 502 is ours. Marked local so it is not mistaken
    // for the provider being down — it is our mapper being wrong about a healthy one.
    return anthropicError(502, `response translation failed: ${(e as Error).message}`, "local");
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

/** The upstream's `Retry-After`, as a header object to spread, or `{}` when it sent none. */
function retryAfterHeader(hh: Headers): Record<string, string> {
  const v = hh.get("retry-after");
  return v ? { "retry-after": v } : {};
}

function anthropicError(
  status: number,
  message: string,
  origin: ErrorOrigin,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message } }), {
    status,
    headers: { "content-type": "application/json", [ERROR_ORIGIN_HEADER]: origin, ...extra },
  });
}

function openaiError(status: number, message: string, origin: ErrorOrigin): Response {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status,
    headers: { "content-type": "application/json", [ERROR_ORIGIN_HEADER]: origin },
  });
}

export type OpenAiFrontProtocol = "chat" | "responses";

/**
 * Turn an Anthropic Message response into the response envelope expected by an OpenAI client.
 *
 * This is deliberately separate from llm-bridge's request translation. Provider request bodies
 * and provider response bodies are different contracts, and treating a response as a request
 * loses tool calls, stop reasons and usage on the way back to the caller.
 */
export function anthropicMessageToOpenAi(
  body: Record<string, unknown>,
  protocol: OpenAiFrontProtocol,
  fallbackModel = "",
): Record<string, unknown> {
  const content = Array.isArray(body.content) ? body.content : [];
  const textParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      const input = block.input ?? {};
      toolCalls.push({
        id: typeof block.id === "string" ? block.id : `tool_call_${toolCalls.length}`,
        type: "function",
        function: {
          name: typeof block.name === "string" ? block.name : "",
          arguments: typeof input === "string" ? input : JSON.stringify(input),
        },
      });
    }
  }

  const text = textParts.join("");
  const model = typeof body.model === "string" && body.model ? body.model : fallbackModel;
  const usage = openAiUsage(body.usage);
  if (protocol === "chat") {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: text || null,
    };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    const out: Record<string, unknown> = {
      id: typeof body.id === "string" ? body.id : "chatcmpl_relay",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: openAiFinishReason(body.stop_reason, toolCalls.length > 0),
      }],
    };
    if (usage) out.usage = withOpenAiTotal(usage);
    return out;
  }

  const output: Array<Record<string, unknown>> = [];
  if (text) {
    output.push({
      type: "message",
      id: `msg_${typeof body.id === "string" ? body.id : "relay"}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const call of toolCalls) {
    const fn = call.function as Record<string, unknown>;
    output.push({
      type: "function_call",
      id: `fc_${call.id}`,
      call_id: call.id,
      name: fn.name,
      arguments: fn.arguments,
      status: "completed",
    });
  }
  const out: Record<string, unknown> = {
    id: typeof body.id === "string" ? body.id : "resp_relay",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    output_text: text,
  };
  if (usage) out.usage = withOpenAiTotal(usage);
  return out;
}

function openAiUsage(raw: unknown): { prompt_tokens?: number; completion_tokens?: number } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const usage = raw as Record<string, unknown>;
  // A usage object with no numeric fields is not a measurement. Keep the relay's unknown-vs-zero
  // convention instead of manufacturing a cost report for an upstream that omitted usage.
  if (typeof usage.input_tokens !== "number" && typeof usage.output_tokens !== "number") return null;
  return {
    ...(typeof usage.input_tokens === "number" ? { prompt_tokens: usage.input_tokens } : {}),
    ...(typeof usage.output_tokens === "number" ? { completion_tokens: usage.output_tokens } : {}),
  };
}

function withOpenAiTotal(usage: { prompt_tokens?: number; completion_tokens?: number }): Record<string, unknown> {
  if (typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number") {
    return { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens };
  }
  return { ...usage };
}

function openAiFinishReason(stopReason: unknown, hasToolCalls: boolean): string {
  if (hasToolCalls || stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "content_filter") return "content_filter";
  return "stop";
}

/** Map an Anthropic error envelope to a client-readable OpenAI error envelope. */
function anthropicErrorToOpenAi(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const top = parsed as Record<string, unknown>;
      const nested = typeof top.error === "object" && top.error !== null ? top.error as Record<string, unknown> : null;
      if (nested && typeof nested.message === "string") {
        return JSON.stringify({ error: {
          message: nested.message,
          type: typeof nested.type === "string" ? nested.type : "upstream_error",
          ...(nested.code !== undefined ? { code: nested.code } : {}),
        } });
      }
    }
  } catch {
    // Fall through to the normalizer, which preserves a useful bounded text message.
  }
  return normalizeOpenAiErrorBody(body, status) ?? body;
}

/**
 * Coerce an upstream error body into the OpenAI error envelope — WITHOUT rewriting one that
 * already conforms.
 *
 * The OpenAI front promises "OpenAI in, OpenAI out", but on the error path it returned whatever
 * shape the provider chose. Gemini wraps its error in a JSON ARRAY (`[{"error":{…}}]`); a client
 * reading `response.choices[0]` gets `undefined` from that and reports a malformed completion,
 * so a plain 429 surfaces as "the model returned garbage" — which is exactly how a rate limit
 * cost two days of debugging on the caller's side.
 *
 * Rules, in order:
 *   - already `{error:{…}}`     → returned BYTE-EXACT. A conforming provider's message, code and
 *                                 type are its own to state, and rewriting them would lose detail.
 *   - `[{error:{…}}, …]`        → unwrapped to the element. Same fields, now at the top level.
 *   - anything else (HTML, text,
 *     a bare string, empty)     → wrapped, with the original preserved as the message.
 *
 * Returns null when the body is already conforming, so the caller can stream the original bytes
 * rather than re-serialize them.
 */
export function normalizeOpenAiErrorBody(body: string, status: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const message = body.trim().slice(0, 2000) || `upstream returned HTTP ${status} with an empty body`;
    return JSON.stringify({ error: { message, type: "upstream_error", code: status } });
  }

  const hasError = (v: unknown): v is { error: Record<string, unknown> } =>
    typeof v === "object" && v !== null && typeof (v as { error?: unknown }).error === "object" && (v as { error?: unknown }).error !== null;

  if (hasError(parsed)) return null; // conforms — do not touch it

  if (Array.isArray(parsed)) {
    const wrapped = parsed.find(hasError);
    if (wrapped) return JSON.stringify(wrapped);
  }

  return JSON.stringify({
    error: {
      message: body.trim().slice(0, 2000) || `upstream returned HTTP ${status} with an empty body`,
      type: "upstream_error",
      code: status,
    },
  });
}

function buildTargetHeaders(target: ResolvedTarget): Record<string, string> {
  const key = readCredential(target.authEnv, process.env, target.provider);
  return {
    "content-type": "application/json",
    ...buildAuthHeaders(key, target.authHeader),
  };
}

/**
 * OpenAI-compatible FRONT: an OpenAI Chat Completions or Responses request comes in, its
 * `model` has already been resolved to a provider target by namespace/tier routing.
 *
 * The common case remains a byte-transparent OpenAI→OpenAI Chat Completions proxy. The other
 * combinations use the same Anthropic-shaped internal seam as the Messages front:
 * OpenAI request → Anthropic request → resolved backend → Anthropic response → OpenAI response.
 * That makes an Anthropic passthrough usable from Codex and OpenAI-native IDEs without changing
 * the existing Claude client path.
 */
export async function fetchOpenAiFront(
  target: ResolvedTarget,
  args: {
    reqJson: unknown;
    wantsStream: boolean;
    signal: AbortSignal;
    protocol?: OpenAiFrontProtocol;
    anthropicHeaders?: Record<string, string>;
  },
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const protocol = args.protocol ?? "chat";
  const base = (args.reqJson ?? {}) as Record<string, unknown>;
  // Preserve the existing direct path for the protocol/backend pair that already speaks the
  // same wire format. It keeps provider-specific OpenAI fields byte-for-byte intact.
  if (target.kind === "openai" && protocol === "chat") {
    const body = { ...base, model: target.model, stream: args.wantsStream };
    return fetchFn(target.base + "/chat/completions", {
      method: "POST",
      headers: buildTargetHeaders(target),
      body: JSON.stringify(body),
      signal: args.signal,
    });
  }

  let anthropicBody: Record<string, unknown>;
  try {
    const source = protocol === "responses" ? "openai-responses" : "openai";
    anthropicBody = translateBetweenProviders(source, "anthropic", base as never) as Record<string, unknown>;
    if (target.model !== undefined) anthropicBody.model = target.model;
    anthropicBody.stream = args.wantsStream;
  } catch (e) {
    return openaiError(400, `llm-relay: request translation failed: ${(e as Error).message}`, "local");
  }

  const reqBuf = Buffer.from(JSON.stringify(anthropicBody), "utf8");
  const backendRes = await fetchBackend(target, {
    path: "/v1/messages",
    method: "POST",
    reqBuf,
    reqJson: anthropicBody,
    anthropicHeaders: args.anthropicHeaders ?? {},
    wantsStream: args.wantsStream,
    signal: args.signal,
  }, fetchFn);

  if (!backendRes.ok) {
    const raw = await backendRes.text().catch(() => "");
    const origin = errorOrigin(backendRes) ?? "upstream";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [ERROR_ORIGIN_HEADER]: origin,
      ...retryAfterHeader(backendRes.headers),
    };
    return new Response(anthropicErrorToOpenAi(raw, backendRes.status), { status: backendRes.status, headers });
  }

  const streamed = args.wantsStream || (backendRes.headers.get("content-type") ?? "").includes("text/event-stream");
  if (streamed && backendRes.body) {
    const targetProtocol = protocol === "responses" ? "openai-responses" : "openai";
    const output = handleUniversalStreamRequest(backendRes.body, "anthropic", targetProtocol);
    return new Response(output, { status: backendRes.status, headers: { "content-type": "text/event-stream" } });
  }

  try {
    const body = (await backendRes.json()) as Record<string, unknown>;
    return new Response(JSON.stringify(anthropicMessageToOpenAi(body, protocol, target.model ?? String(base.model ?? ""))), {
      status: backendRes.status,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return openaiError(502, `llm-relay: response translation failed: ${(e as Error).message}`, "local");
  }
}
