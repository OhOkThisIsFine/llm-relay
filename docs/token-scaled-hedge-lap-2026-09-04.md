# Closeout — C:\Code\llm-relay

Rendered 2026-09-04T12:38:17.883Z by ~/.agent-config/render-closeout.mjs.
Verification below is rendered from commands, arguments, and the verify-green ledger.

## Identity

- Branch: `main`
- HEAD: `8d1649c3d30817718d9c2639ea26de13ed75d354`
- Sprint start: `6c9943f4f8a98d353607404e44948218d396dd72`

## Commits in the sprint range

- 8d1649c chore: release v0.70.0
- fd6ed10 chore: re-baseline the package ceilings for the shipped calibration script
- 6936aaa docs: record lap 2 — token-scaled hedge floor, model-free relay agent for Claude and Codex
- 75a6a25 chore: regenerate AGENTS.md from CLAUDE.md (sync.mjs)
- cc4da1b feat(hedge): the hedge floor grows with the request's estimated input tokens
- e73d113 feat(setup): the relay agent pins no model; Codex relay agent (or documented absence)

## Working tree and remote

- Working tree: clean — PASS
- `origin/main` equals HEAD — PASS

## verify-green ledger

- Ledger: `npm run check` recorded 2026-09-04T12:25:05.386Z on tree `2e849d1da723`
- `verify-green check` FAILED: verify-green: FAIL
content changed AFTER the recorded passing run (2026-09-04T12:25:05.386Z).
Files changed since that run:
M	package-lock.json
M	package.json
Re-run the suite through `record` before claiming green. — FAIL

## CI for exact HEAD

- Publish to npm: completed/success (run 33872680480) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/33872680480
- CI: completed/success (run 33872678062) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/33872678062

## Operator-provided narrative (not machine-derived)

## Goal

Relay agent with no hard-coded model that also serves Codex; hedge delay scaled by the message token
count (owner direction 2026-09-04, after lap 1's closeout).

## What shipped (v0.70.0, 2026-09-04)

- The hedge floor grows with the request's estimated input tokens:
  `floorMs = max(minFloorMs, msPerInputToken × estimatedInputTokens)`, defaults 3000 ms and 0.15 ms
  per token; basis `input-size` announced with the token count; legacy `floorMs` still loads as an
  alias of `minFloorMs`. `scripts/calibrate-hedge-floor.mjs` fits the rate from the accounting store;
  its fit (0.036 ms/token) fell below the accepted band, so the default stays 0.15. `cc4da1b`.
- The Claude `relay` agent pins no model (`model: inherit`, marker v4). Codex has file-based custom
  agents (TOML under `~/.codex/agents/`), and the package's installer now writes a `relay` agent there
  with the same pass-through instructions and no model pinned. `e73d113`.
- Package ceilings re-baselined for the shipped calibration script (packed +3.5 KB; unpacked -37 KB
  after DR-020). `fd6ed10`.
- Docs: HANDOFF §0 for lap 2, backlog closes and adds. `6936aaa`.

## Measurements (live, 2026-09-04, daemon on v0.70.0, `routing.hedge.minFloorMs` 3000)

| Probe | `x-llm-relay-hedged` | Wall |
|---|---|---|
| small prompt, 10 estimated tokens, #1 | primary won after 3000 ms, input-size 10 tokens | 13.5 s |
| small prompt, #2 | hedge won after 3000 ms, input-size 10 tokens | 17.6 s |
| large prompt, 33,573 estimated tokens | primary won after 5035.95 ms, input-size 33573 tokens | 86.7 s |
| `auto`, small prompt | primary won after 3000 ms, input-size 10 tokens | 66.0 s |
| warm-up small prompt | no hedge, served in 2.0 s by kilo/nemotron | 2.0 s |

The threshold scales exactly as specified (0.15 × 33573 = 5036 ms). The wall times in this round are
the pool's state, not the mechanism: the fast member answered 402 after the warm-up, and the remaining
members (nim/kimi-k3, gemini-3.6-flash) were slow; a single hedge cannot beat two slow members.
These figures are session measurements with no repository artifact.

## Verification of the relay agent

`~/.claude/agents/relay.md` is v4 with `model: inherit`. The v3 template was verified end to end in
lap 1 (Agent tool and a three-agent Workflow, provenance lines present); v4 changes only the model
line. `~/.codex/agents/relay.toml` is installed by `npm install -g llm-relay@0.70.0`. Whether a Codex
Desktop `relay` subagent reaches the MCP `dispatch` tool needs a live Desktop session, which only the
owner can drive; it is the first item in HANDOFF's immediate next.

## Residuals (homes named)

- Codex relay agent live verification: owner, Codex Desktop. HANDOFF immediate next; docs/BACKLOG.md.
- Hedge calibration: re-run the script as traffic accumulates. docs/BACKLOG.md.
- `test/os-keyring.test.ts` "sanitizes a thrown child error" fails in a lane worktree with a
  junctioned node_modules and passes in the main checkout (path-sensitive). docs/BACKLOG.md, low.
- Lap 1 residuals unchanged: four verified audit findings; publish timeout; SnapshotMutationResult
  dead members. docs/BACKLOG.md.

## Friction (routed)

- The package-size ceiling failed the gate after the lanes merged; the growth was known (a shipped
  242-line script) and decomposed on the unpacked size before re-baselining. Repo: this closeout.
- `npm pack --dry-run --json` output is not a single JSON document here; the human-readable notice
  or the check script are the usable sources. Machine-wide trap already recorded in memory.

## Lanes

Claude Sonnet: both code tracks (the hedge floor, 35 min; the relay agent and Codex investigation,
18 min). AGY Gemini 3.8 Flash high: the docs pass. Each code diff was judged by its report,
`git show --stat`, the source diff, `llm-relay delegate-gate`, and an orchestrator-run full suite
before merge.

## Verdict

- 1 section(s) FAIL: verify-green check.
