import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ownerSidWhoamiArgs,
  parseOwnerSid,
  resetSecretFileAclOwnerSidCache,
  resolveWindowsOwnerSid,
  restrictSecretDirectoryOnWindowsSync,
  restrictSecretFileOnWindows,
  restrictSecretFileOnWindowsSync,
  secretDirectoryIcaclsArgs,
  secretFileIcaclsArgs,
  windowsSystem32Executable,
  type SecretFileAclSpawn,
  type SecretFileAclSpawnSync,
} from "../src/secret-file-acl.js";

const CAPTURED_OPTIONS = {
  windowsHide: true,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
} as const;

describe("Windows secret-file ACL hardening", () => {
  beforeEach(() => resetSecretFileAclOwnerSidCache());

  it("constructs exact file argv with owner SID and retained privileged grants", () => {
    expect(secretFileIcaclsArgs(
      "C:\\Users\\Example User\\.llm-relay\\keystore.json",
      "S-1-5-21-111-222-333-1001",
    )).toEqual([
      "C:\\Users\\Example User\\.llm-relay\\keystore.json",
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-21-111-222-333-1001:F",
      "*S-1-5-18:F",
      "*S-1-5-32-544:F",
    ]);
  });

  it("constructs exact inheritable directory argv", () => {
    expect(secretDirectoryIcaclsArgs(
      "C:\\Users\\Example User\\.llm-relay",
      "S-1-5-21-111-222-333-1001",
    )).toEqual([
      "C:\\Users\\Example User\\.llm-relay",
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-21-111-222-333-1001:(OI)(CI)F",
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ]);
  });

  it("uses absolute System32 executable paths with a safe fallback", () => {
    expect(windowsSystem32Executable("icacls.exe", "D:\\Windows"))
      .toBe("D:\\Windows\\System32\\icacls.exe");
    expect(windowsSystem32Executable("whoami.exe", "relative\\shim"))
      .toBe("C:\\Windows\\System32\\whoami.exe");
  });

  it("builds and parses the exact whoami SID query", () => {
    expect(ownerSidWhoamiArgs()).toEqual(["/user", "/fo", "csv", "/nh"]);
    expect(parseOwnerSid('"WORKSTATION\\Owner","S-1-5-21-111-222-333-1001"\r\n'))
      .toBe("S-1-5-21-111-222-333-1001");
    expect(parseOwnerSid("unexpected output")).toBeNull();
  });

  it("resolves the owner SID through captured whoami and caches it", () => {
    const spawnSync = vi.fn<SecretFileAclSpawnSync>(() => ({
      status: 0,
      stdout: '"WORKSTATION\\Owner","S-1-5-21-111-222-333-1001"\r\n',
    }));
    const opts = { platform: "win32" as const, systemRoot: "D:\\Windows", spawnSync };

    expect(resolveWindowsOwnerSid(opts)).toBe("S-1-5-21-111-222-333-1001");
    expect(resolveWindowsOwnerSid(opts)).toBe("S-1-5-21-111-222-333-1001");
    expect(spawnSync).toHaveBeenCalledOnce();
    expect(spawnSync).toHaveBeenCalledWith(
      "D:\\Windows\\System32\\whoami.exe",
      ["/user", "/fo", "csv", "/nh"],
      CAPTURED_OPTIONS,
    );
  });

  it("is platform-gated and does not spawn outside win32", () => {
    const spawn = vi.fn<SecretFileAclSpawn>();
    const spawnSync = vi.fn<SecretFileAclSpawnSync>();
    restrictSecretFileOnWindows("/tmp/secret", {
      platform: "linux",
      username: "owner",
      spawn,
      spawnSync,
    });
    restrictSecretFileOnWindowsSync("/tmp/secret", {
      platform: "linux",
      username: "owner",
      spawnSync,
    });
    restrictSecretDirectoryOnWindowsSync("/tmp", {
      platform: "linux",
      username: "owner",
      spawnSync,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("fires and forgets absolute icacls using the resolved SID", () => {
    const on = vi.fn();
    const unref = vi.fn();
    const spawn = vi.fn<SecretFileAclSpawn>(() => ({ on, unref }));
    const spawnSync = vi.fn<SecretFileAclSpawnSync>(() => ({
      status: 0,
      stdout: '"WORKSTATION\\Owner","S-1-5-21-111-222-333-1001"\r\n',
    }));

    restrictSecretFileOnWindows("C:\\secret file", {
      platform: "win32",
      username: "fallback owner",
      systemRoot: "D:\\Windows",
      spawn,
      spawnSync,
    });

    expect(spawnSync).toHaveBeenCalledWith(
      "D:\\Windows\\System32\\whoami.exe",
      ["/user", "/fo", "csv", "/nh"],
      CAPTURED_OPTIONS,
    );
    expect(spawn).toHaveBeenCalledWith(
      "D:\\Windows\\System32\\icacls.exe",
      [
        "C:\\secret file",
        "/inheritance:r",
        "/grant:r",
        "*S-1-5-21-111-222-333-1001:F",
        "*S-1-5-18:F",
        "*S-1-5-32-544:F",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    expect(on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(unref).toHaveBeenCalledOnce();
  });

  it("falls back to username when the SID cannot be resolved", () => {
    const on = vi.fn();
    const unref = vi.fn();
    const spawn = vi.fn<SecretFileAclSpawn>(() => ({ on, unref }));
    const spawnSync = vi.fn<SecretFileAclSpawnSync>(() => ({ status: 1, stdout: "no SID" }));

    restrictSecretFileOnWindows("C:\\secret", {
      platform: "win32",
      username: "Domain\\Owner Name",
      spawn,
      spawnSync,
    });

    expect(spawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\icacls.exe",
      [
        "C:\\secret",
        "/inheritance:r",
        "/grant:r",
        "Domain\\Owner Name:F",
        "*S-1-5-18:F",
        "*S-1-5-32-544:F",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
  });

  it("hardens a file synchronously with captured stdio", () => {
    const spawnSync = vi.fn<SecretFileAclSpawnSync>(() => ({ status: 0, stdout: "" }));
    restrictSecretFileOnWindowsSync("C:\\store.tmp", {
      platform: "win32",
      ownerSid: "S-1-5-21-111-222-333-1001",
      systemRoot: "D:\\Windows",
      spawnSync,
    });

    expect(spawnSync).toHaveBeenCalledOnce();
    expect(spawnSync).toHaveBeenCalledWith(
      "D:\\Windows\\System32\\icacls.exe",
      secretFileIcaclsArgs("C:\\store.tmp", "S-1-5-21-111-222-333-1001"),
      CAPTURED_OPTIONS,
    );
  });

  it("hardens a directory synchronously with inheritable grants", () => {
    const spawnSync = vi.fn<SecretFileAclSpawnSync>(() => ({ status: 0, stdout: "" }));
    restrictSecretDirectoryOnWindowsSync("C:\\.llm-relay", {
      platform: "win32",
      ownerSid: "S-1-5-21-111-222-333-1001",
      spawnSync,
    });

    expect(spawnSync).toHaveBeenCalledOnce();
    expect(spawnSync).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\icacls.exe",
      secretDirectoryIcaclsArgs("C:\\.llm-relay", "S-1-5-21-111-222-333-1001"),
      CAPTURED_OPTIONS,
    );
  });

  it("swallows synchronous launch failures in every hardening form", () => {
    const spawnSync: SecretFileAclSpawnSync = () => {
      throw new Error("icacls unavailable with child output");
    };
    expect(() => restrictSecretFileOnWindowsSync("C:\\secret", {
      platform: "win32",
      ownerSid: "S-1-5-21-111-222-333-1001",
      spawnSync,
    })).not.toThrow();
    expect(() => restrictSecretDirectoryOnWindowsSync("C:\\.llm-relay", {
      platform: "win32",
      ownerSid: "S-1-5-21-111-222-333-1001",
      spawnSync,
    })).not.toThrow();
  });

  it("swallows synchronous async-launch failure", () => {
    const spawn: SecretFileAclSpawn = () => {
      throw new Error("icacls unavailable");
    };
    expect(() => restrictSecretFileOnWindows("C:\\secret", {
      platform: "win32",
      ownerSid: "S-1-5-21-111-222-333-1001",
      spawn,
    })).not.toThrow();
  });
});
