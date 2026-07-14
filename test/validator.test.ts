import { describe, it, expect } from "vitest";
import { ToolUseValidator } from "../src/validator.js";
import { toolSchemaMap, type AssistantMessage } from "../src/anthropic.js";

const tools = toolSchemaMap({
  tools: [
    {
      name: "get_weather",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
});

function msg(content: AssistantMessage["content"], stop_reason: AssistantMessage["stop_reason"]): AssistantMessage {
  return { content, stop_reason };
}

describe("ToolUseValidator", () => {
  const v = new ToolUseValidator();

  it("passes a well-formed tool_use with correct stop_reason", () => {
    const r = v.validate(
      msg([{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }], "tool_use"),
      tools,
    );
    expect(r.valid).toBe(true);
    expect(r.toolUseCount).toBe(1);
  });

  it("flags an unknown/hallucinated tool", () => {
    const r = v.validate(
      msg([{ type: "tool_use", id: "t1", name: "nope", input: {} }], "tool_use"),
      tools,
    );
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.kind)).toContain("unknown_tool");
  });

  it("flags a missing required field (empty args)", () => {
    const r = v.validate(
      msg([{ type: "tool_use", id: "t1", name: "get_weather", input: {} }], "tool_use"),
      tools,
    );
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.kind)).toContain("schema_violation");
  });

  it("flags input that is not a JSON object", () => {
    const r = v.validate(
      msg([{ type: "tool_use", id: "t1", name: "get_weather", input: "{bad" }], "tool_use"),
      tools,
    );
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.kind)).toContain("input_not_object");
  });

  it("flags stop_reason mismatch (tool_use block but end_turn)", () => {
    const r = v.validate(
      msg([{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }], "end_turn"),
      tools,
    );
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.kind)).toContain("stop_reason_mismatch");
  });

  it("passes a plain text response with no tools", () => {
    const r = v.validate(msg([{ type: "text", text: "hello" }], "end_turn"), tools);
    expect(r.valid).toBe(true);
    expect(r.toolUseCount).toBe(0);
  });
});
