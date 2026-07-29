/**
 * A provider whose `base` references an unset ${ENV} used to abort startup. Because the
 * proxy fronts every client session, that turned one unused optional provider into a total
 * outage. These tests pin the proportionate behaviour: disable that provider, keep serving.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

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

  it("fails loudly when disabling leaves a pool with no members at all", () => {
    const cfg = {
      ...base,
      routing: { default: "good/m", pools: { coding: ["needsvar/m"] } },
    };
    expect(() => loadConfig(write(cfg))).toThrow(/coding/);
  });
});
