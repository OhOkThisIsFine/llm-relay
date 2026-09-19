# Backlog — llm-relay

> The work queue. Each entry states an unmet **Property** and is deleted once that property is
> met. Shipped work lives in git history and in the dated documents under
> [`history/`](history/);
> [`../HANDOFF.md`](../HANDOFF.md) holds current state plus the immediate next; `CLAUDE.md` holds
> invariants and rationale. Nothing here is a status log. A machine-wide item (a global hook, a
> shared instruction file, the lap and closeout ceremony) belongs in `C:\Code\docs\backlog.md`,
> not here. ⚠ A measured fact about USING the relay — dispatch mechanics, what a lane can carry,
> reading a reply, lane concurrency, operating the daemon — belongs in
> [`../skills/llm-relay/references/lane-field-notes.md`](../skills/llm-relay/references/lane-field-notes.md),
> the bundle every host installs (owner, 2026-09-17). It is reference, not work, so it never
> belongs in either backlog.

## Open

> Implementation packets for every entry below, plus the stability items a live survey found on
> 2026-09-17, are in [`history/stabilization-plan-2026-09-17.md`](history/stabilization-plan-2026-09-17.md). Delete
> this pointer when that plan's exit condition is met.

- **The Windows `.cmd` lane fallback reparses dispatched task text in `cmd.exe` (verified
  2026-09-18, high/security).** `createLaneSpawner` (`src/mcp/lane-runner.ts`) first uses
  `execFile`, then on Windows `ENOENT` rebuilds the command as one string and passes it to
  `exec()`. That string uses `quoteCmdArg` from `src/lane-probe.ts`, which wraps each argument in
  double quotes and replaces an embedded quote with a backslash followed by a quote. Backslash is
  not `cmd.exe`'s quote escape,
  so task text containing a quote can terminate the quoted argument and expose shell metacharacters
  such as `&` or `|`. This is reachable from dispatch: `normalizeOptions` explicitly leaves task
  text unsanitized and relies on it remaining one argv element. The existing fallback test covers a
  space only. **Property:** no task/user text is ever reparsed as shell syntax. Prefer a no-shell way
  to launch Windows command shims; if a shell remains necessary, its encoder and Windows test must
  prove embedded quotes and `& | < > ^ ( ) % !` stay one literal argument.

- **The repository gate has no Windows execution leg and is not enforced on `main` (verified
  2026-09-18, medium/repository hardening).** `.github/workflows/ci.yml` is intentionally Ubuntu-
  only on the assumption that development happens on Windows, while `CONTRIBUTING.md` now invites
  third-party contributors and the Windows-only spawn boundary above is not exercised by Linux.
  GitHub currently reports `main` as unprotected and the repository has no rulesets, so the stated
  PR gate can be bypassed by a direct push. **Property:** the platform-specific process boundary is
  exercised on Windows CI, and the default branch requires the CI gate before changes can land.
  Keep the Windows leg targeted if a second full gate is unnecessary; configure branch protection
  or a repository ruleset as the settings half of the same property.

- **A lane's `capability` is a hand-set config value, but it must come from the synced capability
  data (owner correction, 2026-09-17, high).** `applyRungCapability` (`src/config/routing-parser.ts`)
  reads it from config; nothing derives it from `docs/tier-data.json`. **Property:** `buildDispatch`
  derives each lane's capability from the lane's model through `getStrength` and
  `strengthAllowedForEffort` (a pool rung takes its pool's band), states the basis, and treats an
  unmatched model as unknown (no limit). Design: item D6 of `history/stabilization-plan-2026-09-17.md`.

- **The stabilization plan holds work that has no entry here (2026-09-17).** Packets W0-1 to W0-3,
  S2 to S5, M1 and R1, operator tasks O2 to O5, and design items D1, D2 and D5 of
  `history/stabilization-plan-2026-09-17.md`. **Property:** each of those packets is shipped, or the owner
  declined it and the plan says so.

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


- **A job killed by an MCP server restart carries no tree delta (2026-09-17, low).** Since
  2026-09-17 a completed, failed, timed-out or cancelled agent-mode job ends with a `tree delta`
  block (`src/mcp/tree-delta.ts`). A `killed` job does not: the `git status` it started from lives
  only in the process that died. **Property:** the running-job journal (`job-journal.ts`) keeps a
  bounded copy of the starting status, and orphan adoption renders the delta for the killed job.

