import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createProxy, type ProxyDeps } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import {
  ATTEMPT_START_WINDOW_MS,
  CircuitBreaker,
  MAX_ATTEMPT_STARTS,
  globalCircuitBreaker,
} from "../src/circuit-breaker.js";
import { PACED_HEADER, SERVED_BY_HEADER, POOL_ATTEMPTS_HEADER } from "../src/backend.js";
import {
  PACING_WINDOW_MS,
  createPacingFn,
  pacingLabel,
  resolvePacing,
  resolvePacingSettings,
  type PacingFn,
  type PacingVerdict,
} from "../src/pacing.js";
import { orderByUsability, targetUsability, applyStickyOrdering, orderDeploymentGroupsByUsability } from "../src/candidate-runner.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import { observedRateLimits, recordObservedRateLimit } from "../src/rate-limits.js";
import { makeCredentialId } from "../src/credential-id.js";
import { resolveAttempt, type ResolvedAttempt } from "../src/resolved-attempt.js";
import type { Config, ProviderConfig, ResolvedTarget } from "../src/config.js";
import type { ProviderTargetIdentity } from "../src/kernel/contracts.js";
import type { QuotaObservation } from "../src/quota-observation.js";

/**
 * Self-pacing against a STATED rate limit (`src/pacing.ts`, owner direction 2026-09-10).
 *
 * Pinned most-specific-first: the breaker's attempt-start log (the dataset), the pure resolver's
 * gates (stated/configured/learned pace; published never; unknown has NO effect; disabled is
 * inert), the band's place in the walk order, and the end-to-end behaviour on BOTH fronts
 * including the announcement header and the live 429-body update. Every multi-candidate
 * scenario uses >= 2 candidates — with one, "steps aside" and "cannot step aside" are the same
 * observation — and one single-candidate scenario pins that a paced member is still SERVED.
 */

const MINUTE = 60_000;

function identity(provider: string, model: string | null = "m", kind: "anthropic" | "openai" = "openai"): ProviderTargetIdentity {
  return { provider, model, kind, credentialId: makeCredentialId(provider) };
}

const t = (n: string, model = "m"): ResolvedTarget => ({
  provider: n,
  base: `http://${n}`,
  kind: "openai",
  model,
  authHeader: "authorization",
  timeoutMs: 1000,
});

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
    routing: { default: "a/m", tiers: {}, benchmarkSort: false, ...routingExtra },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

/** Start `n` attempts against a cell at `at`, each carrying `tokens` as its input estimate. */
function startAttempts(cb: CircuitBreaker, target: ProviderTargetIdentity, n: number, at: number, tokens: number | null = 10): void {
  for (let i = 0; i < n; i++) {
    const begun = cb.beginAttempt(target, { at, estimatedInputTokens: tokens });
    if (!begun.ok) throw new Error(begun.error.kind);
  }
}

function obs(over: Partial<QuotaObservation>): QuotaObservation {
  return {
    axis: "requests",
    period: "minute",
    limit: 60,
    remaining: 30,
    resetsAt: null,
    observedAt: Date.now(),
    basis: "provider-stated",
    ...over,
  };
}

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

describe("CircuitBreaker.attemptsInWindow — the per-cell attempt-start log", () => {
  it("counts starts inside the trailing window and nothing older, per exact cell", () => {
    const cb = new CircuitBreaker();
    const now = 10 * MINUTE;
    startAttempts(cb, identity("a"), 2, now - 2 * MINUTE); // outside a one-minute window
    startAttempts(cb, identity("a"), 3, now - 30_000);
    startAttempts(cb, identity("b"), 5, now - 1_000); // a sibling cell
    expect(cb.attemptsInWindow(identity("a"), MINUTE, now)).toEqual({ requests: 3, estimatedInputTokens: 30, saturated: false });
    expect(cb.attemptsInWindow(identity("a"), 5 * MINUTE, now)).toEqual({ requests: 5, estimatedInputTokens: 50, saturated: false });
    expect(cb.attemptsInWindow(identity("b"), MINUTE, now).requests).toBe(5);
    // A start exactly at the window's far edge is OUTSIDE it (`at <= since`).
    expect(cb.attemptsInWindow(identity("a"), 30_000, now).requests).toBe(0);
  });

  it("an unknown cell, a zero window and a fresh reset all read as no attempts", () => {
    const cb = new CircuitBreaker();
    expect(cb.attemptsInWindow(identity("nobody"), MINUTE, MINUTE)).toEqual({ requests: 0, estimatedInputTokens: 0, saturated: false });
    startAttempts(cb, identity("a"), 4, MINUTE);
    expect(cb.attemptsInWindow(identity("a"), 0, MINUTE).requests).toBe(0);
    cb.reset();
    expect(cb.attemptsInWindow(identity("a"), MINUTE, MINUTE).requests).toBe(0);
  });

  it("a start with NO input estimate makes the window's token sum unknown, never zero", () => {
    const cb = new CircuitBreaker();
    const now = MINUTE;
    startAttempts(cb, identity("a"), 2, now - 1_000, 100);
    startAttempts(cb, identity("a"), 1, now - 500, null);
    const window = cb.attemptsInWindow(identity("a"), MINUTE, now);
    expect(window.requests).toBe(3);
    expect(window.estimatedInputTokens).toBeNull();
    // A negative or non-finite estimate is treated as no estimate — not as a number.
    startAttempts(cb, identity("c"), 1, now - 500, -5);
    expect(cb.attemptsInWindow(identity("c"), MINUTE, now).estimatedInputTokens).toBeNull();
  });

  it("creates NO health state — the log is pacing's dataset, not a CircuitState cell", () => {
    // `test/closed-vocabulary-routing.test.ts` pins that a relay-local fault creates no provider
    // health state; that holds only if beginning an attempt creates none either.
    const cb = new CircuitBreaker();
    startAttempts(cb, identity("a"), 1, MINUTE);
    expect(cb.getState(identity("a"))).toBeUndefined();
    expect([...cb.getAllStates()]).toHaveLength(0);
    expect(cb.exportState()).toEqual([]);
  });

  it("prunes starts older than the widest window and caps the log, reporting saturation", () => {
    const cb = new CircuitBreaker();
    const day0 = 10 * ATTEMPT_START_WINDOW_MS;
    startAttempts(cb, identity("a"), 3, day0 - ATTEMPT_START_WINDOW_MS - 1);
    startAttempts(cb, identity("a"), 1, day0);
    // The three ancient starts fell off at the append; only today's remains anywhere.
    expect(cb.attemptsInWindow(identity("a"), ATTEMPT_START_WINDOW_MS, day0).requests).toBe(1);

    const full = new CircuitBreaker();
    startAttempts(full, identity("a"), MAX_ATTEMPT_STARTS + 50, day0);
    const window = full.attemptsInWindow(identity("a"), MINUTE, day0);
    expect(window.requests).toBe(MAX_ATTEMPT_STARTS);
    expect(window.saturated).toBe(true);
    // Once older entries leave the window the retained count is exact again and not saturated.
    expect(full.attemptsInWindow(identity("a"), MINUTE, day0 + MINUTE + 1).saturated).toBe(false);
  });

  it("beginAttempt without a start option still logs the attempt, at the wall clock", () => {
    const cb = new CircuitBreaker();
    const before = Date.now();
    const begun = cb.beginAttempt(identity("a"));
    expect(begun.ok).toBe(true);
    expect(cb.attemptsInWindow(identity("a"), MINUTE, Date.now() + 1).requests).toBe(1);
    expect(cb.attemptsInWindow(identity("a"), MINUTE, before - 1).requests).toBe(0);
  });
});

describe("resolvePacing — the gates", () => {
  const now = 100 * MINUTE;
  const attemptFor = (n: string, model = "m"): ResolvedAttempt => resolveAttempt(t(n, model));

  it("defaults ON and normalizes the boolean shorthand", () => {
    expect(resolvePacingSettings(undefined)).toEqual({ enabled: true });
    expect(resolvePacingSettings({})).toEqual({ enabled: true });
    expect(resolvePacingSettings({ enabled: false })).toEqual({ enabled: false });
  });

  it("a LEARNED rpm fact paces at the stated ceiling, without any opt-in", () => {
    const cb = new CircuitBreaker();
    recordObservedRateLimit("a", makeCredentialId("a"), "m", { axis: "requests", period: "minute", limit: 3 }, { now });
    const fn = createPacingFn({ cfg: baseCfg(), breaker: cb });
    startAttempts(cb, identity("a"), 2, now - 10_000);
    expect(fn(attemptFor("a"), now)).toBeNull(); // 2 of 3: under the ceiling
    startAttempts(cb, identity("a"), 1, now - 5_000);
    const verdict = fn(attemptFor("a"), now);
    expect(verdict).toEqual({ axis: "requests", period: "minute", limit: 3, limitBasis: "learned", counted: 3 });
    expect(pacingLabel("a/m", verdict!)).toBe("a/m (requests/minute 3 of 3 in the trailing minute, learned)");
    // The window SLIDES: once the oldest start leaves the trailing minute the cell is back.
    expect(fn(attemptFor("a"), now + 55_001)).toBeNull();
  });

  it("a CONFIGURED limit paces, and outranks a learned figure for the same bucket", () => {
    const cb = new CircuitBreaker();
    const cfg = baseCfg({}, { limits: { rpm: 2 } });
    recordObservedRateLimit("a", makeCredentialId("a"), "m", { axis: "requests", period: "minute", limit: 50 }, { now });
    startAttempts(cb, identity("a"), 2, now - 1_000);
    const verdict = resolvePacing({ cfg, breaker: cb }, attemptFor("a"), now);
    expect(verdict).toEqual({ axis: "requests", period: "minute", limit: 2, limitBasis: "configured", counted: 2 });
  });

  it("a PROVIDER-STATED header limit paces, and outranks configured and learned", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(identity("a"), { ok: true, elapsedMs: 1, quotaObservations: [obs({ limit: 4, remaining: 4, observedAt: now })] });
    const cfg = baseCfg({}, { limits: { rpm: 99 } });
    startAttempts(cb, identity("a"), 4, now - 1_000);
    const verdict = resolvePacing({ cfg, breaker: cb }, attemptFor("a"), now);
    expect(verdict).toEqual({ axis: "requests", period: "minute", limit: 4, limitBasis: "provider-stated", counted: 4 });
  });

  it("does NOT read a header's `remaining` — the rate view counts the relay's own starts only", () => {
    // remaining: 0 is the ALLOWANCE view's business (quota-demotion); pacing with 1 start under a
    // limit of 4 must say nothing, or the two terms would be one policy in two homes.
    const cb = new CircuitBreaker();
    cb.recordOutcome(identity("a"), { ok: true, elapsedMs: 1, quotaObservations: [obs({ limit: 4, remaining: 0, observedAt: now })] });
    startAttempts(cb, identity("a"), 1, now - 1_000);
    expect(resolvePacing({ cfg: baseCfg(), breaker: cb }, attemptFor("a"), now)).toBeNull();
  });

  it("a TOKENS ceiling is held against the window's estimated input tokens", () => {
    const cb = new CircuitBreaker();
    recordObservedRateLimit("a", makeCredentialId("a"), "m", { axis: "tokens", period: "minute", limit: 250 }, { now });
    startAttempts(cb, identity("a"), 2, now - 1_000, 100);
    expect(resolvePacing({ cfg: baseCfg(), breaker: cb }, attemptFor("a"), now)).toBeNull();
    startAttempts(cb, identity("a"), 1, now - 500, 100);
    const verdict = resolvePacing({ cfg: baseCfg(), breaker: cb }, attemptFor("a"), now);
    expect(verdict).toEqual({ axis: "tokens", period: "minute", limit: 250, limitBasis: "learned", counted: 300 });
    expect(pacingLabel("a/m", verdict!)).toBe("a/m (tokens/minute 300 of 250 estimated input tokens in the trailing minute, learned)");
  });

  it("a token window with an unestimated start has NO opinion — unknown is never zero", () => {
    const cb = new CircuitBreaker();
    recordObservedRateLimit("a", makeCredentialId("a"), "m", { axis: "tokens", period: "minute", limit: 10 }, { now });
    startAttempts(cb, identity("a"), 3, now - 1_000, 100);
    startAttempts(cb, identity("a"), 1, now - 500, null);
    expect(resolvePacing({ cfg: baseCfg(), breaker: cb }, attemptFor("a"), now)).toBeNull();
  });

  it("a DAY ceiling reads the trailing day, and requests are checked before tokens, minute before day", () => {
    const cb = new CircuitBreaker();
    recordObservedRateLimit("a", makeCredentialId("a"), "m", [
      { axis: "requests", period: "day", limit: 5 },
      { axis: "tokens", period: "minute", limit: 1 },
    ], { now });
    startAttempts(cb, identity("a"), 5, now - 12 * 60 * MINUTE, 10);
    // Both buckets are at/over their ceiling; the canonical order names requests/day first
    // because requests rank before tokens whatever the period.
    const verdict = resolvePacing({ cfg: baseCfg(), breaker: cb }, attemptFor("a"), now);
    expect(verdict).toMatchObject({ axis: "requests", period: "day", limit: 5, counted: 5 });
    expect(PACING_WINDOW_MS.day).toBe(ATTEMPT_START_WINDOW_MS);
  });

  it("a limit nobody stated has NO effect, however many attempts were started", () => {
    const cb = new CircuitBreaker();
    startAttempts(cb, identity("a"), 500, now - 1_000);
    expect(resolvePacing({ cfg: baseCfg(), breaker: cb }, attemptFor("a"), now)).toBeNull();
  });

  it("a stated ceiling with NO attempts started has no effect either", () => {
    const cb = new CircuitBreaker();
    recordObservedRateLimit("a", makeCredentialId("a"), "m", { axis: "requests", period: "minute", limit: 1 }, { now });
    expect(resolvePacing({ cfg: baseCfg(), breaker: cb }, attemptFor("a"), now)).toBeNull();
  });

  it("a month-period or unknown-period observation never paces", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(identity("a"), {
      ok: true,
      elapsedMs: 1,
      quotaObservations: [
        obs({ period: "month", limit: 1, remaining: 1, observedAt: now }),
        obs({ period: "unknown", limit: 1, remaining: 1, resetsAt: now + MINUTE, observedAt: now }),
      ],
    });
    startAttempts(cb, identity("a"), 10, now - 1_000);
    expect(resolvePacing({ cfg: baseCfg(), breaker: cb }, attemptFor("a"), now)).toBeNull();
  });

  it("a saturated log below the ceiling proves nothing and paces nothing", () => {
    const cb = new CircuitBreaker();
    recordObservedRateLimit("a", makeCredentialId("a"), "m", { axis: "requests", period: "minute", limit: MAX_ATTEMPT_STARTS + 1 }, { now });
    startAttempts(cb, identity("a"), MAX_ATTEMPT_STARTS + 5, now - 1_000);
    expect(cb.attemptsInWindow(identity("a"), MINUTE, now).saturated).toBe(true);
    expect(resolvePacing({ cfg: baseCfg(), breaker: cb }, attemptFor("a"), now)).toBeNull();
  });

  it("a learned fact on a SIBLING credential or model does not pace this cell", () => {
    const cb = new CircuitBreaker();
    recordObservedRateLimit("a", makeCredentialId("a", "work"), "m", { axis: "requests", period: "minute", limit: 1 }, { now });
    recordObservedRateLimit("a", makeCredentialId("a"), "other", { axis: "requests", period: "minute", limit: 1 }, { now });
    startAttempts(cb, identity("a"), 5, now - 1_000);
    expect(resolvePacing({ cfg: baseCfg(), breaker: cb }, attemptFor("a"), now)).toBeNull();
  });

  it("an ACCOUNT-worded learned limit covers every model on the credential", () => {
    const cb = new CircuitBreaker();
    recordObservedRateLimit("a", makeCredentialId("a"), "m", { axis: "requests", period: "minute", limit: 1, accountWording: true }, { now });
    startAttempts(cb, identity("a", "other"), 1, now - 1_000);
    expect(resolvePacing({ cfg: baseCfg(), breaker: cb }, attemptFor("a", "other"), now)).toMatchObject({ limit: 1, counted: 1 });
  });

  it("is inert when disabled, and measures nothing for a model-less target", () => {
    const cb = new CircuitBreaker();
    recordObservedRateLimit("a", makeCredentialId("a"), "m", { axis: "requests", period: "minute", limit: 1 }, { now });
    startAttempts(cb, identity("a"), 5, now - 1_000);
    expect(resolvePacing({ cfg: baseCfg(), breaker: cb, settings: { enabled: false } }, attemptFor("a"), now)).toBeNull();
    const noModel = resolveAttempt({ provider: "a", base: "http://a", kind: "anthropic", authHeader: "x-api-key", timeoutMs: 1000 });
    expect(resolvePacing({ cfg: baseCfg(), breaker: cb }, noModel, now)).toBeNull();
  });

  it("createPacingFn degrades to no opinion when a dependency throws", () => {
    const fn = createPacingFn({
      cfg: baseCfg(),
      breaker: {
        getState: () => { throw new Error("boom"); },
        attemptsInWindow: () => { throw new Error("boom"); },
      },
    });
    expect(fn(attemptFor("a"), now)).toBeNull();
  });
});

describe("targetUsability and the walk order — the paced band", () => {
  const now = 100 * MINUTE;
  const pacingFlagging = (...providers: string[]): PacingFn => {
    const verdict: PacingVerdict = { axis: "requests", period: "minute", limit: 1, limitBasis: "learned", counted: 1 };
    return (attempt) => (providers.includes(attempt.target.provider) ? { ...verdict } : null);
  };

  it("reports paced for a member at its ceiling", () => {
    expect(targetUsability(resolveAttempt(t("a")), new CircuitBreaker(), now, null, null, null, null, pacingFlagging("a"))).toBe("paced");
  });

  it("cooling and credential-fault outrank paced; paced outranks slow and probation", () => {
    const cooling = new CircuitBreaker();
    cooling.recordOutcome(identity("a"), { ok: false, status: 429, elapsedMs: 5, at: now });
    expect(targetUsability(resolveAttempt(t("a")), cooling, now, null, null, null, null, pacingFlagging("a"))).toBe("cooling");
    const faulted = new CircuitBreaker();
    faulted.recordCredentialFault(identity("a"), 401, now);
    expect(targetUsability(resolveAttempt(t("a")), faulted, now, null, null, null, null, pacingFlagging("a"))).toBe("credential-fault");
    const slow = () => ({ basis: "absolute" as const, measured: 99_999, threshold: 1000, samples: 9 });
    const probation = () => ({ samples: 0, minSamples: 5 });
    expect(targetUsability(resolveAttempt(t("a")), new CircuitBreaker(), now, null, null, slow, probation, pacingFlagging("a"))).toBe("paced");
  });

  it("orders the full band sequence probation → live → slow → paced → credential-fault → cooling", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(identity("cool"), { ok: false, status: 429, elapsedMs: 5, at: now });
    cb.recordCredentialFault(identity("fault"), 401, now);
    const slow = (attempt: ResolvedAttempt) =>
      attempt.target.provider === "slow" ? { basis: "absolute" as const, measured: 99_999, threshold: 1000, samples: 9 } : null;
    const probation = (attempt: ResolvedAttempt) => (attempt.target.provider === "prob" ? { samples: 0, minSamples: 5 } : null);
    const attempts = [t("paced"), t("cool"), t("fault"), t("slow"), t("live"), t("prob")].map((tg) => resolveAttempt(tg));
    const out = orderByUsability(attempts, cb, now, null, null, slow, probation, pacingFlagging("paced"));
    expect(out.map((x) => x.target.provider)).toEqual(["prob", "live", "slow", "paced", "fault", "cool"]);
    expect(out).toHaveLength(6); // nothing dropped
  });

  it("announces the displaced FIRST choice, and only when pacing displaced it", () => {
    const attempts = [t("a"), t("b")].map((tg) => resolveAttempt(tg));
    const paced = orderDeploymentGroupsByUsability(attempts, new CircuitBreaker(), now, null, null, null, null, pacingFlagging("a"));
    expect(paced.ordered.map((x) => x.target.provider)).toEqual(["b", "a"]);
    expect(paced.pacedFirst).toBe("a/m (requests/minute 1 of 1 in the trailing minute, learned)");
    // The second member paced: the leader is unchanged, so there is nothing to announce.
    const secondPaced = orderDeploymentGroupsByUsability(attempts, new CircuitBreaker(), now, null, null, null, null, pacingFlagging("b"));
    expect(secondPaced.ordered.map((x) => x.target.provider)).toEqual(["a", "b"]);
    expect(secondPaced.pacedFirst).toBeNull();
    // No evaluator at all: today's order, no announcement.
    expect(orderDeploymentGroupsByUsability(attempts, new CircuitBreaker(), now).pacedFirst).toBeNull();
  });

  it("a sticky pin never promotes a paced member", () => {
    const attempts = [t("b"), t("a")].map((tg) => resolveAttempt(tg));
    const pinned = applyStickyOrdering(attempts, "a/m", new CircuitBreaker(), null, now, null, null, null, null, pacingFlagging("a"));
    expect(pinned.status).toBe("bypassed: paced");
    expect(pinned.targets.map((x) => x.target.provider)).toEqual(["b", "a"]);
  });

  it("disabled pacing yields today's order exactly — byte for byte", () => {
    const cb = new CircuitBreaker();
    recordObservedRateLimit("a", makeCredentialId("a"), "m", { axis: "requests", period: "minute", limit: 1 }, { now });
    startAttempts(cb, identity("a"), 1, now - 1_000);
    const fixture = [t("a"), t("b")].map((tg) => resolveAttempt(tg));
    const today = orderByUsability(fixture, cb, now).map((x) => x.target.provider);
    const off = createPacingFn({ cfg: baseCfg(), breaker: cb, settings: { enabled: false } });
    expect(orderByUsability(fixture, cb, now, null, null, null, null, off).map((x) => x.target.provider)).toEqual(today);
    expect(today).toEqual(["a", "b"]);
    const on = createPacingFn({ cfg: baseCfg(), breaker: cb });
    expect(orderByUsability(fixture, cb, now, null, null, null, null, on).map((x) => x.target.provider)).toEqual(["b", "a"]);
  });
});

// ── End to end, both fronts ──────────────────────────────────────────────────────────────────────

const servers: Server[] = [];
function track(s: Server): Server {
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

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

const OK_BODY = JSON.stringify({
  id: "cmpl_ok",
  object: "chat.completion",
  choices: [{ message: { role: "assistant", content: "served" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
});

/** A pool of openai-kind members in CONFIG order (`benchmarkSort: false`), tagged per test. */
function poolCfg(tag: string, bases: string[], routingExtra: Record<string, unknown> = {}): { cfg: Config; specs: string[] } {
  const providers: Record<string, ProviderConfig> = {};
  const specs: string[] = [];
  bases.forEach((base, i) => {
    const provider = `pc${tag}${i + 1}`;
    providers[provider] = { base, kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
    specs.push(`${provider}/m${i + 1}`);
  });
  return {
    cfg: {
      host: "127.0.0.1",
      port: 0,
      providers,
      routing: { default: "pool/paced", tiers: {}, benchmarkSort: false, pools: { paced: specs }, ...routingExtra },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    },
    specs,
  };
}

function startProxy(c: Config, deps: ProxyDeps = {}): Promise<Server> {
  const s = createProxy(c, { catalog: new ModelCatalog({ cachePath: null }), breaker: globalCircuitBreaker, ...deps });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(track(s))));
}

const chat = (p: number) =>
  fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "pool/paced", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
  });
const messages = (p: number) =>
  fetch(`http://127.0.0.1:${p}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "pool/paced", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
  });

function learnRpm(spec: string, limit: number): void {
  const [provider, model] = spec.split("/") as [string, string];
  recordObservedRateLimit(provider, makeCredentialId(provider), model, { axis: "requests", period: "minute", limit });
}

describe("pacing end to end — both fronts", () => {
  it.each([
    { name: "Anthropic", request: messages },
    { name: "OpenAI", request: chat },
  ])("$name front: the second request within the minute steps to the next member, announced", async ({ request }) => {
    const first = await scripted(() => ({ body: OK_BODY }));
    const second = await scripted(() => ({ body: OK_BODY }));
    const { cfg, specs } = poolCfg("a", [`http://127.0.0.1:${port(first.server)}`, `http://127.0.0.1:${port(second.server)}`]);
    learnRpm(specs[0]!, 1);
    const p = port(await startProxy(cfg));

    const r1 = await request(p);
    expect(r1.status).toBe(200);
    await r1.text();
    expect(r1.headers.get(SERVED_BY_HEADER)).toBe(specs[0]);
    expect(r1.headers.get(PACED_HEADER)).toBeNull();

    const r2 = await request(p);
    expect(r2.status).toBe(200);
    await r2.text();
    expect(r2.headers.get(SERVED_BY_HEADER)).toBe(specs[1]);
    expect(r2.headers.get(PACED_HEADER)).toBe(`${specs[0]} (requests/minute 1 of 1 in the trailing minute, learned)`);
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(1);
  });

  it("the window is SHARED across fronts: a Chat request fills it and a Messages request is paced", async () => {
    // "across every client that routes through the relay": one cell, one log, whichever front.
    const first = await scripted(() => ({ body: OK_BODY }));
    const second = await scripted(() => ({ body: OK_BODY }));
    const { cfg, specs } = poolCfg("b", [`http://127.0.0.1:${port(first.server)}`, `http://127.0.0.1:${port(second.server)}`]);
    learnRpm(specs[0]!, 1);
    const p = port(await startProxy(cfg));
    await (await chat(p)).text();
    const r = await messages(p);
    await r.text();
    expect(r.headers.get(SERVED_BY_HEADER)).toBe(specs[1]);
    expect(r.headers.get(PACED_HEADER)).toContain(specs[0]!);
  });

  it("a paced member with NO alternative is still served — pacing never refuses", async () => {
    const only = await scripted(() => ({ body: OK_BODY }));
    const { cfg, specs } = poolCfg("c", [`http://127.0.0.1:${port(only.server)}`]);
    learnRpm(specs[0]!, 1);
    const p = port(await startProxy(cfg));
    for (let i = 0; i < 3; i++) {
      const r = await messages(p);
      expect(r.status).toBe(200);
      await r.text();
      expect(r.headers.get(SERVED_BY_HEADER)).toBe(specs[0]);
      // The leader IS the only member, so nothing displaced it and nothing is announced.
      expect(r.headers.get(PACED_HEADER)).toBeNull();
    }
    expect(only.calls()).toBe(3);
  });

  it("routing.pacing { enabled: false } yields today's order exactly — no reorder, no header", async () => {
    const first = await scripted(() => ({ body: OK_BODY }));
    const second = await scripted(() => ({ body: OK_BODY }));
    // Normalized form, exactly what `parseRouting` produces for `"pacing": false`.
    const { cfg, specs } = poolCfg("d", [`http://127.0.0.1:${port(first.server)}`, `http://127.0.0.1:${port(second.server)}`], {
      pacing: { enabled: false },
    });
    learnRpm(specs[0]!, 1);
    const p = port(await startProxy(cfg));
    for (let i = 0; i < 2; i++) {
      const r = await chat(p);
      await r.text();
      expect(r.headers.get(SERVED_BY_HEADER)).toBe(specs[0]);
      expect(r.headers.get(PACED_HEADER)).toBeNull();
    }
    expect(second.calls()).toBe(0);
  });

  it("a stated TOKENS ceiling paces on the request's input estimate", async () => {
    const first = await scripted(() => ({ body: OK_BODY }));
    const second = await scripted(() => ({ body: OK_BODY }));
    const { cfg, specs } = poolCfg("e", [`http://127.0.0.1:${port(first.server)}`, `http://127.0.0.1:${port(second.server)}`]);
    const [provider, model] = specs[0]!.split("/") as [string, string];
    // "hi" estimates to a handful of tokens; a ceiling of 1 is crossed by the first request.
    recordObservedRateLimit(provider, makeCredentialId(provider), model, { axis: "tokens", period: "minute", limit: 1 });
    const p = port(await startProxy(cfg));
    await (await messages(p)).text();
    const r = await messages(p);
    await r.text();
    expect(r.headers.get(SERVED_BY_HEADER)).toBe(specs[1]);
    expect(r.headers.get(PACED_HEADER)).toMatch(new RegExp(`^${specs[0]} \\(tokens/minute \\d+ of 1 estimated input tokens in the trailing minute, learned\\)$`));
  });

  it("a 429 whose BODY states a window updates pacing live, with no human verdict", async () => {
    // Sub-property 2. The first member 429s once with a stated ceiling; the relay fails over to
    // the second member AND, from that body alone, the pacing term now holds the first member to
    // that ceiling — no `llm-relay eligibility accept` in between. The breaker's own 429 cooldown
    // also demotes the member, so the fact and the verdict are asserted directly rather than
    // through the walk order, where the two would be indistinguishable.
    const flaky = await scripted((n) =>
      n === 1
        ? { status: 429, body: JSON.stringify({ error: { message: "Rate limit reached: limit 1 requests per minute for this model" } }) }
        : { body: OK_BODY });
    const steady = await scripted(() => ({ body: OK_BODY }));
    const { cfg, specs } = poolCfg("f", [`http://127.0.0.1:${port(flaky.server)}`, `http://127.0.0.1:${port(steady.server)}`]);
    const [provider, model] = specs[0]!.split("/") as [string, string];
    expect(observedRateLimits(provider, makeCredentialId(provider), model)).toEqual([]);
    const p = port(await startProxy(cfg));

    const r = await chat(p);
    expect(r.status).toBe(200);
    await r.text();
    expect(r.headers.get(SERVED_BY_HEADER)).toBe(specs[1]);
    expect(r.headers.get(POOL_ATTEMPTS_HEADER)).toContain("2 tried");

    expect(observedRateLimits(provider, makeCredentialId(provider), model)).toMatchObject([
      { axis: "requests", period: "minute", limit: 1, basis: "learned" },
    ]);
    // Live: the same evaluator the proxy built reads the fact on its next call. The one attempt
    // the walk started against the flaky member is the count that meets the ceiling of 1.
    const fn = createPacingFn({ cfg, breaker: globalCircuitBreaker });
    const attempt = resolveAttempt({ provider, base: cfg.providers[provider]!.base, kind: "openai", model, authHeader: "authorization", timeoutMs: 5000 });
    expect(fn(attempt, Date.now())).toEqual({ axis: "requests", period: "minute", limit: 1, limitBasis: "learned", counted: 1 });
  });
});
