import ts from "typescript";
import type { DiffFile } from "./diff-parser.js";
import { reportedPath } from "./diff-parser.js";
import { reconstructPostImage } from "./post-image.js";

/**
 * The one per-file prelude and the one per-file loop every AST detector in this directory runs.
 *
 * `cast-necessity.ts`, `shared-state.ts` and `test-assertions.ts` each opened with the same five
 * steps — read the pre-image, reconstruct the post-image, bail when the diff added nothing, join
 * the lines, hand the result to `ts.createSourceFile` — and each then walked `files` with the same
 * loop. That is CLONE-16 in the 2026-09-05 duplication catalog, confirmed across four call sites,
 * with CLONE-27 (the ScriptKind selection) folded in.
 */

/** What a detector needs before it can look at anything: the post-image, which of its lines the
 * diff ADDED, and the parsed tree. Every detector restricts itself to `addedLines` — a defect the
 * delegate did not touch is not this diff's defect. */
export interface FindingPreamble {
  readonly lines: readonly string[];
  readonly addedLines: ReadonlySet<number>;
  readonly sourceFile: ts.SourceFile;
}

/**
 * Reconstruct one changed file and parse it, or return null when the diff added no line to it.
 *
 * ⚠⚠ **`opts.tsx` is the CALLER's to decide, and it is not derivable here.** Two of the three
 * detectors want the parse mode the path implies (`path.endsWith(".tsx")`); `test-assertions.ts`
 * deliberately parses every file as plain TS, `.tsx` test files included, and always did. A driver
 * that derived the flag from the path would silently change that third detector, so the flag is a
 * required argument rather than an inference.
 *
 * ⚠ **Do not hand this a constant where the caller had a predicate.** The extraction that created
 * this module did exactly that — three call sites went from `path.endsWith(".tsx")` to a literal
 * `true` — and the whole delegate-gate suite stayed green, because no fixture holds a `.ts` file
 * the two grammars read differently. They do differ: TypeScript reads `<T>value` as a type
 * assertion, TSX reads it as an unclosed JSX element and swallows the rest of the file as its
 * children, so a real `as` cast on a later line vanishes from the tree.
 * `test/delegate-gate/script-kind-follows-path.test.ts` pins the caller side for exactly that
 * reason; the flag test beside it cannot, because a hardcoded caller satisfies it.
 */
export function findingPreamble(
  file: DiffFile,
  path: string,
  readOriginal: (path: string) => string | null,
  opts: { tsx: boolean },
): FindingPreamble | null {
  const original = file.isNew ? null : readOriginal(path);
  const { lines, addedLines } = reconstructPostImage(original, file);
  if (addedLines.size === 0) return null;

  const content = lines.join("\n");
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, opts.tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  return { lines, addedLines, sourceFile };
}

/**
 * Walk the diff's files, resolve each reported path, and skip a file the diff left with no hunk.
 *
 * Each caller keeps its OWN file-kind filter inside `analyzeOne` rather than declaring it here:
 * the detectors do not agree on what they analyze (`TS_FILE` for casts and shared state,
 * `TEST_FILE` for assertions), and a filter parameter would only move that disagreement into this
 * signature. Both predicates are pure, so testing the hunk guard before the caller's filter
 * returns the same set as the single `||` guard each loop used before.
 */
export function runFileAnalyzer<T>(
  files: readonly DiffFile[],
  readOriginal: (path: string) => string | null,
  analyzeOne: (file: DiffFile, path: string, readOriginal: (path: string) => string | null) => readonly T[],
): T[] {
  const results: T[] = [];
  for (const file of files) {
    const path = reportedPath(file);
    if (file.hunks.length === 0) continue;
    results.push(...analyzeOne(file, path, readOriginal));
  }
  return results;
}
