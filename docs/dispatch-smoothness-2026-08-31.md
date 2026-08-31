# Dispatch smoothness verification — 2026-08-31

## Result

The best general dispatch surface on this machine is the `llm-relay` MCP `dispatch` tool. It is
the only installed entry point that both chooses the configured ladder and owns the process
mechanics:

- direct children start with `windowsHide: true`;
- stdin is closed after every direct or shell-fallback spawn;
- configured lane environment and timeouts are applied in one place;
- `.cmd` fallback, output capture, cancellation, and slow-job handles are centralized;
- the caller receives an answer or pollable job instead of reconstructing a command.

Behavioral tests now cover those spawn contracts on the direct and Windows `ENOENT` fallback paths.
This is a guarantee about children created by the MCP server, not a guarantee that a third-party CLI
cannot independently create a visible descendant.

Both `claude mcp list` and `codex mcp list` reported `llm-relay: llm-relay mcp` connected.

## Owner decision: one entry point, not a host quiz

The portable rule is now explicit on every model-facing surface: if the MCP tools are present,
call `dispatch`; if they are absent, run `llm-relay dispatch --next-command -t "<task>"` and obey
the returned command or target. The caller never decides from “Claude vs Codex,” “CLI vs desktop,”
or its own guess about provider reachability.

This closes the Codex Desktop contradiction. Releases through v0.68.4 installed `default` and
`relay_coding` agents whose `model_provider = "llm-relay"` / `model = "pool/medium"` looked like the
preferred split-provider route. Desktop's ChatGPT collaboration launcher rejects that model before
the custom provider is contacted, so the relay can do nothing with the request. Global install now
registers the MCP server in Codex config and retires only byte-identical legacy generated agents;
user-edited files remain untouched. The always-loaded MCP instructions, shipped skill, CLI help,
README, quick start, and reference all name the same rule and the Desktop boundary.

Friction recorded during this correction: MCP survey job `job-0001` on `claude-free-pool`
(`pool/medium`) returned no answer after 1,594 seconds and was cancelled. Its output was never used
as evidence. The bounded follow-up is in [`backlog.md`](backlog.md); the symptom alone does not say
whether the delay was pool walking, provider thinking, or an agent loop.

The closeout exposed a second symptom on the same lane family: `pool/high` job `job-0002` exited 0
after 75 seconds, but `dispatch_result` contained only `Based on the evidence`. That incomplete
fragment was not used for the closeout audit.
An independent collaboration audit was started, but its now-obsolete closeout was interrupted when
the owner extended the lap; neither audit produced evidence used for a conclusion. The backlog
investigation must distinguish a truncated provider completion from lane-output capture or MCP
job-storage loss instead of treating exit 0 as proof that a usable answer returned.

Tutor-sync then exposed a separate instruction-delivery failure: the installed primary relay skill
was 46.9 KB / 724 lines, larger than one tool response. Its mandatory complete read was truncated,
so the agent correctly paused before mutating its lap record. The primary guide is now 7.7 KB / 128
lines and retains the universal MCP-first decision; advanced direct routing, dispatch-lane, and
operations guidance moved verbatim into three bounded references loaded only for the relevant task.
Postinstall copies and tests the four-file bundle on Claude, Codex, and OpenCode.

## Verified routing matrix

| Target | Preferred route | Fallback | Verified state |
|---|---|---|---|
| Relay pools / cheapest capable lane | MCP `dispatch`, normally without forcing a lane | `llm-relay dispatch --next-command -t <task>` when MCP is unavailable | Live MCP dispatches completed. The ladder remains free-pool-first, with restored AGY lanes behind the free pool. |
| Claude CLI / Anthropic subscription | From another host, MCP dispatch or `claude -p` with an explicit route | [`scripts/claude-proxied.ps1`](../scripts/claude-proxied.ps1) for an explicitly relay-routed Claude CLI | Claude Code 2.1.237 is installed, but the owner's subscription transition currently blocks a full Claude→MCP→AGY proof. A hidden auth-failure launch created no terminal event. Transposed Claude lanes configure the three long-think idle-timeout overrides. |
| Codex | The current Codex task or the first-party Codex plugin; MCP dispatch for cheap offload | `acpx codex exec` from another host | Codex 0.151.0 is installed. Native Codex Desktop collaboration rejects a `pool/medium` child before it reaches the custom provider, so MCP dispatch is the working split-provider route. |
| AGY | MCP `dispatch` through `lane-launch.ps1`; force `lane: agy-gemini` only when AGY is wanted deliberately | A human may use the absolute headless CLI from an already-open terminal | Codex→MCP→AGY returned `AGY_CODEX_DISPATCH_OK` in 9 seconds with no AGY-associated top-level or foreground window. All 12 rows and autonomous probes are enabled. Direct `agy.exe` from console-less automation remains prohibited. |
| OpenCode | `acpx --no-terminal --no-fs ... opencode exec <task>` | `opencode run <task>` from an existing console | Repaired global install; OpenCode 1.18.25. A real ACP turn returned `OPENCODE_ACP_OK` in 13.15 seconds. |
| Gemini CLI | ACP or direct CLI after authentication is configured | AGY Gemini through MCP `dispatch` | Gemini 0.57.0 is installed, but ACP and direct CLI both report that no Gemini authentication method/API key is configured. The `agy-gemini` lane is ready. |

The installed agent-CLI inventory is Claude, Codex, AGY, Gemini, and OpenCode. Common Qoder,
Qwen, Trae, Goose, Aider, Copilot, Cursor Agent, Amazon Q, Pi, Amp, Crush, Kiro, OpenClaw,
Fast-Agent, and ZeroClaw command names were not installed.

## Machine defects fixed

### 1. `agy` launched the Antigravity desktop application

The PowerShell profile defined:

```powershell
function agy { & "C:\Users\<user>\AppData\Local\Programs\Antigravity\Antigravity.exe" @args }
```

That made ordinary inventory commands such as `agy --version` launch the Electron GUI. The binding
now points to the separate headless CLI:

```powershell
function agy { & "C:\Users\<user>\AppData\Local\agy\bin\agy.exe" @args }
```

A fresh PowerShell resolves `agy.exe` to the headless binary and `agy models --help` returned CLI
help. The Antigravity GUI log proves the last GUI start occurred at `2026-08-31 10:55:54`, before
the profile repair, and its language server shut down at `10:58:37`. No later GUI-log write or
`Antigravity.exe` process was observed.

### 2. `opencode` was hidden by a broken alias and an incomplete install

The same profile aliased `opencode` to nonexistent `opencode-cli`, hiding the real npm shim. The
alias was removed. The global `opencode-ai` package then exposed a 479-byte placeholder
`bin/opencode.exe` because postinstall had not run. Running the package's own `postinstall.mjs`
installed the 179,651,624-byte binary; `opencode --version` now returns `1.18.25`.

### 3. The hidden launcher parsed only one option

`lane-launch.ps1 --timeout 30 --diagnose ...` consumed `--timeout`, then treated `--diagnose` as
the child command. Its option loop now uses an explicit PowerShell loop label. A focused launcher
check completed with exit 0 and emitted its diagnostic line.

### 4. AGY quarantine, attribution correction, and revalidation

A forced MCP AGY dispatch returned a valid answer and did not relaunch the Antigravity GUI, but the
user observed a transient terminal window while several delegated investigations were concurrent.
The first forensic pass found one delegate had directly run `agy --version` and `agy --help`, so the
machine was quarantined while the observation remained unisolated.

The later report has now been corrected from timestamps. The user report was recorded at
`13:09:51.579`; the `audit-code.mjs` → `conhost.exe` process originally blamed for it was not created
until `13:10:40.529`, so it cannot be the cause. AGY's instrumented interval had ended at `13:08:20`.
The closest process match was a concurrent Codex task startup at `13:09:20–22`. Process-creation
auditing was unavailable, so that is the strongest temporal match rather than definitive window-
handle proof.

The temporary mitigation was deliberately broader than `enabled: false` on ladder rows:

- all 12 AGY entries across `low`, `medium`, `high`, and `xhigh` are disabled;
- `routing.laneProbe.enabled` is false because the background cadence probes disabled rows too;
- direct AGY invocation is prohibited during quarantine, including `agy --version` and `agy --help`;
- the hidden relay service was restarted and resumed listening on `127.0.0.1:8791`;
- a ten-minute watcher after quarantine observed no new visible windows; a restart-specific watcher
  later also observed none.

The owner then authorized the exact exit test. Codex Desktop called the `llm-relay` MCP `dispatch`
tool with `lane: agy-gemini`; job `job-0006` returned exactly `AGY_CODEX_DISPATCH_OK` in 9 seconds.
The watcher recorded `agy.exe`, `lane-launch.ps1`, their console-host descendants, and the parent MCP
server, but no `PseudoConsoleWindow`, `CASCADIA_HOSTING_WINDOW_CLASS`, `ConsoleWindowClass`, other
AGY-associated visible window, or foreground transition.

That passed the quarantine's stated condition. All 12 AGY rows and `routing.laneProbe.enabled` are
enabled again. The daemon restarted from the hidden Startup VBS and a 60-second watcher recorded no
new visible window or foreground transition. `agy-gemini` reports ready; the Claude-backed AGY
buckets keep their measured cooldowns. Automated Codex and Claude callers must still use MCP
`dispatch`; direct `agy.exe`, including help/version probes, bypasses the hidden launcher.

## Focus-safety evidence and limits

- `src/mcp/lane-runner.ts` is the canonical MCP execution path. It sets `windowsHide: true` and
  closes stdin on both direct and shell-fallback children. New fake-child tests prove the options,
  the 16 MiB output cap, and stdin closure without spending lane quota.
- `src/lane-probe.ts` and `src/lane-quota-probe.ts` independently carry immediate-child hiding and
  stdin closure. Their cadence is disabled while AGY is quarantined.
- `acpx@0.13.1` sets `windowsHide: true` on its agent spawn. `--no-terminal` controls capabilities
  advertised to the agent; it is not the window-suppression mechanism.
- `agy.exe` is a console-subsystem executable with no window-suppression flag. The existing
  `lane-launch.ps1` applies `CreateNoWindow=true` to the immediate AGY process. The instrumented
  Codex→MCP→AGY run found no visible helper descendant; direct console-less invocation remains an
  unsupported bypass of that evidence.
- `MainWindowHandle` is insufficient evidence: prior measurements found AGY's
  `PseudoConsoleWindow` and the focus-stealing Windows Terminal window belonged to different
  processes. Verification must enumerate top-level windows by PID and class while the lane runs.

## Remaining boundary

`llm-relay dispatch --next-command` intentionally returns a command instead of executing it. It is
the no-MCP fallback, but a console-less caller must still use a hidden process host. Copying the
command into arbitrary shell automation loses the MCP server's process guarantees.

Claude's full host-level MCP→AGY proof remains pending because the owner's subscription transition
temporarily blocks Claude Code. The hidden Claude launch reached the authentication error without a
terminal event, but no AGY child was started, so it is not an end-to-end proof and not an AGY
failure. New MCP server processes load the restored ladder; already-running processes may keep the
startup snapshot until their host session restarts.

## Release and live verification

- Implementation commit `5554bfa` and release commit `9d62a6d` shipped as `v0.68.3`; the final
  attribution correction and reviewer cleanup ship as `v0.68.4`.
- Feature CI run `33428200248`, final cleanup CI run `33431526327`, and `v0.68.4` publish run
  `33431851853` succeeded.
- The npm registry and reinstalled global binary report `0.68.4`.
- The post-revalidation live config enables all 12 AGY rows and autonomous probes; its SHA-256 is
  `DB6A53A5E447E6DF7781D66557AD957F5C312770A519623C88BA5355C244FC64`.
- The final hidden Startup restart produced zero new visible windows and zero foreground
  transitions during a 60-second watch.
- Non-AGY MCP job `job-0005` completed through `claude-free-pool` (`pool/medium`) with exit 0.
- Codex→MCP→AGY job `job-0006` completed through `agy-gemini` in 9 seconds with the exact expected
  answer and no AGY-associated top-level or foreground window.

One delegated release monitor used an unauthenticated public GitHub REST request and received a 404
for the private repository. The authenticated `gh run view` path returned the authoritative workflow
state and should be used for future delegated release checks.
