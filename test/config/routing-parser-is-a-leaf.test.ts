import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_LANE_PROBE, parseOffload, parseRouting } from "../../src/config.js";

/**
 * HOTSPOT-03's properties, pinned structurally rather than asserted in a document.
 *
 * The point of extracting `parseRouting` was not tidiness — it was to give the routing parser a
 * dependency direction it cannot violate. A parser that reaches back into `config.ts` is a cycle
 * into the file it came from; one that reaches into the request path can no longer be tested by
 * handing it a literal. Neither failure produces a compile error, and neither would fail the
 * ordinary suite, so the guard has to read the source.
 */

const source = readFileSync(
  fileURLToPath(new URL("../../src/config/routing-parser.ts", import.meta.url)),
  "utf8",
);

/**
 * Every module specifier the file imports from.
 *
 * ⚠ Matched with a flat pattern rather than one that spans an import's whole body. A regex like
 * `import[\s\S]*?from` backtracks super-linearly, which is a real cost on a 770-line file and is
 * exactly what `sonarjs/super-linear-regex` exists to catch.
 */
const imports = [...source.matchAll(/from "([^"]+)";/g)].map((m) => m[1]);

/** The file with comments removed — its own header discusses the very things it forbids. */
function codeWithoutComments(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlock = true;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    out.push(line);
  }
  return out.join("\n");
}

describe("config/routing-parser is a leaf", () => {
  it("imports only config-types and spec", () => {
    expect([...new Set(imports)].sort()).toEqual(["../config-types.js", "../spec.js"]);
  });

  /**
   * The specific cycle the extraction exists to avoid. `spec.ts` was created FIRST, in its own
   * commit, precisely so this import could not be `../config.js`.
   */
  it("never imports config.js", () => {
    expect(imports).not.toContain("../config.js");
    expect(source).not.toContain('from "../config.js"');
  });

  /**
   * Purity, read from the source because a type cannot express it. A parser that grew a clock or a
   * file read would still compile and still pass every routing test that hands it a literal.
   */
  it("performs no IO, reads no clock, and never awaits", () => {
    const code = codeWithoutComments(source);
    for (const forbidden of [/\bawait\b/, /Date\.now/, /Math\.random/, /readFileSync/, /writeFileSync/, /\bfetch\(/]) {
      expect(code).not.toMatch(forbidden);
    }
  });

  /**
   * The three names other modules import through `config.ts`. A move that quietly stopped
   * re-exporting one would break `offload.ts`, `lane-cadence.ts` or `test/config.test.ts` — but
   * only at their own call sites, which is a worse place to find out.
   */
  it("keeps its publicly consumed names reachable from config.js", () => {
    expect(typeof parseRouting).toBe("function");
    expect(typeof parseOffload).toBe("function");
    expect(DEFAULT_LANE_PROBE).toBeTypeOf("object");
  });
});
