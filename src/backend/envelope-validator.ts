/**
 * Is a provider's response envelope structurally usable by the response mappers?
 *
 * Moved out of `backend.ts` unchanged (HOTSPOT-10). The bodies below are byte-identical to the
 * ones that lived there; only the two names `backend.ts` still calls became exports.
 *
 * ⚠ It answers about FORM, never about content: whether the discriminator the mapper switches on
 * is present and carries the field that discriminator promises. That is the same side of the
 * repair boundary as the tool-call validator — the relay never judges what a model said, only
 * whether the shape it arrived in can be read.
 *
 * ⚠ This module imports `isRecord` and nothing else. Keep it that way: it sits beneath the
 * transport it validates for, and a dependency pointing back at `backend.js` would be a cycle.
 */

import { isRecord } from "../json-shape.js";

export type ResponseProtocol = "openai-chat" | "anthropic-messages" | "openai-responses";

const ANTHROPIC_STREAM_EVENT_FIELDS = new Map<string, string | null>([
  ["ping", null], ["message_stop", null], ["content_block_stop", null],
  ["message_start", "message"], ["content_block_start", "content_block"],
  ["content_block_delta", "delta"], ["message_delta", "delta"], ["error", "error"],
]);

function invalidChatToolCallsReason(message: Record<string, unknown>): string | null {
  if (message.tool_calls === undefined || message.tool_calls === null) return null;
  if (!Array.isArray(message.tool_calls)) return "message tool_calls is not an array";
  for (const rawCall of message.tool_calls) {
    if (!isRecord(rawCall) || !isRecord(rawCall.function)) return "invalid tool call";
    if (typeof rawCall.function.name !== "string" || typeof rawCall.function.arguments !== "string") {
      return "invalid tool function";
    }
  }
  return null;
}

function invalidChatChoiceReason(rawChoice: unknown, streamed: boolean): string | null {
  if (!isRecord(rawChoice)) return "choice is not an object";
  const message = streamed ? rawChoice.delta : rawChoice.message;
  if (!isRecord(message)) return streamed ? "choice is missing delta" : "choice is missing message";
  if (!streamed) {
    const toolCallsReason = invalidChatToolCallsReason(message);
    if (toolCallsReason) return toolCallsReason;
    const hasContent = message.content === null || typeof message.content === "string";
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (!hasContent && !hasToolCalls) return "message has neither content nor tool calls";
  }
  return null;
}

function openAiChatEnvelopeReason(value: Record<string, unknown>, streamed: boolean): string | null {
  if (!Array.isArray(value.choices)) return "missing choices array";
  if (streamed && value.choices.length === 0) {
    return isRecord(value.usage) ? null : "empty choices without usage";
  }
  if (value.choices.length === 0) return "empty choices array";
  for (const rawChoice of value.choices) {
    const reason = invalidChatChoiceReason(rawChoice, streamed);
    if (reason) return reason;
  }
  return null;
}

function invalidAnthropicBlockReason(rawBlock: unknown): string | null {
  if (!isRecord(rawBlock) || typeof rawBlock.type !== "string") return "invalid content block";
  if (rawBlock.type === "text" && typeof rawBlock.text !== "string") return "text block is missing text";
  if (rawBlock.type === "tool_use" && typeof rawBlock.name !== "string") return "tool_use block is missing name";
  return null;
}

function anthropicMessagesBufferedReason(value: Record<string, unknown>): string | null {
  if (!Array.isArray(value.content)) return "missing content array";
  for (const rawBlock of value.content) {
    const reason = invalidAnthropicBlockReason(rawBlock);
    if (reason) return reason;
  }
  return null;
}

function anthropicMessagesStreamedReason(value: Record<string, unknown>): string | null {
  const field = typeof value.type === "string" ? ANTHROPIC_STREAM_EVENT_FIELDS.get(value.type) : undefined;
  if (field === undefined) return "missing or unknown Anthropic event type";
  if (field === null || isRecord(value[field])) return null;
  return `${value.type === "error" ? "error event" : String(value.type)} is missing ${field}`;
}

function anthropicMessagesEnvelopeReason(value: Record<string, unknown>, streamed: boolean): string | null {
  return streamed ? anthropicMessagesStreamedReason(value) : anthropicMessagesBufferedReason(value);
}

/**
 * The Responses discriminator is the top-level `output` array (buffered) or a non-empty `type`
 * on the first streamed event — deliberately as loose as `openai-chat`'s own `choices`-array
 * check, since this is a PREFLIGHT (is the first event usable at all), not the exhaustive event
 * classification `src/stream-commit.ts`'s `openAiResponsesVerdict` performs once content flows.
 */
function openAiResponsesEnvelopeReason(value: Record<string, unknown>, streamed: boolean): string | null {
  if (!streamed) {
    return Array.isArray(value.output) ? null : "missing output array";
  }
  return typeof value.type === "string" && value.type.length > 0 ? null : "missing or unknown Responses event type";
}

/**
 * Validate only the protocol structure the response mappers rely on. Optional identifiers,
 * model names and usage remain optional because several compatible providers legitimately omit
 * them; the required response discriminator must not be optional, or `{}` becomes a successful
 * empty assistant message.
 */
export function invalidEnvelopeReason(value: unknown, protocol: ResponseProtocol, streamed: boolean): string | null {
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

  // A total dispatch over `ResponseProtocol`, closed with `_never` — the invariant this
  // codebase's history repeats more than any other: a runtime dispatch over a closed union must
  // never fall through to the STRONGER claim (here, that would mean a fourth wire shape silently
  // validated as if it were Anthropic Messages). Adding a member is a compile error at the
  // `_never` assignment below, not a silent pass-through.
  if (protocol === "openai-chat") return openAiChatEnvelopeReason(value, streamed);
  if (protocol === "openai-responses") return openAiResponsesEnvelopeReason(value, streamed);
  if (protocol === "anthropic-messages") return anthropicMessagesEnvelopeReason(value, streamed);
  const _never: never = protocol;
  return _never;
}
