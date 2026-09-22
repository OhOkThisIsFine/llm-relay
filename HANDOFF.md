# HANDOFF

Entry point for any agent picking up llm-relay. Read this before `CLAUDE.md`.

## 0. Current state — 2026-09-21

The repository is on the published **v0.86.0** baseline. Active hard-cap continuation remains
unimplemented and gated on live harness evidence.

Implemented in `main`:

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

Verified checkpoint: `078b9a9` (PR #71), CI run **784**, passed on 2026-09-21. This is a recorded
baseline, not a claim about later commits; check GitHub CI for the tree being changed.
PRs #70 and #71 contain the earlier documentation/comment cleanup and its checkpoint.

### Immediate next

Quota-independent continuation preparation is complete: the first-party survey, four exact-ID
interruption/resume probes and same-cwd two-job isolation probe are in `main`. Live verification
is blocked on harness/provider capacity. **Do not begin Phase 5.2 until one harness passes both
its single-job probe and `scripts/measure-continuation-isolation.mjs <harness>`.**

Then mark only that harness verified resumable, add the generic continuation substrate without
changing behavior, and implement the verified harness end to end before expanding support.
AGY is the preferred first probe, then Claude; Codex specifically tests active-turn durability.
Other evidence/vendor/operator-blocked work can proceed when its inputs become available.

The authoritative queue is [`docs/backlog.md`](docs/backlog.md). The sequence and exit conditions
are in [`docs/history/development-plan-2026-09-21.md`](docs/history/development-plan-2026-09-21.md).
The dated release audit is
[`docs/history/release-readiness-audit-2026-09-21.md`](docs/history/release-readiness-audit-2026-09-21.md).

## 1. What still binds

- **Loopback only; loopback is not authorization.** Keep request admission and control-token checks.
- **Metadata-only logs.** Never log headers, bodies or URL parameter values.
- **Repair form, not judgment.** Routing stays deterministic/configured; never fabricate destructive
  tool calls or invent intent to repair malformed protocol.
- **Health demotes, never drops.** Unhealthy candidates remain available for failover and recovery.
- **Unknown capability is not weak capability.** Missing evidence must not silently exclude a lane.
- **One logical attempt owns at most one live process incarnation.** Continuation must preserve this.

Authoritative rationale lives in `CLAUDE.md`, `docs/project-goals.md` and the relevant design records.

## 2. Where to read

| Document | Purpose |
|---|---|
| `docs/README.md` | Documentation index. |
| `docs/backlog.md` | Current unmet properties. |
| `docs/history/development-plan-2026-09-21.md` | Development sequence and evidence gates. |
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
Windows lifecycle behavior. Static analysis is advisory and outside the gate.

Scripts under `scripts/*.mjs` consume `dist/`; rebuild before running them. Tests read `src/`.
Update ratcheted package/bundle baselines with intentional size changes, leaving real headroom.
For documentation moves or additions, stage the paths before running the link tests: they read
the Git index.

Do not hide a regression by raising an arbitrary timeout or weakening an assertion. Establish
whether the mechanism is a source defect, a test defect or genuine timeout exhaustion first.

## 4. Definition of done

Run `npm run gate` on the final tree. Changes to spawning, processes, persistence or lifecycle
also need the Windows boundary suite. New behavior needs a regression that fails without the fix;
shared request policy needs both fronts; failover tests need at least two candidates.

Update the backlog and handoff when a live property or immediate next step changes, and label
intermediate states explicitly. Record only checks actually performed. Keep dated measurements,
audits and closeouts in `docs/history/` and git history, not a release diary here.
