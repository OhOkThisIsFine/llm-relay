import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLockSync, type FileLockOptions } from "./file-lock.js";

/**
 * Options for atomic JSON serialization and file writes.
 */
export interface AtomicJsonWriteOptions {
  readonly space?: number | undefined;
  readonly mode?: number | undefined;
  /** If true, write failures throw instead of failing silently. Defaults to false (best-effort). */
  readonly strict?: boolean | undefined;
}

/**
 * Options for safe JSON reading.
 */
export interface SafeJsonReadOptions<T> {
  readonly validator?: ((data: unknown) => data is T) | undefined;
  readonly fallback?: T | undefined;
}

/**
 * Generate a unique temporary file path adjacent to the destination for atomic renames.
 */
function tempPathFor(targetPath: string): string {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${targetPath}.${process.pid}.${nonce}.tmp`;
}

/**
 * Atomically writes data to a JSON file via an adjacent temp file and atomic rename.
 * Guarantees directory creation and cleans up temporary files on failure.
 */
export function atomicWriteJsonSync(targetPath: string, data: unknown, options: AtomicJsonWriteOptions = {}): boolean {
  const space = options.space ?? 2;
  const targetDir = dirname(targetPath);
  let tmpPath: string | null = null;

  try {
    mkdirSync(targetDir, { recursive: true });
    tmpPath = tempPathFor(targetPath);
    const json = JSON.stringify(data, null, space) + "\n";
    writeFileSync(tmpPath, json, { encoding: "utf8", mode: options.mode });
    renameSync(tmpPath, targetPath);
    tmpPath = null;
    return true;
  } catch (err) {
    if (options.strict) throw err;
    return false;
  } finally {
    if (tmpPath !== null) {
      try {
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
      } catch {
        // Best-effort temp cleanup
      }
    }
  }
}

/**
 * Safely reads and parses a JSON file, guarding against missing files, IO errors,
 * corrupt JSON syntax, and invalid schema shapes.
 */
export function safeReadJsonSync<T = unknown>(targetPath: string, options: SafeJsonReadOptions<T> = {}): T | null {
  const fallback = options.fallback ?? null;
  try {
    if (!existsSync(targetPath)) return fallback;
    const raw = readFileSync(targetPath, "utf8");
    if (!raw || raw.trim().length === 0) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (options.validator) {
      return options.validator(parsed) ? parsed : fallback;
    }
    return parsed as T;
  } catch {
    return fallback;
  }
}



/**
 * Options for a synchronous read/update/write transaction over one JSON file.
 *
 * The lock covers the read as well as the atomic rename. That is the part an atomic writer alone
 * cannot provide: without it, two processes can both read snapshot N and each replace it with a
 * different N+1, losing whichever row the earlier rename introduced.
 */
export interface TransactionalJsonUpdateOptions<T> extends AtomicJsonWriteOptions {
  readonly validator?: ((data: unknown) => data is T) | undefined;
  readonly lock?: FileLockOptions | undefined;
}

/**
 * Serialize one JSON mutation across processes, then commit it with the existing atomic writer.
 *
 * A failed lock/read/write is best-effort by default, matching atomicWriteJsonSync. strict=true
 * makes the failure visible to a caller that wants to decide its own fallback policy.
 */
export function transactionalUpdateJsonSync<T>(
  targetPath: string,
  update: (current: T | null) => T,
  options: TransactionalJsonUpdateOptions<T> = {},
): boolean {
  try {
    return withFileLockSync(
      targetPath,
      () => {
        const current = safeReadJsonSync<T>(targetPath, { validator: options.validator });
        const next = update(current);
        return atomicWriteJsonSync(targetPath, next, {
          space: options.space,
          mode: options.mode,
          strict: true,
        });
      },
      options.lock,
    );
  } catch (err) {
    if (options.strict) throw err;
    return false;
  }
}
