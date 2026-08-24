/**
 * Encrypted credential custody is single-writer by convention. Mutations are read-modify-write,
 * no inter-process lock is built, and concurrent CLI writers therefore have last-write-wins
 * semantics. An envName is globally unique within a store; malformed or duplicate rows are
 * skipped in file order, so the first valid row deterministically wins read-side deduplication.
 */
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
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
  type SecretFileAclOptions,
} from "./secret-file-acl.js";

const STORE_VERSION = 1 as const;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const GCM_TAG_LENGTH = 16;
const GCM_IV_LENGTH = 12;
const FINGERPRINT_SALT_LENGTH = 32;
const ITEM_ID_LENGTH = 16;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const FINGERPRINT_PATTERN = /^hmac:[0-9a-f]{8}$/;
const ITEM_ID_PATTERN = /^[0-9a-f]{32}$/;
const KEK_CHECK_PATTERN = /^[0-9a-f]{64}$/;
const KEK_CHECK_CONTEXT = "llm-relay-kek-v1";

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
  itemId: string;
  kekCheck: string;
  entries: StoredEntry[];
}

type StoreLoadResult =
  | { status: "ok" | "degraded"; droppedCount: number; store: StoredKeystore }
  | { status: "fresh"; droppedCount: 0 }
  | { status: "unreadable"; droppedCount: 0; errno?: string | undefined };

export interface KeystoreOptions extends KeyringOptions {
  path?: string;
  now?: number;
  /** Injected Windows ACL process/platform seam; separate from the keyring spawner. */
  acl?: SecretFileAclOptions;
  /** Read seam for deterministic filesystem-failure tests. */
  readFile?: (path: string) => string;
}

export interface KeystoreStatus {
  status: "ok" | "absent" | "unreadable" | "locked" | "degraded";
  droppedCount: number;
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
  constructor(errno?: string) {
    super(`keystore write failed${errno === undefined ? "" : ` (${errno})`}`);
    this.name = "KeystoreWriteError";
  }
}

export class KeystoreReadError extends Error {
  constructor(errno?: string) {
    super(`keystore read failed${errno === undefined ? "" : ` (${errno})`}`);
    this.name = "KeystoreReadError";
  }
}

export class KeystoreUnlockError extends Error {
  constructor() {
    super("keystore unlock failed");
    this.name = "KeystoreUnlockError";
  }
}

export class KeystoreMutationRefusedError extends Error {
  readonly status: "unreadable" | "degraded";
  readonly droppedCount: number;

  constructor(status: "unreadable" | "degraded", droppedCount = 0, errno?: string) {
    const count = droppedCount > 0 ? `; ${droppedCount} unreadable row${droppedCount === 1 ? "" : "s"}` : "";
    const code = errno === undefined ? "" : `; ${errno}`;
    super(`keystore mutation refused: ${status}${count}${code}`);
    this.name = "KeystoreMutationRefusedError";
    this.status = status;
    this.droppedCount = droppedCount;
  }
}

let unlocked: { path: string; descriptor: string; kek: Buffer } | null = null;
interface MemoizedUnlockFailure {
  path: string;
  descriptor: string;
  status: "locked" | "unreadable";
}
const unlockFailures = new Map<string, MemoizedUnlockFailure>();
const unreadablePaths = new Set<string>();

function unlockFailureKey(path: string, descriptor: string): string {
  return `${path}\0${descriptor}`;
}

/** Resolve the live store path without ever letting tests touch the user's real store. */
export function resolveKeystorePath(opts: { path?: string } = {}): string {
  if (opts.path !== undefined) return opts.path;
  if (process.env.VITEST !== undefined) {
    const pool = process.env.VITEST_POOL_ID ?? "pool";
    const worker = process.env.VITEST_WORKER_ID ?? "worker";
    return join(tmpdir(), `llm-relay-test-keystore-${process.pid}-${pool}-${worker}`, "keystore.json");
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
    && PROVIDER_PATTERN.test(value.provider)
    && parsedId.provider === value.provider
    && typeof value.envName === "string"
    && ENV_NAME_PATTERN.test(value.envName)
    && (decodeBase64(value.ct)?.length ?? 0) > 0
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

function parseStore(raw: unknown): { store: StoredKeystore; droppedCount: number } | null {
  if (!isObject(raw) || !hasExactKeys(raw, [
    "version",
    "kek",
    "fpSalt",
    "itemId",
    "kekCheck",
    "entries",
  ])) return null;
  if (raw.version !== STORE_VERSION || !validKekDescriptor(raw.kek)) return null;
  if (
    decodeBase64(raw.fpSalt, FINGERPRINT_SALT_LENGTH) === null
    || typeof raw.itemId !== "string"
    || !ITEM_ID_PATTERN.test(raw.itemId)
    || typeof raw.kekCheck !== "string"
    || !KEK_CHECK_PATTERN.test(raw.kekCheck)
    || !Array.isArray(raw.entries)
  ) return null;
  const entries: StoredEntry[] = [];
  const seenIds = new Set<string>();
  const seenEnvNames = new Set<string>();
  let droppedCount = 0;
  for (const candidate of raw.entries) {
    if (!validStoredEntry(candidate)) {
      droppedCount += 1;
      continue;
    }
    if (seenIds.has(candidate.id) || seenEnvNames.has(candidate.envName)) {
      droppedCount += 1;
      continue;
    }
    seenIds.add(candidate.id);
    seenEnvNames.add(candidate.envName);
    entries.push(candidate);
  }
  return {
    droppedCount,
    store: {
      version: STORE_VERSION,
      kek: raw.kek,
      fpSalt: raw.fpSalt as string,
      itemId: raw.itemId,
      kekCheck: raw.kekCheck,
      entries,
    },
  };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = String((error as { code?: unknown }).code);
  return /^[A-Z][A-Z0-9_]{0,31}$/u.test(code) ? code : undefined;
}

function loadStore(path: string, opts: Pick<KeystoreOptions, "readFile"> = {}): StoreLoadResult {
  let serialized: string;
  try {
    serialized = opts.readFile?.(path) ?? readFileSync(path, "utf8");
  } catch (error) {
    const errno = errorCode(error);
    if (errno !== "ENOENT") return { status: "unreadable", droppedCount: 0, errno };
    try {
      // readFile reports ENOENT for a dangling symlink too. Only an absent directory entry may
      // create a fresh store; replacing any present path could orphan an existing custody cell.
      lstatSync(path);
      return { status: "unreadable", droppedCount: 0, errno };
    } catch (lstatError) {
      const lstatErrno = errorCode(lstatError);
      return lstatErrno === "ENOENT"
        ? { status: "fresh", droppedCount: 0 }
        : { status: "unreadable", droppedCount: 0, errno: lstatErrno };
    }
  }
  try {
    const parsed = parseStore(JSON.parse(serialized) as unknown);
    if (parsed === null) return { status: "unreadable", droppedCount: 0 };
    return {
      status: parsed.droppedCount > 0 ? "degraded" : "ok",
      droppedCount: parsed.droppedCount,
      store: parsed.store,
    };
  } catch {
    // A present but malformed document is never equivalent to an absent, creatable store.
    return { status: "unreadable", droppedCount: 0 };
  }
}

function validateEntryIdentity(id: string, provider: string, envName: string): void {
  const parsedId = parseCredentialId(id);
  if (parsedId === null) throw new KeystoreValidationError("id");
  if (!PROVIDER_PATTERN.test(provider)) throw new KeystoreValidationError("provider");
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

function fingerprint(value: Buffer, kek: Buffer, fpSalt: string): string {
  const salt = Buffer.from(fpSalt, "base64");
  try {
    return `hmac:${createHmac("sha256", kek).update(salt).update(value).digest("hex").slice(0, 8)}`;
  } finally {
    salt.fill(0);
  }
}

function aad(provider: string, entryId: string, envName: string): Buffer {
  return Buffer.from(`${STORE_VERSION}|${provider}|${entryId}|${envName}`, "utf8");
}

function encryptEntryValue(
  value: string,
  provider: string,
  entryId: string,
  envName: string,
  kek: Buffer,
  fpSalt: string,
): Pick<StoredEntry, "ct" | "iv" | "tag" | "fingerprint"> {
  const plaintext = Buffer.from(value, "utf8");
  const iv = randomBytes(GCM_IV_LENGTH);
  try {
    const cipher = createCipheriv("aes-256-gcm", kek, iv, { authTagLength: GCM_TAG_LENGTH });
    cipher.setAAD(aad(provider, entryId, envName));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ct: ct.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      fingerprint: fingerprint(plaintext, kek, fpSalt),
    };
  } finally {
    plaintext.fill(0);
    iv.fill(0);
  }
}

function decryptEntryBytes(entry: StoredEntry, kek: Buffer, fpSalt: string): Buffer | null {
  const ct = decodeBase64(entry.ct);
  const iv = decodeBase64(entry.iv, GCM_IV_LENGTH);
  const tag = decodeBase64(entry.tag, GCM_TAG_LENGTH);
  if (ct === null || iv === null || tag === null) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", kek, iv, { authTagLength: GCM_TAG_LENGTH });
    decipher.setAAD(aad(entry.provider, entry.id, entry.envName));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    const expected = fingerprint(plaintext, kek, fpSalt);
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

function decryptEntryValue(entry: StoredEntry, kek: Buffer, fpSalt: string): string | null {
  const plaintext = decryptEntryBytes(entry, kek, fpSalt);
  if (plaintext === null) return null;
  try {
    return plaintext.toString("utf8");
  } finally {
    plaintext.fill(0);
  }
}

function entryAuthenticates(entry: StoredEntry, kek: Buffer, fpSalt: string): boolean {
  const plaintext = decryptEntryBytes(entry, kek, fpSalt);
  if (plaintext === null) return false;
  plaintext.fill(0);
  return true;
}

function clearUnlocked(): void {
  if (unlocked !== null) unlocked.kek.fill(0);
  unlocked = null;
}

function keyringItemId(itemId: string): string {
  return `keystore-${itemId}`;
}

function calculateKekCheck(kek: Buffer): string {
  return createHmac("sha256", kek).update(KEK_CHECK_CONTEXT, "utf8").digest("hex");
}

function validKekCheck(kek: Buffer, expected: string): boolean {
  const actual = Buffer.from(calculateKekCheck(kek), "hex");
  const persisted = Buffer.from(expected, "hex");
  try {
    return actual.length === persisted.length && timingSafeEqual(actual, persisted);
  } finally {
    actual.fill(0);
    persisted.fill(0);
  }
}

function descriptorIdentity(descriptor: KekDescriptor, keyId: string): string {
  return `${keyId}|${JSON.stringify(descriptor)}`;
}

function cacheKek(path: string, identity: string, kek: Buffer): Buffer {
  if (kek.length !== 32) {
    kek.fill(0);
    throw new KeystoreUnlockError();
  }
  clearUnlocked();
  unreadablePaths.delete(path);
  unlockFailures.delete(unlockFailureKey(path, identity));
  unlocked = { path, descriptor: identity, kek };
  return kek;
}

interface RecoveredKek {
  kek: Buffer;
  identity: string;
  cached: boolean;
}

function recoverStoreKek(store: StoredKeystore, path: string, opts: KeystoreOptions): RecoveredKek {
  const keyId = keyringItemId(store.itemId);
  const identity = descriptorIdentity(store.kek, keyId);
  if (unlocked?.path === path && unlocked.descriptor === identity) {
    return { kek: unlocked.kek, identity, cached: true };
  }
  if (unlockFailures.has(unlockFailureKey(path, identity))) {
    throw new KeystoreUnlockError();
  }
  // A changed path or wrapper identifies a different custody cell. Do not retain the old KEK if
  // recovery of the replacement fails.
  clearUnlocked();
  try {
    const kek = unwrapKek(store.kek, { ...opts, keyId });
    if (kek.length !== 32) {
      kek.fill(0);
      throw new KeystoreUnlockError();
    }
    return { kek, identity, cached: false };
  } catch {
    // Lazy request-path custody memoizes a sanitized failure just as firmly as a successful KEK:
    // later resolutions degrade from memory instead of respawning the OS keyring per request.
    unlockFailures.set(unlockFailureKey(path, identity), { path, descriptor: identity, status: "locked" });
    throw new KeystoreUnlockError();
  }
}

function discardRecoveredKek(recovered: RecoveredKek): void {
  if (recovered.cached) clearUnlocked();
  else recovered.kek.fill(0);
}

function recoverVerifiedStoreKek(
  store: StoredKeystore,
  path: string,
  opts: KeystoreOptions,
): RecoveredKek {
  const recovered = recoverStoreKek(store, path, opts);
  if (!validKekCheck(recovered.kek, store.kekCheck)) {
    discardRecoveredKek(recovered);
    unlockFailures.set(
      unlockFailureKey(path, recovered.identity),
      { path, descriptor: recovered.identity, status: "locked" },
    );
    throw new KeystoreUnlockError();
  }
  return recovered;
}

function cryptographicallyUnreadableCount(store: StoredKeystore, kek: Buffer): number {
  return store.entries.filter(
    (entry) => !entryAuthenticates(entry, kek, store.fpSalt),
  ).length;
}

function unlockStoreForWrite(store: StoredKeystore, path: string, opts: KeystoreOptions): Buffer {
  const recovered = recoverVerifiedStoreKek(store, path, opts);
  const unreadableRows = cryptographicallyUnreadableCount(store, recovered.kek);
  if (unreadableRows > 0) {
    discardRecoveredKek(recovered);
    throw new KeystoreMutationRefusedError("degraded", unreadableRows);
  }
  if (recovered.cached) return recovered.kek;
  return cacheKek(path, recovered.identity, recovered.kek);
}

function refuseCryptographicDegradationWhenUnlockable(
  store: StoredKeystore,
  path: string,
  opts: KeystoreOptions,
): void {
  let recovered: RecoveredKek;
  try {
    recovered = recoverVerifiedStoreKek(store, path, opts);
  } catch {
    // Lifecycle cleanup must remain possible when custody cannot be unwrapped.
    return;
  }
  try {
    const unreadableRows = cryptographicallyUnreadableCount(store, recovered.kek);
    if (unreadableRows > 0) {
      throw new KeystoreMutationRefusedError("degraded", unreadableRows);
    }
  } finally {
    if (!recovered.cached) recovered.kek.fill(0);
  }
}

function createStore(path: string, opts: KeystoreOptions): { store: StoredKeystore; kek: Buffer } {
  const fpSalt = randomBytes(FINGERPRINT_SALT_LENGTH).toString("base64");
  const itemId = randomBytes(ITEM_ID_LENGTH).toString("hex");
  const keyId = keyringItemId(itemId);
  const created = createKek({ ...opts, keyId });
  const kek = cacheKek(path, descriptorIdentity(created.descriptor, keyId), created.kek);
  return {
    store: {
      version: STORE_VERSION,
      kek: created.descriptor,
      fpSalt,
      itemId,
      kekCheck: calculateKekCheck(kek),
      entries: [],
    },
    kek,
  };
}

function hardeningPlatform(opts: KeystoreOptions): NodeJS.Platform {
  return opts.acl?.platform ?? process.platform;
}

function hardenDirectory(path: string, opts: KeystoreOptions): void {
  if (hardeningPlatform(opts) === "win32") {
    restrictSecretDirectoryOnWindowsSync(path, opts.acl);
  } else {
    chmodSync(path, DIRECTORY_MODE);
  }
}

function hardenFile(path: string, opts: KeystoreOptions): void {
  if (hardeningPlatform(opts) === "win32") {
    restrictSecretFileOnWindowsSync(path, opts.acl);
  } else {
    chmodSync(path, FILE_MODE);
  }
}

function persistStore(path: string, store: StoredKeystore, opts: KeystoreOptions): void {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    const createdDirectory = mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
    if (createdDirectory !== undefined) hardenDirectory(directory, opts);
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      FILE_MODE,
    );
    writeFileSync(descriptor, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    hardenFile(temporaryPath, opts);
    renameSync(temporaryPath, path);
    hardenFile(path, opts);
    unreadablePaths.delete(path);
  } catch (error) {
    throw new KeystoreWriteError(errorCode(error));
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

function refuseMutation(loaded: StoreLoadResult): never {
  const status = loaded.status === "degraded" ? "degraded" : "unreadable";
  const errno = loaded.status === "unreadable" ? loaded.errno : undefined;
  throw new KeystoreMutationRefusedError(status, loaded.droppedCount, errno);
}

function requireStoreForMutation(path: string, opts: KeystoreOptions): StoredKeystore {
  const loaded = loadStore(path, opts);
  if (loaded.status === "fresh") throw new KeystoreEntryNotFoundError();
  if (loaded.status === "unreadable" || loaded.status === "degraded") refuseMutation(loaded);
  return loaded.store;
}

function findEntry(store: StoredKeystore, entryId: string): StoredEntry {
  const entry = store.entries.find((candidate) => candidate.id === entryId);
  if (entry === undefined) throw new KeystoreEntryNotFoundError();
  return entry;
}

export function lookupByEnvName(
  envName: string,
  opts?: KeystoreOptions,
  provider?: string,
): KeystoreLookup | null;
export function lookupByEnvName(
  envName: string,
  provider: string,
  opts?: KeystoreOptions,
): KeystoreLookup | null;
export function lookupByEnvName(
  envName: string,
  optsOrProvider: KeystoreOptions | string = {},
  providerOrOpts?: string | KeystoreOptions,
): KeystoreLookup | null {
  const opts = typeof optsOrProvider === "string"
    ? (typeof providerOrOpts === "object" && providerOrOpts !== null ? providerOrOpts : {})
    : optsOrProvider;
  const provider = typeof optsOrProvider === "string"
    ? optsOrProvider
    : (typeof providerOrOpts === "string" ? providerOrOpts : undefined);
  if (!ENV_NAME_PATTERN.test(envName)) return null;
  if (provider !== undefined && !PROVIDER_PATTERN.test(provider)) return null;
  let recovered: RecoveredKek | null = null;
  let retained = false;
  try {
    const path = resolveKeystorePath(opts);
    if (unreadablePaths.has(path)) return null;
    const loaded = loadStore(path, opts);
    if (loaded.status === "fresh" || loaded.status === "unreadable") {
      if (loaded.status === "unreadable") unreadablePaths.add(path);
      return null;
    }
    unreadablePaths.delete(path);
    const store = loaded.store;
    const now = opts.now ?? Date.now();
    if (!validTimestamp(now)) return null;
    for (const entry of store.entries) {
      if (entry.envName !== envName || (provider !== undefined && entry.provider !== provider)) continue;
      if (entry.disabled || entry.revokedAt !== null) continue;
      if (entry.expiresAt !== null && entry.expiresAt <= now) continue;
      recovered ??= recoverVerifiedStoreKek(store, path, opts);
      if (!recovered.cached && !retained) {
        cacheKek(path, recovered.identity, recovered.kek);
        retained = true;
      }
      const value = decryptEntryValue(entry, recovered.kek, store.fpSalt);
      if (value !== null) {
        return { value, entryId: entry.id as CredentialId, provider: entry.provider };
      }
    }
    return null;
  } catch {
    // Resolver reads are fail-closed: custody failure degrades the provider, never process boot.
    return null;
  } finally {
    if (recovered !== null && !recovered.cached && !retained) recovered.kek.fill(0);
  }
}

export function listEntries(opts: KeystoreOptions = {}): KeystoreEntryDescriptor[] {
  const path = resolveKeystorePath(opts);
  const loaded = loadStore(path, opts);
  if (loaded.status === "unreadable") {
    unreadablePaths.add(path);
    throw new KeystoreReadError(loaded.errno);
  }
  unreadablePaths.delete(path);
  if (loaded.status === "fresh") return [];
  return loaded.store.entries.map(descriptorOf);
}

/** Report resolver-readable custody state without throwing or exposing key material. */
export function keystoreStatus(opts: KeystoreOptions = {}): KeystoreStatus {
  try {
    const path = resolveKeystorePath(opts);
    if (unreadablePaths.has(path)) return { status: "unreadable", droppedCount: 0 };
    const loaded = loadStore(path, opts);
    if (loaded.status === "fresh") return { status: "absent", droppedCount: 0 };
    if (loaded.status === "unreadable") {
      unreadablePaths.add(path);
      return { status: "unreadable", droppedCount: loaded.droppedCount };
    }
    unreadablePaths.delete(path);
    const store = loaded.store;
    let recovered: RecoveredKek | null = null;
    let retained = false;
    try {
      recovered = recoverVerifiedStoreKek(store, path, opts);
      if (!recovered.cached) {
        cacheKek(path, recovered.identity, recovered.kek);
        retained = true;
      }
      const cryptographicallyUnreadable = cryptographicallyUnreadableCount(
        store,
        recovered.kek,
      );
      const droppedCount = loaded.droppedCount + cryptographicallyUnreadable;
      return { status: droppedCount > 0 ? "degraded" : "ok", droppedCount };
    } catch {
      return { status: "locked", droppedCount: loaded.droppedCount };
    } finally {
      if (recovered !== null && !recovered.cached && !retained) recovered.kek.fill(0);
    }
  } catch {
    return { status: "unreadable", droppedCount: 0 };
  }
}

export function addEntry(input: AddEntryInput, opts: KeystoreOptions = {}): KeystoreEntryDescriptor {
  validateEntryIdentity(input.id, input.provider, input.envName);
  validateValue(input.value);
  validateExpiresAt(input.expiresAt);
  const now = writeTime(opts);
  const path = resolveKeystorePath(opts);
  const loaded = loadStore(path, opts);
  if (loaded.status === "unreadable" || loaded.status === "degraded") refuseMutation(loaded);
  const existing = loaded.status === "fresh" ? null : loaded.store;
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
    ...encryptEntryValue(
      input.value,
      input.provider,
      input.id,
      input.envName,
      initialized.kek,
      initialized.store.fpSalt,
    ),
    addedAt: now,
    rotatedAt: null,
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    disabled: false,
  };
  initialized.store.entries.push(entry);
  persistStore(path, initialized.store, opts);
  return descriptorOf(entry);
}

/** Rotate installs a live replacement key; it deliberately un-revokes a revoked entry. */
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
  const store = requireStoreForMutation(path, opts);
  const entry = findEntry(store, entryId);
  Object.assign(entry, encryptEntryValue(
    value,
    entry.provider,
    entry.id,
    entry.envName,
    unlockStoreForWrite(store, path, opts),
    store.fpSalt,
  ));
  entry.rotatedAt = now;
  entry.revokedAt = null;
  if (opts.expiresAt !== undefined) entry.expiresAt = opts.expiresAt;
  persistStore(path, store, opts);
  return descriptorOf(entry);
}

export function revokeEntry(entryId: string, opts: KeystoreOptions = {}): KeystoreEntryDescriptor {
  if (parseCredentialId(entryId) === null) throw new KeystoreValidationError("id");
  const now = writeTime(opts);
  const path = resolveKeystorePath(opts);
  const store = requireStoreForMutation(path, opts);
  const entry = findEntry(store, entryId);
  refuseCryptographicDegradationWhenUnlockable(store, path, opts);
  // Lifecycle metadata stays outside v1 AAD so cleanup remains possible when KEK unwrap fails.
  // When custody is available we authenticate every row before rewriting; the deliberate trade
  // on an unwrappable store is that a file writer can change descriptor/lifecycle metadata and
  // availability, but cannot retarget authenticated provider/id/envName identity or recover
  // plaintext. addedAt, rotatedAt, expiresAt, revokedAt, and disabled remain outside AAD;
  // envName is inside it.
  entry.revokedAt = now;
  persistStore(path, store, opts);
  return descriptorOf(entry);
}

export function removeEntry(entryId: string, opts: KeystoreOptions = {}): boolean {
  if (parseCredentialId(entryId) === null) throw new KeystoreValidationError("id");
  const path = resolveKeystorePath(opts);
  const store = requireStoreForMutation(path, opts);
  const index = store.entries.findIndex((entry) => entry.id === entryId);
  if (index < 0) throw new KeystoreEntryNotFoundError();
  refuseCryptographicDegradationWhenUnlockable(store, path, opts);
  store.entries.splice(index, 1);
  persistStore(path, store, opts);
  return true;
}

export function setDisabled(entryId: string, disabled: boolean, opts: KeystoreOptions = {}): KeystoreEntryDescriptor {
  if (parseCredentialId(entryId) === null) throw new KeystoreValidationError("id");
  if (typeof disabled !== "boolean") throw new KeystoreValidationError("value");
  const path = resolveKeystorePath(opts);
  const store = requireStoreForMutation(path, opts);
  const entry = findEntry(store, entryId);
  refuseCryptographicDegradationWhenUnlockable(store, path, opts);
  entry.disabled = disabled;
  persistStore(path, store, opts);
  return descriptorOf(entry);
}

/** Zeroize a process-held KEK or clear a memoized unlock failure so a later lookup retries. */
export function lock(opts: { path?: string } = {}): void {
  const path = opts.path === undefined ? undefined : resolveKeystorePath(opts);
  if (unlocked !== null && (path === undefined || unlocked.path === path)) clearUnlocked();
  for (const [key, failure] of unlockFailures) {
    if (path === undefined || failure.path === path) unlockFailures.delete(key);
  }
  if (path === undefined) unreadablePaths.clear();
  else unreadablePaths.delete(path);
}
