import type { DiffFile } from "./diff-parser.js";

export interface PostImage {
  /** The reconstructed post-patch file content, one line per array entry (no trailing newline
   * entries). */
  readonly lines: readonly string[];
  /** 1-based post-image line numbers the diff actually ADDED — the only lines an AST detector
   * may report a finding against ("introduced by the diff"). */
  readonly addedLines: ReadonlySet<number>;
}

/**
 * Reconstruct a file's post-patch content from its pre-image plus the diff's hunks.
 *
 * `original` is the pre-image content (read from `--repo`), or `null` for a newly created file —
 * a `null` pre-image is only valid when every hunk's removed-line count is zero, which is what a
 * `diff --git` "new file" section always produces.
 *
 * Lines outside any hunk are copied through unchanged from the pre-image; a hunk's `context`
 * lines are trusted as given (this is a diff CONSUMER, not a patch verifier — a hunk that lies
 * about context is the delegate's problem, not this gate's to detect).
 */
function applyHunkLines(hunk: DiffFile["hunks"][number], out: string[], added: Set<number>, startOldCursor: number): number {
  let oldCursor = startOldCursor;
  for (const line of hunk.lines) {
    if (line.kind === "remove") {
      oldCursor += 1;
      continue;
    }
    out.push(line.content);
    if (line.kind === "add") added.add(out.length);
    if (line.kind === "context") oldCursor += 1;
  }
  return oldCursor;
}

export function reconstructPostImage(original: string | null, file: DiffFile): PostImage {
  const originalLines = original === null ? [] : original.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const added = new Set<number>();

  let oldCursor = 0; // 0-based index into originalLines, next unconsumed line
  for (const hunk of file.hunks) {
    const hunkStartIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    // Copy the untouched span between the previous hunk (or file start) and this one.
    for (; oldCursor < hunkStartIndex; oldCursor++) {
      out.push(originalLines[oldCursor] ?? "");
    }
    oldCursor = applyHunkLines(hunk, out, added, oldCursor);
  }
  for (; oldCursor < originalLines.length; oldCursor++) {
    out.push(originalLines[oldCursor] ?? "");
  }

  return { lines: out, addedLines: added };
}
