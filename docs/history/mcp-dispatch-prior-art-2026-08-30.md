# MCP servers for agent dispatch — prior art, 2026-08-30

Research for the backlog item *"Build an MCP server so agy can DELEGATE"*
([backlog.md](../backlog.md)), which reversed the verdict in
[skill-dispatch-mcp-verification-2026-08-30.md](skill-dispatch-mcp-verification-2026-08-30.md) §4.

**Question put by the owner:** what MCP servers exist that we could mimic or use, to dispatch
agents to other endpoints, including inside Claude workflows?

**Scope:** the decision is machine-wide. It touches `~/.claude`, `~/.codex` and the agy host
configuration. The implementation would live in this repository.

**Method:** the owner named <https://getlulu.dev/mcps>. That directory was searched first. Six
further searches covered delegation servers, multi-model servers, protocol bridges, gateways and
the MCP specification itself. Every server below was read from its own documentation.

⚠ **Advisory limits.** Every fact here comes from vendor documentation or a repository README.
None of it is measured on this machine. Treat every capability claim as unverified until a probe
confirms it. Two facts are flagged as NEGATIVE findings, because they contradict what the marketing
prose implies.

---

## 1. The named directory returned nothing relevant

Lulu MCPs aggregates more than 70,000 servers from four registries. Its featured list holds
FlightPowers, ZOOQ, MarkItDown, Knowledge Graph Memory, Demo (Everything), Scrapling, RepoMix,
Mastra Docs, Serena and Figma Context.

**None of the ten performs agent delegation, sub-agent dispatch, or a route to another LLM
endpoint.** The directory sells sponsored listings. It ranks by commercial interest, not by
capability. Do not use it as a survey instrument.

The relevant prior art sits on GitHub and in the MCP specification repositories. Sections 2 to 4
cover it.

---

## 2. Five families of prior art

### 2.1 Family A — spawn a CLI agent (the closest match to our need)

These servers accept a task, spawn an agent CLI as a child process, and return its answer.

| Server | Language | Tools | What it spawns |
|---|---|---|---|
| [ginkida/agent-dispatch](https://github.com/ginkida/agent-dispatch) | Python ≥3.10 | ~20 | `claude -p`, one per registered project directory |
| [dvcrn/mcp-server-subagent](https://github.com/dvcrn/mcp-server-subagent) | TypeScript | 8 | `claude`, Amazon `q`, Aider |
| [steipete/claude-code-mcp](https://github.com/steipete/claude-code-mcp) | TypeScript | 1 | `claude` CLI, one shot |

**`agent-dispatch` is the most complete design of the three.** Read its tool list before you design
ours. It answers two of our four open constraints directly.

Its tool surface:

- Registry: `list_agents`, `inspect_agent`, `add_agent`, `update_agent`, `remove_agent`.
- One shot: `dispatch(agent, task, context?, caller?, goal?, response_format?, return_ref?,
  timeout_seconds?, group?)`.
- Multi-turn: `dispatch_session(agent, task, session_id?, …)`.
- Concurrent: `dispatch_parallel(dispatches, aggregate?)`.
- Live progress: `dispatch_stream(agent, task, …)`.
- Asynchronous: `dispatch_async`, `dispatch_status(job_id)`, `dispatch_wait(job_id)`,
  `dispatch_cancel(job_id)`, `dispatch_jobs(status?)`, `dispatch_gc(max_age_days?)`.
- Large results: `fetch_result(ref, max_chars?)`.
- Groups: `list_groups`, `inspect_group`.

Its guards, each of which we need an equivalent for:

- `AGENT_DISPATCH_DEPTH` bounds recursion. The default limit is 3.
- Per-agent `permission_mode`, `allowed_tools`, `disallowed_tools`.
- Per-agent `max_budget_usd` and `timeout`.
- Global `max_concurrency`, cache settings and `job_retention_days`.
- The configuration file reloads on every tool call. No restart adds an agent.

**`claude-code-mcp` shows the failure mode to avoid.** It runs `claude` with
`--dangerously-skip-permissions` **by default**, "for backwards compatibility". Its own
documentation states: *"This wrapper is not an OS-level sandbox."* A single `claude_code(prompt,
workFolder)` tool with a bypass default is exactly the side door the backlog warns about. Do not
copy it.

### 2.2 Family B — orchestrate several models from one server

[BeehiveInnovations/pal-mcp-server](https://github.com/BeehiveInnovations/pal-mcp-server) — formerly
`zen-mcp-server`, now renamed to PAL, a Provider Abstraction Layer. It is the best known server in
this space. Python 3.10+, installed with `uv`.

It exposes about 17 tools. Most are task-shaped, not transport-shaped: `chat`, `thinkdeep`,
`planner`, `consensus`, `debug`, `precommit`, `codereview`, `analyze`, `refactor`, `testgen`,
`secaudit`, `docgen`, `tracer`, `apilookup`, `challenge`, `listmodels`.

It reaches providers two ways, and the split matters to us:

1. **HTTP APIs** for Gemini, OpenAI, Azure OpenAI, X.AI, OpenRouter, DIAL and Ollama. This half
   duplicates what llm-relay already does, and does it with less provenance.
2. **`clink`** — "CLI + Link" — spawns an external agent CLI as a child process. This half is the
   direct analogue of our `cli` lane.

`clink(prompt, cli_name?, role?, files?, images?, continuation_id?)`. Presets live in
`conf/cli_clients/`:

- `gemini.json` → `gemini --telemetry false --yolo -o json`
- `claude.json` → `claude --print --output-format json --permission-mode acceptEdits --model sonnet`
- `codex.json` → `codex exec --json --dangerously-bypass-approvals-and-sandbox`

Two observations:

- The `claude.json` preset uses `--permission-mode acceptEdits`. That agrees with the warning in
  our own `CLAUDE.md` against `plan` mode in a lane template. It is independent support for a
  choice we already made.
- The `codex.json` preset bypasses approvals and the sandbox. That is the same permission problem
  as `claude-code-mcp`.
- The documentation states no timeout policy and no working-directory policy. Both are gaps.

**Judgment: mimic `clink`'s shape, not PAL's scope.** PAL's 17 task-shaped tools are the opposite
of our stated goal. We want one verb, host-adapted. PAL wants a tool per activity.

### 2.3 Family C — run the agent loop inside the server

[hessenpepper/mcp-delegate](https://glama.ai/mcp/servers/hessenpepper/mcp-delegate). Python, `uv`.
Four tools: `delegate_task`, `delegate_agentic_task`, `list_recent_delegations`,
`get_delegation_transcript`.

It spawns no CLI. It runs an in-process loop against an OpenAI-compatible endpoint — Ollama, LM
Studio, vLLM or OpenRouter. It gives the delegated model three tools: `read_file`, `write_file`,
`run_bash`. It bounds the loop with `max_iterations` (default 20) and `timeout_seconds`
(default 600). It logs each delegation to SQLite with token counts and cost.

`delegate_agentic_task` takes an explicit `working_dir` argument. Its own documentation admits the
containment is partial: file operations stay inside `working_dir`, but "bash commands technically
could escape".

**Judgment: reject this family for us.** It re-implements an agent loop, which our
"no second implementation of anything" invariant forbids. It also proves the caller-supplied
`working_dir` hazard is real, not hypothetical.

### 2.4 Family D — bridge to another agent protocol

[yw0nam/mcp_a2a_gateway](https://github.com/yw0nam/mcp_a2a_gateway) translates MCP to Agent2Agent
(A2A). Tools: `register_agent(url)`, `list_agents`, `unregister_agent`, `send_message`,
`get_task_result(task_id)`, `get_task_list`. Transports: stdio, streamable-HTTP, SSE.

A2A itself matters as context. Google donated it to the Linux Foundation on 2025-06-23. It reached
v1.0 in April 2026, with more than 150 organizations. It uses JSON-RPC, HTTP(S), SSE and OAuth 2.0.
Discovery reads an AgentCard at `/.well-known/agent-card.json`.

**The one-line distinction to keep:** MCP connects an agent to tools. A2A connects an agent to
another agent. Our need is the second one, delivered over the first transport, because MCP is what
our hosts speak.

**Judgment: do not adopt A2A.** Our four lanes are local processes, not networked peers with
AgentCards. But copy the gateway's task pattern — `send_message` returns a task id, and
`get_task_result` collects it later. Family A reaches the same answer independently.

### 2.5 Family E — Claude Code already is an MCP server

`claude mcp serve` runs Claude Code as a stdio MCP server. It exposes Bash, Read, Write, Edit, LS,
Grep, Glob and Replace to any MCP client.

⚠ **Two limits make it unsuitable as our dispatch mechanism.**

1. It exposes Claude Code's own **tools**, not a task-shaped delegation verb. An agy session would
   have to drive an edit loop itself, tool call by tool call. agy would become the orchestrator, not
   the delegator.
2. MCP servers that Claude Code itself has configured are **not** re-exposed
   ([anthropics/claude-code#631](https://github.com/anthropics/claude-code/issues/631)).

It remains worth knowing. It is a zero-build fallback if our own server slips.

### 2.6 Family F — gateways, for completeness

[MetaMCP](https://github.com/metatool-ai/metamcp), [microsoft/mcp-gateway](https://github.com/microsoft/mcp-gateway),
Docker MCP Gateway, AgentGateway, `mcp-proxy`, Lunar MCPX, and
[LiteLLM](https://github.com/BerriAI/litellm)'s MCP Gateway.

These aggregate many MCP servers behind one endpoint. They add namespaces, authorization and
inspection. LiteLLM is the closest to us in spirit: it is an LLM gateway that also acts as an MCP
client and an MCP server at the same time.

**Judgment: not applicable.** We have one server to expose, not a fleet to multiplex. A list of
these lives at [e2b-dev/awesome-mcp-gateways](https://github.com/e2b-dev/awesome-mcp-gateways) if
the need ever appears.

---

## 3. Protocol facts that move our four constraints

### 3.1 The Tasks extension exists — and no client supports it yet

The 2026-07-28 MCP specification moved long-running operations **out of the core protocol and into
an extension**. AWS contributed it. It is specified at
[modelcontextprotocol/ext-tasks](https://github.com/modelcontextprotocol/ext-tasks).

How it works:

1. The client declares `io.modelcontextprotocol/tasks` in the per-request capabilities, inside
   `_meta`.
2. The server advertises the same extension in its `server/discover` capabilities.
3. The server answers a long request with a `CreateTaskResult`, marked `resultType: "task"`. It
   carries `taskId`, a status, `ttlMs` and `pollIntervalMs`.
4. The client polls `tasks/get`.
5. The client answers a mid-flight request with `tasks/update`.
6. The client may send `tasks/cancel`. Cancellation is cooperative.

Statuses: `working`, `input_required`, `completed`, `failed`, `cancelled`. The last three are
terminal.

⚠ **NEGATIVE FINDING. The official client matrix does not list Tasks at all.** The matrix at
<https://modelcontextprotocol.io/extensions/client-matrix> tracks three extensions only: MCP Apps,
OAuth Client Credentials, and Enterprise-Managed Authorization. Claude Code's own MCP documentation
does not list Tasks either. The specification is explicit that a server must never return a task to
a client that did not declare support.

**Consequence: we cannot build on Tasks today.** Design the wire shape so that Tasks can be adopted
later without a change to the tool names. Do not depend on it.

### 3.2 Application-level polling is what every shipped server actually uses

`agent-dispatch`, `mcp-server-subagent` and `mcp_a2a_gateway` all reached the same answer
independently, and none of them uses the Tasks extension:

- One tool starts the work and returns an id.
- One tool reports status by id.
- One tool returns the result by id.
- One tool cancels by id.

This is the "call now, fetch later" pattern. It works on every MCP client today, because it is
ordinary tool calls. **This closes constraint 4 — the 30-minute lane now has a representation.**

⚠ One caution from `mcp-server-subagent`: its documentation tells the caller to `sleep 30` between
status checks. A model that polls in a tight loop burns context. Return a `pollIntervalMs`-style
hint in the status result, and state the wait in the tool description.

### 3.3 What Claude Code supports as an MCP client

From Claude Code's own MCP documentation:

| Feature | Supported | Note |
|---|---|---|
| Tools | Yes | Includes `anthropic/maxResultSizeChars` and `anthropic/requiresUserInteraction` |
| Resources | Yes | |
| Prompts | Yes | |
| `list_changed` | Yes | Updates without a reconnection |
| Elicitation | Yes | Form mode and URL mode; CLI only, not the Desktop app |
| Channels | Yes | `claude/channel`; pushes messages into a session on an external event |
| Sampling | Not documented | |
| Tasks extension | Not documented | |

Transports: stdio, HTTP, SSE (deprecated), WebSocket. Scopes: local, project, user.

Two of these are directly useful:

- **`anthropic/requiresUserInteraction`** forces an approval prompt for a named tool. That is a
  partial answer to the permission-gate objection. It restores an operator decision at the spawn
  point.
- **`claude/channel`** pushes a message into a session on an external event. A finished lane could
  announce itself instead of being polled for.

⚠ Claude Code cannot register channel servers on protocol revision 2026-07-28. Verify the revision
before you depend on channels.

### 3.4 Sampling is the inverse mechanism, and it does not help us

MCP sampling lets a **server** ask the **client** for an LLM completion, through
`sampling/createMessage`. The client keeps control of model choice, cost and privacy.

It is the exact inverse of what we want. We want a server that reaches other endpoints. Sampling
would make our server borrow the caller's model. Claude Code does not document support for it
either. Record it and move on.

### 3.5 MCP tools reach inside Claude workflows already

The owner asked about Claude workflows specifically. No new mechanism is needed. A Workflow script's
agents reach every session-connected MCP tool through `ToolSearch`, and subagents reach MCP tools
the same way. An `llm-relay` MCP tool would therefore be callable from:

1. The main Claude Code session.
2. A subagent spawned with the Agent tool.
3. An agent inside a `Workflow` script.
4. An agy session — the case that reversed the verdict.
5. A Codex session, through `codex mcp` client configuration.

---

## 4. How the prior art answers our four open constraints

The backlog records four constraints as unsolved. Three now have an answer from prior art.

| Constraint (from the backlog) | Status after this research |
|---|---|
| **1. A fresh install ships no `routing.ladder` and no `cliLane`, so `dispatch()` is inert for a stranger.** | **The fact stands. Its weight as an objection is gone.** Owner decision D2 (2026-08-30) states that the default template will not ship a ladder, that dispatch is deliberately a per-machine feature, and — in as many words — *"stop measuring dispatch work against rubric test 1"*. ⚠ The backlog entry still lists this as "still true and still binding". Both are right about different things, and the wording invites confusion. See §6, question 1. |
| **2. A tool that RETURNS a command duplicates `/dispatch`.** | **Unsolved, and still correct.** No prior-art server returns a command. Every one of them executes. This constraint argues for the executing design, not against MCP. |
| **3. A tool that EXECUTES needs a caller-supplied `cwd`.** | **SOLVED by `agent-dispatch`.** The caller names a **registered agent**, never a path. The path lives in `~/.config/agent-dispatch/agents.yaml` under the operator's own hand. Request content never becomes process configuration. That is the same rule `src/dispatch.ts` already applies to the `{task}` placeholder. |
| **4. A 30-minute lane has no representation.** | **SOLVED by the async job pattern (§3.2).** Start, poll, fetch, cancel — four ordinary tools, no extension needed. `agent-dispatch` ships exactly this. The MCP Tasks extension is the eventual standard form, but no client supports it yet. |

The fifth objection, which the backlog states separately, is unchanged:

- **It removes the spawn from the harness permission gate.** Prior art confirms the danger.
  `claude-code-mcp` bypasses permissions by default. PAL's `codex` preset bypasses approvals and the
  sandbox. Prior art also supplies the mitigation: per-agent `permission_mode`, `allowed_tools`,
  `disallowed_tools`, `max_budget_usd`, a recursion depth limit, plus the
  `anthropic/requiresUserInteraction` annotation from §3.3.

---

## 5. Recommendation

**Build a narrow server. Mimic `agent-dispatch`'s shape. Reject PAL's scope.**

Concretely, mimic these five things:

1. **A named-agent registry, not a path argument.** The caller says `agy` or `claude-free-pool`. The
   operator's config says where that runs. This closes constraint 3.
2. **The async job quartet.** Start, status, result, cancel. This closes constraint 4 today, on
   every client.
3. **A recursion depth counter in the environment.** agy calls the server, which spawns `claude`,
   which could call the server again. `AGENT_DISPATCH_DEPTH` bounds this at 3.
4. **Per-lane permission and budget bounds, declared in config.** Never a caller argument.
5. **A result reference for large output.** `agent-dispatch` returns a `ref` and a summary, then
   serves the full text through `fetch_result`. That protects the caller's context window.

Reject these three:

1. **A tool per activity.** PAL's 17 task-shaped tools contradict our "one verb, host-adapted"
   requirement.
2. **An in-process agent loop.** `mcp-delegate` re-implements what our lanes already do.
3. **A permission bypass default.** Both `claude-code-mcp` and PAL's `codex` preset ship one.

Two things we would have that no prior-art server has, and which are the reason to build rather
than adopt:

- **Provenance.** Every server surveyed returns another agent's text as its own result. Our
  `src/dispatch.ts` already refuses to pretend a CLI answered.
- **Quota state.** None of them knows a lane is rate-limited. We have `dispatch-exhaustion.json`,
  the re-probe cadence and the retraction rule.

**Could we simply use `agent-dispatch` instead of building?** It would work for the agy case. Three
things stop it being a clean answer: it spawns `claude -p` only, so it cannot reach the agy lane or
the relay pools; it is Python and `uv`, a new runtime on this machine; and it holds its own agent
registry, which would become a second source of truth beside `routing.ladder`. Consider it as a
short measurement exercise, not as the destination.

---

## 6. Owner decisions, 2026-08-30

Three questions were put to the owner. All three are answered. Two answers correct the record.

### 6.1 D2 governs — rubric test 1 does not apply to dispatch work

**Decision.** A ladder-free install is a stated design choice. The MCP tool may ship inert for a
stranger, exactly as `llm-relay dispatch` already does.

**Action.** Remove the "inert for a stranger" objection from the backlog entry. It is a true fact
with no weight as an objection. Do not carry it into the design.

### 6.2 Per-lane config bounds — and the "no shell" premise is REJECTED

**Decision.** Bound the lanes with per-lane config: permission mode, allowed tools, budget cap and
recursion depth. Declare all four in operator config. Never accept one as a caller argument.

⚠ **The owner rejects the premise the question was built on.** The owner's words: the claim that agy
has certain limitations was *"a ridiculous error where some agent ordained that AGY had certain
limitations, that it did not have, that I didn't want."*

**Measured, by reading the three files directly on 2026-08-30:**

| File | Allow list |
|---|---|
| `settings.json.bak-2026-08-11` | `read_file`, `list_directory`, `glob`, `search_file_content`, **`command(*)`** |
| `settings.json.bak-2026-08-27-pre-vocab-fix` | `read_file`, `list_directory`, `glob`, `search_file_content` |
| `settings.json` (live) | `read_file`, `write_file`, `read_url`, `mcp` |

The history: an agent removed `command(*)` on 2026-08-11. A second edit on 2026-08-27 replaced three
invalid entries — `list_directory`, `glob` and `search_file_content` are Gemini CLI names that agy
rejects — with `write_file`, `read_url` and `mcp`. That edit did **not** restore `command(*)`.

The global `CLAUDE.md` describes the revocation as *"the accepted cost of making the offload lanes
read-only"*. **Nothing in the file history supports that the owner accepted it.** Treat the
description as an agent's assertion, not as a recorded owner decision.

**Consequence for this design.** The backlog required the build to bound agy's new power, because
"an MCP server hands a host that cannot run `ls` the power to spawn a writing agent". That reasoning
rests on the revoked shell. If the shell returns, the reasoning weakens, and the bound becomes the
ordinary per-lane bound of §6.2 rather than a special case. Restore `command(*)` only on an explicit
owner instruction.

### 6.3 Transport — DEFERRED to build time

**The owner declined to choose, and stated why:** *"the project's invariants and standing decisions
etc. are clearly not reliable. They keep turning up nonsensical."*

That is not a blocker for this research. Record two facts and defer:

1. The cited objection is weaker than it reads. §4.1 of the verification document judged MCP over
   HTTP a violation on the `/ping` precedent. But the owner already amended the same invariant on
   2026-08-29 to permit the background lane cadence to spawn lanes. An invariant with a stated
   exception is not a categorical bar.
2. stdio is the cheaper default. It needs no admission boundary, no control token, and no Host or
   Origin check. Every prior-art server in §2 defaults to stdio.

**Pick the transport when the design is written, not before.** State the reason in one sentence at
that point.

### 6.4 Standing note on record reliability

The owner's distrust is supported by this document's own findings. Three separate defects appeared
in accumulated prose during this research alone:

1. Three of agy's four permission entries were invalid names for months (already recorded).
2. The `command(*)` revocation is described as an accepted cost with no evidence of acceptance
   (§6.2).
3. The backlog and `CLAUDE.md` state opposite conclusions about rubric test 1 (§6.1).

**Rule to apply from here:** verify a claim against the file, the config, or a live probe before it
enters a design. Prose in `CLAUDE.md`, `HANDOFF.md`, the backlog and memory is a pointer to
evidence, never the evidence.

---

## 7. Friction log — the build lap, 2026-08-30

Rewalked from the transcript, not recalled. Each entry says what it cost.

**Environment and tooling**

1. **The global `shell-conventions-guard` hook blocks heredocs for file content.** Correct on
   Windows, and it applied to every multi-line source edit in this lap. The workaround is to Write
   a `.py` script to the scratchpad and then run it — about eight times here. Cost: two tool calls
   per edit instead of one. Worth keeping; worth knowing before you start.
2. **`cd <dir> && node <generator>` is refused as an `&&`-chained generator.** The guard reads the
   whole command line, so the innocent `cd` prefix trips it. Fix: give `node` an absolute path and
   drop the `cd`. Not obvious from the message, which talks about generators rather than about the
   `cd`.
3. **Python's Windows console encoding (cp1252) cannot print `⚠`.** A script that WROTE the file
   correctly still exited 1 on its confirmation `print`, which reads as a failed edit. Verify the
   file, not the exit code, when a script's only failure is in its output.
4. **A stray placeholder command dropped into the Python REPL and burned a 2-minute timeout.**
   Self-inflicted. `python - <<X` with no body opens an interactive interpreter that cannot read
   stdin and loops on `WinError 6`.

**The measured trap this repository already documents, hit anyway**

5. **The eslint hook's baseline is line-number sensitive**, exactly as `CLAUDE.md` warns. Adding one
   `if` to `main()` reported *"Cognitive Complexity from 49"* as a NEW finding. `main()` is already
   **48 at HEAD**, and the repo has explicitly declined to restructure `cli.ts` for it. Disproving
   this cost a stash, a full eslint run and a restore. ⚠ The right response was not to suppress it:
   moving the branch into `dispatchDashboardOrProxy` kept `main()` at its baseline AND landed the
   code in its correct semantic home, where it also closes a real fall-through to `runProxy()`.

**Measurement cost**

6. **Three separate stash-and-rebuild cycles** were needed to decompose the package-size growth —
   once before the rebase, once after variant C landed, and once to restore. Each is a ~30 s build.
   The decomposition was worth it (both times the arithmetic closed to the byte), but there is no
   cheap way to ask "what would `dist/` be without my change?".

**Concurrency**

7. **A parallel session moved `main` seven commits mid-lap**, including adopting package-size
   variant C. That invalidated a baseline this lap had already measured and required a rebase plus a
   full re-measurement. ⚠ It also produced two independent, agreeing corrections of the same agy
   record, which is reassuring rather than wasteful. Check `origin/main` before measuring anything
   that a sibling lap could move.

**Host gaps, pre-existing**

8. **`codex exec` surfaces NO MCP tools at all** — not this server, and not `codebase-memory-mcp` or
   `headroom`, both registered long before it. `codex mcp list` shows all three ENABLED, so the
   registration is correct and the gap is inside `codex exec`. Unresolved; Codex must use the CLI
   form. Worth its own investigation.
9. **`npm i -g .` blocks the postinstall hook** (`install-scripts ... not covered by allowScripts`),
   so the bundled skills are NOT refreshed by a global install alone. Run
   `node scripts/install-skill.mjs --force` after it, or the installed skill silently stays stale.

**Protocol**

10. **A client's protocol revision cannot be guessed.** Claude Code 2.1.237 asks for `2025-11-25`
    and probes `server/discover` first — neither is documented where the server author would look.
    A ten-line logging shim between host and server answered it in one attempt. Do that first, not
    third.

---

## Sources

- <https://getlulu.dev/mcps>
- [ginkida/agent-dispatch](https://github.com/ginkida/agent-dispatch) · [listing](https://mcpservers.org/servers/ginkida/agent-dispatch)
- [dvcrn/mcp-server-subagent](https://github.com/dvcrn/mcp-server-subagent)
- [steipete/claude-code-mcp](https://github.com/steipete/claude-code-mcp)
- [BeehiveInnovations/pal-mcp-server](https://github.com/BeehiveInnovations/pal-mcp-server) · [clink docs](https://github.com/BeehiveInnovations/pal-mcp-server/blob/main/docs/tools/clink.md) · [zen-mcp-server](https://github.com/beehiveinnovations/zen-mcp-server)
- [hessenpepper/mcp-delegate](https://glama.ai/mcp/servers/hessenpepper/mcp-delegate)
- [yw0nam/mcp_a2a_gateway](https://github.com/yw0nam/mcp_a2a_gateway) · [listing](https://mcpservers.org/servers/yw0nam/mcp_a2a_gateway)
- [PanGucheng/codex-deepseek-delegate-mcp](https://github.com/PanGucheng/codex-deepseek-delegate-mcp)
- [MCP Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview) · [ext-tasks](https://github.com/modelcontextprotocol/ext-tasks) · [SEP-1391](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1391)
- [MCP extension client matrix](https://modelcontextprotocol.io/extensions/client-matrix)
- [MCP sampling specification](https://modelcontextprotocol.io/specification/2025-06-18/client/sampling) · [WorkOS explainer](https://workos.com/blog/mcp-sampling)
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) · [claude-code#631](https://github.com/anthropics/claude-code/issues/631)
- [The 2026-07-28 MCP specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/) · [The Register](https://www.theregister.com/devops/2026/07/23/model_context_protocol_prepares_to_break_with_its_stateful_past/5276722)
- [Agent2Agent](https://en.wikipedia.org/wiki/Agent2Agent) · [Zuplo protocol stack](https://zuplo.com/blog/agent-protocol-stack-mcp-a2a-acp-2026)
- [metatool-ai/metamcp](https://github.com/metatool-ai/metamcp) · [microsoft/mcp-gateway](https://github.com/microsoft/mcp-gateway) · [e2b-dev/awesome-mcp-gateways](https://github.com/e2b-dev/awesome-mcp-gateways) · [LiteLLM MCP](https://docs.litellm.ai/docs/mcp)
