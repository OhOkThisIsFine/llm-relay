import { describe, expect, it } from "vitest";
import {
  MAX_THINK_HELD_BYTES,
  MAX_THINK_LEAD_BYTES,
  stripOpeningThinkTag,
  stripThinkTagsInStream,
} from "../src/think-tags.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out + decoder.decode();
    out += decoder.decode(value, { stream: true });
  }
}

const event = (type: string, data: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const textDelta = (text: string) =>
  event("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
const OPEN_STREAM =
  event("message_start", { message: { id: "msg_1", type: "message", role: "assistant", content: [] } }) +
  event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
const CLOSE_STREAM =
  event("content_block_stop", { index: 0 }) +
  event("message_delta", { delta: { stop_reason: "end_turn" } }) +
  event("message_stop", {});

function emittedText(sse: string): string {
  let text = "";
  for (const match of sse.matchAll(/^data: (.+)$/gm)) {
    const data = JSON.parse(match[1]!) as { delta?: { type?: string; text?: string } };
    if (data.delta?.type === "text_delta" && typeof data.delta.text === "string") text += data.delta.text;
  }
  return text;
}

describe("message-opening think-tag strip", () => {
  it("strips one complete opening block in a buffered message", () => {
    expect(stripOpeningThinkTag("<think>private reasoning</think>Answer")).toBe("Answer");
  });

  it("strips with leading whitespace but leaves a second block later in the message untouched", () => {
    expect(stripOpeningThinkTag(" \n<think>first</think>Answer <think>quoted later</think>"))
      .toBe("Answer <think>quoted later</think>");
  });

  it("treats a marker after answer text as mid-message and passes it through losslessly", () => {
    const text = "Answer first; <think>this is quoted</think>";
    expect(stripOpeningThinkTag(text)).toBe(text);
  });

  it("a lead longer than 512 bytes disables stripping and flushes losslessly", () => {
    const text = `${" ".repeat(MAX_THINK_LEAD_BYTES + 1)}<think>reasoning</think>Answer`;
    expect(stripOpeningThinkTag(text)).toBe(text);
  });

  it("an unclosed or nested block is doubtful and therefore lossless", () => {
    const unclosed = "<think>reasoning cut off";
    const nested = "<think>outer <think>inner</think>Answer";
    expect(stripOpeningThinkTag(unclosed)).toBe(unclosed);
    expect(stripOpeningThinkTag(nested)).toBe(nested);
  });

  it("caps the rollback buffer and passes an oversized block through losslessly", () => {
    const text = `<think>${"x".repeat(MAX_THINK_HELD_BYTES)}</think>Answer`;
    expect(stripOpeningThinkTag(text)).toBe(text);
  });

  it("strips a streamed block when the close marker is split across deltas and byte chunks", async () => {
    const source = [
      OPEN_STREAM,
      textDelta("<think>hidden</thi"),
      textDelta("nk>Answer"),
      CLOSE_STREAM,
    ].join("");
    const chunks = [source.slice(0, 73), source.slice(73, 181), source.slice(181)];
    const out = await collect(stripThinkTagsInStream(streamOf(chunks)));

    expect(emittedText(out)).toBe("Answer");
    expect(out).not.toContain("hidden");
    expect(out).toContain("event: message_stop");
  });

  it("flushes an unclosed streamed block before content_block_stop without losing text", async () => {
    const source = OPEN_STREAM + textDelta("<think>unfinished") + CLOSE_STREAM;
    const out = await collect(stripThinkTagsInStream(streamOf([source])));

    expect(emittedText(out)).toBe("<think>unfinished");
    expect(out.indexOf("<think>unfinished")).toBeLessThan(out.indexOf("event: content_block_stop"));
  });

  /**
   * ⚠ The error tail had NO coverage before P1-04 moved it into `createSseTransformStream`:
   * deleting the whole `catch` block left every other test in this file green. It carries this
   * module's losslessness guarantee, so it is pinned rather than trusted — the same uncovered-tail
   * class the Phase 1a accounting-schema extraction found.
   *
   * A broken upstream is also an UNCLOSED think tag. The held text must therefore reach the client
   * BEFORE the error frame, or a transport failure silently deletes content the model produced.
   */
  it("releases held text before it reports a broken upstream", async () => {
    const encoder = new TextEncoder();
    const source = OPEN_STREAM + textDelta("<think>unfinished");
    let sent = false;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode(source));
          return;
        }
        controller.error(new Error("socket reset"));
      },
    });

    const out = await collect(stripThinkTagsInStream(broken));

    expect(emittedText(out)).toBe("<think>unfinished");
    expect(out).toContain("llm-relay: stream failed: socket reset");
    expect(out.indexOf("<think>unfinished")).toBeLessThan(out.indexOf("event: error"));
  });
});
