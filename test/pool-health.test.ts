import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Config } from "../src/config.js";
import { probeMember, probeAllPools, extractContent, DEAD_VERDICTS } from "../src/pool-health.js";

function cfg(pools: Record<string, string[]>): Config {
  return {
    host: "127.0.0.1",
    port: 8791,
    providers: {
      p1: { base: "https://p1.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 1000, authEnv: "P1_KEY" },
      nokey: { base: "https://nokey.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 1000 },
    },
    routing: { default: "p1/m", tiers: {}, pools },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  } as unknown as Config;
}

const okBody = JSON.stringify({ choices: [{ message: { content: "OK" } }] });

function respond(status: number, body = "{}"): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe("extractContent", () => {
  it("reads OpenAI-shaped content", () => {
    expect(extractContent(okBody)).toBe("OK");
  });
  it("reads Anthropic-shaped content", () => {
    expect(extractContent(JSON.stringify({ content: [{ type: "text", text: "hi" }] }))).toBe("hi");
  });
  it("returns empty string on junk", () => {
    expect(extractContent("not json")).toBe("");
  });
});

describe("probeMember", () => {
  beforeEach(() => {
    process.env.P1_KEY = "k";
  });
  afterEach(() => {
    delete process.env.P1_KEY;
  });

  it("reports live when a real completion comes back with content", async () => {
    const r = await probeMember("coding", "p1/m", cfg({ coding: ["p1/m"] }), respond(200, okBody));
    expect(r.verdict).toBe("live");
  });

  // The observed failure: a model listed by the provider that 404s on every call.
  it("reports a 404 as dead, not as a transient error", async () => {
    const r = await probeMember("coding", "p1/gone", cfg({ coding: ["p1/gone"] }), respond(404));
    expect(r.verdict).toBe("missing");
    expect(DEAD_VERDICTS.has(r.verdict)).toBe(true);
  });

  // A 200 with no content is what a reasoning model does when max_tokens is too small —
  // distinct from dead, and must not be reported as such.
  it("distinguishes an empty 200 from a dead model", async () => {
    const body = JSON.stringify({ choices: [{ message: { content: "" } }] });
    const r = await probeMember("coding", "p1/m", cfg({ coding: ["p1/m"] }), respond(200, body));
    expect(r.verdict).toBe("empty");
    expect(DEAD_VERDICTS.has(r.verdict)).toBe(false);
  });

  it("separates rate limiting from deadness", async () => {
    const r = await probeMember("coding", "p1/m", cfg({ coding: ["p1/m"] }), respond(429));
    expect(r.verdict).toBe("rate_limited");
    expect(DEAD_VERDICTS.has(r.verdict)).toBe(false);
  });

  it("reports a missing key without sending a request", async () => {
    delete process.env.P1_KEY;
    let called = false;
    const f = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await probeMember("coding", "p1/m", cfg({ coding: ["p1/m"] }), f);
    expect(r.verdict).toBe("auth");
    expect(called).toBe(false);
  });

  it("reports an unknown provider as dead", async () => {
    const r = await probeMember("coding", "ghost/m", cfg({ coding: ["ghost/m"] }), respond(200, okBody));
    expect(r.verdict).toBe("missing");
  });

  it("probes with a token budget large enough that reasoning models still emit content", async () => {
    let seen = 0;
    const f = (async (_u: string, init: RequestInit) => {
      seen = JSON.parse(String(init.body)).max_tokens;
      return new Response(okBody, { status: 200 });
    }) as unknown as typeof fetch;
    await probeMember("coding", "p1/m", cfg({ coding: ["p1/m"] }), f);
    expect(seen).toBeGreaterThanOrEqual(400);
  });
});

describe("probeAllPools", () => {
  beforeEach(() => {
    process.env.P1_KEY = "k";
  });
  afterEach(() => {
    delete process.env.P1_KEY;
  });

  it("covers every member of every pool", async () => {
    const c = cfg({ coding: ["p1/a", "p1/b"], fast: ["p1/a", "p1/c"] });
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response(okBody, { status: 200 });
    }) as unknown as typeof fetch;
    const res = await probeAllPools(c, fetchFn);
    expect(res).toHaveLength(4);
    expect(res.map((r) => `${r.pool}:${r.spec}`)).toEqual([
      "coding:p1/a",
      "coding:p1/b",
      "fast:p1/a",
      "fast:p1/c",
    ]);
    expect(calls).toBe(3);
    expect(res.every((r) => r.verdict === "live")).toBe(true);
  });

  it("returns an empty list when no pools are configured", async () => {
    expect(await probeAllPools(cfg({}), respond(200, okBody))).toEqual([]);
  });
});
