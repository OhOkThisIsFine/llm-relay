# HANDOFF

Entry point for any agent picking up llm-relay, on any provider. Read this before `CLAUDE.md`.

## 0. State as of 2026-09-04 (v0.69.1 published)

**v0.69.1 is on npm**, released 2026-09-04, carrying three commits on top of the same day's earlier
v0.69.0 release: `b8a90ae` "fix(setup): the relay agent must dispatch every task, never answer
itself" (template v2: no own knowledge, dispatch every task, provenance line or failure), `77e9f67`
"test: the setup-claude guard checks the real relay.md is unchanged, not absent" (the T3 test
asserted the developer's real `~/.claude/agents/relay.md` was ABSENT, which fails on any machine
where setup has already run), and `d9fd32a` "fix(setup): the relay agent needs ToolSearch to reach
the deferred dispatch tools" (template v3: `tools:` now leads with ToolSearch). v0.69.0's own
publish run —
[33847892121](https://github.com/OhOkThisIsFine/llm-relay/actions/runs/33847892121) — the first
attempt was CANCELLED by the job's own `timeout-minutes: 15`: `npm ci` took 5 min 2 s (10 s on the
v0.68.8 run) and the smoke test's two `npm install` calls cost about 5 min each, so ordinary npm
registry slowness alone exhausted the budget before the job reached the publish step — no code or
CI defect involved. `gh run rerun` on the same run published cleanly (`npm ci` still 4 min 17 s the
second time), so CI's `npm run check` gate passed on the exact SHA. The 15-minute ceiling is
marginal at three npm installs per run; raising it is Immediate next, below.

The daemon (the global npm install, launched by the Startup `.vbs`) was restarted onto v0.69.0, and
the operator's config gained `routing.hedge.floorMs: 8000`
(`llm-relay config set routing.hedge.floorMs 8000`; revert with `llm-relay config unset
routing.hedge`) — the reasoning is in the measurements below.

**This was a scattershot dispatch lap** (13 commits, `git log --oneline e776534..eb88c02`), not one
feature:

- **`TargetUsability` gained a `slow` band** above the failure bands, ordered
  live → slow → credential-fault → cooling (`bbe1d20`, owner-approved 2026-09-03) — see "Root cause"
  below for why this mattered enough to lead the lap.
- **An `auto` model resolves to the ladder's first ready free pool rung** (`7e889c9`):
  `x-llm-relay-tier` selects the tier, `x-llm-relay-auto` announces the resolved pool, and `auto` is
  now a reserved provider name. The same commit fixed `fetchAnthropicBackend` forwarding the
  caller's literal model string byte-exact instead of rewriting it to the resolved target's model —
  without that fix, an `auto`/`pool/*` spec reached the backend as the literal string `"auto"` or
  `"pool/medium"` rather than a real model id.
- **A `relay` custom Claude Code agent type ships from `llm-relay setup
  claude-cli|claude-desktop`** (`cecb3e1`/`156f4c3`): `~/.claude/agents/relay.md` (model haiku,
  tools = the three dispatch MCP tools), so a Workflow script can write
  `agent(task, {agentType: "relay"})` instead of building its own dispatch call. A foreign
  `relay.md` with no marker is refused as a warning, not a setup failure.
- **Credential-scoped eviction facts now reach pool admission and the free-only guard per slot**
  (`96d7ef8`, `isCostBlockedForEverySlot` in `src/target-facts.ts`) — both call sites previously
  passed a null credential id, so a `subscription-required` fact on one slot (e.g.
  `opencode#default/*`) excluded nothing.
- **The CLI option guard accepts every short alias help and the parser already declare**
  (`b93501d`/`22cf7fa`): `-t` exited "unsupported option" while `--task` worked, because
  `expandFlagAliases` never expanded the short forms; `VALUE_FLAGS` is now derived from the one
  `FLAG_ALIASES` table instead of hand-copied.
- **DR-020 (owner decision, shrink option A): the accounting store's hand-built write-ahead
  journal, replay and quarantine engine is deleted** (`751fb52`, `src/accounting-store-io.ts`,
  1,247 lines). The store now writes each file through the shared `atomicWriteJsonSync`; on-disk
  formats are unchanged, `snapshot-journal.json` is no longer written and a stale one is ignored.
  Accepted trade: a crash between two file writes can leave files from two different snapshots
  until the next flush.
- **MCP `dispatch` gained an `answer` mode** (`cadefcc`): `mode: "agent" | "answer"` (default
  agent), plus `system`, `schema`, `maxTokens` — answer mode POSTs a relay-kind lane straight to the
  relay's own `/v1/messages`, no `claude -p` harness, and carries the relay's announcing headers as
  provenance. The same commit added a structural `isContentEmpty` check (whitespace/punctuation/
  markdown-scaffolding-only output is a distinct `empty-output` failure), a fifth `timed_out`
  `JobStatus` so a bounded wait never returns nothing, and made `checkCwd` resolve `..` before its
  containment test (audit finding DR-008 / contract finding DR-002, both closed).
  `docs/audit-findings-2026-09-03.md` and `docs/eligibility-proposals-2026-09-03.md` were also
  committed this lap (`5c6c60f`, `12a2ed7`).
- **Two tests made hermetic** (`5e5d8f1`): the ping cadence test raced its own `void loop()`
  (`src/ping/cadence.ts:535`), and the dispatch depth test inherited `LLM_RELAY_DISPATCH_DEPTH`
  from a dispatched lane's own environment.

✅ **The `relay` agent type was verified end to end in this session (2026-09-04).** Agent tool
probe — `[agent] Read C:\Code\llm-relay\package.json and reply version=<field>` — returned
`version=0.69.0` plus `provenance: lane=claude-free-pool spec=pool/medium elapsed=6s`, 2 tool calls
(ToolSearch, dispatch), 17 s wall. A three-call Workflow, `agent(task, {agentType: "relay", model:
"haiku"})` against two `package.json` fields and one `vitest.config.ts` option: 3/3 correct
answers, 3/3 provenance lines, lane elapsed 35 s / 16 s / 16 s, 60 s wall, 6 tool calls. (Both ran
in `agent` mode because the session's own MCP server process predates v0.69.0 and advertises no
`mode`.)

Probing found two defects, both fixed in v0.69.1: (a) the v1 template's `tools:` list omitted
`ToolSearch`, and the dispatch MCP tools are DEFERRED in Claude Code, so the wrapper could never
load their schemas and answered every task itself with zero tool calls; (b) Claude Code loads a
custom agent definition ONCE per session — after `setup` rewrote `relay.md` to v2 the running
session still reported the v1 marker and v1 tools; deleting the file was noticed only minutes later
("no longer available"), and the recreated v3 file was loaded a few minutes after that.

⚠ **RESIDUAL, measured:** with `model: "haiku"` a trivial pure-text task — `[answer] Reply with
exactly: X` — is still answered by the wrapper itself (zero tool calls, no provenance line) even
under the v3 wording; realistic tasks dispatch. A `model: "sonnet"` override on the same call
dispatched the same echo with a provenance line, but spent 47 s wall. So a reply carrying no
`provenance:` line means no lane ran — check for it whenever the task is trivial. Tracked as its
own entry in `docs/backlog.md`.

**Root cause of the pool-walk latency the previous lap's MCP dispatch entries were chasing** — now
closed in `docs/backlog.md`. `targetUsability` was returning the SAME `cooling` band for a LATENCY
demotion as for an outright failure, and unknown-lift candidates sort last within that band, so the
pool's only member that answered requests at all — a latency-demoted `nim/moonshotai/kimi-k3`, p95
385–875 ms/token, itself taking 9–38 s per one-line reply — was walked AFTER every
401/402/403/404/502 member instead of ahead of them. Measured before the fix
(one-line prompts, `pool/medium`): direct HTTP 5.7 / 8.5 / 10.8 / 6.6 s with 6–9 failing members
walked per request (one probe: `9 tried, 1 served: 1x404, 1x401, 3x402, 1x403, 2x502, 1x200`); MCP
dispatch to the `claude-free-pool` lane through the `claude -p` harness 22 s, of which the harness's
own overhead beyond API time measured only 0.06–0.26 s plus about 2 s of process start; AGY's
`agy-gemini` on `gemini-3.8-flash-high` 8 s.

The new `slow` band alone produced `2 tried, 1 served` walks, but the DEFAULT hedge floor then
dominated the total: one-liners still took 21–38 s right after the restart, because the slow primary
answered in 9–38 s and the hedge fired only at the built-in 20 s floor, with its member answering
about a second later — every observed hedge reported basis `floor`. With
`routing.hedge.floorMs` set to 8000, the same one-liners against the restarted v0.69.0 daemon
completed in 17.3 s (first request after restart), 4.0 s, 10.2 s, 3.0 s; `auto` answered in 1.4 s on
`/v1/messages` and 9.3 s on `/v1/chat/completions` (both carrying
`x-llm-relay-auto: pool/medium (medium)`; `x-llm-relay-tier: high` gave `pool/high (high)`); MCP
answer mode answered in 10.5 s and 13.5 s against the new server binary. ⚠ Whether the hedge's
per-token and absolute rungs are unreachable by design or merely unexercised by this traffic is
still open — see Immediate next.

**Lanes.** AGY on Gemini 3.8 Flash (`gemini-3.8-flash-high`, via MCP dispatch) did 8 of the 10 code
lanes this lap plus the refusal-queue research, each in its own git worktree with a `node_modules`
junction, 5–10 minutes each. Claude Sonnet did the MCP answer-mode lane (43 minutes) and this
documentation pass. The Anthropic monthly spend limit killed four Sonnet subagents at once mid-lap
(HTTP 429) — the AGY lanes were unaffected — and later the AGY lane hit its own individual quota
(reset in about 1 h 46 min), which is why this docs pass moved to Sonnet. One investigation result
worth keeping: the "second request" a `claude -p` harness sends per run is `HEAD /api/hello`, a
connectivity probe, not a completion.

**Owner decisions this lap (2026-09-03):** DR-020 → shrink, not replace (done); audit-tools items
are out of scope for llm-relay laps; the refusal queue → research the 4 highest-count items (done —
item 1, the groq TPM 429, proposed as `rate-limited`/`attempt` and awaiting
`llm-relay eligibility accept 2 --sig a568e0cbe2 --class rate-limited --scope attempt`; items 3, 4
and 6 got no verdict, reasons in
[docs/eligibility-proposals-2026-09-03.md](docs/eligibility-proposals-2026-09-03.md)); the sweep
must never name a model — hence `auto`.

Immediate next — each is also a [`docs/backlog.md`](docs/backlog.md) Open entry carrying its unmet
property:

- Raise `publish.yml`'s `timeout-minutes: 15` to 30 — three npm installs at 4–5 minutes each leave
  almost no margin, and the first v0.69.0 attempt already burned it.
- Calibrate `routing.hedge.floorMs` from data instead of the hand-set `8000`, and find why the
  per-token and absolute rungs never fire (`docs/audit-findings-2026-09-03.md` DR-002 names a
  candidate cause: `tokensSeen` hardcoded to `0` at the one production call site).
- Remediate, or explicitly accept with reasons, the four `docs/audit-findings-2026-09-03.md`
  findings verified against source this lap: DR-001 (`config-types.ts` duplicates `config.ts`,
  including the runtime `EFFORT_LEVELS` array), DR-002 (the hedge ladder's adaptive rung, above),
  contract-review DR-003 (the ledger blames the provider for relay-authored refusals), contract-review
  DR-004 (`GET /v1/models` invents a 272000-token context window).
- Clean up the DR-020 residue in `accounting-store.ts`'s public types: `SnapshotMutationResult`
  still declares the dead `"recovered"`/`"recovery-loss"` members, and `ioHooks` is a seam with
  nothing left to inject.
- Decide whether the `relay` agent template should default to `model: sonnet` (reliable on trivial
  tasks, +~40 s wrapper time) or stay `haiku` (fast, shortcuts trivial echoes) — owner call.

## 0.1 Earlier releases

Deliberately NOT restated here. This file holds current state plus the immediate next; a
release-by-release narration is a changelog, and git already has it. `git log --oneline` and the
tags are the trail. What survived each sprint lives in its own home:

- **v0.68.7–v0.68.8, the `server.ts` decomposition audit** — a handed-over refactor arrived green
  with four defects the suite could not see (a lost second `tsc` pass, a downgraded HTTP status, a
  validator field `AssistantMessage` never declared, a broken multi-line SSE parse) plus three
  control-flow changes a function-body diff couldn't see either; repaired, remediated and every
  region reviewed: [docs/refactor-consistency-audit-2026-09-01.md](docs/refactor-consistency-audit-2026-09-01.md).
- **v0.58.0, the max-output-caps lap** — the display-only `max-output` measurement fact (parser
  beside the context parser, observer on both fronts, live-verified on groq), and the stale-digest
  lesson (recorded signature digests go stale across a normalizer migration — list before
  addressing): [docs/max-output-caps-design-2026-08-29.md](docs/max-output-caps-design-2026-08-29.md).
- **v0.57.0, the eligibility triage lap** — queue 199 → 4 with owner-approved family verdicts,
  the lane-split signature fix and its load-time store migration, the Tailwind scan leak:
  [docs/eligibility-triage-2026-08-29.md](docs/eligibility-triage-2026-08-29.md).
- **v0.56.0, digest-keyed `eligibility accept` + provider-stated spend headroom** — the
  eligibility gotchas and the `spend-headroom.ts` row in `CLAUDE.md`.
- **v0.53.0–v0.54.0, the three-axis assessment and its follow-ups** — the report, every verified
  and refuted claim, the retracted finding, and the closed "Remaining open items" ledger:
  [docs/three-axis-assessment-2026-08-28.md](docs/three-axis-assessment-2026-08-28.md).
- **v0.52.0, the advisory-findings verification** — the closed-vocabulary bug class (also a
  `CLAUDE.md` gotcha) and the full verdict ledger:
  [docs/advisory-findings-verification-2026-08-28.md](docs/advisory-findings-verification-2026-08-28.md).
- **v0.50.0–v0.51.0, the documentation pass and the XDG unification** —
  [docs/documentation-pass-2026-08-27.md](docs/documentation-pass-2026-08-27.md), and the
  `state-paths.ts` row in `CLAUDE.md`.
- **v0.49.0, the uncovered-areas sprint** —
  [docs/uncovered-areas-review-2026-08-26.md](docs/uncovered-areas-review-2026-08-26.md).
- **v0.47.x–v0.48.0, the complexity review and its §5 implementation** —
  [docs/complexity-review-2026-08-25.md](docs/complexity-review-2026-08-25.md).
- **v0.46.0, the dialect-rescue destructive filter** — the last safety-shaped code gap. Its rule
  is a `CLAUDE.md` gotcha, and its design is
  [docs/dialect-rescue-destructive-refusal-2026-08-24.md](docs/dialect-rescue-destructive-refusal-2026-08-24.md).
- **v0.45.0, the custody program** — plan, recon corrections and the seven build decisions:
  [docs/custody-sprint-plan-2026-08-24.md](docs/custody-sprint-plan-2026-08-24.md). Residuals: §6.
- **v0.40.0–v0.44.0, the metering program** — closeout ledger and every gap/stage/decision table:
  [docs/metering-reconciliation-2026-08-22.md](docs/metering-reconciliation-2026-08-22.md) §7.
- **Every standing trade and open question** those sprints produced: §6 below, which is the one
  place they are tracked.
- **Process lessons that generalize** (run the pre-fix control yourself; lane discipline; the
  evidence-only closeout auditor) live in agent memory (`llm-relay-revival`,
  `free-lane-playbook`).

## 1. What still binds

These were **not** removed and are load-bearing. Do not relax them:

- **Loopback only.** Startup refuses a non-loopback bind. But loopback is not authorization —
  mutating endpoints carry admission checks plus a capability token.
- **Logs are metadata only**, enforced at the sink by an allow-list in `src/log.ts`. Never headers,
  never bodies, never URL parameter *values*.
- **The repair boundary.** The proxy fixes protocol *form* (malformed tool calls), never *judgment*.
  No LLM opinion may enter the request path. Routing comes from config and deterministic
  classification.
- **Destructive tool calls are refused, never fabricated.**
- **Health demotes, never drops.** Learned from a real outage where filtering unhealthy candidates
  narrowed a pool to nothing.

The invariant recalibration is applied and authoritative in `CLAUDE.md` §Invariants and
`docs/project-goals.md`; the retired rules and their replacements are recorded in
[docs/rubric-recalibration-2026-08-16.md](docs/rubric-recalibration-2026-08-16.md) §2 and in git
history - do not reintroduce them.

## 2. Where to read

| Document | For |
|---|---|
| `CLAUDE.md` | Architecture map, file-to-responsibility table, gotchas. Invariants are authoritative there. |
| `docs/metering-reconciliation-2026-08-22.md` | Implemented vs open against the quota-metering spec: gap/stage/decision tables, both-fronts and provenance checks, remaining-items list. |
| `docs/rubric-recalibration-2026-08-16.md` | What went wrong, the revised invariants (copy-ready), 55 re-adjudicated rejections |
| `docs/credential-fleet-design-2026-08-16.md` | Custody, pooling, cost accounting - components, staged build order |
| `docs/quota-metering-spec-2026-08-16.md` | The metering pipeline - metrics, collection sites, storage, stages |
| `docs/spa-dashboard-design-2026-08-20.md` | Read-only Analytics SPA implementation design, protocol, contract, staged gates |
| `docs/rejection-ledger-2026-08-16.md` | Every past rejection and its reason, grouped by reason-kind |
| `docs/reference.md` | Full user-facing reference, including provider credential fleets and protected diagnostic surfaces. |
| `docs/three-axis-assessment-2026-08-28.md` | The owner's three-axis capability assessment: verdicts per axis, the live-signal finding, the closed follow-up ledger. |
| `docs/advisory-findings-verification-2026-08-28.md` | The pass over the 32 advisory findings the 2026-08-26 review left unverified: the closed-vocabulary bug class and all eight instances, Class A vs Class B, the verdict ledger. |
| `docs/documentation-pass-2026-08-27.md` | The doc-vs-source pass: what was wrong and in what classes, what was deliberately left, and the friction. |
| `docs/dispatch-integration-review-2026-08-27.md` | Historical cross-CLI dispatch review: execution model, AGY permissions, ACP transport, and the original immediate-child window fix. Its AGY focus-safety conclusion is superseded by the 2026-08-31 report below. |
| `docs/dispatch-smoothness-2026-08-31.md` | Current per-agent routing matrix, MCP spawn guarantees, PowerShell/OpenCode repairs, completed AGY focus-safety revalidation, and the deferred Claude host boundary. |

## 3. Verification — the one gate

```bash
npm run build && npm run check
```

`npm run check` = both typechecks (`src/` and `test/`) + the server vitest suite + the dashboard
checks (`tsc -p dashboard/tsconfig.json --noEmit` and the dashboard suite) + the package checks
(bundle-inventory equality, size ratchets, packed smoke). **CI runs exactly this and nothing
else.**

- Bundle sizes live in `docs/dashboard-package-baseline.json` and are ratcheted: regenerate the
  baseline in the SAME change that adds or removes bundle weight, or `check:package` goes red.
- Tests read `src/` directly; `scripts/*.mjs` read `dist/` - rebuild before running any script.
- Some tests are POSIX-only (`skipIf(process.platform === "win32")`) and skip on Windows; CI's
  ubuntu leg is the only place they run, so a green local Windows run is not full coverage of
  secret-file permissions. A store path nested
  under a regular file reads as `ENOENT` on Windows but `ENOTDIR` on Linux, so fixtures that
  require an absent load must inject the stat/read seam rather than relying on that filesystem shape.
- A failing test may be pinning a defect it should have caught. Read its stated reasoning before
  assuming your change is wrong, and fix test and source in the same commit.
- **A test that does real machine work has the machine's worst case in its 5 s budget.** A spawn
  measured at ~50 ms idle took 2.8–4 s under full-suite process contention and flaked for weeks.
  Fix at the root with an injected seam, never by raising one test's timeout — the flake just
  moves to the next test on the same path. The worked example is the `winenv.ts` row in
  `CLAUDE.md`.
- Static analysis (`npm run analysis:run`) is advisory and deliberately outside the gate.

## 4. Things that will bite you

- **Do not trust this repo's documentation without checking source.** Drift here has been
  recurrent. THREE mechanical axes are guarded now — `test/architecture-map.test.ts` (every
  non-index `src/` file has a `CLAUDE.md` table row), `test/scripts-inventory.test.ts` (every
  `scripts/*.mjs` is named in `scripts/CLAUDE.md`, and no name there is dead), and
  `test/doc-links.test.ts` (every relative link in the shipped doc set resolves, and no `.md`
  target wears a line-number fragment). ⚠ Everything a doc SAYS is still unguarded: what a module
  does, what a default is, which release shipped what. Verify before inheriting such claims.
- **A recorded "open gap" is a claim like any other — verify its MECHANISM before working it.**
  A §6 entry once cited a mechanism (backslash paths failing `check:package` on Windows) that had
  never existed on this tree; ten minutes of reproduction beat an afternoon of fixing a defect
  that did not exist.
- **A CLI process's environment is not the running relay's environment.** On Windows a User-scope var
  enters a process only at start, and the relay launches at logon. `llm-relay keys` reports *its own*
  env; `GET /registry` is authoritative. A whole "half the pool is dead" finding was once this.
- **Worktrees.** If work happens in a git worktree, edit and run tests *in that path*. `vitest.config.ts`
  scopes the suite to this checkout's `test/` on purpose — do not widen it.
- **Liveness checks.** llm-relay's `/health` and `/ping` return **403 by design** (they are control
  routes); use `/telemetry`. freellmapi's `/health` returns **200 unconditionally** from an SPA
  catch-all — its real route is `/api/health`.
- **Never put `--permission-mode plan` in a `cliLane` template.** Headless `claude -p` has no
  `ExitPlanMode`, so the lane can never leave plan mode and looks healthy while completing nothing.
- **Headless offload lanes must be told not to stop and ask.** A lane that ends its turn with a
  clarifying question reads as a completed task that did nothing. Instruct it to decide and
  proceed on its own judgement, and to report rather than await approval.
- **Keep `{task}` BEFORE any variadic flag in a `cli` rung template.** Some shells let a variadic
  option swallow what follows it, and the owner's template once lost the whole prompt to
  `--allowedTools`. Confirm a template with one real headless run before trusting a lane built
  from it.
- **Claude Code has THREE client-side idle timers that abort a long silent generation at ~300 s
  on a custom base URL** — event-level + byte-level streaming watchdogs, and the body idle
  timeout. The relay's commit probe (`src/stream-commit.ts`) holds bytes until meaningful
  content, so a long think looks idle to all three. Set
  `CLAUDE_STREAM_IDLE_TIMEOUT_MS=1800000`, `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=1800000` and
  `API_FORCE_IDLE_TIMEOUT=0` in any hand-written CLI rung's `env`; the owner's
  `routing.cliLane.env` already carries all three.
- **A spent pool member stays walkable by design** (health demotes, never drops), so a headless
  session can die on a member with a standing 402/403 when the preferred member is rate-limited.
  Addressing a healthy member directly (`--model <provider>/<model>`) avoids the fall-through;
  the durable fix direction is eligibility facts and the G2 cap, never dropping.
- **A multi-lane burst degrades the free pool it runs on.** Lanes sharing one quota domain die
  together (a weekly spend-limit 403 ends a headless `claude -p` lane outright). Relaunch each
  dead lane pinned to a DIFFERENT healthy member from `/candidates`, so lanes sit in separate
  quota domains.
- **`gh run watch` on a PASSING publish run shows an `X tier-data.json missing or empty`
  annotation.** It comes from the smoke step's DELIBERATE negative test (publish.yml deletes the
  file and requires exactly that error — "PASS-AS-EXPECTED"), and GitHub renders the `::error::`
  as a failure annotation anyway. Judge a run by `conclusion`, never by its annotations.
- **Refusal signatures converge across lanes since the 2026-08-29 fix, with one stated residual.**
  A provider message CUT by the wrapper's 300-char body cap converges only when both lanes'
  extractions share the same 240-char signature prefix; otherwise each lane keeps its own
  signature and each binds for the lane it was learned on. An accepted verdict therefore covers
  the lane whose traffic produced it — which is the walk lane for everything pool-routed. An
  EMPTY wrapped body teaches and queues nothing, by design. Diagnosis and resolution:
  [docs/eligibility-triage-2026-08-29.md](docs/eligibility-triage-2026-08-29.md).
- **The vitest interpretations/fact stores are per-PROCESS files, so entries leak between tests
  in one file.** `resetInterpretations()` drops the memo, not the file — a later test's
  `pendingRefusals()` sees every entry earlier tests flushed. Assert entry-specific facts
  ("this signature is still pending"), never queue lengths.

## 5. Definition of done

- `npm run build && npm run check` green on a clean, committed tree.
- Both request paths covered by any new policy.
- New behaviour pinned by a test. Failover tests use **≥2 candidates** — with one candidate,
  "fails over correctly" and "cannot fail over" are the same observation.
- Commit trailer names the model that authored the change:
  `Co-Authored-By: <model> <noreply@anthropic.com>`.
- No half-done state. Deliberate intermediate states must be called out explicitly so they are not
  mistaken for bugs.

## 6. Outstanding, unclaimed

⚠ What follows is **recorded trades, deferrals and settled decisions kept for their reasons**, not
a work queue. The queue is [docs/backlog.md](docs/backlog.md). Nothing here currently awaits the
owner.

**From the 2026-08-29 triage
([docs/eligibility-triage-2026-08-29.md](docs/eligibility-triage-2026-08-29.md)):**

- **EXECUTED: the lane-split refusal-signature fix** (owner decision 2026-08-29: fix and
  re-migrate). Shipped in v0.57.0 with the load-time store migration; residuals recorded in §4
  and in the `refusal-interpretation.ts` row of `CLAUDE.md`.
- **EXECUTED: the max-output-caps design (accepted 2026-08-29, implemented the same day in
  v0.58.0).** Display-only learning of stated output ceilings, shipped exactly as scoped
  ([docs/max-output-caps-design-2026-08-29.md](docs/max-output-caps-design-2026-08-29.md));
  the carrier groq signature was rejected from the queue on landing.

**Owner decisions on record:**

- **WITHDRAWN: the currency-per-week spend ceiling.** The owner never asked for it; it was an
  agent-recorded candidate. Do not re-raise it as an open item.
- **EXECUTED: the OpenRouter weekly-limit interpretation is accepted**
  (`allowance-exhausted`, scope credential, `--cost-class paid`) — paid OpenRouter deployments
  demote while the condition cools and free ones stay walkable. Self-healing on both sides: any
  paid success, or the spend-headroom poll, clears it.
- **Type-level 7 stays as recorded** (a hard cap's `used` carries no basis provenance) — owner
  chose keep-as-is. A transparency gap, not a wrong refusal.
- **ACCEPTED AS-IS (owner decision 2026-08-23):** streaming cross-protocol usage parity in
  llm-bridge — the ledger observes the BACKEND stream, so accounting is correct; only the
  client-facing translated SSE loses cache fields.
- **DROPPED (owner decision 2026-08-23), not deferred — Gaps 15/16, P4.** Removed from the
  program of record entirely: Gap 15 (single-file HTML dashboard) was superseded by the shipped
  SPA, Gap 16 (in-flight quota leases) had spec §5.4 arguing against it with no measured
  overshoot, P4 (server-enforced system prompts) never acquired a purpose.

**Deferred hardening (2026-08-28 verification sprint)** — every reason in
[docs/advisory-findings-verification-2026-08-28.md](docs/advisory-findings-verification-2026-08-28.md)
"Still open, with its home". In short: four **Class B** findings (a type wider than its producers,
which no producer can reach) are hardening and deferred — type-level 2, 8, 14, 15; type-level 12
is deferred until someone can show acceptance-equivalence by differential fuzzing, because it
governs what LOADS and a quarantined shard is a lost day of ledger. Response-SIZE bounds on the
probe paths and the `withBudget` non-cancelling race are named as out of scope in `cd6e5f8`.

**Standing trades, each judged in its packet review — do not re-litigate them as discoveries:**

- Orphan `tmp-*` journal files are never swept. Crash-only residue (at most one per hard kill,
  bounded by the file caps), unreadable by anything, and a sweeper cannot distinguish an orphan
  from another process's in-flight temp. If ever built: gate on prefix + inside-root + age > 24h,
  and leave `.corrupt-*` alone — that is deliberate evidence.
- `methodSnapshot` accepts bounded arbitrary JSON as an estimation "method" — deliberate and
  pinned (it snapshots a structured descriptor away from later caller mutation).
- The dashboard session token rides `sessionStorage`; the mitigation is the strict CSP.
- Misleading error codes for body problems (N8): fixing it is a versioned WIRE change for a code
  no consumer reads. SPA/test nits standing: flat 30 s poll with no failure backoff (mitigated by
  abort-on-hide/offline), CSS-structure test mirroring styles.css, a few wall-clock-sleep tests,
  dashboard fixtures cast via `as unknown as`, `aria-description` support patchier than
  described-by, theme preference not persisted, SIGKILL leaking the test interpretations file.
- Unverified residual (metering reconciliation §5): rotation-triggered fact clearing is verified
  only in adjacent machinery, not the rotation path itself. (The ≥2-candidate accounting walk IS
  pinned on both fronts in `test/accounting-lifecycle.test.ts`.)
- Custody residuals (v0.45.0): `keys rotate` mints the control token when no relay runs — same
  side effect as `cooldowns clear`, noted, not a defect; the keystore read surface is deliberately
  wider than the strict `keys add`/`import` write gate (documented in `docs/reference.md`); macOS
  `security` and Linux `secret-tool` lanes have injected-double coverage only — no CI leg runs
  them, so any "CI-verified" claim about them would be false; the server-side integration tests
  share the worker-default keystore path; `keystoreStatus` retains the KEK after a successful
  read (deliberate, serves the spawn-once discipline).
- From the 2026-08-27 uncovered-areas sprint
  ([docs/uncovered-areas-review-2026-08-26.md](docs/uncovered-areas-review-2026-08-26.md)
  "Not fixed, and why"): §5 item 24 REJECTED on a measured line delta; items 9, 11, 12, 13,
  19-remainder and 23 keep their verdicts; two behaviours recorded rather than changed
  (`key-checker`'s initial-probe 401/403, and an anthropic-kind provider only ever reporting
  `unverified`); the pre-existing mis-indentation in `src/key-checker.ts` stands so a reformat
  cannot obscure a real diff.
- **`delegate-gate` findings WAIVED across this lap's lane diffs** (2026-09-04): the module-level
  `servers` test-fixture pattern and `as unknown as typeof fetch` casts, both flagged repeatedly
  across this lap's AGY-lane packets, were judged pre-existing repository convention rather than
  new defects and let through — the same shape as the dashboard-fixture `as unknown as` entry
  above, now also seen on the server side.
