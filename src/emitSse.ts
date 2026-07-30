import { randomUUID } from "node:crypto";
import { type AssistantMessage, type ContentBlock, isToolUseBlock } from "./anthropic.js";

/**
 * Fallback id for a message whose source response carried none.
 *
 * NOT a constant: `msg_repair` was emitted for every repaired turn, so two different
 * responses in one session were indistinguishable to anything keying off the id — and
 * because it was emitted even when the backend HAD supplied a real id, the client's view
 * of the conversation silently disagreed with the provider's. The prefix marks it as
 * relay-synthesized so nobody mistakes it for something the provider can be asked about.
 */
function syntheticMessageId(): string {
  return `msg_relay_${randomUUID().replace(/-/g, "")}`;
}

/**
 * `usage` for message_start, carrying only what the backend actually reported.
 *
 * ⚠ Client-visible: when the source message carried no usage at all this is now `{}`
 * rather than `{ input_tokens: 0, output_tokens: 0 }`. Those zeros were a measurement
 * nobody made, and a consumer metering off the stream could not tell them from a call
 * that genuinely cost nothing. Same rule the rest of the proxy follows for an unknown
 * limit or price: absent, never guessed.
 */
function startUsage(msg: AssistantMessage): Record<string, number> {
  const usage: Record<string, number> = {};
  if (typeof msg.usage?.input_tokens === "number") usage.input_tokens = msg.usage.input_tokens;
  // output_tokens is 0 here BY PROTOCOL, not as a guess: at message_start no output has
  // been produced yet and Anthropic streaming fills the real figure in via message_delta.
  // Only stated at all when the backend reported usage — otherwise it is the same
  // invented zero, laundered through a protocol convention.
  if (msg.usage) usage.output_tokens = 0;
  return usage;
}

/**
 * The `message_delta` payload. `usage` is OMITTED when the backend never reported
 * output tokens — `{ output_tokens: 0 }` would assert the call was free, which is a
 * claim, not an absence.
 */
function endDelta(msg: AssistantMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    delta: { stop_reason: msg.stop_reason ?? "end_turn", stop_sequence: msg.stop_sequence ?? null },
  };
  if (typeof msg.usage?.output_tokens === "number") {
    payload.usage = { output_tokens: msg.usage.output_tokens };
  }
  return payload;
}

/**
 * Serialize an AssistantMessage into an Anthropic SSE byte string — the inverse
 * of reconstructFromSse. Used by repair mode to re-emit a reshaped (or original)
 * response as a fresh stream when the client asked for streaming. Emits the
 * event choreography the Claude harness expects:
 *   message_start → (content_block_start → delta → stop)* → message_delta → message_stop
 *
 * The backend's own `id`, `model` and `usage` are re-emitted whenever the message
 * carries them, so a repair does not rewrite the response's identity. Whatever it did
 * not carry is synthesized (id) or omitted (model, usage) — never zero-filled.
 */
export function emitSse(msg: AssistantMessage): string {
  const out: string[] = [];
  const push = (type: string, data: object) => {
    out.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  push("message_start", {
    message: {
      id: msg.id ?? syntheticMessageId(),
      type: "message",
      role: "assistant",
      model: msg.model ?? "",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: startUsage(msg),
    },
  });

  msg.content.forEach((block, index) => {
    emitBlock(push, block, index);
  });

  push("message_delta", endDelta(msg));
  push("message_stop", {});

  return out.join("");
}

/**
 * Serialize ONLY the trailing content blocks (from `startIndex` onward) plus the
 * message terminators — no `message_start`, no earlier blocks. Used by streaming
 * repair: the proxy has already forwarded `message_start` and any leading text
 * blocks byte-for-byte, then withheld from the first tool_use block. When a repair
 * lands, this re-emits just the (corrected) tool_use blocks at their original
 * indices so the client sees one coherent, contiguous stream.
 */
export function emitSseTail(msg: AssistantMessage, startIndex: number): string {
  const out: string[] = [];
  const push = (type: string, data: object) => {
    out.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  msg.content.forEach((block, index) => {
    if (index < startIndex) return;
    emitBlock(push, block, index);
  });

  // No message_start here — the client already has the backend's real one, id included.
  push("message_delta", endDelta(msg));
  push("message_stop", {});

  return out.join("");
}

function emitBlock(
  push: (type: string, data: object) => void,
  block: ContentBlock,
  index: number,
): void {
  if (isToolUseBlock(block)) {
    push("content_block_start", {
      index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    });
    // Emit the full input as a single input_json_delta fragment.
    const json = JSON.stringify(block.input ?? {});
    push("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json } });
    push("content_block_stop", { index });
    return;
  }
  if (block.type === "text") {
    push("content_block_start", { index, content_block: { type: "text", text: "" } });
    push("content_block_delta", {
      index,
      delta: { type: "text_delta", text: (block as { text: string }).text },
    });
    push("content_block_stop", { index });
    return;
  }
  // Opaque block (thinking, redacted_thinking, …): echo the WHOLE block on the start
  // event rather than re-deriving deltas for it. reconstructFromSse keeps the entire
  // content_block payload, so this round-trips every field — including a thinking
  // block's `signature`, without which the block cannot be replayed on the next turn.
  push("content_block_start", { index, content_block: block });
  push("content_block_stop", { index });
}
