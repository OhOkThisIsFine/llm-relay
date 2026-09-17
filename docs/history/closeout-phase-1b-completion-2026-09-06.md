# Closeout — C:\Code\llm-relay

Rendered 2026-09-06T18:31:52.153Z by ~/.agent-config/render-closeout.mjs.
Verification below is rendered from commands, arguments, and the verify-green ledger.

## Identity

- Branch: `main`
- HEAD: `4abbd6ccfd5e56a1825322af97e418856c84fe25`
- Sprint start: `f65afb1`

## Commits in the sprint range

- 4abbd6c docs: closeout for the Phase 1b completion lap (v0.73.0)
- c5a854f docs: name the release the Phase 1b completion lap shipped as
- b4ca089 chore: release v0.73.0
- d6acd8a docs: route the Phase 1b completion results to their homes
- e5d3074 refactor(config): the routing parser gets its own module (HOTSPOT-03, stage 2)
- 3ce59f0 refactor(config): spec spelling gets its own leaf (HOTSPOT-03, stage 1)
- a7143af refactor(ping): remove the deprecated extractQuotaPercent wrapper
- 222f950 refactor(stream-commit): name the relay-authored-response predicate once (CLONE-07)

## Working tree and remote

- Working tree: NOT clean — FAIL
```
M HANDOFF.md
```
- `origin/main` equals HEAD — PASS

## verify-green ledger

- Ledger: `npm run check` recorded 2026-09-06T18:31:42.592Z on tree `00b47cf3e019`
- `verify-green check`: verify-green: PASS — tree 00b47cf3e019 matches the passing run recorded 2026-09-06T18:31:42.592Z (npm run check) — PASS

## CI for exact HEAD

- CI: completed/success (run 34051123706) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/34051123706

## Operator-provided narrative (not machine-derived)

# Phase 1b completion lap — shipped as v0.73.0

## What this lap did

Landed the three Phase 1b items that needed no owner ruling, and released them. Phase 1b is now
finished except for two decisions that are the owner's to make.

| Commit | Item | Pinning test | Mutation check |
|---|---|---|---|
| `222f950` | **CLONE-07** — one named `relayAuthoredResponse` predicate for four call sites | yes, 6-row truth table | yes, 2 mutations |
| `a7143af` | **`extractQuotaPercent` removed** — deprecated, zero `src/` consumers | n/a, a deletion | n/a |
| `3ce59f0` | **HOTSPOT-03 stage 1** — `src/spec.ts`, the leaf the parser needs | `one-declaration` guard | n/a, a pure move |
| `e5d3074` | **HOTSPOT-03 stage 2** — `src/config/routing-parser.ts`, 700 lines out of `config.ts` | yes, a leaf/purity guard | n/a, a pure move |
| `d6acd8a` | Results routed to the backlog and HANDOFF | — | — |

`config.ts` is **2001 → 1261** lines across the lap — 2001 at the sprint start, 1993 immediately before stage 2, 1261 after it.

## How the 700-line move was verified, because a green suite is not evidence

A multiset comparison of every non-blank, non-comment line, **scoped to stage 2**:
`git show e5d3074^:src/config.ts` against the union of `e5d3074:src/config.ts` and
`e5d3074:src/config/routing-parser.ts`.

- **REMOVED: exactly 2.** The spec import line, which lost its now-unused `AUTO_MODEL`, and
  `function parseRouting(`, which gained an `export`.
- **ADDED: 10.** Every one of them import or export plumbing — the new module's import block, the
  re-export line in `config.ts`, and three type names that are now legitimately imported in two
  files instead of one.

No functional line changed.

⚠ **A naive per-function body diff reports FOUR false positives here**, and that is worth knowing
before anyone repeats the check. Comment blocks legitimately move between neighbours when the code
around them moves, so a span that runs "declaration to next declaration" picks up a different
trailing comment in each file. Compare code lines, not spans.

⚠⚠ **And state the SCOPE and the hashes, or the check does not reproduce.** Run the same comparison
from the sprint start instead of from stage 2's parent and it reports 8 removals and 11 additions.
That is not a hidden change: the six extra removals are `POOL_PREFIX`, `AUTO_MODEL` and
`splitSpec` leaving `config.ts` in STAGE 1, for `src/spec.ts` — a file that "the union of the two
new files" excludes. The original wording said "HEAD", which meant the parent commit in the message
where it was written and something else entirely once quoted here. An auditor applying the stated
method literally got the different numbers, which is the point: a verification recipe has to carry
its own scope.

## Two corrections to the item, both from reading HEAD rather than the plan

- **The closure is 19 symbols, not 11.** `DEFAULT_LANE_PROBE`, `parseOffload` and `parseRouting`
  have real importers outside `config.ts` (`lane-cadence.ts`, `offload.ts`, `test/config.test.ts`),
  so the new module exports them and `config.ts` re-exports all three; no other importer changed.
  Three names the closure survey flagged turned out to be COMMENTS, not calls.
- **The complexity discrepancy is settled.** The catalog said 137, the in-source comment said 124,
  and `parseRouting` measures **125**. The comment was right.

## Named rather than left implied

- ⚠ **HOTSPOT-03 moved the hotspot; it did not shrink it.** `parseRouting` is still complexity 125.
  The item's stated property was about the MOVE, and all three parts of it hold and are pinned by a
  test that reads the source — but "the hotspot is dealt with" would be the wrong conclusion, so the
  function's own complexity is filed with its own property and a pointer to the standing invariant
  that says restructuring for that rule is the refactor the 2026-08-04 review already rejected.
- **`extractQuotaPercent` was a published export**, which is why this is a MINOR release and not a
  patch. Pre-1.0, deprecated, replacement named, zero `src/` consumers.
- **The two owner decisions were not touched**, deliberately: P1-06 (recommend DECLINE) and
  CLONE-26's unnamed second consequence. Both carry their evidence in the backlog.

## Offload, with the measurement from both laps

The owner asked for offload through llm-relay. What it was used for, and what that establishes:

- **A concrete diff reviewed against a stated claim — works.** A `free-pool` lane checked the
  CLONE-07 change in 208 s, rebuilt the six-row truth table from source, correctly reported no
  differences, and independently confirmed that `ctx.protocol` is only ever `chat` or `responses`.
- **Open-ended reconnaissance — does not work here.** Measured on the previous lap: 7 of 7 packets
  failed adversarial verification, fabricating symbol names and line ranges with total confidence.

The distinction that predicts which way it goes is whether the lane's output can be CHECKED by
running or reading something specific. That is now recorded in project memory and in HANDOFF.

⚠ The HOTSPOT-03 review was dispatched and then LOST: `dispatch_status` answered
`unknown jobId: job-0063` mid-run because the MCP child restarted. My own multiset proof was the
stronger check anyway, so nothing was blocked — but the handle is gone, which is the documented
`dispatch` trap in a new form.

## Friction hit during the lap

Rewalked from the transcript, not from recall.

1. **A dispatched job vanished with `unknown jobId` because the MCP child restarted.** Already filed
   machine-wide as the `waitMs` trap; this is a new symptom of it — the job was not slow, the host
   simply lost the handle. Recorded in HANDOFF.
2. **`posttooluse-typecheck.mjs` blocked mid-edit twice more**, both on a module extraction. Already
   filed machine-wide, and the recurrence note added yesterday says this shape meets it every time.
3. **`shell-conventions-guard.mjs` blocked a generator chained with `&&`.** The verdict is right and
   the remedy is clear; noted only because "run the generator then check" is a natural one-liner and
   has to be two calls.
4. **My own `execSync` helper crashed on eslint's non-zero exit** and dumped ~60 KB of JSON into the
   transcript. Self-inflicted; the lesson is to capture a linter's output to a file rather than
   through `execSync`, which throws on the exit code that means "findings exist".
5. **`check:package` measures whatever `dist/` holds**, met again: the ceiling breach only appeared
   after a rebuild. Already in `CLAUDE.md`.

## What the closeout auditor found, and what changed because of it

The independent auditor (sonnet, given only the repo path, the start commit and the closeout text)
re-ran the work rather than reading it: it reproduced the stage-2 multiset comparison line for line,
reverted `relayAuthoredResponse` twice and confirmed the mutation counts of 8 and 4, re-measured
`parseRouting` at 125, confirmed the leaf import set, and checked CI, the tag and the registry.

It found two things this document had wrong, both now corrected above:

- **The line counts were false on both ends.** 1994 → 1268 was claimed; the truth is 1993 → 1261 for
  stage 2, and 2001 → 1261 across the lap. The bad pair came from a script reporting array lengths
  before the later import pruning, and it had already propagated from the stage-2 commit message
  into `HANDOFF.md`. Not load-bearing — the multiset proof is what establishes correctness — but
  false as stated, and both documents are fixed.
- **The multiset recipe did not carry its own scope**, so applying it literally across the whole lap
  gives 8/11 rather than 2/10. Now stated with the commit hashes and with stage 1's own move called
  out.

It also named three things the narrative was silent on, all now added: the package baseline moved
twice (`packageEntries` 398 → 401 → 404, ceiling 401 → 407), `AGENTS.md` was regenerated, and the
render's Identity section names `c5a854f` while the true HEAD is one commit later — the renderer's
own circularity, disclosed in that commit's message.

⚠ It correctly declined to verify the three narrative-only claims that rest on dispatch logs outside
this repository: the 208-second lane review, the prior lap's 7-of-7 fabrication finding, and the
`unknown jobId` incident. Those are labelled operator-provided in the render, which is the right
status for them.

## Verdict

- 1 section(s) FAIL: working tree.
