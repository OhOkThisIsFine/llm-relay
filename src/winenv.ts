/**
 * Recovers Windows User/Machine-scope environment variables that a long-running process missed.
 *
 * THE PROBLEM. On Windows, a User-scope variable (`setx`, or the System Properties dialog) is
 * written to `HKCU\Environment` and broadcast — but a process only builds its environment block
 * when it STARTS. Anything already running never sees the new variable. The relay is launched
 * once from `Startup` at logon and then runs for days, so every key added after that logon is
 * invisible to it, while any shell the user opens afterwards has it.
 *
 * That split is what makes it so hard to diagnose: `llm-relay keys` runs as a NEW process and
 * reports its own environment, so the CLI cheerfully lists a key the serving process does not
 * have. Six providers' keys were sitting in the registry while the relay answered 401 for all of
 * them, and every surface that asked a fresh CLI process said the keys were fine. It reads as
 * "the provider rejected my key" and sends you to rotate a credential that was never wrong.
 *
 * THE FIX. At startup, read the registry scopes directly and fill in ONLY variables that are
 * missing from `process.env`. Same contract as `dotenv.ts`: the real environment always wins,
 * because it is the more explicit signal — this is a backstop for what the OS failed to deliver,
 * never an override of what the launcher deliberately set.
 *
 * Non-Windows platforms are a no-op; there is no equivalent gap, since Unix has no way to change
 * an already-running process's environment either but also no registry pretending otherwise.
 */
import { execFileSync } from "node:child_process";
import { keyIsPresent } from "./authEnv.js";

export interface WinEnvResult {
  /** Applied to `process.env` because nothing was set. Names only — never values. */
  loaded: string[];
  /** Present in the registry but already set in the environment; the environment won. */
  skipped: string[];
  /** True when this platform has nothing to recover (everything but win32). */
  skippedPlatform: boolean;
}

/**
 * Variables never taken from the registry even when missing.
 *
 * `PATH` above all: the User scope holds a FRAGMENT of the effective PATH (the OS concatenates
 * Machine + User at logon), so importing it wholesale replaces a complete PATH with a partial
 * one and breaks executable lookup — `node.exe` stops resolving. The others are per-process or
 * per-session by nature and copying them between contexts is meaningless at best.
 */
const NEVER_IMPORT = new Set(["PATH", "PATHEXT", "TEMP", "TMP", "PROMPT", "PSMODULEPATH", "COMSPEC"]);

/** Parse `reg query` output: lines of `    NAME    REG_SZ    value`. */
export function parseRegQuery(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    // Three or more runs of whitespace separate the columns; a value may itself contain spaces.
    const m = /^\s+(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/.exec(raw);
    if (!m) continue;
    const name = m[1]!;
    const value = m[2]!.trim();
    if (!value) continue;
    out[name] = value;
  }
  return out;
}

/** Read one registry environment scope. Returns {} on any failure — this is a backstop. */
function readScope(key: string): Record<string, string> {
  try {
    const stdout = execFileSync("reg", ["query", key], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseRegQuery(stdout);
  } catch {
    return {};
  }
}

/**
 * Fill `env` with User/Machine-scope variables it is missing. Never overwrites.
 *
 * `platform` and `read` are injectable so the behaviour is testable without a Windows registry.
 */
export function recoverWindowsEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { platform?: string; read?: (key: string) => Record<string, string> } = {},
): WinEnvResult {
  const platform = opts.platform ?? process.platform;
  const result: WinEnvResult = { loaded: [], skipped: [], skippedPlatform: false };
  if (platform !== "win32") {
    result.skippedPlatform = true;
    return result;
  }

  const read = opts.read ?? readScope;
  // Machine first, then User — User wins on a conflict, matching how Windows itself composes them.
  const merged = { ...read("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"), ...read("HKCU\\Environment") };

  for (const [name, value] of Object.entries(merged)) {
    if (NEVER_IMPORT.has(name.toUpperCase())) continue;
    // The shared presence predicate, so a whitespace-only exported variable counts as ABSENT
    // and does not shadow a real value in the registry. Presence has one definition here.
    if (keyIsPresent(env[name])) {
      result.skipped.push(name);
      continue;
    }
    env[name] = value;
    result.loaded.push(name);
  }
  return result;
}
