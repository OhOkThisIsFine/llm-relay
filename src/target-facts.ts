import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { parseCredentialId, type CredentialId } from "./credential-id.js";
import { WriteBehindTimer } from "./write-behind.js";

/** A learned condition or measurement about a routing target. */
export type FactKind =
  | "not-servable"
  | "subscription-required"
  | "allowance-exhausted"
  | "credential-invalid"
  | "rate-limited"
  | "context-limit";

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

export const SCOPE_PRECEDENCE: Array<FactScope["kind"]> = [
  "attempt", "group", "deployment", "credential", "provider", "model",
];

interface StoredFact {
  kind: FactKind;
  scope: FactScope;
  at: number;
  until?: number;
  value?: number;
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
  "context-limit": 30 * 24 * 60 * 60 * 1000,
};

const CONDITIONS: ReadonlySet<FactKind> = new Set([
  "not-servable", "subscription-required", "allowance-exhausted", "credential-invalid", "rate-limited",
]);
const COST_BLOCKING: ReadonlySet<FactKind> = new Set(["not-servable", "subscription-required"]);
const COOLING: ReadonlySet<FactKind> = new Set(["allowance-exhausted", "credential-invalid", "rate-limited"]);
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

/** Canonical persisted key. Kept exported so persistence tests cannot duplicate it. */
export function keyOf(scope: FactScope): string {
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
  return key === keyOf(normalizeScope(fact.scope));
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
          if (isValidFact(key, fact)) facts[key] = { ...fact, scope: normalizeScope(fact.scope) };
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

export function recordFact(
  kind: FactKind,
  scope: FactScope,
  opts: { path?: string; now?: number; retryAfterMs?: number | null; value?: number } = {},
): void {
  if (!isValidScope(scope)) return;
  const path = opts.path ?? defaultPath();
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(now)) return;
  const stated = typeof opts.retryAfterMs === "number" && Number.isFinite(opts.retryAfterMs) && opts.retryAfterMs > 0
    ? opts.retryAfterMs : null;
  const normalized = normalizeScope(scope);
  load(path).facts[keyOf(normalized)] = {
    kind, scope: normalized, at: now,
    ...(stated === null ? {} : { until: now + stated }),
    ...(typeof opts.value === "number" && Number.isFinite(opts.value) ? { value: opts.value } : {}),
  };
  writer.touch(() => persist(path));
}

export function factsFor(
  provider: string,
  credentialId: CredentialId | null,
  model: string | null | undefined,
  opts: { path?: string; now?: number } = {},
): Array<{ kind: FactKind; scope: FactScope; until: number; value?: number }> {
  const now = opts.now ?? Date.now();
  const m = typeof model === "string" ? model : null;
  const hits: Array<{ kind: FactKind; scope: FactScope; until: number; value?: number }> = [];
  for (const fact of Object.values(load(opts.path ?? defaultPath()).facts)) {
    const until = expiryOf(fact);
    if (now < until && covers(fact, provider, credentialId, m)) {
      hits.push({ kind: fact.kind, scope: fact.scope, until, ...(fact.value === undefined ? {} : { value: fact.value }) });
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

export function allFacts(opts: { path?: string; now?: number } = {}): Array<{ kind: FactKind; scope: FactScope; at: number; until: number }> {
  const now = opts.now ?? Date.now();
  return Object.values(load(opts.path ?? defaultPath()).facts)
    .filter((fact) => now < expiryOf(fact))
    .map((fact) => ({ kind: fact.kind, scope: fact.scope, at: fact.at, until: expiryOf(fact) }))
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
