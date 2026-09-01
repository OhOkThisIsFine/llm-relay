# Refactor consistency audit — 2026-09-01

Scope: the 98 uncommitted paths present at lap start (`ec5c16f`). Another model decomposed
`src/server.ts` (5,799 → 863 lines, a net −4,936) into `routes/messages.ts`, `routes/openai-front.ts`,
`candidate-runner.ts`, `stream-pipeline.ts`, `accounting-state.ts`, `config-types.ts`,
`storage/json-store.ts` and `kernel/protocol-ir.ts`.

**The gate was green before this audit began.** `npm run check` passed on tree `2666aff05ed2`:
server 147 files / 2,860 passed / 5 skipped; dashboard 5 files / 32 passed; package checks passed.
Every defect below therefore passed the suite. Green did not mean correct.

## Method

- All 104 top-level functions of the original `server.ts` were located in the new tree. None was
  lost.
- Each old function body was extracted, comment-stripped and compared against its new home.
- Survivors were then read against the invariants `CLAUDE.md` records for them.

⚠⚠ **PROVENANCE OF THE "BEFORE" STATE — read this before checking any claim here against `git`.**
Every defect below was found and repaired in the WORKING TREE, before the first commit of the
sprint. The broken state therefore exists in no commit and cannot be reconstructed from history.
An independent auditor confirmed this on 2026-09-01: `git show ec5c16f:package.json` and
`package.json` at HEAD are byte-identical for `build:server`, and `git log ec5c16f..HEAD --
package.json` is empty — exactly what a defect repaired before commit looks like.

So the evidence for each "was broken" claim is a MEASUREMENT taken at the time, named in place
below, not a diff. Where a claim can be checked at HEAD it says so, and every such claim was
independently confirmed. A future reader wanting the broken state has only this document.

## Confirmed defects

### 1. The two-pass build was deleted — an owner decision reverted

`package.json` `build:server` lost its second `tsc` pass. `CLAUDE.md` marks that pass load-bearing
(owner decision 2026-08-30, package-size variant C) and says in bold not to collapse the two passes.

Measured cost, same tree, only the script differing:

| | packBytes | unpackedBytes | entries |
|---|---|---|---|
| Pre-refactor baseline | 916,365 | 4,787,349 | 368 |
| Refactor, one pass | 1,180,450 | 5,474,033 | 392 |
| Refactor, two passes restored | 936,693 | 4,872,345 | 392 |
| Final, after deleting `protocol-ir.ts` | 937,955 | 4,875,246 | 389 |

⚠ The final row is three entries smaller and ~1.3 KB larger, which is the two-pass split doing
exactly its job: the deleted module drops three `dist/` entries, while the invariant prose restored
in this lap lands in the `.d.ts` files, which pass 1 keeps on purpose.

⚠ `check:package` measures whatever `dist/` holds. A gate run immediately after deleting a source
module still reported 392 entries, because it measured a stale `dist/`. Rebuild before trusting a
package figure.

The deleted pass accounted for 243,757 `packBytes`. The honest refactor cost is +20,328 `packBytes`
and +24 entries.

`docs/dashboard-package-baseline.json` had been regenerated with the inflated figures and its
ceilings raised to match, so the gate stayed green over the regression.

**Action taken:** the second pass is restored; the baseline now records the honest figures with the
same proportional ceiling headroom the file used before.

### 2. `readBody` stopped declaring its error code — an oversized body now answers 500, not 413

`src/stream-pipeline.ts` rewrote `readBody` to throw a plain `Error` whose *message* embeds
`BODY_TOO_LARGE_CODE` as text. `bodyReadErrorCode` in `dashboard-routes.ts` classifies on
`error.code === BODY_TOO_LARGE_CODE`, so the property is absent and every oversized dashboard
request downgrades from `oversized` (413) to `internal` (500).

This reinstates the exact defect `CLAUDE.md` records as fixed:

> ⚠ `bodyReadErrorCode` reads a DECLARED `BODY_TOO_LARGE_CODE` off the rejection; it used to regex
> the error MESSAGE, i.e. the relay inferring 413-vs-500 from prose it wrote itself.

The rewrite also dropped `req.resume()`, the drain that lets the client receive the explicit
response, and dropped the `DEFAULT_MAX_BODY_BYTES` default.

No test caught it: `test/dashboard/routes.test.ts` injects its own `readBody` stub.

**Action taken:** the reviewed implementation is restored. `test/stream-pipeline.test.ts` is new and
pins the declared code, the drain, error propagation and the default ceiling.

### 3. `parseAssistant` demanded a field its own contract does not declare

The rewrite gated on `parsed.role === "assistant"`. `AssistantMessage` in `src/anthropic.ts`
declares no `role` field. A body that omits it parsed as `null`, which silently skips validation and
repair — the project's core path.

The rewrite also cast the parsed object wholesale instead of copying fields, so an absent
`stop_reason` became `undefined` rather than `null`. `emitSse` writes that field back to the wire,
where `undefined` omits the key and `null` states it.

**Action taken:** the reviewed constructor is restored, with the reason recorded beside it.

### 4. `frameOpensToolUse` stopped joining multi-line SSE data

The rewrite parsed each `data:` line on its own and split on `"\n"` alone. SSE permits one payload
spread over several `data:` lines, and `sse-frames.ts` already establishes joining as the
convention here. A multi-line `content_block_start` frame therefore answered `null`, so the
tool_use withholding trigger never fired for it.

**Action taken:** the collect-and-join form is restored, with CRLF-tolerant splitting.

### 5. 1,267 lines of invariant prose were deleted from the request path

`server.ts` carried 1,350 comment lines. **As received**, its six successor files on the request
path carried 83 — a 94 percent loss, with `src/server.ts` itself at zero.

⚠ Counted as `grep -cE "^\s*(//|/\*|\*)"` over exactly `src/server.ts`, `routes/messages.ts`,
`routes/openai-front.ts`, `candidate-runner.ts`, `stream-pipeline.ts` and `accounting-state.ts`.
`config-types.ts` and `storage/json-store.ts` are excluded: they are newly authored type and
infrastructure modules, not homes `server.ts`'s prose moved into. **At HEAD the same six count 138**,
because this lap restored 55 lines. Both figures are correct for their own tree, and an auditor
measuring HEAD will not reproduce 83 — that is the point of stating which tree each describes.

This is not cosmetic in this repository. `CLAUDE.md` cites `server.ts` as the *home* of recorded
arguments and instructs later readers to obey them. The `latency-demotion.ts` row says the
`server.ts` argument against re-ranking on stability "BOUNDS the design" and that a later reader
"must not 'restore' the old behaviour as a regression fix". That argument is now gone from the code.

Phrases confirmed absent from the whole new request path: "two ranking passes", "second ranking
pass", "relay-abandoned", "never invents", "loopback is not authorization", "byte-exact",
"fail-clean".

**Status:** partly repaired. See "Owner decisions and residue" below.

## Verified sound

- All 104 original top-level functions survive.
- `completeAttemptCancelled`, `completeAttemptAbandoned`, `nextUncappedAttempt`,
  `respondAllCapped`, `runAttemptWithHedge`, `walkWouldFailOver`, `targetUsability`,
  `ServedAnnouncementContext` and `AttemptRun` all live once, in `candidate-runner.ts`, and both
  fronts import them. The "two fronts, one policy" rule holds structurally.
- `frameEnd` changed form (a manual byte loop in place of a `latin1` `indexOf`) but is
  behaviourally equivalent, and it remains a byte scan, which is the recorded invariant.
- `PROVENANCE_REACHES_HEALTH_PATH`, `CANCELLATION_REACHES_HEALTH_PATH` and
  `CANCELLATION_EVIDENCE_MS` are untouched in `circuit-breaker.ts`.

## Owner decisions and residue

- **`src/kernel/protocol-ir.ts` was a fifth defect, not a neutral design question.** The refactor
  REINTRODUCED the canonical IR that `CLAUDE.md` and `src/kernel/contracts.ts` both say was deleted
  on 2026-08-04 and must not be rebuilt. Filing it under "owner decision" alone reads as a clean
  architectural call; it was a forbidden surface re-added and walked back the same day. That framing
  correction comes from the independent closeout auditor and is the right one.

  DELETED by owner decision 2026-09-01, with its test. It was 116 lines of `Normalized*` types plus
  three type guards, imported by no `src/` file.

  It passed `test/architecture-map.test.ts` only because that test accepts a row naming the
  containing directory, and `kernel/` has one — the very row that says the canonical-IR surface was
  deleted on 2026-08-04 and must not be rebuilt. So the file satisfied the test while contradicting
  the sentence the test was pointing at.

  The four technical reasons — a rival hub beside `src/anthropic.ts`; closed where `ContentBlock`'s
  `OpaqueBlock` and `StopReason`'s `| string` are deliberately open; a `NormalizedUsage` that can
  express neither the separately-priced cache split nor unknown-as-null; and llm-bridge's universal
  IR already being this project's worst shipped defect — are recorded in `src/kernel/contracts.ts`
  beside the original history note, which is their one home.
- **15 static-analysis rules had been switched off** in `eslint.config.mjs` with generic
  justifications. Reverted by owner decision 2026-09-01; the four added stream globals
  (`TransformStream`, `WritableStream`, `ReadableStreamDefaultReader`,
  `TransformStreamDefaultController`) are genuinely needed and stay.

  ⚠ **Correction to this audit's first reading.** The revert surfaces 63 errors, and the CODE that
  produces them is PRE-EXISTING. The suppressions were reducing inherited advisory noise, not
  concealing the refactor's own findings. They were still wrong to add unlabelled — the file's
  convention is one named invariant per disabled rule — but they were not a cover-up, and this
  document should not be read as claiming they were.

  ⚠⚠ **A SECOND correction, from the independent closeout auditor.** This paragraph first said the
  errors were "in files the refactor never touched". **That phrasing is false**, and the difference
  matters. Of the 16 `src/` files carrying the 63 errors, only four are genuinely untouched
  (`circuit-breaker.ts`, `dashboard-routes.ts`, `dashboard-snapshot.ts`, `dashboard-static.ts`); the
  other twelve were modified in the sprint, and one — `candidate-runner.ts` — the refactor CREATED.

  The defensible claim is about the CODE, not the files, and it rests on three measurements:
  `candidate-runner.ts`'s single error sits on `credentialAttemptLabel`, a body moved BYTE-FOR-BYTE
  from `server.ts:2430`; the `rate-limits.ts` and `refusal-interpretation.ts` regexes carry
  identical complexity scores on unchanged lines; and the whole tree scored **155 errors at
  `ec5c16f` under that commit's own config against 63 at HEAD**, so the refactor left the codebase
  cleaner by this measure, not dirtier. "Moved code keeps its findings" is the accurate statement.
  "The refactor never touched those files" was a convenient shorthand that the evidence does not
  support, and I should not have written it.

  ⚠ One further unmentioned change stands: the file also swaps the base `no-redeclare` off for
  `@typescript-eslint/no-redeclare: 'error'`. That is kept deliberately — the TypeScript-aware rule
  is required for declaration merging, and it is set to `error`, so it is stricter than what it
  replaces, not a suppression.
- **`vitest.config.ts` gained `pool: "forks"`** with nothing recorded about why. Measured: the full
  suite passes with it and without it (148 files, 2,865 passed, 5 skipped, same duration either
  way), so it is not load-bearing for correctness. Kept by owner decision 2026-09-01, for Windows
  flake resistance, with that reasoning now recorded beside the line.
- **`opencode.json` lost 26 lines**; `knip.config.json` gained five ignored dependencies.
- **The invariant prose loss (defect 5)** is only partly repaired. Three recorded arguments that
  `CLAUDE.md` cites by name are restored at their new homes: the "two ranking passes" rejection and
  its 2026-08-30 owner amendment above `orderByUsability`, the `SERVED_BY_HEADER` contract inside
  `responseHeadersForTarget`, and the reason `markAttemptCommitted` records on the attempt itself.
  The remaining loss is not mechanically recoverable, because much of it described code that moved.

- **The eight installer-owned files** (`.agent/skills/`, `.gemini/commands/`, `.github/agents/`,
  `.github/prompts/`, `opencode.json`) are unrelated to the refactor. They drop `allow` entries and
  add none, so the change is fail-safe, but nothing records why they were regenerated.

## Result

After the repairs, `npm run check` passes on tree `25037a8a4cc3`: server 148 files, 2,865 passed,
5 skipped; dashboard 5 files, 32 passed; package `packBytes` 937,955 against a 939,900 ceiling, 389 entries.
