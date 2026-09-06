export interface SseBoundary {
  index: number;
  separator: string;
}

export interface SseFrame {
  frame: string;
  separator: string;
  raw: string;
}

export interface SseEventFields {
  eventLines: string[];
  dataLines: string[];
}

/**
 * The one rule for where a complete SSE event ends, for the five stream modules that share this
 * file. Mixed terminators (`\r\n\n`, `\n\r\n`) are one boundary with their true length. A CR-CR
 * blank line is deliberately NOT a boundary — same as every predecessor family, so adopting this
 * module changed nothing on that axis. Prefix-stable: a buffer ending in `\r`, `\n`, or `\r\n` has
 * no boundary yet, so chunk-spanning iteration can never split a separator.
 */
export function findSseBoundary(value: string): SseBoundary | null {
  // Every separator contains "\n"; the indexOf fast-path spares the regex scan on a large
  // newline-free buffer (the pathological no-boundary stream).
  if (!value.includes("\n")) return null;
  const match = /\r?\n\r?\n/.exec(value);
  return match ? { index: match.index, separator: match[0] } : null;
}

/**
 * Buffer decoded stream text and iterate complete SSE frames without changing their bytes.
 * A caller owns decoding and policy; this class only reports the frame and separator strings.
 * ⚠ Resumable by design, unlike a spec-conforming iterator: `next()` reports done whenever no
 * complete frame is buffered, and a later `append` yields further frames — safe for the
 * `for…of`-per-append pattern the adopters use, but do not wrap it in an adapter that latches
 * `done`.
 */
export class BufferedSseFrames implements IterableIterator<SseFrame> {
  private buffered = "";

  append(value: string): this {
    this.buffered += value;
    return this;
  }

  next(): IteratorResult<SseFrame> {
    const boundary = findSseBoundary(this.buffered);
    if (!boundary) return { done: true, value: undefined };

    const frame = this.buffered.slice(0, boundary.index);
    const raw = this.buffered.slice(0, boundary.index + boundary.separator.length);
    this.buffered = this.buffered.slice(boundary.index + boundary.separator.length);
    return {
      done: false,
      value: { frame, separator: boundary.separator, raw },
    };
  }

  [Symbol.iterator](): IterableIterator<SseFrame> {
    return this;
  }

  /** Append an optional decoder tail, then release the incomplete final frame verbatim. */
  takeRemainder(value = ""): string {
    this.buffered += value;
    const remainder = this.buffered;
    this.buffered = "";
    return remainder;
  }
}

export interface SseEvent {
  raw: string;
  type: string;
  data: Record<string, unknown> | null;
}

/**
 * The Anthropic-shaped event parse: LAST `event:` line wins, data lines trimmed and joined, an
 * unparseable body degrading to `data: null` rather than throwing, and an all-whitespace block
 * declined outright.
 *
 * ⚠ It lives here because `dialect-stream.ts` and `think-tags.ts` held BYTE-IDENTICAL private
 * copies of it — the same hand-copy shape this file was created to end one layer down, at
 * `sseEventFields`. ⚠ `openai-dialect.ts` deliberately keeps its own: its policy differs on four
 * points (FIRST event line, a leading space stripped per data line, a `[DONE]` sentinel, and a
 * non-nullable return), so sharing this one would change its wire behaviour. That is the
 * "each adopter keeps its own trimming/event-name policy" boundary, not an omission.
 */
export function parseSseEvent(block: string): SseEvent | null {
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

/** Extract raw SSE field values; callers retain whitespace, JSON and event-name policy. */
export function sseEventFields(frame: string): SseEventFields {
  const eventLines: string[] = [];
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventLines.push(line.slice(6));
    else if (line.startsWith("data:")) dataLines.push(line.slice(5));
  }
  return { eventLines, dataLines };
}

/**
 * What a stream transform contributes, beyond the scaffold every one of them shares.
 *
 * The scaffold owns the machinery; the visitor owns the policy. `processFrames` drains whatever the
 * scaffold has buffered and pushes what should reach the client. `flushHeld` is OPTIONAL, and it
 * exists for a visitor that can be mid-decision when the stream ends: the scaffold calls it at
 * exactly one point, in BOTH the success tail and the error tail, immediately before the trailing
 * remainder is pushed. A visitor that never holds anything omits it and the call is a no-op — which
 * is why one scaffold serves both callers byte-for-byte.
 */
export interface SseStreamVisitor {
  processFrames: () => void;
  flushHeld?: () => void;
}

/** What the scaffold hands a visitor at stream start. */
export interface SseStreamContext {
  /** Enqueue text for the client. An empty write is suppressed, as every caller already did. */
  push: (text: string) => void;
  /** The frame buffer the scaffold feeds and the visitor drains. */
  frames: BufferedSseFrames;
}

/**
 * The ONE read loop, error tail and lifecycle for an SSE-rewriting `ReadableStream` transform.
 *
 * `stripThinkTagsInStream` and `rewriteToolUseIdsInStream` each privately owned a byte-identical
 * copy of all of it: a `TextDecoder`, a `TextEncoder`, a `BufferedSseFrames`, an empty-suppressing
 * `push`, a `for(;;) reader.read()` loop, an end-of-stream `decoder.decode()` with a final drain,
 * `push(frames.takeRemainder())`, a catch that drains and then emits the `event: error` frame, and
 * `controller.close()` in `finally`. Only the frame policy and one optional flush ever differed
 * (CLONE-20).
 *
 * ⚠ The error tail is not incidental, and no future visitor may skip it: a broken upstream is ALSO
 * an unclosed candidate, so held text is released before the error is reported. Otherwise a
 * transform whose stated purpose is losslessness turns transport doubt into silent content
 * deletion. Owning that once is the point of this function.
 *
 * ⚠ It lives here, in the leaf both callers already import, rather than in `sse.ts` as the P1-04
 * plan proposed. The plan's stated reason — that `sse.ts` already owns shared SSE vocabulary
 * through `iterateDataPayloads` — does not hold: that generator is PRIVATE to `sse.ts`, whose
 * domain is rebuilding an `AssistantMessage`. Putting a framing primitive there would make two
 * stream wrappers depend on the message reconstructor for nothing.
 */
export function createSseTransformStream(
  upstream: ReadableStream<Uint8Array>,
  makeVisitor: (ctx: SseStreamContext) => SseStreamVisitor,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const frames = new BufferedSseFrames();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (text: string): void => {
        if (text.length > 0) controller.enqueue(encoder.encode(text));
      };
      const visitor = makeVisitor({ push, frames });
      const reader = upstream.getReader();

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          frames.append(decoder.decode(value, { stream: true }));
          visitor.processFrames();
        }
        frames.append(decoder.decode());
        visitor.processFrames();
        visitor.flushHeld?.();
        // A truncated non-event tail is outside every visitor's seam; preserve it verbatim.
        push(frames.takeRemainder());
      } catch (e) {
        // A broken upstream is also an unclosed candidate. Release held text before reporting the
        // stream error so no visitor turns transport doubt into silent content deletion.
        frames.append(decoder.decode());
        visitor.processFrames();
        visitor.flushHeld?.();
        push(frames.takeRemainder());
        const message = e instanceof Error ? e.message : String(e);
        push(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `llm-relay: stream failed: ${message}` } })}\n\n`);
      } finally {
        controller.close();
      }
    },
  });
}
