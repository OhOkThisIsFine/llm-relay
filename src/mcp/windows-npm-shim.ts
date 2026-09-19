/**
 * Resolve an npm-generated Windows command shim to the Node entrypoint it names.
 *
 * Why this exists: Node cannot execFile a .cmd shim directly, while sending arbitrary dispatched
 * task text through cmd.exe is a command-injection boundary. Windows PowerShell 5.1 is not an
 * adequate escape hatch either: even when the task arrives as data, its legacy native-argument
 * serializer can mangle quotes/metacharacters before the npm shim reaches node.
 *
 * npm's cmd-shim package also writes a .ps1 companion. That file contains a literal
 * "$basedir/<entrypoint>" reference. We read that METADATA, verify it names a Node script, then
 * invoke this process's node executable directly with the original argv. No shell ever sees the
 * task text.
 */
import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { executableCandidates, executableOnPath } from "../executable-lookup.js";

export type WindowsNpmShimResolution =
  | {
      ok: true;
      command: string;
      args: string[];
      shimPath: string;
      entryPath: string;
    }
  | { ok: false; error: string };

export interface WindowsNpmShimDeps {
  env?: NodeJS.ProcessEnv;
  cwd: string;
  nodeExecutable?: string;
  isFile?: (path: string) => boolean;
  readText?: (path: string) => string;
  onPath?: (command: string, env: NodeJS.ProcessEnv) => string | undefined;
}

function realIsFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.F_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function requestedShimPath(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  isFile: (path: string) => boolean,
  onPath: (command: string, env: NodeJS.ProcessEnv) => string | undefined,
): string | undefined {
  const hasPath = command.includes("\\") || command.includes("/");
  if (hasPath) {
    for (const candidate of executableCandidates(command, env, "win32")) {
      const full = win32.isAbsolute(candidate) ? candidate : win32.resolve(cwd, candidate);
      if (isFile(full)) return full;
    }
    return undefined;
  }

  // Windows searches cwd before PATH. Preserve that rule rather than letting the fallback pick a
  // different same-named global shim after CreateProcess failed against the local one.
  for (const candidate of executableCandidates(command, env, "win32")) {
    const local = win32.resolve(cwd, candidate);
    if (isFile(local)) return local;
  }
  return onPath(command, env);
}

function nodeEntrypoint(path: string, readText: (path: string) => string): boolean {
  const ext = win32.extname(path).toLowerCase();
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") return true;
  try {
    const first = readText(path).split(/\r?\n/, 1)[0] ?? "";
    return /^#!.*(?:\bnode(?:\.exe)?\b)/i.test(first);
  } catch {
    return false;
  }
}

/**
 * Find the Node entrypoint referenced by npm's PowerShell companion shim.
 *
 * This is intentionally a parser for a CLOSED generated form, not a PowerShell evaluator. A shim
 * that does not expose a literal $basedir path is unsupported and fails closed.
 */
export function npmPowerShellEntrypoint(
  shimPath: string,
  text: string,
  isFile: (path: string) => boolean = realIsFile,
  readText: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | undefined {
  const basedir = win32.dirname(shimPath);
  const pattern = /["']\$(?:\{basedir\}|basedir)[\\/]([^"'$\r\n]+)["']/gi;
  for (const match of text.matchAll(pattern)) {
    const relative = match[1];
    if (!relative) continue;
    const candidate = win32.resolve(basedir, relative);
    if (!isFile(candidate)) continue;
    if (nodeEntrypoint(candidate, readText)) return candidate;
  }
  return undefined;
}

/**
 * Resolve one failed Windows command to a shell-free Node invocation.
 *
 * Only npm-style .cmd/.bat shims (or an explicitly named .ps1 companion) are accepted. Unknown
 * batch files fail instead of reintroducing cmd.exe.
 */
export function resolveWindowsNpmShim(
  command: string,
  args: readonly string[],
  deps: WindowsNpmShimDeps,
): WindowsNpmShimResolution {
  const env = deps.env ?? process.env;
  const isFile = deps.isFile ?? realIsFile;
  const readText = deps.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const onPath = deps.onPath ?? ((name, e) => executableOnPath(name, e, "win32"));
  const resolved = requestedShimPath(command, deps.cwd, env, isFile, onPath);
  if (!resolved) return { ok: false, error: `Windows command shim not found: ${command}` };

  const ext = win32.extname(resolved).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat" && ext !== ".ps1") {
    return { ok: false, error: `Windows fallback refuses non-shim executable: ${resolved}` };
  }

  const ps1 = ext === ".ps1" ? resolved : resolved.slice(0, -ext.length) + ".ps1";
  if (!isFile(ps1)) {
    return { ok: false, error: `npm PowerShell companion not found for ${resolved}` };
  }

  let text: string;
  try {
    text = readText(ps1);
  } catch {
    return { ok: false, error: `npm PowerShell companion could not be read: ${ps1}` };
  }
  const entryPath = npmPowerShellEntrypoint(ps1, text, isFile, readText);
  if (!entryPath) {
    return { ok: false, error: `npm PowerShell companion has no supported Node entrypoint: ${ps1}` };
  }

  return {
    ok: true,
    command: deps.nodeExecutable ?? process.execPath,
    args: [entryPath, ...args],
    shimPath: resolved,
    entryPath,
  };
}
