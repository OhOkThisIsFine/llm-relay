import ts from "typescript";
import type { DiffFile } from "./diff-parser.js";
import { findingPreamble, runFileAnalyzer } from "./file-driver.js";
import type { Finding } from "./types.js";

const TS_FILE = /\.(ts|tsx|mts|cts)$/;

/** Top-level bindings whose value shape makes an in-place mutation meaningful: object/array
 * literals and `new X(...)` instances (Map, Set, a class instance holding its own state) — plus
 * every EXPORTED top-level binding regardless of shape, since exporting it makes it part of the
 * module's shared surface by declaration. */
function collectModuleScopeBindings(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const initializer = decl.initializer;
      const isStateShaped = initializer !== undefined
        && (ts.isObjectLiteralExpression(initializer)
          || ts.isArrayLiteralExpression(initializer)
          || ts.isNewExpression(initializer));
      if (isExported || isStateShaped) names.add(decl.name.text);
    }
  }
  return names;
}

/** Walk up from an expression to the root identifier of a member/index-access chain:
 * `state.rows[0].value` -> `state`. Returns null for anything else (a call result, `this`, …). */
function rootIdentifier(node: ts.Expression): string | null {
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

const MUTATING_METHODS = new Set([
  "push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin",
  "set", "delete", "clear", "add",
]);

function isAssignmentTarget(node: ts.Node): ts.Expression | null {
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    return node.left;
  }
  return null;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  switch (kind) {
    case ts.SyntaxKind.EqualsToken:
    case ts.SyntaxKind.PlusEqualsToken:
    case ts.SyntaxKind.MinusEqualsToken:
    case ts.SyntaxKind.AsteriskEqualsToken:
    case ts.SyntaxKind.SlashEqualsToken:
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
    case ts.SyntaxKind.QuestionQuestionEqualsToken:
      return true;
    default:
      return false;
  }
}

/** `state.rows.push(x)` / `cache.set(k, v)` / `seen.delete(k)` — a call to a known mutating
 * built-in method on a member-access chain rooted at a tracked binding. */
function mutatingCallTarget(node: ts.Node): ts.Expression | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!MUTATING_METHODS.has(callee.name.text)) return null;
  return callee.expression;
}

function isFunctionLikeContainer(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessor(node)
    || ts.isSetAccessor(node)
    || ts.isConstructorDeclaration(node);
}

/** Is `node` lexically inside a function body (as opposed to sitting directly among a source
 * file's top-level statements)? `node` itself is never function-like here (it is an assignment or
 * call expression), so this only ever matches an ANCESTOR. */
function isInsideFunctionBody(node: ts.Node): boolean {
  return ts.findAncestor(node, isFunctionLikeContainer) !== undefined;
}

interface MutationSite {
  readonly node: ts.Node;
  readonly target: ts.Expression;
}

function findMutationSites(sourceFile: ts.SourceFile): MutationSite[] {
  const sites: MutationSite[] = [];
  const visit = (node: ts.Node): void => {
    const assignmentTarget = isAssignmentTarget(node);
    if (assignmentTarget !== null && isInsideFunctionBody(node)) {
      sites.push({ node, target: assignmentTarget });
    }
    const mutatingTarget = mutatingCallTarget(node);
    if (mutatingTarget !== null && isInsideFunctionBody(node)) {
      sites.push({ node, target: mutatingTarget });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

function findingsForFile(file: DiffFile, path: string, readOriginal: (path: string) => string | null): Finding[] {
  const preamble = findingPreamble(file, path, readOriginal, { tsx: path.endsWith(".tsx") });
  if (preamble === null) return [];
  const { addedLines, sourceFile } = preamble;
  const moduleScope = collectModuleScopeBindings(sourceFile);
  if (moduleScope.size === 0) return [];

  const findings: Finding[] = [];
  for (const site of findMutationSites(sourceFile)) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(site.node.getStart(sourceFile));
    const lineNo = line + 1;
    if (!addedLines.has(lineNo)) continue;
    const root = rootIdentifier(site.target);
    if (root === null || !moduleScope.has(root)) continue;
    findings.push({
      class: "shared-state-mutation",
      file: path,
      line: lineNo,
      detail: `\`${site.node.getText().slice(0, 120)}\` mutates module-level state \`${root}\` from inside a function`,
      autoFixable: false,
    });
  }
  return findings;
}

/**
 * Flag statements the diff ADDS that assign into module-level (top-level, exported, or
 * object-shaped) state from inside a function body.
 *
 * A tracked binding is either exported, or a top-level `const`/`let`/`var` initialized to an
 * object/array literal or a `new X(...)` instance — the shapes a mutation actually changes for
 * every future reader of the module, as opposed to a local primitive that happens to sit at
 * module scope. Both a direct assignment (`state.x = …`, compound operators included) and a call
 * to a known mutating method (`push`, `set`, `delete`, …) on a property/element-access chain
 * rooted at that binding count. Only sites on lines the diff ADDED are reported — a mutation the
 * delegate did not touch is not this diff's defect.
 */
export function analyzeSharedStateMutation(files: readonly DiffFile[], readOriginal: (path: string) => string | null): Finding[] {
  return runFileAnalyzer(files, readOriginal, (file, path, readOriginal) => {
    if (!TS_FILE.test(path)) return [];
    return findingsForFile(file, path, readOriginal);
  });
}
