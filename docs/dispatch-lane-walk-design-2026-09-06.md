# Automatic lane fallback for dispatch — design, 2026-09-06

Owner request, in their words:

> Agents keep manually deciding that the free lane is too slow and moving to some other dispatch
> type. That shouldn't be necessary. The relay should automate that process, so that if the free
> lane is slow or not answering, we move through the fallbacks until finally reaching the base
> agent's own subagents. And once we hit a working lane, that lane should be pinned at least
> temporarily.

And the principle behind it, stated when the scope was approved:

> The relay was always meant to automate the process for callers as much as possible. Callers
> shouldn't have to specifically pick models; they should have the option to if they want, but the
> default should just be to call the relay with a reasoning level and have the relay do the rest.

## 1. What is true before this change

Three facts, each read from the source rather than recalled.

1. **`dispatch` runs exactly ONE lane.** `toolDispatch` in `src/mcp/server.ts` calls `buildView`
   once, takes `view.next`, spawns it, and returns whatever that one lane did. A failure is
   reported as a failure. The calling agent then picks the next lane by hand, which is the
   friction the owner reported.
2. **Nothing remembers which lane worked.** No pin, no affinity, no per-lane preference exists in
   `src/dispatch.ts` or `src/mcp/server.ts`.
3. **The only lane demotion vocabulary is exhaustion.** `markExhausted` records `rate_limited` and
   `quota_exhausted`. "Ran a long time and returned nothing" cannot be expressed, so it cannot be
   recorded — the finding already filed in `docs/backlog.md`.

A fourth fact bounds the design. `buildDispatch` already supports `after`, so the ladder can be
walked. What is missing is a caller that walks it.

## 2. Four parts

### 2.1 The walk

`dispatch` tries lanes in order until one answers. Each lane gets an ATTEMPT BUDGET. When the
budget passes with no answer, the relay kills that lane and starts the next one.

⚠ **The relay abandons; it does not hedge.** The HTTP request path hedges — it starts a second
attempt beside the first and lets them race. That is deliberate there, and it is bounded to free
deployments by an owner amendment. A lane hedge is different: it spends two lanes' quota at once,
and this machine already carries a filed defect in which lane processes are never reaped and keep
burning processor time after their job returns. So the walk kills the lane it leaves.

⚠ **The job is the WALK, not one lane.** This is the load-bearing choice. A caller's tool call has
a client-side ceiling measured between 45 s and 100 s, and above it the call fails AND destroys
the job handle. So the walk cannot finish inside one blocking call. It continues in the background
and the job handle represents the whole walk. `dispatch_status` reports which lane is running now
and which lanes were already tried. Without this the walk would either exceed the client ceiling or
would have to change its own job id as it advances, which breaks polling.

### 2.2 The terminal fallback

When every lane is spent, the relay does not return a bare failure. It returns an instruction: do
this task with your own subagent, or do it in this session. The instruction names every lane tried
and why each one stopped.

⚠ **The relay cannot start the caller's subagent.** It has no such power, and this is the standing
boundary — the relay decides ORDER, the host executes. So the last rung of the ladder is an
ANSWER, not a spawn. The text must be unambiguous, because the whole point of the lap is that the
agent stops deliberating about lanes.

### 2.3 The pin

A lane that answers is preferred for a window. The next dispatch on the same tier takes it first.

⚠ **A pin promotes; it never resurrects.** A pinned lane that is exhausted, disabled, unreachable
or not servable is not selected. The pin only reorders lanes that are already selectable. This is
the mirror of the standing rule that health demotes and never drops.

The pin lives with the daemon, not in the MCP child. The child restarts often — a filed defect
records one restart destroying five lanes at once — so a pin held in that process would rarely
survive to be used. The daemon already holds lane cooldowns and lane statistics on disk, and the
child already reports to it over `POST /dispatch/telemetry`. The pin travels the same channel.

### 2.4 The demotion

A lane the walk abandoned is ordered behind lanes it did not abandon, for a window.

⚠ **This is evidence, not a statistic, and that is deliberate.** The filed backlog item asks for a
threshold calibrated from the recorded wall-clock window. That calibration is not yet possible: the
recorded window mixes several sessions' traffic, and the item says so itself. But no threshold is
needed for the case that actually hurts. "This lane did not answer inside the budget just now" is a
first-party measurement of this lane, taken by this relay, one second ago. It needs no population
and no calibration, and it cannot borrow a number from the HTTP path — which the same backlog item
warns against in bold.

⚠ **Demotion is a separate axis from `LaneState`, not a new member of it.** `LaneState` says
whether a lane can be selected at all, and its `ready` member is what the selection filter tests.
A `slow` member would therefore REMOVE a slow lane rather than demote it, which breaks the standing
rule. So demotion is its own field on the lane, exactly as quota demotion is a term inside
`targetUsability` on the HTTP path rather than a state.

## 3. One owner for the order

`DispatchView` gains `order`: the lane ids that may be selected, best first. `next` is the first
of them. The walk iterates the same list.

Both consumers read one list. The alternative — the walk re-deriving the order from `ladder` — puts
two definitions of the order in two files, which is the shape this repository's own history warns
about most often.

## 4. What this does NOT do

- It does not touch the HTTP request path. `latency-demotion.ts` and `hedge-trigger.ts` are
  unchanged, and none of their numbers is reused.
- It does not hedge lanes.
- It does not calibrate a wall-clock threshold from the recorded window. The window is not yet
  attributable per session, and the backlog item that asks for it says so.
- It does not judge whether a lane's answer is CORRECT. Structural emptiness is already checked;
  anything beyond that crosses the repair boundary.
