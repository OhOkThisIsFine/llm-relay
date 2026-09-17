# Post-commit stream failure — what Claude Code and Codex actually do (2026-09-09)

Packet P12, lap `2026-09-09-plan-all-27-open-backlog-items-and-offlo`. Backlog item 18
(`docs/backlog.md`), the measurement `docs/history/hedged-attempts-design-2026-08-30.md` §12 called for:

> **Property:** a dated doc records what Claude Code and Codex do when a stream carries an SSE
> `error` after content has arrived — retry the request, or fail the turn — measured against a
> scratch relay on both fronts. If a retry reaches another candidate, the abort on a per-token
> stall threshold is built with an announced reason and a pinning test; if not, option B stands
> and this entry closes on the measurement alone.

This document is that measurement. It is measurement only — no source under `src/` or `test/`
changed, and nothing here decides for or against building the per-token abort; it reports what
was observed and applies the entry's own decision rule mechanically.

## Method

A hand-rolled anthropic-kind mock upstream (`mock-upstream.mjs`, Node `http`, no dependencies)
listened on `127.0.0.1:61236`. On every `POST /v1/messages` it logged an arrival timestamp and a
running per-process request counter to a log file, then streamed a valid Anthropic SSE prefix —
`message_start`, `content_block_start` (text), one `content_block_delta` with the text
`"Hello from the mock. "` — and then, by an env-var mode switch:

- **mode `error`** — sent `event: error` with
  `data: {"type":"error","error":{"type":"overloaded_error","message":"mock post-commit failure"}}`
  and ended the response.
- **mode `stall`** — sent nothing further and never ended the response (held the socket open
  indefinitely).

Every other path 404'd.

A scratch `llm-relay` (this worktree's `src/cli.ts` run under `tsx`, **not** the live relay on
`127.0.0.1:8791`) listened on `127.0.0.1:61237`, `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` both pointed at
a fresh temp directory so nothing under `~/.llm-relay/` was read or written. Its only provider was
`mock` (`kind: "anthropic"`, `base: "http://127.0.0.1:61236"`, `credentialMode: "contained"`,
`timeoutMs: 20000`, `stallTimeoutMs: 5000`), `routing.default` and all four `routing.tiers` pointed
at `mock/m`, `mode: "detect"`, `repair: { maxAttempts: 1, destructiveTools: [] }`.

⚠ **One deviation from the packet brief, forced by the type system**: the brief specified
`log: { level: "info", file: "<temp>/relay.log" }`. `Config["log"]["level"]` is
`"metadata" | "silent"` (`src/config-types.ts`) — `"info"` is not a legal value and would have
failed config load ("a load error names the key", as the brief itself warned). `"metadata"` was
used instead — the only level that actually writes rows, matching the intent ("metadata only" is
the log's own documented promise; see the `log.ts` row in `CLAUDE.md`).

Both clients ran from inside `C:\Code-worktrees\llm-relay\pkt-P12` (a git worktree; Codex needs no
`--skip-git-repo-check` there) against `ANTHROPIC_BASE_URL=http://127.0.0.1:61237` /
`model_providers.scratch.base_url="http://127.0.0.1:61237/v1"`, never against
`api.anthropic.com` or `api.openai.com`. Each run was bounded at 120 s via `timeout 120s`. Codex
needed no `env_key` override to start against the custom provider — the base command from the
brief worked unmodified.

Every measured request landed on the mock; nothing reached `127.0.0.1:8791`, `~/.llm-relay/`,
`~/.codex/config.toml`, or `~/.claude`.

### Exact commands

Mock (mode set per cell via `MOCK_MODE`):

```
MOCK_MODE=error|stall MOCK_LOG_FILE=<temp>/mock*.log MOCK_PORT=61236 node <temp>/mock-upstream.mjs
```

Scratch relay (started once, left running for all four cells; only the mock was restarted between
modes):

```
XDG_CONFIG_HOME=<temp>/xdg-config XDG_CACHE_HOME=<temp>/xdg-cache \
  node node_modules/tsx/dist/cli.mjs src/cli.ts --config <temp>/relay-config.resolved.json
```
Startup line: `llm-relay listening on http://127.0.0.1:61237 (mode=detect, providers=[mock], default=mock/m)`

Cell 1 / cell 2 (Claude Code):

```
ANTHROPIC_BASE_URL=http://127.0.0.1:61237 ANTHROPIC_AUTH_TOKEN=dummy \
CLAUDE_CONFIG_DIR=<temp>/claude-config \
CLAUDE_CODE_MAX_CONTEXT_TOKENS=131072 \
CLAUDE_STREAM_IDLE_TIMEOUT_MS=60000 CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=60000 API_FORCE_IDLE_TIMEOUT=0 \
(CLAUDECODE and CLAUDE_CODE_ENTRYPOINT unset) \
timeout 120s claude -p "Reply with one word." --model mock/m --max-turns 1
```

Cell 3 / cell 4 (Codex), run from inside the worktree:

```
timeout 120s codex exec \
  -c model_provider=scratch \
  -c 'model_providers.scratch.name="scratch"' \
  -c 'model_providers.scratch.base_url="http://127.0.0.1:61237/v1"' \
  -c 'model_providers.scratch.wire_api="responses"' \
  -m mock/m -s read-only "Reply with one word."
```

Client versions: `claude --version` → `2.1.237 (Claude Code)`; `codex --version` →
`codex-cli 0.153.2`.

## The four cells — raw counts

| Cell | Client | Failure shape | Mock request count | Inter-request gaps | Client exit code | Final output contains "Hello"? |
|---|---|---|---:|---|---:|---|
| 1 | Claude Code | SSE `error` after content | **2** | 64 ms | 1 | No |
| 2 | Claude Code | Silent stall after content | **2** | 5052 ms | 1 | No |
| 3 | Codex | SSE `error` after content | **6** | 240, 432, 799, 1626, 3154 ms | 1 | No |
| 4 | Codex | Silent stall after content | **6** | 5216, 5475, 5816, 6549, 8362 ms | 1 | No |

"Retry" per the packet's own definition: the mock logging a **second** `POST /v1/messages` for one
client invocation. All four cells show it — cells 1–2 once, cells 3–4 five times (Codex printed
`ERROR: Reconnecting... N/5` for N = 1..5 on both failure shapes, each reconnect a genuinely new
HTTP request the mock counted separately).

Every relay-log row below (`<temp>/relay.log`, `log.level: "metadata"`) matching a cell's turn was
cross-checked 1:1 against the mock's own independent request count — every count agrees between
the two logs.

### Cell 1 — Claude Code, SSE `error`

Mock (`<temp>/mock.log`, excerpt):
```
REQUEST #1 at 2026-09-09T21:22:50.748Z mode=error method=POST path=/v1/messages
REQUEST #1 sent event:error, ending response
REQUEST #2 at 2026-09-09T21:22:50.812Z mode=error method=POST path=/v1/messages
REQUEST #2 sent event:error, ending response
```
Gap: 64 ms — matching the client's own reported "first after 64 ms" (see stderr below).

Relay log (`/v1/messages`) rows, both `backendStatus: 200`, `validated: "pass"`, `hadTools: true`
(Claude Code declares its built-in toolset even for a one-shot `-p` call with no tool use):
```json
{"ts":"2026-09-09T21:22:50.721Z","path":"/v1/messages?beta=<4c>","servedProvider":"mock","servedModel":"m","attempts":[{"provider":"mock","model":"m","status":200,"ms":36}],"hadTools":true,"streamed":true,"backendStatus":200,"validated":"pass","repair":"none","latencyMs":73}
{"ts":"2026-09-09T21:22:50.807Z","path":"/v1/messages?beta=<4c>","servedProvider":"mock","servedModel":"m","attempts":[{"provider":"mock","model":"m","status":200,"ms":18}],"hadTools":true,"streamed":true,"backendStatus":200,"validated":"pass","repair":"none","latencyMs":21}
```
Client exit code: **1**. stderr:
```
API Error: API returned an empty or malformed response (HTTP 200) — check for a proxy or gateway
intercepting the request. Response: content-type event-stream, body is an event stream (the
non-streaming request was answered with a stream), 598 bytes, request-id absent, intermediary
headers transfer-encoding. This was the non-streaming retry of streaming request (no Anthropic
request-id), which failed with: other; 3 stream events received, first after 64 ms, none in the
final 11 ms.
```
Claude Code's own message states the mechanism directly: it retried the failed streaming turn as
a **non-streaming** request. The mock always answers with an SSE stream regardless of the
inbound `stream` flag (it was built to the brief's spec, which does not ask for `stream:false`
handling), so the retry itself failed for a second, different reason — the client never saw a
clean answer either way. That is a limitation of this measurement's mock, stated plainly: the
COUNT of retries is solid (two independently-logged requests, cross-checked against the relay's
own log), but this document cannot say whether a retry that COULD be answered cleanly by a real
backend would have succeeded, only that Claude Code issues one.

### Cell 2 — Claude Code, silent stall

Mock (`<temp>/mock-stall.log`, excerpt):
```
REQUEST #1 at 2026-09-09T21:23:47.293Z mode=stall method=POST path=/v1/messages
REQUEST #1 entering stall — holding socket open, no more bytes
REQUEST #2 at 2026-09-09T21:23:52.345Z mode=stall method=POST path=/v1/messages
REQUEST #2 entering stall — holding socket open, no more bytes
```
Gap: 5052 ms — this is the scratch relay's own configured `stallTimeoutMs` (5000 ms) firing
first: `withStallWatchdog` (`src/stream-pipeline.ts`) aborts the backend fetch after 5000 ms with
no new bytes, which surfaces to the client as a synthetic mid-stream `event: error`
(`sseError()`, `src/stream-pipeline.ts`) rather than a literal silent hang all the way to the
client's own idle timeout (60000 ms, per the isolated `CLAUDE_CONFIG_DIR` gotcha's env vars). The
relay log confirms this — `errorKinds":["backend_stream_failed"]` and `"status":"committed"` (a
non-numeric status, distinct from cell 1's numeric `200`):
```json
{"ts":"2026-09-09T21:23:47.266Z","path":"/v1/messages?beta=<4c>","servedProvider":"mock","servedModel":"m","attempts":[{"provider":"mock","model":"m","status":"committed","ms":5021}],"hadTools":true,"streamed":true,"backendStatus":200,"validated":"skipped","errorKinds":["backend_stream_failed"],"repair":"none","latencyMs":5046}
{"ts":"2026-09-09T21:23:52.322Z","path":"/v1/messages?beta=<4c>","servedProvider":"mock","servedModel":"m","attempts":[{"provider":"mock","model":"m","status":"committed","ms":5026}],"hadTools":true,"streamed":true,"backendStatus":200,"validated":"skipped","errorKinds":["backend_stream_failed"],"repair":"none","latencyMs":5047}
```
Client exit code: **1**, total wall clock 11 s. stderr (same shape as cell 1, again the
non-streaming-retry-answered-with-a-stream failure):
```
API Error: API returned an empty or malformed response (HTTP 200) ... This was the non-streaming
retry of streaming request (no Anthropic request-id), which failed with: other; 3 stream events
received, first after 45 ms, none in the final 5011 ms.
```
So this cell measures the relay's own watchdog turning a stall into an error, not an unbounded
client-side hang — with `stallTimeoutMs` at its packet-specified 5000 ms, Claude Code never had to
wait out its own 60 s idle timers. The client still retried exactly as in cell 1.

### Cell 3 — Codex, SSE `error`

Mock (`<temp>/mock-error-codex.log`, excerpt — six requests, all against `/v1/messages` because
the scratch relay translates Codex's `/v1/responses` call into an Anthropic-shaped request against
the `anthropic`-kind `mock` provider):
```
REQUEST #1 at 2026-09-09T21:25:16.635Z ... sent event:error, ending response
REQUEST #2 at 2026-09-09T21:25:16.875Z ... sent event:error, ending response   (+240 ms)
REQUEST #3 at 2026-09-09T21:25:17.307Z ... sent event:error, ending response   (+432 ms)
REQUEST #4 at 2026-09-09T21:25:18.106Z ... sent event:error, ending response   (+799 ms)
REQUEST #5 at 2026-09-09T21:25:19.732Z ... sent event:error, ending response   (+1626 ms)
REQUEST #6 at 2026-09-09T21:25:22.886Z ... sent event:error, ending response   (+3154 ms)
```
Relay log — six `/v1/responses` rows, all `backendStatus: 200`, `errorKinds: []` (the Responses
front logs the HTTP status of the response headers rather than the later mid-stream classification
— unlike cell 2's Anthropic-front rows; this document reports the fact rather than explaining the
front-to-front asymmetry, which is outside this packet's scope):
```json
{"ts":"2026-09-09T21:25:16.629Z","path":"/v1/responses","servedProvider":"mock","servedModel":"m","attempts":[{"provider":"mock","model":"m","status":200,"ms":10}],"streamed":true,"backendStatus":200,"latencyMs":13}
{"ts":"2026-09-09T21:25:16.873Z","path":"/v1/responses", ...,"attempts":[{"status":200,"ms":3}],"latencyMs":5}
{"ts":"2026-09-09T21:25:17.304Z","path":"/v1/responses", ...,"attempts":[{"status":200,"ms":4}],"latencyMs":6}
{"ts":"2026-09-09T21:25:18.103Z","path":"/v1/responses", ...,"attempts":[{"status":200,"ms":3}],"latencyMs":5}
{"ts":"2026-09-09T21:25:19.729Z","path":"/v1/responses", ...,"attempts":[{"status":200,"ms":3}],"latencyMs":6}
{"ts":"2026-09-09T21:25:22.883Z","path":"/v1/responses", ...,"attempts":[{"status":200,"ms":4}],"latencyMs":6}
```
Client exit code: **1**, wall clock 9 s. stdout/stderr:
```
ERROR: Reconnecting... 1/5
ERROR: Reconnecting... 2/5
ERROR: Reconnecting... 3/5
ERROR: Reconnecting... 4/5
ERROR: Reconnecting... 5/5
ERROR: stream disconnected before completion: stream closed before response.completed
ERROR: stream disconnected before completion: stream closed before response.completed
```
Codex retried **five times on its own** (a fixed, apparently backoff-spaced reconnect budget),
each attempt a genuinely fresh HTTP turn the relay's candidate walk processed independently — then
gave up and failed the turn once the budget was exhausted. Unlike Claude Code, every retry stayed
a **streaming** request (same `/v1/responses` path, `streamed: true` throughout) — Codex does not
downgrade to non-streaming on reconnect.

### Cell 4 — Codex, silent stall

Mock (`<temp>/mock-stall-codex.log`, excerpt — six requests):
```
REQUEST #1 at 2026-09-09T21:25:54.439Z ... entering stall
REQUEST #2 at 2026-09-09T21:25:59.655Z ... entering stall   (+5216 ms)
REQUEST #3 at 2026-09-09T21:26:05.130Z ... entering stall   (+5475 ms)
REQUEST #4 at 2026-09-09T21:26:10.946Z ... entering stall   (+5816 ms)
REQUEST #5 at 2026-09-09T21:26:17.495Z ... entering stall   (+6549 ms)
REQUEST #6 at 2026-09-09T21:26:25.857Z ... entering stall   (+8362 ms)
```
Relay log — six `/v1/responses` rows, each `ms` just over 5000 (the relay's `stallTimeoutMs`
firing each time), `backendStatus: 200`:
```json
{"ts":"2026-09-09T21:25:54.435Z","path":"/v1/responses", ...,"attempts":[{"status":200,"ms":5015}],"latencyMs":5016}
{"ts":"2026-09-09T21:25:59.652Z","path":"/v1/responses", ...,"attempts":[{"status":200,"ms":5025}],"latencyMs":5028}
{"ts":"2026-09-09T21:26:05.127Z","path":"/v1/responses", ...,"attempts":[{"status":200,"ms":5007}],"latencyMs":5010}
{"ts":"2026-09-09T21:26:10.943Z","path":"/v1/responses", ...,"attempts":[{"status":200,"ms":5010}],"latencyMs":5012}
{"ts":"2026-09-09T21:26:17.492Z","path":"/v1/responses", ...,"attempts":[{"status":200,"ms":5010}],"latencyMs":5012}
{"ts":"2026-09-09T21:26:25.855Z","path":"/v1/responses", ...,"attempts":[{"status":200,"ms":5017}],"latencyMs":5018}
```
Client exit code: **1**, wall clock 39 s. stdout/stderr — identical shape to cell 3:
```
ERROR: Reconnecting... 1/5
ERROR: Reconnecting... 2/5
ERROR: Reconnecting... 3/5
ERROR: Reconnecting... 4/5
ERROR: Reconnecting... 5/5
ERROR: stream disconnected before completion: stream closed before response.completed
ERROR: stream disconnected before completion: stream closed before response.completed
```
Same five-retry budget as cell 3, each retry costing roughly one more `stallTimeoutMs` (plus
Codex's own growing backoff between attempts) — 39 s total against the 120 s bound, comfortably
inside it.

## Conclusion

All four cells show a retry: a client-issued, genuinely fresh `POST` to the relay's front door,
counted a second (and in the Codex cells, up to a sixth) time by an independent observer (the
mock) and cross-confirmed by the relay's own metadata log. Both clients retry a stream that
carries an SSE `error` after content has arrived; both also retry a stream that goes silent after
content (the scratch relay's own inter-byte stall watchdog turns that into an `event: error` too,
at its configured `stallTimeoutMs`, rather than the client waiting out its own much longer idle
timers). Neither client's final output contained the mock's `"Hello from the mock."` text in any
cell — every one of these four turns failed from the caller's point of view, despite content
having streamed first.

Applying the entry's decision rule mechanically: **a retry reaches another candidate in every
cell measured, so build the per-token abort** — a per-token stall threshold, an announced reason
(mirroring `x-llm-relay-hedged`/`x-llm-relay-quota-demoted`'s existing pattern), and a pinning
test, per `docs/history/hedged-attempts-design-2026-08-30.md` §12's own framing of the only honest
post-commit remedy. This document does not design that abort; it only closes the measurement side
of backlog item 18's property and hands the "build" branch back to whoever picks up the entry
next.

One point worth carrying into that follow-on work, since it surfaced unasked here: Claude Code's
retry downgrades to a **non-streaming** request while Codex's retry stays **streaming** — an abort
mechanism aimed at "the relay hands the failure to the client to retry" should not assume the
retry arrives in the same wire shape as the original turn.
