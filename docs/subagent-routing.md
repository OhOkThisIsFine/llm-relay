# Client-specific offload routing

How llm-relay independently sends Claude and Codex **subagents** to non-Anthropic providers, and
optionally routes either client's main conversation through the same destination map.

> **This document describes direct HTTP routing, not the portable dispatch entry point.** The
> client's request must already reach llm-relay. For every MCP host, prefer the `dispatch` tool;
> without MCP, use `llm-relay dispatch --next-command`. Codex Desktop collaboration rejects a
> `pool/*` child against the ChatGPT account before contacting a custom provider, so it must use
> MCP `dispatch` rather than the mechanism documented below.

Shipped in **0.3.0**; **off by default since 0.4.0**. Config: `routing.subagents` gated by the
client rules in `routing.offload`. Code: `isSubagentRequest()`, `readRelayDirective()`,
`subagentSpec()` in
[`src/config.ts`](../src/config.ts), applied in `handle()` in [`src/server.ts`](../src/server.ts).

> **Offload is opt-in.** Existing boolean configs remain supported. New configs should use one rule
> per originating client: `claude`, `codex`, or any future client name. Pick destinations with
> `llm-relay candidates`. See [The switch](#the-switch).

---

## The problem this solves

Claude Code's `ANTHROPIC_BASE_URL` is **process-wide**. There is no per-subagent endpoint. So to run
a subagent on another provider, the whole session must point at llm-relay — including the human's own
conversation. llm-relay then has to tell the two apart.

It routes on exactly one input: the `model` string. Nothing else identifies the caller.

### Why the obvious design is broken

The design everyone reaches for first (including the author) is to map llm-relay's existing tiers
onto providers:

```jsonc
"tiers": { "opus": "nim/…", "sonnet": "nim/…", "haiku": "nim/llama-3.1-8b-instruct" }
```

…and declare cheap subagents as `model: haiku`. It uses config that already exists and needs no new
feature. **It is also silently destructive.**

- A subagent declaring `model: haiku` makes Claude Code send `claude-haiku-4-5-20251001`.
- A human picking Haiku in the model picker makes Claude Code send `claude-haiku-4-5-20251001`.

Byte-identical. llm-relay cannot distinguish them, so `haiku → nim/llama-8b` silently drops **the
human's own conversation** onto an 8B model. No error, no warning — just a much weaker model
answering as though it were Claude. Same for every other tier.

**Conclusion: tier is not a subagent signal.** `routing.tiers` must stay pointed at an Anthropic
passthrough. A separate signal was required.

Scope note: that rule is about the **offload topology**, the one this document describes — the human
keeps reaching real Anthropic and only subagents are redirected. It is not a rule about every
config. The shipped [`config.example.json`](../config.example.json) is the *other* topology, the
proxy's original one: no Anthropic provider is declared at all, every tier maps to a free provider,
and the whole session — human included — runs on non-Anthropic models on purpose. There is no
conversation to protect there, so nothing is silently downgraded. The failure mode above appears
precisely when the two are mixed: an Anthropic passthrough in the config *and* a tier pointed
somewhere else.

## The signals: `cc_is_subagent=true`, `x-claude-code-agent-id`, `x-codex-turn-metadata`

**THREE** independent signals, any one sufficient (`isSubagentRequest`). They are checked together
because each covers the others' silent failure, and the shared failure mode is expensive: an
undetected subagent falls through to the passthrough and spends **primary quota** while the
dispatcher believes it offloaded.

The third arrived with Codex support and is the reason the set is not two: a Codex
`/v1/responses` turn has no Anthropic `system` field at all, so it cannot carry the marker.
`x-codex-turn-metadata` is a JSON header whose `request_kind: "subagent"` identifies a child turn;
it is parsed defensively, fails open for anything unrecognized, and is never forwarded upstream.

**`x-claude-code-agent-id`** (adopted 2026-08-05) is the documented one. Anthropic's
[gateway protocol reference](https://code.claude.com/docs/en/llm-gateway-protocol) defines it as the
"Identifier of the subagent that issued the request, present only on requests from an agent Claude
Code spawned inside the session", and states that a gateway may consume the `x-claude-code-*`
headers for routing. Presence is the whole signal — the value identifies *which* agent, and the
same page warns it identifies an agent rather than a person, so the relay never treats it as a user
id. It dies to any middleware that filters unknown request headers, which this relay commonly runs
behind, and Anthropic's advice is to treat the set as open and growing.

**The system-block marker** below is the original signal, kept because it travels *inside the body*
and so survives header filtering. It has its own kill switch: `CLAUDE_CODE_ATTRIBUTION_HEADER=0`
removes the attribution block, and therefore the marker, from the system prompt entirely. The three
signals travel in three different carriers — a body block, an Anthropic-side header, and a
Codex-side header — so no single component drops them all.

### The marker: `cc_is_subagent=true`

Claude Code stamps a billing header as the **first line of the `system` block**, and on subagent
requests only:

```
x-anthropic-billing-header: cc_version=2.1.220.e23; cc_entrypoint=sdk-cli; cc_is_subagent=true;
```

Captured off the wire **2026-07-28 against Claude Code 2.1.220**. Observed facts:

| Fact | Detail |
|---|---|
| Present on subagent requests only | A capture of one dispatch ran `main, main, SUB, SUB, main, main` — no false positives, and stable across the subagent's own multi-turn loop |
| Built-in agents carry it | Verified with the built-in **Explore** agent, not just custom `.md` agents — this is what removes the need to write agent files |
| Subagent model is inherited | A built-in subagent's `model` was `claude-opus-5`, the main conversation's model, unless the Agent tool's `model` param overrides it |
| `messages[0]` is block-structured | Block 0 is Claude Code's injected `<system-reminder>` (CLAUDE.md, current date, …); the **last** text block is the dispatcher's authored prompt |

⚠ **The marker is a client behaviour, not a documented API guarantee** (the header is the
documented half). Re-verify after a Claude Code upgrade (see [Re-verifying](#re-verifying)). If
*both* signals ever disappear, every subagent falls back to normal routing — which is *safe*
(passthrough) but **silent**, so nothing will alert you.

## Design

For a marked subagent request, the destination resolves in this order:

1. **`@relay: <spec>`** on its own line in the dispatcher's prompt. `<spec>` is any normal spec —
   `pool/<name>` or `<provider>/<model>`. The line is **stripped before forwarding**, so the model
   never sees it. Works whether or not the switch is on: it is the per-call opt-in.
2. **`routing.subagents[<tier>]`** — tier substring-matched from the inbound model id.
   *Requires the originating client's rule to be enabled.*
3. **`routing.subagents.default`**. *Requires the originating client's rule to be enabled.*
4. Otherwise unchanged — normal tier/default routing.

Requests without the marker never consult any of this when the rule's scope is `"subagents"`.
With scope `"all"`, ordinary requests from that client also use the map. The relay identifies
Claude by `/v1/messages`, Codex by `/v1/responses`, and OpenAI-compatible chat by
`/v1/chat/completions`; a future front door can use its own rule name or the explicit `default`
rule.

```jsonc
"routing": {
  "tiers":     { "opus": "anthropic", "sonnet": "anthropic", "haiku": "anthropic", "fable": "anthropic" },
  "subagents": { "opus": "pool/xhigh", "fable": "pool/xhigh", "sonnet": "pool/high", "haiku": "pool/medium", "default": "pool/medium" },
  "pools":     { "high": { "preferred": [], "include": "free", "effort": "high" } },
  "offload": {
    "claude": { "enabled": true, "scope": "subagents" },
    "codex":  { "enabled": false, "scope": "all" }
  }
}
```

## The switch

The object form of `routing.offload` has one entry per originating client:

| Field | Meaning |
|---|---|
| `enabled` | Whether this client's offload rule is active. |
| `scope: "subagents"` | Only marked Claude/Codex child requests use `routing.subagents`. |
| `scope: "all"` | Marked children and the client's ordinary conversation use `routing.subagents`. |

An absent key and the legacy boolean `false` are off. A legacy boolean `true` remains a global,
subagents-only rule for backward compatibility. A `default` object rule is an explicit catch-all;
named client rules take precedence over it.

Offloading every subagent the moment a `subagents` map exists was the 0.3.x behaviour, and it is the
wrong default: it silently changes *who is answering* for every built-in agent (Explore,
general-purpose, every one-off dispatch), with no per-call signal that it happened. Which model
answers your reconnaissance is a decision worth making on purpose, so it is now a decision.

```bash
llm-relay offload status
llm-relay offload claude on --scope subagents
llm-relay offload codex on --scope all
llm-relay offload claude off
```

Targeted `on` / `off` reach the running proxy over loopback (`POST /offload`), so the change applies
to the **next request with no restart**, and is persisted back to `config.json`. The API body is
`{"client":"codex","enabled":true,"scope":"all"}`; `GET /offload?client=codex` reads one
rule, while `GET /offload` returns the aggregate and all configured rules. With no proxy listening
the CLI writes the file and says so. `llm-relay dispatch --client codex` makes dispatch hints use
the same client rule.

⚠ **Binding to loopback is not authorization.** Flipping this switch decides which vendor answers
every subagent and rewrites `config.json`, so protected control requests require the per-install
256-bit capability in `~/.llm-relay/control-token`. The CLI attaches it automatically and the
proxy never forwards it to a provider. Admission also requires `Host` to exactly match the bound
listener authority; a present `Origin` must match its exact scheme, host, and effective port
(`Origin: null` is invalid); and a mutating POST must declare `content-type: application/json`.
Missing or invalid capability material returns 403 before any control action. Tokenless GETs are
limited to the side-effect-free status set. Keep using the CLI rather than copying the capability,
and never expose the listener off-loopback.

## Choosing a destination

For a multi-slot provider, `/candidates` emits one row per configured deployment × credential
slot. Missing, disabled, and model-scoped-out cells remain visible for diagnosis even though they
cannot egress. Read the slot's `credentialId`, non-secret policy/state, breaker and learned facts,
and its typed quota observations separately; do not collapse them into a provider-wide percentage.

`GET /candidates` is a protected control read, as is `GET /registry`. Prefer
`llm-relay candidates`, which attaches the
per-install capability automatically and uses the running proxy when reachable. A direct client
must attach the capability from `~/.llm-relay/control-token`; never print, copy, or log it.

`llm-relay candidates` (or `GET /candidates`) is the decision table — every offload target with its
dimensions **side by side and un-blended**:

| Group | Columns |
|---|---|
| Capability (per source) | AA intelligence / coding / agentic, BFCL overall + multi-turn, Aider pass-rate, LMArena rating + rank |
| Specialized task fit | Design Arena agent Elo, BFCL irrelevance, Aider well-formed |
| Cost / shape | context window, price per M tokens in + out, declares tool support |
| Live behaviour | verdict, avg / p95 latency, jitter, uptime %, last ping code |
| Availability now | credential slot policy/state; typed requests/tokens × period quota observations with remaining, limit, reset and basis; per-cell breaker/cooldown/facts; listed in live catalog |
| Observed traffic | calls, successes, average latency through this proxy |

Every leaderboard keeps its own field under `scores`; they disagree, and that disagreement remains
visible. The routing scalar is deliberately structured rather than an available-signal average:
`rawStrength` is fixed at 40% agentic, 35% coding, and 25% general capability, with persisted
calibration anchors and overlap-estimated missing dimensions. `fitness` then combines 75% confidence-
adjusted capability, 20% deployment operations, and 5% task-fit metadata. Latency, quota, and every
raw source value remain separately inspectable.

The scalar never travels without `strengthBasis`, `strengthSignals`, `capabilityDimensions`, and
`directDimensions`/`imputedDimensions`, so an estimate cannot masquerade as direct coverage.
`StrengthBasis` has two values — `snapshot` | `neutral` (see
[`src/benchmarks.ts`](../src/benchmarks.ts)). Runtime telemetry is operational evidence only; it can
order deployments but never impersonates model capability. There is no `static-table` basis.

The CLI first queries the protected running relay for warm quota, ping, and breaker evidence. If
that read is unavailable it falls back to a cold local view, whose environment and runtime fields
may differ from the serving process; unmeasured live-behaviour cells remain blank.

**A blank capability cell means "not measured", not "bad"**, and the sources have very different
coverage — see [capability-sources.md](capability-sources.md) for the probe results. Capability is
synced, never typed: `npm run sync:tiers` merges OpenRouter, BFCL, LMArena and Aider into
`docs/tier-data.json`. Add a source by writing a fetcher there.

⚠ Name-keyed sources match by substring, so a model with no row of its own can inherit a
**different** model's scores. That is why OpenRouter is the spine — its ids are the same shape as
routing specs, so `z-ai/glm-5.2` matches exactly instead of landing on `glm-5.2-max`. Where a fuzzy
match is still the only option, `capability.match` / `capability.matched_name` name the row used and
the CLI marks it `~`.

⚠ `BENCHMARK_DB` — the hardcoded score table in `benchmarks.ts` — was **deleted in 0.6.0**. Every
pattern it carried was already in the snapshot, so it contributed only a stale, provenance-free
number that outranked synced data for anything it substring-matched. Until 0.5.0 it was the *only*
ranking input, which meant models it had never heard of all collapsed to a flat 50.0 and tied, so
pool order silently fell back to whatever order the config happened to list. Don't reintroduce one.

⚠ **Limits and prices are per-(provider, model), not per-model.** The same id on two providers is
two deployments with different ceilings and different prices — possibly free on one and metered on
the other. `candidates` reports each field's provenance (`provider`, or `reference` rendered `~`),
so a NIM row never presents OpenRouter's context window or rate as its own. NIM publishes no
metadata at all; Groq and Mistral publish real limits. Nothing is guessed: unknown renders blank,
and the context guardrail only enforces a `provider` figure.

This gives a dispatcher three levels of control, all optional:

| Intent | How |
|---|---|
| "use this exact model" | `@relay: nim/moonshotai/kimi-k2.6` as the first line of the subagent prompt |
| "use a cheap/strong one" | the Agent tool's `model` param (`sonnet\|opus\|haiku\|fable`) → `subagents[<tier>]` |
| "just pick something good" | say nothing → `subagents.default` → pool ranked by `benchmarkSort` |

The Agent tool's `model` parameter is an enum (`sonnet｜opus｜haiku｜fable`) in Claude Desktop, so a
dispatcher **cannot** name an arbitrary model through it. That is precisely why `@relay:` exists.

## Security boundary

**The directive is read only from the last text block of `messages[0]`.**

Block 0 is Claude Code's injected `<system-reminder>` — it carries your `CLAUDE.md`. Later messages
carry tool results, i.e. **file contents**. Honouring a directive from either would let any file a
subagent happens to read redirect its own routing, and a `CLAUDE.md` in any repo could re-point every
agent that runs there.

Both cases are covered by tests in [`test/config.test.ts`](../test/config.test.ts):
"reads the directive ONLY from the dispatcher's prompt (last block), not injected context" and
"ignores a directive arriving in a later message (i.e. in a tool result / file content)".

Blast radius if it were bypassed is bounded — specs resolve only against configured providers and
pools, never an arbitrary host — but silently rerouting an agent because a repo contained a magic
line is a bad failure regardless.

## Re-verifying

After a Claude Code upgrade, confirm the marker still exists. Put a logging proxy in front of
llm-relay, dispatch any subagent, and check the `system` block:

```js
// capture.mjs — forwards to llm-relay untouched, logs whether each request is a subagent
import http from "node:http";
http.createServer((req, res) => {
  const ch = []; req.on("data", c => ch.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(ch);
    try {
      const p = JSON.parse(raw.toString("utf8"));
      const sys = Array.isArray(p.system) ? p.system.map(s => s.text ?? s).join("\n") : (p.system ?? "");
      // All THREE signals, reported separately — any one alone still routes, but a signal that
      // has quietly stopped arriving is exactly what this check exists to surface. Codex speaks
      // /v1/responses and carries neither of the Claude-side signals, so do not filter by path.
      if (req.url?.startsWith("/v1/messages") || req.url?.startsWith("/v1/responses")) {
        const marker = sys.includes("cc_is_subagent=true");
        const header = Boolean(req.headers["x-claude-code-agent-id"]);
        let codex = false;
        try {
          codex = JSON.parse(req.headers["x-codex-turn-metadata"] ?? "{}").request_kind === "subagent";
        } catch {}
        const sub = marker || header || codex;
        console.log(sub ? "SUB" : "main", `marker=${marker} header=${header} codex=${codex}`, p.model);
      }
    } catch {}
    const up = http.request(
      { host: "127.0.0.1", port: 8791, path: req.url, method: req.method, headers: req.headers },
      ur => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res); });
    up.on("error", () => { res.writeHead(502); res.end("{}"); });
    up.end(raw);
  });
}).listen(8890, "127.0.0.1");
```

Point a session at it (`ANTHROPIC_BASE_URL=http://127.0.0.1:8890`) and dispatch a subagent. You want
to see at least one `SUB` line. If every line says `main`, every signal a client of that kind can
send is gone and `routing.subagents` has silently stopped applying. Judge each client against the
signals it can actually carry: a Claude session should show `marker=true` and/or `header=true` and
never `codex`; a Codex session can only ever show `codex=true`, so for Codex that one IS the whole
set and there is nothing left to fall back on. A Claude `SUB` line reporting only one of
`marker`/`header` is still working, but it is now single-signal — worth knowing before the
remaining one goes too. (Note the capture proxy forwards `req.headers` verbatim; a real middleware
in that position may not.)

A quick behavioural check needs no proxy at all — the same body with and without the marker must
route differently:

```bash
SUB='…cc_is_subagent=true;'
# with marker: the directive is parsed, so a bogus pool is a loud 400
curl -s localhost:8791/v1/messages -H 'content-type: application/json' \
  -d "{\"model\":\"claude-opus-5\",\"max_tokens\":32,\"system\":\"$SUB\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"@relay: pool/nope\\nhi\"}]}]}"
# => llm-relay routing: no pool "nope" configured

# without marker: identical body, directive ignored, goes to the passthrough
```

The directive path is used here on purpose: it works with the client rule off, so this check tests the
marker rather than the rule. To exercise the rule itself, `llm-relay offload claude on` first and drop
the `@relay:` line — the same bogus-pool 400 then proves `routing.subagents` is being consulted.

(`/v1/messages` is a proxy path, not a control path, so these probes need no control-capability
header. A 403 rather than the expected 400 usually means a control request lacked the installed
capability, its `Host`/present `Origin` did not exactly match the listener, or its POST was not JSON.)
