# HANDOFF

Entry point for any agent picking up llm-relay, on any provider. Read this before `CLAUDE.md`.

## 0. State as of 2026-08-28

**Latest — the two approved v0.54.0 hand-back items shipped (v0.56.0).**

- **Digest-keyed `eligibility accept`.** Every printed propose/accept command now carries
  `--sig <digest>` (`signatureDigest` in `refusal-interpretation.ts`: ten hex chars of SHA-256
  over the signature), the listing prints each pending item's digest, and a present `--sig`
  resolves the entry authoritatively — a stale index is corrected with a stderr note, an unknown
  digest exits 1 touching nothing. The bare index stays valid against a fresh listing.
  ⚠ Found and fixed while wiring it: the STATUS listing's "accept with:" line dropped
  `--cost-class`, so a later `llm-relay eligibility` printed a command WIDER than the proposal it
  echoed. Both call sites now pass the full proposal, pinned behaviorally (rendered-output tests
  in `test/cli.test.ts`) and by an argument-list grep widened to both sites
  (`test/fact-cost-class.test.ts`). ⚠ History correction from the independent closeout auditor:
  the `3d2fcee` commit message blames v0.55.2 for "missing" this call site — wrong. The listing
  omission dates from the flag's INTRODUCTION (`7412435`, v0.52.0); v0.55.2 fixed the separate
  `acceptInterpretation` store-persistence half and never touched `cli.ts`.
- **Provider-stated spend headroom** (`src/spend-headroom.ts` + `PingLoop.pollSpendHeadroom`).
  The ping loop asks each OpenRouter credential's key endpoint every 15 minutes (zero egress for
  every other provider) and feeds the stated `limit`/`usage` into the SAME fact the accepted
  weekly-limit interpretation produces: `allowance-exhausted`, credential scope,
  `costClasses: ["paid"]`. `usage >= limit` records it; `usage < limit` retracts ONLY
  paid-only-filtered rows (`clearPaidAllowanceFacts` — a paid-credit statement cannot disprove a
  free-tier exhaustion); no stated limit changes nothing. Design reasoning is in the
  `spend-headroom.ts` CLAUDE.md row — notably why this feeds the fact store and not the quota
  ladder (spend is not a `QuotaAxis`, and the credits answer states no reset, so quota demotion
  could never gate it without an invented cooldown).
- **The "OPEN: dashboard-package-check cannot run on Windows" item is CLOSED as
  not-reproducible** — see §6.
- Process: both features implemented in the main session; the new tests ran against a
  `git stash push -- src/` tree first — 4 CLI tests and the 4 spend BEHAVIOR tests failed
  pre-fix, naming the right defects. ⚠ Stated precisely, because the auditor probed it: a plain
  `src/`-pathspec stash does NOT stash the UNTRACKED new `spend-headroom.ts`, so its 5 pure
  classifier/apply tests kept passing against the new module while the 4 that depend on the
  reverted `cadence.ts`/`target-facts.ts` failed. For a brand-new module the pure-function tests
  have no "un-fixed tree" to fail against; the control is meaningful only for the behavior the
  old tree lacked, and that is the part that failed.

**Earlier — the assessment's leftover findings closed on external lanes (v0.54.0).** The
"Remaining open items" ledger of
[docs/three-axis-assessment-2026-08-28.md](docs/three-axis-assessment-2026-08-28.md) is now
closed except the two lines it keeps deliberately (the learned context ceiling never reaching
the request-path guardrail, unobservable while the store holds zero such facts; and the
`orderByUsability` dead seam). Seven items shipped as five lane packets, every one implemented
on a relay free-pool or pinned-member lane, none by the orchestrator: the `sync-tiers`
artificial_analysis drift guard; `GET /v1/models` resolving real context windows (pool minimum
via `specContextWindow`, 272,000 kept only as the named unresolvable-id fallback); template
declarations for cerebras and cohere plus a live-verified cohere preset, making the QUICKSTART
Stage 2 rows true; the Anthropic front's double `observeEligibility` count; the cooling band
ordered by soonest known lift on both fronts; `headroomBand` gaining the UTC-period gate; and
the `recordCall` JSDoc. The package size ratchet fired during integration — cross-release
creep, not one change — and the baseline was regenerated in its own commit.

Process facts that outlive the sprint:

- **Two of five lanes shipped regression tests that passed on the UN-FIXED tree.**
  Lane D asserted the dedup-keyed fact store, which is structurally blind to a doubled
  observation (the observable is `pendingRefusals().count`); lane B's every assertion was
  satisfiable by the 272,000 fallback, and one read the LIVE snapshot (the exact
  never-pin-live-data gotcha). The orchestrator's pre-fix control caught both; the adversarial
  review lane caught neither. (This bullet first said "three of five" — the independent
  closeout auditor counted the commit evidence and corrected it.) **Run every new test against
  the un-fixed tree yourself; do not delegate that control.**
- **The independent closeout auditor also caught a LIVE bug the whole pipeline missed, fixed
  in v0.55.2:** `acceptInterpretation` silently DROPPED `--cost-class` — its parameter type
  lacked `costClasses`, a spread into `override` defeats the excess-property check, and the
  persisted literal copied six named fields — so the OpenRouter weekly-limit accept persisted
  a verdict covering EVERY class, the exact over-demotion the flag exists to prevent. The
  shipped "round-trip" tests were source-text greps and pinned nothing; the replacement tests
  read the store FILE back after accept (pre-fix: "expected undefined to deeply equal
  ['paid']"). The operator's live entry was repaired in place the same evening (backup:
  `refusal-interpretations.json.bak-2026-08-28-pre-costclass-repair`). ⚠ An evidence-only
  auditor (repo path + start commit + closeout text, nothing else) is now a proven step: it
  corrected the orchestrator twice in one closeout.
- **A five-lane burst degrades the free pool it runs on.** OpenRouter's weekly spend-limit 403
  ended one headless lane (a `claude -p` session dies on 403), the pool's 402-prone members
  cooled under the burst, and two more lanes died with the client's generic model error.
  Recovery that worked: relaunch each dead lane pinned to a DIFFERENT healthy free member from
  `/candidates` (kilo nemotron, nim nemotron, mistral) so lanes sit in separate quota domains.
  Mistral's lane survived 2.1 h and died of its own 402 AFTER finishing the diff — the work
  was intact in the worktree.
- Codex is quota-dead until Sep 3 (probed; exit 0 with a usage-limit body — the recorded
  trap), so Codex carried nothing this sprint.
- Two smaller frictions, so nobody re-hits them: piping a gate through `| tail -N` and then
  reading `$?` reports the TAIL's exit and hides the failure — the ratchet failure surfaced
  only on a full-output rerun; and a write lane cannot append to the log its own launcher
  holds open (`Out-File` keeps the handle) — lane self-reports belong in the digest file.

**Earlier — the three-axis assessment and the four decisions it produced (v0.53.0).** The owner asked
how well the relay handles (a) tracking quota/rate/capability/capacity from different sources,
(b) steering traffic through a single verb, and (c) working from Claude, Codex, OpenCode and other
IDEs. Six auditors read source, every gap claim went to an adversarial verifier (60 claims, **51
refuted**), and the report adds first-hand measurement against the running relay:
[docs/three-axis-assessment-2026-08-28.md](docs/three-axis-assessment-2026-08-28.md).

**The finding that mattered was not in the code — it was in the code's OUTPUT.** The quota
architecture is genuinely excellent and the live signal was nearly empty: 3 of 216 candidates
carried a provider-stated observation and **none** was routing-eligible; 0 configured limits; 0
learned rate-limit measurements in 7 days; 0 of 1223 catalogued models publish one. What actually
gated traffic was the breaker's blind 429/402 escalation — which was **memory-only**. Capability was
the opposite: 216/216 exact matches on synced-snapshot basis.
⚠ **Read a pipeline's output files, not only its source.** Six auditors graded the code correctly
and the grade only moved on `target-facts.json`, `refusal-interpretations.json`, `probe-cache.json`
and `usage/`.

All four owner decisions were approved and shipped:

- **Unknown-period observations that state their own reset are now admitted.** The recorded
  rationale ("a bucket without a known period cannot reach a boundary to expire at") was falsified
  by the wire — groq states limit, remaining AND reset on a header whose NAME carries no period.
  `QuotaBucket.period` widened to `QuotaPeriod`, which made the compiler enumerate all three ledger
  consumers; they now share one `localUsedForPeriod` helper.
- **The stability composite is scaled by availability, not plus 20% of it.** Live: 27 zero-success
  deployments scored above 50 and one at 1-success-in-12 scored 81; recomputed after, that is 0 and
  8. `-1` now means "never probed", not "no measurable sample".
- **Breaker cooldowns and the 429 escalation ladder persist** (`breaker-persistence.ts`). A restart
  was discarding a 19.9-hour cooldown learned from 7 failed requests.
- **`DEFAULT_CONFIG_TEMPLATE` declares the Anthropic passthrough**, so a fresh install matches what
  README/QUICKSTART/SKILL all promise, plus a first-run marker and `llm-relay routing answered` — the
  skill now tells the agent to ASK the operator what they want on first use.

Three process lessons worth more than the commits:

- **A negative-control test caught a hole in the fix it was controlling for.** `resolveRemaining`
  rung 2 still subtracted a ledger figure for an unknown period (returned `-39`). Write the controls.
- **The first-run test caught a defect worse than the bug.** Declaring the passthrough makes
  `mode: "repair"` a hard load error without a `reshaper`, so the template as first written would
  have made *every* fresh install fail to start.
- **Mutation-check a new guard.** Neutering `restoreCooldowns` to `return 0` fails exactly the two
  tests that claim state survives a restart — which is how you know they can observe the bug.

⚠ **One assessment finding was RETRACTED and left visible in the ledger:** the claim that
`routing show` and `pools` flatly contradict each other. They do not — `routing show` prints
`poolPolicies` beside the empty `pools`. The original evidence came from a probe script that
filtered the output to `.pools`, manufacturing the contradiction it reported.

**Earlier — the advisory-findings verification sprint.** The 2026-08-26 uncovered-areas review ended
by saying its remaining 13 cross-cutting and 19 type-level lane findings "remain advisory and
unverified — do not treat them as a work queue". That was right, and it left 32 unchecked claims.
This sprint checked all 32 against source. Full ledger, the Class A / Class B distinction, the three
lane reports that were wrong and how, and everything deliberately left:
[docs/advisory-findings-verification-2026-08-28.md](docs/advisory-findings-verification-2026-08-28.md).

**The result was ONE bug class, not a list.** An open classifier over a CLOSED union — an
unconditional `else`, a bare `default:`, or a runtime list hand-copied from the type — where the
fall-through resolves to the **stronger** claim. v0.50.0 had fixed one instance without naming it
(`FactKind`); **seven more survived, in seven different modules**, and all seven are now closed.
The class is written up in `CLAUDE.md`'s gotchas, because the next instance will be somewhere none
of these touch.

Three things from it that outlive the sprint:

- **A `deadline` outcome must reach the breaker.** While converting the breaker's provenance branch
  into a table, an implementing lane wrote `deadline: false` — which would have left a timing-out
  deployment permanently healthy, in the component whose paradigm case is a hanging provider. **The
  full gate passed with that regression**, because nothing covered the path. There is a live guard
  for it now in `test/closed-vocabulary-routing.test.ts`.
- **A corrupt lane manifest was EVICTING a healthy lane.** Not throwing — `"x".id` is `undefined`,
  so the roster check simply returned false and reported `not-servable`. That contradicts the
  module's own comment and this repo's "corrupt ⇒ UNKNOWN, nothing evicted". ⚠ A test asserting
  only "does not throw" still passes on the old code; assert `status === "unknown"`.
- **`JSON.stringify` cannot express `Infinity`.** A lane's fixture for the catalog's
  permanently-fresh bug was built with `JSON.stringify({ fetchedAt: 1e309 })`, which emits
  `{"fetchedAt":null}` — so the test never contained the value under test and passed identically
  before and after the fix. Build such a fixture from raw JSON text.

⚠ **Making a classifier total surfaces live bugs the analysis missed.** It did twice here: an
optional `contextWindowSource` was already rendering as "published by the serving provider", and a
test fixture had hidden a missing required `authHeader` behind `as unknown as`. Expect that, and fix
what surfaces rather than restoring the fall-through.

⚠ **The single most useful process lesson: "gate green" proved nothing three times.** Every one of
the five implementing lanes needed correction, and **three of five shipped a fixture that could not
observe the bug it was meant to pin** — `JSON.stringify` cannot express `Infinity`; a hand-thrown
`AbortError` never matches a real `AbortSignal.timeout` (which aborts with `TimeoutError`); and four
temp-cleanup tests aimed at a "non-existent parent directory" that the writer itself creates. In
each case the test passed identically before and after the fix. One lane also reported green with
**no tests at all**, and another reported green while carrying a routing regression. **Run every new
test against the un-fixed tree and read the failure.** The full friction list is in the sprint doc.

Five commits: `aabac49` (label unions), `1546b19` (persisted evidence stores), `ab75f65` (routing and
health unions), `cd6e5f8` (bounded probes, ping sockets), `82c084f` (fact prune, temp cleanup, spend
in the coherence guard).

**Earlier — the documentation pass (v0.50.0, `f077a4d`..`63248ec`).** A pass over the whole doc set
against source, plus the tidy it turned up. Ten parallel auditors, every finding adversarially
verified and then re-checked first-hand before anything changed. Full ledger, the two findings
worth reading on their own, everything deliberately NOT done, and the friction:
[docs/documentation-pass-2026-08-27.md](docs/documentation-pass-2026-08-27.md).

Three things from it that outlive the sprint:

- **`llm-relay eligibility` told the operator that six of the ten fact kinds meant "gone from the
  provider — excluded from pools".** A ternary with an unconditional else-branch, so `rate-limited`
  and all five measurements inherited `not-servable`'s meaning — against the store's own
  `COST_BLOCKING` set. Now a `Record<FactKind, string>`.
- **Subagent detection has THREE signals and `docs/subagent-routing.md` documented two**, including
  in the re-verification recipe CLAUDE.md sends you to. It could not observe a Codex subagent even
  in principle. ⚠ For Codex, `x-codex-turn-metadata` is not one signal of three — it is the whole
  set, because a `/v1/responses` turn has no Anthropic `system` field to carry the marker.
- **Every artifact honours XDG now, through one policy** (`src/state-paths.ts`). Thirteen
  hand-rolled resolvers ran THREE policies, so with `XDG_CACHE_HOME` or `XDG_CONFIG_HOME` set the
  state directory SPLIT and `~/.llm-relay/` was not a complete backup. Raised as an owner decision
  and answered the same day. ⚠ **Upgrading moves nothing:** the legacy path still wins whenever it
  holds the file and the XDG one does not, so an existing keystore can never read as empty and
  there is no migration to run. Detail in the `state-paths.ts` row of CLAUDE.md.

⚠ The pass's own verification was incomplete and did not say so: a spend limit killed 43 of 81
agents, and a finding whose verifier DIED was folded into the refuted pile by the run's
`real === true` filter. Eight real findings were recovered by hand from `journal.jsonl`. A fan-out
verify stage must be able to say "the verifier never answered" — a `boolean` verdict cannot.

**Earlier — the uncovered-areas sprint (v0.49.0).** [docs/complexity-review-2026-08-25.md](docs/complexity-review-2026-08-25.md)
§6 recorded two gaps in its OWN coverage: the cross-cutting reviewer (JSON-store persistence,
auth-header construction, vitest temp-dir guards, spec parsing, fetch retry wrappers) failed before
returning, and no reviewer had proposed type-level simplifications — which it called the richest
unexplored seam. Both briefs were re-run, every claim acted on was checked first-hand against
source, and **nine defects were confirmed and fixed** across seven packets (`2920365`..`8192b43`).
Full record, including everything left advisory:
[docs/uncovered-areas-review-2026-08-26.md](docs/uncovered-areas-review-2026-08-26.md).

The headline is a real routing bug: `quota-demotion.ts` memoized the ledger window under a
PERIOD-only key while storing an already axis-projected value, and `bucketRank` puts requests
first — so any period carrying both buckets resolved the TOKENS axis from the REQUESTS count and
failed to demote a spent token allowance. `hard-cap.ts` had always keyed `scope:period:axis`
correctly; one of the two modules asking the ledger the same question got it wrong.

The rest, in one line each:

- `330f475` the OpenRouter quota probe matched a SUBSTRING of a provider's name or base and then
  posted that slot's credential to a hardcoded `openrouter.ai`. Now an exact-host test on the
  configured base, with the URL rebuilt from it. Also: the catalog cap warning stopped printing
  the configured base URL.
- `b7d2311` `pool-health` reported `auth` on a model-specific 401/403 (the entitlement-wall case
  the invariant names) and `missing` on a 400; `key-checker` called every 5xx "Key verified". Each
  verdict now claims only what its evidence supports.
- `5bbe788` the served-response announcement set had two owners that had drifted twice: the
  Anthropic front omitted `x-llm-relay-served-by` on a terminal error, and the OpenAI front dropped
  `x-llm-relay-unknown-refusal` when a later candidate succeeded. One owner now.
- `6f8608b` four drift seams around the availability vocabulary — two mappers whose
  `default: return null` swallowed every future member, a table that reported a missing row at the
  index site, and a third hand-copy of the quota bucket key.
- `b34e731` "Under vitest every default path redirects to a temp dir" was FALSE for six artifacts,
  `.env` included — and `loadEnvFile` READS it into `process.env`. True now, and pinned by one
  mechanical table.
- `8192b43` `llm-relay eligibility accept` never reached a running relay: the store memoized on
  path alone, so the documented "only `accept` makes an interpretation affect routing" needed a
  restart. Stat-keyed now, with a merge that cannot overwrite an operator's acceptance.

Process: every packet gate-verified twice, every new test confirmed to fail pre-fix, and **every
packet needed correction in review** — the recurring shapes are named in the review doc's
"What landed". Five of seven were implemented on relay free-pool lanes, which this sprint proves
are a working WRITE lane for in-repo packets; both Codex lanes hit model-scoped quota limits
mid-sprint.

**Earlier — the 2026-08-26 §5 implementation sprint (v0.48.0)** — the nine §5 items ranked worth
the churn, shipped as eight commits (`3561bb4`..`b9409e3`); items not picked keep their verdicts
in [docs/complexity-review-2026-08-25.md](docs/complexity-review-2026-08-25.md) §5, and git holds
the per-commit detail.

**Earlier — the 2026-08-25/26 complexity sprint (v0.47.0/v0.47.1)** — all seven verified findings
of the same review closed (`06d4581`..`adbd5c4`); the §5 verdict table lives in that doc, and the
process notes that generalize (agy drops long print-mode reports — long-report verification
belongs on relay free-pool lanes; reviewer shells leak junk files — stage with explicit
pathspecs) live in agent memory (`no-fable-subagents`). Per-commit detail: `git log`.

## 0.1 Earlier releases

Deliberately NOT restated here. This file holds current state plus the immediate next; a
release-by-release narration is a changelog, and git already has it. `git log --oneline` and the
tags are the trail.

What survived those sprints lives in its own home rather than in a history section:

- **v0.46.0, the dialect-rescue destructive filter** — the last safety-shaped code gap. Its rule
  is a CLAUDE.md gotcha ("The destructive refusal binds at the DIALECT-RESCUE commit point too"),
  and its design is [docs/dialect-rescue-destructive-refusal-2026-08-24.md](docs/dialect-rescue-destructive-refusal-2026-08-24.md).
- **v0.45.0, the custody program** — `src/os-keyring.ts`, `src/keystore.ts`, the resolver keystore
  rung and the `keys` lifecycle CLI. Plan, recon corrections and the seven build decisions:
  [docs/custody-sprint-plan-2026-08-24.md](docs/custody-sprint-plan-2026-08-24.md). Residuals: §6.
- **v0.40.0–v0.44.0, the metering program** — closeout ledger and every gap/stage/decision table:
  [docs/metering-reconciliation-2026-08-22.md](docs/metering-reconciliation-2026-08-22.md) §7.
- **Every standing trade and open question** those sprints produced: §6 below, which is the one
  place they are tracked.

## 1. What still binds

These were **not** removed and are load-bearing. Do not relax them:

- **Loopback only.** Startup refuses a non-loopback bind. But loopback is not authorization —
  mutating endpoints carry admission checks plus a capability token.
- **Logs are metadata only**, enforced at the sink by an allow-list in `src/log.ts`. Never headers,
  never bodies, never URL parameter *values*.
- **The repair boundary.** The proxy fixes protocol *form* (malformed tool calls), never *judgment*.
  No LLM opinion may enter the request path. Routing comes from config and deterministic
  classification.
- **Destructive tool calls are refused, never fabricated.**
- **Health demotes, never drops.** Learned from a real outage where filtering unhealthy candidates
  narrowed a pool to nothing.

The invariant recalibration is applied and authoritative in `CLAUDE.md` §Invariants and
`docs/project-goals.md`; the retired rules and their replacements are recorded in
[docs/rubric-recalibration-2026-08-16.md](docs/rubric-recalibration-2026-08-16.md) §2 and in git
history - do not reintroduce them.

## 2. Where to read

| Document | For |
|---|---|
| `CLAUDE.md` | Architecture map, file-to-responsibility table, gotchas. Invariants are authoritative there. |
| `docs/metering-reconciliation-2026-08-22.md` | Implemented vs open against the quota-metering spec: gap/stage/decision tables, both-fronts and provenance checks, remaining-items list. |
| `docs/rubric-recalibration-2026-08-16.md` | What went wrong, the revised invariants (copy-ready), 55 re-adjudicated rejections |
| `docs/credential-fleet-design-2026-08-16.md` | Custody, pooling, cost accounting - components, staged build order |
| `docs/quota-metering-spec-2026-08-16.md` | The metering pipeline - metrics, collection sites, storage, stages |
| `docs/spa-dashboard-design-2026-08-20.md` | Read-only Analytics SPA implementation design, protocol, contract, staged gates |
| `docs/open-decisions-2026-08-16.md` | Owner decisions; all recommendations approved 2026-08-21 |
| `docs/rejection-ledger-2026-08-16.md` | Every past rejection and its reason, grouped by reason-kind |
| `docs/evidence-2026-08-16/` | Machine-readable audit trail |
| `docs/reference.md` | Full user-facing reference, including provider credential fleets and protected diagnostic surfaces. |
| `docs/documentation-pass-2026-08-27.md` | The 2026-08-27 doc-vs-source pass: what was wrong and in what classes, the two findings worth reading alone, what was deliberately left, and the friction. |
| `docs/advisory-findings-verification-2026-08-28.md` | The 2026-08-28 pass over the 32 advisory findings the 2026-08-26 review left unverified: the closed-vocabulary bug class and all eight of its instances, the Class A (fix) versus Class B (defer) distinction, the verdict ledger, the three lane reports that were wrong and how, and what was deliberately left. |
| `docs/dispatch-integration-review-2026-08-27.md` | Cross-CLI dispatch: how the ladder is actually executed, the verified agy console-window cause and its host-side fix, agy's five-category permission vocabulary (three of its four entries had been inert), ACP as the verified cross-CLI transport, ranked options, open tests, and the friction. |

## 3. Verification — the one gate

```bash
npm run build && npm run check
```

`npm run check` = both typechecks (`src/` and `test/`) + the server vitest suite + the dashboard
checks (`tsc -p dashboard/tsconfig.json --noEmit` and the dashboard suite) + the package checks
(bundle-inventory equality, size ratchets, packed smoke). **CI runs exactly this and nothing
else.**

- Bundle sizes live in `docs/dashboard-package-baseline.json` and are ratcheted: regenerate the
  baseline in the SAME change that adds or removes bundle weight, or `check:package` goes red.
- Tests read `src/` directly; `scripts/*.mjs` read `dist/` - rebuild before running any script.
- Four POSIX-permission tests skip on Windows; CI's ubuntu leg is the only place they run, so a
  green local Windows run is not full coverage of secret-file permissions. A store path nested
  under a regular file reads as `ENOENT` on Windows but `ENOTDIR` on Linux, so fixtures that
  require an absent load must inject the stat/read seam rather than relying on that filesystem shape.
- A failing test may be pinning a defect it should have caught. Read its stated reasoning before
  assuming your change is wrong, and fix test and source in the same commit.
- **A test that does real machine work has the machine's worst case in its 5 s budget.** Two CLI
  tests flaked for weeks — `test/cli.test.ts` "quotes the task…" and
  `test/accounting-cli-lifecycle.test.ts` "constructs one store…" — always passing alone, failing
  only under a loaded `npm run check`. Root cause (2026-08-25): `src/winenv.ts` `readScope` spawned
  `reg query` TWICE with `timeout: 5000` **each**, on the `loadOrExit()` path every CLI test file
  reaches, while vitest's default test budget is also 5000 ms. Measured ~50–70 ms idle but
  2806–4045 ms with the 108-file suite competing for process creation, and one run at 5265 ms. It
  was also the last unguarded real-world side effect in `src/` — it merged the developer's own
  registry environment into worker `process.env`. Fixed at the root with the VITEST guard every
  sibling module already had (`secret-file-acl.ts`, `os-keyring.ts`): skip the spawn unless the
  `read` seam is injected, which `test/winenv.test.ts` always does. Both tests now run in 7–10 ms,
  flat. ⚠ The lesson generalizes: a fix that only raises one test's timeout moves the flake to
  whichever test next becomes its file's first `loadOrExit()` caller — which is exactly what an
  earlier partial fix (`50e8233`, a `beforeAll` import warm-up) left behind.
- Static analysis (`npm run analysis:run`) is advisory and deliberately outside the gate.

## 4. Things that will bite you

- **Do not trust this repo's documentation without checking source.** Drift here has been
  recurrent. THREE mechanical axes are guarded now — `test/architecture-map.test.ts` (every
  non-index `src/` file has a `CLAUDE.md` table row), `test/scripts-inventory.test.ts` (every
  `scripts/*.mjs` is named in `scripts/CLAUDE.md`, and no name there is dead), and
  `test/doc-links.test.ts` (every relative link in the shipped doc set resolves, and no `.md`
  target wears a line-number fragment). ⚠ Everything a doc SAYS is still unguarded: what a module
  does, what a default is, which release shipped what. The 2026-08-27 documentation pass found
  stale claims in all of those classes. Verify before inheriting them.
- **A CLI process's environment is not the running relay's environment.** On Windows a User-scope var
  enters a process only at start, and the relay launches at logon. `llm-relay keys` reports *its own*
  env; `GET /registry` is authoritative. A whole "half the pool is dead" finding was once this.
- **Worktrees.** If work happens in a git worktree, edit and run tests *in that path*. `vitest.config.ts`
  scopes the suite to this checkout's `test/` on purpose — do not widen it.
- **Liveness checks.** llm-relay's `/health` and `/ping` return **403 by design** (they are control
  routes); use `/telemetry`. freellmapi's `/health` returns **200 unconditionally** from an SPA
  catch-all — its real route is `/api/health`.
- **Never put `--permission-mode plan` in a `cliLane` template.** Headless `claude -p` has no
  `ExitPlanMode`, so the lane can never leave plan mode and looks healthy while completing nothing.
- **Headless offload lanes must be told not to stop and ask.** An Ox-Alpha or `claude -p` lane
  that ends its turn with a clarifying question reads as a completed task that did nothing.
  Instruct it to decide and proceed on its own judgement, and to report rather than await approval.
- **FIXED 2026-08-22 — the owner's `cliLane` template no longer places `{task}` after the variadic
  `--allowedTools`;** it now sits directly after `-p` (pre-order backup at
  `~/.llm-relay/config.json.bak-2026-08-22-pre-clilane-task-order`). The lesson stays: some shells
  let a variadic option swallow what follows it, so keep `{task}` BEFORE any variadic flag, and
  confirm a template with one real headless run before trusting a lane built from it.
- **Claude Code has THREE client-side idle timers that abort a long silent generation at ~300 s
  on a custom base URL** — event-level + byte-level streaming watchdogs, and the body idle
  timeout. The relay's commit probe (`src/stream-commit.ts`) holds bytes until meaningful
  content, so a long think looks idle to all three. `routing.cliLane.env` now carries
  `CLAUDE_STREAM_IDLE_TIMEOUT_MS=1800000`, `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=1800000` and
  `API_FORCE_IDLE_TIMEOUT=0` so a lane child outlives its own thinking; set the same three in any
  hand-written CLI rung.
- **FIXED in v0.39.0 — the tool-call IR envelope that reached `claude -p` clients as TEXT.** Root
  cause was REQUEST-side (`docs/tool-call-dialect-leak.md` §"Second mechanism"): `backend.ts` handed the
  Anthropic conversation to llm-bridge's `universalToOpenAI`, which stringified its IR envelope into the
  outbound prompt (no `tool_call`/`tool_result` case), so models echoed the notation, agentic prompts
  were ~3x inflated, tool results triplicated and no `role:"tool"` messages were sent.
  `src/openai-request.ts` now owns the request direction; llm-bridge keeps responses. Expect prompts to
  shrink ~3x (provider caches miss once) and `role:"tool"` messages to appear for every `openai`-kind
  target; run `llm-relay pools --probe` after an upgrade. Diagnostic tell for any recurrence: leaked
  ids are the model's own (uuid / `Grep:0`), never `toolu_*`.
- **When the preferred pool member is rate-limited, `pool/xhigh` falls through to members with
  standing 402/403 refusals whose error ends a headless claude session.** Addressing a member
  directly (`--model openrouter/stealth/ox-alpha`) avoids the fall-through. Health demotes, never
  drops — so spent members stay walkable by design; the fix direction is eligibility facts or the
  G2 cap, not dropping.
- **Free-lane reliability, 2026-08-24:** ollama-cloud free tier returned 429 "weekly usage limit".
  Codex quota reset on 2026-08-24 (live-probed), so the dispatch ladders are back to the 2026-08-08
  promotion arrangement: codex-sol leads every tier; spark is second in low/medium only; terra and
  luna stay parked (backup `config.json.bak-2026-08-23-pre-codex-reenable`). NIM is DOWN for this
  account since ~21:51 PT 2026-08-23: every kimi-k3 and minimax-m3 completion returns 403
  `{"detail":"Authorization failed"}` identically through the relay and direct with the same key,
  while `/models` still authenticates, so `llm-relay keys` reports VALID. This was account-wide at
  NVIDIA and relay-blameless — RESOLVED 2026-08-24 by rotating the NVIDIA key: kimi-k3 and
  minimax-m3 answer 200 again, direct and through the relay (relay restarted with the fresh key —
  note a User-scope rotation reaches a process only at start, so the relay and any old shell must
  be restarted to see it). Kimi-k3's repeated tool-call ids are still fixed in v0.41.0 (`8473cb1`,
  `src/tool-use-ids.ts`) once NIM recovers.
  `openrouter/nvidia/nemotron-3-ultra-556b-v2` is also de-listed on OpenRouter (400 "not a valid
  model ID"); cached candidates can be stale about both failures.
- **Two heredoc groups in one Bash call break quoting in this harness.** One heredoc per call.
- **`gh run watch` on a PASSING publish run shows an `X tier-data.json missing or empty`
  annotation.** It comes from the smoke step's DELIBERATE negative test (publish.yml deletes the
  file and requires exactly that error — "PASS-AS-EXPECTED"), and GitHub renders the `::error::`
  as a failure annotation anyway. Judge a run by `conclusion`, never by its annotations.
- **The vitest interpretations/fact stores are per-PROCESS files, so entries leak between tests
  in one file.** `resetInterpretations()` drops the memo, not the file — a later test's
  `pendingRefusals()` sees every entry earlier tests flushed. Assert entry-specific facts
  ("this signature is still pending"), never queue lengths.
- **A recorded "open gap" is a claim like any other — verify its MECHANISM before working it.**
  The §6 Windows package-check entry cited backslashes in the generated graph; `toPortablePath()`
  had normalized that path since the plugin's first commit, and a fresh build + check passed
  first try. The real v0.55.0 failure was the entries ceiling, already fixed. Ten minutes of
  reproduction beat an afternoon of fixing a defect that did not exist.

## 5. Definition of done

- `npm run build && npm run check` green on a clean, committed tree.
- Both request paths covered by any new policy.
- New behaviour pinned by a test. Failover tests use **≥2 candidates** — with one candidate,
  "fails over correctly" and "cannot fail over" are the same observation.
- Commit trailer names the model that authored the change:
  `Co-Authored-By: <model> <noreply@anthropic.com>`.
- No half-done state. Deliberate intermediate states must be called out explicitly so they are not
  mistaken for bugs.

## 6. Outstanding, unclaimed

⚠ What follows is **recorded trades and closed items kept for their reasons**, not a work queue.
There is currently NO open code gap.

- **CLOSED 2026-08-28 evening, NOT REPRODUCIBLE: the "dashboard-package-check cannot run on
  Windows" claim.** Verified on this Windows machine the same day the entry was recorded: a fresh
  `npm run build` followed by `npm run check:package` passes both halves, and the generated
  `dashboard-bundle-graph.json` holds zero backslash paths — `toPortablePath()` has normalized
  `packagePath` at the generation site since the plugin's first commit (`b4ec7ee`), so the claimed
  mechanism does not exist on this tree. The v0.55.0 failure that prompted the entry was the
  entries-CEILING ratchet (real, fixed by `4f8c7c9`'s baseline regeneration), not a portability
  refusal. The tarball-measurement workaround is therefore unnecessary; regenerate the baseline
  with the normal local run.

**From the 2026-08-28 verification sprint** — every item with its reason is in
[docs/advisory-findings-verification-2026-08-28.md](docs/advisory-findings-verification-2026-08-28.md)
"Still open, with its home". In short: four **Class B** findings (a type wider than its producers,
which no producer can reach) are hardening and deferred — type-level 2, 8, 14, 15; type-level 12 is
deferred until someone can show acceptance-equivalence by differential fuzzing, because it governs
what LOADS and a quarantined shard is a lost day of ledger; type-level 7 is narrowed to a real
transparency gap (a hard cap's `used` carries no provenance) and is an owner decision, not a wrong
refusal. Response-SIZE bounds on the probe paths and the `withBudget` non-cancelling race are named
as out of scope in `cd6e5f8`.

**Owner decisions, 2026-08-28 evening (v0.54.0 hand-back):**

- ~~**APPROVED, next sprint: digest-keyed `eligibility accept`**~~ — **DELIVERED in v0.56.0**
  (§0): accept takes a signature digest beside the index, because queue positions shift between
  invocations and a `propose` can silently land on the wrong refusal (it did, twice).
- **WITHDRAWN: the currency-per-week spend ceiling.** The owner never asked for it; it was an
  agent-recorded candidate. Do not re-raise it as an open item.
- **EXECUTED: the OpenRouter weekly-limit interpretation is accepted** —
  `allowance-exhausted, scope credential, --cost-class paid`, so paid OpenRouter deployments
  demote while the condition cools and free ones stay walkable. Self-healing on both sides: any
  paid success clears the condition, so buying credits un-demotes without an operator action.
- ~~**NEW owner-endorsed direction: stop inferring paid-credit state — ASK OpenRouter.**~~ —
  **DELIVERED in v0.56.0** (§0, `src/spend-headroom.ts`): the ping loop polls the key/credits
  endpoint and feeds the answer into the fact store, so the paid/free boundary comes from the
  provider's own statement instead of a learned refusal, and updates in both directions. ⚠ It
  deliberately feeds the FACT store, not the quota ladder — spend is not a `QuotaAxis` and the
  credits answer states no reset, so the quota-demotion path could never gate it without an
  invented cooldown duration.
- **Type-level 7 stays as recorded** (hard-cap `used` without basis provenance) — owner chose
  keep-as-is.

**CLOSED 2026-08-27 — the XDG state split.** Raised by the documentation pass as an owner decision
and answered the same day: **honour XDG everywhere**. Thirteen hand-rolled resolvers running three
policies collapse into `src/state-paths.ts` (config-kind → `XDG_CONFIG_HOME`, cache-kind →
`XDG_CACHE_HOME`). ⚠ The option's stated cost — that it MOVES `config.json`, `.env` and the
keystore for anyone with the variable set — is bought off by the legacy fallback rather than by a
migration: `relayStatePath` returns the legacy path whenever the XDG one is ABSENT and the legacy
one EXISTS, so an existing install keeps reading and writing exactly where it does today and a
fresh install with XDG set is fully XDG. Nothing is copied, nothing is deleted, and there is no
migration step to forget. `test/state-paths.test.ts` pins the policy AND greps `src/` so a
fourteenth resolver cannot reintroduce a raw XDG read.

### Recorded trades and closed items

**From the 2026-08-27 uncovered-areas sprint** — every item, with its home, is in
[docs/uncovered-areas-review-2026-08-26.md](docs/uncovered-areas-review-2026-08-26.md)
"Not fixed, and why". In short: §5 item 24 is REJECTED on a measured line delta (about +5, not
−20); §5 items 9, 11, 12, 13, 19-remainder and 23 keep their 2026-08-25 verdicts; two behaviours
are recorded rather than changed (`key-checker`'s initial-probe 401/403, and an anthropic-kind
provider now only ever reporting `unverified`); the pre-existing mis-indentation in
`src/key-checker.ts` stands so a reformat cannot obscure a real diff; and the **13 cross-cutting
plus 19 type-level lane findings that were not acted on remain ADVISORY and unverified** — the
same treatment §5 itself asks for, not a work queue.


After the metering sprint, from [docs/metering-reconciliation-2026-08-22.md](docs/metering-reconciliation-2026-08-22.md) §7:

- **Resolved 2026-08-23 (v0.41.0)** — dashboard/`cost` coverage-partial semantics (`50e8233`):
  partial now means lost/omitted data, never a merely-unmeasured token kind.
- **Resolved 2026-08-23 (v0.41.0)** — OpenAI Responses front's dropped `function_call`
  (`3253a53`, `src/responses-request.ts`).
- **Resolved —** the ollama-cloud 403 "Pro plan" refusal was learned by a seed interpretation as
  `subscription-required` (`ollama-cloud#default/kimi-k3`, excluded from free pools); nothing to accept.
- **Resolved 2026-08-23 (v0.42.0, `d75b143`)** — gemini's OpenAI-compatible endpoint refusing tool
  messages with no `name`.
- **DELIVERED (v0.42.0, `a407ee0`)** — the reviewed-rule rung of `resolveResetsAt` is fed: facts
  persist `untilBasis`, and both the dashboard availability producer and `llm-relay candidates`
  resolve through the new `factResetInputs` gate.
- **ACCEPTED AS-IS (owner decision 2026-08-23)** — streaming cross-protocol usage parity in
  llm-bridge: the ledger observes the BACKEND stream, so accounting is correct; only the
  client-facing translated SSE loses cache fields. (The G2 hard cap is delivered: `5e06a56`,
  `limits.hard`.)
- **Resolved 2026-08-23 (v0.43.0, `405602f` + review fix-up `0de0584`)** — gemini 3.6
  requiring a `thought_signature` on tool-calling turns. `compat.thoughtSignature: "sentinel"`
  stamps Google's own documented opt-out token at
  `tool_calls[N].extra_content.google.thought_signature`, defaulted for the base host
  `generativelanguage.googleapis.com`. Live-verified against the real endpoint: single and parallel
  placements all 200, contradicting the public report that a parallel pair rejects the sentinel.
  No real signature is stored or echoed. Residual (stated in `CLAUDE.md`): the default is
  host-scoped while verification covered `models/gemini-3.6-flash` only; the override is
  `compat: { "thoughtSignature": "none" }`.
- **Resolved 2026-08-23 (v0.43.0, `a509cab` + review fix-up `0de0584`)** — mistral
  (medium-2505) enforcing a 9-char alphanumeric `tool_call_id`. `compat.toolCallIds: "strict9"`
  rewrites both halves of every pair to `^[a-zA-Z0-9]{9}$` — deterministic SHA-256→base62, no
  randomness, so a replayed turn and a failover retry map identically — defaulted for a
  `*.mistral.ai` base host and announced as `x-llm-relay-tool-call-ids` plus the
  `toolCallIdRewrites` log counter. This also subsumes the `tool-use-ids.ts` interaction: a minted
  `Read:0_relay1` id is rewritten like any other shape.
- **Resolved:** Gap 7 by spec amendment 2026-08-22 (no new endpoints).
- **DELIVERED (v0.44.0, `32f31c3`) — Gap 10 / M4.** The attempt-scoped usage observer now records
  model-authored text, thinking/reasoning and whole tool-argument JSON through one chars/4
  `relay_estimate` cell, separate from reported usage; base64 is skipped, any taint nulls the whole
  estimate, serve estimates require final-wire commit and repair attempts are metered
  unconditionally. Consequence: `usedInWindow` now completes estimated-basis tokens to
  input+output, so an operator tpm/tpd `limits.hard` cap refuses sooner and the
  `derived:configured` demotion rung moves; the old input-only scalar fired both late.
- **DELIVERED (v0.44.0, `1ee1ad2`) — M3.** `POST /cooldowns/clear` and
  `llm-relay cooldowns clear <provider>[/<model>] [--credential <label>]` shipped with the §6.2
  security precondition through the same `admissionFailure()` path as `/offload` and `/dispatch`.
  The body rejects every unknown key and the CLI enforces exact arity plus a flag allow-list before
  sending; the clear removes breaker/Retry-After/escalation cooldowns, credential faults,
  quota-sourced cooldowns and cooling condition facts, while retaining measurement/eviction facts,
  failure/stability history and the accounting store. No running relay means exit 1, never a file
  fallback.
- **DROPPED (owner decision 2026-08-23), not deferred — Gaps 15/16, P4.** Removed from the program
  of record entirely, not a future ask: Gap 15 (single-file HTML dashboard) was superseded by the
  shipped SPA, Gap 16 (in-flight quota leases) had spec §5.4 arguing against it with no measured
  overshoot, P4 (server-enforced system prompts / `client_profiles` part 2) never acquired a
  purpose.

Review findings deliberately NOT fixed on 2026-08-22 (report named beside each):

- ~~Destructive-name filter at the dialect-rescue commit point - the one known safety-shaped code
  gap (`docs/status-vs-freellmapi-2026-08-16.md` §3.1 / §6 rec 2).~~ **DELIVERED 2026-08-24.**
  `recoverToolCalls` takes the matcher as a REQUIRED parameter and returns `refused-destructive`;
  the refusal binds at all **four** rescue commit points (buffered/streamed x Anthropic-translated/
  direct-Chat), refuses the envelope WHOLE, and is TERMINAL — `origin: "local"`, so the walk does
  not reroll and the deployment's failure budget is untouched. Announced as
  `x-llm-relay-tool-dialect: refused-destructive` plus a `tool_dialect_refused_destructive` body on
  the buffered lanes, and as the mid-stream SSE `error` event once the head is flushed.
  The *streamed pre-commit* case (nothing meaningful emitted before the envelope) is served as a
  502 rather than a mid-stream event, and **closed 2026-08-25** so it announces identically: the
  probe's dead verdict carries an optional `errorType`, `failClosed` takes it (defaulting to
  `api_error`, so every other caller is unchanged), and both fronts add the dialect header. Both
  also now write `x-llm-relay-error-origin` from `probe.provenance` on any dead pre-commit stream,
  which that header always should have said. Design, policy, and the consequences to expect:
  [docs/dialect-rescue-destructive-refusal-2026-08-24.md](docs/dialect-rescue-destructive-refusal-2026-08-24.md);
  suite: `test/dialect-destructive-refusal.test.ts`.
- Orphan `tmp-*` journal files are never swept (C1 RISK-1 residue; retention itself landed).
  **Re-verified 2026-08-25, KEPT.** Narrower than the title: `atomicReplace` unlinks its own temp
  on any in-process throw (pinned by `test/accounting-store-io.test.ts`), so the only residue is a
  process KILLED between `writeFileSync(temp,…,{flag:"wx"})` and `renameSync` — at most one orphan
  per hard kill, bounded by the file caps, and unreadable by anything (every read is by exact
  name, and the nonce plus `wx` makes collision a non-event). A sweeper would have to add a
  readdir+age gate to a durability primitive whose threat model explicitly excludes concurrent
  writers, and prove an orphan is not another process's in-flight temp. If it is ever built: gate
  on prefix + inside-root + age > 24h, and leave `.corrupt-*` alone — that is deliberate evidence.
- ~~`methodSnapshot` accepts bounded arbitrary JSON as an estimation "method" (C1 NIT-6).~~
  **Re-verified 2026-08-25: the JSON acceptance is deliberate and pinned** (it snapshots a
  structured descriptor away from later caller mutation — `test/accounting.test.ts` asserts
  exactly that), so it stays. But the re-verification surfaced a real latent one beside it and
  **that is FIXED**: the accept side used `isDashboardSafeId`, which permits C0/C1 control
  characters, while the day-shard LOADER's `isSafeId` rejects them — so an admitted method would
  be written and then fail `parseAccountingDayShardV1` on the next read, quarantining the shard
  and losing that day's ledger. Both accept sites now admit through the loader's own predicate
  (`isLoadableId`), pinned by "refuses a method the day-shard LOADER would reject".
- ~~The type escape at `materializeDimensions`' aggregate return (C2 N5)~~ — **FIXED 2026-08-25.**
  Generic over the kind with a `DimensionRowByKind` map, so pairing a source with the wrong kind is
  a compile error instead of a silent `undefined` behind a non-null assertion; five casts removed,
  no runtime change. (Mutation-checked: a swapped call site now fails tsc.)
- ~~Regex-sniffing `bodyReadErrorCode` (C2 N9)~~ — **FIXED 2026-08-25.** Its structured rung tested
  three codes nothing in the repo ever set, so the only live classifier was a regex over the error
  MESSAGE — the relay deciding 413-vs-500 by sniffing prose it had written itself, wrong in both
  directions (any rejection containing "exceeded" read as oversized; a reworded reader would
  silently become `internal`). The producer now tags the rejection with the shared
  `BODY_TOO_LARGE_CODE` and the regex is gone.
- Dashboard session token rides `sessionStorage`; the mitigation is the strict CSP. Trade
  recorded, not changed (C2 R2). Also standing: misleading error codes for body problems (C2 N8),
  re-verified 2026-08-25 and kept. Its neighbour `llm-relay dashboard <anything>` ignoring extra
  positionals (C2 N10) was FIXED the same day, across the whole command family. Both reasons are
  worth knowing:
  - **N8** would be a versioned WIRE change (`malformed_body` added to a frozen enum) for a code
    no consumer reads — the SPA never looks at it and the route tests assert status only. ✅ The
    real hazard in that area was not the code but the duplicate union in `src/dashboard-routes.ts`
    restating the contract's ten codes by hand, and **that is FIXED (2026-08-25)**: the module now
    imports `DashboardErrorCode` from the contract, so removing a code there is a compile error in
    the routes file (mutation-checked) instead of a silent divergence. Pinned by "the error-code
    vocabulary has ONE definition — routes must not restate it", the same mechanical guard as
    `test/destructive-coverage.test.ts`'s "cli.ts no longer hand-copies the list".
  - ~~**N10**~~ — **FIXED 2026-08-25, across the whole family** (owner's call: "checking
    everywhere"). It was kept one release because tightening `dashboard` alone would have made it
    the odd one out; the answer was to stop it being odd. `COMMAND_ARITY` + the pure
    `commandArityError` bound every command, so `cost --window 1h 7d` no longer reports 24h and
    `models nim` no longer lists every provider. Bounds come from what the DISPATCHER reads, never
    from HELP — which omits `lanes` and the `route` alias entirely and documents a `setup` target
    that matches no branch, so a help-derived table would have left two commands unguarded.
    `pools`/`routing`/`route` are VARIADIC and stay unbounded (multi-candidate specs are a routing
    feature; any finite max is a guaranteed false positive). `keys`/`cooldowns`/`help`/`version`
    are exempt and say why in `ARITY_EXEMPT`. ⚠ The guard runs after help/version — so
    `llm-relay <cmd> --help` still works — and before the first side effect, which matters because
    the very next branch's `loadOrExit()` CREATES `~/.llm-relay/config.json`. ⚠ It does not echo
    the stray token, unlike the unknown-command guard: an unknown COMMAND is not a secret-bearing
    position and naming it IS the diagnostic, while a stray positional can be anything pasted —
    and `check-keys` is the same command as `keys check`, whose parser never echoes argv. Verified
    against the built binary with a 16-case before/after baseline: all identical. ✅ The adjacent behaviour it sat next to — an UNRECOGNIZED command falling
    through to `runProxy()`, so a mistyped command started a relay instead of reporting the typo —
    is **FIXED (2026-08-25)** as the shared guard this line asked for: `dispatchDashboardOrProxy`
    refuses a positional that is not in `CLI_COMMAND_NAMES` (exit 1, naming the token, bounded),
    while a KNOWN name still falls through exactly as before and a bare `llm-relay` still starts
    the proxy. ⚠ Second-order benefit: a value-taking flag missing from `VALUE_FLAGS` pushes its
    VALUE into command position — the hazard that constant's comment warns about after `--host
    routed` was parsed as a lane id — and that now fails loudly rather than quietly starting a
    proxy or selecting the wrong lane.
- **Found while exercising the CLI on 2026-08-25, fixed:** the control token was not gitignored.
  It normally lives in `~/.llm-relay/`, but its directory is resolved from the CONFIG's own path,
  so `llm-relay --config ./config.json` run inside this checkout mints a 256-bit capability into
  the repo root — beside the `config.json` that .gitignore already covers for the same reason.
  `git add -A` would have staged it. `control-token` is now ignored.
- SPA/test nits standing (C3): flat 30 s poll with no failure backoff (mitigated by
  abort-on-hide/offline), CSS-structure test mirroring styles.css, a few wall-clock-sleep tests,
  dashboard fixtures cast via `as unknown as`, `aria-description` support patchier than
  described-by, theme preference not persisted, SIGKILL leaking the test interpretations file.
- Unverified residual (reconciliation §5): rotation-triggered fact clearing is verified only in
  adjacent machinery, not the rotation path itself. (The >=2-candidate accounting walk IS pinned on
  both fronts: `test/accounting-lifecycle.test.ts` "records failed and committed winning serve
  attempts" walks a 429 candidate then a winner for each front.)

**DELIVERED 2026-08-24 (v0.45.0) — the custody program** (§0). P1's platform-coverage
question resolved in-build. Custody review findings deliberately NOT fixed, standing (each judged
in the packet reviews, recorded here so nobody re-litigates them as discoveries):

- `keys rotate` mints `~/.llm-relay/control-token` when no relay runs and the clear ends
  `unreachable` — same side effect as `cooldowns clear` today; noted, not a defect.
- The keystore read surface walks the full legacy candidate family (derived names included, env
  parity) while the `keys add`/`import` write gate stays strict (declared + curated only, §2.6) —
  a deliberate, documented asymmetry (`docs/reference.md` custody section).
- macOS `security` and Linux `secret-tool` lanes have injected-double coverage only — no CI leg
  and no machine here can run them (plan D2). Any "CI-verified" claim about them would be false.
- The server-side integration tests share the worker-default keystore path (no injection seam
  through `createProxy`); the hand-written guard in `test/reshaper-credential-binding.test.ts`
  stands.
- `keystoreStatus` retains the KEK after a successful status read (deliberate, serves the
  spawn-once discipline; documented in the `keystore.ts` CLAUDE.md row).
- ~~The owner's 12 live keys remain in env vars until the operator migrates by hand.~~
  **Superseded the same evening** — the migration was executed (§0): all 12 keys live in the
  keystore, the 12 User-scope env vars are gone, and the relay runs keyless off the keystore.
