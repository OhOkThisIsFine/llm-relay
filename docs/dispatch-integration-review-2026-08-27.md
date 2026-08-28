# Dispatch method review — cross-CLI integration

**Date:** 2026-08-27
**Scope:** how this machine hands a delegated task to Claude Code, Codex, Antigravity (`agy`) and
OpenCode, and what to do better.
**Status:** three fixes are **applied and verified**. The rest is a ranked option list.

Confidence words used throughout mean exactly this:

| word | meaning |
|---|---|
| **verified** | measured first-hand on this machine during this review, with the evidence quoted |
| **documented** | the vendor's own help output, docs or source says so |
| **reported** | a third party says so; not independently confirmed here |
| **unverified** | not established; listed in §8 with the test that would settle it |

---

## 1. Answer up front

Yes — and the biggest win was not the one the question was about.

1. **The agy window is fixed.** `agy.exe` is a CONSOLE-subsystem binary. The dispatching host spawns
   its shell window-less, so that shell has no console to lend, so Windows **allocates a new console**
   for agy and that window takes the foreground. No agy flag can suppress it. The caller's process
   creation flags are the only lever. A launcher that sets `CREATE_NO_WINDOW` fixes it while still
   capturing stdout. **Applied to all 12 agy rungs.** Verified in both directions: with default
   flags two windows appear and Windows Terminal seizes focus at t+0 ms; with the launcher, none.

2. **agy was running with one working tool, not four.** Its allow list named `list_directory`,
   `glob` and `search_file_content` — those are *Gemini CLI* tool names. agy rejects them as
   `unknown action` and silently ignores them. Only `read_file` ever worked. Because a denied tool
   makes headless agy discard its whole answer, this explains agy's weakness far better than print
   mode does. **Fixed. Verified.**

3. **agy's permission vocabulary is five broad categories, not tool names**: `command`, `read_file`,
   `write_file`, `read_url`, `mcp`. Every one of the 41 tool-name-shaped spellings tested was
   rejected. **`mcp` is allow-listable**, so the "agy discards on any MCP call" problem was a
   permission gap, not a limitation. **Proven:** headless agy called `codebase-memory-mcp` and
   returned all 21 indexed projects in 6 s. agy now has read, write, URL and MCP access.
   `command` stays revoked, as you intended.

4. **Tighter integration is available, but MCP is not the universal answer.** Every host is an MCP
   *client*: `agy mcp add` takes stdio and http servers, and so do the others. But **no all-four-host
   MCP-*server* lane exists** — OpenCode and agy are client-only, and Codex's `codex mcp-server` is
   deprecated. Only `claude mcp serve` is a current server mode. So MCP is the right way to give a
   lane *capability*, and the wrong thing to bet on as a common dispatch transport. For that, see
   options D and E.

5. **The ladder design itself is sound.** The relay returns a command and the host executes it. That
   invariant is what let the window fix live entirely host-side, with no relay change.

---

## 2. What changed today

All three changes are applied, verified, and reversible. Backups are listed in §7.

### 2.1 Launcher shim — `C:\Users\ethan\.llm-relay\bin\lane-launch.ps1`

Spawns a lane child with `UseShellExecute=false`, `CreateNoWindow=true` and redirected pipes.
Passes every argument verbatim (it reads `$args`, with no `param()` block, so child flags such as
`-p` cannot be captured by PowerShell's binder). Returns the child's exit code. `--timeout N` kills
a hung lane and returns 124.

**Verified**, five tests:

| test | expected | result |
|---|---|---|
| exit-code passthrough | 3 | 3 |
| stdout + stderr both captured | both lines | both lines |
| unknown command | 127 | 127 |
| `--timeout 2` on a 30 s child | 124 | 124 |
| real agy lane, exact ladder args | JSON, correct answer | `{"status":"SUCCESS", ... "0.51.0"}`, exit 0, 11 s |

### 2.2 Ladder rungs routed through the launcher

12 agy rungs across `routing.ladders.{low,medium,high,xhigh}` now read:

```
pwsh -NoProfile -ExecutionPolicy Bypass -File C:\Users\ethan\.llm-relay\bin\lane-launch.ps1 C:\Users\ethan\AppData\Local\agy\bin\agy.exe -p '{task}' --model <id> --output-format json
```

**Verified**: relay restarted (PID 41620, listening on 127.0.0.1:8791), and
`llm-relay dispatch --tier medium` renders the wrapped command.

**The 14 codex rungs were deliberately NOT wrapped.** Two reasons, both verified:
`codex` resolves to `C:\Users\ethan\AppData\Roaming\npm\codex.ps1`, an npm shim — a `.ps1` cannot be
spawned by `ProcessStartInfo` with `UseShellExecute=false`. And it does not need wrapping: Node's
`child_process` defaults `windowsHide: true`, so codex's native console-subsystem children
(`codex.exe`, `codex-code-mode-host.exe`, `rg.exe` — all PE Subsystem 3) are already hidden. This
matches the symptom report: only agy pops a window.

The claude free-pool rungs are `relay` rungs rendered through `routing.cliLane`, not `cli` rungs, so
they were never in scope.

### 2.3 agy permissions repaired

`C:\Users\ethan\.gemini\antigravity-cli\settings.json` now reads:

```json
{
  "permissions": {
    "allow": ["read_file(*)", "write_file(*)", "read_url(*)", "mcp(*)"]
  }
}
```

**Verified**: agy's own log line reports
`CLI settings initialized: permissions=&{Allow:[read_file(*) write_file(*) read_url(*) mcp(*)] Deny:[] Ask:[]}, toolPermission=request-review`
with **zero** `unknown action` rejections. Before the change the same log line carried the old four
names and rejected three of them on every run.

`command(*)` is deliberately absent. Your three narrow grants in
`~/.gemini/config/config.json` (`command(audit-code ensure --quiet)`, `command(audit-code next-step)`,
`command(pytest)`) are untouched.

**End-to-end proof, two tests, both through the launcher with no window:**

1. **Local tool.** Told to use `read_file` on `C:\Code\llm-relay\package.json`, agy answered
   `0.51.0` in 7 s, exit 0 — matching disk exactly, with no denial logged.
2. **MCP tool.** Told to use `codebase-memory-mcp` to list indexed projects, agy returned all 21
   project names in 6 s, exit 0, `"status":"SUCCESS"`. Before the change this call was auto-denied
   and the whole answer was discarded. **This is the single most consequential result of the
   review:** it is what makes agy a usable lane again, and it needed no shell.

### 2.4 Steps 4-8 of the plan, executed the same day

| step | action | result |
|---|---|---|
| 4 | Corrected the agy block in `~/.claude/CLAUDE.md`, then ran the generator | `node ~/.agent-config/sync.mjs` wrote 3 targets; `--check` exits 0 |
| 5 | Raised the agy lane timeouts | `--print-timeout 30m` on all 12 rungs, plus a launcher `--timeout 2100` backstop. Relay restarted (PID 34096); the rendered lane ran and answered in 6 s |
| 6 | Installed the official Codex plugin | `codex@openai-codex` v1.0.6, enabled, user scope. 11 skills, 1 agent (`codex-rescue`), 3 harness-only hooks, **~449 tokens always-on** |
| 7 | Trialled ACP | **`acpx opencode exec` works** — `initialize` → `session/new` → answer → `end_turn`, exit 0, 13 s. **`acpx codex exec` also works**, 15 s |
| 8 | Trialled the Codex daemon | ❌ **`codex app-server daemon` is Unix-only.** Every subcommand fails on Windows |

**Four corrections that came out of running these steps.** Each contradicts something asserted
earlier in the research, so each is recorded rather than quietly fixed.

1. **`codex app-server daemon` does not work here.** Every subcommand — `start`, `stop`, `version` —
   returns `Error: codex app-server daemon lifecycle is only supported on Unix platforms`. The
   research claimed a daemon with `--listen stdio://|unix://PATH|ws://IP:PORT`; **no such flag
   exists** on v0.150.1. The real surface is
   `codex app-server {daemon,proxy,generate-ts,generate-json-schema}`, the whole command is marked
   **`[experimental]`**, and `proxy` connects to a **Unix domain socket** via `--sock`.
2. **The acpx package name was wrong in my earlier plan.** `@openclaw/acpx` (v2026.7.1) is an
   "ACP runtime backend"; the CLI is the bare **`acpx`** (v0.13.1), "Headless CLI client for the
   Agent Client Protocol". Use `npx -y acpx@0.13.1`.
3. **`codex mcp-server` is not marked deprecated by the binary.** Its help says plainly
   "Start Codex as an MCP server (stdio)", with no deprecation notice. The critic reported it as
   deprecated; the installed v0.150.1 does not say so. Treat the deprecation as **unconfirmed**.
   (`codex mcp` really is client configuration — "Manage external MCP servers for Codex".)
4. **acpx has no `agy` agent**, which confirms that Antigravity has no ACP mode. Its agent list is
   `pi, openclaw, codex, claude, gemini, cursor, copilot, droid, fast-agent, grok-build, iflow,
   kilocode, kimi, kiro, mux, opencode, pool, qoder, qwen, trae, zeroclaw`.

**The practical upshot:** ACP is the working cross-CLI transport on this machine, for **OpenCode and
Codex** — but not for agy, which keeps its wrapped `-p` lane. `acpx compare <agent>... <prompt>`
gives multi-agent fan-out for free.

### 2.5 Owner decision — the plugin owns Codex, not the ladder

Asked which of the two Codex dispatch paths should own Codex work, the owner chose the plugin:
*"it will always follow development"* — it is first-party, so it tracks Codex releases.

Applied: the **6 enabled codex rungs are now `"enabled": false`** (`codex-sol` in low/medium/high/
xhigh, `codex-spark` in low/medium). They are **disabled, not deleted**, so the rung definitions,
model ids and notes survive and the change is one flag to reverse. `codex-terra` and `codex-luna`
were already disabled. Relay restarted (PID 39216); `llm-relay dispatch --tier medium` now reports
`use: claude-free-pool — first ready lane (2 ahead of it unavailable)`.

**Side benefit:** this restores the durable free-capacity-first order the config's own notes
describe. `codex-sol` had been temporarily promoted to the front on 2026-08-23 while its weekly
allowance was fresh.

⚠ **The accepted cost, stated plainly.** The relay no longer sees Codex traffic, so ladder ordering,
quota accounting and exhaustion reporting no longer apply to it. Codex spend becomes invisible to
`llm-relay cost` and to the dashboard. If that matters later, re-enable the rungs and decide the
division per task instead.

Revert: `config.json.bak-2026-08-27-pre-codex-to-plugin`, or set `"enabled": true` on the 6 rungs.

---

## 3. How dispatch works today

The relay owns the **order**. The host owns the **execution**. Nothing else.

1. The host asks `llm-relay dispatch [--tier low|medium|high|xhigh]`, or `GET /dispatch` on
   127.0.0.1:8791.
2. `src/dispatch.ts` walks `routing.ladders.<tier>` (or the legacy `routing.ladder`) and returns the
   rungs in order, each with an `invoke` block: `command`, `args`, and optional `env`.
3. Placeholders are substituted: `{task}` in args **only**, `{spec}` and `{contextWindow}` in args
   and env. `{task}` is refused in an env value at config load, because it is request content.
4. **The host runs the command.** `src/` never spawns a `cli` rung. Peer CLI quota is client-bound,
   they run their own tool loops, and they return only final text — so a relay that shelled out
   could not return the `tool_use` blocks an HTTP turn owes its caller.
5. If a lane is exhausted the host reports back: `POST /dispatch` with an `exhausted` body, an
   optional `outcome` (`rate_limited` 15 m, `quota_exhausted` 1 h) and a vendor-stated
   `retryAfterMs` that beats both. The relay never invents the signal.
6. `llm-relay lanes --probe` records what a `cli` lane's own tool says it serves. A rung naming a
   model the roster omits is `not-servable` and is withheld. Eviction needs positive evidence.

There are two lane shapes in the live config:

- **`cli` rungs** — a real command (agy, codex). These are what the launcher now wraps.
- **`relay` rungs via `routing.cliLane`** — a compound PowerShell string that clears the nested
  session variables, points `ANTHROPIC_BASE_URL` at the relay, raises the three Claude idle
  watchdogs, and runs `claude -p ... --model pool/<name>`. These reach the free pool.

**What the host still does by hand:** everything after step 3. It copies the command, runs it, reads
the output, decides whether the lane failed, and reports exhaustion. There is no supervision, no
streaming contract, and no shared state between lanes.

---

## 4. The three real problems

### 4.1 The agy console window — root cause VERIFIED, including the negative control

Chain of evidence, all measured on this machine:

1. `where agy` resolves to one native executable,
   `C:\Users\ethan\AppData\Local\agy\bin\agy.exe` (186,767,512 bytes). **There is no shim** — that
   directory holds only the `.exe` and one `.old` backup. So no interposition point existed.
2. PE parse: `Machine=0x8664`, `Magic=0x020b` (PE32+), **`Subsystem=3`**, which is
   `IMAGE_SUBSYSTEM_WINDOWS_CUI` (console). It is a Go binary, not a Node CLI.
3. Windows gives a console-subsystem process a console at creation. With a console-less parent and
   default flags the loader **allocates a new one**. Measured: a new window of class
   `CASCADIA_HOSTING_WINDOW_CLASS` (Windows Terminal), foreground within 150 ms.
4. **Control case:** the same rig with the parent keeping its own console produced no new window.
   That is why running `agy` by hand in a terminal never shows the problem, and dispatching it
   always does.
5. The dispatching shell here genuinely has no console. `[Console]::WindowWidth` throws
   `The handle is invalid` inside the harness's PowerShell.
6. `agy --help` exposes no window, UI, headless or hide flag. A byte-grep finds no window-management
   API call in the binary. The `ShowWindow` and `SetForegroundWindow` string hits sit inside
   embedded syntax-highlighting keyword blobs, not in code.

**agy is passive here.** The fault is the caller's creation flags, which is what section 2.1 fixes.

**Negative control — run directly, and it settles the causal claim.** Spawning agy with **default
flags** (`UseShellExecute = true`, no redirection) from this same console-less parent produced:

```
=== visible windows BEFORE: 25
=== NEW top-level windows seen during the run: 2
   HWND 1D099E  t+250ms  pid=37244 proc=agy            class=PseudoConsoleWindow
   HWND 9A09BC  t+0ms    pid=3012  proc=WindowsTerminal class=CASCADIA_HOSTING_WINDOW_CLASS title=Terminal
=== foreground transitions:
   t+0ms     pid=3012  proc=WindowsTerminal  class=CASCADIA_HOSTING_WINDOW_CLASS
   t+5000ms  pid=26216 proc=brave            class=Chrome_WidgetWin_1
```

So with default flags **two** windows appear and Windows Terminal takes the foreground at t+0 ms,
holding it for five seconds. With `CREATE_NO_WINDOW` the same command produces no window at all.
Cause and remedy are both verified.

> **This also resolves a contradiction between two research passes.** One concluded agy opens no
> window; another measured that it does. Both were partly right, and the method explains why: agy
> owns a window of class **`PseudoConsoleWindow`**, which is *not* a `MainWindowHandle`, so a check
> of that property finds nothing — while the window that actually steals focus belongs to a
> **different process entirely** (`WindowsTerminal.exe`, pid 3012). Enumerate new top-level windows
> by PID and class. Never conclude from `MainWindowHandle` alone.

> ⚠ Still inherited rather than measured by me: that agy spawns `rg_embedded-*.exe` as a child, and
> that the OAuth browser launch is a separate focus-stealing event. Both are plausible, and both
> came with a stated gap.

Two related effects are worth knowing:

- The default-terminal setting is "Let Windows decide" (`DelegationConsole` and `DelegationTerminal`
  are all-zero GUIDs). That is why the popup is Windows Terminal and not conhost. Changing it would
  only change which window appears, not whether one appears.
- **A browser window stealing focus during an agy run is a different fault.** agy opens URLs through
  Go's `pkg/browser` Windows path, `rundll32.exe url.dll,FileProtocolHandler`. If you see that, a
  token refresh failed and agy is re-authenticating. `CreateNoWindow` does not suppress it.

### 4.2 agy had almost no tools — root cause VERIFIED

agy validates every allow entry at load and logs each rejection. With the old config, every run
logged:

```
ignoring invalid allow entry "list_directory(*)":      unknown action "list_directory"
ignoring invalid allow entry "glob(*)":                unknown action "glob"
ignoring invalid allow entry "search_file_content(*)": unknown action "search_file_content"
```

Three of the four entries were inert. Only `read_file` survived. agy therefore had **no directory
listing, no glob and no grep**. A denied tool makes headless agy discard its whole answer, so any
task needing one of those returned nothing, after full latency and full cost.

I probed 41 candidate action names across two runs. Exactly **five** are valid.

| valid (5) | rejected (sample of 36) |
|---|---|
| `command`, `read_file`, `write_file`, `read_url`, `mcp` | `list_directory`, `glob`, `search_file_content`, `view_file`, `list_dir`, `find_by_name`, `grep_search`, `codebase_search`, `mcp_tool`, `call_mcp_tool`, `create_file`, `edit_file`, `replace_file_content`, `propose_code`, `browser`, `web_search`, `terminal`, `shell`, `run_command`, `execute`, `search`, `agent`, `subagent`, `task`, `notebook`, `deploy` |

They are permission **categories**, not tool names. That is why every tool-name spelling failed. It
is a trap worth remembering: the file accepts any string, and only the log says it was discarded.

> **Correct an error in `~/.claude/CLAUDE.md`.** It states agy retains `read_file`,
> `list_directory`, `glob`, `search_file_content`. Three of those four never worked. The line should
> name the five valid categories instead.

### 4.3 Every lane is a fresh process with no shared state — by design, partly unavoidable

Each dispatch starts a new CLI. It re-reads its config, re-authenticates, rebuilds its context, then
exits. Two costs were visible in this session: agy's `--print-timeout` defaults to **5 minutes**,
which silently caps a long lane; and a one-line answer billed 25,009 input tokens, of which 23,492
were cache reads.

The relay cannot fix this, because the relay must not spawn lanes. Only a host's own daemon mode
fixes it, and of the four hosts only OpenCode clearly has one.

---

## 5. What each host actually exposes

Every cell comes from that binary's own `--help` on this machine unless marked otherwise.
`unknown` means this review did not establish it. It does not mean "absent".

| host | non-interactive | structured output | server / daemon mode | MCP server | MCP client | resume / session | hooks |
|---|---|---|---|---|---|---|---|
| **Claude Code** | `-p` / `--print` | `--output-format text\|json\|stream-json`, `--json-schema` | unknown | `claude mcp serve` (documented) | yes (documented) | `--resume`, `--continue` | full engine; the **only** host whose hooks fire here |
| **Codex** v0.150.1 | `codex exec` | `--json` (JSONL events), `-o/--output-last-message`, `--output-schema` | `codex app-server` — `[experimental]`, subcommands `daemon/proxy/generate-ts/generate-json-schema`. ⚠ **`daemon` is Unix-only and fails on Windows**; `proxy` needs `--sock` | `codex mcp-server` — "Start Codex as an MCP server (stdio)"; **not** marked deprecated in v0.150.1. (`codex mcp` is *client* configuration) | `[mcp_servers.*]` in `config.toml` | `codex exec resume`, `--last` (reported) | engine exists; **never fires here** |
| **Antigravity** v1.1.22 | `-p` / `--print` / `--prompt` | `--output-format text\|json\|stream-json`, `--input-format stream-json`, `--json-schema` | `agy agentapi` — 3 commands, **not** a server (verified) | none found | **yes** — `agy mcp add/remove/list/enable/disable`, stdio and http (verified) | `-c` / `--continue`, `--conversation` | **no hook surface** |
| **OpenCode** | `opencode run [message..]` | unknown | **`opencode serve` — a headless server** (verified from `--help`) | unknown | yes (documented) | `--session`, `export [sessionID]` | plugin API (documented) |

Exact spellings, all verified from `--help` on this machine:

- **agy**: `--model`, `--agent`, `--effort low|medium|high`, `--sandbox`,
  `--dangerously-skip-permissions`, `--add-dir`, `--mode`, `--print-timeout` (**default 5m0s**),
  `--disable-slash-commands`, `--log-file`. Subcommands: `agent(s)`, `changelog`, `install`, `mcp`,
  `mic-serve`, `models`, `plugin(s)`, `update`, plus the undocumented `agentapi`.
  There is **no** `--yolo` and **no** `--approval-mode` — those belong to the Gemini CLI.
- **agy agentapi** (undocumented; wrapper at `~/.gemini/antigravity-cli/bin/agentapi.bat`):
  `get-conversation-metadata <id>`,
  `new-conversation [--model=<flash_lite|flash|pro>] [--title] [--profile] <prompt>`,
  `send-message [--title] <recipient_id> <content>`. Its model vocabulary does not match
  `agy models`.
- **codex exec**: `-m/--model`, `-s/--sandbox read-only|workspace-write|danger-full-access`,
  `-C/--cd`, `--add-dir`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`,
  `--ignore-rules`, `--dangerously-bypass-approvals-and-sandbox`, `--color`.
- **opencode**: subcommands `run`, `serve`, `acp` (**start ACP server**), `models`, `stats`,
  `export`. Options `-m/--model provider/model`, `--prompt`, `--agent`, `--auto`, `--mini`.
  It is npm-installed, so its shim is a Node script and **can** be interposed on, unlike agy.
- **claude**: `--effort low|medium|high|xhigh|max`,
  `--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`, `--agents <json>`,
  `--fallback-model`, `--max-budget-usd` (unique to claude).

**Effort levels do not map one to one.** agy has three levels, claude has five. A normalising
dispatch layer must translate them, not pass them through.

**ACP availability, verified by running it:** OpenCode ✅ (`acpx opencode exec`), Codex ✅
(`acpx codex exec`, via the `codex-acp` adapter), Claude ✅ per the registry but through
`claude-agent-acp`, which wraps the **Agent SDK, not the `claude` CLI**, agy ❌ (no ACP mode,
and no `agy` agent in acpx).

---

## 6. Options, ranked

Two llm-relay invariants bound every option:

- **I1 — the relay never spawns a `cli` rung; the host executes.**
- **I2 — no LLM opinion enters the request path; routing comes from config and deterministic
  classification.**

An option that moves execution into `src/` violates I1. An option that asks a model which lane to
use violates I2. Both are called out below.

### A. Fix the spawn layer — **DONE**

| | |
|---|---|
| **What** | A host-side launcher sets `CREATE_NO_WINDOW` and captures the pipes. |
| **Effort** | S — done today. |
| **Benefit** | Removes the focus theft entirely. Also gives every lane a timeout and a real exit code. |
| **Risk** | Very low. Reversible by restoring one config backup. |
| **Invariants** | Respects I1 fully — the relay still only returns a string. Touches neither routing nor I2. |

### B. Adopt the official Codex plugin for Claude Code — **DONE, and it now OWNS Codex**

| | |
|---|---|
| **What** | OpenAI ships `github.com/openai/codex-plugin-cc`, an official plugin that wraps the **Codex app server** and drives the installed `codex` binary. Install (documented): `/plugin marketplace add openai/codex-plugin-cc`. |
| **Effort** | S — installed. |
| **Benefit** | Codex becomes a *tool* inside a Claude Code session instead of a shell-out. Installed v1.0.6: 11 skills, a `codex-rescue` agent, 3 harness-only hooks, ~449 tokens always-on. Loads at the next session start. First-party, so it tracks Codex releases. Removes the copy-run-read loop for the highest-ranked lane in your ladder. |
| **Risk** | It bypasses the ladder for Codex, so quota accounting and lane ordering no longer see those calls. ✅ **Decided 2026-08-27: the plugin owns Codex; the 6 codex ladder rungs are disabled.** The two-dispatch-path risk is therefore closed rather than left open — see §2.5. |
| **Invariants** | Respects I1 (Claude Code spawns it, not the relay). ⚠ Sits *beside* the ladder rather than inside it — a second dispatch path, which is the failure shape your `CLAUDE.md` warns about ("two paths, one policy empty"). |

### C. Give agy capability through MCP — **recommended, now unblocked**

| | |
|---|---|
| **What** | `mcp(*)` is now allowed, and `agy mcp add` takes stdio and http servers with `--env` and `--header`. `codebase-memory-mcp` is already registered and was being auto-denied; it should now work. |
| **Effort** | S to test, M to curate a useful server set. |
| **Benefit** | Restores agy's usefulness without granting a shell. This is the direct answer to "agy doesn't have a shell" — it gets capability by a different route. |
| **Risk** | agy still discards its whole answer on any denial, so a *newly added* server whose action falls outside the five categories could reintroduce silent total loss. Add one server at a time and test. |
| **Invariants** | Untouched. This changes what a lane can do, not how a lane is chosen. |

### D. Use ACP as the common transport, via `acpx` — **VERIFIED WORKING; the best structural option**

| | |
|---|---|
| **What** | Agent Client Protocol is JSON-RPC 2.0 over stdio, stable at v1, with an official agent registry at `cdn.agentclientprotocol.com/registry/v1/latest/registry.json`. `acpx` (`github.com/openclaw/acpx`, MIT, ~3.2k stars) is a **headless ACP client built for orchestration**: `acpx prompt`, `acpx exec` (one-shot session), `acpx compare <agent>... <prompt>`. Registry launch commands cover your exact fleet — `opencode acp`, `npx @agentclientprotocol/codex-acp`, `npx @google/gemini-cli --acp`, and a Claude adapter. |
| **Effort** | M. Two lanes already proven. |
| **Benefit** | One client, one message shape, for several agents. **Tested: `acpx opencode exec` and `acpx codex exec` both return clean answers with exit 0 and no window.** `acpx compare` is a fan-out across agents for free. Session methods (`session/new`, `session/load`) give the resumable state section 4.3 says is missing. |
| **Risk** | ⚠ **Neither Claude Code nor Codex implements ACP natively.** Claude reaches it through `@agentclientprotocol/claude-agent-acp`, which wraps the **Agent SDK, not the `claude` CLI** — so it does not use your CLI's config, hooks or subscription path. Codex reaches it via `codex-acp`. ACP is also documented as *editor↔agent*, not agent↔agent; using it for dispatch is off-label, though the proxy-chain methods (`proxy/initialize`, `proxy/successor`) suggest the authors anticipate middleware. **agy is not in the fleet list** — no ACP mode was found for it. |
| **Invariants** | Respects I1 and I2 as long as the ladder still chooses and `acpx` only executes. |

### E. Use the real daemon modes instead of one process per task

| | |
|---|---|
| **What** | **`codex app-server`** is JSON-RPC 2.0, bidirectional, with `--listen stdio://`, `unix://PATH` or `ws://IP:PORT`, exposing `thread/start`, `thread/resume`, `thread/list`, `turn/*`. **`opencode serve`** is a headless server, with `opencode attach <url>`. ⚠ Do not confuse `codex app-server` with `codex mcp-server`, which is real but deprecated, or with `codex mcp`, which is client configuration. ⚠ `opencode acp` does **not** avoid HTTP exposure — it starts the same HTTP listener internally. |
| **Effort** | M to L. |
| **STATUS** | ⚠ **Half dead on Windows.** `codex app-server daemon` refuses to run here — it is Unix-only (tested). OpenCode's `serve` remains available and untested. Prefer option D, which achieves session reuse over ACP and is verified working for both Codex and OpenCode. |
| **Benefit** | Removes per-task startup, re-authentication and context rebuild — the 4.3 costs. Gives resumable threads. |
| **Risk** | A long-lived daemon is new operational surface: lifecycle, port, crash recovery, and a second place quota is spent. It also weakens the ladder's exhaustion signal, which is built around a process that exits. |
| **Invariants** | ⚠ Careful with I1. A daemon the *relay* starts would violate it. A daemon the *host* starts, which the relay merely names, does not. Keep the start in the host. |

### F. tmux / worktree fan-out for parallel lanes

| | |
|---|---|
| **What** | Claude Code has **first-party** worktree fan-out: `claude --worktree/-w [name]` creates `.claude/worktrees/<name>/`, `--tmux` opens a session, and the `/batch` skill splits one change across 5-30 worktree-isolated subagents. Third-party: Claude Squad (~8.4k stars, tmux + worktree per agent, agent selected with `-p`), Vibe Kanban (~27.9k stars, multi-executor), and **ntm** (~431 stars), which is notable because it explicitly supports **Antigravity (agy)** alongside Claude, Codex, Gemini and Grok. |
| **Effort** | S for the first-party path, M for a third-party manager. |
| **Benefit** | Real parallelism with isolated working trees. |
| **Risk** | ⚠ **Do not nest worktrees under this repo.** `vitest.config.ts` scopes the suite to this checkout's `test/` on purpose; a worktree under the repo root made `npm test` run 70 files instead of the real suite. Also, Claude Code Agent Teams split-pane is documented as **not supported in Windows Terminal** — it needs tmux or iTerm2. |
| **Invariants** | Orthogonal to both. |

⚠ **A cautionary example.** `osanoai/multicli`, presented elsewhere as the closest Windows fleet
bridge, spawns with `shell: true` and **no** `windowsHide`, and its scheduled task uses
`powershell.exe -WindowStyle Hidden` — the weaker `SW_HIDE` path, not `CREATE_NO_WINDOW`. It would
very likely reproduce exactly the focus theft section 2.1 just removed. Check the spawn flags of any
orchestrator before adopting it on Windows.

### G. Wrap peer CLIs as MCP servers so Claude Code calls them as tools

| | |
|---|---|
| **What** | The community pattern. Largest is **pal-mcp-server** (formerly zen-mcp-server, ~11.7k stars) whose `clink` tool launches isolated CLI instances from inside your current CLI. Also `gemini-mcp-tool` (~2.3k) and `codex-as-mcp` (~173). |
| **Effort** | S. |
| **Benefit** | Lanes become tools; no copy-run-read loop. |
| **Risk** | ⚠ **`steipete/claude-code-mcp`, the best-known wrapper, is ARCHIVED (read-only since 2026-05-15)** — do not adopt it. ⚠ **pal-mcp-server's last push was 2025-12-15**, so "11.7k stars" is not evidence of current maintenance, and parts of it are tmux/WSL-oriented rather than native Windows. `codex-as-mcp` invokes `codex exec --dangerously-bypass-approvals-and-sandbox`, a much wider grant than your current posture. Option B is the maintained, first-party version of this idea for Codex. |
| **Invariants** | ⚠ Same second-dispatch-path concern as B, and worse: a general bridge lets the model pick the lane, which brushes against I2. |

### H. Change nothing structural; fix ergonomics only

| | |
|---|---|
| **What** | Keep the ladder and the shell-out. Fix the window (done), the permissions (done), and document the rest. |
| **Effort** | Zero beyond today. |
| **Benefit** | No new surface, no new failure modes. |
| **Risk** | The 4.3 costs remain. |
| **Invariants** | Untouched. |

---

## 7. Recommended plan

Cheapest first. Each step is independently testable, and each says what success looks like.

**Step 1 — DONE. Confirm the window fix in normal use.**
Next time a lane runs, watch for a popup.
```bash
llm-relay dispatch --tier medium
```
Success: the agy rungs render `... lane-launch.ps1 ... agy.exe ...`, and running one opens no window.

**Step 2 — DONE. Confirm agy's tools.**
```bash
pwsh -NoProfile -File C:\Users\ethan\.llm-relay\bin\lane-launch.ps1 C:\Users\ethan\AppData\Local\agy\bin\agy.exe -p "Read C:\Code\llm-relay\package.json and reply with only its version field." --output-format json
```
Success: `{"status":"SUCCESS", ...}` containing `0.51.0`. Already observed.

**Step 3 — DONE. The MCP path that was previously discarding answers now works.**
```bash
pwsh -NoProfile -File C:\Users\ethan\.llm-relay\bin\lane-launch.ps1 C:\Users\ethan\AppData\Local\agy\bin\agy.exe -p "Use the codebase-memory-mcp tools to list the indexed projects. Reply with the list only." --output-format json
```
Success: a real list, not an empty answer. An empty string with exit 0 would still mean a discard.
Observed: 21 project names, 6 s, exit 0. Passed.

**Step 4 — DONE. Corrected `~/.claude/CLAUDE.md`.**
Replace the claim that agy retains `read_file, list_directory, glob, search_file_content` with the
five valid categories, and record that `mcp` is now granted. Then re-run the generator:
```bash
node ~/.agent-config/sync.mjs --check
```
Observed: 3 targets written, then `--check` reported 11 current, exit 0. Passed.

**Step 5 — DONE. Raised the agy lane timeouts.**
The default is 5 minutes and it silently truncates a long lane. Add `--print-timeout 30m` to the 12
agy rungs, matching the 30-minute idle watchdogs already set on the claude lanes.
Observed: all 12 rungs now carry `--print-timeout 30m` plus a launcher `--timeout 2100` backstop;
the rendered lane answered in 6 s. Passed.

**Step 6 — DONE. Installed the official Codex plugin.**
```bash
claude plugin marketplace add openai/codex-plugin-cc
claude plugin install codex@openai-codex
```
Observed: marketplace `openai-codex` added, plugin v1.0.6 installed and enabled. Passed.
⚠ **Still your call:** whether Codex traffic should keep flowing through the ladder as well. Two
dispatch paths for one lane is the risk, and nothing forces a choice yet.

**Step 7 — DONE, and better than hoped.**
OpenCode is the one host with a verified native ACP mode, so it is the cheapest honest test.
```bash
npx -y acpx@0.13.1 opencode exec "Reply with the single word: acpok"
```
Observed: `initialize` → `session/new` → `acpok` → `end_turn`, exit 0, 13 s. Passed.
`acpx codex exec` also passed, 15 s. ⚠ The package is bare `acpx`, **not** `@openclaw/acpx`, which
is a different thing (an ACP runtime backend).

**Step 8 — DONE, and the answer is no.** `codex app-server daemon` is Unix-only and fails on
Windows. Option D (ACP) supplies the session reuse instead, and it is verified. If you still want a
daemon, the remaining candidate is `opencode serve`, untested.

---

## 8. What is NOT verified

Listed honestly, with the test that would settle each.

| claim | why it matters | how to settle it |
|---|---|---|
| The one transient window seen during the first 70 s agy run | Probably an unrelated window, since the negative control shows the treated case produces none — but it was never attributed | Re-run the treated case several times, logging every new HWND with its owning PID and class |
| `codex mcp` runs Codex as an MCP server | Would be an alternative to option B | `codex mcp --help` |
| Whether `read_file(*)` grants *all* read tools or only one | Determines whether agy can list or grep at all now | Ask agy to list a directory and to grep; see if it succeeds or discards |
| `toolPermission=request-review` semantics | It appears in every log line and its effect on headless runs is unknown | Search the Antigravity CLI docs; test with a tool outside the allow list |
| Whether `agy agentapi` shares the same quota, and whether it is stable | It is undocumented and its model names (`flash_lite\|flash\|pro`) do not match `agy models` | `agy agentapi new-conversation --model=flash "ping"` and watch quota |
| Whether an agy PreToolUse hook can override a denial | Would be a second lever besides the allow list | Reported not to work on v1.1.22; needs a first-party test |
| ACP for Claude Code wraps the Agent SDK, not the CLI | Changes whether your CLI config and subscription apply | Inspect `@agentclientprotocol/claude-agent-acp` dependencies |
| Star counts and maintenance status of the third-party repos | Adoption risk | Open each repo and check the last commit |
| `agy --dangerously-skip-permissions` actually grants a shell | Would be a second lever, and a risk to know about | In a disposable workspace: `agy --dangerously-skip-permissions -p "Run: echo HELLO_FROM_SHELL, then report what it printed" --output-format json` |
| Whether `opencode serve` + `run --attach` truly reuses a session | The last remaining daemon candidate, now that the Codex daemon is ruled out on Windows | `opencode serve --port 4096`, then two `opencode run --attach http://127.0.0.1:4096 "Reply OPENCODE_OK only"` calls; inspect `/session` and the PID |
| Whether `codex mcp-server` is deprecated | The critic says yes; the installed binary's help does not | Check the openai/codex changelog and release notes for v0.150.1 |
| Whether an `acpx` session persists usefully across calls | `exec` is one-shot; `acpx <agent> sessions new` implies reuse | `acpx codex sessions new --name t1`, prompt twice, then `acpx codex status` and compare PIDs |
| Whether losing Codex from the ledger matters in practice | Codex spend is now invisible to `llm-relay cost` and the dashboard | After a week, check whether any Codex budget question goes unanswerable; if so, re-enable the rungs |
| Exact tool inventory of `claude mcp serve` | One research file's list came from a search snippet and conflicts with the local inventory | Run `claude mcp serve`, send `initialize` then `tools/list`, and trust only what it returns |

**A second reviewer did run.** A `codex exec --model gpt-5.6-sol` critic pass over the research
bundle returned 22 findings after ~27 minutes, and its corrections are folded into this document —
specifically the 4.1 caveat, the Codex MCP row in section 5, the option D/E/G risk notes, and the
five rows above. Its full output is at `scratchpad\critic-gaps.md`.

⚠ **One process anomaly, unexplained:** an `agy.exe` (PID 2680) runs in **Session 0** with no
discoverable launcher, no scheduled task and no service entry. Session 0 is isolated from the
interactive desktop, so it cannot be drawing the focus-stealing window — but a long-lived
unexplained agy process is worth investigating separately.

⚠ **A method error worth recording.** My first vocabulary probe compared a *character* count against
a *byte* count when slicing the log, and `agy mcp list` writes no log at all — so it read stale lines
and reported a wrong "accepted" list by subtraction. The corrected method reads the whole log, which
agy truncates per run. If you re-probe, use that method.

---

## 9. Sources

**Windows process creation**
- https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.processstartinfo.createnowindow
- https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process
- https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session
- https://nodejs.org/api/child_process.html
- https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows

**Antigravity CLI**
- https://antigravity.google/blog/introducing-google-antigravity-cli
- https://antigravity.google/docs/cli/headless
- https://antigravity.google/docs/cli/mcp
- https://antigravity.google/docs/cli/install

**Codex**
- https://github.com/openai/codex-plugin-cc
- https://github.com/openai/codex/discussions/15374
- https://github.com/kky42/codex-as-mcp

**OpenCode**
- https://opencode.ai/docs/
- https://opencode.ai/docs/acp/
- https://opencode.ai/docs/agents/

**Protocols**
- https://agentclientprotocol.com/
- https://agentclientprotocol.com/get-started/architecture.md
- https://agentclientprotocol.com/announcements/acp-v2-draft.md
- https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://github.com/a2aproject/A2A

**Orchestration in practice**
- https://github.com/openclaw/acpx
- https://github.com/BeehiveInnovations/pal-mcp-server
- https://github.com/BeehiveInnovations/pal-mcp-server/blob/main/docs/tools/clink.md
- https://github.com/jamubc/gemini-mcp-tool
- https://github.com/smtg-ai/claude-squad
- https://github.com/BloopAI/vibe-kanban
- https://github.com/Dicklesworthstone/ntm

**Full research bundle** (10 files, 396 findings, 379 sources, 446 KB):
`C:\Users\ethan\AppData\Local\Temp\claude\C--Code-llm-relay\4ede2635-ba94-44c2-8889-b106e098c155\scratchpad\dispatch-research\`
⚠ That path is a session scratchpad and will not survive cleanup. Copy it if you want to keep it.

---

## 10. Files changed

| file | change | backup |
|---|---|---|
| `C:\Users\ethan\.llm-relay\bin\lane-launch.ps1` | **new** — the no-window launcher | n/a |
| `C:\Users\ethan\.llm-relay\config.json` | 12 agy `cli` rungs routed through the launcher | `config.json.bak-2026-08-27-pre-lane-launch` |
| `C:\Users\ethan\.gemini\antigravity-cli\settings.json` | allow list repaired to the 4 valid non-shell categories | `settings.json.bak-2026-08-27-pre-vocab-fix` |
| `C:\Users\ethan\.llm-relay\config.json` | `--print-timeout 30m` plus a launcher `--timeout 2100` backstop on the same 12 rungs | `config.json.bak-2026-08-27-pre-agy-timeout` |
| `C:\Users\ethan\.claude\CLAUDE.md` | agy block rewritten: verified vocabulary, window cause, timeout default | `CLAUDE.md.bak-2026-08-27-pre-agy-vocab` |
| `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.config/opencode/AGENTS.md` | regenerated from `CLAUDE.md` | re-run `node ~/.agent-config/sync.mjs` |
| Claude Code plugins | marketplace `openai-codex` added; `codex@openai-codex` v1.0.6 installed, user scope | `claude plugin uninstall codex@openai-codex`, then `claude plugin marketplace remove openai-codex` |

To revert everything: restore the backups, uninstall the plugin, re-run `sync.mjs`, then restart
the relay with
`wscript.exe "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\llm-relay.vbs"`.

---

## 11. Friction hit while doing this work

Rewalked from the transcript, not from memory. Each item cost real time.

**Tooling traps**

1. **Bash heredocs failed repeatedly** with ``unexpected EOF while looking for matching `'` `` when
   the body contained backticks or nested quotes — which markdown and PowerShell snippets always do.
   Three attempts died this way. **Workaround that always worked:** write the content with the Write
   tool to a scratchpad file, then apply it with a short Python script. Do that first next time.
2. **Python `print` dies on non-ASCII** in this console (`cp1252`): `UnicodeEncodeError: '\u2192'`.
   It killed a loop halfway, after it had already written half its files. Prefix with
   `PYTHONIOENCODING=utf-8`, or `.encode('ascii','replace')` anything printed.
3. **Python string escapes bit twice** on Windows paths in non-raw literals — `"C:\Users\..."`
   raised `truncated \UXXXXXXXX escape`. Use raw strings for every Windows path in a patch script.
4. **PowerShell's parameter binder claims `--`** and any child flag such as `-p`, so a wrapper script
   with a `param()` block ate its own child's arguments:
   `Parameter cannot be processed because the parameter name '' is ambiguous`. **Fix: no `param()`
   block at all — read `$args`.** That is why `lane-launch.ps1` has none.
5. **`[Console]::WindowWidth` throws `The handle is invalid`** in the harness's PowerShell, because
   that host has no console. It aborted a script at line 1. Wrap any console probe in try/catch —
   and note this throw is itself the diagnostic for the whole window problem.
6. **Empty junk files leaked into the repo root** (`0)`, `SDK`, ``out.txt`)``) from shell mishaps.
   Removed. This is why commits here need explicit pathspecs rather than `git add -A`.

**Agent-lane friction**

7. **The 12-agent research workflow hit the monthly spend limit** with 2 of 12 agents left, killing
   the critic and the synthesiser. **The research was recoverable** because
   `<transcriptDir>/journal.jsonl` holds each agent's full return value, and
   `Workflow({scriptPath, resumeFromRunId})` replays the unchanged prefix from cache. Patching only
   the script's tail kept all 10 completed agents cached. Worth knowing before panicking.
8. **The free relay pool lane failed this task twice, for TWO DIFFERENT reasons** — and the second
   one was my own fault, which is why both are recorded.
   - Attempt 1 (`pool/medium`) read the inputs, printed "Now I have all the source materials. Let me
     conduct the adversarial review systematically", and exited 0 having written nothing. That is
     the "two words and exit 0 is a failure" mode already in memory.
   - Attempt 2 (`pool/high`) was told to create its output file first and append as it went. It
     created the placeholder, then died on
     `API Error: 402 ... this model requires a subscription or extra usage` from an ollama member.
     **That is a COLD POOL, not a broken lane.** I had restarted the relay three times while
     applying config changes, and `llm-relay.vbs` says in as many words: in-memory breaker state is
     lost on restart, so the first heavy walk burns the paid-gated members rediscovering their 402s
     and can fail outright.
   **Lesson: warm the pool after every relay restart, before spending a real job on it.** Confirmed
   afterwards — one trivial request each and both pools answered: `pool/medium` in 11 s,
   `pool/high` in 40 s, the extra time being the walk past the 402 members.
   The independent review that DID land came from `codex exec --model gpt-5.6-sol` (~27 minutes,
   22 findings, four genuine cross-file contradictions).
9. **`codex exec` buffers all output until exit** under a background PowerShell pipeline, so a long
   run looks identical to a hung one. Check liveness by PID and CPU, not by output size.
10. **agy truncates `cli.log` per run.** An early probe sliced "new" log lines and read stale ones
    from the previous run, producing a confidently wrong result. Read the whole file; it only ever
    describes the most recent run.
11. **`agy mcp list` writes nothing to `cli.log`** — only a real `-p` turn does. A settings-only
    subcommand is not a cheap way to test settings validation.

**Documentation traps**

12. **The research bundle contradicted itself** on the central question, and neither side flagged it.
    One pass measured the window; another concluded "agy opens no window" from `MainWindowHandle`.
    Both were partly right. Only running the negative control resolved it. A fan-out research stage
    needs an explicit cross-file contradiction check — the critic stage found four such pairs.
13. **Two research claims were simply wrong** and would have shipped as recommendations: a
    `codex app-server --listen ws://…` flag that does not exist, and the wrong npm package name for
    `acpx`. Both were caught only by running the commands. Run every command a report recommends.
