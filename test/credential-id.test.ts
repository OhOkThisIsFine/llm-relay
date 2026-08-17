import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_LABEL_PATTERN,
  DEFAULT_CREDENTIAL_LABEL,
  makeCredentialId,
  parseCredentialId,
} from "../src/credential-id.js";

describe("credential slot identity", () => {
  it("uses the default label and preserves provider identity", () => {
    expect(DEFAULT_CREDENTIAL_LABEL).toBe("default");
    expect(makeCredentialId("openai")).toBe("openai#default");
    expect(parseCredentialId("openai#default")).toEqual({ provider: "openai", label: "default" });
  });

  it("accepts only the documented label grammar", () => {
    expect(CREDENTIAL_LABEL_PATTERN.test("team_1.prod-A")).toBe(true);
    for (const label of ["", "has space", "a/b", "a#b", "x".repeat(33)]) {
      expect(() => makeCredentialId("p", label)).toThrow();
      expect(parseCredentialId(`p#${label}`)).toBeNull();
    }
    expect(parseCredentialId("#default")).toBeNull();
    expect(parseCredentialId("p#default#extra")).toBeNull();
  });
});
