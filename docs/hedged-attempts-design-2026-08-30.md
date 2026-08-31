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
it must be (a) announced on the response, the way every other automatic behaviour here is
(`x-llm-relay-hedged`, naming the deployments raced and which won), and (b) **off by default**,
under `routing.hedge`, because a default-on duplicator would spend a stranger's quota at up to twice
the rate they asked for on the first request after install.

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

Setting a shorter per-provider `timeoutMs` (say 25000) is **configuration, not code**, and it caps
the damage from a hang immediately. It is strictly worse than hedging — it abandons a slow member
that was about to answer, which is the case hedging exists to preserve — but it costs nothing to
try, and it makes the pool usable today.

## 7. Decisions needed before any code

1. **Default off under `routing.hedge`?** (Recommended: yes, for the invariant reason in §4.)
2. **Streaming only, or buffered too?** Streaming has the honest trigger. Buffered needs the weaker
   absolute-p90 signal, and is where duplicate cost is least predictable.
3. **What happens to `requestSpend` when a loser burned tokens** — change the projection, or
   document the divergence?
4. **Hedge target selection**: strictly the next candidate in walk order, or the fastest-measured
   candidate not yet tried?

## 8. Status

Proposed by the owner 2026-08-30, in response to the defect B options. Nothing built. B4 shipped
separately and is complementary: B4 makes the relay *meet* a slow member less often, hedging makes
*meeting* one cheap.
