# Review: "Recovery-Aware Routing, Budgets, Tracing, and Classification" proposal

> Reviewed 2026-08-04 against the project goals draft ([project-goals.md](project-goals.md)) and
> the code at 0.15.4 (HEAD e8051fb). Every factual claim below marked **verified** was checked
> against source or live config, not taken from the proposal.

## Overall verdict

**Reject the proposal as a whole; harvest four small pieces.** The document is competent and
mostly factually grounded — it is not hallucinating the codebase. But it is optimizing for a
different project: a multi-tenant, enterprise-observability routing platform, delivered as "one
coordinated routing refactor" of the riskiest code, built around the kernel contract surface this
review cycle has slated for deletion. It fails the project rubric on minimal-mechanism and
toward-boring at the framing level, and several of its centerpiece mechanisms reverse invariants
this repo learned from real outages. Anything adopted from it must land as small, independent,
individually-tested changes — never as the coordinated refactor.

## Fact-check of its claims (verified against source)

| Claim | Status |
|---|---|
| Two duplicate `/4` token estimators | **TRUE** — `metadata.ts:130` and `server.ts:1777` |
| Blanket 400/404 retry behavior exists | **TRUE, but deliberate** — `classifyStatus()` (`server.ts:668`) treats 400/404 as retriable with a documented rationale: in a heterogeneous pool they nearly always mean "this deployment won't take this shape" |
| `provider.timeoutMs` exists as a ceiling | **TRUE** — default 120 000 ms (`config.ts:807`) |
| Exhausted pool returns the last provider's body | **TRUE, and deliberate** — `server.ts:944-952`: the real upstream error is judged more informative than a synthesized one, and `x-llm-relay-served-by` lists every deployment tried, in order, so exhaustion is self-describing |
| Three Codex ladder rungs mis-set reasoning effort | **TRUE** — verified in live `~/.llm-relay/config.json`: `codex-sol` (xhigh tier), `codex-terra` (high), `codex-luna` (medium) all carry notes claiming "at xhigh effort" but pass no `model_reasoning_effort` flag; only low-tier `codex-luna` sets effort explicitly |

## Section-by-section verdicts

### REJECT — the coordinated-refactor framing
One big-bang change across the request path, breakers, estimators, dispatch, and config schema is
the opposite of "stabilize and harden." It also "builds around the existing request-budget and
attempt-lifecycle kernel" — i.e. it retroactively justifies the ~85% of `src/kernel/` that
nothing uses. Adopting it would resolve the half-built kernel in the wrong direction.

### REJECT — central route executor + typed failure decisions
The policy is already shared: both fronts classify through `classifyStatus()` / `shouldTryNext()`
and account through the same attempt lifecycle, with tests pinning it (the "two paths, two
policies" bug is fixed and documented). Replacing working loops with a typed-decision executor is
structure-first churn with no behavior change. Revisit only if a third front protocol appears.

### REJECT — removing 400/404 failover
The proposal calls it "blanket retry"; it is a deliberate pool feature. Across heterogeneous
providers a 400/404 usually means shape/model incompatibility on *that* deployment, and trying
the next candidate is exactly what a pool is for. The failover is bounded by pool size. Its
replacement — per-provider structured-error adapters plus "narrow, tested message patterns" — is
a permanent maintenance treadmill against provider error-text drift.

### REJECT (mostly) — request budgets, leases-for-everything, relay-private headers
No evidence of runaway attempts: the candidate walk is bounded by pool size, repair by
`repair.maxAttempts`, and there are no hidden retries. The `x-llm-relay-max-*` request headers
fail this-installation-first — no client we run will ever set them. The one real concern inside
this section is the **paid boundary** (a typo'd spec or a mislabelled pool member spending
metered/primary quota during "free" offload). That survives as the slim candidate feature below —
not as a ledger.

### REJECT — adaptive per-target timeouts
The formula is made of guesses (500 tok/s in, 8 tok/s out, 1.5×p95, 15 s floor) baked into the
request path — numbers with no provenance, in a repo whose core rule is that a guess must never
look like a measurement. There is no observed timeout pain; the flat per-provider `timeoutMs` is
comprehensible and sufficient. Variable per-attempt deadlines also make behavior harder to reason
about — anti-transparency.

### REJECT — hierarchical scoped breakers with open-rejection and half-open admission
"Open scopes reject ordinary admission rather than merely moving to the end of the candidate
list" directly reverses a pinned invariant: **health demotes, never drops** — learned when
`filter(isHealthy)` narrowed a pool to nothing during a real outage. The five-scope hierarchy
(deployment/model/credential/account/provider) is multi-tenant machinery for a single-operator
relay. The real cases are already covered: `Retry-After` sets cooldowns, credential faults live
on their own axis and demote, catalog refresh restores de-listed models.

### REJECT — LLM failure classifier (its centerpiece)
Fails on every axis at once:
- **Boundary.** The project's one boundary is "fix protocol form, never judgment." Inserting an
  LLM's judgment into routing decisions crosses it in a new place.
- **Opt-in culture.** It defaults ON ("when a free/local classifier is available"). Offload — a
  far less invasive behavior — is opt-in by explicit owner decision.
- **Transparency.** A hidden background LLM call on unknown errors is precisely the "wonder
  what's happening" the owner wants eliminated.
- **Payoff.** Its only permitted effect is "authorize trying one next free candidate" — which
  deterministic failover already does for essentially every retriable case. The entire apparatus
  (sanitization, injection defense, evidence quotes, three modes, strict JSON validation) buys
  almost nothing over `shouldTryNext()`.
- **Treadmill.** "Observed recurring signatures should become deterministic provider rules" is an
  ongoing curation obligation, the opposite of stable-and-boring.

### REJECT (mostly) — trace store, trace headers, `route_exhausted` envelopes
Exhaustion is already self-describing (`x-llm-relay-served-by` lists every tried deployment; the
metadata-only log records attempts), and returning the last **real** upstream error over a
synthesized envelope is this repo's own maxim (cf. the context guardrail: an invented 400 is
worse than a true upstream error). A bounded in-memory trace store with a protected lookup
endpoint and a versioned record schema is enterprise observability for an audience of one.
Slim harvest below.

### HARVEST 1 — fix the three Codex ladder rungs (verified, do first)
Add `"--config", "model_reasoning_effort=xhigh"` to `codex-sol`, `codex-terra`, `codex-luna`
(the ones whose notes already claim xhigh), leave low-tier `codex-luna` at its explicit `high`,
restart the relay. One caveat the proposal glosses: the notes may themselves be copy-paste drift —
terra sits on the *high* tier and luna-medium on *medium*, yet all three notes say "xhigh."
Applying the notes as written matches the proposal; the owner should confirm that intent.

### HARVEST 2 — unify the two `/4` estimators
Delete `server.ts:1777`'s local copy; use `estimateRequestTokens()` everywhere. Pure dedup, no
behavior change intended. **Skip** the proposal's semantic estimator, bounds, confidence tiers,
and safety margins — `"confidence": "medium"` on a byte-ratio guess is fake provenance.

### HARVEST 3 — earliest-reset `Retry-After` on all-429 exhaustion (small, optional)
When every candidate 429'd, the client currently sees the *last* candidate's `Retry-After`, which
may be the worst one. Surfacing the earliest reset among the tried candidates is a small, honest
improvement that keeps the real-error-body design intact.

### HARVEST 4 — dispatch outcome distinction (small, optional)
Extending `POST /dispatch` so the host can report `rate_limited` (cooldown from `retryAfterMs`,
else short) vs `quota_exhausted` (longer) instead of one generic `exhausted` improves ladder
walks with almost no surface. **Skip** `dispatchId`/`correlationId` — nothing consumes them.

### DECIDE — `freeOnly` guard for offload rules (the one budget idea worth keeping)
Slim form of the proposal's `maxPaidAttempts: 0` + cost classes: a per-client
`routing.offload.<client>.freeOnly: true` that refuses (loud, clean error) rather than letting
offloaded traffic reach a metered or unknown-cost target. Cost class resolved as: published
zero/positive pricing → explicit override → `unknown`, with unknown treated as paid
(conservative) and the label carrying provenance like every other number here. Only worth
building if silent paid spend during offload is a worry the owner actually has — the pieces
(dynamic-pool free detection, catalog pricing) mostly exist.

## Recommended path forward

**Sprint 1 — de-drift and shrink (stabilize):**
1. Delete the unadopted kernel surface; keep `AttemptLifecycle` + the types it carries; scope the
   kernel architecture tests down. (Owner sign-off pending — see project-goals.md.)
2. Rewrite CLAUDE.md: re-center the mission (traffic control plane; repair demoted to one
   component), add the five missing modules to the architecture table, refresh the status section.
3. Delete or refresh `docs/fcc-replacement-assessment.md` (13 commits stale, untracked open items).
4. README friend-pass: add `help`/`version` to the command table, then dry-run the actual
   friend path — README + `llm-relay onboard` on a clean machine/profile — and fix what fails.
5. Apply the Codex ladder effort fix (live config; needs relay restart).

**Sprint 2 — harvests (independent, each with tests):**
6. Estimator dedup.
7. Earliest-reset `Retry-After` on all-429 exhaustion (optional).
8. Dispatch `rate_limited` vs `quota_exhausted` outcomes (optional).
9. `freeOnly` offload guard — only if the owner wants it.

**Explicitly rejected** (do not resurrect without new evidence): coordinated refactor, route
executor rewrite, request budgets/leases/headers, adaptive timeouts, scoped breakers with
open-rejection, LLM failure classifier, trace store + `route_exhausted` envelopes, estimator
confidence apparatus, removal of 400/404 failover.
