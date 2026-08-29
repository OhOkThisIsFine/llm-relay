import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/delegate-gate/diff-parser.js";
import { analyzeSharedStateMutation } from "../../src/delegate-gate/shared-state.js";

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

describe("analyzeSharedStateMutation", () => {
  it("flags an assignment into an exported top-level object from inside a function", () => {
    const diff = newFileDiff("f.ts", [
      "export const cache: Record<string, number> = {};",
      "function recordHit(key: string): void {",
      "  cache[key] = (cache[key] ?? 0) + 1;",
      "}",
    ]);
    const findings = analyzeSharedStateMutation(parseUnifiedDiff(diff), noOriginal);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ class: "shared-state-mutation", line: 3, autoFixable: false });
  });

  it("flags a mutating method call on a top-level Map/Set/array binding", () => {
    const diff = newFileDiff("f.ts", [
      "const seen = new Set<string>();",
      "function mark(id: string): void {",
      "  seen.add(id);",
      "}",
    ]);
    const findings = analyzeSharedStateMutation(parseUnifiedDiff(diff), noOriginal);
    expect(findings).toHaveLength(1);
  });

  it("does not flag a mutation of a variable declared LOCALLY inside the function", () => {
    const diff = newFileDiff("f.ts", [
      "function localOnly(): void {",
      "  const local: Record<string, number> = {};",
      '  local[""] = 1;',
      "}",
    ]);
    expect(analyzeSharedStateMutation(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });

  it("does not flag a top-level PRIMITIVE binding that is not exported and not object-shaped", () => {
    const diff = newFileDiff("f.ts", [
      "let counter = 0;",
      "function bump(): void {",
      "  counter = counter + 1;",
      "}",
    ]);
    expect(analyzeSharedStateMutation(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });

  it("does not flag a reassignment sitting directly at module top level (not inside a function)", () => {
    const diff = newFileDiff("f.ts", [
      "export const state: Record<string, number> = {};",
      'state["initialized"] = 1;',
    ]);
    expect(analyzeSharedStateMutation(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });

  it("ignores non-TypeScript files", () => {
    const diff = newFileDiff("f.md", ["export const cache = {};"]);
    expect(analyzeSharedStateMutation(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });
});
