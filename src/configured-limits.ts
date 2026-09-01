/**
 * Operator-declared rate limits — spec §4 "Rung 3: CONFIGURED, operator-asserted".
 *
 * A published table cannot express what an operator knows and no ledger can measure: one
 * account's daily ceiling is shared across EVERY model and key on that account, and inferring it
 * by counting is exactly what `target-facts.ts` forbids. So it is declared in config, and
 * `configured` is its honest provenance label — a sibling to `provider-stated` and
 * `derived:<x>`, never passed off as a measurement.
 *
 * Pure lookups only: no IO, no clock, no request-path role of its own. The availability ladders
 * (spec §5) consume these figures; the limits themselves never refuse a request.
 *
 * This module deliberately carries the whole axis vocabulary so a consumer (the availability
 * lane, a CLI renderer) can import it WITHOUT dragging config internals: the `Config` edge below
 * is type-only and erased at runtime.
 */
import type { Config } from "./config-types.js";
import type { QuotaAxis, QuotaPeriod } from "./quota-observation.js";
import {
  CONFIGURED_LIMIT_AXES,
  type ConfiguredLimitAxis,
  type HardRateLimits,
  type ProviderRateLimits,
  type ProviderLimitsConfig,
} from "./config-types.js";

export {
  CONFIGURED_LIMIT_AXES,
  type ConfiguredLimitAxis,
  type HardRateLimits,
  type ProviderRateLimits,
  type ProviderLimitsConfig,
};

/**
 * Validate one flat axis set. Every figure is a POSITIVE SAFE INTEGER: a ceiling of 0 or a float
 * is not a limit anyone asserted, and silently coercing one would publish a number nobody stated.
 */
function parseAxisValues(raw: Record<string, unknown>, where: string): ProviderRateLimits {
  const out: ProviderRateLimits = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new Error(
        `${where}.${key} must be a positive integer; got ${JSON.stringify(value)}`,
      );
    }
    out[key as ConfiguredLimitAxis] = value as number;
  }
  return out;
}

/** Recognize one member of the closed axis vocabulary. */
function isConfiguredLimitAxis(key: string): key is ConfiguredLimitAxis {
  return (CONFIGURED_LIMIT_AXES as readonly string[]).includes(key);
}

/**
 * Validate the `hard` sub-block of a `limits` declaration at load time. FLAT AXES ONLY: a
 * per-deployment cap rides inside that deployment's own limits entry
 * (`limits.models.<id>.hard`), so every `limits` block — provider, slot or model override —
 * carries exactly the same grammar and the resolver can mirror the soft ladder site for site.
 * Month/hour/week spellings (`mpd`, `rph`) are not in the axis list, so they are rejected BY
 * NAME rather than silently ignored: a cap the ledger cannot read could never fire, and its
 * presence would lie about what this relay enforces.
 */
export function parseHardLimits(raw: unknown, where: string): HardRateLimits | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be an object of rate-limit axes`);
  }
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!isConfiguredLimitAxis(key)) {
      // Month ceilings are refused, not ignored: the ledger's window read declines month
      // (`usedInWindow` returns no figure), so such a cap could never fire and its presence would
      // be a lie about what this relay enforces. See docs/reference.md "Hard caps".
      throw new Error(
        `${where}.${key} is not a known hard-cap axis (expected ${CONFIGURED_LIMIT_AXES.join(", ")}); ` +
          `minute/day periods only — a per-deployment cap belongs in that model's own limits entry`,
      );
    }
  }
  return parseAxisValues(raw as Record<string, unknown>, where);
}

/** Parse the grammar shared by a provider/credential block and each of its model entries. */
function parseLimitEntry(
  raw: Record<string, unknown>,
  where: string,
  allowModels: boolean,
): readonly [limits: ProviderRateLimits, modelsRaw: unknown] {
  const axes: Record<string, unknown> = {};
  let modelsRaw: unknown;
  let hardRaw: unknown;
  for (const [key, value] of Object.entries(raw)) {
    if (allowModels && key === "models") {
      modelsRaw = value;
      continue;
    }
    if (key === "hard") {
      hardRaw = value;
      continue;
    }
    if (!isConfiguredLimitAxis(key)) {
      throw new Error(
        `${where}.${key} is not a known rate-limit axis (expected ${CONFIGURED_LIMIT_AXES.join(", ")})`,
      );
    }
    axes[key] = value;
  }

  const limits = parseAxisValues(axes, where);
  const hard = parseHardLimits(hardRaw, `${where}.hard`);
  if (hard !== undefined) limits.hard = hard;
  return [limits, modelsRaw];
}

/**
 * Validate a `limits` block at load time.
 *
 * A malformed block is a HARD ERROR, not a dropped field: these figures gate how much traffic a
 * credential may absorb, so a typo ("RPM", "rps", "tph") that were silently ignored would look
 * like a declared ceiling while asserting nothing — the operator believes the lane is bounded
 * when it is not. That is worse than refusing to start, which is why this does not follow the
 * credentials[] convention of dropping the bad slot with a warning. Unknown keys are rejected by
 * NAME because the closed axis list IS the feature; `models` keys are arbitrary backend model
 * ids and are deliberately not checked against any catalog.
 *
 * Returns undefined when nothing was declared; `{}` is legal and declares nothing.
 */
export function parseConfiguredLimits(raw: unknown, where: string): ProviderLimitsConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be an object of rate-limit axes`);
  }
  const [parsed, modelsRaw] = parseLimitEntry(raw as Record<string, unknown>, where, true);
  const out: ProviderLimitsConfig = parsed;
  if (modelsRaw !== undefined) {
    if (typeof modelsRaw !== "object" || modelsRaw === null || Array.isArray(modelsRaw)) {
      throw new Error(`${where}.models must be an object mapping backend model ids to limit axes`);
    }
    const models: Record<string, ProviderRateLimits> = {};
    for (const [modelId, entry] of Object.entries(modelsRaw as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`${where}.models.${JSON.stringify(modelId)} must be an object of rate-limit axes`);
      }
      // A model override goes through the SAME closed-axis check — an "RPM" inside a model entry
      // is the same silent-typo hazard as one at the top level. `allowModels` is false here, so a
      // nested `models` key is rejected by that same closed-axis check rather than recursing.
      const [parsedEntry] = parseLimitEntry(
        entry as Record<string, unknown>,
        `${where}.models.${JSON.stringify(modelId)}`,
        false,
      );
      models[modelId] = parsedEntry;
    }
    if (Object.keys(models).length > 0) out.models = models;
  }
  return out;
}

/** Where one axis' figure was found in the declaration ladder, most-specific first. */
export type ConfiguredLimitSource =
  | "provider"
  | "credential"
  | "provider-model"
  | "credential-model";

/** Where one hard-cap axis' figure was found; alias for ConfiguredLimitSource. */
export type HardCapSource = ConfiguredLimitSource;

/** What `resolveConfiguredLimits` returns: figures plus WHICH declaration supplied each. */
export interface ConfiguredLimits {
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
  /**
   * G2 refusal ceilings resolved through the SAME per-axis ladder as the soft figures. Present
   * ONLY when something hard was declared anywhere on this provider/slot pair — a result with no
   * caps carries no `hard` key at all, keeping the pre-G2 soft shape byte-identical for callers
   * that never opted in.
   */
  hard?: HardRateLimits;
  /** Which declaration level supplied each hard axis — provenance beside every ceiling. */
  hardSource?: Partial<Record<ConfiguredLimitAxis, ConfiguredLimitSource>>;
  /** Uniform by construction — every figure here came out of config, never from a probe. */
  basis: "configured";
  source: Partial<Record<ConfiguredLimitAxis, ConfiguredLimitSource>>;
}

type LimitDeclaration = readonly [
  source: ConfiguredLimitSource,
  limits: ProviderRateLimits | undefined,
];

/**
 * Resolve the operator-declared limits for one target, or null when nothing is declared for it.
 *
 * Precedence is per AXIS, most-specific first: a credential's model override beats the
 * provider's model override beats that credential's flat limits beats the provider's flat
 * limits. Independent resolution is the point — a model override that sets only `rpm` inherits
 * `rpd`/`tpm`/`tpd` from above rather than blanking them.
 *
 * Never sums across credentials (each slot is its own metered allowance) and never invents an
 * axis nobody wrote. A `credentialLabel` naming no declared slot simply falls through to the
 * provider level — the relay narrows only what config actually declares.
 */
export function resolveConfiguredLimits(
  cfg: Config,
  provider: string,
  credentialLabel: string | null,
  model: string | null,
): ConfiguredLimits | null {
  const p = cfg.providers[provider];
  const providerLimits = p?.limits;
  // Read the slot BEFORE any early return: a credential declaring its own block under a provider
  // with no flat block is exactly the shape config.example.json ships, so bailing out on the
  // missing provider block would hide a declaration this module's own parser hard-validates.
  const credentialLimits =
    credentialLabel === null || p === undefined
      ? undefined
      : p.credentials?.find((c) => c.label === credentialLabel)?.limits;
  if (providerLimits === undefined && credentialLimits === undefined) return null;

  const ladder: readonly LimitDeclaration[] = [
    ["credential-model", model !== null ? credentialLimits?.models?.[model] : undefined],
    ["provider-model", model !== null ? providerLimits?.models?.[model] : undefined],
    ["credential", credentialLimits],
    ["provider", providerLimits],
  ];
  const out: ConfiguredLimits = { basis: "configured", source: {} };
  const hard: HardRateLimits = {};
  const hardSource: Partial<Record<ConfiguredLimitAxis, HardCapSource>> = {};
  let hardDeclared = false;
  for (const axis of CONFIGURED_LIMIT_AXES) {
    // The two figures resolve independently while walking the SAME precedence ladder.
    for (const [source, limits] of ladder) {
      const softValue = limits?.[axis];
      if (out[axis] === undefined && softValue !== undefined) {
        out[axis] = softValue;
        out.source[axis] = source;
      }
      const hardValue = limits?.hard?.[axis];
      if (hard[axis] === undefined && hardValue !== undefined) {
        hard[axis] = hardValue;
        hardSource[axis] = source;
        hardDeclared = true;
      }
      if (out[axis] !== undefined && hard[axis] !== undefined) break;
    }
  }
  // Attached only when something was declared, so a no-cap resolution keeps the exact pre-G2
  // shape (`{rpm, basis, source}`) and an absent axis stays indistinguishable from "no cap".
  if (hardDeclared) {
    out.hard = Object.freeze(hard);
    out.hardSource = Object.freeze(hardSource);
  }
  if (Object.keys(out.source).length === 0 && !hardDeclared) return null;
  return Object.freeze(out);
}

/**
 * Map an axis onto the quota-observation vocabulary, so a consumer can stand a configured
 * ceiling BESIDE a provider-stated observation for the same (axis, period) bucket instead of
 * inventing its own dimension names.
 */
export function configuredLimitQuotaShape(axis: ConfiguredLimitAxis): {
  axis: QuotaAxis;
  period: Extract<QuotaPeriod, "minute" | "day">;
} {
  switch (axis) {
    case "rpm":
      return { axis: "requests", period: "minute" };
    case "rpd":
      return { axis: "requests", period: "day" };
    case "tpm":
      return { axis: "tokens", period: "minute" };
    case "tpd":
      return { axis: "tokens", period: "day" };
  }
}
