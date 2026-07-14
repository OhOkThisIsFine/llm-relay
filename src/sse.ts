import {
  type AssistantMessage,
  type ContentBlock,
  type StopReason,
} from "./anthropic.js";

/**
 * Reconstruct an assistant message from a captured Anthropic SSE stream so the
 * tool_use validator can inspect it. In detect mode we tee the stream (forward
 * bytes to the client unchanged, accumulate a copy here), then rebuild the final
 * message from the accumulated events at end-of-stream. Nothing here mutates what
 * the client receives.
 *
 * Event grammar handled:
 *   message_start        -> seeds usage/stop_reason
 *   content_block_start  -> opens a block at `index` (text | tool_use | other)
 *   content_block_delta  -> text_delta appends text; input_json_delta appends
 *                           partial_json for the tool_use at `index`
 *   content_block_stop   -> finalizes a block (parse accumulated tool JSON)
 *   message_delta        -> carries final stop_reason + usage
 *   message_stop / ping  -> ignored
 */

interface BlockAccumulator {
  type: string;
  text: string;
  partialJson: string;
  // fields carried from content_block_start for tool_use blocks
  id?: string | undefined;
  name?: string | undefined;
  seedInput?: unknown;
}

export function reconstructFromSse(raw: string): AssistantMessage {
  const blocks = new Map<number, BlockAccumulator>();
  let stopReason: StopReason = null;
  let usage: AssistantMessage["usage"];

  for (const data of iterateDataPayloads(raw)) {
    const evt = safeParse(data);
    if (!evt || typeof evt !== "object") continue;
    const type = (evt as { type?: unknown }).type;

    switch (type) {
      case "message_start": {
        const msg = (evt as { message?: { usage?: AssistantMessage["usage"] } }).message;
        if (msg?.usage) usage = { ...msg.usage };
        break;
      }
      case "content_block_start": {
        const index = numberOr((evt as { index?: unknown }).index, -1);
        const cb = (evt as { content_block?: Record<string, unknown> }).content_block ?? {};
        blocks.set(index, {
          type: typeof cb.type === "string" ? cb.type : "unknown",
          text: "",
          partialJson: "",
          id: typeof cb.id === "string" ? cb.id : undefined,
          name: typeof cb.name === "string" ? cb.name : undefined,
          seedInput: "input" in cb ? cb.input : undefined,
        });
        break;
      }
      case "content_block_delta": {
        const index = numberOr((evt as { index?: unknown }).index, -1);
        const delta = (evt as { delta?: Record<string, unknown> }).delta ?? {};
        const acc = blocks.get(index);
        if (!acc) break;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          acc.text += delta.text;
        } else if (
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          acc.partialJson += delta.partial_json;
        }
        break;
      }
      case "message_delta": {
        const delta = (evt as { delta?: { stop_reason?: StopReason } }).delta;
        if (delta && "stop_reason" in delta) stopReason = delta.stop_reason ?? stopReason;
        const u = (evt as { usage?: AssistantMessage["usage"] }).usage;
        if (u) usage = { ...usage, ...u };
        break;
      }
      default:
        break; // content_block_stop, message_stop, ping — no state to fold
    }
  }

  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]);
  const content: ContentBlock[] = ordered.map(([, acc]) => finalizeBlock(acc));
  return { content, stop_reason: stopReason, usage };
}

function finalizeBlock(acc: BlockAccumulator): ContentBlock {
  if (acc.type === "text") {
    return { type: "text", text: acc.text };
  }
  if (acc.type === "tool_use") {
    let input: unknown = acc.seedInput ?? {};
    if (acc.partialJson.length > 0) {
      const parsed = safeParse(acc.partialJson);
      // If the streamed tool JSON is malformed/incomplete, surface the raw
      // string so the validator flags input_not_object rather than silently
      // treating it as {}.
      input = parsed === undefined ? acc.partialJson : parsed;
    }
    return { type: "tool_use", id: acc.id ?? "", name: acc.name ?? "", input };
  }
  return { type: acc.type };
}

/** Yield each `data:` payload from an SSE byte stream (handles multi-line data). */
function* iterateDataPayloads(raw: string): Generator<string> {
  // Frames are separated by a blank line. Within a frame, concatenate all
  // `data:` lines (SSE allows multiple).
  const frames = raw.split(/\r?\n\r?\n/);
  for (const frame of frames) {
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) yield dataLines.join("\n");
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
