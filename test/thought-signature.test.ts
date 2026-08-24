import { describe, it, expect } from "vitest";
import { anthropicRequestToOpenAi } from "../src/openai-request.js";

/**
 * Gemini 3.x's thought-signature rule on REPLAYED tool calls, under
 * `compat.thoughtSignature: "sentinel"`.
 *
 * FIRST-PARTY EVIDENCE (2026-08-23, `models/gemini-3.6-flash` via the OpenAI-compatible endpoint
 * at `generativelanguage.googleapis.com`): replaying an assistant `tool_calls` turn answers
 * HTTP 400 — "Function call is missing a thought_signature in functionCall parts…".
 *
 * Google's documented escape is the RAW string `skip_thought_signature_validator` at
 * `tool_calls[N].extra_content.google.thought_signature`. Verified accepted against that live
 * endpoint the same day: a single replayed call carrying it → 200 and a correct answer from the
 * tool result; BOTH entries of a parallel pair carrying it → 200 and a correct answer from both
 * results. EVERY-ENTRY is therefore the placement pinned here.
 */

const SENTINEL = "skip_thought_signature_validator";

/** One call/answer pair — the smallest conversation that replays a tool call. */
function pair(id: string) {
  return {
    model: "claude-x",
    messages: [
      { role: "user", content: "weather in Paris?" },
      { role: "assistant", content: [{ type: "tool_use", id, name: "get_weather", input: { city: "Paris" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "22C sunny" }] },
    ],
  };
}

/** Two tool calls in ONE assistant turn — the parallel case the live check covered. */
function parallelPair() {
  return {
    model: "claude-x",
    messages: [
      { role: "user", content: "weather in Paris and Berlin?" },
      { role: "assistant", content: [
        { type: "tool_use", id: "toolu_01A", name: "get_weather", input: { city: "Paris" } },
        { type: "tool_use", id: "toolu_01B", name: "get_weather", input: { city: "Berlin" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_01A", content: "22C sunny" },
        { type: "tool_result", tool_use_id: "toolu_01B", content: "15C rain" },
      ] },
    ],
  };
}

function mapped(body: unknown, mode: "none" | "sentinel" | undefined, extra: Record<string, unknown> = {}) {
  return anthropicRequestToOpenAi(body, {
    model: "m",
    ...(mode !== undefined ? { thoughtSignature: mode } : {}),
    ...extra,
  }) as { messages: Array<Record<string, any>> };
}

function assistantCalls(out: { messages: Array<Record<string, any>> }): Record<string, any>[] {
  return out.messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []);
}

describe("gemini thought-signature sentinel", () => {
  it("stamps the RAW sentinel at the exact documented path", () => {
    const call = assistantCalls(mapped(pair("toolu_01A"), "sentinel"))[0]!;
    expect(call.extra_content).toEqual({ google: { thought_signature: SENTINEL } });
    // A raw string, never base64: an encoded value is a MALFORMED signature rather than the
    // vendor's documented "there is no signature" token.
    expect(call.extra_content.google.thought_signature).toBe(SENTINEL);
    expect(typeof call.extra_content.google.thought_signature).toBe("string");
  });

  it("stamps EVERY entry of a parallel tool-call turn, the verified placement", () => {
    const calls = assistantCalls(mapped(parallelPair(), "sentinel"));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.extra_content).toEqual({ google: { thought_signature: SENTINEL } });
    }
  });

  it("stamps both assistant turns of a multi-turn conversation", () => {
    const body = {
      model: "claude-x",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_01A", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01A", content: "a" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_01B", name: "Grep", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01B", content: "b" }] },
      ],
    };
    const calls = assistantCalls(mapped(body, "sentinel"));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.extra_content).toEqual({ google: { thought_signature: SENTINEL } });
    }
  });

  it('adds NOTHING under "none" or under no mode at all — the outbound bytes are unchanged', () => {
    const body = parallelPair();
    const none = mapped(body, "none");
    const defaulted = mapped(body, undefined);
    // Byte-for-byte: not merely "no sentinel", but the same document this mapper produced before
    // the mode existed.
    expect(JSON.stringify(defaulted)).toBe(JSON.stringify(none));
    for (const call of assistantCalls(none)) {
      expect(call).not.toHaveProperty("extra_content");
      expect(Object.keys(call)).toEqual(["id", "type", "function"]);
    }
  });

  it("leaves a request with no tool calls untouched in either mode", () => {
    const body = { model: "claude-x", messages: [{ role: "user", content: "hi" }] };
    expect(JSON.stringify(mapped(body, "sentinel"))).toBe(JSON.stringify(mapped(body, "none")));
  });

  it("reports a COUNT of what it stamped", () => {
    const counts: number[] = [];
    anthropicRequestToOpenAi(parallelPair(), {
      model: "m", thoughtSignature: "sentinel", onThoughtSignatureSentinels: (n) => counts.push(n),
    });
    anthropicRequestToOpenAi({ model: "claude-x", messages: [{ role: "user", content: "hi" }] }, {
      model: "m", thoughtSignature: "sentinel", onThoughtSignatureSentinels: (n) => counts.push(n),
    });
    expect(counts).toEqual([2, 0]);
  });

  it('never reports under "none" — there is nothing to announce when nothing changed', () => {
    let called = false;
    anthropicRequestToOpenAi(pair("toolu_01A"), {
      model: "m", thoughtSignature: "none", onThoughtSignatureSentinels: () => { called = true; },
    });
    expect(called).toBe(false);
  });

  it("is ORTHOGONAL to strict9 — a provider may set both, and the two passes do not fight", () => {
    // They touch different parts of the same entry: `strict9` rewrites the `id`, the sentinel adds
    // a sibling `extra_content`. A provider declaring both must get both, unaltered.
    const out = anthropicRequestToOpenAi(pair("toolu_01AAAAAAAAAAAAAAAAAAAAAA"), {
      model: "m", toolCallIds: "strict9", thoughtSignature: "sentinel",
    }) as { messages: Array<Record<string, any>> };
    const call = assistantCalls(out)[0]!;
    const tool = out.messages.find((m) => m.role === "tool")!;

    expect(call.id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(call.id).not.toBe("toolu_01AAAAAAAAAAAAAAAAAAAAAA");
    // The pair is still linked after the rewrite…
    expect(tool.tool_call_id).toBe(call.id);
    // …and the sentinel landed on the very same entry.
    expect(call.extra_content).toEqual({ google: { thought_signature: SENTINEL } });
    // The sentinel is stamped on the entry as emitted, so it is unaffected by which id it carries.
    const sentinelOnly = assistantCalls(mapped(pair("toolu_01AAAAAAAAAAAAAAAAAAAAAA"), "sentinel"))[0]!;
    expect(sentinelOnly.extra_content).toEqual(call.extra_content);
  });

  it("counts both passes independently when both are on", () => {
    let rewrites = -1;
    let sentinels = -1;
    anthropicRequestToOpenAi(parallelPair(), {
      model: "m",
      toolCallIds: "strict9",
      thoughtSignature: "sentinel",
      onToolCallIdsRewritten: (n) => { rewrites = n; },
      onThoughtSignatureSentinels: (n) => { sentinels = n; },
    });
    expect(rewrites).toBe(2);
    expect(sentinels).toBe(2);
  });
});
