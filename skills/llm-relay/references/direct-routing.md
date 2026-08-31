# Direct routing and credentials

Read this reference only when configuring or diagnosing traffic that reaches llm-relay directly.
Portable agent-to-agent work still uses MCP `dispatch`; Codex Desktop collaboration children do
not reach this layer.

## Addressing a model

Three forms in a request's `model` field, resolved in this order:

| Form | Goes to | Ranked / failover? |
|---|---|---|
| `pool/<name>` | every candidate in `routing.pools[<name>]` | yes — fitness-ranked, walks candidates on failure |
| `<provider>/<model>` (e.g. `nim/z-ai/glm-5.2`) | that exact deployment, verbatim | no — deliberately pinned |
| a Claude model id (`claude-opus-5`, …) | `routing.tiers` → Anthropic passthrough | n/a |

**Prefer `pool/<name>` over a pinned spec** — a pool survives one model being de-listed; a pin does
not. An unknown pool or provider is a loud 400 (`llm-relay routing: …`), never a silent fallback;
for a pool the error also lists the configured pool names.
Pool refs also work inside `routing.tiers`, `routing.default` and `routing.subagents`; all of them
are validated at config load, so a typo fails at startup, not on the first request.

An unnamespaced/unknown model id lands on `routing.default` — in the standard setup that is the
Anthropic passthrough, so it reaches real Anthropic (spending real quota), never a silently weaker
model.

## Provider credentials

A provider uses legacy `authEnv` or `credentials[]`, never both. Use a fleet for independently
metered accounts on the same backend:

```jsonc
"credentials": [
  { "label": "personal", "authEnv": "NVIDIA_API_KEY" },
  { "label": "work", "authEnv": "NVIDIA_WORK_API_KEY", "models": ["meta/llama-3.1-70b-instruct"] }
]
```

Slot `authEnv` is an exact env name; legacy provider `authEnv` retains compatibility aliases.
Labels are visible, non-secret `[A-Za-z0-9_.-]{1,32}` ids. Optional `enabled` defaults on;
`models` omitted/`null` means all backend ids and `[]` means none. Missing, disabled, or
model-scoped-out slots cannot egress. Provider `maxConcurrent` applies separately to each
`provider#label`.

Any explicit fleet, including `[]`, is contained. True passthrough requires `kind: "anthropic"`, no
provider-owned credentials, and mode not contained; prefer explicit
`credentialMode: "passthrough"`. Passthrough plus a fleet is rejected. Contained Anthropic-format
backends strip caller auth.

Credential walks are deterministic and breadth-first across deployments. A credential-attributable
outcome may unlock the next sibling slot. Provider transport failure suppresses remaining rows for
that provider on the request; protocol/deployment failure closes only that deployment.

## Client-specific offload (OPT-IN — off by default)

Claude Code stamps `cc_is_subagent=true` into the `system` block of subagent requests. Local Codex
stamps `{"request_kind":"subagent"}` into the `x-codex-turn-metadata` header on child-agent
Responses turns. When that client's rule is enabled with `scope: "subagents"`, marked requests
route through `routing.subagents` (tier → spec); with `scope: "all"`, the client's main
conversation consults that map too.

```bash
llm-relay offload status
llm-relay offload claude on --scope subagents
llm-relay offload codex on --scope all
llm-relay offload claude off
```

`routing.offload` is keyed by originating client. Claude is `/v1/messages` and Codex is
`/v1/responses`; arbitrary future names and an explicit `default` rule are valid. The legacy
boolean form remains supported and means one global subagents-only rule.

```jsonc
"routing": {
  "offload": {
    "claude": { "enabled": true, "scope": "subagents", "freeOnly": true },
    "codex": { "enabled": false, "scope": "all" }
  },
  "subagents": {
    "opus": "pool/xhigh", "fable": "pool/xhigh",
    "sonnet": "pool/high", "haiku": "pool/medium", "default": "pool/medium"
  }
}
```

`freeOnly: true` on a rule means that client's rerouted traffic only reaches deployments assessed
free (zero published price / `:free`-labelled / free-tier provider); unknown cost counts as paid,
the Anthropic passthrough never qualifies, and nothing-free-resolving is a clean 503 — never a
silent fall-through that spends money. It binds `@relay:` directives too. A 503 naming freeOnly
means the pool currently has no free member: pick another pool or turn the flag off deliberately.

Three ways to steer a subagent, in precedence order:

1. **`@relay: <spec>` directive** — put it on its own line at the START of the subagent's prompt
   (`@relay: pool/medium` or `@relay: nim/z-ai/glm-5.2`). Stripped before forwarding, so the model
   never sees it. **Works with the switch OFF** — this is the per-call opt-in.
2. **Tier** *(client rule must be on)* — the Agent tool's `model` param maps through
   `routing.subagents` (e.g. opus/fable→`pool/xhigh`, sonnet→`pool/high`, haiku→`pool/medium`).
3. **Nothing** *(client rule on)* — the inherited model id matches a tier, else `subagents.default`.

⚠ Dispatching a subagent does NOT offload it by itself. With that client's rule off, a subagent
runs on its normal route. Check `llm-relay offload status`, don't assume.

⚠ **All three steering methods need the session's traffic to reach the relay.** They reroute an
HTTP request, which requires the request to arrive; from a bypassed host (Claude Desktop) none of
them do anything, and the `@relay:` line reaches the model as literal prompt text. `offload status`
says so when it applies to you.

**On such a host, `llm-relay offload claude on` installs a `PreToolUse(Agent)` hook** into
`~/.claude/settings.json` — that is how the setting is *delivered* where HTTP rerouting cannot
work, not a separate feature. It appends alongside any hook you already have, and
`llm-relay offload claude off` removes it. What it does: deny the `Agent(...)` call and hand back
the relay-routed command to run instead. It is a forcing function, not a redirect — no hook can
change where an in-process subagent's request goes (`SubagentStart` is context-only, and rewriting
the prompt or model does not move the endpoint). It fails **open**: any error allows the call, so a
down proxy never becomes "no subagent works".

Offloaded output is **advisory** — verify claims against source files before acting on them.

### Codex: use MCP dispatch, not Desktop collaboration children

A global npm install provisions both the `llm-relay` Responses provider and the `llm-relay` MCP
server in `~/.codex/config.toml`. In Codex Desktop, call the MCP `dispatch` tool for relay-backed
work. Keep the parent on its normal Codex provider; the MCP server chooses and runs the offload lane.

⚠ Codex Desktop collaboration has a host-side limitation measured on Codex 0.151.0: with a
ChatGPT account, the collaboration launcher validates a child model against the parent account
before contacting llm-relay and ignores the child's `model_provider`. A `pool/medium` child fails
with HTTP 400 (`model is not supported when using Codex with a ChatGPT account`). No prompt or
agent-file setting can repair a request that never reaches the relay.

Releases through v0.68.4 installed `default.toml` and `relay_coding.toml` with that broken path.
Current postinstall retires those files only when their bytes still exactly match llm-relay's old
generated templates; user-edited agents are preserved. A non-Desktop Codex client may still use a
custom-provider child after that exact client has been verified to honor `model_provider`, but that
is an advanced direct-routing setup, not the portable dispatch path.

Directly routed Codex clients may additionally mark child Responses turns with
`x-codex-turn-metadata: {"request_kind":"subagent"}`; the relay recognizes that marker and can
retarget a nominal child model through `routing.subagents`. A verified custom-provider child whose
model is already a `pool/*` reference does not depend on that private header being present. This
does not make it usable in Codex Desktop.
