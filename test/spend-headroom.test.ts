import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySpendHeadroom, classifySpendHeadroom } from "../src/spend-headroom.js";
import { cooldownUntil, factsFor, recordFact, resetFacts } from "../src/target-facts.js";
import { makeCredentialId } from "../src/credential-id.js";
import { PingLoop, SPEND_POLL_INTERVAL_MS } from "../src/ping/cadence.js";
import type { Config, ProviderConfig } from "../src/config.js";
import type { ModelCatalog } from "../src/catalog.js";

/**
 * Provider-stated spend headroom (owner decision 2026-08-28): the paid/free boundary on a
 * spend-limited key comes from the provider's OWN statement (OpenRouter's key/credits endpoint),
 * not from a learned refusal. The statement feeds the SAME fact the accepted weekly-limit
 * interpretation produces — `allowance-exhausted`, credential scope, paid-only — so every
 * demotion consumer behaves identically whichever evidence arrived first.
 */

const cred = makeCredentialId("openrouter");
let dir: string;
let path: string;
const NOW = 1_000_000;
const opts = () => ({ path, now: NOW });

beforeEach(() => {
  resetFacts();
  dir = mkdtempSync(join(tmpdir(), "llm-relay-spend-"));
  path = join(dir, "target-facts.json");
});
afterEach(() => {
  resetFacts();
  rmSync(dir, { recursive: true, force: true });
});

describe("classifySpendHeadroom", () => {
  it("is unknown without a stated limit — no gating on figures nobody stated", () => {
    expect(classifySpendHeadroom({ limitUsd: null, usageUsd: 3 })).toEqual({ state: "unknown" });
    expect(classifySpendHeadroom({})).toEqual({ state: "unknown" });
    expect(classifySpendHeadroom({ limitUsd: 10, usageUsd: null })).toEqual({ state: "unknown" });
    expect(classifySpendHeadroom({ limitUsd: Number.NaN, usageUsd: 1 })).toEqual({ state: "unknown" });
  });

  it("states headroom while usage is below the limit", () => {
    expect(classifySpendHeadroom({ limitUsd: 10, usageUsd: 4 })).toEqual({
      state: "headroom", limitUsd: 10, usageUsd: 4, remainingUsd: 6,
    });
  });

  it("is exhausted inclusively at the limit — the hard-cap convention", () => {
    expect(classifySpendHeadroom({ limitUsd: 10, usageUsd: 10 }).state).toBe("exhausted");
    expect(classifySpendHeadroom({ limitUsd: 10, usageUsd: 12 })).toEqual({
      state: "exhausted", limitUsd: 10, usageUsd: 12, remainingUsd: -2,
    });
    // A key allowed to spend nothing has no paid headroom.
    expect(classifySpendHeadroom({ limitUsd: 0, usageUsd: 0 }).state).toBe("exhausted");
  });
});

describe("applySpendHeadroom", () => {
  it("records the paid-only credential-scoped exhaustion the accepted interpretation also produces", () => {
    expect(applySpendHeadroom("openrouter", cred, classifySpendHeadroom({ limitUsd: 10, usageUsd: 10 }), opts()))
      .toBe("recorded");
    // Paid deployments demote; free deployments and unclassified callers see nothing —
    // exactly the fact-cost-class contract.
    expect(factsFor("openrouter", cred, "paid-model", { ...opts(), costClass: "paid" }).map((f) => f.kind))
      .toEqual(["allowance-exhausted"]);
    expect(factsFor("openrouter", cred, "free-model", { ...opts(), costClass: "free" })).toEqual([]);
    expect(factsFor("openrouter", cred, "paid-model", opts())).toEqual([]);
  });

  it("retracts ONLY paid-only rows on stated headroom — a paid statement cannot disprove a free exhaustion", () => {
    // The row this poll (or the accepted weekly-limit interpretation) wrote:
    recordFact("allowance-exhausted", { kind: "credential", provider: "openrouter", credentialId: cred },
      { ...opts(), costClasses: ["paid"] });
    // An unfiltered exhaustion (covers every class) and a free-filtered one must both survive.
    recordFact("allowance-exhausted", { kind: "deployment", provider: "openrouter", model: "m-any" }, opts());
    recordFact("allowance-exhausted", { kind: "attempt", provider: "openrouter", credentialId: cred, model: "m-free" },
      { ...opts(), costClasses: ["free"] });

    expect(applySpendHeadroom("openrouter", cred, classifySpendHeadroom({ limitUsd: 10, usageUsd: 2 }), opts()))
      .toBe("cleared");

    expect(factsFor("openrouter", cred, "paid-model", { ...opts(), costClass: "paid" })).toEqual([]);
    expect(factsFor("openrouter", cred, "m-any", opts()).map((f) => f.kind)).toEqual(["allowance-exhausted"]);
    expect(factsFor("openrouter", cred, "m-free", { ...opts(), costClass: "free" }).map((f) => f.kind))
      .toEqual(["allowance-exhausted"]);
  });

  it("applies nothing in either direction on unknown", () => {
    recordFact("allowance-exhausted", { kind: "credential", provider: "openrouter", credentialId: cred },
      { ...opts(), costClasses: ["paid"] });
    expect(applySpendHeadroom("openrouter", cred, { state: "unknown" }, opts())).toBe("none");
    // The existing condition is untouched, and nothing new appears.
    expect(cooldownUntil("openrouter", cred, "paid-model", { ...opts(), costClass: "paid" })).not.toBeNull();
  });
});

describe("PingLoop.pollSpendHeadroom", () => {
  const ENV = "SPEND_TEST_OPENROUTER_KEY";
  const provider: ProviderConfig = {
    base: "https://openrouter.ai/api/v1",
    kind: "openai",
    authEnv: ENV,
    timeoutMs: 1000,
  } as ProviderConfig;
  const other: ProviderConfig = {
    base: "https://ping.test/v1",
    kind: "openai",
    authEnv: ENV,
    timeoutMs: 1000,
  } as ProviderConfig;
  const cfg = {
    host: "127.0.0.1", port: 8791,
    providers: { openrouter: provider, other },
    routing: { default: "openrouter/m", tiers: {} },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  } as unknown as Config;
  const catalog = { list: async () => [] } as unknown as ModelCatalog;

  beforeEach(() => { process.env[ENV] = "sk-spend-test"; });
  afterEach(() => { delete process.env[ENV]; });

  function loopWith(answer: () => Promise<Response>): { loop: PingLoop; urls: string[] } {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(String(url));
      return answer();
    }) as unknown as typeof fetch;
    return { loop: new PingLoop(cfg, catalog, { fetchFn }), urls };
  }

  it("asks only the OpenRouter key endpoint, records the stated exhaustion, and honours the interval", async () => {
    const { loop, urls } = loopWith(async () =>
      new Response(JSON.stringify({ data: { limit: 10, usage: 12 } }), { status: 200 }));
    const t0 = Date.now();
    await loop.pollSpendHeadroom(t0);
    // Egress goes to the provider's own key endpoint and nowhere else — `other` produces none.
    expect(urls).toEqual(["https://openrouter.ai/api/v1/auth/key"]);
    const slotCred = makeCredentialId("openrouter", "default");
    expect(factsFor("openrouter", slotCred, "paid-model", { costClass: "paid" }).map((f) => f.kind))
      .toEqual(["allowance-exhausted"]);
    expect(factsFor("openrouter", slotCred, "free-model", { costClass: "free" })).toEqual([]);

    // Within the interval nothing is re-asked; past it, it is.
    await loop.pollSpendHeadroom(t0 + 1000);
    expect(urls).toHaveLength(1);
    await loop.pollSpendHeadroom(t0 + SPEND_POLL_INTERVAL_MS);
    expect(urls).toHaveLength(2);
  });

  it("clears the paid exhaustion when the provider states headroom again", async () => {
    const slotCred = makeCredentialId("openrouter", "default");
    recordFact("allowance-exhausted", { kind: "credential", provider: "openrouter", credentialId: slotCred },
      { costClasses: ["paid"] });
    const { loop } = loopWith(async () =>
      new Response(JSON.stringify({ data: { limit: 10, usage: 2 } }), { status: 200 }));
    await loop.pollSpendHeadroom(Date.now());
    expect(factsFor("openrouter", slotCred, "paid-model", { costClass: "paid" })).toEqual([]);
  });

  it("applies nothing on a failed key-endpoint answer", async () => {
    const slotCred = makeCredentialId("openrouter", "default");
    recordFact("allowance-exhausted", { kind: "credential", provider: "openrouter", credentialId: slotCred },
      { costClasses: ["paid"] });
    const { loop } = loopWith(async () => new Response("nope", { status: 500 }));
    await loop.pollSpendHeadroom(Date.now());
    // A failed fetch is not a statement of headroom: the standing condition survives.
    expect(factsFor("openrouter", slotCred, "paid-model", { costClass: "paid" }).map((f) => f.kind))
      .toEqual(["allowance-exhausted"]);
  });
});
