# Metering reconciliation — accounting foundation vs. quota-metering-spec (2026-08-22)

Reconciles the implemented metering program against [quota-metering-spec-2026-08-16.md](quota-metering-spec-2026-08-16.md)
(§1 metrics, §2 collection, §3 storage, §5 availability, §6 presentation, §8 gaps, §9 stages) and
[open-decisions-2026-08-16.md](open-decisions-2026-08-16.md) (all recommendations approved 2026-08-21).
Read-only analysis; every claim cites a line read for this document.

**Updated 2026-08-22 (evening), after the nine-commit metering sprint** (`7abdaf2` .. `9fd9f36`,
branch `main`) closed Stages 3, 4 and 5: the original reconciliation below was written against the
accounting foundation + Analytics SPA alone (`b4ec7ee`). The tables carry the current state; where
a row flipped, the evidence cites the code as it now stands.

Headline: the spec's pipeline shape was still not built literally — the event-sourced accounting
store (`accounting.ts` lifecycle → `accounting-store.ts` day-sharded snapshots) plus the SPA
supersede Gaps 2/3/6/7/17 — but the availability half is now built: limit discovery (Gaps 5, 8,
13), the §5 ladders, Stage 4 spend with the `llm-relay cost` roll-up, and Gap 12's enforcement term
all landed. Open items are listed in §7.

## 1. GAP 1–17 status

| # | Gap | Status | Evidence | Missing if partial |
|---|---|---|---|---|
| 1 | Typed quota observation | **implemented** | `src/quota-observation.ts:6-14` (`{axis,period,limit,remaining,resetsAt,observedAt,basis}`), extractor `:194-283`; `extractQuotaPercent` kept as deprecated wrapper that declines ambiguous headers (`src/ping/ping.ts:21-28`); probe cache now keyed `(credentialId, modelId)` — the scope drift fixed (`src/ping/cadence.ts:103,179-181,247-256`); breaker stores typed observations (`src/circuit-breaker.ts:35,427-429`) | — |
| 2 | Reported-token capture, both fronts | **implemented** (different mechanism than the tail-tap the sketch proposed) | `observeUsage()` wraps the body in a byte-exact `TransformStream` with a bounded SSE/JSON parser (`src/usage-observer.ts:357-404`, frame cap `:38`); tapped for anthropic-kind backends `src/backend.ts:479-480`, direct Chat `:571`, translated `:1121`, and reshaper calls `src/reshaper.ts:412-416`; OpenAI streams now request usage (`backend.ts:546-549`) | — |
| 3 | Widen `LOG_FIELDS` | **not-started — superseded by decision-shaped drift** | `src/log.ts:79-96` unchanged (no token fields); token totals live in the accounting store instead | The JSONL is not the per-request ledger; the accounting store is. Record the substitution explicitly or add the fields |
| 4 | Widen `AssistantMessage.usage` for cache tokens | **implemented (C3 adopted)** | `src/anthropic.ts:75-83` carries the two cache fields beside input/output, closed shape; emitted only when numerically reported (`src/emitSse.ts:37-43`); both cross-protocol translation seams map them (`src/backend.ts:992-1050`: `openAiUsage()` folds reads+writes into `prompt_tokens`, `openAiPromptUsageToAnthropic()` splits them back out) | **Residual:** STREAMING cross-protocol translation inside the `llm-bridge` dependency drops the cache fields and zero-fills missing usage — no seam after llm-bridge hands back translated SSE; see §7 |
| 5 | Configured limits on `ProviderConfig` | **implemented** | `limits?: ProviderLimitsConfig` on the provider (`src/config.ts:112`) and per credential slot (`credential-fleet.ts`); closed axes + hard-error parser (`src/configured-limits.ts:21,74`); per-axis resolver credential-model → provider-model → credential → provider (`resolveConfiguredLimits`, `configured-limits.ts:153`) | — |
| 6 | Day-sharded usage store + rollups | **implemented** | day shards `YYYY-MM-DD.json` (`src/accounting-store.ts:107`, writer `:336-340`), minute cells inside a day (`:558-567`), `lifetime.json` months (`:264-272,1068-1080`), `recent.json` details, bounded samples for percentiles (`ACCOUNTING_MAX_SAMPLES` `:495-498`), write-behind flush (`:1591-1600`), VITEST temp-dir redirect (`:337`), shutdown close (`src/cli.ts:574-614`) | Finer than spec (minute vs hourly buckets); dedup + coverage/loss ledger goes beyond it |
| 7 | `llm-relay usage`/`quota` + `GET /usage`,`/quota` | **partial -> resolved by spec amendment 2026-08-22** | presentation delivered instead by the SPA: `GET /dashboard/api/v1/snapshot` + per-request detail (`src/dashboard-routes.ts:245-250`), `llm-relay dashboard` (`src/cli.ts:213,876-925`); `llm-relay candidates` renders typed quota (`src/cli.ts:1932,1992-1993`) | No plain `GET /usage`/`/quota` and no `usage`/`quota` CLI verb; the spec's two-command surface does not exist |
| 8 | Learned rate-limit facts (4 FactKinds + parser) | **implemented (display-only)** | `FactKind` now ten kinds — the four `rate-limit-rpm|rpd|tpm|tpd` measurements beside the five conditions + `context-limit` (`src/target-facts.ts:19-30`, 30-day TTL `:70`); deterministic parser with axis+period confidence gates (`parseStatedRateLimit`, `src/rate-limits.ts:171`) wired on both fronts — 429 bodies beside `observeContextLimit` (`server.ts:2711-2712`) and the durable limit half of provider-stated quota headers (`observeStatedRateLimits`, `server.ts:2445,2758`); scope follows evidence, credential scope only on explicit account wording; rendered per member in `/candidates` (`candidates.ts:356`) | Display-only per M2 — gating requires the Gap 12 opt-in (`routing.quota.enforceLearned`) |
| 9 | `quota` sub-object on `Candidate` | **implemented**, un-blended | `src/candidates.ts:70` (field), merge of probe+breaker observations `:276-284,474-476`; sibling to `breaker`/cooldowns (`:76,483`); no score/rank introduced | — |
| 10 | Estimated output tokens | **partial — matches M4 deferral** | storage/plumbing exists (`estimatedOutput` cells: `src/accounting-store.ts:174,437-441`; contract `src/dashboard-contract.ts:208`); **no producer**: `accountingTokens()` supplies only estimated *input* (`src/server.ts:507-522`) | Producer deliberately withheld per M4 evidence gate |
| 11 | Spend + compound `spendBasis` | **implemented (Stage 4)** | typed `AccountingSpend` priced at attempt completion from PUBLISHED per-(provider, model) prices injected through an `AccountingPricePort` (`src/accounting.ts:109,584`; server builds it from `catalog.cachedLimits` + `resolveMetadata`, no fetch); integer micro-USD, per-kind half-up summed as integers; four provenance cells provider_published/reference × reported/estimated with `coverage` and unpriced cache kinds counted beside the amount — a null price is UNPRICED, never $0; request spend projects only the winning serve attempt; `partiallyPricedRequests` > 0 marks every amount a lower bound (`dashboard-contract.ts:293`) | The C1 roll-up shipped the same day: `readCostReport` on the shared read port + `llm-relay cost --include-repair` (`dashboard-snapshot.ts:1551`, `cli.ts:1029`) |
| 12 | Quota as a demotion term in `orderByUsability()` | **implemented (Stage 5 / Gap 12)** | pure resolver `createQuotaDemotionFn` joins both fronts through `orderDeploymentGroupsByUsability`/`targetUsability()` (`src/quota-demotion.ts:203`; `server.ts:1852,1775-1800`); gateable bases = provider-stated / derived:provider-stated / derived:configured by default, `derived:learned` only under `routing.quota.enforceLearned`, `derived:published` NEVER; unknown ⇒ null, no effect; no resolvable expiry ⇒ NO demotion at all (the relay never invents a cooldown); demotes via breaker cooldown source `"quota"` (`circuit-breaker.ts:79,489-498`), reorders only; displaced first choice announced in `x-llm-relay-quota-demoted` (`backend.ts:131`, `server.ts:3404,3527`) | A *credential-level* analogue also exists from Stage 1: selection ranks by fresh provider-stated headroom band with a 10% floor (`src/credential-select.ts:99-118,146,155`) — see M1 below |
| 13 | Catalog rate-limit harvesting | **implemented** | per-(provider, model) rpm/rpd/tpm/tpd harvested through closed alias lists (`rateLimitsFromRecord`, `src/catalog.ts:186-207`), sanitized on cache round-trip (`:263`), read cache-only via `publishedRateLimits(name, model)` beside `cachedLimits()` (`:471-472`) — deliberately no `reference` rung, another provider's allowance is meaningless here; feeds the availability ladder as basis `published`, which never gates | Expected near-empty payoff held: most providers publish none; `/registry` surface skipped (no per-model limits block to extend without inventing wire surface) |
| 14 | Wire or delete `completionTokens` | **implemented (wired)** | argument now supplied from the accumulator (`src/server.ts:2050-2060`); alias maintained by the observer (`usage-observer.ts:98-103`) | — |
| 15 | Single-file HTML page | **deferred-by-decision** | owner chose the SPA (open-decisions `G3`, :27; spec §6.3 resolution :379-383) | — |
| 16 | In-flight leases | **deferred-by-decision** | spec §5.4 argues against (:302); Stage 1 separately landed *concurrency* attempt leases beginning at real egress (HANDOFF.md:53) — not quota leases | Revisit only on measured overshoot |
| 17 | Full SPA dashboard | **implemented** | `src/dashboard-contract.ts` / `dashboard-routes.ts` / `dashboard-snapshot.ts` + React SPA, P0–P4 green (HANDOFF.md:12-24) | — |

## 2. STAGE 0–6 status

| Stage | Status | Gaps covered | Evidence |
|---|---|---|---|
| 0 Make the existing measurement legible | **implemented** (surface differs) | 1, 9, 14 | typed observations flow probes→cadence→breaker→candidates (`cadence.ts:179-181`; `circuit-breaker.ts:427-429`; `candidates.ts:474-476`); rendered with `-` for unmeasured (`cli.ts:1992-1993`). The spec's `GET /telemetry` quota block was *removed* instead (grep: 0 quota refs left in `src/telemetry.ts`) — candidates is now the typed surface |
| 1 The metering primitive | **implemented** (via accounting store, not LOG_FIELDS) | 2, 14; 3 superseded | observer on both fronts (see §3); both-front lifecycle pinned by `it.each(["anthropic","openai"])` (`test/accounting-lifecycle.test.ts:243-247,323-342`) plus streamed-OpenAI-usage case (`:492-516`). the spec's ≥2-candidate gate IS pinned: `test/accounting-lifecycle.test.ts:323-342` walks a 429 candidate then a winner on each front (orchestrator-verified 2026-08-22) |
| 2 Windows and rollups | **implemented** in the store; **CLI/endpoint surface absent** | 6; 7 partial; 10 pending M4 | windows via day shards + lifetime months (`accounting-store.ts:751-794,1055-1082`); by-client dimension on rows (`:948,1033`); latency/commit distributions (`:176-185,481-500`) |
| 3 Availability | **implemented** | 5, 8; 7 remainder; 9 done | discovery rungs landed (rows 5/8/13); the §5.1-5.2 ladders are PURE functions with `now` as an argument — `resolveRemaining` (provider-stated → limit−localUsed → null, staleness a read-time eligibility test, negative preserved), `resolveResetsAt` (provider-stated → reviewed-rule → derived UTC boundary → null), UTC `periodStart`/`periodEnd` (`src/availability.ts:203,272,92-107`); the ledger read is `usedInWindow`, in-memory only, month DECLINES both figures until the lifetime rollup is per-credential (`accounting-store.ts:495,1092`); the dashboard's Quota/Cooldown panels are produced by `createAvailabilityProducer` walking breaker cells + configured/learned limits + target-fact conditions + the local ledger, never throwing and never contacting a provider (`availability-snapshot.ts:72,213,309`; wired `server.ts:322`) |
| 4 Cost | **implemented** | 11 | see row 11 above; the C1 roll-up (`readCostReport` + `llm-relay cost`) folds root minute-cell aggregates exactly while per-value rows walk dimension rows capped; repair spend folded from role:"repair" attempt rows directly, never by subtraction; absence is `empty` ("No accounting data yet"), only a thrown/corrupt read is `unavailable` (`dashboard-snapshot.ts:1551`; CLI `cli.ts:1005-1043`) |
| 5 Enforcement | **implemented** | 12 | see row 12: the demotion term reached `orderByUsability` on both fronts through shared walk-order helpers (`orderDeploymentGroupsByUsability`, `server.ts:1852`), joining the pre-existing credential-level headroom banding (`credential-select.ts:104-117`) |
| 6 The page | **implemented as the SPA** (owner's tier c) | 17 | HANDOFF.md:12-24 |

Catalog harvesting (13) landed with the sprint (commit `82cf8e9`); the low-yield expectation held — most providers publish no rate limits.

## 3. Both-fronts check

Every counter is created once per request above the front split, so both fronts are covered **structurally**, not by duplicated code:

| Counter/observer | Anthropic `/v1/messages` | `openAiFrontPath` |
|---|---|---|
| Request lifecycle (`RequestAccountingState`) | `server.ts:856-864`, path-gated by `isCallerVisibleAccountingPath` which lists `/v1/messages` **and** the chat/responses routes (`:468-475`) | same construction site |
| Pre-parse early terminal accounting | `:833-834` (shared) | same |
| Usage accumulator + `startServe` at real egress | `:1140` + `:1145-1147` | `:2699` + `:2704-2706` |
| Provider-reported usage tap | `fetchBackend` → `observeUsage(... "anthropic-messages")` (`backend.ts:479-480`) | `fetchOpenAiFront` → `observeUsage("openai-chat")` direct `:571`, translated `:1121` |
| Response-header quota observation (`observeAttemptHeaders`) | `server.ts:1252` | `server.ts:2933` |
| Terminal accounting (success/error/cancelled) | shared helpers `completeAttemptSuccess/Failure/Cancelled` → `attempt.accounting?.complete(...)` (`:2512,:2568-2574,:2592`) | same helpers |
| Commit marker (`markAttemptCommitted` → `commitMs`) | `:2492-2494`, write sites `:3142,:3263,:3276,:3432,:3559` | write sites `:3668,:3681,:3698` (each line's owning front not individually traced, but both fronts share the helper) |
| Repair-turn accounting (`role: "repair"`) | `withRepairAccounting` wired `:1398` | `:2769`; hooks defined `:677-704` |
| Runtime-telemetry `completionTokens` | shared `recordCall` from the same terminal helpers (`:2511,:2567`) | same |

No counter was found wired to one front only. Stage-1 gate: `test/accounting-lifecycle.test.ts:323-342` ("records failed and committed winning serve attempts for the %s front") walks two candidates (a scripted 429, then the winner) on BOTH fronts — verified 2026-08-22, so the earlier single-backend caveat was wrong.

## 4. Provenance check

Conforms. The three exceptions the original reconciliation named are closed or re-scoped:

- **Reported vs estimated are separate typed accumulators with per-cell source labels** — `source: "provider_reported" | "relay_estimated"` (`accounting.ts:371-393`), never summed into one field (`accounting-store.ts:444-475` refuses once uncertainty mixes, nulling `value` and counting `unknown`).
- **Unknown stays null, never 0** — absent usage ⇒ `value: null` + `unknown` counter (`accounting-store.ts:402-419`); `safeCounter` rejects non-integers to null (`:345`); estimates carry a `method`, defaulting to `"unspecified"` rather than an invented one (`accounting.ts:16,384,390`).
- **Headroom is a render-time derivation, never stored** (`quota-observation.ts:296-300`), and every observation carries `basis: "provider-stated"` (`:13`). Coverage/loss ledgers mark lower bounds instead of pretending exactness (`accounting-store.ts:1546-1573`).
- ✔ *Closed 2026-08-22:* ~~`llm-relay keys` prints a bare percent~~ — `formatKeyQuota()` now renders "% of credit limit left (relay-derived from provider-stated limit/usage)" (`src/cli.ts:722`): no typed observation exists at that surface, so the basis is stated rather than invented.
- ✔ *Closed 2026-08-22 (the sprint's Gap 11 work):* ~~`unpricedRequests` counts every request~~ — rebased to requests whose tokens had no published price; `partiallyPricedRequests` splits off requests where SOME kinds priced (`accounting-store.ts:241-259,701-704`), and both travel through the wire contract so every spend amount can be marked a lower bound.
- ✔ *Closed 2026-08-22 (C3 adopted, commit `7abdaf2`):* ~~the client-facing `AssistantMessage.usage` type narrows away cache fields~~ — widened (`anthropic.ts:75-83`); see row 4 for the streaming residual.

## 5. Decision rows touched by the implementation

| Row | Recommendation | Implementation | Match |
|---|---|---|---|
| M1 | Headroom demotion on by default, 10% floor, provider-stated | credential selection ranks by fresh `provider-stated` headroom; ≤0 spent, ≤10% tight, unknown neutral (`credential-select.ts:104-117,143-159`) | **matches** (realized at the credential seam, not `orderByUsability`) |
| M2 | Learned limits display-only | learned rate-limit facts exist now (row 8) and are display-only; they gate only under the explicit `routing.quota.enforceLearned` opt-in (`quota-demotion.ts:80,122`) | **matches** (no longer vacuous) |
| M3 | Cooldown-clear only behind control token + admission checks | no such mutating endpoint found (grep: only read-side dashboard panels, `dashboard-snapshot.ts:1268`) | **consistent (not built)** |
| M4 | Estimated output: decide after measuring absence | producer withheld; `estimatedOutput` plumbing reserved (`accounting-store.ts:437-441`) | **matches the approved deferral** |
| M5 | 30-day retention | production constructs `createAccountingStore({ retentionDays: 30 })` (`cli.ts:610`), commented as the M5 disposition; the store itself keeps retention off for library callers (`accounting-store.ts:648-649`) | **matches** (closed earlier on 2026-08-22) |
| M6 | No freellmapi-style savings tile | no savings figure; `spend: null` (`accounting.ts:109,129`) | **matches** |
| C1 | Separate `role:"repair"` rows + `cost --include-repair` roll-up | **delivered 2026-08-22 (commit `9fd9f36`)** — repair rows were already recorded as a distinct role (`accounting.ts:732`); `llm-relay cost --include-repair` folds role:\"repair\" attempt rows directly into the report and prints their share as its own labelled table (`dashboard-snapshot.ts:1551`, `cli.ts:1029`) | **matches** (the lifetime window declines the split — its month rollups mix serve and repair in one figure) |
| C2 | Passthrough recorded, marked caller-operated, excluded from per-key totals | `attribution: "caller_operated"` derived from declared credential state/mode (`server.ts:495-505`), carried on every event/row (`accounting.ts:261-265,618`); dashboard policy string `include_all_labeled` (`cli.ts:612`) | **matches** (per-key exclusion semantics not independently verified beyond the attribution field) |
| C3 | Widen `AssistantMessage.usage` | **adopted 2026-08-22 (commit `7abdaf2`)** — the two cache fields ride the client-facing type (`anthropic.ts:75-83`), re-emission, and both cross-protocol buffered translation seams; streaming cross-protocol translation inside llm-bridge remains the residual (§7) | **matches** |
| C4 | UTC boundaries, local only for labels | canonical UTC timestamps enforced (`accounting.ts:239-247`); day/minute/month slicing is pure UTC-string math (`accounting-store.ts:330-333`) | **matches** |
| P1 | Custody Windows/macOS | explicitly out of scope this branch (HANDOFF.md:70-71) | **deferred as instructed** |
| P2 | Rotation-triggered clearing ratified | adjacent machinery verified: a served request clears facts incl. `credential-invalid` and the breaker's per-credential faults (`server.ts:2519-2529`); the rotation-specific widening was not located | **indirect / unverified** |
| P3 | Opaque `credentialId` keying from day one | end-to-end: events, packets, rows, log sink, candidate identity (`accounting.ts:79,90,106`; `accounting-store.ts:205,970`; HANDOFF.md:55-58) | **matches** |
| P4 | `client_profiles` part 2 needs a purpose first | correctly absent | **matches (purpose-gated)** |

## 6. Remaining items — CLOSED 2026-08-22 (evening)

The open rows below were all closed by the nine-commit metering sprint (`7abdaf2` .. `9fd9f36`);
what remains is re-listed with its current disposition in **§7 Sprint 2026-08-22 (evening)**.

- ~~**OPEN — C3 / Gap 4.** Widen `AssistantMessage.usage`~~ — *closed:* adopted (row 4); the
  streaming cross-protocol residual moves to §7.
- ~~**OPEN — Stage 3/5 remainder (Gaps 5, 8, 12).**~~ — *closed:* configured limits (`ca9e75e`),
  learned rate-limit facts + parser (`3611647`, display-only), and the quota demotion term
  (`f29e18e`) landed.
- ~~**OPEN — Stage 4 (Gap 11 + C1 roll-up).**~~ — *closed:* typed spend from published prices
  (`a386058`) and `llm-relay cost --include-repair` (`9fd9f36`); `unpricedRequests` rebased.
- **CLOSE-NOW — M5 default retention.** Pass `retentionDays: 30` at the production construction site (`cli.ts:605`); the store already implements cursor-based pruning (`accounting-store.ts:1302-1413`). One line; otherwise the disk grows forever and an approved default is silently ignored.
  - *Closed 2026-08-22:* production constructs `createAccountingStore({ retentionDays: 30 })` (`src/cli.ts:610`); pinned by test.
- **CLOSE-NOW — bare percent in `llm-relay keys`.** Label axis+basis or drop it (`cli.ts:716`). Trivial.
  - *Closed 2026-08-22:* `formatKeyQuota()` renders "% of credit limit left (relay-derived from provider-stated limit/usage)" (`src/cli.ts:718-720`) — no typed observation exists at this surface, so the basis is stated rather than invented.
- **CLOSE (as a recorded decision, not code) — Gap 3 / LOG_FIELDS.** The accounting store superseded the JSONL-as-ledger plan. Write that down in CLAUDE.md's file table so nobody "completes" Gap 3 by duplicating token counters into the log.
  - *Closed 2026-08-22:* recorded in the CLAUDE.md `accounting-store.ts` row ("This superseded spec Gap 3's plan of widening `LOG_FIELDS`: do NOT duplicate token counters into the metadata log").
- **CLOSE (decision) — Gap 7 surface shape.** Either amend the spec to name the dashboard snapshot API + `llm-relay dashboard`/`candidates` as the delivery of §6, or add thin read-only `GET /usage`/`/quota` later. Today the spec text and the implementation disagree about where the numbers live.
  - *CLOSED 2026-08-22 — spec amended (§6 Resolution):* the owner chose amendment; the dashboard snapshot API (`GET /dashboard/api/v1/snapshot` + `requests/:id`), `llm-relay dashboard`, and typed quota rendering in `llm-relay candidates` are named as the delivery, and no new endpoints will be added.
- **DEFER — Gap 10 / M4.** Estimated-output producer stays withheld until measured usage-absence rates justify it (owner disposition, open-decisions.md:4-7). Still deferred after the sprint.
- **DEFER — Gaps 15/16, M3, P1, P4.** Superseded by the SPA choice, argued against in §5.4, mutation-with-no-consumer, custody-next-stage, purpose-gated respectively. Do not build without a new decision.

## 7. Sprint 2026-08-22 (evening) — what the sprint delivered, what remains

Delivered by commit (branch `main`, `7abdaf2` .. `9fd9f36`):

| Commit | Delivered |
|---|---|
| `7abdaf2` | **C3 / Gap 4** — `AssistantMessage.usage` widened; cache fields carried through re-emission and both buffered translation seams |
| `ca9e75e` | **Gap 5** — operator-declared rate limits (`limits`) on providers and credential slots, basis `configured` |
| `3611647` | **Gap 8** — learned rate-limit measurement facts on both fronts, display-only |
| `82cf8e9` | **Gap 13** — catalog harvesting of published rpm/rpd/tpm/tpd, cache-only accessor |
| `a386058` | **Gap 11 / Stage 4** — every attempt priced at completion into four provenance cells; `unpricedRequests` rebased, `partiallyPricedRequests` added |
| `a2cd375` + `dd19780` | **Stage 3** — availability ladders, in-memory usage window, dashboard availability producer (+ baseline regen) |
| `f29e18e` | **Stage 5 / Gap 12** — quota demotion joins both fronts' walk order, breaker source `"quota"`, learned opt-in |
| `9fd9f36` | **Stage 4 / C1** — the `llm-relay cost` roll-up with `--include-repair` |

Still OPEN after the sprint:

- **Gap 10 / M4 remains DEFERRED** — estimated-output producer withheld until measured
  usage-absence rates justify it (owner disposition, open-decisions.md:4-7). Unchanged by this
  sprint.
- **G2 manual per-credential hard cap — approved in principle, unbuilt.** The approved G2
  resolution permits an explicit operator cap that REFUSES loudly (its own status + header);
  everything built so far only demotes/reorders. Shape proposal from lane E: a `cap` block (or a
  `hard: true` marker inside the existing `limits` block) resolved like configured limits,
  refusing per attempt BEFORE egress when the ledger shows the cap reached — relay-originated 429
  naming cap/basis `operator-declared` with its own header, outside `orderByUsability` (which may
  only reorder), never widened across credentials. Open design calls for the owner: per-request
  refusal vs fail-closed-for-the-walk, and whether a cap may exceed provider-stated figures.
- **The reviewed-rule rung of `resolveResetsAt` is plumbed but fed null** (`availability.ts:286-288`;
  the producer passes `reviewedRule: null` at `availability-snapshot.ts:148`). The request path
  applies ResetRules but does not persist the resolved reset beside the observation; wiring needs
  either a small persisted field or a deliberate re-parse decision — owner call.
- **Streaming cross-protocol usage parity (llm-bridge).** An OpenAI-front client STREAMING from an
  anthropic-kind backend (or the reverse) still drops cache fields and zero-fills missing usage:
  the translated stream is passed through as the dependency emits it, and there is no seam after
  llm-bridge hands back translated SSE. Options recorded by lane A: upstream/vendor patch, or
  moving that translation seam in-repo. Buffered paths are correct today.
- **Gaps 15/16, M3, P1, P4** — unchanged deferrals (see §6).

## 8. Verification note

Every flipped row above was verified against THIS worktree's source during the closeout pass
(2026-08-22/23): exports, call sites and constants were read directly; commit hashes come from
`git log`. Line numbers cite the state after the sprint and may drift as files evolve.
