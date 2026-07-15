# repair-proxy

A standalone, **loopback** Anthropic-Messages-API reverse proxy. It forwards `/v1/messages` to any backend model and **validates tool-call responses** against the request's `tools[].input_schema`, so the Claude Code harness (or any `ANTHROPIC_BASE_URL` client) can run on non-Anthropic models without pre-filtering them by tool competence.

**The one boundary:** it fixes/flags *protocol form* (malformed tool calls), never *judgment* (bad reasoning). See the spec.

## Status — M0 + M1 + M2 + M4

- ✅ M0 passthrough: forwards streaming + non-streaming `/v1/messages` byte-for-byte.
- ✅ M1 validator + `detect` mode: deterministic tool_use gate (Ajv2020), metadata-only logging of pass/fail/uncheckable — **behavior unchanged**, it only observes.
- ✅ M2 `repair` mode: on a validation failure, a cheap reshaper model reshapes the call, the result is **re-validated**, and the corrected response is re-emitted to the client (JSON or freshly-serialized SSE). Destructive-tool calls are **refused, never fabricated**; unrepairable calls **fail-clean** (502). Valid calls pass through untouched.
- ✅ **OpenAI-compatible backends** (`backend.kind:"openai"`): front NIM / vLLM / OpenRouter / LM Studio. Requests are translated Anthropic→OpenAI and responses back (streaming SSE + non-streaming) via [`llm-bridge`](https://github.com/supermemoryai/llm-bridge) (zero-dep). The validate/repair layer is unchanged — it always sees Anthropic Messages. Verified live end-to-end against NIM.
- ✅ M4 streaming: in `repair` mode, text-block SSE frames stream to the client **as they arrive**; the proxy only starts withholding at the first `tool_use` `content_block_start`. A pure-text response is byte-for-byte passthrough with zero added latency; a valid tool call flushes the withheld frames verbatim; an invalid one is repaired and only the corrected trailing blocks are re-emitted (`message_start` + leading text already delivered). If a repair fails mid-stream, a well-formed SSE `error` event is emitted — never a fabricated call. Handles LF and CRLF frame delimiters and multibyte UTF-8 across chunk boundaries.

### Live demo (no external creds)

```bash
npm run build && node scripts/live-demo.mjs
```
Runs the compiled CLI as a real process against a local flaky-model backend + stub reshaper, showing detect (logs the failure) then repair (delivers the fixed call).

## Install & run

```bash
npm install
npm run build
cp config.example.json config.json   # edit backend + auth
NVIDIA_API_KEY=nvapi-... node dist/cli.js --config config.json
# or, no build step:
NVIDIA_API_KEY=nvapi-... npm run dev -- --config config.json
```

## Use it from your projects

Point the `claude` CLI at the running proxy. **The one thing that matters:** give claude an **isolated `CLAUDE_CONFIG_DIR`**. Without it, an active claude.ai subscription session conflicts with the proxy token and claude fails client-side with `Invalid API key` / `401 Invalid bearer token` before any request is even sent. With it, the proxy's provider token is the sole credential — and your subscription is never in the path (the safe direction).

Wrappers do this for you (they also set the thinking/beta/attribution flags the harness needs against a non-Anthropic model):

```powershell
# PowerShell (from any project directory)
C:\Code\repair-proxy\scripts\claude-proxied.ps1 -p "list the files here"
```
```bash
# bash
/c/Code/repair-proxy/scripts/claude-proxied.sh -p "list the files here"
```

Or inline, if you'd rather not use the wrapper:

```bash
env -u CLAUDECODE -u ANTHROPIC_API_KEY \
  CLAUDE_CONFIG_DIR="$HOME/.repair-proxy-claude" \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8791 \
  ANTHROPIC_AUTH_TOKEN=dummy \
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 CLAUDE_CODE_ATTRIBUTION_HEADER=0 \
  claude -p "list the files here"
```

`ANTHROPIC_AUTH_TOKEN` can be `dummy` — the proxy strips inbound auth and injects the real backend key itself (from `authEnv`). Override the wrapper defaults with `RP_PROXY_URL`, `RP_AUTH`, `RP_CONFIG_DIR`. Verified live end-to-end: a real `claude` agentic session (tool_use → tool_result → answer) completes through the proxy against NIM.

> Backend note: weak models still fail *reasoning* (they may loop or skip a tool) — repair fixes malformed tool-call *form*, not judgment. Pick a strong tool-caller as the backend model. NIM also rate-limits (HTTP 429) under load; claude's own retry/backoff absorbs it.

## Config

Primary example — an OpenAI-compatible backend (NVIDIA NIM / vLLM / OpenRouter / LM Studio):

```jsonc
{
  "listen": "127.0.0.1:8791",              // loopback ONLY — startup refuses non-loopback
  "backend": {
    "base": "https://integrate.api.nvidia.com/v1",  // OpenAI-compatible base
    "kind": "openai",                        // translate Anthropic<->OpenAI (via llm-bridge)
    "model": "meta/llama-3.1-70b-instruct",  // required for kind=openai
    "authEnv": "NVIDIA_API_KEY",
    "authHeader": "authorization"            // Bearer (default for openai)
  },
  "mode": "detect",                          // detect | repair (strict accepted, aliases detect)
  // reshaper is OPTIONAL for an OpenAI backend: in repair mode it defaults to the
  // SAME provider (base/model/kind/key above), so repair runs on the backend with
  // nothing else to edit. Add an explicit block to point repair at a cheaper model
  // or a different provider (required for an Anthropic backend, which has no fixed
  // model id):
  // "reshaper": { "base": "…", "kind": "openai", "model": "…", "authEnv": "…" },
  "repair": {
    "maxAttempts": 2,
    "destructiveTools": ["rm","delete","push","force","overwrite","drop","reset"]
  },
  "log": { "level": "metadata", "file": null }  // metadata-only; NEVER logs headers/bodies
}
```

For a backend that already speaks Anthropic Messages, drop `kind`/`model` (defaults to `kind:"anthropic"`, forwarded as-is) and point `base` at its `/anthropic`-style endpoint.

### Repointing without editing the file

Config string values may reference environment variables as `${NAME}` — an unset var is a loud startup error, never a silent empty value:

```jsonc
"backend": { "base": "${LLM_BACKEND_BASE_URL}", "kind": "openai", "model": "${LLM_MODEL}", "authEnv": "NVIDIA_API_KEY" }
```

Or override the common knobs from the CLI (they win over the file, so one command repoints at a new provider with no edit):

```bash
node dist/cli.js --config config.json \
  --backend-base https://openrouter.ai/api/v1 --model meta-llama/llama-3.1-70b-instruct --mode repair
```

`repair-proxy --help` lists every override.

The reshaper also takes `"kind": "openai"` — so `repair` mode can run entirely on an OpenAI-compatible provider (e.g. NIM) with no Anthropic key. The reshaper is asked only for the **corrected arguments per tool-call id** (not the full message envelope), which is far more reliable on weaker models; the proxy reconstructs the message and re-validates it.

### Live run

```bash
node scripts/nim-front.mjs   # runs the compiled proxy fronting live NIM end-to-end (uses NVIDIA_API_KEY)
```
Then point a `claude` CLI at it (see "Install & run" above) and inspect the log to see which calls trip the validator on your traffic.

## What it logs (per request, metadata only)

`{ ts, path, backendModel, hadTools, streamed, backendStatus, validated: pass|fail|uncheckable|skipped, toolUseCount, uncheckableCount, errorKinds[], latencyMs }`

`uncheckable` = a declared tool with no `input_schema` (built-in `bash`/`text_editor`/…) or a schema that wouldn't compile — surfaced distinctly so an unvalidatable call is never miscounted as a clean pass.

This is the dataset for deciding which backend models are *format-broken* (reshapeable later) vs pass cleanly. Run in `detect` first, measure, then decide on repair.

### Trip-rate dataset

`node scripts/nim-trip-rate.mjs` probes a list of backend models across difficulty-graded tool schemas (× N trials), runs each call through the real validator, and repairs the failures — producing a per-model **trip rate** (share of tool calls that fail schema validation) and **repair-fix rate**. Latest live NIM run: [`docs/nim-trip-rate.md`](docs/nim-trip-rate.md) (raw records in `docs/nim-trip-rate.jsonl`). The sharp result: even strong Llama-3.1 models emit `days:"5"` (string) against an `integer` schema on every trial — and the proxy repairs it every time; the flat/enum/nested schemas pass clean.

## Design

Full spec: `repair-proxy-spec.md` (in the design scratchpad). Consumers (audit-tools dispatch, plain `claude` CLI) point `ANTHROPIC_BASE_URL` at this proxy; it validates one backend per request. Target *selection* / token-prediction is a separate concern (the router/auditor), deliberately not here.

## Dev

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (validator, SSE reconstruction, e2e transparency+detection)
```
