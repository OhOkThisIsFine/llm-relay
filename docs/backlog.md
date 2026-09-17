# Backlog — llm-relay

> The work queue. Each entry states an unmet **Property** and is deleted once that property is
> met. Shipped work lives in git history and in the dated documents under `docs/`;
> [`../HANDOFF.md`](../HANDOFF.md) holds current state plus the immediate next; `CLAUDE.md` holds
> invariants and rationale. Nothing here is a status log. A machine-wide item (a global hook, a
> shared instruction file, the offload lanes themselves) belongs in `C:\Code\docs\backlog.md`,
> not here.

## Open

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

- **A job killed by an MCP server restart carries no tree delta (2026-09-17, low).** Since
  2026-09-17 a completed, failed, timed-out or cancelled agent-mode job ends with a `tree delta`
  block (`src/mcp/tree-delta.ts`). A `killed` job does not: the `git status` it started from lives
  only in the process that died. **Property:** the running-job journal (`job-journal.ts`) keeps a
  bounded copy of the starting status, and orphan adoption renders the delta for the killed job.

