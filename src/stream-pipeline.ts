import type { IncomingMessage, ServerResponse } from "node:http";
import { TransformStream } from "node:stream/web";
import { BODY_TOO_LARGE_CODE } from "./dashboard-routes.js";
import type { AssistantMessage } from "./anthropic.js";

export const MAX_VALIDATE_BYTES = 8 * 1024 * 1024;
/** 25 MiB decoded document × base64 expansion, plus JSON-envelope headroom. */
export const DEFAULT_MAX_BODY_BYTES = 36 * 1024 * 1024;

export const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding", "host",
]);

/**
 * Write a chunk to a ServerResponse while properly tracking backpressure.
 * Invokes onCommit on the first successful byte write.
 */
export async function writeChunk(
  res: ServerResponse,
  bytes: Buffer | Uint8Array,
  onCommit?: () => void,
): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  if (bytes.length === 0) return true;
  onCommit?.();
  if (res.write(bytes)) return true;
  if (res.destroyed || res.writableEnded) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onDrain = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onClose);
    };
    res.on("drain", onDrain);
    res.on("close", onClose);
    res.on("error", onClose);
  });
}

/**
 * Read the full body of an IncomingMessage up to maxBytes.
 * Throws 413 error if body exceeds maxBytes.
 */
export function readBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };

    const onData = (c: Buffer) => {
      if (done) return;
      total += c.length;
      if (total > maxBytes) {
        done = true;
        cleanup();
        // Drain without retaining the rest so the client can receive the explicit 413 response.
        req.resume();
        // Tagged, not described: the dashboard route classifies 413-vs-500 from this CODE. It used
        // to regex-match this very message string, i.e. the relay inferring its own intent from
        // prose — see `BODY_TOO_LARGE_CODE`. Harmless for the other caller, which ignores it.
        reject(Object.assign(new Error("request body too large"), { code: BODY_TOO_LARGE_CODE }));
        return;
      }
      chunks.push(c);
    };

    const onEnd = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/**
 * Wrap a streaming Response with an inter-chunk stall watchdog.
 */
export function withStallWatchdog(response: Response, controller: AbortController, stallTimeoutMs: number): Response {
  const originalBody = response.body;
  if (!originalBody) return response;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const resetTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort();
    }, stallTimeoutMs);
  };

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    start() {
      resetTimer();
    },
    transform(chunk, streamController) {
      resetTimer();
      streamController.enqueue(chunk);
    },
    flush() {
      if (timer !== null) clearTimeout(timer);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
    },
  });

  return new Response(originalBody.pipeThrough(transformStream), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Fail-closed terminal error response for standard endpoints. */
export function failClosed(
  res: ServerResponse,
  status: number,
  message: string,
  extraHeaders?: Record<string, string | string[]>,
  errorType = "api_error",
): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json",
    ...(extraHeaders ?? {}),
  });
  res.end(JSON.stringify({
    type: "error",
    error: { type: errorType, message },
  }));
}

/** Forward a local Response descriptor directly to ServerResponse. */
/**
 * Forward a response the RELAY authored — a `RequestMappingError` 400, a `DocumentError` 400, a
 * dialect destructive refusal — to the client.
 *
 * ⚠ The body is buffered BEFORE the head is committed, and that order is the point. This is the
 * local-failure exit of both candidate loops, where the contract is to fail CLEAN: while the head
 * is unsent the caller can still answer with a proper status, so a body read that rejects must
 * throw before `writeHead`, never after it. Committing the head first and then streaming leaves a
 * truncated body under an already-sent status, which is the one outcome this path exists to avoid.
 * The bodies are small and relay-authored, so buffering costs nothing.
 */
export async function forwardLocalResponse(res: ServerResponse, local: Response): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [k, v] of local.headers) headers[k] = v;
  const bytes = Buffer.from(await local.arrayBuffer());
  if (!res.headersSent) res.writeHead(local.status, headers);
  res.end(bytes);
}

/** Parse an AssistantMessage from raw JSON string if valid. */
/**
 * Parse a buffered backend body into an `AssistantMessage`.
 *
 * ⚠ The shape test is `content` being an array — NOT `role === "assistant"`. `AssistantMessage`
 * declares no `role` field at all, so gating on one makes the parser demand something outside its
 * own contract and silently answer null (validation and repair are then skipped) for any body
 * that omits it.
 *
 * ⚠ The fields are copied deliberately rather than cast wholesale: `stop_reason` normalizes an
 * absent value to `null`, because `emitSse` writes the field back onto the wire and `undefined`
 * omits the key where `null` states it.
 */
export function parseAssistant(text: string): AssistantMessage | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (!Array.isArray(j.content)) return null;
    const msg: AssistantMessage = {
      content: j.content as AssistantMessage["content"],
      stop_reason: (j.stop_reason ?? null) as AssistantMessage["stop_reason"],
      usage: j.usage as AssistantMessage["usage"],
    };
    if (typeof j.id === "string" && j.id) msg.id = j.id;
    if (typeof j.model === "string" && j.model) msg.model = j.model;
    if (typeof j.stop_sequence === "string" || j.stop_sequence === null) {
      msg.stop_sequence = j.stop_sequence;
    }
    return msg;
  } catch {
    return null;
  }
}

/** Find end of double newline in SSE stream. */
export function frameEnd(buf: Buffer): number {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) return i + 2;
    if (i < buf.length - 3 && buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
      return i + 4;
    }
  }
  return -1;
}

/** Check if an SSE frame opens a tool_use block. */
/**
 * If `frame` is a `content_block_start` event opening a `tool_use` block, return its block index;
 * otherwise null. This is the trigger to start withholding.
 *
 * ⚠ The `data:` lines are COLLECTED and JOINED before parsing, and the split tolerates CRLF — the
 * `sse-frames.ts` convention. SSE permits a payload spread over several `data:` lines, so parsing
 * each line on its own answers null for exactly the multi-line frame this exists to catch.
 */
export function frameOpensToolUse(frame: Buffer): number | null {
  const dataLines: string[] = [];
  for (const line of frame.toString("utf8").split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  let evt: unknown;
  try {
    evt = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
  if (typeof evt !== "object" || evt === null) return null;
  const e = evt as { type?: unknown; index?: unknown; content_block?: { type?: unknown } };
  if (e.type !== "content_block_start") return null;
  if (!e.content_block || e.content_block.type !== "tool_use") return null;
  return typeof e.index === "number" ? e.index : 0;
}

/** Build Anthropic SSE error event frame. */
export function sseError(message: string): string {
  return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`;
}

/** Build OpenAI SSE error event frame. */
export function openAiSseError(message: string): string {
  return `data: ${JSON.stringify({ error: { message, type: "api_error" } })}\n\n`;
}
