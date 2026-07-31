import { describe, expect, it } from "vitest";
import {
  buildAuthHeaders,
  credentialState,
  keyIsPresent,
  readCredential,
  resolveAuthEnv,
} from "../src/authEnv.js";

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

  it("resolves provider env aliases when declared variable is unset", () => {
    const env = { GOOGLE_API_KEY: "sk-google-key" };
    expect(credentialState("GEMINI_API_KEY", env)).toBe("declared-present");
    expect(readCredential("GEMINI_API_KEY", env)).toBe("sk-google-key");
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

describe("readCredential", () => {
  it("returns the trimmed value only when the credential is present", () => {
    expect(readCredential("K", { K: "  sk-live  " })).toBe("sk-live");
    expect(readCredential("K", { K: "   " })).toBeUndefined();
    expect(readCredential("K", {})).toBeUndefined();
  });

  it("returns undefined when no authEnv is declared, without consulting the env", () => {
    // A passthrough declares nothing; it must not pick up an ambient key.
    expect(readCredential(undefined, { ANTHROPIC_API_KEY: "sk-ant-ambient" })).toBeUndefined();
  });

  it("agrees with credentialState on every input", () => {
    const cases: Array<[string | undefined, NodeJS.ProcessEnv]> = [
      [undefined, {}],
      [undefined, { K: "sk" }],
      ["K", {}],
      ["K", { K: "" }],
      ["K", { K: "  " }],
      ["K", { K: "sk" }],
    ];
    for (const [declared, env] of cases) {
      const hasValue = readCredential(declared, env) !== undefined;
      expect(hasValue).toBe(credentialState(declared, env) === "declared-present");
    }
  });
});

describe("buildAuthHeaders is the single construction site", () => {
  it("injects the credential into the DECLARED header", () => {
    expect(buildAuthHeaders("sk-live", "x-api-key")).toEqual({ "x-api-key": "sk-live" });
    expect(buildAuthHeaders("sk-live", "authorization")).toEqual({ authorization: "Bearer sk-live" });
  });

  it("builds NOTHING for an absent or blank credential", () => {
    // The builder, not the caller, is what keeps an empty `x-api-key` or a bare
    // `Bearer` off the wire — that is the point of having one construction site.
    for (const header of ["x-api-key", "authorization"] as const) {
      expect(buildAuthHeaders(undefined, header)).toEqual({});
      expect(buildAuthHeaders("", header)).toEqual({});
      expect(buildAuthHeaders("   ", header)).toEqual({});
      expect(buildAuthHeaders("\t\n", header)).toEqual({});
    }
  });

  it("trims the value, so a key pasted with a trailing newline still authenticates", () => {
    expect(buildAuthHeaders(" sk-live\n", "x-api-key")).toEqual({ "x-api-key": "sk-live" });
    expect(buildAuthHeaders(" sk-live\n", "authorization")).toEqual({ authorization: "Bearer sk-live" });
  });

  it("prefixes Bearer idempotently", () => {
    // Three existing sites accept a value that already carries the prefix;
    // double-prefixing it would break them on migration.
    expect(buildAuthHeaders("Bearer sk-live", "authorization")).toEqual({ authorization: "Bearer sk-live" });
    expect(buildAuthHeaders("  Bearer sk-live  ", "authorization")).toEqual({ authorization: "Bearer sk-live" });
    // x-api-key is sent verbatim — it has no prefix convention.
    expect(buildAuthHeaders("Bearer sk-live", "x-api-key")).toEqual({ "x-api-key": "Bearer sk-live" });
  });

  it("emits exactly one credential header, never both", () => {
    expect(Object.keys(buildAuthHeaders("sk-live", "x-api-key"))).toEqual(["x-api-key"]);
    expect(Object.keys(buildAuthHeaders("sk-live", "authorization"))).toEqual(["authorization"]);
  });

  it("composes with readCredential end to end", () => {
    const env = { NVIDIA_API_KEY: " nvapi-xyz \n" };
    expect(buildAuthHeaders(readCredential("NVIDIA_API_KEY", env), "authorization")).toEqual({
      authorization: "Bearer nvapi-xyz",
    });
    // A declared-but-unset credential yields no header at all.
    expect(buildAuthHeaders(readCredential("MISSING_KEY", env), "authorization")).toEqual({});
  });
});
