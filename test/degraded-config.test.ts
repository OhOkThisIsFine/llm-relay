/**
 * A provider whose `base` references an unset ${ENV} used to abort startup. Because the
 * proxy fronts every client session, that turned one unused optional provider into a total
 * outage. These tests pin the proportionate behaviour: disable that provider, keep serving.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveTargets, subagentSpec } from "../src/config.js";

let dir: string;
function write(cfg: unknown): string {
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

const base = {
  listen: "127.0.0.1:8791",
  mode: "detect",
  providers: {
    good: { base: "https://good.test/v1", kind: "openai", authEnv: "GOOD_KEY" },
    needsvar: { base: "https://api.test/accounts/${ACCT_ID}/v1", kind: "openai", authEnv: "OTHER_KEY" },
  },
  routing: {
    default: "good/m",
    pools: { coding: ["good/m", "needsvar/m"] },
  },
};

describe("provider with an unset ${ENV} in base", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
    delete process.env.ACCT_ID;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ACCT_ID;
  });

  it("loads instead of throwing, and disables only that provider", () => {
    const cfg = loadConfig(write(base));
    expect(Object.keys(cfg.providers)).toEqual(["good"]);
    expect(cfg.providers.needsvar).toBeUndefined();
  });

  it("names the missing variable in a warning", () => {
    const cfg = loadConfig(write(base));
    const joined = (cfg.warnings ?? []).join("\n");
    expect(joined).toContain("needsvar");
    expect(joined).toContain("${ACCT_ID}");
  });

  it("drops pool members belonging to the disabled provider, keeping the rest", () => {
    const cfg = loadConfig(write(base));
    expect(cfg.routing.pools?.coding).toEqual(["good/m"]);
    expect((cfg.warnings ?? []).join("\n")).toContain("needsvar/m");
  });

  it("includes the provider normally once the variable is set", () => {
    process.env.ACCT_ID = "abc123";
    const cfg = loadConfig(write(base));
    expect(cfg.providers.needsvar?.base).toBe("https://api.test/accounts/abc123/v1");
    expect(cfg.warnings ?? []).toEqual([]);
  });

  // A pool member naming a provider that simply does not exist is a typo, not a degraded
  // provider. Silently dropping it would send that traffic to the passthrough and spend
  // primary quota, so it must still fail loudly.
  it("still rejects a pool member naming a provider that was never declared", () => {
    const cfg = {
      ...base,
      providers: { good: base.providers.good },
      routing: { default: "good/m", pools: { coding: ["good/m", "typoed/m"] } },
    };
    expect(() => loadConfig(write(cfg))).toThrow(/typoed/);
  });

  /**
   * A degraded pool must degrade to its SURVIVORS, never to routing.default. Falling through to
   * the passthrough is the failure this whole area exists to prevent: the subagent still answers,
   * so nothing looks wrong, while the traffic quietly lands on primary quota.
   */
  it("routes a subagent to the pool's surviving member, not to the default passthrough", () => {
    const cfg = loadConfig(
      write({
        ...base,
        providers: {
          ...base.providers,
          passthru: { base: "https://passthrough.test", kind: "anthropic" },
        },
        routing: {
          default: "passthru",
          pools: { coding: ["needsvar/m", "good/m"] },
          subagents: { default: "pool/coding" },
          offload: true,
          benchmarkSort: false,
        },
      }),
    );

    expect((cfg.warnings ?? []).join("\n")).toContain("needsvar/m");
    const sub = {
      system: "cc_is_subagent=true;",
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    };
    expect(subagentSpec(sub, "claude-opus-5", cfg)).toBe("pool/coding");
    // The disabled member is gone and the survivor is used — "passthru" must not appear.
    expect(resolveTargets("pool/coding", cfg).map((t) => t.provider)).toEqual(["good"]);
  });

  /**
   * Tier and subagent specs were validated against the POST-disabling provider map, so a tier
   * pointing at a provider whose ${ENV} was unset was reported as naming an unknown provider
   * and aborted startup — the same total outage the pool path already avoids, reached by a
   * different route. They degrade the same way a pool member does.
   */
  it("drops a tier naming a disabled provider instead of aborting startup", () => {
    const cfg = loadConfig(
      write({
        ...base,
        routing: { default: "good/m", tiers: { opus: "needsvar/m", sonnet: "good/m" } },
      }),
    );
    expect(cfg.routing.tiers.opus).toBeUndefined();
    expect(cfg.routing.tiers.sonnet).toBe("good/m");
    expect((cfg.warnings ?? []).join("\n")).toContain("routing.tiers.opus");
  });

  it("keeps the surviving members of a multi-candidate tier", () => {
    const cfg = loadConfig(
      write({ ...base, routing: { default: "good/m", tiers: { opus: ["needsvar/m", "good/m"] } } }),
    );
    expect(cfg.routing.tiers.opus).toEqual(["good/m"]);
  });

  /**
   * Dropping a subagent entry means that traffic falls through to routing.default — for a
   * passthrough default, primary quota, while the dispatcher believes it offloaded. That is
   * the hazard an unresolvable `@relay:` directive is a hard ERROR for, so the startup warning
   * has to state the consequence and not merely the fact.
   */
  it("drops a subagent entry naming a disabled provider, warning what it now costs", () => {
    const cfg = loadConfig(
      write({
        ...base,
        providers: { ...base.providers, passthru: { base: "https://passthrough.test", kind: "anthropic" } },
        routing: { default: "passthru", subagents: { opus: "needsvar/m" }, offload: true },
      }),
    );
    expect(cfg.routing.subagents?.opus).toBeUndefined();
    const joined = (cfg.warnings ?? []).join("\n");
    expect(joined).toContain("routing.subagents.opus");
    expect(joined).toContain("primary quota");
  });

  /**
   * routing.default is the fall-through for everything, so there is nowhere left to fall
   * through TO — still fatal. But it must not be reported as a typo: the provider is declared,
   * it is disabled, and sending the operator to hunt for a misspelling wastes the one message
   * they get.
   */
  it("still fails when routing.default itself names the disabled provider — naming the real cause", () => {
    const cfg = { ...base, routing: { default: "needsvar/m" } };
    expect(() => loadConfig(write(cfg))).toThrow(/DISABLED/);
    expect(() => loadConfig(write(cfg))).not.toThrow(/unknown provider/);
  });

  it("fails loudly when disabling leaves a pool with no members at all", () => {
    const cfg = {
      ...base,
      routing: { default: "good/m", pools: { coding: ["needsvar/m"] } },
    };
    expect(() => loadConfig(write(cfg))).toThrow(/coding/);
  });

  it("fails loudly on @relay directive naming a disabled provider in degraded config", () => {
    const cfg = loadConfig(write(base));
    const sub = {
      system: "cc_is_subagent=true;",
      messages: [{ role: "user", content: "@relay: needsvar/m\ngo" }],
    };
    expect(() => subagentSpec(sub, "claude-opus-5", cfg)).toThrow(/disabled provider "needsvar"/);
  });
});
