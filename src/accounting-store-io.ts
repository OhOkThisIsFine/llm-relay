import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { hasExactKeys as isExactRecord, isRecord } from "./json-shape.js";

/**
 * A deliberately small durability primitive for accounting's multi-file read model.
 *
 * It writes a full snapshot journal before replacing any target.  A later process can
 * therefore replay the journal after any target-write prefix without applying a delta
 * twice.  This module knows nothing about accounting's schemas; callers supply already
 * materialised snapshots and an explicit target allow-list. Only flat, portable direct
 * children of the root are supported for targets and the journal.
 *
 * Threat model: the root and its parent must be trusted and non-adversarial against
 * concurrent same-user replacement. Race-proof filesystem containment against an actor
 * able to rename or replace the root is out of scope; root and final reparse points are
 * still checked before filesystem operations. Writer ownership is enforced only among
 * instances in this process; cross-process concurrent writers are unsupported.
 */
export const SNAPSHOT_JOURNAL_SCHEMA = "llm-relay.snapshot-journal.v1";
export const SNAPSHOT_JOURNAL_VERSION = 1;
export const SNAPSHOT_IO_DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const SNAPSHOT_IO_DEFAULT_MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_IO_DEFAULT_MAX_TARGETS = 32;
export const SNAPSHOT_IO_HARD_MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Four schema-sized snapshots plus base64 and journal metadata fit below this ceiling. */
export const SNAPSHOT_IO_HARD_MAX_JOURNAL_BYTES = 128 * 1024 * 1024;
export const SNAPSHOT_IO_HARD_MAX_TARGETS = 128;
export const SNAPSHOT_IO_MAX_RELATIVE_NAME_BYTES = 256;

export type SnapshotText = string | Uint8Array | null;

export type SnapshotIoStep =
  | "before-temp-write"
  | "after-temp-write"
  | "after-file-fsync"
  | "after-rename"
  | "after-directory-fsync"
  | "before-journal-remove"
  | "after-journal-remove"
  | "before-delete"
  | "after-delete";

export interface SnapshotIoStepContext {
  readonly step: SnapshotIoStep;
  readonly phase: "journal" | "target";
  readonly path: string;
  readonly target: string | null;
}

/** Test seams are synchronous so a test can fail an exact persistence prefix without sleeps. */
export interface SnapshotJournalHooks {
  readonly now?: () => number;
  readonly nonce?: () => string;
  /** Called before an fd-backed read; useful for deterministic EIO/EACCES simulations. */
  readonly beforeRead?: (path: string) => void;
  /** Called after fstat on the opened descriptor, for growth/swap regression tests. */
  readonly afterOpenRead?: (path: string) => void;
  /** Called immediately before directory fsync. Throw an error with `code` to simulate it. */
  readonly beforeDirectoryFsync?: (path: string) => void;
  readonly beforeStep?: (context: SnapshotIoStepContext) => void;
  readonly afterStep?: (context: SnapshotIoStepContext) => void;
}

export interface SnapshotJournalIoOptions {
  /**
   * Explicit trusted root. Its parent must not concurrently replace it with a same-user
   * controlled path; race-proof containment against such an actor is out of scope.
   */
  readonly rootDir: string;
  /** Exact flat, portable direct-child names this instance may replace or read. */
  readonly targets?: readonly string[];
  /**
   * Optional bounded namespace policy for additional flat direct-child names.
   * The predicate is never called for unsafe names; exceptions reject the name.
   */
  readonly acceptTarget?: (name: string) => boolean;
  /** Flat, portable direct-child journal filename. */
  readonly journalName?: string;
  readonly maxFileBytes?: number;
  readonly maxJournalBytes?: number;
  readonly maxTargets?: number;
  readonly hooks?: SnapshotJournalHooks;
}

export interface SnapshotReadOptions {
  readonly maxBytes?: number;
  /** When parsing reveals a corrupt or oversize target, quarantine it before returning. */
  readonly quarantineCorrupt?: boolean;
}

export type SnapshotReadStatus = "ok" | "missing" | "oversize" | "corrupt" | "invalid-target" | "failed";

export interface SnapshotReadResult<T> {
  readonly status: SnapshotReadStatus;
  readonly value: T | null;
  readonly error: string | null;
  readonly quarantinedPath: string | null;
}

export type SnapshotMutationStatus = "committed" | "recovered" | "none" | "recovery-loss" | "invalid" | "failed";

export interface SnapshotMutationResult {
  readonly status: SnapshotMutationStatus;
  readonly transactionId: string | null;
  /** A corrupt journal was quarantined. Existing targets are only a lower bound. */
  readonly lowerBoundLoss: boolean;
  readonly error: string | null;
  readonly quarantinedPath: string | null;
  /** Failed writes preserve the journal, so retrying commit/recover is safe. */
  readonly retryable: boolean;
}

export interface SnapshotQuarantineResult {
  readonly status: "quarantined" | "missing" | "invalid-target" | "failed";
  readonly path: string | null;
  readonly error: string | null;
}

export interface SnapshotWriterResult {
  readonly status: "acquired" | "released" | "closed" | "busy" | "invalid" | "failed";
  readonly error: string | null;
  readonly retryable: boolean;
}

export interface SnapshotJournalIo {
  readonly rootDir: string | null;
  readonly journalPath: string | null;
  readonly targetNames: readonly string[];
  /** Effective bounded limits after defaults and hard-ceiling clamps. */
  readonly maxFileBytes: number | null;
  readonly maxJournalBytes: number | null;
  readonly maxTargets: number | null;
  readText(name: string, options?: SnapshotReadOptions): SnapshotReadResult<string>;
  readJson<T = unknown>(
    name: string,
    validate?: (value: unknown) => value is T,
    options?: SnapshotReadOptions,
  ): SnapshotReadResult<T>;
  quarantineTarget(name: string): SnapshotQuarantineResult;
  /**
   * Retain in-process root-scoped writer ownership across several recover/commit calls.
   * Cross-process concurrent writers are unsupported.
   */
  acquireWriter(): SnapshotWriterResult;
  releaseWriter(): SnapshotWriterResult;
  close(): SnapshotWriterResult;
  /** Recover any durable journal. A missing journal is a successful no-op. */
  recover(): SnapshotMutationResult;
  /** A null snapshot is an explicit tombstone for that target. */
  commit(snapshots: Readonly<Record<string, SnapshotText>>): SnapshotMutationResult;
}

interface TargetPath {
  readonly name: string;
  readonly path: string;
}

interface EncodedSnapshot {
  readonly operation: "replace" | "delete";
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string | null;
  readonly data: string | null;
}

interface DecodedSnapshot {
  readonly name: string;
  readonly data: Buffer | null;
}

interface ParsedJournal {
  readonly transactionId: string;
  readonly targets: readonly DecodedSnapshot[];
}

interface RawRead {
  readonly status: Exclude<SnapshotReadStatus, "invalid-target">;
  readonly data: Buffer | null;
  readonly error: string | null;
}

interface PathInspection {
  readonly status: "ok" | "missing" | "corrupt" | "failed";
  readonly error: string | null;
}

interface Config {
  readonly rootDir: string;
  readonly leaseKey: string;
  readonly journalName: string;
  readonly journalPath: string;
  readonly targets: ReadonlyMap<string, TargetPath>;
  readonly targetAliases: ReadonlySet<string>;
  readonly acceptTarget: ((name: string) => boolean) | null;
  readonly targetNames: readonly string[];
  readonly maxFileBytes: number;
  readonly maxJournalBytes: number;
  readonly maxTargets: number;
  readonly hooks: SnapshotJournalHooks;
}

const JOURNAL_KEYS = ["schema", "version", "transactionId", "createdAtMs", "targets"] as const;
const JOURNAL_TARGET_KEYS = ["name", "operation", "bytes", "sha256", "data"] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PORTABLE_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;
const RESERVED_WINDOWS_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);
const rootWriterLeases = new Map<string, object>();

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replaceAll("\0", "").slice(0, 256) || "io";
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function clamp(value: unknown, fallback: number, hardMax: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, hardMax) : fallback;
}

function checkedAdd(left: number, right: number): number | null {
  return left <= Number.MAX_SAFE_INTEGER - right ? left + right : null;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function canonicalName(value: string): string {
  // Portable target names are ASCII, so this is locale-independent and models Windows aliases.
  return value.toLowerCase();
}

function canonicalRootKey(rootDir: string): string {
  return process.platform === "win32" ? rootDir.toLowerCase() : rootDir;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPortableSegment(value: string): boolean {
  if (!PORTABLE_SEGMENT_PATTERN.test(value) || value.endsWith(".") || value.endsWith(" ")) return false;
  const stem = value.split(".", 1)[0]!.toUpperCase();
  return !RESERVED_WINDOWS_NAMES.has(stem);
}

function isSafeDirectChildName(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || value.includes("\\")
    || value.includes("/")
  ) return false;
  if (utf8Bytes(value) > SNAPSHOT_IO_MAX_RELATIVE_NAME_BYTES || isAbsolute(value) || value.includes(":")) return false;
  return isPortableSegment(value);
}

function inside(rootDir: string, candidate: string): boolean {
  const relation = relative(rootDir, candidate);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(relation);
}

function digest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

function mutationResult(
  status: SnapshotMutationStatus,
  options: Partial<Omit<SnapshotMutationResult, "status">> = {},
): SnapshotMutationResult {
  return {
    status,
    transactionId: options.transactionId ?? null,
    lowerBoundLoss: options.lowerBoundLoss ?? false,
    error: options.error ?? null,
    quarantinedPath: options.quarantinedPath ?? null,
    retryable: options.retryable ?? status === "failed",
  };
}

function readResult<T>(
  status: SnapshotReadStatus,
  value: T | null = null,
  error: string | null = null,
  quarantinedPath: string | null = null,
): SnapshotReadResult<T> {
  return { status, value, error, quarantinedPath };
}

function makeConfig(options: SnapshotJournalIoOptions): { config: Config | null; error: string | null } {
  try {
    if (!isRecord(options) || typeof options.rootDir !== "string" || options.rootDir.length === 0 || options.rootDir.includes("\0")) {
      return { config: null, error: "rootDir" };
    }
    const rootDir = resolve(options.rootDir);
    const maxTargets = clamp(options.maxTargets, SNAPSHOT_IO_DEFAULT_MAX_TARGETS, SNAPSHOT_IO_HARD_MAX_TARGETS);
    const maxFileBytes = clamp(options.maxFileBytes, SNAPSHOT_IO_DEFAULT_MAX_FILE_BYTES, SNAPSHOT_IO_HARD_MAX_FILE_BYTES);
    const maxJournalBytes = clamp(options.maxJournalBytes, SNAPSHOT_IO_DEFAULT_MAX_JOURNAL_BYTES, SNAPSHOT_IO_HARD_MAX_JOURNAL_BYTES);
    const acceptTarget = typeof options.acceptTarget === "function" ? options.acceptTarget : null;
    const staticTargets = options.targets ?? [];
    if (!Array.isArray(staticTargets) || (staticTargets.length === 0 && acceptTarget === null)) {
      return { config: null, error: "targets" };
    }
    const journalName = options.journalName ?? "snapshot-journal.json";
    if (!isSafeDirectChildName(journalName)) return { config: null, error: "journalName" };
    const journalPath = resolve(rootDir, journalName);
    if (!inside(rootDir, journalPath)) return { config: null, error: "journalName" };
    const targets = new Map<string, TargetPath>();
    const aliases = new Set<string>([canonicalName(journalName)]);
    for (const name of staticTargets) {
      const alias = typeof name === "string" ? canonicalName(name) : "";
      if (!isSafeDirectChildName(name) || aliases.has(alias) || targets.has(name)) return { config: null, error: "targets" };
      const path = resolve(rootDir, name);
      if (!inside(rootDir, path)) return { config: null, error: "targets" };
      targets.set(name, { name, path });
      aliases.add(alias);
    }
    return {
      config: {
        rootDir,
        leaseKey: canonicalRootKey(rootDir),
        journalName,
        journalPath,
        targets,
        targetAliases: new Set(aliases),
        acceptTarget,
        targetNames: Object.freeze([...targets.keys()].sort(compareNames)),
        maxFileBytes,
        maxJournalBytes,
        maxTargets,
        hooks: options.hooks ?? {},
      },
      error: null,
    };
  } catch (error) {
    return { config: null, error: safeError(error) };
  }
}

class SnapshotJournalIoImpl implements SnapshotJournalIo {
  private readonly config: Config | null;
  private readonly configError: string | null;
  private readonly writerLeaseToken = {};
  private ownsWriterLease = false;
  private writerOperation = false;
  private pendingRecoveryLoss: { readonly error: string; readonly quarantinedPath: string | null } | null = null;
  private closed = false;

  constructor(options: SnapshotJournalIoOptions) {
    const result = makeConfig(options);
    this.config = result.config;
    this.configError = result.error;
  }

  get rootDir(): string | null {
    return this.config?.rootDir ?? null;
  }

  get journalPath(): string | null {
    return this.config?.journalPath ?? null;
  }

  get targetNames(): readonly string[] {
    return this.config?.targetNames ?? Object.freeze([]);
  }

  get maxFileBytes(): number | null {
    return this.config?.maxFileBytes ?? null;
  }

  get maxJournalBytes(): number | null {
    return this.config?.maxJournalBytes ?? null;
  }

  get maxTargets(): number | null {
    return this.config?.maxTargets ?? null;
  }

  readText(name: string, options: SnapshotReadOptions = {}): SnapshotReadResult<string> {
    try {
      const target = this.target(name);
      if (!target) return readResult<string>("invalid-target", null, this.configError ?? "target");
      const raw = this.readRaw(target.path, this.readLimit(options));
      if (raw.status !== "ok" || raw.data === null) {
        return this.maybeQuarantineRead(name, readResult<string>(raw.status, null, raw.error), options);
      }
      const value = raw.data.toString("utf8");
      if (!sameBytes(raw.data, Buffer.from(value, "utf8"))) {
        return this.maybeQuarantineRead(name, readResult<string>("corrupt", null, "utf8"), options);
      }
      return readResult("ok", value);
    } catch (error) {
      return readResult<string>("failed", null, safeError(error));
    }
  }

  readJson<T = unknown>(
    name: string,
    validate?: (value: unknown) => value is T,
    options: SnapshotReadOptions = {},
  ): SnapshotReadResult<T> {
    try {
      const text = this.readText(name, options);
      if (text.status !== "ok" || text.value === null) return text as SnapshotReadResult<T>;
      let value: unknown;
      try {
        value = JSON.parse(text.value);
      } catch {
        return this.maybeQuarantineRead(name, readResult<T>("corrupt", null, "json"), options);
      }
      if (validate !== undefined) {
        let valid = false;
        try {
          valid = validate(value);
        } catch {
          valid = false;
        }
        if (!valid) return this.maybeQuarantineRead(name, readResult<T>("corrupt", null, "schema"), options);
      }
      return readResult("ok", value as T);
    } catch (error) {
      return readResult<T>("failed", null, safeError(error));
    }
  }

  quarantineTarget(name: string): SnapshotQuarantineResult {
    try {
      const target = this.target(name);
      if (!target) return { status: "invalid-target", path: null, error: this.configError ?? "target" };
      return this.withWriterQuarantine(() => this.quarantinePath(target.path));
    } catch (error) {
      return { status: "failed", path: null, error: safeError(error) };
    }
  }

  acquireWriter(): SnapshotWriterResult {
    try {
      if (this.closed) return { status: "closed", error: "closed", retryable: false };
      const config = this.config;
      if (!config) return { status: "invalid", error: this.configError ?? "config", retryable: false };
      if (this.ownsWriterLease) return { status: "acquired", error: null, retryable: false };
      const owner = rootWriterLeases.get(config.leaseKey);
      if (owner !== undefined && owner !== this.writerLeaseToken) {
        return { status: "busy", error: "writer-busy", retryable: true };
      }
      rootWriterLeases.set(config.leaseKey, this.writerLeaseToken);
      this.ownsWriterLease = true;
      return { status: "acquired", error: null, retryable: false };
    } catch (error) {
      return { status: "failed", error: safeError(error), retryable: true };
    }
  }

  releaseWriter(): SnapshotWriterResult {
    try {
      if (this.writerOperation) return { status: "failed", error: "writer-busy", retryable: true };
      const config = this.config;
      if (!config) return { status: "invalid", error: this.configError ?? "config", retryable: false };
      if (!this.ownsWriterLease) return { status: "released", error: null, retryable: false };
      if (rootWriterLeases.get(config.leaseKey) !== this.writerLeaseToken) {
        return { status: "failed", error: "writer-owner", retryable: true };
      }
      rootWriterLeases.delete(config.leaseKey);
      this.ownsWriterLease = false;
      return { status: "released", error: null, retryable: false };
    } catch (error) {
      return { status: "failed", error: safeError(error), retryable: true };
    }
  }

  close(): SnapshotWriterResult {
    if (this.writerOperation) return { status: "failed", error: "writer-busy", retryable: true };
    const result = this.releaseWriter();
    if (result.status === "failed") return result;
    this.closed = true;
    return { status: "closed", error: null, retryable: false };
  }

  recover(): SnapshotMutationResult {
    return this.withWriter(() => this.recoverUnlocked());
  }

  commit(snapshots: Readonly<Record<string, SnapshotText>>): SnapshotMutationResult {
    return this.withWriter(() => this.commitUnlocked(snapshots));
  }

  private recoverUnlocked(): SnapshotMutationResult {
    try {
      const config = this.config;
      if (!config) return mutationResult("invalid", { error: this.configError ?? "config", retryable: false });
      const raw = this.readRaw(config.journalPath, config.maxJournalBytes);
      if (raw.status === "missing") {
        return this.pendingRecoveryLoss === null
          ? mutationResult("none", { retryable: false })
          : this.pendingRecoveryLossResult();
      }
      if (raw.status === "failed") {
        return this.withPendingRecoveryLoss(mutationResult("failed", { error: raw.error ?? "journal-read", retryable: true }));
      }
      if (raw.status !== "ok" || raw.data === null) return this.loseJournal(raw.error ?? raw.status);
      const journal = this.decodeJournal(raw.data);
      if (journal === null) return this.loseJournal("journal");
      const result = this.applyJournal(journal, "recovered");
      return this.withPendingRecoveryLoss(result, result.status === "recovered");
    } catch (error) {
      return this.withPendingRecoveryLoss(mutationResult("failed", { error: safeError(error), retryable: true }));
    }
  }

  private commitUnlocked(snapshots: Readonly<Record<string, SnapshotText>>): SnapshotMutationResult {
    try {
      const config = this.config;
      if (!config) return mutationResult("invalid", { error: this.configError ?? "config", retryable: false });
      const recovery = this.recoverUnlocked();
      if (recovery.status === "failed" || recovery.status === "invalid") return recovery;
      const lowerBoundLoss = recovery.lowerBoundLoss;
      const encoded = this.encodeSnapshots(snapshots);
      if (encoded === null) return mutationResult("invalid", { error: "snapshots", lowerBoundLoss, retryable: false });
      const transactionId = this.transactionId();
      const payload = {
        schema: SNAPSHOT_JOURNAL_SCHEMA,
        version: SNAPSHOT_JOURNAL_VERSION,
        transactionId,
        createdAtMs: this.now(),
        targets: encoded,
      };
      const text = JSON.stringify(payload);
      if (utf8Bytes(text) > config.maxJournalBytes) {
        return mutationResult("invalid", { error: "journal-size", lowerBoundLoss, retryable: false });
      }
      const written = this.atomicReplace(config.journalPath, Buffer.from(text, "utf8"), "journal", null);
      if (!written.ok) return this.withPendingRecoveryLoss(mutationResult("failed", { transactionId, lowerBoundLoss, error: written.error, retryable: true }));
      const journal = this.decodeJournal(Buffer.from(text, "utf8"));
      if (journal === null) {
        // This should be unreachable; preserve the journal so a future version can inspect it.
        return this.withPendingRecoveryLoss(mutationResult("failed", { transactionId, lowerBoundLoss, error: "journal-encode", retryable: true }));
      }
      const result = this.applyJournal(journal, "committed");
      const merged = result.lowerBoundLoss === lowerBoundLoss ? result : { ...result, lowerBoundLoss };
      return this.withPendingRecoveryLoss(merged, merged.status === "committed");
    } catch (error) {
      return this.withPendingRecoveryLoss(mutationResult("failed", { error: safeError(error), retryable: true }));
    }
  }

  private target(name: unknown): TargetPath | null {
    const config = this.config;
    if (!config || typeof name !== "string" || !isSafeDirectChildName(name)) return null;
    const alias = canonicalName(name);
    if (alias === canonicalName(config.journalName)) return null;
    const staticTarget = config.targets.get(name);
    if (staticTarget) return staticTarget;
    if (config.targetAliases.has(alias) || config.acceptTarget === null) return null;
    const path = resolve(config.rootDir, name);
    if (!inside(config.rootDir, path)) return null;
    let accepted = false;
    try {
      accepted = config.acceptTarget(name) === true;
    } catch {
      accepted = false;
    }
    if (!accepted) return null;
    return { name, path };
  }

  private readLimit(options: SnapshotReadOptions): number {
    const config = this.config;
    return config ? clamp(options.maxBytes, config.maxFileBytes, config.maxFileBytes) : SNAPSHOT_IO_DEFAULT_MAX_FILE_BYTES;
  }

  private readRaw(path: string, maxBytes: number): RawRead {
    try {
      const safe = this.inspectExistingPath(path, false);
      if (safe.status === "missing") return { status: "missing", data: null, error: null };
      if (safe.status === "corrupt") return { status: "corrupt", data: null, error: safe.error };
      if (safe.status !== "ok") return { status: "failed", data: null, error: safe.error };
      this.config?.hooks.beforeRead?.(path);
      const descriptor = this.openReadNoFollow(path);
      try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
          return { status: "corrupt", data: null, error: "file-type" };
        }
        this.config?.hooks.afterOpenRead?.(path);
        const afterOpen = this.inspectExistingPath(path, false);
        if (afterOpen.status !== "ok") {
          return { status: afterOpen.status === "missing" || afterOpen.status === "corrupt" ? "corrupt" : "failed", data: null, error: afterOpen.error };
        }
        const named = statSync(path);
        if (named.dev !== stat.dev || named.ino !== stat.ino) {
          return { status: "failed", data: null, error: "path-race" };
        }
        if (stat.size > maxBytes) return { status: "oversize", data: null, error: "size" };
        // Read at most max+1 bytes through this descriptor. Chunking avoids preallocating a
        // huge buffer for a tiny file while still detecting a file that grows after fstat.
        const chunks: Buffer[] = [];
        let offset = 0;
        while (offset <= maxBytes) {
          const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - offset));
          const count = readSync(descriptor, chunk, 0, chunk.length, offset);
          if (count === 0) break;
          chunks.push(chunk.subarray(0, count));
          offset += count;
        }
        if (offset > maxBytes) return { status: "oversize", data: null, error: "size" };
        return { status: "ok", data: Buffer.concat(chunks, offset), error: null };
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { status: "missing", data: null, error: null };
      return { status: "failed", data: null, error: safeError(error) };
    }
  }

  private inspectRoot(create: boolean): PathInspection {
    const config = this.config;
    if (!config) return { status: "failed", error: this.configError ?? "config" };
    try {
      const parsed = parse(config.rootDir);
      const tail = relative(parsed.root, config.rootDir);
      const pieces = tail.length === 0 ? [] : tail.split(sep).filter((piece) => piece.length > 0);
      let current = parsed.root;
      if (pieces.length === 0) {
        const stat = lstatSync(config.rootDir);
        if (this.isReparse(stat) || !stat.isDirectory()) return { status: "corrupt", error: "root" };
        return { status: "ok", error: null };
      }
      for (const piece of pieces) {
        current = join(current, piece);
        let stat: ReturnType<typeof lstatSync>;
        try {
          stat = lstatSync(current);
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
          if (!create) return { status: "missing", error: null };
          mkdirSync(current);
          stat = lstatSync(current);
        }
        if (this.isReparse(stat) || !stat.isDirectory()) return { status: "corrupt", error: "root" };
      }
      return { status: "ok", error: null };
    } catch (error) {
      return { status: "failed", error: safeError(error) };
    }
  }

  private inspectExistingPath(path: string, allowFinalReparse: boolean): PathInspection {
    const config = this.config;
    if (!config || (!inside(config.rootDir, path) && path !== config.rootDir)) {
      return { status: "failed", error: "path" };
    }
    const root = this.inspectRoot(false);
    if (root.status !== "ok") return root;
    try {
      const relation = relative(config.rootDir, path);
      if (relation.length === 0) return { status: "ok", error: null };
      const pieces = relation.split(sep).filter((piece) => piece.length > 0);
      let current = config.rootDir;
      for (let index = 0; index < pieces.length; index += 1) {
        const piece = pieces[index]!;
        const final = index === pieces.length - 1;
        current = join(current, piece);
        let stat: ReturnType<typeof lstatSync>;
        try {
          stat = lstatSync(current);
        } catch (error) {
          if (hasCode(error, "ENOENT")) return { status: "missing", error: null };
          throw error;
        }
        if (this.isReparse(stat)) {
          if (final && allowFinalReparse) return { status: "ok", error: null };
          return { status: "corrupt", error: "reparse" };
        }
        if ((!final && !stat.isDirectory()) || (final && !stat.isFile())) {
          return { status: "corrupt", error: "file-type" };
        }
      }
      return { status: "ok", error: null };
    } catch (error) {
      return { status: "failed", error: safeError(error) };
    }
  }

  private ensureSafeParent(path: string, checkLeaf = true): PathInspection {
    const config = this.config;
    if (!config || (!inside(config.rootDir, path) && path !== config.rootDir)) {
      return { status: "failed", error: "path" };
    }
    const root = this.inspectRoot(true);
    if (root.status !== "ok") return root;
    try {
      const parent = dirname(path);
      if (!inside(config.rootDir, parent) && parent !== config.rootDir) return { status: "failed", error: "parent" };
      const relation = relative(config.rootDir, parent);
      const pieces = relation.length === 0 ? [] : relation.split(sep).filter((piece) => piece.length > 0);
      let current = config.rootDir;
      for (const piece of pieces) {
        current = join(current, piece);
        let stat: ReturnType<typeof lstatSync>;
        try {
          stat = lstatSync(current);
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
          mkdirSync(current);
          stat = lstatSync(current);
        }
        if (this.isReparse(stat) || !stat.isDirectory()) return { status: "corrupt", error: "parent" };
      }
      if (checkLeaf) {
        try {
          const stat = lstatSync(path);
          if (this.isReparse(stat) || !stat.isFile()) return { status: "corrupt", error: "target" };
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
        }
      }
      return { status: "ok", error: null };
    } catch (error) {
      return { status: "failed", error: safeError(error) };
    }
  }

  private isReparse(stat: NonNullable<ReturnType<typeof lstatSync>>): boolean {
    const possible = stat as unknown as { isReparsePoint?: () => boolean };
    try {
      return stat.isSymbolicLink() || possible.isReparsePoint?.() === true;
    } catch {
      return true;
    }
  }

  private openReadNoFollow(path: string): number {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    try {
      return openSync(path, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      // O_NOFOLLOW is not available on every Windows filesystem. Re-check every component
      // immediately before the fallback, then fstat/stat-match the opened descriptor below.
      const unsupported = process.platform === "win32" && noFollow !== 0 && (hasCode(error, "EINVAL") || hasCode(error, "ENOTSUP"));
      if (!unsupported) throw error;
      const inspected = this.inspectExistingPath(path, false);
      if (inspected.status !== "ok") throw new Error(inspected.error ?? "path");
      return openSync(path, "r");
    }
  }

  private maybeQuarantineRead<T>(
    name: string,
    result: SnapshotReadResult<T>,
    options: SnapshotReadOptions,
  ): SnapshotReadResult<T> {
    if (!options.quarantineCorrupt || (result.status !== "corrupt" && result.status !== "oversize")) return result;
    const quarantine = this.quarantineTarget(name);
    if (quarantine.status === "quarantined") return { ...result, quarantinedPath: quarantine.path };
    if (quarantine.status === "missing") return result;
    return { ...result, error: quarantine.error ?? result.error };
  }

  private encodeSnapshots(snapshots: Readonly<Record<string, SnapshotText>>): readonly EncodedSnapshot[] | null {
    const config = this.config;
    if (!config || !isRecord(snapshots)) return null;
    const values: EncodedSnapshot[] = [];
    let totalBytes = 0;
    // Bound the eventual JSON/base64 payload before building the journal string.
    // The fixed allowance intentionally exceeds the schema fields and quoted metadata.
    let encodedBytes = 384;
    let count = 0;
    const aliases = new Set<string>([canonicalName(config.journalName)]);
    for (const name of Object.keys(snapshots)) {
      count += 1;
      if (count > config.maxTargets) return null;
      const target = this.target(name);
      const value = snapshots[name];
      const alias = canonicalName(name);
      if (!target || aliases.has(alias)) return null;
      aliases.add(alias);
      if (value === null) {
        const nextEncoded = checkedAdd(encodedBytes, utf8Bytes(name) + 128);
        if (nextEncoded === null || nextEncoded > config.maxJournalBytes) return null;
        encodedBytes = nextEncoded;
        values.push({ name: target.name, operation: "delete", bytes: 0, sha256: null, data: null });
        continue;
      }
      if (typeof value !== "string" && !(value instanceof Uint8Array)) return null;
      const bytes = typeof value === "string" ? utf8Bytes(value) : value.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > config.maxFileBytes) return null;
      const next = checkedAdd(totalBytes, bytes);
      if (next === null || next > config.maxJournalBytes) return null;
      totalBytes = next;
      const base64Bytes = checkedAdd(0, 4 * Math.ceil(bytes / 3));
      const entryEstimate = base64Bytes === null ? null : checkedAdd(base64Bytes, utf8Bytes(name) + 160);
      const nextEncoded = entryEstimate === null ? null : checkedAdd(encodedBytes, entryEstimate);
      if (nextEncoded === null || nextEncoded > config.maxJournalBytes) return null;
      encodedBytes = nextEncoded;
      const data = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
      values.push({ name: target.name, operation: "replace", bytes: data.length, sha256: digest(data), data: data.toString("base64") });
    }
    if (values.length === 0) return null;
    values.sort((left, right) => compareNames(left.name, right.name));
    return values;
  }

  private decodeJournal(data: Buffer): ParsedJournal | null {
    const config = this.config;
    if (!config || data.length > config.maxJournalBytes) return null;
    let value: unknown;
    try {
      const text = data.toString("utf8");
      if (!sameBytes(data, Buffer.from(text, "utf8"))) return null;
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isExactRecord(value, JOURNAL_KEYS) || value.schema !== SNAPSHOT_JOURNAL_SCHEMA || value.version !== SNAPSHOT_JOURNAL_VERSION) return null;
    if (typeof value.transactionId !== "string" || !NONCE_PATTERN.test(value.transactionId)) return null;
    if (typeof value.createdAtMs !== "number" || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0) return null;
    if (!Array.isArray(value.targets) || value.targets.length === 0 || value.targets.length > config.maxTargets) return null;
    const targets: DecodedSnapshot[] = [];
    let totalBytes = 0;
    let previous = "";
    const seen = new Set<string>();
    for (const entry of value.targets) {
      if (!isExactRecord(entry, JOURNAL_TARGET_KEYS)) return null;
      const name = entry.name;
      const alias = typeof name === "string" ? canonicalName(name) : "";
      if (typeof name !== "string" || !this.target(name) || seen.has(alias) || (previous.length > 0 && compareNames(name, previous) <= 0)) return null;
      if (entry.operation === "delete") {
        if (entry.bytes !== 0 || entry.sha256 !== null || entry.data !== null) return null;
        seen.add(alias);
        previous = name;
        targets.push({ name, data: null });
        continue;
      }
      if (entry.operation !== "replace") return null;
      if (typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > config.maxFileBytes) return null;
      if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) return null;
      if (typeof entry.data !== "string" || entry.data.length > Math.ceil((config.maxFileBytes * 4) / 3) + 8) return null;
      let decoded: Buffer;
      try {
        decoded = Buffer.from(entry.data, "base64");
      } catch {
        return null;
      }
      // Node's base64 decoder is permissive, so require the exact canonical encoding too.
      if (decoded.length !== entry.bytes || decoded.toString("base64") !== entry.data || digest(decoded) !== entry.sha256) return null;
      const next = checkedAdd(totalBytes, decoded.length);
      if (next === null || next > config.maxJournalBytes) return null;
      totalBytes = next;
      seen.add(alias);
      previous = name;
      targets.push({ name, data: decoded });
    }
    return { transactionId: value.transactionId, targets };
  }

  private applyJournal(journal: ParsedJournal, status: "committed" | "recovered"): SnapshotMutationResult {
    const config = this.config;
    if (!config) return mutationResult("invalid", { error: this.configError ?? "config", retryable: false });
    for (const snapshot of journal.targets) {
      const target = this.target(snapshot.name);
      if (!target) return mutationResult("failed", { transactionId: journal.transactionId, error: "journal-target", retryable: true });
      const mutation = snapshot.data === null
        ? this.atomicDelete(target.path, target.name)
        : this.atomicReplace(target.path, snapshot.data, "target", target.name);
      if (!mutation.ok) return mutationResult("failed", { transactionId: journal.transactionId, error: mutation.error, retryable: true });
    }
    const removed = this.removeJournal();
    if (!removed.ok) return mutationResult("failed", { transactionId: journal.transactionId, error: removed.error, retryable: true });
    return mutationResult(status, { transactionId: journal.transactionId, retryable: false });
  }

  private loseJournal(error: string): SnapshotMutationResult {
    const config = this.config;
    if (!config) return mutationResult("invalid", { error: this.configError ?? "config", retryable: false });
    const quarantine = this.quarantinePath(config.journalPath);
    if (quarantine.status === "quarantined" || quarantine.status === "missing") {
      this.pendingRecoveryLoss = null;
      return mutationResult("recovery-loss", {
        lowerBoundLoss: true,
        error,
        quarantinedPath: quarantine.path,
        retryable: false,
      });
    }
    if (quarantine.path !== null) return this.rememberRecoveryLoss(quarantine.error ?? error, quarantine.path);
    return this.withPendingRecoveryLoss(mutationResult("failed", { error: quarantine.error ?? error, retryable: true }));
  }

  private rememberRecoveryLoss(error: string, quarantinedPath: string | null): SnapshotMutationResult {
    this.pendingRecoveryLoss = { error, quarantinedPath };
    return this.pendingRecoveryLossResult();
  }

  private pendingRecoveryLossResult(): SnapshotMutationResult {
    const pending = this.pendingRecoveryLoss;
    if (pending === null) return mutationResult("none", { retryable: false });
    return mutationResult("recovery-loss", {
      lowerBoundLoss: true,
      error: pending.error,
      quarantinedPath: pending.quarantinedPath,
      retryable: true,
    });
  }

  private withPendingRecoveryLoss(result: SnapshotMutationResult, clearOnSuccess = false): SnapshotMutationResult {
    const pending = this.pendingRecoveryLoss;
    if (pending === null) return result;
    const withLoss = {
      ...result,
      lowerBoundLoss: true,
      quarantinedPath: result.quarantinedPath ?? pending.quarantinedPath,
    };
    if (clearOnSuccess) this.pendingRecoveryLoss = null;
    return withLoss;
  }

  private withWriter(action: () => SnapshotMutationResult): SnapshotMutationResult {
    if (this.closed) return mutationResult("invalid", { error: "closed", retryable: false });
    if (this.writerOperation) return mutationResult("failed", { error: "writer-busy", retryable: true });
    const temporary = !this.ownsWriterLease;
    if (temporary) {
      const acquired = this.acquireWriter();
      if (acquired.status !== "acquired") {
        return mutationResult(acquired.status === "invalid" || acquired.status === "closed" ? "invalid" : "failed", {
          error: acquired.error,
          retryable: acquired.retryable,
        });
      }
    }
    this.writerOperation = true;
    try {
      return action();
    } catch (error) {
      return mutationResult("failed", { error: safeError(error), retryable: true });
    } finally {
      this.writerOperation = false;
      if (temporary) this.releaseWriter();
    }
  }

  private withWriterQuarantine(action: () => SnapshotQuarantineResult): SnapshotQuarantineResult {
    if (this.closed) return { status: "failed", path: null, error: "closed" };
    if (this.writerOperation) return { status: "failed", path: null, error: "writer-busy" };
    const temporary = !this.ownsWriterLease;
    if (temporary) {
      const acquired = this.acquireWriter();
      if (acquired.status !== "acquired") return { status: "failed", path: null, error: acquired.error ?? "writer-busy" };
    }
    this.writerOperation = true;
    try {
      return action();
    } catch (error) {
      return { status: "failed", path: null, error: safeError(error) };
    } finally {
      this.writerOperation = false;
      if (temporary) this.releaseWriter();
    }
  }

  private atomicDelete(path: string, target: string): { ok: boolean; error: string | null } {
    const config = this.config;
    if (!config || !inside(config.rootDir, path)) return { ok: false, error: "path" };
    try {
      const safeParent = this.ensureSafeParent(path, true);
      if (safeParent.status !== "ok") return { ok: false, error: safeParent.error ?? safeParent.status };
      let present = true;
      try {
        lstatSync(path);
      } catch (error) {
        if (hasCode(error, "ENOENT")) present = false;
        else throw error;
      }
      if (present) {
        this.step("before-delete", "target", path, target, "before");
        try {
          unlinkSync(path);
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
        }
        this.step("after-delete", "target", path, target, "after");
      }
      const synced = this.fsyncDirectory(dirname(path));
      if (!synced.ok) return synced;
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  }

  private atomicReplace(
    path: string,
    data: Buffer,
    phase: "journal" | "target",
    target: string | null,
  ): { ok: boolean; error: string | null } {
    let temp: string | null = null;
    try {
      const config = this.config;
      if (!config || !inside(config.rootDir, path) || data.length > (phase === "journal" ? config.maxJournalBytes : config.maxFileBytes)) {
        return { ok: false, error: "path-or-size" };
      }
      const parent = dirname(path);
      if (!inside(config.rootDir, parent) && parent !== config.rootDir) return { ok: false, error: "parent" };
      const safeParent = this.ensureSafeParent(path);
      if (safeParent.status !== "ok") return { ok: false, error: safeParent.error ?? safeParent.status };
      const nonce = this.nonce();
      temp = join(parent, `tmp-${basename(path)}-${this.now()}-${nonce}`);
      if (!inside(config.rootDir, temp)) return { ok: false, error: "temp" };
      this.step("before-temp-write", phase, path, target, "before");
      writeFileSync(temp, data, { flag: "wx" });
      this.step("after-temp-write", phase, path, target, "after");
      // Windows permits fsync on a writable descriptor but can reject a read-only one.
      const descriptor = openSync(temp, "r+");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      this.step("after-file-fsync", phase, path, target, "after");
      renameSync(temp, path);
      temp = null;
      this.step("after-rename", phase, path, target, "after");
      const synced = this.fsyncDirectory(parent);
      if (!synced.ok) return synced;
      this.step("after-directory-fsync", phase, path, target, "after");
      return { ok: true, error: null };
    } catch (error) {
      if (temp !== null) {
        try {
          unlinkSync(temp);
        } catch {
          // The next write uses a nonce; an orphan temp cannot be a future target.
        }
      }
      return { ok: false, error: safeError(error) };
    }
  }

  private removeJournal(): { ok: boolean; error: string | null } {
    const config = this.config;
    if (!config) return { ok: false, error: this.configError ?? "config" };
    let removed = false;
    try {
      const safeParent = this.ensureSafeParent(config.journalPath);
      if (safeParent.status !== "ok") return { ok: false, error: safeParent.error ?? safeParent.status };
      this.step("before-journal-remove", "journal", config.journalPath, null, "before");
      try {
        unlinkSync(config.journalPath);
        removed = true;
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        removed = true;
      }
      const synced = this.fsyncDirectory(dirname(config.journalPath));
      if (!synced.ok) return synced;
      this.step("after-journal-remove", "journal", config.journalPath, null, "after");
      return { ok: true, error: null };
    } catch (error) {
      // Once unlink has happened, targets and journal have reached a committed state.
      // Do not report a retryable failure that no longer has a journal to retry.
      if (removed) return { ok: true, error: null };
      return { ok: false, error: safeError(error) };
    }
  }

  private quarantinePath(path: string): SnapshotQuarantineResult {
    const config = this.config;
    if (!config || !inside(config.rootDir, path)) return { status: "failed", path: null, error: "path" };
    try {
      // Validate the parent without following the final (possibly malicious) reparse point.
      const safeParent = this.ensureSafeParent(path, false);
      if (safeParent.status === "missing") return { status: "missing", path: null, error: null };
      if (safeParent.status !== "ok") return { status: "failed", path: null, error: safeParent.error ?? safeParent.status };
      try {
        lstatSync(path);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return { status: "missing", path: null, error: null };
        throw error;
      }
      const parent = dirname(path);
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = join(parent, `${basename(path)}.corrupt-${this.now()}-${this.nonce()}`);
        if (!inside(config.rootDir, candidate)) return { status: "failed", path: null, error: "quarantine-path" };
        try {
          lstatSync(candidate);
          continue;
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
        }
        renameSync(path, candidate);
        const synced = this.fsyncDirectory(parent);
        if (!synced.ok) {
          const restored = this.restoreQuarantinePath(candidate, path);
          return { status: "failed", path: restored ? path : candidate, error: synced.error };
        }
        return { status: "quarantined", path: candidate, error: null };
      }
      return { status: "failed", path: null, error: "quarantine-collision" };
    } catch (error) {
      return { status: "failed", path: null, error: safeError(error) };
    }
  }

  private restoreQuarantinePath(candidate: string, path: string): boolean {
    try {
      const safeParent = this.ensureSafeParent(path, false);
      if (safeParent.status !== "ok") return false;
      try {
        lstatSync(path);
        return false;
      } catch (error) {
        if (!hasCode(error, "ENOENT")) return false;
      }
      renameSync(candidate, path);
      return this.fsyncDirectory(dirname(path)).ok;
    } catch {
      return false;
    }
  }

  private fsyncDirectory(path: string): { ok: boolean; error: string | null } {
    try {
      this.config?.hooks.beforeDirectoryFsync?.(path);
      const descriptor = openSync(path, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return { ok: true, error: null };
    } catch (error) {
      // Directory handles are unsupported by some Windows filesystems. Do not hide EIO,
      // EACCES, sharing violations, or any POSIX failure behind that compatibility case.
      const unsupportedWindows = process.platform === "win32" && (
        hasCode(error, "EPERM") || hasCode(error, "EINVAL") || hasCode(error, "ENOTSUP") || hasCode(error, "EISDIR")
      );
      if (unsupportedWindows) return { ok: true, error: null };
      return { ok: false, error: safeError(error) };
    }
  }

  private now(): number {
    try {
      const value = this.config?.hooks.now?.();
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  private nonce(): string {
    try {
      const candidate = this.config?.hooks.nonce?.() ?? randomBytes(16).toString("base64url");
      return typeof candidate === "string" && NONCE_PATTERN.test(candidate) ? candidate : randomBytes(16).toString("base64url");
    } catch {
      return "fallback";
    }
  }

  private transactionId(): string {
    return this.nonce();
  }

  private step(
    step: SnapshotIoStep,
    phase: "journal" | "target",
    path: string,
    target: string | null,
    when: "before" | "after",
  ): void {
    const context: SnapshotIoStepContext = { step, phase, path, target };
    if (when === "before") this.config?.hooks.beforeStep?.(context);
    else this.config?.hooks.afterStep?.(context);
  }
}

/** Construction is total: malformed runtime options turn later calls into explicit invalid results. */
export function createSnapshotJournalIo(options: SnapshotJournalIoOptions): SnapshotJournalIo {
  return new SnapshotJournalIoImpl(options);
}
