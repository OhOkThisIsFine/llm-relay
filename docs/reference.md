# llm-relay reference

The full usage reference. The [README](../README.md) is the short version; this file covers
config, routing, pools, offload, repair, the CLI, endpoints, and the caveats.

---

## What it does

- **Transparent passthrough** — forwards streaming and non-streaming `/v1/messages` byte-for-byte.
- **`detect` mode** — deterministic tool_use validation (Ajv2020) with metadata-only logging of
  pass/fail/uncheckable. Behavior is unchanged; it only observes.
- **`repair` mode** — on a validation failure, a cheap reshaper model corrects the call, the
  result is **re-validated**, and the corrected response is re-emitted (JSON or SSE).
  Destructive-tool calls are **refused, never fabricated**; unrepairable calls **fail clean**
  (502). Valid calls pass through untouched.
- **OpenAI-compatible backends** (`kind: "openai"`) — front NIM / vLLM / OpenRouter / LM Studio.
  Requests are translated Anthropic↔OpenAI via [`llm-bridge`](https://github.com/supermemoryai/llm-bridge);
  the validate/repair layer always sees Anthropic Messages regardless of backend.
- **Bidirectional OpenAI front** — `POST /v1/chat/completions` and `POST /v1/responses` work
  against both `openai` and `anthropic` targets, streaming and tool calls included.
- **Streaming repair** — text SSE frames stream to the client as they arrive; the proxy only
  withholds from the first `tool_use` block. Pure-text responses are byte-for-byte passthrough
  with zero added latency. A mid-stream repair failure surfaces as an SSE `error` event, never a
  fabricated call.

**The one boundary:** the relay fixes/flags *protocol form* (malformed tool calls), never
*judgment* (bad reasoning). Routing decisions come from config and deterministic classification,
never from an LLM's opinion inserted into the request path.

### Live demo (no external creds)

```bash
npm run build && node scripts/live-demo.mjs
```

Runs the compiled CLI against a local flaky-model backend + stub reshaper, showing detect
(logs the failure) then repair (delivers the fixed call).

---

## Install & run

```bash
NVIDIA_API_KEY=nvapi-... npx llm-relay    # instant, no install
npm install -g llm-relay && llm-relay      # global
```

A global install also drops the generated **llm-relay skill** into `~/.claude/skills/llm-relay/`
and `~/.codex/skills/llm-relay/` (both copied from one source, refreshed on every upgrade), and
provisions local Codex: the `llm-relay` Responses provider in `~/.codex/config.toml` plus
relay-backed `default` and `relay_coding` child agents under `~/.codex/agents/` when absent.
Existing Codex files are preserved.

If your npm blocks unknown install scripts (`npm warn install-scripts … blocked`), allow this one
— `npm config set allow-scripts=llm-relay --location=user` — or run the installer by hand:
`node "$(npm root -g)/llm-relay/scripts/install-skill.mjs" --force`.

### Staying current

Every start (except `help`/`version`) compares against the npm registry — cached 6h, 2.5s
timeout, silent on failure. A **global install updates itself** (installs the new version,
re-execs, continues your command; a failed install says so and continues on the old version).
Any other copy just prints the upgrade command. Stale bin shims from the old version are removed
in all of npm's spellings. Set `LLM_RELAY_NO_SELF_UPDATE=1` to skip the check entirely.

---

## Verifying a setup — two checks, two questions

`keys` answers *are my credentials good?* `pools --probe` answers *will the models I configured
actually answer?* Both are needed:

- A 200 from a provider's `/models` proves nothing when that endpoint is public — a revoked key
  still returns the full catalogue. `keys` re-probes anonymously and escalates to an
  authenticated completion when it must.
- A 401/403 does **not** prove a key is bad — free-tier rosters list premium models a valid key
  cannot touch. When nothing can be concluded, `keys` reports `UNVERIFIED` rather than accusing
  a working key.
- Neither can see a model that is configured, catalogued, and dead. Only `pools --probe` can —
  it sends a real completion to every pool member.

Keys are read from the environment and, if present, from `~/.llm-relay/.env` (one `KEY=value`
per line). **A variable already set in the environment always wins over the file.**

---

## Config

`~/.llm-relay/config.json` (or `--config <path>`): a `providers{}` registry plus a `routing`
block. All state lives under `~/.llm-relay/` (`config.json`, `.env`, `models-cache.json`,
`probe-cache.json`, `runtime-telemetry.json`).

```jsonc
{
  "listen": "127.0.0.1:8791",              // loopback ONLY — startup refuses non-loopback
  "providers": {
    "nim":        { "base": "https://integrate.api.nvidia.com/v1", "kind": "openai", "authEnv": "NVIDIA_API_KEY" },
    "openrouter": { "base": "https://openrouter.ai/api/v1",        "kind": "openai", "authEnv": "OPENROUTER_API_KEY" },
    "anthropic":  { "base": "https://api.anthropic.com", "kind": "anthropic", "credentialMode": "passthrough" }
  },
  "routing": {
    "default": "pool/medium",
    "tiers":  { "opus": "pool/xhigh", "fable": "pool/xhigh", "sonnet": "pool/high", "haiku": "pool/medium" },
    "pools": {
      "low":    { "preferred": [], "include": "free", "effort": "low" },
      "medium": { "preferred": [], "include": "free", "effort": "medium" },
      "high":   { "preferred": [], "include": "free", "effort": "high" },
      "xhigh":  { "preferred": [], "include": "free", "effort": "xhigh" }
    }
  },
  "mode": "repair",                        // detect | repair
  "repair": { "maxAttempts": 2, "destructiveTools": ["Bash", "Write", "Edit", "..."] },
  "log": { "level": "metadata", "file": null }
}
```

Config strings may reference env vars as `${NAME}`. An unset `${NAME}` in a provider `base`
**disables that provider** (its pool members are dropped with a warning) rather than aborting
startup — losing *every* route is still fatal. CLI startup overrides (`--default`, `--mode`,
`--listen`) win over the file.

### Model addressing (split on the first `/`, first match wins)

1. **`pool/<name>`** — expands to the pool's candidate list, benchmark-ranked with failover. An
   unknown pool is a **400, never a silent fallback** — a typo must not quietly succeed against
   a different model.
2. **`provider/model`** — a configured provider name routes there directly; the entire tail
   (nested slashes, `:free` suffixes) is the backend model, verbatim. A pinned spec is never
   re-ranked.
3. **Tier** — otherwise a Claude model id is substring-matched against `routing.tiers`
   (`opus`/`sonnet`/`haiku`/`fable`). This also catches Claude Code's internal side-calls.
4. **Default** — anything else falls to `routing.default`.

`pool/<name>` exists because some callers can only send **one model string** — notably Claude
Code subagent frontmatter. A pool gives them ranking and failover anyway. `pool` is a reserved
provider name. Pool refs are legal in `routing.tiers`, `routing.default` and `routing.subagents`;
pool-in-pool is rejected at load.

**Passthrough:** an `anthropic`-kind provider with **no `authEnv`** forwards the caller's own
credentials byte-for-byte (`authorization`/`x-api-key` *and* `anthropic-beta`). Point every tier
at it and real Claude traffic stays on real Anthropic while `pool/*` routes elsewhere — one
proxy, both behaviours.

Say so with **`"credentialMode": "passthrough"`**. Omitting it still forwards, so existing
configs keep working, but startup warns: "needs no key of its own" and "may be sent the user's
subscription credential" are different intentions, and only the first should follow from an
omission. The opposite declaration, **`"credentialMode": "contained"`**, is the one to use for a
keyless `anthropic`-kind backend that is *not* your own vendor — a local daemon, a second relay,
someone else's Anthropic-format endpoint — and strips the caller's credential instead. It is
illegal alongside `authEnv` (that pair claims both at once). `openai`-kind providers never
receive inbound credentials at all: their upstream headers are built from scratch, which is why
a keyless `ollama` needs no declaration and gets no warning.

### Pools — static and dynamic

A pool is either a static array of specs, or a dynamic free pool:

```jsonc
"medium": { "preferred": [], "include": "free", "effort": "medium" }
```

The `preferred` prefix stays first in written order; the relay then appends every free model
discovered from the live catalogs, ranked by capability. `effort` (`low`|`medium`|`high`|`xhigh`)
is a cumulative capability floor, not a ceiling. Admission needs an exact SKU match and at least
three published capability signals; a member exits only when it falls two points below its floor
(no flapping); known tool-incompatible SKUs are excluded. Catalog refreshes re-materialize pools
automatically — new free models never need a config edit.

⚠ **A pool routes to fewer members than it lists** when some declare an `authEnv` that is unset —
those are dropped before ranking, so a 14-member pool can resolve to 7 and the config's tenth
entry can legitimately be the one that answers. `llm-relay candidates` reports the count.

### Failover (both fronts, one policy)

- **429 / 5xx / 400 / 402 / 404 / 410** → recorded as a breaker failure, next candidate tried. A
  `Retry-After` sets that candidate's cooldown for exactly as long as the provider asked;
  402 (depleted credits) cools for 1 hour. A 410 whose body states end-of-life additionally
  records a `not-servable` fact, so a retired model stops burning a walk slot per request.
- **401 / 403** → next candidate tried, but the fault is recorded on its own axis so
  `llm-relay candidates` shows `AUTH 401` instead of hiding it. It expires after 5 minutes, so a
  rotated key recovers with no restart.
- **A genuine client 4xx** (413, 422, …) → returned as-is; every candidate would reject it
  identically.
- **Every candidate failed** → the last real upstream error, never a synthesized one. If every
  failure was a 429, the served `Retry-After` is the earliest across the pool.
- **Walk budget** — a wall-clock ceiling on *starting* further attempts, so a deep pool cannot
  spend `members × timeoutMs` on one request. The first two attempts are always allowed and an
  attempt in flight is never aborted. Default 45 s; tune with top-level `"walkBudgetMs"` in
  config.json (`0` disables).

Health **demotes** candidates, never drops them (live → credential-faulted → cooling). Responses
carry `x-llm-relay-served-by`: the deployment that served, or on error every deployment tried,
in order. Background: [pool-failover.md](pool-failover.md).

Any walk of **two or more** candidates also carries `x-llm-relay-pool-attempts` — what happened to
each of them, in one line:

```
x-llm-relay-pool-attempts: 13 tried, 0 served: 4×402, 5×429, 3×403, 1×400
```

Without it a pool's error is one member's error: a 402 pointing at a billing page, while the other
twelve failed for three unrelated reasons and the right move was "use another pool". The body is
left alone — it stays the last candidate's real upstream error — so the aggregate rides in a header.
It appears on successes too, where it warns that a pool is thinning before it runs out.

When the answer came from **below** the requested effort band, the response carries
`x-llm-relay-degraded: gemini/models/gemini-2.5-flash (below xhigh)`.

An effort pool is its banded members first, then a degrade tail of everything clearing a lower band
— strongest band first. The tail is reached only after every in-band member has actually failed on
that request, so a healthy pool behaves exactly as before. This exists because a band selects on
capability and capability correlates with the providers that meter hardest, so the top band is both
the narrowest and the first to run dry: measured 2026-08-08, `pool/xhigh` returned 0 served from 12
members while `pool/low` answered from 46 on the same credentials at the same moment.

⚠ Degradation is automatic but never silent — an unflagged capability downgrade is indistinguishable
from getting what you asked for. ⚠ A model that clears **no** band is admitted nowhere, tail
included: unassessed is not the same as weaker.

Ordering also **interleaves providers** within a rank band, so the first N attempts land in N
distinct quota domains rather than N members sharing one credential. The top-ranked candidate is
still tried first; interleaving only decides who is tried second.

A failure whose refusals the relay could not interpret also carries
`x-llm-relay-unknown-refusal: <n>` — a **count, never the message**. The learned-eligibility store
converges only as fast as somebody explains what an unrecognised refusal means, and a queue that
must be polled is a backlog nobody works; this tells the caller to run `llm-relay eligibility` while
it still has the context. The message itself stays out of the header deliberately: it is untrusted
text from an external service, and a response header is exactly the field a client tends to trust.

⚠ On `/v1/messages` the count covers only the candidates **stepped over** — that front commits the
response head before reading the body, so a single-member pool's own refusal is not counted there.
It still reaches `llm-relay eligibility`.

### Context guardrail

The relay estimates each request's prompt tokens against the target model's context limit and
rejects an oversized request with a 400 before any network egress. ⚠ **It only fires against a
limit the serving provider published** (from the warm catalog cache — never a fetch on the
request path). Unknown limit ⇒ no guardrail; the backend returns its own authoritative error.
The relay never rejects a request against a number it guessed.

### Quieting the onboarding nudge (`leave_me_alone`)

```jsonc
"leave_me_alone": ["openai", "anthropic"]
```

`llm-relay onboard` stops prompting for these providers' keys. A name matching no configured
provider is deliberately legal (the list is the negative space — most entries are preset names
you never configured). It suppresses the nudge only: a listed provider still appears in `keys`,
`/registry`, telemetry and `candidates`, and still routes normally.

---

## Repair details

### Destructive-tool refusal (`repair.destructiveTools`)

A repaired tool call may run under `--dangerously-skip-permissions`, so the relay refuses to
emit one that names a destructive tool — it never guesses arguments for it.

- **Matching is exact on the tool name, case-insensitively** — not substring. A trailing `*` is
  an opt-in prefix form (`"git_*"` covers `git_push`, not `gitlab_read`); a bare `"*"` matches
  nothing.
- **The default list leads with the harness's own write/execute tools** (`Bash`, `BashOutput`,
  `Write`, `Edit`, `MultiEdit`, `NotebookEdit`) then the conventional names (`rm`, `delete`,
  `delete_file`, `remove`, `overwrite`, `drop`, `reset`, `force_push`).
- An **empty** list refuses nothing — there is no hidden built-in set, so coverage is always
  traceable to your config. Refused repairs are logged `repair: "refused_destructive"`.

### The reshaper

In `repair` mode an `openai`-kind target reshapes on itself; an `anthropic` provider needs an
explicit top-level `reshaper` block. **Prefer the pool form:**

```jsonc
"reshaper": { "pool": "medium" }     // ranked candidates, tried in order
```

A pinned `{ "base": …, "model": … }` works, but dies silently if the provider de-lists that id.
The pool form fails over on **transport errors only** — a refusal is a real judgement and is
never retried elsewhere (that would be shopping for a more compliant answer). Every candidate
failing at the transport level is logged `repair: "failed"` (nothing reachable), never
`"refused"` (a model declined); the two call for opposite responses. The reshaper is asked only
for **corrected arguments per tool-call id**, which is far more reliable on weak models; the
proxy reconstructs the message and re-validates.

---

## Offload (`routing.offload` + `routing.subagents`)

Independently route Claude, Codex, and future clients' marked subagents — or whole
conversations — to other providers. **Off by default.**

```jsonc
"routing": {
  "subagents": {
    "opus": "pool/xhigh", "fable": "pool/xhigh",
    "sonnet": "pool/high", "haiku": "pool/medium", "default": "pool/medium"
  },
  "offload": {
    "claude": { "enabled": true,  "scope": "subagents", "freeOnly": true },
    "codex":  { "enabled": false, "scope": "all" }
  }
}
```

Rules are keyed by originating client (Claude uses the `/v1/messages` front door, Codex
`/v1/responses`; an explicit `default` rule is the opt-in catch-all). `scope: "subagents"`
reroutes only marked child requests; `scope: "all"` also moves the main conversation — useful
when a quota is exhausted. The CLI toggles one client **without a restart**:

```bash
llm-relay offload status
llm-relay offload claude on --scope subagents
```

**How subagents are recognized:** Claude Code stamps `cc_is_subagent=true` into the `system`
block of subagent requests; local Codex stamps `x-codex-turn-metadata`. This is a client
behaviour, not an API contract — re-verify after a client upgrade
([subagent-routing.md](subagent-routing.md#re-verifying)).

### Hosts whose traffic never arrives

Rerouting a subagent means answering its HTTP request differently, which requires the request to
arrive. A **Claude Desktop** session's does not: the launcher pins `ANTHROPIC_BASE_URL` to
`api.anthropic.com`, overriding both the User-scope variable and the `env` block of
`~/.claude/settings.json` (the block's other keys still land — only that one is managed). The
switch then reports ON and nothing changes.

`llm-relay offload status` detects this and says so. And on such a host, `llm-relay offload claude
on` installs a **`PreToolUse(Agent)` hook** into `~/.claude/settings.json` — the delivery mechanism
for the setting where HTTP rerouting cannot work, not a separate feature. `offload claude off`
removes it again.

The hook denies the `Agent(...)` call and returns the relay-routed command
(`llm-relay dispatch --next-command`) for the agent to run. It is a **forcing function, not a
redirect**: no hook can move an in-process subagent's endpoint — it is served by the same process
over the same pinned connection, `SubagentStart` is context-only by specification, and rewriting
the prompt or `model` via `updatedInput` changes neither the host nor the vendor. It **appends**
alongside any `Agent` hook you already have, refuses to touch an unparseable settings file, and
**fails open** — every error path allows the call, so a stopped proxy never becomes "no subagent
works at all".

**Per-call pin:** put a directive on its own line at the start of the subagent's prompt:

```
@relay: nim/z-ai/glm-5.2
Trace every caller of parseConfig and report the file:line of each.
```

The line is stripped before forwarding, so the model never sees it. It works **whether or not
the offload switch is on** — the per-call opt-in. It is read only from the last text block of
`messages[0]` (the dispatcher's authored prompt), never from tool results — otherwise any file a
subagent reads could redirect its own routing.

Precedence for a marked subagent request: `@relay:` directive → `subagents[<tier>]` →
`subagents.default` → normal routing.

**`freeOnly: true` is the money guard:** the client's rerouted traffic may only reach
deployments assessed **free**. Unknown cost counts as paid, the Anthropic passthrough is never
free, and nothing free resolving is a clean 503 naming the rule — never a silent fall-through to
`routing.default`. It also binds `@relay:` directives, so a subagent prompt cannot spend money
past it.

Full design and wire evidence: [subagent-routing.md](subagent-routing.md).

### What backends said about themselves: `llm-relay eligibility`

A pool's membership is an assumption until a deployment corrects it. `assessCost()` admits any
unpriced model from a `tierType: "free"` provider as free — right as a default, wrong for the
subscription-gated SKUs and de-listed models every roster carries. This command shows what the
backends have since stated, and what has not been understood yet:

```
llm-relay eligibility
```

Four verdicts, and they are **not interchangeable**:

| Verdict | Means | Effect |
|---|---|---|
| `not-servable` | the model is gone from the provider | excluded from pools |
| `subscription-required` | exists, but is not covered by our plan | excluded from **free** pools |
| `allowance-exhausted` | free, but spent until it refreshes | **demoted only**, expires by itself |
| `credential-invalid` | the provider says this key is bad | **demoted only**, cleared by any success |

Each is stored at the **scope its evidence supports**, and lookups resolve most-specific-first:

| Scope | Covers | Typical evidence |
|---|---|---|
| `deployment` | one (provider, model) | "this model requires a subscription" |
| `group` | an explicit list of models on one provider | a family-wide gate, members named |
| `provider` | every deployment behind that credential | a credit balance, a revoked key |
| `model` | the same id wherever served | reference-grade only; never cost or availability |

⚠ Scope comes from what the evidence **states**, never from counting failures — several models
failing identically is equally several gated models under a working key. ⚠ A `group` carries its own
member list; there is no family registry and no prefix inference, so a group verdict can never
quietly widen to a model nobody reviewed.

⚠ The last is never treated as "paid" — a free account that has spent this period's credits is the
normal state of a working free lane, not a discovery about price. It is scoped to the **account**,
so one member's stated credit balance also steps its siblings aside instead of each spending a
round-trip to be told individually. Any success clears it.

A refusal whose message the relay does not recognise changes **nothing** and is listed as pending.
Resolve one by researching what that message means for that provider and model on this account:

```
llm-relay eligibility propose 1 --class subscription-required --scope deployment --rationale "..."
llm-relay eligibility propose 2 --class subscription-required --scope group --members pro-1,pro-2 --rationale "..."
llm-relay eligibility accept 1 --class subscription-required --scope deployment
llm-relay eligibility reject 1
```

Only `accept` makes an interpretation affect routing. That gate is deliberate: research may be done
by an agent, but the request path only ever reads confirmed data — it never asks a model what an
error means mid-request. Design and evidence: [pool-eligibility.md](pool-eligibility.md).

### Choosing a target: `llm-relay candidates`

Every offload target with its dimensions **side by side and deliberately un-blended**:
capability from each leaderboard separately, live behaviour (verdict, p95, jitter, uptime),
availability now (quota, breaker state, auth faults, still-listed), cost, and traffic observed
through the proxy. The sources disagree on purpose — weigh the columns for the task at hand.
`GET /candidates` returns the full JSON.

Capability comes from `npm run sync:tiers`, which merges OpenRouter (Artificial Analysis
indices, pricing, context, tool support), BFCL (tool-call accuracy), LMArena, and Aider into
`docs/tier-data.json` (~770 models). A blank cell means *not measured*, never *bad*. Sources,
scoring formulas and rejected alternatives: [capability-sources.md](capability-sources.md).

**Limits and prices are per-(provider, model), and labelled.** The same model id on two
providers is two deployments. Where a provider publishes its own figures they are shown
unmarked; where it publishes none (NIM), another provider's figure for the same id is shown
marked `~`; where nobody publishes one, the cell is blank — the relay does not guess.

### Local Codex setup

A global install creates these automatically; to do it by hand, add to `~/.codex/config.toml`:

```toml
[model_providers.llm-relay]
name = "llm-relay"
base_url = "http://127.0.0.1:8791/v1"
wire_api = "responses"
requires_openai_auth = true
```

Then create `~/.codex/agents/relay_coding.toml` (and optionally override `default.toml` the same
way) with `model_provider = "llm-relay"` and `model = "pool/medium"`. The parent session stays
on its normal provider; child dispatches go through the relay. Enable with
`llm-relay offload codex on --scope subagents`. Hosted ChatGPT/Cloud tasks cannot reach a
loopback relay — those remain separate dispatch lanes.

### Dispatch ladder

`llm-relay dispatch` answers a different question than offload: which **lane** (peer CLI, relay
pool, passthrough) should a host hand a whole task to, in what order. The order is config
(`routing.ladder`, or per-tier `routing.ladders.{low,medium,high,xhigh}`); the relay hands the
host a command and **never spawns a CLI itself**. Mark a spent lane with
`llm-relay dispatch -x <lane> --outcome rate_limited|quota_exhausted` (or
`--retry-after-ms <n>` for a vendor-stated reset).

A `cli` rung may declare `env`: string values are set on the spawned command, `null` values are
unset (`llm-relay dispatch` renders both into the printed line — `env -u X NAME=value cmd …` for
sh, `$env:`/`Remove-Item Env:` statements for PowerShell). This is what makes a **relay-routed
`claude` CLI rung** declarable — the lane for hosts whose own HTTP traffic cannot be redirected
(Claude Desktop pins its sessions to `api.anthropic.com`; a terminal-spawned `claude` honours
`ANTHROPIC_BASE_URL`, so shelling out IS the redirect):

```jsonc
{
  "id": "claude-pool", "kind": "cli", "command": "claude",
  "args": ["-p", "--model", "pool/medium", "--permission-mode", "plan", "{task}"],
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8791",
    "ANTHROPIC_AUTH_TOKEN": "dummy",           // relay strips it for contained providers
    "CLAUDE_CONFIG_DIR": "/home/me/.llm-relay-claude", // isolated: no OAuth conflict with a
                                               // subscription. ABSOLUTE path — env values are
                                               // passed verbatim, `~` is never expanded
    "CLAUDECODE": null, "CLAUDE_CODE_SSE_PORT": null, "CLAUDE_CODE_ENTRYPOINT": null,
    "ANTHROPIC_API_KEY": null                  // nested-session vars a parent claude leaks
  }
}
```

#### Host-adaptive lanes (`routing.cliLane`)

`llm-relay dispatch` is meant to be the **one verb** a host agent uses, whatever harness it runs
in. To make that true it classifies the calling session — **routed** (its traffic reaches the
relay, so `relay` rungs work as written) or **bypassed** (it does not) — and adapts the answer.

The verdict comes from the caller's `ANTHROPIC_BASE_URL`: a loopback address means routed (a proxy
chain in front, e.g. headroom, still counts), anything else or unset inside a Claude session means
bypassed. It is detected by the **CLI**, which is a child of that session, and forwarded as
`?host=`; the relay cannot work it out from a request, because a bypassing host sends none.
`--host routed|bypassed|unknown` overrides it.

On a bypassed host, a `relay` rung whose spec needs the subagent-reroute path is **transposed** into
a CLI invocation using `routing.cliLane`, so one template replaces a hand-written CLI rung per pool
per tier:

```jsonc
"routing": {
  "cliLane": {
    "command": "claude",
    "args": ["-p", "--model", "{spec}", "--permission-mode", "plan", "{task}"],
    "env": {
      "ANTHROPIC_BASE_URL": "http://127.0.0.1:8791",
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "{contextWindow}",   // dropped when unpublished
      "CLAUDECODE": null
    }
  }
}
```

**Placeholders.** `{spec}` (required) is the rung's routing spec and `{task}` (required) the
delegated task. `{contextWindow}` (optional) is the spec's published context window in tokens.

| Placeholder | In `args` | In `env` | Why |
|---|---|---|---|
| `{spec}` | yes | yes | relay-resolved routing |
| `{contextWindow}` | yes | yes | relay-resolved provider metadata |
| `{task}` | yes | **rejected at config load** | request content must never become process configuration |

A rung pointing at the plain Anthropic passthrough is **not** transposed — a bare `Agent(...)`
reaches that from any host. With no template configured, such a rung is reported `unreachable` and
skipped when picking `next` (an explicit `?lane=` still reaches it, and says why it is blocked).
`requiresDirective` is never set on a bypassed host, because an `@relay:` line there is inert, not
merely insufficient.

#### The context window (`{contextWindow}`)

A CLI told to use a model it does not recognize assumes a window and compacts against it — the
`claude` CLI assumes 200k — so a lane pointed at a 1M-context model silently throws away most of
it. The relay already harvests per-(provider, model) limits for the request-path guardrail, so it
substitutes the number it has.

Three rungs, **all real measurements** — there is deliberately no guessed rung, the same rule that
keeps `resolveMetadata` honest and the request-path guardrail silent on an unknown limit:

1. **`observed`** — a ceiling this deployment *stated when it refused an over-length request*.
   The strongest evidence available: a first-party fact about the exact deployment that will serve
   the next request. See "Learned limits" below.
2. **`provider`** — the serving deployment's own published `contextLength`.
3. **`snapshot`** — `context_length` from the synced capability data (`docs/tier-data.json`, from
   OpenRouter), matched **exactly** on the spec's last segment.

`llm-relay dispatch` prints which rung answered, because a first-party figure and a same-model
figure measured on another host are different claims:

```
   context: 1,048,576 tokens (published by the serving provider)
   context: 163,840 tokens (synced snapshot, same model id on another host)
   context: not published anywhere for this spec — the variable is omitted and the CLI uses its own default
```

⚠ **Rung 2 is what makes this usable.** Free providers publish little metadata and NIM publishes
none, so rung 1 alone is nearly empty — measured 2026-08-07, 0 of 29 `pool/high` members carry a
provider-published window while 28 of 29 carry a snapshot one.

⚠ **Fuzzy snapshot matches are rejected.** `findTierModel` will fall back to containment, which can
borrow a different SKU's row (`glm-5.2` → `glm-5.2-max`). A wrong capability score mis-ranks a pool;
a wrong context window tells a client it may send tokens the backend will reject, so this path takes
the stricter rule.

For a **`pool/<name>`**, the **minimum across members that resolve** is used — failover can land the
request on any member, so the pool's usable window is the smallest one known. An unresolvable member
does **not** veto the pool; the count of unmeasured members is reported alongside the number, so a
floor drawn from 28 of 29 members does not read like one drawn from all of them:

```
   context: 163,840 tokens (synced snapshot, same model id on another host; 1 pool member unmeasured)
```

**Nothing known at all** drops the env entry entirely rather than setting it empty (which a child
would read as zero or garbage), leaving the client on its own default.

⚠ **Do not "fix" an unknown by hand-setting a large value.** The measured pool minimums here are
131,072–163,840 — *below* the 200k the `claude` CLI already assumes for an unrecognized model. A
speculative 1M would overshoot the weakest member by six to eight times and overflow the real
backend, which is strictly worse than the conservative default it replaced.

#### Learned limits (`~/.llm-relay/context-limits.json`)

Providers publish little, but a deployment that *rejects* an over-length request usually states its
real ceiling in the error message. The proxy reads that and remembers it, so a pool's floor gets
more accurate the more it is used:

- Fires on a backend **400/413** whose body reads as a context-length rejection, on **both**
  request paths.
- Records **only an explicitly stated maximum**. "The request was too long" is *not* recorded — it
  bounds the ceiling by this proxy's own chars/4 estimate, and a store whose value is that it holds
  measurements must not accept a guess.
- Reads a **clone** of the response, so the client's body and any failover are untouched. Every
  failure path simply learns nothing.
- Keyed per `(provider, model)`, since the same model id on two hosts is two deployments. A fresh
  observation always replaces an older one in either direction — the deployment is the authority on
  its own ceiling — and entries expire after 30 days so a raised ceiling is not disbelieved forever.

This is what makes the "unmeasured member" case self-correcting: the first over-length rejection
from that member states its ceiling, and the next dispatch reports the corrected floor.

`llm-relay dispatch --next-command -t "<task>"` prints just the runnable line for `next`, for
callers that want something executable rather than the human ladder.

---

## The OpenAI front and `/registry`

OpenAI-native clients point their base URL at `http://127.0.0.1:8791/v1` and use a namespaced
model (`anthropic/claude-sonnet-4-20250514`, `pool/medium`). Codex uses `/v1/responses`; most
IDEs use `/v1/chat/completions`. OpenAI Chat to an OpenAI backend is byte-transparent; other
combinations translate through the Anthropic seam, streaming and tool calls included. The
Anthropic front with tool-call repair runs in parallel — no mode switch.

`GET /registry` returns one JSON view for an external dispatcher: every provider with `has_key`,
`reachable`, and its live models (each with raw capability scores, never collapsed to tiers),
plus current routing and the full leaderboard dataset.

### Document attachments on non-Anthropic backends

Anthropic `document` blocks (PDF, docx, pptx, xlsx, CSV, HTML, …) are converted to markdown via
[MarkItDown](https://github.com/microsoft/markitdown) before reaching an OpenAI-compatible
backend. MarkItDown is optional (`pip install 'markitdown[all]'`, or set
`LLM_RELAY_MARKITDOWN`); without it, a document request gets a clear 400 naming the install
command. An unconvertible document is **refused, never truncated or inlined raw**. Images pass
through natively.

### Model discovery

Model ids are discovered live from each provider's `/models` endpoint — never hand-maintained —
and cached in `~/.llm-relay/models-cache.json` (10-min TTL, fail-open). On startup the proxy
warms routed and free providers and warns about any routing target its provider doesn't serve.

```bash
llm-relay models                 # every provider
llm-relay models -p nim -r       # one provider, force re-fetch
```

---

## CLI reference

| Command | Description |
| :--- | :--- |
| `llm-relay` | Start the proxy |
| `llm-relay onboard` | Set up provider keys |
| `llm-relay setup <claude-cli\|claude-desktop>` | Point a client at the relay |
| `llm-relay keys` | Check provider credentials |
| `llm-relay pools [--probe]` | List pool members; `--probe` tests each with a real completion |
| `llm-relay pools <set\|add\|remove\|delete> <name> [spec...]` | Edit a pool |
| `llm-relay routing <show\|get\|default\|tier\|subagent\|sort\|benchmark\|set\|unset>` | Edit routing |
| `llm-relay config <show\|get\|set\|unset> [path] [value]` | Edit any config field |
| `llm-relay models [-p <name>] [-r]` | List live provider catalogs |
| `llm-relay ping [-p <name>]` | Probe provider latency/health |
| `llm-relay telemetry` | Print telemetry/quota JSON |
| `llm-relay offload [status \| <client> <on\|off> [--scope <scope>]]` | Show/toggle offload |
| `llm-relay candidates [-p <name>]` | Compare offload targets |
| `llm-relay dispatch [lane] [options]` | Choose the next dispatch lane |
| `llm-relay help` / `llm-relay version` | Help / version |

Config editors validate the complete JSON before writing and need a proxy restart; the offload
toggle and dispatch queries talk to a running proxy and apply immediately.

```bash
llm-relay pools set medium nim/z-ai/glm-5.2 openrouter/openai/gpt-5.2-codex
llm-relay pools set medium --free --effort medium     # dynamic free pool
llm-relay routing default nim/z-ai/glm-5.2
llm-relay routing tier sonnet pool/high
llm-relay config set routing.offload.claude.freeOnly true
```

### Endpoints

| Endpoint | Purpose |
| :--- | :--- |
| `POST /v1/messages` | Anthropic front; validates/repairs tool calls |
| `POST /v1/messages/count_tokens` | Local token count |
| `POST /v1/chat/completions`, `POST /v1/responses` | OpenAI front |
| `GET /registry` | Provider/routing/capability metadata |
| `GET /candidates` | Offload target data |
| `GET\|POST /offload` | Read/set offload rules |
| `GET\|POST /dispatch` | Read/advance the dispatch ladder |
| `GET /telemetry`, `GET /ping`, `GET /health` | Telemetry, probe, health |

⚠ **Loopback is not authorization.** Mutating endpoints require the per-install 256-bit
capability token (`~/.llm-relay/control-token` — the CLI carries it automatically), a loopback
`Host`, no non-loopback `Origin`, and `content-type: application/json`. Responses carry
`x-llm-relay-served-by`, `x-llm-relay-quota-percent`, and `x-llm-relay-stability-score`.

---

## Using it from your projects

Point the `claude` CLI at the proxy with an **isolated `CLAUDE_CONFIG_DIR`** — without it, an
active claude.ai subscription session conflicts with the proxy token and claude fails
client-side (`Invalid API key`) before any request is sent. The bundled wrappers
(`scripts/claude-proxied.ps1` / `.sh`) set everything:

```bash
scripts/claude-proxied.sh -p "list the files here"
```

Or inline:

```bash
env -u CLAUDECODE -u ANTHROPIC_API_KEY \
  CLAUDE_CONFIG_DIR="$HOME/.llm-relay-claude" \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8791 \
  ANTHROPIC_AUTH_TOKEN=dummy \
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 CLAUDE_CODE_ATTRIBUTION_HEADER=0 \
  claude -p "list the files here"
```

`ANTHROPIC_AUTH_TOKEN` can be `dummy` — the proxy injects the real backend key from `authEnv`.
Weak backends still fail *reasoning* (repair fixes form, not judgment) — pick a strong
tool-caller.

### What Claude Code gives up behind ANY custom `ANTHROPIC_BASE_URL`

Not caused by, and not fixable by, llm-relay — Claude Code changes its own behaviour behind any
gateway. Verified against Claude Code 2.1.220; re-check after an upgrade.

| What breaks | Workaround |
|---|---|
| **1M context silently drops to 200k** (client omits the beta header) | Pin per-launch: `ANTHROPIC_MODEL='claude-opus-5[1m]' claude` (overrides the model picker) |
| **`/remote-control` disabled** (hard-gated to api.anthropic.com) | None — unset `ANTHROPIC_BASE_URL` to get it back |
| **MCP tool search off by default** | `ENABLE_TOOL_SEARCH=true` (llm-relay forwards `tool_reference` blocks) |

---

## Logging (metadata only)

Per request: `{ ts, path, servedProvider, servedModel, hadTools, streamed, backendStatus,
validated, toolUseCount, uncheckableCount, errorKinds[], repair, latencyMs }`.

The list is an **allow-list applied at the sink** — a caller handing over a wider object cannot
leak a header, body, or key. Query parameter *values* are replaced by their lengths.
`servedProvider`/`servedModel` are the deployment that actually answered (the id the client
asked for is deliberately not recorded — for a pool spec it is routinely not the model that
served). A failed log write is swallowed: a full disk is a logging problem, never a request
failure.

Run in `detect` first, measure which models trip the validator on your traffic, then decide on
repair. `node scripts/nim-trip-rate.mjs` produces a per-model trip-rate dataset
([nim-trip-rate.md](nim-trip-rate.md)).

---

## Composing with headroom (optional)

headroom (a separate loopback proxy, `pip install headroom-ai`) compresses context; llm-relay
routes.
They chain in one order only — llm-relay innermost, because its backends speak OpenAI while
headroom only forwards Anthropic:

```
claude → headroom (:8787, compression) → llm-relay (:8791, route/repair/translate) → providers
```

Point headroom's upstream at the relay (`ANTHROPIC_TARGET_API_URL=http://127.0.0.1:8791`) and
give llm-relay an `anthropic` passthrough provider with every tier pointing at it: subscription
traffic reaches real Anthropic untouched, `pool/*` goes elsewhere, one instance of each.
**Do not route Codex through headroom** — headroom has a single OpenAI upstream; point Codex
directly at llm-relay's `/v1/responses` instead. The `claude-proxied` wrappers bypass headroom
by design (they are for testing the relay, not subscription use).

---

## Dev & release

```bash
npm run check          # both typechecks + suite — the one gate; CI runs exactly this
npm run build          # tsc -> dist/ (scripts/*.mjs read dist/ — rebuild before running them)
npm test               # vitest
```

`test/` is type-checked by `tsconfig.test.json` (vitest transpiles without type-checking).
Releases publish via npm Trusted Publishing from GitHub Actions — no npm token exists; push a
`v*` tag matching `package.json` on `main`. Architecture and invariants: [CLAUDE.md](../CLAUDE.md).
