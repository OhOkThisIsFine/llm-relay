# HANDOFF

Entry point for any agent picking up llm-relay. Read this before `CLAUDE.md`.

## 0. Current state — 2026-09-21

The repository is on the published v0.86.0 baseline and is waiting on live continuation evidence.

- Published package version: **0.86.0**.
- `main` contains the architecture published in **v0.86.0**.
- Current `main` CI (run 779) is green:
  - 4,510 core tests passed, 4 skipped;
  - 46 dashboard tests passed;
  - 57 targeted Windows process-boundary/concurrency tests passed;
  - build, typecheck, package checks and packed-dashboard smoke passed.
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

### Immediate next

All quota-independent continuation preparation is complete: the first-party survey, four exact-ID
interruption/resume probes, and same-cwd two-job isolation probe are in `main`. Live verification
is currently blocked by harness/provider capacity. Do not begin Phase 5.2 until one harness passes
both its single-job probe and `scripts/measure-continuation-isolation.mjs <harness>`.

Audit evidence:
[`docs/history/release-readiness-audit-2026-09-21.md`](docs/history/release-readiness-audit-2026-09-21.md).

Work in this order:

1. when quota is available, run any documented exact-ID continuation probe (prefer AGY, then Claude; Codex specifically tests active-turn durability);
2. mark only a passing harness verified resumable;
3. then add the generic continuation substrate without changing behavior;
4. implement one verified harness end to end, then expand harness support independently;
5. clear evidence/vendor/operator-blocked items in parallel as their inputs become available.

Detailed sequence and exit conditions:
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
| `docs/history/development-plan-2026-09-21.md` | Current development sequence |
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
persistence and Windows-specific lifecycle behavior.

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
