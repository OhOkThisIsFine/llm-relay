# Host-adaptive dispatch

**Status:** shipped in **v0.20.0**, extended with `{contextWindow}` in **v0.21.0** (2026-08-07).
Design ratified by the owner in-session; verified end-to-end from a real Claude Desktop session
against the published build.

The context-window half was proved by A/B against the live ladder: the pinned
`openrouter/deepseek/deepseek-v4-flash-0731` lane renders
`CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576` and the child runs with no window warning, while the
`pool/high` lane renders no such variable and the child still reports that it "assumes 200k" for an
unrecognized model. Same template, same command shape — the only difference is whether a provider
published a number.

## The problem

`llm-relay dispatch` hands a host an ordered ladder of lanes. Two rung kinds:
`cli` (the host spawns a binary) and `relay` (the host addresses a spec through this
proxy, as a subagent). The `relay` kind assumes one thing that is not always true:

> the calling host's own HTTP traffic reaches this relay.

In a **Claude Desktop** session it does not. The Desktop launcher pins
`ANTHROPIC_BASE_URL=https://api.anthropic.com` into the process environment, overriding
both the User-scope variable and the `env` block of `~/.claude/settings.json` — verified
2026-08-07, and directly observable: of the three keys that block sets, `ENABLE_TOOL_SEARCH`
and `CLAUDE_CODE_SUBAGENT_MODEL` arrive in the process environment while `ANTHROPIC_BASE_URL`
reads `https://api.anthropic.com` rather than the configured loopback address. The launcher
manages that one key specifically.

So from Desktop, every mechanism that reroutes a *subagent* silently no-ops:

- `routing.subagents` never fires — the request never arrives.
- `llm-relay offload claude on` applies and persists, but changes nothing for that session.
- An `@relay: pool/high` directive line reaches the real Anthropic model as literal prompt
  text, because nothing is in the path to strip it.

Today `/dispatch` makes this worse rather than better: a `relay` rung is rendered with
`requiresDirective`, whose hint tells the host to add exactly the `@relay:` line that cannot
work there. The relay is advising a mechanism it knows is dead.

**The relay cannot detect this at request time.** There is no request — that is the whole
problem. Detection has to happen in the `llm-relay` CLI process, which is a child of the
Claude session and inherits its environment.

## The contract

`llm-relay dispatch -t "<task>"` is the **single universal verb** a conversational agent
uses. The agent never branches on which harness it is running under. llm-relay resolves
"what is appropriate here" and returns lanes the host can actually execute:

| Calling host | `relay` rung with a non-passthrough spec |
|---|---|
| terminal Claude Code (traffic reaches the relay) | stays a `relay` rung; `@relay:` hint as today |
| Claude Desktop (traffic bypasses the relay) | **transposed** into a `cli` invoke via `routing.cliLane` |
| not a Claude host at all | unchanged — nothing to adapt to |

Same command, same syntax, host-adapted output.

## Detection

`src/host-routing.ts`. Three states, evidence-labelled like everything else here.

The load-bearing signal is **not** the entrypoint name — it is the base URL, answering
"does my parent's traffic reach a loopback proxy at all?":

- `ANTHROPIC_BASE_URL` parses to a **loopback** host ⇒ `routed`. (A proxy chain in front is
  fine: headroom on `:8787` fronting the relay on `:8791` still reads as routed, and must.)
- Set to anything else, or unset, while `CLAUDECODE=1` ⇒ `bypassed`.
- `CLAUDECODE` unset ⇒ `unknown`. Not inside a Claude harness, so there is no subagent
  mechanism to adapt to, and a human reading the ladder wants to see the real specs.

`CLAUDE_CODE_ENTRYPOINT` is carried only to *name* the host in the message
(`claude-desktop`), never to decide. Basing the verdict on the entrypoint string would miss
a terminal session that dropped its env line, and would break the moment the name changes.

⚠ **The verdict is computed in the CLI process and forwarded to the running proxy**
(`GET /dispatch?host=…&entrypoint=…`). The relay process's own environment says nothing
about its caller — it was launched from `Startup` at logon, long before any session existed.
Reading `process.env` inside the server would answer a different question entirely.

## Transposition

`routing.cliLane` — a declared template, not an invented command. The relay must not learn
what a `claude` binary is; the operator states it once and the relay substitutes into it.

```json
"routing": {
  "cliLane": {
    "command": "claude",
    "args": ["-p", "--model", "{spec}", "--permission-mode", "plan", "{task}"],
    "env": {
      "ANTHROPIC_BASE_URL": "http://127.0.0.1:8791",
      "CLAUDECODE": null,
      "CLAUDE_CODE_ENTRYPOINT": null
    }
  }
}
```

`{spec}` is the new placeholder (`SPEC_TOKEN`), alongside the existing `{task}`. Validated at
config load: a template whose args contain no `{spec}` cannot address a target and is a hard error.

**Placeholders split by what they carry, not by convenience.** `{task}` is text a model or a user
wrote, so putting it in a spawned process's environment would let request content become process
configuration — it is substituted into args only, and config load *rejects* it in an env value
rather than passing the literal string through while the operator believes it worked. `{spec}` and
`{contextWindow}` are values this relay resolved from its own config and from published provider
metadata; they are configuration, and are substituted in both places.

### `{contextWindow}` — the number the relay already has

A CLI handed a model it does not recognize assumes a context window and compacts against it; the
`claude` CLI assumes 200k. A lane pointed at a 1M-context model therefore throws away most of it,
silently. The relay already harvests per-(provider, model) limits (`catalog.limitsFromRecord`) for
the request-path guardrail, so it can simply say what it knows.

Resolution has **two rungs, both real publications** (`contextWindowResolver`): the serving
deployment's own `contextLength`, then `context_length` from the synced snapshot for the same model
id, exact-matched. There is no guessed rung.

Rung 2 was added in 0.22.0 after measuring rung 1's coverage, and it is the difference between a
correct feature and a useless one:

| pool | provider-published | snapshot | neither |
|---|---|---|---|
| `pool/high` | 0 / 29 | 28 | 1 |
| `pool/xhigh` | 0 / 15 | 15 | 0 |
| `pool/medium` | 2 / 41 | 38 | 1 |
| `pool/low` | 4 / 49 | 44 | 1 |

⚠ **Fuzzy snapshot matches are rejected**, though `findTierModel` offers them. A borrowed SKU's
capability score mis-ranks a pool; a borrowed SKU's context window tells a client it may send tokens
the backend will reject. Different blast radius, stricter rule.

The rest of the resolution rule:

- pinned spec → that deployment's published `contextLength`;
- `pool/<name>` → every member must publish, and the **minimum** wins, because failover can land
  the request on any member. One unknown member means the floor is unknown, not that the known
  members' floor applies;
- unknown → the env entry is **dropped**, not set to an empty string (which a child would read as
  zero or garbage), and the client keeps its own conservative default.

**Why there is no speculative rung**, considered and rejected 2026-08-07 with the numbers above.
The proposal was to assume 1M when nothing is published and let errors correct it downward. Two
findings killed it:

- **The measured floors point the other way.** With the snapshot rung, resolved pool minimums here
  are 131,072 (`pool/low`) to 163,840 (`pool/medium`, `high`, `xhigh`) — *below* the 200k the
  `claude` CLI already assumes for an unrecognized model. A speculative 1M would overshoot the
  weakest member by six to eight times; the correct adjustment for these pools is **downward**, and
  the honest data already provides it.
- **The correction loop does not exist.** Limits are written in exactly one place — `limitsFromRecord`
  off a `/models` record. Nothing anywhere learns a limit from an error response, so a speculative
  value would not be corrected; it would just be wrong until someone noticed. Building that loop is
  a real piece of work (parse per-provider context-length errors, attribute them to a deployment,
  persist, invalidate) and it is not a prerequisite for this feature — the snapshot rung already
  covers ~97% of members.

One unresolvable model can still block a whole pool, since every member must resolve. Here that is
`huggingface/Qwen/Qwen3-235B-A22B-Instruct-2507`, which alone blocks `low`, `medium` and `high`.

The lookup is **injected** (`DispatchOptions.publishedContextWindow`), not imported: `dispatch.ts`
keeps no catalog dependency and stays synchronous. The server backs it with
`catalog.cachedLimits()` and the CLI with the same on-disk cache, so a cold-read answer matches a
live one — and because `cachedLimits` never fetches, an unwarmed cache degrades to "no window
stated" rather than turning a dispatch query into a blocking round-trip.

This also collapses real duplication. The owner's live config hand-writes the transposition
three times per tier across four tiers — twelve copies of the same ten-key env block —
precisely because it could not be expressed once.

### Which relay rungs get transposed

Not all of them. A rung whose spec resolves to the caller's **own vendor passthrough**
(`kind: "anthropic"` with no declared `authEnv`) is still perfectly reachable from Desktop:
it is a plain `Agent(...)` subagent on primary quota, which is exactly what that rung means.
It needs no directive and no shell-out.

So: transpose a `relay` rung iff its spec resolves to any target that is **not** the vendor
passthrough — those are the ones that need the subagent-reroute machinery, which is the thing
that is dead here.

A rung that needs transposing when no `routing.cliLane` is configured is marked `unreachable`
with the reason, and is never selected as `next`. Silently offering a lane that cannot work is
the failure being fixed; substituting a different one would be inventing intent.

### What must NOT happen

`requiresDirective` is never set on a bypassed host. It is true advice under a routed host and
false advice under a bypassed one, and a hint that cannot work is worse than no hint.

## The hook (second half)

Transposition fixes the path where the agent *asks* llm-relay. It does nothing when the agent
reaches for `Agent(...)` directly. A `PreToolUse` hook on `Agent` closes that.

**What a hook can and cannot do**, verified against the hooks reference 2026-08-07:

- `PreToolUse` supports `permissionDecision: allow|deny|ask|defer`, and `updatedInput`, which
  replaces the tool arguments before execution.
- `SubagentStart` is **context-only** — explicitly no blocking and no decision control. It
  cannot change a subagent's model or endpoint.
- Neither can redirect the subagent's HTTP request. The subagent is served by the same Claude
  Code process over the same connection, with the same pinned base URL. Rewriting the prompt
  to prepend `@relay:` sends the directive to Anthropic as prompt text; rewriting `model` picks
  a different Anthropic model.

So the hook is a **forcing function, not a redirect**: while the host is bypassed, it denies
the `Agent` call and returns the transposed `claude -p …` command line in
`permissionDecisionReason`. The agent then runs it. The deny is enforced; that the agent then
runs the command is not — this is a nudge with teeth, and should be described as one.

Installed **only behind an explicit flag**. llm-relay writing into `~/.claude/settings.json`
is a persistent change to the operator's harness, and the file already carries a user-authored
`^Agent$` hook that must be appended to, never replaced.

## Two bugs this shook out, worth remembering

**`--host` was missing from `VALUE_FLAGS`.** `llm-relay dispatch --host routed` parsed `routed` as
the positional *lane id*, so the command answered `no lane "routed" in the ladder` and every relay
rung silently kept its old rendering. Any value-taking flag omitted from that set fails this exact
way. Pinned by a test on the parser, not on dispatch.

**A second version-skew shape, found while adding `{contextWindow}`.** The original staleness check
compared only `host`. A proxy that understands `?host=` but predates context-window substitution
answers that check correctly and still returns lanes with the variable missing — and from the
rendered output that is indistinguishable from "the provider published nothing", so the failure
reads as a correct result. The discriminator is cheap and exact: both sides resolve the window from
the *same* on-disk cache, so if the CLI can resolve one for a transposed lane and the live answer
carries none, the difference is the proxy's code rather than the data.

**The hook cannot exec the installed launcher.** The first version spawned `process.argv[1]`. On
Windows an npm global install's `llm-relay` is a **`.cmd`**, and `execFileSync` refuses to run
`.cmd`/`.bat` without a shell (blocked since the CVE-2024-27980 fix); a bare `.js` path is not
executable either. Both failures land in the hook's own fail-open catch, so the hook looked
installed and allowed every call — a feature that silently does nothing, which is the same class of
defect as the Desktop no-op it was written to fix. It now spawns `process.execPath` with the CLI
script as its first argument, which also avoids a shell entirely.

## Invariants this must not break

- **The relay never spawns a process.** Transposition renders a command; the host runs it.
  Unchanged.
- **No hardcoded provider URLs, models or binaries in `src/`.** `routing.cliLane` is config.
  The relay never learns what `claude` is.
- **Order, never execution.** Transposition changes how a rung is *rendered*, never the
  ladder's order or the host's authority to pick.

## The migration, done (2026-08-07)

This machine's ladder was collapsed onto the template. Twelve hand-written `claude -p` CLI rungs —
`claude-deepseek-credits`, `claude-free-pool`, `claude-deepseek-late` across four tiers, each
carrying its own copy of the same ten-key env block — became twelve `relay` rungs plus one
`routing.cliLane`. **120 hand-maintained env entries → 10.** Backup:
`~/.llm-relay/config.json.pre-clilane-2026-08-07.bak`.

Only rungs matching the template *exactly* (command, arg shape, and env) were converted; the
`--model` argument became the rung's `spec`, so every rung reaches the same deployment it did
before. `codex-*` and `agy-*` rungs have their own command shapes and stay `cli`.

Verified before and after, across all four tiers and both host states:

- **Bypassed host: the rendered commands are byte-identical** — 24 `run:` lines, diff-clean. The
  only addition is a `via: routing.cliLane → <spec>` provenance line.
- **Routed host: behaviour improves.** Those three rungs now render as `target: pool/high` etc.
  instead of a shell-out, so a terminal session gets an in-process subagent rather than paying to
  spawn a whole `claude` CLI. This is the point of the migration, not a side effect.
- **End-to-end:** a transposed `pool/medium` lane was executed and answered, served by
  `nim/deepseek-ai/deepseek-v4-flash-0731` with failover through `huggingface/moonshotai/Kimi-K3`.
  Zero primary quota.

The rungs' notes were rewritten at the same time: they described themselves as hand-written CLI
lanes ("shelling out IS the redirect"), which is now the relay's decision per calling host, not a
property of the rung. A note should say what a rung is FOR; the mechanism is readable off the
rendered lane.

⚠ **What this trades:** twelve independent hardcoded copies for one shared point of failure. A
missing or broken `cliLane` now turns all twelve rungs `[unreachable]` from a bypassed host at
once, where before each was self-contained. That is the usual deduplication bargain and it is the
right side of it here — but it is why config load rejects a template without `{spec}` rather than
warning.

## Remaining

⚠ **The `Agent` hook installs on a TOGGLE, so an already-on rule does not have it.** This machine
had `offload claude on` set before v0.20.0; re-running `llm-relay offload claude on` is what
installs the hook. Owner's call — it changes how `Agent(...)` behaves in every Claude session on
this machine.
