import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";
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
