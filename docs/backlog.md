# Backlog — llm-relay

> The work queue. Each entry states an unmet **Property** and is deleted once that property is
> met. Shipped work lives in git history and in the dated documents under `docs/`;
> [`../HANDOFF.md`](../HANDOFF.md) holds current state plus the immediate next; `CLAUDE.md` holds
> invariants and rationale. Nothing here is a status log. A machine-wide item (a global hook, a
> shared instruction file, the offload lanes themselves) belongs in `C:\Code\docs\backlog.md`,
> not here.

## Open

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
