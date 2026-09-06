# Closeout — C:\Code\llm-relay

Rendered 2026-09-06T05:09:11.278Z by ~/.agent-config/render-closeout.mjs.
Verification below is rendered from commands, arguments, and the verify-green ledger.

## Identity

- Branch: `main`
- HEAD: `368467d82fb1939284dbf73e761517565f7e37b1`
- Sprint start: `eb862c2bcd065dba29fb56124c1444f9823e57cd`

## Commits in the sprint range

- 368467d docs: name the release the Phase 1b lap shipped as
- 3a0d228 chore: release v0.72.3
- e342f52 docs: route the Phase 1b results to their homes
- 8f6e9d4 chore(eslint): 82 errors to 0 — dead code deleted, intentional code labelled
- a4f9e2b refactor(keystore): one prologue for both new-entry mutations (CLONE-12)
- c04a56a refactor(backend): envelope validation and stream preflight get their own modules (HOTSPOT-10)
- 6b1c099 refactor(sse): one read loop and one error tail for both stream transforms (P1-04, CLONE-20)
- f9006e7 fix(dialects): a DeepSeek payload that is not an object commits nothing (CLONE-26)

## Working tree and remote

- Working tree: NOT clean — FAIL
```
?? docs/closeout-phase-1b-2026-09-05.md
```
- `origin/main` equals HEAD — PASS

## verify-green ledger

- Ledger: `npm run check` recorded 2026-09-06T05:05:21.118Z on tree `6e97faceb231`
- `verify-green check` FAILED: verify-green: FAIL
content changed AFTER the recorded passing run (2026-09-06T05:05:21.118Z).
Files changed since that run:
A	docs/closeout-phase-1b-2026-09-05.md
Re-run the suite through `record` before claiming green. — FAIL

## CI for exact HEAD

- CI: completed/success (run 34013112291) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/34013112291

## Operator-provided narrative (not machine-derived)

# Phase 1b duplication lap — shipped as v0.72.3

## What the lap was asked to do

Advance the tracked Phase 1b work, and offload every delegatable task through llm-relay, preferring
the free `opencode-muse-spark` lane at its highest reasoning variant. The owner amended that at the
start: other agents were dispatching to Muse Spark concurrently, so any free target was acceptable.

## Delivered — five of Phase 1b's seven items, each with a pinning test and a mutation check

| Commit | Item |
|---|---|
| `f9006e7` | **CLONE-26** — a DeepSeek payload that is not a JSON object commits nothing |
| `6b1c099` | **P1-04** — one `createSseTransformStream` for both stream transforms |
| `c04a56a` | **HOTSPOT-10** — envelope validation and stream preflight get their own modules |
| `a4f9e2b` | **CLONE-12** — one prologue for both new-entry keystore mutations |
| `8f6e9d4` | **eslint fold-in** — 82 errors to 0 |
| `e342f52` | Results routed to the backlog, HANDOFF and a dated recon record |

Every extraction was mutation-checked, and every mutation was killed by the intended test:

- P1-04, removing the error frame: 2 tests fail. Removing the held-text release: 1 test fails, and
  only the think-tags one — correct, because the tool-use-ids transform holds nothing.
- CLONE-12, reordering the prologue: the test fails with `KeystoreUnlockError` where it expects
  `KeystoreEntryExistsError` — exactly the failure the order exists to prevent.
- CLONE-26, restoring the lenient branch: the five new cases fail, the negative control stays green.

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
- **One deviation from a committed plan, stated in the commit and in `CLAUDE.md`:** P1-04's scaffold
  lives in `src/sse-frames.ts`, not `src/sse.ts`. The plan's reason for `sse.ts` was that it already
  owns shared SSE vocabulary through `iterateDataPayloads`; that generator is private to `sse.ts`.

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

## Verdict

- 2 section(s) FAIL: working tree, verify-green check.
