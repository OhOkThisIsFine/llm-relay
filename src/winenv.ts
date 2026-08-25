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

function normalizedEnvName(name: string): string {
  return name.toUpperCase();
}

/** Merge registry scopes using Windows' case-insensitive name semantics. Later scopes win. */
function mergeScopes(...scopes: Array<Record<string, string>>): Array<[string, string]> {
  const merged = new Map<string, [string, string]>();
  for (const scope of scopes) {
    for (const [name, value] of Object.entries(scope)) {
      // Store the winning entry, not just its value, so User-scope spelling survives too.
      merged.set(normalizedEnvName(name), [name, value]);
    }
  }
  return [...merged.values()];
}

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
  // ⚠ Under vitest, never spawn `reg` — the same rule and the same shape as
  // `secret-file-acl.ts` and `os-keyring.ts`: skip the real child process unless the seam is
  // injected. This was the LAST unguarded real-world side effect in `src/`, and it cost twice.
  //
  // Latency: `readScope` runs `execFileSync` TWICE with `timeout: 5000` EACH, on the
  // `loadOrExit()` path every CLI test file reaches. vitest's default test budget is also 5000ms,
  // so one contended spawn consumes a whole test. Measured on this machine: ~50-70ms idle,
  // 2806/3041/4045ms while the 108-file suite competed for process creation, and one run at
  // 5265ms — which is exactly the intermittent "passes alone, fails under load" timeout seen in
  // `test/cli.test.ts` and `test/accounting-cli-lifecycle.test.ts`.
  //
  // Hermeticity: it also merged the DEVELOPER'S real User/Machine registry environment into the
  // worker's `process.env`, so a suite run depended on what happened to be set on the machine.
  //
  // `opts.read` still runs, so `test/winenv.test.ts` exercises the whole merge/skip/never-import
  // policy exactly as before; only the literal `reg query` invocation is unreachable from tests,
  // which is the accepted trade the two modules above already make.
  if (process.env.VITEST !== undefined && opts.read === undefined) return result;
  // Machine first, then User — User wins on a conflict, matching how Windows itself composes them.
  const merged = mergeScopes(
    read("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
    read("HKCU\\Environment"),
  );

  for (const [name, value] of merged) {
    const normalizedName = normalizedEnvName(name);
    if (NEVER_IMPORT.has(normalizedName)) continue;
    // The shared presence predicate, so a whitespace-only exported variable counts as ABSENT
    // and does not shadow a real value in the registry. Presence has one definition here.
    const existingNames = Object.keys(env).filter((candidate) => normalizedEnvName(candidate) === normalizedName);
    if (existingNames.some((candidate) => keyIsPresent(env[candidate]))) {
      result.skipped.push(name);
      continue;
    }
    // A plain injected object can hold differently-cased duplicates even though process.env on
    // Windows cannot. Remove blank aliases so the winning registry spelling is observable there.
    for (const existingName of existingNames) {
      if (existingName !== name) delete env[existingName];
    }
    env[name] = value;
    result.loaded.push(name);
  }
  return result;
}
