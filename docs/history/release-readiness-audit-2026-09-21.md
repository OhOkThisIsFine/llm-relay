# Release-readiness audit — 2026-09-21

**Scope:** `v0.85.0` (`de4569d`) → release candidate `v0.86.0`.  
**Delta:** 85 commits from the v0.85.0 tag to the audited `main` head `950db9c`.  
**Status:** complete; v0.86.0 published successfully from tag `v0.86.0` at `9e30cac`.

## Findings

| Subsystem | Evidence | Verdict |
|---|---|---|
| Daemon-owned MCP execution (D1) | `test/mcp-broker-process-boundary.test.ts` kills only the originating MCP process, proves the daemon-owned lane survives, collects the same result from a replacement MCP process, and proves replacement cancellation terminates the owned lane tree. | Release-ready |
| Config hot reload (D2) | `test/config-reload-process.test.ts` keeps one daemon PID across a reload-safe routing change, then rejects a restart-only provider-base change and proves the previously accepted live config remains intact. | Release-ready |
| Public dispatch/liveness contract | `test/mcp-restart-report.test.ts` exposes authoritative `walk-verdict` state across restart; broker transport loss remains `running`/unavailable rather than being guessed dead. | Release-ready |
| Cross-process MCP persistence | PR #64 preserves foreign rows, fails closed on unreadable transactional JSON, and retries the released-lock contention race. Release-gate run 758 then exposed a separate Windows atomic-commit failure: `rename(tmp, target)` can transiently return `EPERM` even while the transaction lock is correctly held. The release candidate now retries only `EPERM`/`EACCES`/`EBUSY` replacement renames on Windows, for a bounded ~1 s schedule, while retaining the same temp file and lock. | Re-verify on Windows |
| Capability routing | `test/dispatch.test.ts` derives capability from synced model evidence or pool bands; unknown evidence remains unknown and legacy manual capability has no routing authority. | Release-ready |
| Failure escalation/failover | Circuit-breaker and pool-failover regressions keep repeated 402/5xx escalation bounded and treat demotion as ordering evidence, never eviction. Multi-candidate tests prove failover remains available. | Release-ready |
| Toolchain/dashboard/package checks | D5 upgrades are complete. `npm run gate` builds first, then runs server/test typechecks, the core suite, dashboard checks and package checks. | Release-ready |
| Windows lifecycle/process boundary | Required CI job covers Windows shim resolution, lane spawning/lifecycle, MCP persistence concurrency, broker process boundary and CPU activity. | Release-ready |

## CI evidence

PR #64 final head `87485aa` ran CI **754** successfully:

- `check`: success;
- `windows-process-boundary`: success.

The default-branch ruleset requires both checks and has no bypass actors.

### Release-gate follow-up

A later docs-only PR (#66) made the repeated Windows regression fire again in CI run **758**. The
failure was not another unlocked read/merge/rewrite race: the worker had entered the serialized
transaction and failed at the final atomic replacement:

```
EPERM: operation not permitted, rename '<mcp-jobs>.tmp' -> 'mcp-jobs.json'
```

This is a documented Windows/Node failure mode when a short-lived external reader holds the target
file. The repair retries only transient Windows replacement errors (`EPERM`, `EACCES`, `EBUSY`)
for a bounded ~1 second while retaining both the transaction lock and the same temp file. It never
unlinks the destination first, so readers continue to see either the old complete JSON or the new
complete JSON. Unit tests pin transient recovery, fail-fast boundaries, and retry exhaustion; the
real four-process Windows regression remains the end-to-end proof.

## Documentation reconciliation

One stale statement in `docs/reference.md` said the walk could stop a lane at a generic “time
budget.” Current behavior is narrower: walk advancement stops an attempt only for apparent
idleness; an active attempt may still be terminated by its own absolute lane timeout. The release
candidate corrects that wording. Active hard-cap continuation remains a separate, unreleased
feature plan.

## Publication gate

The tag-triggered `.github/workflows/publish.yml` is intentionally the final artifact gate. Before
`npm publish`, it:

1. proves the tag commit is contained in the default branch;
2. proves the tag matches `package.json`;
3. builds the package;
4. packs and installs the artifact in a clean directory;
5. verifies the binary, tier data and bundled skill are present and usable;
6. runs a negative missing-asset probe;
7. runs `npm run check`;
8. only then publishes through npm Trusted Publishing.

That clean packed-artifact install smoke cannot be claimed for v0.86.0 until the release tag runs.
The release is therefore not complete until the publish workflow succeeds.

## Deliberately outside this release gate

The separate owner/operator checks in `docs/backlog.md` remain open: a >60 s dispatch through a
freshly restarted external MCP host, Codex Desktop `relay` provenance, chronically unsuccessful
lane review, and refusal/eligibility decisions. They are operational evidence tasks, not unverified
source behavior hidden inside this release candidate.

## Publication closeout

Publish run **167** completed successfully for tag `v0.86.0` at `9e30cac`. The workflow passed:

- default-branch ancestry verification;
- package/tag version agreement;
- build;
- clean packed-artifact install and runtime asset smoke;
- negative missing-asset detection;
- `npm run check`;
- `npm publish --access public`.

This closes the post-v0.85.0 release-readiness property.
