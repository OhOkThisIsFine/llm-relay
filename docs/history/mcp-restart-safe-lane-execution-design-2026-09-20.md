# MCP restart-safe lane execution — design (2026-09-20)

**Status:** design complete; implementation not yet shipped.

## Goal

A host restarting its `llm-relay mcp` process must not destroy a spawned agent lane that is still doing useful work.

The measured Windows S4 result is binding: killing the MCP parent killed its child lane even without
`taskkill /T`. Therefore "spawn detached and remember the pid" is not an adequate cross-platform
design. The independent lifetime has to belong to something outside the host-owned MCP process tree.

## Decision

Use the already-independent **llm-relay daemon as the owner of spawned agent-lane processes**.

The MCP process becomes a client of a narrow, token-gated local execution broker:

```
MCP host process                         relay daemon
----------------                         ------------
create job
journal execution id
POST broker start  --------------------> validate configured lane
                                         spawn/own process tree
                                         retain bounded output/result
poll broker status --------------------> running / terminal result

MCP process dies                         lane continues in daemon

replacement MCP
reads broker execution from journal
POST broker status --------------------> same running execution/result
```

This is the "equivalent independent process lifetime" allowed by D1 after S4 proved ordinary child
detachment insufficient.

## Why the daemon, not a directly detached child

1. **Windows evidence:** an MCP child died with its parent despite the parent-only kill measurement.
   Node's ordinary `detached: true`/process-group behavior does not establish a portable escape from
   a host job/process lifetime boundary.
2. **No PID adoption:** a restarted process must not kill or trust a pid recorded by a dead process;
   pid reuse can target an unrelated process.
3. **No secret-bearing launch file:** the current lane environment may contain credentials and
   session headers. A disk-backed detached bootstrap would either persist those values or need a new
   secret-storage protocol. A loopback control request keeps them in memory.
4. **Existing trust boundary:** the daemon already has an exact Host/Origin check and a per-install
   control capability for mutating local control routes.
5. **Existing lifetime:** the daemon is deliberately independent of Claude/Codex/Desktop MCP
   processes. A host restart therefore does not close the broker's process handles.

## Security boundary

The broker must **not** be a generic remote-exec endpoint.

A start request names a configured **lane id**, task and execution options. The daemon resolves the
lane through the same dispatch/config machinery it already uses for `GET /dispatch`. It never
accepts an arbitrary command, argv or executable path from the request.

The route is:

- loopback/listener-authority constrained by existing admission;
- control-token required;
- JSON-only;
- closed-key validated;
- bounded task/cwd/options;
- absent from tokenless reads.

The daemon may spawn only an invocation produced from the configured ladder/manifest. This keeps the
new capability at the same authority level as "run this configured lane", rather than "run arbitrary
code supplied by anyone holding the control token".

## Scope

First implementation:

- spawned **agent-mode** lane attempts;
- same lane/walk semantics while the original MCP process is alive;
- host/MCP restart survival for the currently running brokered attempt;
- replacement MCP can report/poll/cancel that execution and collect its terminal result;
- if a recovered execution itself fails, the caller re-dispatches. The replacement process does not
  reconstruct and continue the old multi-rung walk.

That last limit is deliberate: continuing the entire old walk would require persisting the original
task and remaining walk state. The current journal stores only a bounded label, not prompt text.
D1 should preserve active work without quietly widening persistent prompt storage.

Non-goals for this implementation:

- daemon-restart survival;
- persisting the full task to reconstruct a walk;
- direct answer-mode HTTP request resurrection;
- pid-based adoption;
- "resume latest" harness sessions;
- hard-cap continuation inside one still-running MCP process (separate design:
  `active-hard-cap-lane-continuation-plan-2026-09-20.md`).

## Broker protocol

Add one exact control route, tentatively `POST /mcp/lane-execution`.

One body union keeps the admission surface small:

```ts
type BrokerRequest =
  | {
      action: "start";
      executionId: string;
      jobId: string;
      laneId: string;
      task: string;
      cwd: string;
      timeoutMs: number;
      // Current MCP recursion depth; daemon writes depth + 1 into the spawned lane.
      depth: number;
      tier?: string;
      readOnly?: boolean;
      // Required when readOnly is true; the daemon cannot infer the caller's protected tree.
      callerRoot?: string;
      host?: "routed" | "bypassed" | "unknown";
      entrypoint?: string;
    }
  | { action: "status"; executionId: string }
  | { action: "cancel"; executionId: string };
```

The client generates a random execution id before start. Start is idempotent for the same id: a
transport retry must return the existing execution, never spawn a duplicate.

A different start payload using an already-present execution id is refused.

Responses use a closed versioned shape:

```ts
interface BrokerExecutionV1 {
  schema: "mcp.lane-execution.v1";
  executionId: string;
  jobId: string;
  laneId: string;
  status: "running" | "completed" | "failed" | "timed_out" | "cancelled";
  startedAt: number;
  endedAt: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  lastOutputAt: number | null;
  // terminal only
  code?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}
```

Do not return command lines, environment values, task text or raw process ids on the ordinary
surface.

## Daemon-side ownership

Create a neutral module (not under an HTTP front), for example `src/lane-execution-broker.ts`.

The broker owns:

- execution map keyed by execution id;
- one `LaneSpawnHandle` per running execution;
- bounded output/result already produced by the existing spawner;
- cancellation;
- terminal retention/pruning.

Initial retention can mirror the job archive's bounded-record philosophy: keep the newest 100
terminal broker results while the daemon lives. A replacement MCP needs the result long enough to
collect it, but D1 does not require a second durable archive in the daemon.

The broker receives an injected lane spawner in tests. During real wiring, the process-execution
primitive currently in `mcp/lane-runner.ts` should be extracted or shared so both owners use
exactly the same Windows npm-shim handling, stdin EOF rule, output cap, timeout and process-tree
termination. Do not duplicate those rules in an admin route.

Daemon shutdown owns these children and cancels/reaps them. MCP shutdown does not.

## Configured invocation resolution

The broker start handler resolves the lane from live daemon config:

1. validate lane id and options;
2. call the same dispatch builder used by `GET /dispatch`, forced to that lane and
   `requester=mcp`, `mode=agent`;
3. require that the resulting lane is executable and matches the requested lane id;
4. apply the same read-only filesystem/tool binding when requested;
5. apply the same launch environment corrections and AGY cwd binding used by MCP today;
6. spawn.

Shared launch normalization should move to a reusable module if needed. There must not be a
"broker launch" and a "local MCP launch" implementation that can drift.

A stale MCP view cannot smuggle an old command into the daemon: the daemon's current config is
authority.

## Journal changes

Extend `JournalRow` additively:

```ts
brokerExecution?: {
  kind: "daemon-v1";
  executionId: string;
};
```

Old rows remain valid.

### Ordering

For a brokered attempt:

1. create the normal job/journal row;
2. generate execution id;
3. persist `brokerExecution` on that row;
4. POST idempotent broker start.

If the MCP dies between 3 and 4, recovery queries an unknown execution and honestly reports the job
killed before the broker start completed.

If it dies after 4, the durable row points to the still-running daemon execution.

### Preservation rule

A journal row carrying `brokerExecution` is **not an orphan merely because its MCP owner pid died**.
Transactional journal rewrites preserve such rows until:

- an MCP process observes the broker terminal result and clears it after archiving, or
- the broker reports the execution unknown, in which case recovery converts it to `killed` and
  clears it after the terminal archive commits.

This is the key semantic change: the execution owner is the daemon, not the journal row's MCP pid.

## Recovery semantics

At MCP startup, broker-backed rows are reconciled asynchronously so `initialize` never waits on
the daemon.

For each broker row:

### broker says running

Expose it as a recovered running job. Polling/status reads broker state. A lightweight watcher may
poll until terminal, but ordinary status/result calls must also be able to refresh on demand.

The replacement MCP is an observer/collector, not a reconstructed walk owner.

### broker says terminal

Convert the broker result into the existing lane result/job rendering, measure the tree delta
against the stored starting tree when available, archive the terminal job, then clear the journal.

### broker says unknown / daemon unavailable

- unknown from a reachable daemon: execution no longer exists -> `killed`;
- daemon unavailable: do **not** immediately claim death from absence of evidence. Report the job as
  recovery-unavailable and keep the journal row until a bounded retry/grace decision is reached.
  A relay restart/start race must not turn a live execution into a false killed report.

The exact grace period should be chosen in implementation with tests, not inferred from elapsed job
age.

## Status after restart

A recovered running broker job should remain recognizable:

```
status: running
lane: <lane>
owner: relay daemon execution (recovered after MCP restart)
output: <bytes so far>
...
```

Its liveness verdict cannot reuse the old MCP process's in-memory activity baseline. Use current
first-party broker/relay/tree observations and explicitly label the recovery boundary. Never infer
"active" solely because the daemon says the process still exists.

## Liveness

Moving the process owner removes direct MCP pid access, so process CPU must not silently disappear.

Broker status should expose a first-party activity measurement suitable for the existing
`latestActivity` logic, preferably cumulative owned-process CPU milliseconds plus output byte/time
counters. The daemon can read CPU from the exact root pids it owns; the MCP receives the
measurement, not the pid.

Existing signals remain siblings:

- tagged relay traffic;
- broker output;
- broker-owned process CPU;
- working-tree change.

Tree reads stay in MCP because they describe the caller's cwd, not process ownership.

## Cancellation and reaping

Explicit `dispatch_cancel` on a broker execution calls broker cancel. The daemon terminates the
owned process tree and stores a terminal cancelled result.

MCP **shutdown** is different: it must leave broker-owned running executions alone. This requires
separating "caller explicitly cancelled this job" from today's `shutdown() -> cancelAll()` policy.

Local/fallback-spawned executions retain today's shutdown reaping behavior.

The daemon becomes the only process allowed to terminate a broker-owned process tree. A replacement
MCP never sends signals to a recorded pid.

## Original-MCP behavior

While the original MCP stays alive, broker execution should look like the current `LaneSpawnHandle`
contract:

- `result` resolves to `LaneRunResult`;
- `kill` maps to broker cancel;
- progress/activity is refreshed from broker state;
- walk logic, telemetry, tree delta and terminal advice remain above that seam unchanged.

This minimizes the behavior diff: the walk should not care whether a process is local or brokered.

If the live daemon/broker cannot be reached before a lane starts, the first implementation may
fall back to the existing local spawner, but status must make that restart-survival difference
observable. Do not silently claim D1 protection for a locally-owned lane.

## Daemon/public HTTP invariant

The old sentence "the daemon never spawns a lane" must be narrowed, not ignored:

> **No public model request may cause a lane/agent process spawn.**

Only the exact token-gated local broker control route may do so. It is not reachable through model
routing and never runs as a side effect of `/v1/messages`, `/v1/responses`, or chat completions.

Tests must prove a model-front request cannot fall through into the broker route.

## Failure cases

- duplicate start, same execution id + same identity -> return existing execution;
- duplicate id with conflicting identity -> 409/refuse, no second spawn;
- configured lane missing/not executable -> 400/refuse before spawn;
- read-only binding cannot be enforced -> refuse before spawn;
- broker spawn fails -> terminal failed result, no dangling running row;
- broker output exceeds existing cap -> same bounded failure as local spawner;
- broker timeout -> same `timed_out` result as local spawner;
- daemon dies -> its shutdown path reaps children when graceful; hard daemon death remains outside
  D1 and is reported killed on later reconciliation;
- replacement MCP cannot reach daemon -> preserve uncertainty until bounded recovery policy resolves;
- terminal archive write fails -> keep journal fallback, preserving the durability invariant already
  shipped.

## Phases

### Phase 1 — broker protocol and daemon store, unused by MCP

- add closed request/response parser/types;
- add in-memory broker with injected spawner;
- add exact token-gated admin route;
- add idempotency/cancel/retention tests;
- no production MCP lane uses it yet.

**Exit:** an injected fake lane can be started, observed and cancelled through the admitted daemon
route; ordinary dispatch behavior is unchanged.

### Phase 2 — broker client as a LaneSpawner-equivalent

- add MCP broker client;
- wire configured invocation resolution/launch normalization;
- make ordinary live MCP agent runs use broker when the daemon is available;
- preserve local spawner fallback explicitly;
- preserve current walk/telemetry/result semantics.

**Exit:** killing no process yet; ordinary tests prove broker-backed and local runs render the same
terminal result.

### Phase 3 — journal recovery and shutdown semantics

- persist broker execution identity before start;
- preserve broker rows after MCP owner death;
- reconcile running/terminal/unknown executions on restart;
- separate explicit cancellation from MCP shutdown;
- recover result and tree delta.

**Exit:** a real process-boundary regression kills the original MCP process while a broker lane runs,
starts a replacement MCP process, and receives the original lane's final answer.

### Phase 4 — Windows destructive regression and docs

- add a Windows CI test mirroring S4 but through the broker;
- prove the lane survives MCP parent death;
- prove cancellation from replacement MCP kills the broker-owned tree;
- prove no PID-based adoption path exists;
- update reference/field notes/architecture and mark D1 complete.

## Acceptance properties

D1 is complete only when all are true:

1. Killing/restarting an MCP host process does not kill a broker-backed spawned lane.
2. A replacement MCP process can report a still-running execution and later collect its original
   terminal output.
3. No pid from a dead MCP process is trusted as ownership evidence.
4. Explicit cancellation still terminates the exact daemon-owned process tree.
5. MCP shutdown leaves broker-owned work running, while local-owned work is still reaped.
6. No public model HTTP request can cause a lane spawn.
7. The daemon resolves only configured lane invocations; the broker is not arbitrary remote exec.
8. Task/environment material is not added to journal/archive persistence merely to survive host
   restart.
9. A recovered failed attempt is reported honestly; the old walk is not reconstructed from missing
   prompt state.
10. Existing non-broker/local fallback behavior remains explicit and unchanged.
