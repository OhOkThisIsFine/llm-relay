import { describe, it, expect } from "vitest";
import { getModelMetadata, estimateRequestTokens } from "../src/metadata.js";

describe("metadata", () => {
  it("looks up context window limits for models", () => {
    const meta = getModelMetadata("claude-3-7-sonnet");
    expect(meta.contextLength).toBe(200000);
    expect(meta.supportsThinking).toBe(true);
  });

  it("estimates request token count accurately", () => {
    const req = {
      system: "You are a helpful coding assistant.",
      messages: [
        { role: "user", content: "Hello, world!" },
        { role: "assistant", content: "Hi there! How can I help you write code today?" },
      ],
    };
    const tokens = estimateRequestTokens(req);
    expect(tokens).toBeGreaterThan(15);
    expect(tokens).toBeLessThan(50);
  });
});
