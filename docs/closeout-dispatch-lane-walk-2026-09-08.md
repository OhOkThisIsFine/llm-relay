# Closeout — C:\Code\llm-relay

Rendered 2026-09-08T18:14:34.926Z by ~/.agent-config/render-closeout.mjs.
Verification below is rendered from commands, arguments, and the verify-green ledger.

## Identity

- Branch: `main`
- HEAD: `fd755b77b2fcc377cd62f87696399c4fc7e1ce9b`
- Sprint start: `7b2b536b12c5a6835ad36210212ac07006e6f166`

## Commits in the sprint range

- fd755b7 docs: resolve the independent closeout audit's flags
- a8eb46f backlog: correct the lane-reordering entry — the distribution-based threshold shipped
- 75bf069 docs: name the two releases this lap shipped
- fcf7a98 chore: release v0.75.0
- 96f0f7f test(dispatch): separate the lane's own budget from the configuration default
- 87fc609 fix(cli): restore lane stats on both dispatch surfaces, not one
- 3aca96b feat(dispatch): give each lane a walk budget drawn from its own recorded runs
- 1401e3b chore: release v0.74.0
- 7c2adba backlog: accounting-store tests leak temp directories into Windows Temp
- 877ad7d fix(cli): restore ladder state into the config the cold dispatch builds from
- 7a31e9b docs: leave real headroom when ratcheting the package size baseline
- 5efba4b fix(dispatch): claim the ladder was exhausted only when it actually was
- d498b46 fix(package): correct size baseline
- f43d898 docs: remove obsolete proxy name
- f2806f3 feat(dispatch): walk the lane ladder automatically, and remember what answered

## Working tree and remote

- Working tree: NOT clean — FAIL
```
M docs/closeout-dispatch-lane-walk-2026-09-08.md
```
- `origin/main` equals HEAD — PASS

## verify-green ledger

- Ledger: `npm run check` recorded 2026-09-08T18:14:26.023Z on tree `253dbf4d06a0`
- `verify-green check`: verify-green: PASS — tree 253dbf4d06a0 matches the passing run recorded 2026-09-08T18:14:26.023Z (npm run check) — PASS

## CI for exact HEAD

- CI: completed/success (run 34261371529) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/34261371529

## Operator-provided narrative (not machine-derived)

## What the lap was for

Owner request, 2026-09-06: *"Agents keep manually deciding that the free lane is too slow and
moving to some other dispatch type. That shouldn't be necessary. The relay should automate that
process, so that if the free lane is slow or not answering, we move through the fallbacks until
finally reaching the base agent's own subagents. And once we hit a working lane, that lane should be
pinned at least temporarily."*

And the principle behind it, given when the scope was approved: *"Callers shouldn't have to
specifically pick models; they should have the option to if they want, but the default should just
be to call the relay with a reasoning level and have the relay do the rest."*

## What shipped

Two releases, both live, global binary reinstalled.

**v0.74.0** — `dispatch` walks the ladder. Each lane gets an attempt budget; a lane that does not
answer is killed and the next started. The LAST lane gets no budget, because there is nowhere to
move to and killing it would discard the only answer still coming. When every lane is spent the
answer is an instruction to do the work in the calling session — the relay cannot start the
caller's subagent, so the last rung is an answer, not a spawn. The lane that answers is pinned; the
lane that does not is demoted. `DispatchView.order` is the one definition of selection order, read
by both `next` and the walk.

**v0.75.0** — each lane's budget is now the 80th percentile of that lane's own recorded runs, with
the rolling window raised from 25 to 100 samples. Plus the two fixes below.

## Four defects found after the first commit, and how

⚠ **Two of the four were found by RUNNING THE BUILT BINARY, not by the suite.** That is the habit
worth carrying: a CLI-visible change is not done until the real binary has printed it.

1. **The exhaustion advice lied.** Found by an adversarial review, then verified against source.
   `dispatch` told the caller "every lane has been tried, do NOT call dispatch again" whenever no
   lane answered — including with `dispatchWalk: false`, which runs one lane, and with `maxLanes`
   capping the walk, where the same answer also said "N further lanes not tried". An autonomous
   caller acting on that abandons free capacity nothing contacted.

2. **The flat 90-second budget was wrong against live data.** Found by the owner asking what had
   become of the request path's distribution-based thresholds. Live per-lane medians are 81 s,
   114 s and 583 s, so 90 s sat below two of three and below the free pool's by a factor of six —
   the relay would have abandoned the free pool on nearly every dispatch, the opposite of the
   walk's purpose.

3. **The cold dispatch restored ladder state into the wrong object.** `runDispatch`'s fallback
   reloads the config, then built its view from the reloaded object while restoring into the
   original one. Both stores are keyed per config object, so the restore went somewhere the view
   never looks — silently. This PRE-DATES the lap: a cold `llm-relay dispatch` had never shown a
   restored cooldown.

4. **Lane statistics were restored on one of the two dispatch surfaces.** Two surfaces, one policy
   — this repository's recurring incident shape, recurring inside a single lap. It only became
   visible because the budget now depends on those statistics, so the cold view printed a wrong
   number rather than a missing column.

## What I got wrong

- I treated the backlog's warning — never point the request path's NUMBERS at a lane — as also
  ruling out its METHOD. The mechanism was the owner's, it existed, it was calibrated, and I did
  not use it. The backlog entry that said such a threshold was "still not possible" carried my
  reasoning and has been corrected rather than quietly dropped.
- The package size ceiling went red three times, all mine. Cause of the last two: I measured the
  baseline and then kept adding documentation, which lands in the `.d.ts` files by the two-pass
  build. The ceiling is now a round number well clear of the observation, and "measure last" is
  written into `CLAUDE.md`.
- My first cancellation test proved nothing — removing either guard left it green. Rewritten, and
  the mutation results are recorded beside it so the next reader does not repeat my mistake.

## Verification

Every behavioural claim carries a test, and every such test was mutation-checked at the time it was
written — the mutation and its result are recorded in the commit that introduced it.

⚠ **An earlier draft of this section claimed "nine mutations, each killing exactly the intended
test". The independent audit could not reconcile that number** — it counted about eleven described
checks, of which seven are explicitly labelled "mutation" in commit prose. The practice was real;
the tally was not something I had actually counted. It is removed rather than replaced with another
figure I cannot substantiate. Read the individual commits for what was checked.

⚠ **The per-lane latency figures quoted below are PERISHABLE and MACHINE-LOCAL.** They are a
snapshot of one operator's rolling window, which real traffic overwrites. The audit re-read the same
file hours later: `opencode-muse-spark` (p50 81 s, p80 165 s) and `agy-gemini` (p50 114 s, p80 224 s)
matched exactly, while `free-pool` had already moved from p50 583 s / p80 1383 s to 302 s / 1207 s
because dispatches continued. That is drift, not fabrication — and the conclusion is unchanged
either way, since free-pool's median is still more than three times the flat 90 s it replaced.
No future reader, and no CI job, can reproduce these numbers; re-measure from
`~/.llm-relay/dispatch-lane-stats.json` before quoting one.

## Independent audit

RAN (model: sonnet), against the repository, the CI and publish runs, the npm registry and the live
state file. Verdict: substantially accurate — every checkable behavioural and release claim held up.
Four flags were raised. Three are resolved here: the unreconciled mutation count above, the
perishable-figure provenance above, and a stale docstring on `LANE_LADDER_EXHAUSTED_ADVICE` that
cited the wrong test file (fixed in source). The fourth stands and cannot be closed: the adversarial
review's coverage figures are self-reported and unverifiable from this repository, which is why the
section below says so rather than presenting the review as complete.

⚠ **The adversarial review's coverage was PARTIAL and must not be read as a clean bill.** Five
lenses ran; 81 of its 116 agents died on the monthly spend limit. Only the concurrency lens
completed verification. The closed-union, invariant, test-quality and documentation lenses raised
findings that were never verified — that ground is unexamined, not clear.

## What remains, each with its home

- The calibrated per-lane DEMOTION threshold — `docs/backlog.md`. The budget now uses lane history;
  the demotion still uses walk evidence, which needs no threshold.
- The accounting-store temp-directory leak, 59 GiB — `docs/backlog.md`, filed by another session
  and committed here so the release gate could pass.
- `parseRouting` decomposition, the eligibility queue triage, and the rest — `docs/backlog.md`.
- Five machine-wide records — `C:\Code\docs\backlog.md`: the nightly static-analysis runner, the
  compaction-checkpoint gitignore convention, the stale untracked-cache trap, the partial-review
  trap, and the shell-escape trap (now enforced by a hook rather than advice).

## Verdict

- 1 section(s) FAIL: working tree.
