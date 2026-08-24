/**
 * Loads `~/.llm-relay/.env` into `process.env` at startup.
 *
 * `llm-relay onboard` has always WRITTEN this file, but nothing ever read it — only
 * `process.env` was consulted. A key saved through the wizard therefore worked for that
 * shell session and was silently gone after a restart, which reads as "the key stopped
 * working" rather than "the key was never persisted anywhere the proxy looks".
 *
 * An already-set variable always wins. The real environment is the more explicit signal
 * (it is what the user's shell, launcher or CI actually exported), and a stale file
 * silently overriding it would be a nastier version of the bug this fixes.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyIsPresent } from "./authEnv.js";

const loadedIntoProcessEnv = new Set<string>();

export interface DotEnvResult {
  /** Path consulted, whether or not it existed. */
  path: string;
  loaded: string[];
  /** Present in the file but already set in the environment — the environment won. */
  skipped: string[];
}

/** Parse `KEY=value` lines. Ignores blanks and `#` comments; strips one layer of quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function defaultEnvPath(): string {
  return join(homedir(), ".llm-relay", ".env");
}

/** Display-only provenance for credential resolution; never a precedence input. */
export function wasEnvNameLoadedFromFile(name: string): boolean {
  return loadedIntoProcessEnv.has(name);
}

/** Merge the env file into `env`, never overwriting a variable that is already set. */
export function loadEnvFile(path: string = defaultEnvPath(), env: NodeJS.ProcessEnv = process.env): DotEnvResult {
  if (env === process.env) loadedIntoProcessEnv.clear();
  const result: DotEnvResult = { path, loaded: [], skipped: [] };
  if (!existsSync(path)) return result;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Unreadable env file must not stop the proxy — it is a convenience, not a requirement.
    return result;
  }
  for (const [k, v] of Object.entries(parseDotEnv(text))) {
    // The shared presence predicate, not a local `.length > 0`: a whitespace-only
    // exported variable is ABSENT, so it must not shadow a real key in the file.
    // Presence has exactly one definition in this codebase.
    if (keyIsPresent(env[k])) {
      result.skipped.push(k);
      continue;
    }
    env[k] = v;
    result.loaded.push(k);
    if (env === process.env) loadedIntoProcessEnv.add(k);
  }
  return result;
}
