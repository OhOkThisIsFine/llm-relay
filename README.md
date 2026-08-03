# llm-relay

A standalone, **loopback** bidirectional LLM API proxy. It forwards Anthropic `/v1/messages` and OpenAI `/v1/chat/completions` or `/v1/responses` requests to any configured backend, translating protocols where needed. Anthropic responses still pass through the relay's **tool-call validation/repair** layer, so Claude Code and OpenAI-native clients can share the same routed providers.

**The one boundary:** it fixes/flags *protocol form* (malformed tool calls), never *judgment* (bad reasoning).

## What it does

- **Transparent passthrough** — forwards streaming and non-streaming `/v1/messages` byte-for-byte.
- **`detect` mode** — deterministic tool_use validation (Ajv2020) with metadata-only logging of pass/fail/uncheckable. Behavior is unchanged; it only observes.
- **`repair` mode** — on a validation failure, a cheap reshaper model corrects the call, the result is **re-validated**, and the corrected response is re-emitted (JSON or freshly-serialized SSE). Destructive-tool calls are **refused, never fabricated**; unrepairable calls **fail-clean** (502). Valid calls pass through untouched. The refusal matches the tool **name exactly** (case-insensitively) — see [Destructive-tool refusal](#destructive-tool-refusal-repairdestructivetools) for which tools that now covers.
- **OpenAI-compatible backends** (`backend.kind:"openai"`) — front NIM / vLLM / OpenRouter / LM Studio. Requests are translated Anthropic→OpenAI and responses back (streaming SSE + non-streaming) via [`llm-bridge`](https://github.com/supermemoryai/llm-bridge) (zero-dep). The validate/repair layer always sees Anthropic Messages, regardless of backend. Verified live end-to-end.
- **Bidirectional OpenAI front** — `POST /v1/chat/completions` and `POST /v1/responses` work against both `kind:"openai"` and `kind:"anthropic"` targets. OpenAI Chat Completions remains byte-transparent to OpenAI backends; Responses and Anthropic targets use the same Anthropic-shaped translation seam, including streaming SSE and tool calls.
- **Streaming repair** — text-block SSE frames stream to the client **as they arrive**; the proxy only withholds from the first `tool_use` block. A pure-text response is byte-for-byte passthrough with zero added latency; a valid tool call flushes the withheld frames verbatim; an invalid one is repaired with only the corrected trailing blocks re-emitted (`message_start` + leading text already delivered). A mid-stream repair failure surfaces as an SSE `error` event, never a fabricated call. Handles LF and CRLF frame delimiters and multibyte UTF-8 across chunk boundaries.

### Live demo (no external creds)

```bash
npm run build && node scripts/live-demo.mjs
```
Runs the compiled CLI as a real process against a local flaky-model backend + stub reshaper, showing detect (logs the failure) then repair (delivers the fixed call).

## Quick Start & Free Model Onboarding

`llm-relay` comes pre-configured with **100%-free model presets** (NVIDIA NIM, Groq, Gemini Free, OpenRouter Free, Cerebras, SambaNova) and supports **pooling your existing subscriptions** (ChatGPT / OpenAI API, AGY, Anthropic).

### Step 1: Run Guided Free Key Setup
```bash
npx llm-relay onboard
```
Scans your environment for active keys and provides direct links to acquire 100%-free API keys from NVIDIA, Groq, Google Gemini, OpenRouter, Cerebras, and SambaNova.

### Step 2: Configure Claude CLI or Claude Desktop

**For Claude Desktop:**
```bash
llm-relay setup claude-desktop
```
Auto-patches `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) to route Claude Desktop through `llm-relay` (`http://127.0.0.1:8791`).

**For Claude CLI (`claude`):**
```bash
llm-relay setup claude-cli
```
Verifies wrapper scripts (`scripts/claude-proxied.ps1` and `scripts/claude-proxied.sh`) that use an isolated `CLAUDE_CONFIG_DIR` so your proxy setup never conflicts with local login tokens.

### Step 3: Start the Proxy
```bash
llm-relay
```

---

## Key Capabilities

### 1. 100%-Free Presets & Subscription Pooling
- **100%-Free Tier**: NVIDIA NIM (`build.nvidia.com`), Groq (`console.groq.com/keys`), Gemini Free (`aistudio.google.com/app/apikey`), OpenRouter Free (`openrouter.ai/keys`), Cerebras, SambaNova.
- **Subscription Tier**: Mapped as `subscription` in config (e.g. OpenAI `OPENAI_API_KEY`, Anthropic `ANTHROPIC_API_KEY`).
- **Priority Cascade**: `llm-relay` prioritizes high-capability subscriptions first, automatically falling back to high-stability free tier targets if 429 rate limits occur.

### 2. Stability-Aware Dynamic Routing & Auto-Failover
- `CircuitBreaker` tracks latency, jitter, spike rates, and remaining rate-limit quota headers (`x-ratelimit-remaining`), computing a live **Stability Score (0–100)** for every provider target.
- Target selection dynamically sorts candidates by Stability Score and automatically cascades on 429 rate limits or timeouts.
- **Multi-Candidate Failover**: `routing.default` and every `routing.tiers` entry accept an **array** of target specs (e.g. `["nim/z-ai/glm-5.2", "groq/llama-3.3-70b"]`) for continuous fallback. ⚠ Ranking and failover both require **more than one** candidate — a single pinned model silently disables both, and on providers where a listed model may not actually be servable that turns one dead backend into a dead relay. Prefer arrays.
- **Named pools** (`routing.pools`, addressed as `model: "pool/<name>"`): the same ranked-candidate behaviour for callers that can only send **one model string** — notably Claude Code subagent frontmatter. Lets an agent ask for *the best available coding model* instead of naming one. An unknown pool is a loud 400, never a silent fall-through.
- **Passthrough targets**: a provider with `kind:"anthropic"` and **no `authEnv`** forwards the caller's own credentials untouched, so real Claude traffic stays on real Anthropic while `pool/*` requests route elsewhere — from the same proxy.
- **Granular offload** (`routing.offload` + `routing.subagents`): independently route Claude, Codex, and future client requests to other providers. Each client can be limited to subagents or set to `scope: "all"` to reroute its main conversation too. **Off by default**; `llm-relay candidates` shows what to point it at. See below.

### 3. Prompt Token & Context Length Guardrails
- Estimates the request's prompt token count (`estimateRequestTokens`) against the target model's context limit, read from the warm catalog cache (`cachedLimits()` — it never fetches, so a cold cache costs no round-trip on the request path).
- Rejects an oversized request before network transmission with an HTTP 400 (`request prompt estimated tokens … exceeds the context limit …`), protecting backends from context-window overflow.
- ⚠ **It only fires against a limit the *serving* provider published.** If that provider publishes no limit (NIM publishes none), there is no guardrail: the request goes upstream and the backend returns its own authoritative error. llm-relay will not reject a request against a number it guessed — see the per-(provider, model) note under [Choosing where to offload](#choosing-where-to-offload-llm-relay-candidates).

### 4. Background Adaptive Health Monitoring & Persistent Caching
- **Adaptive Cadence Loop**: Background `PingLoop` dynamically adjusts probe frequency across 4 operational modes: `speed` (2s interval at startup/activity), `normal` (10s), `slow` (30s after 5m idle), and `forced` (4s).
- **Selective probes**: The background loop probes only deployments present in materialized routing, with pool leaders first. A recent successful real request satisfies freshness; broken targets retry with exponential backoff instead of being hammered every tick. Explicit `llm-relay ping` remains a full-catalog diagnostic.
- **Persistent State**: Background probes, real-world proxy calls, dynamic catalogs, and local keys persist under `~/.llm-relay/` (`models-cache.json`, `probe-cache.json`, `runtime-telemetry.json`, `.env`). JSON caches use bounded write-behind and flush during graceful shutdown, keeping whole-file rewrites out of request/probe hot paths.

### 5. Document (PDF/Office) Attachments on Non-Anthropic Backends
- Anthropic `document` content blocks are converted to markdown **before** the request reaches an
  OpenAI-compatible backend, via [MarkItDown](https://github.com/microsoft/markitdown). Supported:
  PDF, `.docx`, `.pptx`, `.xlsx`, CSV, HTML, JSON, plain text and markdown.
- MarkItDown is an **optional** external dependency (a Python CLI). Install it with
  `pip install 'markitdown[all]'`, or point `LLM_RELAY_MARKITDOWN` at the executable. Without it, a
  request carrying a document gets a clear HTTP 400 naming the install command.
- Images (`image` blocks, base64 and url sources) pass through natively and need nothing installed.
- A document that can't be converted is **refused, never truncated or inlined raw** — the underlying
  translation library would otherwise stringify the block and inject the whole base64 payload into
  the prompt.

### 6. Programmatic Telemetry & Quota Access for Claude
- **Tokenless status endpoints**: `GET /models`, `GET /telemetry`, `GET /offload`, and `GET /dispatch` are side-effect-free status reads.
- **Capability-protected control endpoints**: `POST /offload`, `POST /dispatch`, `GET /ping`, `GET /registry`, `GET /health`, and `GET /candidates`. The CLI automatically carries the per-install 256-bit capability stored in `~/.llm-relay/control-token`; it is never forwarded to providers. ⚠ **Loopback is not authorization** — every request also requires a `Host` exactly matching the bound listener authority, a present `Origin` must match its exact scheme/host/effective port, and `Origin: null` is rejected. Mutating requests additionally require `content-type: application/json`.
- **CLI Commands**: `llm-relay telemetry` outputs live telemetry metrics; `llm-relay models` lists live model catalogs with SWE-bench & quality scores; `llm-relay ping` performs live health & latency probes.
- **Response Headers**: Proxy responses include `x-llm-relay-quota-percent`, `x-llm-relay-stability-score`, and `x-llm-relay-target`.

---

## CLI Command Reference

| Command | Description |
| :--- | :--- |
| `llm-relay` | Start proxy |
| `llm-relay onboard` | Set up provider keys |
| `llm-relay setup [target]` | `target`: `claude-cli` | `claude-desktop` |
| `llm-relay keys | check-keys` | Check provider keys |
| `llm-relay pools [--probe]` | List pool members; `--probe` tests each |
| `llm-relay pools <action> <name> [<spec>...]` | `action`: `set` | `add` | `remove` | `delete` |
| `llm-relay routing <action> ...` | `action`: `show` | `get` | `default` | `tier` | `subagent` | `sort` | `benchmark` | `set` | `unset` |
| `llm-relay config <action> [<path>] [<value>]` | `action`: `show` | `get` | `set` | `unset` |
| `llm-relay telemetry` | Print telemetry/quota JSON |
| `llm-relay models [-p <name>] [-r]` | List provider models |
| `llm-relay ping [-p <name>]` | Probe providers |
| `llm-relay offload [status]` | Show aggregate offload state |
| `llm-relay offload <harness> <on\|off> [--scope <scope>]` | Set one harness's rule |
| `llm-relay candidates [-p <name>]` | Show offload target data |
| `llm-relay dispatch [lane] [options]` | Choose next dispatch lane |

---

### Configure pools and routing from the CLI

The configuration commands edit the selected JSON file (`--config` or the normal global config)
and validate the complete result before writing it. Restart a running proxy after a routing edit.

```bash
# Static pool: members are tried/ranked according to the normal pool rules.
llm-relay pools set medium nim/z-ai/glm-5.2 openrouter/openai/gpt-5.2-codex
llm-relay pools add medium gemini/gemini-2.5-flash
llm-relay pools remove medium gemini/gemini-2.5-flash
llm-relay pools delete medium

# Dynamic effort pool: an empty configured prefix, then evidence-ranked free models.
llm-relay pools set medium --free --effort medium

# Main fallback, Claude tier maps, subagent destinations, and ranking.
llm-relay routing default nim/z-ai/glm-5.2 openrouter/openai/gpt-5.2-codex
llm-relay routing tier sonnet pool/high
llm-relay routing subagent default pool/medium
llm-relay routing sort off
llm-relay routing tier opus --clear

# Inspect or change any less-common routing field using a JSON value.
llm-relay routing show
llm-relay config get routing.pools
llm-relay config set routing.ladder '[{"id":"medium","kind":"relay","spec":"pool/medium"}]'
llm-relay config unset routing.ladder
```

`routing set <path> <value>` and `routing unset <path>` are shorter forms for paths below
`routing`. `llm-relay pools --probe` remains the liveness check to run after changing membership;
editing a pool does not imply that every model is usable.

---

## Install & run

### Option 1: Instant run (no installation required)
```bash
NVIDIA_API_KEY=nvapi-... npx llm-relay
```

### Option 2: Global installation
```bash
npm install -g llm-relay

# Start proxy:
llm-relay

# Check key status & signup URLs:
llm-relay keys

# Check that every model in your pools actually answers:
llm-relay pools --probe
```

**New here?** [docs/QUICKSTART.md](docs/QUICKSTART.md) is a staged setup guide written to be
handed straight to an AI assistant ("set this up for me"), covering free providers, the offload
switch, local models, and using your other CLI subscriptions as fallback lanes.

### Release publishing

Releases publish through npm Trusted Publishing (GitHub Actions OIDC); no `NPM_TOKEN` is stored in
the repository. After merging a version bump to `main`, push the matching tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

`.github/workflows/publish.yml` accepts only `v*` tags from this repository, verifies that the tag
is contained in the default branch and matches `package.json`, then publishes with npm 11.5.1+.
The one-time setup also requires the npm trusted publisher to reference this repository and
workflow, plus the protected GitHub `npm-publish` environment to carry its approval rules.

### Verifying a setup — two checks, two different questions

`keys` answers *are my credentials good?* `pools --probe` answers *will the models I configured
actually answer?* Both are needed, and the cheap one can be confidently wrong in either
direction:

- A 200 from a provider's `/models` proves nothing when that endpoint is **public** — a revoked
  key still returns the full catalogue. `keys` now re-probes anonymously and escalates to an
  authenticated completion when it must.
- A 401/403 on that probe does **not** prove the key is bad — free-tier rosters list premium
  models a valid key cannot touch. The probe is compared against the same request sent with no
  credentials: a different status means the key authenticated; an identical one means nothing
  could be concluded, reported as `UNVERIFIED` rather than as a bad key.
- Neither of those can see a model that is configured, catalogued, and dead. Only
  `pools --probe` can.

Keys are read from the environment and, if present, from `~/.llm-relay/.env` (one `KEY=value`
per line). **A variable already set in the environment always wins over the file.**

A global install drops the same generated **llm-relay skill description** into both host skill
directories: `~/.claude/skills/llm-relay/SKILL.md` for Claude Code and
`~/.codex/skills/llm-relay/SKILL.md` for Codex. Both are copied from the package's single
`skills/llm-relay/SKILL.md` source, so the operating guide (addressing pools/models, the offload
switch, `@relay:` directives, reading the candidates table, failure modes) cannot drift between
hosts. Both refresh automatically on every upgrade; local/dev installs touch neither directory.

The same global install also provisions local Codex: it adds the `llm-relay` Responses provider to
`~/.codex/config.toml` and creates relay-backed `default` and `relay_coding` child agents under
`~/.codex/agents/` when those files are absent. Existing Codex config and agent files are preserved.
This keeps the parent on its normal provider while making generic or named child dispatches use the
relay automatically.

If your npm blocks unknown install scripts (`npm warn install-scripts … blocked`), allow this one —
`npm config set allow-scripts=llm-relay --location=user` — or install the host integrations by hand:
`node "$(npm root -g)/llm-relay/scripts/install-skill.mjs" --force`.

### Staying current

Every start (except `help` and `version`) compares the running version against the npm registry —
answer cached 6h in `~/.llm-relay/update-check.json`, 2.5s timeout, and any failure is silent and
non-blocking, so an offline or slow registry never delays a start.

When a newer version exists:

- **a global install updates itself** — `npm install -g llm-relay@<latest>`, then it re-execs into the
  new build and runs your command there. Nothing to remember, and no half-updated state: if the install
  or the version check after it fails, it says so and continues on the version you already had.
- **any other copy** (source checkout, `npx`, project dependency) just prints the version gap and the
  exact upgrade command, and continues.

The replace is clean. Any bin shim the *old* version installed that the new one no longer declares is
deleted in all of npm's spellings (bare, `.cmd`, `.ps1`, `.bat`), so a renamed or dropped command can
never leave a dangling entry on your `PATH`. If pre-existing shims block npm's overwrite (`EEXIST` —
typically left by a `npm link` or a half-finished install), the update clears them and reinstalls rather
than leaving you pinned to an old build.

Set `LLM_RELAY_NO_SELF_UPDATE=1` to skip the check entirely — it is also set automatically on the
re-exec'd process, so an update can never recurse.

## Use it from your projects

Point the `claude` CLI at the running proxy. **The one thing that matters:** give claude an **isolated `CLAUDE_CONFIG_DIR`**. Without it, an active claude.ai subscription session conflicts with the proxy token and claude fails client-side with `Invalid API key` / `401 Invalid bearer token` before any request is even sent. With it, the proxy's provider token is the sole credential — and your subscription is never in the path (the safe direction).

Wrappers do this for you (they also set the thinking/beta/attribution flags the harness needs against a non-Anthropic model):

```powershell
# PowerShell (from any project directory)
C:\Code\llm-relay\scripts\claude-proxied.ps1 -p "list the files here"
```
```bash
# bash
/c/Code/llm-relay/scripts/claude-proxied.sh -p "list the files here"
```

Or inline, if you'd rather not use the wrapper:

```bash
env -u CLAUDECODE -u ANTHROPIC_API_KEY \
  CLAUDE_CONFIG_DIR="$HOME/.llm-relay-claude" \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8791 \
  ANTHROPIC_AUTH_TOKEN=dummy \
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 CLAUDE_CODE_ATTRIBUTION_HEADER=0 \
  claude -p "list the files here"
```

`ANTHROPIC_AUTH_TOKEN` can be `dummy` — the proxy strips inbound auth and injects the real backend key itself (from `authEnv`). Override the wrapper defaults with `RP_PROXY_URL`, `RP_AUTH`, `RP_CONFIG_DIR`. Verified live end-to-end: a real `claude` agentic session (tool_use → tool_result → answer) completes through the proxy against NIM.

> Backend note: weak models still fail *reasoning* (they may loop or skip a tool) — repair fixes malformed tool-call *form*, not judgment. Pick a strong tool-caller as the backend model. NIM also rate-limits (HTTP 429) under load; claude's own retry/backoff absorbs it.

### What Claude Code gives up behind ANY custom `ANTHROPIC_BASE_URL`

**None of these are caused by llm-relay, and none can be fixed by llm-relay** — Claude Code changes
its own behaviour the moment `ANTHROPIC_BASE_URL` is not `api.anthropic.com`. They apply equally to
any gateway (headroom, LiteLLM, a corporate proxy). Listed here because the symptoms look like proxy
bugs and cost real time to diagnose otherwise.

Verified against **Claude Code 2.1.220 (2026-07-28)**. These are client-version behaviours, not
laws — re-check after a Claude Code upgrade.

| What breaks | Why | Workaround |
|---|---|---|
| **1M context silently drops to 200k** | Claude Code omits the `context-1m-2025-08-07` beta header behind a custom base URL. Nothing errors — you just quietly get a smaller window than you are entitled to. | **Yes.** Pin the model with a `[1m]` suffix at launch: `ANTHROPIC_MODEL='claude-opus-5[1m]' claude`. Cost: this *pins* the model and overrides the in-session model picker, so set it per-launch, not globally. |
| **`/remote-control` (`/rc`) is disabled** | Claude Code ≥2.1.196 hard-gates Remote Control to `api.anthropic.com`; the check is compiled in ("Remote Control is only available when using Claude via api.anthropic.com"). It also breaks under `ANTHROPIC_AUTH_TOKEN` alone. | **None.** It is a binary choice: a proxy, or Remote Control. Unset `ANTHROPIC_BASE_URL` to get it back. |
| **MCP tool search off by default** | Disabled behind a non-first-party base URL. | Set `ENABLE_TOOL_SEARCH=true` (needs the proxy to forward `tool_reference` blocks — llm-relay does). |

llm-relay forwards `anthropic-beta` verbatim on passthrough targets, so the 1M header **does** survive
the proxy hop — the header is simply never sent by the client in the first place. That is why the
workaround is client-side.

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
    "default": "pool/medium",
    "tiers": {                                // Claude tier (substring match) → provider/model
      "opus":  "pool/xhigh",
      "fable": "pool/xhigh",
      "sonnet": "pool/high",
      "haiku": "pool/medium"
    },
    "pools": {                                // addressable as model "pool/<name>"
      "low":    { "preferred": [], "include": "free", "effort": "low" },
      "medium": { "preferred": [], "include": "free", "effort": "medium" },
      "high":   { "preferred": [], "include": "free", "effort": "high" },
      "xhigh":  { "preferred": [], "include": "free", "effort": "xhigh" }
    }
  },
  "mode": "repair",                          // detect | repair (strict accepted, aliases detect)
  // Omit `destructiveTools` to get exactly this default list. Names are matched EXACTLY.
  "repair": { "maxAttempts": 2, "destructiveTools": ["Bash","BashOutput","Write","Edit","MultiEdit","NotebookEdit","rm","delete","delete_file","remove","overwrite","drop","reset","force_push"] },
  "log": { "level": "metadata", "file": null },  // metadata-only; NEVER logs headers/bodies
  // Stop `llm-relay onboard` nudging you about providers you have decided not to configure.
  // Nudge suppression ONLY — see below.
  "leave_me_alone": ["openai", "anthropic"]
}
```

**Routing (lifted from free-claude-code's proven scheme — split on the first `/` only):**
1. **Pool** — a request `model` of `pool/<name>` expands to that pool's whole candidate list,
   which is then fitness-ranked and failed over. Use this to ask for *the best available*
   model instead of naming one. An unknown pool is a **400, never a silent fallback** to the
   default — a typo must not quietly succeed against a different model.
2. **Namespaced** — a request `model` of `provider/rest` where `provider` is a configured
   provider routes there directly; the entire tail (nested slashes, `:free` suffixes) is the
   backend model, verbatim. E.g. `nim/openai/gpt-oss-120b`, `openrouter/openai/gpt-5.2-codex`.
   Deliberately verbatim: a pinned spec is never re-ranked.
3. **Tier** — otherwise the Claude model id is substring-matched against `routing.tiers`
   (`opus`/`sonnet`/`haiku`/`fable`). This also fixes Claude's haiku-class side-calls, which
   would otherwise blindly hit one model and 404.
4. **Default** — anything unrecognized falls to `routing.default`.

`pool/<name>` exists because some callers can only express a **single model string** — notably
Claude Code subagent frontmatter (`model:`), which accepts a full model id but not a candidate
list. A pool is the indirection that gives those callers ranking and failover. `pool` is a
reserved provider name; configuring a provider called `pool` fails at load.

Pools can be static arrays, or automatic free-model pools:

```jsonc
"medium": {
  "preferred": [],
  "include": "free",
  "effort": "medium"
}
```

The configured prefix remains first in exactly the written order. The relay then appends every
model discovered from a `tierType: "free"` provider (excluding a model when its catalog publishes
a positive price), plus zero-priced or explicitly free-labelled models from `tierType: "mixed"`
providers. `effort` may be `low`, `medium`, `high`, or `xhigh`. These are cumulative raw-capability
floors (50/60/70/80), not ceilings. Admission compares a whole-point capability score; an existing
member remains until it falls two points below its floor, preventing refresh noise from flapping the
pool. Automatic membership also requires an exact SKU match and at least three published capability
or task-fit signals; confidence, stability, and metadata affect ordering, not eligibility.
A strong free model remains eligible for `low`, while higher effort narrows upward
(`xhigh ⊆ high ⊆ medium ⊆ low`). Exact SKUs known not to support tools are excluded.
Catalog refreshes re-materialize the pool automatically; adding new free models never requires a
config edit. Materialization builds and ranks one common discovered roster, then filters that
snapshot into all effort pools; the result is reused for a 30-second ranking epoch and invalidated
immediately by a catalog revision. Legacy array pools keep their existing whole-array
`benchmarkSort` behaviour, with their ranking likewise reused within a short epoch.

**What failover actually does** (both `/v1/messages` and `/v1/chat/completions`):

- **429 / 5xx / 400 / 404** → the candidate is recorded as a breaker failure and the next one is
  tried. A `Retry-After` sets that candidate's cooldown for exactly as long as the provider asked.
- **401 / 403** → the next candidate is tried, but the fault is recorded on its own axis rather
  than as ill health, so `llm-relay candidates` shows it as `AUTH 401` instead of hiding it. It
  expires after 5 minutes, so a rotated key recovers with no restart.
- **A genuine client 4xx** (413, 422, …) → returned as-is. Every other candidate would reject it
  identically.
- **Every candidate failed** → the last real upstream error, not a synthesized one.

Responses carry **`x-llm-relay-served-by`**: the deployment that served, or on an error every
deployment that was tried, in order.

⚠ **A pool routes to fewer members than it lists** when some declare an `authEnv` that is unset —
those are dropped before ranking, so a 14-member pool can resolve to 7 and the config's *tenth*
entry can legitimately be the one that answers. `llm-relay candidates` reports the count.
Background: [docs/pool-failover.md](docs/pool-failover.md).

### Quieting the onboarding nudge (`leave_me_alone`)

`llm-relay onboard` walks every known provider and prompts for the keys you are missing. For a
provider you have deliberately decided not to configure, that prompt is permanent noise. List it
in `leave_me_alone` and onboarding stops mentioning it.

```jsonc
"leave_me_alone": ["openai", "anthropic", "some-provider-you-never-set-up"]
```

Two deliberate properties:

- **A name matching no configured provider is legal** — no error, no warning. The list is the
  *negative space*: the providers worth suppressing are exactly the ones that are not in your
  `providers{}` block, and most are only ever preset names. Validating against the known set would
  reject the main use case. (The value's *shape* is still checked loudly — a bare string where a
  list belongs is a mistake with no plausible reading.)
- **It suppresses a nudge, it does not hide state.** A suppressed provider still appears in
  `llm-relay keys`, in `/registry`, in telemetry and in `llm-relay candidates`, and still routes
  normally. Those are the surfaces you go to when something is wrong; a provider that vanished
  from them would be undebuggable.

Matching is case- and whitespace-insensitive, and is against the provider *name* only — never its
`authEnv` or display name — so one entry can never silence a provider you did not name.

### Destructive-tool refusal (`repair.destructiveTools`)

A repaired tool call may run under `--dangerously-skip-permissions`, so llm-relay refuses to emit
one that names a destructive tool — it never guesses arguments for it. Two things about the list
are worth knowing before you configure it:

- **Matching is exact on the tool name, case-insensitively** — not substring. A pattern ending in
  `*` is an opt-in prefix form (`"git_*"` covers `git_push` and `git_reset_hard` but not
  `gitlab_read`); a bare `"*"` matches nothing.
- **The default list leads with the harness's own write/execute tools** — `Bash`, `BashOutput`,
  `Write`, `Edit`, `MultiEdit`, `NotebookEdit` — then the conventional MCP-style names (`rm`,
  `delete`, `delete_file`, `remove`, `overwrite`, `drop`, `reset`, `force_push`).

Both of those changed, and both are visible in behaviour. Refusal used to be substring matching
over fragments like `rm`/`delete`/`push`, which was wrong in **both** directions at once: none of
those fragments occur in `Bash`/`Write`/`Edit`, so the tools that can actually destroy something
were never guarded — while `push` matched `PushNotification` and `reset` matched `ResetZoom`,
refusing safe calls. So:

- a malformed `Bash`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`BashOutput` call that used to be
  repaired is now **refused** (logged as `repair: "refused_destructive"`; the request fails clean
  instead of emitting a call the model did not correctly produce);
- a call named `PushNotification`, `ResetZoom` or `ForceRefresh` is now **permitted**.

There is no built-in list inside the proxy: an empty `repair.destructiveTools` refuses nothing, so
coverage is always traceable to your config.

### Granular offload (`routing.offload` + `routing.subagents`)

Offload rules are keyed by the originating harness. Claude requests use the `/v1/messages` front
door; Codex requests use `/v1/responses`. Each rule is independent and chooses whether it applies
to marked subagents only (the current behavior) or to the whole conversation:

```jsonc
"routing": {
  "tiers":     { "opus": "anthropic", "sonnet": "anthropic", "haiku": "anthropic", "fable": "anthropic" },
  "subagents": {
    "opus": "pool/xhigh", "fable": "pool/xhigh",
    "sonnet": "pool/high", "haiku": "pool/medium", "default": "pool/medium"
  },
  "offload": {
    "claude": { "enabled": true,  "scope": "subagents" },
    "codex":  { "enabled": false, "scope": "all" }
  }
}
```

`scope: "subagents"` preserves the existing topology. `scope: "all"` also applies the same
`routing.subagents` tier/default map to the client's main conversation, which is useful when a
Claude or Codex quota is exhausted. Rules may use any future client name; an explicit `default`
rule is the opt-in catch-all for otherwise unnamed front doors. All rules are off by default.

The CLI changes one harness without restarting the proxy:

```bash
llm-relay offload status
llm-relay offload <harness> <on|off> [--scope <scope>]
```

`<harness>` is `claude`, `codex`, or another configured client. `<scope>` is `subagents` or
`all` (default: `subagents`).

The legacy boolean form remains supported in config files as a global subagents-only rule
(`"offload": false`). The CLI requires a harness name for changes. `GET /offload?client=claude` reads one rule;
`POST /offload` accepts `{"client":"claude","enabled":true,"scope":"all"}`. Changes are
persisted and take effect on the next request.

Claude Code stamps `cc_is_subagent=true` into the `system` block of subagent requests (built-in
agents like Explore included — verified on the wire, Claude Code 2.1.220). Local Codex stamps
`x-codex-turn-metadata: {"request_kind":"subagent",...}` on child-agent turns. A subagents-only
rule requires that marker; an all-scope rule also accepts ordinary main-conversation requests.
An explicit `@relay:` directive remains a subagent-only per-call opt-in, even when a client has an
all-scope rule, so text in a human conversation cannot self-reroute it.

A dispatcher chooses a destination with the Agent tool's `model` parameter (`sonnet|opus|haiku|fable`)
or, when it does not choose, `subagents.default` applies and the pool's ranking picks the model.

**To pin an exact model for one call**, put a directive on its own line in the subagent's prompt:

```
@relay: nim/z-ai/glm-5.2
Trace every caller of parseConfig and report the file:line of each.
```

`<spec>` is any normal spec (`pool/<name>` or `<provider>/<model>`). The line is **stripped before
the request is forwarded**, so the model never sees it. This works **whether or not the switch is
on** — it is the per-call opt-in, so you can offload one dispatch without offloading everything.

⚠ **The directive is read only from the last text block of `messages[0]`** — the dispatcher's
authored prompt. Block 0 is Claude Code's injected `<system-reminder>` (your CLAUDE.md, the date,
…), and later messages carry tool results, i.e. file contents. Reading either would let any file a
subagent happens to read redirect its own routing. Both cases are covered by tests.

Precedence for a marked subagent request: `@relay:` directive → `subagents[<tier>]` →
`subagents.default` → normal routing. The map applies only when that request's client rule is
enabled and its scope admits the request; omit `routing.subagents` entirely and nothing changes.

#### Local Codex setup

For the intended split, keep the parent Codex session on its normal provider and define a named
child agent whose own Responses requests use llm-relay. A global `llm-relay` install creates the
provider and agents below automatically. If npm lifecycle scripts were blocked, run the bundled
installer manually with `--force`, or create the files yourself as follows.

```toml
[model_providers.llm-relay]
name = "llm-relay"
base_url = "http://127.0.0.1:8791/v1"
wire_api = "responses"
requires_openai_auth = true
```

Then create `~/.codex/agents/relay_coding.toml`:

```toml
name = "relay_coding"
description = "Read-only coding child routed through llm-relay."
developer_instructions = "Work read-only. Return a concise result to the parent and do not modify files."

model_provider = "llm-relay"
model = "pool/medium"
model_reasoning_effort = "medium"
```

To make an unqualified child dispatch use the relay automatically, override Codex's built-in
`default` agent with `~/.codex/agents/default.toml`:

```toml
name = "default"
description = "General-purpose read-only child routed through llm-relay."
developer_instructions = "Work read-only. Return a concise result to the parent and do not modify files."

model_provider = "llm-relay"
model = "pool/medium"
model_reasoning_effort = "medium"
```

With that override, a normal “use a subagent” request keeps the parent native while the generic child
goes through `pool/medium`; named agents can still select a different pool explicitly.

Run Codex normally, without the `llm-relay` profile. Ask the parent to use exactly one subagent of
type `relay_coding`; Codex keeps the parent on its normal provider and starts the child through the
relay. The relay pool then chooses the configured provider and can fail over normally.

Enable only Codex child offload in `~/.llm-relay/config.json`:

```bash
llm-relay offload <harness> on --scope <scope>
```

For Codex, use `harness=codex` with `scope=subagents`; use `scope=all` to include the parent
conversation. Claude's rule is unaffected.

The `llm-relay` profile remains available as an explicit all-relay mode, but it routes the parent
through the relay too and is not the split setup described above. The automatic
`x-codex-turn-metadata` marker is still recognized when a Codex client sends it; using a relay pool
as the named child model keeps the split setup reliable even when a custom-agent request omits that
private marker.

This applies to local Codex clients that can reach `127.0.0.1`. Hosted ChatGPT/Cloud tasks cannot
reach a loopback relay, and the relay cannot spend a ChatGPT subscription on behalf of an upstream
request; those remain separate CLI/client-bound dispatch lanes.

Whole-task CLI dispatch can likewise vary by tier with `routing.ladders.{low,medium,high,xhigh}`.
Use `llm-relay dispatch --tier high -t "..."`; without `--tier`, the ladder matching
`subagents.default` is selected (normally `medium`). The legacy single `routing.ladder` remains
supported for configurations that do not need tier-specific CLI models.

### Choosing where to offload (`llm-relay candidates`)

```
target                          pools / tiers      fit    raw    cap        agentic coding BFCL   arena  $/Mout  verdict  p95    quota  breaker  ctx
ollama-cloud/kimi-k3            low,medium,high... 79.9   96.6   87.3/4     50.1     76.2   -      -      -        Pending  -      -      closed   1049k~
nim/z-ai/glm-5.2                low,medium,high... 71.8   83.3   76.6/4     43.1     68.8   -      -      $2.402~ Pending  -      -      closed   1049k~
nim/deepseek-ai/deepseek-v4-pro low,medium,@haiku  64.9   67.4   67.4/5     36.4     59.4   -      1457   $0.87~  Pending  -      -      closed   1049k~
```

Every offload target with its dimensions side by side: capability from each leaderboard separately,
live behaviour (verdict, avg/p95 latency, jitter, uptime), availability and cost right now (quota,
circuit-breaker state, price per million tokens, whether the provider still lists the model), and
traffic actually observed through the proxy.

**Capability comes from `npm run sync:tiers`**, which merges four sources into
`docs/tier-data.json` (~770 models) — see [docs/capability-sources.md](docs/capability-sources.md):

| Source | Contributes |
|---|---|
| OpenRouter | Artificial Analysis intelligence / coding / **agentic** indices, Design Arena Elo, context length, pricing, tool support — and the only source whose ids match routing specs exactly |
| BFCL | tool-call accuracy, multi-turn, irrelevance detection |
| LMArena | general preference rating + rank |
| Aider | polyglot edit benchmark + edit-format compliance |

They **disagree** — the agentic index puts deepseek above kimi while the coding index puts kimi
above deepseek — which is exactly why each keeps its own column, and why a blank cell means *not
measured*, never *bad*.

The raw dimensions remain separate — capability, latency and remaining quota answer different
questions. Pool ordering uses three explicit derived scores:

- `raw` is fixed at 40% agentic/tool use, 35% coding, and 25% general reasoning. Each source is
  mapped through persisted raw-value calibration anchors, so an unrelated leaderboard addition
  cannot silently move every model. If an entire dimension is missing, it is estimated by ridge
  regression from models with overlapping dimensions rather than disappearing from the denominator.
  Artificial Analysis Agentic and BFCL Overall feed agentic capability; AA Coding and Aider pass
  rate feed coding; AA Intelligence and LMArena feed general reasoning.
- Design Arena's differently covered specialist categories, BFCL irrelevance, and Aider formatting
  compliance are task-fit signals, not raw capability. This prevents a model measured on a favorable
  specialized subset from gaining an effort tier.
- `cap` is `raw` shrunk toward neutral by capability evidence confidence. Direct dimension coverage,
  published capability signals, and imputation quality determine confidence; fuzzy model-name
  matches get half confidence. It affects ordering, never effort eligibility. `/4c5p` means four
  direct capability signals and five total publications; `neut` means no capability evidence.
  Operational telemetry never substitutes for capability.
- `fit` is 75% `cap`, 20% deployment operations, and 5% task-fit metadata. Operations combine
  synthetic probe stability with success/speed/recency from at least five real calls. Metadata
  uses the separate specialist/behavior score, exact-SKU tool support, and provider/reference
  context and output limits. Missing inputs are neutral (50), not zero. A known tool-incompatible
  SKU is excluded from automatic effort pools; breaker-open and credential-faulted deployments are
  demoted after scoring.

Only coarse `raw` capability plus the exact-match/three-publication gate decides whether a model
clears an effort floor. The generated snapshot persists the two-point exit band. `fit` decides the
order among eligible deployments. The JSON view exposes dimensions, direct/imputed coverage, task
fit, and confidence.

**Limits and prices are per-(provider, model), and labelled.** The same model id on two providers is
two deployments — different context ceilings, different output caps, and possibly free on one and
metered on the other. Where a provider publishes its own figures (Groq, Mistral, OpenRouter) those
are used and shown unmarked; where it publishes none (NIM returns only `id`/`object`/`created`/
`owned_by`) the table falls back to another provider's figure for the same id and marks it `~`.
If nobody publishes one, the cell is blank — llm-relay does not guess a limit or a price.

That honesty is load-bearing: the **context guardrail only fires against a limit the serving
provider published**. If the limit is unknown the request goes upstream and the backend answers with
its own error, rather than llm-relay rejecting it against a number it made up.

`GET /candidates` returns the full JSON (the table shows a subset). The CLI prefers a running proxy
so the live columns come from warm ping history rather than a cold start.

📄 Full design, the wire evidence behind it, and **how to re-verify the marker after a Claude Code
upgrade**: [docs/subagent-routing.md](docs/subagent-routing.md).

Each provider is `kind:"openai"` (translated Anthropic↔OpenAI via llm-bridge) or
`kind:"anthropic"` (forwarded as-is). In `repair` mode an openai target reshapes on itself;
an anthropic provider has no fixed model id to reshape on, so it needs an explicit top-level
`reshaper` block.

**Prefer the pool form — do not pin one reshaper model:**

```jsonc
"reshaper": { "pool": "medium" }     // ranked candidates, tried in order
```

A pinned `{ "base": …, "model": … }` still works, but if the provider stops serving that exact id
your repair path dies with it and nothing says so. `{ "pool": … }` expands to the pool's ranked
candidates and fails over on transport errors. A **refusal** is never retried on the next
candidate — a reshaper declining to guess is a real judgement, and retrying it elsewhere is
shopping for a more compliant answer, which is how a fabricated tool call gets through.

If **every** candidate fails at the transport level, that is a total outage, not a judgement: the
turn fails clean and is logged `repair: "failed"` (nothing was reachable), never `"refused"` (a
model declined). The two are kept distinguishable in the log because they call for opposite
responses — one is an infrastructure problem, the other is the safety boundary working.

Anthropic-kind entries in the pool are skipped (they cannot reshape); a pool with no usable
target is a loud startup error, never a silently absent reshaper.

### Repointing without editing the file

Config strings may reference env vars as `${NAME}` (unset → loud startup error). Or override
routing from the CLI (wins over the file):

```bash
node dist/cli.js --config config.json --default openrouter/openai/gpt-5.2-codex --mode repair
```

`llm-relay --help` lists every override.

### Model discovery (dynamic + cached)

Model ids are **discovered live** from each provider's `/models` endpoint — never
hand-maintained. The catalog is cached in `~/.llm-relay/models-cache.json`
(10-min TTL, fail-open: a fetch failure serves the last-known list).

```bash
llm-relay models                      # list live models for every provider
llm-relay models --provider nim       # one provider
llm-relay models --provider nim --refresh   # force a re-fetch
```

On startup the proxy warms providers referenced by routing plus free/mixed providers that can
contribute to dynamic pools, then **warns about any routing target its provider doesn't serve**.
Unrelated subscription catalogs stay lazy until first use, while a stale/typo'd routed model is
still caught at boot rather than silently failing on its first request.

> Provider notes: **Groq** returns `403 "check your network settings"` from some
> IPs/regions (a network-side block, not a key issue) — it works once your network
> allows it. **Mistral** needs `MISTRAL_API_KEY` set in your environment.

### Discovery endpoint (`GET /registry`) — for a dispatcher

For a caller that does its own selection (an external dispatcher weighing
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
backend). llm-relay exposes an **OpenAI-compatible front** for exactly this —
`POST /v1/chat/completions` (and `/chat/completions`) plus `POST /v1/responses`: the
request's `model` is routed by namespace/tier. OpenAI-compatible targets receive the
backend model id directly; Anthropic targets receive a translated `/v1/messages` request
and their response is translated back to the caller's OpenAI envelope. Responses streaming,
tool calls and usage are supported. The Anthropic `/v1/messages` front with tool-call repair
stays available in parallel for a Claude-harness client. Meanwhile a plain `claude` client
that sends `claude-sonnet-…` still gets the **dumb tier/default routing** — both coexist,
no mode switch. So the tier map stays the default, and dispatcher-style usage is just
"send namespaced ids + read `/registry`".

OpenAI-native clients can point their base URL at `http://127.0.0.1:8791/v1` and use a
namespaced model such as `anthropic/claude-sonnet-4-20250514` or `pool/medium`. Codex uses
`/v1/responses`; other IDEs commonly use `/v1/chat/completions`. Configure the Anthropic
provider with `kind: "anthropic"` and `authEnv: "ANTHROPIC_API_KEY"` when the relay should
use its own key, or omit `authEnv` for an intentional caller-credential passthrough.

### Model tiers from leaderboards (never a hand-maintained table)

`npm run sync:tiers` snapshots capability rankings into `docs/tier-data.json` from **four** sources
— **OpenRouter** (Artificial Analysis intelligence / coding / agentic indices, Design Arena Elo,
context length, pricing, tool support), **BFCL** (Berkeley Function-Calling Leaderboard — tool-use
accuracy, the primary signal for a tool-call proxy, incl. its Irrelevance-Detection metric = the
malformed-call proxy), **LMArena** (general capability) and **Aider** (polyglot edit benchmark) —
and prints the top tool-callers so you can pick tier targets from real data. Every source is
synced-not-forked, and each is independently failable so one dead endpoint does not cost the
others; a **schema change inside** a source still fails the sync loudly, because a renamed column
is corruption rather than absence. Zero working sources is fatal.

The reshaper also takes `"kind": "openai"` — so `repair` mode can run entirely on an OpenAI-compatible provider (e.g. NIM) with no Anthropic key. The reshaper is asked only for the **corrected arguments per tool-call id** (not the full message envelope), which is far more reliable on weaker models; the proxy reconstructs the message and re-validates it.

### Live run

```bash
node scripts/nim-front.mjs   # runs the compiled proxy fronting live NIM end-to-end (uses NVIDIA_API_KEY)
```
Then point a `claude` CLI at it (see "Install & run" above) and inspect the log to see which calls trip the validator on your traffic.

## What it logs (per request, metadata only)

`{ ts, path, servedProvider, servedModel, hadTools, streamed, backendStatus, validated: pass|fail|uncheckable|skipped, toolUseCount, uncheckableCount, errorKinds[], repair: none|fixed|failed|refused|refused_destructive, latencyMs }`

That list is an **allow-list applied at the sink**, not a convention: the writer projects every record through it, so a caller that hands over a wider object cannot leak a header, a body or an error string carrying a key — and a new field starts being logged only when someone deliberately adds it to the list. `path` is passed through `logSafePath()`, which keeps the route and each query parameter's *name* and replaces its value with the value's length, because a `?task=` value is user prose, not metadata. A failed log write is swallowed to stderr: a full disk is a logging problem, never a request failure.

`uncheckable` = a declared tool with no `input_schema` (built-in `bash`/`text_editor`/…) or a schema that wouldn't compile — surfaced distinctly so an unvalidatable call is never miscounted as a clean pass.

⚠ `servedProvider`/`servedModel` are the deployment that actually served the request — draw "which model trips the validator" conclusions from them. The model the **client asked for** is deliberately not recorded: there used to be a `backendModel` field carrying it, and for a tier or pool spec it is routinely not the model that answered, so every conclusion drawn from this dataset was attributed to whatever id the client happened to send. `null` in the served fields means genuinely nothing served the turn (a guardrail rejection, a routing error, an admin endpoint answered locally).

This is the dataset for deciding which backend models are *format-broken* (reshapeable later) vs pass cleanly. Run in `detect` first, measure, then decide on repair.

### Trip-rate dataset

`node scripts/nim-trip-rate.mjs` probes a list of backend models across difficulty-graded tool schemas (× N trials), runs each call through the real validator, and repairs the failures — producing a per-model **trip rate** (share of tool calls that fail schema validation) and **repair-fix rate**. Latest live NIM run: [`docs/nim-trip-rate.md`](docs/nim-trip-rate.md) (raw records in `docs/nim-trip-rate.jsonl`). The sharp result: even strong Llama-3.1 models emit `days:"5"` (string) against an `integer` schema on every trial — and the proxy repairs it every time; the flat/enum/nested schemas pass clean.

## Composing with headroom (optional)

[headroom](../headroom) is a separate loopback proxy that **optimizes/compresses**
context on the way to the model. Both it and llm-relay are transparent
Anthropic-Messages proxies, so they chain — but only in one order, because
llm-relay's backend speaks OpenAI/NIM while headroom only forwards Anthropic:

```
claude → headroom (:8787, context optimization, OUTER) → llm-relay (:8791, validate/repair + translate, INNER) → NIM/…
```

llm-relay must be **innermost**. To chain them, point headroom's upstream at
llm-relay — headroom exposes this as a launch flag, so its own code is untouched:

```bash
ANTHROPIC_TARGET_API_URL=http://127.0.0.1:8791   # headroom → llm-relay
```

That env var repoints *all* of headroom's Anthropic traffic — including your real
subscription sessions — at llm-relay. **That is fine, and you do not need a second
headroom instance for it**, provided you give llm-relay an `anthropic` passthrough
provider and point every tier at it:

```jsonc
"providers": { "anthropic": { "base": "https://api.anthropic.com", "kind": "anthropic" } },
"routing": {
  "default": "anthropic",
  "tiers": { "opus": "anthropic", "sonnet": "anthropic", "haiku": "anthropic", "fable": "anthropic" },
  "pools":  { "medium": ["nim/z-ai/glm-5.2", "nim/deepseek-ai/deepseek-v4-pro"] }
}
```

A passthrough provider declares **no `authEnv`**, so llm-relay forwards the caller's own
credentials byte-for-byte (`authorization`/`x-api-key` *and* `anthropic-beta`). Every Claude
model you pick therefore reaches real Anthropic untouched, while anything addressed as
`pool/<name>` goes to another provider. One instance, both behaviours.

⚠ **Do not route Codex through headroom.** headroom has a single OpenAI upstream covering both
`/v1/chat/completions` and `/v1/responses`; when using headroom, Codex must reach api.openai.com.
Codex can instead point directly at llm-relay, whose OpenAI front supports `/v1/responses`.

Note the `claude-proxied` wrappers set `ANTHROPIC_BASE_URL` straight to :8791 with a dummy
token and an isolated `CLAUDE_CONFIG_DIR`, so **they bypass headroom entirely** — they are for
testing this proxy against a non-Anthropic backend, not for subscription use.

**Is it worth it?** headroom's headline win is $/token savings vs *paid* Anthropic —
**moot on the free NIM pool**. What still pays off through the chain: context
**compression to fit a smaller backend context window** + lower latency, plus
headroom's backend-agnostic memory/learn layer. So stack it for context-fit, not cost.

## Design

Consumers (an external dispatcher, plain `claude` CLI) point `ANTHROPIC_BASE_URL` at this proxy; it validates one backend per request. Target *selection* / token-prediction is a separate concern (the router/auditor), deliberately not here. For architecture, invariants, and the script inventory, see [CLAUDE.md](CLAUDE.md).

## Dev

```bash
npm run check         # both typechecks + suite — the one gate, and exactly what CI runs
npm run typecheck     # tsc --noEmit, src/ only (tsconfig.json — it drives dist/)
npm run typecheck:test # tsc over the suite (tsconfig.test.json)
npm test              # vitest (validator, SSE reconstruction, e2e transparency+detection)
npm run build         # tsc -> dist/  (scripts/*.mjs read dist/, so rebuild before running them)
```

`.github/workflows/ci.yml` runs `npm run check` on every push to `main` and every pull request.

`test/` needs its own tsconfig because `tsconfig.json` compiles `src/` only and vitest transpiles
tests without type-checking them. Until `tsconfig.test.json` existed nothing checked them at all,
so a `@ts-expect-error` in a test file was never evaluated and proved nothing — treat any
pre-existing one with suspicion, and prefer a runtime assertion when the point is that a surface
does not exist.
