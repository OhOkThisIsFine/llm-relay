import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { parseCredentialId, type CredentialId } from "./credential-id.js";
import {
  createKek,
  unwrapKek,
  type KekDescriptor,
  type KeyringOptions,
} from "./os-keyring.js";
import {
  restrictSecretDirectoryOnWindowsSync,
  restrictSecretFileOnWindowsSync,
} from "./secret-file-acl.js";

const STORE_VERSION = 1 as const;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const GCM_TAG_LENGTH = 16;
const GCM_IV_LENGTH = 12;
const FINGERPRINT_SALT_LENGTH = 32;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FINGERPRINT_PATTERN = /^hmac:[0-9a-f]{8}$/;

interface StoredEntry {
  id: string;
  provider: string;
  envName: string;
  ct: string;
  iv: string;
  tag: string;
  fingerprint: string;
  addedAt: number;
  rotatedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  disabled: boolean;
}

interface StoredKeystore {
  version: typeof STORE_VERSION;
  kek: KekDescriptor;
  fpSalt: string;
  entries: StoredEntry[];
}

type StoreLoadResult =
  | { kind: "valid"; store: StoredKeystore }
  | { kind: "fresh" }
  | { kind: "unreadable" };

export interface KeystoreOptions extends KeyringOptions {
  path?: string;
  now?: number;
}

export interface AddEntryInput {
  id: string;
  provider: string;
  envName: string;
  value: string;
  expiresAt?: number | null;
}

export interface KeystoreEntryDescriptor {
  id: CredentialId;
  provider: string;
  envName: string;
  fingerprint: string;
  addedAt: number;
  rotatedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  disabled: boolean;
}

export interface KeystoreLookup {
  value: string;
  entryId: CredentialId;
  provider: string;
}

export class KeystoreEntryNotFoundError extends Error {
  constructor() {
    super("keystore entry not found");
    this.name = "KeystoreEntryNotFoundError";
  }
}

export class KeystoreEntryExistsError extends Error {
  constructor() {
    super("keystore entry already exists");
    this.name = "KeystoreEntryExistsError";
  }
}

export class KeystoreValidationError extends Error {
  constructor(classification: "id" | "provider" | "envName" | "value" | "timestamp") {
    super(`invalid keystore entry ${classification}`);
    this.name = "KeystoreValidationError";
  }
}

export class KeystoreWriteError extends Error {
  constructor() {
    super("keystore write failed");
    this.name = "KeystoreWriteError";
  }
}

export class KeystoreReadError extends Error {
  constructor() {
    super("keystore read failed");
    this.name = "KeystoreReadError";
  }
}

export class KeystoreUnlockError extends Error {
  constructor() {
    super("keystore unlock failed");
    this.name = "KeystoreUnlockError";
  }
}

let unlocked: { path: string; descriptor: string; kek: Buffer } | null = null;

/** Resolve the live store path without ever letting tests touch the user's real store. */
export function resolveKeystorePath(opts: { path?: string } = {}): string {
  if (opts.path !== undefined) return opts.path;
  if (process.env.VITEST !== undefined) {
    return join(tmpdir(), `llm-relay-test-keystore-${process.pid}`, "keystore.json");
  }
  return join(homedir(), ".llm-relay", "keystore.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const permitted = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => permitted.has(key));
}

function decodeBase64(value: unknown, expectedLength?: number): Buffer | null {
  if (typeof value !== "string") return null;
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value) return null;
    if (expectedLength !== undefined && decoded.length !== expectedLength) return null;
    return decoded;
  } catch {
    return null;
  }
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validNullableTimestamp(value: unknown): value is number | null {
  return value === null || validTimestamp(value);
}

function validKekDescriptor(value: unknown): value is KekDescriptor {
  if (!isObject(value) || typeof value.wrap !== "string") return false;
  switch (value.wrap) {
    case "dpapi":
      return hasExactKeys(value, ["wrap", "blob"])
        && (decodeBase64(value.blob)?.length ?? 0) > 0;
    case "keychain":
    case "libsecret":
      return hasExactKeys(value, ["wrap"]);
    case "passphrase": {
      if (!hasExactKeys(value, ["wrap", "kdf"]) || !isObject(value.kdf)) return false;
      return hasExactKeys(value.kdf, ["n", "r", "p", "salt"])
        && value.kdf.n === 16_384
        && value.kdf.r === 8
        && value.kdf.p === 1
        && decodeBase64(value.kdf.salt)?.length === 32;
    }
    default:
      return false;
  }
}

function validStoredEntry(value: unknown): value is StoredEntry {
  if (!isObject(value) || !hasExactKeys(value, [
    "id",
    "provider",
    "envName",
    "ct",
    "iv",
    "tag",
    "fingerprint",
    "addedAt",
    "rotatedAt",
    "expiresAt",
    "revokedAt",
    "disabled",
  ])) return false;
  const parsedId = typeof value.id === "string" ? parseCredentialId(value.id) : null;
  return parsedId !== null
    && typeof value.provider === "string"
    && value.provider.length > 0
    && !value.provider.includes("#")
    && parsedId.provider === value.provider
    && typeof value.envName === "string"
    && ENV_NAME_PATTERN.test(value.envName)
    && decodeBase64(value.ct) !== null
    && decodeBase64(value.iv, GCM_IV_LENGTH) !== null
    && decodeBase64(value.tag, GCM_TAG_LENGTH) !== null
    && typeof value.fingerprint === "string"
    && FINGERPRINT_PATTERN.test(value.fingerprint)
    && validTimestamp(value.addedAt)
    && validNullableTimestamp(value.rotatedAt)
    && validNullableTimestamp(value.expiresAt)
    && validNullableTimestamp(value.revokedAt)
    && typeof value.disabled === "boolean";
}

function parseStore(raw: unknown): StoredKeystore | null {
  if (!isObject(raw) || !hasExactKeys(raw, ["version", "kek", "fpSalt", "entries"])) return null;
  if (raw.version !== STORE_VERSION || !validKekDescriptor(raw.kek)) return null;
  if (decodeBase64(raw.fpSalt, FINGERPRINT_SALT_LENGTH) === null || !Array.isArray(raw.entries)) return null;
  const entries: StoredEntry[] = [];
  const seenIds = new Set<string>();
  const seenEnvNames = new Set<string>();
  for (const candidate of raw.entries) {
    if (!validStoredEntry(candidate)) continue;
    if (seenIds.has(candidate.id) || seenEnvNames.has(candidate.envName)) continue;
    seenIds.add(candidate.id);
    seenEnvNames.add(candidate.envName);
    entries.push(candidate);
  }
  return {
    version: STORE_VERSION,
    kek: raw.kek,
    fpSalt: raw.fpSalt as string,
    entries,
  };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function loadStore(path: string): StoreLoadResult {
  let serialized: string;
  try {
    serialized = readFileSync(path, "utf8");
  } catch (error) {
    // Absence and corruption are a fresh store. Other IO failures stay distinguishable so a
    // mutation cannot overwrite the OS-held KEK while an existing file is merely unreadable.
    return errorCode(error) === "ENOENT" ? { kind: "fresh" } : { kind: "unreadable" };
  }
  try {
    const store = parseStore(JSON.parse(serialized) as unknown);
    return store === null ? { kind: "fresh" } : { kind: "valid", store };
  } catch {
    return { kind: "fresh" };
  }
}

function validateEntryIdentity(id: string, provider: string, envName: string): void {
  const parsedId = parseCredentialId(id);
  if (parsedId === null) throw new KeystoreValidationError("id");
  if (!provider || provider.includes("#")) throw new KeystoreValidationError("provider");
  if (parsedId.provider !== provider) throw new KeystoreValidationError("provider");
  if (!ENV_NAME_PATTERN.test(envName)) throw new KeystoreValidationError("envName");
}

function validateValue(value: string): void {
  if (typeof value !== "string" || value.length === 0) throw new KeystoreValidationError("value");
}

function validateExpiresAt(value: number | null | undefined): void {
  if (value !== undefined && !validNullableTimestamp(value)) throw new KeystoreValidationError("timestamp");
}

function writeTime(opts: { now?: number }): number {
  const now = opts.now ?? Date.now();
  if (!validTimestamp(now)) throw new KeystoreValidationError("timestamp");
  return now;
}

function fingerprint(value: Buffer, kek: Buffer): string {
  return `hmac:${createHmac("sha256", kek).update(value).digest("hex").slice(0, 8)}`;
}

function aad(provider: string, entryId: string): Buffer {
  return Buffer.from(`${STORE_VERSION}|${provider}|${entryId}`, "utf8");
}

function encryptEntryValue(value: string, provider: string, entryId: string, kek: Buffer): Pick<StoredEntry, "ct" | "iv" | "tag" | "fingerprint"> {
  const plaintext = Buffer.from(value, "utf8");
  const iv = randomBytes(GCM_IV_LENGTH);
  try {
    const cipher = createCipheriv("aes-256-gcm", kek, iv, { authTagLength: GCM_TAG_LENGTH });
    cipher.setAAD(aad(provider, entryId));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ct: ct.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      fingerprint: fingerprint(plaintext, kek),
    };
  } finally {
    plaintext.fill(0);
    iv.fill(0);
  }
}

function decryptEntryBytes(entry: StoredEntry, kek: Buffer): Buffer | null {
  const ct = decodeBase64(entry.ct);
  const iv = decodeBase64(entry.iv, GCM_IV_LENGTH);
  const tag = decodeBase64(entry.tag, GCM_TAG_LENGTH);
  if (ct === null || iv === null || tag === null) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", kek, iv, { authTagLength: GCM_TAG_LENGTH });
    decipher.setAAD(aad(entry.provider, entry.id));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    const expected = fingerprint(plaintext, kek);
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(entry.fingerprint))) {
      plaintext.fill(0);
      return null;
    }
    return plaintext;
  } catch {
    // Authentication failures are a corrupt row, not a process-level custody failure.
    return null;
  } finally {
    ct.fill(0);
    iv.fill(0);
    tag.fill(0);
  }
}

function decryptEntryValue(entry: StoredEntry, kek: Buffer): string | null {
  const plaintext = decryptEntryBytes(entry, kek);
  if (plaintext === null) return null;
  try {
    return plaintext.toString("utf8");
  } finally {
    plaintext.fill(0);
  }
}

function entryAuthenticates(entry: StoredEntry, kek: Buffer): boolean {
  const plaintext = decryptEntryBytes(entry, kek);
  if (plaintext === null) return false;
  plaintext.fill(0);
  return true;
}

function clearUnlocked(): void {
  if (unlocked !== null) unlocked.kek.fill(0);
  unlocked = null;
}

function keyringItemId(fpSalt: string): string {
  return `keystore-${Buffer.from(fpSalt, "base64").toString("hex").slice(0, 32)}`;
}

function descriptorIdentity(descriptor: KekDescriptor, keyId: string): string {
  return `${keyId}|${JSON.stringify(descriptor)}`;
}

function cacheKek(path: string, identity: string, kek: Buffer): Buffer {
  if (kek.length !== 32) {
    kek.fill(0);
    throw new Error("keyring unwrap failed: invalid-key");
  }
  clearUnlocked();
  unlocked = { path, descriptor: identity, kek };
  return kek;
}

interface RecoveredKek {
  kek: Buffer;
  identity: string;
  cached: boolean;
}

function recoverStoreKek(store: StoredKeystore, path: string, opts: KeystoreOptions): RecoveredKek {
  const keyId = keyringItemId(store.fpSalt);
  const identity = descriptorIdentity(store.kek, keyId);
  if (unlocked?.path === path && unlocked.descriptor === identity) {
    return { kek: unlocked.kek, identity, cached: true };
  }
  // A changed path or wrapper identifies a different custody cell. Do not retain the old KEK if
  // recovery of the replacement fails; a later lookup can retry from the persisted descriptor.
  clearUnlocked();
  const kek = unwrapKek(store.kek, { ...opts, keyId });
  if (kek.length !== 32) {
    kek.fill(0);
    throw new Error("keyring unwrap failed: invalid-key");
  }
  return { kek, identity, cached: false };
}

function unlockStoreForWrite(store: StoredKeystore, path: string, opts: KeystoreOptions): Buffer {
  const recovered = recoverStoreKek(store, path, opts);
  if (recovered.cached) return recovered.kek;
  if (store.entries.length > 0 && !store.entries.some((entry) => entryAuthenticates(entry, recovered.kek))) {
    recovered.kek.fill(0);
    throw new KeystoreUnlockError();
  }
  return cacheKek(path, recovered.identity, recovered.kek);
}

function createStore(path: string, opts: KeystoreOptions): { store: StoredKeystore; kek: Buffer } {
  const fpSalt = randomBytes(FINGERPRINT_SALT_LENGTH).toString("base64");
  const keyId = keyringItemId(fpSalt);
  const created = createKek({ ...opts, keyId });
  const kek = cacheKek(path, descriptorIdentity(created.descriptor, keyId), created.kek);
  return {
    store: {
      version: STORE_VERSION,
      kek: created.descriptor,
      fpSalt,
      entries: [],
    },
    kek,
  };
}

function hardenDirectory(path: string): void {
  if (process.platform === "win32") {
    restrictSecretDirectoryOnWindowsSync(path);
  } else {
    chmodSync(path, DIRECTORY_MODE);
  }
}

function hardenFile(path: string): void {
  if (process.platform === "win32") {
    restrictSecretFileOnWindowsSync(path);
  } else {
    chmodSync(path, FILE_MODE);
  }
}

function persistStore(path: string, store: StoredKeystore): void {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
    hardenDirectory(directory);
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      FILE_MODE,
    );
    writeFileSync(descriptor, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    hardenFile(temporaryPath);
    renameSync(temporaryPath, path);
    hardenFile(path);
  } catch {
    throw new KeystoreWriteError();
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the normalized write failure */ }
    }
    try { unlinkSync(temporaryPath); } catch { /* renamed successfully or best-effort cleanup */ }
  }
}

function descriptorOf(entry: StoredEntry): KeystoreEntryDescriptor {
  return {
    id: entry.id as CredentialId,
    provider: entry.provider,
    envName: entry.envName,
    fingerprint: entry.fingerprint,
    addedAt: entry.addedAt,
    rotatedAt: entry.rotatedAt,
    expiresAt: entry.expiresAt,
    revokedAt: entry.revokedAt,
    disabled: entry.disabled,
  };
}

function requireStore(path: string): StoredKeystore {
  const loaded = loadStore(path);
  if (loaded.kind === "unreadable") throw new KeystoreReadError();
  if (loaded.kind === "fresh") throw new KeystoreEntryNotFoundError();
  return loaded.store;
}

function findEntry(store: StoredKeystore, entryId: string): StoredEntry {
  const entry = store.entries.find((candidate) => candidate.id === entryId);
  if (entry === undefined) throw new KeystoreEntryNotFoundError();
  return entry;
}

export function lookupByEnvName(envName: string, opts: KeystoreOptions = {}): KeystoreLookup | null {
  if (!ENV_NAME_PATTERN.test(envName)) return null;
  const path = resolveKeystorePath(opts);
  const loaded = loadStore(path);
  if (loaded.kind === "unreadable") throw new KeystoreReadError();
  if (loaded.kind === "fresh") return null;
  const store = loaded.store;
  const now = opts.now ?? Date.now();
  if (!validTimestamp(now)) throw new KeystoreValidationError("timestamp");
  let recovered: RecoveredKek | null = null;
  for (const entry of store.entries) {
    if (entry.envName !== envName || entry.disabled || entry.revokedAt !== null) continue;
    if (entry.expiresAt !== null && entry.expiresAt <= now) continue;
    recovered ??= recoverStoreKek(store, path, opts);
    const value = decryptEntryValue(entry, recovered.kek);
    if (value !== null) {
      if (!recovered.cached) cacheKek(path, recovered.identity, recovered.kek);
      return { value, entryId: entry.id as CredentialId, provider: entry.provider };
    }
  }
  if (recovered !== null && !recovered.cached) recovered.kek.fill(0);
  return null;
}

export function listEntries(opts: KeystoreOptions = {}): KeystoreEntryDescriptor[] {
  const loaded = loadStore(resolveKeystorePath(opts));
  if (loaded.kind === "unreadable") throw new KeystoreReadError();
  return loaded.kind === "valid" ? loaded.store.entries.map(descriptorOf) : [];
}

export function addEntry(input: AddEntryInput, opts: KeystoreOptions = {}): KeystoreEntryDescriptor {
  validateEntryIdentity(input.id, input.provider, input.envName);
  validateValue(input.value);
  validateExpiresAt(input.expiresAt);
  const now = writeTime(opts);
  const path = resolveKeystorePath(opts);
  const loaded = loadStore(path);
  if (loaded.kind === "unreadable") throw new KeystoreReadError();
  const existing = loaded.kind === "valid" ? loaded.store : null;
  if (existing?.entries.some((entry) => entry.id === input.id || entry.envName === input.envName)) {
    throw new KeystoreEntryExistsError();
  }
  const initialized = existing === null ? createStore(path, opts) : {
    store: existing,
    kek: unlockStoreForWrite(existing, path, opts),
  };
  const entry: StoredEntry = {
    id: input.id,
    provider: input.provider,
    envName: input.envName,
    ...encryptEntryValue(input.value, input.provider, input.id, initialized.kek),
    addedAt: now,
    rotatedAt: null,
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    disabled: false,
  };
  initialized.store.entries.push(entry);
  persistStore(path, initialized.store);
  return descriptorOf(entry);
}

export function rotateEntry(
  entryId: string,
  value: string,
  opts: KeystoreOptions & { expiresAt?: number | null } = {},
): KeystoreEntryDescriptor {
  if (parseCredentialId(entryId) === null) throw new KeystoreValidationError("id");
  validateValue(value);
  validateExpiresAt(opts.expiresAt);
  const now = writeTime(opts);
  const path = resolveKeystorePath(opts);
  const store = requireStore(path);
  const entry = findEntry(store, entryId);
  Object.assign(entry, encryptEntryValue(
    value,
    entry.provider,
    entry.id,
    unlockStoreForWrite(store, path, opts),
  ));
  entry.rotatedAt = now;
  entry.revokedAt = null;
  if (opts.expiresAt !== undefined) entry.expiresAt = opts.expiresAt;
  persistStore(path, store);
  return descriptorOf(entry);
}

export function revokeEntry(entryId: string, opts: KeystoreOptions = {}): KeystoreEntryDescriptor {
  if (parseCredentialId(entryId) === null) throw new KeystoreValidationError("id");
  const now = writeTime(opts);
  const path = resolveKeystorePath(opts);
  const store = requireStore(path);
  // Lifecycle metadata is intentionally editable without unwrapping the KEK. These fields are
  // not authenticated by the v1 AAD, and cleanup must remain possible for an unwrappable store.
  const entry = findEntry(store, entryId);
  entry.revokedAt = now;
  persistStore(path, store);
  return descriptorOf(entry);
}

export function removeEntry(entryId: string, opts: KeystoreOptions = {}): boolean {
  if (parseCredentialId(entryId) === null) throw new KeystoreValidationError("id");
  const path = resolveKeystorePath(opts);
  const store = requireStore(path);
  const index = store.entries.findIndex((entry) => entry.id === entryId);
  if (index < 0) throw new KeystoreEntryNotFoundError();
  store.entries.splice(index, 1);
  persistStore(path, store);
  return true;
}

export function setDisabled(entryId: string, disabled: boolean, opts: KeystoreOptions = {}): KeystoreEntryDescriptor {
  if (parseCredentialId(entryId) === null) throw new KeystoreValidationError("id");
  if (typeof disabled !== "boolean") throw new KeystoreValidationError("value");
  const path = resolveKeystorePath(opts);
  const store = requireStore(path);
  const entry = findEntry(store, entryId);
  entry.disabled = disabled;
  persistStore(path, store);
  return descriptorOf(entry);
}

/** Zeroize the process-held KEK. A later lookup unwraps it again lazily. */
export function lock(opts: { path?: string } = {}): void {
  if (unlocked === null) return;
  if (opts.path !== undefined && unlocked.path !== resolveKeystorePath(opts)) return;
  clearUnlocked();
}
