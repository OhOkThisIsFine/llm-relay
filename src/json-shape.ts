/**
 * Shared predicates for validating JSON object shapes — the one home for `isRecord` and the
 * exact-keys checks that were hand-copied per module (complexity review finding 5).
 * ⚠ The two exact-keys exports are DIFFERENT contracts, not one contract with an option —
 * `hasExactKeys` is the strict guard, `hasExactKeysWithOptional` is deliberately looser.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict exact-keys type guard over `unknown`: beyond key equality it rejects symbol keys, own
 * non-enumerable properties, and any prototype other than `Object.prototype`/null — shapes
 * `JSON.parse` cannot produce, so hostile lookalikes fail here.
 * ⚠ `keys` must be duplicate-free: a duplicated key shrinks the effective expected set and
 * silently WIDENS acceptance instead of rejecting.
 */
export function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const names = Object.getOwnPropertyNames(value);
  const enumerableNames = Object.keys(value);
  return names.length === keys.length
    && enumerableNames.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * The keystore's historical, deliberately LOOSER contract: takes an already-narrowed record and
 * checks own enumerable keys only (`Object.hasOwn` / `Object.keys`) — no symbol, prototype, or
 * enumerability checks. An empty `optionalKeys` list does NOT make this `hasExactKeys`. Custody
 * call sites keep the contract they always had; new strict validation belongs on `hasExactKeys`.
 */
export function hasExactKeysWithOptional(
  record: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  const permitted = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => Object.hasOwn(record, key))
    && Object.keys(record).every((key) => permitted.has(key));
}
