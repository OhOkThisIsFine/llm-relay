import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { DEFAULT_ANTHROPIC_VERSION, type Config } from "./config.js";
import { MetadataLogger, type RequestLog } from "./log.js";
import { ToolUseValidator, type ValidationResult } from "./validator.js";
import { reconstructFromSse } from "./sse.js";
import { toolSchemaMap, type AssistantMessage } from "./anthropic.js";

/** Response/request headers the proxy must not copy through verbatim. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length", // recomputed by us / node
  "content-encoding", // fetch already decoded the body
  "host",
]);
/** Inbound auth headers stripped ONLY when a replacement key is injected. */
const INBOUND_AUTH = ["authorization", "x-api-key"];
/** Cap on bytes accumulated for validation, to bound memory on huge streams. */
const MAX_VALIDATE_BYTES = 8 * 1024 * 1024;

export function createProxy(cfg: Config) {
  const validator = new ToolUseValidator();
  const logger = new MetadataLogger(cfg.log);

  return createServer((req, res) => {
    handle(req, res, cfg, validator, logger).catch((e) => {
      failClosed(res, 502, `repair-proxy internal error: ${(e as Error).message}`);
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: Config,
  validator: ToolUseValidator,
  logger: MetadataLogger,
): Promise<void> {
  const started = Date.now();
  const path = req.url ?? "/";
  const reqBuf = await readBody(req);

  // Parse request body only to extract tools[]/model/stream. On any parse failure
  // we still forward byte-for-byte; we just skip validation.
  let reqJson: unknown;
  try {
    reqJson = reqBuf.length ? JSON.parse(reqBuf.toString("utf8")) : undefined;
  } catch {
    reqJson = undefined;
  }
  const tools = toolSchemaMap(reqJson);
  const hadTools = tools.size > 0;
  const model = pickString(reqJson, "model");
  const isMessages = req.method === "POST" && path.startsWith("/v1/messages");

  const backendUrl = cfg.backend.base + path;
  const headers = buildForwardHeaders(req.headers, cfg);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.backend.timeoutMs);

  let backendRes: Response;
  try {
    const init: RequestInit = { method: req.method ?? "POST", headers, signal: controller.signal };
    if (reqBuf.length) init.body = reqBuf;
    backendRes = await fetch(backendUrl, init);
  } catch (e) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted;
    failClosed(res, aborted ? 504 : 502, aborted ? "backend timed out" : `backend unreachable: ${(e as Error).message}`);
    logger.write(baseLog(started, path, model, hadTools, false, aborted ? 504 : 502, "skipped"));
    return;
  }

  const ct = backendRes.headers.get("content-type") ?? "";
  const streamed = ct.includes("text/event-stream");
  res.writeHead(backendRes.status, filterResponseHeaders(backendRes.headers));

  // Only adjudicate tool-bearing /v1/messages successes; everything else is a
  // transparent forward.
  const willValidate = isMessages && hadTools && backendRes.status < 400;

  let assistant: AssistantMessage | null = null;

  try {
    if (!backendRes.body) {
      res.end();
    } else if (streamed) {
      // Tee: forward bytes unchanged (honoring client backpressure) while
      // accumulating a bounded copy for reconstruction.
      const decoder = new TextDecoder();
      let acc = "";
      let overflow = false;
      for await (const chunk of backendRes.body as unknown as AsyncIterable<Uint8Array>) {
        const buf = Buffer.from(chunk);
        if (!res.write(buf)) await once(res, "drain");
        if (willValidate && !overflow) {
          acc += decoder.decode(chunk, { stream: true });
          if (acc.length > MAX_VALIDATE_BYTES) overflow = true;
        }
      }
      res.end();
      if (willValidate && !overflow) {
        acc += decoder.decode();
        assistant = reconstructFromSse(acc);
      }
    } else {
      // Buffered: forward RAW bytes (no UTF-8 round-trip), decode a copy only for
      // validation.
      const bytes = Buffer.from(await backendRes.arrayBuffer());
      res.end(bytes);
      if (willValidate && bytes.length <= MAX_VALIDATE_BYTES) {
        assistant = parseAssistant(bytes.toString("utf8"));
      }
    }
  } finally {
    clearTimeout(timer);
  }

  // detect mode (M1): validate + log, never alter the forwarded response.
  let validated: RequestLog["validated"] = "skipped";
  let result: ValidationResult | null = null;
  if (willValidate && assistant) {
    result = validator.validate(assistant, tools);
    validated =
      result.errors.length > 0 ? "fail" : result.uncheckableCount > 0 ? "uncheckable" : "pass";
  }

  logger.write({
    ...baseLog(started, path, model, hadTools, streamed, backendRes.status, validated),
    toolUseCount: result?.toolUseCount ?? 0,
    uncheckableCount: result?.uncheckableCount ?? 0,
    errorKinds: result ? dedupe(result.errors.map((e) => e.kind)) : [],
  });
}

function buildForwardHeaders(
  inbound: IncomingMessage["headers"],
  cfg: Config,
): Record<string, string> {
  const apiKey = cfg.backend.authEnv ? process.env[cfg.backend.authEnv]?.trim() : undefined;
  // Strip the client's inbound auth ONLY when we will inject a backend key; with
  // no key configured we pass the caller's auth through (spec §9/§12).
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
    // Inject into exactly one header (avoid sending an API key as an OAuth bearer
    // alongside x-api-key, which strict backends reject).
    if (cfg.backend.authHeader === "authorization") {
      out["authorization"] = `Bearer ${apiKey}`;
    } else {
      out["x-api-key"] = apiKey;
    }
  }
  return out;
}

function filterResponseHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
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
  const body = JSON.stringify({ type: "error", error: { type: "api_error", message } });
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function baseLog(
  started: number,
  path: string,
  model: string | null,
  hadTools: boolean,
  streamed: boolean,
  backendStatus: number,
  validated: RequestLog["validated"],
): RequestLog {
  return {
    ts: new Date(started).toISOString(),
    path,
    backendModel: model,
    hadTools,
    streamed,
    backendStatus,
    validated,
    toolUseCount: 0,
    uncheckableCount: 0,
    errorKinds: [],
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

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
