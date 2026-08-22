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
import type { Config } from "./config.js";
import type { QuotaAxis, QuotaPeriod } from "./quota-observation.js";

/** The closed set of axes an operator may assert: requests/tokens per minute/day. Nothing else. */
export const CONFIGURED_LIMIT_AXES = ["rpm", "rpd", "tpm", "tpd"] as const;

export type ConfiguredLimitAxis = (typeof CONFIGURED_LIMIT_AXES)[number];

/** One rate-limit figure per axis; an omitted axis is simply undeclared, never guessed. */
export interface ProviderRateLimits {
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
}

/**
 * A `limits` block: the flat axes plus optional per-deployment overrides keyed by BACKEND model
 * id (arbitrary ids on purpose — a catalog lookup here would make one provider's typo another
 * provider's problem, and free rosters churn). Per-axis resolution means a model entry naming
 * only `rpm` inherits `rpd`/`tpm`/`tpd` from above.
 */
export interface ProviderLimitsConfig extends ProviderRateLimits {
  models?: Record<string, ProviderRateLimits>;
}

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
  const value = raw as Record<string, unknown>;
  const axes: Record<string, unknown> = {};
  let modelsRaw: unknown;
  for (const [key, v] of Object.entries(value)) {
    if (key === "models") {
      modelsRaw = v;
      continue;
    }
    if (!(CONFIGURED_LIMIT_AXES as readonly string[]).includes(key)) {
      throw new Error(
        `${where}.${key} is not a known rate-limit axis (expected ${CONFIGURED_LIMIT_AXES.join(", ")})`,
      );
    }
    axes[key] = v;
  }

  const out: ProviderLimitsConfig = parseAxisValues(axes, where);
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
      // is the same silent-typo hazard as one at the top level.
      const entryValue = entry as Record<string, unknown>;
      for (const key of Object.keys(entryValue)) {
        if (!(CONFIGURED_LIMIT_AXES as readonly string[]).includes(key)) {
          throw new Error(
            `${where}.models.${JSON.stringify(modelId)}.${key} is not a known rate-limit axis ` +
              `(expected ${CONFIGURED_LIMIT_AXES.join(", ")})`,
          );
        }
      }
      models[modelId] = parseAxisValues(entryValue, `${where}.models.${JSON.stringify(modelId)}`);
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

/** What `resolveConfiguredLimits` returns: figures plus WHICH declaration supplied each. */
export interface ConfiguredLimits {
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
  /** Uniform by construction — every figure here came out of config, never from a probe. */
  basis: "configured";
  source: Partial<Record<ConfiguredLimitAxis, ConfiguredLimitSource>>;
}

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

  const out: ConfiguredLimits = { basis: "configured", source: {} };
  for (const axis of CONFIGURED_LIMIT_AXES) {
    const fromCredentialModel =
      model !== null ? credentialLimits?.models?.[model]?.[axis] : undefined;
    const fromProviderModel = model !== null ? providerLimits?.models?.[model]?.[axis] : undefined;
    const fromCredential = credentialLimits?.[axis];
    const fromProvider = providerLimits?.[axis];
    if (fromCredentialModel !== undefined) {
      out[axis] = fromCredentialModel;
      out.source[axis] = "credential-model";
    } else if (fromProviderModel !== undefined) {
      out[axis] = fromProviderModel;
      out.source[axis] = "provider-model";
    } else if (fromCredential !== undefined) {
      out[axis] = fromCredential;
      out.source[axis] = "credential";
    } else if (fromProvider !== undefined) {
      out[axis] = fromProvider;
      out.source[axis] = "provider";
    }
  }
  if (Object.keys(out.source).length === 0) return null;
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
