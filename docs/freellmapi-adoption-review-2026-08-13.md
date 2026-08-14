# What freellmapi has that llm-relay should adopt — verified review

**Date:** 2026-08-13
**Direction:** the reverse of [freellmapi-gap-proposals-2026-08-10.md](freellmapi-gap-proposals-2026-08-10.md).
That doc proposed llm-relay's features *to* freellmapi's maintainer; this one asks what freellmapi
has that is worth bringing *into* llm-relay, now that llm-relay is being revived.
**freellmapi at:** `origin/main` = `0a8a3f7` (v0.7.0 plus 8 fixes; dev tree `C:\Code\freellmapi`
synced to it today — see §8).
**llm-relay at:** `823bc34`.

**Method.** Three independent lanes, none trusted alone: (1) a 14-agent workflow — six subsystem
readers over `server/src`, six judges checking each finding against llm-relay's actual source and
the [project-goals.md](project-goals.md) rubric, two adversarial verifiers re-deriving every
surviving claim at file:line; (2) Codex reading both trees end-to-end; (3) an Antigravity read-only
survey used as corroboration. 86 features were assessed; 25 candidates went to verification; 23
survived, 2 were refuted. Every claim below that appears with a file reference was confirmed
against source by a verifier or by hand — including all five claims only one lane made. Where the
lanes disagreed, the disagreement is recorded (§4) rather than averaged away.

The strongest signal: the workflow and Codex **independently converged** on the same top defects —
the half-wired `quotaPercent`, the single-timer streaming deadline, transport-scoped request-local
provider skip — from different starting points. Those are the ones to trust most.

---

## 1. Adopt — verified, rubric-clean, ranked

### Reliability on the request path

**1.1 Deferred stream commit point — fail over invisibly until first meaningful content.** (medium)
freellmapi's streaming fronts withhold the response skeleton until the first *meaningful* content;
until that commit, connect errors, in-band error frames inside a 200 stream, empty completions and
unparseable dialect turns all throw back into the fallback loop with zero bytes on the wire
(`server/src/lib/inbound-chat.ts:332-466`; `!headerSent` as the licence to throw,
`routes/proxy.ts:2051-2060`; dialect probe bounded at 256 chars, `proxy.ts:2006`). llm-relay built
the first third of this: `preflightResponseStream` (src/backend.ts:216-309) validates the first
event and fails over on dead streams, and client disconnects complete as cancelled-not-failure. But
commit is at first *structurally valid* event — and the verifier found the gap is larger than
claimed: `invalidEnvelopeReason` treats a well-formed Anthropic `error` event as VALID
(backend.ts:204-205), so even a first-event in-band error frame passes preflight and reaches the
client instead of failing over. Empty completions and truncated streamed dialect envelopes
(src/dialect-stream.ts:105-116 — "the headers are long gone here") land post-commit as
client-visible failures while healthy pool members sit unused. This closes the one place where a
pool with live members still shows the client a single member's failure, and it finally gives
dialect-stream's fail-clean intent ("failover reaches a host that parses") a mechanism on streams.
It touches the riskiest code on both fronts — hence medium, and it should arrive with
hanging-socket tests (§6). Found by: workflow + Codex (as "semantic empty-completion failover").

**1.2 Split the streaming deadline: first-byte grace + inter-byte stall watchdog.** (medium)
freellmapi separates three time axes — per-provider total timeout, a first-byte grace derived from
it, and a 90s inter-byte stall watchdog (`lib/provider-timeout.ts:1-55`). llm-relay has one axis:
`timeoutMs` (default 120s, src/config.ts:979) arms a single AbortController per attempt
(src/server.ts:569-570) cleared only in the streaming handlers' `finally` blocks (lines
1416/1489/1647/1749) — so a healthy stream still emitting at 120s is killed mid-generation, while
a genuinely hung stream survives until the same 120s. Exactly the traffic this relay fronts (slow
free-tier prefills on NIM-class backends) is what the flat deadline mis-serves in both directions.
Keep the per-provider deadline for the pre-first-byte window, where failover is still possible,
then switch to an inter-byte watchdog. Found by: workflow + Codex, same lines independently.

**1.3 Process-level transport-error safety net.** (small)
Boot-time `uncaughtException`/`unhandledRejection` handlers with a *pure classifier* that walks the
error cause chain and swallows only a closed allowlist of undici/socket reset codes; everything
else keeps Node's fail-fast exit(1) (`lib/process-safety-net.ts:17-110`, with its own test file).
llm-relay has zero such handlers (only signal shutdown, src/cli.ts:579) — while
`discardCandidate()` (src/server.ts:1109-1116) cancels un-read bodies of failed-over candidates,
the exact listener-less-stream shape where a late socket reset escalates to an uncaught exception
and kills the proxy that fronts every session. A total outage from an infra hiccup is the failure
class this repo's own philosophy (unset `${ENV}` degrades, the Agent hook fails open) exists to
prevent. Deterministic, dependency-free, unit-testable. Found by: workflow.

**1.4 Treat 410/End-of-Life as retriable and learnable.** (small)
freellmapi grades how much a 404/410 should be trusted as permanent: "definitive" only when status
AND wording agree the model is gone (`lib/error-classify.ts:427-460`). llm-relay currently does
*worse than the problem freellmapi fixed*: `classifyStatus` (src/server.ts:791-795) puts 410 in the
non-retriable client class — no failover — and both the not-servable seed's status predicate
(src/refusal-interpretation.ts:471) and `carriesEligibilityFact` (src/server.ts:1098-1100) are
400/404-only, so the discard path never even reads a 410 body. NVIDIA served real 410 EOL responses
on this machine on 2026-08-07. Minimal fix, entirely inside existing mechanisms: add 410 in both
places and extend the seed to explicit 410/EOL wording. The corroboration ladder is NOT needed —
the unknown-refusal queue plus operator accept already is llm-relay's corroboration path. Found by:
workflow (verifier added the `carriesEligibilityFact` touchpoint).

**1.5 Wall-clock walk budget.** (small)
freellmapi caps the whole failover walk at 45s wall-clock, checked before *starting* each retry,
with attempts 0 and 1 always guaranteed so a slow-failing first model cannot starve the request of
any retry, and 0 disabling it (`lib/fallback-loop.ts:114-144`). llm-relay has per-target `timeoutMs`
and nothing aggregate: a deep pool can legitimately spend `members × timeoutMs`. A config-driven
ceiling that stops *starting* new attempts (never aborts one in flight) is deterministic, tiny, and
directly bounds worst-case latency. Found by: Codex; verified by hand today.

**1.6 Request-scoped provider skip — on transport evidence only.** (small)
freellmapi widens a request-local skip set at the evidence's blast radius: key → model → whole
provider on transport/5xx (`lib/fallback-loop.ts:147-158`, provider widening at :310-319). llm-relay
continues candidate-by-candidate (src/server.ts:612-634), so a provider-wide outage burns one hop
per member in the same walk — the residual half of the measured 13-round-trips-to-learn-4-facts
pathology ([pool-eligibility.md](pool-eligibility.md); learned facts fixed the quota half).
**Adopt the transport slice only** (the `fetchBackend` catch at server.ts:612, where no HTTP
response exists at all: DNS, connect, TLS, socket timeout). Do NOT widen on 5xx statuses —
llm-relay's own record shows 5xx can be model-local (`nim/deepseek-ai/deepseek-v4-flash` at HTTP
529 while sibling NIM models served). Request-local state dies with the response, so it cannot
fight the breaker. Found by: workflow + Codex, both independently narrowing to transport-only.

### Repair and tool calls

**1.7 Deterministic pre-pass for double-encoded tool arguments.** (small)
freellmapi decodes a stringified argument value only when the declared schema says the field is
array/object AND the string parses to exactly that type — recursive, whole-arguments unwrap
included, untouched on any doubt (`lib/tool-args.ts:50-159`). llm-relay ships the same idea in
miniature for dialect-recovered calls only (`coerce()`, src/tool-dialects.ts:116-137); the main
repair path sends every schema violation straight to the LLM reshaper (src/repair.ts:84). And
repair.ts:73-79 already runs a deterministic pre-pass (`stop_reason_mismatch`) before any reshaper
call — this adds a second rung to a slot that already exists. Protocol form provable from the
schema, zero judgment, strictly fewer LLM invocations: the repair boundary done cheaper. Fixes the
GLM-family failure class without a reshaper round-trip. Found by: workflow.

**1.8 The ASCII Kimi/DeepSeek dialect marker variant.** (tiny)
llm-relay's `DIALECT_MARKERS` carry only the fullwidth-｜ DeepSeek/Kimi token forms
(src/tool-dialects.ts:55-61); freellmapi matches the ASCII `<|tool_call_begin|>` form too
(`lib/tool-call-rescue.ts:49`), observed in production on the same free pool. One entry in the
closed set. (The bare/fenced-JSON envelope freellmapi also parses is deliberately NOT here — see
§2.7.) Found by: workflow.

### Telemetry and transparency

**1.9 Feed live-traffic quota headers into the breaker.** (small)
The breaker's observation shape already defines `quotaPercent` (src/circuit-breaker.ts:51,70) and
`applyHealthOutcome` stores it (:393) — but `observeAttemptHeaders` (src/server.ts:1119-1134) never
supplies it, so quota only refreshes on synthetic probes while every real response's
`x-ratelimit-*` headers are dropped. Reuse `extractQuotaPercent` (src/ping/ping.ts:26-52) inside
`observeAttemptHeaders` on both fronts. Provider-stated data, existing field, no new mechanism.
Note the display surfaces: `/telemetry` reads the breaker's field and lights up immediately
(src/telemetry.ts:108-132); `/candidates` currently displays the ping loop's probe-derived quota
(src/candidates.ts:358) and only benefits if additionally pointed at the breaker. freellmapi's
equivalent is its confidence-ranked observation ledger (`services/provider-quota.ts:324-379`) —
the ledger and DB stay behind; the harvest-at-the-boundary idea comes over. Found by: workflow +
Codex, independently.

**1.10 Windowed freshness in the real-world score.** (small)
`getRealWorldScore` computes success rate and speed from LIFETIME totals only
(src/ping/runtime-telemetry.ts:143-152); the 50-call `recentCalls` window it also keeps is read by
nothing but `getLastSuccessfulCallAt` — so a model that degrades today hides behind its lifetime
average. freellmapi decay-weights a 7-day window with a 2-day half-life and folds timeouts into
latency at a capped wall-clock (`services/router.ts:524-607`). Adopt the windowed-freshness half
only: score from the window llm-relay already records. **Skip the writeback half** (freellmapi
periodically rewrites catalog `speed_rank` from observations) — "capability data is synced, never
typed." Found by: workflow.

### Hardening

**1.11 Bound the catalog fetch.** (small)
freellmapi parses `/models` responses defensively: 2MB streaming byte cap with Content-Length
pre-refusal, 500-model cap, 256-char id cap (`services/model-discovery.ts:22-28,267-298`).
llm-relay's catalog fetch buffers unboundedly via `res.json()` (src/catalog.ts:344) — the 120s
timeout bounds time, not bytes, so a buggy or hostile endpoint can balloon the one process fronting
every session. It runs on background refresh, not the request path, but it is the same process.
Byte/count/id-length caps are a few dozen lines in one function. **Skip** the envelope-alias walk
and price-magnitude scaling until a real provider needs them. Found by: workflow.

**1.12 Create `~/.llm-relay/.env` owner-only.** (small)
The control token gets 0600/0700 treatment (src/control-authorization.ts:27,102-106) but
onboarding's `.env` — holding every provider key — is written via `appendFileSync` with default
mode on every platform (src/onboarding.ts:169). Apply the existing `FILE_MODE` pattern to that
write. The Windows icacls leg freellmapi also has (`lib/file-permissions.ts:61-132`, SID-referenced,
inheritance-stripped) is a separate owner call — §2.10. Found by: workflow.

---

## 2. Owner decisions — real value, real costs

Each of these survived verification but changes a contract, adds config surface, or trades against
a documented posture. They need a yes from the owner, not a default.

**2.1 Unrepairable schema-invalid tool call → dead turn that resumes the candidate walk.** (medium)
Today an unrepaired invalid call fails clean as a 502 (src/server.ts:1713-1721) and never fails
over. freellmapi marks it a retryable dead turn scoped to skip that model for the request
(`lib/tool-validate.ts`, scope markers at `routes/responses.ts:1153`). Consistent with how llm-relay
already fails over on unparseable dialect envelopes — but it reorders the deliberate
repair-then-fail-clean contract, and the owner must decide whether failover comes before or after
the reshaper attempt. Buffered path only unless 1.1 lands first.

**2.2 Sticky-session affinity.** (medium — the lanes disagree; see §4)
llm-relay re-derives ordering per request, so a conversation can flap across providers turn to
turn, busting upstream prompt caches and changing the answering model mid-task (no session
machinery exists; grep confirmed). freellmapi pins for 30 minutes keyed on a session header or
first-user-message hash (`routes/proxy.ts:150-151,245-252`). If adopted: surfaced with a
provenance header, always losing to breaker/health ordering, and WITHOUT the reasoning-trace
memory half (it retains response bodies — against the metadata-only posture). Codex recommends
against entirely: hidden request-to-request state, and stickiness can hold a session on a weaker
target after better capacity returns.

**2.3 Escalating cooldown for repeat unexplained 429s + short bench for loopback providers.** (small)
The breaker retries an unexplained 429 on a flat 2-minute cooldown forever
(src/circuit-breaker.ts:418-431); freellmapi escalates 2m→10m→1h→day-scale with provenance tags
and benches *loopback* endpoints only 5s so a busy local Ollama isn't stranded for minutes
(`services/ratelimit.ts:622-820`). Both halves are deterministic and breaker-local. **Leave out**
freellmapi's numeric limit-learning from error bodies — guess-adjacent inference on untrusted
text, exactly what the interpretation store keeps off the request path.

**2.4 An `exclude` list on dynamic pool policy.** (small)
User intent has no home today: a known-bad model in a `{ include: "free" }` pool can only be
avoided by abandoning dynamic pools, while target-facts re-learns its badness every TTL expiry.
freellmapi separates user tombstones (permanent) from machine retirement (soft, reversible)
(`services/model-state.ts:91-190`). The machine half llm-relay already has better (TTL +
success-clearing); the user half would be one config field. Cost: config surface on a project
trying to stay boring.

**2.5 `llm-relay onboard --import <.env>`.** (small)
Onboarding is one-key-at-a-time readline; no file import exists. freellmapi's key-parser does
multi-format import with a closed longest-prefix env-var map and first-class explained skips
(`lib/key-parser.ts:289-522`). Concrete this-installation use: moving the 12 working keys back
from freellmapi (note: they are AES-encrypted in its DB — its export produces the file to import,
`parseExportJson` documents the format). Reuse `authEnv.ts`'s closed alias list; **drop**
freellmapi's `looksLikeApiKey` value heuristic (it is precisely the key-shaped guessing authEnv.ts
refuses) and the CSV/JSONC/opencode formats.

**2.6 A bounded `attempts` array in the metadata log.** (small)
The walk is client-visible (`x-llm-relay-pool-attempts`) and live in `/candidates`, but the durable
log records only the terminal deployment — after the response, "which members were walked and why"
is unrecoverable (src/log.ts LOG_FIELDS). A statuses-only per-attempt list (provider/model/status/
ms — no error text) keeps the sink-enforced metadata invariant. Worth stealing regardless:
freellmapi's `committed` outcome — stream flushed bytes then died — an honesty class llm-relay's
mid-stream handling could name (`lib/attempt-trace.ts:19-27`). Cost: grows the deliberately-small
log schema; the owner may judge the header sufficient.

**2.7 The bare/fenced-JSON dialect envelope.** (owner call, small)
freellmapi also rescues a tool call emitted as a bare or ```json-fenced object, gated on declared
tool names (`lib/tool-call-rescue.ts:25,234-237`). It sits right on llm-relay's
fabricating-intent boundary even with name gating — and even freellmapi only does it on the
buffered path (markerless JSON flushes as passthrough after 256 chars streamed). Decide
deliberately; the ASCII marker variant (1.8) does not depend on it.

**2.8 Upstream-reported model drift field.** (small)
freellmapi captures the upstream's raw `model` before normalizing and records genuine
discrepancies (`lib/served-model.ts`). llm-relay's `servedModel` is the resolved target; no
comparison to what the backend *claimed* exists (grep: no reportedModel/upstreamModel in src).
A nullable `upstreamReportedModel`/mismatch flag — never overwriting the authoritative routed
target — is cheap provenance that catches meta-routers silently substituting models. Verified by
hand. Found by: Codex.

**2.9 Cap the metadata log's growth.** (small)
`log.ts` appends forever (appendFileSync, src/log.ts:99); freellmapi bounds analytics by age and
row count (`services/request-retention.ts`). Copy the principle, not SQLite: a max-size/rotation
pair on the one log file. An unbounded log eventually turns transparency into a disk problem.
Verified by hand. Found by: Codex.

**2.10 Redact the stored refusal sample; Windows ACLs on secret files.** (small each)
Two residual hardening items. (a) `recordUnknownRefusal` persists a VERBATIM 400-char provider
error sample to `~/.llm-relay` (src/refusal-interpretation.ts:630) — the verifier narrowed the
exposure (the CLI prints only the normalized text; the sample's one programmatic reader is the
seed recheck at :649), so this is untrusted text *at rest*, not text replayed into an agent. If
sanitized, the sanitizer must run before BOTH signature and sample or be idempotent under
normalization, or the :649 seed match silently breaks. (b) freellmapi's icacls leg
(`lib/file-permissions.ts`) closes the win32 no-op that control-authorization.ts:102-106 admits in
a comment; but `%USERPROFILE%` inheritance already yields owner-scoped ACLs on a default install,
so it buys marginal hardening for a subprocess spawn at startup.

**2.11 Align the wire body cap with the document cap.** (small)
`MAX_BODY_BYTES` is a hard-coded 10MB (src/server.ts:186) while documents.ts accepts 25MB decoded
(src/documents.ts:39) — after base64 expansion, a document the converter would accept can never
arrive. Make the wire cap configurable (or at least consistent), keep it bounded, keep the explicit
413. Verified by hand. Found by: Codex.

**2.12 Strip provider-intolerant JSON-Schema keys — only when a real provider bites.** (conditional)
freellmapi strips `additionalProperties`/`$schema` from outbound tool schemas for providers that
400 on them, returning a NEW value because the tools array is shared across the failover chain
(`lib/tool-args.ts:161-185`). No provider this install routes to is known to need it — preemptive
adoption is a hypothetical-user feature. If ever needed: the immutability constraint is the
load-bearing lesson, and note the verified-open question of whether llm-bridge already drops these
keys on the translated path (the certainly-verbatim surface is the direct Chat passthrough,
src/backend.ts:831-838).

**2.13 `<think>`-tag extraction.** (medium)
A bounded four-state stream filter moving a message-opening `<think>…</think>` block out of
content (`lib/think-tags.ts`, ≤512B lead hold, ≤7-char close holdback, one block, lossless flush).
Real defect with these pools — thinking rendered as answer text — and the partial-marker technique
is one llm-relay already uses. But the Anthropic-front landing is an open design question:
unsigned thinking blocks don't round-trip, so the minimal safe version (strip vs text-prefix
convention) is the owner's pick.

**2.14 Node-20 CI leg — or raise `engines` to `>=22`.** (tiny)
ci.yml runs Node 22 only while package.json declares `>=20`: the bottom of the declared range runs
nowhere, ever. freellmapi keeps a 20+22 matrix precisely because 20 historically caught crashes
newer local Nodes hid. Either fix is two lines; pick one. Found by: workflow + Codex.

---

## 3. Refuted by verification

- **"Adopt freellmapi's tool-call dialect rescue."** llm-relay HAS the capability
  (src/tool-dialects.ts, src/dialect-stream.ts, wired both paths) — adopting the module would be a
  second implementation. The actionable residue is llm-relay's OWN documented backlog item
  ([tool-call-dialect-leak.md](tool-call-dialect-leak.md): the OpenAI-front direct passthrough is
  uncovered), which requires no freellmapi code. The harvestable deltas are already itemized above
  (1.8, 2.7).
- **"Adopt inbound image normalization (sharp downscale of >1MB images)."** Mechanism confirmed and
  the 413 pain is real on this installation — but sharp IS the heavy-dependency disqualifier: a
  native module with platform prebuilds, taking the project from two pure-JS runtime deps to three
  with its first native binary. Refused on the dependency ground; if the pain recurs, solve it
  dependency-free (e.g. a reject-with-reason guardrail naming the oversized block).

## 4. Where the lanes disagreed

**In-flight concurrency leases / provisional quota gating.** Codex ranked it adopt-high (concurrent
subagents can all pick the same top deployment before any response updates health; freellmapi
closes the race with selection-time leases, `services/ratelimit.ts`). The workflow's judges ranked
it skip on three grounds: it is a second, *predictive* quota policy beside the breaker's reactive
one ("one place per policy"); the worst case today is one extra 429 that the walk already absorbs;
and llm-relay **built and then deleted** this exact machinery — the unadopted kernel lease budgets
removed 2026-08-04, whose rebuilding CLAUDE.md explicitly warns against.
**Recommendation: skip.** The workflow's reasoning is grounded in this repo's own documented
history. Recorded here so the dissent isn't lost: if concurrent-subagent 429 storms ever become a
*measured* problem, Codex's narrow version (in-memory per-deployment lease, stale-lease backstop,
user-configured cap — no quota ledger) is the shape to revisit.

**Sticky sessions** — see 2.2: workflow says consider-with-guardrails, Codex says skip. Owner call.

**Wake-from-sleep recovery.** Workflow: skip (symptoms already absorbed by failover + wall-clock
cooldowns; the undici global-dispatcher swap is version-fragile private API). Codex: adopt narrowly
*only after a live reproduction*, as a drift detector that switches the ping loop to speed mode.
Net: skip until a post-wake failure is actually observed on this machine; then Codex's minimal
version, never the dispatcher swap.

## 5. Considered and not recommended

Grouped; every one was source-verified before rejection. Listed so they are not re-litigated.

- **Randomness in routing** — Thompson-sampled reliability, the 10% exploration floor, strategy
  weight vectors, per-model score multipliers, community priors. llm-relay's deterministic
  equivalents already exist (`deploymentFitness` convex composite with provenance; neutral-50
  mid-band for the unmeasured; config order as policy), and a random draw cannot answer "why this
  backend" reproducibly. The un-blended `/candidates` invariant forbids a second composite score.
- **Database-shaped machinery** — SQLite facade, migration framework + round-trip tests, hourly
  analytics aggregates, DB-backed quirk registry, encrypted backups, boot-time catalog re-apply,
  provenance merge columns. All presuppose the DB llm-relay deliberately lacks; better-sqlite3's
  prebuild pain is a documented operational cost on this very machine. Versioned JSON with
  degrade-to-fresh is the right durability model for reconstructible learned state.
- **Fleet / multi-key patterns** — per-key bandit selection, credential pooling (#619/#640),
  per-key proxy overrides, the RPM/RPD/TPM/TPD sliding-window ledger, account-wide caps,
  quota-pool-key platform tables. Named out loud per the goals doc's standing instruction: the
  ratified **"credentials stay user-operated"** invariant (and the codex-review terms position)
  rules out key rotation and account pooling; the alternative — one provider entry per credential —
  already exists and keeps health/facts/provenance per credential. Account-cap tables would also
  hardcode provider knowledge in `src/`.
- **Second implementations of existing mechanisms** — the graded 429 penalty + penalty-inspector
  (breaker + `/candidates` cover both halves), substring error-scope classification (inference;
  llm-relay's rule is lookup-never-inference), console credential scrubbing (the allowlist sink is
  categorically stronger), declarative env config, a hand-rolled MCP server over data the admin
  routes already serve, hand-rolled Anthropic/Responses fronts (llm-bridge's job), the
  InboundChatWire vtable core (the two fronts share one policy held by pinning tests;
  [suggestion-review-2026-08-04.md](suggestion-review-2026-08-04.md) already rejected the refactor).
- **Out of scope / hypothetical users** — Gemini and Ollama native fronts (no such client can reach
  this relay; Antigravity has no base-URL override), the compression pipeline + 8 engines +
  fidelity gate (headroom's job in this topology; freellmapi's own docs call chaining them
  redundant), response fusion (an LLM's judgment on the request path — the explicit red line),
  exact-response caching (agentic histories never repeat byte-identical; replaying tool calls is a
  safety hazard), cross-model context-handoff injection (the relay authoring conversation content
  crosses the repair boundary; retains bodies), embeddings/media management, SSRF guarding of
  operator-typed URLs, UA-based client classification (the called path is the stronger signal),
  meta-gateway readiness contracts, the ten-format agent-setup writer, structured-output
  enforcement + JSON healing (no client of this relay sends `response_format`; revisit if one
  appears), per-platform sampling-param droplists and max_tokens floors (hardcoded provider
  tables), model unification groups (heuristic identity inference; a pool line is unambiguous),
  median rank seeding ("unknown is not worst" already implemented as neutral-50 with basis
  labeling), `.env` drift detection (`llm-relay keys` answers it better), per-field catalog
  override ownership (no dashboard, no writeback, nothing to protect), scheduler abstraction
  (three timers total), probe jitter + 3-strikes auto-disable (jitter defends fleets; auto-disable
  contradicts "health demotes, never drops"), Docker/desktop-signing release machinery.
- **Key encryption at rest.** The master key would sit in the same directory class as the
  ciphertext (freellmapi's own dev mode proves the reduction to filesystem ACLs), and the owner's
  notes already flag the lose-ENCRYPTION_KEY-lose-everything hazard. The adoptable residue is 1.12.

## 6. Methodologies worth copying (independent of any feature)

1. **Cross-surface convergence tests.** freellmapi keeps table-driven tests asserting identical
   failover behavior across its API surfaces (`__tests__/routes/*-fallback-convergence.test.ts`)
   because its bugs once differed by surface — exactly this repo's pool-failover scar ("two paths,
   one policy empty"). A matrix asserting identical 401/429/timeout/degradation handling across
   `/v1/messages` and the OpenAI front is cheaper than debugging the next drift. (Codex)
2. **Transport tests against real hanging sockets.** Partial JSON bodies, first-byte vs mid-stream
   stalls, actual socket closure (`abort-signal.test.ts`, `stream-first-byte.test.ts`). Adoptions
   1.1/1.2 should arrive with these, in the suite's existing real-server style. (Codex)
3. **Round-trip tests for versioned durable state.** freellmapi snapshot-tests migrations
   up/down/up. llm-relay has no migrations — apply the discipline to its versioned JSON stores if
   their schemas ever evolve: fixture an old file, load/upgrade/rewrite/reload, assert semantic
   equality. (Codex)
4. **Smoke-test the packed artifact.** `cli-release.yml` npm-packs, installs the tarball into a
   clean directory, and exercises the installed binary — proving the `files` whitelist ships every
   runtime asset. publish.yml runs build/check and the postinstall probe but never installs the
   tarball (verified). One job step. Keep everything else about llm-relay's release pipeline —
   pinned action SHAs, tag-ancestry gates, Trusted Publishing are all stronger than freellmapi's. (Codex)
5. **Already practiced here, worth naming so it stays deliberate:** ephemeral vs durable state
   handled differently (in-memory leases vs persisted observations ↔ breaker state vs facts
   store); real-socket test style; defect-pinning tests; provenance on every persisted measurement.

## 7. What this review deliberately does not conclude

Whether to *stay* on llm-relay vs freellmapi — that was settled by the owner today (llm-relay
revived as the daily driver; the decision context lives in
[alternatives-review-2026-08-09.md](alternatives-review-2026-08-09.md) and supersedes its
"retired" line). The four confirmed defects in [audit-2026-08-09.md](audit-2026-08-09.md) predate
this review, remain open, and are not re-listed here — several adoptions above (1.3, 1.12) touch
adjacent surfaces but none closes them.

## 8. Dev-tree update record (2026-08-13)

`C:\Code\freellmapi` synced: local `main` fast-forwarded `4270280` → `0a8a3f7` (v0.7.0 + 8 fixes:
end-to-end vision input #852, dialect-rescue hardening #854, EOL-classify tightening #855,
fallback test seams #856, i18n/UI) and checked out; feature branches untouched. `npm install` on
the pinned Node 22 (6 new packages, lockfile +620 lines). Verification: `test:bootstrap` and the
full **server** suite pass on this machine; the `cli` workspace fails 15 tests on POSIX-hardcoded
path assertions (`cli/src/tools.test.ts`, `/home/tester/...` vs `path.join` backslashes) —
**pre-existing** (assertions present at `4270280`; no cli/ commits in the pull) and spawned as a
separate fix-and-PR-upstream task. One flake note for operators: running `npm test` from pwsh 7
leaks `PSModulePath` into the child Windows PowerShell and fakes a `Get-FileHash` bootstrap
failure; run from Git Bash or a clean shell.
