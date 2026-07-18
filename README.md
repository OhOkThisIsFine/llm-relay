# repair-proxy

A standalone, **loopback** Anthropic-Messages-API reverse proxy. It forwards `/v1/messages` to a backend and **validates tool-call responses** against the request's `tools[].input_schema`, so the Claude Code harness (or any `ANTHROPIC_BASE_URL` client) can run on non-Anthropic models without pre-filtering them by tool competence.

**The one boundary:** it fixes/flags *protocol form* (malformed tool calls), never *judgment* (bad reasoning).

**Division of labor:** repair-proxy does the one thing no gateway does — validate and repair tool calls in flight. Everything else (provider translation, model routing, retries, fallbacks, cost tracking) belongs to the backend it fronts, typically a [LiteLLM proxy](https://docs.litellm.ai/docs/anthropic_unified), which serves the Anthropic Messages format for any provider model:

```
claude CLI → repair-proxy (:8791, validate/repair) → LiteLLM (:4000, translate/route) → NIM / OpenRouter / …
```

## What it does

- **Transparent passthrough** — forwards streaming and non-streaming `/v1/messages` byte-for-byte.
- **`detect` mode** — deterministic tool_use validation (Ajv2020) with metadata-only logging of pass/fail/uncheckable. Behavior is unchanged; it only observes.
- **`repair` mode** — on a validation failure, a cheap reshaper model corrects the call, the result is **re-validated**, and the corrected response is re-emitted (JSON or freshly-serialized SSE). Destructive-tool calls are **refused, never fabricated**; unrepairable calls **fail-clean** (502). Valid calls pass through untouched.
- **Streaming repair** — text-block SSE frames stream to the client **as they arrive**; the proxy only withholds from the first `tool_use` block. A pure-text response is byte-for-byte passthrough with zero added latency; a valid tool call flushes the withheld frames verbatim; an invalid one is repaired with only the corrected trailing blocks re-emitted (`message_start` + leading text already delivered). A mid-stream repair failure surfaces as an SSE `error` event, never a fabricated call. Handles LF and CRLF frame delimiters and multibyte UTF-8 across chunk boundaries.
- **count_tokens fallback** — `/v1/messages/count_tokens` forwards to the backend; if the backend doesn't implement it (404/405), the proxy answers with a local estimate instead.

### Live demo (no external creds)

```bash
npm run build && node scripts/live-demo.mjs
```
Runs the compiled CLI as a real process against a local flaky-model backend + stub reshaper, showing detect (logs the failure) then repair (delivers the fixed call).

## Install & run

The backend must speak Anthropic Messages natively. The usual setup is a local LiteLLM proxy:

```bash
pip install 'litellm[proxy]'
litellm --config docs/litellm-config.example.yaml --port 4000   # edit models/keys first
```

Then repair-proxy in front of it:

```bash
npm install
npm run build
cp config.example.json config.json   # edit backend + reshaper if needed
node dist/cli.js --config config.json
# or, no build step:
npm run dev -- --config config.json
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

> Backend note: weak models still fail *reasoning* (they may loop or skip a tool) — repair fixes malformed tool-call *form*, not judgment. Pick a strong tool-caller as the backend model. Providers rate-limit (HTTP 429) under load; LiteLLM's router retries and claude's own backoff absorb it.

## Config

One backend, one optional reshaper:

```jsonc
{
  "listen": "127.0.0.1:8791",            // loopback ONLY — startup refuses non-loopback
  "backend": {
    "base": "http://127.0.0.1:4000",     // Anthropic-format endpoint (e.g. LiteLLM)
    // "model": "some-fixed-id",         // optional: rewrite every request's model to this;
                                         // omit to pass the client's model through (LiteLLM aliases resolve it)
    "authEnv": "LITELLM_API_KEY",        // env var NAME holding the backend key (never the key itself)
    "authHeader": "authorization"        // or "x-api-key" (default)
  },
  "reshaper": {                          // required in repair mode
    "base": "http://127.0.0.1:4000",
    "model": "reshaper",                 // cheap model (a LiteLLM alias works well)
    "kind": "anthropic",                 // "anthropic" → /v1/messages, "openai" → /chat/completions
    "authEnv": "LITELLM_API_KEY",
    "authHeader": "authorization"
  },
  "mode": "repair",                      // detect | repair (strict accepted, aliases detect)
  "repair": { "maxAttempts": 2, "destructiveTools": ["rm","delete","push","force","overwrite","drop","reset"] },
  "log": { "level": "metadata", "file": null }  // metadata-only; NEVER logs headers/bodies
}
```

Model routing (which Claude tier maps to which provider model, fallbacks, retries) lives in the **LiteLLM config** — see [docs/litellm-config.example.yaml](docs/litellm-config.example.yaml). Alias the `claude-*` ids there and repair-proxy passes the client's model straight through.

The reshaper is asked only for the **corrected arguments per tool-call id** (not the full message envelope), which is far more reliable on weaker models; the proxy reconstructs the message and re-validates it. `kind: "openai"` lets it call an OpenAI-compatible endpoint directly if you'd rather not route the reshaper through LiteLLM.

### Repointing without editing the file

Config strings may reference env vars as `${NAME}` (unset → loud startup error). Or override from the CLI (wins over the file):

```bash
node dist/cli.js --config config.json --backend-base http://127.0.0.1:5000 --model my-model --mode repair
```

`repair-proxy --help` lists every override.

### Live run

```bash
node scripts/litellm-front.mjs   # compiled proxy fronting a live LiteLLM (LITELLM_BASE_URL, optional LITELLM_MODEL/LITELLM_API_KEY)
```
Then point a `claude` CLI at it (see "Install & run" above) and inspect the log to see which calls trip the validator on your traffic.

## What it logs (per request, metadata only)

`{ ts, path, backendModel, hadTools, streamed, backendStatus, validated: pass|fail|uncheckable|skipped, toolUseCount, uncheckableCount, errorKinds[], latencyMs }`

`uncheckable` = a declared tool with no `input_schema` (built-in `bash`/`text_editor`/…) or a schema that wouldn't compile — surfaced distinctly so an unvalidatable call is never miscounted as a clean pass.

This is the dataset for deciding which backend models are *format-broken* (reshapeable later) vs pass cleanly. Run in `detect` first, measure, then decide on repair.

### Trip-rate dataset

`node scripts/nim-trip-rate.mjs` probes a list of backend models across difficulty-graded tool schemas (× N trials), runs each call through the real validator, and repairs the failures — producing a per-model **trip rate** (share of tool calls that fail schema validation) and **repair-fix rate**. Latest live NIM run: [`docs/nim-trip-rate.md`](docs/nim-trip-rate.md) (raw records in `docs/nim-trip-rate.jsonl`). The sharp result: even strong Llama-3.1 models emit `days:"5"` (string) against an `integer` schema on every trial — and the proxy repairs it every time; the flat/enum/nested schemas pass clean.

## Composing with headroom (optional)

[headroom](../headroom) is a separate loopback proxy that **optimizes/compresses**
context on the way to the model. All three layers are transparent Anthropic-Messages
proxies, so they chain:

```
claude → headroom (:8787, context optimization) → repair-proxy (:8791, validate/repair) → LiteLLM (:4000) → NIM/…
```

repair-proxy sits between headroom and LiteLLM. To chain, point headroom's upstream at
repair-proxy — headroom exposes this as a launch flag, so its own code is untouched:

```bash
ANTHROPIC_TARGET_API_URL=http://127.0.0.1:8791   # headroom → repair-proxy
```

**Caveat:** that env var repoints *all* of headroom's Anthropic traffic — including
your real (paid) Claude sessions — at repair-proxy. So run a **second, scoped
headroom instance** for the multiplexed lane and leave your main one pointed at
Anthropic:

```bash
HEADROOM_PORT=8788 ANTHROPIC_TARGET_API_URL=http://127.0.0.1:8791 headroom proxy
# then point the claude client at :8788 (the wrapper's isolated CLAUDE_CONFIG_DIR keeps
# your subscription out of the path); :8787 stays your normal Anthropic route.
```

Note the `claude-proxied` wrappers set `ANTHROPIC_BASE_URL` straight to :8791 and use
an isolated `CLAUDE_CONFIG_DIR`, so **by default they bypass headroom entirely** — you
only get the chain if you deliberately point the client at a headroom instance whose
upstream is repair-proxy.

**Is it worth it?** headroom's headline win is $/token savings vs *paid* Anthropic —
**moot on a free provider pool**. What still pays off through the chain: context
**compression to fit a smaller backend context window** + lower latency, plus
headroom's backend-agnostic memory/learn layer. So stack it for context-fit, not cost.

## Design

Consumers point `ANTHROPIC_BASE_URL` at this proxy; it validates/repairs one Anthropic-format stream per request. Provider translation, model routing, and target *selection* are deliberately not here — LiteLLM (behind) owns translation and routing; a dispatcher that weighs quota/capability talks to LiteLLM directly. For architecture, invariants, and the script inventory, see [CLAUDE.md](CLAUDE.md).

## Dev

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (validator, SSE reconstruction, e2e transparency+detection+repair)
```
