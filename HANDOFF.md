# HANDOFF

Entry point for any agent picking up llm-relay, on any provider. Read this before `CLAUDE.md`.

## 0. State as of 2026-08-30 (eleventh lap)

**Current: v0.67.0 is released** — npm `dist-tags.latest` 0.67.0 confirmed against the REGISTRY, the
global bin reinstalled to match, and the daemon restarted onto it (PID checked, `GET /telemetry`
200, one real `pool/low` request served 200 by `gemini/models/gemini-3.6-flash`). A MINOR rather
than a patch: it changes routing behaviour and adds a `dashboard.cost.v1` field.

**The eleventh lap changed no `src/` file.** It verified the one capability the tenth lap had left
unverified — see the hedge-loser entry below — and it filed one finding met while doing so:
`llm-relay cost` ends every rolling window at a bucket boundary, so it silently drops the newest
partial bucket (up to 6 h on `--window 30d`). That entry is the backlog's only open item; it is
measured, it awaits an owner decision, and no release was cut because nothing shipped.

**The tenth lap closed both backlog entries that stood before it.**

- **The breaker learns from a client-cancelled hang** (`ae5c38c`). A deployment that out-waits the
  caller is now distinguishable from a caller who changed their mind. ⚠ The backlog's constraint —
  separate the two cases, do not delete the early return — was load-bearing: that one line carried
  THREE events, so deleting it would have charged every ordinary client disconnect (the provenance
  table already answers `true` for `client-cancellation`), charged every hedge loser, and started
  merging cancelled attempts' quota headers into routing state. `AttemptCancelled` now carries a
  REQUIRED closed `cause` routed by a second total table, DERIVED from `HealthAttempt.committed`
  and never from the `reason` prose.
- **D3 — a losing hedge's spend is counted and shown** (`0148553`, `779f5e6`). Recorded as its own
  cells and rendered by `llm-relay cost` as its own table. ⚠ One part of D3's literal wording did
  not hold: `requestSpend` does NOT become "what this request actually cost". Three measurements
  forbid it, and the reasoning is in [docs/backlog.md](docs/backlog.md).

⚠ **Two accepted consequences of the cancellation change, stated so they are not later read as
bugs.** An admitted cancellation CREATES a `CircuitState` row where none existed, so that
deployment appears in `availability-snapshot.ts`, `telemetry.ts`, `candidates.ts` and the breaker
export. And `MAX_FAILURES_BEFORE_TRIP` is 2, so ONE long cancellation records a failure and a ping
but sets no cooldown — deliberate, and this repo's standing rule against acting on a single
request's latency.

⚠ **Two commit messages from this lap overstate their test counts, and this is the corrected
record** (the independent closeout auditor caught it after the push; history is not rewritten).
`0148553` says "12 store/producer tests" — it is **7** (`test/abandoned-spend.test.ts` 5, plus 2 in
`test/accounting-store.test.ts`). `779f5e6` says "Four new tests" — it is **3** (1 in
`test/cost-cli.test.ts`, 2 in `test/dashboard/snapshot.test.ts`). `ae5c38c`'s "11 tests" is exact.
This is the second time an auditor has caught a miscount in a commit message here; count from the
diff, never from memory.

⚠ **Mutation checks are real but leave NO repo-verifiable trace.** This repo has no mutation-testing
tooling, so a claim like "five mutation checks, each killed by exactly one test" rests on the
author's say-so and an auditor can only mark it unverifiable. Each check this lap was run by
inverting the source and observing which tests failed; if that standing matters later, re-run the
inversion rather than trusting the sentence.

✅ **VERIFIED LIVE 2026-08-30 (eleventh lap):** a hedge LOSER's `relay-abandoned` classification
and its spend entry. This paragraph used to say it "cannot be on demand", because the live request
after the v0.67.0 restart was served by its first candidate. It CAN be forced, and the recipe is
worth keeping: run a SECOND relay against the operator's own providers with `routing.hedge:
{ enabled: true, floorMs: 1500, minSamples: 100000 }` — a high `minSamples` makes the per-token and
absolute rungs decline, so the threshold is exactly `floorMs` and a hedge starts on nearly every
request. One `pool/low` request then answered:

```
x-llm-relay-served-by: nim/moonshotai/kimi-k3
x-llm-relay-hedged: nim/moonshotai/kimi-k3 -> huggingface/moonshotai/Kimi-K3 (primary won after 1500ms, floor)
```

The PRIMARY won, so the hedge was the loser. Its ledger attempt reads `cancelled` / `aborted` with
`amountMicrousd: 57`, `tokenBasis: estimated`, `coverage: input_only` — exactly D3's stated shape —
the day shard carries `abandonedSpend.referenceEstimated: 57`, and `llm-relay cost` printed the
abandoned table beneath the totals. ⚠ The shard fold is the proof that the `relay-abandoned` CAUSE
threaded through, not just that an attempt was aborted: `accounting.ts` filters that list on
`attempt.abandonedByRelay`, which only `completeAttemptAbandoned` ever sets.

⚠ **Do NOT run that experiment against the live daemon's state.** The second relay needs
`XDG_CONFIG_HOME` and `XDG_CACHE_HOME` pointed at a scratch tree, AND every cache-kind artifact
pre-created there — `relayStatePath` falls back to the legacy path whenever the XDG one is ABSENT,
so a missing file puts a second writer on `~/.llm-relay/usage/`. Leave `.env` and `keystore.json`
absent on purpose: they fall back to the live copies, which the proxy only ever reads.

Earlier the same day, v0.63.1 → v0.66.0 (eight releases); the lap entries below say what each
carried.

✅✅ **HEDGING IS PROVEN ON THE LIVE DAEMON.** One real `pool/low` request after the restart:

```
x-llm-relay-served-by:  openrouter/nvidia/nemotron-3-ultra-550b-a55b:free
x-llm-relay-pool-attempts: 4 tried, 1 served: 1x502, 2x402, 1x200
x-llm-relay-hedged: kilo/nvidia/nemotron-3-ultra-550b-a55b:free -> openrouter/nvidia/nemotron-3-ultra-550b-a55b:free (hedge won after 20000ms, floor)
```

The primary ran past the 20000 ms floor, the next candidate was started BESIDE it, and the hedge
answered 200. That is the check the unit tests structurally cannot make — they inject the ping loop
and the tier types, so they agree with the code about the data the feature reads, which is exactly
how `routing.latency` shipped inert in v0.65.1. ⚠ The `floor` basis is expected and correct: these
deployments carry no probe samples, and an UNMEASURED deployment is hedged by design.
⚠ The daemon was verified by its command line plus the installed `package.json`, not by
`/telemetry` — see the version-field warning below.
⚠ **`GET /telemetry` still carries no version field**, so a claim about the live process always
needs a restart or another check; that has caught this file out before. ⚠ A packument read right
after a publish can serve a STALE `dist-tags.latest` — the version document
(`registry.npmjs.org/llm-relay/<version>`, HTTP 200) plus the publish job's own conclusion are the
tie-breakers, and they disagreed once during this lap.
§6 holds recorded trades, deferrals and settled decisions, not a work queue. The work queue is
[docs/backlog.md](docs/backlog.md), and it is **EMPTY** — every entry that stood there closed this
lap or the one before. Earlier settlements kept for their reasons: package-size variant C is
adopted, and the MCP server (D4) is BUILT AND SHIPPED to `main`.

✅ **`llm-relay mcp` is live** (`e8ac127`, `67d12a0`, `e059bbe`). One MCP tool call hands a whole
task to another agent lane and returns its ANSWER, so no caller composes a lane command. Registered
on Claude Code (✔ Connected) and AGY, where **delegation is verified live** — agy dispatched a task
and reported the answer plus the lane. That closes the goal D4 existed for. ⚠ Codex is registered
and `codex mcp list` shows it enabled, but `codex exec` surfaces NO MCP tools at all, including two
servers older than this one; use the CLI form from Codex. Design survey:
[docs/mcp-dispatch-prior-art-2026-08-30.md](docs/mcp-dispatch-prior-art-2026-08-30.md).

✅ **RELEASED as v0.63.0**, on the owner's instruction reversing their own same-day "stays
unpublished" decision. It carries BOTH held changes: package-size variant C (`packBytes`
1113288 → 879010 including the MCP server's 17494 B, so still 21% below what the registry served)
and the `llm-relay mcp` dispatch server. Verified against the registry directly, and the global bin
was reinstalled FROM THE REGISTRY — the bundled skill in the published package is byte-identical to
the two installed host copies, line endings aside. **A stranger installing from npm now gets the
MCP server.**

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

**This lap (2026-08-30, seventh) — the self-announcing-offload lap.**

✅ **Offload now announces itself.** The owner reported having to say *"use llm-relay for offload"*
out loud, and asked that the tool make itself known without being named. Three measured causes, all
fixed in the repo so every host and every stranger gets it: the MCP `initialize` instructions stated
only WHAT the tool is (they are the one channel a host loads unconditionally); the `dispatch` tool
is DEFERRED on a real host, so its description never loads until a tool search; and the skill
description triggered on the DECISION to offload rather than on the situation. Three tests in
`test/mcp-server.test.ts` pin the claims, mutation-checked both ways. Details in
[docs/backlog.md](docs/backlog.md). ⚠ Commit `61b4ec6`'s message says "four tests"; it is **three**
(`serves the instructions constant`, `states WHEN to delegate`, `carries the unprompted trigger`).
The independent closeout auditor caught the miscount after the push, so this line is the corrected
record — the same treatment `CLAUDE.md` already gives `3d2fcee`.
⚠ The durable lesson is in `CLAUDE.md`: **prose the model must go and find is not a trigger.** The
global instructions already said "PREFER THE MCP TOOL" in bold and it changed nothing.

✅ **The offload "stall" is root-caused, and it is not a stall.** A `pool/medium` lane completed
with **exit 0 after 333 s** and returned a complete answer. The cost is the relay's own candidate
walk: individual requests took 120–123 s across 2–6 attempts, because latency is deliberately not
part of health banding, so a breaker-CLOSED member with a **p95 of 70364 ms**
(`nim/deepseek-ai/deepseek-v4-flash`) is walked ahead of a cooling one. Two previously recorded
threads are disproved — the accounting store DOES receive the rows (`recent.json` `rows` is simply
not sorted by time), and the `unrecognized_model` line remains the no-information warning
`CLAUDE.md` already describes. Full evidence table in [docs/backlog.md](docs/backlog.md).

✅ **And the owner chose the fix, which shipped the same day: sustained latency now DEMOTES.**
`src/latency-demotion.ts`, folded into `targetUsability` beside the quota term — `routing.latency`
(default ON, p95 ceiling 30000 ms over at least 5 measurable samples), announced by
`x-llm-relay-latency-demoted`. It only reorders: never drops, never refuses, and unmeasured latency
has no effect at all. No breaker cooldown is registered, because latency states no reset and this
relay never invents a duration — so the demotion lifts by itself when the measurement recovers.
17 tests, 6 of them driving a real two-candidate walk on BOTH fronts.

⚠ **This reverses a rationale recorded in place at `src/server.ts`, and that is an owner decision,
not drift.** The comment there argued against re-ranking on stability. It is amended rather than
deleted, and it still bounds the design: what was rejected is a second ranking PASS that re-sorts
and can PROMOTE on one request's latency, and that stays rejected. Do not "restore" the old
behaviour as a regression fix.

✅ **And the dataset question that opened right after it is closed too** (owner decision, same day):
`routing.latency` reads the **PROBE dataset** — it persists across restarts and is what
`llm-relay candidates` shows — and that dataset now carries **request latency** as well, so the
primary signal is **milliseconds per output token**. Absolute latency cannot compare a
`max_tokens: 1` probe with a 500-token generation; per-token can, and it is FINAL when it has
evidence rather than falling through to the absolute ceiling. The 250 ms/token default is measured
from 68 real requests (healthy deployments 36–70, the bad one 688), not invented.

⚠ The first version of this read the BREAKER's pings — request-path only, in memory only — so it
went inert after every restart and disagreed with `candidates`. **A live check found that one
request after restarting the daemon; the tests and an independent auditor did not, because every
test seeded the breaker directly and so agreed with the code about which dataset it meant.**

**This lap (2026-08-30, eighth) — the latency-and-cooldown lap.** Opened to answer one question:
did v0.65.0's `routing.latency` actually make offload faster? It had not. Full evidence, including
a claim made and then disproved:
[docs/latency-demotion-regression-2026-08-30.md](docs/latency-demotion-regression-2026-08-30.md).

✅ **v0.65.2 — the absolute latency ceiling reads PROBE samples only.** `recordRequestSample` was
appending generation latency into the same array the ABSOLUTE p95 reads, while `p95Ms` (30000) is
calibrated on a `max_tokens: 1` probe. Per-token exists to stop a long-but-fast answer being
demoted, but it engages only at `minSamples` REQUEST samples — so every deployment passes through a
1-to-4-sample window judged by the wrong ceiling. Live: `nim/nvidia/nemotron-3-ultra-550b-a55b`,
which had served **59 of this machine's 62** successful requests, answered one request with 632
tokens in 34863 ms — **55.2 ms/token** against a 250 ceiling, healthy — and that success alone
demoted it. **A deployment demoted itself by succeeding, and the term demotes the busiest server
first, because the busiest server writes the longest answers.** Verified against the live cache: the
fix flips exactly one verdict across 262 deployments, and it is the wrong one.

✅ **v0.65.3 — a cooldown must outlast the failure that caused it.** Asked to investigate before
choosing a fix, the answer turned out larger and simpler than the latency term. **All 43** timeout
attempts in `usage/recent.json` were on ONE deployment,
`nim/deepseek-ai/deepseek-v4-flash-0731`, each burning the full 120000 ms provider timeout, and its
breaker read `closed` every time. ⚠ **Nothing was broken in the charging path** — `deadline`
provenance reaches health, a 504 passes the 4xx filter, the trip fired as written. The CONSTANT was
smaller than the failure it punished: a 120 s waste bought a 60 s cooldown against requests
78-139 s apart. `DEFAULT_COOLDOWN_MS` is now a FLOOR; a slow failure cools for the time it wasted
(`source: "elapsed"`, clamped to `MAX_RETRY_AFTER_MS`). Fast failures are unaffected by
construction. This is the best explanation yet of the offload lane that took ~17 minutes: every
agent turn paid 120 s to one deployment. Verified live — three consecutive walks ran 121 s, then
**10 s**, then **1 s**, and the breaker shows that member cooling at `source=elapsed`.

Two things worth carrying forward from it:

- ⚠ **I claimed the latency term had "stopped offload" and it had not.** Disabling
  `routing.latency` did not restore service, which disproved it; the outage was provider-side on
  `nim`. The disproof is kept in the doc rather than deleted.
- ⚠ **A fourth instance of the hand-copied closed list.** `isCooldownSource` re-stated all five
  `CooldownSource` members literally, so adding `elapsed` type-checked clean while every persisted
  row carrying it would have been dropped at load. `CooldownSource` is now DERIVED from
  `COOLDOWN_SOURCES`.

**This lap (2026-08-30, ninth) — the hedge-wiring lap. HEDGING IS WIRED ON BOTH FRONTS.**
The owner's proposal — *"if an attempt is taking longer than p90 for that endpoint (normalized by
number of tokens), we pass the task off to the next source, but still allow for the possibility of
the first source returning a useful result"* — is delivered
([docs/hedged-attempts-design-2026-08-30.md](docs/hedged-attempts-design-2026-08-30.md)).

✅ Shipped this lap:
- **`routing.hedge`** — parsed with `routing.latency`'s strictness (unknown key is a hard load
  error). **ON by default, free deployments only** (owner decision D1). `false` is a byte-for-byte
  revert, including the walk's in-flight cap.
- **`server.ts` `runAttemptWithHedge`** — ONE policy shared by `handle` and `openAiFrontPath`.
  `isWin` is the loop's own failover expression, extracted so there is one definition.
- **`x-llm-relay-hedged`** on every hedge, won or lost, naming both deployments, the delay and the
  rung of evidence that set it — which is how the three placeholder constants become calibratable
  from real traffic.
- **`test/hedge-wiring.test.ts`** — 14 tests, both fronts, real two-backend races. Every positive
  case asserts the SECOND backend was actually contacted, never just a header.

⚠⚠ **The invariant was AMENDED, not assumed.** `CLAUDE.md` said acting on counts *"may only
reorder"*; hedging DUPLICATES. The owner amended it on 2026-08-30, and the amendment is written into
`CLAUDE.md` and `docs/project-goals.md` as an amendment rather than a repeal — nothing else here may
duplicate, and a later term that wants to must be argued on its own merits.

⚠⚠ **Two structural findings, both from ATTEMPTING the wiring rather than reading it, and both
would have shipped broken requests.** They are in `CLAUDE.md` because they are the durable half:
- `CredentialAttemptTrace.record` matched the LAST open entry and only then checked identity, so a
  PRIMARY that won against an egressed hedge threw on a perfectly good 200.
- `CredentialWalk.next()` had to start re-offering a pending-but-UNSTARTED attempt. Both fronts'
  failover look-ahead depended on the single-slot saturation branch BY ACCIDENT, so raising the cap
  to 2 made the walk hand out a THIRD candidate while the second stayed pending forever.
  **Measured: 40 multi-candidate failover tests, and they HUNG rather than failed.** A hedging change
  nobody expected to touch failover must still run the whole suite.

⚠ **D3 is the one part of the approved scope NOT delivered, and it is a QUESTION, not an
omission.** The owner decided that a losing hedge's spend should enter `requestSpend`; attempting it
found that `AccountingSpend` is one record with one `pricesUsed`, so it cannot honestly hold two
deployments — the faithful route is the store's four-cell aggregate, i.e. a versioned change to the
event vocabulary, the shard schema and the dashboard projection. And a decision taken AFTER D3
(the race resolves at RESPONSE RESOLUTION) makes an aborted loser carry no tokens at all, so D3 is
usually worth zero. Handed back with the measurement it did not have; tracked in
[docs/backlog.md](docs/backlog.md).

⚠ **Nothing is released.** The two formerly inert modules are now both wired, so the `kernel/`
precedent no longer applies. ⚠ The package ceiling moved ONCE this lap, decomposed to the byte with
no residue and no new entries — the decomposition is in [docs/backlog.md](docs/backlog.md).
✅ **The live-signal check WAS run, because the unit tests share v0.65.1's blind spot.** Those tests
inject a stub `pingLoop` and hand-built tier types, so they agree with the code about the very data
the feature reads — which is exactly how `routing.latency` shipped inert. Measured against the
OPERATOR'S OWN config and `models-cache.json`:

| deployment | `assessCost` | hedgeable |
|---|---|---|
| `nim/moonshotai/kimi-k3` | free (provider-tier) | yes |
| `nim/nvidia/nemotron-3-ultra-550b-a55b` | free (provider-tier) | yes |
| `gemini/models/gemini-3.6-flash` | free (provider-tier) | yes |
| `mistral/mistral-medium-2505` | free (provider-tier) | yes |
| `openrouter/nvidia/nemotron-3-ultra-550b-a55b` | paid (published-price) | no |
| `anthropic/*` | paid (anthropic-kind short-circuit) | no |

So the feature fires on the deployments that actually serve this machine — including the `nim`
member whose 43 consecutive 120 s hangs it was built for — and is correctly excluded from the paid
and passthrough ones. ⚠ The `$15~` figures in `llm-relay candidates` are REFERENCE prices and never
reach `assessCost`, which reads the serving provider's own published figures; that is why an
apparently priced `nim` member is still classified free. The operator's real config also loads
through the new parser with `routing.hedge` resolving to `{}` — all defaults, i.e. ON.

✅ **And the live-daemon request WAS then made** (owner instruction, same lap): released as v0.66.0,
global bin reinstalled, daemon restarted, and ONE real `pool/low` request fired a hedge that WON —
`kilo/...:free -> openrouter/...:free (hedge won after 20000ms, floor)`. The full header block is at
the top of this section.

✅ **Already applied and NOT pending:** `providers.nim` was given `timeoutMs: 100000`. The figure is
measured, not chosen — over 40 successful `nim` attempts the working band runs 559 ms to 96959 ms,
so the 25000 ms I first proposed would have cut **22.5%** of real successes, and 100000 is the only
value the data supports. That finding is itself the argument for hedging: a timeout must choose
between abandoning a slow success and waiting out a hang, and here the two are indistinguishable by
duration.

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

✅ **RELEASED as v0.63.0 (2026-08-30).** The earlier "everything after v0.62.0 stays unpublished"
decision was the owner's, and the owner reversed it the same day. The registry now serves the
variant-C package WITH the MCP server: `dist-tags.latest` 0.63.0 at `packBytes` 879010, down from
1113288. Both held changes reached users in one release.

**The quota-source re-probe shipped** (v0.59.0 feature + two live-found fixes; design, owner
decisions and the full verification record:
[docs/quota-reprobe-design-2026-08-29.md](docs/quota-reprobe-design-2026-08-29.md)):

- **The property the backlog demanded now holds**: a recorded lane quota death either carries an
  expiry the relay enforces (`dispatch-exhaustion.json`, future-only restore), or the background
  quota probe retracts it. Roster staleness (7d) stops evictions on old evidence; `laneOfRung`
  sees through the `lane-launch.ps1` wrapper (agy had been unprobeable since 2026-08-27);
  `routing.laneProbe` (default ON) rides the ping tick — catalog per 24h, quota probes per 6h
  for DEAD buckets only.
- **Invariant amended by owner decision**: the request path never spawns a lane; the operator
  `--probe` and the background cadence are the only two spawn sites. Recorded in the CLAUDE.md
  ladder gotcha and the design doc §5.
- **Two defects were found ONLY by the live drill, both in the Windows spawn path**: v0.59.1 —
  async `execFile` leaves stdin an open pipe and `agy models` stalls to the timeout (the sync
  `stdio: ["ignore"]` was load-bearing); v0.59.2 — the `.cmd` shell fallback joined args
  unquoted, so the probe prompt reached codex as seven tokens. Both fail-safes held: every
  symptom was "never learns", never a wrong verdict.
- Live-verified end to end: cadence refreshed both rosters (agy 11 → 14 models — today's roster
  leads with gemini-3.7, which the stale roster lacked, so a fresh probe under the OLD code
  would have evicted the healthy `agy-gemini` rung); a real recorded death survived two
  restarts, was probed through a real `codex exec` completion, retracted, and the retraction
  flushed to disk.

Operational: this lap ran from the worktree branch `claude/start-lap-a218d7`. ⚠ **Standing, and it
recurs every lap:** after a worktree pushes to `origin/main`, the MAIN CHECKOUT's local `main` at
`C:\Code\llm-relay` is behind origin until someone runs `git pull` there — a worktree cannot
fast-forward a branch another worktree has checked out. The six codex dispatch rungs stay
`"enabled": false` (the 2026-08-27 move to the first-party plugin); machine-side prose no longer
carries its own quota-dead claims — the relay's dispatch state is authoritative (design §5).

⚠ **A worktree with an empty `node_modules` silently certifies the WRONG tree.** Found this lap:
this worktree held zero installed packages, so Node resolution walked up three levels and
satisfied every import from the parent checkout. `npm run build`, `tsc` and the entire vitest
suite all passed against a dependency tree that was not this worktree's; the only check that
noticed was `check:package`, and it reported the symptom (`../../../node_modules/react`) rather
than the cause. Run `npm ci` in a fresh worktree BEFORE recording any verify-green entry. A global
SessionStart hook (`~/.claude/hooks/worktree-deps-guard.mjs`, owner decision 2026-08-30: warn,
never auto-install) now says so at session start, for every repo on this machine.

## 0.1 Earlier releases

Deliberately NOT restated here. This file holds current state plus the immediate next; a
release-by-release narration is a changelog, and git already has it. `git log --oneline` and the
tags are the trail. What survived each sprint lives in its own home:

- **v0.58.0, the max-output-caps lap** — the display-only `max-output` measurement fact (parser
  beside the context parser, observer on both fronts, live-verified on groq), and the stale-digest
  lesson (recorded signature digests go stale across a normalizer migration — list before
  addressing): [docs/max-output-caps-design-2026-08-29.md](docs/max-output-caps-design-2026-08-29.md).
- **v0.57.0, the eligibility triage lap** — queue 199 → 4 with owner-approved family verdicts,
  the lane-split signature fix and its load-time store migration, the Tailwind scan leak:
  [docs/eligibility-triage-2026-08-29.md](docs/eligibility-triage-2026-08-29.md).
- **v0.56.0, digest-keyed `eligibility accept` + provider-stated spend headroom** — the
  eligibility gotchas and the `spend-headroom.ts` row in `CLAUDE.md`.
- **v0.53.0–v0.54.0, the three-axis assessment and its follow-ups** — the report, every verified
  and refuted claim, the retracted finding, and the closed "Remaining open items" ledger:
  [docs/three-axis-assessment-2026-08-28.md](docs/three-axis-assessment-2026-08-28.md).
- **v0.52.0, the advisory-findings verification** — the closed-vocabulary bug class (also a
  `CLAUDE.md` gotcha) and the full verdict ledger:
  [docs/advisory-findings-verification-2026-08-28.md](docs/advisory-findings-verification-2026-08-28.md).
- **v0.50.0–v0.51.0, the documentation pass and the XDG unification** —
  [docs/documentation-pass-2026-08-27.md](docs/documentation-pass-2026-08-27.md), and the
  `state-paths.ts` row in `CLAUDE.md`.
- **v0.49.0, the uncovered-areas sprint** —
  [docs/uncovered-areas-review-2026-08-26.md](docs/uncovered-areas-review-2026-08-26.md).
- **v0.47.x–v0.48.0, the complexity review and its §5 implementation** —
  [docs/complexity-review-2026-08-25.md](docs/complexity-review-2026-08-25.md).
- **v0.46.0, the dialect-rescue destructive filter** — the last safety-shaped code gap. Its rule
  is a `CLAUDE.md` gotcha, and its design is
  [docs/dialect-rescue-destructive-refusal-2026-08-24.md](docs/dialect-rescue-destructive-refusal-2026-08-24.md).
- **v0.45.0, the custody program** — plan, recon corrections and the seven build decisions:
  [docs/custody-sprint-plan-2026-08-24.md](docs/custody-sprint-plan-2026-08-24.md). Residuals: §6.
- **v0.40.0–v0.44.0, the metering program** — closeout ledger and every gap/stage/decision table:
  [docs/metering-reconciliation-2026-08-22.md](docs/metering-reconciliation-2026-08-22.md) §7.
- **Every standing trade and open question** those sprints produced: §6 below, which is the one
  place they are tracked.
- **Process lessons that generalize** (run the pre-fix control yourself; lane discipline; the
  evidence-only closeout auditor) live in agent memory (`llm-relay-revival`,
  `free-lane-playbook`).

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
| `docs/rejection-ledger-2026-08-16.md` | Every past rejection and its reason, grouped by reason-kind |
| `docs/reference.md` | Full user-facing reference, including provider credential fleets and protected diagnostic surfaces. |
| `docs/three-axis-assessment-2026-08-28.md` | The owner's three-axis capability assessment: verdicts per axis, the live-signal finding, the closed follow-up ledger. |
| `docs/advisory-findings-verification-2026-08-28.md` | The pass over the 32 advisory findings the 2026-08-26 review left unverified: the closed-vocabulary bug class and all eight instances, Class A vs Class B, the verdict ledger. |
| `docs/documentation-pass-2026-08-27.md` | The doc-vs-source pass: what was wrong and in what classes, what was deliberately left, and the friction. |
| `docs/dispatch-integration-review-2026-08-27.md` | Cross-CLI dispatch: how the ladder is actually executed, the agy console-window cause and fix, agy's permission vocabulary, ACP as the verified transport, ranked options, open tests. |

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
- Some tests are POSIX-only (`skipIf(process.platform === "win32")`) and skip on Windows; CI's
  ubuntu leg is the only place they run, so a green local Windows run is not full coverage of
  secret-file permissions. A store path nested
  under a regular file reads as `ENOENT` on Windows but `ENOTDIR` on Linux, so fixtures that
  require an absent load must inject the stat/read seam rather than relying on that filesystem shape.
- A failing test may be pinning a defect it should have caught. Read its stated reasoning before
  assuming your change is wrong, and fix test and source in the same commit.
- **A test that does real machine work has the machine's worst case in its 5 s budget.** A spawn
  measured at ~50 ms idle took 2.8–4 s under full-suite process contention and flaked for weeks.
  Fix at the root with an injected seam, never by raising one test's timeout — the flake just
  moves to the next test on the same path. The worked example is the `winenv.ts` row in
  `CLAUDE.md`.
- Static analysis (`npm run analysis:run`) is advisory and deliberately outside the gate.

## 4. Things that will bite you

- **Do not trust this repo's documentation without checking source.** Drift here has been
  recurrent. THREE mechanical axes are guarded now — `test/architecture-map.test.ts` (every
  non-index `src/` file has a `CLAUDE.md` table row), `test/scripts-inventory.test.ts` (every
  `scripts/*.mjs` is named in `scripts/CLAUDE.md`, and no name there is dead), and
  `test/doc-links.test.ts` (every relative link in the shipped doc set resolves, and no `.md`
  target wears a line-number fragment). ⚠ Everything a doc SAYS is still unguarded: what a module
  does, what a default is, which release shipped what. Verify before inheriting such claims.
- **A recorded "open gap" is a claim like any other — verify its MECHANISM before working it.**
  A §6 entry once cited a mechanism (backslash paths failing `check:package` on Windows) that had
  never existed on this tree; ten minutes of reproduction beat an afternoon of fixing a defect
  that did not exist.
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
- **Headless offload lanes must be told not to stop and ask.** A lane that ends its turn with a
  clarifying question reads as a completed task that did nothing. Instruct it to decide and
  proceed on its own judgement, and to report rather than await approval.
- **Keep `{task}` BEFORE any variadic flag in a `cli` rung template.** Some shells let a variadic
  option swallow what follows it, and the owner's template once lost the whole prompt to
  `--allowedTools`. Confirm a template with one real headless run before trusting a lane built
  from it.
- **Claude Code has THREE client-side idle timers that abort a long silent generation at ~300 s
  on a custom base URL** — event-level + byte-level streaming watchdogs, and the body idle
  timeout. The relay's commit probe (`src/stream-commit.ts`) holds bytes until meaningful
  content, so a long think looks idle to all three. Set
  `CLAUDE_STREAM_IDLE_TIMEOUT_MS=1800000`, `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=1800000` and
  `API_FORCE_IDLE_TIMEOUT=0` in any hand-written CLI rung's `env`; the owner's
  `routing.cliLane.env` already carries all three.
- **A spent pool member stays walkable by design** (health demotes, never drops), so a headless
  session can die on a member with a standing 402/403 when the preferred member is rate-limited.
  Addressing a healthy member directly (`--model <provider>/<model>`) avoids the fall-through;
  the durable fix direction is eligibility facts and the G2 cap, never dropping.
- **A multi-lane burst degrades the free pool it runs on.** Lanes sharing one quota domain die
  together (a weekly spend-limit 403 ends a headless `claude -p` lane outright). Relaunch each
  dead lane pinned to a DIFFERENT healthy member from `/candidates`, so lanes sit in separate
  quota domains.
- **`gh run watch` on a PASSING publish run shows an `X tier-data.json missing or empty`
  annotation.** It comes from the smoke step's DELIBERATE negative test (publish.yml deletes the
  file and requires exactly that error — "PASS-AS-EXPECTED"), and GitHub renders the `::error::`
  as a failure annotation anyway. Judge a run by `conclusion`, never by its annotations.
- **Refusal signatures converge across lanes since the 2026-08-29 fix, with one stated residual.**
  A provider message CUT by the wrapper's 300-char body cap converges only when both lanes'
  extractions share the same 240-char signature prefix; otherwise each lane keeps its own
  signature and each binds for the lane it was learned on. An accepted verdict therefore covers
  the lane whose traffic produced it — which is the walk lane for everything pool-routed. An
  EMPTY wrapped body teaches and queues nothing, by design. Diagnosis and resolution:
  [docs/eligibility-triage-2026-08-29.md](docs/eligibility-triage-2026-08-29.md).
- **The vitest interpretations/fact stores are per-PROCESS files, so entries leak between tests
  in one file.** `resetInterpretations()` drops the memo, not the file — a later test's
  `pendingRefusals()` sees every entry earlier tests flushed. Assert entry-specific facts
  ("this signature is still pending"), never queue lengths.

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

⚠ What follows is **recorded trades, deferrals and settled decisions kept for their reasons**, not
a work queue. The queue is [docs/backlog.md](docs/backlog.md). Nothing here currently awaits the
owner.

**From the 2026-08-29 triage
([docs/eligibility-triage-2026-08-29.md](docs/eligibility-triage-2026-08-29.md)):**

- **EXECUTED: the lane-split refusal-signature fix** (owner decision 2026-08-29: fix and
  re-migrate). Shipped in v0.57.0 with the load-time store migration; residuals recorded in §4
  and in the `refusal-interpretation.ts` row of `CLAUDE.md`.
- **EXECUTED: the max-output-caps design (accepted 2026-08-29, implemented the same day in
  v0.58.0).** Display-only learning of stated output ceilings, shipped exactly as scoped
  ([docs/max-output-caps-design-2026-08-29.md](docs/max-output-caps-design-2026-08-29.md));
  the carrier groq signature was rejected from the queue on landing.

**Owner decisions on record:**

- **WITHDRAWN: the currency-per-week spend ceiling.** The owner never asked for it; it was an
  agent-recorded candidate. Do not re-raise it as an open item.
- **EXECUTED: the OpenRouter weekly-limit interpretation is accepted**
  (`allowance-exhausted`, scope credential, `--cost-class paid`) — paid OpenRouter deployments
  demote while the condition cools and free ones stay walkable. Self-healing on both sides: any
  paid success, or the spend-headroom poll, clears it.
- **Type-level 7 stays as recorded** (a hard cap's `used` carries no basis provenance) — owner
  chose keep-as-is. A transparency gap, not a wrong refusal.
- **ACCEPTED AS-IS (owner decision 2026-08-23):** streaming cross-protocol usage parity in
  llm-bridge — the ledger observes the BACKEND stream, so accounting is correct; only the
  client-facing translated SSE loses cache fields.
- **DROPPED (owner decision 2026-08-23), not deferred — Gaps 15/16, P4.** Removed from the
  program of record entirely: Gap 15 (single-file HTML dashboard) was superseded by the shipped
  SPA, Gap 16 (in-flight quota leases) had spec §5.4 arguing against it with no measured
  overshoot, P4 (server-enforced system prompts) never acquired a purpose.

**Deferred hardening (2026-08-28 verification sprint)** — every reason in
[docs/advisory-findings-verification-2026-08-28.md](docs/advisory-findings-verification-2026-08-28.md)
"Still open, with its home". In short: four **Class B** findings (a type wider than its producers,
which no producer can reach) are hardening and deferred — type-level 2, 8, 14, 15; type-level 12
is deferred until someone can show acceptance-equivalence by differential fuzzing, because it
governs what LOADS and a quarantined shard is a lost day of ledger. Response-SIZE bounds on the
probe paths and the `withBudget` non-cancelling race are named as out of scope in `cd6e5f8`.

**Standing trades, each judged in its packet review — do not re-litigate them as discoveries:**

- Orphan `tmp-*` journal files are never swept. Crash-only residue (at most one per hard kill,
  bounded by the file caps), unreadable by anything, and a sweeper cannot distinguish an orphan
  from another process's in-flight temp. If ever built: gate on prefix + inside-root + age > 24h,
  and leave `.corrupt-*` alone — that is deliberate evidence.
- `methodSnapshot` accepts bounded arbitrary JSON as an estimation "method" — deliberate and
  pinned (it snapshots a structured descriptor away from later caller mutation).
- The dashboard session token rides `sessionStorage`; the mitigation is the strict CSP.
- Misleading error codes for body problems (N8): fixing it is a versioned WIRE change for a code
  no consumer reads. SPA/test nits standing: flat 30 s poll with no failure backoff (mitigated by
  abort-on-hide/offline), CSS-structure test mirroring styles.css, a few wall-clock-sleep tests,
  dashboard fixtures cast via `as unknown as`, `aria-description` support patchier than
  described-by, theme preference not persisted, SIGKILL leaking the test interpretations file.
- Unverified residual (metering reconciliation §5): rotation-triggered fact clearing is verified
  only in adjacent machinery, not the rotation path itself. (The ≥2-candidate accounting walk IS
  pinned on both fronts in `test/accounting-lifecycle.test.ts`.)
- Custody residuals (v0.45.0): `keys rotate` mints the control token when no relay runs — same
  side effect as `cooldowns clear`, noted, not a defect; the keystore read surface is deliberately
  wider than the strict `keys add`/`import` write gate (documented in `docs/reference.md`); macOS
  `security` and Linux `secret-tool` lanes have injected-double coverage only — no CI leg runs
  them, so any "CI-verified" claim about them would be false; the server-side integration tests
  share the worker-default keystore path; `keystoreStatus` retains the KEK after a successful
  read (deliberate, serves the spawn-once discipline).
- From the 2026-08-27 uncovered-areas sprint
  ([docs/uncovered-areas-review-2026-08-26.md](docs/uncovered-areas-review-2026-08-26.md)
  "Not fixed, and why"): §5 item 24 REJECTED on a measured line delta; items 9, 11, 12, 13,
  19-remainder and 23 keep their verdicts; two behaviours recorded rather than changed
  (`key-checker`'s initial-probe 401/403, and an anthropic-kind provider only ever reporting
  `unverified`); the pre-existing mis-indentation in `src/key-checker.ts` stands so a reformat
  cannot obscure a real diff.
