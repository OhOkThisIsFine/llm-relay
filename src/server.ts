import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import {
  DEFAULT_ANTHROPIC_VERSION,
  resolveTarget,
  reshaperForTarget,
  RoutingError,
  type Config,
  type ResolvedTarget,
} from "./config.js";
import { MetadataLogger, type RequestLog } from "./log.js";
import { ToolUseValidator } from "./validator.js";
import { reconstructFromSse } from "./sse.js";
import { emitSse, emitSseTail } from "./emitSse.js";
import { repair, destructiveMatcher, type RepairOutcome } from "./repair.js";
import { HttpReshaper, type Reshaper } from "./reshaper.js";
import { fetchBackend, fetchOpenAiFront } from "./backend.js";
import { ModelCatalog } from "./catalog.js";
import { buildRegistry } from "./registry.js";
import { toolSchemaMap, type AssistantMessage, type JsonSchema } from "./anthropic.js";
import { PingLoop } from "./ping/cadence.js";
import { recordModelCall } from "./ping/runtime-telemetry.js";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding", "host",
]);
const INBOUND_AUTH = ["authorization", "x-api-key"];
const MAX_VALIDATE_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface ProxyDeps {
  reshaper?: Reshaper;
  catalog?: ModelCatalog;
  pingLoop?: PingLoop;
}

export function createProxy(cfg: Config, deps: ProxyDeps = {}) {
  const validator = new ToolUseValidator();
  const logger = new MetadataLogger(cfg.log);
  const isDestructive = destructiveMatcher(cfg.repair.destructiveTools);
  const catalog = deps.catalog ?? new ModelCatalog();
  const pingLoop = deps.pingLoop ?? new PingLoop(cfg, catalog);

  // Reshaper selection is per-resolved-target: an explicit global reshaper (or an
  // injected one) wins for every request; otherwise an openai target reshapes on
  // itself (same base/model/key), built once per (provider, model) and cached.
  const explicitReshaper: Reshaper | undefined =
    deps.reshaper ?? (cfg.reshaper ? new HttpReshaper(cfg.reshaper) : undefined);
  const reshaperCache = new Map<string, Reshaper>();
  const resolveReshaper = (target: ResolvedTarget): Reshaper | undefined => {
    if (explicitReshaper) return explicitReshaper;
    const spec = reshaperForTarget(target);
    if (!spec) return undefined;
    const key = `${target.provider}::${target.model ?? ""}`;
    let r = reshaperCache.get(key);
    if (!r) {
      r = new HttpReshaper(spec);
      reshaperCache.set(key, r);
    }
    return r;
  };

  return createServer((req, res) => {
    handle(req, res, cfg, { validator, logger, isDestructive, resolveReshaper, catalog, pingLoop }).catch((e) => {
      failClosed(res, 502, `llm-relay internal error: ${(e as Error).message}`);
    });
  });
}

interface Handlers {
  validator: ToolUseValidator;
  logger: MetadataLogger;
  isDestructive: (name: string) => boolean;
  resolveReshaper: (target: ResolvedTarget) => Reshaper | undefined;
  catalog: ModelCatalog;
  pingLoop?: PingLoop;
}

async function handle(req: IncomingMessage, res: ServerResponse, cfg: Config, h: Handlers): Promise<void> {
  const started = Date.now();
  const path = req.url ?? "/";

  let reqBuf: Buffer;
  try {
    reqBuf = await readBody(req);
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg.includes("too large") ? 413 : 400;
    failClosed(res, status, msg);
    h.logger.write(baseLog(started, path, null, false, false, status, "skipped"));
    return;
  }

  let reqJson: unknown;
  try {
    reqJson = reqBuf.length ? JSON.parse(reqBuf.toString("utf8")) : undefined;
  } catch {
    reqJson = undefined;
  }
  const tools = toolSchemaMap(reqJson);
  const hadTools = tools.size > 0;
  const model = pickString(reqJson, "model");
  const wantsStream = pickBool(reqJson, "stream");
  const pathname = path.split("?")[0] ?? path;

  // Discovery endpoint for a dispatcher (e.g. audit-tools): providers × live models
  // (best-effort capability) + routing + raw leaderboard scores, one coherent view.
  if (req.method === "GET" && pathname === "/registry") {
    const view = await buildRegistry(cfg, h.catalog, h.pingLoop ? { pingLoop: h.pingLoop } : {});
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(view));
    h.logger.write(baseLog(started, path, model, false, false, 200, "skipped"));
    return;
  }

  if (req.method === "GET" && pathname === "/ping") {
    if (h.pingLoop) {
      await h.pingLoop.tickOnce();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pingMode: h.pingLoop?.getMode(), intervalMs: h.pingLoop?.getIntervalMs() }));
    h.logger.write(baseLog(started, path, model, false, false, 200, "skipped"));
    return;
  }

  if (req.method === "GET" && (pathname === "/health/stats" || pathname === "/health")) {
    const view = await buildRegistry(cfg, h.catalog, h.pingLoop ? { pingLoop: h.pingLoop } : {});
    const stats: Record<string, unknown> = {
      generated_at: view.generated_at,
      ping_mode: h.pingLoop?.getMode(),
      providers: view.providers,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(stats));

    h.logger.write(baseLog(started, path, model, false, false, 200, "skipped"));
    return;
  }


  const isCountTokens = req.method === "POST" && pathname === "/v1/messages/count_tokens";
  const isMessages = req.method === "POST" && pathname.startsWith("/v1/messages") && !isCountTokens;

  // Route the request's model to a concrete provider + backend model. A bad route
  // (unknown provider, missing model) is a clean 400, never a crash.
  let target: ResolvedTarget;
  try {
    target = resolveTarget(model, cfg);
  } catch (e) {
    if (e instanceof RoutingError) {
      failClosed(res, 400, `llm-relay routing: ${e.message}`);
      h.logger.write(baseLog(started, path, model, hadTools, false, 400, "skipped"));
      return;
    }
    throw e;
  }

  // OpenAI-compatible FRONT: a dispatcher (e.g. audit-tools) POSTs OpenAI Chat
  // Completions with a namespaced model; route by target and reverse-proxy the
  // upstream OpenAI response straight back (OpenAI in, OpenAI out).
  if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
    await openAiFrontPath(res, target, { reqJson, wantsStream, started, path, model, hadTools, req }, h);
    return;
  }

  // OpenAI-compatible backends expose ONLY /chat/completions — they have no
  // count_tokens route and no other Anthropic paths. Rather than mistranslate
  // those into a chat completion (yielding a spurious 400/garbage), answer
  // count_tokens locally with a cheap estimate and reject other paths cleanly.
  // For an Anthropic backend everything forwards as before (it speaks these).
  if (target.kind === "openai") {
    if (isCountTokens) {
      const input_tokens = estimateInputTokens(reqJson);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens }));
      h.logger.write(baseLog(started, path, model, hadTools, false, 200, "skipped"));
      return;
    }
    if (!isMessages) {
      failClosed(res, 404, `llm-relay: path not supported for an openai backend: ${pathname}`);
      h.logger.write(baseLog(started, path, model, hadTools, false, 404, "skipped"));
      return;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs);
  const onResClose = () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };
  res.on("close", onResClose);

  try {
    let backendRes: Response;
    try {
      backendRes = await fetchBackend(target, {
        path,
        method: req.method ?? "POST",
        reqBuf,
        reqJson,
        anthropicHeaders: buildForwardHeaders(req.headers, target),
        wantsStream,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      failClosed(res, aborted ? 504 : 502, aborted ? "backend timed out" : `backend unreachable: ${(e as Error).message}`);
      h.logger.write(baseLog(started, path, model, hadTools, false, aborted ? 504 : 502, "skipped"));
      return;
    }

    const streamed = (backendRes.headers.get("content-type") ?? "").includes("text/event-stream");
    const willValidate = isMessages && hadTools && backendRes.status < 400;
    const reshaper = h.resolveReshaper(target);
    const doRepair = cfg.mode === "repair" && willValidate && reshaper !== undefined;

    if (doRepair) {
      await repairPath(res, backendRes, timer, { tools, model, wantsStream, streamed, started, path, hadTools, reshaper: reshaper!, req }, h);
    } else {
      await transparentPath(res, backendRes, timer, { tools, model, streamed, willValidate, started, path, hadTools, req }, h);
    }
  } finally {
    clearTimeout(timer);
    res.off("close", onResClose);
  }
}

interface Ctx {
  tools: Map<string, JsonSchema | null>;
  model: string | null;
  streamed: boolean;
  started: number;
  path: string;
  hadTools: boolean;
  req?: IncomingMessage;
}

/**
 * OpenAI front: reverse-proxy the resolved target's /chat/completions to the client,
 * verbatim (streaming or buffered). No Anthropic translation, no tool-call repair —
 * this is the multiplexer path a dispatcher uses to reach many backends by namespace.
 */
async function openAiFrontPath(
  res: ServerResponse,
  target: ResolvedTarget,
  ctx: { reqJson: unknown; wantsStream: boolean; started: number; path: string; model: string | null; hadTools: boolean; req?: IncomingMessage },
  h: Handlers,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs);
  const onResClose = () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };
  res.on("close", onResClose);

  let upstream: Response;
  try {
    upstream = await fetchOpenAiFront(target, { reqJson: ctx.reqJson, wantsStream: ctx.wantsStream, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    res.off("close", onResClose);
    const aborted = controller.signal.aborted;
    const status = aborted ? 504 : 502;
    if (!res.headersSent) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: aborted ? "backend timed out" : `backend unreachable: ${(e as Error).message}`, type: "api_error" } }));
    }
    h.logger.write(baseLog(ctx.started, ctx.path, ctx.model, ctx.hadTools, false, status, "skipped"));
    return;
  }
  try {
    res.writeHead(upstream.status, filterResponseHeaders(upstream.headers));
    if (upstream.body) {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        if (!await writeChunk(res, Buffer.from(chunk))) break;
      }
    }
    if (!res.writableEnded) res.end();
  } finally {
    clearTimeout(timer);
    res.off("close", onResClose);
  }
  const streamed = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  h.logger.write(baseLog(ctx.started, ctx.path, ctx.model, ctx.hadTools, streamed, upstream.status, "skipped"));
}

/** detect/default: forward bytes unchanged, observe + log if applicable. */
async function transparentPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: Ctx & { willValidate: boolean },
  h: Handlers,
): Promise<void> {
  res.writeHead(backendRes.status, filterResponseHeaders(backendRes.headers));
  let assistant: AssistantMessage | null = null;
  try {
    if (!backendRes.body) {
      if (!res.writableEnded) res.end();
    } else if (ctx.streamed) {
      const decoder = new TextDecoder();
      let acc = "";
      let overflow = false;
      for await (const chunk of backendRes.body as unknown as AsyncIterable<Uint8Array>) {
        if (!await writeChunk(res, Buffer.from(chunk))) break;
        if (ctx.willValidate && !overflow) {
          acc += decoder.decode(chunk, { stream: true });
          if (acc.length > MAX_VALIDATE_BYTES) overflow = true;
        }
      }
      if (!res.writableEnded) res.end();
      if (ctx.willValidate && !overflow) assistant = reconstructFromSse(acc + decoder.decode());
    } else {
      const bytes = Buffer.from(await backendRes.arrayBuffer());
      if (!res.writableEnded) res.end(bytes);
      if (ctx.willValidate && bytes.length <= MAX_VALIDATE_BYTES) assistant = parseAssistant(bytes.toString("utf8"));
    }
  } finally {
    clearTimeout(timer);
  }

  let validated: RequestLog["validated"] = "skipped";
  let toolUseCount = 0;
  let uncheckableCount = 0;
  let errorKinds: string[] = [];
  if (ctx.willValidate && assistant) {
    const r = h.validator.validate(assistant, ctx.tools);
    validated = r.errors.length > 0 ? "fail" : r.uncheckableCount > 0 ? "uncheckable" : "pass";
    toolUseCount = r.toolUseCount;
    uncheckableCount = r.uncheckableCount;
    errorKinds = dedupe(r.errors.map((e) => e.kind));
  }
  h.logger.write({
    ...baseLog(ctx.started, ctx.path, ctx.model, ctx.hadTools, ctx.streamed, backendRes.status, validated),
    toolUseCount, uncheckableCount, errorKinds,
  });
}

type RepairCtx = Ctx & { wantsStream: boolean; reshaper: Reshaper };

/** repair: route to the streaming or buffered variant. */
async function repairPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: RepairCtx,
  h: Handlers,
): Promise<void> {
  if (ctx.streamed) {
    await repairStreamingPath(res, backendRes, timer, ctx, h);
  } else {
    await repairBufferedPath(res, backendRes, timer, ctx, h);
  }
}

/**
 * repair, streaming: forward text-block SSE frames to the client as they arrive;
 * withhold everything from the first tool_use `content_block_start` onward. At
 * end-of-stream, validate the reconstructed message — if the tool calls are valid,
 * flush the withheld frames byte-for-byte (fully transparent); if invalid, repair
 * and re-emit only the corrected trailing blocks. `message_start` and any leading
 * text have already reached the client, so a pure-text response streams through
 * with zero added latency.
 */
async function repairStreamingPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: RepairCtx,
  h: Handlers,
): Promise<void> {
  const filtered = filterResponseHeaders(backendRes.headers);
  const decoder = new TextDecoder();
  let acc = "";                 // full decoded stream, for reconstruction
  let overflow = false;         // acc exceeded the validate cap → give up repair
  let work = Buffer.alloc(0);   // raw bytes not yet split into complete frames
  const held: Buffer[] = [];    // frames withheld from the client (first tool_use onward)
  let buffering = false;
  let firstToolUseIndex = -1;
  let headWritten = false;

  const ensureHead = () => {
    if (!headWritten) {
      res.writeHead(backendRes.status, filtered);
      headWritten = true;
    }
  };
  const forward = async (frame: Buffer) => {
    ensureHead();
    await writeChunk(res, frame);
  };
  const flushHeld = async () => {
    for (const f of held) {
      if (res.destroyed) break;
      await forward(f);
    }
    held.length = 0;
  };

  const processFrame = async (frame: Buffer): Promise<void> => {
    if (!overflow) {
      acc += frame.toString("utf8");
      if (acc.length > MAX_VALIDATE_BYTES) {
        // Too large to validate/repair safely: stop holding, stream the rest.
        overflow = true;
        if (buffering) {
          await flushHeld();
          buffering = false;
        }
      }
    }
    if (buffering) {
      held.push(frame);
      return;
    }
    const toolUseIdx = overflow ? null : frameOpensToolUse(frame);
    if (toolUseIdx !== null) {
      buffering = true;
      firstToolUseIndex = toolUseIdx;
      held.push(frame);
      return;
    }
    await forward(frame);
  };

  try {
    if (backendRes.body) {
      for await (const chunk of backendRes.body as unknown as AsyncIterable<Uint8Array>) {
        if (res.destroyed) break;
        work = work.length ? Buffer.concat([work, Buffer.from(chunk)]) : Buffer.from(chunk);
        let end: number;
        while ((end = frameEnd(work)) !== -1) {
          const frame = work.subarray(0, end);
          work = Buffer.from(work.subarray(end)); // detach from the growing buffer
          await processFrame(frame);
        }
      }
    }
    if (work.length) await processFrame(work); // trailing partial frame
  } finally {
    clearTimeout(timer);
  }

  let validated: RequestLog["validated"] = "skipped";
  let toolUseCount = 0;
  let uncheckableCount = 0;
  let errorKinds: string[] = [];
  let repairOutcome: RepairOutcome | "none" = "none";

  if (overflow || !buffering) {
    // Nothing was withheld (pure text, or gave up): stream already complete.
    if (!buffering) {
      const assistant = overflow ? null : reconstructFromSse(acc);
      if (assistant) {
        const r = h.validator.validate(assistant, ctx.tools);
        validated = r.errors.length > 0 ? "fail" : r.uncheckableCount > 0 ? "uncheckable" : "pass";
        toolUseCount = r.toolUseCount;
        uncheckableCount = r.uncheckableCount;
        errorKinds = dedupe(r.errors.map((e) => e.kind));
      }
    }
    ensureHead();
    if (!res.writableEnded) res.end();
  } else {
    const assistant = reconstructFromSse(acc);
    const r = h.validator.validate(assistant, ctx.tools);
    toolUseCount = r.toolUseCount;
    uncheckableCount = r.uncheckableCount;
    if (r.valid) {
      validated = r.uncheckableCount > 0 ? "uncheckable" : "pass";
      await flushHeld();
      ensureHead();
      if (!res.writableEnded) res.end();
    } else {
      validated = "fail";
      errorKinds = dedupe(r.errors.map((e) => e.kind));
      const decision = await repair(assistant, ctx.tools, {
        validator: h.validator,
        reshaper: ctx.reshaper,
        maxAttempts: 2,
        isDestructive: h.isDestructive,
      });
      repairOutcome = decision.outcome;
      ensureHead(); // message_start + leading text already forwarded
      if (decision.outcome === "fixed" && decision.message) {
        if (!res.writableEnded) res.end(emitSseTail(decision.message, firstToolUseIndex));
      } else {
        // Head already committed — surface a mid-stream SSE error, never a fabricated call.
        if (!res.writableEnded) res.end(sseError(`llm-relay: tool call could not be repaired (${decision.outcome})`));
      }
    }
  }

  h.logger.write({
    ...baseLog(ctx.started, ctx.path, ctx.model, ctx.hadTools, true, backendRes.status, validated),
    toolUseCount, uncheckableCount, errorKinds, repair: repairOutcome,
  });
}

/** repair, buffered (non-streamed JSON): buffer, validate; if invalid, reshape and re-emit. */
async function repairBufferedPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: RepairCtx,
  h: Handlers,
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await backendRes.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
  const assistant = ctx.streamed
    ? reconstructFromSse(bytes.toString("utf8"))
    : parseAssistant(bytes.toString("utf8"));

  const filtered = filterResponseHeaders(backendRes.headers);
  let repairOutcome: RepairOutcome | "none" = "none";
  let validated: RequestLog["validated"] = "skipped";
  let toolUseCount = 0;
  let uncheckableCount = 0;
  let errorKinds: string[] = [];

  if (!assistant) {
    // Couldn't parse — forward unchanged.
    res.writeHead(backendRes.status, filtered);
    if (!res.writableEnded) res.end(bytes);
  } else {
    const r = h.validator.validate(assistant, ctx.tools);
    toolUseCount = r.toolUseCount;
    uncheckableCount = r.uncheckableCount;
    if (r.valid) {
      validated = r.uncheckableCount > 0 ? "uncheckable" : "pass";
      res.writeHead(backendRes.status, filtered); // pass through untouched
      if (!res.writableEnded) res.end(bytes);
    } else {
      validated = "fail";
      errorKinds = dedupe(r.errors.map((e) => e.kind));
      const decision = await repair(assistant, ctx.tools, {
        validator: h.validator,
        reshaper: ctx.reshaper,
        maxAttempts: 2,
        isDestructive: h.isDestructive,
      });
      repairOutcome = decision.outcome;
      if (decision.outcome === "fixed" && decision.message) {
        emitFixed(res, backendRes.status, filtered, decision.message, ctx.wantsStream, ctx.model);
      } else {
        // fail-clean: loud, well-formed error rather than a silently broken call.
        failClosed(res, 502, `llm-relay: tool call could not be repaired (${decision.outcome})`);
      }
    }
  }

  h.logger.write({
    ...baseLog(ctx.started, ctx.path, ctx.model, ctx.hadTools, ctx.streamed, backendRes.status, validated),
    toolUseCount, uncheckableCount, errorKinds, repair: repairOutcome,
  });
}

function emitFixed(
  res: ServerResponse,
  status: number,
  filtered: Record<string, string | string[]>,
  message: AssistantMessage,
  wantsStream: boolean,
  model: string | null,
): void {
  if (wantsStream) {
    res.writeHead(status, { ...filtered, "content-type": "text/event-stream" });
    if (!res.writableEnded) res.end(emitSse(message));
  } else {
    res.writeHead(status, { ...filtered, "content-type": "application/json" });
    if (!res.writableEnded) res.end(JSON.stringify(toAnthropicMessage(message, model)));
  }
}

function toAnthropicMessage(msg: AssistantMessage, model: string | null): object {
  return {
    id: "msg_repair",
    type: "message",
    role: "assistant",
    model: model ?? "",
    content: msg.content,
    stop_reason: msg.stop_reason ?? "end_turn",
    stop_sequence: null,
    usage: msg.usage ?? { input_tokens: 0, output_tokens: 0 },
  };
}

function buildForwardHeaders(inbound: IncomingMessage["headers"], target: ResolvedTarget): Record<string, string> {
  const apiKey = target.authEnv ? process.env[target.authEnv]?.trim() : undefined;
  const stripAuth = !!apiKey;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inbound)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (stripAuth && INBOUND_AUTH.includes(key)) continue;
    if (v === undefined) continue;
    out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  if (!out["anthropic-version"]) out["anthropic-version"] = DEFAULT_ANTHROPIC_VERSION;
  if (apiKey) {
    if (target.authHeader === "authorization") out["authorization"] = `Bearer ${apiKey}`;
    else out["x-api-key"] = apiKey;
  }
  return out;
}

function filterResponseHeaders(hh: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  hh.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) return;
    if (k === "set-cookie") return;
    out[key] = value;
  });
  if (typeof hh.getSetCookie === "function") {
    const cookies = hh.getSetCookie();
    if (cookies.length > 0) {
      out["set-cookie"] = cookies;
    }
  } else {
    const sc = hh.get("set-cookie");
    if (sc) out["set-cookie"] = sc;
  }
  return out;
}

function parseAssistant(text: string): AssistantMessage | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (!Array.isArray(j.content)) return null;
    return {
      content: j.content as AssistantMessage["content"],
      stop_reason: (j.stop_reason ?? null) as AssistantMessage["stop_reason"],
      usage: j.usage as AssistantMessage["usage"],
    };
  } catch {
    return null;
  }
}

/**
 * End offset (exclusive) of the first complete SSE frame in `buf`, or -1 if no
 * frame boundary is present yet. Frames are delimited by a blank line — `\n\n`
 * (LF) or `\r\n\r\n` (CRLF); whichever boundary comes first wins. Operates on
 * raw bytes so multibyte UTF-8 in event payloads is never split.
 */
function frameEnd(buf: Buffer): number {
  const lf = buf.indexOf("\n\n", 0, "latin1");
  const crlf = buf.indexOf("\r\n\r\n", 0, "latin1");
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return crlf + 4;
  return lf + 2;
}

/**
 * If `frame` is a `content_block_start` event opening a `tool_use` block, return
 * its block index; otherwise null. This is the trigger to start withholding.
 */
function frameOpensToolUse(frame: Buffer): number | null {
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

/** A single Anthropic-style SSE `error` event, for failing an already-open stream. */
function sseError(message: string): string {
  const data = JSON.stringify({ type: "error", error: { type: "api_error", message } });
  return `event: error\ndata: ${data}\n\n`;
}

function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
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
        req.destroy();
        reject(new Error("request body too large"));
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

async function writeChunk(res: ServerResponse, chunk: Buffer): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  try {
    const ok = res.write(chunk);
    if (!ok && !res.destroyed && !res.writableEnded) {
      await once(res, "drain");
    }
    return !res.destroyed && !res.writableEnded;
  } catch {
    return false;
  }
}

function failClosed(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
}

function baseLog(
  started: number, path: string, model: string | null, hadTools: boolean,
  streamed: boolean, backendStatus: number, validated: RequestLog["validated"],
): RequestLog {
  return {
    ts: new Date(started).toISOString(),
    path, backendModel: model, hadTools, streamed, backendStatus, validated,
    toolUseCount: 0, uncheckableCount: 0, errorKinds: [], repair: "none",
    latencyMs: Date.now() - started,
  };
}

/**
 * Cheap local token estimate for a /v1/messages/count_tokens request against an
 * OpenAI backend (which has no native count_tokens). ~4 chars/token over all
 * string content in system+messages+tools. Advisory only — the harness uses this
 * for context-budget bookkeeping, not correctness.
 */
function estimateInputTokens(body: unknown): number {
  if (typeof body !== "object" || body === null) return 0;
  let chars = 0;
  const walk = (v: unknown): void => {
    if (typeof v === "string") chars += v.length;
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  const b = body as Record<string, unknown>;
  walk(b.system);
  walk(b.messages);
  walk(b.tools);
  return Math.max(1, Math.ceil(chars / 4));
}

function pickString(obj: unknown, key: string): string | null {
  if (typeof obj === "object" && obj !== null) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return null;
}

function pickBool(obj: unknown, key: string): boolean {
  return typeof obj === "object" && obj !== null && (obj as Record<string, unknown>)[key] === true;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
