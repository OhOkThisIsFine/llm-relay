# Closeout — C:\Code\llm-relay

Rendered 2026-09-04T08:48:18.805Z by ~/.agent-config/render-closeout.mjs.
Verification below is rendered from commands, arguments, and the verify-green ledger.

## Identity

- Branch: `main`
- HEAD: `5f8078bbdf4ce7bea55c707130b9cc90d8ffa18b`
- Sprint start: `e7765340cf6110d2d1bd2c8c5083a894fcba5a16`

## Commits in the sprint range

- 5f8078b chore: release v0.69.1
- fcaa463 docs: relay agent type verified end to end; v0.69.1 carries the template fixes
- d9fd32a fix(setup): the relay agent needs ToolSearch to reach the deferred dispatch tools
- 77e9f67 test: the setup-claude guard checks the real relay.md is unchanged, not absent
- b8a90ae fix(setup): the relay agent must dispatch every task, never answer itself
- 07053e5 chore: regenerate AGENTS.md from CLAUDE.md (sync.mjs)
- 0ba68a8 docs: record the v0.69.0 dispatch lap
- eb88c02 chore: release v0.69.0
- 5e5d8f1 test: make the ping cadence test and the dispatch depth test hermetic
- cadefcc feat(mcp): answer mode, content-empty failure, timed-out results, resolved cwd containment
- 22cf7fa refactor(cli): derive VALUE_FLAGS from the one alias table
- 751fb52 refactor(accounting): replace the write-ahead journal engine with the shared atomic writer (DR-020)
- b93501d fix(cli): the option guard accepts the short aliases the parser and help already declare
- 96d7ef8 fix: credential-scoped eviction facts reach pool admission and the free-only guard per slot
- 156f4c3 fix(setup): a refused foreign relay.md is a warning, not a setup failure
- cecb3e1 feat(setup): install a relay agent type so Claude Workflow and Agent calls can use llm-relay lanes
- 12a2ed7 docs: refusal-queue research for the four highest-count unrecognized refusals
- 7e889c9 feat: auto model resolves to the ladder's first ready free pool rung
- bbe1d20 fix: latency-demoted members form a slow band above the failure bands
- 5c6c60f docs: commit audit run 2 findings (35 present of 41 claimed)

## Working tree and remote

- Working tree: clean — PASS
- `origin/main` equals HEAD — PASS

## verify-green ledger

- Ledger: `npm run check` recorded 2026-09-04T08:47:30.372Z on tree `c4ee10623755`
- `verify-green check`: verify-green: PASS — tree c4ee10623755 matches the passing run recorded 2026-09-04T08:47:30.372Z (npm run check) — PASS

## CI for exact HEAD

- Publish to npm: completed/success (run 33854092767) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/33854092767
- CI: completed/success (run 33854090920) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/33854090920

## Operator-provided narrative (not machine-derived)

## Goal

Make llm-relay dispatch fast, easy and working: fix the pool walk order, add a direct answer path
plus an `auto` model so callers never name a model, wire a `relay` agent type for Claude Workflow
calls, shrink the accounting store writer (DR-020). The orchestrator delegated every write and judged
the results.

## What shipped (v0.69.0 and v0.69.1, both 2026-09-04)

- `slow` usability band: a latency-demoted member is walked before credential-faulted and cooling
  members (it answers; they do not). `bbe1d20`.
- `auto` model on both fronts, resolved through the dispatch ladder; `x-llm-relay-tier` selects the
  tier, `x-llm-relay-auto` announces; `auto` is a reserved provider name. `7e889c9`.
- MCP `dispatch` `mode: "answer"` (+ `system`, `schema`, `maxTokens`): a relay-kind lane is served
  by one POST to the relay, no `claude -p` harness. `empty-output` and `timed_out` are real failures;
  `checkCwd` resolves `..`. `cadefcc`.
- `relay` custom agent type installed by `llm-relay setup claude-cli|claude-desktop`, so a Workflow
  script writes `agent(task, {agentType: "relay"})`. `cecb3e1`, `156f4c3`, `b8a90ae`, `d9fd32a`.
- Credential-scoped eviction facts reach pool admission and the free-only guard per slot. `96d7ef8`.
- CLI short aliases (`-t`, `-x`, `-p`, `-r`) accepted by the option guard; `VALUE_FLAGS` derived from
  the one alias table. `b93501d`, `22cf7fa`.
- DR-020: the 1,247-line write-ahead journal engine replaced by the shared atomic writer. `751fb52`.
- Two flaky tests made hermetic; the setup-claude guard no longer asserts the developer's home.
  `5e5d8f1`, `77e9f67`.
- Docs: audit run 2 findings committed (35 of 41 claimed present), refusal-queue research, HANDOFF
  and backlog rewritten. `5c6c60f`, `12a2ed7`, `0ba68a8`, `fcaa463`.

## Measurements (one-line prompt, pool/medium, this machine)

| Path | Before (v0.68.8) | After (v0.69.x, floorMs 8000) |
|---|---|---|
| Direct HTTP | 5.7 / 8.5 / 10.8 / 6.6 s, 6-9 dead members walked | 4.0 / 10.2 / 3.0 s (17.3 s first after restart), 1-3 walked |
| MCP dispatch, free pool | 22 s (harness) | 10.5 / 13.5 s (answer mode) |
| `auto` on /v1/messages, /v1/chat/completions | not available | 1.4 s, 9.3 s |
| Workflow, 3 relay agents | not available | 3/3 answers with provenance, 60 s wall (agent mode) |

The harness was never the cost: 0.06-0.26 s beyond API time plus about 2 s process start. The cost
was the walk order (latency-demoted members sorted last, behind every failing member) and the 20 s
hedge floor (the slow primary answered in 9-38 s; the hedge member answered about 1 s after it
started). `routing.hedge.floorMs` is set to 8000 in the operator config by measurement.

## Owner decisions taken this lap

- DR-020: shrink to the shared atomic writer (done).
- audit-tools items are out of scope for llm-relay laps; the one answer given ("doc fixes now,
  schedule the three engineering items separately") had no tickable home in the audit-tools inbox
  and is recorded only in this closeout and the hand-back.
- Refusal queue: research the four highest-count items; one proposed (`rate-limited`/`attempt` for
  the groq TPM 429), three no verdict.
- The sweep must never name a model: hence `auto`.

## Residuals (homes named)

- Relay agent on `model: haiku` answers trivial pure-text tasks itself; realistic tasks dispatch.
  docs/BACKLOG.md (open) and HANDOFF immediate next (owner call: haiku vs sonnet default).
- publish.yml `timeout-minutes: 15` is marginal under registry slowness. docs/BACKLOG.md.
- Every hedge reports basis `floor`; calibrate from data. docs/BACKLOG.md.
- Four verified audit findings unremediated (DR-001, DR-002, contract DR-003, contract DR-004).
  docs/BACKLOG.md.
- `SnapshotMutationResult` dead members and `ioHooks` residue after DR-020. docs/BACKLOG.md.
- Groq TPM interpretation awaits `llm-relay eligibility accept 2 --sig a568e0cbe2 --class
  rate-limited --scope attempt`. Hand-back.

## Friction (routed)

Machine-wide (C:\Code\docs\backlog.md): `/start-lap` step 5 pulled another repo's nightly queue;
Anthropic monthly spend limit killed four Sonnet subagents at once; `npm --prefix <dir> exec` runs in
the caller's directory; the PowerShell tool blocks `cmd /c`; inline `\\$var` Windows paths do not
expand for `cmd`; remove a node_modules junction before `git worktree remove`; the shell guard blocks
`| tail` on a `gh run view` whose jq filter contains "npm run check". Repo (docs/BACKLOG.md and this
closeout): the publish timeout; AGY Gemini's individual quota ran out after 11 completed lane runs in
one evening; the 12th and 13th dispatches failed with `Individual quota reached … Resets in 1h45m57s`;
Claude Code loads a custom agent definition once per session (edits and deletions are not re-read
promptly); `delegate-gate` flags the common `servers` test pattern and `as unknown as typeof fetch`
fixture casts. Memory: dispatch-fast-path-2026-09-04.

## Lanes

AGY Gemini 3.8 Flash high (MCP `dispatch`, lane `agy-gemini`, tier `high`): 7 of the 11 distinct code
tasks (9 of the 13 code dispatches, counting two follow-ups), with Claude Sonnet doing the other 4
code tasks: the MCP answer-mode lane, the two relay-template fixes and the setup-claude test-guard
fix (the `Co-Authored-By` trailers in `git log e776534..HEAD` give the commit-level split: AGY 9 code
commits + 1 docs commit, Sonnet 4 code commits + 3 docs commits), the refusal research, 5-10 minutes
each, own worktree each. Claude Sonnet: the MCP answer-mode lane, the template hardening, the
test-guard fix, three records/docs lanes. Every lane was judged by its report, `git show --stat`, the
source diff, `llm-relay delegate-gate`, and an orchestrator-run full suite before merge.

The latency figures above are live measurements taken in the orchestrating session on 2026-09-04;
they left no artifact in this repository, so they are reported, not reproducible from the tree.

## Verdict

- All machine-derived sections PASS.
