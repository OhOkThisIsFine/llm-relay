import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/delegate-gate/diff-parser.js";
import { reconstructPostImage } from "../../src/delegate-gate/post-image.js";

describe("reconstructPostImage", () => {
  it("rebuilds a modified file from its pre-image plus the diff's hunks", () => {
    const original = "one\ntwo\nthree\nfour\nfive";
    const diff = `diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -2,2 +2,3 @@
-two
-three
+TWO
+extra
+three
`;
    const [file] = parseUnifiedDiff(diff);
    const { lines, addedLines } = reconstructPostImage(original, file!);
    expect(lines).toEqual(["one", "TWO", "extra", "three", "four", "five"]);
    // A unified diff has no "moved" marker: "three" is re-emitted as its own `+` line, so it is
    // exactly as ADDED as "TWO"/"extra" are, at post-image lines 2, 3 and 4.
    expect([...addedLines].sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  it("treats a null pre-image as an empty file, valid for a new-file diff", () => {
    const diff = `diff --git a/f.ts b/f.ts
new file mode 100644
--- /dev/null
+++ b/f.ts
@@ -0,0 +1,2 @@
+alpha
+beta
`;
    const [file] = parseUnifiedDiff(diff);
    const { lines, addedLines } = reconstructPostImage(null, file!);
    expect(lines).toEqual(["alpha", "beta"]);
    expect([...addedLines].sort()).toEqual([1, 2]);
  });

  it("copies untouched lines before the first hunk and after the last one unchanged", () => {
    const original = "a\nb\nc\nd\ne";
    const diff = `diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -3,1 +3,1 @@
-c
+C
`;
    const [file] = parseUnifiedDiff(diff);
    const { lines, addedLines } = reconstructPostImage(original, file!);
    expect(lines).toEqual(["a", "b", "C", "d", "e"]);
    expect([...addedLines]).toEqual([3]);
  });
});
