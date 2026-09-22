# HANDOFF

Entry point for any agent picking up llm-relay. Read this before `CLAUDE.md`.

## 0. Current state — 2026-09-22

**The owner has redirected the refactor to adoption-first, full-agent dispatch.** The target is
Claude Desktop / Codex Desktop → upstream `opencode-mcp` → an independently managed OpenCode
worker → the standard LiteLLM proxy → approved endpoints. AX is excluded for now.

Follow [`docs/architecture-refactor-plan.md`](docs/architecture-refactor-plan.md). It replaces the
custom RequestService/DispatchService/SQLite plan and the R1 decision to retain custom execution.
Repair and parity with every legacy relay feature are not replacement requirements. The selected
stack has not been qualified in the owner's desktop applications or installed by this plan.

The runtime is still the existing **v0.86.0** architecture plus merged fixes and documentation:

- Reviewed baseline: `cf6d16b`, incorporating PRs #74, #75 and #72. Its file tree matched the
  reconciled PR #72 tree that passed CI **808**. This is historical evidence, not a final-tree
  gate result for subsequent work.
- R0 fixed unsafe stale-lock reclamation. The new native Responses fidelity comparison exposed
  an existing translation defect; it remains unfixed while that old route is reachable.
- D1 daemon-owned lane execution survives an MCP host restart while the daemon remains alive;
  it is not whole-job recovery after daemon death. Explicit transactional reload and public
  activity/liveness state remain implemented.
- Runtime/dependency probes and gateway comparisons exist. They neither install the selected
  replacement nor certify combined OpenCode/LiteLLM dispatch.
- No new RequestService, whole-job DispatchService, operational SQLite migration or automatic
  hard-cap continuation has been implemented. Production dependencies and release version are
  unchanged by the adoption plan.

### Immediate next — prove the adopted stack

Start with **A0**, the compact inventory of actual hosts, workspaces, endpoints/authentication,
required tools, spending constraints and owned host wiring. Then **A1** qualifies a pinned
OpenCode/LiteLLM/bridge version set through real multistep delegation from both desktop hosts.
Use the plan's acceptance matrix: full tool execution, useful progress/results, follow-up,
required input, cancellation and host-disconnect survival. Do not substitute model-only demos.

Do not resume the old R2/R3/R4 custom-service work or make old proxy performance calibration a
prerequisite to the pilot. Do not invent a new MCP server, job store, agent loop or configuration
framework when the selected upstream already supplies the responsibility. Packaging follows a
working vertical slice. Missing live credentials/quota are unverified acceptance items, not a
reason to write a substitute runtime.

Keep OpenCode independent of the host/bridge lifetime; the bridge's auto-started child does not
provide that guarantee. Account for actual native/subscription destinations instead of assuming
an API model connection supplies every CLI entitlement. Record changed retention semantics:
OpenCode sessions can retain full task content. Both points are migration decisions, not grounds
to rebuild every old feature.

### Legacy runtime and upgrade boundary

The old runtime's safety and privacy behavior still binds while it is deployed. For target-design
conflicts, the September 22 project-goals amendment and current adoption plan take precedence over
legacy topology, repair and policy prescriptions in `CLAUDE.md` or historical documents. Do not
silently relax operator access/spending restrictions or claim a retired defect was repaired.

Drain and stop every old daemon, MCP and writing CLI process before running a different lock
version. Legacy `owner.json` locks are not reclaimed automatically. Only after all writers are
confirmed stopped may a confirmed-stale `.lock` directory be removed; preserve the protected state
JSON. Do not mix versions during stale-lock recovery. Evidence:
[`docs/history/refactor-r0-2026-09-21.md`](docs/history/refactor-r0-2026-09-21.md).

### Deferred continuation work

Exact-ID and same-cwd isolation probes remain available, but no harness is certified by both in
the recorded evidence. Universal hard-cap continuation is not an adoption prerequisite. Use
supported upstream follow-up/recovery behavior honestly; persisted sessions do not prove automatic
recovery of an interrupted execution. Only revisit custom continuation for an actual remaining
need after adoption. Historical measurements remain evidence, not the active work sequence.

The authoritative unmet-property queue is [`docs/backlog.md`](docs/backlog.md).

## 1. What still binds

- Full-agent dispatch must not become a text-only fallback or a parent-driven tool loop.
- Use authenticated local service connections; keep provider credentials out of prompts and
  routine diagnostics. Distinguish sensitive session storage from metadata-only logs.
- Preserve explicit access and spending restrictions, or expose unmapped requirements before
  cutover. Unknown is not zero, success or authorization.
- Do not duplicate a possibly accepted task, infer completion from silence, or silently replay
  uncertain side effects. Stopping observation and cancelling work are different operations.
- Do not overwrite unrelated user files, host settings, worktrees or credentials during setup,
  testing, migration or rollback.
- Apply retained-runtime safety regressions until their corresponding paths are actually retired.

## 2. Where to read

| Document | Purpose |
|---|---|
| `docs/architecture-refactor-plan.md` | Authoritative adoption architecture, A0–A4 sequence, acceptance and migration. |
| `docs/project-goals.md` | September 22 owner amendment and earlier goals. |
| `docs/backlog.md` | Active adoption work, legacy obligations and deferred items. |
| `docs/README.md` | Documentation index. |
| `CLAUDE.md` | Existing runtime source map and invariants; not the replacement architecture. |
| `docs/architecture.md`, `docs/reference.md`, `docs/QUICKSTART.md` | Current runtime/user behavior until cutover. |
| `docs/history/refactor-r1-decisions-2026-09-22.md` | Superseded implementation choice; retained comparison evidence. |
| `docs/history/refactor-baselines-and-dependencies-2026-09-22.md` | Historical probes and contract map, not new adoption gates. |
| `docs/history/refactor-r0-2026-09-21.md` | Lock fix and safe legacy upgrade boundary. |
| `docs/history/active-hard-cap-harness-survey-2026-09-21.md` | Historical continuation evidence and limits. |

## 3. Verification

```bash
npm run gate
```

The current gate builds, type-checks source/tests, runs the core/dashboard suites and checks the
package. CI also runs targeted Windows process/persistence checks. Keep applicable gates for
retained code; replace obsolete tests only with the implementation/feature deletion they follow.
Do not weaken live safety assertions or raise arbitrary timeouts to hide a failure.

Most measurement scripts consume `dist/`; rebuild first. Stage document additions/moves before
link tests, which use the Git index. Package/bundle baseline changes must be intentional and
measured. Static analysis remains advisory. New stack acceptance is an additional end-to-end
check, not inferred from the old suite or upstream CI.

## 4. Definition of done

Report the exact tree, local checks, GitHub CI and live-host checks separately. A planning change
is done when its documentation is consistent and verified; it does not mean adoption is complete.
Runtime adoption is done only after both hosts pass the plan's full-task workflow, migration and
rollback are rehearsed, and superseded execution machinery is deleted. Keep detailed evidence in
the PR or dated history, not a duplicate work sequence here.
