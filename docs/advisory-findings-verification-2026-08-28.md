# Advisory-findings verification — 2026-08-28

## What this is

The 2026-08-26 uncovered-areas review ended by saying, of its own output:

> The 13 cross-cutting and 19 type-level lane findings not listed above remain advisory and
> unverified. **Do not treat them as a work queue.**

That instruction was right and it left a debt: 32 claims about this codebase that nobody had checked
against source. This sprint checked them. Every verdict below was read from current `main`, most of
them twice — once by a lane, once first-hand — and where a lane and the source disagreed, the source
won and the disagreement is recorded.

Nine verification packets went to external lanes (four Codex, five relay free-pool); one was done
first-hand from the start. **Three lane reports were wrong in ways that would have caused harm if
taken at face value**, and those are recorded beside the verdicts, because the corrections are more
instructive than the verdicts.

## The headline: this is ONE bug class, not a list

The findings that matter share a shape, and the shape has a direction:

> An **open classifier over a CLOSED union** — an unconditional `else`, or a `default:` with no
> exhaustiveness assertion, or a runtime value list hand-copied from a type — where the fall-through
> resolves to the **stronger or riskier** claim.

A provenance fallback must fall to the *weaker* claim. Every instance here falls the other way, and
none of them can produce a compile error, so a union gaining a member produces a wrong answer
silently.

v0.50.0 already fixed one instance without naming the class: `llm-relay eligibility` told the
operator that six of the ten fact kinds meant "gone from the provider — excluded from pools",
because a nested ternary's else-branch swallowed every kind it did not name. It was fixed with a
`Record<FactKind, string>`. **Seven more instances survived.**

| # | union | site | fall-through resolves to | why that direction is wrong |
|---|---|---|---|---|
| 0 | `FactKind` | `cli.ts` eligibility | "gone from the provider" | **fixed in v0.50.0** — the precedent |
| 1 | `ContextWindowSource` | `cli.ts` lane renderer | "published by the serving provider" | labels an unknown source a first-party measurement |
| 2 | `FactResetBasis` | `availability.ts` `factResetInputs` | the `providerStated` rung | promotes an unknown basis to the **higher**-confidence rung |
| 3 | `AuthHeaderName` | `authEnv.ts` `buildAuthHeaders` | `x-api-key` | sends the operator's credential under the wrong header |
| 4 | `FilterState` | `think-tags.ts` `flush()` | `""` | **deletes held bytes** in the one module whose stated purpose is losslessness |
| 5 | `OutcomeProvenance` | `circuit-breaker.ts` `applyTerminalOutcome` | provider-health evidence | charges the **provider's** breaker for a **relay-local** fault |
| 6 | `ErrorOrigin` | `backend.ts` | `"upstream"` | `upstream` also means *retriable*, so the walk rerolls other members for a relay fault |
| 7 | `AccountingEvent` | `accounting-store.ts` `record()` | falls through the ladder | recorded as a **success that did nothing**, with no loss marker |

Instance 5 is the one to read twice. The repo has written that policy down **in prose, twice** —
*"a cap never registers on the breaker — it is config, not health"* and, of the dialect refusal,
*"the deployment's failure budget is untouched"* — and enforces it for exactly one union member
(`relay-mapper-defect`) with a hand-written early return.

Instance 7 is the sharpest direction: the accounting store's whole contract is that unknown stays
`null` and loss is MARKED. A silently-dropped event defeats the loss markers that exist to make
exactly that visible.

There is a second variant of the same class, where the drift is between a type and a runtime list
rather than inside a branch:

| union | runtime list | how they drift |
|---|---|---|
| `FactResetBasis` | `UNTIL_BASES: ReadonlySet<string>` in `target-facts.ts` | typed over `string`, so a fifth member is not a compile error — it is silently dropped at load and at `recordFact` |
| 9 dashboard wire unions | `TOKEN_SOURCES`, `LIMIT_BASES`, … in `dashboard-contract.ts` | nine unions written by hand, then nine `as const` arrays repeating the same members. Validators use the arrays; producers use the types; nothing connects them |

## The distinction that decides what to fix

Not every type hole in these reports is a defect, and treating them alike would have produced a
churn sprint. Two classes:

- **Class A — an open classifier over a closed union.** A new member produces a **wrong answer** or
  is **silently dropped**, with no compile error anywhere. **Fix these.**
- **Class B — a type wider than its producers.** The bad state is expressible but no producer can
  emit it, because every construction site is centralized and validating. A maintainer would have to
  hand-write the bad state. This is **hardening**, and this repo defers it.

Four findings are Class B and all four get the same verdict, or the sprint would be inconsistent:
type-level **2** (`AccountingSpend` combinations), **8** (`RemainingResolution` value-without-basis),
**14** (`TokenFactsInput` layouts), **15** (`KekDescriptor` combinations). Real type holes, no
producer reaches them, deferred.

## Verdict ledger

### Cross-cutting defects

| # | verdict | note |
|---|---|---|
| 1, 2, 3, 8, 10 | ALREADY-FIXED | closed in v0.49.0 |
| 4 | **CONFIRMED**, scope narrowed | `pool-health` and `ping/quota` have no application deadline. Both are one-shot **CLI** paths, so nothing accumulates in the relay; the real harm is that `llm-relay pools --probe` — "the only real liveness check" — awaits every worker and can hang on one non-settling member |
| 5 | **CONFIRMED (live)** | a corrupt lane manifest **evicts** a healthy lane; a corrupt probe cache reaches **pool ordering** |
| 6 | ALREADY-FIXED | `8192b43` closed the write half too — `persist` re-observes the stat token and merges before writing |
| 7 | **CONFIRMED**, latent, test-only | mechanism was misreported; see below |
| 9 | **CONFIRMED** | a provider name may contain `/` and become unaddressable; an exclusion cannot name a provider containing whitespace though routing can |
| 11 | **CONFIRMED (live)** | `fetchedAt: Infinity` passes `typeof … === "number"`, and `now - Infinity < ttlMs` makes the cache **permanently fresh**. `NaN` is already safe |
| 12 | **CONFIRMED**, severity split | all four writers lack `finally` cleanup; two name the temp by PID (bounded), two by `Date.now()`+random (**unbounded** orphan accumulation) |
| 13 | **CONFIRMED (live)** | `target-facts.ts` has no cap and never prunes; `factsFor` scans it **on the request path** |

**NEW — CC-N1, not in the original report.** `src/ping/ping.ts` `pingProviderModel` returns using
only `resp.status` and `resp.headers`; **the response body is never consumed and never cancelled**,
and `finally { clearTimeout(timer) }` disarms the abort so the unread body has no deadline left.
`isDisabledThinkingRejected` compounds it with `resp.clone().text()`, reading only the clone —
precisely the hazard `CLAUDE.md` warns not to copy into a new call site. Unlike defect 4's own
sites, this runs in the **long-lived relay**, on a cadence, across every configured deployment.

### Cross-cutting simplifications

| # | verdict | note |
|---|---|---|
| 1 | CONFIRMED, simplification | `readDay` runs `parseAccountingDayShardV1` twice — once as the `readJson` predicate, once after — and the parser guards, deep-clones, guards again and deep-freezes each time |
| 2 | pairs with defect 12 | one best-effort writer would fix the temp-cleanup gap; that is the reason to do it, not the ~7 lines |
| 3 | ALREADY-FIXED | `onboarding.ts` now reads `opts?.envPath ?? defaultEnvPath()`; `dotenv.ts` is the one owner, routed through `relayStatePath` |
| 4 | CONFIRMED, count corrected | the report found three first-slash splits, all in `config.ts`. There is a **fourth**, in `metadata.ts` `contextWindowResolver`, and its `slash > 0` guard is different semantics — which *strengthens* the report's own "not worth standalone churn" verdict |
| 5 | CONFIRMED, nit | `refusal-interpretation.ts` re-reads `process.env.VITEST` when `testPath !== null` already holds the decision, and needs a `testPath!` because of it |
| 6, 7 | rejected by the report itself | kept: each would sit on a provenance or durability boundary |

### Type-level findings

| # | verdict | disposition |
|---|---|---|
| 1 | ALREADY-FIXED | v0.49.0 |
| 2 | **REFUTED as a defect** | Class B. Both producers hardcode matching triples and the estimated branch always pairs with `input_only`, so the claimed `estimated`+`full` state is structurally impossible |
| 3 | **REFUTED** | the commit latches once, cannot latch after attempt or request completion, and request completion takes no override |
| 4 | **CONFIRMED** | Class A, thesis 7 |
| 5 | **CONFIRMED** | the coherence guard mirrors `tokens` and omits `spend`, though the field's own comment says spend mirrors tokens |
| 6, 14, 15 | CONFIRMED as type holes | Class B — defer |
| 7 | **CONFIRMED, narrowed** | see below; the lane overstated it |
| 8 | **REFUTED as a defect** | Class B; the report itself found 0 wrong constructor branches and says "defer" |
| 9, 10-partial | ALREADY-FIXED | `6f8608b` added `_never` assertions and `satisfies` |
| 10 | **CONFIRMED** | Class A, thesis 2 — and there are **three** hand-maintained classifiers, not the two claimed |
| 11 | **CONFIRMED** | Class A, thesis 1 |
| 12 | CONFIRMED, deferred | real drift, but one owner over `accounting-store-schema.ts` could change what LOADS. The bar is differential fuzzing over a hostile corpus, as `9964213` did for `json-shape.ts`; this report did not clear it, and a quarantined shard is a lost day of ledger |
| 13 | CONFIRMED as a type hole | Class B — `recordFact` already drops `untilBasis` without a positive `retryAfterMs`, and `load` drops it without an explicit `until` |
| 16 | **CONFIRMED** | Class A2 — nine dashboard unions hand-copied from their own `as const` arrays |
| 17, 18 | **CONFIRMED** | Class A, thesis 3 and 4 |
| 19 | **CONFIRMED**, count corrected | reported 18 sites, actual **19** — `backend.ts` holds an additional distinct `ErrorOrigin` default. Same class, same direction |

## Where the lanes were wrong

Three corrections, each of which would have sent a fixer the wrong way.

1. **CC-B claimed a corrupt lane manifest makes `verifyModel` THROW.** It does not. `"x".id` is
   `undefined` — property access on a string is legal — so `some()` returns false and the lane is
   reported **`not-servable`, i.e. EVICTED**. That is worse than a throw, and it contradicts the
   module's own comment (*"Unreadable is UNKNOWN, never 'nothing is servable'"*) and `CLAUDE.md`'s
   *"corrupt ⇒ UNKNOWN, nothing evicted"*. A fix validated only against "does not throw" would pass
   on the buggy code.
2. **CC-C claimed the write-behind timer writes one path's state to another path.** It does not. The
   adopters capture the path lexically at touch time; `touch()` calls `clearTimeout` and **discards
   the previous callback**, so the hazard is a *dropped* write, not a misdirected one — and only
   when two different paths are touched inside the 250 ms window, which no production process does.
   The proposed fix ("capture the path at touch time") was already the code's behaviour.
   That lane also reported a cap of "1000" that is actually `MAX_UNKNOWN = 200`; 1000 is
   `session-pin.ts`'s LRU, which I had named **in its own brief as an example**. A concrete number
   in a brief can be laundered back as a finding.
3. **TL-A confirmed all four of its findings and quoted no source at all.** Re-checked first-hand,
   two were wrong. The one that matters: its recommended fix for finding 3 was *"Remove
   `RequestCompletionOptions.commitMs` and the late mutation branch"* — deleting a working,
   deliberately-guarded API on a false premise.

⚠ **The tell was uniformity.** A pass over four independent claims that confirms all four, with an
empty evidence column, is a rubber stamp. CC-B and CC-C each produced real evidence and each got one
thing wrong — that is what an honest pass looks like.

And one where the lane was right and the brief was wrong: CC-A was asked to confirm that
`ping/ping.ts` bounds its fetches "for contrast". It does, and it said so, destroying half the
premise it was handed — then found the unrelated body-cancellation gap that became CC-N1.

## Finding 7, narrowed — the hard cap's usage basis

The lane claimed `/candidates`, the CLI **and** the `x-llm-relay-capped` header all label the
used/cap pair `operator-declared`, hiding whether the usage figure was measured or estimated.

`hardCapLabel` renders **no basis at all** — only `${used}/${cap}` — so the header and refusal body
do not conflate anything. `HardCapVerdict.basis` is carefully documented as describing the CAP, and
`formatCandidateHardCap`'s own comment says so: *"`basis` says the ceiling is the operator's own
assertion (not a measurement)"*.

What remains is real but narrower: **`used` carries no provenance anywhere.** On a token axis it can
be a relay chars/4 estimate — `CLAUDE.md` notes an estimated-only window "can move the explicit
refusal ceiling" — while its own doc-comment calls it "What the local ledger **measured**". An
operator asking "why was I refused at 450?" cannot tell a measurement from an estimate. That is a
transparency gap against this project's stated identity, **not a wrong refusal**: the refusal is
licensed by the operator's declared ceiling, which is labelled correctly.

Deferred as an owner decision — it is a DTO change across four consumers for a case needing both a
token-axis hard cap and an estimated window.

## What landed

Every packet gate-verified twice (implementer run, then orchestrator run), every new test confirmed
to FAIL on the un-fixed tree before its fix, and every corrupt-input test carries a valid control
beside it.

- **`aabac49` — three closed unions get one total owner each.** `ContextWindowSource`,
  `AuthHeaderName`, `FilterState`, each a table checked with `satisfies`. Mutation-checked: a
  fourth member added to any of the three fails `npm run typecheck` at the table.

  Two live cases were found **by** making the classifiers total, neither of them in any report:
  - `contextWindowSource` is optional, so an **absent** source was already rendering as "published
    by the serving provider". The compiler said so the moment the table became total. The two
    fields are written together in `dispatch.ts`, so it cannot occur — the renderer now tests both
    anyway, because the alternative is inventing a provenance for a number whose provenance we do
    not have.
  - `test/mid-stream-failure.test.ts` built a `ResolvedTarget` through `as unknown as` and omitted
    the required `authHeader`; the old unconditional return accepted that silently as `x-api-key`.
    Fixture completed, fall-through not restored.

  ⚠ 4 of the 13 new tests fail pre-fix and all four are mechanical guards. The 9 behavioural tests
  pass **both** before and after — which is correct, because this change must alter nothing
  observable, and the three rendered basis strings are byte-identical.

- **`1546b19` — a persisted evidence store degrades to UNKNOWN, never to a verdict.**
  Lane-manifest entries are deep-validated (corrupt ⇒ `null` ⇒ unknown, which the existing code
  already honours); `Number.isFinite` closes the catalog's permanently-fresh state and the disk
  path now applies the same model-count and id-length bounds as the wire path; the probe cache
  guards its reads **and its write**.

  ⚠ The write-side guard is the half a read guard cannot cover. Spreading a corrupt
  `samples: "abc"` turns it into three character samples and **persists them** — after which the
  read guard sees a genuine array and passes it straight through to `getStabilityScore` and
  `samples.length / 5`, which decide pool order. Corruption would have been laundered into evidence.

  ⚠ **A test-quality fix in the same change.** The lane's Infinity fixture was built with
  `JSON.stringify({ fetchedAt: 1e309 })`, which emits `{"fetchedAt":null}` — JSON has no Infinity
  literal. The fixture never contained the value under test, so the test passed identically before
  and after the fix while appearing to pin it. It is raw JSON text now, and a finite-timestamp
  control was added beside it so `Number.isFinite` cannot silently reject a good cache.

## Deliberately not done

- **Four Class B findings** (type-level 2, 8, 14, 15): real type holes, no producer reaches them.
  Hardening, deferred. Type-level 15 (`KekDescriptor`) carries a genuine counter-argument — it is
  custody code, where "make invalid states unrepresentable" is worth more, and the discriminated
  union is only ~6-12 lines. Still deferred, because `keystore.ts` and `os-keyring.ts` are where
  churn costs most and the load validator already holds the line. Recorded as an owner-visible
  trade, not a silent drop.
- **Type-level 12** (persisted accounting vocabularies): real drift, but one owner over
  `accounting-store-schema.ts` could change what LOADS, and a shard that stops loading is a lost
  day of ledger. The bar is differential fuzzing over a hostile corpus, as `9964213` did for
  `json-shape.ts`. Deferred until someone clears it.
- **Type-level 7** (hard-cap usage basis): narrowed to a real transparency gap — `used` carries no
  provenance, and on a token axis it can be a relay estimate — but it is **not** a wrong refusal,
  and the header does not conflate anything. A DTO change across four consumers; owner decision.
- **Cross-cutting 7** (write-behind): confirmed but latent and test-reachable only. The proposed
  fix was already the code's behaviour.
- **Cross-cutting simplifications 1, 4, 5**: confirmed, all small, none urgent. Simplification 4's
  verdict is *strengthened* by finding its fourth site, not weakened: that site has different
  semantics, so one parser could not serve all four.
- **Response body SIZE bounds** on the pool-health and quota paths. CC-A confirmed them unbounded
  in size as well as time. That needs streaming reads with per-call caps and is a different change
  with a different risk profile.
- **No orphan-temp sweeper.** A readdir-and-age sweep would have to prove a file is not another
  process's in-flight temp; `HANDOFF.md` §6 already weighed and declined that.
