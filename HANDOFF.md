# HANDOFF

Entry point for any agent picking up llm-relay. Read this before `CLAUDE.md`.

## 0. Current state — 2026-09-21

The repository is in a consolidation phase after a large post-v0.85.0 development run.

- Published package version: **0.85.0**.
- `main` is the **v0.86.0 release candidate**, containing the post-v0.85.0 architecture audited
  in `docs/history/release-readiness-audit-2026-09-21.md`; npm publication is still pending.
- Current `main` CI is green:
  - 4,490 core tests passed, 4 skipped;
  - 46 dashboard tests passed;
  - 51 targeted Windows process-boundary/concurrency tests passed;
  - build, typecheck, package checks and packed-dashboard smoke passed.
- D1 restart-safe daemon-owned lane execution is implemented.
- D2 transactional config hot reload is implemented.
- Public dispatch/liveness state is explicit rather than inferred from circumstantial clues.
- Multi-process journal/archive mutations use cross-process transactional locking. The 2026-09-21
  Windows row-loss investigation also made transactions fail closed on unreadable existing JSON
  and stopped unrelated journal writes from garbage-collecting foreign rows.
- Lane capability is derived from synced model evidence/pool bands; the legacy hand-set capability
  value has no routing authority.
- Repeated 402/5xx failures use bounded recovery escalation and remain eligible for failover.
- D5 dependency modernization is complete: Vitest 5, Vite 8, jsdom 30, Tailwind 4, native
  TypeScript 7 compilation, jest-dom 7 and lucide-react 1. Node declarations intentionally remain
  on the Node 22 line while Node 22 is supported.

### Immediate next

The post-v0.85.0 subsystem audit is complete and **v0.86.0 is on `main`**. PR #65 passed both
required checks before merge. The remaining release gate is the `v0.86.0` tag: its publish workflow
must pass the clean packed-artifact install smoke and publish npm.

Audit evidence:
[`docs/history/release-readiness-audit-2026-09-21.md`](docs/history/release-readiness-audit-2026-09-21.md).

Persistence and repository enforcement are no longer blockers:
- the concurrency investigation found three correctness holes: unrelated journal writes filtered
  foreign rows through liveness; transactional reads could silently treat an existing
  unreadable/invalid JSON file as empty; and a lock contender propagated a stale rename error when
  the incumbent released the lock between the failed rename and the contender's path inspection;
- the lock-release race now has a deterministic regression, and the real four-process
  journal+archive regression runs five independent rounds per CI execution;
- the regression fixture surfaces per-worker journal/archive commit failures instead of hiding them
  until the final assertion;
- repository ruleset `Protect main` is active on the default branch and requires both `check` and
  `windows-process-boundary`, with no bypass actors.

Work in this order:

1. push `v0.86.0` and require the publish workflow's packed-artifact smoke and npm publish to succeed;
2. record the published checkpoint in the live docs;
3. clear evidence/vendor/operator-blocked items as their inputs become available;
4. begin active hard-cap continuation as staged, harness-specific work.

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
