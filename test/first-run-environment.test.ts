import { describe, it, expect } from "vitest";
import { renderFirstRunEnvironment } from "../src/cli.js";

/**
 * The environment half of the first-run notice.
 *
 * ⚠ This file exists because adversarial review found the renderer shipped with NO seam and ZERO
 * coverage, while being the only part of the notice that makes factual claims about the operator's
 * machine. Two of its claims were wrong: it asserted "none is configured as a lane yet" without
 * checking anything, and its "…and N more" arithmetic was unpinned.
 */

const P = (displayName: string, hasKey: boolean, signupUrl?: string) => ({
  displayName,
  hasKey,
  ...(signupUrl === undefined ? {} : { signupUrl }),
});

describe("renderFirstRunEnvironment", () => {
  it("says nothing at all when there is nothing to report", () => {
    expect(renderFirstRunEnvironment({ detected: [], statuses: [] })).toBe("");
  });

  it("lists detected hosts by label", () => {
    const out = renderFirstRunEnvironment({
      detected: [{ label: "Codex" }, { label: "Antigravity" }],
      statuses: [],
    });
    expect(out).toContain("Detected on this machine: Codex, Antigravity.");
  });

  /**
   * ⚠ The corrected claim. The first version printed "none is configured as a lane yet"
   * unconditionally, which is false the moment an operator adds a ladder rung — a supported edit
   * that deliberately does not clear the first-run marker. The notice must not assert ladder state
   * it never checked.
   */
  it("makes NO claim about ladder membership — it points at the surface that knows", () => {
    const out = renderFirstRunEnvironment({ detected: [{ label: "Codex" }], statuses: [] });
    expect(out).not.toContain("none is configured");
    expect(out).toContain("llm-relay dispatch");
  });

  it("counts providers that already hold a key", () => {
    const out = renderFirstRunEnvironment({
      detected: [],
      statuses: [P("NIM", true), P("Groq", false, "https://groq.test"), P("Gemini", true)],
    });
    expect(out).toContain("Credentials: 2 of 3 configured providers have a key.");
  });

  it("prints a signup URL for each missing provider", () => {
    const out = renderFirstRunEnvironment({
      detected: [],
      statuses: [P("Groq", false, "https://groq.test")],
    });
    expect(out).toContain("Groq — sign up free: https://groq.test");
    expect(out).toContain("llm-relay onboard");
  });

  it("omits a missing provider that publishes no signup URL rather than printing an empty link", () => {
    const out = renderFirstRunEnvironment({ detected: [], statuses: [P("Mystery", false)] });
    expect(out).toContain("Credentials: 0 of 1");
    expect(out).not.toContain("Mystery — sign up");
    // With nothing actionable, it must not advertise the onboarding walk-through either.
    expect(out).not.toContain("llm-relay onboard");
  });

  it("caps the list at three and reports the remainder exactly", () => {
    const statuses = ["a", "b", "c", "d", "e"].map((n) => P(n, false, `https://${n}.test`));
    const out = renderFirstRunEnvironment({ detected: [], statuses });
    expect(out).toContain("a — sign up free");
    expect(out).toContain("c — sign up free");
    expect(out).not.toContain("d — sign up free");
    expect(out).toContain("…and 2 more.");
  });

  it("does not print a remainder line when exactly the cap is missing — off-by-one guard", () => {
    const statuses = ["a", "b", "c"].map((n) => P(n, false, `https://${n}.test`));
    const out = renderFirstRunEnvironment({ detected: [], statuses });
    expect(out).toContain("c — sign up free");
    expect(out).not.toContain("more.");
  });

  it("says nothing about signups when every provider already has a key", () => {
    const out = renderFirstRunEnvironment({ detected: [], statuses: [P("NIM", true)] });
    expect(out).toContain("Credentials: 1 of 1");
    expect(out).not.toContain("sign up free");
    expect(out).not.toContain("llm-relay onboard");
  });
});
