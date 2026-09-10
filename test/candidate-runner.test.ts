import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { makeCredentialId } from "../src/credential-id.js";
import { resolveAttempt, type ResolvedAttempt } from "../src/resolved-attempt.js";
import type { ProviderTargetIdentity } from "../src/kernel/contracts.js";
import type { ResolvedTarget } from "../src/config.js";
import {
  createProbationFn,
  DEFAULT_PROBATION_MIN_SAMPLES,
  orderByUsability,
  probationLabel,
  probationLabelForAttempt,
  resolveProbation,
  resolveProbationSettings,
  targetUsability,
  type CostClassFn,
  type ProbationFn,
  type ProbationVerdict,
} from "../src/candidate-runner.js";

/**
 * The probation band (packet P13, half b): a free-class deployment with fewer than
 * `minSamples` served-request samples leads its pool so the relay gathers data on it.
 *
 * These are UNIT tests — every evidence source is a stub. The end-to-end walks (real proxy,
 * real probe cache, both fronts) live in `test/pool-failover.test.ts`.
 */

function target(provider: string, model: string): ResolvedTarget {
  return { provider, base: `http://${provider}`, kind: "openai", model, authHeader: "authorization", timeoutMs: 1000 };
}

function identity(provider: string, model: string): ProviderTargetIdentity {
  return { provider, model, kind: "openai", credentialId: makeCredentialId(provider) };
}

/** A probation evaluator that flags exactly the named models as untested free members. */
function probationFlagging(...models: string[]): ProbationFn {
  const untested: ProbationVerdict = { samples: 0, minSamples: 5 };
  return (attempt) =>
    models.includes(attempt.target.model ?? "") ? { ...untested } : null;
}

const freeCost: CostClassFn = () => "free";

describe("resolveProbationSettings", () => {
  it("defaults ON with minSamples 5 when absent", () => {
    expect(resolveProbationSettings(undefined)).toEqual({ enabled: true, minSamples: 5 });
    expect(DEFAULT_PROBATION_MIN_SAMPLES).toBe(5);
  });

  it("normalizes the boolean shorthand", () => {
    expect(resolveProbationSettings({ enabled: false }).enabled).toBe(false);
    expect(resolveProbationSettings({ enabled: true })).toEqual({ enabled: true, minSamples: 5 });
  });

  it("round-trips minSamples", () => {
    expect(resolveProbationSettings({ minSamples: 3 })).toEqual({ enabled: true, minSamples: 3 });
  });
});

describe("resolveProbation", () => {
  const attempt = (model: string): ResolvedAttempt =>
    resolveAttempt(target("p", model));

  it("places a free member with 0 samples in probation", () => {
    const verdict = resolveProbation(
      { readRequestSamples: () => 0, costClassOf: freeCost, settings: undefined },
      attempt("m-new"),
    );
    expect(verdict).toEqual({ samples: 0, minSamples: 5 });
  });

  it("leaves the band once samples reach minSamples", () => {
    expect(
      resolveProbation(
        { readRequestSamples: () => 5, costClassOf: freeCost, settings: undefined },
        attempt("m-new"),
      ),
    ).toBeNull();
  });

  it("honours a configured minSamples", () => {
    const deps = { readRequestSamples: () => 2, costClassOf: freeCost, settings: { minSamples: 3 } };
    expect(resolveProbation(deps, attempt("m-new"))).toEqual({ samples: 2, minSamples: 3 });
    expect(
      resolveProbation({ ...deps, settings: { minSamples: 2 } }, attempt("m-new")),
    ).toBeNull();
  });

  it("never places a paid or unknown-cost member", () => {
    for (const cost of ["paid", "unknown", undefined] as const) {
      expect(
        resolveProbation(
          { readRequestSamples: () => 0, costClassOf: () => cost, settings: undefined },
          attempt("m-new"),
        ),
      ).toBeNull();
    }
  });

  it("is unreachable when disabled, and measures nothing without a model", () => {
    const off = { readRequestSamples: () => 0, costClassOf: freeCost, settings: { enabled: false } };
    expect(resolveProbation(off, attempt("m-new"))).toBeNull();
    const noModel = resolveAttempt({ provider: "p", base: "http://p", kind: "anthropic", authHeader: "x-api-key", timeoutMs: 1000 });
    expect(
      resolveProbation(
        { readRequestSamples: () => 0, costClassOf: freeCost, settings: undefined },
        noModel,
      ),
    ).toBeNull();
  });

  it("createProbationFn degrades to no opinion when the reader throws", () => {
    const fn = createProbationFn({
      readRequestSamples: () => { throw new Error("boom"); },
      costClassOf: freeCost,
      settings: undefined,
    });
    expect(fn(attempt("m-new"), Date.now())).toBeNull();
  });
});

describe("targetUsability with probation", () => {
  it("reports probation for an untested free member", () => {
    const cb = new CircuitBreaker();
    const usability = targetUsability(
      resolveAttempt(target("p", "m-new")),
      cb,
      Date.now(),
      null,
      null,
      null,
      probationFlagging("m-new"),
    );
    expect(usability).toBe("probation");
  });

  it("lets every stronger band outrank probation", () => {
    const now = Date.now();
    // Cooling (breaker-open) outranks.
    const coolingCb = new CircuitBreaker();
    coolingCb.recordOutcome(identity("p", "m-new"), { ok: false, status: 429, elapsedMs: 5 });
    expect(
      targetUsability(resolveAttempt(target("p", "m-new")), coolingCb, now, null, null, null, probationFlagging("m-new")),
    ).toBe("cooling");
    // Credential fault outranks.
    const faultCb = new CircuitBreaker();
    faultCb.recordCredentialFault(identity("p", "m-new"), 401);
    expect(
      targetUsability(resolveAttempt(target("p", "m-new")), faultCb, now, null, null, null, probationFlagging("m-new")),
    ).toBe("credential-fault");
    // Latency demotion outranks.
    const slow = () => ({ basis: "absolute" as const, measured: 99_999, threshold: 1000, samples: 9 });
    expect(
      targetUsability(resolveAttempt(target("p", "m-new")), new CircuitBreaker(), now, null, null, slow, probationFlagging("m-new")),
    ).toBe("slow");
  });
});

describe("orderByUsability — probation leads, live keeps config order", () => {
  const t = (n: string, model = "m"): ResolvedTarget => ({ provider: n, base: `http://${n}`, kind: "openai", model, authHeader: "authorization", timeoutMs: 1000 });

  it("places the probation band AHEAD of live, config order within the band", () => {
    // Config order is [measured, untested-a, untested-b]: probation must reorder, live must not.
    const attempts = [t("measured", "m-known"), t("second", "m-new-b"), t("first", "m-new-a")]
      .map((tg) => resolveAttempt(tg));
    const out = orderByUsability(
      attempts, new CircuitBreaker(), Date.now(), null, null, null,
      probationFlagging("m-new-a", "m-new-b"),
    );
    expect(out.map((x) => x.target.provider)).toEqual(["second", "first", "measured"]);
  });

  it("orders the full band sequence probation → live → slow → credential-fault → cooling", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(identity("cool", "m"), { ok: false, status: 429, elapsedMs: 5 });
    cb.recordCredentialFault(identity("fault", "m"), 401);
    const slow = (attempt: ResolvedAttempt) =>
      attempt.target.provider === "slow"
        ? { basis: "absolute" as const, measured: 99_999, threshold: 1000, samples: 9 }
        : null;
    const attempts = [t("cool"), t("fault"), t("slow"), t("live", "m-known"), t("prob")]
      .map((tg) => resolveAttempt(tg));
    const out = orderByUsability(
      attempts, cb, Date.now(), null, null, slow, probationFlagging("m"),
    );
    // "prob" is the only otherwise-live member flagged probation; cooling/fault/slow are
    // flagged too but outranked — that IS the outranking, asserted as an order.
    expect(out.map((x) => x.target.provider)).toEqual(["prob", "live", "slow", "fault", "cool"]);
  });

  it("drops nothing: every candidate is still walked", () => {
    const attempts = [t("a", "m-new"), t("b", "m-known")].map((tg) => resolveAttempt(tg));
    const out = orderByUsability(attempts, new CircuitBreaker(), Date.now(), null, null, null, probationFlagging("m-new"));
    expect(out).toHaveLength(2);
  });

  it("disabled probation yields today's order exactly — byte for byte", () => {
    // The same fixture, three ways: no evaluator, a disabled evaluator, and the live band.
    // The first two must agree exactly; the third must differ (the untested member leads).
    const fixture = [t("measured", "m-known"), t("untested", "m-new")].map((tg) => resolveAttempt(tg));
    const now = Date.now();
    const today = orderByUsability(fixture, new CircuitBreaker(), now).map((x) => x.target.provider);
    const disabled = createProbationFn({ readRequestSamples: () => 0, costClassOf: freeCost, settings: { enabled: false } });
    expect(
      orderByUsability(fixture, new CircuitBreaker(), now, null, null, null, disabled).map((x) => x.target.provider),
    ).toEqual(today);
    expect(today).toEqual(["measured", "untested"]);
    expect(
      orderByUsability(fixture, new CircuitBreaker(), now, null, null, null, probationFlagging("m-new")).map((x) => x.target.provider),
    ).toEqual(["untested", "measured"]);
  });
});

describe("probation announcement labels", () => {
  it("labels a verdict as \"<spec> (n of minSamples request samples)\"", () => {
    expect(probationLabel("opencode/muse-spark-1.3-contributor-free", { samples: 0, minSamples: 5 })).toBe(
      "opencode/muse-spark-1.3-contributor-free (0 of 5 request samples)",
    );
    expect(probationLabel("p/m", { samples: 4, minSamples: 5 })).toBe("p/m (4 of 5 request samples)");
  });

  it("probationLabelForAttempt names the SERVING attempt's verdict, else null", () => {
    const now = Date.now();
    const serving = resolveAttempt(target("p", "m-new"));
    expect(probationLabelForAttempt({ probation: probationFlagging("m-new") }, serving, now)).toBe(
      "p/m-new (0 of 5 request samples)",
    );
    expect(probationLabelForAttempt({ probation: probationFlagging("m-new") }, resolveAttempt(target("p", "m-known")), now)).toBeNull();
    expect(probationLabelForAttempt({}, serving, now)).toBeNull();
  });
});
