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
