import { describe, expect, it } from "vitest";
import { DiffParseError, parseUnifiedDiff, reportedPath } from "../../src/delegate-gate/diff-parser.js";

const MODIFIED_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 line one
-line two
+line TWO
 line three
`;

const NEW_FILE_DIFF = `diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
`;

const DELETED_FILE_DIFF = `diff --git a/src/c.ts b/src/c.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/c.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const gone = true;
-export const alsoGone = true;
`;

describe("parseUnifiedDiff", () => {
  it("parses a modification hunk with context/remove/add line numbers", () => {
    const [file] = parseUnifiedDiff(MODIFIED_DIFF);
    expect(file).toBeDefined();
    expect(file!.oldPath).toBe("src/a.ts");
    expect(file!.newPath).toBe("src/a.ts");
    expect(file!.isNew).toBe(false);
    expect(file!.isDeleted).toBe(false);
    expect(reportedPath(file!)).toBe("src/a.ts");

    const [hunk] = file!.hunks;
    expect(hunk).toBeDefined();
    expect(hunk!.oldStart).toBe(1);
    expect(hunk!.oldLines).toBe(3);
    expect(hunk!.newStart).toBe(1);
    expect(hunk!.newLines).toBe(3);

    const kinds = hunk!.lines.map((l) => l.kind);
    expect(kinds).toEqual(["context", "remove", "add", "context"]);

    const removed = hunk!.lines.find((l) => l.kind === "remove")!;
    expect(removed.content).toBe("line two");
    expect(removed.oldLine).toBe(2);
    expect(removed.newLine).toBeUndefined();

    const added = hunk!.lines.find((l) => l.kind === "add")!;
    expect(added.content).toBe("line TWO");
    expect(added.newLine).toBe(2);
    expect(added.oldLine).toBeUndefined();
  });

  it("treats a new-file section as having no pre-image path", () => {
    const [file] = parseUnifiedDiff(NEW_FILE_DIFF);
    expect(file!.isNew).toBe(true);
    expect(file!.oldPath).toBeNull();
    expect(file!.newPath).toBe("src/b.ts");
    expect(file!.hunks[0]!.lines.every((l) => l.kind === "add")).toBe(true);
  });

  it("treats a deleted-file section as having no post-image path", () => {
    const [file] = parseUnifiedDiff(DELETED_FILE_DIFF);
    expect(file!.isDeleted).toBe(true);
    expect(file!.newPath).toBeNull();
    expect(reportedPath(file!)).toBe("src/c.ts");
    expect(file!.hunks[0]!.lines.every((l) => l.kind === "remove")).toBe(true);
  });

  it("parses multiple diff --git sections into separate files", () => {
    const combined = MODIFIED_DIFF + NEW_FILE_DIFF;
    const files = parseUnifiedDiff(combined);
    expect(files.map((f) => reportedPath(f))).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("throws DiffParseError on a malformed hunk header", () => {
    const bad = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ bogus @@\n-x\n+y\n`;
    expect(() => parseUnifiedDiff(bad)).toThrow(DiffParseError);
  });

  it("records the raw-line index of each hunk line and hunk boundary", () => {
    const [file] = parseUnifiedDiff(MODIFIED_DIFF);
    const hunk = file!.hunks[0]!;
    // Header is raw line 4 (0-indexed) of MODIFIED_DIFF's split('\n') array.
    const rawLines = MODIFIED_DIFF.split("\n");
    expect(rawLines[hunk.headerRawIndex]).toMatch(/^@@ -1,3 \+1,3 @@/);
    for (const line of hunk.lines) {
      const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
      expect(rawLines[line.rawIndex]).toBe(`${marker}${line.content}`);
    }
    expect(hunk.endRawIndex).toBeGreaterThan(hunk.headerRawIndex);
  });

  it("returns an empty array for text with no diff --git section", () => {
    expect(parseUnifiedDiff("just some prose\nno diff here\n")).toEqual([]);
  });
});
