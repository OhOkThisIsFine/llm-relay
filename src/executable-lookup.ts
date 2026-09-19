import { accessSync, statSync, constants as fsConstants } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Finding an executable on PATH — the ONE definition.
 *
 * This started life inside `os-keyring.ts`, scoped to picking the Linux `secret-tool` backend, and
 * moved here when `installed-hosts.ts` needed the same question answered about agent CLIs. Two
 * copies of a PATH walk is exactly the "no second implementation of anything" the project forbids,
 * and the two would have drifted immediately: the keyring's copy has no PATHEXT handling, which is
 * correct for Linux and **silently always false on Windows** for anything not named with its
 * extension.
 *
 * ⚠ It never spawns. A `which`/`where` subprocess would be a process start per lookup on a path
 * that runs at startup, and — more importantly — the spawn guards this repo carries elsewhere
 * (`winenv.ts`, `os-keyring.ts`, `secret-file-acl.ts`) exist precisely so a test run cannot reach
 * the real machine. A pure `accessSync` walk needs no such guard.
 */

/**
 * What Windows appends to a bare command name when PATHEXT is unset. Deliberately the documented
 * default rather than a guess: without it, `codex` never resolves to the `codex.cmd` shim npm
 * writes for a global install, and detection reports "not installed" for a tool that is.
 */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * ⚠ An EMPTY or whitespace-only `PATHEXT` falls back to the default, and that is a fix, not a
 * convenience. `env.PATHEXT ?? DEFAULT` alone treats `""` as a deliberate setting, because an
 * empty string is not nullish — the candidate list then collapses to the bare name and **every**
 * Windows executable becomes undetectable. It is the same blank-value trap the OpenCode installer
 * target hit with the XDG config-home variable: one that is set-but-meaningless must be read as
 * unset, never as an instruction.
 *
 * (That variable is described rather than named because `test/state-paths.test.ts` greps all of
 * `src/` for the literal token, to keep `state-paths.ts` the one owner of XDG resolution. This
 * module resolves no state path at all; the guard simply matches prose, so the prose gives way.)
 */
function pathExtOf(env: NodeJS.ProcessEnv): string {
  const raw = env.PATHEXT;
  return raw !== undefined && raw.trim() !== "" ? raw : DEFAULT_PATHEXT;
}

/**
 * The names to try for one command on this platform.
 *
 * ⚠ A command that ALREADY carries a known extension (`agy.exe`) is a complete name — appending
 * PATHEXT to it would look for `agy.exe.EXE` and find nothing. The membership test is
 * case-insensitive because Windows paths are.
 */
export function executableCandidates(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32") return [command];

  const extensions = pathExtOf(env)
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  const lower = command.toLowerCase();
  if (extensions.some((e) => lower.endsWith(e.toLowerCase()))) return [command];

  return [command, ...extensions.map((e) => `${command}${e}`)];
}

/**
 * Is `command` runnable from PATH?
 *
 * ⚠ **The `platform` argument governs the WHOLE lookup, not just the extension list.** PATH is
 * split and joined through `path.win32` or `path.posix` chosen by that argument, never through the
 * unqualified `node:path` bindings — those follow the REAL host, so a caller simulating win32 on a
 * POSIX host would split a `C:\a;C:\b` PATH on `:` and shred it into garbage segments while the
 * candidate list was correctly virtualized. Half-virtualized is worse than not virtualized: the
 * two halves disagree about which OS they are pretending to be, and the function returns a
 * confident wrong boolean. This is the Windows-versus-Linux-CI divergence class `CLAUDE.md`
 * repeatedly flags.
 *
 * ⚠ **A match must be a FILE.** `X_OK` has no effect on Windows — Node degrades it to `F_OK` — so
 * an `accessSync` check alone reports a *directory* named `codex` on PATH as an executable. The
 * `isFile()` test is what makes the Windows answer mean the same thing as the POSIX one.
 *
 * ⚠ Absence is the branch signal, not an exceptional condition — a missing entry is the normal
 * case and must never throw.
 */
export function executableOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const path = env.PATH;
  if (!path) return undefined;

  const p = platform === "win32" ? win32 : posix;
  const candidates = executableCandidates(command, env, platform);

  for (const directory of path.split(p.delimiter)) {
    if (!directory) continue;
    for (const candidate of candidates) {
      const full = p.join(directory, candidate);
      try {
        accessSync(full, fsConstants.X_OK);
        if (statSync(full).isFile()) return full;
      } catch {
        // Keep searching. Absence is the branch signal, not an exceptional condition.
      }
    }
  }
  return undefined;
}

/** Is `command` runnable from PATH? Boolean compatibility surface over the one resolving walk. */
export function commandExistsOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return executableOnPath(command, env, platform) !== undefined;
}
