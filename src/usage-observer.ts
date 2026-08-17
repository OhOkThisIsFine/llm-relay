/**
 * Observe provider-reported completion usage without putting an observer in
 * the response path.  In particular, this module never changes (or buffers)
 * a response chunk: it only keeps a small amount of parsing state alongside
 * the stream.
 */

export type UsageProtocol =
  | "anthropic-messages"
  | "openai-chat"
  | "openai-responses";

export interface UsageAccumulator {
  completionTokens: number | undefined;
}

export function createUsageAccumulator(): UsageAccumulator {
  return { completionTokens: undefined };
}

const MAX_SSE_FRAME = 16 * 1024;
const MAX_BUFFERED_JSON = 1024 * 1024;
const MAX_DECODE_SLICE = 4096;

function validCompletionTokens(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function record(accumulator: UsageAccumulator, value: unknown): void {
  if (validCompletionTokens(value)) accumulator.completionTokens = value;
}

function usageValue(
  value: unknown,
  protocol: UsageProtocol,
): unknown {
  if (!value || typeof value !== "object") return undefined;
  const root = value as Record<string, unknown>;
  const usage = root.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const usageRecord = usage as Record<string, unknown>;
  return protocol === "openai-chat"
    ? usageRecord.completion_tokens
    : usageRecord.output_tokens;
}

function responseCompletedUsage(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const root = value as Record<string, unknown>;
  if (root.type !== "response.completed") return undefined;
  const response = root.response;
  if (!response || typeof response !== "object") return undefined;
  return usageValue(response, "openai-responses");
}

function inspectJson(
  value: unknown,
  protocol: UsageProtocol,
  accumulator: UsageAccumulator,
): void {
  try {
    record(accumulator, usageValue(value, protocol));
  } catch {
    // An observer must never make provider bytes fail a request.
  }
}

interface SseState {
  event: string | undefined;
  data: string[];
  size: number;
  overflow: boolean;
}

function newSseState(): SseState {
  return { event: undefined, data: [], size: 0, overflow: false };
}

function inspectSseFrame(
  state: SseState,
  protocol: UsageProtocol,
  accumulator: UsageAccumulator,
): void {
  if (state.overflow || state.data.length === 0) return;
  try {
    const value: unknown = JSON.parse(state.data.join("\n"));
    if (protocol === "anthropic-messages") {
      if (value && typeof value === "object") {
        const root = value as Record<string, unknown>;
        if (state.event === "message_delta" || root.type === "message_delta") {
          record(accumulator, usageValue(root, protocol));
        }
      }
    } else if (protocol === "openai-chat") {
      record(accumulator, usageValue(value, protocol));
    } else {
      // Most Responses servers include `type` in the data object; some use
      // the SSE event field as the discriminator instead.
      record(
        accumulator,
        state.event === "response.completed"
          ? value && typeof value === "object"
            ? usageValue((value as Record<string, unknown>).response, "openai-responses")
            : undefined
          : responseCompletedUsage(value),
      );
    }
  } catch {
    // Malformed/incomplete SSE data is simply not a usage report.
  }
}

function resetSse(state: SseState): void {
  state.event = undefined;
  state.data = [];
  state.size = 0;
  state.overflow = false;
}

function processSseLine(
  line: string,
  terminatorBytes: number,
  state: SseState,
  protocol: UsageProtocol,
  accumulator: UsageAccumulator,
): void {
  if (line === "") {
    inspectSseFrame(state, protocol, accumulator);
    resetSse(state);
    return;
  }

  // Count all frame bytes, including fields we do not interpret.  This keeps
  // an attacker from evading the bound with a very large unknown field.
  state.size += new TextEncoder().encode(line).byteLength + terminatorBytes;
  if (state.size > MAX_SSE_FRAME) {
    state.overflow = true;
    state.data = [];
    return;
  }
  if (state.overflow) return;

  if (line.startsWith("event:")) {
    state.event = line.slice(6).replace(/^ /, "");
  } else if (line.startsWith("data:")) {
    state.data.push(line.slice(5).replace(/^ /, ""));
  }
}

function makeSseObserver(
  protocol: UsageProtocol,
  accumulator: UsageAccumulator,
): {
  push(bytes: Uint8Array): void;
  finish(): void;
} {
  const decoder = new TextDecoder();
  let text = "";
  let discardUntilBreak = false;
  const state = newSseState();

  const drain = (final: boolean): void => {
    if (discardUntilBreak) {
      let index = -1;
      let terminatorLength = 0;
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code === 10 || code === 13) {
          // CRLF may be split over two provider chunks.  Keep a trailing CR
          // until the LF arrives so it cannot dispatch a false blank frame.
          if (code === 13 && i === text.length - 1 && !final) break;
          index = i;
          terminatorLength = code === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
          break;
        }
      }
      if (index < 0) {
        // An oversized line can end in a CR whose LF arrives next chunk.
        // Retain that one byte so the frame separator remains intact.
        text = text.endsWith("\r") && !final ? "\r" : "";
        if (final) discardUntilBreak = false;
        return;
      }
      text = text.slice(index + terminatorLength);
      discardUntilBreak = false;
    }
    while (text.length > 0) {
      let index = -1;
      let terminatorLength = 0;
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code === 10 || code === 13) {
          if (code === 13 && i === text.length - 1 && !final) break;
          index = i;
          terminatorLength = code === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
          break;
        }
      }
      if (index < 0) {
        if (state.size + new TextEncoder().encode(text).byteLength > MAX_SSE_FRAME) {
          // Do not retain an unterminated oversized line.  The next blank
          // line will reset the poisoned frame and permit recovery.
          state.overflow = true;
          text = "";
          discardUntilBreak = true;
        }
        break;
      }
      const line = text.slice(0, index);
      text = text.slice(index + terminatorLength);
      processSseLine(line, terminatorLength, state, protocol, accumulator);
    }
    if (final && text.length > 0) {
      if (state.size + new TextEncoder().encode(text).byteLength <= MAX_SSE_FRAME) {
        processSseLine(text, 0, state, protocol, accumulator);
      }
      else state.overflow = true;
      text = "";
    }
    if (final) {
      // A final line without the customary trailing blank line is still a
      // useful terminal event in practice.
      inspectSseFrame(state, protocol, accumulator);
      resetSse(state);
    }
  };

  return {
    push(bytes) {
      try {
        // Keep decoded input bounded even when a provider hands us a very
        // large chunk. TextDecoder's streaming state safely handles a UTF-8
        // code point split between these slices.
        for (let offset = 0; offset < bytes.byteLength; offset += MAX_DECODE_SLICE) {
          const end = Math.min(offset + MAX_DECODE_SLICE, bytes.byteLength);
          text += decoder.decode(bytes.subarray(offset, end), { stream: true });
          drain(false);
        }
      } catch {
        // Ignore parser failures, retaining pass-through behavior.
      }
    },
    finish() {
      try {
        text += decoder.decode();
        drain(true);
      } catch {
        // Ignore parser failures.
      }
    },
  };
}

function makeJsonObserver(
  protocol: UsageProtocol,
  accumulator: UsageAccumulator,
): {
  push(bytes: Uint8Array): void;
  finish(): void;
} {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  return {
    push(bytes) {
      if (overflow) return;
      if (size + bytes.byteLength > MAX_BUFFERED_JSON) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(bytes);
      size += bytes.byteLength;
    },
    finish() {
      if (overflow) return;
      try {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        inspectJson(JSON.parse(new TextDecoder().decode(bytes)), protocol, accumulator);
      } catch {
        // Empty, malformed, or non-UTF-8 JSON is not a report.
      }
    },
  };
}

/**
 * Return a response whose body is byte-for-byte the input body while usage is
 * observed synchronously as each chunk passes through.
 */
export function observeUsage(
  response: Response,
  protocol: UsageProtocol,
  accumulator: UsageAccumulator,
  options: { streamed?: boolean } = {},
): Response {
  if (!response.body) return response;

  const observer = options.streamed
    ? makeSseObserver(protocol, accumulator)
    : makeJsonObserver(protocol, accumulator);
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Observer failures are isolated; errors from the upstream body are
      // owned by pipeThrough and therefore propagate unchanged.
      try {
        observer.push(chunk);
      } catch {
        // A user-supplied accumulator/property must never break pass-through.
      }
      controller.enqueue(chunk);
    },
    flush() {
      try {
        observer.finish();
      } catch {
        // See transform(): observation is strictly best effort.
      }
    },
  });

  let body: ReadableStream<Uint8Array>;
  try {
    body = response.body.pipeThrough(transform);
  } catch {
    return response;
  }

  try {
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  } catch {
    return response;
  }
}
