# Closeout — C:\Code\llm-relay

Rendered 2026-09-05T17:30:29.990Z by ~/.agent-config/render-closeout.mjs.
Verification below is rendered from commands, arguments, and the verify-green ledger.

## Identity

- Branch: `main`
- HEAD: `ae2f1d0c69cd4c5bfb182fc55bb9643e1bc47eee`
- Sprint start: `7c16bde843e9065d7ec8e556e2c976548e334849`

## Commits in the sprint range

- ae2f1d0 chore: release v0.72.1
- 0eb317c fix(mcp): read and dispatch each stdin request the moment it arrives
- c1c1b81 docs: absorb the v0.72.0 lap's uncommitted residue and file two backlog entries

## Working tree and remote

- Working tree: clean — PASS
- `origin/main` equals HEAD — PASS

## verify-green ledger

- Ledger: `npm run check` recorded 2026-09-05T17:30:20.013Z on tree `dc75927a63ee`
- `verify-green check`: verify-green: PASS — tree dc75927a63ee matches the passing run recorded 2026-09-05T17:30:20.013Z (npm run check) — PASS

## CI for exact HEAD

- Publish to npm: completed/success (run 33979837055) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/33979837055
- CI: completed/success (run 33979835509) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/33979835509

## Operator-provided narrative (not machine-derived)

Goal (from `.claude/lap-start.json`): Make `llm-relay mcp` read and dispatch each stdin request the moment it arrives (backlog top item), after committing the unclosed `7c16bde` lap's doc residue.

### What happened, in commit order

- `c1c1b81` docs: absorbed the v0.72.0 lap's uncommitted residue. That lap was tagged and published but never ran its closeout. The residue: the `claude-free-pool` → `free-pool` lane rename across `CLAUDE.md`, `HANDOFF.md`, the Muse Spark doc, `AGENTS.md` (regenerated) and one cli test argument, plus the backlog entry this lap then closed, plus a new Open entry for the eligibility-queue triage (owner decision 2026-09-05: a separate lap). No source change.
- `0eb317c` fix(mcp): `McpDispatchServer.serve(source)` replaces the per-chunk `await server.ingest(chunk)` in `runMcp`; `ingest` is no longer `async` (synchronous split; it resolves when the chunk's handlers settle). Five pinning tests in `test/mcp-server.test.ts` (`describe("stdio serve loop")`); `docs/history/mcp-concurrent-ingest-2026-09-05.md`; `CLAUDE.md` rows for `cli.ts` and `mcp/server.ts`; the backlog entry moved to Closed; HANDOFF §0 rewritten for v0.72.1 with v0.72.0 condensed into §0.1.
- `ae2f1d0` chore: release v0.72.1 (`npm version patch`; tag `v0.72.1`).

### Evidence

- Suite: `test/mcp-server.test.ts` 81 tests pass (76 before the lap plus 5 new); both typechecks clean; the full gate `npm run check` recorded green through verify-green on the tagged tree.
- Mutation check: with `await pending;` re-added inside `serve`'s loop (the old serial behaviour), exactly the two concurrency tests failed (2 failed, 79 passed); the source was restored (0 `MUTATION` lines remain).
- Live measurement (`docs/history/mcp-concurrent-ingest-2026-09-05.md` §4): one isolated daemon on `127.0.0.1:8792` (`USERPROFILE` pointed at a scratch home holding a config copy with `listen` rewritten and `routing.laneProbe` off), one child per binary, every request in its own stdin write, `mode: "answer"`, `lane: "free-pool"`. Old v0.72.0 child: the status probe was answered after 6621 ms (only once dispatch #1 returned at 7032 ms), and dispatch #3 waited behind dispatch #2 (117574 ms from its own write). New child: the status probe answered in under 1 ms while dispatch #1 ran for 68010 ms; dispatch #3 finished 12031 ms after its own write while dispatch #2 ran for 63158 ms. No traffic reached the real daemon on 8791; the real `dispatch-lane-stats.json` and `usage/recent.json` kept their pre-run mtimes.
- Release: publish run https://github.com/OhOkThisIsFine/llm-relay/actions/runs/33979837055 (success) and CI run https://github.com/OhOkThisIsFine/llm-relay/actions/runs/33979835509 (success), both on `ae2f1d0`. Registry: `dist-tags.latest` 0.72.1, published 2026-09-05T17:13:28Z. Global bin reinstalled: `llm-relay --version` prints 0.72.1. The CI run for `0eb317c` (33979819805) was cancelled by the bump push's concurrency rule; `ae2f1d0` contains it.

### Deliberate intermediate state (not bugs)

- A host keeps the OLD serial behaviour until it restarts its `llm-relay mcp` child. Running Claude Code sessions, this one included, still hold a v0.72.0 child.
- No concurrency cap: N parallel `dispatch` calls start N lanes.
- On stdin EOF `runMcp` exits at once through the pre-existing `end`/`close` handlers, so `serve`'s drain never completes in production; it matters for embedders and tests.
- Responses may leave out of request order (JSON-RPC permits it; ids correlate).

### What remains, each with its home

- Nothing is pending from this lap's request.
- Open work → `docs/backlog.md` Open: the eligibility-queue triage lap (new), the post-commit stall measurement, the Codex `relay` verification (owner, deferred), the 63 eslint errors, the `publish.yml` timeout, five audit residues, contributor SKUs route B.
- Machine-wide → `C:\Code\docs\backlog.md` Open items: the P52 owner decision is recorded (form B, the staging-scope refusal; commit `3b72a05` there, no remote); the work is not yet scheduled.
- Persistent memory → `~/.claude/projects/C--Code-llm-relay/memory/mcp-dispatch-server.md` (v0.72.1 paragraph: the stale-child trap and the isolated-daemon proof recipe) and its `MEMORY.md` index line.
- Owner action, not a decision: restart Claude Code sessions (or reconnect the `llm-relay` MCP server) to pick up v0.72.1.

### Owner-only decisions

- None are live at closeout. The three asked at lap start were answered: P52 takes form B; the Codex relay verification stays deferred; the eligibility triage is a separate lap.

### Friction, rewalked from the transcript

1. `/start-lap` step 1 says "Write lap-start.json"; under bypass mode's Bash-first instruction the natural heredoc write was refused by `shell-conventions-guard.mjs` (a correct refusal with a correct remedy). Fixed at the source: the skill now names the Write tool. Home: `~/.claude/skills/start-lap/SKILL.md` (machine-wide; skills auto-mirror).
2. The Edit tool did not match a 100-character anchor at the end of the P52 paragraph in `C:\Code\docs\backlog.md`, then matched a 31-character suffix of the same text; the cause was not found. One retry. No home: not reproduced, noted here only.
3. The previous lap's ledger was stale at lap start (its last doc edits came after its record) and its closeout never ran; this lap absorbed the residue as `c1c1b81`. Home: HANDOFF §0 states it; the P52 refusal (form B) covers the commit-absorption half machine-wide.
4. Job ids are monotonic per PROCESS (`jobCounter` is module-global in `lane-runner.ts`), so a test cannot address `job-0001` inside a shared vitest process; the pinning test learns the next id from a warm-up dispatch. Home: the test's own comment, and the memory note.
5. An isolated daemon needs `routing.laneProbe` switched off in its config copy, or its cadence may spawn real lane commands; `USERPROFILE`, not `HOME`, is the home override Node honours on Windows. Home: `docs/history/mcp-concurrent-ingest-2026-09-05.md` §4, and the memory note.

### Independent audit (sonnet lane, read-only, given only the repo path, the start commit and the first render of this closeout)

- SUBSTANTIATED against primary sources: the three commits and their subjects; exactly five new `it(` blocks inside `describe("stdio serve loop")` (76 → 81 in `test/mcp-server.test.ts`, all in `0eb317c`); the `serve` method and the non-async `ingest` in `src/mcp/server.ts`; `runMcp` calling `server.serve(process.stdin)`; a live run of the test file, 81 of 81; publish run 33979837055 and CI run 33979835509 both `success` on `ae2f1d0`; CI run 33979819805 for `0eb317c` `cancelled` by `ci.yml`'s `cancel-in-progress` concurrency group; `ae2f1d0^` = `0eb317c`; tag `v0.72.1` on `ae2f1d0`; registry `dist-tags.latest` 0.72.1 published 2026-09-05T17:13:28.101Z; `c1c1b81` touching no `src/` file; the ledger citation matching `git rev-parse HEAD^{tree}` for `ae2f1d0`; the backlog, HANDOFF, memory and skill edits named above; machine-wide commit `3b72a05` with no remote.
- UNVERIFIABLE by the auditor (not re-run by instruction): the mutation-check counts, the live-measurement timings (scratch-home daemon, run-to-run pool variance), and the real-state mtime claim.
- CONTRADICTED, one item: the first render's "Working tree: clean — PASS" and "verify-green check PASS" lines were true in the instant before the renderer saved its own output file, then false — the closeout doc itself sat untracked, and `verify-green check` reported `A docs/history/concurrent-ingest-lap-2026-09-05.md`. Root cause: `render-closeout.mjs` checks git status and the ledger before writing its output. Resolution: the interim render was deleted, the ledger was re-recorded on the doc-less tree (`ae2f1d0`'s exact content), this render was produced on that clean tree, and it is committed as the lap's final docs-only commit; the ledger is then re-recorded on the committed tree and its `check` must pass before the closeout checklist claims green. This render therefore certifies `ae2f1d0` (v0.72.1); the commit that carries it is verified by its own CI run and by that later ledger record, both named in the hand-back.

## Verdict

- All machine-derived sections PASS.
