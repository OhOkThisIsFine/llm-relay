# Audit remediation — handoff (2026-07-29 / 30)

**The remediation run is COMPLETE.** All 14 planned modules landed; the state machine reached
`close` with no blocked items.

Work is on **`main`**. (The previous version of this document claimed branch
`remediate/audit-2026-07-29` — that branch is 0 ahead / 8 behind `main` and holds none of the work.
It is stale and can be deleted.)

Gates on a clean committed tree: `npm run build`, `npm test`, `npm run typecheck` all green.
There is now a single `npm run check` (= typecheck + test) and CI runs it.

## What this run changed

Two commits are hand-authored; the rest are per-module remediation commits. Read
`.audit-tools/remediation-report.md` for the per-obligation evidence (untracked, local-only).

| Area | Substance |
|---|---|
| credential containment | one trim-normalising presence predicate + `credentialState` from the DECLARATION + one `buildAuthHeaders`; `config.ts`'s untrimmed active-key filter closed, which was the surviving half of the critical |
| target selection | untracked no longer scores a perfect 100; `recordSuccess`/`recordFailure` **deleted** so `tsc` enforces measured latency; 401 removed from every availability signal; strength provenance survives ranking |
| release path | `publish.yml` given a ref restriction, an environment gate, tag-ancestry + tag-vs-version checks, SHA-pinned actions; `release: published` trigger removed; CI added |
| repair boundary | full harness destructive set asserted as a policy; post-reshape check re-scoped to structural conservation of the reshaper's output; candidate exhaustion now throws instead of masquerading as a refusal |
| http surface | served provider/model reach the log; mid-stream backend failure emits an SSE error and writes exactly one record; unresolvable `@relay:` is a clean 400 with a log line |
| cli | rendered dispatch commands are shell-quoted (one argv element per arg); read-only subcommands can no longer trigger a global reinstall; `setup-claude` gained a real `targetPath` seam |
| wire fidelity | message id + usage survive the repair round trip; the document fence delimiter is derived from content, not from a client-supplied title |
| catalog | a blank published price no longer becomes a hard "free"; an older-schema cache row no longer reads as "publishes something" |

## Immediate next

Nothing here blocks release. These are the loose ends workers recorded rather than reaching
outside their module scope.

1. **Delete `RequestLog.backendModel`.** `server.ts` now populates `servedProvider`/`servedModel`,
   which was the gate. `log.ts` was outside that node's scope, so the deprecated field is still
   emitted. Make the served fields required at the same time — they are optional only because a
   call site might not have migrated, and now they all have.
2. **`reconstruct()` (`reshaper.ts:82-89`) still returns only `{ content, stop_reason }`.** Until it
   forwards the untouched fields from `raw`, a message that goes *through repair* still reaches
   `emitSse` with no id and no usage, so it gets a synthesized one. The wire-fidelity side of that
   seam is done and proven by a round-trip test; this is the other half.
3. **`server.ts`'s non-streaming path still hardcodes `msg_repair` and zero-fills usage**
   (`toAnthropicMessage`), and `parseAssistant()` does not read id/model off buffered JSON. Same
   defect as (2) on the other path.
4. **`candidates.ts` feeds fuzzy-matched tier figures into `resolveMetadata()` as `reference`
   without consulting whether the match was exact.** On a fuzzy match those numbers belong to a
   different SKU and `referenceFrom` names only the host, so the substitution is visible only by
   separately correlating `capabilityMatch`. Either carry the matched name into `from`, or skip
   reference limits on a fuzzy match.
5. **Nothing type-checks `test/`.** `tsconfig.json` excludes `**/*.test.ts` and `vitest.config.ts`
   declares no `typecheck` block, so a `@ts-expect-error` in a test is never evaluated — one worker
   had relied on exactly that. CLAUDE.md's claim that "vitest is what checks those" was corrected;
   the gap itself is still open.
6. **Configure the `npm-publish` environment's protection rules** in Settings → Environments.
   GitHub auto-creates the environment with NO rules on first use, so until reviewers or a
   protected-tag rule exist, the environment is an audit trail and the tag-ancestry check is what
   actually holds the line.
7. Smaller, each recorded with its reasoning in the report: `prepublishOnly` omits typecheck;
   both `repair()` call sites hardcode `maxAttempts: 2` instead of reading `cfg.repair.maxAttempts`;
   `server.ts`'s non-retriable branch records `ok: true` for a 401/403, which resets the breaker on
   a revoked key; `config.ts:673-687` validates tier/subagent specs against the *post-disabling*
   provider map, so a tier naming a provider disabled by an unset `${ENV}` aborts startup — in
   tension with "disabling one optional provider must never be a total outage".

## Deliberate intermediate state (not bugs)

- `circuit-breaker.ts` keeps `isHealthy()` and `getStabilityScore()`. `getStabilityScore` is now a
  thin `getMeasuredStability() ?? UNMEASURED_STABILITY` wrapper so it can no longer return 100 for
  an unseen key, and telemetry no longer calls it — so it is deletable now. `isHealthy` is the
  cooldown accessor and has no replacement yet.
- `credentialState`'s `declared-missing` branch throws from `buildForwardHeaders`. It should be
  unreachable now that `resolveTargets` drops keyless targets, but it is deliberately loud so a
  future routing change fails instead of egressing whatever the caller sent.
- Auto-update was dormant between the self-update commit and the cli commit, by design. Both have
  landed, so it is live again — for mutating subcommands only.

## Not in this run

- **Two feature requests, unstarted, each owed its own commit.** (a) a `leave_me_alone` provider
  suppression list in `~/.llm-relay/config.json`, consumed by `getOnboardingStatusList` — validation
  must tolerate names matching no known provider, since that is the whole point of storing only the
  negative space; suppressed providers stay visible in `llm-relay keys` and `/registry`, because
  silencing a nudge is not hiding state. (b) `scripts/install-skill.mjs` registering llm-relay in the
  global `~/.claude/CLAUDE.md` between markers, idempotent, one-time backup, global-only, with an
  opt-out. Neither is required for anything to work.
- **7 findings the operator left out of scope**, including `ping/quota.ts:28` hardcoding an
  `openrouter.ai` URL against the provider-agnostic invariant, and `presets.ts:149` asserting
  `x-api-key` while `authEnv.ts:33` accepts the bearer-shaped `ANTHROPIC_AUTH_TOKEN`.
  (`publish.yml`, previously the eighth, was pulled in and is done.)

## Residual risks, recorded rather than repaired

- **Test-plan assertion polarity was assigned by a content heuristic**, and the gate checks only
  that both polarities are PRESENT, not that each is CORRECT. An independent reviewer found 12
  `NEGATIVE:` assertions with no failure-marker language and 5 phrased positively. Individually
  verifying them is not something regenerating an artifact can deliver.
- **Two mandated-independent review phases were self-performed in the PREVIOUS run** after five
  dispatch attempts failed with API 5xx/529. This run dispatched the judge independently, which
  partially discharges it; the earlier critique round remains self-graded.
- `CP-NODE-12-f01` is recorded `accept_failed` in the tool's ledger even though its work is on the
  branch. The planner split that node by file list while giving both fragments identical
  instructions, so the fragment that did the work did not own two of the files; the tool's own
  advice for that seam is to serialise, which is what the hand-authored release commit is. It is
  **not** unfinished work.

## Where the machine-readable state lives

`.audit-tools/` — **untracked, local-only**; `git clean -fd` destroys it. `remediation-report.md`
holds the per-obligation evidence, `remediation/friction/run.json` the process friction. The audit
deliverables (`audit-findings.json`, `audit-report.md`) are tracked by an explicit `.gitignore`
allow-list. This document is the committed source of truth.
