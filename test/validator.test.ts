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

  it("fails closed when a declared tool has no schema", () => {
    const schemaLess = toolSchemaMap({ tools: [{ name: "built_in" }] });
    const r = v.validate(
      msg([{ type: "tool_use", id: "t1", name: "built_in", input: {} }], "tool_use"),
      schemaLess,
    );
    expect(r.valid).toBe(false);
    expect(r.uncheckableCount).toBe(1);
    expect(r.errors.map((error) => error.kind)).toContain("schema_uncheckable");
  });

  it("fails closed when a declared schema cannot compile", () => {
    const uncompilable = toolSchemaMap({
      tools: [{ name: "broken", input_schema: { type: "definitely-not-a-json-schema-type" } }],
    });
    const r = v.validate(
      msg([{ type: "tool_use", id: "t1", name: "broken", input: {} }], "tool_use"),
      uncompilable,
    );
    expect(r.valid).toBe(false);
    expect(r.uncheckableCount).toBe(1);
    expect(r.errors.map((error) => error.kind)).toContain("schema_uncheckable");
  });
});
