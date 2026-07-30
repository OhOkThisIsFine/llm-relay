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

  it("carries the backend's id, model and usage through the round trip", () => {
    const msg: AssistantMessage = {
      id: "msg_01BackendReal",
      model: "z-ai/glm-5.2",
      content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 41, output_tokens: 17 },
    };
    const round = reconstructFromSse(emitSse(msg));
    // The whole point: a repaired response is still THIS response. `msg_repair` was emitted
    // for every repair, so the client's transcript disagreed with the provider's.
    expect(round.id).toBe("msg_01BackendReal");
    expect(round.model).toBe("z-ai/glm-5.2");
    expect(round.usage).toEqual({ input_tokens: 41, output_tokens: 17 });
  });

  it("synthesizes a UNIQUE id when the message carries none, never a constant", () => {
    const msg: AssistantMessage = { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" };
    const a = reconstructFromSse(emitSse(msg)).id;
    const b = reconstructFromSse(emitSse(msg)).id;
    expect(a).toMatch(/^msg_relay_[0-9a-f]{32}$/); // marked as relay-minted, not a provider id
    expect(a).not.toBe(b);
    expect(a).not.toBe("msg_repair");
  });

  it("omits usage rather than claiming zero tokens when the backend reported none", () => {
    const sse = emitSse({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
    const delta = JSON.parse(
      sse.split("\n").find((l) => l.startsWith("data:") && l.includes('"message_delta"'))!.slice(5),
    ) as { usage?: unknown };
    expect(delta.usage).toBeUndefined();
    // ...and it round-trips as "unknown", not as a measured zero.
    expect(reconstructFromSse(sse).usage?.output_tokens).toBeUndefined();
  });

  it("re-emits a thinking block whole, signature included", () => {
    const msg: AssistantMessage = {
      content: [
        { type: "thinking", thinking: "weighing it up", signature: "sig-abc" },
        { type: "text", text: "done" },
      ],
      stop_reason: "end_turn",
    };
    // A thinking block without its signature cannot be replayed to Anthropic next turn.
    expect(reconstructFromSse(emitSse(msg)).content).toEqual(msg.content);
  });
});
