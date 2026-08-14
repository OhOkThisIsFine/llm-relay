import { describe, expect, it, vi } from "vitest";
import {
  restrictSecretFileOnWindows,
  secretFileIcaclsArgs,
  type SecretFileAclSpawn,
} from "../src/secret-file-acl.js";

describe("Windows secret-file ACL hardening", () => {
  it("constructs the exact icacls argv with full control for the current user", () => {
    expect(secretFileIcaclsArgs("C:\\Users\\Example User\\.llm-relay\\.env", "Example User")).toEqual([
      "C:\\Users\\Example User\\.llm-relay\\.env",
      "/inheritance:r",
      "/grant:r",
      "Example User:F",
    ]);
  });

  it("is platform-gated and does not spawn outside win32", () => {
    const spawn = vi.fn<SecretFileAclSpawn>();

    restrictSecretFileOnWindows("/tmp/secret", { platform: "linux", username: "owner", spawn });

    expect(spawn).not.toHaveBeenCalled();
  });

  it("fires and forgets icacls on win32 with hidden, ignored stdio", () => {
    const on = vi.fn();
    const unref = vi.fn();
    const spawn = vi.fn<SecretFileAclSpawn>(() => ({ on, unref }));

    restrictSecretFileOnWindows("C:\\secret file", { platform: "win32", username: "owner", spawn });

    expect(spawn).toHaveBeenCalledWith(
      "icacls",
      ["C:\\secret file", "/inheritance:r", "/grant:r", "owner:F"],
      { windowsHide: true, stdio: "ignore" },
    );
    expect(on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(unref).toHaveBeenCalledOnce();
  });

  it("swallows synchronous launch failure", () => {
    const spawn: SecretFileAclSpawn = () => {
      throw new Error("icacls unavailable");
    };

    expect(() => restrictSecretFileOnWindows("C:\\secret", {
      platform: "win32",
      username: "owner",
      spawn,
    })).not.toThrow();
  });
});
