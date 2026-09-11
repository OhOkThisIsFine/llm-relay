# Backlog — llm-relay

> The work queue. Each entry states an unmet **Property** and is deleted once that property is
> met. Shipped work lives in git history and in the dated documents under `docs/`;
> [`../HANDOFF.md`](../HANDOFF.md) holds current state plus the immediate next; `CLAUDE.md` holds
> invariants and rationale. Nothing here is a status log. A machine-wide item (a global hook, a
> shared instruction file, the offload lanes themselves) belongs in `C:\Code\docs\backlog.md`,
> not here.

## Open

- **The relay does not pace itself from the throttling it sees (2026-09-10, owner direction,
  high).** Owner, 2026-09-10: *"The relay should be tracking requests from all IDEs on the machine,
  anything that runs through the relay, so it can use rate-limited messages to calculate when it
  might need to slow something down. It's supposed to adapt and perfect itself."* Today a 429 cools
  ONE deployment (a stated `Retry-After`, else the escalation ladder), a provider-stated quota
  header can demote a spent bucket, and a rate limit stated in a 429 body is learned as a
  `rate-limit-*` fact that is DISPLAY-ONLY (spec decision M2, opt-in, not built). Nothing uses those
  facts to slow the relay's own request rate before the next 429, and a 429 wording the relay has
  not seen before waits in the eligibility queue for a human verdict. **Property:** a deployment
  with a stated or learned rate limit is paced, across every client that routes through the relay,
  so the relay's own rate stays under it; a 429 that states a window updates that pacing without a
  human verdict; and a limit nobody stated has no effect.

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

- **The model catalog refreshes on a clock, not on evidence that it is stale (2026-09-10, owner
  direction, medium).** Owner, 2026-09-10: *"The relay is supposed to be keeping metadata about
  providers and models up to date, with regular sampling; if we get a hint that our model catalog
  might be stale, we update it."* A refusal that says a listed model does not exist (a 404 on a
  model the catalog lists) is today only a signature for the eligibility queue, while the catalog
  waits for its TTL. **Property:** such a refusal triggers a catalog refresh for that provider at
  once, bounded so that a burst of refusals costs one refresh, and dynamic pool membership follows
  the refreshed list.

- **`llm-relay config set` cannot reach a field inside a ladder rung (2026-09-10, friction:
  missing_affordance, low).** Correcting the four free-pool rung notes, `llm-relay config set
  routing.ladders.<tier>.<i>.note "<text>"` failed with "must be an array of rungs": the dot-path
  editor does not treat a numeric segment as an array index, so the only way to change one rung
  field was a hand edit of `config.json` — the path `config-edit.ts` exists to replace, because it
  validates the whole document through `loadConfig()` before writing. **Property:** a numeric
  path segment addresses that element of an array, the candidate document still passes
  `loadConfig()` before it is written, and an index past the end is refused by name.

- **A DeepSeek answer's reasoning never reaches the caller, so pool traffic runs with thinking off
  after the first tool call (2026-09-10, F11 residue, low).** `openai-request.ts` now carries a
  replayed `thinking` block onto DeepSeek's `reasoning_content`, and turns thinking off for a replay
  that has none, so the 400 is gone. But llm-bridge's response translation drops DeepSeek's
  `reasoning_content`, so a caller never holds DeepSeek's own reasoning to replay, and every
  multi-turn tool conversation runs with thinking off after its first tool call. **Property:** on a
  `compat.reasoning: "deepseek"` target, the response's `reasoning_content` reaches the caller — a
  `thinking` block on the Anthropic front, a `reasoning` item on the Responses front — so the
  caller's replay carries it back and thinking can stay on; pinned on both fronts.

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
