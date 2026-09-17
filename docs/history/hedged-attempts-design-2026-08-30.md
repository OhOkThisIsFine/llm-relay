# Hedged attempts — overlapping the walk instead of serialising it

> **Owner's proposal, 2026-08-30**, in their words: *"maybe if an attempt is taking longer than p90
> for that endpoint (normalized by number of tokens), we pass the task off to the next source, but
> still allow for the possibility of the first source returning a useful result."*
>
> This is the right shape of answer, and it is a different shape from everything else considered in
> this lap. Not built. This document is the design, its costs, and the decisions it needs.

## 1. Why it is the right shape

Every other option on the table — a longer cooldown (B4, shipped), a per-candidate time cap (B5),
charging the breaker on client cancellation (B6) — leaves the walk **serial**. A serial walk pays
the full cost of every slow candidate it meets, once per request, and the best it can do is meet
that candidate less often.

Measured this lap: a walk ran four candidates in 341, 322, 385 and 489 ms, then met one that took
**120007 ms**. The fast part of the walk cost 1.5 seconds. The slow part cost 120. B4 stops that
recurring; it does not make the request that hits it any faster.

Hedging attacks the cost itself. If a second candidate starts while the first is still thinking,
the request finishes when the *fastest* one answers, not when the *first* one gives up. The
canonical treatment is Dean & Barroso, *The Tail at Scale* (2013) — hedged and tied requests, where
a small duplicate rate buys a large tail-latency reduction.

It also preserves what the pure timeout answers throw away: **a slow member is still allowed to
win.** A cap or a shorter timeout discards a candidate that was about to answer. A hedge does not.

## 2. The trigger

The owner's rule is "longer than p90 for that endpoint, normalised by number of tokens". That
normalisation matters for exactly the reason this lap already established for
`latency-demotion.ts`: absolute latency cannot compare a short answer with a long one.

**Streaming — the good case.** Tokens arriving are counted as they arrive, so the relay can compute
what the answer *should* have cost so far:

```
expected_ms  =  p90_ms_per_token(deployment)  ×  tokens_seen_so_far
hedge when   elapsed_ms  >  max(FLOOR_MS, expected_ms × MARGIN)
```

This is the owner's idea implemented literally, and it is self-correcting: a deployment producing a
long answer earns more time as it produces it. A deployment producing *nothing* accrues no
allowance, which is exactly the case that needs hedging soonest.

**Buffered — the weaker case.** No token count exists until the answer lands, so the only honest
signal is the deployment's own p90 absolute latency, with a floor.

⚠ **Both readings must respect the dataset separation this lap just established.** Per-token reads
REQUEST samples only; absolute reads PROBE samples only. Mixing them is the defect fixed in
v0.65.2, and a hedge trigger built on a mixed statistic would fire on the busiest, healthiest
deployment first — for the same reason.

⚠ **Unmeasured must not hedge.** Below `minSamples` there is no p90, and `Infinity` means
"unmeasured", never "infinitely slow". This is the same rule the demotion term already carries, and
breaking it here would hedge *every* request against a cold cache.

## 3. What the relay already has

Three pieces exist, which is much of why this is feasible:

- **`stream-commit.ts`** already buffers raw bytes until the client-facing protocol carries
  meaningful content, then replays the prefix byte-exact. That is precisely the "has this candidate
  produced something real yet?" predicate a race needs. **No new notion of commit is required** —
  the winner is the first candidate to commit, and the loser is aborted before either has written a
  head.
- **The walk already resolves an ordered candidate list**, so "the next source" is just the next
  attempt the walk would have made.
- **Per-attempt accounting already exists** (`accounting.ts` records attempts individually), so a
  losing hedge is representable without inventing a new record type.

## 4. What it costs — the part that needs a decision

**Duplicate load is the whole trade, and it is not free here.**

- **Free-tier quota is consumed by the loser too.** This relay's pools are free providers, and its
  entire purpose is to spend quota it does not own carelessly. A hedge rate of *h* multiplies
  request count by up to `1 + h`. At the measured failure rate this lap, *h* would have been high.
- **Paid deployments cost money twice.** `freeOnly` already filters candidates, so a hedge inside a
  `freeOnly` rule stays free — but a pool without that flag can hedge into a paid member and bill
  the operator for an answer nobody read.
- **Request-level spend under-reports.** `accounting.ts` projects request spend from the winning
  serve attempt only. A loser's tokens are real and are recorded attempt-side, so the ledger keeps
  them — but `requestSpend` would stop being "what this request cost". That is a contract question,
  not a bug: either the projection changes, or the divergence is documented.
- **A cancelled loser teaches the breaker nothing.** Cancellation returns before the provenance
  table, so an aborted hedge produces no health evidence. That is arguably correct — the relay
  cancelled it, so its non-answer is not the provider's fault — but it means hedging *hides* the
  slowness it routes around. Pair it with B4 (shipped) so the slow member is still learned about
  from the requests that do not hedge.

⚠ **An invariant is engaged, and it is being stated rather than assumed.** `CLAUDE.md` says of
acting on counts: *"Acting on counts is optional, always announced, and may only reorder."*
**Hedging does not reorder — it duplicates.** That is a new category of action for this relay. So
it must be announced on the response, the way every other automatic behaviour here is
(`x-llm-relay-hedged`, naming the deployments raced and which won).

⚠ **On the second half — whether it ships on or off by default — I recommended OFF and the owner
decided ON, confined to free deployments. See D1 in §7.** The paragraph above is left standing
because its reasoning is what D1 answered, not because it describes the shipped behaviour. What D1
substitutes for "off by default" is a narrower blast radius: a duplicate can only ever land on a
deployment `assessCost()` calls `free`, and unknown counts as paid, so a stranger's install can
duplicate quota but never money.

## 5. Bounds the design needs

1. **At most one hedge in flight per request** to start with. A pool of glacial members must not
   fan out to N concurrent calls.
2. **Never hedge past the walk budget.** The hedge is an attempt like any other and shares
   `walkBudgetMs`.
3. **Never hedge into a candidate the request may not use** — the hedge target comes from the same
   already-filtered candidate list, so `freeOnly`, hard caps and quota demotion all apply unchanged.
4. **Abort the loser promptly** once a winner commits, so the duplicate cost is bounded by the
   hedge delay rather than by the loser's full timeout.
5. **A floor under the trigger**, so a fast deployment with a tiny p90 is never hedged on noise.

## 6. The cheaper thing to do first, stated so it is not skipped

`providers.nim` declares no `timeoutMs`, so it gets the **120000 ms** default — the same value as
the owner's `walkBudgetMs`. One hanging candidate therefore consumes the entire budget by itself,
which is why the walk in §1 died with attempts still unmade.

A shorter per-provider `timeoutMs` is **configuration, not code**, and it caps the damage from a
hang immediately. It is strictly worse than hedging — it abandons a slow member that was about to
answer, which is the case hedging exists to preserve.

⚠ **DONE, and the measurement moved the number a long way — it also makes the case for hedging.**
I first suggested 25000. Measured against 40 successful `nim` attempts from the ledger, that would
have cut **22.5%** of them:

| candidate | successful attempts cut | saved per hang |
|---|---|---|
| 25000 | 9 of 40 — **22.5%** | 95 s |
| 45000 | 4 — 10.0% | 75 s |
| 60000 | 2 — 5.0% | 60 s |
| 75000 | 1 — 2.5% | 45 s |
| **100000** | **0 — 0.0%** | **20 s** |

Successful `nim` requests run from 559 ms to **96959 ms**, so there is **no clean gap between
"working" and "hanging"** — the working band reaches almost to the timeout itself. `100000` is the
only value the data supports, it was applied on 2026-08-30 (backup:
`config.json.bak-2026-08-30-pre-nim-timeout`), and it buys only 20 s.

**That is the strongest argument for this document.** A timeout must choose between abandoning a
slow success and waiting out a hang, and here the two are indistinguishable by duration. A hedge
does not have to choose.

## 7. Decisions — ALL FOUR TAKEN BY THE OWNER, 2026-08-30

Recorded with the recommendation each one answered, so a later reader can tell an owner decision
from an agent's preference. **Two went against my recommendation; both stand, and the consequences
I raised are restated here rather than quietly dropped.**

**D1 — Gating: ON by default, for FREE deployments only.** (I recommended off by default.)
Hedging is enabled without opt-in, and confined to deployments `assessCost()` calls `free`.
⚠ **The consequence I raised, restated:** `assessCost()` treats **unknown as paid**, and a large
share of this machine's pool members carry unknown prices. So the rule is SAFE — it can never
duplicate onto a paid deployment — but it will **silently not fire** on many deployments where it
would have helped. That is the safe direction for a duplicator, and it is the trade the owner
accepted. It also means the feature's reach grows for free as catalog price coverage improves,
with no code change.
⚠ The `freeOnly` guard already resolves cost through `assessCost()`, so this reuses one classifier
rather than adding a second opinion about what "free" means.

**D2 — Scope: streaming AND buffered together.** (I recommended streaming first.)
⚠ **The consequence I raised, restated:** buffered has no token count until the answer lands, so its
trigger can only be absolute p90, and the duplicate rate is least predictable exactly where it
cannot be watched accruing. Its absolute p90 must read **probe samples only**, for the reason
v0.65.2 exists — a request-fed absolute statistic fires on the busiest healthy deployment first.

**D3 — Spend: losing hedges are INCLUDED in `requestSpend`.** (I recommended keeping the
winner-only projection and documenting the divergence.)
`requestSpend` becomes "what this request actually cost", not "what the answer you received cost".
⚠ **The consequence I raised, restated:** this changes the meaning of a shipped wire contract
(`dashboard.cost.v1`), which consumers already read, and a request's spend will no longer match the
deployment that served it. Treat it as a versioned contract change, not an internal edit.

**D4 — Target: the next candidate in walk order.** (This matched my recommendation.)
The hedge is simply the attempt the walk would have made anyway, started early. Deployment fitness
still decides the order, so nothing competes with it — and this deliberately avoids leaning a
second time on the reversed `server.ts` ranking rationale.

## 8. What is still undecided, and belongs with the implementation

- The trigger's constants: the floor under it, and the margin multiplier over expected time. Both
  should be CALIBRATED against this machine's traffic and recorded beside the number, the way
  `DEFAULT_LATENCY_MS_PER_TOKEN` is — not picked.
- Whether one hedge in flight is enough, or the cap needs to be configurable.
- Whether the response header names both deployments raced, or only the winner and a count.

## 9. Status

Proposed by the owner 2026-08-30, in response to the defect B options. B4 shipped separately and is
complementary: B4 makes the relay *meet* a slow member less often, hedging makes *meeting* one cheap.

✅ **BUILT AND WIRED on both fronts, 2026-08-30.** `hedge-trigger.ts` (the decision),
`hedge-race.ts` (the concurrency), `CredentialWalk.maxInFlight` + `recordAbandoned`, and
`server.ts` `runAttemptWithHedge` — ONE shared policy for `handle` and `openAiFrontPath`.
`routing.hedge` parses with `routing.latency`'s strictness; `x-llm-relay-hedged` announces every
hedge, won or lost.

Two structural findings from §8's open questions, both surfaced by ATTEMPTING the wiring rather than
by reading, and both recorded in `CLAUDE.md`:

- `CredentialAttemptTrace.record` matched the LAST open entry, so a primary that won against an
  egressed hedge threw on a good 200. It now matches the most recent open entry for that attempt.
- `CredentialWalk.next()` had to start re-offering a pending-but-UNSTARTED attempt. Both fronts'
  failover look-ahead depended on the single-slot saturation branch by accident, and raising the cap
  to 2 made the walk skip a candidate. 40 multi-candidate failover tests HUNG.

§8's three open questions, as answered by the implementation:

- **The constants stay placeholders.** They are unchanged and still say so in the source. The
  population needed to calibrate them is still not recorded; `HEDGED_HEADER` now states which rung
  set each delay, so the calibration can be gathered from real traffic.
- **One hedge in flight is enough for now.** `maxInFlight` is 2 with hedging on and 1 with it off, so
  `routing.hedge: false` is a byte-for-byte revert. Making the cap configurable is not done and is
  not needed by any measured case.
- **The header names BOTH deployments and which one answered**, plus the delay and its basis. Naming
  only the winner would hide a hedge that lost, which is the case an operator most needs to see.

⚠⚠ **D3 is NOT implemented, and attempting it found a structural obstacle the decision did not
have.** A losing hedge's spend does not enter `requestSpend`; the winner-only projection still
stands. Two findings, both from reading the code the change would have to touch:

1. **`AccountingSpend` cannot honestly represent two deployments.** It is one record carrying one
   `pricesUsed`, one `priceSource` and one `tokenBasis`, so summing a winner's and a loser's amounts
   into it would attach one deployment's prices to another's tokens — the provenance defect this
   project's own invariant forbids. The four-cell aggregate in `accounting-store.ts` CAN sum
   (`addSpendIntoCells`), so the faithful route is to carry the loser's spend as a separate entry on
   `RequestCompletedEvent` and fold it in the STORE. That is an additive change to the accounting
   event vocabulary, the persisted shard schema and the dashboard projection — a versioned contract
   change, exactly as D3 itself says, and a different piece of work from wiring a race.
2. **How much it would add is usually zero, because of a decision taken AFTER D3.** `hedge-race.ts`
   decides the race at RESPONSE RESOLUTION, and the relay reads no body before then, so an ABORTED
   loser has no observed tokens and therefore no spend at all. The case where D3 has real content is
   narrow but real: both sides settle and one loses by a microtask, so the loser carries a full
   completion that `abort()` can no longer undo.

⚠ This is the "an owner decision whose premise moved" pattern this repo already records twice. D3
was taken before the race's resolution point was chosen. The decision is not overturned here — it is
handed back with the measurement it did not have. Tracked in [backlog.md](../backlog.md).

## 11. Amendment 2026-09-04 — the floor grows with the request's own input size

> **Owner direction, 2026-09-04**: make the hedge delay "a multiple of the estimated or actual token
> count of the message."

**The measured context that motivated it.** §8 left the floor's two constants as declared
placeholders, and by this date every hedge on this machine was announcing basis `floor` — not
because no evidence existed, but STRUCTURALLY: `hedgeDelayDecision` is called at RESPONSE
RESOLUTION (§9, "the threshold IS the delay"), before any output token exists by construction, so
the per-token rung can never fire from that entry point and the flat floor decided every real hedge.
Separately, `~/.llm-relay/usage/recent.json` (100 successful requests) showed latency dominated by
the DEPLOYMENT, not the input size: requests under 2,000 input tokens had a median latency of
**30.1 s** (served by slow members such as `nim/kimi-k3`, 33 s at 1,300 tokens), while requests of
10,000+ tokens had a median of **10.9 s** (`kilo/nemotron`, 10.4 s at 105,000 tokens). An "expected
latency for this size × margin" rule built on that population would therefore hedge a SLOW member
LATE — the opposite of the point — because size does not predict latency here; the deployment does.

**The rule shipped instead is a FLOOR that grows with the prompt**, applied before egress from the
request's own ESTIMATE, in place of the flat `floorMs` under every rung:

```
floorMs(request) = max(minFloorMs, msPerInputToken × estimatedInputTokens)
```

`estimatedInputTokens` is the relay's own chars/4 estimate that already existed for the context
guardrail (`estimateRequestTokens` in `src/metadata.ts`; `estimatedRequestTokens` in
`src/server.ts` `handle()`) — threaded into the hedge decision rather than re-estimated, so the two
can never disagree about how large a request is. It protects the case the measured context above
describes directly: a large prompt is not hedged against the time it simply takes a healthy
deployment to read it, while a small prompt still gets the flat `minFloorMs` alone, unaffected.

**Basis, precisely**: only the rung reporting NO per-deployment evidence renames itself from `floor`
to `input-size` and additionally carries the estimated token count
(`x-llm-relay-hedged: ... (hedge won after 3210ms, input-size 1180 tokens)`) — a `per-token` or
`absolute` verdict keeps its bare name even on the rarer occasions where the size-scaled floor is
the larger `Math.max` operand, because evidence (not size) decided that a statistic applied at all;
stating a token count beside it would misattribute a number the deployment's own evidence set.

**Config**: `routing.hedge` gains `minFloorMs` (default 3,000 ms) and `msPerInputToken` (default
0.15 ms/token). `floorMs` survives as a LEGACY ALIAS of `minFloorMs`, resolved in
`resolveHedgeSettings` — an operator config written before this date (this machine's own included:
`routing.hedge.floorMs` had already been raised to 8,000 ms by hand, per `CLAUDE.md`'s
`hedge-trigger.ts` row) keeps loading byte for byte and keeps meaning exactly what it always meant.
An unknown key is still a hard load error.

**Calibration**: `scripts/calibrate-hedge-floor.mjs`, run 2026-09-04 against this machine's own
`~/.llm-relay/usage/recent.json` (100 successful serve attempts, 55 carrying ≥10,000 input tokens).
Method: the p25 (lower quartile) of `latencyMs ÷ inputTokens` ratios among the ≥10,000-token
requests, chosen over an OLS-through-origin slope on "the fast deployments" because that window
cannot support the classification robustly (a handful of deployments in the slice, several with
only 1-2 samples). The fit measured **0.036 ms/token** — OUTSIDE the script's accepted
[0.05, 0.5] band — so it was REJECTED and the built-in default of **0.15 ms/token** shipped instead,
the same fail-safe direction as every other "evidence too thin to trust" rule in this relay. Re-run
the script as traffic accumulates; nothing about the design changes if a future run lands in range —
only the shipped constant would.

Tests: `test/hedge-trigger.test.ts` (the formula, the legacy alias, the basis-preservation rule),
`test/config.test.ts` (`loadConfig — routing.hedge`, the new keys and the alias), and
`test/hedge-wiring.test.ts` (one end-to-end case per front proving a real request's estimate reaches
the announced header, not just a unit test's direct call into `hedge-trigger.ts`).

## 12. Amendment 2026-09-04 — the race settles at COMMIT, not at response resolution

**Owner direction, in reply to audit finding DR-002 ("the per-token rung is unreachable while the
feature is default-ON"):** *"The point of the hedge is to handle wedged requests, or requests so
slow as to be practically wedged. Rule 1 seems important to that."*

What that direction needed, and what was built:

- **The race now settles at COMMIT** — the first meaningful content — instead of at response
  resolution. `candidate-runner.ts` `withCommitProbe` runs the stream-commit probe inside each
  attempt's own promise, `attemptWon` requires a `ready` verdict, and both fronts consume the
  attached verdict through `takeCommitProbe` instead of probing a second time.
- **The shape this closes.** `fetchBackend`'s structural preflight already made "resolution" mean
  the first VALID DATA EVENT, so a provider that sent headers and then nothing was hedged before
  this amendment. The uncovered shape was headers plus a metadata event — a role-only chunk, a
  `message_start` — and then silence, which is how hidden-reasoning providers open a stream. That
  primary had "resolved", was called the winner, and the request waited out the provider timeout.
- **Measured, not assumed.** The first version of the pinning test sent headers and then nothing,
  and with the wrapper disabled it stayed GREEN — which is how the preflight's contribution was
  found. The test backend now sends the metadata preamble; with the wrapper disabled 4 cases fail,
  and with `attemptWon` ignoring the probe 2 cases fail (the dead-stream pair).

What rule 1 (per-token) can and cannot do, stated so it is not re-argued:

- On the hedge path it is INERT by construction: no output token exists before commit, so
  `hedgeDelayDecision` passes `tokensSeen: 0` and rules 2 and 3 decide. That is not a wiring
  defect; it is what "decided before content" means.
- After commit the client already holds the stream's bytes, so no hedge can replace a stream that
  stalls or crawls. The only honest post-commit remedy is an ABORT that hands the failure to the
  client to retry — which turns a slow-but-correct answer into a failed turn for a harness that
  does not retry a mid-stream error. That is a product trade-off the owner has not decided;
  `docs/backlog.md` carries it with the question stated.
- The measured "practically wedged" streams on this machine (kimi-k3 at 385–875 ms/token) are
  post-commit crawls. For those, latency demotion (v0.64+) and the `slow` band (v0.69.0) already
  move traffic away on the NEXT request; nothing in-flight changes until that decision is taken.

Tests: `test/hedge-wiring.test.ts` — "hedges a primary that sends headers and then stalls before
any content", "a slow primary whose stream DIES before content is not a win", and the negative
control "does NOT hedge a stream that commits inside the delay", each on both fronts.

**Owner decisions at the lap hand-back (2026-09-04):**

- **Post-commit remedy: measure first, then build only if clients retry.** A bounded lap measures
  what Claude Code and Codex do when a stream carries an SSE `error` after content has arrived —
  retry the request, or fail the turn. The abort on a per-token stall threshold is built only if a
  retry reaches another candidate; otherwise in-flight streams stay untouched and latency demotion
  plus the `slow` band keep moving the NEXT request. Work item: `docs/backlog.md`.
- **Terms review for hedging: no review needed.** Duplicate free-tier requests are within the
  relay's use as the owner runs it. Recorded here beside D1 (§7), which already confines hedging to
  free deployments; audit finding DR-003 is closed on this decision, not on a review.
