# Backlog — llm-relay

> The work queue. Each entry states an unmet **Property** and is deleted once that property is
> met. Shipped work lives in git history and in the dated documents under `docs/`;
> [`../HANDOFF.md`](../HANDOFF.md) holds current state plus the immediate next; `CLAUDE.md` holds
> invariants and rationale. Nothing here is a status log. A machine-wide item (a global hook, a
> shared instruction file, the offload lanes themselves) belongs in `C:\Code\docs\backlog.md`,
> not here.

## Open

- **A Codex run on the relay's Responses front dies the moment a tool-call argument string
  arrives truncated — five of five DeepSeek lanes, 2026-09-09.** `codex exec -c
  model_provider=llm-relay -m deepseek/deepseek-v4-pro` reaches `/v1/responses`; on every run the
  model's `exec_command` arguments were cut mid-string (Codex: `failed to parse function
  arguments: EOF while parsing a string at line 1 column 86`), Codex replayed the item on its next
  turn, and `responses-request.ts` refused the replay (`function_call "exec_command" arguments are
  not valid JSON`), ending an agentic run at 3k–20k tokens. Which side truncates is NOT known: the
  provider's stream, or the relay's translation of `function_call_arguments` deltas on the
  Responses front → Anthropic → Chat → back path. **Property:** a capture of one failing run's
  upstream Chat stream beside the relay's emitted Responses stream shows where the string was cut.
  If the relay drops or truncates a delta, that is fixed with a pinning test on ≥2 candidates. If
  the provider truncates, the Responses front refuses the REPLAYED item with a message naming the
  call id and that its arguments were truncated, so a harness can repair the turn instead of
  replaying a broken one forever.

- **A NON-STREAMED request has no time-to-first-byte protection, so a slow QUEUE reads as a dead
  backend (2026-09-09, DeepSeek provider survey, medium).** `beginAttemptRun` in
  `src/candidate-runner.ts` arms one flat `target.timeoutMs` deadline for the whole request.
  `routes/messages.ts` and `routes/openai-front.ts` then clear that timer and install
  `withStallWatchdog` — but only `if (streamed && backendRes.status < 400 && stallMs > 0)`. The
  doc comment on `stallTimeoutMs` in `src/config-types.ts` states the intent plainly: "one flat
  deadline kills a healthy long generation at minute two while letting a dead stream hang until
  the same minute two". **That reasoning applies to a non-streamed request too, and a non-streamed
  request gets none of the protection.** It keeps the flat deadline for its whole life, including
  the queue wait before the backend emits anything.
  Measured against `nim` at `timeoutMs: 100000`: `deepseek-ai/deepseek-v4-flash-0731` returned 504
  at 100.03 s and again at 100.04 s, while `deepseek-ai/deepseek-v4-pro-0813` answered 200 in
  81.6 s for TWO output tokens, and `relay-restart.log` holds the same Flash model answering 200
  in 38.1 s on 2026-08-27. The model was never unservable; the free NIM queue simply exceeded the
  deadline. A 504 does not write a `not-servable` fact, so nothing is poisoned — but an operator
  reading the 504 concludes the model is gone, which is what happened here.
  Raising `timeoutMs` is the wrong lever alone: it lengthens the wait for a genuinely dead
  backend by exactly as much.
  **Property:** a non-streamed attempt separates a time-to-first-byte deadline from the total
  deadline, so a backend that has produced no bytes fails fast while one that is merely slow to
  finish is not killed; the existing streamed path keeps its current behaviour.

- **A config change needs a full daemon restart, and the shape of the server makes that avoidable
  (2026-09-09, DeepSeek provider survey, low).** `runProxy` calls `loadOrExit()` once and captures
  `cfg` in the `createServer` closure; every request then receives it as `handle(req, res, cfg,
  …)`. So the per-request read is already indirect — swapping one binding would move every
  SUBSEQUENT request onto a new config while in-flight requests keep the one they started with.
  `loadConfigSafely()` in `src/cli.ts` is already the exact primitive (it returns `null` instead
  of exiting on an unreadable file), and today only the dispatch CLI path calls it.
  ⚠ **The work is not the swap; it is deciding which startup-built objects must be rebuilt.**
  `catalog`, `pingLoop`, `breaker`, `credentialLru`, `dashboardAuth`, `dashboardStatic` and the
  validator are all constructed once from `cfg`. A naive assignment leaves them keyed to the old
  providers. The listen address cannot change at all without rebinding.
  ⚠ **A reload can never pick up a new OS environment variable.** A running process holds the
  environment block it was given. `~/.llm-relay/.env` and the DPAPI keystore ARE files, so a
  reload does cover a new credential written to either of those.
  Measured on 2026-09-09: raising `providers.nim.timeoutMs` from 100000 to 300000 had no effect
  until the daemon was restarted — a probe after the edit still aborted at exactly 100.04 s.
  **Property:** an operator edit to `~/.llm-relay/config.json` takes effect on the next request
  without a restart, or the relay states clearly that it will not; a malformed edit leaves the
  running config untouched and logs the parse failure.

- **The logon-started daemon is stopped by `TerminateProcess`, so no shutdown flush ever runs on
  this machine (2026-09-08, breaker-persistence lap, low).** `flushBreakerPersistence` and its
  siblings run in `runProxy` only when a signal is delivered; `Startup\llm-relay.vbs` starts the
  relay with no console, and `Stop-Process` is `TerminateProcess`. The loss is bounded by
  `MAX_FLUSH_DELAY_MS` (2 s):
  [`breaker-persistence-audit-2026-09-08.md`](breaker-persistence-audit-2026-09-08.md) §3.
  **Property:** the relay exposes a control-token-admitted stop (a `POST` on the existing
  admission boundary, or a documented console-signal launcher) that runs the same shutdown path
  as `SIGTERM`, and the way this machine restarts the daemon uses it.

- **The per-lane stats window is keyed by lane id ALONE, so one tier's runs set another tier's
  walk budget (2026-09-08, safety review, medium).** `recordLaneRun` in
  `src/dispatch-lane-stats.ts` keys by `report.laneId`, while `memoryKey` in
  `src/lane-affinity.ts` is tier-keyed; since 2026-09-08 that window sets each lane's kill budget.
  Not fixed with the rest of the review because it changes the persisted key space of
  `dispatch-lane-stats.json`, and the advisory `stats` column may still want a per-lane aggregate.
  **Property:** a lane's walk budget is derived only from runs on the ladder it will be used on;
  an existing stats file still loads.

- **Accept or decline the 26 triaged refusals** (owner-only; triaged 2026-09-09 in
  [`eligibility-triage-2026-09-09.md`](eligibility-triage-2026-09-09.md), which carries every
  verdict pinned to its digest and the exact `accept`/`reject` commands). Nineteen accepts, six
  rejects, one deliberate pending (the groq client-side network block, never rejected by the
  `network-block.ts` rule). Two accepts evict: `nim/moonshotai/kimi-k3` (48 × "degraded function
  cannot be invoked") and seven ollama-cloud paid-plan SKUs seen once each. The dispatcher may
  `propose`; only the owner may `accept`. **Property (what remains):** the owner has run, or
  declined by name, each listed command, so `llm-relay eligibility` shows no item without a
  verdict except item 1, whose pending state is the stated verdict.

- **A slow `cli` lane is reordered on WALK EVIDENCE, not on a calibrated statistic** (owner
  question 2026-09-05). Most of it shipped with the dispatch walk
  ([`dispatch-lane-walk-design-2026-09-06.md`](dispatch-lane-walk-design-2026-09-06.md)):
  `lane-affinity.ts` demotes, `DispatchView.order` reorders, and each lane's budget is its own p80
  (`attemptBudget` in `dispatch.ts`). The demotion is still "the walk gave this lane its budget
  and it did not answer", not an outlier test against the lane's own history, which needs samples
  attributable in time. ⚠ Never point the HTTP path's numbers (250 ms/token, 30 s) at a lane.
  **Property (what remains):** per-lane wall-clock history is attributable in time, and a lane
  whose RECENT distribution is an outlier against its own earlier history is demoted on a threshold
  calibrated from that history — with the calibration recorded the way the budget's 0.8 quantile
  now is (live p80: 165 s, 224 s, 1383 s; chosen because p90/p95 saturate at the slowest lane's own
  timeout).

- **Muse Spark 1.3 — and every Responses-only OpenCode Zen SKU — is unreachable through the
  relay, because no upstream speaks the OpenAI Responses API.** Zen serves the contributor SKUs
  on `/zen/v1/responses` only (measured 2026-09-04,
  [`muse-spark-1.3-opencode-zen-2026-09-04.md`](muse-spark-1.3-opencode-zen-2026-09-04.md));
  `Kind` in `src/config-types.ts` is `"anthropic" | "openai"`, and `src/backend.ts` speaks only
  `/chat/completions` and `/v1/messages` upstream; `src/responses-request.ts` is the Codex FRONT
  direction. Owner decision 2026-09-04 (option A): contributor SKUs may be routed automatically,
  so this is engineering only. Route A (the four `opencode-muse-spark` OpenCode-CLI rungs) is
  live; this entry is route B. After route B lands, pin both contributor ids as `preferred` in
  the effort pools (no tier-data row, so no automatic admission).
  **Property:** a provider whose models are served only on `/v1/responses` is addressable as
  `provider/model` on both fronts with tools, streaming and usage (`reasoning_tokens`,
  `cached_tokens`) intact. Prefer a `wire: "responses"` option on `kind: "openai"` over a third
  `Kind` — the latter touches about 55 `kind ===` sites in 19 files. Rows 10–13 of the doc are the
  request, response and stream shapes to speak; the doc's §3 route B lists the field mapping.

  Once route B lands the property gains: `opencode/muse-spark-1.3-contributor-free` answers a real
  request through `pool/*` on both fronts.

- **A zero-priced deployment with no exact tier-data row can never enter any effort pool, and a
  `-free` / `-contributor-free` suffix defeats the match against its base SKU's row.**
  `strengthAllowedForEffort` in `src/benchmarks.ts` requires `basis: "snapshot"`,
  `match: "exact"` and ≥3 published signals, so every Zen `-free` SKU is absent from all four
  pools while the paid Zen SKUs are members. "A model clearing NO band is admitted nowhere" is a
  stated rule, so this is a cost, not a defect — but it falls on the free capacity the pools exist
  to spend. **Property:** a free-class, tool-capable deployment that no benchmark source has
  scored yet has some deliberate route into a pool short of `preferred` — e.g. treating
  `-free`/`-contributor-free` as a PRICE suffix that resolves to the base SKU's row (same weights,
  different price; unlike an effort suffix, which `normName()` rightly never strips), or a bounded
  probation band — and the choice is recorded.

- **`llm-relay keys` cannot verify a mixed provider whose completion probe model is paid.**
  `opencode#default` reports `UNVERIFIED` because `/models` is public and the probe model answers
  HTTP 401 with or without the key, while one completion on `opencode/nemotron-3.5-lightning-free`
  through the relay answered 200 (2026-09-04). **Property:** the escalation probe picks a
  free-class model of the provider when the catalog has one (`assessCost` over `cachedModels`), so
  a valid key on a billing-gated account reports `valid`, not `unverified`.

- **Verify the Codex `relay` agent end to end in Codex Desktop** (owner-driven, 2026-09-04).
  Commit `e73d113` added `~/.codex/agents/relay.toml` via `scripts/install-skill.mjs`; standalone
  `codex exec` exposes no MCP tools, so only a live Codex Desktop session driven by the owner can
  verify it. **Property:** one Codex Desktop `relay` subagent reply carries a `provenance:` line
  (e.g. spawning `relay` with "read C:\Code\llm-relay\package.json and reply version=<field>"
  returns the version and provenance from a dispatch lane).

- **Decide the post-commit remedy for a stream that stalls or crawls after first content**
  (owner decision 2026-09-04: measure first, then build only if clients retry; recorded beside
  §12 of [`hedged-attempts-design-2026-08-30.md`](hedged-attempts-design-2026-08-30.md)). The
  hedge race settles at first content, so a stream that COMMITS and then stalls cannot be hedged;
  the per-token rule (`hedge-trigger.ts` rule 1) has evidence only there, and its only honest
  remedy is an abort that hands the failure to the client. Options: (A) build that abort on a
  measured per-token stall threshold; (B) leave in-flight streams alone and rely on latency
  demotion plus the `slow` band for the NEXT request. **Property:** a dated doc records what
  Claude Code and Codex do when a stream carries an SSE `error` after content has arrived — retry
  the request, or fail the turn — measured against a scratch relay on both fronts. If a retry
  reaches another candidate, the abort on a per-token stall threshold is built with an announced
  reason and a pinning test; if not, option B stands and this entry closes on the measurement
  alone.

- **Give the metering subsystem a channel to say it stopped metering** (audit DR-006, verified
  2026-09-04). `writerStatus` and `lastWrite` on the accounting store have zero consumers outside
  the store; the store keeps accepting events after a refused writer lease, and a null
  `snapshots()` silently stops persistence while the relay keeps serving. **Property:**
  `llm-relay cost` and `/telemetry` state when the store's last flush failed or the writer lease
  was refused, so "no spend since noon" cannot be mistaken for "no traffic since noon".
