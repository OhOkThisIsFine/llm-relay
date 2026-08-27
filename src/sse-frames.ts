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
