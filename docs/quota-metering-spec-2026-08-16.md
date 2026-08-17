# Quota availability + usage tracking — specification (2026-08-16)

Commissioned by the owner on 2026-08-16: *"I also want to take freellmapi's dashboard's tracking of quota
availability and usage, and everything that goes into it."*

Produced by tracing freellmapi's stack across all five layers (view → api → service → storage →
collection): **123 elements traced, 47 with no llm-relay equivalent.** 20 metrics specified.

This supersedes the dashboard's prior rejection, which rested on the now-retired *"no client of this
relay needs it"* reasoning. Rubric context: [rejection-ledger-2026-08-16.md](rejection-ledger-2026-08-16.md).

---

## 0. Scope and what is already true

The directive asks for freellmapi's quota-availability and usage *tracking* — the pipeline, not the page. This spec covers metric definitions, capture sites, storage, limit discovery, availability computation, presentation, and what it unblocks.

Three findings reframe the work before any of it starts.

**(a) The signal is already flowing and already typed wrong.** `extractQuotaPercent()` (`src/ping/ping.ts:26`) is called on every real request, from both fronts, via `observeAttemptHeaders()` (`src/server.ts:1537`, called at `src/server.ts:714` for `/v1/messages` and `src/server.ts:1836` for `openAiFrontPath`). Its result reaches `CircuitState.quotaPercent` (`src/circuit-breaker.ts:412`). Exactly one consumer reads it: `getTelemetryReport()` at `src/telemetry.ts:119-132`, rendered by `llm-relay telemetry` at `src/cli.ts:662`. It is not "read for nothing" — but nothing *routes* on it, and the operator-facing table that picks offload targets reads a different source (`src/candidates.ts:360` calls `pingLoop.getProviderQuota()`, `src/ping/cadence.ts:218`, fed only by synthetic probes at `src/ping/cadence.ts:162-163`). The live request-path signal never reaches the surface an operator actually uses.

The deeper defect: the variant list at `src/ping/ping.ts:27-35` treats `x-ratelimit-remaining` / `-remaining-requests` / `-remaining-requests-day` / `-remaining-tokens` / `-remaining-tokens-minute` / `ratelimit-remaining` / `ratelimit-remaining-requests` as interchangeable, returns the first that matches, and discards which one it was along with both the limit and the remaining. Two consecutive requests to the same deployment can produce a requests-per-day headroom and a tokens-per-minute headroom rendered in the same cell under the same name. And `latestQuota` (`src/ping/cadence.ts:95`) is a `Map<providerKey, number>` written from a per-model probe result — the same scope drift `src/target-facts.ts:8-28` exists to prevent, reproduced in a store that predates it.

**(b) There is no third learned-store pattern to invent.** `src/context-limits.ts` no longer stores anything — its header at :20-28 states the storage moved into `src/target-facts.ts` as a `context-limit` fact with a numeric `value` (`src/context-limits.ts:89`, `src/target-facts.ts:99`). What remains in `context-limits.ts` is the *parser*. That split — parser here, scoped storage there — is the pattern to follow exactly. And `src/target-facts.ts:141-147` already distinguishes CONDITIONS (a success disproves them) from MEASUREMENTS (a success says nothing), which is the distinction a learned rate limit needs.

**(c) Token counts are captured nowhere, and the two fronts are asymmetric.** `AssistantMessage.usage` is declared at `src/anthropic.ts:69` and `reconstructFromSse()` folds it from `message_start` and `message_delta` (`src/sse.ts:70`, `:116-117`) — but that reconstruction runs only when `ctx.willValidate` is true and the accumulation stays under `MAX_VALIDATE_BYTES` (`src/server.ts:200` = 8 MiB), i.e. only for tool-carrying `/v1/messages` turns. The OpenAI front's success branch (`src/server.ts:1975-1981`) pipes chunks straight to the socket and accumulates nothing. `recordModelCall()` accepts a `completionTokens` argument (`src/ping/runtime-telemetry.ts:86`, summed at `:110`) that `recordCall()` at `src/server.ts:1262` never supplies — so `ModelTelemetry.totalCompletionTokens` is a permanently-zero field.

---

## 1. THE METRIC SET

Every metric below carries a **provenance class**. The recalibrated rule is in force: an estimate is permitted, but must travel labelled, and must never occupy the same field as a provider-reported number. The enforcement mechanism is structural, not conventional — **reported and estimated token counts are separate fields with separate accumulators**, exactly as `resolveMetadata()` (`src/metadata.ts:41`) keeps `contextLength` and `contextLengthSource` together and refuses a third guessed rung.

### 1.1 Consumption

| Metric | Definition | Window | Source | Provenance |
|---|---|---|---|---|
| `requests` | Turns for which the relay wrote a terminal response to the client. One per client request, regardless of how many candidates were walked. | rolling 1m/1h/24h; calendar day + month; lifetime | terminal branch of each candidate loop | measured |
| `attempts` | Candidate hops. Always ≥ `requests`. A 13-member walk that served on the 13th is 13 attempts, 1 request. | same | `attemptTrace.snapshot()`, already recorded per-hop as `{provider,model,status,ms}` (`src/log.ts:10-15`) | measured |
| `served` / `errored` / `cancelled` | Terminal disposition. `cancelled` (client hung up) counts in `requests` but in **neither** term of the success rate. | same | `RequestAttemptStatus` already carries `"cancelled"` and `"committed"` (`src/log.ts:7`) | measured |
| `successRate` | `served / (served + errored)`. Renders `-` when the denominator is 0, never `0%`. | same | derived | measured |
| `inputTokens.reported` | Prompt tokens **the provider stated**. Anthropic `usage.input_tokens`; OpenAI `usage.prompt_tokens`. | same | response body / SSE tail | provider-stated |
| `inputTokens.estimated` | `estimateRequestTokens(reqJson)` — chars/4 over `system`+`messages`+`tools`+`instructions`+`input`, base64 excluded (`src/metadata.ts:151-171`). | same | request body only | **estimated** |
| `outputTokens.reported` | Completion tokens the provider stated. | same | response body / SSE tail | provider-stated |
| `outputTokens.estimated` | chars/4 over text + reasoning + tool-call arguments the relay actually wrote to the client. **No such counter exists today** — see Gaps. | same | bytes the relay streamed | **estimated** |
| `cachedInputTokens` | Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`; OpenAI `prompt_tokens_details.cached_tokens`. Distinct because a cached prompt token is metered differently and is the single largest distortion in any spend figure. | same | response body | provider-stated |
| `tokenBasis` | Per-record enum: `reported` \| `estimated` \| `mixed`. `mixed` means input came from one class and output from the other — which happens whenever a provider omits `usage` on a streamed turn. | per record | derived at capture | (label) |
| `latencyMs` | Terminal completion minus attempt start. Already computed as `HealthOutcome.elapsedMs` (`src/circuit-breaker.ts:72`) and as `RequestLog.latencyMs` (`src/request-log.ts:37`). | same | clock | measured |
| `commitMs` | Time from attempt start to the point `probeStreamForCommit()` returns `ready` (`src/stream-commit.ts:281`) — the first byte the client-facing protocol carries as *meaningful* content. | same | stream commit probe | measured |

⚠ **`commitMs` is not TTFT and must not be labelled TTFT.** freellmapi's `avgTtfbMs` is time to first byte. `probeStreamForCommit` deliberately holds through metadata preambles, empty deltas and usage-only frames (`src/stream-commit.ts:121`), so `commitMs` is time-to-first-*meaningful*-token. It is the better number and a different number. Name it what it is.

### 1.2 Cost

| Metric | Definition | Window | Source | Provenance |
|---|---|---|---|---|
| `spend` | `inputTokens × pricePerMTokIn/1e6 + outputTokens × pricePerMTokOut/1e6`, per (provider, model). | window-scoped, never projected | `resolveMetadata()` prices (`src/metadata.ts:86-87`) × the token counters above | **compound — see below** |
| `spendBasis` | The weakest link: `measured` only when both the token count is `reported` *and* `priceSource === "provider"`; `estimated` when either is an estimate or the price is `reference`; `null` when no price is published. | per row | derived | (label) |
| `costClass` | `free` \| `paid` \| `unknown` per deployment. Already the single definition at `assessCost()` (`src/metadata.ts:112`). | current | existing | existing |

⚠ **Do not port freellmapi's `estimatedCostSavings`.** Its `FALLBACK_INPUT_PER_M` constants (analytics.ts:196) mix an unlabelled 0.20/0.80 guess into the same SQL SUM as real published prices, and its headline tile extrapolates a 30-day figure from a shorter span. Both are exactly what "a guess must never look like a measurement" rules out. `resolveMetadata()` already returns `null` rather than a fallback price (`src/metadata.ts:1-10` states why the hardcoded rung was deleted in 0.7.0); a row with no published price contributes **nothing** to `spend` and increments an `unpricedRequests` counter shown beside the total. A savings *counterfactual* is a separate, later question and should be asked explicitly rather than smuggled in as a default tile.

### 1.3 Availability

Availability is keyed by **(scope, axis, period)**, never by a bare provider name.

- `scope` — reuses `FactScope` (`src/target-facts.ts:83-87`): `deployment` \| `group` \| `provider` \| `model`. For quota, `provider` *is* the credential today (one `authEnv` per provider, `src/authEnv.ts`), which is why the current provider-keying happens to mostly work — but see Open Questions on pre-shaping for multi-key.
- `axis` — `requests` \| `tokens`. Closed enum. freellmapi adds `credits` and `neurons`; llm-relay should not, because it has no consumer for them and an unmapped axis is worse than an absent one.
- `period` — `minute` \| `day` \| `month` \| `unknown`.

| Metric | Definition | Window | Source | Provenance |
|---|---|---|---|---|
| `limit` | Maximum permitted units of `axis` per `period` at `scope`. | the period | discovery ladder, §4 | provider-stated \| configured \| **learned** |
| `remaining` | Units still available. | point-in-time, with `observedAt` | availability ladder, §5 | provider-stated \| **derived** |
| `localUsed` | Units the relay itself has spent in the current period at this scope. | the period | the relay's own ledger, §3 | measured (or **estimated** when the underlying tokens were) |
| `resetsAt` | Epoch ms at which `remaining` returns to `limit`. | — | reset ladder, §5 | provider-stated \| **derived-boundary** |
| `headroomPct` | `remaining / limit`, 0–100. **Derived, and only emitted when both operands exist at a stated `axis`.** Replaces today's untyped scalar. | point-in-time | derived | inherits the weaker of the two |
| `observedAt` | When the provider last stated anything about this (scope, axis, period). Null ⇒ never. | — | header capture | measured |
| `cooldownRemainingMs` / `cooldownSource` | Already exist (`src/circuit-breaker.ts:81`, surfaced `src/candidates.ts:50-51`). Kept, unchanged, and reported *beside* quota, not merged into it. | — | existing | existing |

⚠ **`headroomPct` must never be stored.** It is a render-time derivation of two stored numbers. Storing it is how the current defect happened: `extractQuotaPercent` persists the ratio and discards the operands, so nothing downstream can recover which axis it described or recompute it against a corrected limit.

---

## 2. COLLECTION

### 2.1 The both-fronts rule, stated first

`src/server.ts:1361-1365` already carries the warning in a comment, naming `docs/pool-failover.md`: the OpenAI front once had *no* failover and *no* breaker accounting because a policy lived only in the `/v1/messages` loop — 14-member pool, every request served by the same rate-limited member, six consecutive 429s with `lastStatus: null` on the breaker throughout. **A metering loop wired into one front is that incident's exact shape**, and it is worse here, because a partial ledger does not fail loudly: it under-reports, and an under-reported meter reads as headroom.

The mitigation is structural, and llm-relay already has the right seam. `recordCall()` (`src/server.ts:1259`) is invoked from `completeAttemptSuccess()` (`src/server.ts:1563`) and `completeAttemptFailure()` (`src/server.ts:1613`) — **both of which both fronts already call**. Every accounting write goes through one function called from those two sites, never open-coded at a front's terminal branch. Pin it with a test that asserts the accounting function is reached from an `openAiFrontPath` request as well as a `/v1/messages` one, using ≥2 candidates (the `test/pool-failover.test.ts` rule: a one-candidate test cannot distinguish "works" from "cannot run at all").

### 2.2 Capture sites, per number

**Request-shaped numbers (both fronts, before dispatch).**
`estimateRequestTokens(reqJson)` is already computed on both fronts for the context guardrail (`src/server.ts:533`, reached after the OpenAI front is detected at `:493-494` precisely so the guardrail covers it). Carry that value forward on the request context rather than recomputing — it is the `inputTokens.estimated` for the turn.

**Response headers (both fronts, at `observeAttemptHeaders`).**
`src/server.ts:714` and `src/server.ts:1836`. Today this extracts a scalar percent. Replace with `extractQuotaObservations(headers)` returning `Array<{axis, period, limit, remaining, resetsAt}>` — plural, because a single response commonly carries both a requests axis and a tokens axis. Keep `extractQuotaPercent` as a thin derived wrapper so `src/telemetry.ts:119` and `src/key-checker.ts` do not break in the same commit. `parseRetryAfterMs()` is already parsed at the same two sites (`src/server.ts:713`, `:1835`) and is a `remaining: 0` observation with a stated reset.

**Error bodies (both fronts, at `discardCandidate` / terminal).**
`discardCandidate()` (`src/server.ts:1515`) already reads the body of a stepped-over candidate when `carriesEligibilityFact(status)` (`src/server.ts:1496`, covers 400/401/402/403/404/410/429) and hands it to `observeEligibility()`. The terminal candidate's body is read at `src/server.ts:1953` (OpenAI front) and `src/server.ts:2079-2081` (Anthropic buffered). **These are the three places a stated rate limit can be learned, and they already exist.** Add a `parseStatedRateLimit(body)` call alongside `interpretRefusal` — no new plumbing, no extra body read, no clone.

⚠ **Never add a `res.clone()` here.** `src/server.ts:1408-1413` documents that `clone()` tees the body, the failover branch cancels the original, and the un-read tee strands the walk — three pre-existing 402 tests went red when it was tried. `observeContextLimit` (`src/server.ts:1377`) still clones and is confined to 400/413; do not copy that pattern to a new call site.

**Response usage — the streaming problem.**

The usage block arrives in the SSE *tail*, which is the one place nothing currently looks.

- `probeStreamForCommit()` (`src/stream-commit.ts:255`) is a **head** probe. It returns the moment content commits and thereafter replays raw chunks through a passthrough `ReadableStream` (`:281-304`). It explicitly HOLDs on a usage-only frame (`src/stream-commit.ts:121`, `choices.length === 0`) and never parses `usage`. It is not, and should not become, the usage tap — turning a commit probe into a full-stream parser would defeat its purpose of committing early.
- **Anthropic front, streamed:** the tee already exists at `src/server.ts:2062-2072` but is gated on `ctx.willValidate`. `reconstructFromSse()` (`src/sse.ts:47`) already extracts `usage` from `message_start` (`:70`) and merges `message_delta` usage (`:116-117`). Two options: (i) ungate the accumulation — costs holding the whole stream in memory for every turn, up to 8 MiB, which is why it is gated; or (ii) **preferred** — add a lightweight tail-only tap in the same `for await` loop that keeps a bounded trailing buffer (last ~16 KiB) and, at end-of-stream, scans it for `message_delta`/`message_start` usage. Constant memory, no reconstruction, works whether or not tools were present.
- **OpenAI front, streamed:** `src/server.ts:1975-1981` accumulates nothing. Add the same bounded trailing-buffer tap. The OpenAI usage-only frame is a chunk with `choices: []` and a `usage` object; the Responses protocol carries it on `response.completed`. The tap must be protocol-aware in exactly the way `classifyEvent()` already is (`src/stream-commit.ts:206-244`) — reuse that switch shape, do not re-derive it.
- **Both fronts, buffered:** trivial. Anthropic at `src/server.ts:2074-2082` already buffers the whole body. The OpenAI front's non-error success is streamed-or-buffered through the same loop; a buffered response yields one chunk and the tail tap sees it.
- **When usage is absent:** record `inputTokens.estimated` from the guardrail estimate and `outputTokens.estimated` from a chars/4 byte counter accumulated in the same write loop. Set `tokenBasis: "estimated"` (or `"mixed"`). **Never zero-fill a reported field.** `src/sse.ts:127-128` already states the rule: an omitted `usage` means the stream never reported one, which is a different statement from "this call used zero tokens".

**Repair turns.** A repair issues additional model calls through `Reshaper` (`src/reshaper.ts`). Those are relay-originated traffic that spends the same quota. Account them under a distinct `kind: "reshape"` so `requests` stays "client turns" and a reshaper burning a pool is still visible. Do not fold them into the parent turn's token totals.

---

## 3. STORAGE

### 3.1 What write-behind can and cannot do — honestly

`WriteBehindTimer` (`src/write-behind.ts:11`) schedules a flush; it does not mediate the mutation. Every consumer mutates an in-memory module global in place (`src/ping/runtime-telemetry.ts:106-111`) and the flush serialises the **entire document** with `writeFileSync` + `renameSync` (`src/target-facts.ts:214-220`, `src/ping/probe-cache.ts:102-108`).

Consequences, stated plainly:

- **Safe for read-modify-write counters within one process.** `m.totalCalls += 1` is a synchronous in-memory increment; there is no lost-update window. Write-behind is genuinely fine here.
- **Unsafe across processes.** Two writers each hold their own loaded copy and each rewrites the whole file. Last rename wins, silently discarding the other's counters. Today this is latent because only the server writes and the CLI reads — `llm-relay candidates` calls `loadRuntimeTelemetry()` read-only (`src/candidates.ts:242`). **Rule: the usage ledger is server-write-only.** `llm-relay usage` must query the running relay over loopback (the pattern `src/cli.ts` already uses for `/offload` and `/dispatch`) and fall back to a **read-only** file scan when no relay is up.
- **Crash window.** Up to `MAX_FLUSH_DELAY_MS` (`src/write-behind.ts:9` = 2,000 ms) of counts are lost on a hard kill. For a health cache that is nothing; for a meter it is real. Mitigate by flushing on the same shutdown hook as `flushFacts()` / `flushProbeCache()`, and label lifetime totals as lower bounds (`≥`) in any surface that shows them. Do not pretend otherwise.

### 3.2 What versioned JSON sliding windows cost

The honest arithmetic. A per-(provider, model) **hourly** bucket over a 30-day horizon with ~50 deployments is 50 × 720 = 36,000 rows. At ~120 bytes of pretty-printed JSON per row that is roughly 4 MB, rewritten in full on every flush — every ≤2 s under load. That is not acceptable and should not be shipped.

Two fixes, both cheap:

1. **Bucket at the granularity you will query.** Per-*provider* hourly (12 × 720 = 8,640 rows) plus per-*deployment* daily (50 × 30 = 1,500). ~1.2 MB. Better, still hot.
2. **Shard by UTC day.** `~/.llm-relay/usage/2026-08-16.json` — only today's file is ever rewritten; every prior day is immutable and never touched again. Retention is `unlink` of files older than N days. Today's file holds at most 24 hourly buckets × dimensions, tens of KB. **This is the recommendation.**

Plus the tier that already exists: `src/log.ts` is an append-only rotating JSONL with a 50 MB cap and one-predecessor rotation (`src/log.ts:4`, `:145-150`). **That is already the per-request ledger** — freellmapi's `requests` table and its `request_attempts` child, in a file llm-relay writes on every turn today. Its `attempts[]` already carries `{provider, model, status, ms}` per hop (`src/log.ts:10-15`), which is freellmapi's failover-ladder drill-down minus the offsets. Adding token fields to `LOG_FIELDS` (`src/log.ts:77`) makes it queryable without a new store.

⚠ `LOG_FIELDS` is a closed allow-list enforced at the sink (`src/log.ts:130-142`), pinned by `test/log.test.ts`. Adding a field is a deliberate act, which is the point. Token counts are **metadata, not content** — `logSafePath()` already logs the *length* of a query value while replacing the value (`src/request-log.ts:47`), so "a number describing the size of content" is established precedent here. The metadata-only invariant survives intact.

### 3.3 Concrete shape

```
~/.llm-relay/
  relay.log                     (existing) + inputTokens/outputTokens/tokenBasis/cachedTokens
  usage/
    2026-08-16.json             hot; rewritten write-behind
    2026-08-15.json             immutable
    lifetime.json               monotonic counters + firstRequestAt
  quota-state.json              volatile availability observations (see §5)
  target-facts.json             (existing) + learned rate-limit facts (see §4)
```

`usage/<UTC-date>.json`:

```jsonc
{
  "version": 1,
  "date": "2026-08-16",
  "buckets": {
    "14": {                                  // UTC hour
      "byDeployment": {
        "nim/z-ai/glm-5.2": {
          "requests": 12, "attempts": 14, "served": 12, "errored": 2, "cancelled": 0,
          "inTokReported": 148230, "outTokReported": 9114,
          "inTokEstimated": 0,    "outTokEstimated": 0,
          "cachedTokReported": 102400,
          "sumLatencyMs": 91200, "sumCommitMs": 8400, "commitSamples": 12,
          "latencySamples": [ /* bounded, for p95 */ ]
        }
      },
      "byClient": { "claude": { "requests": 10 }, "codex": { "requests": 2 } }
    }
  }
}
```

Notes that are load-bearing:

- **Reported and estimated are separate accumulators, always.** Never a single `inTok` with a sibling flag — a flag can be lost in a rollup, two counters cannot. A rollup that spans both reports both, and the surface shows `148,230 + 3,100 est`.
- `byClient` reuses `clientForPath()` / `FRONT_DOOR_CLIENTS` (`src/config.ts`), which already classifies the originating client for offload routing. This is freellmapi's `by-client` chart for free — and it is the one dimension that answers "which workload spent this", which matters more here than in freellmapi because llm-relay fronts several distinct agent CLIs.
- `latencySamples` is bounded exactly as `MAX_SAMPLES` bounds probe samples (`src/ping/probe-cache.ts:22`), and `lifetime.json` carries the counters that outlive the window — the same two-tier shape `ProbeTotals` documents at `src/ping/probe-cache.ts:24-36`, and the same shape freellmapi reaches with `request_hourly` vs raw `requests`. **A p95 needs a distribution; a total needs a counter; the two must not be the same field.**
- Under `VITEST`, redirect to a temp dir, same as `getProbeCachePath()` (`src/ping/probe-cache.ts:62`) and `defaultPath()` (`src/target-facts.ts:171`) — the suite has already polluted a user's live health data once.

### 3.4 Would a different engine be warranted? — a stated trade

The invariant that would have auto-rejected a dependency is removed, so this is now a judgement call rather than a rule, and it deserves a real answer.

**SQLite (`better-sqlite3`) would buy:** true windowed queries without loading a document, atomic `UPDATE … SET n = n + 1` (multi-process safe), retention by `DELETE`, and per-request rows queryable across arbitrary ranges.

**It would cost:** a native dependency in a package whose stated identity is two runtime deps; a compile-or-prebuild step on install; and precisely the Node-version fragility the owner's own environment already documents (`better-sqlite3` has no prebuild for the system Node 26.x, which is why freellmapi runs on a pinned portable Node 22). llm-relay is a global npm CLI installed with `npm i -g`; making that installation fail on a new Node major is a categorically worse failure than a slow query.

**Verdict: not warranted at this volume.** A single-user loopback relay serving one person's agent sessions produces on the order of 10²–10³ requests/day. Day-sharded JSON plus the existing rotating JSONL answers every query in §6 without loading more than one day at a time.

**The threshold at which this flips** (state it now so the decision can be revisited on evidence, not vibes): (a) per-request rows must be queried across more than ~30 days, or (b) a second *writing* process becomes real — a desktop shell, a second relay instance, or a CLI that records rather than reads. Either one makes last-write-wins a live bug rather than a latent one, and at that point SQLite is the right answer and should be taken.

---

## 4. LIMIT DISCOVERY

Three rungs, ordered exactly as `contextWindowResolver()` orders its three (`src/metadata.ts:207-227`), and for the same reason: first-party evidence about *this deployment* beats a published figure, which beats a borrowed one, and **there is no guessed rung**.

### Rung 1 — LEARNED, from what a deployment stated when it refused

Reuse `src/target-facts.ts` wholesale. Add rate limits as new `FactKind`s:

```ts
| "rate-limit-rpm" | "rate-limit-rpd" | "rate-limit-tpm" | "rate-limit-tpd"
```

Kind-per-axis rather than one kind with an axis field, because `FACT_TTL_MS` is a `Record<FactKind, number>` (`src/target-facts.ts:119`) so each axis gets its own staleness window by compiler enforcement, and `FACT_KINDS` derives from it automatically (`src/target-facts.ts:157` — a hand-maintained copy has already fallen behind once). The value rides in the existing optional numeric `value` field (`src/target-facts.ts:99`), the same one `context-limit` uses.

⚠ **These belong in the MEASUREMENT half, not `CONDITIONS`** (`src/target-facts.ts:141-147`). A learned RPM is a property of the deployment; a successful request says nothing about it, and `clearFacts()` must not delete it on success — the file already documents exactly this hazard for `context-limit` at `:350-353`. Getting this wrong would discard a real measurement on essentially every request.

TTL: long, like `context-limit`'s 30 days (`src/target-facts.ts:130`). A ceiling is slow-moving; this is staleness, not health.

The parser is a new module mirroring `src/context-limits.ts` — parser separate from storage, per that file's own header at `:20-28`. Two rules, ported as *rules* from freellmapi's `parseProviderLimit` (its `ratelimit.ts:1125`), not as code:

1. **Require both a number and a confidently-identified axis, or return null.** A wrong axis writes the wrong column and mis-gates every future request. Same refuse-to-guess discipline as `parseStatedContextLimit()` (`src/context-limits.ts:59-70`), whose header at `:12-16` states it directly.
2. **Match day before minute, tokens before requests.** "tokens per day" must not be shadowed by a `tpm` alternative; a body naming both axes must land on the tighter ceiling.

**Monotonicity:** freellmapi only ever lowers a learned limit (`… WHERE col IS NULL OR col > ?`) on the reasoning that hitting a ceiling proves the pre-check let too much through. llm-relay's `recordFact` lets a fresh observation replace an older one in either direction (`src/target-facts.ts:243-247`), on the reasoning that the target is the authority on itself. **Keep llm-relay's rule** — llm-relay has no pre-check to have been wrong, and a provider that raised its limit is telling us so. The TTL bounds the staleness.

### Rung 2 — PUBLISHED, via the catalog

`limitsFromRecord()` (`src/catalog.ts:103-114`) harvests context/max-output/pricing through generic field-alias lists, never a per-provider switch. Extend the alias lists with rate-limit aliases (`rate_limit`, `requests_per_minute`, `rpm`, `tokens_per_minute`, …) and widen `ModelLimits` + `sanitizeLimits()` (`src/catalog.ts:137-152`) to carry them.

⚠ **Expect this rung to be nearly empty, and build it last.** `src/metadata.ts:194-198` records the measurement: 0 of 29 `pool/high` members carry a provider-published context window, because free providers publish almost nothing and NIM publishes none. Rate limits are published even less often. It is correct to have the rung; it is wrong to sequence work as if it will pay.

### Rung 3 — CONFIGURED, operator-asserted

New optional block on `ProviderConfig` (`src/config.ts:59-98`) and on a per-deployment override map:

```jsonc
"nim": { "base": "...", "limits": { "rpm": 40, "rpd": 1000, "tpd": 150000 } }
```

This is freellmapi's `ModelDetailPage` editors and its hardcoded `DEFAULT_PROVIDER_*_CAPS` table, done right. freellmapi hardcodes account-wide caps in `src/`; llm-relay must not — but an **operator asserting** an account cap is a legitimate, differently-sourced piece of evidence, and `configured` is its honest label. It is also the only rung that can express a cap the per-deployment ledger structurally cannot see (one account's daily ceiling shared across every model on it), which `target-facts.ts:23-28` forbids the relay from *inferring* by counting. Config declares it; the relay never guesses it.

### Not a rung: header observations

A `remaining` reading from a response header is **point-in-time state, not durable knowledge**. It does not belong in `target-facts.json` — that store's contract is facts with TTLs. A `limit` extracted from a header *is* durable and goes to rung 1 as a learned fact; the accompanying `remaining` / `resetsAt` go to the volatile `quota-state.json` beside the local ledger. This split falls straight out of the MEASUREMENT/CONDITION distinction the store already draws.

---

## 5. AVAILABILITY

### 5.1 `remaining`, per (scope, axis, period)

```
1. provider-stated   most recent header observation for this (scope, axis, period),
                     IF observedAt is within the current period.
                     ⇒ basis: "provider-stated"
2. derived           limit − localUsed(current period), where limit comes from §4
                     and localUsed from the §3 ledger.
                     ⇒ basis: "derived:<limit-provenance>"  e.g. "derived:configured"
3. null              no opinion.
```

**Staleness is handled at READ time, as a pure function — not by a repair write.** freellmapi runs an `UPDATE` inside its GET path (`provider-quota.ts:422`) to restore `remaining` to `limit` once `reset_at` has passed, because otherwise a key that once hit zero reads exhausted forever. llm-relay should reach the same outcome without the write: if `observedAt` predates the current period boundary, the observation is simply not eligible for rung 1 and resolution falls to rung 2 or 3. Same correctness, no mutation on a read path, and it cannot invent a replenished number because rung 2 recomputes from the ledger and rung 3 is `null`.

⚠ **A `derived` remaining computed against a *learned* limit must not gate routing until the operator opts in.** The limit itself came from a regex over vendor prose; a mis-parsed axis would throttle a healthy deployment on a number nobody stated. It may be *displayed* (labelled `derived:learned`) from day one. `provider-stated` and `derived:configured` are trustworthy enough to gate.

### 5.2 `resetsAt`

```
1. provider-stated   a reset header, or Retry-After (parseRetryAfterMs, already parsed
                     at src/server.ts:713 / :1835).
2. reviewed rule     a ResetRule from src/refusal-interpretation.ts:96-105 — the
                     `field` form reads a JSON key out of THIS response (Google's
                     retryDelay), the `fixed` form is a reviewer assertion.
                     THIS ALREADY EXISTS and already ranks field above fixed
                     (src/server.ts:1476-1486).
3. derived-boundary  the next period boundary for the axis.
4. null.
```

⚠ **Pick one clock for period boundaries and say which.** freellmapi has two and they disagree — its web endpoints cut on UTC (`embeddings.ts:247-248`) while its desktop tray cuts on `localtime`, and its account-daily window uses UTC-midnight while its per-model `rpd` is a sliding 24 h. **Recommendation: UTC for every provider-facing boundary** (providers reset on their own clock, overwhelmingly UTC or a fixed vendor timezone), and local time *only* for a human-facing "today" label, with the surface stating which it used. Never let a sliding-24h and a calendar-day figure appear in the same column.

### 5.3 What "unknown" renders as

`null` limit, `null` remaining, `null` resetsAt ⇒ **`-`**. Never `0`, never `unlimited`, never a bar at 0%.

The idiom already exists in both directions: `fmt(c.quotaPercent, "%")` renders null as `-` in the candidates table (`src/cli.ts:1627`), and the table's own footer states "A blank cell means NOT MEASURED". The stronger precedent is `resolveMetadata()` returning `null` rather than a guessed limit (`src/metadata.ts:1-10`) and the context guardrail firing only on a published limit (`src/server.ts:526-528`). Unknown means no opinion, and the surface must not be able to express an opinion it does not have.

Corollary for any bar/meter: **do not draw a 0-of-0 track.** freellmapi made both calls in different components deliberately; the one consistent with this codebase is to omit the widget and say "no limit known".

### 5.4 Enforcement (routing input)

`orderByUsability()` (`src/server.ts:1018`) already consults `target-facts` cooldowns and orders live → credential-faulted → cooling, **demoting and never dropping** (`src/circuit-breaker.ts:583-595`). Quota joins as one more demotion term:

- `remaining ≤ 0` with basis `provider-stated` or `derived:configured` ⇒ demote to the cooling band with `cooldownSource: "quota"`, expiring at `resetsAt`.
- `remaining ≤ 0` with basis `derived:learned` ⇒ display only, until opted in.
- unknown ⇒ **no effect whatsoever.** Same rule as the context guardrail.

⚠ Demote, never drop. Only an unset credential removes a candidate, and that happens in `resolveTargets` for a different reason.

**In-flight leases: probably not warranted, and here is why.** freellmapi holds provisional leases (`ratelimit.ts:60-193`) to close a check-then-act race across concurrent requests. llm-relay's `kernel/` already has the same begin/complete handshake shape (`AttemptLifecyclePort`, branded `AttemptHandle`, `src/circuit-breaker.ts:190-282`), so it is *available*. But llm-relay is one person's relay; the concurrency that makes a lease necessary — N simultaneous requests all reading the same pre-check and all passing — is a multi-tenant gateway's problem. Ship without leases, accept that a burst can overshoot a limit by the in-flight count, and revisit only if measured overshoot appears.

---

## 6. PRESENTATION

### 6.1 CLI — the pipeline's natural output

Nine analytics endpoints collapse into two commands with a dimension flag, because the surface is a table, not a page.

```
llm-relay usage [--window 1h|24h|7d|30d|today|month|lifetime]
                [--by provider|model|client|pool] [--json]
```

Header line, then one row per group:

```
window: 24h (UTC)   requests 412   served 398   errored 12   cancelled 2   success 97.1%
tokens in  1.84M reported  +  12.4k est      tokens out  221k reported  +  3.1k est
spend $0.00 priced · 38 requests unpriced

by provider          reqs   succ%   p95      commit   tok in     tok out   $
nim                   204   99.0%   2.1s     410ms    980k        118k     -
huggingface            88   86.4%   6.4s     1.9s     412k         48k     -
openrouter             62   98.4%   1.8s     380ms    301k         41k     $0.00
```

```
llm-relay quota [--json]
```

One row per (scope, axis, period) — the availability surface. freellmapi puts this on the *Keys* page rather than Analytics because a quota belongs to a credential; llm-relay's equivalent is that the scope key **is** the credential, and the natural sibling command is `llm-relay keys` (`src/cli.ts:2091`).

```
scope                axis      period   limit      remaining   resets in   basis            seen
openrouter/*         requests  day      1000       842         9h14m       provider-stated  2m ago
openrouter/*         tokens    minute   -          -           -           -                -
nim/*                requests  minute   40         31          22s         derived:config   -
huggingface/*        tokens    month    -          exhausted   ~48m        fact:allowance   14m ago
groq/llama-3.1-8b    tokens    minute   30000      learned     -           derived:learned  -
```

⚠ Every row states its **basis** next to its number. That is the whole discipline, and it is the same one `src/cli.ts:1616` already applies to capability (`"50.0 neut"` — never show the number alone) and `src/candidates.ts:96-99` applies to limits (`~` = another provider's figure).

**`llm-relay candidates` — add columns, never a multiplier.** The `/candidates` contract is that dimensions stay separate and no blended score exists; tests assert there is no `score`/`rank` field and that the one scalar never travels without `strengthBasis` + `strengthSignals` (`src/candidates.ts:16-21`, `:128-158`). freellmapi's "Guardrails ×0.62" cell — headroom × rate-limit folded into one routing discount — is **precisely the construct this repo forbids**. Port the inputs, not the multiplier:

```
… quota      basis            reset
   842/1000  provider-stated  9h14m
   -         -                -
```

as a `quota` sub-object on each `Candidate`, sibling to `breaker` and `facts` — which is already the established shape for "these are different axes and must not be merged" (`src/candidates.ts:46-78`, whose comment at `:67-77` explains exactly why a member cooling on an account credit balance and one cooling on its own timeouts must not look identical).

### 6.2 JSON endpoints (loopback)

- `GET /usage?window=&by=` — the CLI's data, unformatted.
- `GET /quota` — the availability rows.
- `GET /telemetry` — extend the existing per-provider row (`src/telemetry.ts:5-40`, which already carries `quotaPercent`) with the consumption rollup and the typed quota block. This is freellmapi's `GET /api/health` role: health and quota answered together, because they are one question — can this credential take traffic right now.
- `GET /candidates` — the `quota` sub-object above.
- Optional response header, sibling to `x-llm-relay-pool-attempts`: `x-llm-relay-usage: in=1234r out=567r` (`r` = reported, `e` = estimated). Costs nothing, makes a single turn self-describing.

All read-only GETs. **Do not put mutating quota controls (an operator "clear this cooldown" — freellmapi's `DELETE /api/keys/:id/cooldowns`) behind loopback alone.** Loopback is not authorization: `/offload` and `/dispatch` carry Origin/content-type/Host admission checks plus the control token (`src/control-authorization.ts`) precisely because any page the user visits can POST cross-origin. A cooldown-clear endpoint is a mutation and must join them.

### 6.3 A dashboard — a genuine choice, not an assumption

The directive says "the dashboard's tracking", which reads as the capability. But a web UI may well be wanted, so here are three real options with honest prices rather than a recommendation dressed as a fact.

**(a) None. CLI + JSON only.** Cost: zero. Loses: time-series (the one thing a table genuinely cannot show — freellmapi's requests-over-time and tokens-over-time charts have no tabular equivalent), and the at-a-glance stacked budget bar.

**(b) One self-contained HTML file served at `GET /` from the existing loopback listener.** No build step, no framework, no bundler, no new runtime dependency — a single file with inline CSS and inline JS that fetches `/usage`, `/quota` and `/telemetry` and draws sparklines with inline SVG. Cost: one file in the published package, plus the discipline of keeping it truthful. This is the honest middle and probably the right answer: it buys the time-series and costs approximately nothing. ⚠ It makes the listener serve HTML, so: read-only GETs only, no mutating controls without the control token, and the page must respect the same null-rendering rules as the CLI (`-`, never `0`).

**(c) A real SPA, freellmapi's Analytics page ported.** Cost: a build pipeline, a framework dependency, chart-library deps, package size, and a second surface that can drift out of agreement with the CLI. Recommend against unless the owner specifically wants that page.

**This is the owner's call and should be asked as a direct question, with (b) named as the default if no answer comes.**

---

## 7. WHAT THIS UNBLOCKS

The concrete dead signal, and exactly how it comes alive.

**Today.** `extractQuotaPercent()` (`src/ping/ping.ts:26`) runs on every real request from both fronts, via `observeAttemptHeaders()` (`src/server.ts:1537`), called at `src/server.ts:714` and `src/server.ts:1836`. Its output is committed to `CircuitState.quotaPercent` at `src/circuit-breaker.ts:412`. Downstream:

- `getTelemetryReport()` reads it at `src/telemetry.ts:119-132` (`states.find(s => s.quotaPercent !== undefined)`) and puts it on the provider row.
- `llm-relay telemetry` prints it at `src/cli.ts:662`.
- **Nothing else.** `orderByUsability()` (`src/server.ts:1018`) and `getHealthyTargets()` (`src/circuit-breaker.ts:583`) have no quota term. No pool ordering, no admission, no guardrail reads it.
- And the `quota` column of `llm-relay candidates` (`src/cli.ts:1627`) reads a **different source** — `pingLoop.getProviderQuota()` (`src/candidates.ts:360` → `src/ping/cadence.ts:218`), populated only from synthetic probes (`src/ping/cadence.ts:162-163`). So the operator table used to choose offload targets shows probe-aged quota while fresh request-path quota sits unused in the breaker.

So the accurate statement is sharper than "read for nothing": it is **read in one surface, routed on in none, and shown in the wrong place** — and the number itself is not trustworthy, because (i) `src/ping/ping.ts:27-35` returns the first matching header pair out of seven spanning four different axes and discards which one matched, so consecutive requests can report headroom of different quantities under one label; and (ii) `latestQuota` is a `Map<providerKey, …>` (`src/ping/cadence.ts:95`) written from a *per-model* probe, which is the scope drift `src/target-facts.ts:8-28` was written to stop, reproduced in a store that predates it.

**After this spec, four things change.**

1. **Typed.** `extractQuotaObservations()` returns `{axis, period, limit, remaining, resetsAt}` triples instead of one ratio. The percent becomes a render-time derivation of two stored operands, so it can be recomputed against a corrected limit and can always say which axis it describes.
2. **Correctly scoped.** Observations key on `FactScope` (`src/target-facts.ts:83-87`), so a per-model reading is stored per-model and a provider-wide statement is stored per-provider — and one provider's reading can never overwrite another's, nor a model's a provider's.
3. **Backed by a second, independent estimator.** A provider that publishes no rate-limit headers at all (most of the free tier) still gets a `derived` remaining from the local ledger against a configured or learned limit. Today such a provider reports `-` forever.
4. **A routing input.** `remaining ≤ 0` at a trustworthy basis becomes a demotion term in `orderByUsability()` with `cooldownSource: "quota"` and an expiry at `resetsAt` — joining, not replacing, the breaker and the fact store, exactly as `allowance-exhausted` already does. That closes the loop the pool-eligibility work opened: `pool/xhigh`'s 15 members spanning 4 quota domains currently spend 13 round-trips to discover 4 facts; a live headroom signal lets the walk skip a spent domain *before* paying for it.

Two smaller pieces of already-built machinery also come alive: `recordModelCall`'s `completionTokens` parameter (`src/ping/runtime-telemetry.ts:86`, summed at `:110`, never supplied by `src/server.ts:1262`) gets its argument; and `reconstructFromSse`'s `usage` extraction (`src/sse.ts:70`, `:116-117`) stops being reachable only on tool-carrying turns.

---

## 8. GAPS — ranked

Ranked by value per unit effort. S ≈ under a day, M ≈ a few days, L ≈ a week-plus.

| # | Gap | Effort | Why here |
|---|---|---|---|
| 1 | **Typed quota observation** — `extractQuotaObservations()` replacing/wrapping `extractQuotaPercent()`; fix the provider-keying in `src/ping/cadence.ts:95` | S | Highest ratio in the list. Turns an existing, already-flowing measurement from misleading into usable. No new store, no new file. |
| 2 | **Reported-token capture, both fronts** — bounded trailing-buffer SSE tail tap + buffered-body read | M | The primitive everything else rests on. Anthropic front has half of it (`src/sse.ts:116-117`) gated behind `willValidate`; OpenAI front has none (`src/server.ts:1975-1981`). |
| 3 | **Widen `LOG_FIELDS`** (`src/log.ts:77`) with `inputTokens`/`outputTokens`/`cachedTokens`/`tokenBasis` | S | Turns the existing rotating JSONL into the per-request ledger. `attempts[]` already carries the failover ladder. |
| 4 | **Widen `AssistantMessage.usage`** (`src/anthropic.ts:69`) for cache tokens | S | Cached prompt tokens are the largest single distortion in any spend figure. |
| 5 | **Configured limits** on `ProviderConfig` (`src/config.ts:59`) | S | The only rung that can express an account-wide cap without inference. Unblocks `derived` remaining immediately. |
| 6 | **Day-sharded usage store** + rollup reads | M | Windows, rates, lifetime totals. Two-tier shape already proven by `ProbeTotals` (`src/ping/probe-cache.ts:24-36`). |
| 7 | **`llm-relay usage` / `quota` + `GET /usage` `/quota`** | M | The surface. Loopback-query-first with read-only file fallback (§3.1). |
| 8 | **Learned rate-limit facts** — 4 new `FactKind`s + `parseStatedRateLimit()` | M | Reuses `src/target-facts.ts` entirely; the parser is the only new code. Must land in the MEASUREMENT half. |
| 9 | **`quota` sub-object on `Candidate`** (`src/candidates.ts`) | S | Un-blended, sibling to `breaker`/`facts`. No multiplier. |
| 10 | **Estimated output tokens** — chars/4 byte counter in both write loops | S | Only meaningful once #2 exists and reveals how often `usage` is absent. Separate accumulator, always. |
| 11 | **Spend** — tokens × `resolveMetadata()` prices, compound `spendBasis` | M | Cost accounting. Depends on #2 and #3. |
| 12 | **Quota as a demotion term** in `orderByUsability()` (`src/server.ts:1018`) | M | The routing payoff. Opt-in for `derived:learned` basis. |
| 13 | **Catalog rate-limit harvesting** (`src/catalog.ts:103`) | S | Cheap, but expect a near-empty payoff (`src/metadata.ts:194-198`: 0 of 29 members carry even a published context window). Sequence last among the discovery rungs. |
| 14 | **Wire or delete `completionTokens`** (`src/ping/runtime-telemetry.ts:86` vs `src/server.ts:1262`) | S | A field that is structurally always 0. Fold into #2. |
| 15 | **Single-file loopback HTML page** | S | Only if the owner wants it. Tier (b) of §6.3. |
| 16 | **In-flight leases** | L | Argued against in §5.4. Listed so the decision is visible, not so it gets built. |
| 17 | **Full SPA dashboard** | L | Tier (c). Only on an explicit ask. |

---

## 9. STAGED BUILD ORDER

Each stage is independently shippable, leaves the tree green, and is useful on its own.

**Stage 0 — Make the existing measurement legible.** (Gaps 1, 14. Effort S.)
Type the quota observation; fix the provider-keying scope drift; surface `{axis, period, limit, remaining, resetsAt, basis, observedAt}` in `GET /telemetry` and as a `quota` sub-object in `GET /candidates`; render it in `llm-relay candidates` with its basis. Wire or delete `completionTokens`.
*No new store, no new file, no new dependency.* Ships a correction to something already collected. **Do this first regardless of whether the rest lands.**

**Stage 1 — The metering primitive.** (Gaps 2, 3, 4. Effort M.)
Widen `AssistantMessage.usage`; add the bounded tail tap on both fronts; add token fields to `LOG_FIELDS`. The JSONL becomes the per-request ledger and `llm-relay usage --json` can read it directly with no aggregate store.
*Gate:* a test asserting the accounting site is reached from `openAiFrontPath` with ≥2 candidates, not only from `/v1/messages`.

**Stage 2 — Windows and rollups.** (Gaps 6, 7 partial, 10. Effort M.)
Day-sharded `usage/<date>.json` + `lifetime.json`; `llm-relay usage --window --by`; `GET /usage`. Add the estimated-output counter once Stage 1 has shown how often `usage` is absent.
Now: requests, success rate, latency percentiles, token totals, per-provider / per-model / per-client breakdowns, all windowed.

**Stage 3 — Availability.** (Gaps 5, 8, 7 remainder, 9. Effort M.)
Configured limits in config; learned rate-limit facts + parser; the remaining/resetsAt ladders; `llm-relay quota` + `GET /quota`.
Now the freellmapi Quota Signals card exists as a table, with basis and observed-at beside every number.

**Stage 4 — Cost.** (Gap 11. Effort M.)
Spend with compound `spendBasis`; `unpricedRequests` beside the total. No savings counterfactual, no fallback price.

**Stage 5 — Enforcement.** (Gap 12. Effort M, opt-in.)
Quota as a demotion term in `orderByUsability()`, `cooldownSource: "quota"`, expiring at `resetsAt`. `provider-stated` and `derived:configured` gate; `derived:learned` displays only until opted in. Demote, never drop.

**Stage 6 — The page, if wanted.** (Gap 15 or 17. Owner's call.)
Single self-contained HTML at `GET /`, read-only, reusing the Stage 2–4 endpoints.

**Catalog harvesting (Gap 13)** can slot in anywhere after Stage 3; it is cheap and likely low-yield, so it should not block anything.

---

## 10. Invariants this spec deliberately does not touch

Stated because a constraint the owner is never told was applied is one they cannot overrule:

- **Loopback-only bind.** All new endpoints are GETs on the existing listener. Any future mutating quota control joins `/offload` and `/dispatch` behind the admission checks + `src/control-authorization.ts`. Loopback is not authorization.
- **Metadata-only logs.** Token counts are numbers describing content size, not content — the same class as `logSafePath()`'s existing value-length logging (`src/request-log.ts:47`). No body, no header, no prompt text enters any store in this spec. `LOG_FIELDS` stays a closed sink-enforced allow-list.
- **Health demotes, never drops.** Quota joins as another demotion term. Only an unset credential removes a candidate.
- **The repair boundary.** Nothing here puts an LLM on the request path. `parseStatedRateLimit` is a deterministic regex; a miss learns nothing and (optionally) queues for the existing offline review tier in `src/refusal-interpretation.ts`, which already requires `llm-relay eligibility accept` before a verdict binds. Error bodies remain untrusted external content.
- **`/candidates` stays un-blended.** Quota is a new separate sub-object. No `score`, no `rank`, no guardrail multiplier.
- **"A guess must never look like a measurement", recalibrated.** Estimates are permitted and appear throughout. Every one of them lives in its own field, with its own accumulator, under its own label, and never sums into a reported figure.

---

## 11. Open questions for the owner

1. **UTC or local for "today" / "this month"?** Recommendation: UTC for every provider-facing period boundary, local only for a human-facing label, stated on the surface. freellmapi has both and they disagree.
2. **Dashboard: none, one self-contained HTML file, or a full SPA?** Recommendation and prices in §6.3. Default to the single file if unanswered.
3. **Should this pre-shape for multi-key pooling?** llm-relay is one `authEnv` per provider today (`src/authEnv.ts`), so "credential scope" and "provider scope" coincide and freellmapi's per-key metering has nothing to key on. Multi-key pooling is a separate and much larger change (config schema, `resolveTargets`, key selection, `buildForwardHeaders`) and deserves its own spec. **But keying the usage and quota stores on an opaque `credentialId` (today: `= provider`) rather than on the provider name is nearly free now and expensive to retrofit.** Recommend doing it. Confirm.
4. **Estimated output tokens at all?** They require a byte counter in both stream write loops and are, by construction, a chars/4 guess about text the relay already forwarded. The recalibrated rule permits them if labelled. Worth it, or is `-` the better answer when a provider omits `usage`?
5. **Retention horizon** for `usage/<date>.json`. 30 days matches the widest window a surface would offer. Longer costs only disk.
6. **A savings counterfactual?** Deliberately excluded (§1.2) because freellmapi's version mixes an unlabelled fallback price into a real total and extrapolates. A correctly-provenanced version is buildable; it is a separate ask.