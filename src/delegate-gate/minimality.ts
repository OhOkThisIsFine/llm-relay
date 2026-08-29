import type { DiffFile, DiffHunk } from "./diff-parser.js";
import { reportedPath } from "./diff-parser.js";
import type { Finding } from "./types.js";

/** Two lines carry the same code but differ only in leading whitespace. */
function isWhitespaceOnlyChange(removed: string, added: string): boolean {
  return removed !== added && removed.trimStart() === added.trimStart();
}

/** Two lines are byte-identical once surrounding whitespace is trimmed — a change that reads as
 * "different bytes, same code" (re-indentation, a trailing-space touch, a blank line shuffled). */
function hasNoSemanticDelta(removed: string, added: string): boolean {
  return removed !== added && removed.trim() === added.trim();
}

/**
 * Pair a hunk's removed lines against its added lines by position.
 *
 * This is deliberately naive — position pairing, not a diff-of-diffs — because a delegate-diff
 * gate is reading output a lane already produced, not re-deriving the edit. It is precise for the
 * common single-block replacement shape (a contiguous run of `-` lines immediately followed by a
 * contiguous run of `+` lines, equal in count) and says nothing when counts differ rather than
 * guessing a pairing.
 */
function pairedRemoveAddRuns(hunk: DiffHunk): ReadonlyArray<{ removed: string; added: string; newLine: number }> {
  const pairs: Array<{ removed: string; added: string; newLine: number }> = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== "remove") {
      i += 1;
      continue;
    }
    const removeStart = i;
    while (i < lines.length && lines[i]!.kind === "remove") i += 1;
    const removeRun = lines.slice(removeStart, i);
    const addStart = i;
    while (i < lines.length && lines[i]!.kind === "add") i += 1;
    const addRun = lines.slice(addStart, i);
    if (removeRun.length === addRun.length) {
      for (let k = 0; k < removeRun.length; k++) {
        const removed = removeRun[k]!;
        const added = addRun[k]!;
        pairs.push({ removed: removed.content, added: added.content, newLine: added.newLine! });
      }
    }
  }
  return pairs;
}

const NON_MINIMAL_MIN_CHANGED_LINES = 6;
const NON_MINIMAL_NO_DELTA_RATIO = 0.5;

function totalOfKind(hunk: DiffHunk, kind: "add" | "remove"): number {
  return hunk.lines.reduce((count, line) => (line.kind === kind ? count + 1 : count), 0);
}

/**
 * Is this hunk PURE indentation churn: every removed and every added line accounted for by a
 * whitespace-only pair, with nothing left unpaired?
 *
 * The "fully paired" requirement (every remove and every add line in the hunk is consumed by a
 * 1:1 pair) is what makes the auto-fix in `fix.ts` safe: dropping a fully-paired churn hunk
 * removes an equal number of old-side and new-side lines, so it can never shift another hunk's
 * line numbers. A hunk containing an unequal-length remove/add run alongside pure churn is NOT
 * flagged here — `pairedRemoveAddRuns` silently skips unequal runs, and treating the REST of the
 * hunk as "100% churn" while ignoring lines it could not pair would both misreport the hunk and
 * make an auto-fix unsafe.
 */
export function isPureIndentationChurnHunk(hunk: DiffHunk): boolean {
  const pairs = pairedRemoveAddRuns(hunk);
  if (pairs.length === 0) return false;
  if (pairs.length !== totalOfKind(hunk, "remove") || pairs.length !== totalOfKind(hunk, "add")) return false;
  return pairs.every((p) => isWhitespaceOnlyChange(p.removed, p.added));
}

/**
 * Flag indentation-only churn and count changed lines with no semantic delta.
 *
 * Two finding shapes:
 *  - `indentation-churn`: a hunk whose every line is accounted for by a whitespace-only
 *    remove/add pair — the hunk changed formatting and nothing else. Auto-fixable: dropping the
 *    whole hunk is safe (see `isPureIndentationChurnHunk`).
 *  - `non-minimal-diff`: a hunk that is NOT pure churn but where at least half its PAIRED changed
 *    lines (≥6 of them) carry no semantic delta — evidence of a diff that reformats lines it did
 *    not need to touch alongside a real change, i.e. class (e), "non-minimal diffs touching
 *    unrelated lines". Not auto-fixable: a partial hunk mixes a real edit with the noise, and
 *    removing only the noise without re-deriving the hunk boundaries risks corrupting the real
 *    change.
 */
export function analyzeDiffMinimality(files: readonly DiffFile[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    const path = reportedPath(file);
    for (const hunk of file.hunks) {
      if (isPureIndentationChurnHunk(hunk)) {
        const pairs = pairedRemoveAddRuns(hunk);
        findings.push({
          class: "indentation-churn",
          file: path,
          line: pairs[0]!.newLine,
          detail: `hunk @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ changes ${pairs.length} line(s) by leading whitespace only`,
          autoFixable: true,
        });
        continue;
      }

      const pairs = pairedRemoveAddRuns(hunk);
      if (pairs.length === 0) continue;
      const noDeltaPairs = pairs.filter((p) => hasNoSemanticDelta(p.removed, p.added));
      if (pairs.length >= NON_MINIMAL_MIN_CHANGED_LINES
        && noDeltaPairs.length / pairs.length >= NON_MINIMAL_NO_DELTA_RATIO) {
        findings.push({
          class: "non-minimal-diff",
          file: path,
          line: noDeltaPairs[0]!.newLine,
          detail: `hunk @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ has no semantic delta on ${noDeltaPairs.length}/${pairs.length} changed lines — likely touches lines unrelated to the actual edit`,
          autoFixable: false,
        });
      }
    }
  }

  return findings;
}
