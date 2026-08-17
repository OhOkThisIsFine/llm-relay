# llm-relay status, re-derived — and what freellmapi still has (2026-08-16)

**Verdict up front: the revival is complete and the existing comparison docs hold up. The code is
green and essentially closed; the *documentation* is not.** Of 373 claims extracted from the seven
comparison/porting/adoption documents across both trees, 5 are false and none of the five changes a
routing or safety decision. The consequential errors are not in those documents — they are in this
repo's own `CLAUDE.md` and `docs/reference.md`, and in the global operator notes.

One genuinely new code gap was found (§3.1, the tool-call rescue path commits recovered destructive
calls unchecked). Everything else on the "absorb from freellmapi" list is either already landed,
already rejected on record, or correctly waiting for a real sighting.

## 0. How this was produced

Deliberately **not** by reading the existing comparison docs and summarizing them. Both capability
inventories were re-derived from source (185 llm-relay capabilities, 152 freellmapi), every checkable
claim in all seven documents was extracted (373) and then adversarially verified against code, and
the gate was run live rather than quoted.

| | |
|---|---|
| Claims extracted | 373 (65 adopted, 43 skipped, 20 deferred, 49 gap, 196 assertion) |
| Verdicts returned | 375 (two claims split during verification) |
| **TRUE** | **251** |
| **PARTIAL** | **88** |
| **FALSE** | **5** |
| UNVERIFIABLE | 31 (one-shot runtime measurements — suite counts, a DB byte size, a token-cost ratio — that no source read can reconstruct) |

Sources audited: `docs/alternatives-review-2026-08-09.md`, `docs/freellmapi-gap-proposals-2026-08-10.md`,
`docs/freellmapi-adoption-review-2026-08-13.md`, `docs/adoption-round2-decisions-2026-08-14.md`, and
`~/freellmapi/{COMPARISON-FREELLMAPI-VS-LLM-RELAY,PORTING-FROM-LLM-RELAY,PORT-BACKLOG-2026-08-11,
OFFLOAD-DESIGN-2026-08-11,E6-OFFLOAD-MEASUREMENT-2026-08-11,SETUP-STATE}.md`.

⚠ **Two verifier "corrections" were themselves wrong** and were caught by re-checking source; both
would have moved a conclusion. They are recorded in §3.4 and §4.1 rather than deleted, because the
failure mode — a verifier seeing a ranking input and concluding no filter exists — is instructive.

## 1. Status — measured, not quoted

- **Version.** `package.json` = `0.36.1`; HEAD = `428fcd2 chore: release v0.36.1`; npm `latest` =
  `0.36.1`, one dist-tag. Tree, tag and registry agree — nothing unreleased on `main`, nothing newer
  on npm.
- **Gate.** `npm run build` exit 0, zero diagnostics. `npm run check` exit 0: both typechecks silent,
  vitest **67/67 files, 1135 passed | 4 skipped**, 4.95s. The 4 skips are `it.skipIf(win32)`
  POSIX-permission tests ([offload-atomic.test.ts:117](../test/offload-atomic.test.ts:117),
  [onboarding.test.ts:179](../test/onboarding.test.ts:179)) — CI's ubuntu leg is the only place
  secret-file mode is covered, so a local green run is not full coverage.
- **Size.** `src/` 61 files / 20,119 lines; `test/` 67 files / 16,850 lines. Two runtime deps
  (`ajv`, `llm-bridge`).
- **CI.** `ci.yml` runs `npm ci --ignore-scripts` → build → check → postinstall-inertness probe,
  actions SHA-pinned. `publish.yml` is tag-only Trusted Publishing with four gates including the
  packed-artifact smoke test. Green at HEAD.
- **Running now.** `127.0.0.1:8791` = PID 51008, the **global npm install** at 0.36.1 — the running
  binary is not stale relative to what shipped. `/telemetry` reports 15 active providers (2 measured
  healthy, 13 unmeasured — a cold ping loop, not 13 dead providers). It is serving real inference:
  `runtime-telemetry.json` shows `lastCalledAt 2026-08-16T09:51:40` on
  `nim/deepseek-ai/deepseek-v4-flash-0731`, 1897 calls. freellmapi (:3001) and headroom (:8787) are
  both up alongside it.

**Two liveness gotchas worth pinning:**

- `GET /health` and `/ping` on **8791 return 403 `control authorization required`** by design —
  they are in `CONTROL_ROUTES` ([server.ts:85](../src/server.ts:85)). Only `/v1/models`, `/models`,
  `/offload`, `/dispatch`, `/telemetry` are tokenless reads. **A liveness check must hit
  `/telemetry`.**
- `curl 127.0.0.1:3001/health` **returns 200 unconditionally** — that is freellmapi's SPA catch-all,
  not a health endpoint. The real route is `/api/health` (auth-gated, 401). Monitoring built on the
  former can never fail.

## 2. Doc audit — the comparison docs are substantially right

**106 TRUE / 22 PARTIAL / 0 FALSE** across the 128 adopted-skipped-deferred claims; the 5 FALSE
verdicts all fall in the wider gap/assertion set. Nine of the 22 PARTIALs are not errors at all —
they say "item X is not built" for items the backlog itself schedules in Wave 2/3. A plan that says
"later" and hasn't happened is a correct plan.

That leaves ~13 genuine corrections out of 128, none of which changes a conclusion. The ones worth
knowing:

| Where | Correction |
|---|---|
| `COMPARISON…:13-18` | "context-window advertisement" is listed among nine capabilities ported upstream 2026-08-10. **Not ported** — freellmapi has computed `autoContextWindow` since 2026-06-21 (upstream `c5e4a34`), by the upstream maintainer, seven weeks earlier. The nine numbered PRs are all correct. |
| `PORTING…` Item 4 | "freellmapi classifies all six FactKinds" — five of six. It only *classifies* over-length transiently; `learnLimitFromError` persists TPM/TPD/RPM/RPD, never a context maximum. |
| `PORTING…` Item 7 | `rate_limit_cooldowns` is not "scoped exactly as `target-facts.ts` scopes" — one composite `(platform, model_id, key_id)` row vs four scopes resolved most-specific-first ([target-facts.ts:83](../src/target-facts.ts:83)). The backlog concedes this itself by proposing a `model_id='*'` sentinel. |
| `PORT-BACKLOG… §F L110` | "llm-relay sped UP when a human watched a TUI" — llm-relay has no TUI. Speed mode is driven by real proxy traffic via `noteUserActivity` ([cadence.ts:123](../src/ping/cadence.ts:123)). |
| `PORT-BACKLOG… §H L130` | winenv "landed as a review comment on #838" — it did not. PR #838 has zero comments and zero reviews. |
| `PORT-BACKLOG… §H L132` | MarkItDown "25MB uncapped" — each document *is* capped at 25MB with a spawn timeout ([documents.ts:96](../src/documents.ts:96)). What is uncapped is the **number** of spawns per request ([:246](../src/documents.ts:246) maps every block through `Promise.all`) — a sharper and still-valid objection. |

The five outright FALSE claims, all in the freellmapi-side notes and all explained by the docs being
pinned at `823bc34` (2026-08-10):

1. "llm-relay does not implement session affinity" — it does, since `fde98ed` (v0.36.0,
   [session-pin.ts](../src/session-pin.ts)). True when written, false now.
2. "freellmapi grades 404/410 as definitive only when status AND wording agree" — the conjunction
   holds for the 404 branch only; a bare 410 skips the corroboration gate.
3. "process env beats the settings `env` block" — reversed; the doc corrects itself 200 lines later.
4. "the freellmapi DB is not backed up anywhere" — `backup.ps1` was already copying it when written.
5. "client profiles are per-client routing chains" — they are per-client **keys plus
   server-enforced system prompts**; `PORTING…:310` has the correct reading.

## 3. What freellmapi still has that llm-relay lacks

Ranked. Every absence was confirmed by grep, not by an inventory omission.

### 3.1 Destructive-tool refusal at the dialect-rescue commit point — **ADOPT** (high)

**The only genuine code gap found, and the only one with a safety consequence.** `destructive`
appears in exactly five `src/` files — `cli.ts`, `config.ts`, `log.ts`, `repair.ts`, `server.ts` —
and in **none of** `tool-dialects.ts`, `openai-dialect.ts`, `dialect-stream.ts`.

So the guard binds only inside `repair()` ([repair.ts:52](../src/repair.ts:52), `guardReshaped` at
[:323](../src/repair.ts:323)). A **well-formed** tool call recovered from assistant prose that
validates cleanly reaches the client unfiltered — exactly as in freellmapi, whose own rescue tests
show prose being promoted into `Bash` calls. llm-relay's real advantage here is narrower than the
docs imply: it is fail-clean refusal of a **malformed** destructive call.

Claude Code declares `Bash`, and repair output may run under `--dangerously-skip-permissions`.
Fix: a name filter at the recovery commit point in `tool-dialects.ts` and `openai-dialect.ts`,
reusing `destructiveMatcher()`, announced on the existing `x-llm-relay-tool-dialect` header. Rubric 3
— the matcher, the list and the refusal outcome all exist; this is a missing call site.

### 3.2 Provider-stated quota headroom is recorded but never orders candidates — **ADAPT** (medium)

Adoption item 1.9 landed the recording half: `extractQuotaPercent` runs on live traffic
([server.ts:1537](../src/server.ts:1537)) onto breaker state. Nothing reads it for selection —
`targetUsability()` ([server.ts:948](../src/server.ts:948)) sees only breaker health and credential
faults. The value is displayed in `/telemetry` and `/candidates`, then dropped.

Rubric 4 is the whole argument: this is a figure the **serving provider stated on real traffic** —
the strongest evidence class this project recognizes — and it is currently the only such signal that
changes nothing. ADAPT, not ADOPT: freellmapi's `headroomFactor` is fed by a monthly token ledger
already rejected under the credentials-stay-user-operated invariant. Take one predicate in the
existing demotion ladder; absent header ⇒ no opinion; keep demote-never-drop.

### 3.3 Tool-call salvage from a 4xx `failed_generation` body — **ADAPT** (medium)

Groq-class providers reject their own model's tool call with a 400 and return the raw dialect text in
`error.failed_generation`; freellmapi re-runs its rescue over that field. llm-relay owns the identical
parser (`recoverToolCalls`, [tool-dialects.ts:277](../src/tool-dialects.ts:277)) and already reads 4xx
bodies on both fronts, but `classifyStatus` maps 400 to retriable and the turn is discarded. Zero hits
for `failed_generation|tool_use_failed` in `src/` or `test/`, and it appears nowhere in the 2026-08-13
review — **this was never litigated.** Caveat: groq is a configured preset but there is no measured
occurrence on this install. Any salvage must route through the validator **and** §3.1's filter.

### 3.4 Vision capability is never a routing input — **ADAPT** (medium)

⚠ *A verifier claimed llm-relay "does not gate on tools at materialization — no code filters a
candidate on capability". That is false.* [dynamic-pools.ts:220](../src/dynamic-pools.ts:220) excludes
any entry whose `supportsTools === false` from dynamic-pool membership, and `usable` feeds both the
in-band set and the degrade tail. The gap is **scoped to vision**, not to capability gating generally.

There is no vision counterpart: the catalog harvests context window, max output and prices only, and
grep for modality fields returns zero. An image-bearing request therefore discovers a text-only
backend by taking a 400 and walking, one hop per incapable member — the "N round-trips to learn one
fact" pathology [pool-eligibility.md](pool-eligibility.md) exists to kill.

Shape is constrained by rubric 4: admit a vision flag only where a source **states** it, absent means
no opinion, reject fuzzy snapshot matches (the rule `dynamic-pools.ts:38` already states for tools).
Never infer vision from a model name. Note the tools filter runs at materialization over
catalog-discovered members only — a hand-written static pool and the `preferred` prefix bypass it,
which argues for putting any vision flag in the same place rather than adding a request-time check.

### 3.5 Single-tool-call coercion for backends rejecting parallel tool calls — **ADAPT, conditional** (low)

Nothing in `src/` writes `parallel_tool_calls`, and llm-bridge emits it only when the caller supplied
it — which Anthropic-shaped Claude Code requests never do. NIM is this install's primary backend and
rejects parallel-permitting requests with a 400, but grep of `docs/` and `test/` returns nothing, so
it has **not been observed here** (glm-5.2's measured trip rate is 0). Adopt only on a real sighting,
as one optional boolean on the provider config beside `timeoutMs` — never freellmapi's platform-keyed
table, which §5 of the adoption review already rejected. [backend.ts:508](../src/backend.ts:508)
already drops one offending param and retries once on 400/422; that pattern generalises with no
provider table.

### 3.6 Wake-from-sleep recovery — **INFO** (low)

Decision already on record: skip until observed. One datum that sharpens what to watch for without
reversing it — `dropRemainingSameProvider` ([server.ts:1147](../src/server.ts:1147)) prunes a
provider's entire remaining membership on a genuine transport throw, and a stale post-wake socket is
exactly such a throw. Post-wake cost is "one provider pruned per throw", not "one extra hop".

### 3.7 Rejected, on record and re-verified

- **Quota ledgers / in-flight leases / Thompson-sampled routing.** A ledger presupposes limits free
  providers don't publish; it is a second quota policy beside the breaker; it is ruled out by the
  owner-ratified **credentials-stay-user-operated** invariant ([project-goals.md:86](project-goals.md:86));
  and a stochastic draw cannot answer "why this backend" reproducibly.
- **Extra wire surfaces** (Gemini v1beta, Ollama emulation, embeddings, media, MCP, URL tokens,
  dashboard). No client that can reach this relay speaks them; MCP specifically would be a second
  presentation layer over `handleAdminRoutes()`.
- **Encrypted key storage / per-key proxy / SSRF guard.** The master key lands in the same directory
  class as the ciphertext; llm-relay's containment is stronger and lives at the sink
  ([log.ts:152](../src/log.ts:152)); every preset authenticates by header, so no credential rides a URL.
- **Request-path transforms** (compression, response cache, context handoff, structured-output
  healing, image downscale). Compression is headroom's job; context handoff has the relay *authoring*
  conversation content and retaining bodies, which crosses the repair boundary; caching cannot hit on
  agentic histories; `sharp` would be the first non-pure-JS runtime dep.
- **Per-model quirks / reasoning-effort tables, client profiles.** The quirks and effort tables are
  the platform-keyed table §5 already rejected (rubric 3, one place per policy). `client_profiles` is
  per-client minted keys plus server-enforced system prompts — **credential custody**, ruled out by
  the same ratified invariant. *Stating that invariant application out loud, as the goals doc requires.*

## 4. The reverse direction, and the honest division of labour

### 4.1 What llm-relay has that freellmapi lacks (grep-confirmed in both trees)

- **Malformed-destructive-call refusal.** `destructive` returns zero hits across freellmapi's
  `server/src`, `cli/src` and `shared`, in **both** trees. Scope it honestly per §3.1: the delta is
  the *malformed* path.
- **Provider-interleaved failover ordering** ([dynamic-pools.ts:89](../src/dynamic-pools.ts:89)).
  freellmapi owns the identical helper — `interleaveByProvider` — but applies it only to the *probe
  queue*, never to the failover chain. Small port for them, high value: `pool/xhigh`'s 15 members
  were 4 quota domains.
- **Learned per-deployment context ceilings** ([context-limits.ts:59](../src/context-limits.ts:59),
  wired on both fronts). freellmapi classifies context-too-large transiently and never persists what
  the deployment stated.
- **Windows registry env recovery**, the **`freeOnly` spend guard** with `x-llm-relay-degraded` /
  `-paid` announcements, **host-routing detection**, the **`PreToolUse(Agent)` hook**, and the
  **refusal-interpretation store with human-gated verdicts** — all zero hits in freellmapi.
- **Byte-transparent Anthropic passthrough** ([backend.ts:428](../src/backend.ts:428) sets
  `init.body = args.reqBuf`), which makes Anthropic→Anthropic field coverage 100% by construction.
  freellmapi parses and re-emits; byte-exact passthrough exists there only on the live tree.

⚠ **Not on this list, though an earlier draft put it there:** a credential-fault axis separate from
health. freellmapi has one — `isKeyAuthError` → `recordAuthFailure` branches *before* the retryable
check and is explicitly "KEY-fatal, not request-fatal", with per-key `status='invalid'` surfaced in
its status route. The two differ only in **scope keying** (llm-relay per deployment with a 5-minute
TTL; freellmapi per key with immediate revalidation) — a design difference, not a gap either way.

### 4.2 Where freellmapi is decisively ahead

Real per-key **RPM/RPD/TPM/TPD accounting that gates before dispatch**, with in-flight leases;
encrypted central key custody; probe-based early recovery of heuristic cooldowns; breadth of wire
surfaces; and a content-negotiated Anthropic-shaped `GET /v1/models` that llm-relay lacks (its
`/v1/models` is OpenAI/Codex-shaped only).

⚠ Precision correction to an earlier framing: it is **not** true that llm-relay "has no counters at
all and is purely reactive". It keeps `totalCalls` / `successCalls` / `totalLatencyMs`
([runtime-telemetry.ts:19](../src/ping/runtime-telemetry.ts:19)) and `consecutiveFailures` on the
breaker, and uses both for ranking and trip decisions. The true distinction is narrower and still
decisive: **llm-relay counts what already happened; it keeps no pre-dispatch ledger and no leases, so
nothing gates a request before it is sent.**

⚠⚠ **Correction to the correction (2026-08-16, later the same day).** An earlier revision of this
section also cited `totalCompletionTokens` as evidence of existing counters. **That field has read
`0` for the entire life of the file.** `recordModelCall()` accepts a `completionTokens` argument
([runtime-telemetry.ts:86](../src/ping/runtime-telemetry.ts:86), summed at `:110`) that the sole
production call site — [server.ts:1262](../src/server.ts:1262) — never passes. It is a field that
looks like a measurement and is not one, which is precisely what this project's rules exist to
prevent. Do not cite it. Full analysis:
[rubric-recalibration-2026-08-16.md](rubric-recalibration-2026-08-16.md).

⚠ The §3.7 REJECT on quota ledgers **has since been overturned by the owner**, who removed the
invariant it rested on and reinstated accounting/metering as founding goals. This section is
preserved as the record of what was believed on 2026-08-16 before that correction; read the
recalibration document for the current position.

### 4.3 Division of labour

They are not competitors with a winner, and **running both is the correct configuration.**

- **freellmapi** is the instrument for *serving* a pool of free tiers to arbitrary clients — key
  custody, quota ledgers, protocol breadth, dashboard, and (live tree only) the offload lane.
- **llm-relay** is the instrument for *governing* one operator's own traffic with auditable
  provenance — byte-transparent passthrough, per-field metadata with a provenance label and no
  guessed rung, un-blended candidate tables that refuse to average away the judgement, and host-side
  orchestration for the case freellmapi structurally cannot reach: a host whose traffic never arrives.

Put sharply: **freellmapi answers "can I get an answer from somewhere free?"; llm-relay answers
"what exactly answered, on what evidence, and what was it allowed to do?"**

## 5. Drift — where this repo misdescribes itself

This is where the real problem is. A fresh agent reading `CLAUDE.md` as "the map" would be
misdirected at least eight times.

1. **Global `~/.claude/CLAUDE.md:72-73` still says llm-relay was "retired 2026-08-09 … archived, not
   deleted."** Highest blast radius — that file is injected into *every* session in *every* project,
   so an agent starting cold is told the repo it is being asked to work on is archived. It also
   contradicts the memory index loaded beside it. **User's own config — flagged, not edited.**
2. **`CLAUDE.md:462` tells test authors to call `resetEligibility`, which does not exist.** The
   export is `resetFacts()` ([target-facts.ts:403](../src/target-facts.ts:403)). A direct instruction
   that fails on contact, caused by `b4c24ec` folding `deployment-eligibility.ts` into `target-facts.ts`
   without propagating the rename.
3. **Four live references to the deleted `deployment-eligibility.ts`** — `CLAUDE.md:383`,
   `docs/pool-eligibility.md:97`, `docs/freellmapi-gap-proposals-2026-08-10.md:147`, and
   [refusal-interpretation.ts:414](../src/refusal-interpretation.ts:414), **the last shipping to npm
   consumers via `dist/refusal-interpretation.d.ts`**. `pool-eligibility.md:97` goes further and
   describes the superseded three-class/deployment-scope design where source implements six kinds
   across four scopes.
4. **`CLAUDE.md:114` and `docs/reference.md:660` both point users at
   `~/.llm-relay/context-limits.json`, which is never written.** `context-limits.ts:19` says so
   itself — storage moved into `target-facts.ts` as a deployment-scoped fact.
5. **`CLAUDE.md:115` lists 4 of 6 fact kinds and inverts one rule.** `rate-limited` and
   `context-limit` are missing (`rate-limited` is then discussed 300 lines later, so the file
   contradicts itself). "Any success clears every fact covering that deployment" is now false —
   `clearFacts` deliberately excludes `context-limit`: *a success disproves a condition, never a
   measurement.*
6. **`docs/reference.md:768` advertises two headers that do not exist** —
   `x-llm-relay-quota-percent` and `x-llm-relay-stability-score`. `quota_percent` is a `/registry`
   JSON field, never a header. The real emitted set is exactly ten; the reference also omits
   `-sticky`, `-tool-dialect`, `-error-origin`, `-paid`. **This is the user-facing reference an
   integrator would build against.**
7. **Subagent detection has three signals in source, not two** — `SUBAGENT_MARKER`,
   `x-claude-code-agent-id`, and `x-codex-turn-metadata` ([config.ts:250,270,273](../src/config.ts:250)).
   `CLAUDE.md:226` says two and omits Codex; `docs/reference.md:392` names a *different* pair and
   omits the Claude header. A reader following the re-verification recipe never verifies the Codex path.
8. **`CLAUDE.md:100` claims the architecture table covers "all in `src/`"; four shipped modules have
   no row** — `key-import.ts`, `process-safety-net.ts`, `secret-file-acl.ts`, `think-tags.ts` (all
   with dedicated test files, all named decisions 2.5/1.3/2.10b/2.13). The table also omits log
   rotation from the `log.ts` row and the escalation ladder from `circuit-breaker.ts`.
   `docs/project-goals.md:74` catalogued this exact failure mode on 2026-08-04; it recurred within ten days.
9. **`CLAUDE.md:184` states as an *invariant* that state lives in five files under `~/.llm-relay/`;
   source writes ten** — also `control-token`, `target-facts.json`, `refusal-interpretations.json`,
   `lane-manifest.json`, `update-check.json`. **One of the omissions is the control-plane secret.**
   Anyone reasoning about backup or redaction from this gets a half-right answer.
10. **`CLAUDE.md:664` says five leaderboards are merged; `README.md:43` says four; the shipped
    artifact backs the README.** `docs/tier-data.json` records `artificialanalysis` as
    `model_count: 0, configured: false`. The headline sentence overstates the provenance behind every
    pool ranking. Related: `docs/capability-sources.md` predates the AA fetcher and has no AA row, yet
    `CLAUDE.md:666` cites it as the authority.
11. **`CLAUDE.md:592` "nothing is pending in the code" is contradicted by
    `docs/project-goals.md:127`**, which records `llm-relay offload status` not rendering `freeOnly`
    as open. Confirmed: `grep freeOnly src/cli.ts` = **0 hits**, while the data is on `OffloadState`.
12. **Three stale docs read as live**: `docs/alternatives-review-2026-08-09.md:352` still reads as a
    live "adopt it on trial" recommendation with no superseded marker (the trial concluded the other
    way on 2026-08-13); `docs/free-provider-setup-2026-07-29.md:114-127` reads as a live four-item
    to-do list, all four long fixed, and says "Both are 0.9.0" against a 0.36.1 tree;
    `docs/project-goals.md:74-84` keeps a fully-resolved drift section in the present tense.

**Clean on the axes probed**: zero `TODO/FIXME/XXX/HACK` in `src/` or `test/`; no dead exported
surface; every `docs/` and `.claude/` cross-reference in `CLAUDE.md` and `README.md` resolves;
spot-checked numeric claims (30m/1000-entry sticky, 6h/2.5s update cache, 256-bit control token,
two runtime deps) all accurate.

## 6. Recommended next

"Nothing is pending" is **almost true of the code** and **false of the documentation**. Defence: gate
green, both typechecks clean, CI green at HEAD, no TODOs, no dead exports, 1135 tests passing. The
code exceptions are exactly two — one transparency bug (`freeOnly`) and one new safety finding
(§3.1). Everything else below is documentation debt.

| # | Action | Where | Why |
|---|---|---|---|
| 1 | Correct the retirement framing | `~/.claude/CLAUDE.md:72-73` | Highest blast radius; contradicts the memory index loaded beside it. **User's own config — ask first.** |
| 2 | Add destructive-name filter at the dialect-rescue commit point | `src/tool-dialects.ts`, `src/openai-dialect.ts` | The only genuine code gap with a safety consequence (§3.1) |
| 3 | Render the **effective** `freeOnly` in `offload status` | `src/cli.ts` | ⚠ Not cosmetic and not a raw field print: an unset flag is **ON for rerouted traffic, OFF for a directly addressed pool** ([server.ts:1457](../src/server.ts:1457)). Printing the bare optional would be a *new* transparency bug. Today an operator cannot tell whether a lane may spend money. |
| 4 | One `CLAUDE.md` accuracy pass | `CLAUDE.md` | Drift items 2-11 and the `lanes`/`eligibility` command omissions |
| 5 | Fix the phantom headers | `docs/reference.md:768` | User-facing; an integrator would build against them |
| 6 | Retire the three stale docs | `alternatives-review-2026-08-09.md`, `free-provider-setup-2026-07-29.md`, `project-goals.md:74-84` | Banner as superseded / past-tense; the repo already knows how (`freellmapi-adoption-review` carries a dated banner) |
| 7 | Add a mechanical guard: test that every non-index `src/` file appears in the `CLAUDE.md` table | `test/` | Second documented recurrence of that drift; repo philosophy is to pin doc/source agreement (`test/destructive-coverage.test.ts`) rather than rely on discipline |
| 8 | Document the four win32-skipped tests | `CLAUDE.md` build section | So a local green run is not read as full coverage of secret-file permissions |
| 9 | Note the freellmapi `/health` false 200 and llm-relay's 403-by-design | wherever monitoring is described | Both liveness gotchas from §1 |

Items 2, 3 and 7 are code; the rest is documentation. Nothing here requires a routing or
architecture change, and no rejected item from the 2026-08-13 review was reopened by this review.

