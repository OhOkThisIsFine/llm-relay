# MCP host tool-call timeouts and progress notifications (2026-09-17)

**Question.** A native subagent answers in one call. `llm-relay mcp` `dispatch` hands back a job id
after `routing.mcp.maxWaitMs` (25 s) on every host, and the caller must poll. Which hosts survive a
longer tool call, and does an MCP `notifications/progress` message change the limit?

**Answer.** Claude Code survives a long call. The Claude desktop chat client and Codex do not. So
`dispatch` now waits for the answer when the client is `claude-code` and the call carries a
`progressToken`, up to `routing.mcp.blockingWaitMs` (default 25 min), and it sends progress every
30 s. Every other host keeps the 25 s ceiling. Code: `BLOCKING_WAIT_CLIENTS` and `blockingWaitFor`
in `src/mcp/server.ts`; tests: `test/mcp-blocking-wait.test.ts`.

## Measurements on this machine

| Host (`clientInfo.name`) | Evidence | Result |
|---|---|---|
| Claude Code 2.1.237 (`claude-code`), headless `claude -p`, Haiku | A probe MCP server (`wait_then_answer`) held one `tools/call` for 240 s and sent `notifications/progress` every 10 s. | Answer received. The call carried `_meta.progressToken: 2`. |
| Same, no progress notifications | Same probe, progress off. | Answer received at 240 s. |
| Same, no progress, 1,500 s | Same probe, progress off. | See the result section below. |
| Claude desktop chat client (`claude-ai`) | `%APPDATA%\Claude\logs\mcp*.log` | The client cancels a call at exactly 60 s: `-32001 Request timed out`. |
| Codex (code-mode `exec`) | 2026-09-10 transcript sweep (`docs/dispatch-giveup-diagnosis-2026-09-10.md` §8) | The `exec` tool yields its script at 31.0 s; a longer MCP call loses its result. |

Each headless run cost about USD 0.31 on Haiku. The probe files were in the session scratchpad
(`progress-probe/server.mjs`, `mcp-on.json`, `mcp-off.json`, `log-*.ndjson`).

## What the documentation states (Claude Code)

Collected by a documentation lookup, not measured here:

- `MCP_TOOL_TIMEOUT` is the wall-clock limit on one tool call. Its default is about 28 hours, and a
  per-server `timeout` in the MCP config overrides it. Progress does not extend it.
- A stdio server has an idle timeout of 30 minutes. A progress notification resets it.
  `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` changes it.
- An HTTP MCP server has a 60 s timer per request.
- The desktop app's Code tab runs the same engine as the CLI.
- Codex: `tool_timeout_sec` defaults to 60 s. The Codex documentation does not say whether Codex
  honours progress.

## Decisions

- **The default cap is 25 minutes**, under the 30-minute idle timeout, so a call survives even if a
  progress notification does not reset that timer. A lane still running at the cap degrades to a
  job id, as before.
- **A progress token is required.** Claude Code 2.1.237 sends one on every call. An older Claude
  Code that sends none keeps the 25 s ceiling. An earlier Claude Code failure at 60 s (2026-09-10)
  was probably a stale `llm-relay mcp` process; that is an inference, not a measurement, so the
  token gate stays.
- **A cancelled call gets no reply**, as the MCP specification asks. The job keeps running, and
  `dispatch_status` with no `jobId` lists it, so the caller can find it again.
- **`blockingWaitMs: 0` turns the blocking wait off** for every host.

## Not verified

- The desktop app's Code tab after a reinstall. It must restart its `llm-relay mcp` process to load
  the new code, and only the owner can restart that connection.
- Whether Codex honours progress. Codex stays at 25 s until a measurement says otherwise.

## Result of the 1,500 s probe

Pending when this document was written.
