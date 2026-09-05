# Unified telemetry and accounting for dispatched lanes (MCP and CLI) — 2026-09-04

**Status:** approved by the owner 2026-09-04, implementation lap open (lap start `48a5bbb`).
**Provenance:** an AGY + Meta Muse Spark 1.3 design pass. The first draft proposed direct disk
persistence (`AccountingStore` and `recordModelCall`) inside the `llm-relay mcp` process. Meta Muse
Spark 1.3 (`opencode-muse-spark`, `job-0006`) reviewed that draft adversarially and rejected it.
This document is the revised design plus the owner decisions taken at lap start.

## 1. Owner decisions (2026-09-04)

- **D1 — Approved as stated, with one refinement.** Accounting rows are recorded for `cli`-kind
  rungs ONLY. A `relay`-kind rung run in agent mode is `claude -p --model pool/<tier>` whose
  harness traffic goes THROUGH the relay, so the daemon's HTTP pipeline already meters it with
  reported tokens; a second report would double count — the same defect finding F3 names for
  answer mode. Lane-execution stats (wall-clock, exit, terminal status) are recorded for BOTH
  kinds, because the HTTP ledger never sees a lane's wall-clock.
- **D2 — Ledger tokens are the ESTIMATED ENVELOPE.** A cli-lane dispatch row carries chars/4 of
  the task text and chars/4 of the lane's final output as `tokenBasis: "estimated"`. This is the
  dispatch envelope the relay handled, NOT the lane's provider consumption, which the relay
  cannot see (the lane's own harness runs its own tool loop against its own credentials). The
  relay never invents the figure it cannot see: attribution is `unknown`, credential id is null,
  spend is unpriced (null, never $0). Documentation must say this in as many words wherever the
  figure renders.
- **D3 — Ships as a MINOR release** (new control route, new persisted artifact, new MCP
  behaviour). Alternatives offered and declined: no release this lap; report relay-kind lanes too
  and accept the double count; null tokens with request counting only; no ledger row at all.

## 2. Adversarial review verdict (incorporated)

Direct writes from `llm-relay mcp` would:

1. **Break single-writer isolation on `~/.llm-relay/usage/` (F1).** `AccountingStore` holds an
   in-process writer lease only; there is no cross-process file lock. Independent instances in
   `runMcp()` and `runProxy()` would read-modify-write `YYYY-MM-DD.json`, `lifetime.json` and
   `recent.json`, and the last `WriteBehindTimer` flush would overwrite the other process's
   records — silent loss. *Fix:* `llm-relay mcp` never instantiates an `AccountingStore` writer.
   It reports to the daemon over the loopback control route.
2. **Poison HTTP pool scoring with CLI process latency (F2).** `runtime-telemetry.json` feeds
   `getRealWorldScore` (`speedScore = 100 * (1 - avgLatency / 5000)`), latency demotion and
   dynamic pool ranking. CLI wall-clock (`endedAt - startedAt`) includes PowerShell launch,
   `lane-launch.ps1`, the npm wrapper, harness start-up and tool execution (10 s–60 s+). *Fix:*
   CLI wall-clock never reaches `recordModelCall()`; it lives in a distinct lane-stats series.
3. **Double count answer mode (F3).** `dispatch` in `mode: "answer"` already POSTs to the
   daemon's own `/v1/messages`, whose pipeline creates the `AccountingRequest` and records the
   latency. *Fix:* answer-mode jobs are never reported. (D1 extends the same rule to relay-kind
   agent-mode lanes.)
4. **Misattribute provenance (F4).** CLI lanes run with external or anonymous credentials.
   Attribution is `unknown`, never `relay_held`; estimates use `method: "relay_estimate"`.
5. **Lifecycle.** All terminal states are handled: `completed`, `timed_out`, `failed`,
   `cancelled`. A cancelled job is discarded from positive evidence and is not reported.

## 3. Architecture — "MCP reports, daemon records"

```mermaid
flowchart TD
    subgraph Host [Host process: Claude / Codex / AGY]
        MCP["llm-relay mcp (stdio child)"]
        Runner["LaneRunner / LaneJobStore"]
        MCP --> Runner
    end
    subgraph Daemon [llm-relay daemon: runProxy()]
        Ctrl["Control API: POST /dispatch/telemetry"]
        Acct["AccountingStore (single writer)"]
        Stats["Lane stats series (separate from runtime telemetry)"]
        Ctrl --> Acct
        Ctrl --> Stats
    end
    subgraph Disk [Persistent storage]
        Usage["~/.llm-relay/usage/"]
        LaneStats["~/.llm-relay/dispatch-lane-stats.json (cache-kind)"]
        Acct --> Usage
        Stats --> LaneStats
    end
    Runner -- "report (lane, kind, wall-clock, exit, status, estimated tokens)" --> Ctrl
```

### 3.1 New daemon control route: `POST /dispatch/telemetry`

- Lives in `src/routes/admin.ts` beside the existing `/dispatch` controls.
- Shares the ONE admission boundary of the mutating control routes: exact loopback `Host`, exact
  match for any present `Origin`, `content-type: application/json`, and the per-install control
  token (`control-authorization.ts`) — the `reportMcpExhaustion` pattern.
- The payload carries COUNTS and LENGTHS only. Never the task text, never the lane's output
  (logs-are-metadata-only invariant; `logSafePath` precedent).

```ts
interface DispatchedTelemetryReport {
  jobId: string;
  laneId: string;
  kind: "cli" | "relay";
  spec?: string;
  providerKey?: string;
  modelId?: string;
  wallClockMs: number;
  exitCode: number | null;
  status: "completed" | "failed" | "timed_out";
  estimatedInputTokens: number;   // ceil(task.length / 4)
  estimatedOutputTokens: number;  // ceil(output.length / 4)
}
```

### 3.2 Forwarding from `McpDispatchServer`

- `McpServerDeps` gains `reportTelemetry?: (report) => Promise<void> | void`.
- `src/cli.ts` supplies `reportTelemetry: (report) => reportMcpTelemetry(cfg, report)`, which
  POSTs to the daemon with the local control token exactly as the exhaustion report does.
- On an agent-mode job reaching a terminal state: skip `cancelled`; compute
  `wallClockMs = max(0, (endedAt ?? now) - startedAt)`; compute the two estimates; forward
  asynchronously inside a swallow-all catch so forwarding can never interrupt the stdio protocol
  or fail a dispatch. Answer-mode jobs are never forwarded.

### 3.3 Daemon-side recording

On a valid report:

- **Accounting (cli-kind only, D1):** open a request on the daemon's existing store — role
  `serve`, client `mcp-dispatch`, attribution `unknown`, `tokenBasis: "estimated"`,
  `method: "relay_estimate"`, no credential id, no price — and complete it with the two
  estimates. `failed`/`timed_out` complete as failures; nothing is ever written as `0` tokens.
  Whether a run is "metered by the relay" is decided by the DAEMON from the rung's declared
  env — a `cli` rung whose env routes its harness back through this listener is already
  metered by the HTTP pipeline, and the report's own `kind` is never trusted (the C1
  finding: the rung's kind is the authority, a mismatch records stats only).
- **Lane stats (both kinds):** a per-rung series — calls, successes, failures, timeouts, a
  bounded wall-clock sample window — held per `Config` beside the exhaustion state, mirrored to
  a cache-kind file through the shared `WriteBehindTimer`, restored on start with field-by-field
  validation (the `dispatch-exhaustion-persistence.ts` shape). It never touches
  `runtime-telemetry.json` and never feeds `speedScore`, latency demotion or pool ranking.
- Rendered on the ladder surfaces (`dispatch_lanes`, `llm-relay dispatch`, `llm-relay lanes`)
  as advisory columns; never used to reorder the ladder.

## 4. Out of scope

- Lanes the HOST executes itself after `llm-relay dispatch --next-command` — the relay never
  sees them run, so there is nothing to report.
- Any change to HTTP pool scoring, latency demotion or hedging.
- The recorded immediate next (post-commit stalls) — unchanged in the backlog.

## 5. Verification plan

Automated:

- `test/mcp-telemetry-forwarding.test.ts` — (1) the server forwards a report on agent-mode
  completion; (2) answer-mode jobs are NOT forwarded; (3) cancelled jobs are dropped;
  (4) a forwarding error is swallowed and the stdio protocol keeps working; (5) a relay-kind
  agent-mode job forwards lane stats but is flagged so the daemon records no accounting row.
- `test/admin-dispatch-telemetry.test.ts` — (1) the route accepts a valid report with the control
  token and rejects a missing token, a foreign `Origin`, a non-JSON content type and a malformed
  body; (2) the store records ONE attempt with `tokenBasis: "estimated"`; (3)
  `runtime-telemetry.json` HTTP scores are untouched; (4) a relay-kind report updates lane stats
  only.

Manual, after release and global reinstall: run MCP `dispatch` on `opencode-muse-spark`; confirm
the estimated envelope appears in `llm-relay cost`; confirm `llm-relay telemetry` HTTP speed
scores are unchanged and the lane row shows the call.
