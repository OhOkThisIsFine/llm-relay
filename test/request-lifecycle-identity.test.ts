import { describe, expect, it } from "vitest";
import { AttemptLifecycle } from "../src/kernel/request-lifecycle.js";
import type { AttemptOutcome, ProviderTargetIdentity } from "../src/kernel/contracts.js";

const identity = (credentialId: string): ProviderTargetIdentity => ({
  provider: "openai",
  model: "gpt-test",
  kind: "openai",
  credentialId,
});

const success = (target: ProviderTargetIdentity): AttemptOutcome => ({
  target,
  terminal: "succeeded",
  provenance: "upstream",
  status: 200,
  completedAt: 1,
  elapsedMs: 1,
});

describe("request lifecycle credential identity", () => {
  it("rejects completion under a different credential slot", () => {
    const lifecycle = new AttemptLifecycle();
    const first = identity("openai#default");
    const second = identity("openai#backup");
    const begun = lifecycle.beginAttempt(first);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const rejected = lifecycle.completeAttempt(begun.value, success(second));
    expect(rejected).toMatchObject({ ok: false, error: { kind: "cross-target" } });
    expect(lifecycle.completeAttempt(begun.value, success(first)).ok).toBe(true);
  });
});
