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

- **A terminal `dispatch_status` does not carry the answer (2026-09-16, medium).** `toolStatus`
  in `src/mcp/server.ts` returns `describeJob` in every state; the answer body is reachable only
  through `dispatch_result`. A caller that polls status and never calls result can poll a finished
  job indefinitely — measured on this machine: one wrapper polled a job 2,023 times over 71 minutes
  and returned nothing, though the lane had answered. **Property:** once `job.status` leaves
  `running`, `dispatch_status` returns the same text `dispatch_result` returns (`jobAnswer`), so
  the first poll that sees a finished job already holds the answer; a running job keeps the short
  form; `dispatch_result` is unchanged. Also verify while there: whether `dispatch_result` from a
  second MCP connection finds a job the first connection dispatched, now that `job-archive.ts` is
  on disk (v0.82.0) — a 2026-09-16 observation says it did not.

- **An agent-mode lane's result does not say what the lane wrote (2026-09-16, medium).** The
  runner checks that `cwd` exists and sits inside `routing.mcp.allowedRoots` (`checkCwd`) and binds
  read-only tool flags when asked (`readonly-boundary.ts`), but never compares the tree before and
  after the run. A caller learns what changed only by running `git status` itself, and a cancelled
  lane leaves files behind the same way a completed one does — measured: a lane asked to audit
  wrote an unrequested deliverable into a repository root and nothing reported it. **Property:**
  for an agent-mode job whose `cwd` is inside a git work tree, `lane-runner.ts` records
  `git status --porcelain --untracked-files=all` at start and at every terminal state (completed,
  failed, timed out, cancelled, killed); `jobAnswer` appends a `tree delta (<cwd>):` block listing
  paths that appeared, changed status or vanished, or `tree delta: none`; an optional `dispatch`
  argument `scope: string[]` (paths or globs relative to `cwd`) tags every delta path outside it
  `OUT OF SCOPE`. Report only — the relay never refuses or reverts; the caller's own gates decide.

- **No test replays a lane that outlives `waitMs` (moved from the machine backlog 2026-09-16,
  low).** The wait-ceiling clamp (`749be44`, v0.80.0) and the `relay` agent template obligation to
  return the job id are shipped; what is missing is the replay that pins them together.
  **Property:** a test in `test/mcp-server.test.ts` dispatches to a fake lane that answers after
  `waitMs` has elapsed and asserts the reply carries a `jobId`, that `dispatch_status` reports
  `running`, and that `dispatch_result` later returns the lane's answer unchanged.

- **The Codex `relay` agent can report lane provenance for its own inline review (moved from the
  machine backlog 2026-09-16, low).** Measured 2026-09-08: the Codex-side `relay` child returned
  an inline review while stating that dispatch was unavailable, and still printed a provenance
  line. The Claude template (v8, `src/setup-claude.ts`) carries rule 8 (no provenance line without
  a real `dispatch_result`); the Codex template in `scripts/install-skill.mjs` is a prompt
  obligation with no test. **Property:** `scripts/install-skill.mjs`'s Codex template carries the
  same rule, and a test asserts the generated `~/.codex/agents/relay.toml` text contains it, the
  way `test/relay-agent-provenance.test.ts` pins the Claude one.


- **A lane inherits an unexpanded `%VAR%` environment value and Git Bash turns it into a
  directory (2026-09-16, medium).** Measured on Windows: the host that starts `llm-relay mcp`
  carried `HOME=%USERPROFILE%` as a literal (the user variable is `REG_EXPAND_SZ` and the host
  did not expand it). Both a Claude free-pool lane (job-0044) and an AGY lane (job-0043) received
  the literal; in the Claude lane Git Bash resolved `HOME` relative to the lane's cwd and created
  a directory named `%USERPROFILE%` there. `lane-launch.ps1` (generated by `src/lane-manifest.ts`)
  passes the environment through unchanged and `routing.cliLane.env` can only set or unset fixed
  names. **Property:** before a lane starts, every environment value of the shape `%NAME%` is
  either expanded from the same environment (when `NAME` resolves) or removed, and the job
  journal names each value it changed; a test spawns a lane with `HOME=%USERPROFILE%` and asserts
  the child sees `C:\Users\<user>` (or no `HOME`), never the literal.
