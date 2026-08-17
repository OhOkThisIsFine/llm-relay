import { describe, expect, it } from "vitest";
import { resolveAttempt } from "../src/resolved-attempt.js";
import type { ResolvedTarget } from "../src/config.js";

const target: ResolvedTarget = {
  provider: "openai",
  base: "https://example.invalid",
  kind: "openai",
  model: "gpt-test",
  authEnv: "OPENAI_API_KEY",
  authHeader: "authorization",
  timeoutMs: 1000,
};

describe("resolved attempts", () => {
  it("resolves the credential once and assigns the default slot identity", () => {
    const env = { OPENAI_API_KEY: "  secret  " };
    const attempt = resolveAttempt(target, env);
    expect(attempt.credentialId).toBe("openai#default");
    expect(attempt.credential).toEqual({
      state: "declared-present",
      value: "secret",
      envName: "OPENAI_API_KEY",
    });
    expect(attempt.target).toBe(target);
  });
});
