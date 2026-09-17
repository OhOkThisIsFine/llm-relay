# `llm-relay mcp` reads each request on arrival (2026-09-05)

The stdio MCP server used to answer ONE request at a time per process. This lap made it read and
dispatch every request the moment it arrives, pinned that with five tests plus a mutation check,
and measured it live against the released v0.72.0 binary. Shipped as v0.72.1.

## 1. The defect

`runMcp` in `src/cli.ts` drove the server with
`for await (const chunk of process.stdin) { await server.ingest(chunk) }`, and
`McpDispatchServer.ingest` resolves only when every handler in that chunk has settled — a
`dispatch` handler blocks for up to `waitMs` (60 s by default) inside `awaitOrPoll`. So two
requests were concurrent only when they landed in the SAME stdin chunk. A host that issues
parallel tool calls in separate writes — Claude Code does — had its second `dispatch` wait behind
the first's full `waitMs` before the server even read it, and `dispatch_status` /
`dispatch_cancel` could not reach a job while a blocking `dispatch` held the loop. audit-tools
had worked around it with a pool of `llm-relay mcp` children, one per concurrent call.

The parse itself was never the problem: `splitMessages` ran before the first `await`, and the
handlers of one chunk already ran side by side. The serialization was the one `await` in the
read loop.

## 2. The fix

- `McpDispatchServer.ingest` is no longer `async`: the split runs to completion before the first
  handler starts, so two calls in flight cannot interleave or reorder the buffer — message order
  is write order whatever the caller awaits. It still resolves once that chunk's handlers settle,
  which is what the test harness and embedders rely on.
- `McpDispatchServer.serve(source)` is the new read loop: it reads every chunk the moment it
  arrives and never awaits a handler. Each handler settles on its own promise; a rejected
  `ingest` (a response write failed because the host closed the pipe mid-answer — every handler
  error is already contained inside `handleLine`) is logged to stderr and never takes the loop
  down. `serve` resolves after the source ends AND every handler it started has settled.
- `runMcp` calls `await server.serve(process.stdin)`. The per-job wait/poll policy
  (`awaitOrPoll`, `waitMs`) is unchanged.

## 3. Pinning tests and the mutation check

`test/mcp-server.test.ts`, `describe("stdio serve loop")`, drives `serve` with a hand-fed source,
one push per host write:

1. A `dispatch_status` written while an earlier `dispatch` blocks on `waitMs` is answered first
   (`status: running`), and a `dispatch_cancel` from a third write ends the blocking dispatch
   early with `status: cancelled` — the job tools reach a job while a `dispatch` holds the loop.
2. Two dispatches from separate writes come back after ONE wait, not two.
3. `serve` resolves only after the source ends and every started handler has settled.
4. A write that throws for one response is contained (stderr line `ingest failed`), and later
   writes are still served.
5. Two un-awaited `ingest` calls carrying one frame split across them still yield exactly one
   response — the synchronous-split invariant.

Mutation check: re-adding `await pending;` inside `serve`'s loop (the old serial behaviour) turned
exactly tests 1 and 2 red (2 failed, 79 passed); the source was restored afterwards.

## 4. Live measurement

Method: one isolated relay daemon (`dist/cli.js --config`, port 8792, `USERPROFILE` pointed at a
scratch home holding a copy of the real config with `listen` rewritten and `routing.laneProbe`
off, plus copies of the state files), then each child `llm-relay mcp` driven over JSON-RPC with
every request in its OWN stdin write. Dispatches used `mode: "answer"`, `lane: "free-pool"`,
`waitMs: 120000`, task "Reply with exactly the word OK and nothing else." — answer mode POSTs to
the child's own config port, so no traffic reached the real daemon on 8791. The old child is the
globally installed v0.72.0 (`%APPDATA%\npm\node_modules\llm-relay\dist\cli.js`); the new child is
this tree's `dist/cli.js`. Both children reported `serverInfo.version` 0.72.0 (the bump came at
release).

Phase 1: dispatch #1, then 400 ms later `dispatch_status` for `job-0001`.
Phase 2: dispatch #2, then 150 ms later dispatch #3.

| child | status probe answered | dispatch #1 | probe answered before #1 returned | dispatch #2 | dispatch #3 (from its own write) | both done |
|---|---|---|---|---|---|---|
| old v0.72.0 | 6621 ms | 7032 ms | no | 44544 ms | 117574 ms | 117733 ms |
| new (this tree) | under 1 ms | 68010 ms | yes | 63158 ms | 12031 ms | 63158 ms |

Reading: on the old child the status probe was not read until dispatch #1 returned, and dispatch
#3 did not start until dispatch #2 returned (its 117.6 s is #2's 44.5 s plus its own lane time).
On the new child the probe answered while dispatch #1 had 67 s still to run, and dispatch #3
finished 12 s after its own write while dispatch #2 was still in flight for another 51 s; a serial
loop could not have finished #3 before 75189 ms (63158 + 12031).

The 7–73 s spread of the answer-mode calls is the free pool's own latency at that hour (three
providers carried live `allowance-exhausted` facts and the walk hedged), not the MCP server's; it
is why the measurement compares ORDER and OVERLAP rather than absolute times.

Scratch-side evidence after the run: the isolated home's `usage/recent.json` carried five of the
six answer-mode requests (the sixth was still inside the write-behind window when the daemon was
killed), served by `nim/moonshotai/kimi-k3`, `nim/nvidia/nemotron-3-ultra-550b-a55b` and
`kilo/nvidia/nemotron-3-ultra-550b-a55b:free`; the real `~/.llm-relay/dispatch-lane-stats.json`
and `usage/recent.json` kept their pre-run mtimes (answer-mode relay jobs are never reported to
telemetry, and the child's config port was 8792).

## 5. Stated trades

- Responses may now leave out of request order. JSON-RPC permits it; ids correlate.
- There is no concurrency cap. A host that issues N parallel `dispatch` calls starts N lanes,
  each one a call the host made; the ladder's exhaustion state still gates repeated failures.
  Revisit only with evidence of a host flooding the server.
- On stdin EOF `runMcp` still exits at once through the pre-existing `end`/`close` handlers, so
  `serve`'s drain never completes in production; it matters for embedders and tests only.
