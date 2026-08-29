import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseUnifiedDiff, type DiffFile } from "./diff-parser.js";
import { analyzeDiffMinimality } from "./minimality.js";
import { analyzeTestAssertions } from "./test-assertions.js";
import { analyzeCastNecessity } from "./cast-necessity.js";
import { analyzeSharedStateMutation } from "./shared-state.js";
import type { Finding, Verdict } from "./types.js";

export type ReadOriginal = (path: string) => string | null;

/** Read a file the diff modifies from `--repo` — the PRE-image every AST detector reconstructs
 * the post-image against. Absent/unreadable is a legitimate outcome (a file the diff claims to
 * modify but that does not exist at this repo root — quarantine to "no finding", never throw:
 * the gate must still report on every OTHER file). */
export function repoFileReader(repoRoot: string): ReadOriginal {
  return (path: string): string | null => {
    try {
      return readFileSync(join(repoRoot, path), "utf8");
    } catch {
      return null;
    }
  };
}

/**
 * Run every detector over a parsed diff and fold the results into one verdict.
 *
 * Each detector is independent and pure over (files, readOriginal); a detector throwing is a
 * detector bug, not a caller concern, so callers should treat any throw here as "the gate could
 * not evaluate this diff" rather than catch and silently drop a class.
 */
export function evaluateDiff(files: readonly DiffFile[], readOriginal: ReadOriginal): Verdict {
  const findings: Finding[] = [
    ...analyzeDiffMinimality(files),
    ...analyzeTestAssertions(files, readOriginal),
    ...analyzeCastNecessity(files, readOriginal),
    ...analyzeSharedStateMutation(files, readOriginal),
  ];
  return { pass: findings.length === 0, findings };
}

/** Parse a unified diff and evaluate it in one call — the entry point the CLI and tests use. */
export function evaluateDiffText(diffText: string, readOriginal: ReadOriginal): Verdict {
  return evaluateDiff(parseUnifiedDiff(diffText), readOriginal);
}
