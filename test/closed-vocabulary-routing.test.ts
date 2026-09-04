import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { errorOrigin } from "../src/backend.js";
import { factResetInputs } from "../src/availability.js";
import type { AttemptFailed, ProviderTargetIdentity } from "../src/kernel/contracts.js";
import {
  TOKEN_SOURCES, SPEND_PRICE_SOURCES, TOKEN_BASES, SPEND_SOURCES,
  LIMIT_BASES, REMAINING_BASES, LOCAL_USED_BASES, RESETS_AT_BASES,
} from "../src/dashboard-contract.js";

/**
 * The second half of the closed-vocabulary bug class (see `closed-vocabulary-coverage.test.ts` for
 * the first three and for the class itself). These four differ in one way that matters: each one's
 * fall-through fed a DECISION the relay acts on — which rung a reset is attributed to, whether a
 * provider's breaker is charged, whether a failure is retried, whether an event is counted — not
 * merely a label a human reads.
 */

const src = (name: string) => readFileSync(join(__dirname, "..", "src", name), "utf8");

const target: ProviderTargetIdentity = {
  provider: "p", credentialId: "p#default", model: "m", kind: "openai",
};

function failWith(provenance: AttemptFailed["provenance"]): AttemptFailed {
  return {
    target, terminal: "failed", provenance, failure: "http",
    status: 502, retryAfterMs: null, completedAt: 1_050, elapsedMs: 50,
  };
}

function completeOneFailure(provenance: AttemptFailed["provenance"]): CircuitBreaker {
  const breaker = new CircuitBreaker();
  const begun = breaker.beginAttempt(target);
  if (!begun.ok) throw new Error(begun.error.kind);
  breaker.completeAttempt(begun.value, failWith(provenance));
  return breaker;
}

describe("OutcomeProvenance — the provider's breaker is charged only for the provider's faults", () => {
  it("a DEADLINE failure still reaches provider health", () => {
    // Regression guard, and the reason this file exists. While converting the old
    // `if (provenance === "relay-mapper-defect") return;` into a table, a lane wrote
    // `deadline: false` — which would have made a timing-out deployment permanently healthy, in
    // the component whose paradigm case is exactly a hanging provider. The full gate passed WITH
    // that regression, because nothing covered it. This is that cover.
    const states = [...completeOneFailure("deadline").getAllStates()];
    expect(states.length, "a deadline failure must record provider health state").toBeGreaterThan(0);
  });

  it("an upstream failure reaches provider health", () => {
    expect([...completeOneFailure("upstream").getAllStates()].length).toBeGreaterThan(0);
  });

  it("an invalid-upstream-envelope failure reaches provider health", () => {
    expect([...completeOneFailure("invalid-upstream-envelope").getAllStates()].length).toBeGreaterThan(0);
  });

  it("a relay-mapper-defect does NOT charge the provider", () => {
    // The relay's own bug must not demote a healthy deployment — the line CLAUDE.md draws twice in
    // prose: "a cap never registers on the breaker, it is config, not health", and the dialect
    // refusal's "the deployment's failure budget is untouched".
    const states = [...completeOneFailure("relay-mapper-defect").getAllStates()];
    expect(states.length, "a relay-local fault must not create provider health state").toBe(0);
  });

  it("has ONE definition — the health decision is not a hand-written provenance test", () => {
    const text = src("circuit-breaker.ts");
    expect(text).toMatch(/satisfies Record<OutcomeProvenance, boolean>/);
    expect(text).not.toMatch(/if \(outcome\.provenance === "relay-mapper-defect"\) return;/);
  });
});

describe("ErrorOrigin — an unknown origin is not silently blamed on the provider", () => {
  const withHeader = (v: string | null) =>
    new Response("{}", { headers: v === null ? {} : { "x-llm-relay-error-origin": v } });

  it("maps each declared member to itself", () => {
    expect(errorOrigin(withHeader("upstream"))).toBe("upstream");
    expect(errorOrigin(withHeader("local"))).toBe("local");
  });

  it("returns null for an absent or unrecognised origin, leaving the default to the caller", () => {
    // Callers default null to "upstream" deliberately: the provider DID answer. What must not
    // happen is a DECLARED member being rejected here — which is exactly what a hand-written
    // two-literal test does the moment a third member is added, and `upstream` also means
    // RETRIABLE, so the walk would reroll other members for a relay-local fault.
    expect(errorOrigin(withHeader(null))).toBeNull();
    expect(errorOrigin(withHeader("something-else"))).toBeNull();
  });

  it("has ONE definition — the declared set is derived from the type, not re-listed", () => {
    const text = src("backend.ts");
    expect(text).toMatch(/satisfies Record<ErrorOrigin, true>/);
    expect(text).not.toMatch(/v === "upstream" \|\| v === "local"/);
  });
});

describe("FactResetBasis — a reset's rung comes from one table", () => {
  const at = 10_000;
  const inputs = (untilBasis: "retry-after" | "stated-body" | "reviewed-field" | "reviewed-fixed") =>
    factResetInputs({
      facts: [{ kind: "allowance-exhausted", until: at + 1_000, untilBasis }],
      now: at,
      remaining: 0,
      observationReset: null,
    });

  it("puts a provider-stated basis on rung 1 and a reviewed basis on rung 2", () => {
    // The rungs are not interchangeable: rung 1 is what the provider said, rung 2 is a reviewer's
    // assertion. The old unconditional `else` defaulted an unrecognised basis to rung 1 — the
    // STRONGER claim, which is the wrong direction for a provenance fallback.
    expect(inputs("retry-after").providerStated).toBe(at + 1_000);
    expect(inputs("retry-after").reviewedRule).toBeNull();
    expect(inputs("stated-body").providerStated).toBe(at + 1_000);
    expect(inputs("reviewed-field").reviewedRule).toBe(at + 1_000);
    expect(inputs("reviewed-field").providerStated).toBeNull();
    expect(inputs("reviewed-fixed").reviewedRule).toBe(at + 1_000);
  });

  it("has ONE definition — the runtime gate derives from the table, not a parallel list", () => {
    const text = src("target-facts.ts");
    expect(text).toMatch(/satisfies Record<FactResetBasis, "stated" \| "reviewed">/);
    // The old gate was a bare ReadonlySet<string>: the compiler could not connect it to the type,
    // so a fifth member would have been silently dropped at load and at recordFact.
    expect(text).not.toMatch(/const UNTIL_BASES: ReadonlySet<string>/);
  });
});

describe("AccountingEvent — an unhandled event is a marked loss, never a silent success", () => {
  it("has ONE definition — the dispatcher is exhaustive, not an if/else ladder", () => {
    // The old ladder had no final else, so a fifth event type returned normally: recorded as a
    // SUCCESS that did nothing. For a store whose loss markers exist to make exactly that visible,
    // that is the worst available direction.
    const text = src("accounting-store.ts");
    expect(text).toMatch(/switch \(event\.type\)/);
    expect(text).toMatch(/const _never: never = event/);
    expect(text).not.toMatch(/if \(event\.type === "request-started"\) this\.onRequestStarted/);
  });
});

describe("dashboard wire unions derive from their own const arrays", () => {
  it("every union's members come from one array, so validators and types cannot drift", () => {
    // Validators used the arrays; producers used hand-written unions; nothing connected them. A
    // member added to one side was accepted by the validator and unrepresentable to producers, or
    // the reverse. Deriving the type makes the array the single source of truth.
    const text = src("dashboard-contract.ts");
    for (const name of [
      "TOKEN_SOURCES", "SPEND_PRICE_SOURCES", "TOKEN_BASES", "SPEND_SOURCES",
      "LIMIT_BASES", "REMAINING_BASES", "LOCAL_USED_BASES", "RESETS_AT_BASES",
    ]) {
      expect(text, `${name} must have a derived type`).toMatch(
        new RegExp(`= \\(typeof ${name}\\)\\[number\\]`),
      );
    }
  });

  it("keeps every documented member — deriving must not quietly drop one", () => {
    // The arrays ARE the vocabulary now, so pin their contents: a deletion here would narrow the
    // wire contract with no type error anywhere to catch it.
    expect([...TOKEN_SOURCES]).toEqual(["provider_reported", "relay_estimated"]);
    expect([...SPEND_PRICE_SOURCES]).toEqual(["provider_published", "reference"]);
    expect([...TOKEN_BASES]).toEqual(["reported", "estimated"]);
    expect([...SPEND_SOURCES]).toEqual(["provider_reported", "relay_estimated", "unknown"]);
    expect([...LIMIT_BASES]).toEqual(["provider_stated", "configured", "learned", "published"]);
    expect([...REMAINING_BASES]).toEqual([
      "provider_stated", "derived_provider_stated", "derived_configured",
      "derived_learned", "derived_published",
    ]);
    expect([...LOCAL_USED_BASES]).toEqual(["reported", "estimated", "mixed", "relay_counted"]);
    expect([...RESETS_AT_BASES]).toEqual(["provider_stated", "reviewed_rule", "derived_boundary"]);
  });
});

describe("TargetUsability — usability classifiers are exhaustive over all bands", () => {
  it("has ONE definition — orderByUsability consumers do not use an unconditional else", () => {
    const text = src("candidate-runner.ts");
    expect(text).toMatch(/switch \(usability\)/);
    expect(text).toMatch(/const _never: never = usability/);
    expect(text).not.toMatch(/else live\.push/);
  });
});

