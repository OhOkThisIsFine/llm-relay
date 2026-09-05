import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/delegate-gate/diff-parser.js";
import { analyzeTestAssertions } from "../../src/delegate-gate/test-assertions.js";

const noOriginal = () => null;

function newFileDiff(path: string, contentLines: readonly string[]): string {
  const body = contentLines.map((l) => `+${l}`).join("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${contentLines.length} @@`,
    body,
    "",
  ].join("\n");
}

describe("analyzeTestAssertions", () => {
  it("flags expect(true).toBe(true) as a sharp tautology", () => {
    const diff = newFileDiff("t.test.ts", [
      'import { expect, it } from "vitest";',
      'it("x", () => { expect(true).toBe(true); });',
    ]);
    const findings = analyzeTestAssertions(parseUnifiedDiff(diff), noOriginal);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ class: "tautological-assertion", autoFixable: false });
  });

  it("flags expect(x).toBe(x) on the identical identifier", () => {
    const diff = newFileDiff("t.test.ts", [
      'import { expect, it } from "vitest";',
      'it("x", () => { const value = 1; expect(value).toBe(value); });',
    ]);
    const findings = analyzeTestAssertions(parseUnifiedDiff(diff), noOriginal);
    expect(findings).toHaveLength(1);
  });

  it("does NOT flag two different identifiers, even with matching runtime values", () => {
    const diff = newFileDiff("t.test.ts", [
      'import { expect, it } from "vitest";',
      'it("x", () => { const a = 1; const b = 1; expect(a).toBe(b); });',
    ]);
    expect(analyzeTestAssertions(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });

  it("flags expect(<literal>).toBeDefined()", () => {
    const diff = newFileDiff("t.test.ts", [
      'import { expect, it } from "vitest";',
      'it("x", () => { expect("ready").toBeDefined(); });',
    ]);
    const findings = analyzeTestAssertions(parseUnifiedDiff(diff), noOriginal);
    expect(findings).toHaveLength(1);
  });

  it("does not flag expect(x).toBeDefined() on a non-literal", () => {
    const diff = newFileDiff("t.test.ts", [
      'import { expect, it } from "vitest";',
      'import { load } from "../src/load.js";',
      'it("x", () => { expect(load()).toBeDefined(); });',
    ]);
    expect(analyzeTestAssertions(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });

  it("best-effort: flags an assertion whose value calls a function declared locally, never imported", () => {
    const diff = newFileDiff("t.test.ts", [
      'import { expect, it } from "vitest";',
      'it("x", () => {',
      "  function replica(k: string): string {",
      '    if (k === "known") return "handled";',
      '    throw new Error("nope");',
      "  }",
      '  expect(() => replica("bogus")).toThrow("nope");',
      "});",
    ]);
    const findings = analyzeTestAssertions(parseUnifiedDiff(diff), noOriginal);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toMatch(/hand-copied replica/);
  });

  it("does not flag an assertion whose value calls an imported function", () => {
    const diff = newFileDiff("t.test.ts", [
      'import { expect, it } from "vitest";',
      'import { double } from "../src/double.js";',
      'it("x", () => { expect(double(21)).toBe(42); });',
    ]);
    expect(analyzeTestAssertions(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });

  it("does NOT flag an imported function call whose argument is constructed by a local helper", () => {
    const diff = newFileDiff("t.test.ts", [
      'import { expect, it } from "vitest";',
      'import { parseThing } from "../src/parser.js";',
      'function makeInput(s: string) { return { text: s }; }',
      'it("x", () => { expect(parseThing(makeInput("hello"))).toBe("hello"); });',
    ]);
    expect(analyzeTestAssertions(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });

  it("does NOT flag a namespace-imported function call whose argument is constructed by a local helper", () => {
    const diff = newFileDiff("t.test.ts", [
      'import { expect, it } from "vitest";',
      'import * as parser from "../src/parser.js";',
      'const makeInput = (s: string) => ({ text: s });',
      'it("x", () => { expect(parser.parseThing(makeInput("hello"))).toBe("hello"); });',
    ]);
    expect(analyzeTestAssertions(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });

  it("does NOT flag an ordinary assertion built from local primitive variables (no function call)", () => {
    const diff = newFileDiff("t.test.ts", [
      'import { expect, it } from "vitest";',
      'import { double } from "../src/double.js";',
      'it("x", () => { const a = 1; const b = 2; expect(a + b).toBe(3); });',
    ]);
    expect(analyzeTestAssertions(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });

  it("declines the local-replica heuristic entirely when the file has no imports", () => {
    const diff = newFileDiff("t.test.ts", [
      "function fabricated() { return 1; }",
      'it("x", () => { expect(fabricated()).toBe(1); });',
    ]);
    expect(analyzeTestAssertions(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });

  it("ignores an assertion the diff did not add (line outside addedLines)", () => {
    const original = 'import { expect, it } from "vitest";\nit("x", () => { expect(true).toBe(true); });\n';
    const diff = [
      "diff --git a/t.test.ts b/t.test.ts",
      "--- a/t.test.ts",
      "+++ b/t.test.ts",
      "@@ -1,2 +1,3 @@",
      ' import { expect, it } from "vitest";',
      ' it("x", () => { expect(true).toBe(true); });',
      "+it(\"y\", () => { expect(1).toBe(1); });",
      "",
    ].join("\n");
    const findings = analyzeTestAssertions(parseUnifiedDiff(diff), () => original);
    // Only the NEW line's assertion should be reported, not the pre-existing tautology.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(3);
  });

  it("ignores non-test files entirely", () => {
    const diff = newFileDiff("src/plain.ts", ["const ok = expect_like(true);"]);
    expect(analyzeTestAssertions(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });
});
