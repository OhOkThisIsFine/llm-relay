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
