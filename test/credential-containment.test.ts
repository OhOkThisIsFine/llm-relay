import { describe, expect, it } from "vitest";
import { credentialState, keyIsPresent, resolveAuthEnv } from "../src/authEnv.js";

/**
 * Pins ARC-c9155ca2-2 / SEC-a5e9156b: containment was inferred from key presence
 * rather than declared, so a declared-but-unset authEnv took the same branch as
 * an intentional passthrough and the caller's own credential was forwarded to a
 * third-party base URL.
 */
describe("credential containment is declared, not inferred", () => {
  it("distinguishes not-declared from declared-missing", () => {
    // These two were identically falsy under the old `!!apiKey` test.
    expect(credentialState(undefined, {})).toBe("not-declared");
    expect(credentialState("SOME_KEY", {})).toBe("declared-missing");
    expect(credentialState("SOME_KEY", { SOME_KEY: "sk-live" })).toBe("declared-present");
  });

  it("treats a whitespace-only key as missing, not present", () => {
    // config.ts used Boolean() with no trim while server.ts trimmed, so a blank
    // key was "active" to the target filter and absent to header construction.
    expect(keyIsPresent("   ")).toBe(false);
    expect(keyIsPresent("")).toBe(false);
    expect(keyIsPresent(undefined)).toBe(false);
    expect(keyIsPresent("\t\n")).toBe(false);
    expect(keyIsPresent(" sk-live ")).toBe(true);
    expect(credentialState("BLANK_KEY", { BLANK_KEY: "   " })).toBe("declared-missing");
  });

  it("does NOT derive state from resolveAuthEnv returning a name", () => {
    // The trap: the anthropic alias list contains ANTHROPIC_API_KEY and
    // ANTHROPIC_AUTH_TOKEN, so a provider with NO declared authEnv still
    // resolves to a name whenever either is set. Deriving state from that name
    // would classify an intentional passthrough as declared-present, making it
    // inject a key and strip the caller's own token — the exact inversion of
    // what a passthrough is for.
    const env = { ANTHROPIC_API_KEY: "sk-ant-from-environment" };
    const resolution = resolveAuthEnv("anthropic", undefined, env);
    expect(resolution.name).toBe("ANTHROPIC_API_KEY");
    expect(resolution.viaAlias).toBe(true);

    // Same inputs, correct answer: no authEnv declared means passthrough.
    expect(credentialState(undefined, env)).toBe("not-declared");
  });

  it("keeps the alias-substitution signal available to callers", () => {
    const env = { ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-x" };
    const r = resolveAuthEnv("anthropic", "ANTHROPIC_API_KEY", env);
    expect(r.name).toBe("ANTHROPIC_AUTH_TOKEN");
    expect(r.viaAlias).toBe(true);
    expect(r.candidates).toContain("ANTHROPIC_API_KEY");
  });

  it("never scans the environment for key-shaped names", () => {
    // A heuristic match would ship one provider's credential to another's endpoint.
    const env = { TOTALLY_UNRELATED_API_KEY: "sk-should-not-be-found" };
    const r = resolveAuthEnv("nim", "NVIDIA_API_KEY", env);
    expect(r.name).toBe("NVIDIA_API_KEY");
    expect(r.viaAlias).toBe(false);
    expect(r.candidates).not.toContain("TOTALLY_UNRELATED_API_KEY");
  });
});
