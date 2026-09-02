import { afterEach, describe, expect, it } from "vitest";
import { contextCeilingFor } from "../src/server.js";
import { recordObservedContextLimit } from "../src/context-limits.js";
import { resetFacts } from "../src/target-facts.js";
import type { ResolvedTarget } from "../src/config-types.js";

function target(provider: string, model: string | null): ResolvedTarget {
  return { provider, model, kind: "openai", base: "https://example.test" } as unknown as ResolvedTarget;
}

function catalogStating(contextLength: number | null) {
  return {
    cachedLimits: () => (contextLength === null ? null : ({ contextLength } as never)),
  };
}

afterEach(() => {
  resetFacts();
});

describe("contextCeilingFor", () => {
  it("uses the provider's published figure when nothing was observed", () => {
    const ceiling = contextCeilingFor(target("p", "m"), catalogStating(8000));
    expect(ceiling).toEqual({ limit: 8000, basis: "published" });
  });

  // ⚠ The learned rung is FIRST-PARTY evidence about this exact deployment — the provider stated
  // this number while refusing an over-length request — so it outranks a catalogue figure that may
  // be generic or stale. This is the `contextWindowResolver` order.
  it("prefers a ceiling the deployment itself stated over the published one", () => {
    recordObservedContextLimit("p", "m", 4096);
    const ceiling = contextCeilingFor(target("p", "m"), catalogStating(8000));
    expect(ceiling).toEqual({ limit: 4096, basis: "observed" });
  });

  // ⚠⚠ The BASIS is the point of the return shape. The refusal body names where the number came
  // from, and calling a learned measurement something the provider "publishes" reports a
  // measurement as a publication — the one thing the provenance invariant forbids.
  it("reports the observed basis so the refusal cannot claim the provider published it", () => {
    recordObservedContextLimit("p", "m", 4096);
    expect(contextCeilingFor(target("p", "m"), catalogStating(8000))?.basis).toBe("observed");
    expect(contextCeilingFor(target("p", "other"), catalogStating(8000))?.basis).toBe("published");
  });

  // ⚠ Null must stay "no guardrail": the request goes upstream and the backend answers with its
  // own authoritative error. A 400 built from a number nobody stated is worse than a true one.
  it("answers null when neither rung states a ceiling", () => {
    expect(contextCeilingFor(target("p", "m"), catalogStating(null))).toBeNull();
  });

  it("answers null for a target carrying no model", () => {
    recordObservedContextLimit("p", "m", 4096);
    expect(contextCeilingFor(target("p", null), catalogStating(8000))).toBeNull();
  });

  it("does not borrow another deployment's observed ceiling", () => {
    recordObservedContextLimit("p", "m", 4096);
    expect(contextCeilingFor(target("other", "m"), catalogStating(8000))).toEqual({
      limit: 8000,
      basis: "published",
    });
  });
});
