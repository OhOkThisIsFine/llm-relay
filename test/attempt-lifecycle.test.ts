import { describe, expect, it } from "vitest";
import { CircuitBreaker, type HeaderObservation } from "../src/circuit-breaker.js";
import type {
  AttemptFailed,
  AttemptHandle,
  AttemptOutcome,
  AttemptSucceeded,
  ProviderTargetIdentity,
} from "../src/kernel/contracts.js";

const targetA: ProviderTargetIdentity = {
  provider: "provider-a",
  model: "deployment-a",
  kind: "openai",
};
const targetB: ProviderTargetIdentity = {
  provider: "provider-a",
  model: "deployment-b",
  kind: "openai",
};

function begin(breaker: CircuitBreaker, target = targetA): AttemptHandle {
  const result = breaker.beginAttempt(target);
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function headers(
  target: ProviderTargetIdentity = targetA,
  overrides: Partial<HeaderObservation> = {},
): HeaderObservation {
  return {
    target,
    status: 200,
    elapsedMs: 7,
    observedAt: 1_007,
    ...overrides,
  };
}

function success(
  target: ProviderTargetIdentity = targetA,
  overrides: Partial<AttemptSucceeded> = {},
): AttemptSucceeded {
  return {
    target,
    terminal: "succeeded",
    provenance: "upstream",
    status: 200,
    completedAt: 1_050,
    elapsedMs: 50,
    ...overrides,
  };
}

function failure(
  target: ProviderTargetIdentity = targetA,
  overrides: Partial<AttemptFailed> = {},
): AttemptFailed {
  return {
    target,
    terminal: "failed",
    provenance: "upstream",
    failure: "http",
    status: 502,
    retryAfterMs: null,
    completedAt: 1_050,
    elapsedMs: 50,
    ...overrides,
  };
}

function stateBytes(breaker: CircuitBreaker): string {
  return JSON.stringify([...breaker.getAllStates()]);
}

function serialState(order: readonly AttemptOutcome[]): string {
  const breaker = new CircuitBreaker();
  const attempts = order.map(() => begin(breaker));
  order.forEach((outcome, index) => {
    expect(breaker.completeAttempt(attempts[index]!, outcome).ok).toBe(true);
  });
  return stateBytes(breaker);
}

function compatibilityState(order: readonly AttemptOutcome[]): string {
  const breaker = new CircuitBreaker();
  for (const outcome of order) {
    if (outcome.terminal === "cancelled") continue;
    const recorded = {
      ok: outcome.terminal === "succeeded",
      elapsedMs: outcome.elapsedMs,
      at: outcome.completedAt,
      ...(outcome.status !== null ? { status: outcome.status } : {}),
      ...(outcome.terminal === "failed" && outcome.retryAfterMs !== null
        ? { retryAfterMs: outcome.retryAfterMs }
        : {}),
    };
    breaker.recordOutcome(outcome.target, recorded);
  }
  return stateBytes(breaker);
}

describe("CircuitBreaker attempt lifecycle", () => {
  it("keeps 2xx headers provisional and commits only the terminal stream failure", () => {
    const breaker = new CircuitBreaker();
    const handle = begin(breaker);

    expect(breaker.observeHeaders(handle, headers()).ok).toBe(true);
    expect(breaker.getState(targetA)).toBeUndefined();

    expect(
      breaker.completeAttempt(
        handle,
        failure(targetA, {
          failure: "protocol",
          status: 502,
          completedAt: 1_080,
          elapsedMs: 80,
        }),
      ).ok,
    ).toBe(true);
    expect(breaker.getState(targetA)?.pings).toEqual([
      { code: "502", ms: 80, timestamp: 1_080 },
    ]);
    expect(breaker.getState(targetA)?.consecutiveFailures).toBe(1);
  });

  it("rejects duplicate completion without changing one byte of breaker state", () => {
    const breaker = new CircuitBreaker();
    const handle = begin(breaker);
    expect(breaker.completeAttempt(handle, failure()).ok).toBe(true);
    const before = stateBytes(breaker);

    const duplicate = breaker.completeAttempt(handle, success());

    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.kind).toBe("duplicate-completion");
    expect(stateBytes(breaker)).toBe(before);
  });

  it("rejects stale, foreign, and cross-target handles without breaker mutation", () => {
    const breaker = new CircuitBreaker();
    const other = new CircuitBreaker();
    const local = begin(breaker);
    const foreign = begin(other);
    const stale = {} as AttemptHandle;
    const before = stateBytes(breaker);

    const staleResult = breaker.completeAttempt(stale, failure());
    const foreignResult = breaker.completeAttempt(foreign, failure());
    const crossTargetResult = breaker.completeAttempt(local, failure(targetB));

    expect(staleResult.ok || staleResult.error.kind).toBe("stale-handle");
    expect(foreignResult.ok || foreignResult.error.kind).toBe("foreign-handle");
    expect(crossTargetResult.ok || crossTargetResult.error.kind).toBe("cross-target");
    expect(stateBytes(breaker)).toBe(before);

    // A rejected cross-target completion did not spend the valid local handle.
    expect(breaker.completeAttempt(local, success()).ok).toBe(true);
  });

  it("rejects duplicate and invalid header observations without health mutation", () => {
    const breaker = new CircuitBreaker();
    const other = new CircuitBreaker();
    const local = begin(breaker);
    const foreign = begin(other);
    expect(breaker.observeHeaders(local, headers()).ok).toBe(true);
    const before = stateBytes(breaker);

    const duplicate = breaker.observeHeaders(local, headers(targetA, { status: 204 }));
    const stale = breaker.observeHeaders({} as AttemptHandle, headers());
    const foreignResult = breaker.observeHeaders(foreign, headers());
    const crossTarget = breaker.observeHeaders(begin(breaker), headers(targetB));

    expect(duplicate.ok || duplicate.error.kind).toBe("duplicate-observation");
    expect(stale.ok || stale.error.kind).toBe("stale-handle");
    expect(foreignResult.ok || foreignResult.error.kind).toBe("foreign-handle");
    expect(crossTarget.ok || crossTarget.error.kind).toBe("cross-target");
    expect(stateBytes(breaker)).toBe(before);
  });

  it("makes handles stale on reset", () => {
    const breaker = new CircuitBreaker();
    const oldHandle = begin(breaker);
    breaker.recordOutcome(targetA, { ok: true, status: 200, elapsedMs: 1, at: 1 });
    breaker.reset();
    const before = stateBytes(breaker);

    const result = breaker.completeAttempt(oldHandle, failure());

    expect(result.ok || result.error.kind).toBe("stale-handle");
    expect(stateBytes(breaker)).toBe(before);
  });

  it("serializes same-target success/failure in the exact completion call order", () => {
    const failed = failure(targetA, { completedAt: 2_000, elapsedMs: 90 });
    const succeeded = success(targetA, { completedAt: 2_001, elapsedMs: 91 });

    const failureThenSuccess = serialState([failed, succeeded]);
    const successThenFailure = serialState([succeeded, failed]);

    expect(failureThenSuccess).toBe(compatibilityState([failed, succeeded]));
    expect(successThenFailure).toBe(compatibilityState([succeeded, failed]));
    expect(failureThenSuccess).not.toBe(successThenFailure);
  });

  it("does not change another deployment while same-target attempts interleave", () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(targetB, {
      ok: false,
      status: 503,
      elapsedMs: 13,
      at: 900,
      retryAfterMs: 30_000,
    });
    const otherBefore = JSON.stringify(breaker.getState(targetB));
    const first = begin(breaker);
    const second = begin(breaker);

    expect(breaker.completeAttempt(second, success()).ok).toBe(true);
    expect(breaker.completeAttempt(first, failure()).ok).toBe(true);

    expect(JSON.stringify(breaker.getState(targetB))).toBe(otherBefore);
  });

  it("preserves terminal latency, Retry-After, header quota, and bounded ping history", () => {
    const breaker = new CircuitBreaker();
    const limited = begin(breaker);
    expect(
      breaker.observeHeaders(
        limited,
        headers(targetA, { status: 429, quotaPercent: 3, retryAfterMs: 20_000 }),
      ).ok,
    ).toBe(true);
    expect(
      breaker.completeAttempt(
        limited,
        failure(targetA, {
          status: 429,
          completedAt: 10_000,
          elapsedMs: 123,
        }),
      ).ok,
    ).toBe(true);
    expect(breaker.getState(targetA)?.cooldownUntil).toBe(30_000);
    expect(breaker.getState(targetA)?.quotaPercent).toBe(3);
    expect(breaker.getState(targetA)?.pings[0]).toEqual({
      code: "429",
      ms: 123,
      timestamp: 10_000,
    });

    for (let index = 0; index < 11; index++) {
      const handle = begin(breaker);
      expect(
        breaker.completeAttempt(
          handle,
          success(targetA, { completedAt: 11_000 + index, elapsedMs: 200 + index }),
        ).ok,
      ).toBe(true);
    }
    expect(breaker.getState(targetA)?.pings).toHaveLength(10);
    expect(breaker.getState(targetA)?.pings[0]?.ms).toBe(201);
    expect(breaker.getState(targetA)?.pings[9]?.ms).toBe(210);
  });

  it("keeps credential failures separate and lets a terminal success recover them", () => {
    const breaker = new CircuitBreaker();
    const rejected = begin(breaker);
    expect(
      breaker.completeAttempt(
        rejected,
        failure(targetA, { status: 401, completedAt: 4_000 }),
      ).ok,
    ).toBe(true);
    expect(breaker.getState(targetA)).toMatchObject({
      consecutiveFailures: 0,
      credentialFailures: 1,
      lastCredentialStatus: 401,
      credentialFaultUntil: 304_000,
      pings: [],
    });

    const recovered = begin(breaker);
    expect(breaker.completeAttempt(recovered, success()).ok).toBe(true);
    expect(breaker.getState(targetA)?.credentialFailures).toBe(0);
    expect(breaker.getState(targetA)?.credentialFaultUntil).toBe(0);
  });

  it.each([413, 422])(
    "completes a client-error %s once without treating it as deployment health",
    (status) => {
      const breaker = new CircuitBreaker();
      const handle = begin(breaker);

      const completed = breaker.completeAttempt(handle, failure(targetA, { status }));

      expect(completed.ok).toBe(true);
      expect(breaker.getState(targetA)).toBeUndefined();
      const duplicate = breaker.completeAttempt(handle, failure(targetA, { status }));
      expect(duplicate.ok || duplicate.error.kind).toBe("duplicate-completion");
      expect(breaker.getState(targetA)).toBeUndefined();
    },
  );

  it("completes a relay mapper defect once without poisoning provider health", () => {
    const breaker = new CircuitBreaker();
    const handle = begin(breaker);
    const mapperFailure = failure(targetA, {
      provenance: "relay-mapper-defect",
      failure: "mapping",
      status: 502,
    });

    expect(breaker.completeAttempt(handle, mapperFailure).ok).toBe(true);
    expect(breaker.getState(targetA)).toBeUndefined();
    const duplicate = breaker.completeAttempt(handle, mapperFailure);
    expect(duplicate.ok || duplicate.error.kind).toBe("duplicate-completion");
    expect(breaker.getState(targetA)).toBeUndefined();
  });

  it("keys a passthrough target with a null model by provider", () => {
    const breaker = new CircuitBreaker();
    const passthrough: ProviderTargetIdentity = {
      provider: "passthrough",
      model: null,
      kind: "anthropic",
    };
    const handle = begin(breaker, passthrough);
    expect(breaker.completeAttempt(handle, success(passthrough)).ok).toBe(true);

    expect(breaker.hasObservations(passthrough)).toBe(true);
    expect(breaker.getState("passthrough")?.pings[0]?.code).toBe("200");
    expect(breaker.isHealthy(passthrough)).toBe(true);
  });

  it("accepts cancellation once without inventing a health observation", () => {
    const breaker = new CircuitBreaker();
    const handle = begin(breaker);
    const cancelled: AttemptOutcome = {
      target: targetA,
      terminal: "cancelled",
      provenance: "client-cancellation",
      reason: "client disconnected",
      completedAt: 5_000,
      elapsedMs: 12,
    };

    expect(breaker.completeAttempt(handle, cancelled).ok).toBe(true);
    expect(breaker.getState(targetA)).toBeUndefined();
    const duplicate = breaker.completeAttempt(handle, cancelled);
    expect(duplicate.ok || duplicate.error.kind).toBe("duplicate-completion");
    expect(breaker.getState(targetA)).toBeUndefined();
  });
});
