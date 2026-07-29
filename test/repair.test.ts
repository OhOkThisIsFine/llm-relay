import { describe, it, expect } from "vitest";
import { repair, destructiveMatcher } from "../src/repair.js";
import { ToolUseValidator } from "../src/validator.js";
import { toolSchemaMap, type AssistantMessage } from "../src/anthropic.js";
import { ReshaperTransportError, type Reshaper, type ReshapeResult } from "../src/reshaper.js";

const validator = new ToolUseValidator();
const tools = toolSchemaMap({
  tools: [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
});
const badCall: AssistantMessage = {
  content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }],
  stop_reason: "tool_use",
};
const fixedMsg: AssistantMessage = {
  content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }],
  stop_reason: "tool_use",
};
const reshaperOf = (r: ReshapeResult): Reshaper => ({ reshape: async () => r });

describe("repair orchestration", () => {
  const noDestruct = () => false;

  it("returns fixed when the reshaper produces a valid message", async () => {
    const d = await repair(badCall, tools, { validator, reshaper: reshaperOf({ kind: "message", message: fixedMsg }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("fixed");
    expect(d.message).toEqual(fixedMsg);
  });

  it("returns refused when the reshaper declines", async () => {
    const d = await repair(badCall, tools, { validator, reshaper: reshaperOf({ kind: "refuse", reason: "ambiguous" }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("refused");
  });

  it("returns failed when the reshaper keeps producing invalid output", async () => {
    const d = await repair(badCall, tools, { validator, reshaper: reshaperOf({ kind: "message", message: badCall }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("failed");
  });

  it("returns failed (fail-clean, no crash) when the reshaper dies at the transport level", async () => {
    const dead: Reshaper = { reshape: async () => { throw new ReshaperTransportError("connection refused"); } };
    const d = await repair(badCall, tools, { validator, reshaper: dead, maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("failed");
  });

  it("refuses to reshape a destructive tool call (never fabricates it)", async () => {
    const dtools = toolSchemaMap({ tools: [{ name: "delete_file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] });
    const destrCall: AssistantMessage = { content: [{ type: "tool_use", id: "t1", name: "delete_file", input: {} }], stop_reason: "tool_use" };
    let reshaperCalled = false;
    const spy: Reshaper = { reshape: async () => { reshaperCalled = true; return { kind: "message", message: destrCall }; } };
    const d = await repair(destrCall, dtools, { validator, reshaper: spy, maxAttempts: 2, isDestructive: destructiveMatcher(["delete_file"]) });
    expect(d.outcome).toBe("refused_destructive");
    expect(reshaperCalled).toBe(false); // never even asked to reshape it
  });
});
