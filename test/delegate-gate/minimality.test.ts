import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/delegate-gate/diff-parser.js";
import { analyzeDiffMinimality, isPureIndentationChurnHunk } from "../../src/delegate-gate/minimality.js";

const CHURN_DIFF = `diff --git a/src/util.ts b/src/util.ts
--- a/src/util.ts
+++ b/src/util.ts
@@ -1,4 +1,4 @@
 export function add(a, b) {
-  const sum = a + b;
-  return sum;
+    const sum = a + b;
+    return sum;
 }
`;

const REAL_EDIT_DIFF = `diff --git a/src/util.ts b/src/util.ts
--- a/src/util.ts
+++ b/src/util.ts
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return a + b;
+  return a + b + 1;
 }
`;

describe("isPureIndentationChurnHunk", () => {
  it("is true when every line is a whitespace-only pair", () => {
    const [file] = parseUnifiedDiff(CHURN_DIFF);
    expect(isPureIndentationChurnHunk(file!.hunks[0]!)).toBe(true);
  });

  it("is false for a hunk carrying a real content change", () => {
    const [file] = parseUnifiedDiff(REAL_EDIT_DIFF);
    expect(isPureIndentationChurnHunk(file!.hunks[0]!)).toBe(false);
  });

  it("is false when the remove/add run lengths are unequal (nothing paired)", () => {
    const diff = `diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1,1 +1,2 @@
-  const x = 1;
+  const x = 1;
+  const y = 2;
`;
    const [file] = parseUnifiedDiff(diff);
    expect(isPureIndentationChurnHunk(file!.hunks[0]!)).toBe(false);
  });
});

describe("analyzeDiffMinimality", () => {
  it("flags a pure-churn hunk as indentation-churn, auto-fixable", () => {
    const files = parseUnifiedDiff(CHURN_DIFF);
    const findings = analyzeDiffMinimality(files);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ class: "indentation-churn", file: "src/util.ts", autoFixable: true });
  });

  it("does not flag a hunk with only a real semantic change", () => {
    const files = parseUnifiedDiff(REAL_EDIT_DIFF);
    expect(analyzeDiffMinimality(files)).toEqual([]);
  });

  it("flags a large mixed hunk (real edit + reformatted lines) as non-minimal-diff, not auto-fixable", () => {
    const diff = `diff --git a/src/format.ts b/src/format.ts
--- a/src/format.ts
+++ b/src/format.ts
@@ -1,8 +1,8 @@
 export function greet(name) {
-  const label = "Hello";
-  const trimmed = name.trim();
-  const upper = trimmed.toUpperCase();
-  const suffix = "!";
-  const result = label + " " + upper + suffix;
-  return result;
+    const label = "Hi";
+    const trimmed = name.trim();
+    const upper = trimmed.toUpperCase();
+    const suffix = "!";
+    const result = label + " " + upper + suffix;
+    return result.trim();
 }
`;
    const files = parseUnifiedDiff(diff);
    const findings = analyzeDiffMinimality(files);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ class: "non-minimal-diff", file: "src/format.ts", autoFixable: false });
  });

  it("stays silent below the minimum-changed-lines threshold even at 100% no-delta ratio outside pure churn", () => {
    // 3 paired lines, each a TRAILING-whitespace-only change: `hasNoSemanticDelta` (trim() on
    // both ends) is true for all three, but `isWhitespaceOnlyChange` (leading whitespace only) is
    // false for all three (the removed side's trailing space survives `trimStart()`), so this is
    // neither pure churn nor a hunk the size gate would admit — it exercises
    // NON_MINIMAL_MIN_CHANGED_LINES directly: 3 paired lines never reaches `non-minimal-diff`,
    // which requires at least 6.
    const trailingSpace = " ";
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,3 +1,3 @@",
      `-const x = 1;${trailingSpace}`,
      `-const y = 2;${trailingSpace}`,
      `-const z = 3;${trailingSpace}`,
      "+const x = 1;",
      "+const y = 2;",
      "+const z = 3;",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(analyzeDiffMinimality(files)).toEqual([]);
  });
});
