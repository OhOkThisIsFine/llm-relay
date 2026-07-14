import { describe, it, expect } from "vitest";
import { emitSse } from "../src/emitSse.js";
import { reconstructFromSse } from "../src/sse.js";
import { isToolUseBlock, type AssistantMessage } from "../src/anthropic.js";

describe("emitSse ↔ reconstructFromSse round-trip", () => {
  it("re-emits text + tool_use that reconstructs to the same message", () => {
    const msg: AssistantMessage = {
      content: [
        { type: "text", text: "on it" },
        { type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } },
      ],
      stop_reason: "tool_use",
    };
    const round = reconstructFromSse(emitSse(msg));
    expect(round.stop_reason).toBe("tool_use");
    expect(round.content.find((b) => b.type === "text")).toEqual({ type: "text", text: "on it" });
    const tu = round.content.find(isToolUseBlock);
    expect(tu?.name).toBe("get_weather");
    expect(tu?.input).toEqual({ city: "Paris" });
  });

  it("produces a well-formed SSE frame sequence", () => {
    const sse = emitSse({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
    expect(sse).toContain("event: message_start");
    expect(sse).toContain("event: content_block_start");
    expect(sse).toContain("event: message_delta");
    expect(sse.trimEnd().endsWith("}")).toBe(true);
    expect(sse).toContain('event: message_stop');
  });
});
