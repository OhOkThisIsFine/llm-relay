# HANDOFF

Entry point for any agent picking up llm-relay, on any provider. Read this before `CLAUDE.md`.

## 0. State as of 2026-08-22

Branch `codex/stage-1-credential-pooling`.

- Env-backed multi-key credential pooling (Stage 0 + Stage 1) is complete; its packets landed as
  `7217ce0` .. `3795e60` (see git history).
- The accounting foundation + Analytics SPA (P0-P4) landed as `b4ec7ee` after being found
  UNCOMMITTED by a prior worker; it was checkpoint-committed with the gate green. Same-day
  follow-ups sit in the working tree on top of it: a metering reconciliation, a documentation
  drift pass (19 architecture-table rows, gate description, storage list, fact kinds, subagent
  signals, headers, stale-doc banners, plus a `test/architecture-map.test.ts` guard), removal of
  a dead bundled dependency, and review-driven fixes in the accounting store, dashboard server,
  repair path and CLI.
- [docs/metering-reconciliation-2026-08-22.md](docs/metering-reconciliation-2026-08-22.md) is THE
  ledger of implemented-vs-open against `docs/quota-metering-spec-2026-08-16.md`. Open in one
  line: Stage 3 availability (Gaps 5, 8), Stage 4 spend (Gap 11 + the cost roll-up), Gap 12's
  enforcement term, and widening `AssistantMessage.usage` (C3).
- `llm-relay offload status` now renders the EFFECTIVE `freeOnly` (explicit ON/OFF vs the
  two-sided unset default); the last known transparency gap is closed.
- Gate green at the commit that carries this handoff; CI is the living evidence. Do not start
  custody/keystore work until the metering closeout is complete.

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
| `docs/open-decisions-2026-08-16.md` | Owner decisions; all recommendations approved 2026-08-21 |
| `docs/rejection-ledger-2026-08-16.md` | Every past rejection and its reason, grouped by reason-kind |
| `docs/evidence-2026-08-16/` | Machine-readable audit trail |
| `docs/reference.md` | Full user-facing reference, including provider credential fleets and protected diagnostic surfaces. |

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
- Four POSIX-permission tests skip on Windows; CI's ubuntu leg is the only place they run, so a
  green local Windows run is not full coverage of secret-file permissions.
- A failing test may be pinning a defect it should have caught. Read its stated reasoning before
  assuming your change is wrong, and fix test and source in the same commit.
- Static analysis (`npm run analysis:run`) is advisory and deliberately outside the gate.

## 4. Things that will bite you

- **Do not trust this repo's documentation without checking source.** Drift here has been
  recurrent; `test/architecture-map.test.ts` now pins every non-index `src/` file to a
  `CLAUDE.md` table row, but only that one axis is guarded. Verify claims before inheriting them.
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
- **Headless offload lanes must be told not to stop and ask.** An Ox-Alpha or `claude -p` lane
  that ends its turn with a clarifying question reads as a completed task that did nothing.
  Instruct it to decide and proceed on its own judgement, and to report rather than await approval.
- **FIXED 2026-08-22 — the owner's `cliLane` template no longer places `{task}` after the variadic
  `--allowedTools`;** it now sits directly after `-p` (pre-order backup at
  `~/.llm-relay/config.json.bak-2026-08-22-pre-clilane-task-order`). The lesson stays: some shells
  let a variadic option swallow what follows it, so keep `{task}` BEFORE any variadic flag, and
  confirm a template with one real headless run before trusting a lane built from it.
- **Two heredoc groups in one Bash call break quoting in this harness.** One heredoc per call.

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

From [docs/metering-reconciliation-2026-08-22.md](docs/metering-reconciliation-2026-08-22.md) §6:

- **OPEN — C3 / Gap 4.** Widen `AssistantMessage.usage` (`src/anthropic.ts`) so clients stop
  receiving narrowed cache-token fields. Changes the emitted wire shape; needs its own reviewed
  change, not a drive-by.
- **OPEN — Stage 3/5 remainder (Gaps 5, 8, 12).** Configured limits on `ProviderConfig`, learned
  rate-limit facts + parser, and a quota demotion term in `orderByUsability()`. The largest
  genuine piece of the spec still missing; the availability ladders of spec §5 exist in no form.
- **OPEN — Stage 4 (Gap 11 + C1 roll-up).** Spend x `resolveMetadata()` prices with compound
  `spendBasis`; then `cost --include-repair`. Rebase `unpricedRequests` in the same change.
- **Gap 7:** resolved 2026-08-22 by spec amendment; no new endpoints.
- **DEFER — Gap 10 / M4.** Estimated-output producer withheld until measured usage-absence rates
  justify it (owner disposition, open-decisions.md).
- **DEFER — Gap 13.** Catalog rate-limit harvesting: cheap, expected near-empty payoff; slot
  after Stage 3.
- **DEFER — Gaps 15/16, M3, P1, P4.** Superseded by the SPA choice / argued against in spec §5.4 /
  mutation-with-no-consumer / custody-next-stage / purpose-gated respectively. Do not build
  without a new decision.

Review findings deliberately NOT fixed on 2026-08-22 (report named beside each):

- Destructive-name filter at the dialect-rescue commit point - the one known safety-shaped code
  gap (`docs/status-vs-freellmapi-2026-08-16.md` §3.1 / §6 rec 2).
- Orphan `tmp-*` journal files are never swept (C1 RISK-1 residue; retention itself landed).
- `methodSnapshot` accepts bounded arbitrary JSON as an estimation "method" (C1 NIT-6).
- Dashboard session token rides `sessionStorage`; the mitigation is the strict CSP. Trade
  recorded, not changed (C2 R2). Also standing: the type escape at `materializeDimensions`'
  aggregate return (C2 N5), misleading error codes for body problems (C2 N8),
  regex-sniffing `bodyReadErrorCode` (C2 N9), and `llm-relay dashboard <anything>` ignoring
  extra positionals (C2 N10).
- SPA/test nits standing (C3): flat 30 s poll with no failure backoff (mitigated by
  abort-on-hide/offline), CSS-structure test mirroring styles.css, a few wall-clock-sleep tests,
  dashboard fixtures cast via `as unknown as`, `aria-description` support patchier than
  described-by, theme preference not persisted, SIGKILL leaking the test interpretations file.
- Unverified residual (reconciliation §5): rotation-triggered fact clearing is verified only in
  adjacent machinery, not the rotation path itself. (The >=2-candidate accounting walk IS pinned on
  both fronts: `test/accounting-lifecycle.test.ts` "records failed and committed winning serve
  attempts" walks a 429 candidate then a winner for each front.)

Custody/keystore stays out of scope until the metering closeout is complete.
