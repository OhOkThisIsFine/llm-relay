import ts from "typescript";
import type { DiffFile } from "./diff-parser.js";
import { reportedPath } from "./diff-parser.js";
import { reconstructPostImage } from "./post-image.js";
import type { Finding } from "./types.js";

/** A file this pass considers a test file — the diff-minimality and cast detectors run over
 * every changed TS file, but a tautological-assertion check is meaningful only in a test. */
const TEST_FILE = /\.test\.(ts|tsx)$/;

interface ExpectChain {
  /** The `expect(...)` call itself. */
  readonly call: ts.CallExpression;
  /** Its single argument (the "actual" value under test), if there is exactly one. */
  readonly actual: ts.Expression | undefined;
  /** The matcher call chained onto it — `.toBe(x)`, `.toBeDefined()`, etc. — if any. */
  readonly matcherName: string | undefined;
  readonly matcherArgs: readonly ts.Expression[];
}

/** Find every `expect(...)` call and, when it is immediately the receiver of one property-access
 * matcher call (`expect(x).toBe(y)`), pair them. A bare `expect(x)` with no matcher, or a longer
 * chain (`.not.toBe(...)`), is walked separately below — `.not` inverts the verdict on some of
 * these checks, so it is handled explicitly rather than folded in here. */
function findExpectChains(sourceFile: ts.SourceFile): ExpectChain[] {
  const chains: ExpectChain[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "expect") {
      const actual = node.arguments.length === 1 ? node.arguments[0] : undefined;
      const outer = matcherCallOn(node);
      chains.push({
        call: node,
        actual,
        matcherName: outer?.name,
        matcherArgs: outer?.args ?? [],
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return chains;
}

/** Given the `expect(...)` call expression, find the matcher property access that has it (or its
 * `.not`) as receiver, and return the matcher name plus call arguments. Returns undefined if the
 * expect() result is not immediately called as `.<name>(...)`. */
function matcherCallOn(expectCall: ts.CallExpression): { name: string; args: readonly ts.Expression[] } | undefined {
  const parent = expectCall.parent;
  if (!ts.isPropertyAccessExpression(parent)) return undefined;
  // Skip over an optional `.not` / `.resolves` / `.rejects` modifier to reach the real matcher.
  let access = parent;
  if ((access.name.text === "not" || access.name.text === "resolves" || access.name.text === "rejects")
    && ts.isPropertyAccessExpression(access.parent)) {
    access = access.parent;
  }
  const call = access.parent;
  if (!ts.isCallExpression(call) || call.expression !== access) return undefined;
  return { name: access.name.text, args: call.arguments };
}

/** A normalized value key for a LITERAL expression node, or null for anything else. Two literal
 * nodes with equal keys are the identical compile-time value, so `expect(<lit>).toBe(<lit>)` on a
 * matching pair is always true for a primitive — `===` on two equal primitives never disagrees. */
function literalValueKey(node: ts.Expression): string | null {
  if (ts.isStringLiteralLike(node)) return `str:${node.text}`;
  if (ts.isNumericLiteral(node)) return `num:${Number(node.text)}`;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "bool:true";
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "bool:false";
  if (node.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isIdentifier(node) && node.text === "undefined") return "undefined";
  return null;
}

function isLiteralExpression(node: ts.Expression): boolean {
  return ts.isStringLiteralLike(node)
    || ts.isNumericLiteral(node)
    || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword
    || node.kind === ts.SyntaxKind.NullKeyword
    || (ts.isIdentifier(node) && node.text === "undefined");
}

/** `expect(x).toBe(x)` — literally the same identifier expression on both sides, which can only
 * ever pass. Deliberately narrow: `expect(x.a).toBe(x.a)` or two calls that happen to return the
 * same value are NOT flagged, because proving they always agree needs data-flow analysis this
 * pass does not do — a false positive here would tell a reviewer to distrust a real assertion. */
function isSameIdentifierBothSides(actual: ts.Expression, expected: ts.Expression): boolean {
  return ts.isIdentifier(actual) && ts.isIdentifier(expected) && actual.text === expected.text;
}

/** expect(true).toBe(true), expect(1).toBe(1), expect("x").toBe("x") — any pair of literals with
 * the same compile-time value — and expect(x).toBe(x) on the identical identifier. */
function describeTautologicalToBe(actual: ts.Expression, matcherName: string, matcherArgs: readonly ts.Expression[]): string | null {
  if (matcherName !== "toBe" || matcherArgs.length !== 1) return null;
  const expected = matcherArgs[0]!;
  const actualKey = literalValueKey(actual);
  const expectedKey = literalValueKey(expected);
  if (actualKey !== null && actualKey === expectedKey) {
    return `expect(${actual.getText()}).toBe(${expected.getText()}) always passes — both sides are the same literal`;
  }
  if (isSameIdentifierBothSides(actual, expected)) {
    return `expect(${actual.getText()}).toBe(${expected.getText()}) compares an identifier to itself and can never fail`;
  }
  return null;
}

/** expect(<literal>).toBeDefined() — a literal is defined by construction; this asserts nothing
 * about the code under test. */
function describeTautologicalToBeDefined(actual: ts.Expression, matcherName: string): string | null {
  if (matcherName !== "toBeDefined") return null;
  if (!isLiteralExpression(actual)) return null;
  if (actual.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(actual) && actual.text === "undefined") return null;
  return `expect(${actual.getText()}).toBeDefined() is always true — the argument is a literal, not a value derived from the code under test`;
}

/** expect(<literal>).toBeTruthy() / .toBeFalsy() on a constant that trivially satisfies it. */
function describeTautologicalTruthiness(actual: ts.Expression, matcherName: string): string | null {
  if (matcherName !== "toBeTruthy" && matcherName !== "toBeFalsy") return null;
  if (!isLiteralExpression(actual)) return null;
  const truthy = isLiteralTruthy(actual);
  if (truthy === null || (matcherName === "toBeTruthy") !== truthy) return null;
  return `expect(${actual.getText()}).${matcherName}() always passes — the argument is a constant`;
}

function describeTautology(chain: ExpectChain): string | null {
  const { actual, matcherName, matcherArgs } = chain;
  if (actual === undefined || matcherName === undefined) return null;
  return describeTautologicalToBe(actual, matcherName, matcherArgs)
    ?? describeTautologicalToBeDefined(actual, matcherName)
    ?? describeTautologicalTruthiness(actual, matcherName);
}

function isLiteralTruthy(node: ts.Expression): boolean | null {
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(node) && node.text === "undefined") return false;
  if (ts.isNumericLiteral(node)) return Number(node.text) !== 0;
  if (ts.isStringLiteralLike(node)) return node.text.length > 0;
  return null;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function collectImportedNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const clause = statement.importClause;
    if (clause.name !== undefined) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) names.add(element.name.text);
    }
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
  }
  return names;
}

/** Every function-like binding DECLARED in this file (at any nesting depth — the real-history
 * defect this targets declared its replica INSIDE the `it()` callback, not at module scope):
 * `function name() {}`, plus `const name = () => {}` / `const name = function () {}`. */
function collectLocallyDeclaredFunctionNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      names.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function rootIdentifierOf(expr: ts.Expression): string | null {
  let curr: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(curr)) {
    curr = curr.expression;
  }
  return ts.isIdentifier(curr) ? curr.text : null;
}

/**
 * Does `node` contain a call to a local non-imported function as the function under test?
 *
 * When a call invokes an IMPORTED function (or a method on an imported object/namespace),
 * that call is the invocation of code under test. Any calls within its argument list are test
 * fixtures or helper builders, not the function under test, so we do not descend into them.
 */
function containsLocalReplicaCall(
  node: ts.Node,
  localNonImportedFunctions: ReadonlySet<string>,
  importedNames: ReadonlySet<string>,
): boolean {
  if (localNonImportedFunctions.size === 0) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression)) {
        const callee = n.expression.text;
        if (localNonImportedFunctions.has(callee)) {
          found = true;
          return;
        }
        if (importedNames.has(callee)) {
          // Callee is imported: this is an invocation of code under test. Do not descend into arguments.
          return;
        }
      } else if (ts.isPropertyAccessExpression(n.expression)) {
        const root = rootIdentifierOf(n.expression);
        if (root !== null && importedNames.has(root)) {
          // Callee is accessed on an imported object/namespace. Do not descend into arguments.
          return;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * Best-effort, narrowly targeted at the real defect this class is named for (audit-tools
 * `c791df49`): an assertion whose `actual` expression calls a function DECLARED LOCALLY in this
 * same test file rather than one the file imported — the "hand-copied replica of production
 * control flow, asserted against the replica" shape.
 *
 * Deliberately NOT "does this expression reference an import at all" — that broader form flags
 * ordinary assertions over local test data (`const a = 1; const b = 2; expect(a + b).toBe(3)`),
 * which is legitimate and common, trading the "prefer false negatives" rule for noise. Calling a
 * same-file, non-imported FUNCTION is a much sharper tell: a plain local variable is not a
 * replica of anything, but a locally-declared function standing in for one usually is.
 */
function describeLocalReplicaCall(chain: ExpectChain, importedNames: ReadonlySet<string>, localFunctionNames: ReadonlySet<string>): string | null {
  const { actual, matcherName } = chain;
  if (actual === undefined || matcherName === undefined) return null;
  if (importedNames.size === 0) return null; // nothing to contrast "local" against
  const nonImportedLocalFunctions = new Set([...localFunctionNames].filter((n) => !importedNames.has(n)));
  if (!containsLocalReplicaCall(actual, nonImportedLocalFunctions, importedNames)) return null;
  return `expect(${actual.getText().slice(0, 80)}).${matcherName}(...) calls a function declared locally in this test file, never imported — it may assert against a hand-copied replica rather than the code under test`;
}

function findingsForFile(file: DiffFile, path: string, readOriginal: (path: string) => string | null): Finding[] {
  const original = file.isNew ? null : readOriginal(path);
  const { lines, addedLines } = reconstructPostImage(original, file);
  if (addedLines.size === 0) return [];

  const content = lines.join("\n");
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const importedNames = collectImportedNames(sourceFile);
  const localFunctionNames = collectLocallyDeclaredFunctionNames(sourceFile);

  const findings: Finding[] = [];
  for (const chain of findExpectChains(sourceFile)) {
    const line = lineOf(sourceFile, chain.call);
    if (!addedLines.has(line)) continue;

    const tautology = describeTautology(chain);
    if (tautology !== null) {
      findings.push({ class: "tautological-assertion", file: path, line, detail: tautology, autoFixable: false });
      continue;
    }

    const localReplica = describeLocalReplicaCall(chain, importedNames, localFunctionNames);
    if (localReplica !== null) {
      findings.push({ class: "tautological-assertion", file: path, line, detail: localReplica, autoFixable: false });
    }
  }
  return findings;
}

/**
 * Flag assertions added by the diff, in changed TEST files, that cannot fail or that show no
 * traceable connection to the code under test.
 *
 * Sharp (always correct) checks: `expect(<literal>).toBeDefined()`, `expect(true).toBe(true)` /
 * `expect(false).toBe(false)`, `expect(x).toBe(x)` on the identical identifier, and the
 * `toBeTruthy`/`toBeFalsy` equivalents on a constant.
 *
 * Best-effort (may under-report on purpose, per the "prefer false negatives" rule): an assertion
 * whose value is produced by calling a function DECLARED LOCALLY in the same test file rather
 * than one it imported — the "hand-copied replica of production control flow, asserted against
 * the replica" shape from `docs/delegate-gate.md`'s cited real defect. Narrower than "no reference
 * to any import at all" on purpose: that broader form flags ordinary local-variable assertions
 * (`const a = 1; expect(a + 1).toBe(2)`), which is legitimate and common.
 */
export function analyzeTestAssertions(files: readonly DiffFile[], readOriginal: (path: string) => string | null): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const path = reportedPath(file);
    if (!TEST_FILE.test(path) || file.hunks.length === 0) continue;
    findings.push(...findingsForFile(file, path, readOriginal));
  }
  return findings;
}
