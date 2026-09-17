# P1-01 — Delegate-Gate Analyzer Driver Unification (CLONE-16 + CLONE-27)

Scope: consolidate the four delegate-gate per-file analyzer drivers into one shared driver.
Adversarial verdict: ACCEPT for both CLONE-16 and CLONE-27 per
`docs/history/reviews/adversarial-verification-2026-09-05.md`; fold the ScriptKind flag into this item.

## Architectural rationale and layering

Target location: a new shared driver module inside `src/delegate-gate/`, alongside
`post-image.ts` and `diff-parser.ts` (for example `src/delegate-gate/file-driver.ts`).
Rationale:

- The four drivers live in the same layer (`delegate-gate` analyzers) and share the same
  dependency direction: analyzer module → `post-image.ts` (`reconstructPostImage`) →
  `diff-parser.ts` (`DiffFile`). A shared driver preserves that direction and introduces
  no new edge.
- The alternative (a generic util outside `delegate-gate`) would invert the layer by
  forcing `delegate-gate` types (`DiffFile`, `Finding`, `PostImage`) into a lower layer.
  Keeping the driver inside `delegate-gate` keeps the types local.
- No circular dependency: the driver depends only on `post-image.ts`, `diff-parser.ts`,
  and the TypeScript compiler API already used by every analyzer. Analyzers depend on
  the driver, never the reverse.

## Complete blast radius

Seed symbols (verified by graph search on this project):

- Function `findingsForFile` in `src/delegate-gate/cast-necessity.ts` — the prelude
  sequence `readOriginal` → `reconstructPostImage` → early return on empty `addedLines`
  → `lines.join` → `ts.createSourceFile`.
- Function `castEditsForFile` in the same module — identical prelude, same call shape,
  differing only in the per-node visitor that follows.
- Function `findingsForFile` in `src/delegate-gate/shared-state.ts` — identical prelude
  with the same ScriptKind expression as `cast-necessity.ts`.
- Function `findingsForFile` in `src/delegate-gate/test-assertions.ts` — identical
  prelude except the ScriptKind argument is the plain-TS variant.
- File-loop drivers: function `analyzeCastNecessity` in `src/delegate-gate/cast-necessity.ts`
  and the corresponding per-file loop surrounding `findingsForFile` in
  `src/delegate-gate/shared-state.ts` — reported as differing only by callee name.
- Shared dependency: function `reconstructPostImage` in `src/delegate-gate/post-image.ts`
  and type `DiffFile` in `src/delegate-gate/diff-parser.ts` — unchanged.
- Callers of the four drivers: function `evaluateDiff` and function `evaluateDiffText`
  in `src/delegate-gate/gate.ts`, plus function `runDelegateGateCli` in
  `src/delegate-gate/cli.ts` — behavior must be identical after the move.
- Affected test suites: every suite under `test/delegate-gate/` — at minimum the suites
  covering `cli`, `fix`, and `fixtures` observed in the graph, plus any suite asserting
  `unnecessary-cast`, `shared-state-mutation`, or `tautological-assertion` findings.

Imports and exports: the only new export is the shared driver (`findingPreamble` plus
`runFileAnalyzer` or equivalent). No analyzer gains a new external import beyond the
driver module. The `tsx` flag becomes an explicit parameter, so the implicit
`path.endsWith` divergence becomes visible at each call site.

## Specific code modifications with contracts

New contract in the shared driver module:

```typescript
import type { DiffFile } from "./diff-parser.js";
import type * as ts from "typescript";

export interface FindingPreamble {
  readonly lines: readonly string[];
  readonly addedLines: ReadonlySet<number>;
  readonly sourceFile: ts.SourceFile;
}

export function findingPreamble(
  file: DiffFile,
  path: string,
  readOriginal: (path: string) => string | null,
  opts: { tsx: boolean },
): FindingPreamble | null;
```

Contract:

- Returns `null` exactly when the diff adds no lines (the current early-return case).
- Otherwise returns the reconstructed post-image plus a parsed `SourceFile` created
  with the ScriptKind selected by `opts.tsx`.
- Pure with respect to analysis: it performs no finding logic and allocates no
  findings.

Second contract for the file-loop shape:

```typescript
export function runFileAnalyzer<T>(
  files: ReadonlyMap<string, DiffFile>,
  readOriginal: (path: string) => string | null,
  analyzeOne: (file: DiffFile, path: string, preamble: FindingPreamble) => readonly T[],
): T[];
```

Before (representative — inside function `findingsForFile` in
`src/delegate-gate/cast-necessity.ts`, immediately after the function signature):

```typescript
const original = file.isNew ? null : readOriginal(path);
const { lines, addedLines } = reconstructPostImage(original, file);
if (addedLines.size === 0) return [];
const content = lines.join("\n");
const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
```

After (same anchor — inside function `findingsForFile` in
`src/delegate-gate/cast-necessity.ts`, immediately after the function signature):

```typescript
const preamble = findingPreamble(file, path, readOriginal, { tsx: true });
if (preamble === null) return [];
const { lines, addedLines, sourceFile } = preamble;
```

Before (inside function `findingsForFile` in
`src/delegate-gate/test-assertions.ts`, immediately after the function signature):

```typescript
const original = file.isNew ? null : readOriginal(path);
const { lines, addedLines } = reconstructPostImage(original, file);
if (addedLines.size === 0) return [];
const content = lines.join("\n");
const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
```

After (same anchor):

```typescript
const preamble = findingPreamble(file, path, readOriginal, { tsx: false });
if (preamble === null) return [];
const { lines, addedLines, sourceFile } = preamble;
```

The remaining two drivers change identically to the first example, each passing
`tsx: true`. The per-node visitor loops below each anchor stay untouched.
The file-loop drivers (`analyzeCastNecessity` in `src/delegate-gate/cast-necessity.ts`
and the loop surrounding `findingsForFile` in `src/delegate-gate/shared-state.ts`)
delegate iteration to `runFileAnalyzer`.

## Step-by-step implementation sequence

1. Create the shared driver module in `src/delegate-gate/` exporting
   `findingPreamble` and `runFileAnalyzer`, implemented by moving the verified
   prelude verbatim out of `cast-necessity.ts`.
2. Rewire function `findingsForFile` in `src/delegate-gate/cast-necessity.ts` to the
   driver with the TSX-enabled flag; keep the visitor below the anchor unchanged.
3. Rewire function `castEditsForFile` in the same module the same way.
4. Rewire function `findingsForFile` in `src/delegate-gate/shared-state.ts` with the
   TSX-enabled flag; keep the `collectModuleScopeBindings` call and mutation-site
   loop below the anchor unchanged.
5. Rewire function `findingsForFile` in `src/delegate-gate/test-assertions.ts` with
   the plain-TS flag; keep the `collectImportedNames` and
   `collectLocallyDeclaredFunctionNames` calls below the anchor unchanged.
6. Replace the two file-loop drivers with `runFileAnalyzer`, passing each
   analyzer's per-file function as `analyzeOne`.
7. Run the verification plan below; delete no old code until all delegate-gate
   suites pass.

## Verification and regression test plan

Exact commands, run from the repository root:

```powershell
npm test -- test/delegate-gate/cli.test.ts
npm test -- test/delegate-gate/fix.test.ts
npm test -- test/delegate-gate/fixtures.test.ts
npm test -- test/delegate-gate
npx tsc --noEmit
```

Automated checks and invariant assertions:

- The full `test/delegate-gate` suite passes with zero finding-count changes on the
  existing fixture corpus (the driver is behavior-preserving by construction).
- A targeted invariant test asserts `findingPreamble` returns `null` exactly when
  `addedLines` is empty, and returns a `SourceFile` whose ScriptKind matches the
  `tsx` flag for both a `.ts` path and a `.tsx` path.
- Confirm by text search that no analyzer module still imports `reconstructPostImage`
  directly except through the new driver.
- Confirm zero line-number references were introduced by this change (symbol anchors
  only, per this plan's mandatory constraint).
