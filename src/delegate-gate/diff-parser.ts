/**
 * A minimal unified-diff parser (git's `diff --git` dialect) — just enough structure for the
 * detectors in this module: per-file hunks, each line typed context/add/remove and carrying its
 * line number in whichever image it belongs to.
 *
 * Deliberately narrow: this is not a general patch-apply library. It accepts the shape `git diff`
 * / `git format-patch` produce and refuses (throws `DiffParseError`) rather than guess on anything
 * else — the same "refuse, don't mangle" rule `documents.ts` and `openai-request.ts` follow
 * elsewhere in this repo.
 */

export type DiffLineKind = "context" | "add" | "remove";

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Line content, WITHOUT the leading `+`/`-`/` ` marker and without a trailing newline. */
  readonly content: string;
  /** 1-based line number in the pre-image; undefined for an added line. */
  readonly oldLine: number | undefined;
  /** 1-based line number in the post-image; undefined for a removed line. */
  readonly newLine: number | undefined;
  /** Index of this line's raw (marker-included) text in the diff's full line array. The
   * auto-repair pass edits/removes raw lines by this index rather than re-deriving offsets — the
   * ONE place the diff's own text layout is exposed outside this parser. */
  readonly rawIndex: number;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
  /** Raw-line index of this hunk's `@@ ... @@` header. */
  readonly headerRawIndex: number;
  /** Raw-line index one past this hunk's last body line — `[headerRawIndex, endRawIndex)` is the
   * whole hunk, header included, safe to delete as a unit. */
  readonly endRawIndex: number;
}

export interface DiffFile {
  /** Pre-image path (`a/...` with the prefix stripped), or null for a newly created file. */
  readonly oldPath: string | null;
  /** Post-image path (`b/...` with the prefix stripped), or null for a deleted file. */
  readonly newPath: string | null;
  readonly isNew: boolean;
  readonly isDeleted: boolean;
  readonly hunks: readonly DiffHunk[];
}

export class DiffParseError extends Error {}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Strip a single leading `a/` or `b/` path prefix, the form git always emits. */
function stripPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

function pathFromHeaderLine(line: string, marker: "---" | "+++"): string | null {
  const rest = line.slice(marker.length + 1);
  // A trailing tab introduces a timestamp in some diff dialects; git's own output never does,
  // but tolerate it rather than folding it into the path.
  const tabAt = rest.indexOf("\t");
  const raw = (tabAt === -1 ? rest : rest.slice(0, tabAt)).trim();
  if (raw === "/dev/null") return null;
  return stripPrefix(raw);
}

interface FileHeader {
  readonly isNew: boolean;
  readonly isDeleted: boolean;
  readonly oldPath: string | null;
  readonly newPath: string | null;
}

/** Consume the file-header block (index/mode/rename/similarity lines, then `---`/`+++`) starting
 * at `rawLines[start]`. Returns the parsed header and the index of the first line after it. */
function parseFileHeader(rawLines: readonly string[], start: number): { header: FileHeader; next: number } {
  let isNew = false;
  let isDeleted = false;
  let oldPath: string | null = null;
  let newPath: string | null = null;

  let i = start;
  while (i < rawLines.length) {
    const line = rawLines[i]!;
    if (line.startsWith("diff --git ") || line.startsWith("@@")) break;
    if (line.startsWith("new file mode")) isNew = true;
    else if (line.startsWith("deleted file mode")) isDeleted = true;
    else if (line.startsWith("--- ")) oldPath = pathFromHeaderLine(line, "---");
    else if (line.startsWith("+++ ")) newPath = pathFromHeaderLine(line, "+++");
    i += 1;
    if (line.startsWith("+++ ")) break;
  }
  return { header: { isNew, isDeleted, oldPath, newPath }, next: i };
}

/** Classify one hunk body line and advance the pre/post cursors it carries. */
function classifyHunkBodyLine(body: string, oldCursor: number, newCursor: number, rawIndex: number): DiffLine {
  const marker = body.charAt(0);
  if (marker === "+") return { kind: "add", content: body.slice(1), oldLine: undefined, newLine: newCursor, rawIndex };
  if (marker === "-") return { kind: "remove", content: body.slice(1), oldLine: oldCursor, newLine: undefined, rawIndex };
  // A context line always starts with a single space in a conforming diff; an empty string (a
  // blank context line some tools emit unmarked) is accepted the same way.
  const content = marker === " " ? body.slice(1) : body;
  return { kind: "context", content, oldLine: oldCursor, newLine: newCursor, rawIndex };
}

/** Parse one `@@ -l,s +l,s @@` hunk starting at `rawLines[start]`. Returns the hunk and the
 * index of the first line after it. */
function parseHunk(rawLines: readonly string[], start: number): { hunk: DiffHunk; next: number } {
  const headerLine = rawLines[start]!;
  const match = HUNK_HEADER.exec(headerLine);
  if (!match) throw new DiffParseError(`malformed hunk header: ${headerLine}`);
  const oldStart = Number(match[1]);
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);

  const lines: DiffLine[] = [];
  let oldCursor = oldStart;
  let newCursor = newStart;
  let consumedOld = 0;
  let consumedNew = 0;
  let i = start + 1;
  while (consumedOld < oldLines || consumedNew < newLines) {
    if (i >= rawLines.length) break;
    const body = rawLines[i]!;
    if (body.startsWith("diff --git ") || body.startsWith("@@")) break;
    // A bare "\ No newline at end of file" marker carries no content of its own.
    if (body.startsWith("\\ ")) {
      i += 1;
      continue;
    }
    const line = classifyHunkBodyLine(body, oldCursor, newCursor, i);
    lines.push(line);
    if (line.kind !== "remove") { newCursor += 1; consumedNew += 1; }
    if (line.kind !== "add") { oldCursor += 1; consumedOld += 1; }
    i += 1;
  }

  return { hunk: { oldStart, oldLines, newStart, newLines, lines, headerRawIndex: start, endRawIndex: i }, next: i };
}

/**
 * Parse a unified diff into per-file hunks.
 *
 * Accepts multiple `diff --git` sections. Each file section must open with a `diff --git a/X b/Y`
 * line; `---`/`+++`/`@@` lines follow standard git conventions. A file section with no hunks
 * (e.g. a pure rename or mode change) is skipped — there is nothing here for a line-level
 * detector to look at.
 */
export function parseUnifiedDiff(text: string): readonly DiffFile[] {
  // Normalize line endings so a CRLF-authored diff parses identically to LF.
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const files: DiffFile[] = [];

  let i = 0;
  while (i < rawLines.length) {
    if (!rawLines[i]!.startsWith("diff --git ")) {
      i += 1;
      continue;
    }
    const { header, next: afterHeader } = parseFileHeader(rawLines, i + 1);
    i = afterHeader;

    const hunks: DiffHunk[] = [];
    while (i < rawLines.length && rawLines[i]!.startsWith("@@")) {
      const { hunk, next } = parseHunk(rawLines, i);
      hunks.push(hunk);
      i = next;
    }

    if (hunks.length > 0 || header.isNew || header.isDeleted) {
      files.push({ oldPath: header.oldPath, newPath: header.newPath, isNew: header.isNew, isDeleted: header.isDeleted, hunks });
    }
  }

  return files;
}

/** The path a detector should report findings under — the post-image path, falling back to the
 * pre-image path for a deletion (which carries no post-image). */
export function reportedPath(file: DiffFile): string {
  return file.newPath ?? file.oldPath ?? "(unknown)";
}
