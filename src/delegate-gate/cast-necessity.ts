import ts from "typescript";
import type { DiffFile, DiffLine } from "./diff-parser.js";
import { reportedPath } from "./diff-parser.js";
import { findingPreamble, runFileAnalyzer } from "./file-driver.js";
import type { Finding } from "./types.js";

/** A single-line, mechanical correction to one `+` line of the diff — the raw-index-addressed
 * edit `fix.ts` applies directly to the diff text. */
export interface CastFixEdit {
  readonly rawIndex: number;
  readonly newContent: string;
}

const TS_FILE = /\.(ts|tsx|mts|cts)$/;

const PRIMITIVE_KEYWORD_TO_LITERAL_KIND: ReadonlyMap<ts.SyntaxKind, readonly ts.SyntaxKind[]> = new Map([
  [ts.SyntaxKind.StringKeyword, [ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral]],
  [ts.SyntaxKind.NumberKeyword, [ts.SyntaxKind.NumericLiteral]],
  [ts.SyntaxKind.BooleanKeyword, [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword]],
]);

/** `x as unknown as T` (or any AsExpression whose own expression is itself an AsExpression to
 * `unknown`) — a double cast that exists only to defeat the type checker. */
function isDoubleUnknownCast(node: ts.AsExpression): boolean {
  const inner = node.expression;
  if (!ts.isAsExpression(inner)) return false;
  return ts.isTypeReferenceNode(inner.type) === false
    && inner.type.kind === ts.SyntaxKind.UnknownKeyword;
}

function isAnyCast(node: ts.AsExpression): boolean {
  return node.type.kind === ts.SyntaxKind.AnyKeyword;
}

/** `"x" as string`, `5 as number`, `true as boolean` — a cast of a literal to the primitive type
 * it already trivially has. Deliberately narrow: this is a syntactic check, not a type-checker
 * one, so it only fires on the unambiguous literal-vs-keyword-type case and never guesses about
 * an identifier's inferred type. */
function isTriviallyRedundantLiteralCast(node: ts.AsExpression): boolean {
  const allowedKinds = PRIMITIVE_KEYWORD_TO_LITERAL_KIND.get(node.type.kind);
  if (allowedKinds === undefined) return false;
  return allowedKinds.includes(node.expression.kind);
}

function findAsExpressionsOnAddedLines(sourceFile: ts.SourceFile, addedLines: ReadonlySet<number>): ts.AsExpression[] {
  const found: ts.AsExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      if (addedLines.has(line + 1)) found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function describeCast(node: ts.AsExpression): { detail: string; autoFixable: boolean } | null {
  if (isAnyCast(node)) {
    return { detail: `\`${node.getText()}\` casts to \`any\`, discarding type safety`, autoFixable: false };
  }
  if (isDoubleUnknownCast(node)) {
    return { detail: `\`${node.getText()}\` is a double cast through \`unknown\` — it exists only to bypass the type checker`, autoFixable: false };
  }
  if (isTriviallyRedundantLiteralCast(node)) {
    return { detail: `\`${node.getText()}\` casts a literal to the primitive type it already has — the cast adds nothing`, autoFixable: true };
  }
  return null;
}

/**
 * Flag `as` casts introduced by the diff that add nothing.
 *
 * Always flagged: `as any` and `x as unknown as T` double casts. Best-effort beyond that: a
 * literal cast to the primitive type it already trivially has (`"x" as string`). Deciding
 * necessity in the general case needs a full type-checker `Program` over the whole repo — slow,
 * and only as good as whether the diff's target compiles in isolation — so this deliberately stays
 * syntactic rather than risk a false positive on a cast that genuinely narrows or widens a type.
 */
function findingsForFile(file: DiffFile, path: string, readOriginal: (path: string) => string | null): Finding[] {
  const preamble = findingPreamble(file, path, readOriginal, { tsx: path.endsWith(".tsx") });
  if (preamble === null) return [];
  const { addedLines, sourceFile } = preamble;

  const findings: Finding[] = [];
  for (const node of findAsExpressionsOnAddedLines(sourceFile, addedLines)) {
    const described = describeCast(node);
    if (described === null) continue;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      class: "unnecessary-cast",
      file: path,
      line: line + 1,
      detail: described.detail,
      autoFixable: described.autoFixable,
    });
  }
  return findings;
}

export function analyzeCastNecessity(files: readonly DiffFile[], readOriginal: (path: string) => string | null): Finding[] {
  return runFileAnalyzer(files, readOriginal, (file, path, readOriginal) => {
    if (!TS_FILE.test(path)) return [];
    return findingsForFile(file, path, readOriginal);
  });
}

/** The diff's own `add` line at post-image line `newLine`, or undefined if none matches — used to
 * translate an AST node's line number back into the raw diff line the auto-fix edits. */
function addedDiffLine(file: DiffFile, newLine: number): DiffLine | undefined {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add" && line.newLine === newLine) return line;
    }
  }
  return undefined;
}

function castEditsForFile(file: DiffFile, path: string, readOriginal: (path: string) => string | null): CastFixEdit[] {
  const preamble = findingPreamble(file, path, readOriginal, { tsx: path.endsWith(".tsx") });
  if (preamble === null) return [];
  const { lines, addedLines, sourceFile } = preamble;

  const edits: CastFixEdit[] = [];
  for (const node of findAsExpressionsOnAddedLines(sourceFile, addedLines)) {
    if (!isTriviallyRedundantLiteralCast(node)) continue; // the only auto-fixable cast shape
    const start = node.getStart(sourceFile);
    const { line: lineIndex, character: startCol } = sourceFile.getLineAndCharacterOfPosition(start);
    const endCol = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).character;
    const lineText = lines[lineIndex];
    if (lineText === undefined) continue;
    const diffLine = addedDiffLine(file, lineIndex + 1);
    if (diffLine === undefined) continue;
    const replacementText = node.expression.getText(sourceFile);
    const newContent = lineText.slice(0, startCol) + replacementText + lineText.slice(endCol);
    edits.push({ rawIndex: diffLine.rawIndex, newContent });
  }
  return edits;
}

/** Mechanical corrections for the `unnecessary-cast` findings this module can safely apply on its
 * own: only the trivially-redundant-literal-cast shape (`"x" as string` -> `"x"`). `as any` and
 * the double-unknown cast are never auto-fixed — removing them changes what the surrounding code
 * type-checks as, which is a judgment call for a human, not a mechanical rewrite. */
export function findFixableCastEdits(files: readonly DiffFile[], readOriginal: (path: string) => string | null): CastFixEdit[] {
  const edits: CastFixEdit[] = [];
  for (const file of files) {
    const path = reportedPath(file);
    if (!TS_FILE.test(path) || file.hunks.length === 0) continue;
    edits.push(...castEditsForFile(file, path, readOriginal));
  }
  return edits;
}
