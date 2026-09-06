import { createCipheriv, createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addEntry,
  createKeystoreResolutionWalk,
  keystoreStatus,
  KeystoreEntryExistsError,
  KeystoreMutationRefusedError,
  KeystoreReadError,
  KeystoreUnlockError,
  KeystoreValidationError,
  KeystoreWriteError,
  listEntries,
  lock,
  lookupByEnvName,
  lookupByEnvNames,
  removeEntry,
  resolveKeystorePath,
  revokeEntry,
  rotateEntry,
  setDisabled,
  type KeystoreOptions,
} from "../src/keystore.js";
import type { KeyringSpawnSync } from "../src/os-keyring.js";
import type { SecretFileAclSpawnSync } from "../src/secret-file-acl.js";
import { resolveCredential } from "../src/authEnv.js";

const PASSPHRASE = "correct horse battery staple";
const FIRST_SECRET = "sk_A7vQ2mX9pL4rT8uN6wC3";
const SECOND_SECRET = "sk_B8yR3nW0qM5sU9vP7xD4";
const ATTEMPTED_SECRET = "sk_C9zS4oX1rN6tV0wQ8yE5";
const OWNER_SID = "S-1-5-21-111-222-333-1001";
const CAPTURED_ACL_OPTIONS = {
  windowsHide: true,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
} as const;

interface RawEntry extends Record<string, unknown> {
  id: string;
  provider: string;
  envName: string;
  ct: string;
  iv: string;
  tag: string;
  fingerprint: string;
  addedAt: number;
  rotatedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  disabled: boolean;
}

interface RawStore extends Record<string, unknown> {
  version: number;
  kek: Record<string, unknown>;
  fpSalt: string;
  itemId: string;
  kekCheck: string;
  entries: RawEntry[];
}

function stringifyForLeakCheck(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Match the key-checker adversarial convention: every sliding four-character window leaks. */
function leaks(value: unknown, secret: string): boolean {
  const output = stringifyForLeakCheck(value);
  const needles = new Set<string>();
  for (let offset = 0; offset + 4 <= secret.length; offset += 1) {
    needles.add(secret.slice(offset, offset + 4));
  }
  needles.add(Buffer.from(secret, "utf8").toString("base64"));
  needles.add(Buffer.from(secret, "utf8").toString("hex"));
  return [...needles].some((needle) => needle.length > 0 && output.includes(needle));
}

function expectNoSecretLeaks(value: unknown, ...secrets: string[]): void {
  for (const secret of secrets) expect(leaks(value, secret)).toBe(false);
}

function captureError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected action to throw");
}

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

  const options = (
    extra: Partial<KeystoreOptions & { expiresAt?: number | null }> = {},
  ): KeystoreOptions & { expiresAt?: number | null } => ({
    path,
    mode: "passphrase" as const,
    passphrase: PASSPHRASE,
    ...extra,
  });

  const readRaw = (): RawStore => JSON.parse(readFileSync(path, "utf8")) as RawStore;

  const writeRaw = (raw: RawStore): void => {
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  };

  const replaceRawValue = (
    raw: RawStore,
    entry: RawEntry,
    value: string,
    kek: Buffer,
    ivByte: number,
  ): void => {
    const plaintext = Buffer.from(value, "utf8");
    const iv = Buffer.alloc(12, ivByte);
    try {
      const cipher = createCipheriv("aes-256-gcm", kek, iv, { authTagLength: 16 });
      cipher.setAAD(Buffer.from(`1|${entry.provider}|${entry.id}|${entry.envName}`, "utf8"));
      entry.ct = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64");
      entry.iv = iv.toString("base64");
      entry.tag = cipher.getAuthTag().toString("base64");
      entry.fingerprint = `hmac:${createHmac("sha256", kek)
        .update(Buffer.from(raw.fpSalt, "base64"))
        .update(plaintext)
        .digest("hex")
        .slice(0, 8)}`;
    } finally {
      plaintext.fill(0);
      iv.fill(0);
    }
  };

  const seedTwoRows = (): RawStore => {
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: FIRST_SECRET,
    }, options({ now: 100 }));
    addEntry({
      id: "openai#work",
      provider: "openai",
      envName: "OPENAI_API_KEY",
      value: SECOND_SECRET,
    }, options({ now: 200 }));
    return readRaw();
  };

  it("round-trips a passphrase-backed entry in the exact closed non-plaintext v1 shape", () => {
    const descriptor = addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: FIRST_SECRET,
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
      value: FIRST_SECRET,
      entryId: "nim#personal",
      provider: "nim",
    });

    const raw = readRaw();
    expect(Object.keys(raw).sort()).toEqual([
      "entries", "fpSalt", "itemId", "kek", "kekCheck", "version",
    ]);
    expect(raw).toMatchObject({
      version: 1,
      kek: {
        wrap: "passphrase",
        kdf: { n: 16_384, r: 8, p: 1, salt: expect.any(String) },
      },
      fpSalt: expect.any(String),
      itemId: expect.stringMatching(/^[0-9a-f]{32}$/),
      kekCheck: expect.stringMatching(/^[0-9a-f]{64}$/),
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
    expect(Object.keys(raw.entries[0]!).sort()).toEqual([
      "addedAt", "ct", "disabled", "envName", "expiresAt", "fingerprint",
      "id", "iv", "provider", "revokedAt", "rotatedAt", "tag",
    ]);
    expect(Buffer.from(raw.fpSalt, "base64")).toHaveLength(32);
    expect(Buffer.from(raw.entries[0]!.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(raw.entries[0]!.tag, "base64")).toHaveLength(16);
    expect(Buffer.from(raw.entries[0]!.ct, "base64")).toHaveLength(Buffer.byteLength(FIRST_SECRET));
    expectNoSecretLeaks(readFileSync(path, "utf8"), FIRST_SECRET);
    expect(listEntries(options())).toEqual([descriptor]);
    expect(listEntries(options())[0]).not.toHaveProperty("ct");
    expect(listEntries(options())[0]).not.toHaveProperty("value");
    expect(keystoreStatus(options())).toEqual({ status: "ok", droppedCount: 0, undecryptableCount: 0 });
  });

  it("uses a fresh 12-byte IV and a 16-byte authentication tag for every encryption", () => {
    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, options());
    const first = readRaw().entries[0]!;
    rotateEntry("nim#personal", SECOND_SECRET, options({ now: 200 }));
    const second = readRaw().entries[0]!;

    expect(first.iv).not.toBe(second.iv);
    expect(Buffer.from(first.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(second.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(first.tag, "base64")).toHaveLength(16);
    expect(Buffer.from(second.tag, "base64")).toHaveLength(16);
  });

  it("binds provider and credential id into AES-GCM AAD", () => {
    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, options());
    const raw = readRaw();
    raw.entries[0]!.provider = "tampered-provider";
    raw.entries[0]!.id = "tampered-provider#personal";
    writeRaw(raw);

    expect(() => lookupByEnvName("NVIDIA_API_KEY", options())).not.toThrow();
    expect(lookupByEnvName("NVIDIA_API_KEY", options())).toBeNull();
    expect(keystoreStatus(options())).toEqual({ status: "degraded", droppedCount: 1, undecryptableCount: 1 });
  });

  it("binds envName into AES-GCM AAD so a file writer cannot retarget a secret", () => {
    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, options());
    const raw = readRaw();
    raw.entries[0]!.envName = "OPENAI_API_KEY";
    writeRaw(raw);

    expect(lookupByEnvName("OPENAI_API_KEY", options())).toBeNull();
    expect(lookupByEnvName("NVIDIA_API_KEY", options())).toBeNull();
    expect(keystoreStatus(options())).toEqual({ status: "degraded", droppedCount: 1, undecryptableCount: 1 });
  });

  it("keeps the legacy provider argument compatibility-only while envName owns identity", () => {
    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, options());

    expect(lookupByEnvName("NVIDIA_API_KEY", "nim", options())?.value).toBe(FIRST_SECRET);
    expect(lookupByEnvName("NVIDIA_API_KEY", "openai", options())?.value).toBe(FIRST_SECRET);
    expect(lookupByEnvName("NVIDIA_API_KEY", "not a provider!", options())?.value)
      .toBe(FIRST_SECRET);
    expect(lookupByEnvName("NVIDIA_API_KEY", options(), "nim")?.value).toBe(FIRST_SECRET);
    expect(lookupByEnvName("NVIDIA_API_KEY", options(), "openai")?.value).toBe(FIRST_SECRET);
  });

  it("loads once for a candidate batch, scans candidate order, and rereads only after staleness", () => {
    seedTwoRows();
    const readFile = vi.fn((candidatePath: string) => readFileSync(candidatePath, "utf8"));
    const statFile = vi.fn((candidatePath: string) => {
      const { mtimeMs, size, ino } = statSync(candidatePath);
      return { mtimeMs, size, ino };
    });
    const counted = options({ readFile, statFile });

    expect(lookupByEnvNames(
      ["OPENAI_API_KEY", "NVIDIA_API_KEY"],
      counted,
    )).toMatchObject({
      envName: "OPENAI_API_KEY",
      value: SECOND_SECRET,
      entryId: "openai#work",
      provider: "openai",
    });
    expect(statFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(1);

    const aliasPath = join(directory, "unused", "..", "keystore.json");
    expect(lookupByEnvName("NVIDIA_API_KEY", { ...counted, path: aliasPath })?.value)
      .toBe(FIRST_SECRET);
    expect(lookupByEnvName("NVIDIA_API_KEY", counted)?.value).toBe(FIRST_SECRET);
    expect(lookupByEnvName("NVIDIA_API_KEY", counted)?.value).toBe(FIRST_SECRET);
    expect(statFile).toHaveBeenCalledTimes(4);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("shares one store observation across consumers in an opaque resolution walk", () => {
    seedTwoRows();
    const readFile = vi.fn((candidatePath: string) => readFileSync(candidatePath, "utf8"));
    const statFile = vi.fn((candidatePath: string) => {
      const { mtimeMs, size, ino } = statSync(candidatePath);
      return { mtimeMs, size, ino };
    });
    const scoped = options({
      readFile,
      statFile,
      resolutionWalk: createKeystoreResolutionWalk(),
    });

    expect(lookupByEnvNames(["NVIDIA_API_KEY"], scoped)?.value).toBe(FIRST_SECRET);
    expect(listEntries(scoped)).toHaveLength(2);
    expect(keystoreStatus(scoped)).toEqual({ status: "ok", droppedCount: 0, undecryptableCount: 0 });
    expect(statFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("skips a legacy whitespace-only candidate and returns the next usable named value", () => {
    const knownKek = Buffer.alloc(32, 0x42);
    const spawnSync = vi.fn<KeyringSpawnSync>(() => ({
      status: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    const knownKekOptions: KeystoreOptions = {
      path,
      mode: "libsecret",
      platform: "linux",
      spawnSync,
      randomBytes: (size) => Buffer.alloc(size, 0x42),
    };
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: FIRST_SECRET,
    }, knownKekOptions);
    addEntry({
      id: "openai#work",
      provider: "openai",
      envName: "OPENAI_API_KEY",
      value: SECOND_SECRET,
    }, knownKekOptions);
    const raw = readRaw();
    replaceRawValue(raw, raw.entries[0]!, " \t\n ", knownKek, 0x33);
    writeRaw(raw);

    expect(lookupByEnvNames(
      ["NVIDIA_API_KEY", "OPENAI_API_KEY"],
      knownKekOptions,
    )).toMatchObject({
      envName: "OPENAI_API_KEY",
      value: SECOND_SECRET,
      entryId: "openai#work",
      provider: "openai",
    });
  });

  it("uses one presence definition to reject whitespace-only add and rotate values", () => {
    const addError = captureError(() => addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: " \t\n ",
    }, options()));
    expect(addError).toBeInstanceOf(KeystoreValidationError);
    expect(addError.message).toBe("invalid keystore entry value");
    expect(existsSync(path)).toBe(false);

    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: FIRST_SECRET,
    }, options());
    const before = readFileSync(path);
    const rotateError = captureError(() => rotateEntry("nim#personal", "\r\n\t", options()));
    expect(rotateError).toBeInstanceOf(KeystoreValidationError);
    expect(rotateError.message).toBe("invalid keystore entry value");
    expect(readFileSync(path)).toEqual(before);
  });

  it("deduplicates envName globally in deterministic file order and reports the dropped row", () => {
    const raw = seedTwoRows();
    raw.entries[1]!.envName = "NVIDIA_API_KEY";
    writeRaw(raw);

    expect(listEntries(options()).map((entry) => entry.id)).toEqual(["nim#personal"]);
    expect(lookupByEnvName("NVIDIA_API_KEY", options())?.value).toBe(FIRST_SECRET);
    expect(lookupByEnvName("NVIDIA_API_KEY", "openai", options())?.value).toBe(FIRST_SECRET);
    expect(keystoreStatus(options())).toEqual({ status: "degraded", droppedCount: 1, undecryptableCount: 0 });
  });

  const mutationCases: Array<{
    name: string;
    mutate: (opts: KeystoreOptions) => unknown;
  }> = [
    {
      name: "addEntry",
      mutate: (opts) => addEntry({
        id: "anthropic#third",
        provider: "anthropic",
        envName: "ANTHROPIC_API_KEY",
        value: ATTEMPTED_SECRET,
      }, opts),
    },
    {
      name: "rotateEntry",
      mutate: (opts) => rotateEntry("nim#personal", ATTEMPTED_SECRET, opts),
    },
    { name: "revokeEntry", mutate: (opts) => revokeEntry("nim#personal", opts) },
    { name: "removeEntry", mutate: (opts) => removeEntry("nim#personal", opts) },
    { name: "setDisabled", mutate: (opts) => setDisabled("nim#personal", true, opts) },
  ];

  const corruptionCases: Array<{
    name: string;
    expectedStatus: "degraded" | "unreadable";
    droppedCount: number;
    corrupt: (raw: RawStore) => void;
  }> = [
    {
      name: "an unknown entry key",
      expectedStatus: "degraded",
      droppedCount: 1,
      corrupt: (raw) => { raw.entries[1]!.futureField = true; },
    },
    {
      name: "a non-canonical ciphertext character",
      expectedStatus: "degraded",
      droppedCount: 1,
      corrupt: (raw) => { raw.entries[1]!.ct = `!${raw.entries[1]!.ct}`; },
    },
    {
      name: "an unknown top-level key",
      expectedStatus: "unreadable",
      droppedCount: 0,
      corrupt: (raw) => { raw.futureField = true; },
    },
    {
      name: "a corrupted DPAPI blob",
      expectedStatus: "unreadable",
      droppedCount: 0,
      corrupt: (raw) => { raw.kek = { wrap: "dpapi", blob: "!" }; },
    },
    {
      name: "an unsupported version",
      expectedStatus: "unreadable",
      droppedCount: 0,
      corrupt: (raw) => { raw.version = 2; },
    },
  ];

  it.each(corruptionCases.flatMap((corruption) => mutationCases.map((mutation) => ({
    corruption: corruption.name,
    expectedStatus: corruption.expectedStatus,
    droppedCount: corruption.droppedCount,
    corrupt: corruption.corrupt,
    mutation: mutation.name,
    mutate: mutation.mutate,
  }))))(
    "refuses $mutation when the present store has $corruption and preserves every byte",
    ({ expectedStatus, droppedCount, corrupt, mutate }) => {
      const raw = seedTwoRows();
      corrupt(raw);
      writeRaw(raw);
      const before = readFileSync(path);

      if (expectedStatus === "degraded") {
        expect(listEntries(options()).map((entry) => entry.id)).toEqual(["nim#personal"]);
        expect(lookupByEnvName("NVIDIA_API_KEY", options())?.value).toBe(FIRST_SECRET);
      } else {
        expect(() => listEntries(options())).toThrow(KeystoreReadError);
        expect(lookupByEnvName("NVIDIA_API_KEY", options())).toBeNull();
      }
      expect(keystoreStatus(options())).toEqual({
        status: expectedStatus,
        droppedCount,
        undecryptableCount: 0,
      });

      const error = captureError(() => mutate(options()));
      expect(error).toBeInstanceOf(KeystoreMutationRefusedError);
      expect(error.name).toBe("KeystoreMutationRefusedError");
      expect(error).toMatchObject({ status: expectedStatus, droppedCount });
      expect(readFileSync(path)).toEqual(before);
      expectNoSecretLeaks(error, FIRST_SECRET, SECOND_SECRET, ATTEMPTED_SECRET);
    },
  );

  it.each(mutationCases)(
    "refuses $name when ciphertext has a canonical Base64 character flip",
    ({ mutate }) => {
      const raw = seedTwoRows();
      const ct = raw.entries[1]!.ct;
      raw.entries[1]!.ct = `${ct[0] === "A" ? "B" : "A"}${ct.slice(1)}`;
      writeRaw(raw);
      const before = readFileSync(path);

      expect(lookupByEnvName("NVIDIA_API_KEY", options())?.value).toBe(FIRST_SECRET);
      expect(keystoreStatus(options())).toEqual({
        status: "degraded",
        droppedCount: 1,
        undecryptableCount: 1,
      });
      lock({ path });
      const error = captureError(() => mutate(options()));
      expect(error).toBeInstanceOf(KeystoreMutationRefusedError);
      expect(error).toMatchObject({ status: "degraded", droppedCount: 1 });
      expect(readFileSync(path)).toEqual(before);
      expectNoSecretLeaks(error, FIRST_SECRET, SECOND_SECRET, ATTEMPTED_SECRET);
    },
  );

  it("uses kekCheck to reject add -> remove -> wrong-passphrase KEK forking", () => {
    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, options());
    removeEntry("nim#personal", options());
    const emptyStore = readRaw();
    expect(emptyStore.entries).toEqual([]);
    expect(emptyStore.itemId).toMatch(/^[0-9a-f]{32}$/);
    expect(emptyStore.kekCheck).toMatch(/^[0-9a-f]{64}$/);
    const before = readFileSync(path);
    lock({ path });

    const error = captureError(() => addEntry({
      id: "nim#replacement",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: ATTEMPTED_SECRET,
    }, { ...options(), passphrase: "typo'd passphrase" }));
    expect(error).toBeInstanceOf(KeystoreUnlockError);
    expect(error.name).toBe("KeystoreUnlockError");
    expect(readFileSync(path)).toEqual(before);
    expectNoSecretLeaks(error, FIRST_SECRET, ATTEMPTED_SECRET);

    lock({ path });
    addEntry({
      id: "nim#replacement", provider: "nim", envName: "NVIDIA_API_KEY", value: SECOND_SECRET,
    }, options());
    expect(lookupByEnvName("NVIDIA_API_KEY", options())?.value).toBe(SECOND_SECRET);
  });

  it("self-heals wrong-passphrase reads and writes after the 60-second cooldown", () => {
    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, options());
    const before = readFileSync(path);
    lock({ path });

    expect(lookupByEnvName("NVIDIA_API_KEY", {
      ...options(),
      passphrase: "wrong passphrase",
      now: 0,
    })).toBeNull();
    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 59_999 }))).toBeNull();
    expect(readFileSync(path)).toEqual(before);
    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 60_000 }))?.value)
      .toBe(FIRST_SECRET);

    addEntry({
      id: "nim#work",
      provider: "nim",
      envName: "NVIDIA_WORK_API_KEY",
      value: SECOND_SECRET,
    }, options({ now: 60_001 }));
    expect(lookupByEnvName("NVIDIA_WORK_API_KEY", options({ now: 60_002 }))?.value)
      .toBe(SECOND_SECRET);
  });

  it("does not bypass the unlock cooldown for a same-descriptor stat-token change", () => {
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: FIRST_SECRET,
    }, options());
    lock({ path });
    expect(lookupByEnvName("NVIDIA_API_KEY", {
      ...options(),
      passphrase: "wrong passphrase",
      now: 0,
    })).toBeNull();

    const raw = readRaw();
    const kdf = raw.kek.kdf as Record<string, unknown>;
    raw.kek = {
      kdf: { salt: kdf.salt, p: kdf.p, r: kdf.r, n: kdf.n },
      wrap: "passphrase",
    };
    writeRaw(raw);
    utimesSync(path, new Date(1_600_000_000_000), new Date(1_600_000_000_000));

    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 1 }))).toBeNull();
    expect(keystoreStatus(options({ now: 1 }))).toEqual({
      status: "locked",
      droppedCount: 0,
      undecryptableCount: 0,
    });
    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 60_000 }))?.value)
      .toBe(FIRST_SECRET);
  });

  it("retries immediately when a replacement store has a different KEK descriptor identity", () => {
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: FIRST_SECRET,
    }, options());
    lock({ path });
    expect(lookupByEnvName("NVIDIA_API_KEY", {
      ...options(),
      passphrase: "wrong passphrase",
      now: 0,
    })).toBeNull();

    const replacementPath = join(directory, "replacement.json");
    addEntry({
      id: "nim#replacement",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: SECOND_SECRET,
    }, options({ path: replacementPath, now: 1 }));
    writeFileSync(path, readFileSync(replacementPath));
    utimesSync(path, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 2 }))?.value).toBe(SECOND_SECRET);
  });

  it.each([
    ["label line feed", "nim#bad\nlabel", "nim", "NVIDIA_API_KEY"],
    ["label carriage return", "nim#bad\rlabel", "nim", "NVIDIA_API_KEY"],
    ["label terminal escape", "nim#bad\u001b[31m", "nim", "NVIDIA_API_KEY"],
    ["env line feed", "nim#personal", "nim", "NVIDIA\nAPI_KEY"],
    ["env carriage return", "nim#personal", "nim", "NVIDIA\rAPI_KEY"],
    ["env terminal escape", "nim#personal", "nim", "NVIDIA\u001b[31m_API_KEY"],
  ])("refuses %s at write", (_name, id, provider, envName) => {
    expect(() => addEntry({ id, provider, envName, value: FIRST_SECRET }, options()))
      .toThrow(KeystoreValidationError);
    expect(existsSync(path)).toBe(false);
  });

  it("bounds environment names at 128 characters", () => {
    const maximumName = `A${"B".repeat(127)}`;
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: maximumName,
      value: FIRST_SECRET,
    }, options());

    const hostileName = `${maximumName}C`;
    expect(() => addEntry({
      id: "nim#work",
      provider: "nim",
      envName: hostileName,
      value: SECOND_SECRET,
    }, options())).toThrow(KeystoreValidationError);
    expect(listEntries(options()).map((entry) => entry.envName)).toEqual([maximumName]);
  });

  it.each([
    ["provider CRLF", "nim\r\nX-Injected: 1"],
    ["provider terminal escape", "nim\u001b[31m"],
  ])("refuses %s in credential provider at write", (_name, provider) => {
    const error = captureError(() => addEntry({
      id: `${provider}#personal`,
      provider,
      envName: "NVIDIA_API_KEY",
      value: FIRST_SECRET,
    }, options()));
    expect(error).toBeInstanceOf(KeystoreValidationError);
    expect(error.message).toBe("invalid keystore entry provider");
    expect(existsSync(path)).toBe(false);
  });

  it.each([
    ["provider CRLF", "nim\r\nX-Injected: 1"],
    ["provider terminal escape", "nim\u001b[31m"],
  ])("drops %s in credential provider at load", (_name, provider) => {
    const raw = seedTwoRows();
    raw.entries[1]!.provider = provider;
    raw.entries[1]!.id = `${provider}#work`;
    writeRaw(raw);

    expect(listEntries(options()).map((entry) => entry.id)).toEqual(["nim#personal"]);
    expect(lookupByEnvName("NVIDIA_API_KEY", options())?.value).toBe(FIRST_SECRET);
    expect(lookupByEnvName("OPENAI_API_KEY", options())).toBeNull();
    expect(keystoreStatus(options())).toEqual({
      status: "degraded",
      droppedCount: 1,
      undecryptableCount: 0,
    });
  });

  it("refuses a credential id whose provider does not match the entry provider", () => {
    expect(() => addEntry({
      id: "other#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: FIRST_SECRET,
    }, options())).toThrow(KeystoreValidationError);
    expect(existsSync(path)).toBe(false);
  });

  it("rejects duplicate environment names at write", () => {
    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, options());
    expect(() => addEntry({
      id: "nim#work", provider: "nim", envName: "NVIDIA_API_KEY", value: SECOND_SECRET,
    }, options())).toThrow();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses malformed write timestamp %s before creating a store",
    (now) => {
      expect(() => addEntry({
        id: "nim#personal",
        provider: "nim",
        envName: "NVIDIA_API_KEY",
        value: FIRST_SECRET,
      }, options({ now }))).toThrow(KeystoreValidationError);
      expect(existsSync(path)).toBe(false);
    },
  );

  it.each([
    ["label line feed", (entry: RawEntry) => { entry.id = "nim#bad\nlabel"; }],
    ["label carriage return", (entry: RawEntry) => { entry.id = "nim#bad\rlabel"; }],
    ["label terminal escape", (entry: RawEntry) => { entry.id = "nim#bad\u001b[31m"; }],
    ["env line feed", (entry: RawEntry) => { entry.envName = "BAD\nENV"; }],
    ["env carriage return", (entry: RawEntry) => { entry.envName = "BAD\rENV"; }],
    ["env terminal escape", (entry: RawEntry) => { entry.envName = "BAD\u001b[31m_ENV"; }],
  ] as const)("drops a loaded entry containing %s", (_name, edit) => {
    const raw = seedTwoRows();
    edit(raw.entries[1]!);
    writeRaw(raw);

    expect(listEntries(options()).map((entry) => entry.id)).toEqual(["nim#personal"]);
    expect(lookupByEnvName("NVIDIA_API_KEY", options())?.value).toBe(FIRST_SECRET);
    expect(keystoreStatus(options())).toEqual({
      status: "degraded",
      droppedCount: 1,
      undecryptableCount: 0,
    });
  });

  it("drops a loaded entry whose credential id belongs to another provider", () => {
    const raw = seedTwoRows();
    raw.entries[1]!.provider = "anthropic";
    writeRaw(raw);

    expect(listEntries(options()).map((entry) => entry.id)).toEqual(["nim#personal"]);
    expect(keystoreStatus(options())).toEqual({
      status: "degraded",
      droppedCount: 1,
      undecryptableCount: 0,
    });
  });

  it("rejects a zero-length ciphertext at load", () => {
    const raw = seedTwoRows();
    raw.entries[1]!.ct = "";
    writeRaw(raw);

    expect(listEntries(options()).map((entry) => entry.id)).toEqual(["nim#personal"]);
    expect(lookupByEnvName("OPENAI_API_KEY", options())).toBeNull();
    expect(keystoreStatus(options())).toEqual({
      status: "degraded",
      droppedCount: 1,
      undecryptableCount: 0,
    });
  });

  it.each([
    ["corrupt JSON", "{"],
    ["null", "null"],
    ["array", "[]"],
    ["primitive", "42"],
  ])("reports a present %s document as unreadable, never fresh", (_name, serialized) => {
    writeFileSync(path, serialized, "utf8");

    expect(() => listEntries(options())).toThrow(KeystoreReadError);
    expect(() => lookupByEnvName("NVIDIA_API_KEY", options())).not.toThrow();
    expect(lookupByEnvName("NVIDIA_API_KEY", options())).toBeNull();
    expect(keystoreStatus(options())).toEqual({
      status: "unreadable",
      droppedCount: 0,
      undecryptableCount: 0,
    });
  });

  it("resolver reads return absent without throwing when the store does not exist", () => {
    expect(existsSync(path)).toBe(false);
    expect(() => lookupByEnvName("NVIDIA_API_KEY", options())).not.toThrow();
    expect(lookupByEnvName("NVIDIA_API_KEY", options())).toBeNull();
    expect(keystoreStatus(options())).toEqual({
      status: "absent",
      droppedCount: 0,
      undecryptableCount: 0,
    });
  });

  it("memoizes absence with one stat and zero reads per independent resolution", () => {
    const readFile = vi.fn((candidatePath: string) => readFileSync(candidatePath, "utf8"));
    const statFile = vi.fn((candidatePath: string) => {
      const { mtimeMs, size, ino } = statSync(candidatePath);
      return { mtimeMs, size, ino };
    });
    const counted = options({ readFile, statFile });

    for (let request = 0; request < 5; request += 1) {
      expect(lookupByEnvNames(["NVIDIA_API_KEY", "NIM_API_KEY"], counted)).toBeNull();
    }
    expect(statFile).toHaveBeenCalledTimes(5);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("recovers an unreadable store immediately when its stat token changes", () => {
    seedTwoRows();
    const validStore = readFileSync(path, "utf8");
    const readFile = vi.fn((candidatePath: string) => readFileSync(candidatePath, "utf8"));
    const statFile = vi.fn((candidatePath: string) => {
      const { mtimeMs, size, ino } = statSync(candidatePath);
      return { mtimeMs, size, ino };
    });
    const unreadableWalk = createKeystoreResolutionWalk();
    writeFileSync(path, "{", "utf8");

    expect(lookupByEnvName("NVIDIA_API_KEY", options({
      now: 0,
      readFile,
      statFile,
      resolutionWalk: unreadableWalk,
    }))).toBeNull();
    expect(keystoreStatus(options({
      now: 1,
      readFile,
      statFile,
      resolutionWalk: unreadableWalk,
    }))).toEqual({
      status: "unreadable",
      droppedCount: 0,
      undecryptableCount: 0,
    });
    expect(statFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(1);

    writeFileSync(path, validStore, "utf8");
    const repairedWalk = createKeystoreResolutionWalk();
    expect(lookupByEnvName("NVIDIA_API_KEY", options({
      now: 2,
      readFile,
      statFile,
      resolutionWalk: repairedWalk,
    }))?.value)
      .toBe(FIRST_SECRET);
    expect(keystoreStatus(options({
      now: 2,
      readFile,
      statFile,
      resolutionWalk: repairedWalk,
    }))).toEqual({
      status: "ok",
      droppedCount: 0,
      undecryptableCount: 0,
    });
    expect(statFile).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("retries a same-token transient read failure after 30 seconds without wall sleeps", () => {
    seedTwoRows();
    const observed = statSync(path);
    const statFile = vi.fn(() => ({
      mtimeMs: observed.mtimeMs,
      size: observed.size,
      ino: observed.ino,
    }));
    const readFile = vi.fn()
      .mockImplementationOnce((): never => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      })
      .mockImplementation((candidatePath: string) => readFileSync(candidatePath, "utf8"));
    const initialWalk = createKeystoreResolutionWalk();

    expect(lookupByEnvName("NVIDIA_API_KEY", options({
      now: 0,
      readFile,
      statFile,
      resolutionWalk: initialWalk,
    }))).toBeNull();
    const cooldownWalk = createKeystoreResolutionWalk();
    expect(lookupByEnvName("NVIDIA_API_KEY", options({
      now: 29_999,
      readFile,
      statFile,
      resolutionWalk: cooldownWalk,
    }))).toBeNull();
    expect(readFile).toHaveBeenCalledTimes(1);
    const retryWalk = createKeystoreResolutionWalk();
    expect(lookupByEnvName("NVIDIA_API_KEY", options({
      now: 30_000,
      readFile,
      statFile,
      resolutionWalk: retryWalk,
    }))?.value).toBe(FIRST_SECRET);
    expect(keystoreStatus(options({
      now: 30_000,
      readFile,
      statFile,
      resolutionWalk: retryWalk,
    }))).toEqual({ status: "ok", droppedCount: 0, undecryptableCount: 0 });
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(statFile).toHaveBeenCalledTimes(3);
  });

  it("treats ENOENT as fresh only when the store path entry is genuinely absent", () => {
    seedTwoRows();
    const before = readFileSync(path);
    lock({ path });
    const readFile = vi.fn((): string => {
      throw Object.assign(new Error(`missing ${FIRST_SECRET}`), { code: "ENOENT" });
    });
    const presentButUnreadable = options({ readFile });

    expect(lookupByEnvName("NVIDIA_API_KEY", presentButUnreadable)).toBeNull();
    expect(keystoreStatus(presentButUnreadable)).toEqual({
      status: "unreadable",
      droppedCount: 0,
      undecryptableCount: 0,
    });
    const error = captureError(() => addEntry({
      id: "anthropic#third",
      provider: "anthropic",
      envName: "ANTHROPIC_API_KEY",
      value: ATTEMPTED_SECRET,
    }, presentButUnreadable));
    expect(error).toBeInstanceOf(KeystoreMutationRefusedError);
    expect(error).toMatchObject({ status: "unreadable", droppedCount: 0 });
    expect(readFileSync(path)).toEqual(before);
    expectNoSecretLeaks(error, FIRST_SECRET, SECOND_SECRET, ATTEMPTED_SECRET);
  });

  it("resolver reads return unreadable without throwing for a directory at the store path", () => {
    mkdirSync(path);

    expect(() => lookupByEnvName("NVIDIA_API_KEY", options())).not.toThrow();
    expect(lookupByEnvName("NVIDIA_API_KEY", options())).toBeNull();
    expect(keystoreStatus(options())).toEqual({
      status: "unreadable",
      droppedCount: 0,
      undecryptableCount: 0,
    });
    expect(() => listEntries(options())).toThrow(KeystoreReadError);
    const mutationError = captureError(() => addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: ATTEMPTED_SECRET,
    }, options()));
    expect(mutationError).toBeInstanceOf(KeystoreMutationRefusedError);
  });

  it("surfaces a sanitized EACCES errno on metadata reads while resolver reads stay non-throwing", () => {
    const statFile = vi.fn((): never => {
      throw Object.assign(new Error(`denied ${FIRST_SECRET}`), { code: "EACCES" });
    });
    const denied = options({ statFile });

    expect(() => lookupByEnvName("NVIDIA_API_KEY", denied)).not.toThrow();
    expect(lookupByEnvName("NVIDIA_API_KEY", denied)).toBeNull();
    expect(keystoreStatus(denied)).toEqual({
      status: "unreadable",
      droppedCount: 0,
      undecryptableCount: 0,
    });
    const readError = captureError(() => listEntries(denied));
    expect(readError).toBeInstanceOf(KeystoreReadError);
    expect(readError.message).toBe("keystore read failed (EACCES)");
    expect(readError.message).not.toContain("denied");
    expectNoSecretLeaks(readError, FIRST_SECRET);

    const mutationError = captureError(() => addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: ATTEMPTED_SECRET,
    }, denied));
    expect(mutationError).toBeInstanceOf(KeystoreMutationRefusedError);
    expect(mutationError.message).toContain("EACCES");
    expect(mutationError.message).not.toContain("denied");
    expectNoSecretLeaks(mutationError, FIRST_SECRET, ATTEMPTED_SECRET);
    expect(existsSync(path)).toBe(false);
  });

  it("reports locked for missing and wrong passphrases while resolver reads never throw", () => {
    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, options());
    lock({ path });

    const missingPassphrase = { path } satisfies KeystoreOptions;
    expect(() => lookupByEnvName("NVIDIA_API_KEY", missingPassphrase)).not.toThrow();
    expect(lookupByEnvName("NVIDIA_API_KEY", missingPassphrase)).toBeNull();
    expect(keystoreStatus(missingPassphrase)).toEqual({
      status: "locked",
      droppedCount: 0,
      undecryptableCount: 0,
    });
    lock({ path });

    const wrongPassphrase = { ...options(), passphrase: "wrong passphrase" };
    expect(() => lookupByEnvName("NVIDIA_API_KEY", wrongPassphrase)).not.toThrow();
    expect(lookupByEnvName("NVIDIA_API_KEY", wrongPassphrase)).toBeNull();
    expect(keystoreStatus(wrongPassphrase)).toEqual({
      status: "locked",
      droppedCount: 0,
      undecryptableCount: 0,
    });
    lock({ path });

    expect(lookupByEnvName("NVIDIA_API_KEY", options())?.value).toBe(FIRST_SECRET);
    expect(keystoreStatus(options())).toEqual({
      status: "ok",
      droppedCount: 0,
      undecryptableCount: 0,
    });
  });

  it("lets explicit lock end an unlock cooldown and permits exactly one fresh unwrap", () => {
    const knownKek = Buffer.alloc(32, 0x42);
    const createSpawn = vi.fn<KeyringSpawnSync>(() => ({
      status: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: FIRST_SECRET,
    }, {
      path,
      mode: "libsecret",
      platform: "linux",
      spawnSync: createSpawn,
      randomBytes: (size) => Buffer.alloc(size, 0x42),
    });
    lock({ path });

    const retrySpawn = vi.fn<KeyringSpawnSync>()
      .mockReturnValueOnce({
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      })
      .mockReturnValue({
        status: 0,
        stdout: Buffer.from(`${knownKek.toString("base64")}\n`, "ascii"),
        stderr: Buffer.alloc(0),
      });
    const retryOptions: KeystoreOptions = {
      path,
      mode: "libsecret",
      platform: "linux",
      spawnSync: retrySpawn,
    };

    expect(lookupByEnvName("NVIDIA_API_KEY", { ...retryOptions, now: 0 })).toBeNull();
    expect(retrySpawn).toHaveBeenCalledTimes(1);
    lock({ path });
    expect(lookupByEnvName("NVIDIA_API_KEY", { ...retryOptions, now: 2 })?.value)
      .toBe(FIRST_SECRET);
    expect(keystoreStatus({ ...retryOptions, now: 2 })).toEqual({
      status: "ok",
      droppedCount: 0,
      undecryptableCount: 0,
    });
    expect(retrySpawn).toHaveBeenCalledTimes(2);
  });

  it("memoizes a failing keyring across two sequential credential resolutions and status", () => {
    const createSpawn = vi.fn<KeyringSpawnSync>(() => ({
      status: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: FIRST_SECRET,
    }, {
      path,
      mode: "libsecret",
      platform: "linux",
      spawnSync: createSpawn,
      randomBytes: () => Buffer.alloc(32, 0x42),
    });
    lock({ path });

    const failingSpawn = vi.fn<KeyringSpawnSync>(() => ({
      status: 1,
      stdout: Buffer.from("child-output-must-not-escape"),
      stderr: Buffer.from("child-error-must-not-escape"),
    }));
    const failingOptions: KeystoreOptions = {
      path,
      mode: "libsecret",
      platform: "linux",
      spawnSync: failingSpawn,
    };

    const first = resolveCredential("NVIDIA_API_KEY", {}, "nim", {
      ...failingOptions,
      now: 0,
    });
    const second = resolveCredential("NVIDIA_API_KEY", {}, "nim", {
      ...failingOptions,
      now: 59_999,
    });
    expect(first).toMatchObject({ state: "declared-missing", source: undefined });
    expect(second).toEqual(first);
    expect(keystoreStatus({ ...failingOptions, now: 59_999 })).toEqual({
      status: "locked",
      droppedCount: 0,
      undecryptableCount: 0,
    });
    expect(failingSpawn).toHaveBeenCalledTimes(1);
    expect(resolveCredential("NVIDIA_API_KEY", {}, "nim", {
      ...failingOptions,
      now: 60_000,
    })).toMatchObject({ state: "declared-missing", source: undefined });
    expect(resolveCredential("NVIDIA_API_KEY", {}, "nim", {
      ...failingOptions,
      now: 60_001,
    })).toMatchObject({ state: "declared-missing", source: undefined });
    expect(failingSpawn).toHaveBeenCalledTimes(2);
  });

  it("memoizes a successful keyring unwrap across later resolutions and status", () => {
    const knownKek = Buffer.alloc(32, 0x42);
    const createSpawn = vi.fn<KeyringSpawnSync>(() => ({
      status: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: FIRST_SECRET,
    }, {
      path,
      mode: "libsecret",
      platform: "linux",
      spawnSync: createSpawn,
      randomBytes: (size) => Buffer.alloc(size, 0x42),
    });
    lock({ path });

    const successfulSpawn = vi.fn<KeyringSpawnSync>(() => ({
      status: 0,
      stdout: Buffer.from(`${knownKek.toString("base64")}\n`, "ascii"),
      stderr: Buffer.alloc(0),
    }));
    const lookupOptions: KeystoreOptions = {
      path,
      mode: "libsecret",
      platform: "linux",
      spawnSync: successfulSpawn,
    };

    const first = resolveCredential("NVIDIA_API_KEY", {}, "nim", lookupOptions);
    const second = resolveCredential("NVIDIA_API_KEY", {}, "nim", lookupOptions);
    expect(first).toMatchObject({ state: "declared-present", value: FIRST_SECRET, source: "keystore" });
    expect(second).toEqual(first);
    expect(keystoreStatus(lookupOptions)).toEqual({
      status: "ok",
      droppedCount: 0,
      undecryptableCount: 0,
    });
    expect(successfulSpawn).toHaveBeenCalledTimes(1);
  });

  it("includes a non-secret filesystem errno in normalized write failures", () => {
    const obstruction = join(directory, "not-a-directory");
    writeFileSync(obstruction, "obstruction", "utf8");
    path = join(obstruction, "keystore.json");
    const statFile = vi.fn((): never => {
      // Statting the nested store reports ENOENT on Windows but ENOTDIR on Linux. Make
      // loadStore observe the store entry itself as absent on both; persistStore still uses the
      // real filesystem and fails when it tries to write through the regular-file parent.
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const error = captureError(() => addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: ATTEMPTED_SECRET,
    }, options({ statFile })));
    expect(error).toBeInstanceOf(KeystoreWriteError);
    expect(error.message).toMatch(/^keystore write failed \([A-Z][A-Z0-9_]*\)$/);
    expect(statFile).toHaveBeenCalledTimes(1);
    expectNoSecretLeaks(error, ATTEMPTED_SECRET);
  });

  it("does not poison a memoized parsed store when an existing-store write fails", () => {
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: FIRST_SECRET,
    }, options());
    expect(lookupByEnvName("NVIDIA_API_KEY", options())?.value).toBe(FIRST_SECRET);
    const before = readFileSync(path);
    const backupPath = join(directory, "keystore-before-failed-write.json");
    const statFile = vi.fn((candidatePath: string) => {
      const { mtimeMs, size, ino } = statSync(candidatePath);
      renameSync(candidatePath, backupPath);
      mkdirSync(candidatePath);
      return { mtimeMs, size, ino };
    });

    const error = captureError(() => rotateEntry(
      "nim#personal",
      ATTEMPTED_SECRET,
      options({ statFile }),
    ));
    expect(error).toBeInstanceOf(KeystoreWriteError);
    rmSync(path, { recursive: true, force: true });
    renameSync(backupPath, path);
    expect(readFileSync(path)).toEqual(before);
    expect(lookupByEnvName("NVIDIA_API_KEY", options())?.value).toBe(FIRST_SECRET);
    expect(statFile).toHaveBeenCalledTimes(1);
    expectNoSecretLeaks(readFileSync(path, "utf8"), ATTEMPTED_SECRET);
  });

  it("keeps lifecycle cleanup available when the KEK cannot be unwrapped", () => {
    addEntry({
      id: "nim#personal",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: FIRST_SECRET,
    }, options({ now: 100 }));
    lock({ path });
    const locked = { ...options(), passphrase: "wrong passphrase" };

    expect(setDisabled("nim#personal", true, locked).disabled).toBe(true);
    expect(revokeEntry("nim#personal", { ...locked, now: 200 }).revokedAt).toBe(200);
    expect(removeEntry("nim#personal", locked)).toBe(true);
    expect(listEntries(options())).toEqual([]);
  });

  it("rotates a revoked entry into a live replacement, re-enables it before expiry, then removes it", () => {
    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, options({ now: 100 }));
    revokeEntry("nim#personal", options({ now: 150 }));
    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 151 }))).toBeNull();

    const rotated = rotateEntry("nim#personal", SECOND_SECRET, options({
      now: 200,
      expiresAt: 500,
    }));
    expect(rotated.rotatedAt).toBe(200);
    expect(rotated.revokedAt).toBeNull();
    expect(listEntries(options())[0]?.revokedAt).toBeNull();
    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 300 }))?.value).toBe(SECOND_SECRET);

    setDisabled("nim#personal", true, options());
    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 400 }))).toBeNull();
    setDisabled("nim#personal", false, options());
    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 499 }))?.value).toBe(SECOND_SECRET);
    expect(lookupByEnvName("NVIDIA_API_KEY", options({ now: 500 }))).toBeNull();

    expectNoSecretLeaks(readFileSync(path, "utf8"), FIRST_SECRET, SECOND_SECRET);
    expect(removeEntry("nim#personal", options())).toBe(true);
    expect(listEntries(options())).toEqual([]);
  });

  it("rereads external lifecycle and ciphertext changes when the stat token changes", () => {
    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, options());
    expect(lookupByEnvName("NVIDIA_API_KEY", options())?.value).toBe(FIRST_SECRET);

    const disabled = readRaw();
    disabled.entries[0]!.disabled = true;
    writeRaw(disabled);
    utimesSync(path, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    expect(lookupByEnvName("NVIDIA_API_KEY", options())).toBeNull();

    const corrupted = readRaw();
    corrupted.entries[0]!.disabled = false;
    const ct = corrupted.entries[0]!.ct;
    corrupted.entries[0]!.ct = `${ct[0] === "A" ? "B" : "A"}${ct.slice(1)}`;
    writeRaw(corrupted);
    utimesSync(path, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    expect(lookupByEnvName("NVIDIA_API_KEY", options())).toBeNull();
    expect(keystoreStatus(options())).toEqual({
      status: "degraded",
      droppedCount: 1,
      undecryptableCount: 1,
    });
  });

  it("zeroizes the real cached KEK buffer on lock", () => {
    const kek = Buffer.alloc(32, 0x5a);
    const spawn = vi.fn<KeyringSpawnSync>(() => ({
      status: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
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

  it("computes the fingerprint from HMAC-SHA256(KEK, fpSalt || plaintext)", () => {
    const knownKek = Buffer.alloc(32, 0x5a);
    const spawn = vi.fn<KeyringSpawnSync>(() => ({
      status: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, {
      path,
      mode: "libsecret",
      spawnSync: spawn,
      randomBytes: () => Buffer.from(knownKek),
    });
    const raw = readRaw();
    const expected = createHmac("sha256", knownKek)
      .update(Buffer.from(raw.fpSalt, "base64"))
      .update(Buffer.from(FIRST_SECRET, "utf8"))
      .digest("hex")
      .slice(0, 8);

    expect(raw.entries[0]!.fingerprint).toBe(`hmac:${expected}`);
  });

  it("uses distinct persisted itemIds and OS item purposes for distinct stores with the same KEK", () => {
    const firstPath = join(directory, "first", "keystore.json");
    const secondPath = join(directory, "second", "keystore.json");
    const knownKek = Buffer.alloc(32, 0x42);
    const spawn = vi.fn<KeyringSpawnSync>(() => ({
      status: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    const osOptions = (storePath: string): KeystoreOptions => ({
      path: storePath,
      mode: "libsecret",
      spawnSync: spawn,
      randomBytes: () => Buffer.from(knownKek),
    });

    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, osOptions(firstPath));
    lock({ path: firstPath });
    addEntry({
      id: "openai#personal", provider: "openai", envName: "OPENAI_API_KEY", value: SECOND_SECRET,
    }, osOptions(secondPath));

    const firstRaw = JSON.parse(readFileSync(firstPath, "utf8")) as RawStore;
    const secondRaw = JSON.parse(readFileSync(secondPath, "utf8")) as RawStore;
    const firstPurpose = spawn.mock.calls[0]?.[1].at(-1);
    const secondPurpose = spawn.mock.calls[1]?.[1].at(-1);
    expect(firstRaw.itemId).not.toBe(secondRaw.itemId);
    expect(firstPurpose).toBe(`keystore-kek:keystore-${firstRaw.itemId}`);
    expect(secondPurpose).toBe(`keystore-kek:keystore-${secondRaw.itemId}`);
    expect(firstPurpose).not.toBe(secondPurpose);
  });

  it("changes the fingerprint with fpSalt without orphaning the dedicated OS itemId", () => {
    const knownKek = Buffer.alloc(32, 0x42);
    const spawn = vi.fn<KeyringSpawnSync>()
      .mockReturnValueOnce({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({
        status: 0,
        stdout: Buffer.from(`${knownKek.toString("base64")}\n`, "ascii"),
        stderr: Buffer.alloc(0),
      });
    const osOptions: KeystoreOptions = {
      path,
      mode: "libsecret",
      spawnSync: spawn,
      randomBytes: () => Buffer.from(knownKek),
    };

    const first = addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, osOptions);
    const original = readRaw();
    const originalItemId = original.itemId;
    const firstPurpose = spawn.mock.calls[0]?.[1].at(-1);
    removeEntry("nim#personal", osOptions);
    const empty = readRaw();
    empty.fpSalt = Buffer.alloc(32, 0x24).toString("base64");
    writeRaw(empty);
    lock({ path });

    const second = addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, osOptions);
    const rewritten = readRaw();
    const secondPurpose = spawn.mock.calls[1]?.[1].at(-1);

    expect(rewritten.itemId).toBe(originalItemId);
    expect(firstPurpose).toBe(`keystore-kek:keystore-${originalItemId}`);
    expect(secondPurpose).toBe(firstPurpose);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(lookupByEnvName("NVIDIA_API_KEY", osOptions)?.value).toBe(FIRST_SECRET);
  });

  it("threads the Windows ACL seam through writes and hardens a directory only when created", () => {
    const nestedDirectory = join(directory, "nested");
    path = join(nestedDirectory, "keystore.json");
    const spawnSync = vi.fn<SecretFileAclSpawnSync>(() => ({ status: 0, stdout: "" }));
    const acl = {
      platform: "win32" as const,
      ownerSid: OWNER_SID,
      systemRoot: "D:\\Windows",
      spawnSync,
    };

    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, options({ acl }));

    expect(spawnSync).toHaveBeenCalledTimes(3);
    const firstTemporaryPath = spawnSync.mock.calls[1]![1][0]!;
    expect(firstTemporaryPath).toContain(`.keystore.json.${process.pid}.`);
    expect(firstTemporaryPath).toMatch(/[0-9a-f]{24}\.tmp$/);
    expect(spawnSync.mock.calls).toEqual([
      [
        "D:\\Windows\\System32\\icacls.exe",
        [
          nestedDirectory,
          "/inheritance:r",
          "/grant:r",
          `*${OWNER_SID}:(OI)(CI)F`,
          "*S-1-5-18:(OI)(CI)F",
          "*S-1-5-32-544:(OI)(CI)F",
        ],
        CAPTURED_ACL_OPTIONS,
      ],
      [
        "D:\\Windows\\System32\\icacls.exe",
        [
          firstTemporaryPath,
          "/inheritance:r",
          "/grant:r",
          `*${OWNER_SID}:F`,
          "*S-1-5-18:F",
          "*S-1-5-32-544:F",
        ],
        CAPTURED_ACL_OPTIONS,
      ],
      [
        "D:\\Windows\\System32\\icacls.exe",
        [
          path,
          "/inheritance:r",
          "/grant:r",
          `*${OWNER_SID}:F`,
          "*S-1-5-18:F",
          "*S-1-5-32-544:F",
        ],
        CAPTURED_ACL_OPTIONS,
      ],
    ]);

    spawnSync.mockClear();
    addEntry({
      id: "openai#work", provider: "openai", envName: "OPENAI_API_KEY", value: SECOND_SECRET,
    }, options({ acl }));

    expect(spawnSync).toHaveBeenCalledTimes(2);
    const secondTemporaryPath = spawnSync.mock.calls[0]![1][0]!;
    expect(spawnSync.mock.calls).toEqual([
      [
        "D:\\Windows\\System32\\icacls.exe",
        [
          secondTemporaryPath,
          "/inheritance:r",
          "/grant:r",
          `*${OWNER_SID}:F`,
          "*S-1-5-18:F",
          "*S-1-5-32-544:F",
        ],
        CAPTURED_ACL_OPTIONS,
      ],
      [
        "D:\\Windows\\System32\\icacls.exe",
        [
          path,
          "/inheritance:r",
          "/grant:r",
          `*${OWNER_SID}:F`,
          "*S-1-5-18:F",
          "*S-1-5-32-544:F",
        ],
        CAPTURED_ACL_OPTIONS,
      ],
    ]);
  });

  it("redirects the default path under VITEST into a process-and-worker-specific temporary path", () => {
    const defaultPath = resolveKeystorePath();
    const pool = process.env.VITEST_POOL_ID ?? "pool";
    const worker = process.env.VITEST_WORKER_ID ?? "worker";
    const expectedDirectory = join(tmpdir(), `llm-relay-test-keystore-${process.pid}-${pool}-${worker}`);
    expect(process.env.VITEST).toBeDefined();
    expect(defaultPath).toContain(tmpdir());
    expect(defaultPath).toContain(String(process.pid));
    expect(defaultPath).not.toBe(join(homedir(), ".llm-relay", "keystore.json"));
    expect(dirname(defaultPath)).toBe(expectedDirectory);

    if (dirname(defaultPath) !== expectedDirectory) {
      throw new Error("unsafe VITEST keystore redirect");
    }
    try {
      addEntry({
        id: "nim#default", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
      }, { mode: "passphrase", passphrase: PASSPHRASE });
      expectNoSecretLeaks(readFileSync(defaultPath, "utf8"), FIRST_SECRET);
    } finally {
      lock({ path: defaultPath });
      rmSync(expectedDirectory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "persists a 0600 file inside a 0700 directory on POSIX",
    () => {
      addEntry({
        id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
      }, options());

      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    },
  );

  /**
   * ⚠ CLONE-12's extracted prologue documents its ORDER as a contract, and the order was entirely
   * uncovered before this test: moving the duplicate check to AFTER `unlockStoreForWrite` left
   * every other test in this file green. That order is what stops a REJECTED add from opening the
   * keyring — a custody prompt, or a custody error, for a write that was never going to happen.
   *
   * The wrong passphrase is the probe. `lock()` first drops the process-held KEK, so an unlock
   * would really run; then the error the caller actually receives says which check ran first.
   */
  it("rejects a duplicate entry before it opens the keystore for writing", () => {
    addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: FIRST_SECRET,
    }, options());
    lock({ path });

    expect(() => addEntry({
      id: "nim#personal", provider: "nim", envName: "NVIDIA_API_KEY", value: SECOND_SECRET,
    }, options({ passphrase: "not the passphrase" }))).toThrow(KeystoreEntryExistsError);
  });
});
