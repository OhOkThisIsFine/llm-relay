import { describe, it, expect } from "vitest";
import { anthropicRequestToOpenAi } from "../src/openai-request.js";

/**
 * Outbound tool-call ids under `compat.toolCallIds: "strict9"`.
 *
 * FIRST-PARTY EVIDENCE (2026-08-23, `mistral-medium-2505`): forwarding the caller's own id
 * verbatim answers HTTP 400
 *   {"object":"error","message":"Tool call id was toolu_01AAAAAAAAAAAAAAAAAAAAAA but must be
 *    a-z, A-Z, 0-9, with a length of 9.","type":"invalid_function_call","code":"3280"}
 * `mistral-common` enforces `^[a-zA-Z0-9]{9}$` on BOTH the assistant `tool_calls[].id` and the
 * answering tool message's `tool_call_id`, and from v13 also linkage and uniqueness.
 *
 * Every id shape that actually reaches this mapper violates it, so each one is pinned below.
 */

const STRICT9 = /^[a-zA-Z0-9]{9}$/;

/** One call/answer pair, the smallest conversation that exercises both halves of the rule. */
function pair(id: string) {
  return {
    model: "claude-x",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    ],
  };
}

function mapped(body: unknown, mode: "preserve" | "strict9" | undefined) {
  return anthropicRequestToOpenAi(body, {
    model: "m",
    ...(mode !== undefined ? { toolCallIds: mode } : {}),
  }) as { messages: Array<Record<string, any>> };
}

describe("strict9 outbound tool-call ids", () => {
  const REAL_SHAPES = [
    ["Anthropic", "toolu_01AAAAAAAAAAAAAAAAAAAAAA"],
    ["nim kimi-k3", "Read:0"],
    ["relay-minted", "Read:0_relay1"],
    ["Codex via the Responses front", "call_abc123"],
    ["dialect rescue", "tu_recovered_0"],
  ] as const;

  for (const [origin, id] of REAL_SHAPES) {
    it(`rewrites a ${origin} id (${id}) to mistral's stated shape on BOTH halves of the pair`, () => {
      const out = mapped(pair(id), "strict9");
      const assistant = out.messages.find((m) => m.role === "assistant")!;
      const tool = out.messages.find((m) => m.role === "tool")!;

      expect(assistant.tool_calls[0].id).toMatch(STRICT9);
      // The linkage IS the id: a rewrite that moved only one half would detach the result from
      // the call it answers, which mistral-common v13 rejects outright.
      expect(tool.tool_call_id).toBe(assistant.tool_calls[0].id);
      expect(assistant.tool_calls[0].id).not.toBe(id);
    });
  }

  it("leaves an already-conforming id alone, so a mistral-native id round-trips", () => {
    const out = mapped(pair("aB3xY9z01"), "strict9");
    const assistant = out.messages.find((m) => m.role === "assistant")!;
    expect(assistant.tool_calls[0].id).toBe("aB3xY9z01");
    expect(out.messages.find((m) => m.role === "tool")!.tool_call_id).toBe("aB3xY9z01");
  });

  it("never collapses two distinct source ids onto one outbound id", () => {
    const body = {
      model: "claude-x",
      messages: [
        { role: "assistant", content: [
          { type: "tool_use", id: "toolu_01A", name: "Grep", input: {} },
          { type: "tool_use", id: "toolu_01B", name: "Read", input: {} },
          { type: "tool_use", id: "Read:0", name: "Read", input: {} },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_01A", content: "a" },
          { type: "tool_result", tool_use_id: "toolu_01B", content: "b" },
          { type: "tool_result", tool_use_id: "Read:0", content: "c" },
        ] },
      ],
    };
    const out = mapped(body, "strict9");
    const ids = out.messages.find((m) => m.role === "assistant")!.tool_calls.map((c: any) => c.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(STRICT9);
    expect(out.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(ids);
  });

  it("is DETERMINISTIC — the same conversation maps to the same ids every time", () => {
    // No randomness, the `tool-use-ids.ts` precedent: a conversation only appends, so the id a
    // `tool_result` answers must still be the id its call was given one turn (or one failover
    // candidate, or one retry) earlier.
    const first = mapped(pair("toolu_01A"), "strict9");
    const second = mapped(pair("toolu_01A"), "strict9");
    expect(second).toEqual(first);
  });

  it("still stamps the gemini functionResponse name, which is keyed by the ORIGINAL id", () => {
    const out = mapped(pair("toolu_01A"), "strict9");
    expect(out.messages.find((m) => m.role === "tool")!.name).toBe("Read");
  });

  it('leaves the outbound bytes IDENTICAL under "preserve" and under no mode at all', () => {
    const body = pair("toolu_01A");
    const preserved = mapped(body, "preserve");
    const defaulted = mapped(body, undefined);
    expect(defaulted).toEqual(preserved);
    expect(preserved.messages.find((m) => m.role === "assistant")!.tool_calls[0].id).toBe("toolu_01A");
    expect(preserved.messages.find((m) => m.role === "tool")!.tool_call_id).toBe("toolu_01A");
  });

  it("reports a COUNT of what it rewrote, and 0 when the ids already conformed", () => {
    const counts: number[] = [];
    anthropicRequestToOpenAi(pair("toolu_01A"), {
      model: "m", toolCallIds: "strict9", onToolCallIdsRewritten: (n) => counts.push(n),
    });
    anthropicRequestToOpenAi(pair("aB3xY9z01"), {
      model: "m", toolCallIds: "strict9", onToolCallIdsRewritten: (n) => counts.push(n),
    });
    // One SOURCE id, rewritten once — the answering tool message reuses the same mapping rather
    // than counting a second time.
    expect(counts).toEqual([1, 0]);
  });

  it('never reports under "preserve" — there is nothing to announce when nothing changed', () => {
    let called = false;
    anthropicRequestToOpenAi(pair("toolu_01A"), {
      model: "m", toolCallIds: "preserve", onToolCallIdsRewritten: () => { called = true; },
    });
    expect(called).toBe(false);
  });

  it("maps an ORPHAN tool_result too, so its id is legal even with no call to answer", () => {
    // The name is withheld (no matching `tool_use`), but the id shape is the provider's rule and
    // applies regardless — an orphan carrying `toolu_…` is the same 400.
    const out = mapped({
      model: "claude-x",
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_orphan", content: "x" }] }],
    }, "strict9");
    const tool = out.messages.find((m) => m.role === "tool")!;
    expect(tool.tool_call_id).toMatch(STRICT9);
    expect(tool).not.toHaveProperty("name");
  });
});
