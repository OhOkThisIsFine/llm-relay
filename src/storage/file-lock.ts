import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Cross-process lock options for short synchronous state-file transactions.
 */
export interface FileLockOptions {
  /** How long to sleep between acquisition attempts. Defaults to 10 ms. */
  readonly retryMs?: number | undefined;
  /** Maximum normal contention wait. Defaults to 5 seconds. */
  readonly timeoutMs?: number | undefined;
  /** Process-liveness seam used by tests; defaults to process.kill(pid, 0). */
  readonly isAlive?: ((pid: number) => boolean) | undefined;
  /**
   * Test/instrumentation seam invoked after a rename reports contention and before the stable lock
   * path is inspected. Production callers leave this unset.
   */
  readonly onContention?: (() => void) | undefined;
}

interface LockOwner {
  version: 2;
  pid: number;
  instance: string;
  acquiredAt: number;
}

const LOCK_VERSION = 2;
const DEFAULT_RETRY_MS = 10;
const DEFAULT_TIMEOUT_MS = 5_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const INSTANCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Only ESRCH establishes that the process is absent; uncertainty must not steal a lock.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLockOwner(value: unknown): value is LockOwner {
  return (
    isRecord(value) &&
    value["version"] === LOCK_VERSION &&
    typeof value["pid"] === "number" &&
    Number.isSafeInteger(value["pid"]) &&
    value["pid"] > 0 &&
    typeof value["instance"] === "string" &&
    INSTANCE_PATTERN.test(value["instance"]) &&
    typeof value["acquiredAt"] === "number" &&
    Number.isFinite(value["acquiredAt"])
  );
}

function ownerFilename(instance: string): string {
  return `owner-${instance}.json`;
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const files = readdirSync(lockPath);
    const file = files[0];
    if (files.length !== 1 || file === undefined) return null;
    const parsed: unknown = JSON.parse(readFileSync(join(lockPath, file), "utf8"));
    return isLockOwner(parsed) && file === ownerFilename(parsed.instance) ? parsed : null;
  } catch {
    return null;
  }
}

function errorCode(err: unknown): string | undefined {
  return isRecord(err) && typeof err["code"] === "string" ? err["code"] : undefined;
}

/** Never recursively remove the reusable lock path: a successor may already own it. */
function removeEmptyLock(lockPath: string): boolean {
  try {
    rmdirSync(lockPath);
    return true;
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") return !existsSync(lockPath);
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY") return false;
    throw err;
  }
}

function reclaimDeadLock(lockPath: string, observed: LockOwner, isAlive: (pid: number) => boolean): boolean {
  if (isAlive(observed.pid)) return false;
  const current = readOwner(lockPath);
  if (current === null || current.pid !== observed.pid || current.instance !== observed.instance) return false;
  try {
    // Another reclaimer can replace the directory after readOwner. This generation-specific
    // unlink cannot remove its successor's marker; rmdir can remove only an empty directory.
    unlinkSync(join(lockPath, ownerFilename(observed.instance)));
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw err;
  }
  return removeEmptyLock(lockPath);
}

function acquisitionTimeout(targetPath: string, lockPath: string): Error {
  const legacy = existsSync(join(lockPath, "owner.json"));
  return new Error(`Timed out acquiring file lock for ${targetPath}` + (legacy
    ? "; legacy lock present. Stop all relay/MCP writers, confirm the lock is stale, remove only its .lock directory, then restart with one version."
    : ""));
}

/**
 * Run work while holding an adjacent cross-process lock directory.
 *
 * A fully-populated claim directory is published to the stable lock path by one atomic rename, so
 * the stable path never has an ownerless acquisition window. The owner record lets a later process
 * recover a lock left by a process that died inside the critical section. An unreadable/malformed
 * or legacy owner is never stolen automatically. Empty directories left after retiring a marker
 * are safe to remove; a published live claim is always nonempty.
 */
export function withFileLockSync<T>(
  targetPath: string,
  work: () => T,
  options: FileLockOptions = {},
): T {
  const lockPath = `${targetPath}.lock`;
  const retryMs = Math.max(1, Math.floor(options.retryMs ?? DEFAULT_RETRY_MS));
  const timeoutMs = Math.max(retryMs, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const isAlive = options.isAlive ?? defaultIsAlive;
  const startedAt = Date.now();
  const owner: LockOwner = {
    version: LOCK_VERSION,
    pid: process.pid,
    instance: randomUUID(),
    acquiredAt: startedAt,
  };
  const claimPath = `${lockPath}.${owner.instance}.claim`;
  const claimOwnerPath = join(claimPath, ownerFilename(owner.instance));

  mkdirSync(dirname(targetPath), { recursive: true });

  // Build the complete lock off to the side, then publish it with ONE directory rename. The stable
  // lock path is therefore never visible without a valid owner record: a process killed before the
  // rename leaves only its uniquely-named claim directory, which does not block another writer.
  mkdirSync(claimPath, { mode: 0o700 });
  try {
    writeFileSync(claimOwnerPath, JSON.stringify(owner) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    for (;;) {
      if (Date.now() - startedAt >= timeoutMs) throw acquisitionTimeout(targetPath, lockPath);
      try {
        renameSync(claimPath, lockPath);
        break;
      } catch (err) {
        // POSIX commonly reports ENOTEMPTY and Windows commonly reports EEXIST/EPERM when the
        // destination directory already exists. The holder may release the lock between this
        // failed rename and our inspection below. That is ordinary contention, not a transaction
        // failure: retry instead of propagating the stale rename error.
        options.onContention?.();
        const code = errorCode(err);
        const contentionError =
          code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM" || code === "EACCES";
        if (!existsSync(lockPath)) {
          if (!contentionError) throw err;
          sleepSync(retryMs);
          continue;
        }

        const observed = readOwner(lockPath);
        if (observed !== null && reclaimDeadLock(lockPath, observed, isAlive)) continue;
        // A process can die between retiring its marker and rmdir. Windows may refuse to rename
        // over that empty directory, so finish the safe cleanup rather than leave it wedged.
        if (observed === null && removeEmptyLock(lockPath)) continue;

        sleepSync(retryMs);
      }
    }
  } catch (err) {
    // If the claim was never published, it is private debris and safe to remove. After a successful
    // rename it no longer exists here, so this cannot remove another process's stable lock.
    if (existsSync(claimPath)) rmSync(claimPath, { recursive: true, force: true });
    throw err;
  }

  try {
    return work();
  } finally {
    const current = readOwner(lockPath);
    if (current === null || current.pid !== owner.pid || current.instance !== owner.instance) {
      throw new Error(`File lock ownership changed for ${targetPath}`);
    }
    unlinkSync(join(lockPath, ownerFilename(owner.instance)));
    removeEmptyLock(lockPath);
  }
}
