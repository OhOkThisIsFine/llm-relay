import { type AssistantMessage, type ContentBlock, isToolUseBlock } from "./anthropic.js";

/**
 * Serialize an AssistantMessage into an Anthropic SSE byte string — the inverse
 * of reconstructFromSse. Used by repair mode to re-emit a reshaped (or original)
 * response as a fresh stream when the client asked for streaming. Emits the
 * event choreography the Claude harness expects:
 *   message_start → (content_block_start → delta → stop)* → message_delta → message_stop
 */
export function emitSse(msg: AssistantMessage): string {
  const out: string[] = [];
  const push = (type: string, data: object) => {
    out.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const outputTokens = msg.usage?.output_tokens ?? 0;
  const inputTokens = msg.usage?.input_tokens ?? 0;

  push("message_start", {
    message: {
      id: "msg_repair",
      type: "message",
      role: "assistant",
      model: "",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });

  msg.content.forEach((block, index) => {
    emitBlock(push, block, index);
  });

  push("message_delta", {
    delta: { stop_reason: msg.stop_reason ?? "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
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

  push("message_delta", {
    delta: { stop_reason: msg.stop_reason ?? "end_turn", stop_sequence: null },
    usage: { output_tokens: msg.usage?.output_tokens ?? 0 },
  });
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
  // Opaque block: pass through as a start/stop with the block echoed.
  push("content_block_start", { index, content_block: block });
  push("content_block_stop", { index });
}
