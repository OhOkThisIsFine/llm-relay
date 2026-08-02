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
    throw new Error(`could not read config ${path}: ${(e as Error).message}`);
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

export function parseConfigPath(path: string): string[] {
  const parts = path.split(".");
  if (parts.length === 0 || parts.some((part) => part.length === 0 || FORBIDDEN_PATH_PARTS.has(part))) {
    throw new Error(`config path must be dot-separated names (got "${path}")`);
  }
  return parts;
}

export function readConfigPath(document: ConfigDocument, path: string): unknown {
  let current: unknown = document;
  for (const part of parseConfigPath(path)) {
    if (typeof current !== "object" || current === null || !(part in (current as Record<string, unknown>))) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function writeConfigPath(document: ConfigDocument, path: string, value: unknown): void {
  const parts = parseConfigPath(path);
  let current: Record<string, unknown> = document;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
      current = existing as Record<string, unknown>;
    } else {
      const next: Record<string, unknown> = {};
      current[part] = next;
      current = next;
    }
  }
  current[parts[parts.length - 1]!] = value;
}

export function deleteConfigPath(document: ConfigDocument, path: string): boolean {
  const parts = parseConfigPath(path);
  let current: unknown = document;
  for (const part of parts.slice(0, -1)) {
    if (typeof current !== "object" || current === null) return false;
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== "object" || current === null) return false;
  const record = current as Record<string, unknown>;
  if (!(parts[parts.length - 1]! in record)) return false;
  delete record[parts[parts.length - 1]!];
  return true;
}
