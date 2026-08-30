# HANDOFF

Entry point for any agent picking up llm-relay, on any provider. Read this before `CLAUDE.md`.

## 0. State as of 2026-08-30 (sixth lap)

**Current: v0.63.0 is released** — npm `dist-tags.latest` 0.63.0 and `llm-relay version` 0.63.0,
both verified 2026-08-30 against the registry itself rather than a cached packument. ⚠ The RUNNING
relay's version is not asserted here: `GET /telemetry` carries no version field, so a claim about
the live process needs a restart or another check — and the daemon on this machine was started
before v0.63.0, so it is NOT serving this build.
§6 holds recorded trades, deferrals and settled decisions, not a work queue. The work queue is
[docs/backlog.md](docs/backlog.md). **Both owner decisions that stood there are now settled:**
package-size variant C is adopted, and the MCP server (D4) is BUILT AND SHIPPED to `main`.

✅ **`llm-relay mcp` is live** (`e8ac127`, `67d12a0`, `e059bbe`). One MCP tool call hands a whole
task to another agent lane and returns its ANSWER, so no caller composes a lane command. Registered
on Claude Code (✔ Connected) and AGY, where **delegation is verified live** — agy dispatched a task
and reported the answer plus the lane. That closes the goal D4 existed for. ⚠ Codex is registered
and `codex mcp list` shows it enabled, but `codex exec` surfaces NO MCP tools at all, including two
servers older than this one; use the CLI form from Codex. Design survey:
[docs/mcp-dispatch-prior-art-2026-08-30.md](docs/mcp-dispatch-prior-art-2026-08-30.md).

⚠ **Unreleased commits sit on `main` after the v0.62.0 tag, and they are no longer neutral.** The
package-hygiene lap itself (`fb38d7e`, `68ea8ce`, `76ae510`) changed nothing inside the published
package — a test and a script `package.json` `files` does not list. The owner then chose
package-size variant C, and THAT does change `dist/`: `packBytes` 1113288 → 861516. The MCP server
then added 17494 B back, so `main` builds 879010 — still 21% below what the registry serves. Two
material changes now await a release, not one.

**freellmapi is RETIRED** (owner decision 2026-08-29), so llm-relay is now the ONLY free-provider
offload runtime on this machine. It is dormant and reversible, nothing deleted; the measured basis
and the cutover record are
[docs/freellmapi-takeover-readiness-2026-08-29.md](docs/freellmapi-takeover-readiness-2026-08-29.md).
The measurements that settled it: llm-relay carried 5.5× freellmapi's weekly traffic on the same
accounts, freellmapi's compression had saved 0.08% lifetime, and its in-flight quota leases were
already handled inside llm-relay.

**Recent laps, compressed — each has its own doc, and git holds the narrative.**

- **v0.60.0, the eligibility-and-probe lap** — a successful background probe now RETRACTS cooling
  facts (`src/ping/cadence.ts` `recordPing` → `clearFacts`), plus a display-only network-block
  advisory. [docs/eligibility-and-probe-lap-2026-08-30.md](docs/eligibility-and-probe-lap-2026-08-30.md).
- **v0.61.0** — a stated `unknown` host was treated like `routed`, so a headless caller got a
  `target:` spec it could not address and `--next-command` exited 2 with nothing to run.
  [docs/skill-dispatch-mcp-verification-2026-08-30.md](docs/skill-dispatch-mcp-verification-2026-08-30.md).
- **v0.62.0** — OpenCode is a third `install-skill.mjs` target, and it is the only one honouring
  `XDG_CONFIG_HOME` rather than a fixed dotfolder in HOME.
- **v0.62.0+, the package-hygiene lap** — below.

Three durable facts from those laps, kept because prose elsewhere had them wrong:

- ⚠ **`AGENTS.md` can only be regenerated from the MAIN checkout.** `sync.mjs` resolves project
  targets under `C:/Code` and never reads a worktree, so a worktree lap must hand that step back.
- ⚠ **Reason about agy from `~/.gemini/antigravity-cli/settings.json`, never from prose.** Its live
  allow list is `read_file`, `write_file`, `read_url`, `mcp` — verified end to end 2026-08-27. An
  earlier write-up here claimed far less. (`~/.agent-config/host-agy.md` was stale for three days
  and was rewritten 2026-08-30; it is correct now.)
- ⚠ **The MCP verdict is REVERSED** (owner, 2026-08-30): agy must be able to DELEGATE, so an MCP
  server is now wanted. The work item is in [docs/backlog.md](docs/backlog.md); the superseded
  reasoning stays in `CLAUDE.md` because its two INVALID objections must not be repeated.
- ⚠ **agy's missing shell is NOT a security boundary** (owner correction, 2026-08-30). The
  2026-08-11 `command(*)` revocation was an AGENT's act, not an owner decision, and the global
  `CLAUDE.md` phrase "the accepted cost" describes an acceptance no file history shows. Never cite
  it to gate a design. The MCP work item first did, and that text is retracted in place.

**This lap (2026-08-30, sixth) — the package-hygiene lap.** Full evidence:
[docs/package-size-2026-08-30.md](docs/package-size-2026-08-30.md).

- **A green baseline was intermittently RED, and the cause is now known.**
  `test/hard-cap.test.ts` derived its retry-after bound from a clock read AFTER the response, while
  `server.ts` `respondAllCapped` reads its own clock earlier. `ceil` is monotonic, so the relay's
  value can legitimately be one second LARGER than the test's bound. Measured 26478 vs 26477.
  A 200000-case arithmetic model reproduces the old form failing 2.4% of the time and the new form
  never failing. ⚠ **This is very likely the unexplained flake recorded in the v0.61.0 friction
  log**, whose diagnostics were lost to a `tail` pipe. The fix is in the TEST, per this repo's
  own protocol; `hard-cap.test.ts:636` was the suite's only derived-boundary retry-after bound.
- **`check:package` now names the build** instead of dying on a raw ENOENT (`readBuiltJson`).
- **The 9 unexplained package entries are closed with no residue** — three modules from `ba3bd2a`
  (v0.59.0) × three `tsc` outputs. 329 + 9 + 3 = 341 exactly.
- **A stale `observed.unpackedBytes` was corrected** to the measured 5205915. The recorded 5194760
  described no tree that ever existed, and survived because a CEILING metric's `observed` value is
  never compared for equality. A provenance correction, not a ratchet raise; no ceiling moved.
- **The comment-prose size question is now measured, not asked.** 29.5% of `dist/*.js` is comment
  prose; four tarball variants are measured in the doc §3. Owner decision, in the backlog.

**Owner decisions taken this lap.** D1, D3 and D5 were already closed and were verified as such.

- **D2 — CLOSED PERMANENTLY, the other way.** `DEFAULT_CONFIG_TEMPLATE` will NOT ship a
  `routing.ladder` or `cliLane`. Dispatch is deliberately a per-machine feature, so dispatch work
  is no longer measured against `docs/project-goals.md` rubric test 1. Recorded in the CLAUDE.md
  MCP gotcha.
- **D4 — REVERSED: agy must be able to DELEGATE**, so an MCP server is now wanted. The reversal
  condition was written into the CLAUDE.md gotcha and the owner met it. Work item in
  [docs/backlog.md](docs/backlog.md).
  ⚠ **I first attached a security cost to it, and the owner retracted that the same day.** I wrote
  that an MCP server "reaches around a deliberate 2026-08-11 revocation" which "the owner accepted
  knowingly". Both halves were false: the revocation was an agent's act, and no file history shows
  an acceptance. The text is retracted in place in all three homes rather than quietly deleted.

**Package-size variant C shipped** (owner decision, 2026-08-30, taken in the hand-back).
`build:server` now runs `tsc` twice — pass 1 emits the `.d.ts` files WITH docs, pass 2 re-emits
only the JavaScript with `--removeComments`. Consumers keep their IntelliSense text.
**`packBytes` 1113288 → 861516, 22.6% smaller**, `packageEntries` unchanged at 347, `.d.ts` bytes
unchanged. Ceilings ratcheted DOWN with it, keeping the same ~0.5% headroom. ⚠ Do not collapse the
two passes into one `removeComments: true` — that is variant B, which strips the `.d.ts` docs and
was rejected for that reason. See the CLAUDE.md build note and
[docs/package-size-2026-08-30.md](docs/package-size-2026-08-30.md) §3.1.

**Immediate next:** one item for whoever picks this repo up — the owner-directed investigation into
why the llm-relay offload lane STALLS and returns nothing (measured: ~17 minutes, ~19 idle child
processes, one diagnostic line reporting `pool/medium` as an unrecognized model on the
session-title query path). See [docs/backlog.md](docs/backlog.md).

⚠ **The MCP server design is OWNED BY ANOTHER AGENT** (owner, 2026-08-30). Do not start it here.
⚠⚠ **And its stated justification expired ~70 minutes after the decision.** D4 rested on *"agy has
no shell, so MCP is its only delegation mechanism"*. **agy has a shell again** —
`~/.gemini/antigravity-cli/settings.json` now reads
`read_file(*) write_file(*) read_url(*) mcp(*) command(*)`, restored at 10:51:13 PDT against a D4
answered at about 09:40. The owner's GOAL is unchanged, but the premise is gone, so the design
should be confirmed rather than assumed. Timeline and attribution: [docs/backlog.md](docs/backlog.md).

⚠ `AGENTS.md` cannot be regenerated from a worktree; `sync.mjs` resolves project targets under
`C:/Code` only, so this lap's `CLAUDE.md` edits need `node ~/.agent-config/sync.mjs` run from the
MAIN checkout.

✅ **RELEASED as v0.63.0** (2026-08-30, owner instruction reversing the same-day "stays unpublished"
decision). npm `dist-tags.latest` = 0.63.0, verified against the registry directly. It carries BOTH
held changes: package-size variant C (tarball 1113288 -> 879010, 21% smaller than what the registry
served) and the `llm-relay mcp` dispatch server. The global bin was reinstalled FROM THE REGISTRY and
the bundled skill now matches the published copy byte for byte (line endings aside).
