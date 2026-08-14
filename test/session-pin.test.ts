import { describe, expect, it } from "vitest";
import {
  deriveSessionKey,
  StickySessionManager,
  type SessionPin,
} from "../src/session-pin.js";

describe("deriveSessionKey — evidence-bounded key sources", () => {
  it("uses the relay-owned header and compounds the verified Claude agent id", () => {
    expect(deriveSessionKey({
      "X-LLM-Relay-Session": " session-1 ",
      "x-claude-code-agent-id": " agent-child ",
    }, { messages: [{ role: "user", content: "ignored" }] })).toBe("hdr:session-1::agent-child");
  });

  it("does not accept the design's unverified client session headers", () => {
    const body = { messages: [{ role: "user", content: "verified fallback" }] };
    const expected = deriveSessionKey({}, body);
    expect(deriveSessionKey({
      "x-claude-code-session-id": "dead-rung",
      "x-session-id": "dead-rung",
      "x-codex-turn-metadata": JSON.stringify({ session_id: "dead-rung" }),
    }, body)).toBe(expected);
    expect(expected).toMatch(/^msg:[0-9a-f]{16}$/);
  });

  it("hashes the first user text consistently across Anthropic, Chat, and Responses shapes", () => {
    const anthropic = deriveSessionKey({}, {
      messages: [{ role: "user", content: [
        { type: "text", text: "<system-reminder>injected</system-reminder>" },
        { type: "text", text: "same prompt" },
      ] }],
    });
    const chat = deriveSessionKey({}, {
      messages: [{ role: "user", content: " same prompt " }, { role: "assistant", content: "later" }],
    });
    const responses = deriveSessionKey({}, {
      input: [{ role: "user", content: [{ type: "input_text", text: "same prompt" }] }],
    });
    expect(anthropic).toBe(chat);
    expect(responses).toBe(chat);
  });

  it("creates no key when the first user turn has no text", () => {
    expect(deriveSessionKey({}, {
      messages: [{ role: "user", content: [{ type: "image", source: { data: "abc" } }] }],
    })).toBeNull();
    expect(deriveSessionKey({}, { input: [] })).toBeNull();
  });
});

describe("StickySessionManager — sliding TTL and bounded LRU", () => {
  it("refreshes on access and expires after the inactivity TTL", () => {
    const manager = new StickySessionManager({ ttlMs: 1000, maxSessions: 10 });
    manager.setPin("hdr:a", "p1/m1", 1000);
    expect(manager.getPin("hdr:a", 1900)).toBe("p1/m1");
    expect(manager.getPin("hdr:a", 2800)).toBe("p1/m1");
    expect(manager.getPin("hdr:a", 3801)).toBeNull();
  });

  it("keeps the ten most recently used entries at its configured cap", () => {
    const manager = new StickySessionManager({ ttlMs: 10_000, maxSessions: 10 });
    for (let index = 0; index < 10; index++) manager.setPin(`hdr:${index}`, `p/m${index}`, index);
    expect(manager.getPin("hdr:0", 100)).toBe("p/m0");
    manager.setPin("hdr:10", "p/m10", 101);

    expect(manager.getPin("hdr:1", 102)).toBeNull();
    expect(manager.getPin("hdr:0", 102)).toBe("p/m0");
    expect(pinMap(manager).size).toBe(10);
  });

  it("stores only a 16-hex hash key and pin metadata, never prompt text", () => {
    const fragment = "private-prompt-fragment";
    const prompt = `${fragment}:${"x".repeat(500_000)}`;
    const key = deriveSessionKey({}, { messages: [{ role: "user", content: prompt }] });
    expect(key).toMatch(/^msg:[0-9a-f]{16}$/);

    const manager = new StickySessionManager();
    manager.setPin(key!, "p2/m2", 1234);
    const serialized = JSON.stringify([...pinMap(manager)]);
    expect(serialized).not.toContain(fragment);
    expect([...pinMap(manager)]).toEqual([[key, {
      targetSpec: "p2/m2",
      pinnedAt: 1234,
      lastUsedAt: 1234,
      useCount: 1,
    }]]);
    expect(Object.keys([...pinMap(manager).values()][0]!)).toEqual([
      "targetSpec",
      "pinnedAt",
      "lastUsedAt",
      "useCount",
    ]);
  });
});

function pinMap(manager: StickySessionManager): Map<string, SessionPin> {
  return (manager as unknown as { pins: Map<string, SessionPin> }).pins;
}
