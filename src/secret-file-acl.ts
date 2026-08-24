import { spawn, spawnSync } from "node:child_process";
import { win32 } from "node:path";

interface FireAndForgetChild {
  on(event: "error", listener: (error: Error) => void): unknown;
  unref(): unknown;
}

export interface SecretFileAclSpawnSyncResult {
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: unknown;
}

export interface SecretFileAclSpawnSyncOptions {
  windowsHide: true;
  encoding: "utf8";
  stdio: ["ignore", "pipe", "pipe"];
}

export type SecretFileAclSpawn = (
  command: string,
  args: string[],
  options: { windowsHide: true; stdio: "ignore" },
) => FireAndForgetChild;

export type SecretFileAclSpawnSync = (
  command: string,
  args: string[],
  options: SecretFileAclSpawnSyncOptions,
) => SecretFileAclSpawnSyncResult;

export interface SecretFileAclOptions {
  platform?: NodeJS.Platform | undefined;
  username?: string | undefined;
  systemRoot?: string | undefined;
  /** A raw owner SID. `null` deliberately skips resolution and uses the username fallback. */
  ownerSid?: string | null | undefined;
  spawn?: SecretFileAclSpawn | undefined;
  spawnSync?: SecretFileAclSpawnSync | undefined;
}

const WINDOWS_ROOT_FALLBACK = "C:\\Windows";
const ICACLS_EXE = "icacls.exe";
const WHOAMI_EXE = "whoami.exe";
const SYSTEM_PRINCIPAL = "*S-1-5-18";
const ADMINISTRATORS_PRINCIPAL = "*S-1-5-32-544";
const SID_PATTERN = /^S-\d+(?:-\d+)+$/iu;

const spawnAcl: SecretFileAclSpawn = (command, args, options) =>
  spawn(command, args, options);

const spawnAclSync: SecretFileAclSpawnSync = (command, args, options) =>
  spawnSync(command, args, options);

let ownerSidCache = new WeakMap<SecretFileAclSpawnSync, Map<string, string | null>>();

/** Return an absolute path to a trusted Windows System32 executable. */
export function windowsSystem32Executable(
  executable: string,
  systemRoot: string | undefined = process.env.SystemRoot,
): string {
  const candidate = systemRoot?.trim();
  const root = candidate && win32.isAbsolute(candidate) ? candidate : WINDOWS_ROOT_FALLBACK;
  return win32.join(root, "System32", executable);
}

/** Pure argv builder for the SID lookup. */
export function ownerSidWhoamiArgs(): string[] {
  return ["/user", "/fo", "csv", "/nh"];
}

/** Parse only the numeric SID cell from `whoami /user /fo csv /nh`. */
export function parseOwnerSid(stdout: string): string | null {
  let sid: string | null = null;
  for (const match of stdout.matchAll(/"(S-\d+(?:-\d+)+)"/giu)) {
    sid = match[1] ?? sid;
  }
  return sid;
}

function icaclsPrincipal(owner: string): string {
  const trimmed = owner.trim();
  if (trimmed.startsWith("*") && SID_PATTERN.test(trimmed.slice(1))) return trimmed;
  return SID_PATTERN.test(trimmed) ? `*${trimmed}` : trimmed;
}

/**
 * `icacls name /grant:r Sid:perm` accepts simple rights without parentheses; `F` is
 * full access. Numeric SIDs carry the required `*` prefix. SYSTEM and Administrators
 * remain explicit because removing inherited ACEs must not lock out backup/admin agents.
 */
export function secretFileIcaclsArgs(path: string, owner: string): string[] {
  const principal = icaclsPrincipal(owner);
  return [
    path,
    "/inheritance:r",
    "/grant:r",
    `${principal}:F`,
    `${SYSTEM_PRINCIPAL}:F`,
    `${ADMINISTRATORS_PRINCIPAL}:F`,
  ];
}

/** Pure argv builder for a directory whose children must inherit the restricted ACL. */
export function secretDirectoryIcaclsArgs(path: string, owner: string): string[] {
  const principal = icaclsPrincipal(owner);
  return [
    path,
    "/inheritance:r",
    "/grant:r",
    `${principal}:(OI)(CI)F`,
    `${SYSTEM_PRINCIPAL}:(OI)(CI)F`,
    `${ADMINISTRATORS_PRINCIPAL}:(OI)(CI)F`,
  ];
}

function capturedSpawnOptions(): SecretFileAclSpawnSyncOptions {
  return {
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
}

/** Clear the process-local SID cache. Exported solely for deterministic injected tests. */
export function resetSecretFileAclOwnerSidCache(): void {
  ownerSidCache = new WeakMap();
}

/**
 * Resolve the current Windows owner by SID. Resolution is best effort and cached for the
 * process. Child output is captured and is never logged or attached to a thrown error.
 */
export function resolveWindowsOwnerSid(
  opts: Pick<SecretFileAclOptions, "platform" | "systemRoot" | "spawnSync"> = {},
): string | null {
  if ((opts.platform ?? process.platform) !== "win32") return null;

  // Applying real host ACL tooling from a sandboxed Vitest process can lock the runner out
  // of its own fixtures. An injected spawner keeps the branch fully unit-testable.
  if (process.env.VITEST !== undefined && opts.spawnSync === undefined) return null;

  const spawner = opts.spawnSync ?? spawnAclSync;
  const command = windowsSystem32Executable(WHOAMI_EXE, opts.systemRoot);
  let commandCache = ownerSidCache.get(spawner);
  if (commandCache?.has(command)) return commandCache.get(command) ?? null;

  let sid: string | null = null;
  try {
    const result = spawner(command, ownerSidWhoamiArgs(), capturedSpawnOptions());
    if (result.error === undefined && (result.status === undefined || result.status === 0)) {
      const stdout = typeof result.stdout === "string"
        ? result.stdout
        : result.stdout?.toString("utf8") ?? "";
      sid = parseOwnerSid(stdout);
    }
  } catch {
    // SID lookup is hardening support, never a reason make the secret unusable.
  }

  commandCache ??= new Map();
  commandCache.set(command, sid);
  ownerSidCache.set(spawner, commandCache);
  return sid;
}

function ownerPrincipal(opts: SecretFileAclOptions): string | null {
  const explicitSid = opts.ownerSid;
  const sid = explicitSid === undefined
    ? resolveWindowsOwnerSid({
        platform: opts.platform,
        systemRoot: opts.systemRoot,
        spawnSync: opts.spawnSync,
      })
    : explicitSid !== null && SID_PATTERN.test(explicitSid)
      ? explicitSid
      : null;
  if (sid) return sid;

  const username = (opts.username ?? process.env.USERNAME)?.trim();
  return username || null;
}

/**
 * Restrict a secret file to its owner while retaining SYSTEM and Administrators. This keeps
 * the established fire-and-forget contract used by onboarding and control authorization.
 */
export function restrictSecretFileOnWindows(
  path: string,
  opts: SecretFileAclOptions = {},
): void {
  if ((opts.platform ?? process.platform) !== "win32") return;
  if (process.env.VITEST !== undefined && opts.spawn === undefined) return;

  const owner = ownerPrincipal(opts);
  if (!owner) return;

  try {
    const child = (opts.spawn ?? spawnAcl)(
      windowsSystem32Executable(ICACLS_EXE, opts.systemRoot),
      secretFileIcaclsArgs(path, owner),
      { windowsHide: true, stdio: "ignore" },
    );
    // A missing/broken icacls is hardening failure, never a reason make the secret unusable.
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Synchronous spawn failures have the same best-effort posture.
  }
}

function restrictSecretPathOnWindowsSync(
  path: string,
  directory: boolean,
  opts: SecretFileAclOptions,
): void {
  if ((opts.platform ?? process.platform) !== "win32") return;
  if (process.env.VITEST !== undefined && opts.spawnSync === undefined) return;

  const owner = ownerPrincipal(opts);
  if (!owner) return;

  try {
    (opts.spawnSync ?? spawnAclSync)(
      windowsSystem32Executable(ICACLS_EXE, opts.systemRoot),
      directory
        ? secretDirectoryIcaclsArgs(path, owner)
        : secretFileIcaclsArgs(path, owner),
      capturedSpawnOptions(),
    );
  } catch {
    // Create-time ACL hardening remains best effort and never exposes child error details.
  }
}

/** Synchronous create-time file hardening for tmp-before-publish write sequences. */
export function restrictSecretFileOnWindowsSync(
  path: string,
  opts: SecretFileAclOptions = {},
): void {
  restrictSecretPathOnWindowsSync(path, false, opts);
}

/** Synchronous directory hardening with inheritable owner/SYSTEM/Administrators grants. */
export function restrictSecretDirectoryOnWindowsSync(
  path: string,
  opts: SecretFileAclOptions = {},
): void {
  restrictSecretPathOnWindowsSync(path, true, opts);
}
