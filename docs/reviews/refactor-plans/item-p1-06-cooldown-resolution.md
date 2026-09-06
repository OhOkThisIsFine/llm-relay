# P1-06 — Cooldown Resolution Consolidation (SEM-06, `resolveCooldownMs`)

Scope: consolidate scattered cooldown and retry-after arithmetic plus bounds capping
across `src/dispatch.ts` and `src/circuit-breaker.ts` (with documented consumers in
`src/lane-cadence.ts`, `src/target-facts.ts`, `src/lane-quota-probe.ts`, and
`src/routes/admin.ts`) behind one authoritative evaluator.
Adversarial verdict: ACCEPT per `docs/reviews/adversarial-verification-2026-09-05.md`,
with the attribution fix that the day-scale cap lives in `src/dispatch.ts`.

## Architectural rationale and layering

Target location: the new `resolveCooldownMs` evaluator lives in `src/dispatch.ts`
(or in the kernel beside it if the kernel owns shared dispatch vocabulary at
implementation time). Rationale:

- The ceiling (`MAX_EXHAUSTED_MS`) and the outcome defaults (`OUTCOME_DEFAULT_MS`)
  already live in `src/dispatch.ts`; the floor-plus-ceiling evaluator belongs with
  the constants it applies so the policy has one home.
- Dependency direction is already consumer → `dispatch.ts` (lane-cadence, the quota
  probe, and the admin route all import dispatch vocabulary today). The breaker
  calls the evaluator as a pure function; the evaluator never imports the breaker,
  so no cycle is introduced.
- The alternative (housing the evaluator in `circuit-breaker.ts`) would force
  dispatch-level consumers (probe caps, admin outcome defaults, exhaustion
  persistence clamps) onto a breaker import, inverting the layer.

## Complete blast radius

Policy constants and functions:

- Constant `MAX_EXHAUSTED_MS` in `src/dispatch.ts` — the day-scale ceiling applied by
  function `normalizeTtl` (the write clamp), by the restore clamp neighboring it,
  and by the cooldown-write clamp.
- Constant `OUTCOME_DEFAULT_MS` in `src/dispatch.ts` — the per-outcome defaults
  (`rate_limited`, `quota_exhausted`) with the documented explicit-beats-default rule.
- Function `failureCooldown` in `src/circuit-breaker.ts` — the floor-plus-ceiling
  evaluator for generic failures (floor from `DEFAULT_COOLDOWN_MS`, ceiling from
  `MAX_RETRY_AFTER_MS`), with the measured 43-hang incident documented above its
  definition.
- Constants `DEFAULT_COOLDOWN_MS`, `MAX_RETRY_AFTER_MS`, `MIN_RETRY_AFTER_MS`,
  plus the escalation table `RATE_LIMIT_ESCALATION_MS`, the loopback constant
  `LOOPBACK_RATE_LIMIT_COOLDOWN_MS`, and the quota constant
  `QUOTA_EXHAUSTED_COOLDOWN_MS` in `src/circuit-breaker.ts` — read the evaluator
  contract before changing any of them.
- The `MAX_RETRY_AFTER_MS` clamp inside the breaker health path (the arm neighboring
  the cooldown computation) — a consumer of the ceiling, not a second policy.

Consumers (all preserve explicit-beats-default semantics):

- The `OUTCOME_DEFAULT_MS` read in `src/lane-cadence.ts` neighboring the
  `verdict.retryAfterMs` nullish-coalescing expression.
- The stated-greater-than-zero gate plus basis binding in `src/target-facts.ts`
  neighboring the reset-basis documentation.
- The probe cap in `src/lane-quota-probe.ts` neighboring the per-unit rounding
  expression.
- The `OUTCOME_DEFAULT_MS` read in `src/routes/admin.ts` neighboring the outcome
  guard.
- The `normalizeTtl` function plus restore and write clamps in the exhaustion
  persistence path (reached via `normalizeTtl` in `src/dispatch.ts`) — the
  attribution fix confirms this path inherits its cap from dispatch, it does not
  own one.
- The `IGNORED_TTL_MS` constant in `src/refusal-interpretation.ts` and the
  day-scale fact TTL in `src/target-facts.ts` — adjacent policy constants that stay
  as-is; this plan only routes their computation through the evaluator where they
  already clamp.

Suites: dispatch suites, circuit-breaker suites, lane-cadence suites, quota-probe
suites, target-facts suites, and admin dispatch-view suites.

## Specific code modifications with contracts

New contract in `src/dispatch.ts`:

```typescript
export interface CooldownCaps {
  readonly floorMs: number;
  readonly ceilingMs: number;
}

export function resolveCooldownMs(
  explicitMs: number | null | undefined,
  outcome: DispatchOutcome | undefined,
  caps?: Partial<CooldownCaps>,
): { ms: number; source: "explicit" | "outcome-default" | "floor" | "ceiling" };
```

Contract:

- An explicit, finite, positive value wins (clamped into floor-plus-ceiling) —
  the explicit-beats-default rule verified at every site.
- Otherwise the outcome default applies when an outcome is known, else the floor.
- The result is always within floor-plus-ceiling; defaults resolve the caps
  (`floorMs` from the dispatch floor, `ceilingMs` from `MAX_EXHAUSTED_MS`) so
  existing call sites pass no caps and change no behavior.
- Pure: no clock reads, no store writes; clamping is the only response to an
  out-of-range input (never a throw), matching the documented advisory-cooldown
  property above `MAX_EXHAUSTED_MS`.

Before (inside function `failureCooldown` in `src/circuit-breaker.ts`, at the anchor
of the wasted-computation expression):

```typescript
const wasted = Number.isFinite(elapsedMs) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, elapsedMs)) : 0;
return wasted > DEFAULT_COOLDOWN_MS
  ? { ms: wasted, source: "elapsed" }
  : { ms: DEFAULT_COOLDOWN_MS, source: "default" };
```

After (same anchor — the breaker keeps its floor and ceiling, the evaluator owns the
arithmetic):

```typescript
return resolveCooldownMs(Number.isFinite(elapsedMs) ? elapsedMs : null, undefined, {
  floorMs: DEFAULT_COOLDOWN_MS,
  ceilingMs: MAX_RETRY_AFTER_MS,
});
```

Before (inside function `normalizeTtl` in `src/dispatch.ts`, at the anchor of the
min-max clamp expression):

```typescript
return Math.min(MAX_EXHAUSTED_MS, Math.max(0, ttlMs));
```

After (same anchor):

```typescript
return resolveCooldownMs(ttlMs, undefined, { floorMs: 0, ceilingMs: MAX_EXHAUSTED_MS }).ms;
```

Before (in `src/lane-cadence.ts`, at the anchor neighboring the
`verdict.retryAfterMs` nullish-coalescing expression):

```typescript
const ttl = verdict.retryAfterMs ?? OUTCOME_DEFAULT_MS[verdict.outcome];
```

After (same anchor):

```typescript
const ttl = resolveCooldownMs(verdict.retryAfterMs, verdict.outcome).ms;
```

The probe cap, the admin outcome read, and the restore/write clamps change
identically: keep their anchors, replace the inline min-max or nullish-coalescing
expression with the evaluator call.

## Step-by-step implementation sequence

1. Add `resolveCooldownMs` plus the `CooldownCaps` interface to `src/dispatch.ts`
   with unit tests pinning explicit-beats-default, floor, ceiling, and source
   labels.
2. Rewire function `normalizeTtl` first (dispatch-owned, lowest risk); verify with
   the dispatch suites.
3. Rewire function `failureCooldown` in `src/circuit-breaker.ts`, mapping its
   `elapsed` / `default` sources onto the evaluator's source labels; verify with
   the breaker suites.
4. Rewire the `lane-cadence.ts` outcome-default read; verify.
5. Rewire the probe cap, the admin outcome read, and the restore/write clamps one
   at a time, verifying after each.
6. Run the full verification plan; leave `IGNORED_TTL_MS` and the fact TTL
   constants untouched.

## Verification and regression test plan

```powershell
npm test -- test/dispatch.test.ts
npm test -- test/circuit-breaker.test.ts
npm test -- test/lane-cadence.test.ts
npm test -- test/lane-quota-probe.test.ts
npm test -- test/target-facts.test.ts
npx tsc --noEmit
```

(Substitute the owning directory suite where a file name differs in the working
tree.)

Invariant assertions:

- Explicit-beats-default holds at every rewired site: a stated retry-after value
  inside bounds survives unchanged through the evaluator.
- Bounds hold everywhere: no evaluator output exceeds its ceiling or falls below
  its floor on a fuzz corpus of negative, zero, fractional, non-finite, and
  over-ceiling inputs.
- Breaker incident property preserved: a slow failure (waste above the floor)
  cools for the measured waste, a fast failure keeps the floor.
- No line-number references introduced.
