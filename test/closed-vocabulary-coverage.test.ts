import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAuthHeaders } from "../src/authEnv.js";
import { ThinkTagStripFilter } from "../src/think-tags.js";

/**
 * Pins one recurring bug class, found by verifying the 2026-08-26 advisory findings against source.
 *
 * The shape: an OPEN CLASSIFIER over a CLOSED union — an unconditional `else`, or a `default:` with
 * no exhaustiveness assertion — where the default resolves to the STRONGER or RISKIER claim. A new
 * union member then compiles clean and produces a wrong answer, with no compile error anywhere.
 *
 * v0.50.0 already fixed one instance: `llm-relay eligibility` told the operator that six of the ten
 * fact kinds meant "gone from the provider", because a nested ternary's else-branch swallowed every
 * kind it did not name. These three are the same defect in three more vocabularies:
 *
 *  - `ContextWindowSource` — an unknown source rendered as "published by the serving provider",
 *    i.e. a guess labelled a first-party measurement (the provenance invariant).
 *  - `AuthHeaderName`      — an unknown header sent the operator's credential as `x-api-key`.
 *  - `FilterState`         — an unknown holding state silently DELETED the bytes it was holding,
 *    in a module whose entire stated purpose is losslessness.
 *
 * Each is now a total table, so a new member is a compile error AT THE TABLE. The mutation check
 * that proves it is recorded in the sprint doc; these tests pin the behaviour the tables must keep.
 */
describe("closed-vocabulary classifiers keep one total owner", () => {
  const src = (name: string) => readFileSync(join(__dirname, "..", "src", name), "utf8");

  describe("AuthHeaderName — the credential goes where the config said", () => {
    it("writes each declared header exactly", () => {
      expect(buildAuthHeaders("k", "x-api-key")).toEqual({ "x-api-key": "k" });
      expect(buildAuthHeaders("k", "authorization")).toEqual({ authorization: "Bearer k" });
    });

    it("does not double-prefix a value that already carries Bearer", () => {
      expect(buildAuthHeaders("Bearer k", "authorization")).toEqual({ authorization: "Bearer k" });
    });

    it("still returns no header at all when the key is absent", () => {
      // The containment contract: an absent key must produce NO header, never an empty one.
      expect(buildAuthHeaders(undefined, "x-api-key")).toEqual({});
      expect(buildAuthHeaders("   ", "authorization")).toEqual({});
    });

    it("trims the key before writing it", () => {
      expect(buildAuthHeaders("  k  ", "x-api-key")).toEqual({ "x-api-key": "k" });
    });

    it("has ONE definition — buildAuthHeaders must not hand-roll the header choice", () => {
      // The `destructive-coverage` precedent: pin the single owner mechanically, so the next
      // person to add a header cannot reintroduce the else-branch.
      const text = src("authEnv.ts");
      expect(text).toMatch(/satisfies Record<AuthHeaderName, \(value: string\) => Record<string, string>>/);
      expect(text).not.toMatch(/return \{ "x-api-key": value \};/);
    });
  });

  describe("FilterState — flush() never silently drops held bytes", () => {
    it("releases held text from lead-hold", () => {
      const f = new ThinkTagStripFilter();
      // A bare "<" is an undecided lead: it could still become "<think>".
      expect(f.push("<")).toBe("");
      expect(f.flush()).toBe("<");
    });

    it("releases held text from inside-think when the block never closes", () => {
      const f = new ThinkTagStripFilter();
      expect(f.push("<think>unclosed reasoning")).toBe("");
      // Lossless: an unclosed block is released byte-for-byte, never deleted.
      expect(f.flush()).toBe("<think>unclosed reasoning");
    });

    it("returns empty from a state that has already released", () => {
      const f = new ThinkTagStripFilter();
      expect(f.push("visible answer")).toBe("visible answer");
      expect(f.flush()).toBe("");
    });

    it("returns empty from done, after a complete block was stripped", () => {
      const f = new ThinkTagStripFilter();
      expect(f.push("<think>hidden</think>answer")).toBe("answer");
      expect(f.flush()).toBe("");
    });

    it("has ONE definition — flush() must not hand-roll the state test", () => {
      const text = src("think-tags.ts");
      expect(text).toMatch(/as const satisfies Record<FilterState, boolean>/);
      expect(text).not.toMatch(/if \(this\.state === "lead-hold" \|\| this\.state === "inside-think"\) return this\.releaseLosslessly\(\);/);
    });
  });

  describe("ContextWindowSource — provenance is never upgraded by a fall-through", () => {
    it("has ONE definition — the lane renderer must not hand-roll the basis ternary", () => {
      // The label table lives beside the renderer in cli.ts (CLI prose does not belong in the pure
      // metadata module), so it is pinned by source the same way the dashboard error-code
      // vocabulary is. `satisfies` is what makes a new source a compile error at the table.
      const text = src("cli.ts");
      expect(text).toMatch(/satisfies Record<ContextWindowSource, string>/);
      expect(text).not.toMatch(/l\.contextWindowSource === "observed"\s*\n?\s*\?/);
    });

    it("keeps every rendered basis string byte-identical to the pre-table wording", () => {
      // `llm-relay dispatch` output is user-facing. A table change must not reword it.
      const text = src("cli.ts");
      expect(text).toContain("learned from what this deployment stated when it refused an over-length request");
      expect(text).toContain("synced snapshot, same model id on another host");
      expect(text).toContain("published by the serving provider");
    });

    it("renders 'nothing known' rather than inventing a provenance when the source is absent", () => {
      // Found by the compiler while making the table total: `contextWindowSource` is optional, and
      // the old ternary's else-branch labelled an ABSENT source "published by the serving
      // provider". The two fields are written together in dispatch.ts, so this cannot occur — but
      // the renderer now tests both rather than asserting one from the other, because the
      // alternative is inventing a provenance for a number whose provenance we do not have.
      const text = src("cli.ts");
      expect(text).toMatch(/l\.contextWindow === undefined \|\| l\.contextWindowSource === undefined/);
    });
  });
});
