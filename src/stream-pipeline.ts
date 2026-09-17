import type { IncomingMessage, ServerResponse } from "node:http";
import { TransformStream } from "node:stream/web";
import type { AssistantMessage } from "./anthropic.js";
import type { CrawlWatchdogConfig } from "./config-types.js";
import { isRecord } from "./json-shape.js";
import { estimateTokensFromCharacters } from "./metadata.js";
import { BufferedSseFrames, parseSseEvent } from "./sse-frames.js";

/**
 * The code `readBody` sets when it refused a body for exceeding the cap. Owned HERE, by the
 * thrower, since 2026-09-04 (contract review DR-005): `dashboard-routes.ts` re-exports it for its
 * own classifier, and `server.ts` classifies 413-vs-400 through `bodyReadStatus` below. Both
 * consumers read this TAG. Until this date the data plane still regex-matched the MESSAGE
 * ("too large") — the relay inferring its own intent from prose it had written itself, the
 * inference the dashboard route had already stopped making.
 */
export const BODY_TOO_LARGE_CODE = "ERR_DASHBOARD_BODY_TOO_LARGE";

/** 413 when `readBody` refused the body for size; 400 for any other body-read failure. */
export function bodyReadStatus(error: unknown): 413 | 400 {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code: unknown }).code
    : undefined;
  return code === BODY_TOO_LARGE_CODE ? 413 : 400;
}

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
        // Tagged, not described: both consumers classify from this CODE — the dashboard route
        // 413-vs-500, the data plane 413-vs-400 via `bodyReadStatus` — never from the message.
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

/**
 * Default crawl-abort threshold: ms per output token, sustained over a full trailing window, above
 * which a COMMITTED stream is judged CRAWLING rather than merely producing a long answer.
 *
 * Calibrated 2026-09-09, on the `latency-demotion.ts` precedent: 4 x `DEFAULT_LATENCY_MS_PER_TOKEN`
 * (250 ms/token, itself measured over 68 real requests on 2026-08-30 — see that file's own
 * comment). A crawl abort hands the client a failure it must retry — measured in
 * `docs/history/post-commit-stall-measurement-2026-09-09.md`: Claude Code retries once, downgraded to a
 * NON-STREAMING request; Codex retries up to five times, staying streaming, in all four measured
 * cells — so the bar must sit far above the demotion threshold, or a deployment merely slow enough
 * to be latency-demoted would also be aborted mid-response. 250 ms/token is itself ~3.5x the
 * healthy band measured that day, so 1000 ms/token sits well clear of ordinary slow-but-working
 * traffic. A tunable default, not a provider fact — the provenance invariant permits this.
 * Re-calibrate by reading `~/.llm-relay/usage/recent.json` the same way `latency-demotion.ts`
 * describes; there is no dedicated crawl-abort log field to read back yet (see the accepted gaps
 * in `docs/backlog.md`'s "Build the post-commit CRAWL abort" entry once it is amended).
 */
export const DEFAULT_CRAWL_MS_PER_TOKEN = 1000;
/**
 * Width of the trailing window the crawl rate is measured over, in ms — and, since the rate is
 * `windowMs / tokensInWindow` (see `withCrawlWatchdog`), also the numerator of every rate this
 * watchdog ever computes.
 *
 * Corrected 2026-09-09 (fixing a same-day defect the packet that introduced this watchdog shipped
 * uncaught): the ORIGINAL pairing of `windowMs: 20_000` with `minTokens: 50` could never fire.
 * That version measured `spanMs = min(elapsed, windowMs)` — so `spanMs` never exceeded 20 000 —
 * and required `tokensInWindow >= minTokens` (50) before judging `rate = spanMs / tokensInWindow`.
 * The worst case allowed was 20 000 ms / 50 tokens = 400 ms/token, which can never clear a 1000
 * ms/token threshold: the three defaults were mutually inconsistent by construction, and the
 * measured scenario this watchdog exists for (60 tokens over 90 s, one every 1.5 s) could not trip
 * it either. The rule is now: judge only once a FULL window has elapsed since commit
 * (`elapsed >= windowMs`), then take `tokensInWindow` as the tokens sampled in the trailing
 * `windowMs` and compute `rate = windowMs / tokensInWindow` (a fixed numerator, not a growing
 * `spanMs`) — so with `windowMs: 30_000` and `msPerToken: 1000`, fewer than 30 tokens landing in
 * any trailing 30 s window trips the abort, which the 90 s/60-token scenario clears easily (one
 * token per 1.5 s is roughly 20 tokens per 30 s window).
 */
export const DEFAULT_CRAWL_WINDOW_MS = 30_000;
/**
 * Minimum output tokens that must be observed SINCE COMMIT — across the whole stream, not just the
 * trailing window — before ANY judgement runs at all: evidence the stream is producing an answer
 * in the first place, distinct from `tokensInWindow` below. A window judged before this gate clears
 * would be able to abort a stream that has barely started, on the strength of a single early burst
 * falling silent — exactly the case the SEPARATE "full window holding zero tokens" rule below
 * already declines to judge, stated as its own gate so the two can be tested apart.
 */
export const DEFAULT_CRAWL_MIN_TOKENS = 20;

export interface CrawlWatchdogSettings {
  enabled: boolean;
  msPerToken: number;
  windowMs: number;
  minTokens: number;
}

/**
 * Resolve `routing.crawl` into a total settings object. Absent, `{}`, or any missing key means
 * the tunable default for that key — the `resolveHedgeSettings`/`resolveLatencyDemotion`
 * precedent.
 *
 * The rule `withCrawlWatchdog` enforces, in words: `minTokens` (default 20) is the minimum number
 * of output tokens observed since commit — over the WHOLE stream — before any judgement runs at
 * all, evidence the stream is producing an answer. A window is judged only once it is FULL —
 * elapsed time since commit at least `windowMs` (default 30 000). `tokensInWindow` counts only the
 * tokens whose sample time falls inside the trailing `windowMs`; a full window holding zero tokens
 * yields no opinion at all (silence is `withStallWatchdog`'s job, and this watchdog must never
 * pre-empt it). Otherwise `rate = windowMs / tokensInWindow`, and the stream is CRAWLING — the
 * fetch is aborted — when `rate > msPerToken` (default 1000).
 */
export function resolveCrawlSettings(raw: CrawlWatchdogConfig | undefined): CrawlWatchdogSettings {
  return {
    enabled: raw?.enabled ?? true,
    msPerToken: raw?.msPerToken ?? DEFAULT_CRAWL_MS_PER_TOKEN,
    windowMs: raw?.windowMs ?? DEFAULT_CRAWL_WINDOW_MS,
    minTokens: raw?.minTokens ?? DEFAULT_CRAWL_MIN_TOKENS,
  };
}

/**
 * The CLIENT-facing wire shape the crawl watchdog reads deltas from. Deliberately the same three
 * members as `stream-commit.ts`'s `StreamCommitProtocol` (not imported from there — this module
 * stays a leaf the way `sse-frames.ts` does, and the membership is copied rather than re-exported
 * so a change to one is never mistaken for a change to the other).
 */
export type CrawlProtocol = "anthropic-messages" | "openai-chat" | "openai-responses";

/**
 * A committed stream the relay itself terminated because its measured per-token rate, over the
 * sliding window, stayed worse than the configured threshold.
 *
 * `message` is EXACTLY the text the client-visible SSE `error` frame carries — no
 * "backend stream failed mid-response" wrapping prefix — because the backlog entry ("Build the
 * post-commit CRAWL abort") pins the wording. `candidate-runner.ts` `handleMidStreamError` detects
 * this type via `AbortSignal.reason` (never by inspecting the caught exception, which may be an
 * opaque `AbortError` from the fetch machinery rather than this object) and uses `.message`
 * unwrapped, plus a distinct `errorKinds` member.
 */
export class CrawlAbortedError extends Error {
  constructor(
    readonly rateMsPerToken: number,
    readonly windowMs: number,
    readonly thresholdMsPerToken: number,
  ) {
    super(
      `relay aborted a crawling stream: ${rateMsPerToken} ms/token over ${windowMs / 1000} s ` +
      `(threshold ${thresholdMsPerToken})`,
    );
    this.name = "CrawlAbortedError";
  }
}

function deltaText(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function anthropicDeltaCharacters(data: Record<string, unknown>): number {
  if (data.type !== "content_block_delta" || !isRecord(data.delta)) return 0;
  const delta = data.delta;
  if (delta.type === "text_delta") return deltaText(delta.text);
  if (delta.type === "thinking_delta") return deltaText(delta.thinking);
  if (delta.type === "input_json_delta") return deltaText(delta.partial_json);
  return 0;
}

function openAiChatChoiceDeltaCharacters(choice: unknown): number {
  if (!isRecord(choice) || !isRecord(choice.delta)) return 0;
  const delta = choice.delta;
  let total = deltaText(delta.content);
  const reasoning = typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0
    ? delta.reasoning_content
    : delta.reasoning;
  total += deltaText(reasoning);
  if (!Array.isArray(delta.tool_calls)) return total;
  for (const call of delta.tool_calls) {
    if (isRecord(call) && isRecord(call.function)) total += deltaText(call.function.arguments);
  }
  return total;
}

function openAiChatDeltaCharacters(data: Record<string, unknown>): number {
  if (!Array.isArray(data.choices)) return 0;
  let total = 0;
  for (const choice of data.choices) total += openAiChatChoiceDeltaCharacters(choice);
  return total;
}

const OPENAI_RESPONSES_TEXT_DELTA_TYPES = new Set([
  "response.output_text.delta",
  "response.refusal.delta",
  "response.reasoning.delta",
  "response.reasoning_text.delta",
]);

function openAiResponsesDeltaCharacters(data: Record<string, unknown>): number {
  const type = typeof data.type === "string" ? data.type : "";
  if (OPENAI_RESPONSES_TEXT_DELTA_TYPES.has(type)) {
    const delta = deltaText(data.delta);
    return delta > 0 ? delta : deltaText(data.text);
  }
  if (type === "response.function_call_arguments.delta") return deltaText(data.delta);
  return 0;
}

/**
 * How many characters of TEXT or TOOL-ARGUMENT delta a single parsed SSE event contributes,
 * per client-facing protocol. Advisory — this is a rate SIGNAL, not the accounting estimate
 * (`usage-observer.ts` owns that, with its base64/overflow defenses); a missed or double-counted
 * delta here changes only how quickly the watchdog notices a crawl, never a served figure.
 */
function deltaCharacters(protocol: CrawlProtocol, data: Record<string, unknown>): number {
  if (protocol === "anthropic-messages") return anthropicDeltaCharacters(data);
  if (protocol === "openai-chat") return openAiChatDeltaCharacters(data);
  return openAiResponsesDeltaCharacters(data);
}

/**
 * Wrap a COMMITTED streaming Response with a crawl watchdog: abort the backend fetch once a FULL
 * trailing window has elapsed since commit and that window's per-token rate — `settings.windowMs
 * / tokensInWindow` — exceeds `settings.msPerToken`. Two independent gates guard against judging
 * too early: `settings.minTokens` tokens must have been observed SINCE COMMIT (the whole stream,
 * not just the trailing window) before any judgement runs at all, and a full window holding ZERO
 * tokens yields no opinion rather than an abort (unmeasured is no opinion, never slow — the
 * `latency-demotion.ts` precedent; silence is `withStallWatchdog`'s job and this watchdog must
 * never pre-empt it). See `resolveCrawlSettings` for the rule spelled out in full.
 *
 * Installed at the SAME call site as `withStallWatchdog`, after the commit probe has already
 * rebuilt the response from its replayed prefix — so `now() - commitTime` (captured at
 * installation) approximates the true post-commit elapsed time.
 *
 * ⚠ The abort carries the `CrawlAbortedError` as its `AbortSignal.reason` — the same mechanism
 * `controller.abort(reason)` offers natively — rather than erroring the transform's own
 * `ReadableStreamDefaultController` directly. Enqueuing the triggering chunk and then erroring
 * the SAME controller in one microtask risks losing that already-enqueued-but-unread chunk (the
 * ReadableStream spec does not guarantee it survives an immediately following `error()`); routing
 * the abort through the existing `AbortController` — exactly how `withStallWatchdog` already ends
 * a stream — sidesteps that risk entirely and reuses a path already proven correct.
 */
export function withCrawlWatchdog(
  response: Response,
  controller: AbortController,
  protocol: CrawlProtocol,
  settings: CrawlWatchdogSettings,
  now: () => number = Date.now,
): Response {
  if (!settings.enabled) return response;
  const originalBody = response.body;
  if (!originalBody) return response;

  const decoder = new TextDecoder();
  const frames = new BufferedSseFrames();
  const commitTime = now();
  const samples: { ts: number; tokens: number }[] = [];
  let totalTokensSinceCommit = 0;
  let tripped = false;

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, streamController) {
      streamController.enqueue(chunk);
      if (tripped) return;

      try {
        frames.append(decoder.decode(chunk, { stream: true }));
        for (const { frame } of frames) {
          const event = parseSseEvent(frame);
          if (!event?.data) continue;
          const chars = deltaCharacters(protocol, event.data);
          if (chars <= 0) continue;
          const tokens = estimateTokensFromCharacters(chars);
          if (tokens > 0) {
            const ts = now();
            samples.push({ ts, tokens });
            totalTokensSinceCommit += tokens;
          }
        }
      } catch {
        // Parsing is advisory; a malformed frame must never break pass-through.
      }

      // Gate 1: not enough evidence yet that the stream is producing an answer at all.
      if (totalTokensSinceCommit < settings.minTokens) return;

      const t = now();
      const elapsed = t - commitTime;
      // Gate 2: only judge a FULL window — a partial one would let an early burst plus silence
      // read as a fast rate purely because the elapsed span was still short.
      if (elapsed < settings.windowMs) return;

      const windowStart = t - settings.windowMs;
      while (samples.length > 0 && samples[0]!.ts < windowStart) samples.shift();
      const tokensInWindow = samples.reduce((sum, s) => sum + s.tokens, 0);
      // Gate 3: a full window with literally nothing in it is silence, not a slow trickle —
      // `withStallWatchdog` owns that case.
      if (tokensInWindow === 0) return;

      const rate = settings.windowMs / tokensInWindow;
      if (rate <= settings.msPerToken) return;

      tripped = true;
      controller.abort(new CrawlAbortedError(Math.round(rate), settings.windowMs, settings.msPerToken));
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
