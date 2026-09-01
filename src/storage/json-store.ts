import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WriteBehindTimer } from "../write-behind.js";

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
 * Configuration options for a managed JSON state store.
 */
export interface JsonStoreOptions<T> {
  readonly path: string;
  readonly validator?: ((data: unknown) => data is T) | undefined;
  readonly defaultData: () => T;
  readonly space?: number | undefined;
}

/**
 * High-level managed JSON store combining in-memory state, atomic writes,
 * schema validation, and debounced write-behind persistence.
 */
export class JsonStore<T> {
  readonly #path: string;
  readonly #validator?: ((data: unknown) => data is T) | undefined;
  readonly #defaultData: () => T;
  readonly #writeBehind = new WriteBehindTimer();
  readonly #space: number;
  #data: T | null = null;

  constructor(options: JsonStoreOptions<T>) {
    this.#path = options.path;
    this.#validator = options.validator;
    this.#defaultData = options.defaultData;
    this.#space = options.space ?? 2;
  }

  get path(): string {
    return this.#path;
  }

  /**
   * Load current state from disk or return in-memory cached state.
   */
  read(): T {
    if (this.#data !== null) return this.#data;
    const readOptions: SafeJsonReadOptions<T> = {
      fallback: this.#defaultData(),
      ...(this.#validator ? { validator: this.#validator } : {}),
    };
    const loaded = safeReadJsonSync<T>(this.#path, readOptions);
    this.#data = loaded ?? this.#defaultData();
    return this.#data;
  }

  /**
   * Update in-memory state and immediately write atomically to disk.
   */
  write(data: T): boolean {
    this.#data = data;
    return atomicWriteJsonSync(this.#path, data, { space: this.#space });
  }

  /**
   * Update in-memory state and schedule a debounced atomic write.
   */
  touch(updater: () => T): void {
    this.#data = updater();
    this.#writeBehind.touch(() => {
      if (this.#data !== null) {
        atomicWriteJsonSync(this.#path, this.#data, { space: this.#space });
      }
    });
  }

  /**
   * Clear in-memory cache forcing next read() to reload from disk.
   */
  invalidate(): void {
    this.#data = null;
  }
}
