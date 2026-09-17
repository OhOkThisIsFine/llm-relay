# Rejection ledger — every "not adopted" item and the reason given (2026-08-16)

Assembled at the owner's request to re-examine whether the **reasons** are true, independent of who
first stated them. Sources: `freellmapi-adoption-review-2026-08-13.md` §3/§4/§5,
`adoption-round2-decisions-2026-08-14.md`, `suggestion-review-2026-08-04.md`,
`codex-review-2026-08-05.md`.

Grouped by the **kind of reason**, because that is what determines how you check it. The last column
is what would falsify the reason — the point is to make each one testable rather than rhetorical.

⚠ Reasons of kind A and E are cheap to check and reversible. Kind C reasons are the load-bearing
ones: each rests on a stated invariant, and if an invariant is wrong or narrower than recorded, every
rejection resting on it reopens at once.

---

## A. "llm-relay already has this" — second-implementation rejections

Falsifiable by reading llm-relay's source. If the equivalent is missing or weaker, the rejection is void.

| Rejected | Reason given | Falsified if |
|---|---|---|
| freellmapi's tool-call dialect rescue module | llm-relay has the capability (`tool-dialects.ts`, `dialect-stream.ts`, both paths wired); adopting the module = second implementation | llm-relay's parser covers fewer envelopes, or a path is unwired. **Partly falsified**: the OpenAI direct front was uncovered until `ba60568` (0.36.x) |
| Graded 429 penalty + penalty inspector | Breaker + `/candidates` cover both halves | Breaker lacks graded escalation. **Was true only after `ceb6b36` (2026-08-14)** — the reason post-dates the rejection |
| Console credential scrubbing | llm-relay's allowlist-at-the-sink is categorically stronger | A credential can reach a log through a non-allowlisted path |
| Substring error-scope classification | llm-relay's rule is lookup-never-inference | — (a deliberate design choice, not a capability claim) |
| Hand-rolled MCP server | Duplicates data the admin routes already serve | A client exists that can only speak MCP |
| Hand-rolled Anthropic/Responses fronts | That is `llm-bridge`'s job | llm-bridge stops covering a needed field |
| InboundChatWire vtable core | Both fronts share one policy, held by pinning tests | The two fronts diverge again (this bug shipped once already) |
| Declarative env config | Existing config + `${ENV}` expansion covers it | — |
| Median rank seeding | Already implemented as neutral-50 with basis labelling | — |
| `.env` drift detection | `llm-relay keys` answers it better | — |

## B. Dependency / footprint rejections

| Rejected | Reason given | Falsified if |
|---|---|---|
| Inbound image downscaling (sharp) | sharp is a **native** module with platform prebuilds — takes the project from 2 pure-JS runtime deps to 3, with its first native binary. *The 413 pain was confirmed real on this install.* | You decide the 413 pain outweighs the dependency rule, or a pure-JS downscaler is acceptable |
| SQLite facade, migrations, analytics aggregates, encrypted backups, DB-backed quirk registry | All presuppose a DB llm-relay deliberately lacks; `better-sqlite3`'s prebuild pain is a documented cost **on this very machine** | Versioned JSON stops being sufficient for some store |
| Docker / desktop-signing release machinery | Out of scope for a loopback personal tool | You want to distribute it that way |

## C. Invariant-based rejections — the load-bearing ones

Each names a stated project invariant. **If the invariant is wrong, everything under it reopens.**

### C1. "Credentials stay user-operated" (`project-goals.md:86`)
Rejects: per-key bandit selection, **credential pooling**, per-key proxy overrides, the
**RPM/RPD/TPM/TPD sliding-window ledger**, account-wide caps, quota-pool-key platform tables,
**key encryption at rest**, `client_profiles` (per-client minted keys + server-enforced prompts).

> Reason: the invariant rules out running logins, central key custody, and account pooling. Stated
> alternative — one provider entry per credential — already exists and keeps health/facts/provenance
> per credential. Key-encryption-at-rest additionally reasoned as: the master key sits in the same
> directory class as the ciphertext, reducing to filesystem ACLs.

⚠ **This is the widest-reaching invariant in the project, and the quota-ledger rejection is the one
most worth re-examining.** The ledger is *accounting*, not custody — it meters keys you already hold
yourself. It also carries a second, independent reason (C4, "one place per policy") and a third
(free providers publish no limits to meter against), so overturning the invariant alone would not
automatically adopt it.

### C2. "Health demotes, never drops" (learned from a real outage)
Rejects: hierarchical scoped breakers with open-rejection and half-open admission; probe
3-strikes auto-disable.

> Reason: open scopes rejecting admission directly reverses the invariant — learned when
> `filter(isHealthy)` narrowed a pool to nothing during a live outage. The five-scope hierarchy is
> multi-tenant machinery for a single-operator relay.

### C3. "Fix protocol form, never judgment" — the repair boundary
Rejects: **the LLM failure classifier**, response fusion, cross-model context-handoff injection.

> Reason: inserting an LLM's judgment into routing crosses the project's one red line. The classifier
> additionally defaults ON. Context handoff has the relay *authoring* conversation content and
> retaining bodies.

### C4. "One place per policy" / no second composite score
Rejects: in-flight concurrency leases, Thompson-sampled routing, the 10% exploration floor, strategy
weight vectors, per-model score multipliers, per-platform sampling droplists, per-model quirk and
reasoning-effort tables.

> Reason: a second *predictive* quota policy beside the breaker's reactive one; a random draw cannot
> answer "why this backend" reproducibly; the un-blended `/candidates` invariant forbids a second
> composite score. Hardcoded provider tables also violate provider-agnosticism.

⚠ Codex ranked in-flight leases **adopt-high** and was overruled. Recorded dissent: concurrent
subagents can all pick the same top deployment before any response updates health. The stated
counter is "worst case is one extra 429 the walk already absorbs."

### C5. "A guess must never look like a measurement"
Rejects: adaptive per-target timeouts; any speculative context-window fallback.

> Reason: the proposed formula (500 tok/s in, 8 tok/s out, 1.5×p95, 15s floor) is numbers with no
> provenance baked into the request path. No observed timeout pain; flat `timeoutMs` is sufficient.

### C6. Provider-agnosticism — no hardcoded provider knowledge in `src/`
Rejects: account-cap tables, quota-pool-key platform tables, per-platform max_tokens floors, model
unification groups (heuristic identity inference).

## D. Scope rejections — "no user or client of this relay needs it"

| Rejected | Reason given | Falsified if |
|---|---|---|
| Gemini + Ollama native fronts | No such client can reach this relay; Antigravity has no base-URL override | A client you use gains one |
| Compression pipeline + 8 engines + fidelity gate | headroom's job in this topology; freellmapi's own docs call chaining them redundant | You drop headroom |
| Exact-response caching | Agentic histories never repeat byte-identical; replaying tool calls is a safety hazard | A non-agentic workload appears |
| Structured-output enforcement + JSON healing | No client of this relay sends `response_format` | One appears |
| Embeddings / media management, meta-gateway contracts, ten-format agent-setup writer, scheduler abstraction (3 timers total), per-field catalog override ownership (no dashboard) | No consumer in this topology | A consumer appears |
| SSRF guarding of operator-typed URLs | The URLs are operator-typed, not attacker-supplied | Config becomes non-operator-authored |
| UA-based client classification | The called path is the stronger signal | — |
| Request budgets / relay-private `x-llm-relay-max-*` headers | No client we run will ever set them; no evidence of runaway attempts | — |
| Trace store + `route_exhausted` envelopes | Exhaustion is already self-describing; returning the last **real** upstream error beats a synthesized envelope | — |
| Removal of 400/404 failover | Not "blanket retry" — across heterogeneous providers a 400/404 usually means shape/model incompatibility on *that* deployment; bounded by pool size | A 400 is observed that should be terminal |

## E. Conditional skips — explicitly reversible on evidence

**These are not rejections. They are "not yet", and each names its trigger.**

| Skipped | Trigger that reopens it |
|---|---|
| Schema-key stripping (2.12) | A real provider bites. *If adopted: return a NEW tools array — immutability is the load-bearing lesson* |
| Single-tool-call coercion / parallel_tool_calls | A real sighting on this install |
| Wake-from-sleep recovery | A post-wake failure actually observed here; then Codex's minimal drift-detector, never the undici dispatcher swap |
| In-flight leases | Concurrent-subagent 429 storms become a **measured** problem; then the narrow version (in-memory per-deployment lease, stale-lease backstop, user-configured cap — no quota ledger) |
| Bare/fenced-JSON dialect envelope (2.7) | *Closed on the closed-envelope rule; 1.8's ASCII marker variant covers the marker cases* |

## F. "Built it, deleted it" rejections

| Rejected | Reason given |
|---|---|
| In-flight lease budgets | llm-relay built and then deleted this exact machinery — the unadopted kernel lease budgets removed 2026-08-04, which `CLAUDE.md` warns against rebuilding |
| Coordinated routing refactor / central route executor | Retroactively justifies the ~85% of `src/kernel/` that nothing used; resolves the half-built kernel in the wrong direction. Policy is already shared via `classifyStatus()`/`shouldTryNext()` with pinning tests |

---

## Where the reasons look weakest

Flagged on inspection, for the owner to judge:

1. **The quota-ledger rejection bundles three different reasons** (credential invariant + one-place-per-policy + "free providers publish no limits"). Only the third is a fact about the world; the first is arguably misapplied, since metering keys you already hold is not custody. Worth separating.
2. **Two "already have it" reasons post-date or overstate the capability** — the graded-429 reason became true only on 2026-08-14, and the dialect-rescue "both paths wired" claim was not true for the OpenAI direct front until 0.36.x. Both are now true; neither was when written.
3. **The sharp/image rejection concedes the pain is real** on this install and rejects purely on the dependency count. That is a genuine values trade, not a technical fact — it is the one most likely to be a misread of your priorities.
4. **"No client sends `response_format`" and "no client speaks MCP"** are true of today's clients only, and are cheap to re-check.
5. **The in-flight-lease rejection overruled the reviewer who ranked it highest**, on a worst-case estimate ("one extra 429") that has never been measured under concurrent subagents.
