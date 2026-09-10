# Why agents give up on llm-relay dispatch — diagnosis, 2026-09-10

Status: diagnosis. Measured on the live relay (global bin and daemon v0.79.0; daemon PID 18020,
started 08:20 local), the state files in `~/.llm-relay/`, the accounting ledger
(`~/.llm-relay/usage/`), five live MCP probes, and the source at `574819e`. Times are UTC unless
marked local (local = UTC−7). No source or config change was made; §10 lists the one state change
that a probe caused.

## 1. The answer in brief

The ladder lists 11 lanes. Today one lane can answer: `free-pool`. At the default tier the dispatch
walk gives that lane 90 seconds, then stops it and moves to lanes that cannot answer. The last of
those fails in 0 seconds with a false error. The final reply then says "Do NOT call dispatch again
for this task … Do the work in this session instead." The agents obey.

Five faults combine:

1. The walk budget stops the working lane on real work (§3).
2. Lanes that cannot answer show as `ready` (§4).
3. The final message is wrong, and it tells the agent to stop (§5).
4. Until this morning the pool behind `free-pool` failed 20–50 % of requests at night. Paid
   DeepSeek carries that pool now (§6).
5. Host call limits cut the call before the relay replies. Codex stops the calling script at
   31 s, so a 40 s dispatch wait loses its job handle; a Claude Code call to an old MCP process that
   still honours a 60 s wait fails with "Request timed out" (§8).

The agents' own transcripts agree (Appendix A): of 365 dispatch calls since 2026-09-07, 183
(50.1 %) got an answer.

DeepSeek: the relay already spends the paid credits — every request it served from 14:00 to 16:15
today went to the `deepseek` provider. But no dispatch call can ask for DeepSeek by name. So an
agent that must use DeepSeek writes its own HTTP call, usually a `curl` to the relay itself with a
DeepSeek model. Only 2 direct calls to `api.deepseek.com` were found, and a user asked for both.
Agents go around dispatch, not around the relay (§7, Appendix A).

## 2. What an agent sees

A typical call is `dispatch(task)` with no tier, in agent mode. The tier is then `medium`. This is
the selection order at 16:00 (from `dispatch_lanes`):

| # | lane | walk budget | record | what happens |
|---|---|---|---|---|
| 1 | `free-pool` (`pool/medium`) | 90 s — the flat floor; its own p80 is 39.5 s | 119 of 140 answered at `medium` | stopped at 90 s when the task needs longer |
| 2 | `opencode-muse-spark` | 900 s — from six 900 s timeouts | 0 of 12 at `medium` | waits up to 900 s, then fails; skipped while another job holds its one slot |
| 3 | `agy-claude-opus` | 90 s | 0 of 34 | AGY retries a quota 429 in silence; the walk kills it at 90 s |
| 4 | `anthropic` | none — the last lane | 0 of 21 | fails in 0 s: "cannot be run from here … no cliLane template configured" |

The records are the relay's own lane stats (`~/.llm-relay/dispatch-lane-stats.json`); the `medium`
rows are tier-keyed, which began on 2026-09-09. The other seven rungs are out: `codex-sol`,
`codex-spark`, `codex-terra`, `codex-luna` and `openrouter-deepseek` are disabled; `agy-gemini`
(until 2026-09-11T03:57) and `agy-claude-sonnet` (until 2026-09-16T15:24) carry recorded quota
deaths. The walk tries at most `maxLanes` = 4 lanes.

Worst case: 90 + 900 + 90 + 0 s, about 18 minutes. Then the reply ends with
`LANE_LADDER_EXHAUSTED_ADVICE`:

> Every dispatch lane has now been tried for this task and none of them answered. Do NOT call
> dispatch again for this task — it would pick the same lanes. Do the work in this session
> instead, with your own subagent if you have one.

During the walk the host call returns after 40 s (the `routing.mcp.maxWaitMs` default) with "Still
running after 40s. Poll dispatch_status …". `dispatch_status` then shows only the lane and the
elapsed time. Nothing tells the agent how long this lane usually needs.

## 3. Fault 1 — the walk budget stops the only working lane

**The budget.** `budgetFromSamples` in `src/dispatch.ts` returns the larger of `attemptMs` (90 s,
`DEFAULT_DISPATCH_WALK` in `src/config/routing-parser.ts`) and the 80th percentile of the lane's own
recorded wall clock. `attemptBudget` uses the tier's own window once it holds `attemptMinSamples`
(5) samples.

**The data.** `free-pool` at tier `medium` holds 100 samples. All 100 were recorded between 09:08
and 09:27 — 140 calls in 19 minutes, a burst of short calls. p50 19 s, p80 39.5 s, so the budget is
the 90 s floor.

Three defects make that number wrong for agent-mode work:

a. **The two modes share one window.** `forwardTelemetry` in `src/mcp/server.ts` reports
   `taskLength`, `laneId`, `kind`, `spec` and `tier`, and no mode. An answer-mode call (seconds) and
   an agent-mode run (minutes) feed one budget.

b. **The window can never show a need for more time.** `recordLaneRun` in
   `src/dispatch-lane-stats.ts` adds no duration for an `abandoned` run. A run that the walk stops at
   90 s leaves no sample. So the window holds only runs that finished inside the budget, and its p80
   stays below the budget for ever. The rule stops a ratchet, but it creates a lock at the floor.

c. **Failures count as time to answer.** A `timed_out` or `failed` run adds its wall clock.
   `opencode-muse-spark` at `medium` holds six timeouts at 900 s, so its budget is 900 s. The walk
   waits longest on the lane that answers least.

Compare tier `high`: 11 samples from 1 s to 2,700 s, budget 1,561 s. The orchestrators that know
this pass `lane: "free-pool"` and tier `high`. Jobs 2–20 in the shared MCP process each tried
exactly one lane, so each ran with no budget: a forced lane is also the last lane, and `runWalk`
gives the last lane no budget. An ordinary agent does not know this.

## 4. Fault 2 — lanes that cannot answer show as ready

**`anthropic`.** `resolveDispatchView` in `src/cli.ts` builds the MCP view with `host: "bypassed"`.
For that host, `toLane` in `src/dispatch.ts` keeps a pass-through rung as a relay target with no
command (`reachableWithoutRelay` is true), because a bypassed host "still HAS the tool" (`Agent`).
The MCP server has no `Agent` tool. Measured:

- agent mode (job-0023): "Lane "anthropic" cannot be run from here: it is a relay target
  (anthropic) with no cliLane template configured." `routing.cliLane` IS configured; the text is
  the default in `startLane`.
- answer mode (job-0024): "relay answered HTTP 401 … invalid x-api-key". The dummy key goes through
  to Anthropic.

The ledger holds 10 `auth_error` requests with attribution `caller_operated` (the caller's own
credential, i.e. the pass-through path) from last night. Record: 0 of 21.

**`agy-claude-opus`.** AGY's own log (`~/.gemini/antigravity-cli/cli.log`, 16:03) shows
`RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to
increase your limits. Resets in 144h10m31s.` AGY retries with back-off (4 s, 7.8 s, 15 s, 23 s,
45 s, 117 s, 206 s …) and prints nothing. The walk kills it at 90 s, before AGY gives up, so the
relay never reads the quota statement and the lane stays `ready`. Record: 0 of 34. The ledger shows
17 walk abandonments last night and 14 on 2026-09-09 (`aborted` is the failure kind that
`TELEMETRY_FAILURE_KIND` in `src/routes/admin.ts` gives an abandoned lane).

My probe (job-0025, a forced lane, so no budget) ran 604 s and ended "lane reported
quota_exhausted". The relay then recorded `quota:agy-claude-opus` until 2026-09-16T16:13. That one
full-length run is the only reason the walk now skips this lane.

**`opencode-muse-spark`.** 0 of 12 at `medium`: six timeouts at 900 s, and six failures that left no
duration sample (an abandoned run leaves none). The relay's own pool member
`opencode/muse-spark-1.3-contributor-free` answered 429 in probe job-0021. Zen's free contributor
tier is saturated. Last night: 7 answered, 17 timed out, 6 abandoned, 2 failed. A demotion lasts
15 minutes (`demoteMs`); then the lane is `ready` again.

**What is missing.** Only a recorded quota death removes a lane from the walk. No rule demotes a
lane after a long run of zero successes. And `canAddressAsSubagent` / `mustTransposeEveryRung` have
no state for the MCP server itself, which has neither a subagent tool nor a way to run a
pass-through rung.

## 5. Fault 3 — the final message is wrong and tells the agent to stop

`jobAnswer` in `src/mcp/server.ts` adds `LANE_LADDER_EXHAUSTED_ADVICE` when nothing answered, the
walk is on, and no lane is left untried. Measured faults:

- It fires after the walk **stopped `free-pool` while it was still working** — the one lane that
  would have answered.
- It fires after a one-lane `lane:` override. Jobs 0023 and 0024 each tried one lane and got "Every
  dispatch lane has now been tried".
- The error line above it is the last lane's error, usually the `anthropic` text. That text reads
  as a relay configuration fault or an authentication fault.
- `MCP_INSTRUCTIONS` says the same: "When it reports that every lane was tried, do the work here —
  re-dispatching the same task picks the same lanes."

So one bad walk ends the agent's use of dispatch for the rest of its task.

## 6. Fault 4 — the pool failed at night; paid DeepSeek carries it now

Requests by hour, 2026-09-10 (`usage/2026-09-10.json`, read at 16:08):

| hour (UTC) | requests | served | errored | cancelled | attempts per request |
|---|---|---|---|---|---|
| 00 | 20 | 14 | 3 | 3 | 1.8 |
| 01 | 49 | 36 | 12 | 1 | 2.3 |
| 02 | 29 | 15 | 10 | 4 | 2.2 |
| 03 | 9 | 6 | 2 | 1 | 2.1 |
| 06 | 7 | 3 | 4 | 0 | 2.7 |
| 07 | 28 | 24 | 0 | 4 | 2.8 |
| 08 | 24 | 12 | 12 | 0 | 1.0 |
| 09 | 170 | 120 | 26 | 24 | 2.3 |
| 14 | 495 | 494 | 0 | 1 | 1.02 |
| 15 | 856 | 855 | 0 | 1 | 1.01 |
| 16 (partial) | 532 | 531 | 1 | 0 | 1.01 |

The day before shows the same pattern: at 16Z on 2026-09-09, 46 requests, 14 served, 22 errored,
10 cancelled.

From 14:00 to about 16:15, 2,055 requests went to the `deepseek` provider (1,434 `deepseek-flash`,
612 `deepseek-v4-pro`, 9 on the OpenAI front), and all 2,055 succeeded. The last 100 requests before
16:08 were 100 × `deepseek-flash`, one attempt each, p50 3.3 s, p95 27.9 s.

The config change: at 14:51 an agent put `deepseek/deepseek-flash` in `preferred` of all four pools
(backup `config.json.bak-2026-09-10-pre-deepseek-flash`), for package 0 of lap 232d8bef. The owner
had asked to "make sure we're using the new DeepSeek model via llm-relay rather than the older one".
The daemon reads its config only at start, and it restarted at 15:21:

| window | `deepseek-v4-pro` | `deepseek-flash` |
|---|---|---|
| 14:00–15:21, old daemon | 612 | 3 |
| 15:21–16:15, new daemon | 0 | 1,881 |

So DeepSeek was already first before the edit took effect. `deepseek-v4-pro` was not in `preferred`
then; it was a dynamic pool member with cost class `unknown`, which `materializeDynamicPools` places
behind the free members of its band. It still took the first attempt of nearly every request
(1.02 attempts per request at 14Z). Either its band placement or the health demotion of the free
members ahead of it put it first; this report did not measure which.

So the lane named `free-pool` now spends paid DeepSeek credits first. Two texts are now false:

- the rung note: "Free capacity is spent before any metered or subscription lane";
- `MCP_INSTRUCTIONS`: "The default lane is free capacity, so offloading spends no subscription
  quota".

## 7. DeepSeek — why agents go around the relay

1. **No way to ask for it.** `dispatch` takes `lane` (a rung id) and `tier`; it takes no model. No
   rung names the direct `deepseek` provider. The one DeepSeek rung, `openrouter-deepseek`, goes
   through OpenRouter and has been disabled since 2026-09-09. Before 14:51 today no pool named
   DeepSeek in `preferred`. An agent told to use DeepSeek has no dispatch path, so it writes its own
   call. Example: the lap-232d8bef orchestrator wrote `plan.mjs` (in its scratchpad), which posts to
   `http://127.0.0.1:8791/v1/chat/completions` with model `deepseek/deepseek-flash` — through the
   relay, but outside dispatch.
2. **Wrong label.** The config gives `deepseek` no `tierType`. `assessCost` in `src/metadata.ts`
   returns `unknown`, which the relay treats as paid — correct in effect. But `getTelemetryReport`
   in `src/telemetry.ts` falls back `p.tierType ?? preset?.tierType ?? "free"`, so `/telemetry`
   shows DeepSeek as **free**. That is a fall-through to the stronger claim.
3. **No hedge and a long timeout.** A hedge fires only for deployments classed free, so a DeepSeek
   attempt gets none. `deepseek` has `timeoutMs` 600,000 and `stallTimeoutMs` 600,000. DeepSeek is
   now the first member of `pool/low`, `pool/high` and `pool/xhigh`. `walkBudgetMs` (120,000) does
   not stop a running attempt: `#budgetAllowsStart` in `CredentialWalk` (`src/credential-select.ts`)
   only blocks a third or later start. So one DeepSeek stall can hold a request for up to 10 minutes
   before the first failover.
4. **History.** On 2026-09-09 the Codex path to DeepSeek died 5 of 5 (the relay's own 1,024
   `max_tokens` default on the Responses front; fixed in v0.78.0). On 2026-09-10 V4.1 Flash on
   `/v1/messages` spent all 32,000 output tokens on reasoning with thinking disabled (the lap plan's
   measurement; the thinking control shipped in v0.79.0). Agents that met these failures learned to
   call DeepSeek another way.

## 8. Other findings

- **One MCP process serves several sessions.** The tool calls from this session went to the
  `llm-relay mcp` process that the Claude desktop app started at 08:16 local (PID 39344): my jobs
  were numbered 0021–0025, `job-0001` in the same process was another session's
  `opencode-muse-spark` job, and its `free-pool` in-flight count (9) equals the nine `claude -p`
  lanes it parents. So job ids, in-flight counts and `maxConcurrent` are shared across the sessions
  of the desktop app. That is correct for `maxConcurrent`; it also means that one session's slow
  walk holds capacity that the other sessions see.
- **Old MCP processes still run.** Two `llm-relay mcp` processes started on 2026-09-09 at 18:08 and
  18:16 local, before v0.78.0 was tagged (20:14 local). They run older code: no
  `routing.mcp.maxWaitMs` ceiling and no `maxConcurrent`. One has lost its parent process. This
  report did not measure whether a session still calls them. v0.80.0 was published at 16:04; a
  running MCP process keeps its old code until its host restarts it.
- **AGY starts its own relay MCP server.** `~/.gemini/config/mcp_config.json` registers
  `llm-relay.cmd mcp`, so each AGY lane run starts `cmd.exe` and then `node.exe … cli.js mcp`
  (seen at 09:10:21 local, under an `agy-claude-opus` run). The owner saw a console window twice:
  at about 09:03 local, and again between 09:10 and 09:17 local. An AGY lane ran both times. A
  separate investigation handles the console windows (§10).
- **Host call limits cut the call before the relay replies.** Codex runs an MCP call inside a
  code-mode `exec` script. That tool returns `Script running with cell ID 2 / Wall time 31.0 seconds`
  with empty output when the script is still waiting (read in
  `~/.codex/sessions/2026/09/07/rollout-2026-09-07T14-11-25-…jsonl`). A dispatch call blocks for up
  to 40 s (`DEFAULT_MCP_MAX_WAIT_MS`), so on Codex a call that is still waiting at 31 s loses its
  job id: the transcript sweep counts 29 of 266 first Codex dispatch calls since 2026-09-07. In
  Claude Code, a call with `waitMs: 60000` at 15:14 failed with `Error: Request timed out` and no job
  id. Since v0.78.0 `resolveWaitMs` lowers any wait above 40 s to 40 s, so the process that served
  that call most likely ran code from before v0.78.0; the desktop app started a new MCP process two
  minutes later. That last point is an inference from process start times, not a measurement.

## 9. Fix plan

The fastest end to the give-ups is F1 + F3 + F4 (small changes in `src/mcp/server.ts` and
`src/dispatch.ts`), or stopgap S1 until they ship. F5 answers the DeepSeek complaint directly.

| # | change | where | effect | confidence |
|---|---|---|---|---|
| F1 | Never trade a working lane for lanes that cannot answer. Before the walk abandons a lane at its budget, check the later lanes; when none of them answered in its recent record (for example no success in its last 5 runs, or a recorded death), give the current lane no budget, as if it were last. | `runWalk` | Every `medium` walk measured today would have let `free-pool` finish. | High — the rule reads data the relay already keeps. |
| F2 | Budget from time to answer, per mode. Report `mode`; key the window by mode; add a duration only for a `completed` run; when recent attempts were abandoned, raise the budget (for example double it, capped at the lane's timeout) instead of reading the censored window. | `forwardTelemetry`, `recordLaneRun`, `attemptBudget` | Agent-mode `free-pool` gets minutes, not 90 s; `opencode-muse-spark` loses the 900 s budget it built from timeouts. | High on the three defects; medium on the exact raise rule — re-measure after one day. |
| F3 | Take `anthropic` out of the MCP walk. Mark a pass-through rung `unreachable` for the MCP server, which has no `Agent` tool, with a true reason; correct the default text in `startLane`. | `resolveDispatchView`, `toLane`, `startLane` | No walk ends on a 0-second false error. | High. |
| F4 | An honest last message. Print `LANE_LADDER_EXHAUSTED_ADVICE` only when every lane in the ladder ran and failed on its own. When the walk abandoned a lane, name it and give the call that lets it finish (`lane: "free-pool"`); after a one-lane override, say that only that lane ran. Change `MCP_INSTRUCTIONS` to match, and remove "free capacity … spends no subscription quota". | `jobAnswer`, `LANE_LADDER_EXHAUSTED_ADVICE`, `MCP_INSTRUCTIONS` | Agents stop quitting after a walk that stopped a working lane. | High. |
| F5 | Let dispatch name a model. Add a `model` argument (a routing spec such as `deepseek/deepseek-flash` or `pool/high`): answer mode posts it as `model`; agent mode renders the `routing.cliLane` template with it; no walk. | `toolDispatch`, `startLane` | An agent uses DeepSeek, or any deployment, in one call, so it has no reason to write its own HTTP client. | High. |
| F6 | Record the quota deaths that AGY states. When the walk stops or ends an AGY lane, read `~/.gemini/antigravity-cli/cli.log` for `RESOURCE_EXHAUSTED … Resets in <duration>` and report the death with that duration. Also demote a lane with no success in its last N runs until a probe answers. | `runOneLane` or the AGY launcher | Dead AGY lanes leave the walk after one attempt, not after a full-length run by luck. | Medium — `cli.log` is shared by concurrent AGY runs and its wording can change. Do it after the console-window fix, which also changes the AGY launch path. |
| F7 | DeepSeek labels and bounds. `getTelemetryReport` must not fall back to `"free"`; show `unknown`. Give `deepseek` a stall bound that fails over in minutes (for example `stallTimeoutMs` 120,000, or a `firstByteTimeoutMs`), because a DeepSeek attempt gets no hedge. Correct the `free-pool` rung note. | `src/telemetry.ts`, operator config | The surfaces stop calling paid DeepSeek free; a DeepSeek stall stops holding a request for 10 minutes. | High on the label; medium on the timeout value (DeepSeek can think for a long time; v0.79.0 turns thinking off by default). |
| F8 | Tell the poller how long to wait. A running job's status adds the lane's usual time to answer in this mode (p50, p80). | `describeJob` | Agents poll a long lane instead of giving up. | Medium on the effect. |
| F9 | Wait less than the shortest host limit. Lower the default blocking wait below Codex's 31 s script limit (for example 25 s), or pick it per host from the `initialize` `clientInfo`. An `llm-relay mcp` process that runs older code than the installed package says so in each reply, so the owner knows to restart the host. | `DEFAULT_MCP_MAX_WAIT_MS`, `resolveWaitMs`, `initialize` | Codex callers keep their job handle; stale MCP processes become visible. | High on the Codex limit (read in the Codex transcripts); medium on the per-host choice. |

Stopgaps in the operator config. Each one needs a daemon restart, which interrupts the requests of
every running lane, so each one is an owner decision:

- **S1** `routing.dispatchWalk.enabled: false` — one lane (the first ready one, `free-pool`), no
  budget, no stop advice; the exact pre-walk behaviour. Cost: no automatic fallback when
  `free-pool` fails.
- **S2** `routing.dispatchWalk.attemptMs: 600000` — `free-pool` gets 10 minutes at `medium`. Cost: a
  lane that hangs costs up to 10 minutes before the walk moves on.
- **S3** Add rungs `deepseek-flash` and `deepseek-pro` (kind `relay`, spec `deepseek/deepseek-flash`
  and `deepseek/deepseek-v4-pro`) to each ladder, so `lane: "deepseek-flash"` works before F5
  ships.
- **S4** Set `enabled: false` on the `anthropic` rungs until F3 ships. Cost: a routed host loses the
  backstop rung in its ladder view; its default routing still reaches Anthropic.

## 10. State changes during the diagnosis

- Probes: job-0021 (answer mode, `free-pool`, 2 s, served by `deepseek-flash` after one 429),
  job-0022 (agent mode, `free-pool`, 5 s), job-0023 and job-0024 (`anthropic`, 0 s failures),
  job-0025 (`agy-claude-opus`, 604 s, quota).
- job-0025 made the relay record `quota:agy-claude-opus` until 2026-09-16T16:13. That is a true
  fact — AGY stated the reset — and the relay's re-probe cadence retracts it if a probe disproves
  it.
- The owner saw a console window during job-0025. A separate agent investigates the console
  windows; its record goes to `C:\Code\docs\`.
- No config, source or process change.

## 11. How to re-measure

- `dispatch_lanes` for tier `medium`: the budget and the record of each lane.
- Lane stats: `~/.llm-relay/dispatch-lane-stats.json`, one row per lane and tier, with `calls`,
  `successes`, `failures`, `timeouts`, `wallClockMs` and `wallClockAt`.
- Ledger by hour: `~/.llm-relay/usage/<date>.json` → `cells["HH:MM"].aggregate` for totals, and
  `cells["HH:MM"].rows` for `kind`, `provider`, `model`, `client`, `outcome` and `failureKind`. A
  lane run is a row with `client: "mcp-dispatch"` and the lane id in `model`; `aborted` means the
  walk abandoned it.
- AGY quota: read `~/.gemini/antigravity-cli/cli.log` right after an AGY run; AGY truncates it on
  each run.
- Walk outcomes: `dispatch_result` of a finished job lists each lane that it tried, with the reason.

## Appendix A — what the agents' transcripts show

A scripted sweep read 431 transcripts written since 2026-09-07 local midnight: 182 Claude Code
sessions and subagents, 124 relay-lane sessions, 125 Codex sessions. It found each first
`dispatch` call, followed its `dispatch_status` / `dispatch_result` / `dispatch_cancel` calls, and
classed the end. The full tables are in a session scratchpad and are temporary; these figures are
the durable part.

**Outcome of 365 first dispatch calls:**

| outcome | all | Claude Code | Codex |
|---|---|---|---|
| answered in the first call | 21 | 8 | 13 |
| answered after polling | 162 | 23 | 139 |
| lane failed | 52 | 17 | 35 |
| abandoned by the agent (cancelled, or polling stopped) | 58 | 31 | 27 |
| walk ended with the stop advice | 26 | 5 | 21 |
| the host call failed (Codex 31 s script limit; Claude Code "Request timed out") | 36 | 7 | 29 |
| `unknown jobId` after an MCP server restart | 9 | 8 | 1 |
| other | 1 | 0 | 1 |
| **answered in total** | **183 of 365 (50 %)** | **31 of 99 (31 %)** | **152 of 266 (57 %)** |

Lanes that answered: `opencode-muse-spark` 81, `agy-gemini` 33, `free-pool` 69 (32 at `medium`,
29 at `high`, 4 at `xhigh`, 4 at `low`). Lanes that failed or ended a walk: `opencode-muse-spark`
22, `free-pool` 32, `anthropic` 9, `agy-gemini` 7, `agy-claude-sonnet` 5, `agy-claude-opus` 2,
`openrouter-deepseek` 1.

**The most common reasons, verbatim:**

| count | reason |
|---|---|
| 24 | agent issued `dispatch_cancel` |
| 23 | last known state still "running"; no further poll |
| 16 | the lane exceeded its own configured timeout, followed by the stop advice |
| 15 | the lane exceeded its own configured timeout |
| 13 | lane reported quota_exhausted |
| 13 | the lane exceeded its configured timeout and was stopped before it finished |
| 9 | `unknown jobId: job-NNNN` |
| 9 | Lane "anthropic" cannot be run from here … no cliLane template configured (6 with the stop advice) |
| 7 | Error: Request timed out |
| 6 | Codex: Script running with cell ID 2 (the 31 s script limit) |
| 5 | lane reported rate_limited |

**A real walk, as a caller saw it.** "1. free-pool (pool/medium): abandoned after 101s — no answer
within the 101s walk budget, so the next lane was started", then "2. opencode-muse-spark:
abandoned after 608s", then `agy-claude-sonnet`: "failed … lane reported quota_exhausted" at
1,654 s. The budgets were the tier-less p80 figures of that time (101 s and 608 s). Several other
walks ended on a timeout that the caller had set itself (90–360 s), and then got the stop advice.

**Relay-lane transcripts since 2026-09-09:** 69 sessions. 15 ended with a clean answer, 49 ended
with no answer (a lane stopped by its walk or its timeout leaves this trace), 3 ended on a tool
error, and 2 on HTTP 402.

**DeepSeek.** Only 2 direct calls to `api.deepseek.com` exist in the corpus, and a user asked for
both: a comparison of DeepSeek providers on 2026-09-09, and a check of the new model id before the
2026-09-10 pool change. The common pattern is a hand-written call to the relay itself — `curl` or
`Invoke-RestMethod` to `127.0.0.1:8791/v1/messages` or `/v1/chat/completions` with
`deepseek/deepseek-flash`, `deepseek/deepseek-v4-pro` or `nim/deepseek-ai/…` — in at least four
sessions, plus the `plan.mjs` client of §7. The agents did not leave the relay. They left
`dispatch`, which cannot name a model.

**Limits of the sweep.** Result previews are cut at 300–500 characters. A Codex script can batch
several calls, so its captured output can hold a neighbour's text. The job counter restarts at
`job-0001` when an MCP process restarts; the sweep bounded each job's poll chain between reuses of
the same id. Only transcripts on this machine were read, and no dispatch call was made for the
sweep.
