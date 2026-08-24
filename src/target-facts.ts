import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { parseCredentialId, type CredentialId } from "./credential-id.js";
import { WriteBehindTimer } from "./write-behind.js";

/**
 * A learned condition or measurement about a routing target.
 *
 * The kinds split into two halves, and the split is load-bearing:
 * - CONDITIONS (`not-servable`, `subscription-required`, `allowance-exhausted`, `credential-invalid`,
 *   `rate-limited`) say "this target is currently unusable for a reason". A success disproves a
 *   condition, so `clearFacts()` deletes them; they cool or cost-block through the sets below.
 * - MEASUREMENTS (`context-limit`, `rate-limit-rpm|rpd|tpm|tpd`) say "here is a ceiling this
 *   deployment stated". A success does not disprove a measurement, so they are in none of the sets
 *   below and `clearFacts()` never touches them — they expire on their own TTL. They are
 *   display-only today (see `rate-limits.ts`); acting on them is a separate, announced decision.
 */
export type FactKind =
  | "not-servable"
  | "subscription-required"
  | "allowance-exhausted"
  | "credential-invalid"
  | "rate-limited"
  | "context-limit"
  | "rate-limit-rpm"
  | "rate-limit-rpd"
  | "rate-limit-tpm"
  | "rate-limit-tpd";

/**
 * The evidence scope, in lookup order. `provider` deliberately means every credential for the
 * provider; credential-wide evidence must use `credential` instead.
 */
export type FactScope =
  | { kind: "attempt"; provider: string; credentialId: CredentialId; model: string }
  | { kind: "group"; provider: string; credentialId?: CredentialId; members: string[] }
  | { kind: "deployment"; provider: string; model: string }
  | { kind: "credential"; provider: string; credentialId: CredentialId }
  | { kind: "provider"; provider: string }
  | { kind: "model"; model: string };

export interface CooldownFactClearSelector {
  readonly provider: string;
  readonly model?: string;
  readonly credentialId?: CredentialId;
}

export interface ClearedCooldownFact {
  readonly kind: FactKind;
  readonly scope: FactScope;
}

export const SCOPE_PRECEDENCE: Array<FactScope["kind"]> = [
  "attempt", "group", "deployment", "credential", "provider", "model",
];

/**
 * How a fact's explicit `until` was resolved against the response that produced it. Mirrors the
 * rung order of `resolveReset` in `server.ts` — the one place these values are minted:
 *
 *   retry-after    — the response's own `Retry-After` header.
 *   reviewed-field — a reviewed `field` ResetRule read out of THIS response's body
 *                    (Google's `retryDelay`): a measurement from a place only a reviewer knew.
 *   stated-body    — the generic body parse; the response stated a reset, unprompted.
 *   reviewed-fixed — a reviewer-asserted window; knowledge of the provider, not of this response.
 *
 * ABSENT means a legacy row or the kind's default TTL — the relay declined to record why, so the
 * absence must never be read as a basis by a consumer. Never written as a guess: `recordFact`
 * accepts it only alongside a positive finite `retryAfterMs`.
 */
export type FactResetBasis = "retry-after" | "reviewed-field" | "stated-body" | "reviewed-fixed";

const UNTIL_BASES: ReadonlySet<string> = new Set([
  "retry-after", "reviewed-field", "stated-body", "reviewed-fixed",
]);

interface StoredFact {
  kind: FactKind;
  scope: FactScope;
  at: number;
  until?: number;
  value?: number;
  untilBasis?: FactResetBasis;
}

interface FactStore {
  version: 2;
  facts: Record<string, StoredFact>;
}

export const FACT_TTL_MS: Record<FactKind, number> = {
  "not-servable": 6 * 60 * 60 * 1000,
  "subscription-required": 24 * 60 * 60 * 1000,
  "allowance-exhausted": 60 * 60 * 1000,
  "credential-invalid": 15 * 60 * 1000,
  "rate-limited": 2 * 60 * 1000,
  // The measurement half (see FactKind above): a ceiling the deployment stated about itself.
  // Same TTL as context-limit — provider rate structures change on the same timescale as
  // published context windows do. A success neither clears nor refreshes these; only age does.
  "context-limit": 30 * 24 * 60 * 60 * 1000,
  "rate-limit-rpm": 30 * 24 * 60 * 60 * 1000,
  "rate-limit-rpd": 30 * 24 * 60 * 60 * 1000,
  "rate-limit-tpm": 30 * 24 * 60 * 60 * 1000,
  "rate-limit-tpd": 30 * 24 * 60 * 60 * 1000,
};

// The condition half only (see FactKind). The rate-limit-* / context-limit measurements are
// deliberately absent from every set below: not cleared by clearFacts, never cooling, never
// cost-blocking. They describe what the deployment is entitled to, not whether it is broken.
const CONDITIONS: ReadonlySet<FactKind> = new Set([
  "not-servable", "subscription-required", "allowance-exhausted", "credential-invalid", "rate-limited",
]);
const COST_BLOCKING: ReadonlySet<FactKind> = new Set(["not-servable", "subscription-required"]);
const COOLING: ReadonlySet<FactKind> = new Set(["allowance-exhausted", "credential-invalid", "rate-limited"]);
/**
 * The kinds whose `until` may answer a QUOTA row's `resetsAt` (`availability.ts`
 * `factResetInputs`). Exported so the availability ladder and `llm-relay candidates` share one
 * definition instead of each restating a kind list.
 *
 * It is COOLING minus `credential-invalid` on purpose, and the narrowing is the point: the two
 * kinds here say "this allowance/throughput is spent and refills at T", which is what a quota row
 * asks. A revoked or faulted credential's expiry says when the RELAY will next try the key — a
 * different question, on a different axis, and answering the quota one with it would label an
 * auth cooldown as a quota reset. The evicting conditions (`not-servable`,
 * `subscription-required`) are excluded for the same reason: removal from selection is not
 * replenishment. Those all still render in the Cooldowns panel, which is where they belong.
 */
export const QUOTA_RESET_FACT_KINDS: ReadonlySet<FactKind> = new Set(["allowance-exhausted", "rate-limited"]);
const FACT_KINDS_SET: ReadonlySet<string> = new Set(Object.keys(FACT_TTL_MS));
export const FACT_KINDS = Object.keys(FACT_TTL_MS) as FactKind[];

let _store: FactStore | null = null;
let _path: string | null = null;
const writer = new WriteBehindTimer();

function defaultPath(): string {
  if (process.env.VITEST !== undefined) return join(tmpdir(), `llm-relay-test-target-facts-${process.pid}.json`);
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() ? join(xdg, "llm-relay") : join(homedir(), ".llm-relay"), "target-facts.json");
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function credentialBelongsTo(provider: string, credentialId: unknown): credentialId is CredentialId {
  return typeof credentialId === "string" && parseCredentialId(credentialId)?.provider === provider;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function canonicalMembers(members: string[]): string[] {
  return [...new Set(members)].sort();
}

/**
 * Canonical persisted key for a fact, INCLUDING its kind.
 *
 * ⚠ The kind is part of the key on purpose: one scope may legitimately carry several kinds at once
 * (a real Groq 429 states both an RPM and a TPM ceiling), and a key of scope alone made four
 * rate-limit measurements overwrite each other down to one. Conditions never collide this way in
 * practice (a cell holds at most one condition verdict), but the measurement half made the
 * omission a silent data loss, so the key is now `<kind>:<scope>` throughout.
 *
 * Exported so persistence tests cannot duplicate it.
 */
export function keyOf(kind: FactKind, scope: FactScope): string {
  return `${kind}:${keyOfScope(scope)}`;
}

/** Scope-only key, kept for callers that key a single-slot cell by scope alone. */
export function keyOfScope(scope: FactScope): string {
  switch (scope.kind) {
    case "attempt": return `a:${scope.credentialId}/${scope.model}`;
    case "group": return scope.credentialId
      ? `g:c:${scope.credentialId}/${canonicalMembers(scope.members).join(",")}`
      : `g:p:${scope.provider}/${canonicalMembers(scope.members).join(",")}`;
    case "deployment": return `d:${scope.provider}/${scope.model}`;
    case "credential": return `c:${scope.credentialId}`;
    case "provider": return `p:${scope.provider}`;
    case "model": return `m:${scope.model}`;
  }
}

function normalizeScope(scope: FactScope): FactScope {
  return scope.kind === "group" ? { ...scope, members: canonicalMembers(scope.members) } : scope;
}

function isValidScope(value: unknown): value is FactScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  switch (scope.kind) {
    case "attempt":
      return hasExactKeys(scope, ["kind", "provider", "credentialId", "model"])
        && validText(scope.provider) && validText(scope.model) && credentialBelongsTo(scope.provider, scope.credentialId);
    case "group":
      return hasExactKeys(scope, scope.credentialId === undefined
        ? ["kind", "provider", "members"]
        : ["kind", "provider", "credentialId", "members"])
        && validText(scope.provider)
        && Array.isArray(scope.members) && scope.members.length > 0 && scope.members.every(validText)
        && (scope.credentialId === undefined || credentialBelongsTo(scope.provider, scope.credentialId));
    case "deployment":
      return hasExactKeys(scope, ["kind", "provider", "model"]) && validText(scope.provider) && validText(scope.model);
    case "credential":
      return hasExactKeys(scope, ["kind", "provider", "credentialId"])
        && validText(scope.provider) && credentialBelongsTo(scope.provider, scope.credentialId);
    case "provider": return hasExactKeys(scope, ["kind", "provider"]) && validText(scope.provider);
    case "model": return hasExactKeys(scope, ["kind", "model"]) && validText(scope.model);
    default: return false;
  }
}

function isValidFact(key: string, value: unknown): value is StoredFact {
  if (!value || typeof value !== "object") return false;
  const fact = value as Record<string, unknown>;
  if (!FACT_KINDS_SET.has(fact.kind as string) || !isValidScope(fact.scope) || !Number.isFinite(fact.at)) return false;
  if (fact.until !== undefined && !Number.isFinite(fact.until)) return false;
  if (fact.value !== undefined && !Number.isFinite(fact.value)) return false;
  const scope = normalizeScope(fact.scope);
  // Rows written before the kind joined the key carry the bare scope key; they are migrated to
  // the canonical key by `load`, so refusing them here would wipe every learned fact on upgrade.
  return key === keyOf(fact.kind as FactKind, scope) || key === keyOfScope(scope);
}

function load(path: string): FactStore {
  if (_store && _path === path) return _store;
  _path = path;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    // v1 had no credential identity. It is intentionally empty, rather than guessed or widened.
    if (parsed && typeof parsed === "object" && (parsed as { version?: unknown }).version === 2) {
      const rawFacts = (parsed as { facts?: unknown }).facts;
      const facts: Record<string, StoredFact> = {};
      if (rawFacts && typeof rawFacts === "object") {
        for (const [key, fact] of Object.entries(rawFacts)) {
          if (!isValidFact(key, fact)) continue;
          // Drop a basis outside the closed enum rather than failing the load: an unknown spelling
          // must behave exactly like the legacy rows that never carried one. A basis with NO
          // explicit `until` goes the same way — `expiryOf` would then fall back to the kind's
          // default TTL, and handing a consumer that fallback with a basis attached is the exact
          // "a guess labelled a measurement" the field exists to prevent.
          const { untilBasis, ...rest } = fact;
          const attributable = Number.isFinite(fact.until) && UNTIL_BASES.has(untilBasis as string);
          const stored: StoredFact = {
            ...rest,
            scope: normalizeScope(fact.scope),
            ...(attributable ? { untilBasis: untilBasis as FactResetBasis } : {}),
          };
          // Rows predating the kind-in-key format carry a bare scope key; rekey them to the
          // canonical `<kind>:<scope>` so an upgrade keeps every learned fact. Where both forms
          // exist the canonical one stays — it was written later by this version.
          const canonical = keyOf(stored.kind, stored.scope);
          facts[canonical] ??= stored;
        }
      }
      _store = { version: 2, facts };
      return _store;
    }
  } catch {
    // Learned data is best effort. Corruption must never block startup or a request.
  }
  _store = { version: 2, facts: {} };
  return _store;
}

function persist(path: string): void {
  if (!_store) return;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(_store, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  } catch { /* best effort */ }
}

function expiryOf(fact: StoredFact): number { return fact.until ?? fact.at + FACT_TTL_MS[fact.kind]; }

function covers(fact: StoredFact, provider: string, credentialId: CredentialId | null, model: string | null): boolean {
  switch (fact.scope.kind) {
    case "attempt": return credentialId !== null && model !== null
      && fact.scope.provider === provider && fact.scope.credentialId === credentialId && fact.scope.model === model;
    case "group": return model !== null && fact.scope.provider === provider && fact.scope.members.includes(model)
      && (fact.scope.credentialId === undefined || (credentialId !== null && fact.scope.credentialId === credentialId));
    case "deployment": return model !== null && fact.scope.provider === provider && fact.scope.model === model;
    case "credential": return credentialId !== null && fact.scope.provider === provider && fact.scope.credentialId === credentialId;
    case "provider": return fact.scope.provider === provider;
    case "model": return model !== null && fact.scope.model === model;
  }
}

/**
 * Retract a fact only when its entire scope fits inside the operator's selection. Unlike a real
 * success, an operator clear is not evidence that can disprove a broader condition; retaining a
 * wider row prevents a narrow clear from reviving sibling deployments or credential cells.
 */
function matchesClearSelector(scope: FactScope, selector: CooldownFactClearSelector): boolean {
  switch (scope.kind) {
    case "attempt":
      return scope.provider === selector.provider &&
        (selector.model === undefined || scope.model === selector.model) &&
        (selector.credentialId === undefined || scope.credentialId === selector.credentialId);
    case "group":
      if (scope.provider !== selector.provider) return false;
      if (
        selector.model !== undefined &&
        !scope.members.every((member) => member === selector.model)
      ) return false;
      return selector.credentialId === undefined || scope.credentialId === selector.credentialId;
    case "deployment":
      return scope.provider === selector.provider &&
        selector.credentialId === undefined &&
        (selector.model === undefined || scope.model === selector.model);
    case "credential":
      return scope.provider === selector.provider &&
        selector.model === undefined &&
        (selector.credentialId === undefined || scope.credentialId === selector.credentialId);
    case "provider":
      return scope.provider === selector.provider &&
        selector.model === undefined &&
        selector.credentialId === undefined;
    case "model":
      // A provider-qualified mutation must not retract a cross-provider row for its siblings.
      return false;
  }
}

export function recordFact(
  kind: FactKind,
  scope: FactScope,
  opts: { path?: string; now?: number; retryAfterMs?: number | null; untilBasis?: FactResetBasis; value?: number } = {},
): void {
  if (!isValidScope(scope)) return;
  const path = opts.path ?? defaultPath();
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(now)) return;
  const stated = typeof opts.retryAfterMs === "number" && Number.isFinite(opts.retryAfterMs) && opts.retryAfterMs > 0
    ? opts.retryAfterMs : null;
  // The basis is bound to the explicit expiry it explains: with no positive `retryAfterMs` the
  // kind's default TTL is what applied, and a basis recorded beside it would mislabel a fallback.
  const basis = stated !== null && opts.untilBasis !== undefined && UNTIL_BASES.has(opts.untilBasis)
    ? opts.untilBasis
    : null;
  const normalized = normalizeScope(scope);
  load(path).facts[keyOf(kind, normalized)] = {
    kind, scope: normalized, at: now,
    ...(stated === null ? {} : { until: now + stated }),
    ...(basis === null ? {} : { untilBasis: basis }),
    ...(typeof opts.value === "number" && Number.isFinite(opts.value) ? { value: opts.value } : {}),
  };
  writer.touch(() => persist(path));
}

export function factsFor(
  provider: string,
  credentialId: CredentialId | null,
  model: string | null | undefined,
  opts: { path?: string; now?: number } = {},
): Array<{ kind: FactKind; scope: FactScope; until: number; untilBasis?: FactResetBasis; value?: number }> {
  const now = opts.now ?? Date.now();
  const m = typeof model === "string" ? model : null;
  const hits: Array<{ kind: FactKind; scope: FactScope; until: number; untilBasis?: FactResetBasis; value?: number }> = [];
  for (const fact of Object.values(load(opts.path ?? defaultPath()).facts)) {
    const until = expiryOf(fact);
    if (now < until && covers(fact, provider, credentialId, m)) {
      hits.push({
        kind: fact.kind, scope: fact.scope, until,
        ...(fact.untilBasis === undefined ? {} : { untilBasis: fact.untilBasis }),
        ...(fact.value === undefined ? {} : { value: fact.value }),
      });
    }
  }
  return hits.sort((a, b) => SCOPE_PRECEDENCE.indexOf(a.scope.kind) - SCOPE_PRECEDENCE.indexOf(b.scope.kind));
}

export function isCostBlocked(provider: string, credentialId: CredentialId | null, model: string | null | undefined, opts: { path?: string; now?: number } = {}): boolean {
  return factsFor(provider, credentialId, model, opts).some((fact) => COST_BLOCKING.has(fact.kind));
}

export function cooldownUntil(provider: string, credentialId: CredentialId | null, model: string | null | undefined, opts: { path?: string; now?: number } = {}): number | null {
  let latest: number | null = null;
  for (const fact of factsFor(provider, credentialId, model, opts)) {
    if (COOLING.has(fact.kind)) latest = latest === null ? fact.until : Math.max(latest, fact.until);
  }
  return latest;
}

/** A success retracts conditions covering this credential/model cell, never measurements. */
export function clearFacts(provider: string, credentialId: CredentialId | null, model: string | null | undefined, opts: { path?: string } = {}): FactKind[] {
  const path = opts.path ?? defaultPath();
  const m = typeof model === "string" ? model : null;
  const store = load(path);
  const cleared: FactKind[] = [];
  let changed = false;
  for (const [key, fact] of Object.entries(store.facts)) {
    if (!CONDITIONS.has(fact.kind) || !covers(fact, provider, credentialId, m)) continue;
    delete store.facts[key];
    // Callers use this return value to clear credential-wide breaker symptoms. A success at a
    // narrower scope must still delete its fact, but must not claim the credential itself recovered.
    if (fact.scope.kind === "credential") cleared.push(fact.kind);
    changed = true;
  }
  if (changed) writer.touch(() => persist(path));
  return cleared;
}

function clearMatchingActiveFacts(
  selector: CooldownFactClearSelector,
  opts: { path?: string; now?: number },
  matchesKind: (kind: FactKind) => boolean,
): ClearedCooldownFact[] {
  const path = opts.path ?? defaultPath();
  const now = opts.now ?? Date.now();
  const store = load(path);
  const cleared: ClearedCooldownFact[] = [];
  for (const [key, fact] of Object.entries(store.facts)) {
    if (
      !matchesKind(fact.kind) ||
      now >= expiryOf(fact) ||
      !matchesClearSelector(fact.scope, selector)
    ) continue;
    delete store.facts[key];
    cleared.push({
      kind: fact.kind,
      scope: fact.scope.kind === "group"
        ? { ...fact.scope, members: [...fact.scope.members] }
        : { ...fact.scope },
    });
  }
  if (cleared.length > 0) writer.touch(() => persist(path));
  return cleared.sort((a, b) =>
    a.kind.localeCompare(b.kind) || keyOfScope(a.scope).localeCompare(keyOfScope(b.scope))
  );
}

/** Operator retraction of active cooling conditions only; never success evidence or eviction. */
export function clearCooldownFacts(
  selector: CooldownFactClearSelector,
  opts: { path?: string; now?: number } = {},
): ClearedCooldownFact[] {
  return clearMatchingActiveFacts(selector, opts, (kind) => COOLING.has(kind));
}

/** Rotation retraction of active credential-invalid facts only. */
export function clearCredentialInvalidFacts(
  selector: CooldownFactClearSelector,
  opts: { path?: string; now?: number } = {},
): ClearedCooldownFact[] {
  return clearMatchingActiveFacts(selector, opts, (kind) => kind === "credential-invalid");
}

export function allFacts(opts: { path?: string; now?: number } = {}): Array<{ kind: FactKind; scope: FactScope; at: number; until: number; untilBasis?: FactResetBasis }> {
  const now = opts.now ?? Date.now();
  return Object.values(load(opts.path ?? defaultPath()).facts)
    .filter((fact) => now < expiryOf(fact))
    .map((fact) => ({
      kind: fact.kind, scope: fact.scope, at: fact.at, until: expiryOf(fact),
      ...(fact.untilBasis === undefined ? {} : { untilBasis: fact.untilBasis }),
    }))
    .sort((a, b) => b.at - a.at);
}

export function describeScope(scope: FactScope): string {
  switch (scope.kind) {
    case "attempt": return `${scope.credentialId}/${scope.model}`;
    case "group": return `${scope.credentialId ?? scope.provider}/{${scope.members.length} models}`;
    case "deployment": return `${scope.provider}/${scope.model}`;
    case "credential": return `${scope.credentialId}/*`;
    case "provider": return `${scope.provider}/* (all credentials)`;
    case "model": return `*/${scope.model}`;
  }
}

export function flushFacts(opts: { path?: string } = {}): void {
  if (!writer.dirty) return;
  writer.clear();
  persist(opts.path ?? defaultPath());
}

export function resetFacts(): void {
  _store = null;
  _path = null;
  writer.clear();
}
