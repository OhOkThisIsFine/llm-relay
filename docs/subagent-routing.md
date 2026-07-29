# Subagent-aware routing

How llm-relay sends Claude Code **subagents** to non-Anthropic providers while the human's own
conversation keeps reaching real Anthropic — with no agent files and no model ids in prompts.

Shipped in **0.3.0**; **off by default since 0.4.0**. Config: `routing.subagents` gated by
`routing.offload`. Code: `isSubagentRequest()`, `readRelayDirective()`, `subagentSpec()` in
[`src/config.ts`](../src/config.ts), applied in `handle()` in [`src/server.ts`](../src/server.ts).

> **Offload is opt-in.** With `routing.offload` false (the default) a subagent routes exactly like
> the human's own conversation. Turn it on with `llm-relay offload on`; pick a destination with
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

## The signal: `cc_is_subagent=true`

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

⚠ **This is a client behaviour, not a documented API guarantee.** Re-verify after a Claude Code
upgrade (see [Re-verifying](#re-verifying)). If the marker ever disappears, every subagent falls back
to normal routing — which is *safe* (passthrough) but **silent**, so nothing will alert you.

## Design

For a request carrying the marker, the destination resolves in this order:

1. **`@relay: <spec>`** on its own line in the dispatcher's prompt. `<spec>` is any normal spec —
   `pool/<name>` or `<provider>/<model>`. The line is **stripped before forwarding**, so the model
   never sees it. Works whether or not the switch is on: it is the per-call opt-in.
2. **`routing.subagents[<tier>]`** — tier substring-matched from the inbound Claude model id.
   *Requires `routing.offload`.*
3. **`routing.subagents.default`**. *Requires `routing.offload`.*
4. Otherwise unchanged — normal tier/default routing.

Requests **without** the marker never consult any of this. That is the invariant the whole feature
rests on.

```jsonc
"routing": {
  "offload":   false,   // master switch — subagents behave normally until this is on
  "tiers":     { "opus": "anthropic", "sonnet": "anthropic", "haiku": "anthropic", "fable": "anthropic" },
  "subagents": { "opus": "pool/reasoning", "sonnet": "pool/coding", "haiku": "pool/fast", "default": "pool/coding" },
  "pools":     { "coding": ["nim/z-ai/glm-5.2", "nim/deepseek-ai/deepseek-v4-pro"] }
}
```

## The switch

`routing.offload` defaults to **false**, and an absent key is false — a config written before 0.4.0
does not start offloading on upgrade.

Offloading every subagent the moment a `subagents` map exists was the 0.3.x behaviour, and it is the
wrong default: it silently changes *who is answering* for every built-in agent (Explore,
general-purpose, every one-off dispatch), with no per-call signal that it happened. Which model
answers your reconnaissance is a decision worth making on purpose, so it is now a decision.

```bash
llm-relay offload status
```

`on` / `off` reach the running proxy over loopback (`POST /offload`), so the change applies to the
**next request with no restart**, and are persisted back to `config.json` so they survive one. With
no proxy listening the CLI writes the file and says so. `GET /offload` reports state without
changing it.

## Choosing a destination

`llm-relay candidates` (or `GET /candidates`) is the decision table — every offload target with its
dimensions **side by side and un-blended**:

| Group | Columns |
|---|---|
| Capability | SWE-bench, HumanEval, LiveCodeBench, Arena Elo, BFCL (tool-use), context window |
| Live behaviour | verdict, avg / p95 latency, jitter, uptime %, last ping code |
| Availability now | provider quota %, circuit-breaker open/closed + cooldown, listed in live catalog |
| Observed traffic | calls, successes, average latency through this proxy |

Nothing is ranked or averaged and the order is config order. Capability, latency and remaining quota
trade off differently per task — "cheapest thing that can do it" and "best available" are different
questions, and one blended number answers neither. The two composites that already exist in the
product (`benchmarkSort`'s quality score, the breaker's stability score) appear under `sortInputs`,
labelled as what they drive rather than as a recommendation.

The CLI prefers a running proxy so it can use warm ping history and real breaker state; run it cold
and the live-behaviour columns are empty because nothing has been measured yet.

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
      if (req.url?.startsWith("/v1/messages")) {
        console.log(sys.includes("cc_is_subagent=true") ? "SUB" : "main", p.model);
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
to see at least one `SUB` line. If every line says `main`, the marker is gone and `routing.subagents`
has silently stopped applying.

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

The directive path is used here on purpose: it works with the switch off, so this check tests the
marker rather than the switch. To exercise the switch itself, `llm-relay offload on` first and drop
the `@relay:` line — the same bogus-pool 400 then proves `routing.subagents` is being consulted.
