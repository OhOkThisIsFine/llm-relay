import { describe, it, expect } from "vitest";
import { CircuitBreaker, failureCooldown } from "../src/circuit-breaker.js";
import type { ProviderTargetIdentity } from "../src/kernel/contracts.js";

describe("CircuitBreaker", () => {
  const targetA: ProviderTargetIdentity = {
    provider: "nim",
    credentialId: "nim#default",
    base: "http://nim",
    kind: "openai",
    model: "model-a",
  };
  const targetB: ProviderTargetIdentity = {
    provider: "openrouter",
    credentialId: "openrouter#default",
    base: "http://or",
    kind: "openai",
    model: "model-b",
  };

  it("initially marks all targets as healthy", () => {
    const cb = new CircuitBreaker();
    expect(cb.isHealthy(targetA)).toBe(true);
    expect(cb.isHealthy(targetB)).toBe(true);
  });

  it("trips circuit immediately on HTTP 429 rate limit", () => {
    const cb = new CircuitBreaker();
    const now = 100000;
    cb.recordOutcome(targetA, {
      ok: false,
      status: 429,
      elapsedMs: 40,
      at: now,
    });

    expect(cb.isHealthy(targetA, now + 1000)).toBe(false);
    expect(cb.isHealthy(targetA, now + 130000)).toBe(true); // after cooldown
  });

  it("escalates repeat unexplained remote 429s and caps at a day", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    const expected = [120_000, 600_000, 3_600_000, 86_400_000, 86_400_000];

    expected.forEach((cooldown, index) => {
      const now = at + index;
      cb.recordOutcome(targetA, {
        ok: false,
        status: 429,
        elapsedMs: 5,
        at: now,
      });
      const state = cb.getState(targetA)!;
      expect(state.cooldownUntil).toBe(now + cooldown);
      expect(state.cooldownSource).toBe(index === 0 ? "default" : "escalation");
      expect(state.unexplained429s).toBe(index + 1);
    });
  });

  it("resets unexplained 429 escalation on success", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    cb.recordOutcome(targetA, { ok: false, status: 429, elapsedMs: 5, at });
    cb.recordOutcome(targetA, {
      ok: false,
      status: 429,
      elapsedMs: 5,
      at: at + 1,
    });
    cb.recordOutcome(targetA, {
      ok: true,
      status: 200,
      elapsedMs: 5,
      at: at + 2,
    });
    cb.recordOutcome(targetA, {
      ok: false,
      status: 429,
      elapsedMs: 5,
      at: at + 3,
    });

    const state = cb.getState(targetA)!;
    expect(state.cooldownUntil).toBe(at + 3 + 120_000);
    expect(state.cooldownSource).toBe("default");
    expect(state.unexplained429s).toBe(1);
  });

  it.each(["http://127.0.0.1:11434/v1", "http://localhost:11434/v1"])(
    "short-benches unexplained 429s from loopback base %s",
    (base) => {
      const cb = new CircuitBreaker();
      const at = 1_000_000;
      const local = { ...targetA, base };
      cb.recordOutcome(local, { ok: false, status: 429, elapsedMs: 5, at });
      cb.recordOutcome(local, {
        ok: false,
        status: 429,
        elapsedMs: 5,
        at: at + 1,
      });

      const state = cb.getState(local)!;
      expect(state.cooldownUntil).toBe(at + 1 + 5_000);
      expect(state.cooldownSource).toBe("loopback");
      expect(state.unexplained429s).toBe(0);
    },
  );

  it("trips circuit after consecutive failure threshold", () => {
    const cb = new CircuitBreaker();
    const now = 100000;
    cb.recordOutcome(targetA, {
      ok: false,
      status: 502,
      elapsedMs: 40,
      at: now,
    });
    expect(cb.isHealthy(targetA, now)).toBe(true);

    cb.recordOutcome(targetA, {
      ok: false,
      status: 502,
      elapsedMs: 40,
      at: now,
    });
    expect(cb.isHealthy(targetA, now + 1000)).toBe(false);
  });

  it("escalates repeated generic failures from the third failure and caps at 24 hours", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    const expected: Array<{ ms: number | null; source: string | null }> = [
      { ms: null, source: null },          // failure 1: below trip threshold
      { ms: 60_000, source: "default" },  // failure 2: pre-existing trip behavior
      { ms: 600_000, source: "failure-escalation" },
      { ms: 3_600_000, source: "failure-escalation" },
      { ms: 21_600_000, source: "failure-escalation" },
      { ms: 86_400_000, source: "failure-escalation" },
      { ms: 86_400_000, source: "failure-escalation" },
    ];

    expected.forEach((want, index) => {
      const now = at + index;
      cb.recordOutcome(targetA, { ok: false, status: 500, elapsedMs: 5, at: now });
      const state = cb.getState(targetA)!;
      expect(state.consecutiveFailures).toBe(index + 1);
      expect(state.cooldownSource).toBe(want.source);
      expect(state.cooldownUntil).toBe(want.ms === null ? 0 : now + want.ms);
    });
  });

  it("keeps a longer measured failure cooldown instead of shortening it to the escalation floor", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    cb.recordOutcome(targetA, { ok: false, status: 500, elapsedMs: 5, at });
    cb.recordOutcome(targetA, { ok: false, status: 500, elapsedMs: 5, at: at + 1 });
    cb.recordOutcome(targetA, { ok: false, status: 500, elapsedMs: 12 * 60_000, at: at + 2 });
    const state = cb.getState(targetA)!;
    expect(state.cooldownSource).toBe("elapsed");
    expect(state.cooldownUntil).toBe(at + 2 + 12 * 60_000);
  });

  it("keeps 402 at its existing one-hour floor until the failure ladder becomes longer", () => {
    const cb = new CircuitBreaker();
    const at = 2_000_000;
    const expected = [
      [3_600_000, "default"],
      [3_600_000, "default"],
      [3_600_000, "default"],
      [3_600_000, "default"],
      [21_600_000, "failure-escalation"],
      [86_400_000, "failure-escalation"],
    ] as const;
    expected.forEach(([ms, source], index) => {
      const now = at + index;
      cb.recordOutcome(targetA, { ok: false, status: 402, elapsedMs: 5, at: now });
      const state = cb.getState(targetA)!;
      expect(state.cooldownUntil).toBe(now + ms);
      expect(state.cooldownSource).toBe(source);
    });
  });

  it("a real success resets the repeated-failure escalation ladder", () => {
    const cb = new CircuitBreaker();
    const at = 3_000_000;
    for (let i = 0; i < 4; i += 1) {
      cb.recordOutcome(targetA, { ok: false, status: 500, elapsedMs: 5, at: at + i });
    }
    expect(cb.getState(targetA)!.cooldownSource).toBe("failure-escalation");

    cb.recordOutcome(targetA, { ok: true, status: 200, elapsedMs: 5, at: at + 10 });
    cb.recordOutcome(targetA, { ok: false, status: 500, elapsedMs: 5, at: at + 11 });
    const state = cb.getState(targetA)!;
    expect(state.consecutiveFailures).toBe(1);
    expect(state.cooldownUntil).toBe(0);
    expect(state.cooldownSource).toBeNull();
  });

  it("a success resets the consecutive-failure count", () => {
    const cb = new CircuitBreaker();
    const now = 100000;
    cb.recordOutcome(targetA, {
      ok: false,
      status: 502,
      elapsedMs: 40,
      at: now,
    });
    cb.recordOutcome(targetA, {
      ok: true,
      status: 200,
      elapsedMs: 80,
      at: now + 1,
    });
    cb.recordOutcome(targetA, {
      ok: false,
      status: 502,
      elapsedMs: 40,
      at: now + 2,
    });
    // One failure either side of a success must not add up to the trip threshold.
    expect(cb.isHealthy(targetA, now + 1000)).toBe(true);
    expect(cb.getState(targetA)!.consecutiveFailures).toBe(1);
  });

  it("filters healthy targets", () => {
    const cb = new CircuitBreaker();
    const now = 100000;
    cb.recordOutcome(targetA, {
      ok: false,
      status: 429,
      elapsedMs: 40,
      at: now,
    });

    const ordered = cb.orderByUsability([targetA, targetB], now);
    expect(ordered).toEqual([targetB, targetA]);
  });

  it("keeps the incoming order when NOTHING has been measured", () => {
    const cb = new CircuitBreaker();
    // Both untracked, so the health dimension says nothing and must not reorder the
    // benchmark-ranked list it was handed. This holds because untracked targets tie
    // with each other — not because every comparison returns 0.
    expect(cb.orderByUsability([targetB, targetA], 100000)).toEqual([
      targetB,
      targetA,
    ]);
  });
});

/**
 * A credential fault is its own dimension — neither health nor success.
 *
 * Recording a 401 as a failure would open the breaker on a CONFIG problem and hide the 401 the
 * operator must see behind a "target unhealthy" skip; recording it as a success would launder a
 * permanently broken member into a healthy one (that was the pre-0.10 bug). Neither answer lets
 * a pool step over the member, which is how half of a real 14-member pool sat in the routing
 * order answering 401 while `/candidates` showed every row `closed`.
 */
describe("CircuitBreaker — credential faults", () => {
  const t: ProviderTargetIdentity = {
    provider: "p",
    credentialId: "p#default",
    base: "http://p",
    kind: "openai",
    model: "m",
  };

  it("does not touch health state, and does not open the breaker", () => {
    const cb = new CircuitBreaker();
    cb.recordCredentialFault(t, 401);
    const s = cb.getState(t)!;
    expect(s.credentialFailures).toBe(1);
    expect(s.lastCredentialStatus).toBe(401);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.cooldownUntil).toBe(0);
    expect(s.pings.length).toBe(0); // not a latency observation either
    expect(cb.isHealthy(t)).toBe(true); // "healthy" keeps meaning what it says
    expect(cb.hasCredentialFault(t)).toBe(true); // but it IS reported, and demotes
  });

  it("expires, so a rotated key recovers without restarting the proxy", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    cb.recordCredentialFault(t, 401, at);
    expect(cb.hasCredentialFault(t, at + 60_000)).toBe(true);
    expect(cb.hasCredentialFault(t, at + 400_000)).toBe(false);
  });

  it("clears on a real success — proof the credential works now", () => {
    const cb = new CircuitBreaker();
    cb.recordCredentialFault(t, 403);
    cb.recordOutcome(t, { ok: true, status: 200, elapsedMs: 12 });
    expect(cb.hasCredentialFault(t)).toBe(false);
    expect(cb.getState(t)!.credentialFailures).toBe(0);
  });
});

describe("CircuitBreaker — Retry-After drives the cooldown", () => {
  const t: ProviderTargetIdentity = {
    provider: "p",
    credentialId: "p#default",
    base: "http://p",
    kind: "openai",
    model: "m",
  };

  it("honours the provider's own figure over the flat 2-minute guess", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    cb.recordOutcome(t, {
      ok: false,
      status: 429,
      elapsedMs: 5,
      at,
      retryAfterMs: 20_000,
    });
    expect(cb.getState(t)!.cooldownUntil).toBe(at + 20_000);
    expect(cb.getState(t)!.cooldownSource).toBe("retry-after");
  });

  it("falls back to the flat cooldown when the provider said nothing", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    cb.recordOutcome(t, { ok: false, status: 429, elapsedMs: 5, at });
    expect(cb.getState(t)!.cooldownUntil).toBe(at + 120_000);
    expect(cb.getState(t)!.cooldownSource).toBe("default");
  });

  it("trips a 503 immediately when it carries a Retry-After, without waiting for a second failure", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    cb.recordOutcome(t, {
      ok: false,
      status: 503,
      elapsedMs: 5,
      at,
      retryAfterMs: 30_000,
    });
    expect(cb.getState(t)!.cooldownUntil).toBe(at + 30_000);
  });

  it("clamps an absurd or hostile value at both ends", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    cb.recordOutcome(t, {
      ok: false,
      status: 429,
      elapsedMs: 5,
      at,
      retryAfterMs: 999_999_999,
    });
    expect(cb.getState(t)!.cooldownUntil).toBe(at + 900_000); // 15 min ceiling
    const cb2 = new CircuitBreaker();
    cb2.recordOutcome(t, {
      ok: false,
      status: 429,
      elapsedMs: 5,
      at,
      retryAfterMs: 0,
    });
    expect(cb2.getState(t)!.cooldownUntil).toBe(at + 1000); // 1s floor — never a busy loop
  });
});

describe("CircuitBreaker — credential-cell isolation", () => {
  const personal: ProviderTargetIdentity = {
    provider: "p",
    credentialId: "p#personal",
    base: "https://example.invalid",
    kind: "openai",
    model: "m",
  };
  const work: ProviderTargetIdentity = { ...personal, credentialId: "p#work" };

  it("uses credentialId/model keys and isolates 401, 402, and 429", () => {
    const cb = new CircuitBreaker();
    cb.recordCredentialFault(personal, 401, 1);
    expect(cb.hasCredentialFault(personal, 2)).toBe(true);
    expect(cb.hasCredentialFault(work, 2)).toBe(false);
    cb.recordOutcome(personal, { ok: false, status: 402, elapsedMs: 1, at: 3 });
    expect(cb.isHealthy(personal, 4)).toBe(false);
    expect(cb.isHealthy(work, 4)).toBe(true);
    cb.recordOutcome(work, { ok: false, status: 429, elapsedMs: 1, at: 5 });
    expect(cb.isHealthy(personal, 6)).toBe(false);
    expect(cb.isHealthy(work, 6)).toBe(false);
    expect([...cb.getAllStates().keys()]).toEqual(["p#personal/m", "p#work/m"]);
  });

  it("success and credential clearing never leak to a sibling credential", () => {
    const cb = new CircuitBreaker();
    cb.recordCredentialFault(personal, 401, 1);
    cb.recordCredentialFault(work, 401, 1);
    cb.recordOutcome(personal, { ok: true, status: 200, elapsedMs: 1, at: 2 });
    expect(cb.hasCredentialFault(personal, 3)).toBe(false);
    expect(cb.hasCredentialFault(work, 3)).toBe(true);
    expect(cb.clearCredentialFaults("p#personal")).toBe(0);
    expect(cb.clearCredentialFaults("p#work")).toBe(1);
  });
});

/**
 * A cooldown must outlast the failure that caused it.
 *
 * Measured live 2026-08-30: `nim/deepseek-ai/deepseek-v4-flash-0731` hung on 43 consecutive
 * attempts, each costing the full 120000 ms provider timeout, while its breaker read `closed` every
 * time. The charging path was correct all along — the 60 s constant was simply smaller than the
 * 120 s failure it punished, and requests arrived 78-139 s apart, so the cell was always closed
 * again by the next walk. Evidence: `docs/history/latency-demotion-regression-2026-08-30.md` §3.
 */
describe("CircuitBreaker — a slow failure cools for at least as long as it wasted", () => {
  const t: ProviderTargetIdentity = {
    provider: "nim",
    credentialId: "nim#default",
    base: "http://nim",
    kind: "openai",
    model: "deepseek-ai/deepseek-v4-flash-0731",
  };

  it("cools for the wasted time after two 120-second timeouts, not the flat 60 seconds", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    // The live figure, twice: `MAX_FAILURES_BEFORE_TRIP` is 2, so the second one trips.
    cb.recordOutcome(t, { ok: false, status: 504, elapsedMs: 120_007, at });
    cb.recordOutcome(t, { ok: false, status: 504, elapsedMs: 120_007, at });
    const state = cb.getState(t)!;
    expect(state.cooldownUntil).toBe(at + 120_007);
    expect(state.cooldownSource).toBe("elapsed");
    // The whole point: still cooling when the next request arrives. Live spacing was 78-139 s.
    expect(cb.isHealthy(t, at + 78_000)).toBe(false);
  });

  it("leaves a FAST failure on the flat default, so nothing else changes", () => {
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    cb.recordOutcome(t, { ok: false, status: 500, elapsedMs: 341, at });
    cb.recordOutcome(t, { ok: false, status: 500, elapsedMs: 341, at });
    const state = cb.getState(t)!;
    expect(state.cooldownUntil).toBe(at + 60_000);
    expect(state.cooldownSource).toBe("default");
  });

  it("never lets a provider-stated Retry-After lose to the elapsed time", () => {
    // The ladder's order is unchanged: an explicit figure still wins where it applied before.
    const cb = new CircuitBreaker();
    const at = 1_000_000;
    cb.recordOutcome(t, { ok: false, status: 503, elapsedMs: 120_000, at, retryAfterMs: 5_000 });
    const state = cb.getState(t)!;
    expect(state.cooldownUntil).toBe(at + 5_000);
    expect(state.cooldownSource).toBe("retry-after");
  });
});

describe("failureCooldown — the pure decision", () => {
  it("keeps the 60-second floor for anything faster than it", () => {
    expect(failureCooldown(0)).toEqual({ ms: 60_000, source: "default" });
    expect(failureCooldown(341)).toEqual({ ms: 60_000, source: "default" });
    expect(failureCooldown(60_000)).toEqual({ ms: 60_000, source: "default" });
  });

  it("rises to the measured waste above the floor", () => {
    expect(failureCooldown(60_001)).toEqual({ ms: 60_001, source: "elapsed" });
    expect(failureCooldown(120_007)).toEqual({ ms: 120_007, source: "elapsed" });
  });

  it("clamps at the same ceiling a provider-stated Retry-After gets", () => {
    // A 30-minute `timeoutMs` (openrouter declares exactly that) must not buy a 30-minute
    // cooldown off one sample.
    expect(failureCooldown(1_800_000)).toEqual({ ms: 900_000, source: "elapsed" });
  });

  it("treats a nonsense elapsed time as no evidence, never as an enormous cooldown", () => {
    // Unknown is never a measurement. Falling the other way would cool a cell for the ceiling on
    // a number nobody measured — the provenance rule broken in the most damaging direction.
    expect(failureCooldown(Number.NaN)).toEqual({ ms: 60_000, source: "default" });
    expect(failureCooldown(Number.POSITIVE_INFINITY)).toEqual({ ms: 60_000, source: "default" });
    expect(failureCooldown(-5)).toEqual({ ms: 60_000, source: "default" });
  });
});
