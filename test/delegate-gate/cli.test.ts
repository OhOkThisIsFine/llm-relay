import { describe, expect, it } from "vitest";
import { runDelegateGateCli } from "../../src/delegate-gate/cli.js";

const CHURN_DIFF = `diff --git a/src/util.ts b/src/util.ts
--- a/src/util.ts
+++ b/src/util.ts
@@ -1,2 +1,2 @@
-  const sum = a + b;
+    const sum = a + b;
 return sum;
`;

const CLEAN_DIFF = `diff --git a/src/plain.ts b/src/plain.ts
new file mode 100644
--- /dev/null
+++ b/src/plain.ts
@@ -0,0 +1,1 @@
+export const ok = true;
`;

function fakeIo(files: Record<string, string>) {
  const written: Record<string, string> = {};
  return {
    readFile: (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: (path: string, content: string) => {
      written[path] = content;
    },
    written,
  };
}

describe("runDelegateGateCli", () => {
  it("exits 1 with findings for a diff that trips a detector", () => {
    const io = fakeIo({ "diff.patch": CHURN_DIFF });
    const result = runDelegateGateCli({ diffPath: "diff.patch", repoRoot: ".", fix: false }, io);
    expect(result.exitCode).toBe(1);
    const verdict = JSON.parse(result.stdout);
    expect(verdict.pass).toBe(false);
    expect(verdict.findings[0].class).toBe("indentation-churn");
  });

  it("exits 0 with an empty findings list for a clean diff", () => {
    const io = fakeIo({ "diff.patch": CLEAN_DIFF });
    const result = runDelegateGateCli({ diffPath: "diff.patch", repoRoot: ".", fix: false }, io);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ pass: true, findings: [] });
  });

  it("--fix writes <input>.fixed.patch next to the input when a mechanical fix applies", () => {
    const io = fakeIo({ "diff.patch": CHURN_DIFF });
    const result = runDelegateGateCli({ diffPath: "diff.patch", repoRoot: ".", fix: true }, io);
    expect(result.exitCode).toBe(1); // exit code reflects the INPUT diff's verdict, fix or no fix
    expect(io.written["diff.patch.fixed.patch"]).toBeDefined();
    expect(result.stderr).toMatch(/wrote 1 mechanical fix/);
  });

  it("--fix writes nothing and says so when no finding is mechanically fixable", () => {
    const io = fakeIo({ "diff.patch": CLEAN_DIFF });
    const result = runDelegateGateCli({ diffPath: "diff.patch", repoRoot: ".", fix: true }, io);
    expect(Object.keys(io.written)).toHaveLength(0);
    expect(result.stderr).toMatch(/no mechanically fixable findings/);
  });

  it("fails cleanly when the diff file cannot be read", () => {
    const io = fakeIo({});
    const result = runDelegateGateCli({ diffPath: "missing.patch", repoRoot: ".", fix: false }, io);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/could not read/);
  });

  it("requires both the diff-file positional and --repo", () => {
    const io = fakeIo({});
    expect(runDelegateGateCli({ diffPath: undefined, repoRoot: ".", fix: false }, io).exitCode).toBe(1);
    expect(runDelegateGateCli({ diffPath: "diff.patch", repoRoot: undefined, fix: false }, io).exitCode).toBe(1);
  });
});
