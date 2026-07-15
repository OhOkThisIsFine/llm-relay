# repair-proxy

A standalone, **loopback** Anthropic-Messages-API reverse proxy. It forwards `/v1/messages` to any backend model and **validates tool-call responses** against the request's `tools[].input_schema`, so the Claude Code harness (or any `ANTHROPIC_BASE_URL` client) can run on non-Anthropic models without pre-filtering them by tool competence.

**The one boundary:** it fixes/flags *protocol form* (malformed tool calls), never *judgment* (bad reasoning).

## What it does

- **Transparent passthrough** — forwards streaming and non-streaming `/v1/messages` byte-for-byte.
- **`detect` mode** — deterministic tool_use validation (Ajv2020) with metadata-only logging of pass/fail/uncheckable. Behavior is unchanged; it only observes.
- **`repair` mode** — on a validation failure, a cheap reshaper model corrects the call, the result is **re-validated**, and the corrected response is re-emitted (JSON or freshly-serialized SSE). Destructive-tool calls are **refused, never fabricated**; unrepairable calls **fail-clean** (502). Valid calls pass through untouched.
- **OpenAI-compatible backends** (`backend.kind:"openai"`) — front NIM / vLLM / OpenRouter / LM Studio. Requests are translated Anthropic→OpenAI and responses back (streaming SSE + non-streaming) via [`llm-bridge`](https://github.com/supermemoryai/llm-bridge) (zero-dep). The validate/repair layer always sees Anthropic Messages, regardless of backend. Verified live end-to-end.
- **Streaming repair** — text-block SSE frames stream to the client **as they arrive**; the proxy only withholds from the first `tool_use` block. A pure-text response is byte-for-byte passthrough with zero added latency; a valid tool call flushes the withheld frames verbatim; an invalid one is repaired with only the corrected trailing blocks re-emitted (`message_start` + leading text already delivered). A mid-stream repair failure surfaces as an SSE `error` event, never a fabricated call. Handles LF and CRLF frame delimiters and multibyte UTF-8 across chunk boundaries.

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

## Config — multi-provider registry

A `providers{}` registry (any number of OpenAI-compatible or Anthropic backends) plus
a `routing` block that maps each request's `model` to one provider + backend model:

```jsonc
{
  "listen": "127.0.0.1:8791",              // loopback ONLY — startup refuses non-loopback
  "providers": {
    "nim":        { "base": "https://integrate.api.nvidia.com/v1", "kind": "openai", "authEnv": "NVIDIA_API_KEY" },
    "openrouter": { "base": "https://openrouter.ai/api/v1",        "kind": "openai", "authEnv": "OPENROUTER_API_KEY" },
    "gemini":     { "base": "https://generativelanguage.googleapis.com/v1beta/openai", "kind": "openai", "authEnv": "GEMINI_API_KEY" }
  },
  "routing": {
    "default": "nim/z-ai/glm-5.2",           // fallback when nothing else matches
    "tiers": {                                // Claude tier (substring match) → provider/model
      "opus":   "nim/nvidia/nemotron-3-super-120b-a12b",
      "sonnet": "nim/z-ai/glm-5.2",
      "haiku":  "nim/openai/gpt-oss-20b",     // cheap/fast — also catches Claude's haiku side-calls
      "fable":  "nim/openai/gpt-oss-20b"
    }
  },
  "mode": "repair",                          // detect | repair (strict accepted, aliases detect)
  "repair": { "maxAttempts": 2, "destructiveTools": ["rm","delete","push","force","overwrite","drop","reset"] },
  "log": { "level": "metadata", "file": null }  // metadata-only; NEVER logs headers/bodies
}
```

**Routing (lifted from free-claude-code's proven scheme — split on the first `/` only):**
1. **Namespaced** — a request `model` of `provider/rest` where `provider` is a configured
   provider routes there directly; the entire tail (nested slashes, `:free` suffixes) is the
   backend model, verbatim. E.g. `nim/openai/gpt-oss-120b`, `openrouter/openai/gpt-5.2-codex`.
2. **Tier** — otherwise the Claude model id is substring-matched against `routing.tiers`
   (`opus`/`sonnet`/`haiku`/`fable`). This also fixes Claude's haiku-class side-calls, which
   would otherwise blindly hit one model and 404.
3. **Default** — anything unrecognized falls to `routing.default`.

Each provider is `kind:"openai"` (translated Anthropic↔OpenAI via llm-bridge) or
`kind:"anthropic"` (forwarded as-is). In `repair` mode an openai target reshapes on itself;
an anthropic provider needs an explicit top-level `reshaper` block.

### Repointing without editing the file

Config strings may reference env vars as `${NAME}` (unset → loud startup error). Or override
routing from the CLI (wins over the file):

```bash
node dist/cli.js --config config.json --default openrouter/openai/gpt-5.2-codex --mode repair
```

`repair-proxy --help` lists every override.

### Model discovery (dynamic + cached)

Model ids are **discovered live** from each provider's `/models` endpoint — never
hand-maintained. The catalog is cached in `~/.repair-proxy/models-cache.json`
(10-min TTL, fail-open: a fetch failure serves the last-known list).

```bash
repair-proxy models                      # list live models for every provider
repair-proxy models --provider nim       # one provider
repair-proxy models --provider nim --refresh   # force a re-fetch
```

On startup the proxy warms the cache and **warns about any routing target its
provider doesn't serve** — so a stale/typo'd tier model is caught at boot, not
silently at request time.

> Provider notes: **Groq** returns `403 "check your network settings"` from some
> IPs/regions (a network-side block, not a key issue) — it works once your network
> allows it. **Mistral** needs `MISTRAL_API_KEY` set in your environment.

### Discovery endpoint (`GET /registry`) — for a dispatcher

For a caller that does its own selection (e.g. audit-tools dispatch, which weighs
quota / rate limits / token budget), `GET http://127.0.0.1:8791/registry` returns one
coherent JSON view:

- **providers** — each with `base`, `kind`, `has_key` (auth env set?), `reachable`
  (did the live `/models` catalog return anything?), and `models[]` where every model
  carries a best-effort `capability` (raw BFCL + Arena scores, **never collapsed** to
  tiers — `null` when no confident leaderboard match).
- **routing** — the current default + tier map.
- **capability_source** — the full raw leaderboard dataset, so a consumer can run a
  finer id→score join than the built-in best-effort one.

The consumer then dispatches by pointing its OpenAI-compatible pool at :8791 and
setting each packet's model to a **namespaced** `provider/model` (it picked the exact
backend). Meanwhile a plain `claude` client that sends `claude-sonnet-…` still gets the
**dumb tier/default routing** — both coexist, no mode switch. So the tier map stays the
default, and dispatcher-style usage is just "send namespaced ids + read `/registry`".

### Model tiers from leaderboards (never a hand-maintained table)

`npm run sync:tiers` snapshots capability rankings from **BFCL** (Berkeley Function-Calling
Leaderboard — tool-use accuracy, the primary signal for a tool-call proxy, incl. its
Irrelevance-Detection metric = the malformed-call proxy) and **LMArena** (general capability)
into `docs/tier-data.json`, and prints the top tool-callers so you can pick tier targets from
real data. Both sources are synced-not-forked; a leaderboard schema change fails the sync loudly.

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

## Composing with headroom (optional)

[headroom](../headroom) is a separate loopback proxy that **optimizes/compresses**
context on the way to the model. Both it and repair-proxy are transparent
Anthropic-Messages proxies, so they chain — but only in one order, because
repair-proxy's backend speaks OpenAI/NIM while headroom only forwards Anthropic:

```
claude → headroom (:8787, context optimization, OUTER) → repair-proxy (:8791, validate/repair + translate, INNER) → NIM/…
```

repair-proxy must be **innermost**. To chain them, point headroom's upstream at
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
**moot on the free NIM pool**. What still pays off through the chain: context
**compression to fit a smaller backend context window** + lower latency, plus
headroom's backend-agnostic memory/learn layer. So stack it for context-fit, not cost.

## Design

Consumers (audit-tools dispatch, plain `claude` CLI) point `ANTHROPIC_BASE_URL` at this proxy; it validates one backend per request. Target *selection* / token-prediction is a separate concern (the router/auditor), deliberately not here. For architecture, invariants, and the script inventory, see [CLAUDE.md](CLAUDE.md).

## Dev

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (validator, SSE reconstruction, e2e transparency+detection)
```
