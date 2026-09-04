---
name: llm-relay
description: >-
  Operate llm-relay, the loopback multi-provider LLM proxy (default 127.0.0.1:8791) that
  validates/repairs tool calls and offloads Claude, Codex and other client requests to
  non-Anthropic providers on free capacity. Use it BEFORE spending this session's context or
  subscription quota on delegatable work — a broad code search, a file-by-file sweep, a survey,
  a bulk edit, a long summary, a second opinion, or any self-contained task whose result is a
  conclusion you can check. Nobody has to ask for offload first. Also use when choosing an
  offload target, addressing a pool or model through the relay, toggling client-specific
  offload, dispatching to peer agent CLIs (Antigravity/Codex) as fallback lanes, reordering
  dispatch, or diagnosing a request that failed at or behind the relay. When MCP tools are
  present, use `dispatch` on every host. In Codex Desktop, never try to reach a relay pool by
  spawning a `pool/*` collaboration child; Desktop rejects it before the relay is contacted.
---

# llm-relay — operating guide

llm-relay is a **loopback-only** bidirectional proxy for Anthropic `/v1/messages` and OpenAI
`/v1/chat/completions` / `/v1/responses`. It routes each request to a configured provider
(Anthropic passthrough, NIM, OpenRouter, Gemini, Groq, Mistral, …), translating protocols where
needed, and **validates + repairs malformed tool calls** on the Anthropic-shaped response seam
so agent harnesses can run on models that are weaker at tool use. Config, keys and caches live in
`~/.llm-relay/` (`config.json`, `.env`, `models-cache.json`, …).

One boundary governs everything it does: the proxy fixes **protocol form** (tool-call args that
violate the schema), never **judgment**. It refuses to fabricate destructive tool calls, and an
unrepairable response fails loudly (502 / mid-stream SSE error) rather than passing through broken.

## Reach for a lane without being asked

**The operator should never have to say "use llm-relay for offload".** If they did, this section
failed. Offload is a reflex you apply yourself, not an instruction you wait for. ⚠ Prose alone has
already failed at this once: a machine whose global instructions said *"PREFER THE MCP TOOL"* in
bold still needed the words spoken out loud (2026-08-30). That is why the trigger now lives in the
skill description and in the MCP `initialize` instructions, which a host loads whether or not the
model goes looking.

**Offload a task when both of these hold:**

1. It is self-contained. A prompt plus a path is enough, and it needs nothing from this
   conversation that you cannot write into the prompt.
2. Its result is a conclusion you can check afterwards against the source.

Typical: a broad code search, a file-by-file sweep, an inventory, a survey of prior art, a long
summary, a draft, a second opinion on a diagnosis, a bulk mechanical edit.

**Keep the work here instead when** it needs your own conversation context, when you must
supervise each edit, when it is one file and two minutes, or when the answer decides something
you cannot reverse.

**How to offload, in order of preference:**

1. `dispatch(task: "...")` — the MCP tool. One call returns an ANSWER. Prefer it whenever the
   tools are present, because building and running a lane command correctly is the part that keeps
   going wrong; the server handles the working directory, the environment and the idle timeouts.
   This rule is the same in Claude, Codex, desktop apps, CLIs and other MCP hosts.
   ⚠ Pass `mode: "answer"` for a question, draft, summary, or second opinion that needs no file
   access — it skips spawning a harness and posts straight to the relay, so it answers in seconds
   rather than tens of seconds. Keep the default agent mode when the lane must read or edit files
   or run commands. See [references/dispatch-lanes.md](references/dispatch-lanes.md).
2. `llm-relay dispatch --next-command -t "<task>"` — when the MCP tools are absent. Exit 0 prints
   one runnable command line. Exit 2 means the rung is a relay target, so address the named spec
   as an ordinary subagent.

**Do not choose a mechanism by recognizing the host yourself.** Ask the MCP server when it exists;
otherwise ask the CLI. In particular, Codex Desktop collaboration is not a relay path: with a
ChatGPT account it validates a `pool/*` child against the parent account, ignores the child's
`model_provider`, and fails before contacting llm-relay. Use MCP `dispatch` there.

⚠ Free capacity is spent before any metered or subscription lane, so an offloaded task normally
costs no subscription quota.

⚠ **Lane output is advisory.** Verify every claim against the source before you act on it. For a
lane that WRITES, inspect the tree yourself (`git status --porcelain`, `git diff`,
`git show --stat HEAD`) rather than trusting the lane's own report, and give every writing lane its
own worktree.

## Use from a Workflow or the Agent tool

Claude Code workflows and subagents can delegate tasks to llm-relay lanes via the custom `relay` agent type:

- In a Workflow script: `agent(task, {agentType: "relay"})`
- On the Agent tool: `subagent_type: relay`
- The `[answer]`/`[agent]` tag: a task that begins with `[answer]` or `[agent]` forces answer mode (`mode: "answer"`) when the task needs no file reads, edits, commands or working directory, and the tag is stripped before dispatch.
- Installation: `llm-relay setup claude-desktop` or `llm-relay setup claude-cli` installs the definition at `~/.claude/agents/relay.md`.
- The relay agent never answers a task itself, even a trivial one — it always dispatches and ends its reply with a `provenance: lane=<id> spec=<spec> elapsed=<seconds>` line, so a reply with no provenance line means no lane ran.

## First use on a machine — ASK, do not assume

A fresh install writes a config that **changes nothing**: every Claude model id reaches real
Anthropic, and the free pools exist but nothing is routed to them. That is the safe default and it
is almost certainly not why the operator installed a traffic router — so the relay leaves a marker
saying the question has never been put, and **you** are the one who asks.

`llm-relay routing show` and `llm-relay offload status` print a first-run notice **on stderr** while
that marker exists. When you see it:

1. Ask the operator what they want. Offer concrete options, not a lecture:
   - **Subagents only** (recommended start) — `llm-relay offload claude on`. Marked child requests
     go to the free pools; the operator's own turns stay on Anthropic. Nothing else changes.
   - **Subagents plus the whole conversation** — `llm-relay offload claude on --scope all`. Spends
     no Anthropic quota, and every turn now runs on a weaker model. Say that plainly.
   - **Free lanes only, never spend money** — add `"freeOnly": true` to the rule. It refuses with a
     clean 503 rather than falling through to paid.
   - **Nothing yet** — a real answer. Leave the routing alone.
2. Apply the answer with the ordinary verbs. Do not hand-edit `config.json`.
3. Run `llm-relay routing answered` to retire the notice — including when the answer was "nothing
   yet". Forcing a config edit just to silence a prompt is how a default gets changed for the
   wrong reason.

⚠ Ask ONCE per machine. The marker is the memory; do not re-open the question because a later
session did not see the notice.

## Quick operating commands

```bash
llm-relay dispatch --next-command -t "<task>"  # only when MCP is unavailable
llm-relay dispatch                              # inspect the ladder
llm-relay candidates                            # compare destinations
llm-relay keys                                  # validate every credential slot
llm-relay pools --probe                         # test every configured deployment
llm-relay offload status                        # inspect direct-routing rules
```

When MCP `dispatch` outlives its initial wait, use `dispatch_status`, then
`dispatch_result`; use `dispatch_cancel` only when the task should stop. Do not relaunch a
still-running job.

## Load only the reference needed

Do not read every reference by default.

- For model addressing, credential fleets, direct HTTP offload rules, or verified non-Desktop
  custom-provider children, read [references/direct-routing.md](references/direct-routing.md).
- For lane selection, peer CLI behavior, MCP/CLI dispatch details, timeouts, or ladder ordering,
  read [references/dispatch-lanes.md](references/dispatch-lanes.md).
- For health commands, control authorization, failures, pool-walk headers, eligibility
  interpretation, or safety invariants, read [references/operations.md](references/operations.md).

The CLI's `help`, `dispatch_lanes`, and live status commands are authoritative for current
configuration and quota. Do not copy a dated lane roster from prose.
