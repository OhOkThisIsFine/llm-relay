---
name: llm-relay
description: >-
  Operate llm-relay, the loopback multi-provider LLM proxy (default 127.0.0.1:8791) that
  validates/repairs tool calls and can offload Claude Code subagents to non-Anthropic
  providers. Use when offloading bulk work to a subagent on another provider, choosing an
  offload target, addressing a pool or model through the relay, toggling subagent offload,
  dispatching to peer agent CLIs (Antigravity/Codex) as fallback lanes, reordering dispatch,
  or diagnosing a request that failed at or behind the relay.
---

# llm-relay — operating guide

llm-relay is a **loopback-only** reverse proxy for the Anthropic `/v1/messages` API. It routes
each request to a configured provider (Anthropic passthrough, NIM, OpenRouter, Gemini, Groq,
Mistral, …), translating to/from OpenAI-compatible backends, and **validates + repairs malformed
tool calls** so agent harnesses can run on models that are weaker at tool use. Config, keys and
caches live in `~/.llm-relay/` (`config.json`, `.env`, `models-cache.json`, …).

One boundary governs everything it does: the proxy fixes **protocol form** (tool-call args that
violate the schema), never **judgment**. It refuses to fabricate destructive tool calls, and an
unrepairable response fails loudly (502 / mid-stream SSE error) rather than passing through broken.

## Addressing a model

Three forms in a request's `model` field, resolved in this order:

| Form | Goes to | Ranked / failover? |
|---|---|---|
| `pool/<name>` | every candidate in `routing.pools[<name>]` | yes — benchmark-ranked, walks candidates on failure |
| `<provider>/<model>` (e.g. `nim/z-ai/glm-5.2`) | that exact deployment, verbatim | no — deliberately pinned |
| a Claude model id (`claude-opus-5`, …) | `routing.tiers` → Anthropic passthrough | n/a |

**Prefer `pool/<name>` over a pinned spec** — a pool survives one model being de-listed; a pin does
not. An unknown pool or provider is a loud 400 listing valid names, never a silent fallback.
Pool refs also work inside `routing.tiers`, `routing.default` and `routing.subagents`; all of them
are validated at config load, so a typo fails at startup, not on the first request.

An unnamespaced/unknown model id lands on `routing.default` — in the standard setup that is the
Anthropic passthrough, so it reaches real Anthropic (spending real quota), never a silently weaker
model.

## Subagent offload (OPT-IN — off by default)

Claude Code stamps `cc_is_subagent=true` into the `system` block of subagent requests. When the
offload switch is ON, those requests (and only those) route through `routing.subagents`
(tier → spec); the human's own conversation never consults that map.

```bash
llm-relay offload status     # where things stand
llm-relay offload on         # takes effect on the next request, no restart, persisted
llm-relay offload off
```

Three ways to steer a subagent, in precedence order:

1. **`@relay: <spec>` directive** — put it on its own line at the START of the subagent's prompt
   (`@relay: pool/coding` or `@relay: nim/z-ai/glm-5.2`). Stripped before forwarding, so the model
   never sees it. **Works with the switch OFF** — this is the per-call opt-in.
2. **Tier** *(switch must be on)* — the Agent tool's `model` param maps through
   `routing.subagents` (e.g. opus→`pool/reasoning`, sonnet→`pool/coding`, haiku→`pool/fast`).
3. **Nothing** *(switch on)* — the inherited model id matches a tier, else `subagents.default`.

⚠ Dispatching a subagent does NOT offload it by itself. With the switch off, a subagent runs on
Anthropic like any other request. Check with `llm-relay offload status`, don't assume.

Offloaded output is **advisory** — verify claims against source files before acting on them.

## Choosing a target

```bash
llm-relay candidates         # one row per offload target, all dimensions side by side
```

The table is deliberately **un-blended** — capability from each leaderboard separately (AA
agentic/coding, BFCL tool-use, Aider polyglot, LMArena), price, context, live health (verdict,
p95), quota, breaker state, and traffic observed through this proxy. Weigh the columns yourself:

- `str` is the one scalar (pool ordering needs an order) and always carries provenance:
  `83.3/4` = four published signals; `obs` = ranked on this proxy's own traffic; `neut` = nothing
  known. A blank cell means **not measured**, never "bad".
- `~` on ctx/$ means the figure belongs to a **different host** serving the same model id
  (e.g. NIM publishes nothing, so OpenRouter's numbers are shown as reference). Never quote a `~`
  figure as the serving provider's real ceiling or rate.
- Capability is synced (`npm run sync:tiers` in the repo), never hand-typed.

`GET 127.0.0.1:8791/candidates` returns the full JSON (every raw score, jitter, observed calls).

## The dispatch ladder — including agent-CLI lanes (Antigravity, Codex)

Subscription and CLI-credit quotas are **client-bound**: only the vendor's own client can spend
them, so the relay cannot front them as providers (Antigravity's endpoint is compiled into its
binary; Codex's ChatGPT path uses client-bound OAuth on `/v1/responses`). They are still dispatch
targets — the host agent reaches them by shelling out to the vendor CLI, and they participate in
**one ordered ladder** together with the relay's pools. Walk it top to bottom; each rung falls
back to the next on failure or quota exhaustion, exactly like candidates inside a relay pool.

**Default ladder for offloadable work** (bulk recon, extraction, analysis). Included
subscription/credit allowances are spent before metered-or-free API capacity, so the cheap lanes
are the *first* resort, not the fallback:

1. **Antigravity — Gemini 3.6 Flash, any tier.** The default workhorse for every tier; pick the
   reasoning level to suit the task, since AGY bakes it into the model id:
   ```bash
   agy -p "<task>" --model gemini-3.6-flash-medium --output-format json
   ```
   `-high` for analysis and tracing, `-medium` for ordinary recon, `-low` for mechanical sweeps.
   Other flags: `--add-dir <path>` to scope the workspace, `--json-schema` for structured output,
   `--print-timeout` (default 5m), `--mode plan` for analysis-only runs. Spends AGY CLI credits.
   *Exhausted when:* the CLI reports credits/quota exhausted or rate-limits.
2. **Antigravity — Claude, same CLI and credits.** When Flash is not strong enough for the task,
   stay on AGY and step up rather than leaving the lane: `--model claude-opus-4-6-thinking` for
   hard reasoning, `--model claude-sonnet-4-6` for everything else. (Neither id carries a level
   suffix — use the session flag `--effort low|medium|high` if you need to tune them.)
   *Exhausted when:* AGY credits are gone — i.e. this rung and rung 1 exhaust together.
3. **Codex — Sol, then Terra, then Luna.** Spends the ChatGPT subscription:
   ```bash
   codex exec --model gpt-5.6-sol "<task>"
   ```
   Walk `gpt-5.6-sol` → `gpt-5.6-terra` → `gpt-5.6-luna` in that order. Set reasoning to suit with
   `-c model_reasoning_effort="high|medium|low"` (the config default is `high`). `codex exec review`
   runs a repo review. *Exhausted when:* it reports usage-limit errors.
4. **Relay pools — free API-key capacity, benchmark order.** `@relay: pool/coding` (or the tier
   mapping in `routing.subagents` when offload is on). Ordering *inside* a pool is by synced
   benchmark strength, not config order — see "Reordering dispatch" below. *Exhausted when:* the
   pool 4xx/5xxs after failover walks every candidate, or `llm-relay candidates` shows the breaker
   open / quota drained across the pool.
5. **Anthropic subagent** — plain `Agent(...)`, no directive. Spends primary quota; always works.

`agy models` and the Codex model list are the authority on what exists — re-check them rather than
trusting these ids after a CLI upgrade, since a de-listed id fails the whole rung.

Rules for walking it:

- **Skip a rung whose CLI is not installed** (`Get-Command agy` / `codex` or `command -v`) — this
  ladder degrades gracefully to "relay pools, then Anthropic" on machines without the peer CLIs.
- Both CLIs are **full agents with their own tool loops** — hand them a self-contained prompt with
  file paths, run long tasks in the background, and treat output as advisory (verify against
  source) exactly like relay-offloaded output. Do NOT wrap them in a bare one-shot HTTP helper.
- A **refusal or a wrong answer is not a transport failure** — do not walk the ladder to shop for
  a more compliant model. Only availability failures (errors, quota, rate limits) advance a rung.
- Interactive-only quotas (e.g. an IDE-bound plan with no CLI) are unreachable by any dispatcher;
  don't try to MITM them into the ladder.

## Reordering dispatch

Ordering exists at three levels; change the right one:

- **The ladder above** (which lane is tried first): it is instructions, not code — edit the
  numbered list in this skill file (`skills/llm-relay/SKILL.md` in the repo; the installed copy
  lives in `~/.claude/skills/llm-relay/`, refreshed on package upgrade). E.g. to preserve AGY
  credits and spend free API capacity first, move rung 4 to the top. The user can also reorder
  per-request in chat ("try codex first for this").
- **Which pool a tier lands on** (`routing.subagents` in `~/.llm-relay/config.json`): maps the
  Agent tool's `model` param (opus/sonnet/haiku/…) to a pool or pinned spec. Takes effect on the
  next request; no restart.
- **Candidate order inside a pool** (`routing.pools`): with `"benchmarkSort": true` (default
  setup) failover order is by synced benchmark strength and the config array only breaks ties.
  To make the array order authoritative, set `"benchmarkSort": false`. Either way the circuit
  breaker still demotes unhealthy targets — that is live health, not preference, and it is what
  you want. For an absolutely fixed destination, pin `<provider>/<model>`; a pin is never
  reordered and never fails over.

## Everyday commands

```bash
llm-relay models -p nim      # live roster per provider (listed ≠ servable — some listed ids 404)
llm-relay keys               # provider key health + quota
llm-relay ping               # latency/stability probe across providers
llm-relay telemetry          # JSON health/quota report
```

Runtime endpoints on the running proxy: `/registry`, `/candidates`, `/offload` (GET/POST),
`/telemetry`, `/ping`, `/health`.

## Failure modes worth knowing

- **Relay down** → clients pointed at it fail to start. It must be running before anything routes.
- **404 from an openai backend** is nearly always the model id: a model can be listed in `/models`
  and still not be served (NIM does this). The error says so; pick another candidate or a pool.
- **429s pass through** — the client's retry/backoff handles them; the relay's circuit breaker
  cools that target down and failover walks the next pool candidate.
- **400 "exceeds the context limit"** fires only when the serving provider itself published a
  limit. Unknown limit = no guardrail; the backend answers with its own authoritative error.
- **Repair refused/failed** → 502 `tool call could not be repaired (…)`. That is fail-clean by
  design: a refusal is a judgement and is never retried on another model.
- **Document blocks** to openai backends are converted to markdown via MarkItDown
  (`pip install 'markitdown[all]'`); without it, requests carrying documents fail with a clear
  error instead of injecting base64 into the prompt.

## Safety invariants (do not work around these)

- Loopback bind only — it holds provider keys and does no auth.
- Logs are metadata-only; never ask it to log request/response bodies.
- Destructive tool calls are refused, never fabricated — repair output may run under
  `--dangerously-skip-permissions`.
