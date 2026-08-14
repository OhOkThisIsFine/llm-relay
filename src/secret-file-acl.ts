import { spawn } from "node:child_process";

interface FireAndForgetChild {
  on(event: "error", listener: (error: Error) => void): unknown;
  unref(): unknown;
}

export type SecretFileAclSpawn = (
  command: string,
  args: string[],
  options: { windowsHide: true; stdio: "ignore" },
) => FireAndForgetChild;

const spawnAcl: SecretFileAclSpawn = (command, args, options) => spawn(command, args, options);

/**
 * `icacls name /grant:r Sid:perm` accepts simple rights without parentheses; `F` is full access.
 * Passing an argv array means paths and user names containing spaces stay single arguments.
 */
export function secretFileIcaclsArgs(path: string, username: string): string[] {
  return [path, "/inheritance:r", "/grant:r", `${username}:F`];
}

/**
 * Restrict a secret file to the current Windows user without making hardening an availability
 * dependency. Removing inherited ACEs drops the ordinary inherited grants; `/grant:r` establishes
 * one explicit full-control grant for the current user. icacls is a Windows system tool and is
 * intentionally invoked by its plain name.
 */
export function restrictSecretFileOnWindows(
  path: string,
  opts: {
    platform?: NodeJS.Platform;
    username?: string | undefined;
    spawn?: SecretFileAclSpawn;
  } = {},
): void {
  if ((opts.platform ?? process.platform) !== "win32") return;
  // Vitest may run under a sandbox principal that intentionally differs from %USERNAME%; applying
  // the real ACL would correctly lock that runner out of its own fixture. The injected spawner
  // keeps the Win32 branch fully unit-testable without mutating host ACLs.
  if (process.env.VITEST !== undefined && opts.spawn === undefined) return;
  const username = opts.username ?? process.env.USERNAME;
  if (!username?.trim()) return;

  try {
    const child = (opts.spawn ?? spawnAcl)(
      "icacls",
      secretFileIcaclsArgs(path, username),
      { windowsHide: true, stdio: "ignore" },
    );
    // A missing/broken icacls is a hardening failure, never a reason to make the secret unusable.
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Synchronous spawn failures have the same best-effort posture.
  }
}
