---
title: "§2 Owner Decisions — Adoption Round 2"
date: 2026-08-14
status: advisory
authoring_lane: "in-session (author)"
caveat: "This is an ADVISORY lane deliverable. File:line claims must be re-verified at implementation time."
---

# §2 owner decisions — resolved 2026-08-14

All fourteen owner decisions from `docs/history/freellmapi-adoption-review-2026-08-13.md` §2 were put to the
owner via structured questions in this session and answered. This record is the input for updating
the review doc's §2 (mark each decided) and for building the implementation backlog. The session was
read-only; nothing in the repo has been edited yet.

## Adopted (12)

| Item | Decision | Scope notes fixed at decision time |
|---|---|---|
| 2.1 Dead turns | **Adopt — failover AFTER repair fails; buffered-only BY DESIGN.** | Repair-first contract preserved: only exhausted buffered repair resumes the candidate walk. Streaming commits deliberately at the first structured `tool_use`, per [the deferred-commit design](design-deferred-commit-2026-08-14.md), so an unrepairable streaming call is post-commit by definition. Walk resumption is structurally impossible there; the existing mid-stream fail-clean error remains correct behavior. This is not a deferral. |
| 2.2 Sticky sessions | **Adopt with guardrails.** | Owner overrode Codex's skip recommendation. Constraints from the review: provenance header, always loses to breaker/health ordering, NO response-body retention (metadata-only posture). 30-min pin keyed on session header or first-user-message hash. |
| 2.3 Escalating 429 cooldown | **Adopt.** | Both halves: 2m→10m→1h→day escalation with provenance tags + 5s short bench for loopback providers. Leave OUT numeric limit-learning from error bodies. |
| 2.4 Pool exclude list | **Adopt.** | User tombstone config field on dynamic pool policy; machine half (TTL facts) unchanged. |
| 2.5 onboard --import | **Adopt.** | Reuse authEnv closed alias list; drop looksLikeApiKey heuristic and CSV/JSONC/opencode formats. Concrete use: moving the 12 keys back from freellmapi's export. |
| 2.6 Attempts array in log | **Adopt.** | Statuses-only per-attempt list (provider/model/status/ms, no error text) through the LOG_FIELDS sink; include the `committed` outcome class. |
| 2.8 Model drift field | **Adopt.** | Nullable upstreamReportedModel/mismatch flag; never overwrites servedModel. |
| 2.9 Log rotation | **Adopt.** | Max-size/rotation pair on the one log file; principle only, no SQLite. |
| 2.10a Redact refusal sample | **Adopt.** | Sanitizer must run before BOTH signature and sample or be idempotent under normalization (refusal-interpretation.ts:649 seed recheck constraint). |
| 2.10b Windows ACLs (icacls) | **Adopt.** | Owner chose it despite the marginal-benefit note. Follows freellmapi's file-permissions leg; closes control-authorization.ts's admitted win32 no-op. |
| 2.11 Body-cap alignment | **Adopt.** | Wire cap configurable or at least consistent with documents.ts's 25MB; bounded; explicit 413 kept. |
| 2.13 Think tags | **Adopt — STRIP the block.** | Bounded four-state stream filter, ≤512B lead hold, one block, lossless flush on doubt. Strip (not text-prefix): unsigned thinking blocks don't round-trip anyway. |
| 2.14 Node range | **Raise engines to >=22.** (No Node-20 CI leg.) Node 20 is past EOL; declare what is tested. |

## Skipped (2)

- **2.7 Bare/fenced-JSON dialect envelope — skip.** The closed-envelope rule stands; 1.8's ASCII
  marker variant (already landed) covers the marker cases.
- **2.12 Schema-key stripping — skip until a real provider bites.** (Not selected in the
  breaker/pool batch; matches the review's own conditional framing.) If it ever lands: return a NEW
  tools array — the immutability constraint is the load-bearing lesson.

## §4 lane disagreements — status after these decisions

- In-flight leases: **skip** stands (review's own recommendation; nothing here reopened it).
- Sticky sessions: resolved by 2.2 above — adopt with guardrails.
- Wake-from-sleep recovery: **skip until observed** stands.

## Companion deliverables produced this session (docs/)

- [design-deferred-commit-2026-08-14.md](design-deferred-commit-2026-08-14.md) — Codex design pass for the §1.1 remainder (deferred
  header commit on both fronts).
- [design-cross-front-convergence-2026-08-14.md](design-cross-front-convergence-2026-08-14.md) — Gemini 3.7 Flash survey + table-driven cross-front test design
  (§6.1). Spot-checked: POOL_ATTEMPTS_HEADER pinning and the degraded-header zero-coverage claim
  both verified against test/. Key verified gaps: single-429 failover + Retry-After cooldown +
  pool-attempts header unpinned on the Anthropic front; 5xx→200 failover and the degraded header
  unpinned on BOTH fronts; freeOnly unpinned on the OpenAI front.
- [design-tarball-smoke-2026-08-14.md](design-tarball-smoke-2026-08-14.md) — free-pool lane design for the packed-artifact smoke test
  (§6.4). Spot-checked: package.json files whitelist and publish.yml:104/106/107 step order both
  verified. Placement: between build and check in publish.yml; publish-only (not ci.yml), with
  reasoning recorded.

All three lane outputs are ADVISORY — re-verify file:line claims during implementation.

## Suggested implementation order (for the next working session)

1. **2.14** engines >=22 (one line) + **2.11** body-cap alignment + **2.9** log rotation — trivial,
   independent.
2. **§6.1** cross-front convergence suite (new `test/cross-front-convergence.test.ts`) — lands the
   safety net BEFORE the behavior-changing items, and closes the verified pinning gaps.
3. **§6.4** tarball smoke step in publish.yml.
4. **2.3, 2.4, 2.6, 2.8** — breaker/pool/log items, each small and independently testable.
5. **2.1** dead-turn failover (buffered-only BY DESIGN) and **2.13** think-tag strip.
6. **2.5** onboard --import, **2.10a** redaction, **2.10b** icacls.
7. **§1.1 remainder** (deferred commit) per the Codex design — riskiest, last, with hanging-socket
   tests. The streaming revisit is closed: 2.1 cannot extend past the deliberate first-structured-
   `tool_use` commit boundary, because repair exhaustion is then post-commit.
8. **2.2** sticky sessions — design doc first (session key, TTL, provenance header name), since it
   is the one adopted item with real design latitude.
