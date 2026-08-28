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

## Friction

Rewalked from the transcript, not recalled.

### Lane behaviour

1. ⚠ **`codex exec` exits 0 when it hits its usage limit.** Three lanes died mid-work with
   `ERROR: You've hit your usage limit … try again at Sep 3rd` and **exit code 0**; the harness
   reported "completed (exit code 0)" for all three. Nothing in the exit status distinguishes a
   finished lane from a dead one — only the missing report file does. **Never judge a Codex lane by
   its exit code; check for the artifact.** Memory already recorded this for relay lanes ("a lane
   returning two words and exit 0 is a failure, retry"); it is true of Codex too.
2. ⚠ **Codex went from healthy to exhausted inside one sprint**, with a reset SIX DAYS out. A probe
   returned `CODEXOK` at 09:33; the limit hit at ~09:55 after roughly 930k tokens across four lanes.
   Put the CHEAPEST packets on Codex first — the opposite of what I did, having given it the biggest
   ones because it is the strongest.
3. ⚠ **`codex exec --sandbox workspace-write` DECLINES a write outside the workspace** (`patch:
   declined`), losing that lane's entire answer. A Codex lane's report path must be inside the repo.
4. ⚠ **The OpenRouter key hit a WEEKLY limit and dominated every pool.** Four lane dispatches died on
   it across `pool/high`, `pool/xhigh` and `pool/medium`, because gemini and huggingface were
   simultaneously `allowance-exhausted` and three kimi-k3 breakers were OPEN. A trivial probe still
   returned `OK` — the walk only exhausts on a LARGE request, which narrows the pool by context
   window to exactly the OpenRouter members. **A pool that answers a one-word probe is not a pool
   that can carry a long packet.**
5. **This produced a live demonstration of the problem `target-facts.ts` exists for** — and then a
   sharper demonstration of the trap next to it. The same refusal was queued once PER MODEL
   (entries 17, 19-24, all identical), which looks exactly like the "rediscovered per model" waste
   the fact store was built to end. I proposed a **credential**-scoped `allowance-exhausted`,
   reasoning that the message names the KEY.

   ⚠ **That was wrong, and the owner caught it.** OpenRouter's weekly key limit is a **SPEND**
   limit, and its models are a mix of free, temporarily discounted and paid — categories that
   change on OpenRouter's schedule, not ours. Measured 2026-08-28 on one credential within one
   minute: `cohere/north-mini-code:free` → **200**, `dots-studio/dots-3-note-preview:free` →
   **200**, `deepseek/deepseek-v4-flash-0731` (paid) → **403 Key limit exceeded**. The relay's
   OpenRouter catalog holds 398 models, 18 of them free.

   So the condition is real but its SURFACE is the paid subset, not the credential. A
   credential-scoped fact would have demoted all 398 deployments, including 18 that demonstrably
   answer. **A scope must match the surface the evidence covers, not the noun the message
   happens to name.** `CLAUDE.md` already warns against collapsing "out of free credits" into
   "paid"; this is the mirror image — collapsing a paid-tier exhaustion onto the free tier — and
   it is just as wrong.

   ⚠ **No static scope can express it.** The vocabulary is attempt → group → deployment →
   credential → provider → model; none carries a cost dimension. A `group` with an explicit member
   list is the closest, and it would go stale precisely because the categories move. The relay
   *does* classify cost live — `assessCost()` reads catalog pricing and `freeOnly` rules resolve
   through it — but a fact cannot say "the paid subset of this credential".

   **Conclusion: record no fact.** The per-deployment breaker credential-fault path is correct
   here *because* it is per-deployment: each model discovers its own 403 and demotes on its own,
   which cannot cross the cost boundary. The per-model rediscovery I called waste **is the safety
   property**. Nothing binding was written; `propose` leaves the signature queued.

### Lane output quality — the tells

6. ⚠ **Uniformity is the rubber-stamp tell.** A report confirming all four of its findings with an
   empty evidence column is not a pass. Both honest reports (CC-B, CC-C) produced real evidence and
   each got one thing wrong. The rejected one (TL-A) confirmed everything, quoted nothing, and was
   wrong on two of four — including recommending the DELETION of a working, deliberately-guarded API.
7. ⚠ **A brief's own example can come back as a finding.** CC-C reported a cap of "1000" that is
   actually 200; 1000 was `session-pin.ts`'s LRU, which I had named in that brief as an example of a
   collection that already has a cap.
8. ⚠ **Three of five implementing lanes shipped a fixture that hid the bug it was meant to pin.**
   `JSON.stringify({fetchedAt: 1e309})` emits `null`, so the Infinity test never contained Infinity.
   A hand-thrown `new DOMException("Aborted","AbortError")` never matches a real
   `AbortSignal.timeout`, which aborts with `TimeoutError`. **Always run a new test against the
   un-fixed tree and read the failure**, and prefer rejecting with the real signal's own `reason`
   over inventing an error.
9. ⚠ **A lane reported "gate green" having written NO tests at all** (FIX-B, five changes). Green is
   not done.
10. ⚠ **A lane introduced a routing regression that the full gate passed.** `deadline: false` in the
    breaker's provenance table would have left a timing-out deployment permanently healthy. Nothing
    covered the path. **When a lane converts a branch into a table, check every entry against what
    the branch actually did** — a table is a transcription, not an invitation to re-decide policy.
11. **A lane also destroyed half of a brief's premise, correctly.** CC-A was asked to confirm
    `ping/ping.ts` bounds its fetches "for contrast"; it does, it said so, and then found the
    unrelated body-cancellation gap that became this sprint's one new finding. Briefs should invite
    that.

### Environment

12. ⚠ **I hit the documented `python -` trap anyway.** `docs/documentation-pass-2026-08-27.md`
    records that it opens an interactive REPL and hangs to the 2-minute timeout. I used it as the
    first half of a `python - … || node -e …` fallback and lost the full two minutes. **A documented
    trap is not a solved trap.** Use the Edit tool, or write a `.mjs` and run it with node.
13. ⚠ **`pwsh -File <relative-path>` prints the PowerShell help and exits 0** when the path does not
    resolve. Two re-dispatches silently did nothing because the Bash tool's cwd had moved into a
    subdirectory from an earlier `cd`. Use absolute paths for `-File`; the Bash tool's cwd persists
    across calls.
14. ⚠ **Heredoc quoting in the Bash tool broke twice** on content containing backticks and nested
    quotes, both times costing a retry. For anything with code in it, use the Write tool.
15. **Fix lanes must be SEQUENTIAL; verification lanes may be parallel.** Two write lanes would both
    run `npm run build` into the same `dist/` and both run vitest over a shared `src/`, so each
    would see the other's half-finished edits. Nine read-only verification lanes ran at once with no
    trouble.
16. **A lane that dies mid-response can leave good work.** FIX-A died after two of three changes; the
    tables were correct, the comments explained why, and the strings were intact, so finishing it was
    cheaper than discarding it. Judge the partial tree on quality — the precedent for discarding
    (2026-08-26) was a tree that was mis-indented and untested, not merely incomplete.

## What landed, completed

Five fix packets, gate green on each, every new test confirmed to FAIL on the un-fixed tree.

| commit | what |
|---|---|
| `aabac49` | three closed unions that produce LABELS get one total owner each |
| `1546b19` | three persisted evidence stores degrade to UNKNOWN, never to a verdict |
| `ab75f65` | four closed unions that decide ROUTING and HEALTH, plus nine derived wire unions |
| `cd6e5f8` | the diagnostic probes get a deadline; the relay's ping loop stops stranding sockets |
| `82c084f` | expired facts pruned, four temp files cleaned up, `spend` mirrored in the guard |

**Every one of the five implementing lanes needed correction in review, and the corrections
cluster.** Three of five shipped a fixture that could not observe the bug it was meant to pin:

- `JSON.stringify({ fetchedAt: 1e309 })` emits `{"fetchedAt":null}` — JSON has no Infinity literal.
- A hand-thrown `new DOMException("Aborted", "AbortError")` never matches a real
  `AbortSignal.timeout`, which aborts with **TimeoutError**.
- All four temp-cleanup tests aimed at a "non-existent parent directory", which every one of those
  writers creates with `mkdirSync(…, { recursive: true })` before writing — and then asserted
  against the wrong directory.

In each case the test passed identically before and after the fix. **The only reliable check is to
run a new test against the un-fixed tree and read the failure.** "Gate green" caught none of them —
nor did it catch a lane reporting green with no tests at all, nor a lane's `deadline: false` routing
regression.

Two further corrections were design rather than test quality: a lane inlined a duplicate of
`errorOrigin()` at the call site — creating a second definition inside the commit whose entire point
is one owner — and left the real drift seam untouched; and a `flushFacts` guard would have SKIPPED
the shutdown flush on a non-finite clock rather than falling back, losing the pending write.

### Still open, with its home

- ~~The OpenRouter weekly limit, as a credential-scoped fact.~~ **WITHDRAWN, and it should not be
  accepted** — see friction item 5. The limit is a SPEND limit whose surface is the paid subset;
  free models on the same key answer 200. No scope in the vocabulary expresses a dynamic cost
  subset, so the right answer is to record nothing and let the per-deployment breaker handle it.
  Nothing binding was written.
- **Observation, not a proposed change:** the fact-scope vocabulary has no cost-class dimension,
  and the one mechanism that could express a spend ceiling directly — the G2 `limits.hard` cap — is
  denominated in requests/tokens per minute or day, not currency per week. So an operator-declared
  "stop at $N/week on this key" has no home today. Recorded because it is the shape a real answer
  would take, not because it is asked for.
- **Type-level 7** (hard-cap usage basis) and **type-level 12** (persisted accounting vocabularies):
  confirmed, deferred with reasons above. Owner decisions.
- **Four Class B findings** (type-level 2, 8, 14, 15): hardening, deferred.
- **Type-level 2's real residue:** `AccountingSpend` carries both `tokenBasis` and `source`, two
  fields holding the same fact with near-identical doc-comments and nothing enforcing agreement.
  A correlated-pair smell, not worth churn alone, and the honest version of what that finding was
  reaching for.
- **Response-SIZE bounds** on the pool-health and quota paths, and the `withBudget` non-cancelling
  race in `key-checker.ts` — both named in the packet-D commit as deliberately out of scope.
