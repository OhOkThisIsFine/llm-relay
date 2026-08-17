import { describe, expect, it } from "vitest";
import {
  CircuitBreaker,
  UNMEASURED_STABILITY,
} from "../src/circuit-breaker.js";
import type { ProviderTargetIdentity } from "../src/kernel/contracts.js";

const target = (
  provider: string,
  model: string,
  credentialId = provider + "#default",
): ProviderTargetIdentity => ({
  provider,
  credentialId,
  model,
  base: "https://example.invalid",
  kind: "openai",
});
const deployment = (target: ProviderTargetIdentity) => ({
  provider: target.provider,
  model: target.model,
});

describe("breaker deployment measurement", () => {
  it("stores exact elapsed time in the credential cell and aggregates deployment stability", () => {
    const cb = new CircuitBreaker();
    const fast = target("nim", "fast");
    const slow = target("nim", "slow");
    cb.recordOutcome(fast, { ok: true, elapsedMs: 120, status: 200 });
    cb.recordOutcome(slow, { ok: true, elapsedMs: 4800, status: 200 });
    expect(cb.getState(fast)?.pings[0]?.ms).toBe(120);
    expect(cb.getState(slow)?.pings[0]?.ms).toBe(4800);
    expect(
      cb.getDeploymentMeasurement(deployment(fast)).stabilityScore!,
    ).toBeGreaterThan(
      cb.getDeploymentMeasurement(deployment(slow)).stabilityScore!,
    );
  });

  it("exposes no fabricated-latency writers or scalar cell stability APIs", () => {
    const proto = CircuitBreaker.prototype as unknown as Record<
      string,
      unknown
    >;
    expect(proto["recordOutcome"]).toBeTypeOf("function");
    expect(proto["recordSuccess"]).toBeUndefined();
    expect(proto["recordFailure"]).toBeUndefined();
    expect(proto["getDeploymentMeasurement"]).toBeTypeOf("function");
    expect(proto["getMeasuredStability"]).toBeUndefined();
    expect(proto["hasObservations"]).toBeUndefined();
  });

  it("reports an untracked deployment explicitly, never as a perfect score", () => {
    const measurement = new CircuitBreaker().getDeploymentMeasurement({
      provider: "nim",
      model: "never-probed",
    });
    expect(measurement.stabilityScore).toBeNull();
    expect(measurement.pings).toEqual([]);
    expect(measurement.minSamples).toBe(0);
  });

  it("keeps ordering stable when all cells are usable; stability does not silently re-sort", () => {
    const cb = new CircuitBreaker();
    const healthy = target("nim", "healthy");
    const untracked = target("nim", "untracked");
    for (let i = 0; i < 5; i++)
      cb.recordOutcome(healthy, { ok: true, elapsedMs: 120, status: 200 });
    expect(
      cb.getDeploymentMeasurement(deployment(healthy)).stabilityScore!,
    ).toBeGreaterThan(UNMEASURED_STABILITY);
    expect(cb.orderByUsability([untracked, healthy])).toEqual([
      untracked,
      healthy,
    ]);
  });

  it("does not discard erratic observations or candidates", () => {
    const cb = new CircuitBreaker();
    const healthy = target("nim", "healthy");
    const untracked = target("nim", "untracked");
    const erratic = target("nim", "erratic");
    for (let i = 0; i < 3; i++)
      cb.recordOutcome(healthy, { ok: true, elapsedMs: 120, status: 200 });
    cb.recordOutcome(erratic, { ok: true, elapsedMs: 100, status: 200 });
    cb.recordOutcome(erratic, { ok: true, elapsedMs: 9000, status: 200 });
    expect(
      cb.getDeploymentMeasurement(deployment(healthy)).stabilityScore!,
    ).toBeGreaterThan(UNMEASURED_STABILITY);
    expect(
      cb.getDeploymentMeasurement(deployment(erratic)).stabilityScore!,
    ).toBeLessThan(UNMEASURED_STABILITY);
    expect(cb.orderByUsability([erratic, untracked, healthy])).toEqual([
      erratic,
      untracked,
      healthy,
    ]);
  });

  it("reports a deployment with only failures as measured stability zero", () => {
    const cb = new CircuitBreaker();
    const t = target("nim", "always-500");
    cb.recordOutcome(t, { ok: false, status: 500, elapsedMs: 30 });
    const measurement = cb.getDeploymentMeasurement(deployment(t));
    expect(measurement.pings).toHaveLength(1);
    expect(measurement.stabilityScore).toBe(0);
  });

  it("keeps non-2xx codes in the measurement history", () => {
    const cb = new CircuitBreaker();
    const revoked = target("nim", "revoked-key");
    cb.recordOutcome(revoked, { ok: true, elapsedMs: 40, status: 401 });
    expect(cb.getState(revoked)?.pings[0]?.code).toBe("401");
    expect(cb.getState(revoked)?.lastStatus).toBe(401);

    const working = target("nim", "working");
    cb.recordOutcome(working, { ok: true, elapsedMs: 40, status: 200 });
    expect(
      cb.getDeploymentMeasurement(deployment(working)).stabilityScore!,
    ).toBeGreaterThan(
      cb.getDeploymentMeasurement(deployment(revoked)).stabilityScore!,
    );
  });

  it("merges credential-cell pings in timestamp order", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(target("p", "m", "p#one"), {
      ok: true,
      status: 200,
      elapsedMs: 20,
      at: 30,
    });
    cb.recordOutcome(target("p", "m", "p#two"), {
      ok: true,
      status: 200,
      elapsedMs: 10,
      at: 10,
    });
    cb.recordOutcome(target("p", "m", "p#one"), {
      ok: true,
      status: 200,
      elapsedMs: 15,
      at: 20,
    });
    const measurement = cb.getDeploymentMeasurement({
      provider: "p",
      model: "m",
    });
    expect(measurement.pings.map((ping) => ping.timestamp)).toEqual([
      10, 20, 30,
    ]);
    expect(measurement.minSamples).toBe(1);
  });

  it("does not inflate confidence when five credentials have one sample each", () => {
    const cb = new CircuitBreaker();
    for (let index = 0; index < 5; index += 1) {
      cb.recordOutcome(target("p", "m", "p#key-" + index), {
        ok: true,
        status: 200,
        elapsedMs: 10,
        at: index,
      });
    }
    const measurement = cb.getDeploymentMeasurement({
      provider: "p",
      model: "m",
    });
    expect(measurement.pings).toHaveLength(5);
    expect(measurement.minSamples).toBe(1);
  });
});
