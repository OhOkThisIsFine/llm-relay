export const TIER_SNAPSHOT_SCHEMA_VERSION = "llm-relay/tier-snapshot/v1" as const;

export type TierCapabilityValue = number | boolean | null;

export interface TierSnapshotModel {
  readonly name: string | null;
  readonly norm: string;
  readonly sources: readonly string[];
  readonly strength: number | null;
  readonly strengthRank: number | null;
  readonly signals: readonly string[];
  readonly signalCount: number;
  readonly capabilities: Readonly<Record<string, TierCapabilityValue>>;
}

/** Persisted producer/consumer schema. Unknown measurements are explicitly null. */
export interface TierSnapshot {
  readonly schemaVersion: typeof TIER_SNAPSHOT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly models: readonly TierSnapshotModel[];
}

export interface TierSnapshotParseOptions {
  readonly nowEpochMs: number;
  readonly maxAgeMs: number;
}

export type TierSnapshotInvalidReason =
  | "not-an-object"
  | "missing-schema-version"
  | "invalid-generated-at"
  | "invalid-models"
  | "invalid-model-row"
  | "duplicate-model";

export type TierDataLoadResult =
  | { readonly status: "ready"; readonly snapshot: TierSnapshot; readonly ageMs: number }
  | { readonly status: "stale"; readonly snapshot: TierSnapshot; readonly ageMs: number }
  | { readonly status: "missing" }
  | {
      readonly status: "incompatible";
      readonly expectedVersion: typeof TIER_SNAPSHOT_SCHEMA_VERSION;
      readonly actualVersion: string;
    }
  | {
      readonly status: "invalid";
      readonly reason: TierSnapshotInvalidReason;
      readonly row: number | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueNonEmptyStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length
  );
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function parseModel(value: unknown): TierSnapshotModel | null {
  if (!isRecord(value)) return null;
  if (value.name !== null && !isNonEmptyString(value.name)) return null;
  if (!isNonEmptyString(value.norm) || value.norm !== value.norm.trim().toLowerCase()) return null;
  if (!uniqueNonEmptyStrings(value.sources) || !uniqueNonEmptyStrings(value.signals)) return null;
  if (!isFiniteNumberOrNull(value.strength)) return null;
  if (typeof value.strength === "number" && (value.strength < 0 || value.strength > 1)) return null;
  if (
    value.strengthRank !== null &&
    (!Number.isSafeInteger(value.strengthRank) || (value.strengthRank as number) < 1)
  ) {
    return null;
  }
  if (!Number.isSafeInteger(value.signalCount) || (value.signalCount as number) < 0) return null;
  if (value.signalCount !== value.signals.length) return null;
  if (!isRecord(value.capabilities)) return null;

  const capabilityEntries = Object.entries(value.capabilities);
  for (const [key, measurement] of capabilityEntries) {
    if (!isNonEmptyString(key)) return null;
    if (
      measurement !== null &&
      typeof measurement !== "boolean" &&
      (typeof measurement !== "number" || !Number.isFinite(measurement))
    ) {
      return null;
    }
  }

  const capabilities = Object.freeze(
    Object.fromEntries(capabilityEntries) as Record<string, TierCapabilityValue>,
  );
  return Object.freeze({
    name: value.name,
    norm: value.norm,
    sources: Object.freeze([...value.sources]),
    strength: value.strength,
    strengthRank: value.strengthRank as number | null,
    signals: Object.freeze([...value.signals]),
    signalCount: value.signalCount as number,
    capabilities,
  });
}

/**
 * Validate an already-deserialized snapshot without I/O or ambient time.
 * A malformed row rejects the whole snapshot; consumers never receive a
 * plausible-looking partial capability index.
 */
export function parseTierSnapshot(
  candidate: unknown,
  options: TierSnapshotParseOptions,
): TierDataLoadResult {
  if (!Number.isFinite(options.nowEpochMs)) {
    throw new RangeError("tier snapshot nowEpochMs must be finite");
  }
  if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) {
    throw new RangeError("tier snapshot maxAgeMs must be a finite non-negative number");
  }
  if (candidate === null || candidate === undefined) return Object.freeze({ status: "missing" });
  if (!isRecord(candidate)) {
    return Object.freeze({ status: "invalid", reason: "not-an-object", row: null });
  }
  if (!("schemaVersion" in candidate)) {
    return Object.freeze({ status: "invalid", reason: "missing-schema-version", row: null });
  }
  if (candidate.schemaVersion !== TIER_SNAPSHOT_SCHEMA_VERSION) {
    if (typeof candidate.schemaVersion === "string") {
      return Object.freeze({
        status: "incompatible",
        expectedVersion: TIER_SNAPSHOT_SCHEMA_VERSION,
        actualVersion: candidate.schemaVersion,
      });
    }
    return Object.freeze({ status: "invalid", reason: "missing-schema-version", row: null });
  }
  if (!isNonEmptyString(candidate.generatedAt)) {
    return Object.freeze({ status: "invalid", reason: "invalid-generated-at", row: null });
  }
  const generatedAtMs = Date.parse(candidate.generatedAt);
  if (!Number.isFinite(generatedAtMs) || generatedAtMs > options.nowEpochMs) {
    return Object.freeze({ status: "invalid", reason: "invalid-generated-at", row: null });
  }
  if (!Array.isArray(candidate.models)) {
    return Object.freeze({ status: "invalid", reason: "invalid-models", row: null });
  }

  const models: TierSnapshotModel[] = [];
  const norms = new Set<string>();
  for (let row = 0; row < candidate.models.length; row++) {
    const model = parseModel(candidate.models[row]);
    if (!model) {
      return Object.freeze({ status: "invalid", reason: "invalid-model-row", row });
    }
    if (norms.has(model.norm)) {
      return Object.freeze({ status: "invalid", reason: "duplicate-model", row });
    }
    norms.add(model.norm);
    models.push(model);
  }

  const snapshot: TierSnapshot = Object.freeze({
    schemaVersion: TIER_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: candidate.generatedAt,
    models: Object.freeze(models),
  });
  const ageMs = options.nowEpochMs - generatedAtMs;
  return Object.freeze({
    status: ageMs > options.maxAgeMs ? "stale" : "ready",
    snapshot,
    ageMs,
  });
}
