/**
 * Encrypted credential custody is single-writer by convention. Mutations are read-modify-write,
 * no inter-process lock is built, and concurrent CLI writers therefore have last-write-wins
 * semantics. An envName is globally unique within a store; malformed or duplicate rows are
 * skipped in file order, so the first valid row deterministically wins read-side deduplication.
 */
import { relayStatePath } from "./state-paths.js";
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
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { parseCredentialId, type CredentialId } from "./credential-id.js";
import { hasExactKeysWithOptional, isRecord as isObject } from "./json-shape.js";
import {
  createPassphraseKek,
  createKek,
  derivePassphraseKek,
  unwrapKek,
  type KekDescriptor,
  type KekWrapMode,
  type KeyringOptions,
  type ScryptKdfDescriptor,
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
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const FINGERPRINT_PATTERN = /^hmac:[0-9a-f]{8}$/;
const ITEM_ID_PATTERN = /^[0-9a-f]{32}$/;
const KEK_CHECK_PATTERN = /^[0-9a-f]{64}$/;
const KEK_CHECK_CONTEXT = "llm-relay-kek-v1";
const EXPORT_AAD = Buffer.from("llm-relay-keystore-export-v1", "utf8");
const EXPORT_SOURCE = "llm-relay-keystore";
const UNREADABLE_RETRY_MS = 30_000;
const UNLOCK_RETRY_MS = 60_000;

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

export interface KeystoreFileStat {
  mtimeMs: number;
  size: number;
  ino: number;
}

declare const keystoreResolutionWalkBrand: unique symbol;
export interface KeystoreResolutionWalk {
  readonly [keystoreResolutionWalkBrand]: true;
}

export interface KeystoreOptions extends KeyringOptions {
  path?: string;
  now?: number;
  /** Injected Windows ACL process/platform seam; separate from the keyring spawner. */
  acl?: SecretFileAclOptions;
  /** Read seam for deterministic filesystem-failure tests. */
  readFile?: (path: string) => string;
  /** Stat seam for deterministic staleness and filesystem-cardinality tests. */
  statFile?: (path: string) => KeystoreFileStat;
  /** Opaque request-resolution scope created with createKeystoreResolutionWalk(). */
  resolutionWalk?: KeystoreResolutionWalk;
}

export interface KeystoreStatus {
  status: "ok" | "absent" | "unreadable" | "locked" | "degraded";
  /** Retained descriptors whose authenticated ciphertext cannot be decrypted. */
  undecryptableCount: number;
  /** Total structurally dropped plus cryptographically undecryptable rows. */
  droppedCount: number;
}

export interface KeystoreExportEntry extends KeystoreEntryDescriptor {
  /** Secret-bearing. This type is only returned after decrypting an encrypted export. */
  value: string;
}

interface KeystoreExportEnvelope {
  version: 1;
  source: typeof EXPORT_SOURCE;
  kdf: ScryptKdfDescriptor;
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
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

export interface KeystoreCandidateLookup extends KeystoreLookup {
  envName: string;
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

export class KeystoreExportError extends Error {
  constructor(message = "encrypted keystore export is invalid or cannot be decrypted") {
    super(message);
    this.name = "KeystoreExportError";
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
  failedAt: number;
}

interface MemoizedStoreLoad {
  token: string;
  result: StoreLoadResult;
  failedAt?: number;
}

const unlockFailures = new Map<string, MemoizedUnlockFailure>();
// Production resolves one configured store path. Test/embedding path injection can grow these
// maps until lock()/process exit; cardinality eviction would violate unchanged-store zero-read and
// uninterrupted unlock-cooldown guarantees.
const storeLoads = new Map<string, MemoizedStoreLoad>();
const resolutionWalkLoads = new WeakMap<
  KeystoreResolutionWalk,
  Map<string, MemoizedStoreLoad>
>();

function unlockFailureKey(path: string, descriptor: string): string {
  return `${path}\0${descriptor}`;
}

function pruneUnlockFailures(path: string, descriptor: string): void {
  for (const [key, failure] of unlockFailures) {
    if (failure.path === path && failure.descriptor !== descriptor) unlockFailures.delete(key);
  }
}

function rememberUnlockFailure(
  path: string,
  descriptor: string,
  status: MemoizedUnlockFailure["status"],
  opts: Pick<KeystoreOptions, "now">,
): void {
  const key = unlockFailureKey(path, descriptor);
  unlockFailures.delete(key);
  unlockFailures.set(key, { path, descriptor, status, failedAt: memoTime(opts) });
}

export function createKeystoreResolutionWalk(): KeystoreResolutionWalk {
  const walk = Object.freeze({}) as KeystoreResolutionWalk;
  resolutionWalkLoads.set(walk, new Map());
  return walk;
}

/** Resolve the live store path without ever letting tests touch the user's real store. */
export function resolveKeystorePath(opts: { path?: string } = {}): string {
  if (opts.path !== undefined) return resolve(opts.path);
  if (process.env.VITEST !== undefined) {
    const pool = process.env.VITEST_POOL_ID ?? "pool";
    const worker = process.env.VITEST_WORKER_ID ?? "worker";
    return resolve(join(tmpdir(), `llm-relay-test-keystore-${process.pid}-${pool}-${worker}`, "keystore.json"));
  }
  // ⚠ `relayStatePath` keeps returning the legacy `~/.llm-relay/keystore.json` whenever that file
  // exists and the XDG one does not. That fallback is load-bearing HERE above everywhere else: an
  // operator's encrypted credentials are the one artifact this relay cannot re-fetch, so honouring
  // XDG must never turn a working store into an empty one.
  return resolve(relayStatePath("config", ["keystore.json"]));
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
      return hasExactKeysWithOptional(value, ["wrap", "blob"])
        && (decodeBase64(value.blob)?.length ?? 0) > 0;
    case "keychain":
    case "libsecret":
      return hasExactKeysWithOptional(value, ["wrap"]);
    case "passphrase": {
      if (!hasExactKeysWithOptional(value, ["wrap", "kdf"]) || !isObject(value.kdf)) return false;
      return hasExactKeysWithOptional(value.kdf, ["n", "r", "p", "salt"])
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
  if (!isObject(value) || !hasExactKeysWithOptional(value, [
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
  if (!isObject(raw) || !hasExactKeysWithOptional(raw, [
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

type StoreObservation =
  | { kind: "present"; token: string }
  | { kind: "absent"; token: "ENOENT" }
  | { kind: "error"; token: string; errno?: string };

function memoTime(opts: Pick<KeystoreOptions, "now">): number {
  return validTimestamp(opts.now) ? opts.now : Date.now();
}

function observeStore(
  path: string,
  opts: Pick<KeystoreOptions, "statFile">,
): StoreObservation {
  let pathEntryExists = false;
  try {
    let stat: KeystoreFileStat;
    if (opts.statFile !== undefined) {
      stat = opts.statFile(path);
      pathEntryExists = true;
    } else {
      const pathStat = lstatSync(path);
      pathEntryExists = true;
      if (pathStat.isSymbolicLink()) {
        const targetStat = statSync(path);
        stat = {
          mtimeMs: targetStat.mtimeMs,
          size: targetStat.size,
          ino: targetStat.ino,
        };
      } else {
        stat = {
          mtimeMs: pathStat.mtimeMs,
          size: pathStat.size,
          ino: pathStat.ino,
        };
      }
    }
    if (
      !Number.isFinite(stat.mtimeMs)
      || !Number.isFinite(stat.size)
      || !Number.isFinite(stat.ino)
    ) {
      return { kind: "error", token: "stat:EINVAL", errno: "EINVAL" };
    }
    return {
      kind: "present",
      token: `stat:${stat.mtimeMs}:${stat.size}:${stat.ino}`,
    };
  } catch (error) {
    const errno = errorCode(error);
    if (errno === "ENOENT" && !pathEntryExists) {
      return { kind: "absent", token: "ENOENT" };
    }
    if (errno !== "ENOENT") {
      return errno === undefined
        ? { kind: "error", token: "stat:UNKNOWN" }
        : { kind: "error", token: `stat:${errno}`, errno };
    }
    // A dangling symlink has a directory entry even though following it reports ENOENT.
    return { kind: "error", token: "stat:ENOENT:present", errno };
  }
}

function reusableStoreLoad(memo: MemoizedStoreLoad, now: number): boolean {
  if (memo.result.status !== "unreadable") return true;
  const failedAt = memo.failedAt ?? now;
  return now < failedAt || now - failedAt < UNREADABLE_RETRY_MS;
}

function rememberStoreLoad(path: string, memo: MemoizedStoreLoad): void {
  storeLoads.delete(path);
  storeLoads.set(path, memo);
}

function walkLoads(opts: Pick<KeystoreOptions, "resolutionWalk">): Map<string, MemoizedStoreLoad> | undefined {
  return opts.resolutionWalk === undefined
    ? undefined
    : resolutionWalkLoads.get(opts.resolutionWalk);
}

function invalidateStoreLoad(path: string, opts?: Pick<KeystoreOptions, "resolutionWalk">): void {
  const normalizedPath = resolve(path);
  storeLoads.delete(normalizedPath);
  if (opts !== undefined) walkLoads(opts)?.delete(normalizedPath);
}

function loadStore(path: string, opts: KeystoreOptions = {}): StoreLoadResult {
  const normalizedPath = resolve(path);
  const now = memoTime(opts);
  const scopedLoads = walkLoads(opts);
  const scoped = scopedLoads?.get(normalizedPath);
  if (scoped !== undefined) return scoped.result;

  const observation = observeStore(normalizedPath, opts);
  const memoized = storeLoads.get(normalizedPath);
  if (
    memoized !== undefined
    && memoized.token === observation.token
    && reusableStoreLoad(memoized, now)
  ) {
    scopedLoads?.set(normalizedPath, memoized);
    return memoized.result;
  }

  let result: StoreLoadResult;
  if (observation.kind === "absent") {
    result = { status: "fresh", droppedCount: 0 };
  } else if (observation.kind === "error") {
    result = observation.errno === undefined
      ? { status: "unreadable", droppedCount: 0 }
      : { status: "unreadable", droppedCount: 0, errno: observation.errno };
  } else {
    try {
      const serialized = opts.readFile?.(normalizedPath) ?? readFileSync(normalizedPath, "utf8");
      const parsed = parseStore(JSON.parse(serialized) as unknown);
      result = parsed === null
        ? { status: "unreadable", droppedCount: 0 }
        : {
            status: parsed.droppedCount > 0 ? "degraded" : "ok",
            droppedCount: parsed.droppedCount,
            store: parsed.store,
          };
    } catch (error) {
      // A present but malformed or transiently unreadable document is never equivalent to an
      // absent, creatable store. The sanitized verdict is retried on token change or TTL expiry.
      const errno = errorCode(error);
      result = errno === undefined
        ? { status: "unreadable", droppedCount: 0 }
        : { status: "unreadable", droppedCount: 0, errno };
    }
  }

  const remembered: MemoizedStoreLoad = result.status === "unreadable"
    ? { token: observation.token, result, failedAt: now }
    : { token: observation.token, result };
  rememberStoreLoad(normalizedPath, remembered);
  scopedLoads?.set(normalizedPath, remembered);
  return result;
}

function validateEntryIdentity(id: string, provider: string, envName: string): void {
  const parsedId = parseCredentialId(id);
  if (parsedId === null) throw new KeystoreValidationError("id");
  if (!PROVIDER_PATTERN.test(provider)) throw new KeystoreValidationError("provider");
  if (parsedId.provider !== provider) throw new KeystoreValidationError("provider");
  if (!ENV_NAME_PATTERN.test(envName)) throw new KeystoreValidationError("envName");
}

export function keyIsPresent(value: string | undefined): boolean {
  return (value ?? "").trim().length > 0;
}

function validateValue(value: string): void {
  if (typeof value !== "string" || !keyIsPresent(value)) {
    throw new KeystoreValidationError("value");
  }
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
  switch (descriptor.wrap) {
    case "dpapi":
      return `${keyId}|dpapi|${descriptor.blob ?? ""}`;
    case "passphrase":
      return `${keyId}|passphrase|${descriptor.kdf?.n ?? ""}|${descriptor.kdf?.r ?? ""}|${descriptor.kdf?.p ?? ""}|${descriptor.kdf?.salt ?? ""}`;
    case "keychain":
    case "libsecret":
      return `${keyId}|${descriptor.wrap}`;
  }
}

function cacheKek(path: string, identity: string, kek: Buffer): Buffer {
  if (kek.length !== 32) {
    kek.fill(0);
    throw new KeystoreUnlockError();
  }
  clearUnlocked();
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
  pruneUnlockFailures(path, identity);
  if (unlocked?.path === path && unlocked.descriptor === identity) {
    return { kek: unlocked.kek, identity, cached: true };
  }
  const failureKey = unlockFailureKey(path, identity);
  const failure = unlockFailures.get(failureKey);
  if (failure !== undefined) {
    const now = memoTime(opts);
    if (now < failure.failedAt || now - failure.failedAt < UNLOCK_RETRY_MS) {
      throw new KeystoreUnlockError();
    }
    unlockFailures.delete(failureKey);
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
    // Lazy request-path custody applies a cooldown to sanitized failures. Later resolutions avoid
    // respawning the OS keyring until the bounded retry window expires.
    rememberUnlockFailure(path, identity, "locked", opts);
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
    rememberUnlockFailure(path, recovered.identity, "locked", opts);
    throw new KeystoreUnlockError();
  }
  unlockFailures.delete(unlockFailureKey(path, recovered.identity));
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
    invalidateStoreLoad(path, opts);
    hardenFile(path, opts);
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

function cloneStoreForMutation(store: StoredKeystore): StoredKeystore {
  return {
    ...store,
    entries: store.entries.map((entry) => ({ ...entry })),
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
  return cloneStoreForMutation(loaded.store);
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
  if (!ENV_NAME_PATTERN.test(envName)) return null;
  const found = lookupByEnvNames([envName], opts);
  if (found === null) return null;
  return { value: found.value, entryId: found.entryId, provider: found.provider };
}

export function lookupByEnvNames(
  envNames: readonly string[],
  opts: KeystoreOptions = {},
): KeystoreCandidateLookup | null {
  const candidates = envNames.filter((envName) => ENV_NAME_PATTERN.test(envName));
  if (candidates.length === 0) return null;
  let recovered: RecoveredKek | null = null;
  let retained = false;
  try {
    const path = resolveKeystorePath(opts);
    const loaded = loadStore(path, opts);
    if (loaded.status === "fresh" || loaded.status === "unreadable") return null;
    const store = loaded.store;
    const now = opts.now ?? Date.now();
    if (!validTimestamp(now)) return null;
    for (const envName of candidates) {
      for (const entry of store.entries) {
        if (entry.envName !== envName) continue;
        if (entry.disabled || entry.revokedAt !== null) continue;
        if (entry.expiresAt !== null && entry.expiresAt <= now) continue;
        recovered ??= recoverVerifiedStoreKek(store, path, opts);
        if (!recovered.cached && !retained) {
          cacheKek(path, recovered.identity, recovered.kek);
          retained = true;
        }
        const value = decryptEntryValue(entry, recovered.kek, store.fpSalt);
        if (value !== null && keyIsPresent(value)) {
          return {
            envName,
            value,
            entryId: entry.id as CredentialId,
            provider: entry.provider,
          };
        }
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
  if (loaded.status === "unreadable") throw new KeystoreReadError(loaded.errno);
  if (loaded.status === "fresh") return [];
  return loaded.store.entries.map(descriptorOf);
}

/** Report resolver-readable custody state without throwing or exposing key material. */
export function keystoreStatus(opts: KeystoreOptions = {}): KeystoreStatus {
  try {
    const path = resolveKeystorePath(opts);
    const loaded = loadStore(path, opts);
    if (loaded.status === "fresh") {
      return { status: "absent", undecryptableCount: 0, droppedCount: 0 };
    }
    if (loaded.status === "unreadable") {
      return {
        status: "unreadable",
        undecryptableCount: 0,
        droppedCount: loaded.droppedCount,
      };
    }
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
      return {
        status: droppedCount > 0 ? "degraded" : "ok",
        undecryptableCount: cryptographicallyUnreadable,
        droppedCount,
      };
    } catch {
      return {
        status: "locked",
        undecryptableCount: 0,
        droppedCount: loaded.droppedCount,
      };
    } finally {
      if (recovered !== null && !recovered.cached && !retained) recovered.kek.fill(0);
    }
  } catch {
    return { status: "unreadable", undecryptableCount: 0, droppedCount: 0 };
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
  const existing = loaded.status === "fresh" ? null : cloneStoreForMutation(loaded.store);
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

/** Read only the wrapping mode; passphrase bytes and KEK recovery are deliberately not involved. */
export function keystoreWrapMode(opts: KeystoreOptions = {}): KekWrapMode | null {
  const path = resolveKeystorePath(opts);
  const loaded = loadStore(path, opts);
  if (loaded.status === "fresh") return null;
  if (loaded.status === "unreadable") throw new KeystoreReadError(loaded.errno);
  return loaded.store.kek.wrap;
}

/**
 * Explicitly verify a passphrase store against its persisted KEK verifier.
 * Other wrap modes are a metadata-only no-op.
 */
export function verifyKeystoreUnlock(opts: KeystoreOptions = {}): KekWrapMode | null {
  const path = resolveKeystorePath(opts);
  const loaded = loadStore(path, opts);
  if (loaded.status === "fresh") return null;
  if (loaded.status === "unreadable") throw new KeystoreReadError(loaded.errno);
  const mode = loaded.store.kek.wrap;
  if (mode !== "passphrase") return mode;

  // An explicit operator retry starts a fresh verifier attempt. Otherwise the resolver's
  // bounded wrong-passphrase cooldown could reject a corrected passphrase in this process.
  lock({ path });
  const recovered = recoverVerifiedStoreKek(loaded.store, path, opts);
  try {
    return mode;
  } finally {
    if (!recovered.cached) recovered.kek.fill(0);
    lock({ path });
  }
}

interface KeystoreExportPayload {
  version: 1;
  entries: KeystoreExportEntry[];
}

function parseExportEnvelope(text: string): KeystoreExportEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isObject(parsed) || !hasExactKeysWithOptional(parsed, [
    "version", "source", "kdf", "cipher", "iv", "tag", "ciphertext",
  ])) return null;
  if (
    parsed.version !== 1 ||
    parsed.source !== EXPORT_SOURCE ||
    parsed.cipher !== "aes-256-gcm" ||
    !isObject(parsed.kdf) ||
    !hasExactKeysWithOptional(parsed.kdf, ["n", "r", "p", "salt"]) ||
    parsed.kdf.n !== 16_384 ||
    parsed.kdf.r !== 8 ||
    parsed.kdf.p !== 1 ||
    typeof parsed.kdf.salt !== "string" ||
    decodeBase64(parsed.kdf.salt, 32) === null ||
    typeof parsed.iv !== "string" ||
    decodeBase64(parsed.iv, GCM_IV_LENGTH) === null ||
    typeof parsed.tag !== "string" ||
    decodeBase64(parsed.tag, GCM_TAG_LENGTH) === null ||
    typeof parsed.ciphertext !== "string" ||
    (decodeBase64(parsed.ciphertext)?.length ?? 0) === 0
  ) return null;
  return parsed as unknown as KeystoreExportEnvelope;
}

function validExportEntry(value: unknown): value is KeystoreExportEntry {
  if (!isObject(value) || !hasExactKeysWithOptional(value, [
    "id", "provider", "envName", "fingerprint", "addedAt", "rotatedAt", "expiresAt",
    "revokedAt", "disabled", "value",
  ])) return false;
  const parsedId = typeof value.id === "string" ? parseCredentialId(value.id) : null;
  return parsedId !== null &&
    typeof value.provider === "string" && PROVIDER_PATTERN.test(value.provider) &&
    parsedId.provider === value.provider &&
    typeof value.envName === "string" && ENV_NAME_PATTERN.test(value.envName) &&
    typeof value.fingerprint === "string" && FINGERPRINT_PATTERN.test(value.fingerprint) &&
    validTimestamp(value.addedAt) &&
    validNullableTimestamp(value.rotatedAt) &&
    validNullableTimestamp(value.expiresAt) &&
    validNullableTimestamp(value.revokedAt) &&
    typeof value.disabled === "boolean" &&
    typeof value.value === "string" && keyIsPresent(value.value);
}

function parseExportPayload(value: unknown): KeystoreExportPayload | null {
  if (!isObject(value) || !hasExactKeysWithOptional(value, ["version", "entries"]) ||
      value.version !== 1 || !Array.isArray(value.entries)) return null;
  const entries: KeystoreExportEntry[] = [];
  const ids = new Set<string>();
  const envNames = new Set<string>();
  for (const candidate of value.entries) {
    if (!validExportEntry(candidate) || ids.has(candidate.id) || envNames.has(candidate.envName)) {
      return null;
    }
    ids.add(candidate.id);
    envNames.add(candidate.envName);
    entries.push(candidate);
  }
  return { version: 1, entries };
}

/** True only for this CLI's closed, versioned encrypted-export envelope. */
export function isEncryptedKeystoreExport(text: string): boolean {
  return parseExportEnvelope(text) !== null;
}

/**
 * Decrypt every usable row and immediately re-encrypt the whole logical payload under an
 * export-time passphrase. A plaintext export API deliberately does not exist.
 */
export function createEncryptedKeystoreExport(
  exportPassphrase: string | Buffer,
  opts: KeystoreOptions = {},
): string {
  const path = resolveKeystorePath(opts);
  const loaded = loadStore(path, opts);
  if (loaded.status === "fresh") throw new KeystoreReadError("ENOENT");
  if (loaded.status === "unreadable") throw new KeystoreReadError(loaded.errno);
  if (loaded.status === "degraded") {
    throw new KeystoreMutationRefusedError("degraded", loaded.droppedCount);
  }
  // Derive the export key before decrypting any row, so KDF failure cannot strand an owned
  // plaintext payload buffer. Every Buffer below enters the outer cleanup scope immediately.
  const created = createPassphraseKek(exportPassphrase);
  let iv: Buffer | undefined;
  let plaintext: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let tag: Buffer | undefined;
  try {
    iv = randomBytes(GCM_IV_LENGTH);
    const recovered = recoverVerifiedStoreKek(loaded.store, path, opts);
    const entries: KeystoreExportEntry[] = [];
    try {
      for (const entry of loaded.store.entries) {
        const value = decryptEntryValue(entry, recovered.kek, loaded.store.fpSalt);
        if (value === null) throw new KeystoreMutationRefusedError("degraded", 1);
        entries.push({ ...descriptorOf(entry), value });
      }
    } finally {
      if (!recovered.cached) recovered.kek.fill(0);
    }
    const payload: KeystoreExportPayload = { version: 1, entries };
    plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const cipher = createCipheriv("aes-256-gcm", created.kek, iv);
    cipher.setAAD(EXPORT_AAD);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    tag = cipher.getAuthTag();
    const kdf = created.descriptor.kdf;
    if (created.descriptor.wrap !== "passphrase" || kdf === undefined) {
      throw new KeystoreExportError();
    }
    const envelope: KeystoreExportEnvelope = {
      version: 1,
      source: EXPORT_SOURCE,
      kdf,
      cipher: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    return `${JSON.stringify(envelope, null, 2)}\n`;
  } finally {
    tag?.fill(0);
    ciphertext?.fill(0);
    plaintext?.fill(0);
    iv?.fill(0);
    created.kek.fill(0);
  }
}

/** Decrypt an encrypted export for immediate insertion into another keystore. */
export function decryptEncryptedKeystoreExport(
  text: string,
  passphrase: string | Buffer,
): KeystoreExportEntry[] {
  const envelope = parseExportEnvelope(text);
  if (envelope === null) throw new KeystoreExportError();
  let key: Buffer | undefined;
  let iv: Buffer | undefined;
  let tag: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    key = derivePassphraseKek(passphrase, envelope.kdf);
    iv = Buffer.from(envelope.iv, "base64");
    tag = Buffer.from(envelope.tag, "base64");
    ciphertext = Buffer.from(envelope.ciphertext, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(EXPORT_AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = parseExportPayload(JSON.parse(plaintext.toString("utf8")) as unknown);
    if (parsed === null) throw new KeystoreExportError();
    return parsed.entries;
  } catch (error) {
    if (error instanceof KeystoreExportError) throw error;
    throw new KeystoreExportError();
  } finally {
    key?.fill(0);
    iv?.fill(0);
    tag?.fill(0);
    ciphertext?.fill(0);
    plaintext?.fill(0);
  }
}

/** Restore one authenticated export row, re-encrypting under the destination store's KEK. */
export function restoreEntryFromExport(
  input: KeystoreExportEntry,
  opts: KeystoreOptions = {},
): KeystoreEntryDescriptor {
  if (!validExportEntry(input)) throw new KeystoreExportError();
  const path = resolveKeystorePath(opts);
  const loaded = loadStore(path, opts);
  if (loaded.status === "unreadable" || loaded.status === "degraded") refuseMutation(loaded);
  const existing = loaded.status === "fresh" ? null : cloneStoreForMutation(loaded.store);
  if (existing?.entries.some((entry) => entry.id === input.id || entry.envName === input.envName)) {
    throw new KeystoreEntryExistsError();
  }
  const initialized = existing === null
    ? createStore(path, opts)
    : { store: existing, kek: unlockStoreForWrite(existing, path, opts) };
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
    addedAt: input.addedAt,
    rotatedAt: input.rotatedAt,
    expiresAt: input.expiresAt,
    revokedAt: input.revokedAt,
    disabled: input.disabled,
  };
  initialized.store.entries.push(entry);
  persistStore(path, initialized.store, opts);
  return descriptorOf(entry);
}

/** Zeroize a process-held KEK and end the matching unlock-failure cooldown epoch. */
export function lock(opts: { path?: string } = {}): void {
  const path = opts.path === undefined ? undefined : resolveKeystorePath(opts);
  if (unlocked !== null && (path === undefined || unlocked.path === path)) clearUnlocked();
  for (const [key, failure] of unlockFailures) {
    if (path === undefined || failure.path === path) unlockFailures.delete(key);
  }
}
