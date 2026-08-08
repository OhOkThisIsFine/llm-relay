# Pool eligibility — why a top-tier pool collapses to zero survivors

Diagnosed and fixed 2026-08-08, from an audit run whose `pool/xhigh` dispatch had no live member.

## What was seen

An audit lane addressing `pool/xhigh` got nothing. Probed directly, 0 of 13 members were healthy:
4×402 (credits), 3×429 (quota), 3×403 (subscription), 1×400 (gone). At the same moment
`llm-relay pools --probe` found three live candidates — `openrouter/nemotron-3-ultra:free`,
`gemini-3.5-flash-lite`, `nim/inkling` — and **none of them was in `xhigh`**.

Four symptoms were reported. All four reproduced. The probes below are first-party, run
2026-08-08 against the real accounts, and are the evidence the fix is built on:

```
ollama-cloud/glm-5.2            403  "this model requires a subscription, upgrade for access"
ollama-cloud/kimi-k3            403  "requires both a Pro, Max, or Team plan and extra usage"
nim/moonshotai/kimi-k2.6        404  "Function '<uuid>': Not found for account '<id>'"
huggingface/…/DeepSeek-V4       400  "The requested model … does not exist"
huggingface/…/DeepSeek-V4-Pro   402  "You have depleted your monthly included credits"
nim/z-ai/glm-5.2                429
```

## Root cause: pool depth is not quota independence

`pool/xhigh`'s 15 members are 6 huggingface + 4 ollama-cloud + 3 nim + 2 gemini.

HuggingFace states its 402 **per account**, not per model. Ollama Cloud's 403 is one
subscription. NIM's 429 is one account rate limit. So a 15-member pool has **four independent
quota domains**, and failover was walking 15 candidates to discover 4 facts. That is why the pool
goes from serviceable to zero in one step, and why the walk cost 13 round-trips to report one
thing.

Membership is what puts them there. `assessCost()` returns `free` on the `provider-tier` basis for
any model from a `tierType: "free"` provider with unpublished prices — the right default, since
most free providers publish nothing, but it is an assumption about a **roster**. A roster contains
subscription-gated SKUs and models de-listed behind the scenes, and nothing ever re-examined that
assumption against what the deployments actually answered.

The reported framing — "effort-tier membership is selected by capability, and capability
correlates with metered" — is close but not quite it. The `xhigh` members are not *priced*; they
are **allowance-gated**, admitted as free and then discovered to be spent, subscription-walled, or
gone. The survivors (`openrouter/…:free`, gemini flash-lite) are free on stronger evidence:
published zero price or an explicit `free` label.

## The four symptoms

### 1. `freeOnly` never fired — a config cause, plus two code gaps

`freeOnly` was **`false` on every rule** in the live config (`default`, `claude`, `codex`),
confirmed against the running relay's `/offload`, not just the file. The guard was never consulted,
so HuggingFace's raw 402 passed through as designed-for-a-different-configuration. A global
CLAUDE.md note claiming the guard was "enabled on this machine's rules" was stale, and has been
corrected.

Two genuine code gaps sat behind it, both now fixed:

- The guard was gated on `subSpec !== null`, i.e. **offload-rerouted traffic only**. A dispatch
  `cliLane` runs `claude -p --model pool/<name>`, whose requests are a *main* conversation — no
  subagent marker, no `@relay:` directive — so the free-lane traffic the flag exists to bound
  walked straight past it. It now also covers a **directly addressed** `pool/<name>`, which is by
  construction relay-routed free-lane traffic and never the vendor passthrough. The guard can only
  refuse to spend, so extending it cannot cost anyone an answer they were entitled to.
- The guard assessed **price only**. A deployment that has *stated* it requires a subscription now
  outranks a price table that calls it free.

⚠ Superseded 2026-08-08 — see *Settled* below. The flag became an option that defaults ON for
offload-rerouted traffic, and this machine keeps an explicit `false`.

### 2 & 3. Paid endpoints and catalog rot inside free-assessed pools

Both are the same shape: a fact about a deployment that only the deployment can tell you, which
nothing was recording. Fixed by a learned store — see below.

### 4. A pool's error was one member's error

The client saw HuggingFace's 402 and was pointed at a billing page, when four distinct causes were
in play and the correct action was "use another pool".

Now every walk of ≥2 candidates carries `x-llm-relay-pool-attempts`:

```
x-llm-relay-pool-attempts: 13 tried, 0 served: 4×402, 5×429, 3×403, 1×400
```

A **header**, not a rewritten body: the served body stays the last candidate's real upstream error,
the same maxim the context guardrail and the all-429 policy already follow. It is emitted on both
fronts from the same tracker, and on **successes** too — a 200 that took two candidates is worth
knowing about before the pool runs out. A single-candidate walk emits nothing, because then the
response *is* the walk.

## The fix: learned deployment eligibility

Two new modules, modelled on `context-limits.ts` — first-party evidence about the exact deployment
beats any published figure.

`src/deployment-eligibility.ts` stores verdicts and reports consequences. Three classes, and
**they are not interchangeable**:

| Class | The fact | Scope | Consequence |
|---|---|---|---|
| `not-servable` | existence — 404/400 "does not exist" | deployment | excluded from pool admission |
| `subscription-required` | cost — 403 "requires a subscription" | deployment | excluded from **free** pool admission |
| `allowance-exhausted` | temporal — 402 "depleted your monthly included credits" | **account** | demoted, never excluded |

⚠ **`allowance-exhausted` must never mean "paid".** A free-tier account that has spent this
period's credits is the normal state of a working free lane, not a discovery about price.
Reclassifying it would evict the deployment from every free pool, and the eviction would outlive
the exhaustion that caused it. It is unreachable from the cost path by construction: `isCostBlocked()`
does not consider it, only `cooldownUntil()` reports it, and any success clears it — including the
account record, so a topped-up balance recovers well before the TTL.

`subscription-required` is scoped to the **deployment**, not the account: Ollama Cloud's message is
about one model under a credential that works fine for its others. Only credit-balance refusals name
an account-level fact, and that scope is what stops six HuggingFace members costing six round-trips
to learn one balance.

TTLs (all three are reversible, so all three expire): 6h existence, 24h subscription, 1h allowance —
the shortest, deliberately, because cooling a provider for a month on one 402 would be catastrophic
if the balance were topped up an hour later. A vendor-stated `Retry-After` beats all of them.

## Interpretation: a two-tier design, and the boundary it respects

A status code does not carry its meaning. **403 is at least four different facts** — a revoked key,
a plan-gated model, a license/region-gated model, a policy refusal — and only the message
distinguishes them, in wording each vendor invents for itself. A hand-written pattern set covers
only the messages its author happened to see; every other refusal teaches nothing, forever.

`src/refusal-interpretation.ts` splits this in two:

- **Request path — deterministic lookup, nothing else.** A refusal is reduced to a signature
  (provider + model + the message with uuids, ids, numbers and urls stripped) and looked up against
  confirmed entries and reviewed seeds. A hit applies. **A miss learns nothing** — the same
  fail-safe that governs `context-limits.ts` — and records the signature as unseen.
- **Out of band — where judgement is allowed.** `llm-relay eligibility` lists unseen signatures with
  samples; research says what a message means for that provider, that model, this account; the
  verdict binds only once accepted.

⚠ **An LLM never decides a live routing decision.** CLAUDE.md's repair boundary — *routing decisions
come from config and deterministic classification, never from an LLM's opinion inserted into the
request path* — is why the research tier is offline and why acceptance is a separate step. The
relationship is the one `docs/tier-data.json` already has to pool ranking: a model may author the
data, the request path only ever reads it.

Signatures are keyed **per (provider, model, message)**. The same provider sends different wording
per model, and the same wording can mean different things for a model the account can reach and one
it cannot. A known message on a new model is a **miss** until researched — conservative, which is
the safe direction: a miss costs one round-trip, a false hit evicts a working deployment.

Seeds are the exception, matched as patterns rather than exact signatures, because a seed must cover
a provider it has never run against. They are reviewed source in version control; a researched
verdict is a model's opinion and gets the conservative key.

```bash
llm-relay eligibility
```

## Implementation gotcha worth remembering

The obvious way to read an error body for learning is `res.clone()`, as `observeContextLimit` does.
**It breaks failover.** `clone()` tees the body, the failover branch immediately cancels the
original, and the un-read tee branch strands the walk — the client is served the first candidate's
error with the rest of the pool untouched. Three pre-existing 402 tests went red and caught it,
which is exactly what this file's ≥2-candidate rule exists for.

The body is instead read where it was going to be discarded anyway (`discardCandidate()`) or where
it is already buffered (the terminal error branches). Cheaper, and no tee.

A second trap, also caught by the suite: the learned stores are process-global, and
`test/pool-failover.test.ts`'s `QUOTA_BODY` is the *real* HuggingFace message — so the first 402 test
recorded an account-scoped exhaustion for provider `p1` and every later test reusing that name found
its first candidate already demoted. Reset the stores per test, same as the breaker.

## Closing the loop: the dispatcher interprets, the owner accepts

A pull-only queue is a backlog nobody works, so the unseen-refusal signal is **pushed**: a failure
carrying uninterpretable refusals returns `x-llm-relay-unknown-refusal: <n>`, and the `llm-relay`
skill makes "run `llm-relay eligibility` on a pool failure" the reflex. The agent driving the
session is the right reader — it is already outside the request path, it already receives the
error, and it knows which pool it addressed and whether the task then succeeded elsewhere, which a
CLI listing cannot tell you.

The split is: **the agent may `propose`, only the user may `accept`.** That keeps the gate exactly
where it was — acceptance is what changes routing — while moving the review to where the owner
already is, instead of a file they have to remember to open.

⚠ **Error bodies are untrusted content from an external service**, and an agent that reads them is
an injection target. The payoff is real: text crafted to get rival providers classified
`not-servable` would evict the competition from every pool — a denial of service that looks like
the relay working. Three things bound it, and none may be traded away for convenience:

- a proposal is constrained to **three classes and two scopes** — not free text, not a command, so
  the most a hostile message can do is argue for its own classification;
- signatures are keyed per (provider, model), so one provider's message can **never** produce a
  verdict about another;
- the user accepts.

A count, not the message, travels in the header for the same reason: a response header is the field
a client is most likely to treat as trustworthy.

## The structural half: bands that degrade, order that spreads

Eligibility fixed membership *hygiene*. It did not fix the structural problem, which was measured
again after that work landed — same moment, same credentials:

```
pool/low   (46 members) → 200 OK   10 tried, 1 served: 7x429, 1x404, 1x403, 1x200
pool/xhigh (12 members) → 402      12 tried, 0 served: 6x402, 6x429
```

Two changes, both live:

**An exhausted band degrades.** Each effort pool is its banded members, then a tail of everything
clearing a lower band, strongest first. The tail is reached only after every in-band member has
actually failed, so a healthy pool is untouched. ⚠ A model clearing **no** band is admitted nowhere,
tail included — unassessed is not weaker, and admitting it would quietly reverse the evidence-aware
admission rule. Degradation is automatic but announced: `x-llm-relay-degraded: <spec> (below <band>)`.
An unflagged downgrade is indistinguishable from getting what you asked for.

**Order interleaves providers within a band.** Members sharing a credential share their failure, and
fitness ranking clustered them: `pool/xhigh` opened huggingface, gemini, huggingface, huggingface —
three of four attempts behind one credit balance. Interleaved, the first N attempts cover N domains.
The top-ranked candidate still goes first; this only decides who is second.

Measured after, on the same exhausted pool:

```
pool/xhigh → 200 OK   7 tried, 1 served: 6x429, 1x200
             x-llm-relay-degraded: gemini/models/gemini-2.5-flash (below xhigh)
```

Consequence worth expecting: every effort pool now has near-identical **membership** and differs
only in **order**, so `{contextWindow}` converges across pools. That is correct — the minimum is
taken precisely because failover can land anywhere, which is now more true than it was.

## Scope is part of the fact

The eligibility store was a one-off patch of a general problem. A fact's natural scope and its
storage keying kept drifting apart, independently, in every store that learned something:

| Fact | Real scope | Was stored as |
|---|---|---|
| Credit balance (402) | provider/account | per-deployment, until fixed here |
| Revoked key (401/403) | provider/account | per-deployment (`credentialFaultUntil`) |
| Account rate limit (429) | often provider | per-deployment (`cooldownUntil`) |
| Context window | deployment | deployment ✓ |
| Price / limits | deployment, cross-provider `reference` | correct ✓ |

`target-facts.ts` makes scope explicit and part of the fact — `deployment` → `group` → `provider` →
`model`, resolved most-specific-first with provenance, the shape `metadata.ts` already used for
limits and prices. A new fact kind can no longer invent its own keying.

⚠ **Scope comes from evidence, never from counting.** "Three models on this provider returned 401"
is equally three gated models under a working key — the false accusation `key-checker.ts` exists to
avoid. A provider-scoped fact requires wording that *states* an account-level condition; a bare
401/403 produces no fact at all and stays on the breaker's credential axis. Anything ambiguous goes
to the review tier and binds only once accepted.

⚠ **A group carries its own member list.** No registry, no prefix inference — that is the heuristic
`authEnv.ts` refuses, and a wrong match here evicts a working family. The reviewer sees exactly
which models a group verdict covers before accepting it.

### Where the breaker fits

The breaker keeps its per-deployment axes, deliberately. They are the right home for behaviour that
really is per-deployment: this model's back-pressure, this model's repeated timeouts, this model's
entitlement wall. What moved to the fact store is only what a backend **states** about a wider
scope, and the two now compose rather than compete:

- `rate-limited` (provider scope) exists for a 429 that names the *account*, *organization* or
  *key*. An ordinary 429 still produces no fact and stays entirely on the breaker's cooldown —
  matching plain throttling would demote whole providers on routine back-pressure, which is worse
  than the problem it solves.
- `credential-invalid` (provider scope) covers a *stated* bad key. A bare 401/403 still produces no
  fact, because it is equally an entitlement wall on one gated model.
- **A proven credential clears its own symptoms.** While a key is bad, every model that happens to
  be tried records its own credential fault on its own clock, so after a rotation the pool stayed
  artificially narrow until the last of them aged out. A served request proves the shared
  credential works, so `clearFacts` reports which provider-scoped facts it disproved and the
  breaker drops that provider's credential faults together. ⚠ Only on a disproved *stated* fact,
  never on any success — clearing bare 403s whenever a sibling succeeds would re-try gated models
  after every successful request, a permanent waste loop instead of a one-time recovery.

`/candidates` now carries a `facts` array per deployment, separate from `breaker`, because "cooling
on an account-wide credit balance" and "cooling on its own repeated timeouts" are identical in the
breaker fields and call for opposite responses.

`context-limits.ts` remains its own store. It is already correctly scoped per (provider, model), so
folding it in would be tidiness, not a fix — and it is the one store whose parsing rules are
genuinely specific to what it reads.

## Settled

- **`freeOnly` is an option that defaults ON for offload-rerouted traffic** and OFF for a directly
  addressed pool (owner decision, 2026-08-08 — see `freeOnlyApplies`). An install that has never
  thought about cost cannot discover offload by being billed for it; a request that *names* a pool
  is an explicit choice by someone who knows what a pool is. This machine carries an explicit
  `false` and is unaffected.
- **Pools rank free capacity first rather than excluding paid capacity** (same decision). A pool
  that admits only free deployments is free by construction — safe-sounding, until the free lane is
  spent and there is nothing left. Paid is reachable, always behind every free member of the band,
  and never silent: `x-llm-relay-paid` names the deployment and how its cost was assessed.
- The seed patterns generalize from a handful of observed messages. Everything they miss now lands
  in `llm-relay eligibility` as a pending item instead of being silently re-discovered every
  request — that queue is the intended way this converges.
