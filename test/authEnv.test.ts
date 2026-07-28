import { describe, it, expect } from "vitest";
import { candidateEnvNames, resolveAuthEnv } from "../src/authEnv.js";

describe("candidateEnvNames", () => {
  it("puts the declared name first, then known aliases", () => {
    const names = candidateEnvNames("gemini", "GEMINI_API_KEY");
    expect(names[0]).toBe("GEMINI_API_KEY");
    expect(names).toContain("GOOGLEAI_API_KEY");
    expect(names).toContain("GOOGLE_API_KEY");
  });

  it("derives candidates for a provider with no curated aliases", () => {
    expect(candidateEnvNames("my-host.2")).toEqual(["MY_HOST_2_API_KEY", "MY_HOST_2_KEY", "MY_HOST_2_TOKEN"]);
  });

  it("never repeats a name", () => {
    const names = candidateEnvNames("groq", "GROQ_API_KEY");
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("resolveAuthEnv", () => {
  it("prefers the declared name when it is set", () => {
    const r = resolveAuthEnv("gemini", "GEMINI_API_KEY", { GEMINI_API_KEY: "a", GOOGLEAI_API_KEY: "b" });
    expect(r.name).toBe("GEMINI_API_KEY");
    expect(r.viaAlias).toBe(false);
  });

  it("falls back to an alias when the declared name is unset", () => {
    const r = resolveAuthEnv("gemini", "GEMINI_API_KEY", { GOOGLEAI_API_KEY: "b" });
    expect(r.name).toBe("GOOGLEAI_API_KEY");
    expect(r.viaAlias).toBe(true);
  });

  it("ignores an env var that is set but blank", () => {
    const r = resolveAuthEnv("gemini", "GEMINI_API_KEY", { GEMINI_API_KEY: "   ", GOOGLEAI_API_KEY: "b" });
    expect(r.name).toBe("GOOGLEAI_API_KEY");
  });

  it("keeps the declared name when nothing is set, so diagnostics stay stable", () => {
    const r = resolveAuthEnv("gemini", "GEMINI_API_KEY", {});
    expect(r.name).toBe("GEMINI_API_KEY");
    expect(r.viaAlias).toBe(false);
  });

  it("does not borrow another provider's key", () => {
    const r = resolveAuthEnv("gemini", "GEMINI_API_KEY", { GROQ_API_KEY: "g", OPENAI_API_KEY: "o" });
    expect(r.name).toBe("GEMINI_API_KEY");
    expect(r.viaAlias).toBe(false);
  });
});
