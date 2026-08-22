# Metering reconciliation — accounting foundation vs. quota-metering-spec (2026-08-22)

Reconciles the implemented accounting foundation + Analytics SPA (`b4ec7ee`, branch
`codex/stage-1-credential-pooling`) against [quota-metering-spec-2026-08-16.md](quota-metering-spec-2026-08-16.md)
(§1 metrics, §2 collection, §3 storage, §5 availability, §6 presentation, §8 gaps, §9 stages) and
[open-decisions-2026-08-16.md](open-decisions-2026-08-16.md) (all recommendations approved 2026-08-21).
Read-only analysis; every claim cites a line read for this document.

Headline: the implementation did **not** build the spec's pipeline shape. It built a strictly
stronger *event-sourced accounting store* (`accounting.ts` lifecycle → `accounting-store.ts`
day-sharded snapshots) plus the SPA, which supersedes Gaps 2/3/6/7/17 by a different mechanism, and
leaves the **availability half of the spec (§4 limit discovery, §5 ladders, §6.1 `usage`/`quota`
surfaces, Stage 4 spend) genuinely unbuilt**. Two spec items are silently unfilled rather than
deferred: default retention (M5) and the widened `AssistantMessage.usage` type (C3).

## 1. GAP 1–17 status

| # | Gap | Status | Evidence | Missing if partial |
|---|---|---|---|---|
| 1 | Typed quota observation | **implemented** | `src/quota-observation.ts:6-14` (`{axis,period,limit,remaining,resetsAt,observedAt,basis}`), extractor `:194-283`; `extractQuotaPercent` kept as deprecated wrapper that declines ambiguous headers (`src/ping/ping.ts:21-28`); probe cache now keyed `(credentialId, modelId)` — the scope drift fixed (`src/ping/cadence.ts:103,179-181,247-256`); breaker stores typed observations (`src/circuit-breaker.ts:35,427-429`) | — |
| 2 | Reported-token capture, both fronts | **implemented** (different mechanism than the tail-tap the sketch proposed) | `observeUsage()` wraps the body in a byte-exact `TransformStream` with a bounded SSE/JSON parser (`src/usage-observer.ts:357-404`, frame cap `:38`); tapped for anthropic-kind backends `src/backend.ts:479-480`, direct Chat `:571`, translated `:1121`, and reshaper calls `src/reshaper.ts:412-416`; OpenAI streams now request usage (`backend.ts:546-549`) | — |
| 3 | Widen `LOG_FIELDS` | **not-started — superseded by decision-shaped drift** | `src/log.ts:79-96` unchanged (no token fields); token totals live in the accounting store instead | The JSONL is not the per-request ledger; the accounting store is. Record the substitution explicitly or add the fields |
| 4 | Widen `AssistantMessage.usage` for cache tokens | **not-started** | `src/anthropic.ts:66-69` still `{input_tokens?, output_tokens?}` — cache fields still narrowed client-side | Cache facts ARE metered internally (`usage-observer.ts:20-21,105-115`), so this is now purely the C3 wire-shape defect |
| 5 | Configured limits on `ProviderConfig` | **not-started** | no `limits`/`rpm`/`rpd` block anywhere in `src/config.ts` (grep, 0 hits) | Blocks the `derived:configured` rung of §5.1 |
| 6 | Day-sharded usage store + rollups | **implemented** | day shards `YYYY-MM-DD.json` (`src/accounting-store.ts:107`, writer `:336-340`), minute cells inside a day (`:558-567`), `lifetime.json` months (`:264-272,1068-1080`), `recent.json` details, bounded samples for percentiles (`ACCOUNTING_MAX_SAMPLES` `:495-498`), write-behind flush (`:1591-1600`), VITEST temp-dir redirect (`:337`), shutdown close (`src/cli.ts:574-614`) | Finer than spec (minute vs hourly buckets); dedup + coverage/loss ledger goes beyond it |
| 7 | `llm-relay usage`/`quota` + `GET /usage`,`/quota` | **partial -> resolved by spec amendment 2026-08-22** | presentation delivered instead by the SPA: `GET /dashboard/api/v1/snapshot` + per-request detail (`src/dashboard-routes.ts:245-250`), `llm-relay dashboard` (`src/cli.ts:213,876-925`); `llm-relay candidates` renders typed quota (`src/cli.ts:1932,1992-1993`) | No plain `GET /usage`/`/quota` and no `usage`/`quota` CLI verb; the spec's two-command surface does not exist |
| 8 | Learned rate-limit facts (4 FactKinds + parser) | **not-started** | `src/target-facts.ts:8-13` has only the pre-existing behavioural `rate-limited` kind (2-min, `:50`); no `rate-limit-rpm/rpd/tpm/tpd`, no `parseStatedRateLimit` | Whole §4 rung 1 absent |
| 9 | `quota` sub-object on `Candidate` | **implemented**, un-blended | `src/candidates.ts:70` (field), merge of probe+breaker observations `:276-284,474-476`; sibling to `breaker`/cooldowns (`:76,483`); no score/rank introduced | — |
| 10 | Estimated output tokens | **partial — matches M4 deferral** | storage/plumbing exists (`estimatedOutput` cells: `src/accounting-store.ts:174,437-441`; contract `src/dashboard-contract.ts:208`); **no producer**: `accountingTokens()` supplies only estimated *input* (`src/server.ts:507-522`) | Producer deliberately withheld per M4 evidence gate |
| 11 | Spend + compound `spendBasis` | **not-started** | `spend` is hard-typed `null` on every event/packet (`src/accounting.ts:108-110,127-129`; store `:196`); `unpricedRequests` incremented per request (`accounting-store.ts:513`) | Stage 4 wholly open |
| 12 | Quota as a demotion term in `orderByUsability()` | **not-started at deployment level** | `orderByUsability` bands live/faulted/cooling only, no quota term (`src/server.ts:1848-1873`) | A *credential-level* analogue exists: selection ranks by fresh provider-stated headroom band with a 10% floor (`src/credential-select.ts:99-118,146,155`) — see M1 below |
| 13 | Catalog rate-limit harvesting | **not-started** | no rate-limit aliases in `src/catalog.ts` (grep, 0 hits) | Cheap; expected low-yield per spec |
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
| 3 Availability | **not-started** (display-only pieces shipped) | 5, 8; 7 remainder; 9 done | no discovery rungs (rows 5/8); remaining/resetsAt ladders of §5.1-5.2 do not exist; quota display = raw provider-stated observations only |
| 4 Cost | **not-started** | 11 | `spend: null` everywhere (`accounting.ts:109,129`) |
| 5 Enforcement | **partially, at a different seam** | 12 | credential ordering consumes fresh provider-stated headroom, unknown ⇒ neutral band 1 (`credential-select.ts:104-117`); `orderByUsability` itself untouched (`server.ts:1848-1873`) |
| 6 The page | **implemented as the SPA** (owner's tier c) | 17 | HANDOFF.md:12-24 |

Catalog harvesting (13) was never slotted — still open, still low-yield.

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

Conforms, with three named exceptions:

- **Reported vs estimated are separate typed accumulators with per-cell source labels** — `source: "provider_reported" | "relay_estimated"` (`accounting.ts:371-393`), never summed into one field (`accounting-store.ts:444-475` refuses once uncertainty mixes, nulling `value` and counting `unknown`).
- **Unknown stays null, never 0** — absent usage ⇒ `value: null` + `unknown` counter (`accounting-store.ts:402-419`); `safeCounter` rejects non-integers to null (`:345`); estimates carry a `method`, defaulting to `"unspecified"` rather than an invented one (`accounting.ts:16,384,390`).
- **Headroom is a render-time derivation, never stored** (`quota-observation.ts:296-300`), and every observation carries `basis: "provider-stated"` (`:13`). Coverage/loss ledgers mark lower bounds instead of pretending exactness (`accounting-store.ts:1546-1573`).
- ✖ **Violation (minor): `llm-relay keys` prints a bare percent** — `` ` | Quota: ${r.quotaPercent}%` `` with no axis or basis (`src/cli.ts:716`). Spec §6.1 requires the basis beside every number.
- ⚠ **Latent: `unpricedRequests` counts every request** (`accounting-store.ts:513`) while `spend` is unimplemented — accurate today, but it will silently become wrong the moment pricing lands without being rebased to "requests whose tokens had no published price".
- ✖ **C3 stands:** the client-facing `AssistantMessage.usage` type still narrows away cache fields (`anthropic.ts:66-69`), even though the relay meters them internally.

## 5. Decision rows touched by the implementation

| Row | Recommendation | Implementation | Match |
|---|---|---|---|
| M1 | Headroom demotion on by default, 10% floor, provider-stated | credential selection ranks by fresh `provider-stated` headroom; ≤0 spent, ≤10% tight, unknown neutral (`credential-select.ts:104-117,143-159`) | **matches** (realized at the credential seam, not `orderByUsability`) |
| M2 | Learned limits display-only | no learned limits exist to gate — vacuously satisfied | **matches (vacuous)** |
| M3 | Cooldown-clear only behind control token + admission checks | no such mutating endpoint found (grep: only read-side dashboard panels, `dashboard-snapshot.ts:1268`) | **consistent (not built)** |
| M4 | Estimated output: decide after measuring absence | producer withheld; `estimatedOutput` plumbing reserved (`accounting-store.ts:437-441`) | **matches the approved deferral** |
| M5 | 30-day retention | `retentionDays` supported but **defaults to null** (`accounting-store.ts:648-649`); production constructs with no options (`cli.ts:605`) | **NOT matched — nothing prunes** |
| M6 | No freellmapi-style savings tile | no savings figure; `spend: null` (`accounting.ts:109,129`) | **matches** |
| C1 | Separate `role:"repair"` rows + `cost --include-repair` roll-up | repair rows recorded as a distinct role (`accounting.ts:461-462`; store rowKey includes role, `accounting-store.ts:529-531`); no cost command exists | **half** — rows yes, roll-up waits on Stage 4 |
| C2 | Passthrough recorded, marked caller-operated, excluded from per-key totals | `attribution: "caller_operated"` derived from declared credential state/mode (`server.ts:495-505`), carried on every event/row (`accounting.ts:261-265,618`); dashboard policy string `include_all_labeled` (`cli.ts:612`) | **matches** (per-key exclusion semantics not independently verified beyond the attribution field) |
| C3 | Widen `AssistantMessage.usage` | not widened (`anthropic.ts:66-69`); internal metering covers cache facts another way | **not adopted — the wire-shape defect remains** |
| C4 | UTC boundaries, local only for labels | canonical UTC timestamps enforced (`accounting.ts:239-247`); day/minute/month slicing is pure UTC-string math (`accounting-store.ts:330-333`) | **matches** |
| P1 | Custody Windows/macOS | explicitly out of scope this branch (HANDOFF.md:70-71) | **deferred as instructed** |
| P2 | Rotation-triggered clearing ratified | adjacent machinery verified: a served request clears facts incl. `credential-invalid` and the breaker's per-credential faults (`server.ts:2519-2529`); the rotation-specific widening was not located | **indirect / unverified** |
| P3 | Opaque `credentialId` keying from day one | end-to-end: events, packets, rows, log sink, candidate identity (`accounting.ts:79,90,106`; `accounting-store.ts:205,970`; HANDOFF.md:55-58) | **matches** |
| P4 | `client_profiles` part 2 needs a purpose first | correctly absent | **matches (purpose-gated)** |

## 6. Remaining items

- **CLOSE-NOW — M5 default retention.** Pass `retentionDays: 30` at the production construction site (`cli.ts:605`); the store already implements cursor-based pruning (`accounting-store.ts:1302-1413`). One line; otherwise the disk grows forever and an approved default is silently ignored.
  - *Closed 2026-08-22:* production constructs `createAccountingStore({ retentionDays: 30 })` (`src/cli.ts:610`); pinned by test.
- **CLOSE-NOW — bare percent in `llm-relay keys`.** Label axis+basis or drop it (`cli.ts:716`). Trivial.
  - *Closed 2026-08-22:* `formatKeyQuota()` renders "% of credit limit left (relay-derived from provider-stated limit/usage)" (`src/cli.ts:718-720`) — no typed observation exists at this surface, so the basis is stated rather than invented.
- **CLOSE (as a recorded decision, not code) — Gap 3 / LOG_FIELDS.** The accounting store superseded the JSONL-as-ledger plan. Write that down in CLAUDE.md's file table so nobody "completes" Gap 3 by duplicating token counters into the log.
  - *Closed 2026-08-22:* recorded in the CLAUDE.md `accounting-store.ts` row ("This superseded spec Gap 3's plan of widening `LOG_FIELDS`: do NOT duplicate token counters into the metadata log").
- **CLOSE (decision) — Gap 7 surface shape.** Either amend the spec to name the dashboard snapshot API + `llm-relay dashboard`/`candidates` as the delivery of §6, or add thin read-only `GET /usage`/`/quota` later. Today the spec text and the implementation disagree about where the numbers live.
  - *CLOSED 2026-08-22 — spec amended (§6 Resolution):* the owner chose amendment; the dashboard snapshot API (`GET /dashboard/api/v1/snapshot` + `requests/:id`), `llm-relay dashboard`, and typed quota rendering in `llm-relay candidates` are named as the delivery, and no new endpoints will be added.
- **OPEN — C3 / Gap 4.** Widen `AssistantMessage.usage` (`anthropic.ts:66-69`) so clients stop receiving narrowed usage. Changes the emitted wire shape; needs its own reviewed change, not a drive-by.
- **OPEN — Stage 3/5 remainder (Gaps 5, 8, 12).** Configured limits, learned rate-limit facts + parser, and a quota term in `orderByUsability`. Largest genuine piece of the spec still missing; the availability ladders of §5 do not exist in any form.
- **OPEN — Stage 4 (Gap 11 + C1 roll-up).** Spend × `resolveMetadata()` prices with compound `spendBasis`; then the `cost --include-repair` flag. Rebase `unpricedRequests` in the same change.
- **DEFER — Gap 10 / M4.** Estimated-output producer stays withheld until measured usage-absence rates justify it (owner disposition, open-decisions.md:4-7).
- **DEFER — Gap 13 catalog harvesting.** Cheap, expected near-empty payoff; slot after Stage 3 per spec §9.
- **DEFER — Gaps 15/16, M3, P1, P4.** Superseded by the SPA choice, argued against in §5.4, mutation-with-no-consumer, custody-next-stage, purpose-gated respectively. Do not build without a new decision.
