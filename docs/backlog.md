# Backlog — llm-relay

> The work queue. Each entry states an unmet **Property** and is deleted once that property is
> met. Shipped work lives in git history and in the dated documents under `docs/`;
> [`../HANDOFF.md`](../HANDOFF.md) holds current state plus the immediate next; `CLAUDE.md` holds
> invariants and rationale. Nothing here is a status log. A machine-wide item (a global hook, a
> shared instruction file, the offload lanes themselves) belongs in `C:\Code\docs\backlog.md`,
> not here.

## Open

- **A pre-commit stream failure names no cause, and the relay keeps no per-request record of it
  (2026-09-10, C:\Code lap 232d8bef, medium).** A streamed `deepseek/deepseek-flash` request that
  spent its whole `max_tokens` on reasoning (the V4.1 Flash default before v0.79.0's
  `compat.reasoning`) answered `502 stream completed without meaningful content`. The real cause —
  a `length`/`max_tokens` stop with reasoning-only content — was visible only by re-sending the
  request directly. With `log.file` null (the default) and `/telemetry` carrying no per-request
  rows, the relay had nothing to diagnose it from. **Property:** a pre-commit empty-stream failure
  in `stream-commit.ts` names the upstream stop reason when one was sent (for example "the backend
  stopped at max_tokens after N reasoning tokens and no text"), and that reason reaches the
  served error and the metadata log.

- **An OpenCode lane that dies on a stream error in its first second stays `running` until its
  timeout (2026-09-10, C:\Code lap 232d8bef, medium).** Muse Spark job-0017 logged `stream error` in
  `~/.local/share/opencode/log/opencode.log` in its first second and produced nothing more; the
  process stayed alive and `dispatch_status` reported `running` for 9+ minutes, until it was
  cancelled by hand. v0.80.0's process-tree reaping ends the process at the budget but does not
  shorten the wait. **Property:** a lane that has produced no output and whose harness has stopped
  making progress is reported as failed well before `timeoutMs`, with the reason, or
  `dispatch_status` states how long the lane has been silent so the caller can decide.

- **The dispatch walk abandons the only working lane, then tells the agent to stop (2026-09-10,
  live diagnosis, high).** At tier `medium` the walk gives `free-pool` the 90 s `attemptMs` floor:
  its window holds 100 short answer-mode calls (p80 39.5 s), an abandoned run adds no sample so the
  p80 can never rise above the budget, and a `timed_out` run does add one (so
  `opencode-muse-spark`, 0 of 12 at `medium`, earned a 900 s budget). The walk then runs lanes that
  cannot answer and ends on `anthropic`. Evidence and the full plan:
  [`dispatch-giveup-diagnosis-2026-09-10.md`](dispatch-giveup-diagnosis-2026-09-10.md) §3 and §9
  F1–F2. **Property:** `runWalk` never abandons a lane at its budget while no later lane in the
  selection order has answered in its recent record; the budget window is keyed by dispatch mode
  and fed only by `completed` runs; and an abandoned run raises the lane's next budget (bounded by
  its timeout) instead of leaving the window unchanged.

- **The MCP walk selects the `anthropic` pass-through rung, which the MCP server cannot run
  (2026-09-10, live diagnosis, high).** `resolveDispatchView` states `host: "bypassed"`, and `toLane`
  keeps a pass-through rung for that host because a bypassed host has an `Agent` tool; the MCP
  server has none. Agent mode fails in 0 s with "no cliLane template configured" (false: the
  template exists), answer mode with HTTP 401. 0 of 21 runs answered, and as the last lane its error
  heads the final reply. Diagnosis §4, plan F3. **Property:** the MCP view marks every rung that the
  MCP server cannot run `unreachable` with a true reason, so no walk attempt runs one; and
  `startLane`'s default text never claims that a configured template is missing.

- **`LANE_LADDER_EXHAUSTED_ADVICE` tells agents to stop dispatching after a working lane was
  stopped, or after one forced lane ran (2026-09-10, live diagnosis, high).** `jobAnswer` prints "Do
  NOT call dispatch again … Do the work in this session instead" whenever nothing answered and no
  lane is untried — including after the walk abandoned `free-pool` mid-run and after a one-lane
  `lane:` override (jobs 0023 and 0024 on 2026-09-10). `MCP_INSTRUCTIONS` repeats it, and says "the
  default lane is free capacity", which the operator config made false on 2026-09-10 (paid DeepSeek
  is first in every pool). Diagnosis §5, plan F4. **Property:** the stop advice appears only when
  every lane in the ladder ran and failed on its own; an abandoned lane is named with the call that
  lets it finish; a forced one-lane run says that only that lane ran; and `MCP_INSTRUCTIONS` makes no
  cost claim that the operator config can make false.

- **`dispatch` cannot run a named model, so agents that must use DeepSeek go around it (2026-09-10,
  live diagnosis, high).** `dispatch` takes a rung id and a tier only, and no rung names the direct
  `deepseek` provider. The lap-232d8bef orchestrator wrote its own HTTP client (`plan.mjs`, posting
  `deepseek/deepseek-flash` to `/v1/chat/completions`) to reach it. Diagnosis §7, plan F5.
  **Property:** `dispatch` accepts a routing spec (`model`) and runs exactly that spec — posted as
  `model` in answer mode, rendered into the `routing.cliLane` template in agent mode — with no walk,
  and the reply names the spec that served.

- **An AGY lane's quota death reaches the relay only when a run lasts until AGY gives up
  (2026-09-10, live diagnosis, medium).** AGY logs `RESOURCE_EXHAUSTED … Resets in 144h` to
  `~/.gemini/antigravity-cli/cli.log` and retries in silence. The walk kills it at 90 s, so
  `agy-claude-opus` stayed `ready` through 34 failed runs, until one forced 604 s probe recorded the
  death. No rule demotes a lane with a long run of zero successes. Diagnosis §4, plan F6.
  **Property:** when the walk stops or ends an AGY lane whose run logged `RESOURCE_EXHAUSTED`, the
  relay records a quota death with the stated reset; and a lane with no success in its last N runs
  is demoted until a probe answers. Change the AGY launch path only after the console-window fix of
  2026-09-10 lands, because both touch it.

- **`/telemetry` labels a provider with no `tierType` as free, and DeepSeek attempts run unhedged
  for up to 10 minutes (2026-09-10, live diagnosis, medium).** `getTelemetryReport` falls back
  `p.tierType ?? preset?.tierType ?? "free"`, so paid DeepSeek reads `free` while `assessCost` says
  `unknown`. A DeepSeek attempt gets no hedge (hedging is for free deployments), and the operator
  config gives `deepseek` a `timeoutMs` and a `stallTimeoutMs` of 600,000 while DeepSeek is the first
  member of every pool. Diagnosis §7, plan F7. **Property:** the telemetry label for an undeclared
  tier is `unknown`, never `free`; and a stalled DeepSeek attempt fails over within a bound that the
  operator states in minutes (the bound is an operator-config change and an owner decision).

- **A running dispatch's status gives no expected duration, so agents stop polling (2026-09-10, live
  diagnosis, low).** `dispatch_status` shows the lane and the elapsed time only, while `free-pool`
  agent-mode runs at tier `high` took up to 2,700 s on 2026-09-10 (median 778 s). Diagnosis §9, plan
  F8. **Property:** the status of a running job states the lane's usual time to answer in the job's
  mode (p50 and p80 from completed runs), or says that no record exists.

- **A dispatch call waits longer than some hosts allow, so the caller loses the job handle
  (2026-09-10, transcript sweep, high).** Codex's code-mode `exec` tool returns "Script running with
  cell ID N / Wall time 31.0 seconds" with empty output, so a dispatch that blocks for the 40 s
  `routing.mcp.maxWaitMs` default loses its job id: 29 of 266 first Codex dispatch calls since
  2026-09-07. In Claude Code, a call with `waitMs: 60000` at 15:14 on 2026-09-10 failed with "Error:
  Request timed out"; the MCP process that served it was most likely one started before v0.78.0,
  which honours a wait above the host ceiling (inference from process start times, not measured).
  Diagnosis Appendix A, plan F9. **Property:** the blocking wait of every dispatch call ends before
  the lowest host ceiling measured on this machine (Codex: 31 s), and an `llm-relay mcp` process
  that runs older code than the installed version says so in every reply.

- **DeepSeek refuses a multi-turn tool-call replay from the relay with HTTP 400 because the relay
  drops `reasoning_content` between turns (2026-09-09, DeepSeek capture, medium).** In thinking
  mode DeepSeek requires the `reasoning_content` of the assistant turn that made a tool call to be
  replayed with that turn. `openai-request.ts` drops `thinking`/`redacted_thinking` cross-vendor
  ("no representation") and `responses-request.ts` drops Codex's `reasoning` items, so the third
  capture run in
  [`deepseek-responses-truncation-2026-09-09.md`](deepseek-responses-truncation-2026-09-09.md)
  ended at HTTP 400 after one or two tool-call turns. A representation EXISTS for this provider:
  Chat `reasoning_content` on the outbound assistant message. (The same capture's other ancillary
  finding, DeepSeek naming Codex's `exec` argument `cmd`/`command` as a bare string, is the
  model's own shape error and repair mode's business, not a relay defect.) **Property:** on a
  target whose provider declares it (a `compat` key on the `toolCallIds` precedent, defaulting from
  a labelled host fact for `api.deepseek.com`, an explicit value winning both ways), the reasoning
  the relay itself emitted for an assistant turn — a Responses `reasoning` item or an Anthropic
  `thinking` block the CALLER replays — is carried as `reasoning_content` on that outbound
  assistant message byte-for-byte and never fabricated when absent, pinned on ≥2 candidates, with
  every other provider's outbound bytes unchanged.

- **CLOSED 2026-09-10 by owner decision: 24 of the 25 triaged refusal verdicts are applied.** The
  triage is [`eligibility-triage-2026-09-09.md`](eligibility-triage-2026-09-09.md), which carries
  every verdict pinned to its digest. The owner chose "run 24; skip the kimi-k3 eviction", so
  eighteen `accept` and six `reject` commands ran: three groq per-minute throughput limits and one
  OpenRouter free-models-per-minute limit as `rate-limited`; four gemini free-tier quotas as
  `allowance-exhausted` filtered to free deployments; two OpenRouter batch-only SKUs as
  `not-servable`; seven ollama-cloud paid-plan SKUs as `subscription-required`; and six generation
  failures and bare 429s rejected as teaching the router nothing. ⚠ **The digest pin earned its
  keep in the doing:** the queue reordered under six of the commands and each one reported
  `--sig <digest> now sits at position N, acting on it` — an index-only accept would have landed
  those six verdicts on the wrong refusal.
  **Two items remain pending on purpose, and both are the stated verdict, not an omission:**
  item 1, the groq client-side network block, which `network-block.ts` says never to reject because
  rejecting suppresses the signature for good; and item 3, `nim/moonshotai/kimi-k3`'s 48 × "degraded
  function cannot be invoked", which the owner declined so the model stays in the walk and a
  recovery can show up as a real success. The cost of that choice, stated: the relay keeps spending
  one attempt per walk on that deployment.
  ⚠ **Three NEW unrecognized refusals arrived during this closeout and have no verdict** —
  `opencode/muse-spark-1.3-contributor-free` 429 ×5 and `opencode/mimo-v2.5-free` 429 ×1 (both
  produced by this closeout's own route-B probes), and `nim/deepseek-ai/deepseek-v4-flash-0731`
  400 "degraded function cannot be invoked" ×2, which is the same wording as item 3 on a different
  NIM deployment. **Property:** each of the three carries a verdict the owner accepted or rejected,
  or a recorded reason for staying pending.

- **Route B reaches the vendor; the SERVED half waits for the free allowance to refill**
  (route B shipped 2026-09-09: `wire: "responses"` on a `kind: "openai"` provider, `src/backend.ts`;
  tests in `test/backend-responses-upstream.test.ts`). Everything this entry asked for except a
  200 is now measured. **Done and recorded 2026-09-10:** the daemon runs v0.78.0 (restarted from
  `Startup\llm-relay.vbs`, PID 28920); `~/.llm-relay/config.json` declares
  `providers.opencode.wire: "responses"`, pins `opencode/muse-spark-1.3-contributor-free` first in
  `routing.pools.medium.preferred`, and carries `maxConcurrent: 1` on all four
  `opencode-muse-spark` rungs (backup `config.json.bak-2026-09-09-pre-v0.78.0-route-b`); and a
  STREAMED request carrying a tool, sent on BOTH fronts (`/v1/messages` and `/v1/responses`),
  egressed to OpenCode Zen on the Responses wire and came back
  `x-llm-relay-served-by: opencode/muse-spark-1.3-contributor-free`,
  `x-llm-relay-error-origin: upstream`, each front's own native error envelope, and
  `x-llm-relay-probation: opencode/muse-spark-1.3-contributor-free (0 of 5 request samples)`.
  ⚠ The upstream answer was `HTTP 429 FreeUsageLimitError: Rate limit exceeded` on both. That is
  the vendor's free contributor allowance, spent by the six Muse Spark packets this machine
  dispatched on 2026-09-09 — not a relay fault, and a 429 proves egress but not translation.
  **Property (what remains):** with the allowance refilled, one request per front through
  `pool/medium` is SERVED (HTTP 200) by that deployment with a tool call and streaming, and
  `llm-relay cost` shows its `cached_tokens`. Recorded with the served-by header and the date.

- **Verify the Codex `relay` agent end to end in Codex Desktop** (owner-driven, 2026-09-04).
  Commit `e73d113` added `~/.codex/agents/relay.toml` via `scripts/install-skill.mjs`; standalone
  `codex exec` exposes no MCP tools, so only a live Codex Desktop session driven by the owner can
  verify it. **Property:** one Codex Desktop `relay` subagent reply carries a `provenance:` line
  (e.g. spawning `relay` with "read C:\Code\llm-relay\package.json and reply version=<field>"
  returns the version and provenance from a dispatch lane).
