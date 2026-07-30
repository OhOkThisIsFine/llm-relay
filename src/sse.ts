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
 *   message_start        -> seeds message id/model + usage
 *   content_block_start  -> opens a block at `index` (text | tool_use | other), keeping
 *                           the WHOLE start payload so an opaque block's own fields
 *                           (e.g. `signature`, `data`) are not thrown away
 *   content_block_delta  -> text_delta appends text; input_json_delta appends
 *                           partial_json for the tool_use at `index`; thinking_delta and
 *                           signature_delta append to the extended-thinking block
 *   content_block_stop   -> finalizes a block (parse accumulated tool JSON)
 *   message_delta        -> carries final stop_reason + stop_sequence + usage
 *   message_stop / ping  -> ignored
 *
 * ⚠ An unrecognized delta type is DROPPED, and that is how `thinking_delta` /
 * `signature_delta` used to silently erase a whole extended-thinking block: neither
 * branch matched, the accumulator stayed empty, and finalize returned a bare
 * `{ type }`. Adding a delta kind means adding a branch here AND a matching
 * re-emission in emitSse.ts, or the round trip loses it again.
 */

interface BlockAccumulator {
  type: string;
  text: string;
  partialJson: string;
  thinking: string;
  signature: string;
  // fields carried from content_block_start for tool_use blocks
  id?: string | undefined;
  name?: string | undefined;
  seedInput?: unknown;
  /** The whole content_block payload from content_block_start, for opaque block types. */
  seed: Record<string, unknown>;
}

export function reconstructFromSse(raw: string): AssistantMessage {
  const blocks = new Map<number, BlockAccumulator>();
  let stopReason: StopReason = null;
  let stopSequence: string | null | undefined;
  let usage: AssistantMessage["usage"];
  let id: string | undefined;
  let model: string | undefined;

  for (const data of iterateDataPayloads(raw)) {
    const evt = safeParse(data);
    if (!evt || typeof evt !== "object") continue;
    const type = (evt as { type?: unknown }).type;

    switch (type) {
      case "message_start": {
        // The backend's own identity. Captured here or it is gone: a repaired response is
        // re-serialized from this shape, and with nowhere to carry the id every repair was
        // emitted under one constant.
        const msg = (evt as {
          message?: { id?: unknown; model?: unknown; usage?: AssistantMessage["usage"] };
        }).message;
        if (typeof msg?.id === "string" && msg.id) id = msg.id;
        if (typeof msg?.model === "string" && msg.model) model = msg.model;
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
          // Seeded from the start payload, then appended to by the deltas — a
          // non-streamed thinking block arrives fully formed on the start event.
          thinking: typeof cb.thinking === "string" ? cb.thinking : "",
          signature: typeof cb.signature === "string" ? cb.signature : "",
          id: typeof cb.id === "string" ? cb.id : undefined,
          name: typeof cb.name === "string" ? cb.name : undefined,
          seedInput: "input" in cb ? cb.input : undefined,
          seed: cb,
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
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          acc.thinking += delta.thinking;
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          // The signature is what makes a thinking block replayable to Anthropic on the
          // next turn; dropping it invalidates the whole block, not just a field.
          acc.signature += delta.signature;
        }
        break;
      }
      case "message_delta": {
        const delta = (evt as { delta?: { stop_reason?: StopReason; stop_sequence?: string | null } }).delta;
        if (delta && "stop_reason" in delta) stopReason = delta.stop_reason ?? stopReason;
        if (delta && "stop_sequence" in delta) stopSequence = delta.stop_sequence;
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
  // Absent fields stay absent: an omitted `usage` means the stream never reported one,
  // which is a different statement from "this call used zero tokens".
  const msg: AssistantMessage = { content, stop_reason: stopReason, usage };
  if (id !== undefined) msg.id = id;
  if (model !== undefined) msg.model = model;
  if (stopSequence !== undefined) msg.stop_sequence = stopSequence;
  return msg;
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
  // Opaque block (thinking, redacted_thinking, anything Anthropic adds later): keep every
  // field the start event carried, then overlay whatever the deltas accumulated. Returning
  // a bare `{ type }` here is what erased extended-thinking blocks wholesale.
  const { type: _dropped, ...rest } = acc.seed;
  const block: Record<string, unknown> = { type: acc.type, ...rest };
  if (acc.thinking) block.thinking = acc.thinking;
  if (acc.signature) block.signature = acc.signature;
  return block as ContentBlock;
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
