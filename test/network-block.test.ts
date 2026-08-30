import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifyNetworkBlock,
  NETWORK_BLOCK_PATTERNS,
  type NetworkBlockBasis,
} from "../src/network-block.js";

describe("network-block advisory", () => {
  it("recognises the wording measured on groq", () => {
    const hint = classifyNetworkBlock("access denied. please check your network settings.");
    expect(hint).not.toBeNull();
    expect(hint?.phrase).toBe("check your network settings");
    expect(hint?.advice).toMatch(/VPN/);
  });

  /**
   * The advice must NOT tell the operator to reject the signature. `reject` writes it to the
   * store's `ignored` set, where it stays suppressed, so following that advice would guarantee
   * the next VPN episode queues nothing and this warning never fires again. The first draft of
   * this module recommended exactly that; the assertion exists so it cannot come back.
   */
  it("tells the operator to leave the item pending, never to reject it", () => {
    const advice = classifyNetworkBlock("access denied. please check your network settings.")?.advice ?? "";
    expect(advice).toMatch(/PENDING/);
    expect(advice).toMatch(/suppresses/);
    expect(advice).not.toMatch(/verdict for this signature is .reject./);
  });

  it("matches regardless of case", () => {
    expect(classifyNetworkBlock("Access Denied. Please Check Your Network Settings.")).not.toBeNull();
  });

  // Negative controls. The advisory must stay silent on the refusals that DO have a fact class,
  // or it would talk over the interpretation the operator actually needs to make.
  it.each([
    ["a spent allowance", "check your subscription on <url>"],
    ["a rate limit", "rate limit exceeded, limit 60 requests per minute"],
    ["a missing model", "the model does not exist or you do not have access to it"],
    ["an empty message", ""],
  ])("stays silent on %s", (_label, message) => {
    expect(classifyNetworkBlock(message)).toBeNull();
  });

  /**
   * The honesty rule this module states about itself: only wording this relay has actually seen
   * refuse a request is admitted. A pattern added later with no provenance, or with a basis
   * outside the closed set, fails here rather than shipping as advice nobody can audit.
   */
  it("every pattern declares a known basis and a non-empty provenance", () => {
    const known: readonly NetworkBlockBasis[] = ["first-party-observed"];
    expect(NETWORK_BLOCK_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of NETWORK_BLOCK_PATTERNS) {
      expect(known).toContain(pattern.basis);
      expect(pattern.provenance.trim().length).toBeGreaterThan(0);
      // A phrase is matched as a lower-case substring, so an upper-case one could never fire.
      expect(pattern.phrase).toBe(pattern.phrase.toLowerCase());
    }
  });

  /**
   * Structural guard for "display-only". The module's whole claim is that it records no fact and
   * reaches no store, and the cheapest way to keep that true is to have nothing to reach with:
   * it must import nothing at all. A future edit that pulls in `target-facts.js` to "also record
   * it" fails here, at the claim, rather than silently asserting a deployment fact the evidence
   * does not support.
   */
  it("imports nothing, so it cannot write to any store", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/network-block.ts", import.meta.url)), "utf8");
    // A line scan rather than a multiline regex: `^\s*import` backtracks super-linearly, and the
    // question here is per-line anyway.
    const importLines = source.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("import "));
    expect(importLines).toEqual([]);
    expect(source.includes("require(")).toBe(false);
  });
});
