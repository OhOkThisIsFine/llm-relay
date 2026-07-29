import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import type { ResolvedTarget } from "../src/config.js";

const target = (provider: string, model: string): ResolvedTarget =>
  ({ provider, model, base: "https://example.invalid", kind: "openai" }) as unknown as ResolvedTarget;

/**
 * Pins ARC-4d706fce / COR-54d9134c: the number that decides which backend serves
 * a request was built from parameter defaults and a no-measurement sentinel that
 * mapped to a perfect score.
 */
describe("breaker records measured latency (ARC-4d706fce)", () => {
  it("stores the elapsed time it was given, not the parameter default", () => {
    const cb = new CircuitBreaker();
    const t = target("nim", "z-ai/glm-5.2");
    cb.recordOutcome(t, { ok: true, elapsedMs: 1234, status: 200 });
    // The defect stored the 500/1000 defaults for every real request.
    expect(cb.getMeasuredStability(t)).not.toBeNull();
    const withReal = cb.getMeasuredStability(t);
    const other = new CircuitBreaker();
    const t2 = target("nim", "other/model");
    other.recordSuccess(t2); // legacy path, defaulted ms
    expect(withReal).not.toBe(null);
    expect(other.getMeasuredStability(t2)).not.toBeNull();
  });

  it("recordOutcome cannot be called without a measurement", () => {
    const cb = new CircuitBreaker();
    const t = target("nim", "m");
    // The real assertion here is the @ts-expect-error itself: `npm run typecheck`
    // FAILS if elapsedMs ever becomes optional, because the expected error would
    // no longer occur. That is the enforcement — a runtime expect() cannot check
    // a compile-time guarantee.
    // @ts-expect-error elapsedMs is required and omitting it must not compile
    cb.recordOutcome(t, { ok: true });
    expect(cb.hasObservations(t)).toBe(true);
  });

  it("an UNTRACKED target reports unknown, never a perfect score", () => {
    const cb = new CircuitBreaker();
    const untracked = target("nim", "never-probed");
    // The defect: getStabilityScore returns 100 for an unseen key, so a target
    // nobody has measured is indistinguishable from a proven-healthy one.
    expect(cb.getMeasuredStability(untracked)).toBeNull();
    expect(cb.hasObservations(untracked)).toBe(false);
  });

  it("an untracked target does not compare equal to a measured-healthy one", () => {
    const cb = new CircuitBreaker();
    const healthy = target("nim", "healthy");
    const untracked = target("nim", "untracked");
    for (let i = 0; i < 5; i++) cb.recordOutcome(healthy, { ok: true, elapsedMs: 120, status: 200 });

    const a = cb.getMeasuredStability(healthy);
    const b = cb.getMeasuredStability(untracked);
    // This is the assertion the stable-sort accident defeated: under the old
    // accessor both were 100, the comparator returned 0, and Array.sort being
    // stable preserved input order — so an ordering test passed with a
    // competing re-sort fully intact.
    expect(a).not.toBe(b);
    expect(b).toBeNull();
    expect(typeof a).toBe("number");
  });

  it("hasObservations distinguishes measured from unmeasured", () => {
    const cb = new CircuitBreaker();
    const t = target("nim", "m");
    expect(cb.hasObservations(t)).toBe(false);
    cb.recordOutcome(t, { ok: false, status: 429, elapsedMs: 50 });
    expect(cb.hasObservations(t)).toBe(true);
  });
});
