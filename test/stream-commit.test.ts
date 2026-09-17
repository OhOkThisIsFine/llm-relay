import { describe, expect, it } from "vitest";
import {
  probeStreamForCommit,
  relayAuthoredResponse,
  STREAM_PREFLIGHT_LIMIT,
  type FrontProtocol,
  type StreamCommitProtocol,
} from "../src/stream-commit.js";

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function event(value: unknown, name?: string, newline = "\n"): string {
  const prefix = name ? `event: ${name}${newline}` : "";
  return `${prefix}data: ${JSON.stringify(value)}${newline}${newline}`;
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function expectReady(
  protocol: StreamCommitProtocol,
  chunks: readonly Uint8Array[],
): Promise<Uint8Array> {
  const result = await probeStreamForCommit(streamOf(chunks), protocol);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error(`expected ready, got ${result.kind}`);
  return collect(result.body);
}

describe("final-wire stream commit probe", () => {
  it("holds Anthropic metadata, pings, and whitespace until a real text delta", async () => {
    const raw = [
      event({ type: "message_start", message: { id: "m", content: [] } }, "message_start"),
      event({ type: "ping" }, "ping"),
      event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start"),
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "  " } }, "content_block_delta"),
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } }, "content_block_delta"),
    ].join("");

    expect(await expectReady("anthropic-messages", [bytes(raw)])).toEqual(bytes(raw));
  });

  it.each([
    { label: "thinking", frame: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "reason" } } },
    { label: "redacted thinking", frame: { type: "content_block_start", content_block: { type: "redacted_thinking", data: "opaque" } } },
    { label: "tool use", frame: { type: "content_block_start", content_block: { type: "tool_use", id: "call_1", name: "lookup", input: {} } } },
  ])("counts Anthropic $label as meaningful", async ({ frame }) => {
    await expectReady("anthropic-messages", [bytes(event(frame))]);
  });

  it.each([
    { label: "signature", delta: { type: "signature_delta", signature: "sig_abc" } },
    { label: "tool arguments", delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' } },
  ])("does not commit an Anthropic $label delta without its content block start", async ({ delta }) => {
    const result = await probeStreamForCommit(
      streamOf([bytes(event({ type: "content_block_delta", index: 0, delta }, "content_block_delta"))]),
      "anthropic-messages",
    );
    expect(result).toMatchObject({ kind: "dead", reason: "stream ended before meaningful content" });
  });

  it("fails an Anthropic in-band error before content but commits content before a later error", async () => {
    const error = event({ type: "error", error: { message: "capacity" } }, "error");
    const dead = await probeStreamForCommit(
      streamOf([bytes(event({ type: "ping" }, "ping") + error)]),
      "anthropic-messages",
    );
    expect(dead).toMatchObject({ kind: "dead", provenance: "upstream", reason: expect.stringContaining("capacity") });

    const content = event({ type: "content_block_delta", delta: { type: "text_delta", text: "yes" } }, "content_block_delta");
    const raw = content + error;
    expect(await expectReady("anthropic-messages", [bytes(raw)])).toEqual(bytes(raw));
  });

  it.each([
    { protocol: "anthropic-messages" as const, raw: event({ type: "message_stop" }, "message_stop") },
    { protocol: "openai-chat" as const, raw: "data: [DONE]\n\n" },
    { protocol: "openai-responses" as const, raw: event({ type: "response.completed", response: { status: "completed", output: [] } }, "response.completed") },
  ])("treats empty $protocol termination as a dead turn", async ({ protocol, raw }) => {
    const result = await probeStreamForCommit(streamOf([bytes(raw)]), protocol);
    expect(result).toMatchObject({ kind: "dead", reason: expect.stringContaining("without meaningful content") });
  });

  it("recognizes Chat content, refusal, reasoning aliases, and native tool-call bytes", async () => {
    const frames = [
      { choices: [{ delta: { content: "answer" } }] },
      { choices: [{ delta: { refusal: "cannot" } }] },
      { choices: [{ delta: { reasoning_content: "reason" } }] },
      { choices: [{ delta: { reasoning: "reason" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1" }] } }] },
    ];
    for (const frame of frames) await expectReady("openai-chat", [bytes(event(frame))]);
  });

  it("commits a Chat frame whose content and finish reason arrive together", async () => {
    const raw = event({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] });
    expect(await expectReady("openai-chat", [bytes(raw)])).toEqual(bytes(raw));
  });

  it("holds Chat role and usage frames and rejects finish-only completion", async () => {
    const preamble = event({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }) +
      event({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } });
    const finished = event({ choices: [{ delta: {}, finish_reason: "stop" }] });
    const result = await probeStreamForCommit(streamOf([bytes(preamble + finished)]), "openai-chat");
    expect(result).toMatchObject({ kind: "dead", reason: expect.stringContaining("without meaningful content") });
  });

  it.each([
    { label: "text", frame: { type: "response.output_text.delta", delta: "answer" } },
    { label: "refusal", frame: { type: "response.refusal.delta", delta: "cannot" } },
    { label: "reasoning", frame: { type: "response.reasoning.delta", delta: "reason" } },
    { label: "function item", frame: { type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", name: "lookup", arguments: "" } } },
    { label: "function arguments", frame: { type: "response.function_call_arguments.delta", delta: "{" } },
    { label: "completed output", frame: { type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "answer" }] }] } } },
  ])("recognizes Responses $label output", async ({ frame }) => {
    await expectReady("openai-responses", [bytes(event(frame, String(frame.type)))]);
  });

  it.each([
    { type: "response.failed" },
    { type: "response.incomplete" },
    { type: "response.cancelled" },
  ])("treats Responses $type before content as dead", async (frame) => {
    const result = await probeStreamForCommit(
      streamOf([bytes(event(frame, frame.type))]),
      "openai-responses",
    );
    expect(result).toMatchObject({ kind: "dead", provenance: "upstream" });
  });

  it("handles CRLF, multi-line data, a UTF-8 split, and replays the exact original bytes", async () => {
    const raw = ": heartbeat\r\n\r\n" +
      "data: {\"choices\":[\r\n" +
      "data: {\"delta\":{\"content\":\"héllo 🌋\"}}\r\n" +
      "data: ]}\r\n\r\n";
    const encoded = bytes(raw);
    const emoji = raw.indexOf("🌋");
    const split = bytes(raw.slice(0, emoji)).byteLength + 2; // split inside the four-byte code point
    const chunks = [encoded.subarray(0, 7), encoded.subarray(7, split), encoded.subarray(split)];

    expect(await expectReady("openai-chat", chunks)).toEqual(encoded);
  });

  it.each([
    { label: "LF", newline: "\n" },
    { label: "CRLF", newline: "\r\n" },
  ])("parses and byte-exactly replays a $label event delimiter split across chunks", async ({ newline }) => {
    const raw = event({ choices: [{ delta: { content: "answer" } }] }, undefined, newline);
    const encoded = bytes(raw);
    const secondNewlineBytes = bytes(newline).byteLength;
    const split = encoded.byteLength - secondNewlineBytes;

    expect(await expectReady("openai-chat", [encoded.subarray(0, split), encoded.subarray(split)]))
      .toEqual(encoded);
  });

  it("preserves event ordering when error and content share one transport chunk", async () => {
    const error = event({ error: { message: "nope" } });
    const content = event({ choices: [{ delta: { content: "yes" } }] });
    const before = await probeStreamForCommit(streamOf([bytes(error + content)]), "openai-chat");
    expect(before.kind).toBe("dead");

    const afterRaw = content + error;
    expect(await expectReady("openai-chat", [bytes(afterRaw)])).toEqual(bytes(afterRaw));
  });

  it("tags malformed translated wire as local", async () => {
    const result = await probeStreamForCommit(
      streamOf([bytes("data: {not-json}\n\n")]),
      "openai-responses",
      { malformedProvenance: "local" },
    );
    expect(result).toEqual({
      kind: "dead",
      reason: "stream event before meaningful content is not valid JSON",
      provenance: "local",
    });
  });

  it("enforces the 64 KiB pre-commit cap with a distinct reason", async () => {
    const raw = bytes(`: ${"x".repeat(STREAM_PREFLIGHT_LIMIT)}\n\n`);
    const result = await probeStreamForCommit(streamOf([raw]), "anthropic-messages");
    expect(result).toEqual({
      kind: "dead",
      reason: "no meaningful content within commit probe limit",
      provenance: "upstream",
    });
  });

  it("does not corrupt or commit UTF-8 content that straddles the 64 KiB cap", async () => {
    const prefix = 'data: {"choices":[{"delta":{"content":"';
    const suffix = '"}}]}\n\n';
    const padding = " ".repeat(STREAM_PREFLIGHT_LIMIT - bytes(prefix).byteLength - 2);
    const raw = bytes(`${prefix}${padding}🌋${suffix}`);

    expect(raw.subarray(STREAM_PREFLIGHT_LIMIT - 2, STREAM_PREFLIGHT_LIMIT + 2)).toEqual(bytes("🌋"));
    const result = await probeStreamForCommit(streamOf([raw]), "openai-chat");
    expect(result).toEqual({
      kind: "dead",
      reason: "no meaningful content within commit probe limit",
      provenance: "upstream",
    });
  });

  it("classifies a read failure as cancelled when the client disconnected", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("socket closed");
      },
    });
    const result = await probeStreamForCommit(body, "anthropic-messages", { isCancelled: () => true });
    expect(result).toEqual({ kind: "cancelled" });
  });
});

/**
 * CLONE-07. The rule "did the relay author these bytes" used to be spelled twice, once per front,
 * against each front's own passthrough condition. The two spellings never disagreed — the truth
 * table in `docs/history/reviews/clone-07-clone-26-evidence-2026-09-05.md` proves it over all six reachable
 * combinations — so naming it once is behaviour-preserving by construction, and this table is what
 * makes that checkable rather than asserted.
 *
 * ⚠ The value is not cosmetic. `upstream` makes a malformed final wire the PROVIDER's fault, so the
 * outcome is retriable and the walk fails over; `local` makes it terminal. Getting one row wrong
 * either strands a request the pool could have served, or rerolls the whole pool on the relay's own
 * mapper defect.
 */
describe("relayAuthoredResponse", () => {
  const ROWS: ReadonlyArray<{
    readonly targetKind: "anthropic" | "openai";
    readonly front: FrontProtocol;
    readonly expected: "upstream" | "local";
    readonly why: string;
  }> = [
    { targetKind: "anthropic", front: "anthropic-messages", expected: "upstream", why: "byte passthrough — the vendor's own shape" },
    { targetKind: "openai", front: "anthropic-messages", expected: "local", why: "translated OpenAI -> Anthropic" },
    { targetKind: "openai", front: "chat", expected: "upstream", why: "byte passthrough — the direct Chat lane" },
    { targetKind: "openai", front: "responses", expected: "local", why: "translated for the Responses front" },
    { targetKind: "anthropic", front: "chat", expected: "local", why: "translated Anthropic -> OpenAI" },
    { targetKind: "anthropic", front: "responses", expected: "local", why: "translated Anthropic -> Responses" },
  ];

  it.each(ROWS.map((row) => [`${row.targetKind}-kind target on the ${row.front} front (${row.why})`, row] as const))(
    "reports %s",
    (_name, row) => {
      expect(relayAuthoredResponse(row.targetKind, row.front)).toBe(row.expected);
    },
  );

  /**
   * The negative control, and it is what makes the table above mean something: exactly TWO of the
   * six combinations are a passthrough. A predicate that answered `local` everywhere would satisfy
   * four rows on its own, and one that answered `upstream` everywhere would satisfy two.
   */
  it("calls exactly two of the six combinations a passthrough", () => {
    const upstream = ROWS.filter((row) => relayAuthoredResponse(row.targetKind, row.front) === "upstream");
    expect(upstream.map((row) => `${row.targetKind}/${row.front}`)).toEqual([
      "anthropic/anthropic-messages",
      "openai/chat",
    ]);
  });

  /**
   * Pins the behaviour-preservation claim directly: each front's ORIGINAL expression, transcribed
   * verbatim from the code CLONE-07 replaced, must agree with the shared predicate on every row it
   * could reach. Delete this and the "no behaviour changed" claim rests on a document.
   */
  it("agrees with both original per-front spellings on every reachable row", () => {
    for (const { targetKind, front } of ROWS) {
      const shared = relayAuthoredResponse(targetKind, front);
      if (front === "anthropic-messages") {
        expect(shared).toBe(targetKind === "openai" ? "local" : "upstream");
      } else {
        expect(shared).toBe(targetKind === "openai" && front === "chat" ? "upstream" : "local");
      }
    }
  });
});
