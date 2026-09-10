# HANDOFF

Entry point for any agent picking up llm-relay, on any provider. Read this before `CLAUDE.md`.

## 0. State as of 2026-09-09 (v0.77.1)

- **What shipped:** the `parseRouting` split with its validation order pinned FIRST
  (`test/config/routing-parser-order.test.ts`; cognitive complexity 125 → 12; `parseOffload` and
  `parseLadder` untouched by design). The `config/routing-parser.ts` row of `CLAUDE.md` names the
  helpers.
- **Two pre-existing quirks pinned as behaviour:** the pool-member warning lacks the `config.`
  prefix and the consequence sentence the other five degradation warnings carry;
  `routing.subagents` stays attached as `{}` when its only entry is dropped.
- **Daemon note:** the logon-started daemon runs v0.77.0 until the next logon (owner decision
  2026-09-09), while `llm-relay --version` reports 0.77.1.
- **Offload record:** both packets of the v0.77.1 lap went to the free pool through MCP
  `dispatch`, and both needed repair here. The measurement: a free lane follows the SHAPE of a
  brief and drops its finest constraints, so verify with the suite AND a typecheck; and cancel a
  stalled lane by hand once its file stops changing, because the walk budget is the lane's own p80.
- **Docs trimmed (2026-09-09, this lap):** this file and `docs/backlog.md` hold current state and
  open work only. The backlog's former Closed section and this file's release list are in git
  history (`git log -p -- docs/backlog.md HANDOFF.md`), not restated anywhere.
- **Immediate next:** triage the eligibility queue (10 unrecognized refusals; the dispatcher
  proposes by digest, only the owner accepts). Then the Open entries of `docs/backlog.md`, which
  is the queue.

### 0.1 Previous laps

- **v0.77.0, breaker persistence (2026-09-08/09).** The WHOLE circuit-breaker cell survives a
  restart (failure counters, the credential fault, the served-request ping window
  `GET /telemetry` scores from, quota observations), and every write-behind store flushes at a
  graceful shutdown. Three stated behaviour changes: restore is faithful, not future-only; a
  credential fault survives for its five-minute window (owner-accepted); every outcome dirties
  the file, bounded by `WriteBehindTimer`. Residue: the logon-started daemon dies by
  `TerminateProcess`, so the flush never runs there (backlog). Evidence:
  [docs/breaker-persistence-audit-2026-09-08.md](docs/breaker-persistence-audit-2026-09-08.md).
- **v0.74.0–v0.76.0, the dispatch lane walk and its safety review.** `dispatch` walks the
  ladder, pins the lane that answered, demotes the one that did not, and budgets each lane from
  its own p80. Three defects fixed in review: a demotion did not retract the pin; the budget
  measured itself; a clamped budget was labelled `history`. ⚠ Review coverage was PARTIAL — 24 of
  33 second-pass findings are UNVERIFIED, two filed in the backlog. ⚠ The demotion is EVIDENCE,
  not a calibrated statistic; never point the HTTP path's numbers at a lane. Full record:
  [docs/lane-walk-safety-review-2026-09-08.md](docs/lane-walk-safety-review-2026-09-08.md).

### 0.2 Offload, measured

Free lanes CANNOT do open-ended reconnaissance here — 7 of 7 packets fabricated on 2026-09-05.
They CAN review a concrete diff against a stated claim, and they carry a mechanical rewrite with
a stated rule. The test is whether the output can be checked by running or reading something
specific. Never key a fallback on a `null` result; never make a lane the only check.
`opencode-muse-spark` is congested, not broken (owner, 2026-09-05), and the lane walk routes
around it.

### 0.3 Earlier releases

Earlier releases are deliberately not restated here. `git log --oneline`, the tags, and the dated
documents under `docs/` are the trail; what survived each release lives in the `CLAUDE.md` rows
and gotchas.

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
| `docs/metering-reconciliation-2026-08-22.md` | Implemented vs open against the quota-metering spec: gap/stage/decision tables. |
| `docs/rubric-recalibration-2026-08-16.md` | What went wrong, the revised invariants (copy-ready), 55 re-adjudicated rejections. |
| `docs/credential-fleet-design-2026-08-16.md` | Custody, pooling, cost accounting: components, staged build order. |
| `docs/quota-metering-spec-2026-08-16.md` | The metering pipeline: metrics, collection sites, storage, stages. |
| `docs/spa-dashboard-design-2026-08-20.md` | Read-only Analytics SPA design, protocol, contract, staged gates. |
| `docs/rejection-ledger-2026-08-16.md` | Every past rejection and its reason, grouped by reason-kind. |
| `docs/reference.md` | Full user-facing reference: credential fleets, protected diagnostic surfaces. |
| `docs/three-axis-assessment-2026-08-28.md` | The owner's three-axis capability assessment: verdicts per axis, the live-signal finding. |
| `docs/advisory-findings-verification-2026-08-28.md` | The 32 advisory findings: the closed-vocabulary bug class and all eight instances. |
| `docs/documentation-pass-2026-08-27.md` | The doc-vs-source pass: what was wrong, in what classes, what was deliberately left. |
| `docs/dispatch-integration-review-2026-08-27.md` | Historical cross-CLI dispatch review; its AGY focus-safety conclusion is superseded by the next row. |
| `docs/dispatch-smoothness-2026-08-31.md` | Current per-agent routing matrix, MCP spawn guarantees, PowerShell/OpenCode repairs. |

## 3. Verification — the one gate

```bash
npm run gate
```

- `npm run gate` = `npm run build && npm run check`. It is ONE script because
  `verify-green.mjs record -- <cmd>` takes one command, and a fresh lap worktree has no `dist/`
  (gitignored), so `check:package` fails unless the build ran first. Record the ledger with
  `node ~/.agent-config/verify-green.mjs record -- npm run gate`.
- `npm run check` = both typechecks (`src/` and `test/`) + the server vitest suite + the dashboard
  checks (`tsc -p dashboard/tsconfig.json --noEmit` and the dashboard suite) + the package checks
  (bundle-inventory equality, size ratchets, packed smoke). **CI runs exactly this and nothing
  else.**
- Bundle sizes live in `docs/dashboard-package-baseline.json` and are ratcheted: regenerate the
  baseline in the SAME change that adds or removes bundle weight, or `check:package` goes red.
- Tests read `src/` directly; `scripts/*.mjs` read `dist/` - rebuild before running any script.
- Some tests are POSIX-only and skip on Windows; CI's ubuntu leg is the only place they run. A
  store path nested under a regular file reads `ENOENT` on Windows but `ENOTDIR` on Linux, so
  fixtures inject the stat/read seam.
- A failing test may pin a defect it should have caught; fix test and source in one commit.
- A test doing real machine work has the machine's worst case in its 5 s budget: a spawn measured
  at ~50 ms idle took 2.8–4 s under full-suite contention and flaked two CLI tests for weeks. Fix
  at the root with an injected seam, never by raising one test's timeout.
- Static analysis (`npm run analysis:run`) is advisory and deliberately outside the gate.

## 4. Things that will bite you

1. Do not trust this repo's documentation without checking source; three mechanical guards exist
   (`test/architecture-map.test.ts`, `test/scripts-inventory.test.ts`, `test/doc-links.test.ts`)
   and everything a doc SAYS is still unguarded.
2. A recorded "open gap" is a claim; verify its mechanism before working it.
3. A CLI process's environment is not the running relay's environment; `GET /registry` is
   authoritative for `has_key`.
4. `/health` and `/ping` return 403 by design; use `/telemetry`.
5. Headless offload lanes must be told not to stop and ask.
6. A spent pool member stays walkable by design; address a healthy member directly with
   `--model <provider>/<model>`.
7. A multi-lane burst degrades the free pool it runs on; relaunch each dead lane pinned to a
   different healthy member from `/candidates`.
8. The vitest interpretations/fact stores are per-PROCESS files; assert entry-specific facts,
   never queue lengths.
9. Worktrees: edit and run tests in that path; `vitest.config.ts` scopes the suite on purpose.

## 5. Definition of done

- `npm run gate` green on a clean, committed tree.
- Both request paths covered by any new policy.
- New behaviour pinned by a test. Failover tests use **≥2 candidates** — with one candidate,
  "fails over correctly" and "cannot fail over" are the same observation.
- Commit trailer names the model that authored the change:
  `Co-Authored-By: <model> <noreply@anthropic.com>`.
- No half-done state. Deliberate intermediate states must be called out explicitly so they are not
  mistaken for bugs.

## 6. Recorded trades with no other home

Everything here is a settled trade kept for its reason, not work; the queue is `docs/backlog.md`.

1. **Custody residuals (v0.45.0):** `keys rotate` mints the control token when no relay runs (same
   side effect as `cooldowns clear`); the macOS `security` and Linux `secret-tool` lanes have
   injected-double coverage only, no CI leg runs them. (The keystore flake of 2026-09-09 is
   closed: its mechanism was a four-character leak-check needle colliding with base64 ciphertext,
   and the shared worker-default path only made the haystack longer; both halves fixed in
   `test/keystore.test.ts`.) Plan:
   [docs/custody-sprint-plan-2026-08-24.md](docs/custody-sprint-plan-2026-08-24.md).
2. **SPA and test nits standing:** the flat 30 s poll with no failure backoff (mitigated by
   abort-on-hide/offline), the CSS-structure test mirroring styles.css, a few wall-clock-sleep
   tests, dashboard fixtures cast via `as unknown as`, `aria-description` support patchier than
   described-by, theme preference not persisted, SIGKILL leaking the test interpretations file;
   and the misleading body-problem error codes (N8), a versioned wire change no consumer reads.
3. **`delegate-gate` findings waived (2026-09-04, extended 2026-09-09):** the module-level
   `servers` test-fixture pattern and `as unknown as typeof fetch` casts are pre-existing
   repository convention, not new defects. Added 2026-09-09, each with its reason in the commit
   that carries it: a partial-`Config` fixture cast `as unknown as Config` where the file's own
   `Harness` already casts a partial literal (P8); the tautological-assertion detector's
   local-helper false positive (`provider()`, `budgetOf()`); a double cast through the accounting
   store's returned `writerStatus` reference to reach a `lease_refused` state that has no
   single-process producer (P11-b); a `WeakMap` set on the Responses path that the Chat path
   in the same file already performs (P7); and, for the probation band (P13), the same
   local-helper false positive (`attempt()`) plus an `as unknown as typeof fetch` cast that is
   `test/dynamic-pools.test.ts`'s existing fixture convention.
4. **Where every other settled decision lives:** the owner decisions of 2026-09-04 (`freeOnly`
   stays `false`; contributor SKUs route automatically) in the `dynamic-pools.ts` row of
   `CLAUDE.md` and `docs/muse-spark-1.3-opencode-zen-2026-09-04.md`; the Class B deferrals, the
   type-level 7 keep and the WITHDRAWN currency-per-week spend ceiling in
   `docs/advisory-findings-verification-2026-08-28.md`; the dropped Gaps 15/16/P4 and the accepted
   streaming usage parity in `docs/metering-reconciliation-2026-08-22.md` §7; the uncovered-areas
   verdicts in `docs/uncovered-areas-review-2026-08-26.md`.
