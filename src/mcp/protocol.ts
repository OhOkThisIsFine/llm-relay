/**
 * JSON-RPC 2.0 over stdio — the MCP wire, hand-rolled.
 *
 * WHY hand-rolled. The alternative is an SDK, and this repository already hand-rolls the protocols
 * it speaks rather than importing one: `sse-frames.ts`, `openai-request.ts` and
 * `responses-request.ts` all exist for the same reason. The surface actually needed here is four
 * methods (`initialize`, `tools/list`, `tools/call`, `ping`) plus one notification, over
 * newline-delimited JSON. An SDK would be a fourth runtime dependency for that.
 *
 * ⚠ The known cost, stated so it is not rediscovered: hand-rolling means owning a spec that moves.
 * The mitigation is that this file implements only the stable core. Extensions (Tasks, Apps,
 * sampling) are deliberately absent — see `docs/mcp-dispatch-prior-art-2026-08-30.md` §3.1, which
 * measured that no client ships Tasks support today.
 *
 * TRANSPORT. MCP stdio framing is one JSON message per line. A message therefore must not contain
 * a raw newline, which `JSON.stringify` guarantees (it escapes them inside strings).
 *
 * ⚠ NOTHING may be written to stdout except protocol messages. A stray `console.log` corrupts the
 * stream and the client drops the connection with no useful error. Diagnostics go to stderr, which
 * is why `logStderr` exists rather than a bare console call.
 */

/** A request carries an id and expects exactly one response. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

/** A notification carries no id and must NEVER be answered — answering one is a protocol error. */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

/** The JSON-RPC 2.0 reserved codes this server can raise. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/**
 * Protocol revisions this server can speak, newest first.
 *
 * Negotiation rule, from the MCP specification: echo the client's requested revision when it is
 * one we support, otherwise answer with our newest and let the client decide. Never list a
 * revision we do not implement — that claims a capability we do not have, which is the
 * closed-vocabulary defect this repository documents eight times.
 *
 * ⚠ **`2026-07-28` is deliberately ABSENT, and the reason is measured.** That revision adds
 * `server/discover`, which this server does not implement. Listing it was the first live-wiring
 * failure: Claude Code 2.1.237 sends `initialize` with `protocolVersion: "2025-11-25"`, which was
 * not on this list, so the fallback answered `2026-07-28` — a revision the client had already
 * declined — and the client refused the connection with *"Server's protocol version is not
 * supported: 2026-07-28"*. Captured from the real handshake, not inferred.
 *
 * ⚠ The lesson generalises past the one entry: a fallback to "our newest" is only safe when every
 * listed revision is one we genuinely serve. Add a revision here when its CORE (`initialize`,
 * `tools/list`, `tools/call`, `ping`) is what we implement — never because it is newer.
 *
 * ⚠ A `server/discover` probe still arrives from a 2026-07-28-aware client BEFORE `initialize`.
 * Answering it `-32601` is correct and the client falls back on its own; that path is verified.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export function negotiateProtocolVersion(requested: unknown): ProtocolVersion {
  const fallback = SUPPORTED_PROTOCOL_VERSIONS[0];
  if (typeof requested !== "string") return fallback;
  const match = SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === requested);
  return match ?? fallback;
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["jsonrpc"] !== "2.0") return false;
  if (typeof v["method"] !== "string") return false;
  const id = v["id"];
  return typeof id === "string" || typeof id === "number";
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["jsonrpc"] !== "2.0") return false;
  if (typeof v["method"] !== "string") return false;
  return v["id"] === undefined;
}

/**
 * Split a byte stream into complete newline-delimited messages.
 *
 * Returns the parsed lines plus whatever tail had no terminator yet, so the caller can carry it
 * into the next chunk. A blank line is skipped rather than reported as a parse error: some clients
 * pad the stream, and a hard failure there would drop a healthy connection.
 *
 * ⚠ Handles CRLF as well as LF. The same mixed-terminator rule `sse-frames.ts` records — a Windows
 * client writing `\r\n` must not leave a stray `\r` glued to the JSON, which would fail the parse.
 */
export function splitMessages(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== "\n") continue;
    let end = i;
    if (end > start && buffer[end - 1] === "\r") end -= 1;
    const line = buffer.slice(start, end);
    if (line.trim().length > 0) lines.push(line);
    start = i + 1;
  }
  return { lines, rest: buffer.slice(start) };
}

/** Serialize one message for the wire. The trailing newline IS the frame terminator. */
export function encodeMessage(message: JsonRpcResponse | JsonRpcNotification): string {
  return JSON.stringify(message) + "\n";
}

export function errorResponse(id: string | number, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export function resultResponse(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/** Diagnostics channel. stdout belongs to the protocol; see the header warning. */
export function logStderr(message: string): void {
  process.stderr.write(`[llm-relay mcp] ${message}\n`);
}
