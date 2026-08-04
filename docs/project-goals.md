# Project goals — working draft

> Status: **DRAFT under discussion** (2026-08-04). Being hashed out in conversation before any
> external suggestions are evaluated against it. Not yet authoritative; do not cite as policy.

## What llm-relay is for

**A personal LLM traffic control plane, built to be shareable.** It steers one person's LLM
traffic across providers and quotas — reliably, transparently, and with the minimum mechanism
that achieves that. It is published and installable because the owner will re-install it on new
machines and share it with friends, not because it is chasing a general audience.

- **Reliable** — failover, circuit breaking, health that survives restarts. Things keep working
  when a provider doesn't.
- **Transparent** — the user should never have to wonder what is happening in the background.
  "Just works" in operation, and when you *do* look, the metadata, logs, and metrics answer the
  question with provenance.
- **Lightweight** — llm-relay does only what is necessary. Minimal dependencies, no second
  implementation of anything, no speculative structure.
- **Tool-call repair is one small component**, not the project's identity. The docs currently
  mis-center it (CLAUDE.md's "What this is" leads with repair); that is drift from an agent's
  misreading, not the owner's intent.

Trajectory: **stabilize and harden.** A few features still to add/expand, some things to remove
(lists TBD in this discussion), then the goal is to stay stable. Explicitly *not* an
enterprise-grade project.

## Rubric for judging suggestions

Every proposed change should pass these, derived from the goals above:

1. **This installation first.** Does it help this setup, a fresh install on a new machine, or a
   friend's install? Features for hypothetical users fail.
2. **Transparency.** Does it reduce the "wonder what's happening" factor — or add a layer the
   user must now reason about?
3. **Minimal mechanism.** Is it the smallest change that does the job? Does it duplicate a
   definition, policy, or translation layer that already exists (llm-bridge, `credentialState()`,
   `documents.ts`, `tier-data.ts`)? One place per policy.
4. **Provenance.** Numbers and verdicts must carry where they came from; loud failure beats
   silent fallback; never guess.
5. **Toward boring.** Does it move the project toward stable-and-boring or toward
   enterprise-shaped? Structure-first proposals (new abstraction layers, versioned contract
   envelopes, migration phases) are presumptively wrong here.

## Kernel critique (src/kernel/) — assessment 2026-08-04

Adoption audit: only `AttemptLifecycle`/`AttemptLifecyclePort` (plus the types they carry:
`ProviderTargetIdentity`, `AttemptHandle`, outcome shapes) are wired in — `CircuitBreaker`
implements the port; `server.ts` consumes the types. Everything else in `contracts.ts` —
`CanonicalRequest`/`CanonicalMessage` IR, `ProviderTransport`, `CredentialHeaderPort`,
`DocumentTranscoder`, `AttemptLease`/`SpentAttemptLease`/budget machinery, `VersionedView` —
plus the whole `tier-snapshot.ts` module is referenced by **nothing** outside `src/kernel/`
except its own tests.

**Keep:** the attempt lifecycle. It encodes a bug class this repo actually shipped (the OpenAI
front bypassing breaker accounting — "two paths, two policies, one empty") as a typed handshake
with duplicate/foreign/cross-target rejection. That is behavior enforcement in one place —
consistent with the repo's existing philosophy.

**Delete (pending owner decision):** the unadopted surface. Reasons:
- The canonical IR + `ProviderTransport` duplicate llm-bridge's job; completing that migration
  means absorbing a translation layer the project deliberately outsources. Fails "lightweight."
- `CredentialHeaderPort` is a second home for a policy that already lives (hard-won) in
  `credentialState()`/`buildForwardHeaders()`. `DocumentTranscoder` duplicates `documents.ts`.
- `tier-snapshot.ts` is a parallel schema for `tier-data.json` used only by its own test — a
  green test guarding an unused artifact is false confidence, and two definitions of one schema
  is exactly the drift this repo's invariants exist to prevent.
- Dead aspirational contracts actively mislead future maintainers — who here are agents that
  read `contracts.ts` and will infer the ports are the intended architecture.
- Completing the migration is months of churn in the riskiest code for zero user-visible
  behavior — the opposite of "stabilize and harden."

## Doc drift found (2026-08-04)

- CLAUDE.md architecture table is missing: `src/kernel/` (4 files), `src/routes/admin.ts`
  (admin endpoints factored out of `server.ts`), `src/control-authorization.ts` (capability
  token for mutating control-plane endpoints), `src/request-log.ts` (`baseLog`/`logSafePath`
  extracted), `src/self-update.ts` (npm-registry version check + global-install self-update).
- CLAUDE.md "What this is" mis-centers repair (confirmed by owner as drift).
- CLAUDE.md "Nothing is pending in the code" predates the half-adopted kernel.
- README: essentially current (only `help`/`version` missing from the command table).
- `docs/fcc-replacement-assessment.md` was a snapshot at commit 799eed3 with open items nobody
  was tracking; deleted 2026-08-04.

## Friend-install standard (owner decision 2026-08-04)

A friend must succeed with **README + `llm-relay onboard` alone**, with minimal work on their
side. That pair is the supported install path — for friends and for the owner's own future
machines. Anything the install actually requires that lives only in CLAUDE.md or in chat history
is a bug against this standard.

## Open threads in the discussion

- Owner sign-off on the kernel deletion (critique above; recommended in the suggestion review).
- Owner decision on the `freeOnly` offload guard and the two optional harvests — see
  [suggestion-review-2026-08-04.md](suggestion-review-2026-08-04.md) for the full review and the
  recommended two-sprint path forward.
- Confirm intended reasoning effort per Codex ladder tier (notes say "xhigh" on three tiers —
  possibly copy-paste drift).
- CLAUDE.md rewrite to re-center the mission statement (queued in Sprint 1).
