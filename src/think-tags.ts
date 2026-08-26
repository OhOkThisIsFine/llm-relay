/**
 * Conservative stripping for a message-opening `<think>…</think>` block.
 *
 * Only translated OpenAI text is routed through this module. Native Anthropic thinking blocks
 * and byte-exact OpenAI Chat passthrough never reach it. The filter strips at most one complete,
 * unnested block; every uncertain shape is released byte-for-byte as ordinary text.
 */

import { BufferedSseFrames, sseEventFields } from "./sse-frames.js";

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";
export const MAX_THINK_LEAD_BYTES = 512;
export const MAX_THINK_HELD_BYTES = 64 * 1024;
const MARKER_HOLDBACK = CLOSE_TAG.length - 1; // 7 chars: a strict split-marker prefix.

type FilterState = "pass-through" | "lead-hold" | "inside-think" | "done";

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Four-state text filter shared by buffered and streaming translation.
 *
 * `inside-think` retains the candidate block until its close is proven. That bounded rollback
 * buffer is what makes an unclosed or nested block lossless instead of silently deleting text.
 */
export class ThinkTagStripFilter {
  private state: FilterState = "lead-hold";
  private held = "";
  private bodyStart = 0;
  private scanFrom = 0;

  push(text: string): string {
    if (text.length === 0) return "";
    if (this.state === "pass-through" || this.state === "done") return text;

    this.held += text;
    if (this.state === "lead-hold") return this.decideLead();
    return this.inspectThink();
  }

  /** Release every undecided byte when the message/text block ends. */
  flush(): string {
    if (this.state === "lead-hold" || this.state === "inside-think") return this.releaseLosslessly();
    return "";
  }

  private decideLead(): string {
    const firstNonWhitespace = this.held.search(/\S/);
    if (firstNonWhitespace < 0) {
      return bytes(this.held) > MAX_THINK_LEAD_BYTES ? this.releaseLosslessly() : "";
    }

    const candidate = this.held.slice(firstNonWhitespace);
    if (candidate.startsWith(OPEN_TAG)) {
      const decisionEnd = firstNonWhitespace + OPEN_TAG.length;
      // Bound the lead buffer itself, not merely the whitespace prefix.
      if (bytes(this.held.slice(0, decisionEnd)) > MAX_THINK_LEAD_BYTES) {
        return this.releaseLosslessly();
      }
      this.state = "inside-think";
      this.bodyStart = decisionEnd;
      this.scanFrom = decisionEnd;
      return this.inspectThink();
    }

    if (OPEN_TAG.startsWith(candidate)) {
      return bytes(this.held) > MAX_THINK_LEAD_BYTES ? this.releaseLosslessly() : "";
    }

    // Any non-whitespace byte before the tag makes it mid-message, never removable.
    return this.releaseLosslessly();
  }

  private inspectThink(): string {
    const nested = this.held.indexOf(OPEN_TAG, this.scanFrom);
    const close = this.held.indexOf(CLOSE_TAG, this.scanFrom);

    if (nested >= 0 && (close < 0 || nested < close)) return this.releaseLosslessly();

    if (close >= 0) {
      const closeEnd = close + CLOSE_TAG.length;
      if (bytes(this.held.slice(0, closeEnd)) > MAX_THINK_HELD_BYTES) {
        return this.releaseLosslessly();
      }
      const remainder = this.held.slice(closeEnd);
      this.held = "";
      this.state = "done";
      return remainder;
    }

    if (bytes(this.held) > MAX_THINK_HELD_BYTES) return this.releaseLosslessly();

    // Re-scan only the strict marker prefix that could complete in the next chunk. The rollback
    // buffer remains bounded separately so an unclosed/nested candidate can still flush losslessly.
    this.scanFrom = Math.max(this.bodyStart, this.held.length - MARKER_HOLDBACK);
    return "";
  }

  private releaseLosslessly(): string {
    const text = this.held;
    this.held = "";
    this.state = "pass-through";
    return text;
  }
}

/** Strip one complete opening block, or return the original text on any doubt. */
export function stripOpeningThinkTag(text: string): string {
  const filter = new ThinkTagStripFilter();
  return filter.push(text) + filter.flush();
}

interface SseEvent {
  raw: string;
  type: string;
  data: Record<string, unknown> | null;
}

function parseEvent(block: string): SseEvent | null {
  if (!block.trim()) return null;
  const fields = sseEventFields(block);
  const type = fields.eventLines.at(-1)?.trim() ?? "";
  const dataLines = fields.dataLines.map((line) => line.trim());
  if (dataLines.length === 0) return { raw: block, type, data: null };
  try {
    return { raw: block, type, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
  } catch {
    return { raw: block, type, data: null };
  }
}

function sseDelta(index: number, text: string): string {
  const data = { type: "content_block_delta", index, delta: { type: "text_delta", text } };
  return `event: content_block_delta\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Rewrite translated Anthropic SSE text deltas through the strip filter. All non-text frames pass
 * through; held doubtful text is emitted before its content block closes, preserving SSE order.
 */
export function stripThinkTagsInStream(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const filter = new ThinkTagStripFilter();
  const frames = new BufferedSseFrames();
  let blockIndex = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (text: string) => {
        if (text.length > 0) controller.enqueue(encoder.encode(text));
      };
      const flushHeld = () => {
        const tail = filter.flush();
        if (tail.length > 0) push(sseDelta(blockIndex, tail));
      };
      const reader = upstream.getReader();

      const processFrames = () => {
        for (const { frame: block, raw } of frames) {
          const ev = parseEvent(block);
          if (!ev) {
            push(raw);
            continue;
          }

          if (ev.type === "content_block_start") {
            blockIndex = typeof ev.data?.index === "number" ? ev.data.index : blockIndex;
            push(raw);
            continue;
          }

          if (ev.type === "content_block_delta") {
            const delta = ev.data?.delta as { type?: string; text?: string } | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              const out = filter.push(delta.text);
              if (out === delta.text) push(raw);
              else if (out.length > 0) push(sseDelta(blockIndex, out));
              continue;
            }
          }

          if (ev.type === "content_block_stop" || ev.type === "message_stop") flushHeld();
          push(raw);
        }
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          frames.append(decoder.decode(value, { stream: true }));
          processFrames();
        }
        frames.append(decoder.decode());
        processFrames();
        flushHeld();
        // A truncated non-event tail is outside the filter's text seam; preserve it verbatim.
        push(frames.takeRemainder());
      } catch (e) {
        // A broken upstream is also an unclosed candidate. Release held text before reporting the
        // stream error so this filter never turns transport doubt into silent content deletion.
        frames.append(decoder.decode());
        processFrames();
        flushHeld();
        push(frames.takeRemainder());
        const message = e instanceof Error ? e.message : String(e);
        push(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `llm-relay: stream failed: ${message}` } })}\n\n`);
      } finally {
        controller.close();
      }
    },
  });
}
