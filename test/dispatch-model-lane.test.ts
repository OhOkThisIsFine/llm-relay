/**
 * The dispatch-view half of two 2026-09-10 fixes (`docs/dispatch-giveup-diagnosis-2026-09-10.md` §9):
 *
 * - F5: `dispatch` can name a MODEL. Until then it could only name a ladder rung, so an agent that
 *   had to use DeepSeek wrote its own HTTP calls to the relay (§7). `buildDispatch` now builds ONE
 *   ad-hoc relay lane for a named routing spec, validated against the configured providers and pools.
 * - F3: a pass-through rung — one that forwards the caller's own Anthropic credential — is
 *   `unreachable` for the MCP server, which holds no such credential. It ran 0 of 21 times from there,
 *   and as the last lane its 0-second failure ended every walk that ran out of lanes.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import { buildDispatch, mcpPassThroughReason } from "../src/dispatch.js";

const dir = mkdtempSync(join(tmpdir(), "llm-relay-model-lane-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** ESC, built at run time: a raw control character in a source file is invisible to a reader. */
const ESC = String.fromCharCode(27);

function cfg(): Config {
  const path = join(dir, `c-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      listen: "127.0.0.1:8791",
      providers: {
        anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" },
        deepseek: { base: "https://api.deepseek.com/v1", kind: "openai", authEnv: "LLM_RELAY_TEST_UNSET_DEEPSEEK_KEY" },
      },
      routing: {
        default: "anthropic",
        pools: { high: ["deepseek/deepseek-flash"] },
        cliLane: { command: "claude", args: ["-p", "{task}", "--model", "{spec}"] },
        ladder: [
          { id: "anthropic", kind: "relay", spec: "anthropic" },
          { id: "free-pool", kind: "relay", spec: "pool/high" },
        ],
      },
    }),
  );
  return loadConfig(path);
}

describe("dispatch can name a model (F5)", () => {
  it("a caller-named model is ONE ad-hoc relay lane, appended past the ladder", () => {
    const view = buildDispatch(cfg(), { model: "deepseek/deepseek-flash" });
    expect(view.order).toEqual(["model:deepseek/deepseek-flash"]);
    expect(view.next).toMatchObject({
      id: "model:deepseek/deepseek-flash",
      kind: "relay",
      spec: "deepseek/deepseek-flash",
      adHoc: true,
      position: 3,
      state: "ready",
    });
    expect(view.reason).toBe('model "deepseek/deepseek-flash" named by the caller');
    // The configured ladder is untouched and still listed, in config order.
    expect(view.ladder.map((l) => l.id)).toEqual(["anthropic", "free-pool", "model:deepseek/deepseek-flash"]);
  });

  it("on a host that cannot address it as a subagent, agent mode reaches it through routing.cliLane", () => {
    const view = buildDispatch(cfg(), { model: "deepseek/deepseek-flash", host: "bypassed", task: "summarise" }, "linux");
    expect(view.next?.transposed).toBe(true);
    expect(view.next?.invoke?.command).toBe("claude");
    expect(view.next?.invoke?.args).toEqual(["-p", "summarise", "--model", "deepseek/deepseek-flash"]);
  });

  it("a pool spec and the reserved auto model are accepted", () => {
    expect(buildDispatch(cfg(), { model: "pool/high" }).next?.spec).toBe("pool/high");
    expect(buildDispatch(cfg(), { model: "auto" }).next?.spec).toBe("auto");
  });

  it("an unknown provider or pool yields no lane, and the reason names what exists", () => {
    const provider = buildDispatch(cfg(), { model: "nosuch/some-model" });
    expect(provider.next).toBeNull();
    expect(provider.order).toEqual([]);
    expect(provider.reason).toBe(
      'model "nosuch/some-model" names no configured provider or pool (providers: anthropic, deepseek)',
    );
    const pool = buildDispatch(cfg(), { model: "pool/nosuch" });
    expect(pool.next).toBeNull();
    expect(pool.reason).toBe('no pool "pool/nosuch" configured (have: pool/high)');
  });

  it("⚠ a prototype key is not a provider — `constructor` names nothing configured", () => {
    const view = buildDispatch(cfg(), { model: "constructor/x" });
    expect(view.next).toBeNull();
    expect(view.reason).toContain("names no configured provider or pool");
  });

  it("a spec holding whitespace or control characters is refused, and never echoed raw", () => {
    for (const bad of ["deepseek/a b", `deepseek/${ESC}[31mred`]) {
      const view = buildDispatch(cfg(), { model: bad });
      expect(view.next, bad).toBeNull();
      expect(view.reason, bad).toContain("is not a routing spec");
      expect(view.reason, bad).not.toContain(ESC);
    }
  });

  it("lane and model together are refused — they name two different targets", () => {
    const view = buildDispatch(cfg(), { model: "deepseek/deepseek-flash", lane: "free-pool" });
    expect(view.next).toBeNull();
    expect(view.order).toEqual([]);
    expect(view.reason).toContain("pass lane or model, not both");
  });

  it("an over-long model reads as absent, like any option that cannot be parsed — the ordinary ladder view", () => {
    const view = buildDispatch(cfg(), { model: `deepseek/${"x".repeat(300)}` });
    expect(view.next?.id).toBe("anthropic");
    expect(view.next?.adHoc).toBeUndefined();
  });
});

describe("a pass-through rung is unreachable for the MCP server (F3)", () => {
  it("requester mcp: the rung carries the true reason and is absent from the order", () => {
    const view = buildDispatch(cfg(), { requester: "mcp", host: "bypassed" });
    const anthropic = view.ladder.find((l) => l.id === "anthropic");
    expect(anthropic?.unreachable).toBe(mcpPassThroughReason("anthropic"));
    expect(view.order).not.toContain("anthropic");
    expect(view.next?.id).toBe("free-pool");
  });

  it("negative control: any other caller sees the rung exactly as before", () => {
    const view = buildDispatch(cfg(), { host: "bypassed" });
    expect(view.ladder.find((l) => l.id === "anthropic")?.unreachable).toBeUndefined();
    expect(view.next?.id).toBe("anthropic");
  });

  it("a named pass-through MODEL reaches the MCP server as unreachable, with the reason", () => {
    const view = buildDispatch(cfg(), { requester: "mcp", model: "anthropic" });
    expect(view.next?.unreachable).toBe(mcpPassThroughReason("anthropic"));
    expect(view.reason).toContain(mcpPassThroughReason("anthropic"));
  });
});
