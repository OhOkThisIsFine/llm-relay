import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseStatedRateLimit,
  looksLikeRateLimitError,
  recordObservedRateLimit,
  observedRateLimits,
  flushObservedRateLimits,
  resetObservedRateLimits,
  OBSERVED_RATE_LIMIT_TTL_MS,
  rateLimitFactKind,
  rateLimitAxisOf,
  type StatedRateLimit,
} from "../src/rate-limits.js";
import { clearFacts, FACT_KINDS } from "../src/target-facts.js";
import { makeCredentialId } from "../src/credential-id.js";

/**
 * Learned rate-limit facts (spec §4 Rung 1): what a deployment STATED about its own ceilings.
 *
 * The parser rules are the whole point: only an explicit limit with a confidently identified axis
 * AND period becomes a measurement. A miss learns NOTHING — same fail-safe as `context-limits.ts`,
 * because a guess in this store wears a `learned` label for 30 days.
 */

const dir = mkdtempSync(join(tmpdir(), "rp-ratelimit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
let path = "";
beforeEach(() => {
  path = join(dir, `limits${n++}.json`);
  resetObservedRateLimits();
});

const CRED = makeCredentialId("nim");
const OTHER_CRED = makeCredentialId("nim", "other");

describe("parsing a STATED rate limit out of a response body", () => {
  it.each([
    // Real provider wordings first — these are the shapes the seeds were written from.
    [
      "Anthropic org-wide tokens",
      "Number of request tokens has exceeded your organization's rate limit of 55,000 input tokens per minute; new requests are rejected until 2026-08-22T12:00:00Z",
      [{ axis: "tokens", period: "minute", limit: 55000, accountWording: true }],
    ],
    [
      "OpenAI-ish requests per minute",
      "Rate limit exceeded: limit 60 requests per minute. Please try again later.",
      [{ axis: "requests", period: "minute", limit: 60 }],
    ],
    [
      "Groq bracketed TPM clause",
      "Rate limit reached for model llama on tokens per min (TPM): Limit 6000, Used 0, Requested 5000. Please try again in 6.9s.",
      [{ axis: "tokens", period: "minute", limit: 6000 }],
    ],
    ["colon form", "Requests per day: 10000", [{ axis: "requests", period: "day", limit: 10000 }]],
    ["acronym after copula", "TPM is 6000 for this tier", [{ axis: "tokens", period: "minute", limit: 6000 }]],
    ["acronym before number", "you are limited to 60 RPM", [{ axis: "requests", period: "minute", limit: 60 }]],
    [
      "several ceilings in one body yield each",
      "Your plan allows 20000 tokens per minute and 500000 tokens per day.",
      [
        { axis: "tokens", period: "minute", limit: 20000 },
        { axis: "tokens", period: "day", limit: 500000 },
      ],
    ],
  ] as Array<[string, string, StatedRateLimit[]]>)("reads %s", (_label, body, expected) => {
    expect(parseStatedRateLimit(body)).toEqual(expected);
  });

  it("captures the LIMIT, never the usage count next to it", () => {
    // Groq states used/requested figures in the same breath as the limit. Capturing either would
    // persist a "ceiling" that moves with every request — worse than knowing nothing.
    const hits = parseStatedRateLimit(
      "on tokens per min (TPM): Limit 6000, Used 5980, Requested 5000. Try again in 6.9s.",
    );
    expect(hits).toEqual([{ axis: "tokens", period: "minute", limit: 6000 }]);
  });

  it("returns null when the body proves throttling but states no ceiling", () => {
    expect(looksLikeRateLimitError("Rate limit exceeded")).toBe(true);
    expect(parseStatedRateLimit("Rate limit exceeded")).toBeNull();
    expect(parseStatedRateLimit("Too many requests, slow down.")).toBeNull();
  });

  it("returns null for a REQUESTED count with no limit beside it", () => {
    // "you sent 120 requests" is a count, not a ceiling. Persisting it would store a number that
    // grows with traffic and call it a measurement.
    expect(looksLikeRateLimitError("you sent 120 requests in the last minute")).toBe(false);
    expect(parseStatedRateLimit("you sent 120 requests in the last minute")).toBeNull();
  });

  it("returns null for period-only or axis-only wording", () => {
    expect(parseStatedRateLimit("requests per minute exceeded")).toBeNull();
    expect(parseStatedRateLimit("rate limit of 60 requests")).toBeNull();
  });

  it("returns null for a bare number and for credit-balance wording", () => {
    // A bare number has no axis and no period; a credit balance is allowance territory (402), not
    // a rate. Neither may be guessed into a measurement bucket.
    expect(parseStatedRateLimit("60")).toBeNull();
    expect(parseStatedRateLimit("you have 5 credits left")).toBeNull();
  });

  it("never records a monthly ceiling — there is no month measurement kind", () => {
    // Monthly ceilings are allowance territory (`allowance-exhausted`), not rate. A `month` kind
    // would invite availability math on a number the relay re-learns anyway when it trips.
    expect(parseStatedRateLimit("30 requests per month")).toBeNull();
    expect(parseStatedRateLimit("monthly quota of 30000 tokens")).toBeNull();
  });

  it("returns null for unrelated errors and junk", () => {
    for (const body of ["", "{}", "internal server error", "invalid api key"]) {
      expect(parseStatedRateLimit(body)).toBeNull();
    }
  });

  it("rejects an implausible ceiling rather than persisting a parse artifact", () => {
    expect(parseStatedRateLimit("limit 99999999 requests per minute")).toBeNull();
    expect(parseStatedRateLimit("limit 999999999999 tokens per minute")).toBeNull();
  });

  it("does not scan an unbounded body", () => {
    const buried = "x".repeat(20000) + " limit 60 requests per minute";
    expect(parseStatedRateLimit(buried)).toBeNull();
  });

  it("maps axis×period to the four measurement kinds and back", () => {
    expect(rateLimitFactKind({ axis: "requests", period: "minute" })).toBe("rate-limit-rpm");
    expect(rateLimitFactKind({ axis: "requests", period: "day" })).toBe("rate-limit-rpd");
    expect(rateLimitFactKind({ axis: "tokens", period: "minute" })).toBe("rate-limit-tpm");
    expect(rateLimitFactKind({ axis: "tokens", period: "day" })).toBe("rate-limit-tpd");
    expect(rateLimitAxisOf("rate-limit-tpm")).toEqual({ axis: "tokens", period: "minute" });
    // Every kind that is NOT one of the four measurements maps to null — including `rate-limited`,
    // which is a CONDITION about throttling, not a measurement of a ceiling. The inverse must not
    // hallucinate a bucket for a kind that carries no limit value.
    for (const kind of FACT_KINDS.filter(
      (k) => k !== "rate-limit-rpm" && k !== "rate-limit-rpd" && k !== "rate-limit-tpm" && k !== "rate-limit-tpd",
    )) {
      expect(rateLimitAxisOf(kind)).toBeNull();
    }
  });

  it("does not mistake a stated USAGE figure for the ceiling", () => {
    // The comparison form states what was sent. Recording it would persist a number that moves
    // with every request and call it a measurement — worse than knowing nothing.
    expect(parseStatedRateLimit("Request exceeds allowed rate: 8192 > TOKENS_PER_MINUTE")).toBeNull();
    expect(parseStatedRateLimit("you used 120 tokens per minute")).toBeNull();
  });
});

describe("the learned-rate-limit store", () => {
  it("records and reads back a ceiling at attempt scope", () => {
    recordObservedRateLimit("nim", CRED, "m", { axis: "requests", period: "minute", limit: 60 }, { path });
    expect(observedRateLimits("nim", CRED, "m", { path })).toEqual([
      { axis: "requests", period: "minute", limit: 60, basis: "learned", until: expect.any(Number) },
    ]);
  });

  it("keeps measurements through a condition-clearing success", () => {
    recordObservedRateLimit("nim", CRED, "m", { axis: "requests", period: "minute", limit: 60 }, { path });
    clearFacts("nim", CRED, "m", { path });
    expect(observedRateLimits("nim", CRED, "m", { path })).toHaveLength(1);
  });

  it("does not widen to a sibling model by inference", () => {
    // Attempt scope means THIS credential × THIS model. A sibling learning the same 403 on its own
    // clock is the failure mode `target-facts.ts` exists to prevent; reading across models would
    // reintroduce it through the read side instead of the write side.
    recordObservedRateLimit("nim", CRED, "m1", { axis: "requests", period: "minute", limit: 60 }, { path });
    expect(observedRateLimits("nim", CRED, "m2", { path })).toEqual([]);
  });

  it("widens to credential scope ONLY when the statement named the account/key", () => {
    recordObservedRateLimit(
      "nim",
      CRED,
      "m1",
      { axis: "requests", period: "day", limit: 10000, accountWording: true },
      { path },
    );
    // Credential scope covers every model on THIS key…
    expect(observedRateLimits("nim", CRED, "m2", { path })).toEqual([
      { axis: "requests", period: "day", limit: 10000, basis: "learned", until: expect.any(Number) },
    ]);
    // …and no model on any OTHER key.
    expect(observedRateLimits("nim", OTHER_CRED, "m1", { path })).toEqual([]);
  });

  it("falls back to deployment scope when no credential is known", () => {
    recordObservedRateLimit("nim", null, "m", { axis: "tokens", period: "minute", limit: 55000 }, { path });
    expect(observedRateLimits("nim", null, "m", { path })).toHaveLength(1);
    expect(observedRateLimits("openrouter", null, "m", { path })).toEqual([]);
  });

  it("orders most-specific-first when several scopes hold the same axis×period", () => {
    recordObservedRateLimit("nim", null, "m", { axis: "requests", period: "minute", limit: 30 }, { path });
    recordObservedRateLimit("nim", CRED, "m", { axis: "requests", period: "minute", limit: 60 }, { path });
    const hits = observedRateLimits("nim", CRED, "m", { path });
    expect(hits.map((h) => h.limit)).toEqual([60, 30]);
  });

  it("lets a fresh statement replace an older one, in both directions", () => {
    recordObservedRateLimit("nim", CRED, "m", { axis: "requests", period: "minute", limit: 60 }, { path, now: 1000 });
    recordObservedRateLimit("nim", CRED, "m", { axis: "requests", period: "minute", limit: 120 }, { path, now: 2000 });
    expect(observedRateLimits("nim", CRED, "m", { path, now: 3000 })[0]?.limit).toBe(120);
    recordObservedRateLimit("nim", CRED, "m", { axis: "requests", period: "minute", limit: 40 }, { path, now: 4000 });
    expect(observedRateLimits("nim", CRED, "m", { path, now: 5000 })[0]?.limit).toBe(40);
  });

  it("expires on the measurement TTL, so a raised limit is not disbelieved forever", () => {
    recordObservedRateLimit("nim", CRED, "m", { axis: "requests", period: "minute", limit: 60 }, { path, now: 0 });
    expect(observedRateLimits("nim", CRED, "m", { path, now: OBSERVED_RATE_LIMIT_TTL_MS - 1 })).toHaveLength(1);
    expect(observedRateLimits("nim", CRED, "m", { path, now: OBSERVED_RATE_LIMIT_TTL_MS + 1 })).toEqual([]);
  });

  it("ignores a nonsensical value instead of storing it", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      recordObservedRateLimit("nim", CRED, "bad", { axis: "requests", period: "minute", limit: bad }, { path });
      expect(observedRateLimits("nim", CRED, "bad", { path })).toEqual([]);
    }
  });

  it("survives a flush to disk and a fresh read", () => {
    recordObservedRateLimit("nim", CRED, "m", { axis: "tokens", period: "minute", limit: 55000 }, { path });
    flushObservedRateLimits({ path });
    expect(existsSync(path)).toBe(true);

    // ⚠ Asserts the ROUND TRIP, not the file's internal shape — storage layout belongs to
    // `target-facts.ts`, and what must hold is that a learned ceiling survives a restart.
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as unknown;
    expect(JSON.stringify(onDisk)).toContain("55000");

    resetObservedRateLimits();
    expect(observedRateLimits("nim", CRED, "m", { path })[0]?.limit).toBe(55000);
  });
});

// ── Wired into BOTH request paths ──────────────────────────────────────────────────────────────
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { Config, ProviderConfig } from "../src/config.js";

const servers: Server[] = [];
function track(s: Server): Server {
  servers.push(s);
  return s;
}

beforeEach(() => {
  globalCircuitBreaker.reset();
  // ⚠ The learned stores are process-global: one test's refusal demoting another's candidate is a
  // hermeticity bug, not a routing one.
  resetFactsViaRateLimits();
  resetInterpretations();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  globalCircuitBreaker.reset();
  resetFactsViaRateLimits();
  resetInterpretations();
});

function resetFactsViaRateLimits(): void {
  resetObservedRateLimits();
}

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

/** A backend whose responses are scripted in order, counting calls. */
function scripted(
  reply: (n: number) => { status?: number; headers?: Record<string, string>; body: string },
): Promise<{ server: Server }> {
  let n = 0;
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        const out = reply(++n);
        res.writeHead(out.status ?? 200, { "content-type": "application/json", ...out.headers });
        res.end(out.body);
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: track(s) }));
  });
}

const RATE_LIMIT_429 = JSON.stringify({
  error: { message: "Rate limit exceeded: limit 60 requests per minute.", type: "rate_limit_error" },
});

const OK_BODY = JSON.stringify({
  id: "cmpl_ok",
  object: "chat.completion",
  choices: [{ message: { role: "assistant", content: "served" }, finish_reason: "stop" }],
});

/**
 * A two-member pool in CONFIG order (`benchmarkSort: false`). With fewer than two candidates,
 * "fails over correctly" and "cannot fail over at all" are the same observation — the exact trap
 * `test/pool-failover.test.ts` documents.
 */
function poolCfg(bases: string[]): Config {
  const providers: Record<string, ProviderConfig> = {};
  bases.forEach((base, i) => {
    providers[`p${i + 1}`] = { base, kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
  });
  return {
    host: "127.0.0.1",
    port: 0,
    providers,
    routing: {
      default: "pool/coding",
      tiers: {},
      benchmarkSort: false,
      pools: { coding: bases.map((_, i) => `p${i + 1}/m${i + 1}`) },
    },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

function startProxy(c: Config): Promise<Server> {
  const s = createProxy(c, { catalog: new ModelCatalog({ cachePath: null }), breaker: globalCircuitBreaker });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(track(s))));
}

const FRONT_FETCHERS = {
  anthropic: (p: number): Promise<Response> =>
    fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "pool/coding", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    }),
  openai: (p: number): Promise<Response> =>
    fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    }),
} as const;

describe("learning a stated rate limit from real traffic", () => {
  it.each(["anthropic", "openai"] as const)(
    "candidate 1's 429 ceiling is learned while candidate 2 serves (%s front)",
    async (front) => {
      // ⚠ One policy, both paths: this repo shipped a defect where the OpenAI front had no copy of
      // a policy the Anthropic path enforced, and a learning loop wired into one front only knows
      // nothing about half the traffic.
      let served = "";
      const b1 = await scripted(() =>
        served.length > 0
          ? { status: 429, body: RATE_LIMIT_429 }
          : { status: 429, body: RATE_LIMIT_429 },
      );
      const b2 = await scripted(() => {
        served = "p2/m2";
        return { status: 200, body: OK_BODY };
      });
      const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(b1.server)}`, `http://127.0.0.1:${port(b2.server)}`])));

      const r = await FRONT_FETCHERS[front](p);
      expect(r.status).toBe(200);
      expect(served).toBe("p2/m2");

      // Candidate 1's own credential × its own model learned the ceiling it stated…
      expect(observedRateLimits("p1", makeCredentialId("p1"), "m1")).toEqual([
        { axis: "requests", period: "minute", limit: 60, basis: "learned", until: expect.any(Number) },
      ]);
      // …and the member that served learned nothing, because it never refused.
      expect(observedRateLimits("p2", makeCredentialId("p2"), "m2")).toEqual([]);
    },
  );

  it("records the durable half of provider-stated quota headers", async () => {
    // extractQuotaObservations emits an observation only when limit AND remaining share one
    // explicitly-attributed axis:period bucket — send both spellings.
    const b1 = await scripted(() => ({
      status: 200,
      headers: {
        "x-ratelimit-limit-requests-day": "1000",
        "x-ratelimit-remaining-requests-day": "999",
      },
      body: OK_BODY,
    }));
    const b2 = await scripted(() => ({ status: 200, body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(b1.server)}`, `http://127.0.0.1:${port(b2.server)}`])));

    const r = await FRONT_FETCHERS.openai(p);
    expect(r.status).toBe(200);
    expect(observedRateLimits("p1", makeCredentialId("p1"), "m1")).toEqual([
      { axis: "requests", period: "day", limit: 1000, basis: "learned", until: expect.any(Number) },
    ]);
  });

  it("skips a monthly quota header — there is no month measurement kind", async () => {
    const b1 = await scripted(() => ({
      status: 200,
      headers: {
        "x-ratelimit-limit-requests-month": "50",
        "x-ratelimit-remaining-requests-month": "49",
      },
      body: OK_BODY,
    }));
    const b2 = await scripted(() => ({ status: 200, body: OK_BODY }));
    const p = port(await startProxy(poolCfg([`http://127.0.0.1:${port(b1.server)}`, `http://127.0.0.1:${port(b2.server)}`])));

    await FRONT_FETCHERS.openai(p);
    expect(observedRateLimits("p1", makeCredentialId("p1"), "m1")).toEqual([]);
  });
});
