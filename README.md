# repair-proxy

A standalone, **loopback** Anthropic-Messages-API reverse proxy. It forwards `/v1/messages` to any backend model and **validates tool-call responses** against the request's `tools[].input_schema`, so the Claude Code harness (or any `ANTHROPIC_BASE_URL` client) can run on non-Anthropic models without pre-filtering them by tool competence.

**The one boundary:** it fixes/flags *protocol form* (malformed tool calls), never *judgment* (bad reasoning). See the spec.

## Status — M0 + M1 + M2

- ✅ M0 passthrough: forwards streaming + non-streaming `/v1/messages` byte-for-byte.
- ✅ M1 validator + `detect` mode: deterministic tool_use gate (Ajv2020), metadata-only logging of pass/fail/uncheckable — **behavior unchanged**, it only observes.
- ✅ M2 `repair` mode: on a validation failure, a cheap reshaper model reshapes the call, the result is **re-validated**, and the corrected response is re-emitted to the client (JSON or freshly-serialized SSE). Destructive-tool calls are **refused, never fabricated**; unrepairable calls **fail-clean** (502). Valid calls pass through untouched.
- ✅ **OpenAI-compatible backends** (`backend.kind:"openai"`): front NIM / vLLM / OpenRouter / LM Studio. Requests are translated Anthropic→OpenAI and responses back (streaming SSE + non-streaming) via [`llm-bridge`](https://github.com/supermemoryai/llm-bridge) (zero-dep). The validate/repair layer is unchanged — it always sees Anthropic Messages. Verified live end-to-end against NIM.
- ⏳ M4 hardening — streaming repair is implemented (buffer + re-emit); the text-streams-through optimization, OpenAI-format reshaper, and broader hardening remain.

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

Then point a client at it:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8791 \
ANTHROPIC_AUTH_TOKEN=anything \
CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 \
CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
CLAUDE_CODE_ATTRIBUTION_HEADER=0 \
claude -p "list the files here"
```

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
  "reshaper": {                              // REQUIRED when mode="repair" (Anthropic-format for now)
    "base": "https://api.anthropic.com",
    "model": "claude-haiku-4-5-20251001",
    "authEnv": "ANTHROPIC_API_KEY"
  },
  "repair": {
    "maxAttempts": 2,
    "destructiveTools": ["rm","delete","push","force","overwrite","drop","reset"]
  },
  "log": { "level": "metadata", "file": null }  // metadata-only; NEVER logs headers/bodies
}
```

For a backend that already speaks Anthropic Messages, drop `kind`/`model` (defaults to `kind:"anthropic"`, forwarded as-is) and point `base` at its `/anthropic`-style endpoint.

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

## Design

Full spec: `repair-proxy-spec.md` (in the design scratchpad). Consumers (audit-tools dispatch, plain `claude` CLI) point `ANTHROPIC_BASE_URL` at this proxy; it validates one backend per request. Target *selection* / token-prediction is a separate concern (the router/auditor), deliberately not here.

## Dev

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (validator, SSE reconstruction, e2e transparency+detection)
```
