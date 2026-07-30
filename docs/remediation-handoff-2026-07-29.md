# Audit remediation — handoff (2026-07-29 / 30)

**The remediation run is COMPLETE, and its follow-up list is discharged (2026-07-30).**
All 14 planned modules landed, and the seven "Immediate next" items this document used to carry
are done. Work is on **`main`**.

Gate on a clean committed tree: `npm run build && npm run check`. `check` is now
typecheck(src) + typecheck(test) + vitest. Don't pin a test count here — it drifts every wave.

Per-obligation evidence for the original run is in `.audit-tools/remediation-report.md`
(untracked, local-only).

## What the run changed

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

## The follow-up pass (2026-07-30) — closed

1. **`RequestLog.backendModel` deleted**, served fields now required. The model the CLIENT asked
   for is no longer in the log at all: routing resolves a tier/pool spec, so it routinely is not
   the model that answered, and it was the id every "which model trips the validator" reading was
   attributed to. `baseLog()` no longer takes it, so `Ctx.model` is gone too.
2. **Wire fidelity, both halves.** `reconstruct()` carries `id`/`model`/`stop_sequence`/`usage`
   over from `raw`; `parseAssistant()` reads them off buffered JSON; `toAnthropicMessage()` emits
   them instead of the constant `msg_repair` + the client's model + a zero-filled usage, and omits
   `usage` entirely when the backend reported none. Belt and braces: `repair()` re-attaches the
   backend's envelope via `withEnvelopeOf()` regardless of what the `Reshaper` implementation
   returned — same reasoning `guardReshaped()` exists for.
3. **`candidates.ts` fuzzy reference attribution.** `metadataReferenceFrom` is now
   `openrouter:<matched-name>` when the snapshot row was a fuzzy match, so a limit or price
   borrowed from a *different SKU* says so without the reader correlating `capabilityMatch`.
   `buildCandidates` gained a `tierData` injection seam so this is testable against fixed rows.
4. **`test/` is type-checked** by `tsconfig.test.json`, run by `npm run check` (hence by CI). The
   first run found 23 errors, including hand-built `ProviderConfig`/`ReshaperConfig` literals
   missing a required field. ⚠ A `@ts-expect-error` in a test was inert for this project's whole
   history, so a pre-existing one proves nothing.
5. **`npm-publish` environment**: a custom deployment branch policy now limits it to the `v*` tag
   pattern, so the ref restriction is enforced by GitHub and not only by the workflow's `if`. No
   required reviewer — a release stays one command, by the owner's decision.
6. **Smaller items**: `prepublishOnly` runs `check` (not just `test`); both `repair()` call sites
   read `cfg.repair.maxAttempts` instead of a hardcoded 2; a non-retriable 401/403 is no longer
   recorded as a breaker SUCCESS (it is recorded as nothing — a credential fault is not health
   data, and a failure would hide the 401 behind a "target unhealthy" skip); tier / subagent /
   array-default / ladder specs naming a provider disabled by an unset `${ENV}` now degrade with a
   warning instead of aborting startup, and the one remaining fatal case (a single-spec
   `routing.default`) names the unset variable rather than accusing the operator of a typo.
7. **`CircuitBreaker.getStabilityScore()` deleted** — its last consumer had migrated. A `number`
   return cannot say "nothing measured", which was the whole defect; `getMeasuredStability()` +
   `hasObservations()` are the pair that can.

Also delivered in the same pass, from "Not in this run": **`leave_me_alone`**, the onboarding-nudge
suppression list. Entries matching no known provider are legal on purpose (the list stores the
negative space), and it silences the nudge ONLY — suppressed providers stay visible in
`llm-relay keys`, `/registry`, telemetry and `candidates`.

## Still open

- **7 findings the operator left out of scope.** Named examples: `ping/quota.ts:28` hardcodes an
  `openrouter.ai` URL against the provider-agnostic invariant, `ping/ping.ts:58` hardcodes provider
  NAMES to decide a disabled-thinking toggle (same class, found during the run), and
  `presets.ts:149` asserts `x-api-key` while `authEnv.ts:33` accepts the bearer-shaped
  `ANTHROPIC_AUTH_TOKEN`. These were an explicit operator decision, not an oversight — reopen them
  deliberately or not at all.
- **`scripts/install-skill.mjs` registering llm-relay in the global `~/.claude/CLAUDE.md`.**
  Proposed, then **dropped by the owner (2026-07-30)**. Don't re-propose it as an oversight: the
  cost is that every global install/upgrade writes to the user's own global instruction file.

## Residual risks, recorded rather than repaired

- **Test-plan assertion polarity was assigned by a content heuristic**, and the gate checked only
  that both polarities were PRESENT, not that each was CORRECT. An independent reviewer found 12
  `NEGATIVE:` assertions with no failure-marker language and 5 phrased positively.
- **Two mandated-independent review phases were self-performed in the PREVIOUS run** after five
  dispatch attempts failed with API 5xx/529. The final run dispatched the judge independently,
  which partially discharges it; the earlier critique round remains self-graded.
- `CP-NODE-12-f01` is recorded `accept_failed` in the tool's ledger even though its work is on the
  branch — the planner split that node by file list while giving both fragments identical
  instructions. **Not** unfinished work.

## Deliberate intermediate state (not bugs)

- `credentialState`'s `declared-missing` branch throws from `buildForwardHeaders`. It should be
  unreachable now that `resolveTargets` drops keyless targets, but it is deliberately loud so a
  future routing change fails instead of egressing whatever the caller sent.
- Several existing tests pin the defect they should catch. A correct fix in this codebase can
  legitimately turn the suite red — read the failing test's stated reasoning before assuming the
  change is wrong.

## Where the machine-readable state lives

`.audit-tools/` — **untracked, local-only**; `git clean -fd` destroys it. `remediation-report.md`
holds the per-obligation evidence, `remediation/friction/run.json` the process friction. The audit
deliverables (`audit-findings.json`, `audit-report.md`) are tracked by an explicit `.gitignore`
allow-list. This document is the committed source of truth.
