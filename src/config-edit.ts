import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";

export type ConfigDocument = Record<string, unknown>;

/** Read the user-facing JSON document without normalizing away its configured shape. */
export function readConfigDocument(path: string): ConfigDocument {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`could not read config ${path}: ${(e as Error).message}`, { cause: e });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`config ${path} must contain a JSON object`);
  }
  return value as ConfigDocument;
}

/**
 * Apply an edit only after the existing config loader accepts the complete result.
 *
 * The temporary validation file is kept beside the target so `${ENV}` expansion and relative
 * paths behave just as they do when the proxy starts. Unknown top-level settings are preserved.
 */
export function updateConfigDocument(path: string, edit: (document: ConfigDocument) => void): void {
  const document = readConfigDocument(path);
  edit(document);

  const serialized = JSON.stringify(document, null, 2) + "\n";
  const temporary = join(dirname(path), `.${path.split(/[\\/]/).pop() ?? "config"}.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(temporary, serialized, "utf8");
    loadConfig(temporary);
    // Validation above means a partial edit cannot leave the user with an unloadable file. Keep
    // the final write deliberately simple because rename-over-existing is not portable on Windows.
    writeFileSync(path, serialized, "utf8");
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* best effort cleanup; the validated target is still usable */
    }
  }
}

/** Parse a CLI value as JSON when possible, otherwise keep it as a string. */
export function parseConfigValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

const FORBIDDEN_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * A path segment that addresses one element of an array rather than a key of an object.
 *
 * The spelling is plain decimal digits, and `String(index)` must round-trip, so `01` and `+1`
 * are names rather than indices — a path that reads as an index but is not one is the ambiguity
 * this check exists to refuse, and admitting `"01"` would put an array on the way to carrying a
 * `"01"` key beside its elements.
 */
const ARRAY_INDEX_PART = /^(?:0|[1-9][0-9]*)$/;

function arrayIndexPart(part: string): number | null {
  return ARRAY_INDEX_PART.test(part) ? Number(part) : null;
}

export function parseConfigPath(path: string): string[] {
  const parts = path.split(".");
  if (parts.length === 0 || parts.some((part) => part.length === 0 || FORBIDDEN_PATH_PARTS.has(part))) {
    throw new Error(`config path must be dot-separated names (got "${path}")`);
  }
  return parts;
}

/**
 * Refuse an index the array does not have, naming both the index and the array's actual length.
 *
 * An out-of-range index is never appended: a config edit that grew a ladder by one rung would
 * leave the unknown-field-preserving editor silently inventing a rung whose `id`, `kind` and
 * `command` nobody wrote, and `loadConfig` would then reject the document with a type error that
 * says nothing about the path the operator typed.
 */
function arrayIndexError(part: string, length: number, where: string): Error {
  return new Error(
    `${where}: index ${part} is out of range for an array of length ${length}`,
  );
}

/** "This path addresses nothing here", kept distinct from a document value that IS `null`. */
const MISSING = Symbol("missing");

/**
 * The value a path segment addresses, or MISSING when it is absent or the path cannot continue.
 *
 * A non-numeric segment against an array MISSES rather than throwing. Reading is how the CLI asks
 * whether a path exists (`config get`/`config unset` both treat `undefined` as "no value at"), and
 * a read that fails must stay a miss, not become a diagnosis. The write path re-checks the same
 * segment and REFUSES it, which is where an operator can still act on the answer.
 */
function descend(current: unknown, part: string): unknown {
  if (Array.isArray(current)) {
    const index = arrayIndexPart(part);
    return index === null || index >= current.length ? MISSING : current[index];
  }
  if (typeof current === "object" && current !== null) {
    const record = current as Record<string, unknown>;
    return part in record ? record[part] : MISSING;
  }
  return MISSING;
}

/**
 * Settle the object a path segment must WRITE into, or refuse with a reason.
 *
 * `current` is the container the path has reached. A segment that misses inside an ARRAY is
 * refused and never invented — an index past the end has no length the path states, and a name
 * where an index belongs would hang a non-index key off the array, a shape `JSON.stringify`
 * drops. A segment that misses inside an OBJECT is created, which is how every other dot-path
 * editor here already grows nested config.
 */
function descendForWrite(current: unknown, part: string, path: string): Record<string, unknown> {
  if (Array.isArray(current)) {
    const index = arrayIndexPart(part);
    if (index === null) {
      throw new Error(
        `config path "${path}": "${part}" is not an index (the value at that path is an array of length ${current.length})`,
      );
    }
    if (index >= current.length) throw arrayIndexError(part, current.length, `config path "${path}"`);
    return current[index] as Record<string, unknown>;
  }
  if (typeof current !== "object" || current === null) {
    // Reached a string/number/boolean/null where the path still has segments to walk. Writing
    // here would throw a bare JS TypeError naming a property, not the path the operator typed.
    throw new Error(
      `config path "${path}": cannot write through the non-object value at "${part}"`,
    );
  }
  const record = current as Record<string, unknown>;
  const existing = part in record ? record[part] : MISSING;
  if (existing !== MISSING) {
    // The path names something real; it must still be a container for the walk to continue.
    if (typeof existing !== "object" || existing === null) {
      throw new Error(
        `config path "${path}": cannot write through the non-object value at "${part}"`,
      );
    }
    return existing as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  record[part] = next;
  return next;
}

export function readConfigPath(document: ConfigDocument, path: string): unknown {
  let current: unknown = document;
  for (const part of parseConfigPath(path)) {
    current = descend(current, part);
    if (current === MISSING) return undefined;
  }
  return current;
}

export function writeConfigPath(document: ConfigDocument, path: string, value: unknown): void {
  const parts = parseConfigPath(path);
  let current: Record<string, unknown> = document;
  for (const part of parts.slice(0, -1)) {
    current = descendForWrite(current, part, path);
  }
  const last = parts[parts.length - 1]!;
  if (Array.isArray(current)) {
    const index = arrayIndexPart(last);
    if (index === null) {
      throw new Error(
        `config path "${path}": "${last}" is not an index (the value at that path is an array of length ${current.length})`,
      );
    }
    if (index >= current.length) throw arrayIndexError(last, current.length, `config path "${path}"`);
    current[index] = value;
    return;
  }
  current[last] = value;
}

export function deleteConfigPath(document: ConfigDocument, path: string): boolean {
  const parts = parseConfigPath(path);
  let current: unknown = document;
  for (const part of parts.slice(0, -1)) {
    current = descend(current, part);
    if (current === MISSING) return false;
  }
  const last = parts[parts.length - 1]!;
  if (Array.isArray(current)) {
    const index = arrayIndexPart(last);
    if (index === null || index >= current.length) return false;
    // Splice, never `delete`: `delete arr[i]` leaves a HOLE, so the array keeps its length and
    // the removed element reads as `undefined` — which `loadConfig()` would then reject, or (for
    // an optional position) accept as a spilled hole. Removing an array element means shortening
    // the array. sonarjs/no-array-delete flags exactly this, and it is a real defect here.
    current.splice(index, 1);
    return true;
  }
  if (typeof current !== "object" || current === null) return false;
  const record = current as Record<string, unknown>;
  if (!(last in record)) return false;
  delete record[last];
  return true;
}
