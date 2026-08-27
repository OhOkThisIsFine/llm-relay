import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProxy, orderByUsability, type ProxyDeps } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { CircuitBreaker, globalCircuitBreaker } from "../src/circuit-breaker.js";
import { QUOTA_DEMOTED_HEADER, SERVED_BY_HEADER } from "../src/backend.js";
import { createQuotaDemotionFn, quotaDemotionLabel } from "../src/quota-demotion.js";
import { buildCandidates } from "../src/candidates.js";
import { loadConfig } from "../src/config.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import { recordObservedRateLimit } from "../src/rate-limits.js";
import { makeCredentialId } from "../src/credential-id.js";
import { resolveAttempt } from "../src/resolved-attempt.js";
import type { Config, ProviderConfig, ResolvedTarget } from "../src/config.js";
import type { ProviderTargetIdentity } from "../src/kernel/contracts.js";
import type { QuotaObservation } from "../src/quota-observation.js";

/**
 * Gap 12 — quota as a DEMOTION term (spec §5.4).
 *
 * Pinned here, most-specific-first: the pure resolver's gates (fresh vs stale, configured vs
 * learned, unknown-means-nothing, no-invented-duration), the breaker's quota cooldown mechanics,
 * the demote-never-drop contract through the shared banding, and the end-to-end behaviour on BOTH
 * fronts including the announcement header. Every multi-candidate scenario uses >= 2 candidates —
 * with one, "fails over correctly" and "cannot fail over" are the same observation.
 */

const MINUTE = 60_000;

function breakerIdentity(provider: string, model: string | null, kind: "anthropic" | "openai" = "openai"): ProviderTargetIdentity {
  return { provider, model, kind, credentialId: makeCredentialId(provider) };
}

function obs(over: Partial<QuotaObservation>): QuotaObservation {
  return {
    axis: "requests",
    period: "minute",
    limit: 60,
    remaining: 0,
    resetsAt: null,
    observedAt: Date.now(),
    basis: "provider-stated",
    ...over,
  };
}

/** Seed typed observations WITHOUT tripping anything: a success records them and nothing else. */
function seedObservations(cb: CircuitBreaker, identity: ProviderTargetIdentity, observations: QuotaObservation[]): void {
  cb.recordOutcome(identity, { ok: true, elapsedMs: 1, quotaObservations: observations });
}

function baseCfg(routingExtra: Record<string, unknown> = {}, providerExtra: Partial<ProviderConfig> = {}): Config {
  const mk = (base: string): ProviderConfig => ({
    base,
    kind: "openai",
    authHeader: "authorization",
    timeoutMs: 1000,
    ...providerExtra,
  });
  return {
    host: "127.0.0.1",
    port: 0,
    providers: { a: mk("http://a"), b: mk("http://b") },
    routing: {
      default: "a/m",
      tiers: {},
      benchmarkSort: false,
      ...routingExtra,
    },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

const t = (n: string): ResolvedTarget => ({
  provider: n,
  base: `http://${n}`,
  kind: "openai",
  model: "m",
  authHeader: "authorization",
  timeoutMs: 1000,
});

describe("quota demotion resolver — the §5.4 gates", () => {
  beforeEach(() => {
    globalCircuitBreaker.reset();
    resetFacts();
    resetInterpretations();
  });
  afterEach(() => {
    globalCircuitBreaker.reset();
    resetFacts();
    resetInterpretations();
  });

  it("demotes on a FRESH provider-stated remaining 0, expiring at the stated reset", () => {
    const now = Math.floor(Date.now() / MINUTE) * MINUTE + 5_000;
    const resetAt = now + 20_000;
    const cb = new CircuitBreaker();
    seedObservations(cb, breakerIdentity("a", "m"), [obs({ remaining: 0, resetsAt: resetAt, observedAt: now })]);
    const fn = createQuotaDemotionFn({ cfg: baseCfg(), breaker: cb });
    const d = fn(resolveAttempt(t("a")), now);
    expect(d).not.toBeNull();
    expect(d!.axis).toBe("requests");
    expect(d!.period).toBe("minute");
    expect(d!.remaining).toBe(0);
    expect(d!.basis).toBe("provider-stated");
    expect(d!.resetsAt).toBe(resetAt);
    expect(d!.resetsAtBasis).toBe("provider-stated");
    expect(quotaDemotionLabel("a/m", d!)).toBe("a/m (requests/minute remaining 0, provider-stated)");
  });

  it("an observation from a PREVIOUS period is stale and has no effect", () => {
    const now = Math.floor(Date.now() / MINUTE) * MINUTE + 5_000;
    const cb = new CircuitBreaker();
    seedObservations(cb, breakerIdentity("a", "m"), [
      obs({ remaining: 0, resetsAt: now - MINUTE, observedAt: now - 2 * MINUTE }),
    ]);
    const fn = createQuotaDemotionFn({ cfg: baseCfg(), breaker: cb });
    expect(fn(resolveAttempt(t("a")), now)).toBeNull();
  });

  it("a STALE observation's stated LIMIT still gates through this period's ledger usage (derived:provider-stated)", () => {
    const minuteStart = Math.floor(Date.now() / MINUTE) * MINUTE;
    const now = minuteStart + 30_000;
    const cb = new CircuitBreaker();
    // Stated LAST period, so rung 1 declines it — but its LIMIT half stays durable knowledge
    // (a header limit states entitlement, not point-in-time state) and feeds rung 2.
    seedObservations(cb, breakerIdentity("a", "m"), [
      obs({ remaining: 0, resetsAt: minuteStart - 1, observedAt: minuteStart - MINUTE + 5_000 }),
    ]);
    let queried = 0;
    const fn = createQuotaDemotionFn({
      cfg: baseCfg(),
      breaker: cb,
      accounting: {
        // Period-aware stub: 60 requests THIS minute against the stated 60/min ceiling.
        usedInWindow: (options) =>
          Math.floor((options.now ?? 0) / MINUTE) === Math.floor(now / MINUTE)
            ? (queried += 1, { requests: 60, tokens: 500, basis: "reported" })
            : { requests: 0, tokens: null, basis: null },
      },
    });
    const d = fn(resolveAttempt(t("a")), now);
    expect(d).not.toBeNull();
    expect(d!.basis).toBe("derived:provider-stated");
    expect(d!.remaining).toBe(0);
    expect(d!.axis).toBe("requests");
    expect(d!.period).toBe("minute");
    // Staleness took the observation's own reset with it; the derived UTC minute boundary lifts.
    expect(d!.resetsAt).toBe(minuteStart + MINUTE);
    expect(d!.resetsAtBasis).toBe("derived-boundary");

    // Contrast, pinning WHY this gates: the same stale evidence WITHOUT a ledger reading stays
    // inert — the subtraction is first-party only because the limit half was stated.
    const noLedger = createQuotaDemotionFn({ cfg: baseCfg(), breaker: cb });
    expect(noLedger(resolveAttempt(t("a")), now)).toBeNull();
    expect(queried).toBeGreaterThan(0);
  });

  it("remaining > 0 never demotes", () => {
    const now = Date.now();
    const cb = new CircuitBreaker();
    seedObservations(cb, breakerIdentity("a", "m"), [obs({ remaining: 3, observedAt: now })]);
    const fn = createQuotaDemotionFn({ cfg: baseCfg(), breaker: cb });
    expect(fn(resolveAttempt(t("a")), now)).toBeNull();
  });

  it("a derived:configured spend demotes and EXPIRES at the next minute boundary (fake clock)", () => {
    const minuteStart = Math.floor(Date.now() / MINUTE) * MINUTE;
    const now = minuteStart + 30_000;
    const cfg = baseCfg({}, { limits: { rpm: 2 } });
    let queried = 0;
    const fn = createQuotaDemotionFn({
      cfg,
      breaker: new CircuitBreaker(),
      accounting: {
        // Period-aware stub: 2 requests THIS minute, none afterwards — so the demotion must lift
        // purely because the clock crossed the boundary, never because anything cleared it.
        usedInWindow: (options) =>
          Math.floor((options.now ?? 0) / MINUTE) === Math.floor(now / MINUTE)
            ? (queried += 1, { requests: 2, tokens: 50, basis: "reported" })
            : { requests: 0, tokens: null, basis: null },
      },
    });
    const d = fn(resolveAttempt(t("a")), now);
    expect(d).not.toBeNull();
    expect(d!.basis).toBe("derived:configured");
    expect(d!.remaining).toBe(0);
    expect(d!.resetsAt).toBe(minuteStart + MINUTE);
    expect(d!.resetsAtBasis).toBe("derived-boundary");
    // Next minute: same stores, same evidence, no spend -> no demotion.
    expect(fn(resolveAttempt(t("a")), minuteStart + MINUTE + 1)).toBeNull();
    expect(queried).toBeGreaterThan(0);
  });

  it("keeps request and token usage separate when both configured buckets share one period", () => {
    const now = Math.floor(Date.now() / MINUTE) * MINUTE + 30_000;
    let queried = 0;
    const fn = createQuotaDemotionFn({
      cfg: baseCfg({}, { limits: { rpm: 1_000, tpm: 100 } }),
      breaker: new CircuitBreaker(),
      accounting: {
        usedInWindow: () => {
          queried += 1;
          return { requests: 1, tokens: 100, basis: "reported" };
        },
      },
    });

    expect(fn(resolveAttempt(t("a")), now)).toMatchObject({
      axis: "tokens",
      period: "minute",
      remaining: 0,
      basis: "derived:configured",
    });
    // The raw window serves both axis projections; the request-path bound stays one read/period.
    expect(queried).toBe(1);
  });

  it("a LEARNED limit has no effect by default and demotes only under enforceLearned", () => {
    const now = Date.now();
    recordObservedRateLimit("a", makeCredentialId("a"), "m", { axis: "tokens", period: "minute", limit: 100 }, { now });
    const accounting = {
      usedInWindow: () => ({ requests: 1, tokens: 100, basis: "reported" as const }),
    };
    const off = createQuotaDemotionFn({ cfg: baseCfg(), breaker: new CircuitBreaker(), accounting });
    expect(off(resolveAttempt(t("a")), now)).toBeNull();

    const on = createQuotaDemotionFn({
      cfg: baseCfg({ quota: { enforceLearned: true } }),
      breaker: new CircuitBreaker(),
      accounting,
    });
    const d = on(resolveAttempt(t("a")), now);
    expect(d).not.toBeNull();
    expect(d!.basis).toBe("derived:learned");
    expect(d!.axis).toBe("tokens");
    expect(d!.period).toBe("minute");
    // Learned ceilings have no stated reset; the derived UTC minute boundary is the lift time.
    expect(d!.resetsAtBasis).toBe("derived-boundary");
  });

  it("unknown everywhere yields null and leaves the walk order byte-for-byte alone", () => {
    const fn = createQuotaDemotionFn({ cfg: baseCfg(), breaker: new CircuitBreaker() });
    const attempts = [t("a"), t("b")].map((target) => resolveAttempt(target));
    for (const attempt of attempts) expect(fn(attempt, Date.now())).toBeNull();
    expect(orderByUsability([...attempts], new CircuitBreaker()).map((x) => x.target.provider)).toEqual(["a", "b"]);
  });

  it("an UNKNOWN-period bucket cannot demote — there is no boundary to expire against", () => {
    const now = Date.now();
    const cb = new CircuitBreaker();
    seedObservations(cb, breakerIdentity("a", "m"), [obs({ period: "unknown", remaining: 0, observedAt: now })]);
    const fn = createQuotaDemotionFn({ cfg: baseCfg(), breaker: cb });
    expect(fn(resolveAttempt(t("a")), now)).toBeNull();
  });

  it("enforce: false disables the term outright, learned included", () => {
    const now = Date.now();
    const cb = new CircuitBreaker();
    seedObservations(cb, breakerIdentity("a", "m"), [obs({ remaining: 0, resetsAt: now + 30_000, observedAt: now })]);
    const fn = createQuotaDemotionFn({ cfg: baseCfg({ quota: { enforce: false, enforceLearned: true } }), breaker: cb });
    expect(fn(resolveAttempt(t("a")), now)).toBeNull();
  });
});

describe("breaker quota cooldown — visible, self-expiring, never health data", () => {
  it("registers source 'quota', touches no failure counter, expires on its own", () => {
    const cb = new CircuitBreaker();
    const id = breakerIdentity("a", "m");
    cb.recordQuotaCooldown(id, 5_000, 1_000);
    expect(cb.isHealthy(id, 1_000)).toBe(false);
    const state = cb.getState(id)!;
    expect(state.cooldownSource).toBe("quota");
    expect(state.cooldownUntil).toBe(5_000);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastStatus).toBeUndefined();
    expect(cb.hasCredentialFault(id, 1_000)).toBe(false);
    // Lifts by itself at expiry — no success needed, nothing to clear.
    expect(cb.isHealthy(id, 5_001)).toBe(true);
  });

  it("declines a past or non-finite reset rather than inventing a duration", () => {
    const cb = new CircuitBreaker();
    const id = breakerIdentity("a", "m");
    cb.recordQuotaCooldown(id, Number.NaN, 1_000);
    cb.recordQuotaCooldown(id, 500, 1_000);
    expect(cb.isHealthy(id, 1_000)).toBe(true);
    expect(cb.getState(id)).toBeUndefined();
  });

  it("any success clears it through the ordinary path; a longer standing cooldown wins", () => {
    const cb = new CircuitBreaker();
    const id = breakerIdentity("a", "m");
    cb.recordOutcome(id, { ok: false, status: 429, elapsedMs: 1, at: 1_000, retryAfterMs: 60_000 });
    const standingUntil = cb.getState(id)!.cooldownUntil;
    expect(standingUntil).toBeGreaterThan(1_000);
    // A quota demotion never SHORTENS someone else's cooldown...
    cb.recordQuotaCooldown(id, 2_000, 1_100);
    expect(cb.getState(id)!.cooldownUntil).toBe(standingUntil);
    expect(cb.getState(id)!.cooldownSource).not.toBe("quota");
    // ...and a success clears whichever is standing, exactly as for every other source.
    cb.recordOutcome(id, { ok: true, elapsedMs: 1, at: 1_200 });
    expect(cb.isHealthy(id, 1_200)).toBe(true);
    expect(cb.getState(id)!.cooldownSource).toBeNull();
  });
});

describe("ordering — quota demotes into the cooling band, never drops", () => {
  it("a quota-cooled candidate sinks behind live members and is still present", () => {
    const now = Date.now();
    const cb = new CircuitBreaker();
    cb.recordQuotaCooldown(breakerIdentity("a", "m"), now + 30_000, now);
    const out = orderByUsability([t("a"), t("b")].map((target) => resolveAttempt(target)), cb, now);
    expect(out.map((x) => x.target.provider)).toEqual(["b", "a"]);
    expect(out).toHaveLength(2);
  });

  it("a pool whose EVERY member is quota-cooled keeps its full depth and its order", () => {
    const now = Date.now();
    const cb = new CircuitBreaker();
    cb.recordQuotaCooldown(breakerIdentity("a", "m"), now + 30_000, now);
    cb.recordQuotaCooldown(breakerIdentity("b", "m"), now + 30_000, now);
    const attempts = [t("a"), t("b")].map((target) => resolveAttempt(target));
    const out = orderByUsability(attempts, cb, now);
    expect(out.map((x) => x.target.provider)).toEqual(["a", "b"]); // stable within the band
    expect(out).toHaveLength(2); // demote, never drop
  });
});

describe("/candidates exposes the quota cooldown with its source", () => {
  it("renders breaker source 'quota' un-blended, with no score anywhere", async () => {
    const now = Date.now();
    const cb = new CircuitBreaker();
    cb.recordQuotaCooldown(breakerIdentity("a", "m"), now + 30_000, now);
    const view = await buildCandidates(
      baseCfg({ pools: { coding: ["a/m", "b/m"] } }),
      { breaker: cb, tierData: null, nowMs: now },
    );
    const row = view.candidates.find((c) => c.provider === "a");
    expect(row).toBeDefined();
    expect(row!.breaker.cooldownSource).toBe("quota");
    expect(row!.breaker.open).toBe(true);
    expect(row!.breaker.consecutiveFailures).toBe(0);
    const json = JSON.stringify(view);
    expect(json).not.toContain('"score"');
    expect(json).not.toContain('"rank"');
  });
});

// ── End to end: both fronts ─────────────────────────────────────────────────────────────────────

const servers: Server[] = [];
function track(s: Server): Server {
  servers.push(s);
  return s;
}

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

/** A backend whose responses are scripted per call number. */
function scripted(
  reply: (n: number) => { status?: number; headers?: Record<string, string>; body: string },
): Promise<{ server: Server; calls: () => number }> {
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
    s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n }));
  });
}

/**
 * The wire form of "this deployment is out of requests this minute, back in 30s": a complete
 * limit/remaining pair plus a reset, i.e. everything `extractQuotaObservations` requires before
 * it will believe a header.
 */
const SPENT_HEADERS = {
  "x-ratelimit-limit-requests-minute": "10",
  "x-ratelimit-remaining-requests-minute": "0",
  "x-ratelimit-reset-requests-minute": "30s",
};

function okBody(kind: "anthropic" | "openai", model: string): string {
  return kind === "anthropic"
    ? JSON.stringify({ id: "msg", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })
    : JSON.stringify({ id: "cmpl", object: "chat.completion", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
}

function startProxy(c: Config, deps: ProxyDeps = {}): Promise<Server> {
  const s = createProxy(c, { catalog: new ModelCatalog({ cachePath: null }), breaker: globalCircuitBreaker, ...deps });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(track(s))));
}

function poolCfg(bases: string[], kind: "anthropic" | "openai"): Config {
  const providers: Record<string, ProviderConfig> = {};
  bases.forEach((base, i) => {
    providers[`p${i + 1}`] = { base, kind, authHeader: "authorization", timeoutMs: 5000 };
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

async function post(p: number, kind: "anthropic" | "openai"): Promise<Response> {
  const path = kind === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const body =
    kind === "anthropic"
      ? { model: "pool/coding", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }
      : { model: "pool/coding", messages: [{ role: "user", content: "hi" }] };
  return fetch(`http://127.0.0.1:${p}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Gap 12 end to end — both fronts", () => {
  beforeEach(() => {
    globalCircuitBreaker.reset();
    resetFacts();
    resetInterpretations();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    globalCircuitBreaker.reset();
    resetFacts();
    resetInterpretations();
  });

  // The demotion is driven by what the deployment STATED on its own successful response, so the
  // natural sequence is: request 1 teaches the relay candidate 1 is spent; request 2 must lead
  // with candidate 2 and say why.
  it.each(["anthropic", "openai"] as const)(
    "a fresh provider-stated remaining 0 demotes candidate 1 behind candidate 2 (%s front)",
    async (kind) => {
      const a = await scripted(() => ({ headers: SPENT_HEADERS, body: okBody(kind, "m1") }));
      const b = await scripted(() => ({ body: okBody(kind, "m2") }));
      const p = port(await startProxy(poolCfg([
        `http://127.0.0.1:${port(a.server)}`,
        `http://127.0.0.1:${port(b.server)}`,
      ], kind)));

      const first = await post(p, kind);
      expect(first.status).toBe(200);
      await first.text();
      expect(first.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");

      const second = await post(p, kind);
      expect(second.status).toBe(200);
      await second.text();
      // Candidate 2 led...
      expect(second.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
      // ...and the displacement is announced with its basis, bounded and metadata-only.
      expect(second.headers.get(QUOTA_DEMOTED_HEADER)).toBe("p1/m1 (requests/minute remaining 0, provider-stated)");
      expect(a.calls()).toBe(1); // the demoted member was NOT re-tried ahead of the live one
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "the demoted candidate is still reachable when the pool needs it — demote, never drop (%s front)",
    async (kind) => {
      const a = await scripted(() => ({ headers: SPENT_HEADERS, body: okBody(kind, "m1") }));
      // Always failing: request 2 must walk p2 (500) and then come BACK to the demoted p1.
      const b = await scripted(() => ({ status: 500, body: JSON.stringify({ error: { message: "boom" } }) }));
      const p = port(await startProxy(poolCfg([
        `http://127.0.0.1:${port(a.server)}`,
        `http://127.0.0.1:${port(b.server)}`,
      ], kind)));

      const first = await post(p, kind);
      expect(first.status).toBe(200);
      await first.text();
      expect(first.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");

      const second = await post(p, kind);
      expect(second.status).toBe(200);
      await second.text();
      // Walked p2 (500), then RETURNED to the demoted p1 — the cooling band is reached, not
      // deleted. A success SERVED_BY names only the winner; the walk is in pool-attempts.
      expect(second.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");
      expect(second.headers.get(QUOTA_DEMOTED_HEADER)).toBe("p1/m1 (requests/minute remaining 0, provider-stated)");
      expect(a.calls()).toBe(2);
      expect(b.calls()).toBe(1);
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "every candidate quota-spent still serves, and displaces nothing worth announcing (%s front)",
    async (kind) => {
      const a = await scripted(() => ({ headers: SPENT_HEADERS, body: okBody(kind, "m1") }));
      const b = await scripted(() => ({ headers: SPENT_HEADERS, body: okBody(kind, "m2") }));
      const p = port(await startProxy(poolCfg([
        `http://127.0.0.1:${port(a.server)}`,
        `http://127.0.0.1:${port(b.server)}`,
      ], kind)));

      const first = await post(p, kind);
      expect(first.status).toBe(200);
      await first.text();
      expect(first.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");

      // Request 2: p1 is taught-and-spent, p2 has said nothing yet — so p2 leads and, by
      // answering, states ITS OWN remaining 0.
      const second = await post(p, kind);
      expect(second.status).toBe(200);
      await second.text();
      expect(second.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
      expect(second.headers.get(QUOTA_DEMOTED_HEADER)).toBe("p1/m1 (requests/minute remaining 0, provider-stated)");

      // Request 3: BOTH cells are now spent. The whole pool sits in the cooling band together,
      // the ranked first choice still leads, so nothing is announced and nothing was taken from
      // the caller — demote never drop, measured at the wire.
      const third = await post(p, kind);
      expect(third.status).toBe(200);
      await third.text();
      expect(third.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");
      expect(third.headers.get(QUOTA_DEMOTED_HEADER)).toBeNull();
    },
  );
});

// ── Config surface ───────────────────────────────────────────────────────────────────────────────

describe("routing.quota config block", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-quota-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function write(name: string, obj: unknown): string {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(obj));
    return p;
  }
  function base(extra: Record<string, unknown> = {}) {
    return {
      listen: "127.0.0.1:8791",
      providers: { nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" } },
      routing: { default: "nim/z-ai/glm-5.2" },
      ...extra,
    };
  }

  it("is absent by default, accepts the explicit defaults, and round-trips both flags", () => {
    expect(loadConfig(write("q-absent.json", base())).routing.quota).toBeUndefined();
    expect(loadConfig(write("q-empty.json", base({ routing: { default: "nim/z-ai/glm-5.2", quota: {} } }))).routing.quota).toEqual({});
    expect(loadConfig(write("q-off.json", base({ routing: { default: "nim/z-ai/glm-5.2", quota: { enforce: false } } }))).routing.quota).toEqual({ enforce: false });
    expect(loadConfig(write("q-learned.json", base({ routing: { default: "nim/z-ai/glm-5.2", quota: { enforceLearned: true } } }))).routing.quota).toEqual({ enforceLearned: true });
  });

  it("rejects malformed blocks loudly instead of silently ignoring them", () => {
    expect(() => loadConfig(write("q-array.json", base({ routing: { default: "nim/z-ai/glm-5.2", quota: [] } })))).toThrow(/must be an object/);
    expect(() => loadConfig(write("q-str.json", base({ routing: { default: "nim/z-ai/glm-5.2", quota: { enforce: "yes" } } })))).toThrow(/enforce must be a boolean/);
    expect(() => loadConfig(write("q-l.json", base({ routing: { default: "nim/z-ai/glm-5.2", quota: { enforceLearned: 1 } } })))).toThrow(/enforceLearned must be a boolean/);
  });
});
