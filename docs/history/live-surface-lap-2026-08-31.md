# Live-surface lap — 2026-08-31

## Goal and baseline

Exercise every llm-relay surface live — CLI commands, HTTP endpoints, MCP tools, dispatch lanes,
`delegate-gate`, and a free-lane audit fan-out — then verify each finding against source and fix or
file what survives.

The lap started at `bc75bb5807ff3f4a98017151336ffdeb8a9bd763`, where `npm run check` was green.
This document records the working-tree evidence; final gate and release evidence are added only
after they complete.

## Coverage

| Surface | Exercise and result |
| --- | --- |
| CLI | Safe read commands were exercised. `llm-relay telemetry` reported `healthy=0, unmeasured=15` from a fresh process while the running relay's `/telemetry` reported `healthy=7, unmeasured=7`; the command now reads the live relay first and falls back locally. Unknown and wrong-command options are now rejected before configuration, network, or provider side effects. |
| HTTP | Both protocol fronts and documented aliases were reviewed. `POST /v1/messages-prefix-lookalike` returned 502 before the fix because the Anthropic translator accepted a prefix; the route now requires exact `/v1/messages`, and the focused parameterized test passes for `/` and the lookalike. |
| MCP | `dispatch`, `dispatch_lanes`, `dispatch_status`, `dispatch_result`, and `dispatch_cancel` were exercised. `job-0003` was observed running, cancelled, and then observed as `cancelled`. Focused MCP tests cover sync and async completion, polling, cancellation, semantic failure, and report-before-exposure ordering. |
| Dispatch lanes | A low-tier AGY lane completed a hedge-diff review with `No issues.` A separate running job exercised the status/result/cancel lifecycle. Lane answers remained advisory and were checked against source/diffs. |
| `delegate-gate` | A clean diff exited 0. A deliberately tautological fixture exited 1 with four findings. The focused delegate-gate set ran 13 files / 162 tests green. |
| Free audit fan-out | Free capacity was used for independent CLI, HTTP, MCP, documentation, and provider-integration reviews. Surviving claims were checked with exact source reads and targeted `rg`. |

## Findings and fixes

1. **Hedge minimum sample count used a different population than its p90.**
   `getP90` measures only `MEASURABLE_CODES`, while the absolute hedge rung counted every probe
   record. Four 503 records plus one slow 200 could therefore unlock a statistic resting on one
   measurement and suppress the floor hedge. The rung now counts measurable probes. The new test
   was red before the fix; 70 hedge/latency tests were green afterward.

2. **The Anthropic messages route accepted prefix lookalikes.**
   `pathname.startsWith("/v1/messages")` admitted `/v1/messages-prefix-lookalike`, while downstream
   client selection did not classify that path as Anthropic. The predicate is now the exact route.
   Live/focused red evidence was 502 before the fix; the focused server case is green afterward.

3. **Several CLI commands silently accepted options they did not consume.**
   Examples included `telemetry --bogus`, `pools --proeb`, and a misspelled dispatch option. A
   value-free command/action option policy now rejects unsupported options before side effects,
   preserves the strict `keys`/`cooldowns` parsers and help/version behavior, and is pinned to the
   complete command vocabulary. The same pass corrected update-check classification:
   `dispatch --exhausted` persists exhaustion and `delegate-gate --fix` writes a patch, so both are
   mutating forms.

4. **CLI telemetry observed a cold process instead of the running relay.**
   The measured `0/15` versus `7/7` discrepancy was runtime-state drift, not a version mismatch.
   `runTelemetry` now reads authenticated live `/telemetry` when available and uses the previous
   local report only as a failure fallback.

5. **MCP dispatch discarded positive quota evidence.**
   An AGY lane can exit 0 with a structured `Individual quota reached` error. MCP previously marked
   that job complete and never updated the daemon's persistent exhaustion state. Settlement now
   narrowly recognizes the AGY structured sentinel, reuses the existing classifier for explicit
   nonzero quota/rate failures, reports the outcome once through authenticated `POST /dispatch`
   before exposing completion, and presents the job/MCP result as failed. Successful answer prose
   mentioning quota, unknown failures, timeouts, and caller cancellations do not create evidence.

6. **The user-facing reference omitted or misstated live surfaces.**
   The reference and CLI help now cover setup's optional target, pool list/show aliases, eligibility
   rejection, OpenAI route aliases/model discovery, protected `/health/stats`, dashboard `HEAD`
   support, and the provider-health meaning of telemetry.

## Environment and verification limits

- The codebase-memory MCP transport was closed during this lap. Tier Verify therefore used exact
  source paths and targeted `rg`; no negative or exhaustive graph claim is made.
- Codex desktop collaboration 0.151.0 ignored the installed child's `model_provider` and rejected
  `pool/medium` against the parent ChatGPT account before llm-relay was contacted. In-app work used
  MCP `dispatch` instead. The version-specific host limitation is recorded in the bundled skill,
  reference, and the machine-wide backlog; generated agent profiles remain useful to clients that
  honor custom providers.
- The first relay-backed collaboration attempts failed before doing work. They are host-integration
  failures, not findings about the delegated code.

## Verification state

The complete recorded repository gate is green on the implementation tree:

- server suite: 144 files, 2,839 passed and 5 skipped;
- dashboard suite: 5 files, 32 passed;
- package checks: 913,598 packed bytes, 4,777,716 unpacked bytes, 365 entries, and packed smoke
  passed;
- separate focused evidence: 4 CLI/server/hedge/MCP files with 227 tests, plus the 13-file /
  162-test `delegate-gate` set described above.

The final documentation-tree gate is also green. Final release/live verification is complete:
commit `e5fcdd8` released v0.68.1 via
[publish run](https://github.com/OhOkThisIsFine/llm-relay/actions/runs/33412435087); npm registry
`latest` is 0.68.1, and the global executable is 0.68.1. The running daemon is PID 46012. A warm
`pool/low` request returned 200 via `nim/moonshotai/kimi-k3`; the hedge fired and the primary won
after the 20-second floor. The prefix-lookalike route returned 404, and `telemetry --bogus` exited
1. CLI telemetry agrees with HTTP telemetry aside from the volatile timestamp and cooldown
countdown.
