# Closeout — C:/Code/llm-relay

Rendered 2026-09-04T20:54:23.694Z by ~/.agent-config/render-closeout.mjs.
Verification below is rendered from commands, arguments, and the verify-green ledger.

## Identity

- Branch: `main`
- HEAD: `ba4692dfe71ecd5105b21f36c957c451042956ac`
- Sprint start: `8973500`

## Commits in the sprint range

- ba4692d docs: closeout for the audit-triage lap (v0.71.1)
- 029484d docs: the lap shipped as v0.71.1; the doc-links hermeticity gap and the shared-checkout rewrite get their homes
- 659ef6b chore: release v0.71.1
- a137d04 docs: Muse Spark 1.3 on OpenCode Zen — Responses-only SKU the relay cannot serve yet; CLI rung recipe; pools carry paid SKUs behind free with freeOnly off; CLAUDE.md dynamic-pools row corrected
- 23a53c4 chore: release v0.71.0
- 76e11e4 docs: audit-triage lap; verdicts for all 35 findings, CLAUDE.md rows for every change, backlog and handoff
- 8710277 feat(hedge): the race settles at commit, so a stream that opens and then goes silent is hedged (DR-002); the ledger never blames the provider for a relay-authored refusal (contract DR-003)
- b64709a refactor: remove the DR-020 type residue and the never-adopted JsonStore class (DR-011)
- c7246db chore(analysis): the run summary prints exit codes as exit codes, and a .json report only when it parses (DR-018)
- 4ac047b fix: the data plane classifies 413 by the body reader's code, never by its message (contract DR-005)
- d042570 fix(models): GET /v1/models omits an unresolved context window and resolves auto through the ladder (contract DR-004)
- 2212356 refactor: one declaration per exported name; the config vocabulary lives in config-types.ts (DR-001)

## Working tree and remote

- Working tree: clean — PASS
- `origin/main` equals HEAD — PASS

## verify-green ledger

- Ledger: `npm run check` recorded 2026-09-04T20:50:52.766Z on tree `833f111c0b5b`
- `verify-green check`: verify-green: PASS — tree 833f111c0b5b matches the passing run recorded 2026-09-04T20:50:52.766Z (npm run check) — PASS

## CI for exact HEAD

- CI: completed/success (run 33918210578) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/33918210578

## Operator-provided narrative (not machine-derived)

Lap: audit triage (2026-09-04). Goal, as recorded at lap start: "Triage the 2026-09-03 audit findings
against HEAD; remediate or explicitly accept the verified items." Start commit 8973500. Owner
approved the plan as stated.

What shipped, v0.71.1 (v0.71.0 was tagged first; its publish run failed on `test/doc-links.test.ts`
because the backlog rewrite had committed four entries a concurrent session in the same checkout
had added uncommitted, one of them linking a document that session committed later as `a137d04`;
v0.71.1 is the fix-forward on the tree holding both):

- Every one of the 35 audit findings has a verdict in `docs/history/audit-triage-2026-09-04.md`.
- FIXED with pinning tests: DR-001/contract DR-001 (config vocabulary has one declaration;
  `test/config-vocabulary.test.ts`), DR-004/contract DR-008 (general guard
  `test/one-declaration.test.ts`, which found and closed three more duplicate pairs), contract
  DR-003 (`RELAY_AUTHORED_PROVENANCE`; `test/accounting-failure-kind.test.ts`), contract DR-004
  (`GET /v1/models` omits an unresolved context window, `auto` resolves through the ladder;
  `test/models-endpoint.test.ts`; Codex v0.153.2 measured tolerating the omission), contract DR-005
  (`bodyReadStatus`; `test/stream-pipeline.test.ts`), DR-014, DR-018, the DR-020 residue, DR-011's
  `JsonStore`.
- BUILT: DR-002 — the hedge race settles at COMMIT (`withCommitProbe`/`attemptWon`, both fronts),
  after the owner said the hedge exists for wedged requests. Mutation-checked: wrapper disabled
  ⇒ 4 red, probe ignored ⇒ 2 red. The first test version stayed green under the mutant because
  `fetchBackend`'s preflight already covers "headers then nothing"; the real gap is "headers plus
  a metadata event, then silence".
- Recorded decisions / opinions / open items: the rest, each with its evidence and home.

Owner decisions taken this lap: lap plan as stated; groq TPM 429 accepted (`rate-limited`/
`attempt`, both unit spellings); ESLint 63 → switch off per file with the invariant named, outside
this lap; hedge → race-to-commit built, post-commit remedy pending.

Deliberate intermediate states, so they are not read as bugs: the per-token hedge rung
(`hedge-trigger.ts`) stays in the module with no production consumer that can hand it output
tokens; `shouldHedge`/`hedgeLabel`/`hedgeDelayMs` remain exported and unwired (part of the
export-pruning backlog entry); the two routes keep an inline commit-probe fallback for a response
that did not come through `withCommitProbe`.

Verification at render time: the verify-green ledger records `npm run check` PASSING on the tree
of the commit before this closeout document was added; CI (`ci.yml`) is green for the release
commit 659ef6b and for a137d04; the publish run 33916818131 succeeded; the registry serves 0.71.1;
the daemon runs 0.71.1 (pid 29232).

Friction met in this lap, with homes:
- Three `relay` subagents lost their MCP dispatch jobs when the session hit its usage limit
  (job ids reset, "Request timed out" then "Connection closed") — machine backlog standing trap;
  direct `dispatch` with `waitMs: 5000` and polling from the main session ran the same three
  sweeps to completion (7–21 min each).
- Two sessions in one checkout: my backlog rewrite committed the other session's uncommitted
  entries — machine backlog standing trap; `test/doc-links.test.ts` resolves against untracked
  files — repo backlog entry.
- The global PostToolUse typecheck hook judges each edit alone, so a batch of related edits shows
  transient red diagnostics until the last edit lands — noise only, no action taken.
- The mutation check of the wrapper stayed green on the first fixture — a green mutant is a
  finding about the test, recorded in project memory.
- The three lane sweeps returned confident "still-present-defect" verdicts for DR-007 and DR-022
  that source contradicted (the `slow` band; answer mode's live HTTP) — lane output is advisory,
  and both were rejected on the source check.

Remaining, each with its home (also in the hand-back): two owner decisions (post-commit stall
remedy; terms review for hedging) — `docs/backlog.md` Open; DR-006, DR-009, contract DR-006,
DR-012/contract DR-007, DR-024 docs, the doc-links hermeticity gap, the ESLint execution, the
`publish.yml` timeout, the Codex Desktop `relay` check, the path-sensitive keyring test —
`docs/backlog.md` Open.

## Verdict

- All machine-derived sections PASS.
