import { describe, expect, it } from "vitest";
import ts from "typescript";
import { parseUnifiedDiff } from "../../src/delegate-gate/diff-parser.js";
import { findingPreamble } from "../../src/delegate-gate/file-driver.js";

/**
 * The `findingPreamble` contract: null exactly when the diff added no line, and a tree parsed in
 * the mode the caller asked for.
 *
 * ⚠ The parse mode is asserted through what the TREE CONTAINS, not through `SourceFile.scriptKind`.
 * That field is internal to the TypeScript compiler and absent from the public type, so reading it
 * passes `npm run typecheck` (which covers `src/` only) and fails `npm run typecheck:test` — the
 * split `CLAUDE.md` records. A behavioural assertion is also the stronger claim: `<T>value` is the
 * one construct the two grammars disagree about, so a tree that holds a TypeAssertionExpression was
 * parsed as TypeScript and one that does not was not.
 *
 * ⚠ This file cannot catch a CALLER that hardcodes the flag — it hands the flag over itself.
 * `test/delegate-gate/script-kind-follows-path.test.ts` is the guard for that, and the reason it
 * exists.
 */

const noOriginal = () => null;

function newFileDiff(path: string, contentLines: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${contentLines.length} @@`,
    ...contentLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function hasTypeAssertion(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.TypeAssertionExpression) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

describe("findingPreamble", () => {
  it("returns null exactly when the diff adds no lines", () => {
    const original = "one\ntwo\nthree\n";
    const removalOnly = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,3 +1,2 @@",
      " one",
      "-two",
      " three",
      "",
    ].join("\n");
    const [removalFile] = parseUnifiedDiff(removalOnly);
    expect(findingPreamble(removalFile!, "f.ts", () => original, { tsx: true })).toBeNull();
    expect(findingPreamble(removalFile!, "f.ts", () => original, { tsx: false })).toBeNull();

    const added = parseUnifiedDiff(newFileDiff("f.ts", ["const x = 1;"]));
    expect(findingPreamble(added[0]!, "f.ts", noOriginal, { tsx: true })).not.toBeNull();
    expect(findingPreamble(added[0]!, "f.ts", noOriginal, { tsx: false })).not.toBeNull();
  });

  it("parses in the mode the caller asked for, whatever the path says", () => {
    const source = ["const a = <string>x;"];

    // A .ts path asked to parse as TSX must obey the flag, not the extension.
    const [tsFile] = parseUnifiedDiff(newFileDiff("f.ts", source));
    expect(hasTypeAssertion(findingPreamble(tsFile!, "f.ts", noOriginal, { tsx: false })!.sourceFile)).toBe(true);
    expect(hasTypeAssertion(findingPreamble(tsFile!, "f.ts", noOriginal, { tsx: true })!.sourceFile)).toBe(false);

    // And a .tsx path asked to parse as TypeScript must obey it in the other direction.
    const [tsxFile] = parseUnifiedDiff(newFileDiff("f.tsx", source));
    expect(hasTypeAssertion(findingPreamble(tsxFile!, "f.tsx", noOriginal, { tsx: false })!.sourceFile)).toBe(true);
    expect(hasTypeAssertion(findingPreamble(tsxFile!, "f.tsx", noOriginal, { tsx: true })!.sourceFile)).toBe(false);
  });

  it("carries the post-image and the added-line set through unchanged", () => {
    const [file] = parseUnifiedDiff(newFileDiff("f.ts", ["const x = 1;", "const y = 2;"]));
    const preamble = findingPreamble(file!, "f.ts", noOriginal, { tsx: false })!;
    expect(preamble.lines).toEqual(["const x = 1;", "const y = 2;"]);
    expect([...preamble.addedLines].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});
