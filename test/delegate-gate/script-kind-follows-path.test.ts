import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/delegate-gate/diff-parser.js";
import { analyzeCastNecessity } from "../../src/delegate-gate/cast-necessity.js";
import { analyzeSharedStateMutation } from "../../src/delegate-gate/shared-state.js";

/**
 * Pins that each analyzer picks its parse mode from the PATH, not from a constant.
 *
 * `test/delegate-gate/file-driver.test.ts` asserts that `findingPreamble` honours the `tsx` flag
 * it is handed. That is a different claim, and it cannot catch the defect this file exists for: a
 * caller that hands over a hardcoded `true` satisfies it perfectly. The P1-01 extraction did
 * exactly that — `path.endsWith(".tsx")` became `{ tsx: true }` at three call sites — and the whole
 * delegate-gate suite stayed green, because no fixture contains a `.ts` file whose TSX parse
 * differs.
 *
 * The discriminator is the one construct the two grammars disagree about: `<T>value`. TypeScript
 * reads it as a type assertion; TSX reads it as an unclosed JSX element and swallows the rest of
 * the file as children, so a real `as` cast on a later line disappears from the AST.
 */

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

const noOriginal = () => null;

describe("analyzer parse mode follows the file path", () => {
  it("reads a .ts file as TypeScript, so an angle-bracket assertion does not hide a later cast", () => {
    const source = ["const a = <string>x;", 'const b = "y" as string;'];
    const tsFindings = analyzeCastNecessity(parseUnifiedDiff(newFileDiff("probe.ts", source)), noOriginal);
    const tsxFindings = analyzeCastNecessity(parseUnifiedDiff(newFileDiff("probe.tsx", source)), noOriginal);

    // The .ts parse sees the redundant literal cast on the second line.
    expect(tsFindings.map((f) => f.class)).toEqual(["unnecessary-cast"]);
    // The .tsx parse cannot: `<string>` opened a JSX element that never closes.
    expect(tsxFindings).toEqual([]);
  });

  it("reads a .tsx file as TSX, so JSX is not a parse casualty", () => {
    const source = ["export const s: unknown[] = [];", "function add() { s.push(1); }"];
    const findings = analyzeSharedStateMutation(parseUnifiedDiff(newFileDiff("probe.tsx", source)), noOriginal);
    expect(findings.map((f) => f.class)).toEqual(["shared-state-mutation"]);
  });
});
