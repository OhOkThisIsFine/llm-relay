# HANDOFF

Entry point for any agent picking up llm-relay. Read this before `CLAUDE.md`.

## 0. Current state — 2026-09-22

The architecture refactor has an R0 legacy-storage safety fix, executable runtime baselines and
recorded R1 dependency/boundary choices. PRs #74 and #75 are merged. The target request, dispatch
and SQLite ownership changes are not implemented; active hard-cap continuation remains
unimplemented and evidence-gated.

- Published package version: **0.86.0**. This refactor work is not a new published release.
- R0 replaces unsafe recursive stale-lock deletion with generation-specific owner retirement.
  Lock evidence and the upgrade boundary are in
  [`docs/history/refactor-r0-2026-09-21.md`](docs/history/refactor-r0-2026-09-21.md).
- Runtime and SDK/schema/SQLite probes pass on Linux and Windows. Measurements and the protected
  contract map are in
  [`docs/history/refactor-baselines-and-dependencies-2026-09-22.md`](docs/history/refactor-baselines-and-dependencies-2026-09-22.md).
- R1 selects in-process native adapters plus llm-bridge for supported cross-wire translation,
  official MCP SDK v2, Zod/Ajv schemas, and worker-isolated SQLite using DELETE/EXTRA. Decisions,
  gateway comparisons, performance-budget policy and remaining acceptance boundaries are in
  [`docs/history/refactor-r1-decisions-2026-09-22.md`](docs/history/refactor-r1-decisions-2026-09-22.md).
  Production dependencies and the Node engine range have not changed.
- The expanded comparison confirms a current **native Responses fidelity defect**: unnecessary
  translation changes native fields, IDs and usage structure. It is recorded in the backlog and
  must be corrected by R2; it is not fixed by the evidence packet or this documentation cleanup.
- D1 daemon-owned lane execution survives an MCP host restart while the daemon remains alive.
- D2 explicit, transactional config reload applies supported fields; restart-only changes reject
  the whole candidate rather than partially applying it.
- Dispatch exposes a public activity/liveness verdict rather than requiring circumstantial inference.
- Multi-process journal/archive mutations are locked, with bounded retries for transient Windows
  replacement failures that preserve atomic writes.
- Lane capability derives from synced model evidence and pool bands, not the legacy hand-set value.
- Repeated 402/5xx failures use bounded recovery escalation and remain eligible for failover.
- D5 dependency modernization is complete. Builds use native TypeScript 7; classic TypeScript
  remains the runtime Compiler API. Node declarations stay on the Node 22 line while it is supported.
- PRs #70 and #71 contain the earlier documentation/comment cleanup and its checkpoint. PR #72
  follows with factual corrections and the compact `CLAUDE.md` guide, reconciled with R0/R1 here.

Verified pre-merge checkpoints: R0 `5e8c260b` passed CI **796** and refactor evidence **4**;
R1 `d800e7c` passed CI **805**, refactor evidence **13** and gateway comparison **9**.
These are recorded checkpoints, not a claim about later commits; check GitHub CI for the tree
being changed. Green comparison jobs mean evidence generation succeeded, not every contract passed.

### Immediate next — architecture refactor

Follow [`docs/architecture-refactor-plan.md`](docs/architecture-refactor-plan.md). Finished-system
simplicity takes priority over refactor size. R1 implementation choices are recorded: do not restart
an open-ended gateway survey. Calibrate the matched same-build runtime controls against the explicit
budget policy, then implement R2's one RequestService, including native Responses preservation.
Delete both obsolete orchestration loops; answer mode must use a real internal consumer.

The current compact contract map protects unreviewed tests by default; review each affected assertion
before replacing its owning implementation. A passing comparison screen is not full qualification.
The gateways' documented native passthrough routes passed all twelve tested native cases; their earlier
unified-endpoint field losses are not evidence that native preservation is impossible.

SDK/schema/SQLite choices are for implementation, not installed runtime changes. Node 22.13 is a
tested minimum API level, not an operational patch recommendation; its SQLite API is experimental.
Paired-control calibration, full host/schema/install and storage-cutover gates remain. Do not claim
the service refactor or release acceptance complete from the probes alone.

**Upgrade boundary:** drain and stop every old daemon, MCP and writing CLI process before running
this lock version. A legacy `owner.json` lock is never reclaimed automatically. Only after all
writers are confirmed stopped, remove a confirmed-stale `.lock` directory, not its protected state
JSON, and restart writers on one version. Do not mix versions during stale-lock recovery.

Offline refactor work does not wait for harness quota. Keep the continuation measurements below,
but implement continuation only after the daemon-owned job boundary is stable and the harness has
passed its evidence gates.

### Continuation work — still evidence-gated

Quota-independent continuation preparation is complete: the first-party survey, four exact-ID
interruption/resume probes and same-cwd two-job isolation probe are in `main`. Live verification
is blocked on harness/provider capacity. **Do not begin Phase 5.2 until one harness passes both
its single-job probe and `scripts/measure-continuation-isolation.mjs <harness>`.**

Subject to the refactor ownership boundary above, mark only a passing harness verified resumable,
then add the generic continuation substrate without changing behavior, and implement that harness
end to end before expanding support. AGY is the preferred first probe, then Claude; Codex
specifically tests active-turn durability. Other evidence/vendor/operator-blocked work can proceed
when its inputs become available.

The authoritative queue is [`docs/backlog.md`](docs/backlog.md). The continuation sequence and exit
conditions are in
[`docs/history/development-plan-2026-09-21.md`](docs/history/development-plan-2026-09-21.md).
The dated release audit is
[`docs/history/release-readiness-audit-2026-09-21.md`](docs/history/release-readiness-audit-2026-09-21.md).

## 1. What still binds

- **Loopback only; loopback is not authorization.** Keep request admission and control-token checks.
- **Metadata-only logs.** Never log headers, bodies or URL parameter values.
- **Repair form, not judgment.** Routing stays deterministic/configured; no LLM opinion enters the
  request path. Never invent intent to repair malformed protocol.
- **Destructive tool calls are refused, never fabricated.**
- **Health demotes, never drops.** Unhealthy candidates remain available for failover and recovery.
- **Unknown capability is not weak capability.** Missing evidence must not silently exclude a lane.
- **One logical attempt owns at most one live process incarnation.** Continuation must preserve this.

Authoritative rationale lives in `CLAUDE.md`, `docs/project-goals.md` and the relevant design records.

## 2. Where to read

| Document | Purpose |
|---|---|
| `docs/README.md` | Documentation index. |
| `docs/backlog.md` | Current unmet properties. |
| `docs/architecture-refactor-plan.md` | Target architecture, implementation sequence and acceptance criteria. |
| `docs/history/refactor-r1-decisions-2026-09-22.md` | Selected dependencies, native-wire evidence, performance budgets and R2 boundary. |
| `docs/history/refactor-baselines-and-dependencies-2026-09-22.md` | Runtime measurements, contract map and tested infrastructure choices. |
| `docs/history/refactor-r0-2026-09-21.md` | Initial R0 lock evidence and upgrade boundary. |
| `docs/history/development-plan-2026-09-21.md` | Earlier continuation preparation sequence and evidence gates. |
| `CLAUDE.md` | Detailed architecture, invariants and gotchas. |
| `docs/architecture.md` | Contributor source map. |
| `docs/reference.md` | Commands, configuration, APIs and caveats. |
| `docs/history/mcp-restart-safe-lane-execution-design-2026-09-20.md` | D1 design and evidence. |
| `docs/history/config-reload-design-2026-09-20.md` | D2 design and evidence. |
| `docs/history/active-hard-cap-lane-continuation-plan-2026-09-20.md` | Planned continuation feature. |
| `docs/history/active-hard-cap-harness-survey-2026-09-21.md` | Resume-capability matrix and probe gate. |
| `docs/history/stabilization-plan-2026-09-17.md` | Historical packets, not the live queue. |

## 3. Verification

```bash
npm run gate
```

The gate builds, type-checks source and tests, runs the core and dashboard suites, and checks the
package. CI also runs the targeted `windows-process-boundary` job for process, persistence and
Windows lifecycle behavior. The separate refactor evidence workflow runs synthetic baseline and
dependency probes; it does not replace this gate. Static analysis is advisory and outside the gate.

Scripts under `scripts/*.mjs` consume `dist/`; rebuild before running them. Tests read `src/`.
Update ratcheted package/bundle baselines with intentional size changes, leaving real headroom.
For documentation moves or additions, stage the paths before running the link tests: they read
the Git index.

Do not hide a regression by raising an arbitrary timeout or weakening an assertion. Establish
whether the mechanism is a source defect, a test defect or genuine timeout exhaustion first.

## 4. Definition of done

Run `npm run gate` on the final tree. Changes to spawning, processes, persistence or lifecycle
also need the Windows boundary suite. New behavior needs a regression that fails without the fix;
shared request policy needs all applicable fronts; failover tests need at least two candidates.

Update the backlog and handoff when a live property or immediate next step changes, and label
intermediate states explicitly. Record only checks actually performed. Keep dated measurements,
audits and closeouts in `docs/history/` and git history, not a release diary here.
