# Offload lanes: tool use and agentic capability

**Date:** 2026-08-08 · **Host:** Claude Desktop session (`CLAUDE_CODE_ENTRYPOINT=claude-desktop`,
`ANTHROPIC_BASE_URL=https://api.anthropic.com` — bypasses the relay, so every offload is a shell-out)
· **Claude Code:** 2.1.223 · **Lane under test:** `claude-deepseek-credits`
(`openrouter/deepseek/deepseek-v4-flash-0731` via `routing.cliLane`)

## Summary

The premise "our dispatch method prevents tool use and limits us to single-shot calls" is **half
right, and the working half is the important one.**

- **Tool use is not broken.** It was never broken. The offloaded session is granted the full
  27-tool set — `Task` (its own subagents), `Bash`, `Edit`, `Write`, `Glob`, `Grep`, `WebSearch`,
  `Skill`, `Workflow` — and runs a real multi-turn agentic loop through the relay.
- **What blocks the work is one config token: `--permission-mode plan`** in `routing.cliLane`.
  Headless `claude -p` has **no `ExitPlanMode` tool**, so a lane started in plan mode can never
  leave it. The agent explores read-only, writes a plan document, and stops.
- **"Single-shot" is real but shallow** — each dispatch is a fresh process with no session
  continuity. `--session-id` + `--resume` fixes it; both verified working through the relay.

Both limits are in `~/.llm-relay/config.json`. Neither is in `src/`.

## Measured evidence

### Run 1 — current template (`--permission-mode plan`)

Task: *"Count the .ts files in this directory using your tools, then write the number into PROOF.txt."*

```
tools granted   : 27 (Task, Bash, Edit, Write, Glob, Grep, WebFetch, WebSearch, Skill, Workflow, …)
permissionMode  : plan
num_turns       : 4
tools invoked   : Glob(*.ts) → 3 files ✓ · Write(→ plans/*.md) ✓ · Bash(echo) ✓
PROOF.txt       : NOT created
permission_denials: []            ← nothing was denied; the agent self-censored
cost            : $0.032275
```

The model's own closing words name the trap exactly:

> "I'm in plan mode, so creating `PROOF.txt` … is deferred until you approve. **No ExitPlanMode
> tool is available in this session**, so I can't formally signal approval."

This is the whole defect. The agent used tools, reached the right answer (3), and then had no
mechanism to act on it. It wrote its plan into
`~/.llm-relay-claude/plans/count-the-ts-files-synthetic-cray.md` — a directory the operator was
probably never looking at — and exited `success`. **A plan-mode lane fails silently and reports
`is_error: false`.** Nothing in the exit status distinguishes "did the work" from "was caged".

### Run 2 — `--permission-mode acceptEdits --allowedTools "Bash,Read,Edit,Write,Glob,Grep,Task,WebFetch"`

```
num_turns       : 3
PROOF.txt       : created, contents "3"      ✓
permission_denials: []
cost            : $0.008725
```

Same task, same model, same relay path. Config change only.

### Run 3 — `--resume` against run 2's `--session-id`

Prompt: *"Without re-running any tool, what number did you just write, and into which file?"*

```
num_turns       : 1
result          : "I wrote 3 into PROOF.txt (…\tooltest\PROOF.txt)."
cost            : $0.002425
```

Full prior context recovered with no tool calls. **Multi-turn offload works through the relay
today** — nothing was built to enable it; the dispatch template simply never passed a session id.

## The fix

`routing.cliLane.args` in `~/.llm-relay/config.json`. Current:

```json
["-p", "--model", "{spec}", "--permission-mode", "plan", "{task}"]
```

Replace `plan` with a mode that can actually finish. Modes available in 2.1.223 —
`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`:

| Mode | Behaviour | Fits |
|---|---|---|
| `plan` | read-only, **cannot exit in headless** | nothing — it is a trap here |
| `dontAsk` | denies anything outside `permissions.allow` + the read-only command set; never hangs | pure recon, matches the "offload is advisory" doctrine |
| `acceptEdits` | writes files, auto-approves `mkdir`/`touch`/`mv`/`cp`; other shell + network still need `--allowedTools` | **recommended** — full agentic, still bounded |
| `bypassPermissions` | everything, no checks | sandboxes only |

`acceptEdits` alone still aborts on an un-allowed `Bash`, so pair it with `--allowedTools`.

Recommended template:

```json
["-p", "--model", "{spec}",
 "--permission-mode", "acceptEdits",
 "--allowedTools", "Bash,Read,Edit,Write,Glob,Grep,Task,WebFetch,WebSearch",
 "--max-budget-usd", "0.50",
 "{task}"]
```

`--max-budget-usd` is worth adding regardless: the top lane is **paid** OpenRouter credits, and a
trivial three-file count cost $0.032. An unattended agentic loop on that lane has no ceiling today.

### Known limitation of the single-template design

`routing.cliLane` is one template (`config.ts:147`, `cliLane?: CliLaneTemplate`) applied to every
transposed `relay` rung. There is no per-rung override and no way to ask for a read-only lane and a
write-enabled lane from the same ladder. Making `cliLane` accept named variants (recon vs agentic,
selected by `llm-relay dispatch --lane-mode`) is the natural follow-up if one template proves too
coarse. Not required for this fix.

## What other people do about this

Four approaches, in rough order of how much they'd change here.

**1. Permission flags — what everyone actually lands on.** The Anthropic headless docs treat
`--allowedTools` + a non-`plan` permission mode as *the* answer for unattended runs: "pre-approving
tools with `--allowedTools` and `--permission-mode` so unattended runs never block on a prompt."
`plan` is documented for exactly one use — "analysis output from scripts or CI-like workflows
**without editing**." Our lane inherited the CI-analysis recipe for a general-purpose worker.

**2. `--permission-prompt-tool` — programmatic approval policy.** A largely undocumented flag
pointing Claude Code at an MCP tool that answers permission prompts in code. Decision order is
`settings.json` / `--allowedTools` / `--disallowedTools` first; anything unmatched falls through to
your tool. This is the principled middle ground between `dontAsk` (auto-deny) and
`bypassPermissions` (auto-allow) — a policy that can approve `Write` under `docs/` and refuse it
under `src/`, with an audit trail. Interesting for llm-relay specifically: the relay already owns a
destructive-tool refusal set (`DEFAULT_DESTRUCTIVE`), so a permission-prompt MCP backed by that same
list would put one definition behind both the repair boundary and the execution boundary. Worth
considering, not needed now.

**3. Bidirectional `stream-json` — a persistent session instead of N processes.**
`--input-format stream-json --output-format stream-json` turns `claude -p` into a live loop: one
JSON message per line on stdin, events on stdout, no per-turn process start. `--resume`/`--continue`
(verified in run 3) gets most of the benefit at a fraction of the complexity, so this only pays off
if we start doing genuinely conversational offload.

**4. claude-code-router (`@musistudio/claude-code-router`).** The closest published analogue to
llm-relay: a proxy between the CLI and other providers, launched as `ccr code`, with `/model
provider,model` mid-session and per-subagent pinning via a
`<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>` prompt prefix — the same mechanism as our
`@relay:` directive, invented independently. **It offers nothing we lack**, and it does not solve
the Desktop problem either: `ccr code` is a terminal launch, which is precisely the thing a Desktop
session cannot do to itself. Worth knowing the convergent design exists; not worth adopting.

Also considered and rejected: the **Agent SDK** (TypeScript/Python) with a `canUseTool` callback.
Strictly better ergonomics than shelling out, but it means llm-relay spawning and owning agent
processes — which the project has ruled out on purpose ("The dispatch ladder decides ORDER, never
execution"; the relay hands over a command, the host runs it). Not a fit.

## What this does *not* fix

The Desktop bypass is unchanged and unfixable from here: the launcher pins `ANTHROPIC_BASE_URL`, so
in-process `Agent(...)` subagents and `@relay:` directives still no-op in a Desktop session. The
shell-out ladder remains the only route to another provider from Desktop. This work makes that
route *capable*; it does not make it *native*.

## Sources

- [Run Claude Code programmatically — Claude Code Docs](https://code.claude.com/docs/en/headless)
- [Claude Code Playbook: outsourcing permissions with `--permission-prompt-tool`](https://www.vibesparking.com/en/blog/ai/claude-code/docs/cli/2025-08-28-outsourcing-permissions-with-claude-code-permission-prompt-tool/)
- [Claude Code in CI/CD and Headless Automation](https://hidekazu-konishi.com/entry/claude_code_cicd_and_headless_automation.html)
- [Claude Code Router guide (2026)](https://www.agensi.io/learn/claude-code-router-guide)
- [ExitPlanMode / plan-mode headless issues](https://github.com/anthropics/claude-code/issues/15755)
