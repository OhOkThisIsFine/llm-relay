# Development plan — 2026-09-21

**Status:** active sequencing plan.  
**Queue authority:** [`../backlog.md`](../backlog.md).  
**Current-state authority:** [`../../HANDOFF.md`](../../HANDOFF.md).

## Goal

Turn the large post-v0.85.0 `main` delta into a trustworthy released checkpoint, then resume feature
development from a clean baseline.

The ordering is intentional:

1. correctness evidence before new architecture;
2. repository enforcement before relying on CI as a merge gate;
3. a release checkpoint before another large subsystem change;
4. external/evidence-blocked work separated from source work;
5. active hard-cap continuation implemented incrementally, one verified harness at a time.

## Phase 1 — close the persistence-concurrency uncertainty

### Evidence

On 2026-09-21 the targeted Windows CI job failed twice in
`test/mcp-persistence-concurrency.test.ts`:

- run `35568330539` at `f5e7ff9`;
- run `35571358626` at `73c7ed0`.

In both cases the failing property was the real concurrent-process test that expects every distinct
journal/archive row to survive. One journal row was missing. Both commits were dependency-only laps;
later runs passed, including current `main`.

That pattern is evidence of unresolved nondeterminism in either the test/process synchronization or
the persistence path. It is not evidence that the dependency changes caused the failure.

### Work

1. **Stress the existing regression on Windows and Linux.**
   - Run the real multi-process case repeatedly, not just the in-process transaction unit.
   - Capture which row disappears, whether archive and journal differ, worker exit state, and lock
     ownership at failure.
2. **Make persistence failure observable in the regression path.**
   - Production journal writes may remain best-effort where that is an intentional contract.
   - Tests need a seam that distinguishes "transaction committed" from "failure swallowed", so a
     lost row cannot masquerade as ordinary execution.
3. **Classify the mechanism.**
   Investigate, in order:
   - journal owner/liveness filtering dropping a still-valid row;
   - lock acquisition/reclamation behavior on Windows;
   - a transaction/write failure hidden by best-effort persistence;
   - worker coordination allowing an owner to disappear before inspection;
   - filesystem rename/directory-lock semantics.
4. **Fix the mechanism, not the symptom.**
   Do not merely widen the 30 s MCP lock budget unless a captured failure proves lock timeout.
5. **Pin the actual failure mode.**
   Add or sharpen a regression that fails for the identified mechanism and passes with the fix.
6. **Stress after the fix.**
   Require repeated Windows and Linux runs with no missing non-conflicting row.

### Exit

The cross-process persistence property is considered closed only when:

- the mechanism of the observed CI failure is explained;
- the regression is deterministic enough to detect that mechanism;
- repeated supported-platform stress runs preserve every non-conflicting row;
- no write needed for that property can fail silently in the test harness.

## Phase 2 — make CI enforcement real

The repository already runs:

- `check`;
- `windows-process-boundary`.

Configure branch protection or a repository ruleset so both are required before `main` advances.

This is an administrator action, not a source packet.

### Exit

A deliberately failing PR cannot merge to `main` while either required check is red or missing.

## Phase 3 — establish the next release checkpoint

The published package is v0.85.0, while `main` contains a large subsequent body of work including
restart-safe daemon ownership, config hot reload, liveness/status changes, persistence changes,
capability derivation and the D5 toolchain upgrades.

Do not begin hard-cap continuation before this delta has a stable release boundary.

### Release-readiness pass

1. Review the v0.85.0 → `main` diff by subsystem rather than commit-by-commit.
2. Verify D1 from a real host:
   - start a daemon-owned lane;
   - terminate/restart the originating MCP host;
   - recover/collect the same execution from a replacement MCP process;
   - verify cancellation routes to daemon ownership.
3. Verify D2 against a live daemon:
   - apply a reload-safe change without changing PID;
   - reject a restart-only change atomically;
   - confirm the prior live configuration remains intact after rejection.
4. Verify the public liveness/status contract from an MCP client without relying on circumstantial
   process clues.
5. Run:
   - `npm run gate`;
   - targeted Windows process-boundary/concurrency coverage;
   - package/install smoke.
6. Reconcile README/reference/HANDOFF/backlog against observed behavior.
7. Cut and publish the next version.

### Exit

There is one published release containing the current architecture, with green Linux/package and
Windows lifecycle gates and no known unexplained persistence failure.

## Phase 4 — clear evidence, vendor and operator blockers

These tasks should not block ordinary source development once Phase 3 is complete, but they should
be closed when their external inputs exist.

### M1 — AGY envelope

- Obtain one raw archived first-party successful AGY envelope.
- Freeze only the observed schema in a fixture.
- Implement lane-specific unwrapping only if that schema supports it.
- Preserve raw archived stdout.
- Render provenance that the answer was unwrapped.
- Treat an empty inner response as empty output.

Do not infer the schema from prose or another client.

### Live host verification

Complete and record:

- >60 s dispatch through a freshly restarted MCP host;
- Codex Desktop `relay` agent with real `provenance:`;
- current behavior of chronically unsuccessful lanes before enabling/disabling changes;
- refusal/eligibility queue decisions.

### Route B

Wait for a supported OpenCode answer to the session-identity restriction. Do not spoof OpenCode's
own client identity. If no supported relay path exists, record the route as unsupported rather than
leaving it as a recurring pseudo-task.

## Phase 5 — active hard-cap continuation

Detailed design:
[`active-hard-cap-lane-continuation-plan-2026-09-20.md`](active-hard-cap-lane-continuation-plan-2026-09-20.md).

Implement it as separate packets.

### 5.1 Harness capability survey

For Claude, Codex, AGY and OpenCode, measure:

- whether an exact resumable session/conversation/thread ID exists;
- whether it is observable before normal process exit;
- the exact command/protocol required to resume that ID;
- whether resume preserves the same conversation semantics under concurrent jobs.

Never use "resume latest".

**Exit:** a table classifies each harness as verified resumable or unsupported/unknown, with captured
first-party evidence.

### 5.2 Model logical attempts separately from process incarnations

Introduce attempt-scoped continuation state without changing behavior.

Requirements:

- `LaneJob.attempts` continues to mean logical ladder attempts;
- a hard-cap rollover does not consume another rung or `maxLanes`;
- process incarnation metadata stays bounded and diagnostic;
- cancellation and ownership semantics remain unchanged.

### 5.3 Implement one harness end to end

Choose the harness with the strongest measured exact-resume support.

At an intentionally short hard cap:

1. take a fresh liveness reading;
2. if inactive, retain ordinary timeout behavior;
3. if active and resumable, terminate the owned process tree;
4. prove the old incarnation is gone;
5. resume the exact session on the same logical lane;
6. reset only the per-incarnation hard-cap timer.

**Hard invariant:** two incarnations of one logical attempt must never overlap.

### 5.4 Preserve routing continuity safely

Use a logical-attempt continuity identity to preserve the existing backend where possible.

Continuity may improve cache/session locality, but it must never override current health, quota,
eligibility or safety evidence.

### 5.5 Settle telemetry and scoring once

A rollover is lifecycle management, not failure evidence.

- emit one final logical-attempt outcome;
- do not increment lane failure history for a successful rollover;
- expose bounded rollover count/reason diagnostics;
- make continuation-budget exhaustion explicit.

### 5.6 Expand harness support independently

Add each additional harness only after its own exact-resume behavior is measured and regression
tested. Unsupported harnesses keep the current timeout semantics.

## Development sequence

| Order | Packet | Kind | Gate to advance |
|---|---|---|---|
| 1 | Persistence-concurrency investigation/fix | source correctness | mechanism explained + stress green |
| 2 | Required CI checks on `main` | repository admin | merge blocked when either check fails |
| 3 | Release-readiness audit and release | verification/release | current architecture published |
| 4 | M1 and live/vendor/operator blockers | evidence/operations | close as inputs become available |
| 5 | Continuation harness survey | design/evidence | exact-resume matrix exists |
| 6 | Continuation substrate | source | no behavior change, gate green |
| 7 | First harness continuation | source | active rollover proved end to end |
| 8 | Routing continuity + telemetry | source | logical-attempt semantics preserved |
| 9 | Additional harnesses | source | one measured adapter at a time |

## Non-goals

- Do not reopen completed D1/D2/D5/D6 work without new evidence.
- Do not increase test timeouts as a substitute for identifying concurrency mechanisms.
- Do not implement AGY parsing from an assumed envelope.
- Do not spoof vendor client/session identity.
- Do not combine the release checkpoint with hard-cap continuation.
- Do not turn `HANDOFF.md` back into a release diary; dated evidence belongs in `docs/history/`.
