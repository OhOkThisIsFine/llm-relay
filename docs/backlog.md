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
  not seen before waits in the eligibility queue for a human verdict. A probe that answers 200
  retracts a cooling fact but never a breaker cooldown — `PingLoop` holds no breaker reference
  (`ping/cadence.ts`) — so a model cooled by 429s waits out its escalation step (2 min, 10 min,
  1 h, 24 h) even after a probe shows it answers again. Owner, 2026-09-10: *"The relay should be
  polling to see if things start working again anyway."* **Property:** a deployment with a stated
  or learned rate limit is paced, across every client that routes through the relay, so the
  relay's own rate stays under it; a 429 that states a window updates that pacing without a human
  verdict; a probe that answers 200 ends a rate-limit cooldown early; and a limit nobody stated
  has no effect.

- **The model catalog refreshes on a clock, not on evidence that it is stale (2026-09-10, owner
  direction, medium).** Owner, 2026-09-10: *"The relay is supposed to be keeping metadata about
  providers and models up to date, with regular sampling; if we get a hint that our model catalog
  might be stale, we update it."* A refusal that says a listed model does not exist (a 404 on a
  model the catalog lists) is today only a signature for the eligibility queue, while the catalog
  waits for its TTL. **Property:** such a refusal triggers a catalog refresh for that provider at
  once, bounded so that a burst of refusals costs one refresh, and dynamic pool membership follows
  the refreshed list.

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
  **Checked 2026-09-16, still open, and the blocker changed.** A direct request to
  `opencode/muse-spark-1.3-contributor-free` now answers `HTTP 400 MissingSessionID: "OpenCode's
  free tier can only be used in OpenCode"` — a vendor session-identity check, not the rate limit
  this entry was written against. This is not fixable by sending a stronger request: the vendor is
  asking the caller to prove it IS the OpenCode CLI, and manufacturing that proof would mean the
  relay impersonating another vendor's own client, which this project's terms-compliance position
  rules out. The property stays open; the honest next step is confirming with OpenCode Zen support
  whether a relay-forwarded request can ever qualify, not a code change here.

- **Verify the Codex `relay` agent end to end in Codex Desktop** (owner-driven, 2026-09-04).
  Commit `e73d113` added `~/.codex/agents/relay.toml` via `scripts/install-skill.mjs`; standalone
  `codex exec` exposes no MCP tools, so only a live Codex Desktop session driven by the owner can
  verify it. **Property:** one Codex Desktop `relay` subagent reply carries a `provenance:` line
  (e.g. spawning `relay` with "read C:\Code\llm-relay\package.json and reply version=<field>"
  returns the version and provenance from a dispatch lane).

- **The dashboard SPA has no control for the operator pin yet (2026-09-16, owner request, high —
  the UI half of the dashboard's first write).** The ENDPOINT half landed 2026-09-16:
  `POST /dispatch {"pin"|"unpin"}` (`routes/admin.ts` `operatorLanePin`) reuses `lane-affinity.ts`'s
  pin, sits on the same admission as every `POST /dispatch` (exact `Host`, `Origin` when present,
  JSON content-type, control token), refuses by name anything it cannot honour, and is visible on
  the next `GET /dispatch` with no restart (`test/admin-dispatch-pin.test.ts`; `docs/reference.md`
  "Pinning a lane by hand"). What remains is the SPA: `dashboard/src/` reads only
  `dashboard.snapshot.v1` and renders no ladder at all, and a dashboard session is read-only by
  design (`dashboard-auth.ts`) — it does not carry the control token, so the control must take the
  token from the operator (pasted once from `~/.llm-relay/control-token`, held in memory only) and
  send it on the write, rather than widening the session. **Property:** a ladder panel in the SPA
  reads `GET /dispatch` (tokenless, same origin), offers pin/unpin per selectable lane on the shown
  tier, sends the operator-entered control token on `POST /dispatch`, and re-reads the ladder after
  the response; the token is never persisted by the page and never appears in the snapshot.

