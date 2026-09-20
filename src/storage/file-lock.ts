import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
}

interface LockOwner {
  version: 1;
  pid: number;
  instance: string;
  acquiredAt: number;
}

const LOCK_VERSION = 1;
const DEFAULT_RETRY_MS = 10;
const DEFAULT_TIMEOUT_MS = 5_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let lockInstanceCounter = 0;

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
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
    value["instance"].length > 0 &&
    typeof value["acquiredAt"] === "number" &&
    Number.isFinite(value["acquiredAt"])
  );
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    return isLockOwner(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function errorCode(err: unknown): string | undefined {
  return isRecord(err) && typeof err["code"] === "string" ? err["code"] : undefined;
}

/**
 * Reclaim only a lock whose SAME observed owner is still present and whose pid is dead.
 *
 * A pid can be reused, so a reused live pid delays recovery rather than risking theft from a live
 * holder. That is the same safe direction as the MCP job journal's owner check.
 */
function reclaimDeadLock(lockPath: string, observed: LockOwner, isAlive: (pid: number) => boolean): boolean {
  if (isAlive(observed.pid)) return false;
  const current = readOwner(lockPath);
  if (current === null || current.pid !== observed.pid || current.instance !== observed.instance) return false;
  try {
    rmSync(lockPath, { recursive: true });
    return true;
  } catch (err) {
    return errorCode(err) === "ENOENT";
  }
}

/**
 * Run work while holding an adjacent cross-process lock directory.
 *
 * mkdir is the portable exclusive acquisition primitive on both Windows and POSIX. The owner
 * record lets a later process recover a lock left by a process that died inside the critical
 * section. An unreadable/malformed owner is never stolen automatically: uncertainty fails closed
 * instead of risking two writers entering together.
 */
export function withFileLockSync<T>(
  targetPath: string,
  work: () => T,
  options: FileLockOptions = {},
): T {
  const lockPath = `${targetPath}.lock`;
  const ownerPath = join(lockPath, "owner.json");
  const retryMs = Math.max(1, Math.floor(options.retryMs ?? DEFAULT_RETRY_MS));
  const timeoutMs = Math.max(retryMs, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const isAlive = options.isAlive ?? defaultIsAlive;
  const startedAt = Date.now();
  lockInstanceCounter += 1;
  const owner: LockOwner = {
    version: LOCK_VERSION,
    pid: process.pid,
    instance: `${process.pid}-${startedAt.toString(36)}-${lockInstanceCounter.toString(36)}`,
    acquiredAt: startedAt,
  };

  mkdirSync(dirname(targetPath), { recursive: true });

  for (;;) {
    try {
      mkdirSync(lockPath);
      try {
        writeFileSync(ownerPath, JSON.stringify(owner) + "\n", {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (err) {
        rmSync(lockPath, { recursive: true, force: true });
        throw err;
      }
      break;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;

      const observed = readOwner(lockPath);
      if (observed !== null && reclaimDeadLock(lockPath, observed, isAlive)) continue;

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out acquiring file lock for ${targetPath}`);
      }
      sleepSync(retryMs);
    }
  }

  try {
    return work();
  } finally {
    const current = readOwner(lockPath);
    if (current === null || current.pid !== owner.pid || current.instance !== owner.instance) {
      throw new Error(`File lock ownership changed for ${targetPath}`);
    }
    rmSync(lockPath, { recursive: true });
  }
}
