import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { anthropicRequestToOpenAi } from "../src/openai-request.js";
import { resolveReasoningMode, loadConfig, resolveTargets } from "../src/config.js";

/**
 * The Anthropic-path caller's reasoning/thinking intent, carried onto DeepSeek's own vocabulary
 * under the RESOLVED `compat.reasoning: "deepseek"` mode (defaulting from `api.deepseek.com`).
 *
 * FIRST-PARTY EVIDENCE (docs/deepseek-responses-truncation-2026-09-09.md): DeepSeek is thinking ON
 * by default; its OpenAI-format controls are `thinking: {type:"disabled"}` / `reasoning_effort:
 * low|high|max`. The same 36k-token probe showed the Anthropic path dropping `thinking:
 * {type:"disabled"}` and burning all 32,000 output tokens on reasoning — no answer. And a multi-turn
 * thinking-mode replay without the prior turn's `reasoning_content` answers HTTP 400.
 */

function mapped(body: unknown, opts: Record<string, unknown> = {}): Record<string, any> {
  return anthropicRequestToOpenAi(body, { model: "deepseek-flash", ...opts });
}

const TURN = {
  model: "claude-opus-5",
  messages: [{ role: "user", content: "hi" }],
};

describe("DeepSeek reasoning mapping", () => {
  it("forwards the caller's thinking:{type:'disabled'} verbatim under the deepseek mode", () => {
    const out = mapped({ ...TURN, thinking: { type: "disabled" } }, { reasoning: "deepseek" });
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it("maps a high-effort pool to reasoning_effort:'high' when the caller did not disable thinking", () => {
    const out = mapped(TURN, { reasoning: "deepseek", effort: "high" });
    expect(out.reasoning_effort).toBe("high");
    expect(out).not.toHaveProperty("thinking");
  });

  it("quantizes medium -> high and xhigh -> max onto DeepSeek's three levels", () => {
    expect(mapped(TURN, { reasoning: "deepseek", effort: "medium" }).reasoning_effort).toBe("high");
    expect(mapped(TURN, { reasoning: "deepseek", effort: "xhigh" }).reasoning_effort).toBe("max");
    expect(mapped(TURN, { reasoning: "deepseek", effort: "low" }).reasoning_effort).toBe("low");
  });

  it("prefers the caller's explicit output_config.effort over the pool band", () => {
    const out = mapped({ ...TURN, output_config: { effort: "max" } }, { reasoning: "deepseek", effort: "low" });
    expect(out.reasoning_effort).toBe("max");
  });

  it("maps an explicit effort of 'none' to thinking disabled", () => {
    const out = mapped({ ...TURN, output_config: { effort: "none" } }, { reasoning: "deepseek" });
    expect(out.thinking).toEqual({ type: "disabled" });
  });

  it("defaults thinking OFF when the caller sent no thinking control, so a multi-turn lane cannot hit the 400", () => {
    const out = mapped(TURN, { reasoning: "deepseek" });
    expect(out.thinking).toEqual({ type: "disabled" });
  });

  it("leaves thinking:enabled alone when there is no level to map (never switches off an explicit ask)", () => {
    const out = mapped({ ...TURN, thinking: { type: "enabled", budget_tokens: 8000 } }, { reasoning: "deepseek" });
    expect(out).not.toHaveProperty("reasoning_effort");
    expect(out).not.toHaveProperty("thinking");
  });

  it("never adds the fields under the default mode — the pre-existing bytes are unchanged", () => {
    const body = { ...TURN, thinking: { type: "disabled" } };
    expect(JSON.stringify(mapped(body))).toBe(JSON.stringify(mapped(body, { reasoning: "none" })));
    expect(mapped(body)).not.toHaveProperty("thinking");
    expect(mapped(body)).not.toHaveProperty("reasoning_effort");
  });

  it("ignores the pool effort under the default mode", () => {
    const out = mapped(TURN, { effort: "high" });
    expect(out).not.toHaveProperty("reasoning_effort");
    expect(out).not.toHaveProperty("thinking");
  });
});

/**
 * F10 — a FORCED tool choice must win over thinking, whatever left thinking on. Reproduces the
 * relay's own refusal store: `deepseek|deepseek-v4-pro|400|thinking mode does not support this
 * tool_choice`, 15 times, all under an MCP answer-mode `tool_choice: {type:"tool", name:"answer"}`
 * plus a routed pool effort band (rule 3 of `deepSeekThinkingSpec`, which fires before rule 5 and
 * therefore leaves thinking ON for nearly all pool traffic — see that function's doc comment).
 *
 * F11 — a replayed assistant tool-call turn with no reasoning to carry forward must ALSO force
 * thinking off, and when reasoning IS available it must ride the outbound `reasoning_content`
 * byte for byte, never fabricated.
 */
describe("DeepSeek thinking override (F10 forced tool choice, F11 reasoning replay)", () => {
  const TOOLS = [{ name: "answer", input_schema: { type: "object", properties: {} } }];
  /** The exact shape `runAnswerFetch` in `src/mcp/server.ts` posts for MCP answer mode + schema. */
  const FORCED_TOOL_CHOICE = { type: "tool", name: "answer" };

  function withToolCallTurn(reasoningBlock: Record<string, unknown> | null): Record<string, unknown> {
    const assistantContent: Record<string, unknown>[] = [];
    if (reasoningBlock) assistantContent.push(reasoningBlock);
    assistantContent.push({ type: "tool_use", id: "call_1", name: "do_thing", input: {} });
    return {
      model: "claude-opus-5",
      messages: [
        { role: "user", content: "do it" },
        { role: "assistant", content: assistantContent },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }] },
      ],
    };
  }

  it("F10: forces thinking off for a named-function tool_choice even though the pool effort would enable reasoning_effort", () => {
    let overridden = -1;
    const out = mapped(
      { ...TURN, tools: TOOLS, tool_choice: FORCED_TOOL_CHOICE },
      { reasoning: "deepseek", effort: "high", onDeepSeekThinkingOverridden: (n: number) => { overridden = n; } },
    );
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out).not.toHaveProperty("reasoning_effort");
    expect(out.tool_choice).toEqual({ type: "function", function: { name: "answer" } });
    expect(overridden).toBe(1);
  });

  it("F10: forces thinking off for Anthropic's 'any' tool_choice (mapped to OpenAI's required)", () => {
    const out = mapped(
      { ...TURN, tools: TOOLS, tool_choice: { type: "any" } },
      { reasoning: "deepseek", effort: "xhigh" },
    );
    expect(out.tool_choice).toBe("required");
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it("F10: the callback reports 0 when the natural spec was already disabled — that is not an override", () => {
    let overridden = -1;
    const out = mapped(
      { ...TURN, tools: TOOLS, tool_choice: FORCED_TOOL_CHOICE, thinking: { type: "disabled" } },
      { reasoning: "deepseek", effort: "high", onDeepSeekThinkingOverridden: (n: number) => { overridden = n; } },
    );
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(overridden).toBe(0);
  });

  it("F10: a forced tool choice under the default mode leaves tool_choice mapped and adds nothing else", () => {
    const out = mapped({ ...TURN, tools: TOOLS, tool_choice: FORCED_TOOL_CHOICE });
    expect(out.tool_choice).toEqual({ type: "function", function: { name: "answer" } });
    expect(out).not.toHaveProperty("thinking");
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it("F11: carries a replayed thinking block's own text onto that turn's reasoning_content, byte for byte", () => {
    let overridden = -1;
    const out = mapped(
      withToolCallTurn({ type: "thinking", thinking: "because the file needs a read first" }),
      { reasoning: "deepseek", effort: "high", onDeepSeekThinkingOverridden: (n: number) => { overridden = n; } },
    );
    const assistantMsg = (out.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    expect(assistantMsg?.reasoning_content).toBe("because the file needs a read first");
    // Replay was available, so nothing was overridden — the natural rule-3 spec stands.
    expect(out.reasoning_effort).toBe("high");
    expect(out).not.toHaveProperty("thinking");
    expect(overridden).toBe(0);
  });

  it("F11: forces thinking off when a replayed tool-call turn carries no reasoning at all, with no forced tool_choice on this request", () => {
    let overridden = -1;
    const out = mapped(
      withToolCallTurn(null),
      { reasoning: "deepseek", effort: "high", onDeepSeekThinkingOverridden: (n: number) => { overridden = n; } },
    );
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out).not.toHaveProperty("reasoning_effort");
    expect(overridden).toBe(1);
    const assistantMsg = (out.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    // Never fabricated: absent, not "".
    expect(assistantMsg).not.toHaveProperty("reasoning_content");
  });

  it("F11: a redacted_thinking block counts as NOT available to replay (opaque to every other vendor)", () => {
    const out = mapped(
      withToolCallTurn({ type: "redacted_thinking", data: "opaque-anthropic-blob" }),
      { reasoning: "deepseek", effort: "high" },
    );
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out).not.toHaveProperty("reasoning_effort");
    const assistantMsg = (out.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    expect(assistantMsg).not.toHaveProperty("reasoning_content");
  });

  it("F11: a tool-call turn with an EMPTY thinking block is also unavailable to replay — never a fabricated \"\"", () => {
    const out = mapped(withToolCallTurn({ type: "thinking", thinking: "" }), { reasoning: "deepseek", effort: "high" });
    expect(out.thinking).toEqual({ type: "disabled" });
  });

  it("negative control: a replayed thinking block under the default mode is dropped exactly as before — no other provider's bytes move", () => {
    const body = withToolCallTurn({ type: "thinking", thinking: "some reasoning" });
    const withDefault = mapped(body);
    const withNone = mapped(body, { reasoning: "none" });
    expect(JSON.stringify(withDefault)).toBe(JSON.stringify(withNone));
    const assistantMsg = (withDefault.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    expect(assistantMsg).not.toHaveProperty("reasoning_content");
    expect(withDefault).not.toHaveProperty("thinking");
  });
});

describe("resolveReasoningMode", () => {
  it("defaults to deepseek on api.deepseek.com and none everywhere else", () => {
    expect(resolveReasoningMode({ base: "https://api.deepseek.com/v1" })).toBe("deepseek");
    expect(resolveReasoningMode({ base: "https://api.openai.com/v1" })).toBe("none");
    expect(resolveReasoningMode({ base: "https://api.mistral.ai/v1" })).toBe("none");
  });

  it("an explicit compat.reasoning wins in both directions", () => {
    expect(resolveReasoningMode({ base: "https://api.deepseek.com/v1", compat: { reasoning: "none" } })).toBe("none");
    expect(resolveReasoningMode({ base: "https://api.openai.com/v1", compat: { reasoning: "deepseek" } })).toBe("deepseek");
  });
});

describe("resolveTargets effort stamping", () => {
  it("stamps the routed dynamic pool's effort band onto a deepseek target", () => {
    const dir = mkdtempSync(join(tmpdir(), "ds-effort-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, JSON.stringify({
        listen: "127.0.0.1:8791",
        providers: { deepseek: { base: "https://api.deepseek.com/v1", kind: "openai" } },
        routing: {
          default: "pool/high",
          pools: {
            high: { preferred: ["deepseek/deepseek-flash"], include: "free", effort: "high" },
          },
        },
      }));
      const cfg = loadConfig(path);
      const targets = resolveTargets("pool/high", cfg);
      expect(targets.length).toBeGreaterThan(0);
      for (const t of targets) {
        expect(t.effort).toBe("high");
        expect(t.reasoning).toBe("deepseek");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves effort absent for a directly addressed spec (no pool to map)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ds-direct-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, JSON.stringify({
        listen: "127.0.0.1:8791",
        providers: { deepseek: { base: "https://api.deepseek.com/v1", kind: "openai" } },
        routing: { default: "deepseek/deepseek-flash" },
      }));
      const cfg = loadConfig(path);
      const targets = resolveTargets("deepseek/deepseek-flash", cfg);
      expect(targets[0]?.effort).toBeUndefined();
      expect(targets[0]?.reasoning).toBe("deepseek");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
