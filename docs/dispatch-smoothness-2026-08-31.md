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

## Verified routing matrix

| Target | Preferred route | Fallback | Verified state |
|---|---|---|---|
| Relay pools / cheapest capable lane | MCP `dispatch`, normally without forcing a lane | `llm-relay dispatch --next-command -t <task>` when MCP is unavailable | Live MCP dispatches completed. The ladder is currently free-pool-first because AGY is quarantined. |
| Claude CLI / Anthropic subscription | From another host, MCP dispatch or `claude -p` with an explicit route | [`scripts/claude-proxied.ps1`](../scripts/claude-proxied.ps1) for an explicitly relay-routed Claude CLI | Claude Code 2.1.237 is installed and authenticated. Transposed Claude lanes configure the three long-think idle-timeout overrides. Claude ACP uses the Agent SDK, not the installed CLI subscription path. |
| Codex | The current Codex task or the first-party Codex plugin; MCP dispatch for cheap offload | `acpx codex exec` from another host | Codex 0.151.0 is installed. Native Codex Desktop collaboration rejects a `pool/medium` child before it reaches the custom provider, so MCP dispatch is the working split-provider route. |
| AGY | Disabled pending instrumented window revalidation | Once reverified: MCP dispatch through `lane-launch.ps1` and the absolute headless CLI path | AGY has no ACP agent. All 12 AGY ladder entries and autonomous lane probes are disabled after a terminal was observed while an MCP run and direct AGY probes were concurrent; the source was not isolated. |
| OpenCode | `acpx --no-terminal --no-fs ... opencode exec <task>` | `opencode run <task>` from an existing console | Repaired global install; OpenCode 1.18.25. A real ACP turn returned `OPENCODE_ACP_OK` in 13.15 seconds. |
| Gemini CLI | ACP or direct CLI after authentication is configured | None currently | Gemini 0.57.0 is installed, but ACP and direct CLI both report that no Gemini authentication method/API key is configured. AGY Gemini is not a fallback while AGY remains quarantined. |

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

### 4. AGY was quarantined after a contradictory live observation

A forced MCP AGY dispatch returned a valid answer and did not relaunch the Antigravity GUI, but the
user observed a transient terminal window while several delegated investigations were concurrent.
A forensic audit of every delegate then found one had directly run both `agy --version` and
`agy --help`; no other delegate launched AGY or another peer-agent CLI. The AGY CLI log was last
written at `2026-08-31 11:40:30`. Because `agy.exe` is a console-subsystem executable, either direct
probe is itself sufficient to explain a transient console from a windowless parent. The observation
therefore cannot be attributed specifically to the MCP AGY lane. A process scan after completion
could not identify the already-exited window owner, so focus safety remains unproven.

The live mitigation is deliberately broader than `enabled: false` on ladder rows:

- all 12 AGY entries across `low`, `medium`, `high`, and `xhigh` are disabled;
- `routing.laneProbe.enabled` is false because the background cadence probes disabled rows too;
- direct AGY invocation is prohibited during quarantine, including `agy --version` and `agy --help`;
- the hidden relay service was restarted and resumed listening on `127.0.0.1:8791`;
- a ten-minute watcher after quarantine observed no new visible windows; a restart-specific watcher
  later also observed none.

This preserves the AGY installation and credentials while ensuring automatic dispatch cannot start
it. Re-enable only after one instrumented run shows no `PseudoConsoleWindow`,
`CASCADIA_HOSTING_WINDOW_CLASS`, `ConsoleWindowClass`, or other visible descendant.

## Focus-safety evidence and limits

- `src/mcp/lane-runner.ts` is the canonical MCP execution path. It sets `windowsHide: true` and
  closes stdin on both direct and shell-fallback children. New fake-child tests prove the options,
  the 16 MiB output cap, and stdin closure without spending lane quota.
- `src/lane-probe.ts` and `src/lane-quota-probe.ts` independently carry immediate-child hiding and
  stdin closure. Their cadence is disabled while AGY is quarantined.
- `acpx@0.13.1` sets `windowsHide: true` on its agent spawn. `--no-terminal` controls capabilities
  advertised to the agent; it is not the window-suppression mechanism.
- `agy.exe` is a console-subsystem executable with no window-suppression flag. The existing
  `lane-launch.ps1` applies `CreateNoWindow=true` to the immediate AGY process. The current open
  question is whether AGY or one of its helpers creates a separate visible descendant.
- `MainWindowHandle` is insufficient evidence: prior measurements found AGY's
  `PseudoConsoleWindow` and the focus-stealing Windows Terminal window belonged to different
  processes. Verification must enumerate top-level windows by PID and class while the lane runs.

## Remaining boundary

`llm-relay dispatch --next-command` intentionally returns a command instead of executing it. It is
the no-MCP fallback, but a console-less caller must still use a hidden process host. Copying the
command into arbitrary shell automation loses the MCP server's process guarantees.

The AGY quarantine remains pending one explicitly authorized, instrumented revalidation. Until
then the cleanest behavior is to skip AGY and use the relay pool, Codex, Claude, or OpenCode route.

## Release and live verification

- Implementation commit `5554bfa` and release commit `9d62a6d` shipped as `v0.68.3`; the final
  attribution correction and reviewer cleanup ship as `v0.68.4`.
- Feature CI run `33428200248`, final cleanup CI run `33431526327`, and `v0.68.4` publish run
  `33431851853` succeeded.
- The npm registry and reinstalled global binary report `0.68.4`.
- Reinstall preserved the config hash and the 12-row AGY quarantine.
- The hidden Startup restart produced zero new visible windows during a 12-second watch.
- Non-AGY MCP job `job-0005` completed through `claude-free-pool` (`pool/medium`) with exit 0.

One delegated release monitor used an unauthenticated public GitHub REST request and received a 404
for the private repository. The authenticated `gh run view` path returned the authoritative workflow
state and should be used for future delegated release checks.
