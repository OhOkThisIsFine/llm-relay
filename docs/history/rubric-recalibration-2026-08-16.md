# Rubric recalibration and the metering lane (2026-08-16)

Commissioned after the owner removed three invariants and two reasoning patterns, recalibrated a
fourth, and reinstated **accounting and metering** as founding goals. Companion documents:
[rejection-ledger-2026-08-16.md](rejection-ledger-2026-08-16.md) (what was rejected and why),
[quota-metering-spec-2026-08-16.md](quota-metering-spec-2026-08-16.md) (the tracking pipeline spec).

**55 rejections re-adjudicated**: 25 reasons VOIDED, 15 WEAKENED, 11 SURVIVE on independent grounds,
4 n/a. New verdicts: 6 ADOPT, 26 ADAPT, 18 REJECT, 3 INVESTIGATE, 2 INFO.

---

## 1. WHAT WENT WRONG

**The honest finding: accounting/metering was never in this repo's founding text — it was explicitly assigned to a sibling project on day one, and this repo then absorbed that sibling's *other* half and never went back for this one.** Do not tell the owner there was a fall from grace inside the repo; the truth is worse in a more useful way — the goal was deferred, the deferral's premise was voided within hours, and nobody reopened it for thirteen months of commits.

### The founding text (verified, not recovered)

`6dec975:README.md:59` (first commit, 2026-07-14, "M1: Anthropic proxy passthrough + tool_use validator + detect-mode logging"), verbatim:

> "Full spec: `repair-proxy-spec.md` (in the design scratchpad). Consumers (audit-tools dispatch, plain `claude` CLI) point `ANTHROPIC_BASE_URL` at this proxy; it validates one backend per request. **Target *selection* / token-prediction is a separate concern (the router/auditor), deliberately not here.**"

A case-insensitive grep of that README for `quota|meter|account|budget|cost|spend|usage|track` returns exactly that one line and nothing else. So the founding document names token-prediction, defers it, and names where it went.

⚠ **This does not refute the owner.** It locates the drift. The goal lived in the *router/auditor* concept and in `repair-proxy-spec.md`, a design-scratchpad file that is **not in this repo**. That file is the one artifact that could confirm the founding intent directly, and it is worth recovering (open question 5).

### The premise was voided the same day and nobody noticed

`774ba18` (2026-07-14, hours later) — "feat: multi-provider registry with namespace + tier routing" — replaced the single `backend` with `providers{}` + `routing`. That *is* the "target selection" the README had deferred. The deferral was thereby void for selection. **No commit ever voided it for token-prediction.** Every later argument against a ledger was arguing against importing a feature from a project this repo had already, silently, become.

### Three times the mechanism was built and never joined

1. **`3353e94`** (2026-07-28, "feat: add 100% free presets, subscription pooling, onboarding, and telemetry") added to the README: *"Response Headers: Proxy responses include `x-llm-relay-quota-percent`, `x-llm-relay-stability-score`, and `x-llm-relay-target`."* `git log --all -S'quota-percent'` and `-S'stability-score'` return **only two commits, both documentation** (`3353e94`, `621547c`). Neither string has ever existed under `src/`. The claim is still live today at `docs/reference.md:768`. **The project has advertised per-request quota transparency it has never once possessed.**

2. **`65853de`** (2026-07-28, "fix: carry streamed usage through openai backends"): *"Send `stream_options.include_usage` on streamed openai-kind requests, and retry once without it if a backend rejects the unknown field (400/422) **rather than failing the request over telemetry**."* The author already regarded usage as telemetry the relay wanted (`src/backend.ts:495`, retry at `:507-511`). Nothing was ever written to accumulate it.

3. **`ModelTelemetry.totalCompletionTokens`** (`src/ping/runtime-telemetry.ts:22`) is accumulated at `:110` and mirrored into `RecentCall.tokens` at `:117` — and the **sole** production call site is `src/server.ts:1262`:
   ```
   recordModelCall(target.provider, target.model, { ok, latencyMs: Date.now() - started });
   ```
   No `completionTokens` argument. **Verified by grep: one definition, one call site, field omitted.** The counter has read `0` for the life of the file, and `0` is indistinguishable from "this model generated no output" — a field that looks like a measurement and is not one, already shipped. ⚠ `docs/history/status-vs-freellmapi-2026-08-16.md:236-241` cites this very field as proof that llm-relay "is not true that it has no counters at all". That defence rests on a counter that has never counted.

### What removed it, and when

Not a deletion — **an invariant ratified after the fact.** `27b7a48` (2026-08-04) did delete `RequestBudget`/`AttemptLease` ("Deleted the never-adopted kernel surface: canonical IR, transport/credential/transcoder ports, lease-budget machinery, tier-snapshot.ts and their tests"), and the companion review's stated grounds are now-retired reasoning ("no client we run will ever set them"). **But that code was not accounting** — `RequestBudget.acquire()` returned `budget-exhausted` on attempt count and `deadline-exceeded` on wall clock, with no provider, key, model, tokens, persistence or window. Both halves shipped later in simpler form (`walkBudgetMs`, `DEFAULT_WALK_BUDGET_MS`, `src/server.ts:1086`). Reinstating metering must **not** be satisfied by resurrecting it; that would look like restitution while delivering none.

The actual removal was `docs/project-goals.md:86`, **"Credentials stay user-operated" (ratified 2026-08-08)** — a sound anti-hosting rule that was then applied to *metering keys you already hold yourself*. Combined with "one place per policy" (`project-goals.md:39`) and provider-agnosticism, it produced the 2026-08-13 rejection bundle (`docs/history/freellmapi-adoption-review-2026-08-13.md:375-381`) that killed the RPM/RPD/TPM/TPD ledger, account caps, and quota-pool grouping in one paragraph. The ledger doc had already caught the error itself: *"This is the widest-reaching invariant in the project, and the quota-ledger rejection is the one most worth re-examining. The ledger is accounting, not custody"* (`docs/history/rejection-ledger-2026-08-16.md:56-58`).

### The consequence, on the record

Five days after deleting the lease machinery, `c0bcbb8` retired the project. `docs/history/alternatives-review-2026-08-09.md:169` lists as a freellmapi advantage: *"**Per-key RPM/RPD/TPM/TPD counters** to stay under provider caps — your quota-domain problem."* Line 380: claude-code-router loses because it has *"no free-provider roster, no per-key quota counters."* Line 389: *"freellmapi is the only one that matches the actual workload: stacking free tiers, **tracking each key's quota**, failing over across quota domains."*

**The project rejected accounting, then lost a head-to-head partly on accounting, and no document ever connected the two events.** That is what went wrong.

---

## 2. REVISED INVARIANTS

Copy-ready. Replace `docs/project-goals.md` §"Credentials stay user-operated" and rubric item 3, and the corresponding CLAUDE.md invariant bullets.

### REMOVED — delete these outright

Delete `docs/project-goals.md:86-104` (the "Credentials stay user-operated" section) and replace with §REINSTATED + §RECALIBRATED below. Delete the phrase "One place per policy." from rubric item 3 (`project-goals.md:39`). Retire the following as *reasons* anywhere they appear in review docs; they may not be cited again:

- "Credentials stay user-operated" — as an argument against **metering, counting, or ordering** keys the operator already holds. (See §SURVIVES for the narrow anti-hosting rule that replaces it.)
- "One place per policy" / "no second composite score." It was self-refuting: `deploymentFitness` has been a weighted composite since it landed (`src/benchmarks.ts:219-221`, `0.75·capability + 0.2·operational + 0.05·metadata`), and `test/offload.test.ts:537-545` pins only that `/candidates` exposes no top-level `score`/`rank` — decomposability, not monism.
- "No hardcoded provider knowledge in `src/`." Already false as applied: `src/ping/ping.ts:59` hardcodes `["cerebras","mistral","groq","sambanova"]`; `src/authEnv.ts:17` is a per-provider alias table; `src/presets.ts` is per-provider bases/models/URLs; `src/refusal-interpretation.ts:417+` seeds provider-specific wording. See §SURVIVES for the true, narrower rule.
- "No user or client of this relay needs it."
- "We built this and deleted it before."

### RECALIBRATED — new precise wording

> **### Provenance: a guess must never be *labelled* a measurement**
>
> Every number the relay reports carries where it came from. A figure a provider stated, a figure
> the relay derived from stated figures, a figure the relay estimated, and a figure an operator
> declared are four different things and must be four different labels — `provider-stated`,
> `derived`, `estimated`, `operator-declared` — with `null` for absent. A total that mixes bases
> shows the split; it never quietly reports the sum as one kind. An unknown stays `null`, never
> `0`: `0` is a claim, absence is not (`src/emitSse.ts:44-51`, `src/anthropic.ts:66-69`,
> `src/backend.ts:816-819` already say this and are correct).
>
> **This rule governs LABELLING, not the existence of parameters.** A tunable constant with a
> documented default — a cooldown, a threshold, a flush cadence, a concurrency cap — is not a
> guess wearing a measurement's clothes; it is configuration, and the project already ships
> several (`DEFAULT_WALK_BUDGET_MS` `src/server.ts:1086`, `DEFAULT_STALL_TIMEOUT_MS` `:1105`).
> **A feature must not be rejected because one of its parameters needs a default.** The two
> forbidden things are: presenting an estimate as an observation, and inventing a *provider's*
> number (a limit, a price, a context ceiling) that nobody published — `resolveMetadata()`'s
> deleted 128k/4096 rung and `contextWindowResolver`'s "no guessed rung" remain the model.

### REINSTATED — new first-class section for `docs/project-goals.md`

> **## Accounting and metering (owner-restated 2026-08-16)**
>
> **Knowing what each credential has spent, and how much is left, is a founding goal of this
> project.** It was deferred on day one to a sibling "router/auditor" project
> (`6dec975:README.md:59`), that project's routing half was absorbed here within hours
> (`774ba18`), and the accounting half was never carried across. Three separate mechanisms for it
> were built and left unjoined: `stream_options.include_usage` (`65853de`),
> `ModelTelemetry.totalCompletionTokens` (never fed — `src/server.ts:1262`), and the harvested
> `quotaPercent` (`a700aaa`, read only for display). The gap is now closed deliberately.
>
> llm-relay must be able to answer, per credential and per deployment: **how much have I used,
> how much is left, and at what rate.** Counting is unconditional and needs no published limit.
> Acting on the count is optional, always announced, and may only reorder.
>
> A ledger is **accounting, not custody**: it meters keys the operator already holds. Nothing in
> this section authorises the relay to obtain, store, mint, or centrally proxy a credential.

### SURVIVES UNCHANGED — restate, do not weaken

> - **Loopback only.** Startup refuses a non-loopback bind. Loopback is not authorization: the
>   mutating control-plane endpoints keep their admission checks and capability token.
> - **Logs are metadata only**, enforced at the sink by `LOG_FIELDS` (`src/log.ts:77-93`).
>   Counts, identities and derived costs are metadata and belong on that list; bodies, headers
>   and prose never do, and no field is logged until someone adds it deliberately.
> - **The repair boundary.** The relay fixes protocol *form*, never *judgment*. No LLM opinion
>   enters the request path; routing comes from config and deterministic classification.
> - **Destructive tool calls are refused, never fabricated.**
> - **Health DEMOTES; it never drops.** `orderByUsability` returns every candidate
>   (`src/server.ts:1018-1043`). This binds the new metering gate with full force — see §5.
> - **No hosted relay, no pooled consumer accounts** (the surviving core of the retired
>   credentials rule): llm-relay never operates a login, never asks anyone to paste a Claude
>   token into it, never centrally proxies another person's subscription traffic. Each person
>   runs their own instance with their own keys. *This bars a shared/hosted deployment. It does
>   not bar counting, ordering, or holding several of your own keys for one provider.*
> - **Provider knowledge is DATA, not routing configuration.** The real rule, correctly stated:
>   no hardcoded provider **URLs, models, or credentials** decide routing in `src/`; those come
>   from config. Per-provider *facts* — env-var aliases, param quirks, refusal wording, preset
>   defaults — already live in `src/` and may continue to, provided each is labelled with its
>   basis and is overridable by config (the `SEED_INTERPRETATIONS` bootstrap-not-mechanism
>   pattern, `src/refusal-interpretation.ts:417`).
> - **⚠ Invariant applications are stated out loud.** Unchanged and now doubly important: if a
>   request is narrowed or redesigned because of a rule here, name the rule, say what it ruled
>   out, and say what was done instead.

---

## 3. RE-ADJUDICATED ITEMS

Ranked by value. "Void" = the stated reason is retired by the directive.

| # | Item | Old reason | Why void | New verdict |
|---|---|---|---|---|
| 1 | **RPM/RPD/TPM/TPD per-key ledger** | credentials-user-operated + "second predictive quota policy" + "presupposes limits free providers don't publish" | First two retired. Third is false as stated — the relay already harvests provider-stated rate-limit headers (`extractQuotaPercent`, `src/ping/ping.ts:26-52`, wired `src/server.ts:1537`) and freellmapi *learns* ceilings from refusal bodies exactly as `context-limits.ts` already does. And recording needs no limit at all. | **ADOPT** (staged) |
| 2 | **Wire `totalCompletionTokens`** | never rejected — silently never wired (`src/server.ts:1262`) | n/a | **ADOPT — Stage 1** |
| 3 | **Emit `x-llm-relay-quota-percent` / `-stability-score`** | never rejected — advertised since `3353e94`, never implemented; still claimed at `docs/reference.md:768` | n/a | **ADOPT — Stage 1.** Both inputs already exist. |
| 4 | **`headroomFactor` — order on harvested quota** | "fed by a monthly token ledger already rejected under the credentials invariant" | Retired ledger reason. `state.quotaPercent` is written at `src/circuit-breaker.ts:412` and read **only** by `src/telemetry.ts:132`, for display. The strongest evidence class the project recognises changes nothing. | **ADOPT** — as a demotion band, **not** a multiplier on `deploymentFitness` |
| 5 | **Cost = usage × resolved price** | never proposed | n/a — both inputs already resolved with provenance (`src/metadata.ts:20-21,41,112`) | **ADOPT** |
| 6 | **Account-wide caps (RPD/RPM/TPD)** | "would hardcode provider knowledge in `src/`" + credentials | Both retired | **ADAPT** — `ProviderConfig.accountCaps?`, basis `operator-declared`; preset seeds allowed only if labelled `preset-default` and overridable |
| 7 | **In-flight per-deployment leases** | one-place-per-policy + "worst case is one extra 429" + "built and deleted it" | 1st and 3rd retired; 3rd is also a category error (the deleted `AttemptLease` bounded one request's failover walk). 2nd survives only as an unmeasured estimate — and the race is structural: pool order is cached (`src/dynamic-pools.ts:265`, `src/benchmarks.ts:68`) and breaker state mutates only at terminal completion (`src/circuit-breaker.ts:309`), so N concurrent requests all pick candidate #0. Ranked **adopt-high by Codex and overruled**. | **ADAPT** — demote-only, cap default `null` |
| 8 | **Quota-pool grouping (which models share a bucket)** | provider-agnosticism + credentials | Both retired. `FactScope.group` already carries an explicit member list (`src/target-facts.ts:84`), so declaration replaces freellmapi's inference. | **ADAPT** — declared in config, never inferred |
| 9 | **Credential pooling — several keys per provider** | "the invariant rules out key rotation and account pooling"; "one provider entry per credential already works" | Invariant retired; the ToS text it rested on covers *offering Claude plan credentials on behalf of users* (`docs/history/codex-review-2026-08-05.md:32-34`), not third-party keys you hold. Second leg is thin: `ProviderConfig` carries one `authEnv` (`src/config.ts:67`), so two keys = two entries = split health, facts and accounting. | **ADAPT** — ordered `authEnvs?: string[]`, **deterministic** selection. Sequence last: with one key per provider it delivers nothing. |
| 10 | **Strategy weight vectors** | "the un-blended /candidates invariant forbids a second composite score" | Retired, and self-refuting (§2). The weights are hardcoded literals today with no lever. | **ADAPT** — `routing.fitnessWeights?`, defaulting to today's values, applied vector surfaced in `sortInputs` |
| 11 | **Per-model operator preference multipliers** | same struck invariant | Retired. Operator levers today are binary: leave in, or tombstone out. | **ADAPT** — `routing.preferences?`, bounded, applied **after** fitness and surfaced as its own field so evidence and thumb-on-scale stay separable |
| 12 | **Per-platform sampling-param droplists** | "hardcoded provider tables" | Retired — and already false: `src/ping/ping.ts:54-61,95,153-157` ships a droplist *and* a learn-on-rejection mechanism, stranded in the prober where the data path cannot see it | **ADAPT** — lift to a shared module; learn new entries, don't type them |
| 13 | **Server-enforced system prompts** | mis-bundled with minted keys as "credential custody" | Wholly void — an operator string has nothing to do with custody | **INVESTIGATE** — ask the owner what it is for before building (open question 6). I will not manufacture a replacement reason. |

### Rejections that SURVIVE on independent grounds

Being honest about these is what makes the rest credible.

| Item | Old reason status | Why it still stands |
|---|---|---|
| **Per-key bandit selection / Thompson sampling** | credentials + composite-score legs both void | **Reproducibility**, which the owner did not strike: "Transparent — the user should never have to wonder what is happening" (`docs/project-goals.md:16`), operationalised as headers whose contract is that the served route is reconstructible from recorded state. A per-request `sampleBeta` draw makes ordering irreproducible **by construction**. Take the deterministic residue (`α/(α+β)` with an explicit prior) if the operational axis ever needs one; never the sampler. |
| **10% exploration floor** | composite-score leg void | The starvation it solves does not exist here. freellmapi needs it because it learns operational quality only from served traffic; llm-relay synthetically probes every pool member (`src/ping/cadence.ts:59-69`) and persists results across restarts. And an exploration floor spends 1 in 10 of the owner's **real** requests on a model believed worse — fails "this installation first" on its own. |
| **Key encryption at rest** | credentials leg void | The load-bearing leg was never the invariant. freellmapi's own source says it: storing the master key beside the ciphertext "meant encryption-at-rest protected nothing for a default install" (`crypto.ts:22-27`); its mitigation reduces to filesystem ACLs. AES-GCM here buys nothing against a local reader and creates a lose-key-lose-everything hazard. **Adoptable residue (small):** `~/.llm-relay/.env` gets 0600 only on the onboarding path and only off-Windows (`src/onboarding.ts:191-194`) while `control-token` gets it consistently (`src/control-authorization.ts:28,108`) — fix and surface in `llm-relay keys`. |
| **Per-client minted inference keys** | custody leg void | Loopback-only + a data plane that deliberately does no auth. Minting per-client inference keys presupposes mutually-untrusted callers a single-operator loopback relay does not have, and the client identity actually needed is already derived credential-free from the front door (`clientForPath`). |
| **Per-key proxy overrides** | custody leg void | **Footprint**, unstruck: every backend call goes through global `fetch`, which has no proxy support; per-key egress needs undici `ProxyAgent` + a SOCKS agent, taking two pure-JS runtime deps to four, threaded through both fronts. No egress-control need on record. Reclassify from "invariant rejection" to **conditional skip** — reopens on geo-routing or a corporate egress path. |
| **DB-backed quirk registry** | invariant + SQLite legs both weak | A reason the ledger never recorded: in freellmapi the registry is **not on the routing path** — `resolveQuirksByModel`/`listQuirkDefinitions` have one non-test consumer, `scripts/export-catalog.ts`, and even `severity: 'blocker'` gates nothing. It is a documentation store with a UI; llm-relay has no UI, and `target-facts.ts` + `refusal-interpretation.ts` already cover the machine-actionable half better. |
| **Pre-dispatch gating that REMOVES a candidate** | — | **"Health demotes, never drops" is still in force**, and the argument is sharper than the general rule: the relay already declines to evict on a provider's own *stated* exhaustion (`allowance-exhausted` demotes, `src/server.ts:1027-1037`). A meter-derived "this key is spent" is the relay's own arithmetic — strictly weaker evidence. Removing on the weaker signal while demoting on the stronger one is backwards. |

---

## 4. THE METERING LANE

Merged from the two design agents, with conflicts resolved to source.

### 4.1 Unit of account — the ATTEMPT, with a role

One `/v1/messages` call can walk 13 candidates (`src/server.ts:619-731`); each non-served candidate had the full body posted to it and is discarded at `:722`. Each spent input tokens **on its own credential**. Recording only the served candidate under-counts provider spend by up to twelve turns; attributing all thirteen to the client turn over-states what the client cost.

**The leaf is the attempt, and it carries a `role`.** llm-relay already has the attempt as a typed object — the begin/complete handshake in `src/kernel/`, consumed at `src/server.ts:1549/1582/1616`. The ledger writes on attempt completion from the handle that already exists. No new lifecycle.

Coordinate: `(provider, model, credential, role, client)` where `role ∈ served | discarded | repair` and `credential` is the resolved env-var **name**. `(provider, model)` uses the existing `${provider}/${model}` spelling — do not invent a third.

> **Improve on freellmapi:** it records usage only after success, and its own comment names the cost ("between key selection and that write the router has no idea a request is already in the air"). **Count requests for every attempt that reached the wire, whatever its status; count tokens only when reported or estimable.** Different questions, different gates.

### 4.2 Credential identity — CONFLICT RESOLVED

The two designs disagreed. METER proposed `sha256(key value).slice(0,16)` as the persisted fingerprint; GATING and the adversarial pass said **never** persist any function of the credential value (`src/log.ts:77-93` discipline). **The adversarial pass is right on the persisted artifact; METER is right that a name alone cannot detect rotation.** Synthesis:

- **Persisted key = the resolved env-var NAME** from `resolveTargetAuthEnv` (`src/authEnv.ts:100-126`), not `provider.name` and not the declared `authEnv` — the resolver may return an alias (`GEMINI_API_KEY` vs `GOOGLE_API_KEY`, alias table `:17-34`). Two provider entries resolving to the same name collapse to one credential row, which is the point.
- **Rotation detection lives in process memory only.** Hold a hash of the current value per env name in RAM, never written; when it changes, bump a persisted integer `epoch` and start a new row `{envName, epoch}`. No key-derived material at rest, rotation still visible as `GROQ_API_KEY (epoch 2, rotated 3d ago)`.
- **The Anthropic passthrough is not a relay-held key.** `resolveAuthEnv` returns a name whenever `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` happens to be set even with no declared `authEnv` (`src/authEnv.ts:85-97`). The ledger must read `credentialState()` and record such turns as `caller-operated`, never as a metered relay key.
- **Do not extend `SCOPE_PRECEDENCE`** in `src/target-facts.ts:90` yet. That array is exported "so callers cannot invent a different precedence" and adding a fifth scope changes `covers()`/`keyOf()` for existing facts. The ledger owns its own key tuple and reuses `describeScope()` **for display only**. Revisit when credential pooling lands.

### 4.3 What is counted, and from where — three rungs

Mirrors `MetadataSource` (`src/metadata.ts:11`).

| Rank | Basis | Already exists at | Kind |
|---|---|---|---|
| 1 | `provider-stated` — `usage` in the response | Anthropic buffered `src/server.ts:2082` → `src/anthropic.ts:66-69`; Anthropic streamed `src/sse.ts:116-117`; OpenAI `src/backend.ts:675,758,814-830` | Measurement |
| 2 | `provider-headers` — raw `x-ratelimit-limit/remaining/reset` | `src/ping/ping.ts:26-52`, harvested on live traffic since `a700aaa` (`src/server.ts:1537`) | Counter **reading** — reconciliation only |
| 3 | `estimated` — `estimateRequestTokens()` | `src/metadata.ts:151` (the ONE estimator, input only) | Estimate |
| — | `null` | | Never `0` |

**Rung 2 reconciles; it never sums.** `extractQuotaPercent` collapses the pair to a percentage immediately, and a percentage cannot be differenced to derive spend — which is exactly why `a700aaa` feeds a display field and nothing else. Add a sibling `extractRateLimitCounters()` returning `{axis, remaining, limit, resetMs}` and make the percentage a derived view. Then `limit - remaining` is compared against the ledger's own count and any **drift is reported, never silently corrected** (`rpd 41 counted / 38 provider-stated (drift 3)`) — drift is the signal that another client shares the key or the provider's day boundary differs.

**Aggregates never blend rungs.** Every rollup reports `tokensStated`, `tokensEstimated`, and `eventsByBasis`. `llm-relay candidates` already establishes that a blank cell means not-measured (`src/cli.ts:1665`).

### 4.4 Cost — a join of two things already resolved

`resolveMetadata()` resolves `pricePerMTokIn`/`pricePerMTokOut` per (provider, model) with a `provider|reference|null` label; `assessCost()` is the single free/paid/unknown authority. Neither has ever been multiplied by anything — the `$` column in `candidates` is the rate card, not the bill.

`costMicroUsd = in/1e6·priceIn·1e6 + out/1e6·priceOut·1e6`, with **provenance = the weakest input**: `measured` (stated tokens × provider price) → `reference-price` (another host's rate for the same id) → `estimated-tokens` → `null` (never `0`) → `assumed-free`, which **carries `assessCost`'s basis**. ⚠ `assumed-free` is not a measured zero: `assessCost` admits any unpriced model from a `tierType:"free"` provider on the `provider-tier` basis, which CLAUDE.md already flags as "a claim about a roster". Render `$0.00 (assumed-free, 15 deployments, provider-tier basis)`, never a bare `$0.00`.

### 4.5 Storage — CONFLICT RESOLVED

METER proposed bucketed JSON through `WriteBehindTimer`; the adversarial pass showed that class is unsafe for counters. Resolution takes **both** corrections:

- **The relay process is the sole writer.** Every CLI view reads over HTTP (`GET /usage`) — the pattern CLAUDE.md already mandates for `/registry` vs CLI env. This closes the multi-process lost-update hazard that is **already live** in this repo (`llm-relay eligibility accept` writes the interpretation store from a CLI process at `src/cli.ts:1485` while the running relay rewrites the whole document on shutdown, `src/refusal-interpretation.ts:543-547`).
- **⚠ No `--path` inspector, ever.** `loadRuntimeTelemetry({path})` rebinds the module globals `_telemetry`/`_telemetryPath` (`src/ping/runtime-telemetry.ts:43-60`), so a later default-path write lands in the diagnostic file and the real file silently stops updating. Latent today; it goes live the moment someone writes the obvious first CLI for a meter.
- **Buckets, not an event list.** Every persist here re-serializes the whole document; a day of events at 2s max-age is unworkable. Hot tier: bounded in-memory ring of exact `{at,in,out}` per key for RPM/TPM (freellmapi's `Window.timestamps`/`pruneTimestamps` is the right structure), 25h + a global cap, resets on restart correctly. Warm tier: `~/.llm-relay/usage.json` v1 with 5-minute buckets (48h), UTC-day buckets (400d), and **lifetime `totals` that outlive both rings** — the lesson already learned in `src/ping/probe-cache.ts`. Split fields, not split keys: each bucket carries `reqServed/reqDiscarded/reqRepair`, `inStated/outStated/inEstimated`, `costMicro`, `costBasisCounts`.
- **`WriteBehindTimer` needs per-store cadence.** `src/write-behind.ts:8-9` hardcodes 250ms/2s for every consumer. Add constructor options defaulting to today's values (no existing caller changes) and give the ledger ~30s/5min, plus an eager flush on bucket rollover and on shutdown.
- Downsample on rollover, never delete; beyond a hard byte budget drop `daily` oldest-first but keep `totals` and record `dailyTruncatedBefore`. Corrupt ⇒ start fresh; a storage problem is never a request failure.
- **State the cost honestly:** RPD/TPD are accurate to ±5 min at the window edge; **RPM/TPM come only from the hot ring, so for the first minute after a restart they read `unknown`, not `0`.** Report both `sliding24h` and `sinceReset` (default UTC midnight) — a sliding window benches a provider well past its actual reset.

### 4.6 Limits — four rungs, each labelled

1. **`operator`** — `ProviderConfig.limits?: {rpm,rpd,tpm,tpd,resets}` plus per-model override. Highest rank: the operator knows their plan, and no probe discovers a monthly cap. This is precisely the tunable the recalibrated rule clears.
2. **`provider-stated` (headers)** — the `limit` half of `extractRateLimitCounters`. Cheapest source; needs no refusal.
3. **`learned`** — parsed from a refusal body, port freellmapi's `parseProviderLimit` **with its discipline**: it requires both a numeric limit and a confident axis and refuses to guess the axis — the same rule `src/context-limits.ts:12-16` already enforces. Store as a new `FactKind "rate-limit"` in `src/target-facts.ts`, and ⚠ **exclude it from `CONDITIONS`** (`:141`) exactly as `context-limit` is excluded, or one success erases a learned ceiling (`:349-353`).
4. **none** ⇒ `null` ⇒ **no gate**. Same doctrine as the context guardrail: unknown limit ⇒ no guardrail. **Never fill it with a speculative default.**

### 4.7 Gating — demote-only, by construction

New `src/admission.ts` with a two-member verdict type: `"live" | "throttled"`. **There is no `skip` and no `deny`.** The failure mode "gates so hard the pool won't dispatch" cannot be configured into existence, because no code path removes a candidate.

`targetUsability` (`src/server.ts:948-956`) gains one band, giving `live → throttled → credential-fault → cooling` in `orderByUsability` (`:1018-1043`). **`throttled` sits above the other two** because band order follows strength of evidence that the request will fail: `throttled` is the relay's own prediction; `credential-fault` is the provider having actually returned 401/403; `cooling` is observed failure or a provider-stated fact. Prediction ranks below observation — the same ladder `getStrength()` and `contextWindowResolver` use.

Three independent inputs, each with a silent off-switch: **lease saturation** (cap default `null` = off), **window budget** (no known limit ⇒ no opinion), **headroom** (`quotaPercent < floor`; never observed ⇒ no opinion, matching the neutral-50 doctrine). ⚠ **Do not multiply `deploymentFitness`** the way freellmapi does — that lets an operational signal move capability order, which the comment at `src/server.ts:483-492` exists to prevent. Banding demotes without renumbering fitness, and sort stability preserves fitness order within a band.

**Demotion is not a weaker skip — it is a strictly better one.** The walk terminates at the first success, so a candidate demoted below every live member is never reached while any live member serves. Demotion delivers the whole benefit of skipping in the normal case and degrades to "try it anyway" in the case that matters. The only visible difference is that `x-llm-relay-pool-attempts` now shows the throttled member tried last rather than not at all — more honest, not less.

Testable property, pinned: with all gates dark, `orderByUsability` returns a byte-identical array; with all gates firing on every member it returns a **permutation** — never a shorter array.

**Provider-stated exhaustion is untouched.** `cooledByAllowance` already demotes it via `cooldownUntil` (`src/server.ts:930-937`). Promoting it to exclusion now would be a regression against a rule still in force.

### 4.8 In-flight leases — CONFLICT RESOLVED

GATING's lifetime analysis is correct and is why this is cheap: attach the lease to `HealthAttempt`, acquire at the two existing `beginHealthAttempt` sites (after every gate has cleared, immediately before dispatch — copy freellmapi's ordering so a rejected candidate never consumes budget), release inside the three existing `completeAttempt*` helpers beside `attempt.completed = true`. For a streamed response terminal completion is reached only after the body drains, and the routing-level `finally` (`src/server.ts:872-885`) terminalizes every attempt even on a throw. **No new lifetime machinery, no new `finally`.**

⚠ **Do not copy freellmapi's flat 2-minute `LEASE_MAX_AGE_MS`.** Once a stream is committed llm-relay's total deadline disarms and only inter-byte silence aborts (`withStallWatchdog`, `src/server.ts:1107-1125`), so a flat cap would expire exactly the long generations that most occupy provider capacity. Derive expiry from the attempt's own deadline and re-arm it in the same transform that re-arms the watchdog — one clock, one place. The backstop can afford to be lenient precisely because a leaked lease costs at most a reordering.

### 4.9 Read surface

`llm-relay usage` (per credential / provider / deployment, `--window`, `--since`), per-credential spend in `llm-relay keys`, raw un-blended columns in `candidates` (`quotaPercent`, `rpmUsed/limit`, `leases`, each with its basis — **no blended headroom score**), `GET /usage` on the admin routes, five metadata-only additions to `LOG_FIELDS` (`inputTokens`, `outputTokens`, `tokensBasis`, `costMicroUsd`, `costBasis`), and finally **`x-llm-relay-quota-percent` + `x-llm-relay-stability-score`**, advertised at `docs/reference.md:768` since `3353e94` and never once implemented. Every gate decision is announced in a response header alongside `x-llm-relay-degraded` / `x-llm-relay-pool-attempts` — an unannounced routing change is indistinguishable from getting what you asked for.

---

## 5. RISKS

### 5.1 Token counting vs metadata-only logging — resolved, but write the boundary down first

**The metadata-only invariant is not an obstacle, and the substrate already exists.** `stream_options: {include_usage:true}` is already sent (`src/backend.ts:495`); `src/sse.ts:116-117` already merges `usage` from `message_delta`; `src/backend.ts:675,684` already maps `prompt_tokens`/`completion_tokens`. None of that retains prose. **Boundary to write down: the meter may hold ONLY the integers plus the (provider, model, credential-name) identity, and must never accumulate a body to get them.**

Five concrete traps, all verified:

1. **Do not reuse `acc`.** `src/server.ts:2062-2072` (and `:2235` in the repair path) builds a full decoded string for *validation*, bounded by `MAX_VALIDATE_BYTES` (`:200`). A meter reusing it would put whole bodies in memory on every tool-less streaming turn that today is a pure pipe. Build a bounded incremental frame scanner.
2. **Streaming tool-less turns are currently never parsed at all** — accumulation is gated on `ctx.willValidate = isMessages && hadTools && status < 400` (`src/server.ts:793,2066`). Metering adds a parse to that path for the first time. It must also **survive the 8 MiB overflow give-up at `:2068`**, or it silently under-counts exactly the largest turns.
3. **Read the LAST usage in the stream, never the first.** `src/emitSse.ts:31-38` emits `usage.output_tokens = 0` in `message_start` — correctly, by protocol, and only when the backend reported usage at all. A naive first-usage scanner records `0` for every repaired streaming turn.
4. **Tap the upstream response, never the client-facing stream.** `repairStreamingPath` re-emits corrected trailing blocks via `emitSseTail` rather than the backend's bytes (`src/server.ts:2189-2244`). Counting what the client receives meters the relay's own serialization.
5. **⚠ Anthropic cache tokens are dropped by the relay's own type.** `AssistantMessage.usage` is `{input_tokens?, output_tokens?}` (`src/anthropic.ts:66-69`) and `emitSse` copies only those two. Anthropic reports `cache_creation_input_tokens` and `cache_read_input_tokens` separately and they price very differently. **Claude Code is a heavy prompt-cache user, so an input count that folds cache reads into plain input over-states cost on the exact lane the owner most wants metered** — and note this also means the relay currently strips cache accounting from what it forwards to clients. See open question 4.

### 5.2 Double-counting across failover and repair

- **The walk.** Up to 12 discarded candidates per served turn, each having spent input tokens on its own credential. Solved by the `role` field (§4.1) — **do not build a scalar `tokens` counter**; the served/discarded split is unrecoverable after the fact, the same mistake `candidates.ts` documents about blended scores.
- **Discarded spend is structurally unmeasurable.** Error bodies carry no usage, and `src/backend.ts:816-819` explicitly refuses to manufacture one ("a usage object with no numeric fields is not a measurement"). Walk spend can only ever be `estimated`; served spend is `stated`. **Record both, label both, never sum them into one figure.** This is where the recalibrated rule still has teeth.
- **⚠ Reshaper spend is 100% invisible and charges an account no ledger knows exists.** `HttpReshaper` reads `process.env[this.cfg.authEnv]` directly (`src/reshaper.ts:180`) and issues its own `fetch` (`:216`) — never through `resolveTargets`, `beginHealthAttempt`, the breaker, or `recordModelCall`. `FailoverReshaper` may walk several delegates (`:139-159`) and `repair()` may reshape up to `maxAttempts` times, so one client turn can generate `maxAttempts × delegates` extra upstream calls. Repair is by design pointed at weak/free models where quota is tightest. **Instrument `reshaper.ts` with `role: "repair"` or the repair lane is entirely unmetered.**
- **Client-facing and provider-side numbers will legitimately disagree — document it, do not "fix" it.** `withEnvelopeOf` deliberately reports the *backend's* usage to the client (`src/repair.ts:264-281`, comment states the reasoning: reporting the reshaper's usage would make the client meter and attribute wrongly). Someone reconciling the two will find the gap and be tempted to close it. **The gap is the design.**
- **Cancelled streams under-count and the provider still bills.** A client disconnect returns early at `src/server.ts:2102-2105`, leaving the routing `finally` to record cancellation; the `message_delta` usage frame never arrives while upstream generation may continue. **Record `cancelled, output unknown` — never `0`.**
- **Headers reconcile, never sum** (§4.3). Adding a counter reading to an increment double-counts.

### 5.3 Concurrent JSON counters

`src/write-behind.ts` is a debounce timer — `touch()` re-arms a `setTimeout`, `clear()` cancels it. That is the whole class. Verified assessment:

- **NOT a defect:** intra-process increments are safe. `m.totalCalls += 1` (`src/ping/runtime-telemetry.ts:107-110`) is synchronous with no await, so Node's single thread makes concurrent-request increments atomic. Nobody should invent a mutex.
- **Crash window:** up to `MAX_FLUSH_DELAY_MS` (2s) of increments vanish on a hard kill. Acceptable for telemetry; for a meter, mitigate with the ledger's own eager flush on rollover plus the existing shutdown path — and accept the residue.
- **Stale-snapshot flush:** `scheduleRuntimeTelemetryFlush` captures `data` at schedule time (`:78-80`); a `reload: true` between schedule and fire writes the stale object over the fresh one. Same shape at `src/ping/probe-cache.ts:111-114`. The ledger must capture at flush time, not schedule time.
- **Multi-process lost update — already live in this repo** (`eligibility accept` vs the relay's whole-document shutdown flush, §4.5). Solved for the ledger by sole-writer + HTTP reads; **worth fixing separately for the interpretation store.**

### 5.4 Failure direction — the design must fail toward dispatching

Under-count ⇒ a spent key is dispatched ⇒ 402/429 ⇒ `classifyStatus` marks it retriable (`src/server.ts:1069`) ⇒ the walk moves on, the breaker cools it, `allowance-exhausted` learns the truth from the provider's own words. **Cost: one round-trip. That is today's working behaviour and it self-corrects.**

Over-count ⇒ the deployment is not dispatched ⇒ no response ⇒ no usage frame ⇒ **no correction** ⇒ it never comes back. Silent, permanent, self-reinforcing capacity loss with no upstream signal to break it. Requirements that make it fail safe: (1) the gate demotes only; (2) the gate fires only on `stated` usage, never on `estimated`; (3) any success on that credential clears the gate; (4) every gate decision is announced in a header.

### 5.5 Nothing to gate against, yet

The catalog harvests context ceilings, output caps and prices — **no rate or quota limits**. Until §4.6 rungs 1-3 land, the window gate has no input on most providers and correctly does nothing. Do not let that argue against **recording**, which needs no limit at all. That conflation is exactly what killed the ledger in 2026-08-13.

---

## 6. PLAN

Effort in focused engineer-days; each stage is independently shippable and green.

### Stage 1 — "Count what already arrives" (S, ~1 day)

The smallest thing that makes metering real: **provider-stated token counts stop being discarded.**

- Extend `recordCall` at `src/server.ts:1262` to pass `completionTokens` (and add `promptTokens`) from the usage the relay has already parsed — **on both fronts**, per the "two paths, one policy — never one empty" rule. Fixes the structurally-always-zero `totalCompletionTokens` (`src/ping/runtime-telemetry.ts:22`) rather than shipping a second counter beside it.
- Incremental SSE usage tap (last-usage-wins, upstream side, survives overflow) per §5.1.
- Add `inputTokens`, `outputTokens`, `tokensBasis` to `LOG_FIELDS` (`src/log.ts:77-93`) — metadata, allow-listed deliberately.
- Emit `x-llm-relay-quota-percent` and `x-llm-relay-stability-score`; both inputs already exist (`src/circuit-breaker.ts:412`, `benchmarks`). Closes a doc claim that has been false since `3353e94`.
- Record `cancelled ⇒ unknown`, absent ⇒ `null`, never `0`.

**Deliberately excludes:** any new store, any credential dimension, any window, any limit, any gating, any cost arithmetic, any lease. After Stage 1 the owner can answer "what did each deployment generate" from `/telemetry` and the log — which is more than the project has ever been able to answer.

### Stage 2 — Credential dimension, windows, read surface (M, ~3 days)

`src/usage-ledger.ts`; env-name keying + in-memory rotation epoch; role split (`served`/`discarded`/`repair`, including instrumenting `src/reshaper.ts`); hot ring + bucketed `usage.json`; per-store `WriteBehindTimer` cadence; `llm-relay usage` + `GET /usage`; sole-writer discipline and **no `--path` flag**.

### Stage 3 — Limits (S–M, ~2 days)

`ProviderConfig.limits?` (operator); `extractRateLimitCounters` raw pairs + drift reporting; `FactKind "rate-limit"` learned from refusal bodies, excluded from `CONDITIONS`. Unknown ⇒ `null` ⇒ no gate.

### Stage 4 — Cost join (S, ~1 day)

Multiply Stage 1's usage by `resolveMetadata()`'s already-provenance-labelled prices; `costMicroUsd` + `costBasis` into the ledger and `LOG_FIELDS`; `assumed-free` renders with `assessCost`'s basis.

### Stage 5 — Headroom band (S, ~1 day)

`src/admission.ts` with the two-member verdict; fourth band in `targetUsability`/`orderByUsability`; header announcement; the permutation-never-shorter test. Ships before the window gate because its input (`quotaPercent`) already exists and is provider-stated.

### Stage 6 — Window gate + in-flight leases (M, ~3 days)

Window band fed by Stage 2+3; `src/attempt-lease.ts` modelled on `src/session-pin.ts`, attached to `HealthAttempt`, deadline-derived expiry, cap default `null`.

### Stage 7 — Multi-credential (M, ~3 days), only if the owner runs more than one key per provider

`ProviderConfig.authEnvs?: string[]` with deterministic selection; credential as a component of the breaker/fact key; declared `quotaPools`; `accountCaps`. **Sequenced last because with one key per provider it delivers nothing.**

### Parallel small wins (not blocking)

`.env` permission enforcement + reporting on the `control-token` footing (`src/onboarding.ts:191-194`); `routing.fitnessWeights` and `routing.preferences` (both S, both independent of the ledger); lifting the thinking-disabled droplist out of `src/ping/ping.ts` into a shared module.

### Explicitly not built

Thompson sampling; the exploration floor; key encryption at rest; minted per-client inference keys; the quirk registry; any verdict that removes a candidate.

---

## 7. OPEN QUESTIONS FOR THE OWNER

Five below, each a decision no amount of source-reading settles. Full text in `openQuestions`.
