import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { DEFAULT_ANTHROPIC_VERSION, type Config } from "./config.js";
import { MetadataLogger, type RequestLog } from "./log.js";
import { ToolUseValidator } from "./validator.js";
import { reconstructFromSse } from "./sse.js";
import { emitSse } from "./emitSse.js";
import { repair, destructiveMatcher, type RepairOutcome } from "./repair.js";
import { HttpReshaper, type Reshaper } from "./reshaper.js";
import { fetchBackend } from "./backend.js";
import { toolSchemaMap, type AssistantMessage, type JsonSchema } from "./anthropic.js";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding", "host",
]);
const INBOUND_AUTH = ["authorization", "x-api-key"];
const MAX_VALIDATE_BYTES = 8 * 1024 * 1024;

export interface ProxyDeps {
  reshaper?: Reshaper;
}

export function createProxy(cfg: Config, deps: ProxyDeps = {}) {
  const validator = new ToolUseValidator();
  const logger = new MetadataLogger(cfg.log);
  const isDestructive = destructiveMatcher(cfg.repair.destructiveTools);
  const reshaper: Reshaper | undefined =
    deps.reshaper ?? (cfg.reshaper ? new HttpReshaper(cfg.reshaper) : undefined);

  return createServer((req, res) => {
    handle(req, res, cfg, { validator, logger, isDestructive, reshaper }).catch((e) => {
      failClosed(res, 502, `repair-proxy internal error: ${(e as Error).message}`);
    });
  });
}

interface Handlers {
  validator: ToolUseValidator;
  logger: MetadataLogger;
  isDestructive: (name: string) => boolean;
  reshaper: Reshaper | undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse, cfg: Config, h: Handlers): Promise<void> {
  const started = Date.now();
  const path = req.url ?? "/";
  const reqBuf = await readBody(req);

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
  const isMessages = req.method === "POST" && path.startsWith("/v1/messages");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.backend.timeoutMs);

  let backendRes: Response;
  try {
    backendRes = await fetchBackend(cfg, {
      path,
      method: req.method ?? "POST",
      reqBuf,
      reqJson,
      anthropicHeaders: buildForwardHeaders(req.headers, cfg),
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
  const doRepair = cfg.mode === "repair" && willValidate && h.reshaper !== undefined;

  if (doRepair) {
    await repairPath(res, backendRes, timer, { tools, model, wantsStream, streamed, started, path, hadTools }, h);
  } else {
    await transparentPath(res, backendRes, timer, { tools, model, streamed, willValidate, started, path, hadTools }, h);
  }
}

interface Ctx {
  tools: Map<string, JsonSchema | null>;
  model: string | null;
  streamed: boolean;
  started: number;
  path: string;
  hadTools: boolean;
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
      res.end();
    } else if (ctx.streamed) {
      const decoder = new TextDecoder();
      let acc = "";
      let overflow = false;
      for await (const chunk of backendRes.body as unknown as AsyncIterable<Uint8Array>) {
        if (!res.write(Buffer.from(chunk))) await once(res, "drain");
        if (ctx.willValidate && !overflow) {
          acc += decoder.decode(chunk, { stream: true });
          if (acc.length > MAX_VALIDATE_BYTES) overflow = true;
        }
      }
      res.end();
      if (ctx.willValidate && !overflow) assistant = reconstructFromSse(acc + decoder.decode());
    } else {
      const bytes = Buffer.from(await backendRes.arrayBuffer());
      res.end(bytes);
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

/** repair: buffer, validate; if invalid, reshape and emit the corrected response. */
async function repairPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: Ctx & { wantsStream: boolean },
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
    res.end(bytes);
  } else {
    const r = h.validator.validate(assistant, ctx.tools);
    toolUseCount = r.toolUseCount;
    uncheckableCount = r.uncheckableCount;
    if (r.valid) {
      validated = r.uncheckableCount > 0 ? "uncheckable" : "pass";
      res.writeHead(backendRes.status, filtered); // pass through untouched
      res.end(bytes);
    } else {
      validated = "fail";
      errorKinds = dedupe(r.errors.map((e) => e.kind));
      const decision = await repair(assistant, ctx.tools, {
        validator: h.validator,
        reshaper: h.reshaper!,
        maxAttempts: 2,
        isDestructive: h.isDestructive,
      });
      repairOutcome = decision.outcome;
      if (decision.outcome === "fixed" && decision.message) {
        emitFixed(res, backendRes.status, filtered, decision.message, ctx.wantsStream, ctx.model);
      } else {
        // fail-clean: loud, well-formed error rather than a silently broken call.
        failClosed(res, 502, `repair-proxy: tool call could not be repaired (${decision.outcome})`);
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
  filtered: Record<string, string>,
  message: AssistantMessage,
  wantsStream: boolean,
  model: string | null,
): void {
  if (wantsStream) {
    res.writeHead(status, { ...filtered, "content-type": "text/event-stream" });
    res.end(emitSse(message));
  } else {
    res.writeHead(status, { ...filtered, "content-type": "application/json" });
    res.end(JSON.stringify(toAnthropicMessage(message, model)));
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

function buildForwardHeaders(inbound: IncomingMessage["headers"], cfg: Config): Record<string, string> {
  const apiKey = cfg.backend.authEnv ? process.env[cfg.backend.authEnv]?.trim() : undefined;
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
    if (cfg.backend.authHeader === "authorization") out["authorization"] = `Bearer ${apiKey}`;
    else out["x-api-key"] = apiKey;
  }
  return out;
}

function filterResponseHeaders(hh: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  hh.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out[key] = value;
  });
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

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function failClosed(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
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
