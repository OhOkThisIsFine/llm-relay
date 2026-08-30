# HANDOFF

Entry point for any agent picking up llm-relay, on any provider. Read this before `CLAUDE.md`.

## 0. State as of 2026-08-30 (sixth lap)

**Current: v0.62.0 is released** — npm `dist-tags.latest` 0.62.0 and `llm-relay version` 0.62.0,
both verified 2026-08-30. ⚠ The RUNNING relay's version is not asserted here: `GET /telemetry`
carries no version field, so a claim about the live process needs a restart or another check.
§6 holds recorded trades, deferrals and settled decisions, not a work queue. The work queue is
[docs/backlog.md](docs/backlog.md), which holds **two owner decisions** — build the MCP server so
agy can delegate (D4), and choose a package-size variant.

⚠ Three commits sit on `main` after the v0.62.0 release tag (`fb38d7e`, `68ea8ce`, `76ae510` —
the package-hygiene lap). They change nothing inside the published package: `packBytes` is
byte-identical at 1113288 and `packageEntries` at 347, because the only code touched was a test
and a script that `package.json` `files` does not list.

**freellmapi is RETIRED** (owner decision 2026-08-29), so llm-relay is now the ONLY free-provider
offload runtime on this machine. It is dormant and reversible, nothing deleted; the measured basis
and the cutover record are
[docs/freellmapi-takeover-readiness-2026-08-29.md](docs/freellmapi-takeover-readiness-2026-08-29.md).
The measurements that settled it: llm-relay carried 5.5× freellmapi's weekly traffic on the same
accounts, freellmapi's compression had saved 0.08% lifetime, and its in-flight quota leases were
already handled inside llm-relay.

**Recent laps, compressed — each has its own doc, and git holds the narrative.**

- **v0.60.0, the eligibility-and-probe lap** — a successful background probe now RETRACTS cooling
  facts (`src/ping/cadence.ts` `recordPing` → `clearFacts`), plus a display-only network-block
  advisory. [docs/eligibility-and-probe-lap-2026-08-30.md](docs/eligibility-and-probe-lap-2026-08-30.md).
- **v0.61.0** — a stated `unknown` host was treated like `routed`, so a headless caller got a
  `target:` spec it could not address and `--next-command` exited 2 with nothing to run.
  [docs/skill-dispatch-mcp-verification-2026-08-30.md](docs/skill-dispatch-mcp-verification-2026-08-30.md).
- **v0.62.0** — OpenCode is a third `install-skill.mjs` target, and it is the only one honouring
  `XDG_CONFIG_HOME` rather than a fixed dotfolder in HOME.
- **v0.62.0+, the package-hygiene lap** — below.

Three durable facts from those laps, kept because prose elsewhere had them wrong:

- ⚠ **`AGENTS.md` can only be regenerated from the MAIN checkout.** `sync.mjs` resolves project
  targets under `C:/Code` and never reads a worktree, so a worktree lap must hand that step back.
- ⚠ **Reason about agy from `~/.gemini/antigravity-cli/settings.json`, never from prose.** Its live
  allow list is `read_file`, `write_file`, `read_url`, `mcp` — verified end to end 2026-08-27. An
  earlier write-up here claimed far less. (`~/.agent-config/host-agy.md` was stale for three days
  and was rewritten 2026-08-30; it is correct now.)
- ⚠ **The MCP verdict is REVERSED** (owner, 2026-08-30): agy must be able to DELEGATE, so an MCP
  server is now wanted. The work item is in [docs/backlog.md](docs/backlog.md); the superseded
  reasoning stays in `CLAUDE.md` because its two INVALID objections must not be repeated.
- ⚠ **agy's missing shell is NOT a security boundary** (owner correction, 2026-08-30). The
  2026-08-11 `command(*)` revocation was an AGENT's act, not an owner decision, and the global
  `CLAUDE.md` phrase "the accepted cost" describes an acceptance no file history shows. Never cite
  it to gate a design. The MCP work item first did, and that text is retracted in place.

**This lap (2026-08-30, sixth) — the package-hygiene lap.** Full evidence:
[docs/package-size-2026-08-30.md](docs/package-size-2026-08-30.md).

- **A green baseline was intermittently RED, and the cause is now known.**
  `test/hard-cap.test.ts` derived its retry-after bound from a clock read AFTER the response, while
  `server.ts` `respondAllCapped` reads its own clock earlier. `ceil` is monotonic, so the relay's
  value can legitimately be one second LARGER than the test's bound. Measured 26478 vs 26477.
  A 200000-case arithmetic model reproduces the old form failing 2.4% of the time and the new form
  never failing. ⚠ **This is very likely the unexplained flake recorded in the v0.61.0 friction
  log**, whose diagnostics were lost to a `tail` pipe. The fix is in the TEST, per this repo's
  own protocol; `hard-cap.test.ts:636` was the suite's only derived-boundary retry-after bound.
- **`check:package` now names the build** instead of dying on a raw ENOENT (`readBuiltJson`).
- **The 9 unexplained package entries are closed with no residue** — three modules from `ba3bd2a`
  (v0.59.0) × three `tsc` outputs. 329 + 9 + 3 = 341 exactly.
- **A stale `observed.unpackedBytes` was corrected** to the measured 5205915. The recorded 5194760
  described no tree that ever existed, and survived because a CEILING metric's `observed` value is
  never compared for equality. A provenance correction, not a ratchet raise; no ceiling moved.
- **The comment-prose size question is now measured, not asked.** 29.5% of `dist/*.js` is comment
  prose; four tarball variants are measured in the doc §3. Owner decision, in the backlog.

**Owner decisions taken this lap.** D1, D3 and D5 were already closed and were verified as such.

- **D2 — CLOSED PERMANENTLY, the other way.** `DEFAULT_CONFIG_TEMPLATE` will NOT ship a
  `routing.ladder` or `cliLane`. Dispatch is deliberately a per-machine feature, so dispatch work
  is no longer measured against `docs/project-goals.md` rubric test 1. Recorded in the CLAUDE.md
  MCP gotcha.
- **D4 — REVERSED: agy must be able to DELEGATE**, so an MCP server is now wanted. The reversal
  condition was written into the CLAUDE.md gotcha and the owner met it. Work item in
  [docs/backlog.md](docs/backlog.md).
  ⚠ **I first attached a security cost to it, and the owner retracted that the same day.** I wrote
  that an MCP server "reaches around a deliberate 2026-08-11 revocation" which "the owner accepted
  knowingly". Both halves were false: the revocation was an agent's act, and no file history shows
  an acceptance. The text is retracted in place in all three homes rather than quietly deleted.

**Immediate next:** the two owner decisions now in [docs/backlog.md](docs/backlog.md) — the MCP
server build (D4) and the package-size variant. ⚠ `AGENTS.md` cannot be regenerated from a
worktree; `sync.mjs` resolves project targets under `C:/Code` only, so the CLAUDE.md edit in this
lap needs `node ~/.agent-config/sync.mjs` run from the MAIN checkout.

**The quota-source re-probe shipped** (v0.59.0 feature + two live-found fixes; design, owner
decisions and the full verification record:
[docs/quota-reprobe-design-2026-08-29.md](docs/quota-reprobe-design-2026-08-29.md)):

- **The property the backlog demanded now holds**: a recorded lane quota death either carries an
  expiry the relay enforces (`dispatch-exhaustion.json`, future-only restore), or the background
  quota probe retracts it. Roster staleness (7d) stops evictions on old evidence; `laneOfRung`
  sees through the `lane-launch.ps1` wrapper (agy had been unprobeable since 2026-08-27);
  `routing.laneProbe` (default ON) rides the ping tick — catalog per 24h, quota probes per 6h
  for DEAD buckets only.
- **Invariant amended by owner decision**: the request path never spawns a lane; the operator
  `--probe` and the background cadence are the only two spawn sites. Recorded in the CLAUDE.md
  ladder gotcha and the design doc §5.
- **Two defects were found ONLY by the live drill, both in the Windows spawn path**: v0.59.1 —
  async `execFile` leaves stdin an open pipe and `agy models` stalls to the timeout (the sync
  `stdio: ["ignore"]` was load-bearing); v0.59.2 — the `.cmd` shell fallback joined args
  unquoted, so the probe prompt reached codex as seven tokens. Both fail-safes held: every
  symptom was "never learns", never a wrong verdict.
- Live-verified end to end: cadence refreshed both rosters (agy 11 → 14 models — today's roster
  leads with gemini-3.7, which the stale roster lacked, so a fresh probe under the OLD code
  would have evicted the healthy `agy-gemini` rung); a real recorded death survived two
  restarts, was probed through a real `codex exec` completion, retracted, and the retraction
  flushed to disk.

Operational: this lap ran from the worktree branch `claude/start-lap-a218d7`. ⚠ **Standing, and it
recurs every lap:** after a worktree pushes to `origin/main`, the MAIN CHECKOUT's local `main` at
`C:\Code\llm-relay` is behind origin until someone runs `git pull` there — a worktree cannot
fast-forward a branch another worktree has checked out. The six codex dispatch rungs stay
`"enabled": false` (the 2026-08-27 move to the first-party plugin); machine-side prose no longer
carries its own quota-dead claims — the relay's dispatch state is authoritative (design §5).

⚠ **A worktree with an empty `node_modules` silently certifies the WRONG tree.** Found this lap:
this worktree held zero installed packages, so Node resolution walked up three levels and
satisfied every import from the parent checkout. `npm run build`, `tsc` and the entire vitest
suite all passed against a dependency tree that was not this worktree's; the only check that
noticed was `check:package`, and it reported the symptom (`../../../node_modules/react`) rather
than the cause. Run `npm ci` in a fresh worktree BEFORE recording any verify-green entry. A global
SessionStart hook (`~/.claude/hooks/worktree-deps-guard.mjs`, owner decision 2026-08-30: warn,
never auto-install) now says so at session start, for every repo on this machine.

## 0.1 Earlier releases

Deliberately NOT restated here. This file holds current state plus the immediate next; a
release-by-release narration is a changelog, and git already has it. `git log --oneline` and the
tags are the trail. What survived each sprint lives in its own home:

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
| `docs/dispatch-integration-review-2026-08-27.md` | Cross-CLI dispatch: how the ladder is actually executed, the agy console-window cause and fix, agy's permission vocabulary, ACP as the verified transport, ranked options, open tests. |

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
