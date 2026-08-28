import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Config } from "../src/config.js";
import { probeMember, probeAllPools, extractContent, DEAD_VERDICTS } from "../src/pool-health.js";

function cfg(pools: Record<string, string[]>): Config {
  return {
    host: "127.0.0.1",
    port: 8791,
    providers: {
      p1: { base: "https://p1.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000, authEnv: "P1_KEY" },
      nokey: { base: "https://nokey.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 },
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

  // A 400 is a request-validation error (mistral's 9-char tool-call-id refusal, a
  // max_tokens complaint), not evidence of model absence. It must not be reported as "dead /
  // missing" — that would tell the operator to remove a working deployment.
  it("does not report a 400 as model-not-servable", async () => {
    const r = await probeMember("coding", "p1/m", cfg({ coding: ["p1/m"] }), respond(400));
    expect(r.verdict).toBe("error");
    expect(r.verdict).not.toBe("missing");
    expect(DEAD_VERDICTS.has(r.verdict)).toBe(false);
  });

  // A 401/403 from a single-model completion probe is ambiguous: it may be the credential,
  // or it may be an entitlement wall on a model the key legitimately cannot touch. The probe
  // must not ASSERT a credential fault, so it reports `denied` (a server rejection) rather
  // than `auth` (which carries a rotate-the-key recommendation in the CLI).
  it("reports an ambiguous 401 as denied, not as a proven credential fault", async () => {
    const r = await probeMember("coding", "p1/m", cfg({ coding: ["p1/m"] }), respond(401));
    expect(r.verdict).toBe("denied");
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

  it("uses the first serviceable fleet slot and reports only its stable id", async () => {
    process.env.FLEET_ONE = "one";
    process.env.FLEET_TWO = "two";
    const c = cfg({ coding: ["p1/m"] });
    c.providers.p1 = {
      base: "https://p1.test/v1",
      kind: "openai",
      authHeader: "authorization",
      timeoutMs: 1000,
      credentials: [
        { label: "one", authEnv: "FLEET_ONE" },
        { label: "two", authEnv: "FLEET_TWO" },
      ],
    };
    let seen = "";
    const f = (async (_url: string, init: RequestInit) => {
      seen = ((init.headers as Record<string, string>)?.authorization ?? "");
      return new Response(okBody, { status: 200 });
    }) as unknown as typeof fetch;
    const r = await probeMember("coding", "p1/m", c, f);
    expect(r.verdict).toBe("live");
    expect(r.credentialId).toBe("p1#one");
    expect(seen).toBe("Bearer one");
    delete process.env.FLEET_ONE;
    delete process.env.FLEET_TWO;
  });

  it("falls through a missing first slot and keeps Anthropic model-less probes", async () => {
    process.env.FLEET_TWO = "two";
    const c = cfg({ coding: ["p1/m"] });
    c.providers.p1 = {
      base: "https://p1.test/v1",
      kind: "openai",
      authHeader: "authorization",
      timeoutMs: 1000,
      credentials: [
        { label: "missing", authEnv: "FLEET_MISSING" },
        { label: "present", authEnv: "FLEET_TWO" },
      ],
    };
    const selected = await probeMember("coding", "p1/m", c, respond(200, okBody));
    expect(selected.verdict).toBe("live");
    expect(selected.credentialId).toBe("p1#present");

    let anthropicBody: Record<string, unknown> | undefined;
    const anthropic: Config = {
      ...c,
      providers: {
        anthropic: { base: "https://a.test", kind: "anthropic", authHeader: "x-api-key", timeoutMs: 1000 },
      },
    } as unknown as Config;
    const anthropicResult = await probeMember("coding", "anthropic", anthropic, async (_url, init) => {
      anthropicBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    });
    expect(anthropicResult.verdict).toBe("live");
    expect(anthropicBody?.model).toBeUndefined();
    delete process.env.FLEET_TWO;
  });

  it("does not egress when every explicit slot is disabled or missing", async () => {
    const c = cfg({ coding: ["p1/m"] });
    c.providers.p1 = {
      base: "https://p1.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 1000,
      credentials: [
        { label: "disabled", authEnv: "FLEET_DISABLED", enabled: false },
        { label: "missing", authEnv: "FLEET_MISSING" },
      ],
    };
    let called = false;
    const result = await probeMember("coding", "p1/m", c, async () => {
      called = true;
      return new Response(okBody, { status: 200 });
    });
    expect(result.verdict).toBe("auth");
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

  it("applies a total-operation deadline and returns both results when one member hangs", async () => {
    const pools = { test: ["p1/fast", "p1/slow"] };
    const c = cfg(pools);
    // ⚠ A REAL deadline, deliberately short. The signal under test is a real `AbortSignal.timeout`,
    // so the fixture's own `timeoutMs` is the wall-clock this test waits. At the shared 5000 it
    // burned five real seconds and needed a 15 s budget — precisely the load-sensitive shape
    // HANDOFF §3 records as having flaked two CLI tests for weeks. 40 ms proves the same thing.
    c.providers.p1!.timeoutMs = 40;
    // fast member resolves immediately
    // slow member never settles (a Promise that never resolves) — only AbortSignal can stop it
    let slowSettled = false;
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const spec = body.model === "fast" ? "fast" : "slow";
      if (spec === "fast") {
        return new Response(okBody, { status: 200 });
      }
      // slow: await a promise that never resolves unless the signal aborts.
      // ⚠ Reject with the signal's OWN `reason`, not a hand-made AbortError. `AbortSignal.timeout()`
      // aborts with a **TimeoutError**; only `AbortController.abort()` produces an `AbortError`.
      // A fake that invents an AbortError would pass against a `name === "AbortError"` check that
      // a real timeout never satisfies — which is exactly the bug this fixture nearly hid.
      await new Promise<void>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          if (signal.aborted) {
            reject(signal.reason);
          } else {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }
        }
      });
      slowSettled = true;
      return new Response(okBody, { status: 200 }); // never reached without abort
    };
    const results = await probeAllPools(c, fetchFn);
    // Should return both members without hanging
    expect(results).toHaveLength(2);
    expect(results.map(r => r.spec)).toEqual(["p1/fast", "p1/slow"]);
    expect(results.find(r => r.spec === "p1/fast")!.verdict).toBe("live");
    const slow = results.find(r => r.spec === "p1/slow")!;
    expect(slow.verdict).toBe("error");
    // Not merely "it stopped" — the operator must be told WHY. A raw DOMException message here
    // would mean the TimeoutError fell through the abort branch.
    expect(slow.detail).toBe("probe timed out");
    expect(slowSettled).toBe(false); // the slow request was aborted, never settled naturally
  }, 15000);
});
