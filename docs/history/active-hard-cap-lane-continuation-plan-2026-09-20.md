# Active hard-cap lane continuation — implementation plan (2026-09-20)

**Status:** planned; not implemented.

## Goal

A hard runtime ceiling should end a **process incarnation**, not necessarily the **logical lane attempt**.

Today an MCP-dispatched lane has an absolute `timeoutMs` (default 30 minutes). When that timer fires, the process tree is killed and the lane is reported as `timed_out`, even if first-party liveness evidence says the lane was still actively working. That loses useful work and also feeds a timeout into lane reliability history.

The desired behavior is:

1. if the lane reaches its hard cap and is idle/unhealthy, keep the current timeout behavior;
2. if it reaches the cap while demonstrably active and the harness supports exact-session resume, terminate that process incarnation, resume the same harness session on the same lane, reset the per-incarnation timer, and continue the same logical attempt;
3. preserve the same actual relay backend where possible, so a resumed process retains routing continuity and has the best chance of benefiting from provider-side caching;
4. report and score only the final logical outcome, not each internal rollover.

The core invariant is:

> **An active hard-cap rollover is lifecycle management, not lane-failure evidence.**

## Terminology

- **job** — the existing `LaneJob`: one MCP dispatch/walk, addressed by one `jobId`.
- **logical lane attempt** — one rung in that walk. It may span more than one process.
- **incarnation** — one concrete spawned harness process belonging to a logical lane attempt.
- **continuation** — terminating an active incarnation at its hard cap and resuming the exact harness session in a new incarnation.
- **continuity id** — a relay-owned identifier stable for the logical attempt, used to preserve backend affinity across incarnations.

## Existing behavior to preserve

The implementation must not disturb these current contracts:

- host MCP-call ceilings and lane runtime ceilings remain separate;
- `dispatch` may return a pollable `jobId` while the lane continues;
- the walk advances on a lane that becomes genuinely idle when another usable rung remains;
- the last lane is never idle-stopped merely because there is nowhere else to go;
- cancellation stops the job rather than advancing or resuming it;
- process-tree ownership/reaping remains authoritative;
- `LaneJob.attempts` describes logical ladder attempts, not subprocess details;
- lane telemetry is forwarded once per settled logical attempt;
- affinity never resurrects a target that present health/quota evidence says is unavailable.

## 1. Model process incarnations separately from logical attempts

Do **not** add hard-cap rollovers to `LaneJob.attempts[]`. That array answers "which ladder rungs did this job try?" A restarted process on the same rung is still the same logical attempt.

Add attempt-scoped continuation metadata, for example:

```ts
interface LaneContinuationState {
  harness: LaneHarness;
  sessionId: string;
  continuityId: string;
  incarnation: number;      // 1-based
  resumed: number;          // successful rollovers
  firstStartedAt: number;   // start of the logical attempt
  incarnationStartedAt: number;
}
```

The exact placement may be a nested field on `LaneJob` or an MCP-server-owned map if keeping ephemeral process metadata out of the core persisted shape is cleaner. The public job surface should expose only useful diagnostics, not raw internal identifiers.

A continuation rollover must not increment the walk's tried-lane count, consume `maxLanes`, or cause `setCurrentLane` to move to another rung.

Primary files:

- `src/mcp/lane-runner.ts`
- `src/mcp/server.ts`

## 2. Introduce harness-specific continuation adapters

Create one module responsible for answering three questions:

1. does this invocation belong to a harness whose sessions can be resumed safely?
2. can the relay capture the **specific** session identity for this invocation?
3. how is a new invocation constructed to resume that exact session?

Suggested shape:

```ts
interface LaneContinuationAdapter {
  identify(invoke: LaneInvocation): boolean;
  observe(chunkOrEvent: unknown): string | null;
  resumeInvoke(
    original: LaneInvocation,
    sessionId: string,
    continuationPrompt: string,
  ): LaneInvocation;
}
```

Likely initial harnesses are the CLI families already used as lanes: Claude, Codex, AGY and OpenCode. Each adapter must be independently gated on verified behavior.

### Safety rule: never resume "latest"

Automatic continuation is enabled only when the relay has a specific session/conversation/thread identifier attributable to this exact process.

Do not use a harness's "continue latest" facility. Multiple concurrent jobs may share a working directory and configuration; "latest" creates a race in which one job can resume another job's conversation.

If exact identity cannot be captured, the lane remains non-resumable and falls back to ordinary timeout behavior.

## 3. Capture session identity before successful exit

A killed process cannot provide metadata only emitted at normal completion, so session identity must be observable early in the invocation.

Extend the spawn/launch seam so a continuation adapter can inspect machine-readable process output while it is running. This is separate from the existing byte-count activity observer:

```ts
interface LaneSpawnOptions {
  ...
  onOutput?: (...) => void;
  onProtocolEvent?: (event: unknown) => void;
}
```

The adapter parser should retain only bounded metadata required for continuation. Do not turn arbitrary model/tool output into relay state.

Where a harness requires structured/streaming output to expose a session id, normalize its eventual answer back into the existing `LaneRunResult.stdout` contract so callers and renderers do not have to understand every harness protocol.

Requirements:

- capture the canonical session id as early as possible;
- bind it to the owning job/incarnation, never to cwd alone;
- do not overwrite a previously captured canonical id merely because a resumed invocation emits another invocation-local identifier;
- parser failure must disable continuation for that attempt rather than fail the lane.

Primary files:

- new `src/mcp/lane-continuation.ts`
- `src/mcp/lane-runner.ts`
- `src/mcp/server.ts`

## 4. Move resumable hard-cap policy above the subprocess timeout

At present, the spawner owns `timeoutMs`; by the time `runOneLane()` sees `timedOut: true`, the process has already been killed. That is too late to decide whether active work deserves continuation.

For a resumable lane, make `runOneLane()` own the incarnation deadline.

At the deadline:

1. perform a **fresh** liveness read using the same first-party activity sources the walk already trusts;
2. decide whether the attempt is active enough to continue;
3. only then terminate or classify it.

Decision table:

| State at hard cap | Resume identity | Continuation budget | Action |
|---|---|---|---|
| idle/unhealthy | any | any | kill; ordinary timeout/failure handling |
| active | unavailable | any | kill; ordinary timeout with explicit "continuation unavailable" diagnostic |
| active | available | exhausted | kill; end logical attempt as continuation-policy exhaustion |
| active | available | available | kill incarnation; verify reaped; resume exact session on same lane |

### Freshness threshold

The continuation decision must reuse the walk's liveness evidence rather than invent a second activity system.

For a lane already subject to idle monitoring, use the same `idleMs` baseline/activity evidence.

For the last/forced lane, where `idleMs` is currently null because it must not be idle-stopped, still retain a configured freshness window for the **continuation decision only**. That window must not cause an early stop; it only answers whether activity observed near the absolute deadline is fresh enough to justify another incarnation.

A fresh "active" signal extends execution only at the hard-cap boundary. It does not otherwise change walk behavior.

## 5. Never overlap two incarnations

Continuation must be serialized:

1. request termination of the current owned process tree;
2. await/observe its settlement;
3. enumerate the owned root PIDs;
4. verify that no survivor remains;
5. only then spawn the resumed incarnation.

If any survivor remains, do **not** start the replacement. Two agents from the same logical attempt concurrently editing the same worktree is a worse failure mode than losing continuation.

Reuse the existing process-tree ownership and survivor reporting instead of creating an independent process-discovery mechanism.

Cancellation wins at every boundary:

- cancellation before the deadline: ordinary cancel;
- cancellation while the old incarnation is being reaped: do not spawn the new incarnation;
- cancellation after resume spawn: kill the new owned process as usual.

## 6. Resume state rather than replaying the task from scratch

The resumed process must keep:

- the same lane/rung;
- the same cwd;
- the same read-only binding;
- the same configured model/agent;
- the same environment corrections;
- the same depth/scope/system/schema/max-token options;
- the same logical job and tree-delta baseline.

The continuation prompt should be short and procedural, for example:

> Continue the previous task from where you left off. The prior process was terminated only because its runtime ceiling was reached. Preserve completed work in the current worktree and continue the existing task.

Do not resend the original task as if this were a fresh conversation. The harness session carries conversational state, and the worktree carries completed filesystem work.

If a harness's resume syntax inherently continues without an additional user prompt, prefer that native behavior; the adapter owns the difference.

## 7. Preserve lane and backend affinity

An active hard-cap rollover must first resume on the **same lane**. The hard cap itself is not negative evidence and must not advance the dispatch ladder.

For relay-backed pool lanes, same lane does not necessarily mean same provider/model. Add a relay-owned continuity identity to requests emitted by resumed incarnations.

Prefer a dedicated internal header/identity, for example:

```
x-llm-relay-continuity: <opaque-logical-attempt-id>
```

It should be injected by the lane launch path alongside the existing activity tag, not supplied by the model.

Use the existing sticky-session machinery as the basis for continuity affinity:

```
continuity id -> concrete provider/model target
```

Properties:

- created/learned for the logical attempt;
- reused across every incarnation;
- cleared/allowed to expire when the logical attempt ends;
- applies only as a preference among currently usable candidates;
- quota exhaustion, breaker state, eviction and other stronger availability evidence still win.

This is partly a cache optimization, but the correctness reason is conversational/routing continuity. Provider-side prompt-cache reuse is beneficial when available but must not be assumed.

Likely files:

- `src/session-pin.ts` or a new sibling module
- `src/candidate-runner.ts`
- `src/server.ts`
- `src/mcp/server.ts`

## 8. Add a whole-logical-attempt safety bound

Resetting the incarnation timeout on every active continuation must not create an immortal job.

Keep separate controls for:

- **incarnation timeout** — current `timeoutMs`, reset on each successful resume;
- **logical-attempt limit** — bounds total continuation.

Suggested configuration under `routing.mcp`:

```json
{
  "continuation": {
    "enabled": true,
    "maxRestarts": 2,
    "maxJobMs": 7200000
  }
}
```

Exact defaults should be chosen during implementation/testing, not guessed into the initial code.

Semantics:

- `maxRestarts` caps how many new process incarnations one logical lane attempt may create;
- `maxJobMs` caps total wall clock across all incarnations;
- hitting either while still active ends the logical attempt as **continuation-policy exhaustion**, not as evidence that the lane became unhealthy;
- operator cancellation and existing walk rules remain independent.

Config validation should be fail-closed for malformed explicit values and backward compatible when the section is absent.

Primary files:

- `src/config-types.ts`
- `src/config.ts`
- `config.example.json`

## 9. Keep telemetry logical, not process-oriented

A lane that runs:

```
30m -> active rollover -> 30m -> active rollover -> completes at 75m
```

should contribute one logical result:

```
calls: +1
successes: +1
failures: +0
timeouts: +0
time-to-answer sample: 75m
continuations: 2   // diagnostic, if persisted
```

It must not contribute two timeout failures followed by a success.

Therefore:

- do not call the existing attempt telemetry forwarder for an internal rollover;
- do not increment `consecutiveFailures`;
- do not create a timeout-driven lane demotion;
- measure logical elapsed wall clock from `firstStartedAt`, not the final incarnation start;
- retain separate diagnostic events/counters for rollover behavior.

Useful diagnostic counters:

- hard-cap reached while active;
- continuation attempted;
- continuation resumed successfully;
- continuation launch failed;
- continuation unavailable because no exact session id was captured;
- continuation refused because the old process survived termination;
- continuation policy exhausted.

Whether those belong in `dispatch-lane-stats.json` or a narrower MCP diagnostic surface should be decided during implementation; they must not change existing lane-health meanings.

Primary files:

- `src/mcp/server.ts`
- `src/dispatch-lane-stats.ts`
- admin telemetry validation/forwarding code

## 10. Make continuation visible in status/results

A caller polling a long job should be able to tell that it crossed a hard cap and was resumed.

Example running status:

```
status: running
lane: agy-gemini
elapsed: 43m
incarnation: 2
continued: 1 time
session: resumable
current incarnation: 13m
activity: active
walk-verdict: keep-running
```

Example terminal attempt summary:

```
1. agy-gemini: completed after 75m — continued twice after active hard-cap rollover
```

Do not expose raw session ids in ordinary status output. They are implementation identifiers and create noise; expose them only through an explicit debug surface if one is later justified.

A continuation-policy exhaustion result should distinguish:

- "the lane became idle/failed" from
- "the lane remained active but this job reached the operator's total continuation bound."

That distinction is important because only the former is negative lane evidence.

## 11. Persist enough state for diagnosis, not automatic server-restart resurrection

Extend the running journal/archive validation with optional continuation diagnostics needed to explain a job after restart:

- harness kind;
- continuation count/incarnation;
- whether an exact resumable session had been captured;
- canonical session id if retaining it locally is acceptable;
- continuity id if needed to diagnose routing.

Keep wire/file compatibility additive: old rows without these fields remain valid.

**Non-goal for the first implementation:** automatically resume a logical lane after the entire `llm-relay mcp` process dies.

A server restart has a different ownership/failure boundary from an incarnation timeout. The current journal should continue to report such a job as `killed`. If useful, its report may say that a resumable session existed, but resurrection after process death should be a separate design with its own safety analysis.

Primary files:

- `src/mcp/job-journal.ts`
- `src/mcp/job-archive.ts`
- restart-report tests

## 12. Failure handling

Continuation itself can fail. These cases must have deterministic outcomes:

### Resume identity never captured

No continuation. At the hard cap, terminate and classify using the existing timeout path, with a diagnostic explaining why resume was unavailable.

### Resume invocation cannot be constructed

Treat as a continuation infrastructure failure. Do not silently replay the task as fresh. End that logical lane attempt and let the ordinary walk decide whether to advance.

### Resume process exits immediately with "session not found" or equivalent

Do not retry using "latest." End the logical attempt, record a bounded continuation diagnostic, and proceed according to normal walk rules.

### Old process survives termination

Do not spawn the resumed process. End the logical attempt with a process-cleanup failure. Survivor reporting remains authoritative.

### Backend affinity target becomes unavailable

Allow normal candidate selection/failover. Backend continuity is a preference, never an availability override.

### Resumed lane becomes idle

Apply the normal idle-stop/walk logic. A prior active rollover does not make the lane permanently privileged.

## 13. Tests

At minimum, add regression coverage for:

1. active + hard cap + exact session id -> same lane resumes and eventually succeeds;
2. two active hard-cap rollovers -> timer resets each time and the job remains one logical attempt;
3. active hard-cap rollover does not consume another `maxLanes` slot;
4. active hard-cap rollover does not increment timeout/failure/consecutive-failure statistics;
5. total time-to-answer is measured across all incarnations;
6. idle at the hard cap -> no resume; ordinary timeout/walk behavior;
7. no captured exact session id -> no unsafe "continue latest";
8. two concurrent jobs in one cwd -> each resumes only its own explicit session;
9. cancellation during reap -> replacement incarnation never starts;
10. old process reports survivors -> replacement incarnation never starts;
11. resumed invocation fails -> clean logical failure/walk, no infinite retry;
12. `maxRestarts` exhaustion while active -> explicit policy-exhausted result, no lane-health demotion;
13. `maxJobMs` exhaustion while active -> same semantics;
14. same pooled lane across continuation -> same continuity identity is presented to relay routing;
15. continuity-affined target becomes unavailable -> normal healthy fallback still occurs;
16. continuation state appears accurately in `dispatch_status`;
17. terminal attempt summary says it continued rather than listing multiple fake lane attempts;
18. old journal/archive rows without continuation fields still restore;
19. malformed optional continuation fields drop only the malformed row according to current persistence rules;
20. adapter parser failure disables continuation without failing the lane;
21. canonical session id is not replaced by an invocation-local id emitted during resume;
22. non-resumable lanes retain current timeout semantics byte-for-byte where possible.

Likely suites:

- `test/dispatch-lane-walk.test.ts`
- `test/lane-runner.test.ts`
- `test/mcp-lane-launch.test.ts`
- `test/mcp-telemetry-forwarding.test.ts`
- `test/dispatch-lane-stats.test.ts`
- `test/mcp-job-archive.test.ts`
- `test/mcp-restart-report.test.ts`
- `test/sticky-sessions.test.ts`
- new focused continuation-adapter tests

## 14. Implementation phases

### Phase 1 — continuation infrastructure, behavior still off

- add continuation types/state;
- add the harness-adapter abstraction;
- add structured session-id observation;
- verify each supported harness independently;
- expose diagnostics in tests;
- keep automatic continuation disabled.

**Exit criterion:** a normal lane run can prove "this exact process owns resumable session X" without changing timeout behavior.

### Phase 2 — active hard-cap rollover

- move resumable incarnation timeout ownership into `runOneLane()`;
- fresh-check liveness at the deadline;
- terminate/reap before replacement spawn;
- resume exact session on same lane;
- reset incarnation timer;
- add `maxRestarts` / `maxJobMs`;
- keep cancellation dominant.

**Exit criterion:** a fake/test harness can cross multiple hard caps while active and complete as one logical successful attempt.

### Phase 3 — routing continuity

- introduce the internal continuity identity;
- preserve the concrete backend target across incarnations when it remains usable;
- prove availability evidence overrides continuity affinity.

**Exit criterion:** a resumed pool lane prefers the prior concrete target without bypassing breaker/quota/eligibility decisions.

### Phase 4 — telemetry, persistence, surfaces, docs

- ensure internal rollovers never poison lane-health statistics;
- measure logical time-to-answer across incarnations;
- add continuation diagnostics;
- persist additive continuation metadata;
- render status/result continuation information;
- update field notes/reference docs and examples.

**Exit criterion:** operators and callers can understand exactly what happened, while existing lane-health meanings remain intact.

## 15. Explicit non-goals

Do not include these in the first implementation:

- resume "latest" session;
- automatic resurrection after the entire MCP server process dies;
- process suspension/checkpointing at the OS level;
- cross-lane migration of one harness session;
- keeping an unhealthy/quota-exhausted backend solely for cache locality;
- infinite renewal while activity continues;
- treating filesystem progress alone as sufficient to reconstruct lost conversational state when no exact session resume primitive exists.

## 16. Acceptance properties

The implementation is complete only when all of these are true:

1. **No active work is discarded solely because one process incarnation reached its relay-imposed hard cap when exact-session continuation is available.**
2. **A continuation never resumes an ambiguous or unrelated harness session.**
3. **At most one incarnation of a logical attempt is allowed to own the worktree at a time.**
4. **An internal rollover never counts as a lane failure, timeout, new ladder attempt or additional `maxLanes` consumption.**
5. **The same lane and, when healthy, the same concrete backend are preferred across continuation.**
6. **Present availability evidence always outranks cache/continuity affinity.**
7. **Cancellation prevents any further incarnation from starting.**
8. **The logical attempt has a finite total bound independent of its resettable incarnation timer.**
9. **Status and archived results distinguish active policy exhaustion from actual lane failure.**
10. **Existing non-resumable lanes retain their current timeout behavior.**
