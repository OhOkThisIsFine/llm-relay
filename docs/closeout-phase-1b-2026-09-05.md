# Closeout — C:\Code\llm-relay

Rendered 2026-09-06T05:32:04.561Z by ~/.agent-config/render-closeout.mjs.
Verification below is rendered from commands, arguments, and the verify-green ledger.

## Identity

- Branch: `main`
- HEAD: `358cd776a4646be6d613aa846861eccdfb3e47c7`
- Sprint start: `eb862c2bcd065dba29fb56124c1444f9823e57cd`

## Commits in the sprint range

- 358cd77 docs: resolve the closeout auditor's flags, and make one of them true instead of weaker
- 04f2be3 docs: closeout for the Phase 1b duplication lap (v0.72.3)
- 368467d docs: name the release the Phase 1b lap shipped as
- 3a0d228 chore: release v0.72.3
- e342f52 docs: route the Phase 1b results to their homes
- 8f6e9d4 chore(eslint): 82 errors to 0 — dead code deleted, intentional code labelled
- a4f9e2b refactor(keystore): one prologue for both new-entry mutations (CLONE-12)
- c04a56a refactor(backend): envelope validation and stream preflight get their own modules (HOTSPOT-10)
- 6b1c099 refactor(sse): one read loop and one error tail for both stream transforms (P1-04, CLONE-20)
- f9006e7 fix(dialects): a DeepSeek payload that is not an object commits nothing (CLONE-26)

## Working tree and remote

- Working tree: clean — PASS
- `origin/main` equals HEAD — PASS

## verify-green ledger

- Ledger: `npm run check` recorded 2026-09-06T05:28:36.241Z on tree `a5abb9df65fb`
- `verify-green check`: verify-green: PASS — tree a5abb9df65fb matches the passing run recorded 2026-09-06T05:28:36.241Z (npm run check) — PASS

## CI for exact HEAD

- CI: completed/success (run 34014092267) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/34014092267

## Operator-provided narrative (not machine-derived)

# Phase 1b duplication lap — shipped as v0.72.3

## What the lap was asked to do

Advance the tracked Phase 1b work, and offload every delegatable task through llm-relay, preferring
the free `opencode-muse-spark` lane at its highest reasoning variant. The owner amended that at the
start: other agents were dispatching to Muse Spark concurrently, so any free target was acceptable.

## Delivered — five of Phase 1b's seven items

| Commit | Item | Pinning test | Mutation check |
|---|---|---|---|
| `f9006e7` | **CLONE-26** — a DeepSeek payload that is not a JSON object commits nothing | yes | yes |
| `6b1c099` | **P1-04** — one `createSseTransformStream` for both stream transforms | yes | yes |
| `c04a56a` | **HOTSPOT-10** — envelope validation and stream preflight get their own modules | yes, 31-row table | yes |
| `a4f9e2b` | **CLONE-12** — one prologue for both new-entry keystore mutations | yes | yes |
| `8f6e9d4` | **eslint fold-in** — 82 errors to 0 | **no, and correctly** | **no** |
| `e342f52` | Results routed to the backlog, HANDOFF, and `docs/phase-1b-recon-2026-09-05.md` — a new 220-line dated record, itself a deliverable of this lap | — | — |

⚠ **The eslint fold-in carries neither, and that is right, not an omission.** It is a lint-config
change plus the deletion of genuinely dead code; `npm run check` plus a before/after error count is
its whole verification. An earlier draft of this closeout claimed "each with a pinning test and a
mutation check" for all five — the closeout auditor flagged that as an overstatement, and it was.

Every CODE item was mutation-checked, and every mutation was killed by the intended test and only
by it:

- P1-04, removing the error frame: 2 tests fail. Removing the held-text release: 1 test fails, and
  only the think-tags one — correct, because the tool-use-ids transform holds nothing.
- CLONE-12, reordering the prologue: the test fails with `KeystoreUnlockError` where it expects
  `KeystoreEntryExistsError` — exactly the failure the order exists to prevent.
- CLONE-26, restoring the lenient branch: the five new cases fail, the negative control stays green.
- HOTSPOT-10, accepting a missing `choices` array: 1 row fails. Accepting an unknown Anthropic event
  type: 1 row fails. (Added after the auditor observed the commit claimed no mutation check — the
  claim was made true rather than weakened.)

## Not done, and named rather than left implied

- **CLONE-07 is completely unaddressed.** It was the other half of the seventh backlog item, and
  the `malformedProvenance` predicate is still spelled twice. No decision is outstanding — the
  evidence document proves by truth table that the two spellings are one rule — so this is ordinary
  refactor work, now filed on its own.
- **HOTSPOT-03 and P1-06 were not built**, for the reasons below.
- The eslint inventory corrected a stale backlog figure along the way: **42** distinct
  (file, rule) pairs, not 41.

## The offload result, which is the most reusable thing this lap produced

All seven reconnaissance packets were dispatched to free llm-relay lanes. **All seven failed both
adversarial verification lenses — 14 verdicts, 14 times `packetSound: false`.** The P1-04 packet
invented two symbol names that exist nowhere in the tree, invented line ranges for them, invented an
`sse.ts` API, and argued against the real plan on the strength of the invention. The P1-06 packet
returned an empty step list and blamed a total tool-access failure; the verifying lens read all six
files with ordinary `cat` from the same directory.

⚠ **The `null` fallback never fired and could not.** The pipeline was built to fall back to a paid
model when a lane returns nothing. Every lane returned something — plausible, structured and wrong.
A fallback keyed on absence does not catch a confident fabrication. Only verification did.

The lanes were healthy throughout: `free-pool` served on
`kilo/nvidia/nemotron-3-ultra-550b-a55b:free` in 3 s and 44 s. The answers were the problem, not the
capacity.

## Three findings that came from verifying rather than from writing

1. **Three duplicated tails in a row had NO coverage.** P1-04's shared `event: error` tail,
   CLONE-12's prologue order, and (in Phase 1a) the accounting envelope tail. A duplicated block
   survives duplication precisely because nothing tests it, so a duplication sweep is also a
   coverage audit.
2. **The backlog named the wrong code for CLONE-12.** Its paragraph described the
   `revokeEntry` / `setDisabled` prologue; the catalog's CLONE-12 is
   `addEntry` / `restoreEntryFromExport`. The real one was worth extracting; the described one is
   now recorded as benign.
3. **P1-06's premise does not survive reading its six sites.** Four genuinely different clamps plus
   three uses of `??` is not one rule, and `failureCooldown`'s floor changes the reported RUNG
   rather than the value. Nothing was built; it is an owner decision with a site-by-site table.

## Deliberate intermediate states, named so they are not read later as bugs

- **HOTSPOT-03 is scoped and NOT started.** Its closure is 17 symbols, not 11, and three primitives
  must relocate to a leaf first or the new module cycles back into `config.ts`. Starting without
  finishing would leave the tree worse than not starting.
- **P1-06 is deliberately unbuilt**, pending the owner's ruling on the recommendation to decline.
- **The package baseline moved deliberately.** HOTSPOT-10 adds exactly six `dist/` entries;
  `packageEntries` 392 → 398 and `packBytes` to 959904 both crossed their ceilings, so both were
  raised to observed + ~0.5%, the file's existing convention. `unpackedBytes` still fits and was
  left alone rather than loosened.
- **One deviation from a committed plan, stated in the commit, in `HANDOFF.md` and now in
  `CLAUDE.md`'s `sse-frames.ts` row:** P1-04's scaffold lives in `src/sse-frames.ts`, not
  `src/sse.ts`. The plan's reason for `sse.ts` was that it already owns shared SSE vocabulary
  through `iterateDataPayloads`; that generator is private to `sse.ts`. (An earlier draft claimed
  the deviation was already in `CLAUDE.md` when only the source comment carried it. The auditor
  caught that; the architecture row now records the new export and the deviation together, which is
  where the map should have carried it anyway.)

- ⚠ **CLONE-26 shipped a live wire-visible consequence its ruling did not name, and it is now
  documented rather than left pending.** A DeepSeek block with a scalar or array payload whose name
  is in `repair.destructiveTools` used to reach the destructive filter and yield
  `refused-destructive`; it is now discarded before the filter sees it and yields `detected`, with a
  pool reroll and a breaker charge. The docs must describe what the code does, so `CLAUDE.md`'s
  dialect gotcha now records it; whether to KEEP it is the open owner decision.

## Friction hit during the lap

Rewalked from the transcript, not from memory.

1. **`opencode-muse-spark` at `--variant xhigh` ran 683 s on a one-file line count and never
   answered.** Cancelled. Owner-explained as concurrent contention from other agents. Its recorded
   history is healthy (49 calls, 47 ok, median 111.5 s), so this is congestion, not a defect — but
   the ladder recommends it regardless, which is the open `cli`-lane health item.
2. **`posttooluse-typecheck.mjs` blocked four two-step edits at their midpoint** — an import added in
   one edit and its use in the next. Already filed machine-wide (`C:\Code\docs\backlog.md`,
   2026-09-05). Hit again here; no new information, so nothing new to file.
3. **`shell-conventions-guard.mjs` blocked appending source through a heredoc**, twice. The verdict
   is correct and the remedy printed is usable. Noted only because it makes "append a block to a
   file" a Write/Edit operation rather than a shell one, which is worth knowing in advance.
4. **`check:package` measures whatever `dist/` holds.** A gate run right after source edits passed
   with stale `dist/`, and the real ceiling breach only appeared after a rebuild. `CLAUDE.md`
   already records this; it cost one wasted gate run here.
5. **A `$TEMP` path inside a single-quoted `node -e` script lost its backslashes** and wrote to a
   mangled relative path. Windows-specific; the fix is to avoid interpolating Windows paths into
   inline scripts.
6. **The closeout renderer is circular by construction.** It runs `verify-green check`, so writing
   the closeout file makes the tree dirty and the render reports itself as two FAIL sections. The
   resolution is to commit the render and re-record, which is what happened; the sections are not
   evidence of an ungreen tree. Worth knowing before reading a first render as a failure.

## What the closeout auditor found, and what changed because of it

The independent auditor (sonnet, given only the repo path, the start commit and the closeout text)
verified the load-bearing claims by REVERTING each fix and re-running the named test, and by
counting eslint errors at the pre-lap commit itself. It substantiated the release, CI on both HEADs,
the 82→0 count, all four mutation-check claims it could test, the CLONE-12 misidentification, the
CLAUDE.md rows for the new modules, and the +6 `dist/` entry delta.

It flagged four claims and four omissions. Every one is resolved above rather than argued with:

- "each with a pinning test and a mutation check" overreached — the table now states the truth per
  item, and HOTSPOT-10's missing mutation check was performed rather than the claim weakened.
- The P1-04 deviation was in `HANDOFF.md`, not `CLAUDE.md` as claimed — now in both.
- HOTSPOT-10's case count was stated three different ways — the real figures are recorded.
- The 14-verdict offload narrative has no in-tree primary evidence — the recon doc now says exactly
  where the journal lives and that it is session-local.
- CLONE-07, the recon doc as a deliverable, the 42-not-41 correction, and CLONE-26's shipped
  destructive consequence were all unnamed — each is now named, and the last is in `CLAUDE.md`.
- The pre-lap package baseline did not reproduce (389 against a measured 392). Pre-existing metric
  drift, not this lap's doing; recorded in the recon document with the reason it cannot be caught.

## Verdict

- All machine-derived sections PASS.
