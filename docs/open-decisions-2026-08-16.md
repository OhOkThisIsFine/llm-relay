# Open owner decisions — metering / fleet / quota program (2026-08-16)

**Owner disposition — 2026-08-21:** all recommendations in this document were approved as written.
They became implementation defaults, including their stated safety gates and deferrals. The later
2026-08-23 decisions recorded below waived M4's evidence gate and dropped P4; M4 and M3 were then
delivered on 2026-08-24. Neither is an unresolved implementation choice.

Eighteen decisions surfaced across the three design tracks. G1–G4 were resolved before
implementation; the owner disposition above closes the recommended defaults for the remaining
rows. The tables remain the rationale and implementation record.

Source documents:
- [rubric-recalibration-2026-08-16.md](rubric-recalibration-2026-08-16.md) — what was rejected, what voided it, 55 re-adjudications
- [quota-metering-spec-2026-08-16.md](quota-metering-spec-2026-08-16.md) — the tracking pipeline
- [credential-fleet-design-2026-08-16.md](credential-fleet-design-2026-08-16.md) — custody, pooling, cost accounting
- [rejection-ledger-2026-08-16.md](rejection-ledger-2026-08-16.md) — the original rejections and their reasons

---

## Gating — RESOLVED by the owner, 2026-08-16

| # | Decision | **Resolution** |
|---|---|---|
| G1 | Build order | **Stage 0, then pooling.** The `credentialState` refactor and per-credential keying first, then multi-key pooling on the env vars that already exist. Custody (Stage 3) follows once the resolver seam is proven rather than speculative. |
| G2 | May metering refuse a request? | **Demote-only, plus a manual per-credential hard cap.** A *derived* number may only demote a candidate to last resort. An explicit operator-set cap may refuse, loudly, with its own status and header. Rationale on record: a candidate never dispatched never returns a usage frame, so an over-count is self-perpetuating and unobservable. ⚠ **Status 2026-08-22:** the demote-only half is delivered (Stage 5 / Gap 12); the manual hard cap is **DELIVERED 2026-08-23** (`5e06a56`, v0.40.0): `limits.hard` on a provider / credential slot / `models.<id>` override refuses before egress with a relay 429 + `x-llm-relay-capped` + Retry-After from the UTC boundary; `routing.quota.hardCaps: false` disables. Design record in [metering-reconciliation-2026-08-22.md](metering-reconciliation-2026-08-22.md) §7. |
| G3 | Dashboard | **Full SPA port of freellmapi's Analytics page.** ⚠ Chosen against the recommendation — see the budget note below; this is a deliberate, stated trade. The [implementation design](spa-dashboard-design-2026-08-20.md) is complete. |
| G4 | Recover `repair-proxy-spec.md` | **Proceed on the reconstruction.** The commit evidence stands on its own: the day-one deferral, the same-day voiding of its premise, and the three unjoined mechanisms are all documented. No further provenance work. |

### ⚠ G3 changes the dependency and packaging budget — deliberately

Every other decision in this program was designed to cost **zero new runtime deps, no native module,
no database**. A full SPA port does not fit inside that envelope, and the trade should be visible
rather than discovered later:

- **A client build pipeline.** llm-relay ships `dist/` from `tsc` alone today. An SPA adds a bundler,
  a framework, and a chart library as devDependencies, plus built assets in the published package.
- **Package size.** Currently two runtime deps and a small tarball. Chart libraries are not small,
  and the tarball smoke gate in `publish.yml` would need to cover the built assets.
- **A second surface that must stay truthful.** The metrics evolve; a dashboard that drifts from the
  pipeline is worse than no dashboard, and `CLAUDE.md`'s own drift history says that happens here.
- **CI.** `npm run check` is the one gate. A client build needs its own gate or it will rot.

None of these is a reason not to do it — the invariants that would have auto-rejected it are removed,
and the owner has chosen it explicitly. The implementation specification was completed 2026-08-20
in [the Analytics SPA design](spa-dashboard-design-2026-08-20.md): design only, with no code,
dependencies, measurements, or implementation gates claimed.

---

## Metering and enforcement

| # | Decision | Recommendation |
|---|---|---|
| M1 | Should the headroom demotion band (ordering by provider-stated quota percent the relay already harvests) be **on by default** in the release that introduces it? | On, at a 10% floor. It is provider-stated — the strongest evidence class the project recognises — and it changes nothing today. Caveat: it silently changes routing order on upgrade. ✅ **Delivered** at the credential seam (`credential-select.ts` headroom banding), later joined at the deployment seam by Stage 5 / Gap 12. |
| M2 | Should a **learned** limit (parsed from vendor prose) ever gate routing, or stay display-only? | Display-only by default. A mis-parsed axis would throttle a healthy deployment on a number nobody stated. Opt-in later. ✅ **Delivered** exactly so: learned rate-limit facts are display-only, gating only under the explicit `routing.quota.enforceLearned` opt-in (Stage 5). |
| M3 | Should llm-relay ship an operator **"clear this cooldown"** mutation? | Only behind the control token plus the existing Origin/content-type/Host admission checks — never loopback alone. |
| M4 | Estimated **output** tokens at all, or render `-` when a provider omits usage? | Decide after Stage 1 measures how often usage is actually absent. |
| M5 | Retention horizon for `usage/<date>.json`. | 30 days — matches the widest window any surface offers; longer costs only disk. ✅ **Delivered** — production constructs the store with `retentionDays: 30` (`src/cli.ts`). |
| M6 | A **savings counterfactual** tile (freellmapi's "estimated savings $")? | Not as freellmapi implements it — it mixes an unlabelled fallback price into the same sum as real published prices and extrapolates 30 days from a shorter span. A correctly-provenanced version is a separate ask. |

## Cost accounting

| # | Decision | Recommendation |
|---|---|---|
| C1 | Is a **repair (reshaper) call's spend** charged to the request that triggered it, or reported separately? | Both — separate `role: "repair"` rows, with `llm-relay cost --include-repair` for the roll-up. Costs one flag, and "what did tool-call repair cost me" is worth being able to answer. ✅ **Delivered** (`llm-relay cost --include-repair`, commit `9fd9f36`). |
| C2 | How should the ledger treat the **Anthropic passthrough**, where the credential is the caller's own? | Record it, mark the row `caller-operated`, exclude from per-key totals and gates. ⚠ Without this it silently meters as a relay-held key, because `resolveAuthEnv` returns a name whenever `ANTHROPIC_API_KEY` is set even with no declared `authEnv`. |
| C3 | Anthropic **prompt-cache tokens** are dropped by the relay's own type. Recover by widening `AssistantMessage.usage`, or by reading the raw frame before narrowing? | Widen the type. It fixes a second defect — clients currently receive narrowed usage — but it changes the wire shape the relay emits. Cache reads and writes price very differently and Claude Code is a heavy cache user, so folding them into plain input over-states cost on the lane most worth metering. ✅ **Delivered** — type widened (commit `7abdaf2`); residual: streaming cross-protocol translation inside llm-bridge still drops cache fields (reconciliation §7). |
| C4 | Clock for period boundaries. | UTC for every provider-facing boundary, local only for human labels, with the surface stating which it used. freellmapi has both and they disagree. |

## Custody and pooling

| # | Decision | Recommendation |
|---|---|---|
| P1 | **Platform coverage** for custody. | Windows + macOS now, Linux later. Windows DPAPI is verified here; macOS `security` is always present; Linux realistically means passphrase mode, which needs an interactive unlock on every relay start and so conflicts with autostart-at-logon. |
| P2 | Does **rotation-triggered clearing** of `credential-invalid` need explicit ratification? | Accept the widening. Both stores currently say "only on a disproved STATED fact, never on any success", and a rotation is an operator *assertion* — but it is verified against what actually resolves before being honoured. The alternative leaves a rotated key artificially narrow for 15 minutes with no way to say so. |
| P3 | Should the usage store key on an opaque **credentialId** from day one, even while it is 1:1 with the provider? | Yes. Nearly free now, expensive to retrofit — scope keying is precisely what `target-facts.ts` was written to stop drifting. |
| P4 | What are **server-enforced system prompts** (`client_profiles` part 2) *for*? | Genuinely unknown. Its only recorded rejection reason was void (mis-bundled with credential custody), and no replacement reason was manufactured — deliberately, since inventing one is the failure this exercise exists to correct. Needs a purpose before it can be judged. |

---

## Not a decision — a correction already applied

`docs/status-vs-freellmapi-2026-08-16.md` cited `totalCompletionTokens` as evidence llm-relay "has
counters". That field has read `0` for the life of the file: `recordModelCall()` accepts a
`completionTokens` argument that its sole production call site never passes. Corrected in place, with
the error recorded rather than deleted.

---

## 2026-08-23 decisions

Made after the v0.43.0 release. Where these conflict with the rows above, these supersede — the P4
row above stays in place as history.

| # | Decision | **Resolution** |
|---|---|---|
| — | Custody/keystore program | **APPROVED — queued as the next sprint.** The metering gate was already lifted; work starts from [credential-fleet-design-2026-08-16.md](credential-fleet-design-2026-08-16.md)'s staged build order, not tonight. |
| M4 | Estimated-output producer (Gap 10) | **DELIVERED (`32f31c3`).** Attempt-scoped at the usage observer, separate from reported usage; the owner-waived producer is queued for v0.44.0. |
| M3 | Cooldown-clear mutation | **DELIVERED (`1ee1ad2`).** The route ships behind the control token plus the same Origin/content-type/Host admission checks as `/offload` and `/dispatch`; its scope grammar fails closed and it clears only cooling state. Queued for v0.44.0. |
| Gap 15 | Single-file HTML dashboard | **DROPPED**, not deferred — superseded by the shipped SPA (G3). Removed from the program of record. |
| Gap 16 | In-flight quota leases | **DROPPED**, not deferred — spec §5.4 already argued against it with no measured overshoot. Removed from the program of record. |
| P4 | Server-enforced system prompts (`client_profiles` part 2) | **DROPPED** — never acquired a purpose. Removed from the program of record. |
