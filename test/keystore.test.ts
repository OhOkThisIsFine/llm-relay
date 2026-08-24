import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addEntry,
  KeystoreReadError,
  KeystoreUnlockError,
  KeystoreValidationError,
  listEntries,
  lock,
  lookupByEnvName,
  removeEntry,
  resolveKeystorePath,
  revokeEntry,
  rotateEntry,
  setDisabled,
  type KeystoreOptions,
} from "../src/keystore.js";
import type { KeyringSpawnSync } from "../src/os-keyring.js";

const PASSPHRASE = "correct horse battery staple";

describe("encrypted credential keystore", () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "llm-relay-keystore-"));
    path = join(directory, "keystore.json");
    lock();
  });

  afterEach(() => {
    lock();
    rmSync(directory, { recursive: true, force: true });
  });

  const options = (extra: Partial<KeystoreOptions & { expiresAt?: number | null }> = {}) => ({
    path,
    mode: "passphrase" as const,
    passphrase: PASSPHRASE,
    ...extra,
  });

  it("round-trips a passphrase-backed entry and persists the exact non-plaintext v1 shape", () => {
    const descriptor = addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "nvapi-secret-value",
      expiresAt: 9_999,
    }, options({ now: 1_000 }));

    expect(descriptor).toEqual({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      fingerprint: expect.stringMatching(/^hmac:[0-9a-f]{8}$/),
      addedAt: 1_000,
      rotatedAt: null,
      expiresAt: 9_999,
      revokedAt: null,
      disabled: false,
    });
    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 2_000 }))).toEqual({
      value: "nvapi-secret-value",
      entryId: "nim#personal",
      provider: "nim",
    });

    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({
      version: 1,
      kek: {
        wrap: "passphrase",
        kdf: { n: 16_384, r: 8, p: 1, salt: expect.any(String) },
      },
      fpSalt: expect.any(String),
      entries: [{
        id: "nim#personal",
        provider: "nim",
        envName: "NVIDIA_API_KEY",
        ct: expect.any(String),
        iv: expect.any(String),
        tag: expect.any(String),
        fingerprint: descriptor.fingerprint,
        addedAt: 1_000,
        rotatedAt: null,
        expiresAt: 9_999,
        revokedAt: null,
        disabled: false,
      }],
    });
    expect(JSON.stringify(raw)).not.toContain("nvapi-secret-value");
    expect(Buffer.from(raw.fpSalt as string, "base64")).toHaveLength(32);
    expect(listEntries(options())).toEqual([descriptor]);
    expect(listEntries(options())[0]).not.toHaveProperty("ct");
    expect(listEntries(options())[0]).not.toHaveProperty("value");
  });

  it("binds ciphertext to provider and entry id with AES-GCM AAD", () => {
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "aad-bound-secret",
    }, options());
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      entries: Array<{ id: string; provider: string }>;
    };
    raw.entries[0]!.provider = "tampered-provider";
    raw.entries[0]!.id = "tampered-provider#personal";
    writeFileSync(path, `${JSON.stringify(raw)}\n`, "utf8");

    expect(() => lookupByEnvName("NVIDIA_API_KEY", options())).not.toThrow();
    expect(lookupByEnvName("NVIDIA_API_KEY", options())).toBeNull();
  });

  it("does not cache or persist a passphrase-derived KEK until existing ciphertext authenticates", () => {
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "original-secret",
    }, options());
    const before = readFileSync(path, "utf8");
    lock({ path });

    expect(lookupByEnvName("NVIDIA_API_KEY", {
      ...options(),
      passphrase: "wrong passphrase",
    })).toBeNull();
    expect(lookupByEnvName("NVIDIA_API_KEY", options())?.value).toBe("original-secret");
    lock({ path });

    expect(() => addEntry({
      id: "nim#work",
      provider: "nim",
      envName: "NVIDIA_WORK_API_KEY",
      value: "must-not-persist",
    }, { ...options(), passphrase: "wrong passphrase" })).toThrow(KeystoreUnlockError);
    expect(() => rotateEntry(
      "nim#personal",
      "must-not-rotate",
      { ...options(), passphrase: "wrong passphrase" },
    )).toThrow(KeystoreUnlockError);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(lookupByEnvName("NVIDIA_API_KEY", options())?.value).toBe("original-secret");
  });

  it.each([
    ["line feed", "nim#bad\nlabel", "NVIDIA_API_KEY"],
    ["carriage return", "nim#bad\rlabel", "NVIDIA_API_KEY"],
    ["terminal escape", "nim#bad\u001b[31m", "NVIDIA_API_KEY"],
    ["env line feed", "nim#personal", "NVIDIA\nAPI_KEY"],
    ["env carriage return", "nim#personal", "NVIDIA\rAPI_KEY"],
    ["env terminal escape", "nim#personal", "NVIDIA\u001b[31m_API_KEY"],
  ])("refuses %s in labels or environment names at write", (_name, id, envName) => {
    expect(() => addEntry({
      id,
      provider: "nim",
      envName,
      value: "secret",
    }, options())).toThrow(KeystoreValidationError);
  });

  it("refuses a credential id whose provider does not match the entry provider", () => {
    expect(() => addEntry({
      id: "other#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "secret",
    }, options())).toThrow(KeystoreValidationError);
    expect(existsSync(path)).toBe(false);
  });

  it("rejects duplicate environment names and drops later duplicates at load", () => {
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "first-secret",
    }, options());
    expect(() => addEntry({
      id: "nim#work",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "second-secret",
    }, options())).toThrow();

    addEntry({
      id: "nim#work",
      provider: "nim",
      envName: "NVIDIA_WORK_API_KEY",
      value: "second-secret",
    }, options());
    const raw = JSON.parse(readFileSync(path, "utf8")) as { entries: Array<{ envName: string }> };
    raw.entries[1]!.envName = "NVIDIA_API_KEY";
    writeFileSync(path, `${JSON.stringify(raw)}\n`, "utf8");

    expect(listEntries(options()).map((entry) => entry.id)).toEqual(["nim#personal"]);
    expect(lookupByEnvName("NVIDIA_API_KEY", options())?.value).toBe("first-secret");
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses malformed write timestamp %s before creating a store",
    (now) => {
      expect(() => addEntry({
        id: "nim#personal",
        provider: "nim",
        envName: "NVIDIA_API_KEY",
        value: "secret",
      }, options({ now }))).toThrow(KeystoreValidationError);
      expect(existsSync(path)).toBe(false);
    },
  );

  it.each([
    ["label line feed", (entry: Record<string, unknown>) => { entry.id = "nim#bad\nlabel"; }],
    ["label carriage return", (entry: Record<string, unknown>) => { entry.id = "nim#bad\rlabel"; }],
    ["label terminal escape", (entry: Record<string, unknown>) => { entry.id = "nim#bad\u001b[31m"; }],
    ["env line feed", (entry: Record<string, unknown>) => { entry.envName = "BAD\nENV"; }],
    ["env carriage return", (entry: Record<string, unknown>) => { entry.envName = "BAD\rENV"; }],
    ["env terminal escape", (entry: Record<string, unknown>) => { entry.envName = "BAD\u001b[31m_ENV"; }],
  ])("drops a loaded entry containing %s", (_name, edit) => {
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "secret",
    }, options());
    const raw = JSON.parse(readFileSync(path, "utf8")) as { entries: Array<Record<string, unknown>> };
    edit(raw.entries[0]!);
    writeFileSync(path, `${JSON.stringify(raw)}\n`, "utf8");

    expect(listEntries(options())).toEqual([]);
    expect(lookupByEnvName("NVIDIA_API_KEY", options())).toBeNull();
  });

  it("drops a loaded entry whose credential id belongs to another provider", () => {
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "secret",
    }, options());
    const raw = JSON.parse(readFileSync(path, "utf8")) as { entries: Array<{ provider: string }> };
    raw.entries[0]!.provider = "other";
    writeFileSync(path, `${JSON.stringify(raw)}\n`, "utf8");

    expect(listEntries(options())).toEqual([]);
  });

  it.each([
    ["corrupt JSON", "{"],
    ["wrong version", JSON.stringify({ version: 2, kek: {}, fpSalt: "", entries: [] })],
    ["null", "null"],
    ["array", "[]"],
    ["primitive", "42"],
  ])("degrades %s to a fresh empty store without throwing", (_name, serialized) => {
    writeFileSync(path, serialized, "utf8");

    expect(() => listEntries(options())).not.toThrow();
    expect(listEntries(options())).toEqual([]);
    expect(lookupByEnvName("NVIDIA_API_KEY", options())).toBeNull();
  });

  it("drops an entry with malformed authenticated-encryption fields at load", () => {
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "secret",
    }, options());
    const raw = JSON.parse(readFileSync(path, "utf8")) as { entries: Array<{ iv: string }> };
    raw.entries[0]!.iv = "not-base64";
    writeFileSync(path, `${JSON.stringify(raw)}\n`, "utf8");

    expect(listEntries(options())).toEqual([]);
  });

  it("reports unreadable paths with a sanitized error and refuses to overwrite them", () => {
    mkdirSync(path);

    expect(() => listEntries(options())).toThrow(KeystoreReadError);
    expect(() => lookupByEnvName("NVIDIA_API_KEY", options())).toThrow(KeystoreReadError);
    expect(() => addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "secret",
    }, options())).toThrow(KeystoreReadError);
  });

  it("implements rotate, revoke, disable, expiry, and removal without exposing old values", () => {
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "old-secret",
    }, options({ now: 100 }));

    const rotated = rotateEntry("nim#personal", "new-secret", options({ now: 200, expiresAt: 500 }));
    expect(rotated.rotatedAt).toBe(200);
    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 300 }))?.value).toBe("new-secret");
    expect(readFileSync(path, "utf8")).not.toContain("old-secret");
    expect(readFileSync(path, "utf8")).not.toContain("new-secret");

    revokeEntry("nim#personal", options({ now: 350 }));
    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 351 }))).toBeNull();
    rotateEntry("nim#personal", "third-secret", options({ now: 400 }));
    expect(listEntries(options())[0]?.revokedAt).toBeNull();

    setDisabled("nim#personal", true, options());
    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 450 }))).toBeNull();
    setDisabled("nim#personal", false, options());
    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 500 }))).toBeNull();

    expect(removeEntry("nim#personal", options())).toBe(true);
    expect(listEntries(options())).toEqual([]);
  });

  it("rereads store metadata on every lookup while keeping only the KEK cached", () => {
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "secret",
    }, options());
    expect(lookupByEnvName("NVIDIA_API_KEY", options())?.value).toBe("secret");

    const raw = JSON.parse(readFileSync(path, "utf8")) as { entries: Array<{ disabled: boolean }> };
    raw.entries[0]!.disabled = true;
    writeFileSync(path, `${JSON.stringify(raw)}\n`, "utf8");
    expect(lookupByEnvName("NVIDIA_API_KEY", options())).toBeNull();
  });

  it("zeroizes the cached KEK buffer on lock", () => {
    const kek = Buffer.alloc(32, 0x5a);
    const spawn = vi.fn<KeyringSpawnSync>(() => ({
      status: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));

    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "secret",
    }, {
      path,
      mode: "libsecret",
      spawnSync: spawn,
      randomBytes: () => kek,
    });

    expect(kek.equals(Buffer.alloc(32))).toBe(false);
    lock({ path });
    expect(kek.equals(Buffer.alloc(32))).toBe(true);
  });

  it("uses fpSalt to namespace OS items and invalidate a same-path cached KEK", () => {
    const secondKek = Buffer.alloc(32, 0x42);
    const spawn = vi.fn<KeyringSpawnSync>()
      .mockReturnValueOnce({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({
        status: 0,
        stdout: Buffer.from(`${secondKek.toString("base64")}\n`, "ascii"),
        stderr: Buffer.alloc(0),
      });
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "secret",
    }, {
      path,
      mode: "libsecret",
      spawnSync: spawn,
      randomBytes: (size) => Buffer.alloc(size, 0x41),
    });
    const firstPurpose = spawn.mock.calls[0]?.[1].at(-1);

    const raw = JSON.parse(readFileSync(path, "utf8")) as { fpSalt: string };
    raw.fpSalt = Buffer.alloc(32, 0x42).toString("base64");
    writeFileSync(path, `${JSON.stringify(raw)}\n`, "utf8");

    expect(lookupByEnvName("NVIDIA_API_KEY", { path, spawnSync: spawn })).toBeNull();
    expect(spawn).toHaveBeenCalledTimes(2);
    const secondPurpose = spawn.mock.calls[1]?.[1].at(-1);
    expect(firstPurpose).toMatch(/^keystore-kek:keystore-[0-9a-f]{32}$/);
    expect(secondPurpose).toBe("keystore-kek:keystore-42424242424242424242424242424242");
    expect(secondPurpose).not.toBe(firstPurpose);
    secondKek.fill(0);
  });

  it("redirects the default path under VITEST into a pid-specific temporary path", () => {
    const defaultPath = resolveKeystorePath();
    const expectedDirectory = join(tmpdir(), `llm-relay-test-keystore-${process.pid}`);
    expect(process.env.VITEST).toBeDefined();
    expect(defaultPath).toContain(tmpdir());
    expect(defaultPath).toContain(String(process.pid));
    expect(defaultPath).not.toBe(join(homedir(), ".llm-relay", "keystore.json"));
    expect(dirname(defaultPath)).toBe(expectedDirectory);
    if (dirname(defaultPath) !== expectedDirectory) throw new Error("unsafe VITEST keystore redirect");

    try {
      addEntry({
        id: "nim#default",
        provider: "nim",
        envName: "NVIDIA_API_KEY",
        value: "redirected-secret",
      }, { mode: "passphrase", passphrase: PASSPHRASE });
      expect(readFileSync(defaultPath, "utf8")).not.toContain("redirected-secret");
    } finally {
      lock();
      rmSync(expectedDirectory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("persists a 0600 file inside a 0700 directory on POSIX", () => {
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "secret",
    }, options());

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });
});
