import { describe, expect, it } from "vitest";
import { CircuitBreaker, UNMEASURED_STABILITY } from "../src/circuit-breaker.js";
import type { ResolvedTarget } from "../src/config.js";

const target = (provider: string, model: string): ResolvedTarget =>
  ({ provider, model, base: "https://example.invalid", kind: "openai" }) as unknown as ResolvedTarget;

/**
 * Pins ARC-4d706fce / COR-54d9134c: the number that decides which backend serves
 * a request was built from parameter defaults and a no-measurement sentinel that
 * mapped to a perfect score.
 */
describe("breaker records measured latency (ARC-4d706fce)", () => {
  it("stores the elapsed time it was given, not a fabricated constant", () => {
    const cb = new CircuitBreaker();
    const fast = target("nim", "fast");
    const slow = target("nim", "slow");
    cb.recordOutcome(fast, { ok: true, elapsedMs: 120, status: 200 });
    cb.recordOutcome(slow, { ok: true, elapsedMs: 4800, status: 200 });

    // The defect stored 500ms for BOTH, so these two were the same number.
    expect(cb.getState(fast)!.pings[0]!.ms).toBe(120);
    expect(cb.getState(slow)!.pings[0]!.ms).toBe(4800);
    expect(cb.getMeasuredStability(fast)!).toBeGreaterThan(cb.getMeasuredStability(slow)!);
  });

  /**
   * The measured-latency invariant is enforced by there being NO writer that can
   * invent one. `recordOutcome`'s `elapsedMs` is required, and the defaulted
   * `recordSuccess`/`recordFailure` pair is gone — `npm run typecheck` excludes
   * `test/**`, so a `@ts-expect-error` in this file would prove nothing; the
   * enforcement has to be the absence of the surface, which is checkable here.
   */
  it("exposes no defaulted writer that could fabricate a latency", () => {
    const proto = CircuitBreaker.prototype as unknown as Record<string, unknown>;
    expect(proto["recordOutcome"]).toBeTypeOf("function");
    expect(proto["recordSuccess"]).toBeUndefined();
    expect(proto["recordFailure"]).toBeUndefined();
  });

  it("an UNTRACKED target reports unknown, never a perfect score", () => {
    const cb = new CircuitBreaker();
    const untracked = target("nim", "never-probed");
    // The defect: getStabilityScore returned 100 for an unseen key, so a target
    // nobody has measured was indistinguishable from a proven-healthy one.
    expect(cb.getMeasuredStability(untracked)).toBeNull();
    expect(cb.hasObservations(untracked)).toBe(false);
    expect(cb.getStabilityScore(untracked)).toBe(UNMEASURED_STABILITY);
    expect(cb.getStabilityScore(untracked)).not.toBe(100);
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
    // …and the ordering value they are compared BY also differs, which is the
    // half the old test could not see.
    expect(cb.getStabilityScore(healthy)).toBeGreaterThan(cb.getStabilityScore(untracked));
  });

  /**
   * INV-TS-7 end to end. The ordering must separate all three bands, so it cannot
   * pass by `Array.prototype.sort` being stable over an all-equal comparator.
   */
  it("orders measured-healthy above untracked above measured-erratic", () => {
    const cb = new CircuitBreaker();
    const healthy = target("nim", "healthy");
    const untracked = target("nim", "untracked");
    const erratic = target("nim", "erratic");

    for (let i = 0; i < 3; i++) cb.recordOutcome(healthy, { ok: true, elapsedMs: 120, status: 200 });
    // Answers, but wildly: a huge tail and huge jitter. Measured, and measured BAD.
    cb.recordOutcome(erratic, { ok: true, elapsedMs: 100, status: 200 });
    cb.recordOutcome(erratic, { ok: true, elapsedMs: 9000, status: 200 });

    expect(cb.getMeasuredStability(healthy)!).toBeGreaterThan(UNMEASURED_STABILITY);
    expect(cb.getMeasuredStability(erratic)!).toBeLessThan(UNMEASURED_STABILITY);

    // Deliberately fed worst-first so a no-op sort cannot produce this answer.
    const ordered = cb.getHealthyTargets([erratic, untracked, healthy], Date.now());
    expect(ordered.map((t) => t.model)).toEqual(["healthy", "untracked", "erratic"]);
  });

  it("a target that answered but never usably scores 0, not unknown", () => {
    const cb = new CircuitBreaker();
    const t = target("nim", "always-500");
    // No measurable sample at all, which the composite reports as -1. That is
    // evidence of failure, not absence of evidence, so it must NOT read as null
    // (unknown) and must NOT have mapped to 100 the way it used to.
    cb.recordOutcome(t, { ok: false, status: 500, elapsedMs: 30 });
    expect(cb.hasObservations(t)).toBe(true);
    expect(cb.getMeasuredStability(t)).toBe(0);
    expect(cb.getStabilityScore(t)).toBe(0);
  });

  it("a 401 is never laundered into a success ping", () => {
    const cb = new CircuitBreaker();
    const revoked = target("nim", "revoked-key");
    // server.ts does not classify 401 as retriable, so it arrives here as ok:true.
    // The old writer hardcoded code "200" for any ok outcome, so a provider whose
    // key had been revoked accumulated synthetic successes and read as available.
    cb.recordOutcome(revoked, { ok: true, elapsedMs: 40, status: 401 });
    expect(cb.getState(revoked)!.pings[0]!.code).toBe("401");
    expect(cb.getState(revoked)!.lastStatus).toBe(401);

    const working = target("nim", "working");
    cb.recordOutcome(working, { ok: true, elapsedMs: 40, status: 200 });
    expect(cb.getMeasuredStability(working)!).toBeGreaterThan(cb.getMeasuredStability(revoked)!);
  });

  it("hasObservations distinguishes measured from unmeasured", () => {
    const cb = new CircuitBreaker();
    const t = target("nim", "m");
    expect(cb.hasObservations(t)).toBe(false);
    cb.recordOutcome(t, { ok: false, status: 429, elapsedMs: 50 });
    expect(cb.hasObservations(t)).toBe(true);
  });

  it("still records a 2xx as a success ping", () => {
    const cb = new CircuitBreaker();
    const t = target("nim", "created");
    cb.recordOutcome(t, { ok: true, elapsedMs: 40, status: 201 });
    expect(cb.getState(t)!.pings[0]!.code).toBe("200");
  });
});
