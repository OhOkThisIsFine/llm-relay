import { parseUnifiedDiff } from "./diff-parser.js";
import { isPureIndentationChurnHunk } from "./minimality.js";
import { findFixableCastEdits } from "./cast-necessity.js";
import type { ReadOriginal } from "./gate.js";

export interface AutoRepairResult {
  readonly fixedText: string;
  readonly fixedCount: number;
}

/**
 * Produce a corrected diff for the two MECHANICAL finding classes: pure indentation-churn hunks
 * (dropped whole) and trivially-redundant literal casts (rewritten in place). Every other finding
 * class is a judgment call and is left in the verdict for a human/reviewer to act on — this
 * function never touches the target repo, only the diff text itself.
 *
 * Both transforms are line-count-preserving or hunk-boundary-preserving by construction (see
 * `isPureIndentationChurnHunk` and `findFixableCastEdits`), so no other hunk's `@@` header ever
 * needs recomputing.
 */
export function autoRepairDiff(diffText: string, readOriginal: ReadOriginal): AutoRepairResult {
  const normalized = diffText.replace(/\r\n/g, "\n");
  const rawLines = normalized.split("\n");
  const files = parseUnifiedDiff(normalized);

  const dropped = new Set<number>();
  let fixedCount = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      if (!isPureIndentationChurnHunk(hunk)) continue;
      for (let i = hunk.headerRawIndex; i < hunk.endRawIndex; i++) dropped.add(i);
      fixedCount += 1;
    }
  }

  const replacements = new Map<number, string>();
  for (const edit of findFixableCastEdits(files, readOriginal)) {
    replacements.set(edit.rawIndex, edit.newContent);
    fixedCount += 1;
  }

  const out: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (dropped.has(i)) continue;
    const replacement = replacements.get(i);
    out.push(replacement === undefined ? rawLines[i]! : `+${replacement}`);
  }

  return { fixedText: out.join("\n"), fixedCount };
}
