# Three-axis assessment — 2026-08-28 (v0.52.0)

Scope: three questions the owner asked.

1. How well does llm-relay track available quota, rate, capability, and capacity from different sources?
2. How well does llm-relay direct traffic through a single verb?
3. How well does llm-relay function from Claude, Codex, OpenCode, and other IDEs?

## Method

Six parallel auditors read source. Each auditor returned strengths and falsifiable gaps.
Every gap then went to an adversarial verifier with instructions to refute it.
A completeness critic then read the surviving set. 66 agents ran. No agent failed.

**60 gap claims were verified. 51 were refuted. 9 survived.** The refutation rate is 85%.
Most apparent gaps in this repository are recorded trades with reasons at the code site.

The auditors read code. This document also carries **first-hand measurements against the running
relay** on `127.0.0.1:8791`, because code coverage and live signal coverage are different questions.
The live measurements are the calibrating evidence. They are what changes the grades.

## Verdict

| Axis | Grade | One-line reason |
|---|---|---|
| 1a. Quota and rate tracking | **C+** | The architecture is excellent. The live signal is nearly empty, so the breaker does the work. |
| 1b. Capability tracking | **A−** | 216 of 216 routed deployments carry exact, multi-signal capability data. |
| 1c. Capacity tracking | **C** | 141 of 216 deployments are unmeasured. The health score rewards failure. |
| 2. Single verb | **B−** | The engine is disciplined. The control panel has about 33 levers and no composed view. |
| 3. Cross-client | **A−** | The data plane is genuinely client-agnostic. Every feature above it is Claude-shaped. |

---

## Axis 1 — tracking quota, rate, capability, capacity

### 1a. Quota and rate — the architecture is strong

The relay carries seven independent quota sources. The provenance discipline is compiler-enforced:

- `availability.ts:162` closes `DERIVED_BASIS` with `satisfies Record<LimitProvenance, …>`.
- `availability.ts:481` and `:512` end the basis mappers with `const _never: never`.
- `quota-observation.ts:83` refuses a header that names two axes or an unsupported period.
- `accounting-store.ts:1155` declines the month window rather than narrowing a root aggregate.
- `hard-cap.ts:132` derives a cap's usage scope from the declaration site, not from the caller.
- Every layer keys quota per credential slot, never per provider.

Nothing here guesses. That is the project's stated invariant, and the code holds it.

### 1a. Quota and rate — the live signal is nearly empty

Measured against the running relay, 216 resolved candidates, 2026-08-28:

| Rung | Live coverage |
|---|---|
| Provider-stated headers | **3 of 216 cells** (mistral x2, groq x1) |
| — of which routing-eligible | **0.** The two mistral rows report `staleObservations: 1` and `routingEligible: false`. The groq row carries `period: "unknown"`, and `availability.ts:110` drops it. |
| Derived (`limit − localUsed`) | **0.** `localUsed` is null on every row. |
| Operator-configured `limits` | **0 declared.** `hardCap` is null on all 216. |
| Learned rate-limit facts | **0.** `target-facts.json` holds 10 facts, all conditions, no measurements. |
| Published catalogue limits | **0 of 1223** catalogued model entries. |
| **What actually gates traffic** | The circuit breaker's blind 429 and 402 escalation. |

The escalation ladder works. It is also expensive, and it is not durable:

- `nim/moonshotai/kimi-k3` — 7 consecutive unexplained 429s, cooldown 71,766,416 ms (19.9 hours).
- `gemini/models/gemini-3.6-flash` — 26 consecutive unexplained 429s, same cooldown.

The relay learned both facts by paying 33 failed requests. **`circuit-breaker.ts` performs no file
IO.** Its state is `private states = new Map()`. Restart the relay and all of it is lost — the
cooldowns, the escalation ladder, the credential faults, and every stored quota observation.

Persisted state is `target-facts.json`, `probe-cache.json`, `runtime-telemetry.json`, and `usage/`.
`CLAUDE.md` states the project delivers "health that survives restarts". That is true for ping
health. It is false for the breaker.

### 1b. Capability — this axis is genuinely strong

Measured on the same 216 candidates:

- **216 of 216** report `capabilityMatch: "exact"`. Zero fuzzy matches. No borrowed SKU scores.
- **216 of 216** report `strengthBasis: "snapshot"`. The neutral-50 fallback never fires.
- Signal depth: 115 cells at 3 signals, 88 at 4, 10 at 2, 3 at 5.

The routed population is far better covered than the raw snapshot, which holds 203 models at 0
signals and 421 at 1 signal. The join is doing real work.

Metadata coverage is honest and labelled: 146 provider-published context lengths, 69 marked
`reference`, 1 null. Prices split 144 / 70 / 2. `maxOutputTokens` is null for 72 cells (33%).

Four capability sources contribute. Artificial Analysis reports `configured: false` and
`model_count: 0`, so it contributes nothing today.

### 1c. Capacity — measured, and the measurement is inverted

**141 of 216 deployments report `health.verdict: "Not Active"`.** 65% of the routed fleet carries
no capacity measurement at all.

The score that ranks the rest rewards failure. `ping/metrics.ts:27` defines
`MEASURABLE_CODES = {"200","401"}`. `getP95` and `getJitter` — 60% of the composite weight — read
only that subset. `getUptime` reads all samples and carries 20%. A deployment that fails with 403,
404, 429, or 5xx therefore leaves 60% of the weight and stays in the 20%.

Reproduced on live probe data:

- `openrouter/x-ai/grok-build-0.1` — 1 success in 12, eleven 403s — scores **81**.
- `gemini/models/gemini-3.5-flash` — 3 successes in 3 — scores **27**.
- **27 deployments with zero successes score above 50.** The all-401 `opencode/*` block scores 76–78.

This reaches routing. All four of this operator's pools are `{preferred: [], include: "free"}`, so
`dynamic-pools.ts:46` feeds this score into `benchmarks.ts:203`, and it decides the whole pool order.
The module's own comment at `ping/metrics.ts:21` claims a 401-only target is "capped accordingly".
The arithmetic does not deliver that cap.

A related face of the same defect: an all-402 deployment returns `-1`, which becomes a null
stability score, which becomes the neutral 50. The 24-row `kilo/*` block therefore also outranks
the all-success gemini rows.

### The cross-cutting cause

One pattern explains most of axis 1. **"Refuse to guess" is implemented as poison-the-total rather
than report-what-was-measured.** Each rule is individually correct. Together they produce silence:

- `accounting-store.ts:608` nulls a cumulative token cell when one attempt reports nothing. Live
  `lifetime.json` shows **every** token value null, despite 8,327 known `reportedInput` observations.
- `availability.ts:110` drops every unknown-period observation, which is the shape this fleet
  actually receives.
- `benchmarks.ts:170` requires an exact match plus 3 or more signals.

A second pattern reinforces it. **Every knowledge lane that binds automatically has produced output.
Every lane gated on a human `accept` has produced zero.** `refusal-interpretations.json` holds
`confirmed: 0` against `unknown: 200` and 3,968 occurrences. 163 of those 200 signatures carry
explicit allowance wording. The research queue is a backlog, not a feedback loop.

### A contradiction between two live consumers

`availability.ts:110` drops an observation whose header names no period.
`credential-select.ts:96` `headroomBand` never reads `period` at all. It filters on basis and
freshness only. Both run on every request. They apply opposite rules to the same observation.

This is inert today, because no provider declares a `credentials` fleet. The first fleet the
operator configures activates an untested interaction between three ordering layers.

### The recorded rationale is falsified by live data

`quota-demotion.ts:50` justifies excluding unknown-period buckets: "a bucket without a known period
cannot reach a boundary to expire at". The live groq observation states its own reset:

```
{axis:"requests", period:"unknown", limit:1000, remaining:999,
 resetsAt:1787926130775, observedAt:1787926044375, basis:"provider-stated"}
```

`resolveResetsAt` rung 1 reads `observation.resetsAt` directly. The boundary the comment calls
unreachable is stated on the wire. `collectQuotaBuckets` discards the row before that rung runs.

### Cooling-band order ignores lift time

`server.ts:2002` `orderDeploymentGroupsByUsability` builds three bands and preserves fitness order
inside each. The cooling band is therefore ordered by fitness, not by soonest lift. When a pool is
entirely cooling — the exact state this install reached — the walk can try a member that lifts in
19 hours before one that lifts in 2 minutes. `state.cooldownUntil` is already on the breaker, so the
sort key is in hand. A `walkBudgetMs` bounds the damage in wall-clock time, not in wasted attempts.

### Levers for axis 1

1. **Admit an unknown-period observation that carries its own `resetsAt`.** Keep it as a distinct
   bucket. Keep the existing type discipline everywhere else. This converts the fleet's most common
   header shape from inert to usable. It needs no new dependency and no new store.
2. **Fix the stability composite.** Compute p95 and jitter over successes, then scale the composite
   by measured uptime instead of adding uptime as a 20% term. This is a few lines in
   `ping/metrics.ts:72`.
3. **Persist the breaker's cooldowns and escalation ladder.** A restart today discards 20 hours of
   learned exhaustion, and the relay re-walks into the same walls.
4. **Sort the cooling band by soonest lift.**

---

## Axis 2 — directing traffic through a single verb

### There is no single verb, and the count is about 33

Two independent auditors enumerated the steering surfaces and both reached 33 or 34. At least 8 are
consulted on every request. The list spans config keys (`routing.default`, `tiers`, `pools`,
`subagents`, `offload`, `sticky`, `ladders`, `cliLane`, `quota`), model-spec syntax
(`pool/<name>`, `provider/model`, tier substring match), a per-request `@relay:` directive, a
`PreToolUse(Agent)` hook, and 21 CLI commands.

### What is genuinely good

- **Every routing mutation validates the complete resulting config before it commits**
  (`config-edit.ts:35`). No CLI edit can leave an unloadable file.
- **The live-versus-restart split is announced at every mutation site** (`cli.ts:2226`, `:2825`,
  `:1893`). The two live-only controls refuse rather than pretend.
- **Every steering ambiguity fails loudly.** An unknown pool is a 400. An unresolvable `@relay:`
  raises a `RoutingError` rather than falling through to primary quota (`config.ts:747`).
- **Every automatic reroute is announced on the wire** — `x-llm-relay-served-by`,
  `-pool-attempts`, `-degraded`, `-quota-demoted`, `-capped`, `-unknown-refusal`. This is what
  makes the multiplicity survivable in practice.
- **Model addressing precedence is documented in one place** (`docs/reference.md:404`,
  first match wins). Subagent precedence is documented at `config.ts:720`.
- **The positional-arity guard** means no steering command silently discards an argument.

### What is missing

**Composition.** Nothing answers "given model X from client Y, where does the request go, and why".
The precedence chain is correct, and it is documented in four separate places: model addressing at
`reference.md:404`, offload at `:884`, the `freeOnly` guard, sticky sessions, quota demotion, and
hard caps each in their own section.

**The most common intent takes two verbs with two liveness models.** To send subagents to a free
pool the operator runs `routing subagent <tier> <spec>` (file only, restart required) and
`offload claude on` (live). The destination half is inert until the switch half is flipped. The CLI
prints a warning for the half-configured case (`cli.ts:2242`), which is good, and which also shows
the trap is real.

**Two read verbs over the same pools read differently** — though less badly than this assessment
first said. `routing show` prints `"pools": {"low": [], …}` because `loadConfig` splits a dynamic
pool into an empty `pools` array plus a `poolPolicies` declaration, and members are materialized at
runtime; `llm-relay pools` prints 216 members each. **Correction:** an earlier draft called this a
flat contradiction. It is not — `routing show` prints `poolPolicies` immediately below, showing
`{preferred: [], include: "free", effort: "low"}`, so a reader who sees the whole output has the
explanation. The first draft's evidence came from a probe script of mine that filtered the output
down to `.pools`, which manufactured the contradiction it then reported. Left unchanged.

**HELP drift is real and verified today.** `CLI_COMMAND_NAMES` holds 21 names.
HELP omits `lanes` and the `route` alias entirely (0 matches each). HELP documents a `setup`
target `claude-cli` that matches no branch — `cli.ts:3350` tests only `claude-desktop`/`desktop`
and everything else falls through. A verifier reproduced this: `llm-relay setup clade-desktop`
(a typo) printed the Claude CLI setup and exited 0. HELP is not pinned by any test.

**`llm-relay lanes` is undiscoverable.** It appears in no HELP text, and in no user-facing document.
`cli.ts:1782` is the only writer of `~/.llm-relay/lane-manifest.json`. An operator who never learns
the command never gets lane eviction. The miss is fail-safe, so the cost is a dormant feature.

### Lever for axis 2

**Add one composed read verb, not a new subsystem.** `llm-relay route <model> [--client <name>]`
should print the resolved candidate order and name the rule that produced each position. The alias
`route` already exists, undocumented, as a synonym for `routing`. Every input it needs is already
resolved in one place in `handle()`. This answers the question that four doc sections currently
answer separately, and it makes the 33 levers legible without removing any of them.

Second, cheaper: **pin HELP against `CLI_COMMAND_NAMES` with a test**, and make an unrecognized
`setup` target an error instead of a silent fall-through.

---

## Axis 3 — Claude, Codex, OpenCode, and other IDEs

### The data plane works, and I verified it live

All six front-protocol x backend-kind cells are implemented and covered by end-to-end HTTP tests.
22 test files exercise `/v1/chat/completions`; 13 exercise `/v1/responses`.

Verified against the running relay:

| Test | Result |
|---|---|
| `POST /v1/chat/completions`, `model: pool/low`, non-streaming | **200.** `served-by: openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`, `pool-attempts: 3 tried, 1 served: 2x402, 1x200`. 51.6 s. |
| `POST /v1/chat/completions`, `model: pool/medium`, streaming | **200.** `text/event-stream`, real SSE frames, byte-transparent. |
| `POST /v1/responses`, `model: pool/low` | **200.** Correct Responses shape, `output` and `output_text`. |
| `GET /v1/models`, no credential | **200.** Returns 5 ids: `anthropic`, `pool/low`, `pool/medium`, `pool/high`, `pool/xhigh`. |
| `POST /v1/chat/completions`, `model: gpt-4o` | **401** from Anthropic. The model fell to `routing.default`. |

The `/v1/models` result is an undocumented strength. A generic IDE shows a four-pool dropdown, and
each pool gives it ranked failover across 216 free deployments. That is the best possible IDE
experience, and no user-facing document mentions it.

Other real strengths:

- **Non-`/v1` path spellings are served**, so a base URL with or without `/v1` both work.
- **`GET /v1/models` is exempt from the control token**, which is what lets a third-party IDE
  enumerate models at all. An IDE cannot carry `~/.llm-relay/control-token`.
- **The caller's key never egresses on the OpenAI front.** Containment is decided from the config
  declaration, so an IDE sending `Authorization: Bearer sk-cursor-…` has it stripped.
- **Codex subagent detection through `x-codex-turn-metadata` is real**, and a verifier exercised it
  end to end over HTTP.
- **Codex client wiring is automated.** `scripts/install-skill.mjs` writes the Responses provider
  block and two child agents, and refuses to overwrite what the user already has.

### The feature plane is Claude-shaped

`config.ts:659` `clientForPath` derives client identity from the **path only**:

| Path | Client name |
|---|---|
| `/v1/messages*` | `claude` |
| `/v1/responses`, `/responses` | `codex` |
| `/v1/chat/completions`, `/chat/completions` | `openai` |
| anything else | `default` |

So Cursor, Continue, Cline, Zed, aider, and OpenCode all identify as `openai`. Per-client offload
rules are really **per-protocol** rules. This is a deliberate, documented decision —
`unroutableOffloadClient` refuses a rule named `cursor` and names the four valid keys — and it is
still the ceiling on how finely traffic can be steered by origin.

Claude-only features, and how a non-Claude client degrades:

| Feature | Non-Claude client |
|---|---|
| `PreToolUse(Agent)` hook | Nothing. Claude Code only. |
| `@relay:` directive | **Silently inert on the Responses front.** `config.ts:583` reads only `messages`; a Responses turn carries `input`. The directive then reaches the model as literal prompt text. |
| Host-routing detection | `unknown`. It runs in the CLI and needs `ANTHROPIC_BASE_URL`. |
| `llm-relay setup` | Two targets, both Claude. |
| Subagent detection | Claude has three signals. Codex has one. Everything else has none. |

### OpenCode has no client support in this repository

I searched the whole tree. `opencode` appears in `src/` once, in a comment in `dynamic-pools.ts:168`
about mixed provider catalogues. The `opencode.json` at the repository root is OpenCode running
**on** this repository for the `/audit-code` workflow. That is not client support.

An OpenCode user would hand-write an OpenAI-compatible provider block, point it at
`http://127.0.0.1:8791/v1`, and land in the anonymous `openai` bucket. That would work — the data
plane is protocol-generic. Nothing tells them so.

Zero mentions of OpenCode, Cursor, Zed, Continue, Cline, or aider appear in `README.md`,
`docs/reference.md`, or `docs/QUICKSTART.md`. `reference.md:1247` carries one generic sentence:
"OpenAI-native clients point their base URL at `http://127.0.0.1:8791/v1`".

### Two adoption traps

1. **`localhost` returns 403 on every request.** A verifier reproduced it live: `Host: 127.0.0.1:8791`
   is admitted; `Host: localhost:8791` returns `403 Host authority does not match the bound listener`.
   This is the correct DNS-rebinding guard. It is also the first thing an IDE user types.
2. **A fresh install contradicts the shipped documents.** `DEFAULT_CONFIG_TEMPLATE`
   (`cli.ts:361`) declares no `anthropic` provider and sets `routing.default: "pool/medium"` with
   `opus`/`fable` to `pool/xhigh`. A verifier reproduced this on a clean `HOME`:
   `resolveTargets("claude-opus-5")` returned `[]`. `QUICKSTART.md:68` says "At this point everything
   still goes to Anthropic. Nothing is saved yet — but nothing is broken either." That is false for a
   stranger following `README` plus `llm-relay onboard`, which `docs/project-goals.md:120` names as
   an explicit goal. This operator is unaffected, because the live config declares the passthrough.

### Lever for axis 3

**Write one "wire up your client" page** covering Cursor, Continue, Cline, Zed, aider, and OpenCode.
Each entry needs three lines: base URL `http://127.0.0.1:8791/v1`, any API key value, and a model of
`pool/high`. State the `127.0.0.1`-not-`localhost` rule once, at the top. Everything on that page
already works today; the gap is entirely signposting.

**Second: fix the fresh-install default so it matches the documents.** Either ship the `anthropic`
passthrough in `DEFAULT_CONFIG_TEMPLATE`, or change `QUICKSTART.md:68` and `README.md:43`. This is
the highest-severity finding of the whole assessment for a new user.

---

## Confirmed defect ledger

Nine findings survived adversarial verification. Severity is the verifier's, after calibration.

| # | Finding | Severity |
|---|---|---|
| 1 | Fresh install routes `claude-*` to free pools, contradicting `README`, `QUICKSTART`, and `SKILL.md`. | medium-high |
| 2 | `getStabilityScore` excludes 403/404/429/5xx from 60% of its weight, so failing deployments outrank succeeding ones and lead the pool order. | medium |
| 3 | `fetchOpenRouter` guards only `context_length` while the embedded `artificial_analysis` block carries one of two signals in every capability dimension. Drift would silently drop 118 deployments from every pool. | medium |
| 4 | `GET /v1/models` reports a hardcoded `context_window: 272000` for every id, `pool/*` included, against measured pool minimums of 131k–163k. Codex budgets against it. | low-medium |
| 5 | `QUICKSTART.md` lists Cerebras and Cohere, which the generated config never declares. Setting either variable is a silent no-op. Cohere has no preset anywhere in `src/`. | low-medium |
| 6 | `llm-relay lanes` appears in no HELP text and no user-facing document. It is the only writer of the lane manifest. | low |
| 7 | HELP omits `lanes` and `route`, and documents a `setup claude-cli` target that matches no branch. HELP is unpinned by any test. | low |
| 8 | A terminal buffered 4xx on the Anthropic front calls `observeEligibility` twice, so one signature's occurrence count doubles. The OpenAI front counts once. | low |
| 9 | `server.ts:2723` JSDoc names `getStrength()` as the telemetry consumer and cites a `StrengthBasis` value `"telemetry"` that commit `23f1e4a` deleted. | low, comment only |

Findings verified first-hand during this assessment, additional to the nine:

| Finding | Evidence |
|---|---|
| The request-path context guardrail never reads the learned ceiling. | `server.ts:1307` reads `catalog.cachedLimits` only. `contextWindowResolver`, whose top rung is the learned `context-limit` fact, is called only by `cli.ts:1923` and `routes/admin.ts:337`. |
| `CircuitBreaker.orderByUsability` has zero `src/` callers. | Only tests call it. `server.ts:2391` `orderByUsability` is also a test-only seam. Live ordering is `targetUsability` + `orderDeploymentGroupsByUsability`. `CLAUDE.md` calls the breaker method "the ordering API". |
| ~~`routing show` and `pools` disagree about the same four pools.~~ **RETRACTED.** | `routing show` prints `poolPolicies` beside the empty `pools`, so the dynamic declaration is visible. The original evidence came from a probe script that filtered the output to `.pools`. |
| The cooling band is ordered by fitness, not by soonest lift. | `server.ts:2002`. |
| `candidates.ts:395` omits `published` from its `hasLimits` test; `availability-snapshot.ts:124` includes it. | Currently inert — 0 of 1223 catalogued models publish a rate limit. |

## What was refuted — do not re-raise these

51 of 60 gap claims were refuted. The recurring reasons are worth recording:

- **`period: "unknown"` observations are dropped by design.** `docs/quota-metering-spec-2026-08-16.md`
  §5.4 states the rule verbatim. The *narrow* exception argued above — an unknown-period observation
  that states its own `resetsAt` — is new, and it is the only part not covered by that decision.
- **`clientForPath` identifies by protocol front door, not by product.** No client needs a name.
- **`candidates.ts:407` hardcodes `localUsed: null` deliberately.** The docstring at
  `candidates.ts:363` says so in the word "deliberately".
- **Loopback admission checks (`Host`, `Origin`, `content-type`) are a documented, tested boundary.**
- **The `/v1/messages`-only scope of tool-call validation is an explicit design commitment.**
- **Codex wiring through `postinstall` is the primary documented install path, not a leftover.**

## Owner decisions — ANSWERED AND SHIPPED, 2026-08-28

All four were put to the owner and all four were approved. They are implemented in this repository;
the decision text is kept because the reasoning outlives the commits.

| Decision | Answer | Commit |
|---|---|---|
| Unknown-period observations that state their own reset | **Admit them** | `feat(quota): admit an unknown-period observation that states its own reset` |
| The stability composite | **Rescale by uptime** | `fix(health): scale the stability score by availability…` |
| Breaker persistence | **Persist cooldowns and the ladder** | `feat(health): persist breaker cooldowns and the 429 escalation ladder` |
| The fresh-install contradiction | **Fix the template**, and have the agent ASK on first use | `feat(onboarding): ship a template that matches the docs, and ask on first run` |

Measured effects, recomputed against this operator's own live data after the change:

- Zero-success deployments scoring above 50 fell from **27 to 0**; `openrouter/x-ai/grok-build-0.1`
  fell from **81 to 8**.
- The groq shape (`period: "unknown"` with a stated `resetsAt`) now reaches the demotion ladder
  instead of being discarded.
- A restart no longer discards a 19.9-hour cooldown learned from 7 failed requests.
- A fresh install resolves `claude-opus-5` to the Anthropic passthrough with no keys configured.

Three things worth keeping from the implementation:

1. **My own negative-control test caught a hole in my own fix.** `resolveRemaining` rung 2 still
   subtracted a ledger figure for an unknown period, returning `-39`. The rule now lives in the
   exported pure function rather than in each caller.
2. **The first-run test caught a defect worse than the bug.** Declaring the Anthropic passthrough
   makes `mode: "repair"` a hard load error without a `reshaper`, so the template as first written
   would have made *every* fresh install fail to start.
3. **The breaker fix was mutation-checked.** Neutering `restoreCooldowns` to `return 0` fails
   exactly the two tests that claim state survives a restart.

## Remaining open items

None of the four decisions is outstanding.

**CLOSED 2026-08-28 evening (v0.54.0), the five-lane follow-up sprint:** findings 3, 4, 5, 8
and 9 (the OpenRouter `sync-tiers` drift guard; the hardcoded 272,000 `context_window` on
`GET /v1/models`, now resolved through the same machinery as dispatch with 272,000 kept only
as the named fallback for an unresolvable id; the Cerebras/Cohere template declarations plus a
live-verified Cohere preset; the double `observeEligibility` count; the `recordCall` JSDoc) —
plus the two residues this section had named: the cooling band now orders ascending by soonest
known lift on both fronts, and `headroomBand` declines an observation from a lapsed UTC
period. All implemented on relay free-pool/pinned-member lanes and adversarially checked;
three of the five lanes' regression tests had to be rewritten because they passed on the
un-fixed tree.

Still open, deliberately:

- **The learned context ceiling still never reaches the request-path guardrail.**
  `server.ts` reads `catalog.cachedLimits` only. Not raised as a decision because the store holds
  zero `context-limit` facts today, so the fix would be unobservable either way.
- **`CircuitBreaker.orderByUsability` still has zero `src/` callers.** `CLAUDE.md` no longer calls
  it "the ordering API"; the dead code itself is left, and its tests pin a function the router does
  not call.

---

## Friction hit while implementing the four decisions

Rewalked from the transcript, separate from the assessment's own friction below.

1. **A Git Bash heredoc plus Python string escaping failed twice on source patches**, once with
   `unexpected EOF while looking for matching '` on a 130-line markdown document, and once with a
   bare `AssertionError` on a block whose text I had verified byte for byte with `cat -A`. Both
   succeeded immediately through the `Edit` tool. Do not push source patches containing backticks,
   `${...}` or escaped newlines through a heredoc.
2. **The architecture-map guard is the only thing that demands a `CLAUDE.md` row for a new module**,
   and it fails at the end of a full `npm run check` rather than at `typecheck`. Add the row when
   the file is created, not when the gate tells you.
3. **`npm run check` is the only place three separate guards fire** — the architecture map, the
   arity coverage table, and the persistent-paths table. A packet touching `src/` in a new way
   should run the whole gate early, not just the focused suite.
4. **The publish workflow's `tier-data.json missing or empty` annotation reads as a failure and is
   a negative control** (`.github/workflows/publish.yml:219` requires the error to appear against a
   stripped fixture). Check the run's `conclusion` before reacting to an annotation.
5. **Node cannot import a Windows absolute path as an ESM specifier.** `import(".../dist/config.js")`
   fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`; use `pathToFileURL(...).href`.

## Friction hit during this assessment

Rewalked from the transcript, not from recall.

1. **The fan-out lost 21 of 24 agents to a monthly spend limit mid-run.** The failure text was a
   billing message, not a workflow error, so it did not look like a tool fault. `resumeFromRunId`
   recovered it correctly: 3 agents replayed from cache, 63 ran, 0 errored. Resume works. Use it
   instead of re-running a fan-out from the start.
2. **Workflow journal result records carry no agent label.** `journal.jsonl` gave 69 result lines
   whose `label` was `undefined`, so every one printed as `?`. I had to classify results by SHAPE
   (`r.area`, `r.refuted`, `r.overall`) instead. A verdict therefore cannot be attributed to the
   lane that produced it.
3. **A Git Bash heredoc failed on a 130-line markdown document** with ``unexpected EOF while
   looking for matching `'` `` despite `<<'EOF'` quoting. The `Write` tool succeeded on the same
   content. Do not push large markdown with backticks and apostrophes through a heredoc.
4. **The control-token header name is not discoverable from the error.** `GET /health` without it
   answers `control authorization required`. The name is `x-llm-relay-control-token`
   (`control-authorization.ts:21`), and the token is at `~/.llm-relay/control-token`. The error
   names neither. One extra clause would save the next reader a source read.
5. **Node cannot resolve a Git Bash `/tmp` path.** `curl -o /tmp/x.json` succeeded and
   `require('/tmp/x.json')` then failed with `MODULE_NOT_FOUND`. Write to the scratchpad instead.
6. **A verifier agent left `cfg2.json` in the repository root** — a throwaway fixture with a fake
   key and an ephemeral port. Removed in the assessment commit. This is the recorded
   "reviewer shells leak junk files" pattern, seen again. Check `git status` before every commit.
7. **A free-text grading field invited the critic to renumber the axes.** It graded capability and
   capacity under `axis2_single_verb`, and the tracking-to-routing seam under `axis3_cross_client`,
   so neither the single-verb axis nor the cross-client axis received an overall verdict. Name each
   axis inside its own schema field description.
8. **`llm-relay routing show` reporting four empty pools cost real time.** I doubted the live config
   until `llm-relay pools` reported 216 members each. That is finding 3 in the ledger above, and it
   is also friction: the first read verb an operator reaches for is the misleading one.
