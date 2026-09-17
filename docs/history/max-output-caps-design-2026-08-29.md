# Design proposal: learned max-output ceilings (display-only)

Status: **ACCEPTED** (owner decision 2026-08-29, at the triage lap's hand-back) and
**IMPLEMENTED** (2026-08-29, the following lap) exactly as scoped below: the `max-output`
measurement fact, the parser half in `src/context-limits.ts`, the observer beside
`observeContextLimit` in `inspectCandidateResponse`, and the `candidates` rendering.
Origin: triage follow-up,
[eligibility-triage-2026-08-29.md](eligibility-triage-2026-08-29.md) finding 2. Judged against
[project-goals.md](../project-goals.md) below.

## Problem and evidence

`groq/qwen/qwen3.6-27b` answered 13 requests with HTTP 400:

> `max_tokens` must be less than or equal to `N`, the maximum value for `max_tokens` is less than
> the `context_window` for this model

The body states an EXPLICIT output-token ceiling. Today no store can hold it: `context-limits.ts`
learns context windows, `rate-limits.ts` learns rate ceilings, and the eligibility queue can carry
a condition but never a VALUE. So the statement is discarded, the client keeps sending the same
oversized `max_tokens`, and the failure repeats on every walk that lands there. The carrier
signature sits pending in the eligibility queue as a deliberate reminder.

## Proposed mechanism

Mirror `rate-limits.ts` exactly — it is the established pattern for "a ceiling the deployment
stated about itself":

1. **One new measurement fact kind, `max-output`**, in `target-facts.ts` (30-day TTL, the
   measurement convention: success neither clears nor refreshes it, only age does). Scope
   `deployment` — the message names the model, never the account. The closed-vocabulary rule
   applies: `FACT_KINDS` derives from `FACT_TTL_MS`, and every total table over `FactKind` gets
   the new member at compile time.
2. **A parser with the context-limit discipline**: only an EXPLICIT stated maximum with a
   confidently identified number is recorded ("max_tokens must be less than or equal to 8192");
   "max_tokens too large" proves nothing and learns nothing. A miss is a no-op.
3. **Wired beside `observeContextLimit`** in `inspectCandidateResponse` — the one call site both
   fronts share, on 400/413 bodies only.
4. **Display-only**: `llm-relay candidates` renders kind + value + scope beside the rate-limit
   measurements. Nothing routes, demotes, refuses, or rewrites on it.

Explicitly OUT of scope, with the rule that excludes each:

- **Clamping the caller's `max_tokens`** — the repair boundary: the relay fixes protocol form,
  never rewrites the caller's request parameters. A silently clamped request is a judgment call
  the caller never sees.
- **A local pre-flight 400 on the learned cap** — the context guardrail's maxim: it fires only on
  a limit the SERVING provider published; extending refusals to learned figures would need its own
  opt-in (the `routing.quota.enforceLearned` shape) and is not part of this proposal.
- **A dispatch placeholder (`{maxOutput}`)** — possible later on the `{contextWindow}` precedent,
  but nothing requests it today.

## Judged against the project rubric

- *Does it steer traffic more reliably?* Not directly — display-only. It converts a repeating
  silent failure into a visible figure the operator can act on (fix the client's `max_tokens`,
  or pick another member).
- *Is it transparent with provenance?* Yes — a stated figure, labelled learned, never guessed.
- *Is it lightweight?* One fact kind + one parser + one render row. No new module, no new store.
- *Honest cost:* kind-churn through every total `FactKind` table, for a figure nothing acts on.
  The value is operator visibility only. If that visibility is not worth the churn, the honest
  alternative is to REJECT the carrier signature and record "the relay does not learn output
  caps" as a settled decision.

## Decision requested

Accept (implement as scoped above), or reject (reject the pending groq signature and close the
observation as settled). Either outcome retires the queue reminder.
