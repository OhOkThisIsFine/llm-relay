import { describe, it, expect } from "vitest";
import { openaiResponsesRequestToAnthropic } from "../src/responses-request.js";
import { anthropicRequestToOpenAi } from "../src/openai-request.js";

/**
 * F11 — the Responses-front half. A Codex `reasoning` item has no Anthropic representation and was
 * dropped unconditionally (docs/history/deepseek-responses-truncation-2026-09-09.md, finding 3: the third
 * capture run ended at HTTP 400 "The `reasoning_content` in the thinking mode must be passed back
 * to the API" after 1-2 tool-call turns). Under the RESOLVED `reasoning: "deepseek"` option, the
 * item's own stated `summary` text is now carried onto a LEADING `thinking` block on the current
 * assistant turn — byte for byte, never fabricated — so `openai-request.ts`'s `assistantMessage`
 * can carry it onward as DeepSeek's `reasoning_content` when this intermediate is fed to an
 * `openai`-kind target (see `fetchTranslatedOpenAiFront` in `src/backend.ts`).
 */
describe("Responses reasoning item -> Anthropic thinking block (F11)", () => {
  function bodyWithReasoning(summary: Array<Record<string, unknown>> | undefined): unknown {
    return {
      model: "irrelevant",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ...(summary !== undefined ? [{ type: "reasoning", id: "rs_1", summary }] : [{ type: "reasoning", id: "rs_1" }]),
        { type: "function_call", call_id: "call_1", name: "do_thing", arguments: "{}" },
      ],
    };
  }

  function assistantTurn(out: Record<string, unknown>): Record<string, unknown> | undefined {
    return (out.messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant");
  }

  it("under 'deepseek' mode, carries the reasoning item's summary text onto a leading thinking block", () => {
    const out = openaiResponsesRequestToAnthropic(
      bodyWithReasoning([{ type: "summary_text", text: "checking the file first" }]),
      { reasoning: "deepseek" },
    );
    const turn = assistantTurn(out);
    const content = turn?.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "thinking", thinking: "checking the file first" });
    // Leading: the thinking block precedes the tool_use it explains, whatever the arrival order.
    expect(content[1]).toMatchObject({ type: "tool_use", id: "call_1", name: "do_thing" });
  });

  it("joins multiple summary_text parts with a blank line, byte for byte, never inventing a separator scheme", () => {
    const out = openaiResponsesRequestToAnthropic(
      bodyWithReasoning([
        { type: "summary_text", text: "first, list the files" },
        { type: "summary_text", text: "then read package.json" },
      ]),
      { reasoning: "deepseek" },
    );
    const turn = assistantTurn(out);
    const content = turn?.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "thinking", thinking: "first, list the files\n\nthen read package.json" });
  });

  it("never fabricates a thinking block when the item has no summary text (the common case for Codex today)", () => {
    const noSummaryArray = openaiResponsesRequestToAnthropic(bodyWithReasoning([]), { reasoning: "deepseek" });
    const noSummaryField = openaiResponsesRequestToAnthropic(bodyWithReasoning(undefined), { reasoning: "deepseek" });
    for (const out of [noSummaryArray, noSummaryField]) {
      const turn = assistantTurn(out);
      const content = turn?.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(1);
      expect(content[0]).toMatchObject({ type: "tool_use" });
    }
  });

  it("ignores encrypted_content — an opaque blob for a different vendor's decoder, never forwarded as reasoning", () => {
    const out = openaiResponsesRequestToAnthropic(
      {
        model: "irrelevant",
        input: [
          { type: "reasoning", id: "rs_1", encrypted_content: "opaque-openai-blob", summary: [] },
          { type: "function_call", call_id: "call_1", name: "do_thing", arguments: "{}" },
        ],
      },
      { reasoning: "deepseek" },
    );
    const turn = assistantTurn(out);
    const content = turn?.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "tool_use" });
  });

  it("negative control: under the default mode (opts omitted), a reasoning item is dropped exactly as before this option existed", () => {
    const withOpts = openaiResponsesRequestToAnthropic(
      bodyWithReasoning([{ type: "summary_text", text: "should never appear" }]),
      { reasoning: "none" },
    );
    const withoutOpts = openaiResponsesRequestToAnthropic(
      bodyWithReasoning([{ type: "summary_text", text: "should never appear" }]),
    );
    expect(JSON.stringify(withOpts)).toBe(JSON.stringify(withoutOpts));
    const turn = assistantTurn(withoutOpts);
    const content = turn?.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "tool_use" });
  });

  it("composes end to end: the carried thinking block becomes reasoning_content once mapped onward for an openai-kind target", () => {
    const anthropicShaped = openaiResponsesRequestToAnthropic(
      bodyWithReasoning([{ type: "summary_text", text: "reading the manifest" }]),
      { reasoning: "deepseek" },
    );
    // `fetchTranslatedOpenAiFront` in src/backend.ts feeds this straight into `fetchBackend`,
    // which for an openai-kind target maps it through `anthropicRequestToOpenAi` with the SAME
    // resolved `reasoning` mode. `max_tokens` isn't required by this mapper.
    const openaiShaped = anthropicRequestToOpenAi(anthropicShaped, { model: "deepseek-flash", reasoning: "deepseek" });
    const assistantMsg = (openaiShaped.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    expect(assistantMsg?.reasoning_content).toBe("reading the manifest");
  });
});
