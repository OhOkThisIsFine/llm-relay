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
 * OpenAI-compatible FRONT: an OpenAI `/chat/completions` request comes in, its `model`
 * has already been resolved to a provider target by namespace/tier routing. For an
 * openai-kind target this is a routing reverse-proxy — rewrite `model` to the backend
 * id, inject the backend key, and stream the upstream OpenAI response straight back
 * (OpenAI in, OpenAI out — no translation). This is the transport a dispatcher (e.g.
 * an external dispatcher) consumes to reach many backends behind one endpoint.
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
    return openaiError(
      400,
      `llm-relay: OpenAI front requires an openai-kind provider; "${target.provider}" is ${target.kind}`,
      "local",
    );
  }
  const base = (args.reqJson ?? {}) as Record<string, unknown>;
  const body = { ...base, model: target.model, stream: args.wantsStream };
  return fetchFn(target.base + "/chat/completions", {
    method: "POST",
    headers: buildTargetHeaders(target),
    body: JSON.stringify(body),
    signal: args.signal,
  });
}
