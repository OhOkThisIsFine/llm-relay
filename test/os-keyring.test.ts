import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  createKek,
  createPassphraseKek,
  dpapiUnwrapArgv,
  dpapiWrapArgv,
  KeyringPassphraseRequiredError,
  KeyringUnavailableError,
  keychainLoadArgv,
  keychainStoreArgv,
  libsecretLoadArgv,
  libsecretStoreArgv,
  sameKek,
  unwrapKek,
  windowsPowerShellPath,
  wrapKek,
  type KeyringSpawnSync,
} from "../src/os-keyring.js";

const KEK = Buffer.from("0123456789abcdef0123456789abcdef", "ascii");
const WRAPPED = Buffer.from("dpapi-wrapped-test-value", "ascii");

const WRAP_SCRIPT = [
  "Add-Type -AssemblyName System.Security;",
  "$stdin=[Console]::OpenStandardInput();",
  "$memory=New-Object System.IO.MemoryStream;",
  "$stdin.CopyTo($memory);",
  "$plain=$memory.ToArray();",
  "$wrapped=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
  "$stdout=[Console]::OpenStandardOutput();",
  "$stdout.Write($wrapped,0,$wrapped.Length);",
  "$stdout.Flush();",
].join("");

const UNWRAP_SCRIPT = [
  "Add-Type -AssemblyName System.Security;",
  "$stdin=[Console]::OpenStandardInput();",
  "$memory=New-Object System.IO.MemoryStream;",
  "$stdin.CopyTo($memory);",
  "$wrapped=$memory.ToArray();",
  "$plain=[Security.Cryptography.ProtectedData]::Unprotect($wrapped,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
  "$stdout=[Console]::OpenStandardOutput();",
  "$stdout.Write($plain,0,$plain.Length);",
  "$stdout.Flush();",
].join("");

function leaks(text: string, ...needles: string[]): boolean {
  for (const needle of needles) {
    for (let index = 0; index + 4 <= needle.length; index += 1) {
      if (text.includes(needle.slice(index, index + 4))) return true;
    }
  }
  return false;
}

describe("OS keyring argv discipline", () => {
  it("keeps KEK bytes out of every argv builder", () => {
    const builders = [
      dpapiWrapArgv,
      dpapiUnwrapArgv,
      keychainStoreArgv,
      keychainLoadArgv,
      libsecretStoreArgv,
      libsecretLoadArgv,
    ];

    for (const build of builders) {
      const argvBytes = Buffer.from(build().join("\0"), "utf8");
      expect(argvBytes.includes(KEK)).toBe(false);
      expect(argvBytes.toString("utf8")).not.toContain(KEK.toString("base64"));
      expect(argvBytes.toString("utf8")).not.toContain(KEK.toString("hex"));
    }
  });

  it("pins the macOS and libsecret argv forms", () => {
    expect(keychainStoreArgv()).toEqual(["-i"]);
    expect(keychainLoadArgv()).toEqual([
      "find-generic-password",
      "-a",
      "llm-relay",
      "-s",
      "llm-relay-keystore-kek",
      "-w",
    ]);
    expect(libsecretStoreArgv()).toEqual([
      "store",
      "--label=llm-relay KEK",
      "application",
      "llm-relay",
      "purpose",
      "keystore-kek",
    ]);
    expect(libsecretLoadArgv()).toEqual([
      "lookup",
      "application",
      "llm-relay",
      "purpose",
      "keystore-kek",
    ]);
    expect(keychainLoadArgv("keystore-a1b2")).toContain("keystore-a1b2");
    expect(libsecretStoreArgv("keystore-a1b2")).toContain("keystore-kek:keystore-a1b2");
    expect(libsecretLoadArgv("keystore-a1b2")).toContain("keystore-kek:keystore-a1b2");
  });
});

describe("DPAPI custody", () => {
  it("uses absolute Windows PowerShell 5.1 and transports the KEK through stdin only", () => {
    const spawn = vi.fn<KeyringSpawnSync>()
      .mockReturnValueOnce({ status: 0, stdout: WRAPPED, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: KEK, stderr: Buffer.alloc(0) });
    const env = { SystemRoot: "D:\\Win Root" };

    const descriptor = wrapKek(KEK, { mode: "dpapi", env, spawnSync: spawn });
    const recovered = unwrapKek(descriptor, { env, spawnSync: spawn });

    expect(descriptor).toEqual({ wrap: "dpapi", blob: WRAPPED.toString("base64") });
    expect(recovered).toEqual(KEK);
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      "D:\\Win Root\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WRAP_SCRIPT],
      { windowsHide: true, stdio: "pipe", encoding: "buffer", input: KEK },
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "D:\\Win Root\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", UNWRAP_SCRIPT],
      { windowsHide: true, stdio: "pipe", encoding: "buffer", input: WRAPPED },
    );
    for (const call of spawn.mock.calls) {
      expect(call[1].join("\0")).not.toContain(KEK.toString("ascii"));
    }
  });

  it("falls back to C:\\Windows when SystemRoot is absent", () => {
    expect(windowsPowerShellPath({})).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(windowsPowerShellPath({ SystemRoot: "relative\\shim" })).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("sanitizes a thrown child error without retaining argv or child output", () => {
    const argvLeak = "--child-argv-secret";
    const stdoutLeak = "stdout-super-secret";
    const stderrLeak = "stderr-ultra-secret";
    const spawn: KeyringSpawnSync = () => {
      const childError = new Error(`failed ${argvLeak}`) as Error & Record<string, unknown>;
      childError.stdout = stdoutLeak;
      childError.stderr = stderrLeak;
      childError.output = [stdoutLeak, stderrLeak];
      childError.cmd = argvLeak;
      childError.argv = [argvLeak];
      throw childError;
    };

    let caught: unknown;
    try {
      wrapKek(KEK, { mode: "dpapi", env: { SystemRoot: "C:\\Windows" }, spawnSync: spawn });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const serialized = `${(caught as Error).message}\n${inspect(caught)}`;
    expect(serialized).toContain("keyring wrap failed: launch");
    expect(leaks(serialized, argvLeak, stdoutLeak, stderrLeak)).toBe(false);
  });

  it("sanitizes child result errors and stderr on nonzero exit", () => {
    const childOutput = "Q7vZP2mN4kL8xC6b";
    const firstStdout = "R8wYP3nM5jK9zD7c";
    const secondStdout = "T9xAQ4oN6iL0yE8d";
    const spawn = vi.fn<KeyringSpawnSync>()
      .mockReturnValueOnce({
        status: null,
        stdout: Buffer.from(firstStdout),
        stderr: Buffer.from(childOutput),
        error: new Error(`spawn failed: ${childOutput}`),
      })
      .mockReturnValueOnce({
        status: 7,
        stdout: Buffer.from(secondStdout),
        stderr: Buffer.from(childOutput),
      });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let caught: unknown;
      try {
        wrapKek(KEK, { mode: "dpapi", spawnSync: spawn });
      } catch (error) {
        caught = error;
      }
      const serialized = `${(caught as Error).message}\n${inspect(caught)}`;
      expect(leaks(serialized, childOutput, firstStdout, secondStdout)).toBe(false);
    }
  });
});

describe("portable and Unix custody modes", () => {
  it("round-trips passphrase mode through real node:crypto", () => {
    const passphrase = Buffer.from("correct horse battery staple", "utf8");
    const originalPassphrase = Buffer.from(passphrase);
    const created = createPassphraseKek(passphrase, {
      randomBytes: (size) => Buffer.alloc(size, 0x5a),
    });

    expect(created.descriptor).toEqual({
      wrap: "passphrase",
      kdf: {
        n: 16384,
        r: 8,
        p: 1,
        salt: Buffer.alloc(32, 0x5a).toString("base64"),
      },
    });
    const recovered = unwrapKek(created.descriptor, { passphrase });
    expect(sameKek(recovered, created.kek)).toBe(true);
    expect(passphrase).toEqual(originalPassphrase);

    recovered.fill(0);
    created.kek.fill(0);
  });

  it("auto-selects passphrase on Linux without secret-tool", () => {
    const created = createKek({
      platform: "linux",
      passphrase: "portable passphrase",
      commandExists: () => false,
      randomBytes: (size) => Buffer.alloc(size, 0x31),
    });

    expect(created.descriptor.wrap).toBe("passphrase");
    created.kek.fill(0);
  });

  it("refuses Linux store creation when neither keyring nor passphrase is available", () => {
    expect(() => createKek({
      platform: "linux",
      commandExists: () => false,
    })).toThrow(KeyringUnavailableError);
  });

  it("requires a passphrase when opening a passphrase descriptor", () => {
    const created = createPassphraseKek("temporary", {
      randomBytes: (size) => Buffer.alloc(size, 0x72),
    });
    expect(() => unwrapKek(created.descriptor)).toThrow(KeyringPassphraseRequiredError);
    created.kek.fill(0);
  });

  it.each([
    {
      mode: "keychain" as const,
      command: "security",
      storeArgv: keychainStoreArgv(),
      loadArgv: keychainLoadArgv(),
    },
    {
      mode: "libsecret" as const,
      command: "secret-tool",
      storeArgv: libsecretStoreArgv(),
      loadArgv: libsecretLoadArgv(),
    },
  ])("round-trips $mode through an injected captured-stdio spawn", ({
    mode,
    command,
    storeArgv,
    loadArgv,
  }) => {
    const capturedInputs: Buffer[] = [];
    let call = 0;
    const spawn = vi.fn<KeyringSpawnSync>((_command, _args, options) => {
      call += 1;
      if (options.input !== undefined) capturedInputs.push(Buffer.from(options.input));
      return call === 1
        ? { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
        : {
          status: 0,
          stdout: Buffer.from(`${KEK.toString("base64")}\n`, "ascii"),
          stderr: Buffer.alloc(0),
        };
    });

    const descriptor = wrapKek(KEK, { mode, spawnSync: spawn });
    expect(unwrapKek(descriptor, { spawnSync: spawn })).toEqual(KEK);
    const expectedStoreInput = mode === "keychain"
      ? Buffer.from(
        `add-generic-password -a llm-relay -s llm-relay-keystore-kek -U -w ${KEK.toString("base64")}\n`,
        "ascii",
      )
      : Buffer.from(KEK.toString("base64"), "ascii");
    expect(spawn).toHaveBeenNthCalledWith(1, command, storeArgv, {
      windowsHide: true,
      stdio: "pipe",
      encoding: "buffer",
      input: expect.any(Buffer),
    });
    expect(capturedInputs).toEqual([expectedStoreInput]);
    expect(spawn).toHaveBeenNthCalledWith(2, command, loadArgv, {
      windowsHide: true,
      stdio: "pipe",
      encoding: "buffer",
    });
  });
});
