# Refactor consistency audit — 2026-09-01

Scope: the 98 uncommitted paths present at lap start (`ec5c16f`). Another model decomposed
`src/server.ts` (−5,664 lines) into `routes/messages.ts`, `routes/openai-front.ts`,
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

`server.ts` carried 1,350 comment lines. The successor files carry 83 — a 94 percent loss.
`src/server.ts` itself now has none.

This is not cosmetic in this repository. `CLAUDE.md` cites `server.ts` as the *home* of recorded
arguments and instructs later readers to obey them. The `latency-demotion.ts` row says the
`server.ts` argument against re-ranking on stability "BOUNDS the design" and that a later reader
"must not 'restore' the old behaviour as a regression fix". That argument is now gone from the code.

Phrases confirmed absent from the whole new request path: "two ranking passes", "second ranking
pass", "relay-abandoned", "never invents", "loopback is not authorization", "byte-exact",
"fail-clean".

**Status:** open. See "Remaining" below.

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

## Remaining, not yet actioned

- **`src/kernel/protocol-ir.ts` is unadopted.** No `src/` file imports it; only its own test does.
  `CLAUDE.md` records that a canonical-IR contract surface was deleted on 2026-08-04 with "do not
  rebuild it". It also has no architecture-map row.
- **15 static-analysis rules were switched off** in `eslint.config.mjs` with generic justifications.
  The repo convention names the invariant beside each disabled rule.
- **`vitest.config.ts` gained `pool: "forks"`** with nothing recorded about why. Measured: the full
  suite passes with it and without it (148 files, 2,865 passed, 5 skipped, same duration either
  way), so it is not load-bearing for correctness. It may still have been added for Windows flake
  resistance. The line is left in place pending an owner decision, because silently changing the
  gate's isolation in either direction is the failure this audit exists to catch.
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
5 skipped; dashboard 5 files, 32 passed; package `packBytes` 936,693 against a 938,600 ceiling.
