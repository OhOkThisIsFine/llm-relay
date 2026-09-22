# HANDOFF

Entry point for any agent picking up llm-relay. Read this before `CLAUDE.md`.

## 0. Current state — 2026-09-22

The architecture refactor has begun with the R0 legacy-storage safety fix, executable runtime
baselines and R1 infrastructure proofs. The target request, dispatch and SQLite ownership changes
are not implemented; live continuation remains evidence-gated.

- Published package version: **0.86.0**. This refactor work is not a new published release.
- Starting `main` baseline: `3f5d88a` (merged architecture plan, PR #73), CI run **790** green.
- R0 replaces unsafe recursive stale-lock deletion with generation-specific owner retirement.
  The source checkpoint `5737286` passed CI run **791**, including the full Linux gate and targeted
  Windows suite. Lock evidence and the upgrade boundary are in
  [`docs/history/refactor-r0-2026-09-21.md`](docs/history/refactor-r0-2026-09-21.md).
- Runtime and SDK/schema/SQLite probes pass on Linux and Windows at checkpoint `e49ea16`
  (refactor evidence run **3**, ordinary CI run **795**). Decisions, measurements and remaining gates:
  [`docs/history/refactor-baselines-and-dependencies-2026-09-22.md`](docs/history/refactor-baselines-and-dependencies-2026-09-22.md).
  Production dependencies and the Node engine range have not changed.
- D1 restart-safe daemon-owned lane execution is implemented.
- D2 transactional config hot reload is implemented.
- Public dispatch/liveness state is explicit rather than inferred from circumstantial clues.
- Multi-process journal/archive mutations are transactionally locked and tolerate bounded transient
  Windows replacement failures without weakening atomic writes.
- Lane capability is derived from synced model evidence/pool bands; the legacy hand-set capability
  value has no routing authority.
- Repeated 402/5xx failures use bounded recovery escalation and remain eligible for failover.
- D5 dependency modernization is complete: Vitest 5, Vite 8, jsdom 30, Tailwind 4, native
  TypeScript 7 compilation, jest-dom 7 and lucide-react 1. Node declarations intentionally remain
  on the Node 22 line while Node 22 is supported.
- PR #70 refreshed live documentation and trimmed implementation comments. The separate follow-up
  documentation PR #72 was not included in this refactor packet.

### Immediate next — architecture refactor

Follow [`docs/architecture-refactor-plan.md`](docs/architecture-refactor-plan.md). Finished-system
simplicity takes priority over refactor size. Execute the remaining R1 translation/gateway comparison
(llm-bridge control, LiteLLM and Bifrost candidates) and calibrate paired performance budgets from
the new R0 probe before R2. The current compact contract map protects unreviewed tests by default;
review each affected assertion before replacing its owning implementation.

The tested infrastructure direction is official MCP server SDK v2, Zod definitions with Ajv consumers,
and worker-isolated `node:sqlite` using DELETE/EXTRA. These are decisions for implementation, not
installed runtime changes. Node 22.13 is a tested minimum API level, not an operational patch
recommendation; its SQLite API is experimental. Full host/schema/install and storage-cutover gates
remain. Do not claim R0/R1 or the service refactor complete from the probes alone.

**Upgrade boundary:** drain and stop every old daemon, MCP and writing CLI process before running
this lock version. A legacy `owner.json` lock is never reclaimed automatically. Only after all
writers are confirmed stopped, remove a confirmed-stale `.lock` directory, not its protected state
JSON, and restart writers on one version. Do not mix versions during stale-lock recovery.

Offline refactor work does not wait for harness quota. Keep the continuation measurements below,
but implement continuation only after the daemon-owned job boundary is stable and the harness has
passed its evidence gates.

### Continuation work — still evidence-gated

All quota-independent continuation preparation is complete: the first-party survey, four exact-ID
interruption/resume probes, and same-cwd two-job isolation probe are in `main`. Live verification
is currently blocked by harness/provider capacity. Do not begin Phase 5.2 until one harness passes
both its single-job probe and `scripts/measure-continuation-isolation.mjs <harness>`.

Audit evidence:
[`docs/history/release-readiness-audit-2026-09-21.md`](docs/history/release-readiness-audit-2026-09-21.md).

Continuation work proceeds in this order, subject to the refactor ownership boundary above:

1. when quota is available, run any documented exact-ID continuation probe (prefer AGY, then Claude; Codex specifically tests active-turn durability);
2. mark only a passing harness verified resumable;
3. then add the generic continuation substrate without changing behavior;
4. implement one verified harness end to end, then expand harness support independently;
5. clear evidence/vendor/operator-blocked items in parallel as their inputs become available.

Detailed continuation sequence and exit conditions:
[`docs/history/development-plan-2026-09-21.md`](docs/history/development-plan-2026-09-21.md).

The authoritative unmet-property list is [`docs/backlog.md`](docs/backlog.md).

## 1. What still binds

These are load-bearing constraints. Do not relax them casually:

- **Loopback only.** Startup refuses a non-loopback bind. Loopback is not authorization; mutating
  endpoints also use admission checks and the control token.
- **Logs are metadata only.** Never log headers, bodies or URL parameter values.
- **Repair protocol form, not judgment.** Tool-call repair may fix malformed protocol form; no LLM
  opinion enters the request path. Routing remains deterministic/config-driven.
- **Destructive tool calls are refused, never fabricated.**
- **Health demotes, never drops.** A temporarily unhealthy candidate remains available to the
  failover/recovery machinery.
- **Unknown capability is not weak capability.** Missing capability evidence must not silently
  exclude a lane.
- **One logical lane attempt may own at most one live process incarnation at a time.** This becomes
  especially important when hard-cap continuation is implemented.

Authoritative rationale lives in `CLAUDE.md`, `docs/project-goals.md`, and the relevant dated
design records.

## 2. Where to read

| Document | Purpose |
|---|---|
| `docs/README.md` | Documentation index |
| `docs/backlog.md` | Current unmet properties |
| `docs/architecture-refactor-plan.md` | Target architecture, implementation sequence and acceptance criteria |
| `docs/history/refactor-baselines-and-dependencies-2026-09-22.md` | Runtime measurements, contract map and tested infrastructure choices |
| `docs/history/refactor-r0-2026-09-21.md` | Initial R0 lock evidence and upgrade boundary |
| `docs/history/development-plan-2026-09-21.md` | Earlier continuation preparation sequence |
| `CLAUDE.md` | Architecture map, invariants, responsibility table and gotchas |
| `docs/architecture.md` | Human-facing codebase overview |
| `docs/reference.md` | User-facing commands, configuration, APIs and caveats |
| `docs/history/mcp-restart-safe-lane-execution-design-2026-09-20.md` | D1 design/evidence |
| `docs/history/config-reload-design-2026-09-20.md` | D2 design/evidence |
| `docs/history/active-hard-cap-lane-continuation-plan-2026-09-20.md` | Planned continuation feature |
| `docs/history/active-hard-cap-harness-survey-2026-09-21.md` | Exact-resume capability matrix and live-probe gate |
| `docs/history/stabilization-plan-2026-09-17.md` | Historical stabilization packets; not the live queue |

## 3. Verification

The complete local gate is:

```bash
npm run gate
```

`npm run gate` builds first, then runs both typechecks, the core test suite, dashboard checks and
package checks. CI additionally has the targeted `windows-process-boundary` job for process,
persistence, spawning or lifecycle semantics. The separate refactor evidence workflow runs the
synthetic baseline and dependency probes; it does not replace this gate.

Important rules:

- scripts under `scripts/*.mjs` consume `dist/`; rebuild before running them;
- tests read `src/` directly;
- bundle/package baselines are ratcheted and must change in the same commit as intentional bundle
  weight changes;
- do not fix contention flakes by increasing an arbitrary test timeout unless the measured failure
  is actually timeout exhaustion;
- a failing regression may be exposing a source defect rather than a test defect. Prove the
  mechanism before weakening the assertion.

Static analysis remains advisory and is outside the gate.

## 4. Definition of done

For source changes:

- `npm run gate` is green on the final committed tree;
- the targeted Windows process-boundary suite is green when the change touches process,
  persistence, spawning or lifecycle semantics;
- new behavior is pinned by a regression that fails when the implementation is removed;
- both request fronts are covered by any policy that applies to both;
- failover tests use at least two candidates;
- docs/backlog/handoff are updated only when the change alters a live property or immediate next
  step;
- deliberate intermediate states are labeled explicitly.

Do not use this file as a release diary. Historical measurements, designs, audits and closeouts
belong under `docs/history/` and in git history.
