import { describe, expect, it } from "vitest";
import type {
  AttemptHandle,
  AttemptOutcome,
  CancellationSignal,
  ProviderTargetIdentity,
} from "../src/kernel/contracts.js";
import {
  AttemptLifecycle,
  RequestBudget,
  type MonotonicClock,
} from "../src/kernel/request-lifecycle.js";

class FakeClock implements MonotonicClock {
  constructor(public value: number) {}
  now(): number {
    return this.value;
  }
}

class FakeCancellation implements CancellationSignal {
  cancelled = false;
  cause: string | undefined;
  isCancelled(): boolean {
    return this.cancelled;
  }
  reason(): string | undefined {
    return this.cause;
  }
}

const targetA: ProviderTargetIdentity = {
  provider: "nim",
  model: "model-a",
  kind: "openai",
};
const targetB: ProviderTargetIdentity = {
  provider: "anthropic",
  model: "model-b",
  kind: "anthropic",
};

function success(target: ProviderTargetIdentity, completedAt = 20): AttemptOutcome {
  return {
    terminal: "succeeded",
    target,
    provenance: "upstream",
    completedAt,
    elapsedMs: 10,
    status: 200,
  };
}

function bytes(value: unknown): string {
  return JSON.stringify(value);
}

describe("RequestBudget", () => {
  it("bounds synchronous acquisition across concurrent contenders", async () => {
    const clock = new FakeClock(100);
    const cancellation = new FakeCancellation();
    const budget = new RequestBudget({ capacity: 3, deadline: 200, clock, cancellation });

    const contenders = await Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve().then(() => budget.acquire())),
    );
    expect(contenders.filter((result) => result.ok)).toHaveLength(3);
    expect(contenders.filter((result) => !result.ok)).toHaveLength(17);
    expect(budget.view()).toEqual({
      capacity: 3,
      deadline: 200,
      issued: 3,
      remaining: 0,
      cancelled: false,
    });
  });

  it("returns deterministic cancellation, deadline, and capacity failures without mutation", () => {
    const clock = new FakeClock(100);
    const cancellation = new FakeCancellation();
    const budget = new RequestBudget({ capacity: 1, deadline: 110, clock, cancellation });

    expect(budget.acquire().ok).toBe(true);
    const exhaustedBefore = bytes(budget.view());
    expect(budget.acquire()).toEqual({
      ok: false,
      error: { kind: "budget-exhausted", capacity: 1, issued: 1 },
    });
    expect(bytes(budget.view())).toBe(exhaustedBefore);

    clock.value = 110;
    const deadlineBefore = bytes(budget.view());
    expect(budget.acquire()).toEqual({
      ok: false,
      error: { kind: "deadline-exceeded", deadline: 110, now: 110 },
    });
    expect(bytes(budget.view())).toBe(deadlineBefore);

    cancellation.cancelled = true;
    cancellation.cause = "caller left";
    const cancelledBefore = bytes(budget.view());
    expect(budget.acquire()).toEqual({
      ok: false,
      error: { kind: "cancelled", reason: "caller left" },
    });
    expect(bytes(budget.view())).toBe(cancelledBefore);
  });

  it("issues opaque leases that can be spent exactly once", () => {
    const clock = new FakeClock(5);
    const cancellation = new FakeCancellation();
    const budget = new RequestBudget({ capacity: 1, deadline: 50, clock, cancellation });
    const acquired = budget.acquire();
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    expect(acquired.value.view()).toEqual({ ordinal: 1, acquiredAt: 5, deadline: 50, spent: false });
    const spent = acquired.value.spend();
    expect(spent).toEqual({
      ok: true,
      value: { ordinal: 1, acquiredAt: 5, deadline: 50 },
    });
    const beforeDuplicate = bytes(acquired.value.view());
    expect(acquired.value.spend()).toEqual({
      ok: false,
      error: { kind: "lease-spent", ordinal: 1 },
    });
    expect(bytes(acquired.value.view())).toBe(beforeDuplicate);
  });

  it("rejects invalid immutable limits at construction", () => {
    const clock = new FakeClock(0);
    const cancellation = new FakeCancellation();
    expect(
      () => new RequestBudget({ capacity: -1, deadline: 10, clock, cancellation }),
    ).toThrow(RangeError);
    expect(
      () => new RequestBudget({ capacity: 1, deadline: Number.POSITIVE_INFINITY, clock, cancellation }),
    ).toThrow(RangeError);
  });
});

describe("AttemptLifecycle", () => {
  it("creates unique target-bound handles and completes each exactly once", () => {
    const lifecycle = new AttemptLifecycle(7);
    const first = lifecycle.beginAttempt(targetA);
    const second = lifecycle.beginAttempt(targetA);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).not.toBe(second.value);

    const firstCompletion = lifecycle.completeAttempt(first.value, success(targetA));
    const secondCompletion = lifecycle.completeAttempt(second.value, success(targetA, 21));
    expect(firstCompletion.ok && firstCompletion.value.id).toBe("7:1");
    expect(secondCompletion.ok && secondCompletion.value.id).toBe("7:2");
    expect(lifecycle.view()).toEqual({ generation: 7, issued: 2, completed: 2, open: 0, closed: false });
  });

  it("rejects duplicate, foreign, stale, and cross-target handles with byte-identical state", () => {
    const lifecycle = new AttemptLifecycle();
    const other = new AttemptLifecycle();

    const own = lifecycle.beginAttempt(targetA);
    const foreign = other.beginAttempt(targetA);
    expect(own.ok).toBe(true);
    expect(foreign.ok).toBe(true);
    if (!own.ok || !foreign.ok) return;

    let before = bytes(lifecycle.view());
    expect(lifecycle.completeAttempt(own.value, success(targetB))).toMatchObject({
      ok: false,
      error: { kind: "cross-target", expected: targetA, received: targetB },
    });
    expect(bytes(lifecycle.view())).toBe(before);

    before = bytes(lifecycle.view());
    expect(lifecycle.completeAttempt(foreign.value, success(targetA))).toEqual({
      ok: false,
      error: { kind: "foreign-handle" },
    });
    expect(bytes(lifecycle.view())).toBe(before);

    const fabricated = Object.freeze({}) as AttemptHandle;
    before = bytes(lifecycle.view());
    expect(lifecycle.completeAttempt(fabricated, success(targetA))).toEqual({
      ok: false,
      error: { kind: "stale-handle" },
    });
    expect(bytes(lifecycle.view())).toBe(before);

    expect(lifecycle.completeAttempt(own.value, success(targetA)).ok).toBe(true);
    before = bytes(lifecycle.view());
    expect(lifecycle.completeAttempt(own.value, success(targetA))).toMatchObject({
      ok: false,
      error: { kind: "duplicate-completion" },
    });
    expect(bytes(lifecycle.view())).toBe(before);
  });

  it("closes admission without invalidating completion obligations", () => {
    const lifecycle = new AttemptLifecycle();
    const begun = lifecycle.beginAttempt(targetA);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    lifecycle.close();
    const beforeRejectedBegin = bytes(lifecycle.view());
    expect(lifecycle.beginAttempt(targetA)).toEqual({
      ok: false,
      error: { kind: "lifecycle-closed" },
    });
    expect(bytes(lifecycle.view())).toBe(beforeRejectedBegin);
    expect(lifecycle.completeAttempt(begun.value, success(targetA)).ok).toBe(true);
  });

  it("does not expose a constructible handle shape to TypeScript callers", () => {
    // @ts-expect-error AttemptHandle's brand is intentionally module-private.
    const forged: AttemptHandle = {};
    expect(forged).toEqual({});
  });
});
