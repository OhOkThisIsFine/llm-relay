# DeepSeek Responses-front truncation — capture attempt (2026-09-09, packet P-DS/P-DS-b)

## Verdict up front

**Could not reproduce.** Three `codex exec` runs against a fully instrumented capture chain
(DeepSeek's own Chat-Completions stream teed byte-for-byte, and the relay's emitted
Responses stream teed byte-for-byte) produced **zero** occurrences of the target signature —
Codex's `failed to parse function arguments: EOF while parsing a string` or the relay's
`function_call "…" arguments are not valid JSON` — across 68 upstream requests and 69 emitted
requests. Every `tool_calls[].function.arguments` / `response.function_call_arguments.delta`
reassembly checked (mechanically, by script) was valid JSON. So **none of cases (a), (b), (c)**
from `BRIEF.md` step 5 is established, because the triggering condition never occurred. No
source change was made — inventing a fix for an uncaptured symptom would contradict this
packet's own "measurement first" rule.

Instead, the same reproduction command surfaced **three different, real, first-party-observed
failures** in the same DeepSeek → relay → Codex chain, none of which is the backlog's cut-string
bug. They are recorded below because they are plausibly why 3/3 attempts here never got deep
enough into a long tool-using conversation to hit whatever the original 5/5 live-relay runs hit.

## Setup (exact commands and ports)

Working directory for the relay and `codex exec`: `C:\Code-worktrees\llm-relay\pkt-PDS`.
Temp root (`TMPROOT`):
`C:\Users\<user>\AppData\Local\Temp\claude\C--Code-llm-relay\ca52d5b6-a0d8-43af-9750-630dace51503\scratchpad\pkt-PDS\`.

Three loopback processes, in order:

1. **Upstream tee** — `node tee-proxy.mjs --port 8930 --target https://api.deepseek.com --outDir <TMPROOT>/captures --prefix upstream`. Forwards `POST /v1/chat/completions` to DeepSeek byte-for-byte (credential passed through, `authorization` redacted only in the sidecar `.meta.json`), tees every response byte to `captures/upstream-<n>.sse`.
2. **Scratch relay** — `npx tsx src/cli.ts --config <TMPROOT>/scratch-relay-config.json`, listening on `127.0.0.1:8931`, `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`HOME` all under `<TMPROOT>`. One provider `deepseek` (`kind: "openai"`, `base: "http://127.0.0.1:8930/v1"`, `authEnv: "DEEPSEEK_API_KEY"`, `timeoutMs: 120000`), `routing.default` and all four tiers at `deepseek/deepseek-v4-pro`, `mode: "detect"`, `repair: { maxAttempts: 1, destructiveTools: [] }`. `DEEPSEEK_API_KEY` was read from the process environment only — never printed, logged, or written to any file.
3. **Client-side tee** — `node tee-proxy.mjs --port 8932 --target http://127.0.0.1:8931 --outDir <TMPROOT>/captures --prefix emitted`. Forwards `POST /v1/responses` to the scratch relay, tees every response byte to `captures/emitted-<n>.sse`.

**Port note (this packet, per orchestrator correction):** port 8930 was found already bound to
a stale `node.exe` (Windows PID 20852, left running by the previous lane's tee-proxy). Confirmed
with `tasklist //FI "PID eq 20852"` (image name `node.exe`), then `taskkill //PID 20852 //F`.
Ports 8930/8931/8932 were then all free (`netstat -ano | findstr :893` showed no listeners), so
no port renumbering was needed and no script/config edits were required.

Pre-flight check (per `BRIEF-B.md` step 1): `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8931/telemetry` → `200`, confirmed before any Codex run.

**Reproduction command** (`BRIEF.md` step 4, with `BRIEF-B.md`'s port and one added override):

```
codex exec \
  -c model_provider=scratch \
  -c 'model_providers.scratch.name="scratch"' \
  -c 'model_providers.scratch.base_url="http://127.0.0.1:8932/v1"' \
  -c 'model_providers.scratch.wire_api="responses"' \
  -c 'model_providers.scratch.requires_openai_auth=true' \
  -m deepseek/deepseek-v4-pro \
  -s read-only \
  "List the files in this directory, then read package.json and tell me the version."
```

Run three times, each wrapped in `timeout 300` (a 300 s bound), stdout+stderr captured to
`<TMPROOT>/codex-run-<n>.log`. Codex CLI version: `codex-cli 0.153.2` (`codex --version`).

The live `~/.codex/config.toml` (read-only, never edited) was checked to confirm the `scratch`
provider's shape matches the real `[model_providers.llm-relay]` entry it stands in for:
`base_url = "http://127.0.0.1:8791/v1"`, `wire_api = "responses"`, `requires_openai_auth = true`
— all three carried into the scratch override, so the reproduction is not structurally
mismatched from the live provider definition.

## Results per run

All three ran against the **same** long-lived relay/tee processes (never restarted between
runs), so the tee proxies' request counters are cumulative across runs, not per-run: run 1 is
upstream requests #1–21 (emitted #1–21, interleaved with `GET /v1/models` calls), run 2 is
upstream #22–61 (emitted #22–68), run 3 is upstream #62–68 (emitted #69, plus its own
`GET /v1/models` calls). File numbers cited below are the exact, verified numbers from each
run — not approximations.

### Run 1 — `codex-run-1.log`, exit `124` (killed at the 300 s bound)

DeepSeek never produced a usable answer within its completion-token budget for most of the 21
requests. Example, `captures/upstream-3.sse` (324,024 reconstructed bytes; see "Marker-stripping
note" below for why the raw tee-file byte count differs): 2,479 SSE lines of `reasoning_content`
deltas, terminating in

```
data: {...,"choices":[{"index":0,"delta":{"content":"","reasoning_content":null},
"logprobs":null,"finish_reason":"length"}],
"usage":{"prompt_tokens":22982,"completion_tokens":1024,"total_tokens":24006,
"prompt_tokens_details":{"cached_tokens":0},
"completion_tokens_details":{"reasoning_tokens":1024},
"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":22982}}
```

`completion_tokens: 1024` and `reasoning_tokens: 1024` — the **entire** completion budget for
that request was consumed by chain-of-thought, zero left for an actual answer or tool call. The
relay's `stream-commit.ts` correctly classified this as no meaningful content and returned a
buffered 502 to Codex (`captures/emitted-3.sse`: `{"error":{"message":"llm-relay: stream
completed without meaningful content","type":"api_error"}}`), which Codex logged as
`ERROR: Reconnecting... 1/5` and retried. This pattern repeated for requests #3–7, #9–16 (12 of
21 upstream requests in this run). This matches the `CLAUDE.md` `responses-request.ts` row
verbatim: *"`max_output_tokens` absent carries llm-bridge's 1024 — a default, not a
measurement"* — Codex's Responses request apparently did not carry `max_output_tokens` through
in a way this relay's Responses→Anthropic mapper picked up, so the 1024-token llm-bridge default
went out to DeepSeek as `max_tokens: 1024`, and DeepSeek (a reasoning model at Codex's `ultra`
effort) burned the whole budget thinking.

When DeepSeek *did* stay under budget and emit a tool call (requests #8, #17, #18, #20, #21 —
all `finish_reason: "tool_calls"`, all reassembled to **valid** JSON, confirmed with
`analyze-upstream.mjs`/`analyze-emitted.mjs`), Codex's own tool router rejected 3 of them with
`Fatal error: tool exec invoked with incompatible payload` (see "Ancillary finding 2" below) —
not a JSON-validity failure, a schema-shape one.

### Run 2 — `codex-run-2.log`, exit `0` (Codex gave up cleanly)

39 upstream requests (#22–61 in this run). DeepSeek reliably stayed under the token budget this
time (`finish_reason` was `"tool_calls"` on every request that produced a tool call; no
`"length"` cutoffs), and every tool call reassembled to valid JSON on both the upstream and
emitted sides. But **every single** `exec` tool call Codex tried to route failed with
`Fatal error: tool exec invoked with incompatible payload` — 30 occurrences logged. Codex's own
final answer: *"Every attempt to run a shell command was aborted by the environment… I tried 30+
variations… every single one returned `aborted`."* It never reached a second real tool-execution
turn, so it never got anywhere near the multi-thousand-token depth the backlog's "3k–20k tokens"
describes.

### Run 3 — `codex-run-3.log`, exit `1`

7 upstream requests (#62–68 in this run). Two more `incompatible payload` errors, then DeepSeek
itself returned **HTTP 400** on the third-from-last replay:

`captures/upstream-67.sse` (175 bytes, `responseStatus: 400` in `upstream-67.meta.json`):

```
{"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API.","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}
```

Repeated identically in `captures/upstream-68.sse`. The relay forwarded this verbatim (its
`normalizeOpenAiErrorBody()` byte-exact passthrough for a conforming error shape) to Codex as
`captures/emitted-69.sse`:

```
{"error":{"message":"openai backend HTTP 400: {\"error\":{\"message\":\"The `reasoning_content` in the thinking mode must be passed back to the API.\",\"type\":\"invalid_request_error\",\"param\":null,\"code\":\"invalid_request_error\"}}","type":"api_error"}}
```

This matches the `CLAUDE.md` `openai-request.ts` row: *"`thinking`/`redacted_thinking`,
`metadata` and the request-level `thinking` budget are DROPPED"* when the relay maps an Anthropic
conversation back onto an OpenAI Chat request. DeepSeek's own API requires the prior turn's
`reasoning_content` to be echoed back on any multi-turn "thinking mode" replay; the relay drops
it (by design, per that row — there is no Anthropic-side representation to carry it in), so
DeepSeek rejects the second real multi-turn request outright.


## Aggregate over all 68 captures (added 2026-09-10, after an independent audit)

⚠ **This section exists because the figure it states was cited in four places and lived in none.**
The commit that shipped the fix (`6a17905`), the `responses-request.ts` row of `CLAUDE.md`,
`HANDOFF.md` §0 and the lap closeout all quoted "20 of 68 answers ended at exactly 1024, and all
44 `response.completed` events said `completed`" — and an independent auditor, reading only this
document, correctly reported that no such tally appeared anywhere in it and that this document's
own headline verdict is the opposite ("could not reproduce"). Both things were true at once: the
CUT STRING was never reproduced, and the aggregate was real but unwritten. It is written now, and
it is re-derivable by anyone with the captures.

Re-derived mechanically from `captures/upstream-*.sse` and `captures/emitted-*.sse` — no prose was
read to produce these numbers:

| Figure | Count |
|---|---|
| upstream captures | 68 |
| upstream captures carrying a `usage` block | 64 |
| upstream answers ending `finish_reason: "length"` | **20** |
| …of those, ending at exactly `completion_tokens: 1024` | **19** |
| …the one exception, `upstream-2.sse` | `completion_tokens: 1` (a one-token probe, not the cap) |
| emitted captures | 69 |
| emitted `response.completed` events | **44** |
| …of those, carrying `incomplete_details` | **0** |
| emitted `response.incomplete` events | **0** |

The nineteen capped answers are `upstream-3,4,5,6,7,9,10,11,12,13,14,15,16,23,24,62,63,64,65`.

**What the aggregate does and does not establish.** It establishes the MECHANISM the fix in
`6a17905` addresses: the relay substituted a `max_tokens` nobody asked for, roughly a quarter of
the upstream answers hit it, and the relay then announced every single completion as `completed`
with no `incomplete_details` — so a caller had no way to learn that an answer was cut. It does NOT
establish that this is what killed the five Codex runs; the truncated tool-call argument was never
reproduced in three read-only runs, exactly as §1 of this document says. Read the fix as a
response to a demonstrated announcement defect, not as a reproduction of the death.

⚠ Two corrections to the wording that was in circulation, both from this re-derivation: it is
**19** of 68 at exactly 1024 (20 ended `length`, one of them at one token), and 44 is the count of
`response.completed` events across the emitted captures, not of upstream answers.

## Fix landed (2026-09-10, lap 232d8bef package-0)

The three ancillary findings below became the work of the "move llm-relay onto DeepSeek V4.1
Flash (`deepseek-flash`)" lap. Two of the three are now fixed in `src/`; the third (Codex's
`exec` shape) is the model's own output and stays with repair mode. What changed:

- **The Anthropic path carries the caller's thinking intent.** `src/openai-request.ts` previously
  dropped the request-level `thinking` control ("mapping it to `reasoning_effort` would be a
  guess"). Under a RESOLVED `compat.reasoning: "deepseek"` mode — a new `compat` key defaulting
  from the labelled host fact `api.deepseek.com`, an explicit value winning both ways, the
  `toolCallIds`/`thoughtSignature` precedent — the mapper now forwards `thinking: {type:"disabled"}`
  verbatim and maps an explicit effort (`output_config.effort` / `reasoning.effort`) or the routed
  pool's effort band to DeepSeek's `reasoning_effort` (`low|high|max`; the pool's `medium`→`high`
  and `xhigh`→`max`). Every other provider's outbound bytes are unchanged.
- **A DeepSeek lane defaults thinking OFF when the caller sent no thinking control.** Finding #3
  below is the cheaper safe route, chosen explicitly over round-tripping `reasoning_content`:
  DeepSeek's thinking mode requires the prior turn's `reasoning_content` to be replayed on a
  multi-turn conversation (HTTP 400 otherwise), and this relay deliberately holds no store to
  round-trip it, so a multi-turn agent lane must not think by default. A caller that explicitly
  asks for thinking (`thinking: {type:"enabled"}` or an explicit effort) still gets it.
- **Pool admission.** `deepseek/deepseek-flash` was missing from the pools because the synced
  `docs/tier-data.json` snapshot carries no `deepseek-flash` row with capability signals (its only
  namesakes are `deepseek-v4-flash` — a different, dated SKU — and `deepseek-v4-flash-latest`, a
  zero-signal stub), so `findTierModel` resolves it as `neutral`/`fuzzy` and it clears no effort
  band; `deepseek-v4-pro` has a 4-signal snapshot row and clears every band. Fixed by routing each
  pool's `preferred` prefix to `deepseek/deepseek-flash` (a live config edit, not a source change —
  stated in the lap report as exact JSON).


None of these is the backlog's cut-string bug (that bug is about a tool call's `arguments`
string itself being **truncated mid-JSON** — invalid JSON, an `EOF while parsing a string`).
These are separate, but they plausibly explain why this reproduction never got deep enough into
a real multi-tool-call, multi-thousand-token conversation to hit it:

1. **`max_tokens` defaults to 1024 for a reasoning-heavy model, consuming the whole budget on
   thought before any tool call is attempted at all** (run 1). Confirmed first-party via
   `completion_tokens: 1024` / `reasoning_tokens: 1024` in `usage`, matching `CLAUDE.md`'s
   documented llm-bridge default exactly.
2. **A tool-call schema/shape mismatch on the `exec` tool under `-s read-only`.** DeepSeek
   inconsistently named the argument field `command` (e.g. `captures/upstream-17.sse`:
   `{"command": "Get-ChildItem -Force | …"}`) or `cmd` (e.g. `captures/upstream-25.sse`:
   `{"cmd": "Get-ChildItem -Force | …"}`, `captures/upstream-28.sse`: `{"cmd": "echo test"}`) and
   sent the value as a **bare string**, not an array — both syntactically valid JSON, but
   apparently not the shape Codex 0.153.2's read-only `exec` tool router accepts, since every one
   of them (bytes 14–132, all valid JSON, confirmed by script) still failed with
   `Fatal error: tool exec invoked with incompatible payload`. Original "what is known" names the
   tool `exec_command`, not `exec` — this Codex build may expose a different tool identity/schema
   under `-s read-only` than whatever sandbox mode produced the original 5/5 reproduction, which
   would explain the naming mismatch too.
3. **The relay drops `reasoning_content` across turns, and DeepSeek's API refuses a replay
   without it** (run 3), ending the conversation at HTTP 400 after only 1–2 real tool-call turns.

Any of these — especially #2, which blocked *every* real tool execution in run 2 — would starve
a run of the many-tool-call depth (3k–20k tokens, per the backlog entry) needed to hit a rarer
mid-argument truncation. This packet does not attempt to fix any of the three (out of scope,
unmeasured beyond what is captured here, and two of the three already have their own root cause
named above rather than needing a fresh capture) — flagged here for the orchestrating session to
decide whether any becomes its own backlog entry.

## Marker-stripping note (methodology)

`tee-proxy.mjs` writes a `: T+<ms>ms n=<bytes>\n` comment **immediately before every raw
upstream/relay chunk**, at arbitrary byte offsets that do not respect SSE line boundaries — a
marker can land mid-line, splitting one `data: {...}` JSON line into two on disk. A naive
line-by-line parse of the raw `.sse` file therefore reports spurious "unparseable" lines that are
artifacts of the tee, not of the wire. `analyze-upstream.mjs` and `analyze-emitted.mjs` first
regex-strip every `: T+\d+ms n=\d+\n` marker from the raw bytes (via a `latin1` 1:1 byte mapping,
so the strip is byte-exact and safe across multi-byte UTF-8 sequences — the ASCII marker pattern
cannot occur inside a UTF-8 continuation byte), reconstructing the exact original response body,
before splitting into lines. Verified against `upstream-17.sse`/`emitted-17.sse`: the
reconstructed byte counts (206509 / 5282) match the tee proxy's own console-logged
`bytes=206509` / `bytes=5282` for those requests exactly, and the two sides' reassembled
`arguments` strings are byte-identical (`deltas === done-event: true`).

## Files written

In the working directory `C:\Code-worktrees\llm-relay\pkt-PDS`:
- `docs/deepseek-responses-truncation-2026-09-09.md` — this document.
- `out-pkt/pkt-PDS.report.md` — the packet report for the orchestrating session.
- No `src/` or `test/` changes were made, so no `out-pkt/pkt-PDS.patch` was produced (per
  `BRIEF.md` rule 6, the patch step applies only "if you changed `src/` or `test/`").

Under `TMPROOT` (left in place per `BRIEF-B.md` step 4 — "Leave the captures in place — the
orchestrating session reads them"):
- `captures/upstream-1.sse` … `captures/upstream-68.sse` (+ matching `.meta.json` / `.chunks.log`)
  — DeepSeek's raw Chat-Completions responses, byte-for-byte.
- `captures/emitted-1.sse` … `captures/emitted-69.sse` (+ matching `.meta.json` / `.chunks.log`)
  — the scratch relay's raw Responses-API responses to Codex, byte-for-byte.
- `codex-run-1.log`, `codex-run-2.log`, `codex-run-3.log` — Codex's stdout+stderr for each of the
  three attempts, plus its own exit code.
- `upstream-tee.log`, `client-tee.log`, `relay-start.log` — the three background processes'
  console output.
- `upstream-tee.log`'s own per-request summary line and `client-tee.log`'s equivalent give exact
  status/byte-count/timing for every one of the 68/69 requests without needing to open every
  capture file.
- `analyze-upstream.mjs`, `analyze-emitted.mjs`, `scan-run.mjs` — the marker-aware reassembly and
  validity-checking scripts used to produce every claim in this document mechanically (grep- and
  eyeball-checked, not asserted from memory).
- `run-codex.sh` — the wrapper script used for all three attempts (`sh run-codex.sh <n>`).

## What could not be done

**The target failure — a tool-call argument string arriving truncated, producing Codex's
`failed to parse function arguments: EOF while parsing a string` and the relay's
`function_call "…" arguments are not valid JSON` refusal — did not reproduce in any of the 3
permitted attempts.** Every reassembled tool-call-argument string, on both the upstream DeepSeek
side and the relay's emitted Responses side, across all 68/69 captured requests, was valid JSON
(confirmed mechanically, not by inspection alone). Consequently:
- Step 5's "locate the cut" could not be performed — there was no cut to locate.
- Step 6's branch (a)/(b)/(c) determination does not apply: none of the three preconditions
  ("DeepSeek's own concatenation is already truncated" / "the relay's emitted concatenation is
  cut" / "both complete and Codex cut it") was observed, because the underlying event (a
  truncated argument string reaching Codex at all) never happened. No pinning test and no source
  change were written, consistent with the packet's "measurement first" framing — there is
  nothing to pin a test against.
- Whether this environment's differences from the original 5/5 reproduction (Codex CLI version,
  `-s read-only` sandbox exposing a differently-shaped `exec` tool, the `max_tokens`/
  `reasoning_content` issues starving every run of tool-call depth) are why the specific
  truncation never surfaced, versus the truncation being genuinely rare and the packet simply
  drew three misses, is **not established** — only that it did not reproduce here, three times,
  under the exact specified command.

## F10/F11 fixed (2026-09-10) — the request-shape half of ancillary finding 3

Ancillary finding 3 above ("The relay drops `reasoning_content` across turns, and DeepSeek's API
refuses a replay without it") was left open by the earlier "Fix landed" section — that section's
own third bullet ("A DeepSeek lane defaults thinking OFF when the caller sent no thinking control")
is a correct description of `deepSeekThinkingSpec` rule 5, but it is **not** what protects
pool-routed traffic, and this section corrects that. **F10** and **F11** are the two request-shape
defects this closes; both live in `src/openai-request.ts` and `src/responses-request.ts`.

**F10 — a forced tool choice conflicts with DeepSeek's thinking mode.** `deepSeekThinkingSpec`'s
rule 3 (the routed pool's effort band → `reasoning_effort`) is checked BEFORE rule 5 ("no thinking
control" → disabled), and `ResolvedTarget.effort` is stamped for nearly every `pool/*` resolution —
so pool-routed DeepSeek traffic runs with thinking ON by default, not off, whatever rule 5's own
name suggests. DeepSeek accepts only one of "forced tool" and "thinking", so an MCP `dispatch(...,
mode:"answer", schema:...)` call — which posts `tool_choice: {type:"tool", name:"answer"}`
(`runAnswerFetch` in `src/mcp/server.ts`) — 400ed on every pool-routed DeepSeek attempt. The relay's
own `refusal-interpretations.json` recorded this 18 times against `deepseek-v4-pro` and 2 times
against `deepseek-flash` as of this section (`deepseek|<model>|400|thinking mode does not support
this tool_choice`; the count includes this section's own live reproduction below). **Fix:** when
the outbound `tool_choice` is OpenAI's `"required"` or a named function AND the natural spec would
leave thinking on, the mapper now sends `thinking:{type:"disabled"}` and omits `reasoning_effort`
instead — an override, not a reordering of the five rules, counted through the new
`onDeepSeekThinkingOverridden` option and announced on the response as
`x-llm-relay-thinking-disabled` (`src/backend.ts`).

**F11 — a replayed tool-call turn with no reasoning fails the same way.** `openai-request.ts` and
`responses-request.ts` both dropped `thinking`/`redacted_thinking`/a Responses `reasoning` item
with no representation at all, so a caller could never hold or replay DeepSeek's own chain of
thought through this relay. The store above independently confirms the resulting 400 is real in
production: `deepseek|deepseek-v4-pro|400|the \`reasoning_content\` in the thinking mode must be
passed back to the api.`, count 3, first seen roughly four hours before the tool_choice burst on
the same day. **Fix, two parts:** (1) a replayed Anthropic `thinking` block's own text (never a
`redacted_thinking` block — that carries only Anthropic's own encrypted `data`) is now carried onto
the outbound assistant message's `reasoning_content`, byte for byte, only under the resolved
`compat.reasoning: "deepseek"` mode, and a Responses `reasoning` item's `summary` text is carried
the same way through the Anthropic-shaped intermediate `responses-request.ts` produces; (2) a SAFE
FALLBACK — when thinking would be on and any replayed assistant tool-call turn carries no
reasoning this relay can put on `reasoning_content`, the request now sends
`thinking:{type:"disabled"}` instead of risking the 400. The relay still never fabricates a
`reasoning_content` value.

**Live reproduction (2026-09-10, against the running relay, `deepseek/deepseek-flash` and
`deepseek/deepseek-v4-pro`, `max_tokens` 32–800):**

| # | Request shape | Result |
|---|---|---|
| 1 | `pool/high` + forced `tool_choice:{type:"tool",name:"answer"}`, no explicit thinking control | 200 (failed over to a lower-band member; `x-llm-relay-pool-attempts: 4 tried, 1 served: 2x400, 1x401, 1x200`) |
| 2 | `deepseek/deepseek-flash` DIRECT + forced tool_choice, no thinking control | 200 — direct specs get no pool effort, so rule 5 already disables thinking; NO conflict |
| 3 | `deepseek/deepseek-flash` DIRECT + forced tool_choice + `thinking:{type:"enabled"}` | **400** `Thinking mode does not support this tool_choice` |
| 4 | `deepseek/deepseek-v4-pro` DIRECT + forced tool_choice + `thinking:{type:"enabled"}` | **400**, same message |
| 5 | `deepseek/deepseek-v4-pro` DIRECT + forced tool_choice + `output_config:{effort:"high"}` (no `thinking` key at all) | **400**, same message — confirms the conflict fires off rule 2 (explicit effort) too, not only rule 3/4 |
| 6 | `deepseek/deepseek-v4-pro` DIRECT + `tool_choice:"auto"` + `thinking:enabled`, `max_tokens:32` | 502 "tool call could not be repaired" — a `max_tokens` artifact, not F10/F11: re-run at `max_tokens:300` returned 200 cleanly |
| 7 | Two- and three-turn tool-call conversations on `deepseek/deepseek-v4-pro`, thinking enabled, EACH replay carrying no `reasoning_content` (trivial "2+2", then a heavier 3-turn Fibonacci sequence) | All 200 — F11's exact "reasoning_content must be passed back" 400 did **not** reproduce live today, on either shape |

F10 reproduced cleanly and repeatedly, with two clean negative controls isolating the trigger to
"forced tool choice + thinking-would-be-on" specifically. **F11 did not reproduce live** despite a
genuine escalating attempt (mirroring this document's own §"Verdict up front" experience with the
truncation bug) — but the refusal-interpretations store above shows the identical, verbatim error
text occurred 3 times in production the same day, so the condition is real; it is simply narrower
or deeper-conversation-dependent than either this session's live attempts or the original 3 Codex
runs could reliably trigger.

**Why today's Claude Code lanes succeed on `deepseek-flash` regardless.** `runAnswerFetch` in
`src/mcp/server.ts` is the ONLY place in this codebase that constructs a forced `tool_choice`, and
it fires only for MCP answer-mode with an explicit `schema` — an ordinary Claude Code agentic
session's own multi-tool loop uses `tool_choice:"auto"` (or omits it), so F10 never applies to it.
For F11, the refusal store shows the reasoning_content-replay 400 recorded only against
`deepseek-v4-pro` — never once against `deepseek-flash` — even though all four production pool
tiers (`low`/`medium`/`high`/`xhigh`) route DeepSeek traffic through `deepseek-flash` as the
preferred member. Whether that is because V4.1 Flash enforces the replay requirement less strictly
than V4-Pro, or because flash's real traffic simply has not yet hit the narrow trigger shape, is
**not established** by this evidence alone — both fixes above are written to hold regardless of
which explanation is true.

Tests: `test/deepseek-thinking.test.ts` (the request-mapper unit tests, including the forced-choice
and reasoning-replay cases), `test/deepseek-responses-reasoning.test.ts` (the Responses-item
carrying half), and `test/pool-failover.test.ts` (`describe("DeepSeek reasoning wiring is isolated
to the declared target (F10/F11)")`, ≥2 candidates, pinning that a sibling candidate with no
`compat.reasoning` is byte-for-byte unaffected).
