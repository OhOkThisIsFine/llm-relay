# delegate-gate — a quality gate for delegated diffs

`llm-relay delegate-gate <diff-file> --repo <root> [--fix]`

A **host-side CLI**, not a server route. `dispatch.ts`/`lane-manifest.ts` decide which agent lane
a host hands a delegated task to; the *host* runs that lane and gets back a unified diff. This
gate runs between "the lane returned a diff" and "a judgment pass or a merge happens" — the same
place a human reviewer would sit, except deterministic and mechanical, on the same "repair
boundary" this repo draws everywhere else: it checks *protocol/structural* properties of the diff,
never whether the change is a good idea. Nothing here calls a model.

## Why this exists

Delegated diffs fail in a small number of recurring, mechanically detectable shapes — evidenced in
this project's own sibling repo's history (see "Evidence" below): a test that asserts on a
hand-copied replica of the code it claims to test rather than calling the real thing, and, as
general classes worth guarding regardless of what any one history search turns up: pure
re-indentation dressed up as a real edit, casts that exist only to silence the type checker,
mutation of state a diff's caller cannot see coming, and diffs that touch far more than the stated
change. A human reviewer catches these eventually, at the cost of attention; a mechanical pass
catches them every time, before a judgment pass ever reads the diff.

## What it checks

Four detectors, each producing findings of one `class`:

| class | what it flags | mechanism |
|---|---|---|
| `indentation-churn` | A hunk whose every line is a whitespace-only remove/add pair — the hunk reformats and changes nothing else. | Unified-diff parsing + per-pair whitespace comparison. No AST needed. |
| `non-minimal-diff` | A hunk that is not pure churn, but where at least half its paired changed lines (≥6) carry no semantic delta (`removed.trim() === added.trim()`) — evidence the diff reformats lines beside the real edit. | Same pairing as above, ratio-gated. |
| `tautological-assertion` | An `expect(...)` call added to a changed `*.test.ts`/`*.test.tsx` file that cannot fail (`expect(true).toBe(true)`, `expect(x).toBe(x)` on the same identifier, `expect(<literal>).toBeDefined()`, a trivially-satisfied `toBeTruthy`/`toBeFalsy`), plus a best-effort check for an assertion whose value has no traceable reference to anything the test file imported. | TypeScript compiler API (`ts.createSourceFile`) over the diff's reconstructed post-image, restricted to lines the diff **added**. |
| `unnecessary-cast` | An `as` cast introduced by the diff that adds nothing: always `as any` and `x as unknown as T` double casts; best-effort a literal cast to the primitive type it already has (`"x" as string`). | Same AST pass, `AsExpression` nodes on added lines. |
| `shared-state-mutation` | A statement the diff **added**, inside a function body, that assigns into or calls a mutating method on a top-level (exported, or object/array/`new X()`-initialized) binding. | Same AST pass: collect module-scope bindings, then walk for assignment/`.push`/`.set`/… targets rooted at one of them, filtered to added lines and to sites inside a function. |

Every AST-based detector only looks at lines the diff **added** — it reconstructs each changed
file's post-patch content from `--repo`'s pre-image plus the diff's hunks (`post-image.ts`), then
maps each AST node back to a line and keeps only nodes on an added line. A pre-existing tautology
the diff did not touch is not this diff's defect to report.

**Precision over recall, deliberately**, per the class this repo already follows for the parts of
its request path that decide routing on evidence (`target-facts.ts`'s "a miss learns nothing"):
the assertion and cast checks are syntactic/structural, not full type-checking, so they flag only
shapes that are unambiguous by construction. Proving a general cast is unnecessary, or that an
assertion's value can never diverge from a fixture, needs a whole-program type checker and real
data-flow analysis — out of scope here, and a wrong "this is fine" from an over-eager heuristic is
worse than an under-report, because it teaches a reviewer to stop reading.

## Verdict schema

```ts
interface Finding {
  class: "indentation-churn" | "non-minimal-diff" | "tautological-assertion"
       | "unnecessary-cast" | "shared-state-mutation";
  file: string;      // path as it appears in the diff (post-image path)
  line: number;      // 1-based line in the POST-image
  detail: string;    // human-readable explanation
  autoFixable: boolean;
}

interface Verdict {
  pass: boolean;               // true iff findings is empty
  findings: Finding[];
}
```

The CLI prints the `Verdict` as JSON on stdout and exits `0` on pass, `1` when there is at least
one finding — the exit code always reflects the **input** diff, whether or not `--fix` ran.

## Auto-repair (`--fix`)

Only the two **mechanical** classes are auto-fixed, into `<diff-file>.fixed.patch` beside the
input — the target repo is never touched:

- `indentation-churn`: the whole flagged hunk is dropped. Safe because the detector requires every
  line in the hunk to be accounted for by an equal-length whitespace-only pair (`isFullyPaired` —
  see `minimality.ts`), so removing the hunk deletes an equal number of old-side and new-side
  lines and can never shift another hunk's `@@` line numbers.
- `unnecessary-cast`, only the trivially-redundant-literal-cast shape: the `as <Type>` suffix is
  removed in place on that one line. `as any` and the double-`unknown` cast are **never**
  auto-fixed — removing them can change what the surrounding code type-checks as, which is a
  judgment call, not a mechanical rewrite.

`non-minimal-diff`, `tautological-assertion` and `shared-state-mutation` findings always stay in
the verdict; there is no mechanical rewrite for "which assertion did you mean" or "is this
mutation intentional".

If nothing in the diff is mechanically fixable, `--fix` writes nothing and says so on stderr; the
JSON verdict on stdout is unaffected either way.

## How an orchestrator wires this in

Run it on every lane-returned packet **before** judgment/merge, in the same host process that
executes the lane (per `dispatch.ts`'s "the relay never spawns a `cli` rung — it owns the order,
the host executes"; delegate-gate belongs to that same host-side layer, not the proxy):

```sh
llm-relay delegate-gate lane-output.patch --repo . --fix
```

- Exit `0`: nothing to flag — proceed to judgment/merge as normal.
- Exit `1`: read the JSON verdict. `autoFixable` findings have a corresponding hunk/line already
  rewritten in `lane-output.patch.fixed.patch` if `--fix` was passed; apply that instead if you
  trust the mechanical rewrite, or hand the verdict to whatever makes the merge/reject call for the
  non-mechanical findings. This gate does not decide "reject the diff" on your behalf — it reports.

## Evidence this targets real defects, not hypothetical ones

`C:\Code\audit-tools` (a sibling project, not this repo) has direct git history for the
tautological-assertion class: commit `c791df49` ("refactor(tests): one step-walking driver, and
fix the test that never called its subject") records a test —
`"advancePastDesignReview throws on unknown pause kind"` — that declared a hand-copied replica of
the production step-walker *inside the test body* and asserted against the replica; the production
helper could have been deleted and the test would have stayed green. The backlog entry recorded
alongside it (`docs/backlog/open-bugs.md`, commit `a2e16310`) generalizes the tell: "a function
declared in a test file that mirrors production control flow… rather than calling into `src/`" —
and notes why ordinary gates miss it (green, typechecks, no unused exports, coverage counts the
replica's own lines).

The other four classes (indentation churn, unnecessary casts, shared-state mutation, non-minimal
diffs) are covered on the owner's standing instruction regardless of what a bounded history search
turns up for them specifically in that repo — they are exactly the shapes a delegate lane produces
when it is asked to make a small change and instead reformats, defeats the type checker to make a
red build go green, or reaches for a module-level cache/counter instead of threading state through
an argument.
