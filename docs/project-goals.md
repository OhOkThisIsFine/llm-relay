# Project goals

> Status: **ratified by the owner 2026-08-04** (hashed out in conversation, then confirmed).
> This is the standing statement of what llm-relay is for and the rubric every proposed change
> is judged against. Change it only with the owner.

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
   `documents.ts`, `tier-data.ts`)?
4. **Provenance.** Every reported number carries one of `provider-stated`, `derived`, `estimated`,
   or `operator-declared`; every verdict states its basis. A total mixing bases shows its split
   rather than quietly reporting one undifferentiated number; unknown stays `null`, never `0`.
   Tunable, documented defaults are allowed, but an estimate must never masquerade as a measurement
   and unpublished provider limits, prices, or context ceilings are never invented. Loud failure
   beats silent fallback.
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

## Doc drift found (2026-08-04) — resolved

All of the drift found that day was fixed in the same cycle:

- CLAUDE.md's architecture table gained the then-missing rows (`src/kernel/`,
  `src/routes/admin.ts`, `src/control-authorization.ts`, `src/request-log.ts`, `src/self-update.ts`),
  and a follow-up sweep on 2026-08-22 added every remaining uncovered module plus
  `test/architecture-map.test.ts`, which fails when any `src/` file lacks a table row.
- CLAUDE.md "What this is" was re-centered on the traffic-control-plane mission.
- The kernel surface question was closed by deletion; only the adopted attempt lifecycle remains.
- README: essentially current (only `help`/`version` missing from the command table at the time).
- `docs/fcc-replacement-assessment.md` was a snapshot at commit 799eed3 with open items nobody
  was tracking; deleted 2026-08-04.

## Accounting metering (owner-restated 2026-08-16)

**Knowing what each credential has used, how much is left, and at what rate is a founding goal of
this project.** It was deferred when the project began, then this relay absorbed the routing work
without bringing the accounting work along. That gap is now deliberately closed.

llm-relay must answer, per credential and per deployment: **how much was used, how much remains,
and the rate.** Counting is unconditional and needs no published limit. Acting on counts is
optional, always announced, and may only reorder.

The ledger is **accounting, not custody**: it meters keys the operator already holds. It does not
authorise the relay to obtain, store, mint, or centrally proxy credentials.

There is no hosted relay and no pooled consumer accounts: the relay never operates a login, never
asks anyone to paste a Claude token into it, and never centrally proxies another person's
subscription traffic. Each person runs their own instance with their own keys. This bars shared or
hosted deployment, but does not bar counting, ordering, or holding several keys belonging to that
operator.

**⚠ Decisions made on the strength of an invariant must be stated OUT LOUD.** If a request is
narrowed, declined, or redesigned because of a rule, say so in the response — name the invariant,
say what it ruled out, and say what was done instead. An invariant that silently shapes work is
indistinguishable from an agent being unhelpful for its own reasons, and the owner cannot overrule a
constraint they were never told was applied. This is a standing instruction from the owner, and it
applies to any project invariant that changes what gets built.

## Friend-install standard (owner decision 2026-08-04)

A friend must succeed with **README + `llm-relay onboard` alone**, with minimal work on their
side. That pair is the supported install path — for friends and for the owner's own future
machines. Anything the install actually requires that lives only in CLAUDE.md or in chat history
is a bug against this standard.

## Resolution (2026-08-04, v0.16.0)

Every thread from the discussion closed the same day, shipped as 0.16.0:

- **Kernel**: owner signed off on deletion; only the adopted attempt lifecycle remains.
- **Harvests**: all four landed (freeOnly guard, earliest-reset Retry-After, dispatch outcome
  split, estimator unification). The rejected remainder is documented with reasons in
  [suggestion-review-2026-08-04.md](suggestion-review-2026-08-04.md).
- **Codex ladder**: owner confirmed xhigh-on-three-tiers was intent, not drift; the missing
  effort flags were added to the personal config (not the package).
- **Docs**: CLAUDE.md re-centered on the traffic-control-plane mission; README friend-passed
  against the "README + onboard alone" standard; the stale assessment doc deleted.
- **Personal config**: `freeOnly: true` set on both existing offload rules.

Open (minor), closed 2026-08-22: `llm-relay offload status` now renders the **effective**
`freeOnly` — explicit ON/OFF, with unset shown as its two-sided default rather than a bare field —
so the transparency gap in the table rendering is closed.
