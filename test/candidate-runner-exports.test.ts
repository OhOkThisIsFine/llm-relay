import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every export of `src/candidate-runner.ts` has a consumer in `src/` or `test/`,
 * or it is not an export.
 *
 * The `server.ts` decomposition published this module's internals as public API;
 * only `orderByUsability` and `classifyStatus` are recorded test seams. An export
 * nothing consumes is dead API surface: a maintainer reading it cannot tell
 * whether it is load-bearing. Dropping the `export` keyword keeps the function
 * exactly where it is — no logic change — while removing it from the module's
 * public surface.
 *
 * Mechanical half (the `state-paths.ts` precedent): collect every `export` name
 * from the source and require a word-boundary reference in at least one OTHER
 * file under `src/` or `test/`. A type referenced by name only inside another
 * file's type annotation counts — that IS a consumer.
 */

const SRC = join(__dirname, "..", "src");
const TEST = join(__dirname);
const TARGET_REL = "candidate-runner.ts";

const DECLARATION = /^export +(?:async +)?(?:const|type|interface|function|class|enum) +([A-Za-z0-9_]+)/;
const EXPORT_LIST = /^export +(type +)?\{([^}]*)\}/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Every name `candidate-runner.ts` exports, whatever syntactic form declares it. */
function exportedNames(): string[] {
  const text = readFileSync(join(SRC, TARGET_REL), "utf8");
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("export ")) continue;
    const decl = DECLARATION.exec(trimmed);
    if (decl) {
      names.push(decl[1]!);
      continue;
    }
    const list = EXPORT_LIST.exec(trimmed);
    if (list) {
      for (const part of list[2]!.split(",")) {
        // `X`, `type X`, or `X as Y` — the first space-separated token is the exported name.
        const name = part.trim().replace(/^type /, "").split(" ")[0]!.trim();
        if (name.length > 0) names.push(name);
      }
    }
    // A line matching neither form is silently skipped HERE and caught by the
    // "every export line uses a form this test understands" test below, which
    // fails with the offending line — so no export can pass unseen.
  }
  return names;
}

function otherFiles(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  for (const [dir, prefix] of [[SRC, "src"], [TEST, "test"]] as const) {
    for (const full of sourceFiles(dir)) {
      const rel = `${prefix}/${relative(dir, full).split(sep).join("/")}`;
      if (rel === `src/${TARGET_REL}`) continue;
      if (rel === "test/candidate-runner-exports.test.ts") continue;
      out.push({ rel, text: readFileSync(full, "utf8") });
    }
  }
  return out;
}

describe("every candidate-runner export has a consumer", () => {
  const names = exportedNames();
  const files = otherFiles();

  it("scans an export list large enough to mean something", () => {
    expect(names.length).toBeGreaterThan(50);
  });

  it("every export line uses a form this test understands, so none is silently skipped", () => {
    const text = readFileSync(join(SRC, TARGET_REL), "utf8");
    const unhandled = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("export "))
      .filter((line) => !DECLARATION.test(line) && !EXPORT_LIST.test(line));
    expect(unhandled).toEqual([]);
  });

  it("each export is referenced by at least one other file under src/ or test/", () => {
    const unconsumed = names.filter(
      (name) => !files.some(({ text }) => new RegExp(`\\b${name}\\b`).test(text)),
    );
    expect(
      unconsumed,
      `These exports have no consumer outside candidate-runner.ts; drop the \`export\` keyword:\n  ${unconsumed.join("\n  ")}`,
    ).toEqual([]);
  });
});
