# Closeout — C:\Code\llm-relay

Rendered 2026-09-06T18:14:00.001Z by ~/.agent-config/render-closeout.mjs.
Verification below is rendered from commands, arguments, and the verify-green ledger.

## Identity

- Branch: `main`
- HEAD: `c5a854f841ce908fd8376e715fc626c5435bcc67`
- Sprint start: `f65afb1`

## Commits in the sprint range

- c5a854f docs: name the release the Phase 1b completion lap shipped as
- b4ca089 chore: release v0.73.0
- d6acd8a docs: route the Phase 1b completion results to their homes
- e5d3074 refactor(config): the routing parser gets its own module (HOTSPOT-03, stage 2)
- 3ce59f0 refactor(config): spec spelling gets its own leaf (HOTSPOT-03, stage 1)
- a7143af refactor(ping): remove the deprecated extractQuotaPercent wrapper
- 222f950 refactor(stream-commit): name the relay-authored-response predicate once (CLONE-07)

## Working tree and remote

- Working tree: clean — PASS
- `origin/main` equals HEAD — PASS

## verify-green ledger

- Ledger: `npm run check` recorded 2026-09-06T18:09:29.983Z on tree `94c91dfd70b4`
- `verify-green check`: verify-green: PASS — tree 94c91dfd70b4 matches the passing run recorded 2026-09-06T18:09:29.983Z (npm run check) — PASS

## CI for exact HEAD

- CI: completed/success (run 34050815352) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/34050815352

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

`config.ts` is 1994 → 1268 lines.

## How the 700-line move was verified, because a green suite is not evidence

A multiset comparison of every non-blank, non-comment line, between `git show HEAD:src/config.ts`
and the union of the two new files:

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

## Verdict

- All machine-derived sections PASS.
