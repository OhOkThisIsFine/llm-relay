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
not. An unknown pool or provider is a loud 400 (`llm-relay routing: …`), never a silent fallback;
for a pool the error also lists the configured pool names.
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

### The lanes, and how to drive each

- **Relay pools** — `@relay: pool/coding` on a subagent prompt, or the tier mapping in
  `routing.subagents` when offload is on. Spends provider API keys. *Exhausted when:* the pool
  4xx/5xxs after failover walks every candidate, or `llm-relay candidates` shows the breaker open
  / quota drained across the pool.
- **Antigravity (`agy`)** — `agy -p "<task>" --model <id> --output-format json`. Ask
  `agy models` for the roster; ids may carry a reasoning-level suffix (`…-high|-medium|-low`),
  and `--effort low|medium|high` tunes ids that don't. Other flags: `--add-dir <path>` to scope
  the workspace, `--json-schema` for structured output, `--print-timeout` (default 5m),
  `--mode plan` for analysis-only runs. ⚠ **AGY meters its Gemini and its Claude models against
  two independent credit balances** — exhausting one leaves the other fully available, so they
  are two distinct rungs, not one.
- **Codex** — `codex exec --model <id> "<task>"`, spending the ChatGPT subscription. Reasoning
  level is a config override, not a flag (there is no `--effort`):
  `-c model_reasoning_effort="minimal|low|medium|high|xhigh"`, defaulting to whatever
  `~/.codex/config.toml` sets; `plan_mode_reasoning_effort` sets it separately for plan mode.
  ⚠ Codex's own guidance is that high effort burns subscription rate limits fast — match the
  level to the task rather than leaving it high for mechanical work. `codex exec review` runs a
  repo review.
- **Anthropic subagent** — plain `Agent(...)`, no directive. Spends primary quota; always works,
  so it is the natural bottom of any ladder.

The CLIs' own model lists are the authority on what exists — re-check them rather than trusting
ids written down anywhere, since a de-listed id fails a whole rung.

### Order — ask the relay, don't guess

The ordering is **config, not prose**: `routing.ladder` in `~/.llm-relay/config.json`, an ordered
list of rungs. Ask for the next lane rather than deciding yourself:

```bash
llm-relay dispatch -t "<the task>"     # ordered ladder + the exact command to run
llm-relay dispatch --json              # same, machine-readable
```

`next` is the lane to use and `reason` says why. Then:

- **Override with a specific target:** `llm-relay dispatch <lane> -t "<task>"` (or
  `GET /dispatch?lane=<id>`). Honoured even if that rung is cooling down — you asked for it.
- **A lane failed on availability** (quota gone, rate-limited, CLI missing): report it and get
  the next one — `llm-relay dispatch -x <lane>`, or
  `POST /dispatch {"exhausted":"<lane>","ttlMs":…}`. Rungs sharing a `quota` bucket cool down
  together; rungs that merely share a binary do not. `{"clear":true}` resets.
- **Walk manually:** `GET /dispatch?after=<lane>` for the first ready rung past one.
- **Turn subagent routing on/off:** `llm-relay offload on|off` — `/dispatch` reports the switch
  state, and flags relay rungs `requiresDirective: true` while it is off, meaning a bare subagent
  will *not* offload and you must put `@relay: <spec>` in its prompt or flip the switch.

The relay decides order and remembers what is spent; **it never runs a `cli` rung for you** — it
hands you the command and you execute it. That boundary is deliberate: a CLI agent runs its own
tool loop and returns only final text, so nothing it produces could serve an HTTP turn.

⚠ Config lives in `~/.llm-relay/config.json`, which npm never touches, so a ladder survives
reinstalls. **Never write a user's ordering into this skill file** — `postinstall` overwrites it
from the package on every global install and the edit would be silently lost.

With no `routing.ladder` configured, `/dispatch` says so and expresses no opinion; fall back to
the user's `CLAUDE.md`, or to relay pools first and primary quota last.

Rules for walking it:

- **Skip a rung whose CLI is not installed** (`Get-Command agy` / `codex` or `command -v`) — this
  ladder degrades gracefully to "relay pools, then Anthropic" on machines without the peer CLIs.
- Both CLIs are **full agents with their own tool loops** — hand them a self-contained prompt with
  file paths, run long tasks in the background, and treat output as advisory (verify against
  source) exactly like relay-offloaded output. Do NOT wrap them in a bare one-shot HTTP helper.
- A **refusal or a wrong answer is not a transport failure** — do not walk the ladder to shop for
  a more compliant model. Only availability failures (errors, quota, rate limits) advance a rung.
- **The rungs draw on five independent buckets**, so exhausting one never implies the next is
  gone: AGY-Gemini, AGY-Claude (separate balances despite one CLI), ChatGPT, provider API keys,
  Anthropic primary. Re-check the rung you skipped on the next dispatch — a reset refills it.
- Interactive-only quotas (e.g. an IDE-bound plan with no CLI) are unreachable by any dispatcher;
  don't try to MITM them into the ladder.

## Reordering dispatch

Ordering exists at three levels; change the right one:

- **Which lane is tried first** (`routing.ladder` in `~/.llm-relay/config.json`): reorder the
  array; rung order *is* the ladder. Add `"enabled": false` to park a rung without deleting it.
  Validated at load — a bad spec, a duplicate id, or a `cli` rung whose `args` lack `{task}`
  fails at startup, not mid-fallback. ⚠ Never put a personal ordering in
  `~/.claude/skills/llm-relay/SKILL.md`: `postinstall` overwrites it on every global install.
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
llm-relay keys               # are the CREDENTIALS good?
llm-relay pools --probe      # will each configured MODEL answer? real completion per member
llm-relay ping               # latency/stability probe across providers
llm-relay telemetry          # JSON health/quota report
```

Runtime endpoints on the running proxy: `/registry`, `/candidates`, `/offload` (GET/POST),
`/dispatch` (GET/POST), `/telemetry`, `/ping`, `/health`.

⚠ **`/offload` and `/dispatch` are admission-checked — loopback is not authorization.** They flip
routing and rewrite `~/.llm-relay/config.json`, and any web page can POST to `127.0.0.1`, so the
proxy rejects with **403** when the `Origin` header is present and not loopback, or when `Host` is
not a loopback name (DNS rebinding). A `POST` must also send `content-type: application/json`. The
CLI and a normal `curl -H 'content-type: application/json'` are unaffected — a missing `Origin` is
allowed. A surprise 403 from these two paths is this check, not a broken proxy. This closes the
browser-driven write path only; the proxy still does no authentication, so never bind it off-loopback.

`llm-relay telemetry` reports health as a tri-state: `true`, `false`, or **`null` = nothing has been
observed yet**. `null` is not `false` — an unmeasured provider is unknown, not unhealthy, and
`unmeasuredProvidersCount` says how many are in that state. Same rule for `stabilityScore` and
`quotaPercent`: unmeasured stays `null` rather than becoming a confident-looking zero.

**`keys` and `pools --probe` answer different questions — you need both.**

- `keys` can be wrong in BOTH directions, which is why it hedges. A 200 from a public
  `/models` proves nothing about a key (it re-probes anonymously and escalates when needed);
  and a 401/403 on the escalated probe does not prove a key is bad, because free-tier rosters
  list premium models a valid key cannot touch. When the probe answers identically with and
  without credentials, nothing can be concluded and it reports **`UNVERIFIED`** — treat that
  as "unknown", never as "broken", and do not tell the user to rotate a key on that basis.
- `pools --probe` is the ground truth for whether a *model* works, and the only thing that
  catches a member that is configured, catalogued, and dead. **Run it after editing
  `routing.pools`.** A `DEAD`/`AUTH` member should be removed: pools are strength-ranked, so a
  dead model can sit at the top and burn a failover hop on every request. `EMPTY` is NOT dead —
  that is a reasoning model that spent its token budget thinking.
- Never add a spec to a pool without probing that exact spec first.

## Failure modes worth knowing

- **Relay down** → clients pointed at it fail to start. It must be running before anything routes.
- **404 from an openai backend** is nearly always the model id: a model can be listed in `/models`
  and still not be served (NIM does this). The error says so; pick another candidate or a pool.
- **429s pass through** — the client's retry/backoff handles them; the relay's circuit breaker
  cools that target down and failover walks the next pool candidate.
- **400 "exceeds the context limit"** fires only when the serving provider itself published a
  limit. Unknown limit = no guardrail; the backend answers with its own authoritative error.
- **Repair refused/failed** → 502 `llm-relay: tool call could not be repaired (<outcome>)`
  (mid-stream, the same text as an SSE `error`). That is fail-clean by design. Read the outcome —
  the four are not interchangeable:
  - `refused_destructive` — the failing call named a destructive tool, so its arguments were never
    model-authored. Expected, not a bug; see below.
  - `refused` — a reshaper looked at the call and declined to guess. A **judgement**, so it is
    returned as-is and never retried on another model; retrying would be shopping for a more
    compliant answer, which is how a fabricated call gets through.
  - `failed` — nothing usable came back: the reshaper never validated within `maxAttempts`, **or**
    every pooled reshaper candidate was unreachable. A total outage is reported as `failed`, never
    as `refused`, because nobody answered and so there is no judgement to report.
- **A malformed `Bash`, `BashOutput`, `Write`, `Edit`, `MultiEdit` or `NotebookEdit` call is
  refused, not repaired** — that is `refused_destructive`, and a repair that used to "succeed" on
  one of these was the bug, not the feature. Matching is **exact on the tool name**
  (case-insensitive), so safe tools that merely contain a scary fragment — `PushNotification`,
  `ResetZoom`, `ForceRefresh` — are permitted; a config can opt a whole family in deliberately with
  a trailing `*` (`git_*`). The list is `repair.destructiveTools`, and it is the ONLY source: an
  empty list refuses nothing, because there is no hidden built-in set in `src/`.
- **Document blocks** to openai backends are converted to markdown via MarkItDown
  (`pip install 'markitdown[all]'`); without it, requests carrying documents fail with a clear
  error instead of injecting base64 into the prompt.

## Safety invariants (do not work around these)

- Loopback bind only — it holds provider keys and does no auth. Loopback is not authorization
  either: the control routes (`/offload`, `/dispatch`) admission-check `Origin`, `Host` and (on
  POST) the content type, and that check is not a workaround target.
- Logs are metadata-only; never ask it to log request/response bodies.
- Destructive tool calls are refused, never fabricated — repair output may run under
  `--dangerously-skip-permissions`. The set is `repair.destructiveTools`, matched exactly by name
  and covering the harness's own write/execute tools (see *Failure modes* above). Narrowing it to
  make a repair "work" removes the guard, it does not fix the call.
