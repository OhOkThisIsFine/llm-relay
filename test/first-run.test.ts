/**
 * The fresh-install contract: what the shipped template routes, and the question it leaves open.
 *
 * Before this landed, `DEFAULT_CONFIG_TEMPLATE` declared NO anthropic provider and set
 * `routing.default: "pool/medium"`, so on a clean HOME a `claude-opus-5` request resolved to a
 * free pool — and with no free keys yet, to nothing at all. Meanwhile README.md promised "Claude
 * traffic keeps your own credentials and reaches real Anthropic untouched", QUICKSTART.md said
 * "At this point everything still goes to Anthropic", and skills/llm-relay/SKILL.md said a Claude
 * model id reaches the Anthropic passthrough. All three were false for a stranger following
 * README plus `llm-relay onboard`, which docs/project-goals.md makes an explicit goal.
 *
 * The safe default is now the one where nothing changes until the operator asks — and because
 * "nothing changes" is the wrong FINAL state for a traffic router, a first-run marker records
 * that the question has never been put.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG_TEMPLATE_FOR_TEST, FIRST_RUN_MARKER, firstRunPending, clearFirstRun } from "../src/cli.js";
import { loadConfig, resolveTargets } from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-relay-first-run-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Load the shipped template exactly as a first run writes it. */
function loadTemplate(): ReturnType<typeof loadConfig> {
  const path = join(dir, "config.json");
  writeFileSync(path, DEFAULT_CONFIG_TEMPLATE_FOR_TEST, "utf8");
  return loadConfig(path);
}

describe("the shipped default config matches the shipped docs", () => {
  it("routes every Claude tier to the Anthropic passthrough, not to a free pool", () => {
    const cfg = loadTemplate();
    expect(cfg.routing.default).toBe("anthropic");
    expect(cfg.routing.tiers).toEqual({
      opus: "anthropic",
      fable: "anthropic",
      sonnet: "anthropic",
      haiku: "anthropic",
    });
  });

  /**
   * The decisive check, and the one the old template failed: with NO provider keys set — a
   * stranger's very first minute — a Claude model id must still resolve to the passthrough.
   * It used to resolve to `[]`, because the free pools were empty and no anthropic provider
   * existed to fall back to.
   */
  it("resolves a Claude model id with no provider keys configured at all", () => {
    const cfg = loadTemplate();
    const targets = resolveTargets("claude-opus-5", cfg);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets[0]!.provider).toBe("anthropic");
    // Passthrough: no key of its own, and it says so rather than leaving it to omission.
    expect(cfg.providers["anthropic"]!.authEnv).toBeUndefined();
    expect(cfg.providers["anthropic"]!.credentialMode).toBe("passthrough");
  });

  it("still ships the free pools and the offload switches, all off", () => {
    const cfg = loadTemplate();
    expect(Object.keys(cfg.routing.poolPolicies ?? {}).sort()).toEqual(["high", "low", "medium", "xhigh"]);
    const offload = cfg.routing.offload;
    expect(typeof offload).toBe("object");
    for (const rule of Object.values(offload as Record<string, { enabled: boolean }>)) {
      expect(rule.enabled).toBe(false);
    }
    // The destination map is present, so turning offload on is one command and not two.
    expect(cfg.routing.subagents?.["default"]).toBe("pool/medium");
  });
});

describe("the first-run marker", () => {
  it("reports pending only while the marker exists, and clearing is idempotent", () => {
    expect(firstRunPending(dir)).toBe(false);
    writeFileSync(join(dir, FIRST_RUN_MARKER), "2026-08-28T00:00:00.000Z\n", "utf8");
    expect(firstRunPending(dir)).toBe(true);

    expect(clearFirstRun(dir)).toBe(true);
    expect(firstRunPending(dir)).toBe(false);
    // Clearing again is not an error — an agent may not know whether it already answered.
    expect(clearFirstRun(dir)).toBe(false);
    expect(existsSync(join(dir, FIRST_RUN_MARKER))).toBe(false);
  });

  it("treats an unreadable directory as no question pending, never as an error", () => {
    expect(firstRunPending(join(dir, "does", "not", "exist"))).toBe(false);
    expect(clearFirstRun(join(dir, "does", "not", "exist"))).toBe(false);
  });
});

describe("the template stays parseable and self-consistent", () => {
  it("loads without warnings about its own routing", () => {
    const cfg = loadTemplate();
    // Provider `${ENV}` gaps are expected on a clean machine (no keys yet) and degrade per
    // provider. What must NOT appear is a warning about routing naming something unresolvable.
    const routingWarnings = (cfg.warnings ?? []).filter((w) => /routing|tier|subagent|pool/i.test(w));
    expect(routingWarnings).toEqual([]);
  });

  it("is valid JSON with the documented top-level shape", () => {
    const parsed = JSON.parse(DEFAULT_CONFIG_TEMPLATE_FOR_TEST) as Record<string, unknown>;
    expect(parsed["listen"]).toBe("127.0.0.1:8791");
    expect(parsed["mode"]).toBe("repair");
    expect(Object.keys(parsed["providers"] as object)).toContain("anthropic");
  });
});
