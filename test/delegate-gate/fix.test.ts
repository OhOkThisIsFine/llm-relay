import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { autoRepairDiff } from "../../src/delegate-gate/fix.js";
import { evaluateDiffText, repoFileReader } from "../../src/delegate-gate/gate.js";
import { parseUnifiedDiff } from "../../src/delegate-gate/diff-parser.js";

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const repoRoot = join(fixturesDir, "repo");
const readOriginal = repoFileReader(repoRoot);
const readNoRepo = (): string | null => null;

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

describe("autoRepairDiff — round trip", () => {
  it("drops a pure indentation-churn hunk whole, and the fixed diff re-evaluates clean", () => {
    const original = loadFixture("indentation-churn.diff");
    const before = evaluateDiffText(original, readOriginal);
    expect(before.pass).toBe(false);

    const repaired = autoRepairDiff(original, readOriginal);
    expect(repaired.fixedCount).toBe(1);

    // The fixed diff carries no `@@` hunk at all for this file (the whole hunk was dropped) —
    // i.e. parsing it yields no file section, because a hunkless, non-new, non-deleted section
    // is not a change to report.
    const fixedFiles = parseUnifiedDiff(repaired.fixedText);
    expect(fixedFiles).toEqual([]);

    const after = evaluateDiffText(repaired.fixedText, readOriginal);
    expect(after).toEqual({ pass: true, findings: [] });
  });

  it("rewrites only the trivially-redundant literal cast, leaving any/double-unknown findings untouched", () => {
    const original = loadFixture("unnecessary-cast.diff");
    const before = evaluateDiffText(original, readNoRepo);
    expect(before.findings).toHaveLength(3);

    const repaired = autoRepairDiff(original, readNoRepo);
    expect(repaired.fixedCount).toBe(1);
    expect(repaired.fixedText).toContain('const s = "hello";');
    expect(repaired.fixedText).not.toContain('"hello" as string');

    const after = evaluateDiffText(repaired.fixedText, readNoRepo);
    expect(after.findings).toHaveLength(2);
    expect(after.findings.map((f) => f.detail).join("\n")).toMatch(/any/);
    expect(after.findings.map((f) => f.detail).join("\n")).toMatch(/double cast/);
  });

  it("is a no-op (fixedCount 0, byte-identical text) on a diff with no mechanically fixable findings", () => {
    const original = loadFixture("shared-state-mutation.diff");
    const repaired = autoRepairDiff(original, readNoRepo);
    expect(repaired.fixedCount).toBe(0);
    expect(repaired.fixedText).toBe(original.replace(/\r\n/g, "\n"));
  });

  it("never touches the target repo — only reads it, and writes nothing on disk itself", () => {
    // autoRepairDiff takes ReadOriginal, not a writable filesystem handle at all; this test
    // documents that contract by construction rather than asserting a negative on disk.
    const original = loadFixture("indentation-churn.diff");
    const before = readFileSync(join(repoRoot, "src/util.ts"), "utf8");
    autoRepairDiff(original, readOriginal);
    const after = readFileSync(join(repoRoot, "src/util.ts"), "utf8");
    expect(after).toBe(before);
  });
});
