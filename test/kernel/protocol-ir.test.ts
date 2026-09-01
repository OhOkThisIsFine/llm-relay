import { describe, it, expect } from "vitest";
import {
  isNormalizedTextBlock,
  isNormalizedToolUseBlock,
  isNormalizedToolResultBlock,
  type NormalizedLlmRequest,
  type NormalizedLlmResponse,
} from "../../src/kernel/protocol-ir.js";

describe("Protocol IR types and guards", () => {
  it("correctly identifies text blocks", () => {
    const textBlock = { type: "text" as const, text: "hello" };
    expect(isNormalizedTextBlock(textBlock)).toBe(true);
    expect(isNormalizedToolUseBlock(textBlock)).toBe(false);
  });

  it("correctly identifies tool_use blocks", () => {
    const toolUseBlock = {
      type: "tool_use" as const,
      id: "call_123",
      name: "bash",
      input: { command: "ls" },
    };
    expect(isNormalizedToolUseBlock(toolUseBlock)).toBe(true);
    expect(isNormalizedToolResultBlock(toolUseBlock)).toBe(false);
  });

  it("correctly identifies tool_result blocks", () => {
    const resultBlock = {
      type: "tool_result" as const,
      toolUseId: "call_123",
      content: "file1.txt\nfile2.txt",
    };
    expect(isNormalizedToolResultBlock(resultBlock)).toBe(true);
    expect(isNormalizedTextBlock(resultBlock)).toBe(false);
  });

  it("instantiates a complete NormalizedLlmRequest and NormalizedLlmResponse", () => {
    const req: NormalizedLlmRequest = {
      model: "gpt-4o",
      system: ["You are a helpful assistant."],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello!" }],
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Fetch weather for city",
          inputSchema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      temperature: 0.7,
      maxTokens: 4096,
    };
    expect(req.messages).toHaveLength(1);

    const res: NormalizedLlmResponse = {
      id: "msg_abc",
      model: "claude-3-7-sonnet",
      role: "assistant",
      content: [{ type: "text", text: "Hello from Claude!" }],
      stopReason: "end_turn",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
      },
    };
    expect(res.usage.inputTokens).toBe(10);
  });
});
