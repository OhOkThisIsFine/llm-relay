# Windows lane-orphan measurement — 2026-09-19

## Question

When the Windows host force-kills the `llm-relay mcp` process, does a lane process that was
already in flight survive independently long enough to finish?

This is stabilization packet S4 from
[`stabilization-plan-2026-09-17.md`](history/stabilization-plan-2026-09-17.md). It is a
measurement, not a behavior change.

## Method

Measured on GitHub Actions `windows-latest`, Node 22, against commit
`13d2764160e04b891e25a73462e86a7140b30cfd` in CI run `35473201811`.

The retained harness is [`../scripts/measure-lane-orphan.mjs`](../scripts/measure-lane-orphan.mjs).
It:

1. rebuilds/uses the real `dist/cli.js` and starts `llm-relay mcp` with an isolated temporary
   config and unused loopback port;
2. configures one real `cli` ladder rung whose command is Node running a temporary fake-lane
   script;
3. dispatches that rung through the MCP `dispatch` tool;
4. the fake lane writes its PID, then intends to append one line per second for 60 seconds;
5. after the first output line exists, runs exactly `taskkill /PID <mcp-pid> /F` — deliberately
   **without** `/T`;
6. checks the lane 500 ms later and counts its final output.

## Result

The CI measurement emitted:

```text
LANE_ORPHAN_MEASUREMENT {"platform":"win32","mcpPid":2900,"lanePid":5152,"laneAliveAfterMcpKill":false,"laneProcessExited":true,"laneFinished":false,"outputLines":1,"expectedLines":60,"elapsedMs":2417}
```

So, on Windows:

- the lane was **not alive** 500 ms after the MCP parent was force-killed;
- the lane process had exited;
- it **did not finish** its intended workload;
- only **1 of 60** expected lines reached disk.

## Decision input for D1

The current lane launch does **not** survive the MCP parent on Windows. Re-adoption alone cannot
preserve in-flight work, because there is no live process left to adopt.

D1 therefore needs a detached launch or equivalent independent process-lifetime mechanism before
the next MCP process can safely re-adopt a running lane. The existing running-job journal remains
useful for reporting/recovery metadata, but journaling by itself cannot prevent this loss.

This result says nothing about the exact detachment design, PID-reuse defense, output-file
ownership, or reap semantics; those remain D1 design work.
