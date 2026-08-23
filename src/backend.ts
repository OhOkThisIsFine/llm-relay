import { translateBetweenProviders, handleUniversalStreamRequest } from "llm-bridge";
import { buildAuthHeaders } from "./authEnv.js";
import type { ResolvedAttempt } from "./resolved-attempt.js";
import { DocumentError, transcodeDocuments } from "./documents.js";
import { anthropicRequestToOpenAi, RequestMappingError } from "./openai-request.js";
import { recoverToolCalls, type DialectToolCall } from "./tool-dialects.js";
import { recoverDialectInStream } from "./dialect-stream.js";
import { toolSchemaMap } from "./anthropic.js";
import { stripOpeningThinkTag, stripThinkTagsInStream } from "./think-tags.js";
import { knownToolUseIds, rewriteToolUseIds, rewriteToolUseIdsInStream } from "./tool-use-ids.js";
import { STREAM_PREFLIGHT_LIMIT } from "./stream-commit.js";
import {
  inspectDialectInOpenAiChat,
  recoverDialectInOpenAiChatStream,
  type RecoveredOpenAiChatProcessor,
} from "./openai-dialect.js";
import { observeUsage, type UsageAccumulator } from "./usage-observer.js";

/**
 * A tool-call envelope was present in the response text but could not be parsed — truncated, or a
 * dialect variant we do not model. Distinct from a mapper defect: the relay's translation is fine,
 * the SERVING HOST returned an unusable body. Carried as a retriable failure so the pool fails over
 * to a host that parses its models' dialect.
 */
export class DialectUnparseableError extends Error {
  constructor(public readonly dialect: string) {
    super(`backend returned an unparseable ${dialect} tool-call envelope as text`);
    this.name = "DialectUnparseableError";
  }
}

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
 * WHY each of those candidates dropped out — `"13 tried, 0 served: 4×402, 5×429, 3×403, 1×400"`.
 *
 * `SERVED_BY_HEADER` answers "who was tried"; this answers "what happened to them", which is the
 * half that turns a pool exhaustion into a diagnosis. Without it a client holds one member's
 * error — a HuggingFace 402 pointing at a billing page — while the other twelve failed for three
 * unrelated reasons, and the correct action ("use another pool") is invisible.
 *
 * A header rather than a rewritten body, deliberately: the served body stays the last candidate's
 * real upstream error, because a true upstream error beats a synthesized one.
 */
export const POOL_ATTEMPTS_HEADER = "x-llm-relay-pool-attempts";
/** Response metadata headers for credential-aware pool diagnostics. */
export const CREDENTIAL_HEADER = "x-llm-relay-credential";
export const CREDENTIAL_ATTEMPTS_HEADER = "x-llm-relay-credential-attempts";

/**
 * How many refusals in this walk said something the relay could not interpret.
 *
 * The learned-eligibility store converges only as fast as somebody explains the messages it does
 * not recognise, and a pull-only queue is a backlog nobody works. This is the push half: the
 * caller — which is usually an agent that is about to report a pool failure to a human anyway —
 * finds out at the moment it matters that a NEW kind of refusal just appeared, and can run
 * `llm-relay eligibility` while the context is still in hand.
 *
 * ⚠ It is a COUNT, never the message. The message is untrusted text from an external service, and
 * putting it in a response header would be the relay handing an agent attacker-controlled prose in
 * a field agents tend to trust. The count says "go look"; `llm-relay eligibility` shows the text
 * with its provenance and the enum-constrained verdicts it may receive.
 */
export const UNKNOWN_REFUSAL_HEADER = "x-llm-relay-unknown-refusal";

type OnEgress = () => void;

function oneShotFetch(
  fetchFn: typeof fetch,
  signal: AbortSignal,
  onEgress?: OnEgress,
): typeof fetch {
  let invoked = false;
  return (input, init) => {
    if (!invoked && !signal.aborted) {
      invoked = true;
      onEgress?.();
    }
    return fetchFn(input, init);
  };
}

/**
 * This answer came from BELOW the effort band that was asked for.
 *
 * An effort pool falls back to lower-banded live members once its own band is exhausted, because a
 * band with nothing behind it turns "the strongest models are busy" into "no answer at all". That
 * fallback is automatic — but it must never be silent. A capability downgrade that reads as an
 * ordinary 200 is indistinguishable from having got what you asked for, which is the failure mode
 * that lets a caller build on a weaker answer without knowing it did.
 *
 * Names the deployment and the band it fell out of, e.g. `groq/llama-3.3-70b (below xhigh)`.
 */
export const DEGRADED_HEADER = "x-llm-relay-degraded";

/**
 * The walk's FIRST choice was demoted for a spent quota and the answer came from further down.
 *
 * Same maxim as `DEGRADED_HEADER` — automatic degradation is acceptable only because it is
 * announced — but a different fact: capability fell below the requested band there, while here a
 * quota figure said the first choice was spent until a known reset. Value is one bounded line,
 * e.g. `groq/llama-3.3-70b (requests/minute remaining 0, provider-stated)` — axis/period/remaining
 * plus the basis, no credential values, nothing secret.
 */
export const QUOTA_DEMOTED_HEADER = "x-llm-relay-quota-demoted";

/**
 * This request was refused by an OPERATOR-SET HARD CAP (G2) — not by a provider.
 *
 * Value is one line per capped credential cell, e.g.
 * `a/nim/z-ai/glm-5.2 requests/day 450/450` — label/deployment, axis/period, the inclusive
 * used/cap pair. Present only when EVERY walked candidate was capped: a partial walk serves
 * from whoever remained, and the pool-attempts header carries the `Nxcapped` tally beside the
 * other outcomes instead. Nothing secret: the label is the config slot name, the figures are
 * the operator's own declaration and this relay's own ledger reading.
 *
 * BOUNDED by cell count, not just by cell width: at most `MAX_CAPPED_HEADER_CELLS` (5) cells are
 * named and the rest are counted as `+K more`. A capped attempt costs no walk start budget, so a
 * fully capped 30-member dynamic pool reaches every one of them and an unbounded join would be a
 * ~1.2 KB header. The header says what stopped the request; it is not a roster.
 */
export const HARD_CAP_HEADER = "x-llm-relay-capped";

/**
 * This answer came from a deployment that is NOT free.
 *
 * Pools rank free capacity first but no longer exclude paid capacity, so a spent free lane is not
 * a dead end. That is only acceptable if spending is announced: an unflagged paid response is
 * indistinguishable from a free one, and the difference is money. Same reasoning as
 * `DEGRADED_HEADER` — automatic fallback is fine, silent fallback is not.
 *
 * Carries the deployment and how its cost was assessed, e.g.
 * `openrouter/anthropic/claude-sonnet-5 (paid, published-price)`.
 */
export const PAID_HEADER = "x-llm-relay-paid";

/** This response contains a tool call reconstructed from a recognized text dialect envelope. */
export const TOOL_DIALECT_HEADER = "x-llm-relay-tool-dialect";

/**
 * `tool_use` ids in this response were MINTED by the relay because the host reused ones the
 * conversation already carried — value `"<n> rewritten"`.
 *
 * Same maxim as `DEGRADED_HEADER`: an automatic fix is acceptable only because it is announced.
 * A count, never an id: the ids themselves are in the body the caller already has, and a header
 * is not the place to restate content.
 *
 * ⚠ Buffered responses only. On a stream the headers are written before the first
 * `content_block_start` exists, so a count there could only be a guess; the streaming pass
 * reports through `toolUseIdRewrites()` instead, which the server reads for its log record after
 * the stream drains. See `src/tool-use-ids.ts`.
 */
export const TOOL_USE_IDS_HEADER = "x-llm-relay-tool-use-ids";

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

type ResponseProtocol = "openai-chat" | "anthropic-messages";

interface UpstreamResponseMetadata {
  reportedModel?: string;
  /**
   * How many `tool_use` ids the relay had to mint for this response (`tool-use-ids.ts`). Mutable
   * after the Response exists on purpose: on a stream the pass runs while the body drains, and the
   * server reads this where it reports end-of-stream facts. A count, never an id.
   */
  toolUseIdRewrites?: number;
}

// Response provenance is private process state, not a wire header: callers can
// read it for logging without accidentally forwarding it to the client.
const upstreamResponseMetadata = new WeakMap<Response, UpstreamResponseMetadata>();

/**
 * A fetch completed far enough to yield provider headers, but consuming its body failed.
 *
 * This is process-local metadata rather than a wire marker. Adapters sometimes have to consume
 * and rebuild an error response before the routing loop sees it; retaining this discriminant on
 * the original Response prevents that failure from being rewritten as an empty credential error.
 */
export interface PostHeaderBodyFailure {
  readonly kind: "post-header-body-failure";
  readonly cause: unknown;
}

const postHeaderBodyFailures = new WeakMap<Response, PostHeaderBodyFailure>();

function attachPostHeaderBodyFailure(response: Response, cause: unknown): Response {
  postHeaderBodyFailures.set(response, { kind: "post-header-body-failure", cause });
  return response;
}

/** Read adapter-private post-header body failure metadata. */
export function postHeaderBodyFailure(response: Response): PostHeaderBodyFailure | undefined {
  return postHeaderBodyFailures.get(response);
}

/** Raw model id stated by the upstream response, before any relay translation. */
export function upstreamReportedModel(response: Response): string | undefined {
  return upstreamResponseMetadata.get(response)?.reportedModel;
}

/**
 * How many `tool_use` ids this response had minted, or `undefined` when none were.
 *
 * On a streamed response the figure is final only once the body has drained — read it where the
 * server reports end-of-stream facts, not before it writes headers.
 */
export function toolUseIdRewrites(response: Response): number | undefined {
  const n = upstreamResponseMetadata.get(response)?.toolUseIdRewrites;
  return n !== undefined && n > 0 ? n : undefined;
}

function attachUpstreamMetadata(response: Response, metadata: UpstreamResponseMetadata): Response {
  upstreamResponseMetadata.set(response, metadata);
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate only the protocol structure the response mappers rely on. Optional identifiers,
 * model names and usage remain optional because several compatible providers legitimately omit
 * them; the required response discriminator must not be optional, or `{}` becomes a successful
 * empty assistant message.
 */
function invalidEnvelopeReason(value: unknown, protocol: ResponseProtocol, streamed: boolean): string | null {
  if (!isRecord(value)) return "expected a JSON object";

  // An error envelope seen here under `streamed` is the FIRST event of a 2xx stream — preflight
  // inspects nothing later, so this cannot fire mid-stream. Pre-commit, an in-band error frame
  // is a dead turn, not a response: failing it makes the candidate loop walk on to a member
  // that answers, where forwarding it spent the whole pool on one member's error inside a 200
  // (adoption review §1.1). An error frame arriving AFTER a valid first event still streams
  // through untouched — post-commit, honesty beats replay. The reason carries a bounded excerpt
  // of the upstream's own message, same maxim as serving the last candidate's real error.
  if (streamed && isRecord(value.error)) {
    const message = typeof value.error.message === "string" ? value.error.message.slice(0, 200) : "";
    return message
      ? `stream opened with an in-band error event: ${message}`
      : "stream opened with an in-band error event";
  }

  if (protocol === "openai-chat") {
    if (!Array.isArray(value.choices)) return "missing choices array";
    if (streamed && value.choices.length === 0) {
      return isRecord(value.usage) ? null : "empty choices without usage";
    }
    if (value.choices.length === 0) return "empty choices array";
    for (const rawChoice of value.choices) {
      if (!isRecord(rawChoice)) return "choice is not an object";
      const message = streamed ? rawChoice.delta : rawChoice.message;
      if (!isRecord(message)) return streamed ? "choice is missing delta" : "choice is missing message";
      if (!streamed && message.tool_calls !== undefined && message.tool_calls !== null) {
        if (!Array.isArray(message.tool_calls)) return "message tool_calls is not an array";
        for (const rawCall of message.tool_calls) {
          if (!isRecord(rawCall) || !isRecord(rawCall.function)) return "invalid tool call";
          if (typeof rawCall.function.name !== "string" || typeof rawCall.function.arguments !== "string") {
            return "invalid tool function";
          }
        }
      }
      if (!streamed) {
        const hasContent = message.content === null || typeof message.content === "string";
        const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
        if (!hasContent && !hasToolCalls) return "message has neither content nor tool calls";
      }
    }
    return null;
  }

  if (!streamed) {
    if (!Array.isArray(value.content)) return "missing content array";
    for (const rawBlock of value.content) {
      if (!isRecord(rawBlock) || typeof rawBlock.type !== "string") return "invalid content block";
      if (rawBlock.type === "text" && typeof rawBlock.text !== "string") return "text block is missing text";
      if (rawBlock.type === "tool_use" && typeof rawBlock.name !== "string") return "tool_use block is missing name";
    }
    return null;
  }

  switch (value.type) {
    case "ping":
    case "message_stop":
    case "content_block_stop":
      return null;
    case "message_start":
      return isRecord(value.message) ? null : "message_start is missing message";
    case "content_block_start":
      return isRecord(value.content_block) ? null : "content_block_start is missing content_block";
    case "content_block_delta":
    case "message_delta":
      return isRecord(value.delta) ? null : `${String(value.type)} is missing delta`;
    case "error":
      return isRecord(value.error) ? null : "error event is missing error";
    default:
      return "missing or unknown Anthropic event type";
  }
}

type StreamPreflight =
  | { ok: true; body: ReadableStream<Uint8Array>; metadata: UpstreamResponseMetadata }
  | { ok: false; reason: string };

function captureReportedModel(
  metadata: UpstreamResponseMetadata,
  value: unknown,
  protocol: ResponseProtocol,
  streamed: boolean,
): void {
  if (metadata.reportedModel !== undefined || !isRecord(value)) return;
  const envelope = protocol === "anthropic-messages" && streamed && value.type === "message_start"
    ? value.message
    : value;
  if (isRecord(envelope) && typeof envelope.model === "string") {
    metadata.reportedModel = envelope.model;
  }
}

/** Inspect the first data event before handing a provider stream to llm-bridge. */
async function preflightResponseStream(
  body: ReadableStream<Uint8Array>,
  protocol: ResponseProtocol,
): Promise<StreamPreflight> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const metadata: UpstreamResponseMetadata = {};
  let buffered = "";
  let byteLength = 0;

  const captureCompleteEvents = (final = false): void => {
    let boundary: RegExpExecArray | null;
    const separator = /\r?\n\r?\n/g;
    while ((boundary = separator.exec(buffered)) !== null) {
      const event = buffered.slice(0, boundary.index);
      buffered = buffered.slice(boundary.index + boundary[0].length);
      separator.lastIndex = 0;
      captureEventModel(event);
    }
    if (final && buffered.trim()) captureEventModel(buffered);
  };

  const replay = (): StreamPreflight => {
    let prefixIndex = 0;
    // The first valid event can be a ping. Keep observing the untouched raw
    // stream while the consumer drains it so a later message_start/chunk can
    // still supply the upstream's model before terminal logging.
    captureCompleteEvents();
    return { ok: true, metadata, body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (prefixIndex < chunks.length) {
          controller.enqueue(chunks[prefixIndex++]!);
          return;
        }
        try {
          const more = await reader.read();
          if (more.done) {
            buffered += decoder.decode();
            captureCompleteEvents(true);
            controller.close();
          } else {
            buffered += decoder.decode(more.value, { stream: true });
            captureCompleteEvents();
            controller.enqueue(more.value);
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reasonToCancel) {
        await reader.cancel(reasonToCancel).catch(() => {});
      },
    }) };
  };

  const fail = async (reason: string): Promise<StreamPreflight> => {
    await reader.cancel().catch(() => {});
    return { ok: false, reason };
  };

  const inspectEvent = (event: string): string | null | undefined => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) return undefined;
    if (data === "[DONE]") return "stream ended before a response event";
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return "data event is not valid JSON";
    }
    captureReportedModel(metadata, parsed, protocol, true);
    return invalidEnvelopeReason(parsed, protocol, true);
  };

  const captureEventModel = (event: string): void => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;
    try {
      captureReportedModel(metadata, JSON.parse(data), protocol, true);
    } catch {
      // Preflight owns envelope validity; this observer owns provenance only.
    }
  };

  while (byteLength <= STREAM_PREFLIGHT_LIMIT) {
    const next = await reader.read().catch(() => null);
    if (next === null) return fail("stream failed during preflight");
    if (next.done) {
      buffered += decoder.decode();
      let finalReason = buffered.trim() ? inspectEvent(buffered) : undefined;
      // A few compatible providers ignore `stream: true` and return one valid buffered
      // completion. Preserve the old adapter behaviour for that genuine envelope.
      if (finalReason === undefined && buffered.trim()) {
        try {
          const parsed = JSON.parse(buffered);
          captureReportedModel(metadata, parsed, protocol, false);
          finalReason = invalidEnvelopeReason(parsed, protocol, false);
        } catch {
          // The SSE-specific reason below remains more useful.
        }
      }
      if (finalReason === null) return replay();
      return fail(finalReason ?? "stream ended before a response event");
    }
    chunks.push(next.value);
    byteLength += next.value.byteLength;
    if (byteLength > STREAM_PREFLIGHT_LIMIT) return fail("no response event within preflight limit");
    buffered += decoder.decode(next.value, { stream: true });

    let boundary: RegExpExecArray | null;
    const separator = /\r?\n\r?\n/g;
    while ((boundary = separator.exec(buffered)) !== null) {
      const event = buffered.slice(0, boundary.index);
      buffered = buffered.slice(boundary.index + boundary[0].length);
      separator.lastIndex = 0;
      const reason = inspectEvent(event);
      if (reason === undefined) continue;
      if (reason !== null) return fail(reason);

      return replay();
    }
  }

  return fail("no response event within preflight limit");
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
  attempt: ResolvedAttempt,
  args: {
    path: string;
    method: string;
    reqBuf: Buffer;
    reqJson: unknown;
    anthropicHeaders: Record<string, string>;
    wantsStream: boolean;
    usage?: UsageAccumulator;
    signal: AbortSignal;
    onEgress?: OnEgress;
  },
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const invokeFetch = oneShotFetch(fetchFn, args.signal, args.onEgress);
  const target = attempt.target;
  if (target.kind === "anthropic") {
    const init: RequestInit = { method: args.method, headers: args.anthropicHeaders, signal: args.signal };
    if (args.reqBuf.length) init.body = args.reqBuf;
    const native = await invokeFetch(target.base + args.path, init);
    const nativeStreamed = nativeResponseIsStreamed(native, args.wantsStream);
    const res = args.usage
      ? observeUsage(native, "anthropic-messages", args.usage, { streamed: nativeStreamed })
      : native;
    // Preserve passthrough bytes, but do not preserve a successful status for a malformed
    // Messages envelope. Inspecting a clone leaves the original buffered body byte-exact.
    const messagesPath = args.path.split("?", 1)[0] === "/v1/messages";
    if (!res.ok || !messagesPath) return res;
    const streamed = args.wantsStream || (res.headers.get("content-type") ?? "").includes("text/event-stream");
    if (streamed) {
      if (!res.body) {
        return anthropicError(502, "llm-relay: invalid Anthropic upstream envelope: empty stream", "upstream", {
          ...retryAfterHeader(res.headers),
        }, "invalid_upstream_envelope");
      }
      const preflight = await preflightResponseStream(res.body, "anthropic-messages");
      if (!preflight.ok) {
        return anthropicError(502, `llm-relay: invalid Anthropic upstream envelope: ${preflight.reason}`, "upstream", {
          ...retryAfterHeader(res.headers),
        }, "invalid_upstream_envelope");
      }
      return attachUpstreamMetadata(
        new Response(preflight.body, { status: res.status, headers: res.headers }),
        preflight.metadata,
      );
    }

    let body: unknown;
    try {
      body = await res.clone().json();
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) return attachPostHeaderBodyFailure(res, cause);
      return anthropicError(502, "llm-relay: invalid Anthropic upstream envelope: body is not valid JSON", "upstream", {
        ...retryAfterHeader(res.headers),
      }, "invalid_upstream_envelope");
    }
    const invalidReason = invalidEnvelopeReason(body, "anthropic-messages", false);
    if (invalidReason) {
      return anthropicError(502, `llm-relay: invalid Anthropic upstream envelope: ${invalidReason}`, "upstream", {
        ...retryAfterHeader(res.headers),
      }, "invalid_upstream_envelope");
    }
    const metadata: UpstreamResponseMetadata = {};
    captureReportedModel(metadata, body, "anthropic-messages", false);
    return attachUpstreamMetadata(res, metadata);
  }

  // kind === "openai"
  // Documents are transcoded to markdown BEFORE the request mapper, or refused: a `document`
  // block has no OpenAI representation, and the pre-mapper behaviour put its whole base64
  // payload into the prompt. The pre-pass walks the top level of each turn AND the content of
  // each `tool_result`, so a document a tool returned is converted rather than refused.
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
    // The REQUEST direction is relay-owned (`openai-request.ts`); only the RESPONSE direction is
    // still llm-bridge's. llm-bridge's `universalToOpenAI` has no case for a tool_call/tool_result
    // block, so it stringified its own IR envelope into the outbound prompt — see
    // docs/tool-call-dialect-leak.md §"Second mechanism".
    openaiBody = anthropicRequestToOpenAi(reqJson, { model: target.model, stream: args.wantsStream });
  } catch (e) {
    // A block we will not put on the wire is the caller's request being unrepresentable, not a
    // provider failure — same clean local 400 as an unconvertible document.
    if (e instanceof RequestMappingError) return anthropicError(400, `llm-relay: ${e.message}`, "local");
    return anthropicError(502, `request translation failed: ${(e as Error).message}`, "local");
  }
  // OpenAI-compatible backends omit usage from streamed responses unless asked. Without
  // this the translated `message_delta` reports output_tokens: 0 and anything metering
  // off the stream undercounts. Not universally supported — see the 400 retry below.
  if (args.wantsStream) openaiBody.stream_options = { include_usage: true };

  const post = (body: Record<string, unknown>) =>
    invokeFetch(target.base + "/chat/completions", {
      method: "POST",
      headers: buildTargetHeaders(attempt),
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

  if (args.usage) {
    const nativeStreamed = nativeResponseIsStreamed(res, args.wantsStream);
    res = observeUsage(res, "openai-chat", args.usage, { streamed: nativeStreamed });
  }

  if (!res.ok) {
    let body: string;
    try {
      body = await res.text();
    } catch (cause) {
      return attachPostHeaderBodyFailure(res, cause);
    }
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

  if (args.wantsStream) {
    if (!res.body) {
      return anthropicError(502, "llm-relay: invalid OpenAI upstream envelope: empty stream", "upstream", {
        ...retryAfterHeader(res.headers),
      }, "invalid_upstream_envelope");
    }
    const preflight = await preflightResponseStream(res.body, "openai-chat");
    if (!preflight.ok) {
      return anthropicError(502, `llm-relay: invalid OpenAI upstream envelope: ${preflight.reason}`, "upstream", {
        ...retryAfterHeader(res.headers),
      }, "invalid_upstream_envelope");
    }
    try {
      const anthStream = handleUniversalStreamRequest(preflight.body, "openai", "anthropic");
      // Strip a complete message-opening think block BEFORE dialect scanning. Otherwise the
      // preamble can hide a tool envelope from recovery. Native Anthropic streams never enter
      // this branch, and direct OpenAI Chat passthrough is handled on the other front.
      const strippedStream = stripThinkTagsInStream(anthStream);
      // Recover a tool call this host returned as raw dialect TEXT. Gated on the request actually
      // declaring tools: with none declared there is no call to recover, and wrapping the stream
      // would add holdback latency for nothing.
      const schemas = toolSchemaMap(args.reqJson) as Map<string, { type?: unknown; properties?: Record<string, { type?: unknown }> }>;
      const recovered = schemas.size > 0 ? recoverDialectInStream(strippedStream, schemas) : strippedStream;
      // AFTER recovery, so a call the relay reconstructed is covered too, and BEFORE anything that
      // watches for the first `tool_use` — validation and repair must see the ids the client will.
      // The taken-set is a thunk: a response with no tool call never walks the conversation.
      // ⚠ Deliberately NOT gated on `schemas.size > 0` like the line above, and the asymmetry is
      // the point: recovery needs a schema to parse a call out of text, uniqueness needs only an
      // id to exist. A host may emit `tool_calls` a request never declared — Claude Code's compact
      // turn declares none while the conversation it summarizes is full of tool_use ids — and that
      // is exactly the turn the normalizer would empty to `[Tool use interrupted]`. The framing
      // holdback is already paid by `stripThinkTagsInStream` above, and an event with no
      // `tool_use` substring costs one scan, so the gate would buy little and lose that case.
      const metadata = preflight.metadata;
      const body = rewriteToolUseIdsInStream(
        recovered,
        () => knownToolUseIds(args.reqJson),
        (count) => { metadata.toolUseIdRewrites = count; },
      );
      return attachUpstreamMetadata(
        new Response(body, { status: res.status, headers: { "content-type": "text/event-stream" } }),
        metadata,
      );
    } catch (e) {
      return anthropicError(502, `llm-relay: response translation failed: ${(e as Error).message}`, "local", {}, "relay_mapper_defect");
    }
  }

  let upstreamJson: unknown;
  try {
    upstreamJson = await res.json();
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) return attachPostHeaderBodyFailure(res, cause);
    return anthropicError(502, "llm-relay: invalid OpenAI upstream envelope: body is not valid JSON", "upstream", {
      ...retryAfterHeader(res.headers),
    }, "invalid_upstream_envelope");
  }
  const invalidReason = invalidEnvelopeReason(upstreamJson, "openai-chat", false);
  if (invalidReason) {
    return anthropicError(502, `llm-relay: invalid OpenAI upstream envelope: ${invalidReason}`, "upstream", {
      ...retryAfterHeader(res.headers),
    }, "invalid_upstream_envelope");
  }

  let anthropicJson: object;
  try {
    const schemas = toolSchemaMap(args.reqJson) as Map<string, { type?: unknown; properties?: Record<string, { type?: unknown }> }>;
    anthropicJson = openAiResponseToAnthropic(upstreamJson as Record<string, unknown>, target.model ?? "", schemas);
  } catch (e) {
    if (e instanceof DialectUnparseableError) {
      // NOT a mapper defect — the translation is fine and the HOST returned an unusable body. It
      // counts against this deployment so the breaker sees it and the pool fails over to a host
      // that parses its models' dialect. 502 is retriable, which is what drives the walk.
      return anthropicError(502, `llm-relay: ${e.message}`, "upstream", {}, "tool_dialect_unparseable");
    }
    // The provider returned a valid source envelope, so a failure after this point belongs to
    // the relay mapper rather than the provider or its failure budget.
    return anthropicError(502, `llm-relay: response translation failed: ${(e as Error).message}`, "local", {}, "relay_mapper_defect");
  }
  // A host that reuses a tool-call id across turns makes Claude Code drop the call while building
  // its next request; mint a fresh one where it collides. The pass runs on the TRANSLATED message,
  // so a dialect-recovered call is covered too and keeps its `tu_recovered_*` id unless that id is
  // itself already in the conversation. See `src/tool-use-ids.ts`.
  const mintedIds = mintUniqueToolUseIds(anthropicJson, args.reqJson);
  if (mintedIds.message) anthropicJson = mintedIds.message;
  // Announce a recovered call for the same reason `x-llm-relay-degraded` is announced: a response
  // whose tool call the RELAY reconstructed is not the same as one that arrived correct, and an
  // unflagged reconstruction is indistinguishable from a host that worked.
  const recoveredDialect = recoveredDialectOf(anthropicJson);
  const response = new Response(JSON.stringify(anthropicJson), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(recoveredDialect ? { [TOOL_DIALECT_HEADER]: recoveredDialect } : {}),
      ...(mintedIds.rewritten > 0
        ? { [TOOL_USE_IDS_HEADER]: `${mintedIds.rewritten} rewritten` }
        : {}),
    },
  });
  const metadata: UpstreamResponseMetadata = {};
  captureReportedModel(metadata, upstreamJson, "openai-chat", false);
  if (mintedIds.rewritten > 0) metadata.toolUseIdRewrites = mintedIds.rewritten;
  return attachUpstreamMetadata(response, metadata);
}

/**
 * Give a translated message's `tool_use` blocks ids the conversation has not already used.
 *
 * Lazy on purpose: a response with no `tool_use` block never walks the request's messages, so the
 * ordinary text completion — the overwhelming majority of traffic — pays one array scan. `message`
 * is null when nothing changed, so an untouched response is never re-built.
 */
function mintUniqueToolUseIds(
  message: object,
  reqJson: unknown,
): { message: object | null; rewritten: number } {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || !content.some((b) => isRecord(b) && b.type === "tool_use")) {
    return { message: null, rewritten: 0 };
  }
  const out = rewriteToolUseIds(content, knownToolUseIds(reqJson));
  if (out.rewritten === 0) return { message: null, rewritten: 0 };
  return { message: { ...message, content: out.content }, rewritten: out.rewritten };
}

/** Did this translated message carry a tool call the relay reconstructed from text? */
function recoveredDialectOf(message: object): string | null {
  const content = (message as { content?: Array<Record<string, unknown>> }).content ?? [];
  return content.some((b) => b.type === "tool_use" && typeof b.id === "string" && b.id.startsWith("tu_recovered_"))
    ? "recovered"
    : null;
}

/**
 * Map a non-streaming OpenAI chat completion into an Anthropic message.
 *
 * `schemas` enables recovery of a tool call the HOST failed to parse: some free hosts return the
 * model's native tool-call dialect as assistant TEXT instead of populating `tool_calls`, which
 * without this reaches the client as markup it treats as a final answer (see
 * docs/tool-call-dialect-leak.md). Omitting it keeps the pure translation behaviour.
 */
export function openAiResponseToAnthropic(
  j: Record<string, unknown>,
  model: string,
  schemas?: Map<string, { type?: unknown; properties?: Record<string, { type?: unknown }> }>,
): object {
  const choice = (j.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
  const msg = (choice.message as Record<string, unknown> | undefined) ?? {};
  const content: object[] = [];
  let toolCalls = (msg.tool_calls as Array<Record<string, unknown>> | undefined) ?? [];
  // This mapper is the translated OpenAI→Anthropic seam. Strip first so an opening think block
  // cannot conceal a following dialect envelope from the recovery pass below.
  const messageText = typeof msg.content === "string" ? stripOpeningThinkTag(msg.content) : null;

  // Recover ONLY when the host parsed nothing. A host that populated `tool_calls` has already
  // spoken; second-guessing it here would be inference, not translation.
  let recovered: DialectToolCall[] = [];
  if (toolCalls.length === 0 && messageText !== null && messageText.length > 0) {
    const out = recoverToolCalls(messageText, schemas ?? new Map());
    if (out.status === "parsed") {
      recovered = out.calls;
      if (out.text.length > 0) content.push({ type: "text", text: out.text });
    } else if (out.status === "detected") {
      // Framing present, nothing parseable — a truncated or unmodelled envelope. Fail clean so
      // failover reaches a host that parses, exactly as repair fails clean on an unrepairable
      // call. Returning the fragment would hand the client a "final answer" that is really the
      // tail of a broken tool call, which is the misdiagnosis this whole path exists to prevent.
      throw new DialectUnparseableError(out.dialect);
    } else {
      content.push({ type: "text", text: messageText });
    }
  } else if (messageText !== null && messageText.length > 0) {
    content.push({ type: "text", text: messageText });
  }
  if (recovered.length > 0) {
    toolCalls = recovered.map((c, i) => ({
      id: `tu_recovered_${i}`,
      function: { name: c.name, arguments: JSON.stringify(c.input) },
    }));
  }
  for (const tc of toolCalls) {
    const fn = (tc.function as Record<string, unknown> | undefined) ?? {};
    let input: unknown;
    try { input = JSON.parse((fn.arguments as string) ?? "{}"); } catch { input = fn.arguments ?? {}; }
    content.push({ type: "tool_use", id: (tc.id as string) ?? "tu", name: (fn.name as string) ?? "", input });
  }
  const finish = choice.finish_reason as string | undefined;
  const stopReason =
    toolCalls.length > 0 ? "tool_use" : finish === "length" ? "max_tokens" : finish === "stop" ? "end_turn" : finish ?? "end_turn";
  const rawUsage = isRecord(j.usage) ? j.usage : null;
  const usage = rawUsage &&
    (typeof rawUsage.prompt_tokens === "number" || typeof rawUsage.completion_tokens === "number")
    ? {
        ...openAiPromptUsageToAnthropic(rawUsage),
        ...(typeof rawUsage.completion_tokens === "number" ? { output_tokens: rawUsage.completion_tokens } : {}),
      }
    : null;
  return {
    id: (j.id as string) ?? "msg_translated",
    type: "message",
    role: "assistant",
    model: model || ((j.model as string) ?? ""),
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    ...(usage ? { usage } : {}),
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
  type = "api_error",
): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", [ERROR_ORIGIN_HEADER]: origin, ...extra },
  });
}

function openaiError(
  status: number,
  message: string,
  origin: ErrorOrigin,
  type = "invalid_request_error",
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { "content-type": "application/json", [ERROR_ORIGIN_HEADER]: origin, ...extra },
  });
}

export type OpenAiFrontProtocol = "chat" | "responses";

/**
 * Remove the usage-only Chat SSE event we requested on the caller's behalf.  This sits after
 * the observer: accounting sees the native bytes immediately, while the client sees its
 * original stream contract.  It deliberately matches only an empty-choices event with usage.
 */
function suppressRelayAddedOpenAiUsageFrames(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  const append = (left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> => {
    const out = new Uint8Array(left.byteLength + right.byteLength);
    out.set(left);
    out.set(right, left.byteLength);
    return out;
  };
  const frameEnd = (bytes: Uint8Array): number | null => {
    for (let i = 0; i + 1 < bytes.byteLength; i += 1) {
      if (bytes[i] === 10 && bytes[i + 1] === 10) return i + 2;
      if (i + 3 < bytes.byteLength && bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i + 4;
    }
    return null;
  };
  const isUsageOnly = (frame: Uint8Array): boolean => {
    let event: string;
    try {
      // Fatal decoding means opaque/noncanonical bytes pass through untouched.
      event = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    } catch {
      return false;
    }
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return false;
    try {
      const parsed = JSON.parse(data) as unknown;
      return isRecord(parsed) && Array.isArray(parsed.choices) && parsed.choices.length === 0 && isRecord(parsed.usage);
    } catch {
      return false;
    }
  };
  const drain = (controller: TransformStreamDefaultController<Uint8Array>, final = false): void => {
    while (true) {
      const end = frameEnd(pending);
      if (end === null) break;
      const frame = pending.slice(0, end);
      pending = pending.slice(end);
      if (!isUsageOnly(frame)) controller.enqueue(frame);
    }
    // Do not let a malformed provider frame become unbounded buffering. Retained bytes are
    // always original slices, never decoder/re-encoder output.
    if ((final || pending.byteLength > 16 * 1024) && pending.byteLength > 0) {
      controller.enqueue(pending);
      pending = new Uint8Array(0);
    }
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending = append(pending, chunk);
      drain(controller);
    },
    flush(controller) {
      drain(controller, true);
    },
  }));
}

function nativeResponseIsStreamed(response: Response, wantsStream: boolean): boolean {
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (type.includes("text/event-stream")) return true;
  if (type.includes("application/json") || /\+json(?:;|$)/.test(type)) return false;
  return wantsStream;
}

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

/**
 * A cache figure this relay is willing to repeat downstream: a finite, non-negative number.
 * Negative or non-finite is malformed host output, not a measurement, so it is treated exactly
 * like an absent field — propagating it would shrink a prompt total or publish a negative
 * `cached_tokens`, i.e. manufacture a figure nobody stated.
 */
function measuredCacheTokens(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Anthropic→OpenAI prompt-side mapping (used when an anthropic-kind backend answers a
 * Chat/Responses front-door request).
 *
 * The two protocols disagree on what "prompt tokens" means: OpenAI's `prompt_tokens` INCLUDES
 * the cached subset; Anthropic's `input_tokens` EXCLUDES cache reads and cache writes, which
 * ride in their own fields. Mapping input_tokens straight across therefore UNDER-STATES the
 * prompt by exactly the cache traffic, so it is summed back here. `cache_read_input_tokens`
 * additionally becomes `prompt_tokens_details.cached_tokens` — the field an OpenAI client
 * reads to know how much of the prompt was served from cache — and each output field is
 * emitted only when its source was actually reported, never zero-filled.
 */
function openAiUsage(raw: unknown): { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const usage = raw as Record<string, unknown>;
  const cacheRead = measuredCacheTokens(usage.cache_read_input_tokens);
  const cacheCreation = measuredCacheTokens(usage.cache_creation_input_tokens);
  const cacheSum = (cacheRead ?? 0) + (cacheCreation ?? 0);
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  // A usage object with no numeric fields is not a measurement. Keep the relay's unknown-vs-zero
  // convention instead of manufacturing a cost report for an upstream that omitted usage.
  if (input === undefined && typeof usage.output_tokens !== "number") return null;
  const out: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } = {
    ...(input !== undefined ? { prompt_tokens: input + cacheSum } : {}),
    ...(typeof usage.output_tokens === "number" ? { completion_tokens: usage.output_tokens } : {}),
  };
  // The details object only when a cache read was actually reported — `{cached_tokens: 0}`
  // would claim the backend stated something about caching that it did not.
  if (cacheRead !== undefined) {
    out.prompt_tokens_details = { cached_tokens: cacheRead };
  }
  return out;
}

/**
 * OpenAI→Anthropic prompt-side mapping (the translated seam of `openAiResponseToAnthropic`).
 *
 * Mirror of `openAiUsage`: subtract the cached subset back OUT of `prompt_tokens`, because
 * Anthropic's `input_tokens` must exclude it or every downstream reader of the Anthropic shape
 * (validator, repair envelope re-attachment, SSE re-emission) sees a double-counted figure.
 * Only mapped when the host actually reported `prompt_tokens_details.cached_tokens`, as a
 * finite non-negative number; anything else (`cached_tokens > prompt_tokens`, negative,
 * non-finite) is malformed host output rather than evidence, so the prompt figure passes
 * through unchanged and the cache field is dropped — an unmeasurable split is not evidence
 * either way, and inventing one would be worse than none.
 */
function openAiPromptUsageToAnthropic(
  rawUsage: Record<string, unknown>,
): { input_tokens?: number; cache_read_input_tokens?: number } {
  if (typeof rawUsage.prompt_tokens !== "number") return {};
  // Same trust rule as `measuredCacheTokens`, applied to the split direction: a negative or
  // non-finite `cached_tokens` would make `input_tokens` EXCEED the prompt the host stated, so
  // it is malformed exactly like `cached > prompt_tokens`.
  const cached = (() => {
    const details = rawUsage.prompt_tokens_details;
    if (typeof details !== "object" || details === null) return undefined;
    return measuredCacheTokens((details as Record<string, unknown>).cached_tokens);
  })();
  if (cached === undefined || cached > rawUsage.prompt_tokens) {
    return { input_tokens: rawUsage.prompt_tokens };
  }
  return {
    input_tokens: rawUsage.prompt_tokens - cached,
    cache_read_input_tokens: cached,
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

function buildTargetHeaders(attempt: ResolvedAttempt): Record<string, string> {
  const { target, credential } = attempt;
  return {
    "content-type": "application/json",
    ...buildAuthHeaders(credential.value, target.authHeader),
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
  attempt: ResolvedAttempt,
  args: {
    reqJson: unknown;
    wantsStream: boolean;
    signal: AbortSignal;
    protocol?: OpenAiFrontProtocol;
    anthropicHeaders?: Record<string, string>;
    processRecoveredChat?: RecoveredOpenAiChatProcessor;
    usage?: UsageAccumulator;
    onEgress?: OnEgress;
  },
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const invokeFetch = oneShotFetch(fetchFn, args.signal, args.onEgress);
  const target = attempt.target;
  const protocol = args.protocol ?? "chat";
  const base = (args.reqJson ?? {}) as Record<string, unknown>;
  // Preserve the existing direct path for the protocol/backend pair that already speaks the
  // same wire format. It keeps provider-specific OpenAI fields byte-for-byte intact.
  if (target.kind === "openai" && protocol === "chat") {
    const schemas = toolSchemaMap(base);
    const callerRequestedUsage = isRecord(base.stream_options) && base.stream_options.include_usage === true;
    const relayAddedUsage = args.wantsStream && !callerRequestedUsage;
    const body: Record<string, unknown> = { ...base, model: target.model, stream: args.wantsStream };
    const originalBody = { ...body };
    if (relayAddedUsage) {
      body.stream_options = {
        ...(isRecord(base.stream_options) ? base.stream_options : {}),
        include_usage: true,
      };
    }
    const post = (requestBody: Record<string, unknown>) => invokeFetch(target.base + "/chat/completions", {
      method: "POST",
      headers: buildTargetHeaders(attempt),
      body: JSON.stringify(requestBody),
      signal: args.signal,
    });
    let res = await post(body);
    // Only a relay-added compatibility hint is safe to remove. A caller-provided option is
    // their request, not relay policy.
    if (!res.ok && relayAddedUsage && (res.status === 400 || res.status === 422)) {
      await res.body?.cancel().catch(() => {});
      res = await post(originalBody);
    }
    if (args.usage) {
      const nativeStreamed = nativeResponseIsStreamed(res, args.wantsStream);
      res = observeUsage(res, "openai-chat", args.usage, { streamed: nativeStreamed });
    }
    if (!res.ok) return res;
    const streamed = args.wantsStream || (res.headers.get("content-type") ?? "").includes("text/event-stream");
    if (streamed) {
      if (!res.body) {
        return openaiError(502, "llm-relay: invalid OpenAI upstream envelope: empty stream", "upstream", "invalid_upstream_envelope", retryAfterHeader(res.headers));
      }
      const preflight = await preflightResponseStream(res.body, "openai-chat");
      if (!preflight.ok) {
        return openaiError(502, `llm-relay: invalid OpenAI upstream envelope: ${preflight.reason}`, "upstream", "invalid_upstream_envelope", retryAfterHeader(res.headers));
      }
      let response: Response | null = null;
      let recovered = false;
      const responseBody = schemas.size > 0
        ? recoverDialectInOpenAiChatStream(preflight.body, schemas, () => {
            recovered = true;
            response?.headers.set(TOOL_DIALECT_HEADER, "recovered");
          }, args.processRecoveredChat)
        : preflight.body;
      response = new Response(
        relayAddedUsage ? suppressRelayAddedOpenAiUsageFrames(responseBody) : responseBody,
        { status: res.status, headers: res.headers },
      );
      if (recovered) response.headers.set(TOOL_DIALECT_HEADER, "recovered");
      return attachUpstreamMetadata(response, preflight.metadata);
    }

    let responseBody: unknown;
    try {
      responseBody = await res.clone().json();
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) return attachPostHeaderBodyFailure(res, cause);
      return openaiError(502, "llm-relay: invalid OpenAI upstream envelope: body is not valid JSON", "upstream", "invalid_upstream_envelope", retryAfterHeader(res.headers));
    }
    const invalidReason = invalidEnvelopeReason(responseBody, "openai-chat", false);
    if (invalidReason) {
      return openaiError(502, `llm-relay: invalid OpenAI upstream envelope: ${invalidReason}`, "upstream", "invalid_upstream_envelope", retryAfterHeader(res.headers));
    }
    let recovery;
    try {
      recovery = await inspectDialectInOpenAiChat(
        responseBody as Record<string, unknown>,
        schemas,
        args.processRecoveredChat,
      );
    } catch (error) {
      return openaiError(
        502,
        `llm-relay: ${error instanceof Error ? error.message : String(error)}`,
        "upstream",
        "tool_call_recovery_failed",
      );
    }
    if (recovery.status === "detected") {
      return openaiError(
        502,
        `llm-relay: backend returned an unparseable ${recovery.dialect} tool-call envelope as text`,
        "upstream",
        "tool_dialect_unparseable",
      );
    }
    const metadata: UpstreamResponseMetadata = {};
    const finalBody = recovery.status === "parsed" ? recovery.body : responseBody;
    captureReportedModel(metadata, finalBody, "openai-chat", false);
    if (recovery.status === "parsed") {
      const headers = new Headers(res.headers);
      headers.set(TOOL_DIALECT_HEADER, "recovered");
      return attachUpstreamMetadata(new Response(JSON.stringify(finalBody), {
        status: res.status,
        headers,
      }), metadata);
    }
    return attachUpstreamMetadata(res, metadata);
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
  const backendRes = await fetchBackend(attempt, {
    path: "/v1/messages",
    method: "POST",
    reqBuf,
    reqJson: anthropicBody,
    anthropicHeaders: args.anthropicHeaders ?? {},
    wantsStream: args.wantsStream,
    ...(args.usage ? { usage: args.usage } : {}),
    signal: args.signal,
    ...(args.onEgress ? { onEgress: args.onEgress } : {}),
  }, fetchFn);
  const metadata = upstreamResponseMetadata.get(backendRes);
  if (postHeaderBodyFailure(backendRes)) return backendRes;

  if (!backendRes.ok) {
    let raw: string;
    try {
      raw = await backendRes.text();
    } catch (cause) {
      return attachPostHeaderBodyFailure(backendRes, cause);
    }
    const origin = errorOrigin(backendRes) ?? "upstream";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [ERROR_ORIGIN_HEADER]: origin,
      ...retryAfterHeader(backendRes.headers),
    };
    return new Response(anthropicErrorToOpenAi(raw, backendRes.status), { status: backendRes.status, headers });
  }

  const streamed = args.wantsStream || (backendRes.headers.get("content-type") ?? "").includes("text/event-stream");
  if (streamed) {
    if (!backendRes.body) {
      const generated = target.kind !== "anthropic";
      return openaiError(
        502,
        generated ? "llm-relay: response mapper produced an empty stream" : "llm-relay: invalid Anthropic upstream envelope: empty stream",
        generated ? "local" : "upstream",
        generated ? "relay_mapper_defect" : "invalid_upstream_envelope",
        retryAfterHeader(backendRes.headers),
      );
    }
    const preflight = await preflightResponseStream(backendRes.body, "anthropic-messages");
    if (!preflight.ok) {
      const generated = target.kind !== "anthropic";
      return openaiError(
        502,
        generated
          ? `llm-relay: response mapper produced an invalid Anthropic envelope: ${preflight.reason}`
          : `llm-relay: invalid Anthropic upstream envelope: ${preflight.reason}`,
        generated ? "local" : "upstream",
        generated ? "relay_mapper_defect" : "invalid_upstream_envelope",
        retryAfterHeader(backendRes.headers),
      );
    }
    const targetProtocol = protocol === "responses" ? "openai-responses" : "openai";
    try {
      const output = handleUniversalStreamRequest(preflight.body, "anthropic", targetProtocol);
      const response = new Response(output, { status: backendRes.status, headers: { "content-type": "text/event-stream" } });
      return metadata ? attachUpstreamMetadata(response, metadata) : response;
    } catch (e) {
      return openaiError(502, `llm-relay: response translation failed: ${(e as Error).message}`, "local", "relay_mapper_defect");
    }
  }

  let body: unknown;
  try {
    body = await backendRes.json();
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) return attachPostHeaderBodyFailure(backendRes, cause);
    const generated = target.kind !== "anthropic";
    return openaiError(
      502,
      generated ? "llm-relay: response mapper produced non-JSON output" : "llm-relay: invalid Anthropic upstream envelope: body is not valid JSON",
      generated ? "local" : "upstream",
      generated ? "relay_mapper_defect" : "invalid_upstream_envelope",
      retryAfterHeader(backendRes.headers),
    );
  }
  const invalidReason = invalidEnvelopeReason(body, "anthropic-messages", false);
  if (invalidReason) {
    const generated = target.kind !== "anthropic";
    return openaiError(
      502,
      generated
        ? `llm-relay: response mapper produced an invalid Anthropic envelope: ${invalidReason}`
        : `llm-relay: invalid Anthropic upstream envelope: ${invalidReason}`,
      generated ? "local" : "upstream",
      generated ? "relay_mapper_defect" : "invalid_upstream_envelope",
      retryAfterHeader(backendRes.headers),
    );
  }

  try {
    // This front's TRANSLATED lane runs through `fetchBackend`, so an `openai`-kind target reached
    // from `/v1/responses` inherits the id mint. Rebuilding the body must not swallow the
    // announcement — an automatic fix is acceptable only because it is announced, and the count
    // is as true here as it was one Response ago.
    const minted = backendRes.headers.get(TOOL_USE_IDS_HEADER);
    const response = new Response(JSON.stringify(anthropicMessageToOpenAi(body as Record<string, unknown>, protocol, target.model ?? String(base.model ?? ""))), {
      status: backendRes.status,
      headers: {
        "content-type": "application/json",
        ...(minted ? { [TOOL_USE_IDS_HEADER]: minted } : {}),
      },
    });
    return metadata ? attachUpstreamMetadata(response, metadata) : response;
  } catch (e) {
    return openaiError(502, `llm-relay: response translation failed: ${(e as Error).message}`, "local", "relay_mapper_defect");
  }
}
