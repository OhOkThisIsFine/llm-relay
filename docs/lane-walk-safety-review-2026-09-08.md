# Safety review of the dispatch lane walk — 2026-09-08

Two adversarial review lenses re-run over the lane-walk sprint (`7b2b536..HEAD`), at the owner's
direction, after the sprint's first review lost 81 of its 116 agents to the monthly spend limit and
left four of five lenses unverified.

**Owner's choice, verbatim options given:** re-run the two safety lenses (closed-union discipline
and the project's stated invariants), rather than all four or none. The reasoning offered and
accepted: this repository's own history says those two classes are the ones that actually cause
harm here — eight recorded closed-union defects, against zero harm ever traced to a documentation
lens.

## Method

Six reviewers: two lenses × three file groups, each on Opus, each told to verify against source and
to run a mutation where it could. Every finding then met three refuters with different jobs — read
the control flow, test whether the finding belongs to a class this project deliberately defers, and
try to construct the concrete failure — with two of three required to kill a finding.

Free offload lanes were ruled out for every stage, by measurement rather than preference: seven
read-only reconnaissance packets against this same codebase on 2026-09-05 returned invented symbol
names, invented line ranges and an invented module interface, 7 of 7 unsound. The defect class these
lenses hunt produces no compile error and no failing test, so a fabricated symbol name is
indistinguishable from a real finding, and checking one means re-reading the source — the whole task.

## Coverage, stated honestly

| | Result |
|---|---|
| Reviewers that returned | **6 of 6** — full lens × file-group coverage |
| Findings raised | 33 |
| Survived three refuters | 7 (collapsing to 5 distinct defects) |
| Genuinely refuted | 2 |
| **Never verified** | **24** — their refuters died on the spend limit |
| Completeness critic | died on the spend limit |

⚠ **The 24 are UNVERIFIED, not refuted.** The workflow script computed "survives" as
`votes >= 2 && refuted < 2`, so a finding whose three refuters all died scored zero votes and fell
into the same bucket as one that was argued down. That is a defect in the harness, not a verdict on
those findings, and it is recorded here because the two states call for opposite responses. Nine of
the 24 were verified afterwards by hand; the rest are listed below as open.

## Confirmed and fixed

Each was re-verified by reading the source directly before any change, and each fix is
mutation-checked — the mutation and what it killed are recorded beside it.

### 1. A demotion did not retract the pin — the walk re-tried the lane it had just abandoned

`recordLaneAffinity` in `src/routes/admin.ts`. **The most consequential of the five.**

`remember` in `src/lane-affinity.ts` writes one key per KIND (`${kind}:${tier}:${laneId}`), so
`demoteLane` can never touch the pin row; only the caller can. It retracted on the pin path only. A
lane that answered, was pinned, and then hung on a later walk therefore held BOTH memories — and
`rankSelectable` ranks a lane holding both as PINNED, i.e. FIRST.

So the lane the walk had just abandoned led the ladder again on the very next dispatch, and kept
that position for the rest of its pin window (15 minutes by default). **The demotion half of the
feature was inert in exactly the case the feature exists for** — the owner's own framing was
*"if the free lane is slow or not answering, we move through the fallbacks"*.

`rankSelectable`'s doc rests on the retraction being symmetric: it ranks a both-memories lane as
pinned BECAUSE "the pin is the more recent evidence", which only holds if recording one retracts the
other. `CLAUDE.md` states the same. Both were describing behaviour that did not exist.

*Fix:* retract before recording, whichever way the report points. *Mutation:* moving the retraction
back inside the pin branch kills one test.

### 2. A configured default was reported as a measurement

`attemptBudget` in `src/dispatch.ts`. Found independently by both lenses.

Three real cases were mapped onto a two-member union, and the collapse resolved to the STRONGER
claim — the exact shape this repository records as its most repeated defect. The final return
emitted `basis: "history"` unconditionally, including when `Math.max` picked the operator's flat
`attemptMs` over the lane's own quantile.

Measured consequence: a fast answer-mode relay lane (5.7–10.8 s runs against a 90 s floor) rendered
`budget: 90s (from 25 recorded runs)` when no run had ever approached 90 s — and the lane's real p80
of nine seconds, the very signal the per-lane budget exists to expose, was invisible.

*Fix:* a third basis, `clamped`, carrying the lane's own `quantileMs` beside the served figure;
`formatAttemptBudget` became a total switch closed with `const _never: never`. *Mutation:*
collapsing the third case back into `history` kills three tests; the negative control stays green.

⚠ One existing test asserted `basis: "history"` for the clamped case — a test written to pin the
defect it should have caught. Flipped in the same commit as the fix, this repository's standing
protocol.

### 3. The budget measured itself, and ratcheted

`recordLaneRun` in `src/dispatch-lane-stats.ts`. Raised by both lenses, in three separate findings.

`entry.wallClockMs.push(...)` ran for every status, `abandoned` included. But the walk kills an
abandoned lane AT its budget, so that wall clock IS the budget, not a duration the lane produced.
Feeding it back made the next budget partly a measurement of the relay's own impatience — and it
ratchets: a lane slower than its budget is killed at B, B enters the window, the quantile is pulled
toward B, and the lane can never demonstrate it needed longer, because it is never allowed to run
longer.

Shape of the harm: `free-pool`'s median run is roughly five times the flat 90 s default, so under a
walk it would be killed at 90 s repeatedly, its window would fill with 90 s samples, and the lane
the whole feature exists to route around would instead be locked out permanently.

*Fix:* an abandoned run contributes no duration sample. The COUNT still lands — that a lane did not
answer is first-party evidence, and `lane-affinity.ts` acts on it; only the duration is withheld.
This is exactly the rule `circuit-breaker.ts` already states for a cancelled attempt, whose `status`
is deliberately absent so that "an attempt of unknown true duration moves uptime and never enters a
latency statistic". *Mutation:* restoring the unconditional push kills two tests.

### 4. Two reason strings described behaviour the ordering code does not implement

`selectionReason` in `src/dispatch.ts`. A reason string is a claim about the ordering code, printed
on the ladder view and by the CLI.

- `"the least recently demoted"` — `rankSelectable` consults no timestamp at all. Its comparator is
  a stable sort on a three-valued band rank, so the lane named is simply the first in ladder order
  among the demoted. Demoting `beta` and then `alpha` named `alpha` — the MOST recently demoted —
  while claiming the opposite.
- `"N ahead of it unavailable"` — with demotion reordering, a lane ahead in ladder order can be
  perfectly READY and merely demoted. It reported available lanes as unavailable.

*Fix:* counts taken from the selectable set rather than from `position` arithmetic, and the two
populations named separately, because they call for opposite responses — an unavailable lane needs
attention, a demoted one is the walk working. *Mutation:* reverting the strings kills two tests;
the "genuinely unavailable" negative control stays green.

### 5. `dispatchWalk: false` did not restore the pre-walk behaviour

`annotateAffinity` in `src/dispatch.ts`. The field doc promises `false` "restores the pre-walk
behaviour exactly: one lane per call, no memory."

`recordLaneAffinity` did honour it, so no new memory was written. But rows written while the walk
was ON are restored from `lane-affinity.json` at startup, and `annotateAffinity` read them
regardless — so `rankSelectable` kept reordering and `next` kept naming a pinned lane. An operator
who turned the walk off to revert got the old behaviour only once every surviving memory lapsed, up
to the six-hour ceiling.

*Fix:* gate inside `annotateAffinity`, which makes `rankSelectable` a no-op by construction — with
no lane carrying either field every lane ranks equal and the sort is stable. *Mutation:* removing
the gate kills one test; the walk-on negative control stays green.

### 6. The restore path bypassed the ceiling the write path enforces

`restoreLaneAffinityRows` in `src/lane-affinity.ts`. `clampWindow` bounded what this process
records; the restore admitted whatever the file said, subject only to a future check. A hand-edited
or corrupt `lane-affinity.json` could park a lane pinned or demoted for years, past the six-hour
ceiling the module states as its own rule, silently — a memory leaves no trace by design.

*Fix:* clamp on restore too, correcting rather than rejecting, the direction `clampWindow` already
takes. *Mutation:* removing the clamp kills one test; the in-ceiling negative control stays green.

### 7. A closed-union fall-through in the attempt reason

`attemptReason` in `src/mcp/server.ts` ended in an unconditional `return "the lane failed"`. Total
by exhaustion today, with no compile-time protection — and `DispatchLaneStatus` GREW this very
sprint, which is the proof it grows.

*Fix:* an explicit `failed` branch closed with `const _never: never`. *Mutation, by type:* adding a
fifth status member is now a compile error at six tables, `attemptReason` among them. Before the
fix that site absorbed the new member silently.

### 8. A comment claimed a protection the code does not deliver

`quantileWallClockMs` in `src/dispatch-lane-stats.ts`. The header said the `(0, 1]` clamp stops a
quantile of 0 from taking "the fastest sample ever seen — a budget nothing could meet".

`Math.max(Number.EPSILON, q)` changes no answer: at EPSILON, `Math.ceil(q * n)` is 1; at 0 it is 0,
which the `Math.max(1, rank)` below lifts to 1. Both return `sorted[0]` — the fastest sample, which
is precisely what the comment said the clamp prevented. The operator's real guard is `parseRouting`,
which rejects an `attemptQuantile` outside `(0, 1)` as a hard load error.

*Fix:* the comment now states what the code does and names the parser as the actual guard. No
behaviour change.

## Refuted, and left alone

- **`toLane`** in `src/dispatch.ts` — claimed to classify `LadderRung["kind"]` without a total
  table. Refuted 3 of 3.
- **`formatAttemptBudget`** — claimed the basis union was hand-declared in three places with no
  total classification. Refuted 2 of 2. (It became a total switch anyway, as part of finding 2.)

## Still open — raised, never verified

Filed in `docs/backlog.md`. The two worth naming here:

- **The stats window is keyed by lane id ALONE and ignores the `tier` field this sprint added**, so
  one ladder's runs set another ladder's budget — while the affinity memory beside it IS tier-keyed,
  for the stated reason that "a lane that answered a `low` task says nothing about `xhigh`". The
  same reasoning applies to a budget. Not fixed here because it changes the persisted key space and
  needs a schema decision.
- **`LANE_AFFINITY_KINDS`'s docstring promises that "a third memory is a compile error at every
  total table"**, and no total table over `LaneAffinityKind` exists in `src/`.

## What this review does NOT cover

Three of the original five lenses remain unexamined: **test quality**, **documentation**, and the
**concurrency** lens (which did complete in the first review and found the exhaustion-advice defect
fixed on 2026-09-06). The completeness critic that would have named the gaps inside these two lenses
died on the spend limit, so this section is written from the coverage table rather than from its
verdict.
