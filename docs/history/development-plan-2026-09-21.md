# Development plan — 2026-09-21

**Status:** active sequencing plan.  
**Queue authority:** [`../backlog.md`](../backlog.md).  
**Current-state authority:** [`../../HANDOFF.md`](../../HANDOFF.md).

## Goal

Finish the remaining live evidence gates, then implement active hard-cap continuation one verified
harness at a time without weakening process ownership, routing, or telemetry semantics.

Phases 1–3 below are complete and retained as evidence. Active sequencing is:

1. close external/operator evidence when inputs are available;
2. verify at least one harness with both exact-resume and same-cwd isolation measurements;
3. add behavior-neutral continuation state;
4. implement one verified harness end to end;
5. expand routing continuity, telemetry, and additional harnesses incrementally.

## Phase 1 — persistence-concurrency uncertainty — completed 2026-09-21

Three Windows CI failures established that the real multi-process persistence property was not
stable:

- run `35568330539` lost one journal row;
- run `35571358626` lost one archive row;
- run `35635993384` lost one journal row.

The commits that happened to trigger those runs were unrelated to MCP persistence.

The investigation found three correctness holes:

1. **Unrelated journal writes performed liveness-based garbage collection.** A normal journal
   mutation preserved only foreign rows whose owner passed a process-liveness probe. That made a
   false-negative liveness read destructive, and it also allowed a genuinely dead owner's recovery
   row to disappear before a replacement MCP process adopted it.
2. **Transactional reads failed open.** `transactionalUpdateJsonSync(..., strict: true)` still read
   through `safeReadJsonSync`, which maps any read/parse/validation failure to `null`. An existing
   but temporarily unreadable or invalid file could therefore be treated as empty and replaced with
   a partial new snapshot. This defect applied equally to journal and archive.
3. **Lock acquisition had a release-after-contention TOCTOU.** A contender could fail
   `rename(claim, lock)` because the incumbent lock existed, then the incumbent could release the
   lock before the contender called `existsSync(lockPath)`. The old code propagated the now-stale
   rename error instead of retrying. Journal persistence is intentionally best-effort, so that
   transaction error was swallowed and surfaced only later as a missing row. The race is now pinned
   deterministically by removing the incumbent lock in exactly that inspection gap.

The fix:

- ordinary journal writes preserve every foreign row without a liveness probe;
- dead startup-orphan rows are removed only after durable terminal adoption, matched against the
  exact startup row identity;
- transactional updates distinguish true `ENOENT` from read/parse/validation failure and fail
  closed on the latter;
- a contender retries when a contention-shaped rename error is followed by a vanished stable lock,
  rather than propagating the stale error;
- the real worker fixture verifies that its own journal/archive mutation actually committed, so a
  swallowed persistence failure is reported at the worker rather than only as a later missing-row
  assertion;
- deterministic tests pin all three mechanisms and orphan acknowledgement ordering;
- the real four-process journal+archive regression now runs five independent rounds per CI
  execution.

No timeout was increased.

Exit evidence on the repaired source:
- Windows run 750 completed its targeted job green after the lock fix;
- run 751 passed both `check` and `windows-process-boundary` with the deterministic lock test;
- run 752 passed both required jobs with the repeated five-round real-process stress test.
The final documentation head must pass both required checks again before merge.

## Phase 2 — CI enforcement — completed 2026-09-21

Repository ruleset `Protect main` is active for the default branch. It requires a pull request and
both status checks:

- `check`;
- `windows-process-boundary`.

The ruleset has no bypass actors and does not require the branch to be rebased to the latest
`main` before merge.

## Phase 3 — establish the next release checkpoint — completed 2026-09-21

**Completed:** v0.86.0 was tagged at `9e30cac` and publish run 167 succeeded. The publish
workflow verified that the tag is contained in `main`, matched `package.json`, built successfully,
passed the clean packed-artifact install/asset smoke, passed `npm run check`, and completed
`npm publish --access public`.

The release gate itself found and forced repair of a transient Windows atomic replacement failure:
`rename(tmp, target)` could return `EPERM` after the transaction lock had serialized the writer.
The final source retries only transient Windows replacement errors for a bounded interval while
retaining the same temp file and lock; PR #66 and post-merge main CI both passed
`windows-process-boundary` and `check`.

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

**First-party survey and repeatable measurement tooling complete:** see
[`active-hard-cap-harness-survey-2026-09-21.md`](active-hard-cap-harness-survey-2026-09-21.md).
Manual probes now exist for AGY, Claude, Codex and OpenCode and share one shell-free process/NDJSON
helper. The remaining gate is live evidence: no harness is implementation-ready until both its
exact-ID interruption/resume probe and same-cwd isolation probe succeed. Phase 5.2 remains
intentionally blocked while quota/provider capacity prevents those measurements.

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
| 1 | Persistence-concurrency investigation/fix | source correctness | **complete** |
| 2 | Required CI checks on `main` | repository admin | **complete** |
| 3 | Release-readiness audit and release | verification/release | **complete — v0.86.0 published** |
| 4 | M1 and live/vendor/operator blockers | evidence/operations | close as inputs become available |
| 5 | Continuation harness survey + probe tooling | design/evidence | **tooling complete; live exact-resume + isolation result pending** |
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
