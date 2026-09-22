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
3. **Minimal mechanism in the finished system.** Does the target architecture accomplish the goals
   with the least necessary complexity? Refactor size is not a priority. Prefer a maintained library
   when it reduces total maintenance responsibility; neither existing custom code nor dependency
   count is protected. Eliminate duplicated definitions, policies, ownership, and translation.
4. **Provenance.** Every reported number carries one of `provider-stated`, `derived`, `estimated`,
   or `operator-declared`; every verdict states its basis. A total mixing bases shows its split
   rather than quietly reporting one undifferentiated number; unknown stays `null`, never `0`.
   Tunable, documented defaults are allowed, but an estimate must never masquerade as a measurement
   and unpublished provider limits, prices, or context ceilings are never invented. Loud failure
   beats silent fallback.
5. **Toward boring.** Does the finished system become easier to understand and maintain? Real
   ownership boundaries and adopted library replacements are justified by the work they remove,
   even when the refactor is large. Speculative abstractions, unused parallel architectures, and
   enterprise machinery without a current product need remain wrong here.

## Architecture objective — owner clarification 2026-09-21

Optimize for the best code structure that accomplishes the project's goals, not the smallest
change to today's implementation. Preserve intended product contracts and safety guarantees;
existing internal topology and accidental behavior have no independent authority. Dependency
choices should minimize total maintenance burden, not the number of entries in `package.json`.

The target and execution sequence are recorded in
[`architecture-refactor-plan.md`](architecture-refactor-plan.md). It proposes one shared request
lifecycle, daemon ownership of complete dispatch jobs, transactional operational job state, and
maintained protocol/schema infrastructure. It is a plan, not a claim that the runtime has changed.

This clarification supersedes migration-size objections in historical assessments below. It does
not reinstate unused kernel ports or authorize speculative abstractions: replacements must be
adopted, preserve the relevant contracts, and delete the superseded implementation.

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
  `src/routes/admin.ts`, `src/control-authorization.ts`, `src/self-update.ts`),
  and a follow-up sweep on 2026-08-22 added every remaining uncovered module plus
  `test/architecture-map.test.ts`, which fails when any `src/` file lacks a table row.
- CLAUDE.md "What this is" was re-centered on the traffic-control-plane mission.
- README: essentially current (only `help`/`version`missing; code cleanup prohibited)