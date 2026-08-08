# Host-adaptive dispatch

**Status:** implemented 2026-08-07, suite green (`npm run check`: 51 files, 764 tests). Design
ratified by the owner in-session. Not yet released — see "Remaining" at the end.

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
config load: a template whose args contain no `{spec}` cannot address a target and is a hard
error. As with `cli` rungs, **neither placeholder is ever substituted into env values** — env
is operator-authored routing, not task content.

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

## Remaining

Owner decisions, not pending code:

1. **Release.** The working tree already carried an unrelated in-flight sprint (eslint / knip /
   dependency-cruiser config plus edits across ~20 files) when this landed, overlapping
   `src/cli.ts`, `src/config.ts` and `src/dispatch.ts`. Committing this work would bundle that
   sprint into the release, so the commit/tag/publish flow was deliberately not run.
2. **`routing.cliLane` in the live config.** Adding it is currently a no-op for this machine: the
   live ladder's only `relay` rung is the Anthropic passthrough, which is never transposed. The
   value arrives when the three hand-written per-tier `claude` CLI rungs (`claude-free-pool`,
   `claude-deepseek-credits`, `claude-deepseek-late` — twelve copies of the same ten-key env block
   across four tiers) are collapsed back into `relay` rungs plus one template.
