---
name: llm-relay
description: >-
  Operate llm-relay, the loopback multi-provider LLM proxy (default 127.0.0.1:8791) that
  validates/repairs tool calls and can offload Claude Code subagents to non-Anthropic
  providers. Use when offloading bulk work to a subagent on another provider, choosing an
  offload target, addressing a pool or model through the relay, toggling subagent offload,
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
