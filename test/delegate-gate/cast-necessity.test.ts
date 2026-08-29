import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/delegate-gate/diff-parser.js";
import { analyzeCastNecessity, findFixableCastEdits } from "../../src/delegate-gate/cast-necessity.js";

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

describe("analyzeCastNecessity", () => {
  it("always flags `as any`, never auto-fixable", () => {
    const diff = newFileDiff("f.ts", ["const n: unknown = 1;", "const x = n as any;"]);
    const findings = analyzeCastNecessity(parseUnifiedDiff(diff), noOriginal);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ class: "unnecessary-cast", line: 2, autoFixable: false });
    expect(findings[0]!.detail).toMatch(/any/);
  });

  it("always flags a double cast through unknown, never auto-fixable", () => {
    const diff = newFileDiff("f.ts", ["declare const n: number;", "const x = n as unknown as string;"]);
    const findings = analyzeCastNecessity(parseUnifiedDiff(diff), noOriginal);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ class: "unnecessary-cast", autoFixable: false });
    expect(findings[0]!.detail).toMatch(/double cast/);
  });

  it("flags a literal cast to the primitive type it already has, auto-fixable", () => {
    const diff = newFileDiff("f.ts", ['const s = "hello" as string;', "const n = 5 as number;", "const b = true as boolean;"]);
    const findings = analyzeCastNecessity(parseUnifiedDiff(diff), noOriginal);
    expect(findings).toHaveLength(3);
    for (const f of findings) expect(f.autoFixable).toBe(true);
  });

  it("does not flag a cast to a non-keyword type (out of the syntactic scope by design)", () => {
    const diff = newFileDiff("f.ts", ["const arr = [1, 2, 3] as number[];"]);
    expect(analyzeCastNecessity(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });

  it("does not flag a cast on a non-literal expression (needs a real type checker to judge)", () => {
    const diff = newFileDiff("f.ts", ["declare const input: unknown;", "const s = input as string;"]);
    expect(analyzeCastNecessity(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });

  it("ignores non-TypeScript files", () => {
    const diff = newFileDiff("f.md", ["`x as any` in prose is not code"]);
    expect(analyzeCastNecessity(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });
});

describe("findFixableCastEdits", () => {
  it("computes an in-place replacement removing only the redundant cast suffix", () => {
    const diff = newFileDiff("f.ts", ['const s = "hello" as string;']);
    const edits = findFixableCastEdits(parseUnifiedDiff(diff), noOriginal);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.newContent).toBe('const s = "hello";');
  });

  it("produces no edits for as-any or double-unknown casts", () => {
    const diff = newFileDiff("f.ts", ["const a = 1 as any;", "const b = 1 as unknown as string;"]);
    expect(findFixableCastEdits(parseUnifiedDiff(diff), noOriginal)).toEqual([]);
  });
});
