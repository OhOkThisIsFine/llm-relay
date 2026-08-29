import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateDiffText, repoFileReader } from "../../src/delegate-gate/gate.js";
import type { FindingClass } from "../../src/delegate-gate/types.js";

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const repoRoot = join(fixturesDir, "repo");
const readOriginal = repoFileReader(repoRoot);
const readNoRepo = (): string | null => null; // the new-file fixtures need no pre-image at all

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

function classesOf(verdict: ReturnType<typeof evaluateDiffText>): FindingClass[] {
  return verdict.findings.map((f) => f.class);
}

describe("delegate-gate fixtures — one per defect class plus a clean control", () => {
  it("indentation-churn.diff: pure re-indentation flags as indentation-churn, auto-fixable", () => {
    const verdict = evaluateDiffText(loadFixture("indentation-churn.diff"), readOriginal);
    expect(verdict.pass).toBe(false);
    expect(classesOf(verdict)).toEqual(["indentation-churn"]);
    expect(verdict.findings[0]!.autoFixable).toBe(true);
  });

  it("non-minimal-diff.diff: a real edit buried in reformatted lines flags as non-minimal-diff, not auto-fixable", () => {
    const verdict = evaluateDiffText(loadFixture("non-minimal-diff.diff"), readOriginal);
    expect(verdict.pass).toBe(false);
    expect(classesOf(verdict)).toEqual(["non-minimal-diff"]);
    expect(verdict.findings[0]!.autoFixable).toBe(false);
  });

  it("tautological-assertion.diff: every sharp pattern plus the local-replica heuristic fire", () => {
    const verdict = evaluateDiffText(loadFixture("tautological-assertion.diff"), readNoRepo);
    expect(verdict.pass).toBe(false);
    const classes = classesOf(verdict);
    expect(classes.every((c) => c === "tautological-assertion")).toBe(true);
    // expect(true).toBe(true); expect(value).toBe(value); expect("ready").toBeDefined();
    // and the local-replica `driveReplica(...)` call — four distinct tautologies in one fixture.
    expect(classes).toHaveLength(4);
  });

  it("unnecessary-cast.diff: any/double-unknown always flagged; the trivial literal cast is auto-fixable; the array-type cast stays unflagged", () => {
    const verdict = evaluateDiffText(loadFixture("unnecessary-cast.diff"), readNoRepo);
    expect(verdict.pass).toBe(false);
    expect(classesOf(verdict)).toEqual(["unnecessary-cast", "unnecessary-cast", "unnecessary-cast"]);
    const fixable = verdict.findings.filter((f) => f.autoFixable);
    expect(fixable).toHaveLength(1);
    expect(fixable[0]!.detail).toMatch(/casts a literal/);
  });

  it("shared-state-mutation.diff: the exported top-level object is flagged; the local-only function is not", () => {
    const verdict = evaluateDiffText(loadFixture("shared-state-mutation.diff"), readNoRepo);
    expect(verdict.pass).toBe(false);
    expect(classesOf(verdict)).toEqual(["shared-state-mutation"]);
    expect(verdict.findings[0]!.line).toBe(4); // `cache[key] = ...` inside recordHit
  });

  it("clean.diff: a minimal diff with a real assertion on imported code passes with zero findings", () => {
    const verdict = evaluateDiffText(loadFixture("clean.diff"), readNoRepo);
    expect(verdict).toEqual({ pass: true, findings: [] });
  });
});
