import { describe, it, expect } from "vitest";
import { reconstructFromSse } from "../src/sse.js";
import { isToolUseBlock } from "../src/anthropic.js";

function sse(events: object[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

describe("reconstructFromSse", () => {
  it("reassembles a tool_use from input_json_delta fragments", () => {
    const raw = sse([
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "get_weather", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"ci' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'ty":"Paris"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ]);
    const m = reconstructFromSse(raw);
    expect(m.stop_reason).toBe("tool_use");
    const tu = m.content.find(isToolUseBlock);
    expect(tu?.name).toBe("get_weather");
    expect(tu?.input).toEqual({ city: "Paris" });
  });

  it("reassembles streamed text", () => {
    const raw = sse([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ]);
    const m = reconstructFromSse(raw);
    expect(m.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(m.stop_reason).toBe("end_turn");
  });

  it("captures the backend's own message id, model and usage off message_start", () => {
    const raw = sse([
      { type: "message_start", message: { id: "msg_01BackendReal", model: "z-ai/glm-5.2", usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
    ]);
    const m = reconstructFromSse(raw);
    // Without these the repaired response can only be re-emitted under an invented id.
    expect(m.id).toBe("msg_01BackendReal");
    expect(m.model).toBe("z-ai/glm-5.2");
    expect(m.usage).toEqual({ input_tokens: 5, output_tokens: 9 });
  });

  it("leaves usage ABSENT when the stream never reported any", () => {
    const raw = sse([
      { type: "message_start", message: { id: "m1" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ]);
    const m = reconstructFromSse(raw);
    // undefined, not {input_tokens:0, output_tokens:0}: "not reported" is not "cost nothing".
    expect(m.usage).toBeUndefined();
  });

  it("keeps a streamed thinking block's text AND signature instead of dropping both", () => {
    const raw = sse([
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "step one, " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "step two" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ]);
    const m = reconstructFromSse(raw);
    // Both delta kinds were unhandled, so the whole block collapsed to `{ type: "thinking" }`.
    expect(m.content).toEqual([{ type: "thinking", thinking: "step one, step two", signature: "sig-abc" }]);
  });

  it("keeps the fields an opaque content_block_start carries", () => {
    const raw = sse([
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "EncryptedBlob==" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ]);
    expect(reconstructFromSse(raw).content).toEqual([{ type: "redacted_thinking", data: "EncryptedBlob==" }]);
  });

  it("surfaces malformed streamed tool JSON as a raw string (so the validator can flag it)", () => {
    const raw = sse([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "get_weather", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ]);
    const m = reconstructFromSse(raw);
    const tu = m.content.find(isToolUseBlock);
    expect(typeof tu?.input).toBe("string"); // incomplete JSON -> raw string, not silently {}
  });
});
