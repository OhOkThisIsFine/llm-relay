import { describe, expect, it } from "vitest";
import { recoverDialectInStream } from "../src/dialect-stream.js";
import { scanForMarker } from "../src/tool-dialects.js";
import { fetchBackend } from "../src/backend.js";
import type { ResolvedTarget } from "../src/config.js";
import { resolveAttempt } from "../src/resolved-attempt.js";

const schemas = new Map([
  ["write_note", { type: "object", properties: { path: { type: "string" }, count: { type: "number" } } }],
]);

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

async function collect(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const textDelta = (text: string) => ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });

const OPEN =
  ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [] } }) +
  ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
const CLOSE = ev("content_block_stop", { index: 0 }) + ev("message_delta", { delta: { stop_reason: "end_turn" } }) + ev("message_stop", {});

describe("streaming dialect recovery", () => {
  it("recovers an envelope split across deltas into a real tool_use block", async () => {
    // The case the buffered fix could not reach: the envelope arrives in pieces over SSE.
    const out = await collect(recoverDialectInStream(streamOf([
      OPEN,
      textDelta("I'll write the note."),
      textDelta("<｜DSML｜tool_calls><｜DSML｜invoke name=\"write_"),
      textDelta("note\"><｜DSML｜parameter name=\"path\">a.txt</｜DSML｜parameter>"),
      textDelta("<｜DSML｜parameter name=\"count\">42</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>"),
      CLOSE,
    ]), schemas));

    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"write_note"');
    expect(out).toContain('a.txt');
    expect(out).toContain('"stop_reason":"tool_use"');
    // The prose before the envelope still streamed.
    expect(out).toContain("I'll write the note.");
    // ⚠ No fragment of the envelope reaches the client as text.
    expect(out).not.toContain("DSML");
  });

  it("fails clean mid-stream on a TRUNCATED envelope instead of releasing the fragment", async () => {
    // The measured 70-byte body. There is no call to recover, and handing back the tail is what
    // made this read as "the job died" — so it becomes an SSE error and the pool fails over.
    const out = await collect(recoverDialectInStream(streamOf([
      OPEN,
      textDelta("</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>"),
      CLOSE,
    ]), schemas));

    expect(out).toContain("event: error");
    expect(out).toContain("unparseable dsml tool-call envelope");
    expect(out).not.toContain('"type":"tool_use"');
  });

  it("passes ordinary prose through untouched, including text containing '<'", async () => {
    // ⚠ The regression guard: a bounded holdback must not turn every response with a '<' into a
    // buffered one, and must not corrupt the text.
    const out = await collect(recoverDialectInStream(streamOf([
      OPEN,
      textDelta("Use <b>bold</b> and compare a < b."),
      CLOSE,
    ]), schemas));

    const text = [...out.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
    expect(text).toContain("Use <b>bold</b> and compare a < b.");
    expect(out).toContain("event: message_stop");
    expect(out).not.toContain("event: error");
  });

  it("settles a stream that ends without message_stop", async () => {
    // A truncated upstream must not strand the withheld envelope silently.
    const out = await collect(recoverDialectInStream(streamOf([
      OPEN,
      textDelta("<tool_call>{\"name\":\"write_note\",\"arguments\":{\"path\":\"a.txt\"}}</tool_call>"),
    ]), schemas));
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"stop_reason":"tool_use"');
  });
});

describe("marker scanning", () => {
  it("holds back a viable marker prefix and releases it once it cannot become one", () => {
    // Mid-marker: nothing after the prefix start is safe to emit yet.
    const partial = scanForMarker("hello <tool_c");
    expect(partial.hit).toBe(false);
    expect(partial.safeLen).toBe("hello ".length);

    // Resolved into something that is not a marker: fully safe.
    const resolved = scanForMarker("hello <tool_cat> bye");
    expect(resolved.hit).toBe(false);
    expect(resolved.safeLen).toBe("hello <tool_cat> bye".length);

    expect(scanForMarker("x<tool_call>").hit).toBe(true);
  });
});

/**
 * CONTRACT: an unrecognised JSON envelope in model TEXT stays text.
 *
 * Ported from REPRO 2 of the 2026-08-23 leak investigation. The relay used to teach every
 * openai-kind backend a bogus tool-call notation by stringifying llm-bridge's universal IR into
 * the outbound prompt (fixed in `src/openai-request.ts`); models echoed the notation back, and
 * this is what the client then received. The ids in the real samples were the MODEL's own
 * (`"Grep:0"`, uuids) — never `toolu_*` — which is how the echo was told apart from a serializer.
 *
 * ⚠ The fix for that is on the REQUEST side, and this test exists so nobody is tempted to "also"
 * fix it on the response side by adding a JSON marker to `DIALECT_MARKERS`. An arbitrary JSON
 * object is not a closed envelope; promoting one to a `tool_use` would be fabricating intent,
 * which is the one thing `src/tool-dialects.ts` must never do. Text in, text out.
 */
describe("unrecognised JSON envelope in model text", () => {
  const ECHOED = JSON.stringify({
    _original: { provider: "anthropic", raw: { type: "tool_use", id: "Grep:0", name: "Grep", input: { pattern: "x" } } },
    tool_call: { arguments: { pattern: "x" }, id: "Grep:0", metadata: { input: { pattern: "x" } }, name: "Grep" },
    type: "tool_call",
  });

  it("is streamed to the client as text and never promoted to a tool_use", async () => {
    const out = await collect(recoverDialectInStream(streamOf([
      OPEN,
      textDelta(ECHOED.slice(0, 40)),
      textDelta(ECHOED.slice(40)),
      CLOSE,
    ]), schemas));

    expect(out).not.toContain('"type":"tool_use"');
    expect(out).not.toContain("event: error");
    expect(out).toContain('"stop_reason":"end_turn"');
    const text = [...out.matchAll(/"text_delta","text":("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]!) as string).join("");
    expect(text).toBe(ECHOED);
  });

  it("reaches the Anthropic front byte-exact through the translated openai stream", async () => {
    // The full path REPRO 2 measured: openai-kind SSE -> llm-bridge response translation ->
    // think-tag strip -> dialect recovery (tools ARE declared, so the scanner really runs).
    const chunk = (content: string) =>
      `data: ${JSON.stringify({ id: "c", model: "m", choices: [{ index: 0, delta: { content } }] })}\n\n`;
    const sse =
      `data: ${JSON.stringify({ id: "c", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n` +
      chunk(ECHOED.slice(0, 40)) +
      chunk(ECHOED.slice(40)) +
      `data: ${JSON.stringify({ id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
      "data: [DONE]\n\n";

    const target: ResolvedTarget = {
      provider: "nim", base: "https://backend.test", kind: "openai", model: "m",
      authHeader: "authorization", timeoutMs: 5000, authEnv: "RP_BACKEND_KEY",
    };
    const reqJson = {
      model: "claude-x", max_tokens: 64, stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "write_note", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    };
    const res = await fetchBackend(resolveAttempt(target), {
      path: "/v1/messages", method: "POST",
      reqBuf: Buffer.from(JSON.stringify(reqJson)), reqJson,
      anthropicHeaders: {}, wantsStream: true, signal: AbortSignal.timeout(5000),
    }, async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const out = await res.text();

    expect(res.status).toBe(200);                                    // no protocol failure, no failover
    expect(out).toContain("text_delta");                             // it is TEXT to the client
    expect(out).not.toContain('"content_block":{"type":"tool_use"'); // never promoted to a tool call
    expect(out).toContain('"stop_reason":"end_turn"');
    const text = [...out.matchAll(/"text_delta","text":("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]!) as string).join("");
    expect(text).toBe(ECHOED);
  });
});
