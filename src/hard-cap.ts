/**
 * G2's manual per-credential HARD CAP — the refusal half of the open decision the demotion term
 * (v0.38.0, `quota-demotion.ts`) only demoted on.
 *
 * The owner's rule, 2026-08-16: "A DERIVED number may only demote a candidate to last resort. An
 * explicit operator-set cap may refuse, loudly, with its own status and header." The dividing line
 * is provenance: a cap lives in config under the operator's own hand, so refusing on it is
 * enforcing the operator's own instruction, not acting on a guess. Everything derived — provider
 * headers, learned parses, published figures — stays on the demotion side of that line, which is
 * why this module reads ONLY the `hard` block and never consults observations.
 *
 * The `used` half is deliberately narrow: the relay reads its own in-memory ledger
 * (`AccountingStore.usedInWindow`, the SAME seam `quota-demotion.ts` reads) and nothing else. A
 * null reading — no store, no traffic this period — means NO refusal, because a guess must not
 * refuse. Month caps are not supported at all: `usedInWindow` declines month (the lifetime rollup
 * is root-aggregate across credentials, so no per-credential month figure can be narrowed), and a
 * cap the ledger cannot read would silently never fire — so config load rejects `mpd`/`mpm`
 * spellings outright (see `parseHardLimits`).
 *
 * ⚠ **A cap's SCOPE is part of the cap, and it comes from WHERE THE OPERATOR DECLARED IT** — the
 * rule `target-facts.ts` states for learned facts, applied to a declared one. Per axis:
 *
 *   - a FLAT cap (`limits.hard.<axis>`, on the provider block or on a credential slot) bounds
 *     that credential as a whole, so it is compared against the credential's usage ACROSS ALL
 *     MODELS;
 *   - a PER-DEPLOYMENT cap (`limits.models.<id>.hard.<axis>`, at either level) bounds one
 *     deployment, so it is compared against THAT model's usage on that credential and nothing
 *     else.
 *
 * Reading a per-deployment cap against the credential's whole usage would refuse `m/x` for
 * requests spent entirely on `m/y` — a false refusal on an operator-declared number, the exact
 * failure that "unknown ⇒ no refusal" exists to avoid. `resolveConfiguredLimits` already reports
 * WHICH declaration supplied each axis (`hardSource`), so the scope is read off the winning site
 * rather than chosen by the caller: every consumer (the request path, `/candidates`, the
 * dashboard producer) asks the ledger the same question and the three cannot drift.
 *
 * The comparison is INCLUSIVE: a cap of 450 admits 450 requests; the 451st is refused. Pure: no
 * IO, no clock of its own, and the ledger read is the store's in-memory window — never a disk
 * read, never a network call.
 */
import type { Config } from "./config.js";
import type { QuotaAxis } from "./quota-observation.js";
import {
  CONFIGURED_LIMIT_AXES,
  configuredLimitQuotaShape,
  resolveConfiguredLimits,
  type HardCapSource,
} from "./configured-limits.js";
import type { LocalUsedReading } from "./availability.js";
import { periodEnd } from "./availability.js";
// Canonical bucket order is the demotion term's, imported rather than re-stated: two copies of
// "requests before tokens, minute before day" is two things to keep in step for no gain.
import { bucketRank } from "./quota-demotion.js";

/** One reached ceiling — the smallest honest statement of "why this attempt was refused". */
export interface HardCapVerdict {
  readonly capped: true;
  readonly axis: QuotaAxis;
  /** Only minute/day exist: the ledger can read those windows and nothing else. */
  readonly period: "minute" | "day";
  /** The operator's own figure, verbatim. Never a derived or published number. */
  readonly cap: number;
  /** What the local ledger measured this period. ≥ cap by construction. */
  readonly used: number;
  /**
   * Where the CAP came from. Uniform by construction — a hard cap is only ever an operator's own
   * declaration — but stated rather than assumed, so a consumer rendering this figure beside a
   * `provider-stated` or `derived:*` one never has to know that by heart.
   */
  readonly basis: "operator-declared";
  /** Which declaration site supplied the winning axis — and so which usage scope it was read at. */
  readonly source: HardCapSource;
  /** Whose usage the cap was compared against: this credential as a whole, or one deployment. */
  readonly scope: HardCapScope;
  /** The UTC period boundary the cap lifts at — derived, never invented. */
  readonly resetsAt: number;
  readonly resetsAtBasis: "derived-boundary";
}

/**
 * Whose usage one axis is measured against — decided by the declaration site, never by the
 * caller. `credential` = every model this slot served this period; `deployment` = this model only.
 */
export type HardCapScope = "credential" | "deployment";

/**
 * The per-(axis, period, scope) ledger read the caller supplies.
 *
 * Axis-aware on purpose: a requests cap must be compared against a requests reading, never
 * against the token figure for the same window — merging the two would compare a count against a
 * token total. Scope-aware for the same reason at the other dimension: the caller narrows its
 * `usedInWindow` call to the attempt's model when, and only when, this module says the winning
 * declaration was per-deployment.
 */
export type HardCapUsedInWindow = (
  axis: "requests" | "tokens",
  period: "minute" | "day",
  scope: HardCapScope,
) => LocalUsedReading;

export interface HardCapInput {
  readonly cfg: Config;
  readonly provider: string;
  /** The credential slot the attempt would spend; null resolves only the provider-level block. */
  readonly credentialLabel: string | null;
  readonly model: string | null;
  readonly usedInWindow: HardCapUsedInWindow;
  readonly now: number;
}

/**
 * The usage scope one declaration site implies. A `models.<id>` entry names a deployment and
 * bounds only that deployment; a flat block names the credential (or the provider standing in
 * for every slot of it) and bounds the credential as a whole.
 */
function scopeOfSource(source: HardCapSource | undefined): HardCapScope {
  return source === "credential-model" || source === "provider-model" ? "deployment" : "credential";
}

/**
 * The G2 verdict for one credential×deployment cell, from the operator's `hard` block and the
 * local ledger. Null means NO OPINION — nothing declared, the switch off, or no readable usage —
 * and a null has no effect whatsoever on the walk.
 */
export function evaluateHardCap(input: HardCapInput): HardCapVerdict | null {
  // Default true: an operator who wrote a `hard` block meant it. `false` turns every cap into an
  // ordinary soft limit and costs one property read.
  if (input.cfg.routing.quota?.hardCaps === false) return null;

  const configured = resolveConfiguredLimits(input.cfg, input.provider, input.credentialLabel, input.model);
  if (configured === null) return null;

  // One read per (scope, period, axis) cell, memoized — so several hard axes sharing a window ask
  // the ledger once, and the per-request cost stays flat as caps accumulate. Scope is part of the
  // key because a credential-wide and a deployment-narrowed read of the same window are two
  // different questions with two different answers.
  const readings = new Map<string, LocalUsedReading>();
  const usedFor = (axis: QuotaAxis, period: "minute" | "day", scope: HardCapScope): LocalUsedReading => {
    const key = `${scope}:${period}:${axis}`;
    const cached = readings.get(key);
    if (cached !== undefined) return cached;
    const reading = input.usedInWindow(axis, period, scope);
    readings.set(key, reading);
    return reading;
  };

  const capped: Array<{
    axis: QuotaAxis;
    period: "minute" | "day";
    cap: number;
    used: number;
    source: HardCapSource;
    scope: HardCapScope;
  }> = [];
  const hard = configured.hard ?? {};
  for (const axis of CONFIGURED_LIMIT_AXES) {
    const cap = hard[axis];
    if (cap === undefined) continue;
    const shape = configuredLimitQuotaShape(axis);
    // The declaration site decides whose usage this ceiling bounds — see the scope note above.
    // `hardSource` is always populated beside a resolved `hard` axis; `credential` is the
    // conservative reading if it somehow is not, since a credential-wide figure is the SUPERSET
    // and so can only ever refuse where a narrower one also would.
    const source = configured.hardSource?.[axis] ?? "credential";
    const scope = scopeOfSource(source);
    const reading = usedFor(shape.axis, shape.period, scope);
    if (reading.value === null) continue; // unknown usage ⇒ no refusal, ever
    if (reading.value >= cap) {
      capped.push({ axis: shape.axis, period: shape.period, cap, used: reading.value, source, scope });
    }
  }
  if (capped.length === 0) return null;

  // Soonest lift wins: the actionable bound for a retry-after, and stable for identical evidence
  // because the buckets were gathered in canonical order.
  capped.sort((a, b) => bucketRank(a.axis, a.period) - bucketRank(b.axis, b.period));
  const first = capped[0]!;
  const end = periodEnd(input.now, first.period);
  // Unreachable for minute/day (both boundaries always resolve), but a null here must not become
  // a fabricated reset — the same fail-safe the demotion term applies.
  if (end === null) return null;
  return {
    capped: true,
    axis: first.axis,
    period: first.period,
    cap: first.cap,
    used: first.used,
    basis: "operator-declared",
    source: first.source,
    scope: first.scope,
    resetsAt: end,
    resetsAtBasis: "derived-boundary",
  };
}

/**
 * `"a/glm-5.2 requests/day 450/450"` — the bounded, metadata-only line the
 * `x-llm-relay-capped` header and the refusal body share. Names the credential label and
 * deployment (no key material), the axis/period, and the inclusive used/cap pair.
 */
export function hardCapLabel(credentialLabel: string | null, spec: string, verdict: HardCapVerdict): string {
  return `${credentialLabel ?? "-"}/${spec} ${verdict.axis}/${verdict.period} ${verdict.used}/${verdict.cap}`;
}
