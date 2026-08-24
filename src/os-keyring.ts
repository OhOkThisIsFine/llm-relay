import { randomBytes as nodeRandomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join, win32 } from "node:path";
import { windowsSystem32Executable } from "./secret-file-acl.js";

const KEK_BYTES = 32;
const SCRYPT_SALT_BYTES = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const KEYCHAIN_ACCOUNT = "llm-relay";
const KEYCHAIN_SERVICE = "llm-relay-keystore-kek";
const LIBSECRET_LABEL = "llm-relay KEK";
const KEYRING_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,96}$/;
const BASE64_ALPHABET = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", "ascii");
const BASE64_REVERSE = new Int16Array(256).fill(-1);
for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
  BASE64_REVERSE[BASE64_ALPHABET[index]!] = index;
}

const DPAPI_WRAP_SCRIPT = [
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

const DPAPI_UNWRAP_SCRIPT = [
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

export type KekWrapMode = "dpapi" | "keychain" | "libsecret" | "passphrase";
export type OsKekWrapMode = Exclude<KekWrapMode, "passphrase">;

export interface ScryptKdfDescriptor {
  n: 16384;
  r: 8;
  p: 1;
  salt: string;
}

/** Shape persisted as the keystore's `kek` block. */
export interface KekDescriptor {
  wrap: KekWrapMode;
  /** Present only for DPAPI. */
  blob?: string;
  /** Present only for passphrase mode. */
  kdf?: ScryptKdfDescriptor;
}

export interface KeyringSpawnSyncOptions {
  windowsHide: true;
  stdio: "pipe";
  encoding: "buffer";
  input?: Buffer;
}

export interface KeyringSpawnSyncResult {
  status: number | null;
  stdout?: Buffer | Uint8Array | string | null;
  stderr?: Buffer | Uint8Array | string | null;
  error?: Error | undefined;
}

/** Captured-stdio synchronous spawn seam; no child error object may escape its caller. */
export type KeyringSpawnSync = (
  command: string,
  args: string[],
  options: KeyringSpawnSyncOptions,
) => KeyringSpawnSyncResult;

export type KeyringCommandExists = (command: string, env: NodeJS.ProcessEnv) => boolean;
export type KeyringRandomBytes = (size: number) => Buffer;

export interface KeyringOptions {
  mode?: KekWrapMode;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Caller-owned; this module never mutates or zeroizes it. */
  passphrase?: string | Buffer;
  spawnSync?: KeyringSpawnSync;
  commandExists?: KeyringCommandExists;
  randomBytes?: KeyringRandomBytes;
  /** Non-secret stable identifier for one keystore's OS-held item. */
  keyId?: string;
}

export interface WrapKekOptions extends Omit<KeyringOptions, "mode" | "passphrase"> {
  mode?: OsKekWrapMode;
}

export class KeyringUnavailableError extends Error {
  constructor() {
    super("No supported OS keyring or passphrase is available");
    this.name = "KeyringUnavailableError";
  }
}

export class KeyringPassphraseRequiredError extends Error {
  constructor() {
    super("Passphrase mode requires a non-empty passphrase");
    this.name = "KeyringPassphraseRequiredError";
  }
}

/** Resolve Windows PowerShell 5.1 without consulting PATH. */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot?.trim() || env.SYSTEMROOT?.trim() || "";
  return windowsSystem32Executable(
    win32.join("WindowsPowerShell", "v1.0", "powershell.exe"),
    systemRoot,
  );
}

function keyringId(keyId?: string): string {
  const value = keyId ?? KEYCHAIN_ACCOUNT;
  if (!KEYRING_ID_PATTERN.test(value)) throw new Error("invalid keyring identifier");
  return value;
}

function keyringPurpose(keyId?: string): string {
  return keyId === undefined ? "keystore-kek" : `keystore-kek:${keyringId(keyId)}`;
}

/** Pure argv builders. Secret material is deliberately not accepted as an argument. */
export function dpapiWrapArgv(): string[] {
  return ["-NoProfile", "-NonInteractive", "-Command", DPAPI_WRAP_SCRIPT];
}

export function dpapiUnwrapArgv(): string[] {
  return ["-NoProfile", "-NonInteractive", "-Command", DPAPI_UNWRAP_SCRIPT];
}

export function keychainStoreArgv(): string[] {
  return ["-i"];
}

export function keychainLoadArgv(keyId?: string): string[] {
  return [
    "find-generic-password",
    "-a",
    keyringId(keyId),
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ];
}

export function libsecretStoreArgv(keyId?: string): string[] {
  return [
    "store",
    `--label=${LIBSECRET_LABEL}`,
    "application",
    "llm-relay",
    "purpose",
    keyringPurpose(keyId),
  ];
}

export function libsecretLoadArgv(keyId?: string): string[] {
  return ["lookup", "application", "llm-relay", "purpose", keyringPurpose(keyId)];
}

/** PATH lookup used only to select Linux libsecret versus passphrase mode; it never spawns. */
export function commandExistsOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const path = env.PATH;
  if (!path) return false;
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    try {
      accessSync(join(directory, command), fsConstants.X_OK);
      return true;
    } catch {
      // Keep searching. Absence is the branch signal, not an exceptional condition.
    }
  }
  return false;
}

const spawnCaptured: KeyringSpawnSync = (command, args, options) => {
  // Unit tests must inject a captured-stdio seam. Never let an omitted double reach a real
  // OS credential store (most critically, a macOS Keychain write).
  if (process.env.VITEST !== undefined) throw new KeyringUnavailableError();
  return nodeSpawnSync(command, args, options);
};

type KeyringOperation = "wrap" | "unwrap";
type FailureClass = "descriptor" | "exit" | "input" | "kdf" | "launch" | "output";

function keyringFailure(operation: KeyringOperation, classification: FailureClass): Error {
  return new Error(`keyring ${operation} failed: ${classification}`);
}

function capturedOutput(value: KeyringSpawnSyncResult["stdout"]): Buffer {
  // A real spawnSync Buffer becomes caller-owned so its KEK bytes can be zeroized directly.
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.alloc(0);
}

function wipeCaptured(value: KeyringSpawnSyncResult["stdout"] | KeyringSpawnSyncResult["stderr"]): void {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) value.fill(0);
}

function runCaptured(
  operation: KeyringOperation,
  command: string,
  args: string[],
  input: Buffer | undefined,
  spawn: KeyringSpawnSync,
): Buffer {
  const baseOptions = {
    windowsHide: true as const,
    stdio: "pipe" as const,
    encoding: "buffer" as const,
  };
  const options: KeyringSpawnSyncOptions = input === undefined
    ? baseOptions
    : { ...baseOptions, input };

  let result: KeyringSpawnSyncResult;
  try {
    result = spawn(command, args, options);
  } catch (error) {
    if (error instanceof KeyringUnavailableError) throw new KeyringUnavailableError();
    // Never retain a child error as cause: child messages commonly contain argv and stdio.
    throw keyringFailure(operation, "launch");
  }

  let childError: Error | undefined;
  let status: number | null;
  let stdout: KeyringSpawnSyncResult["stdout"];
  let stderr: KeyringSpawnSyncResult["stderr"];
  try {
    childError = result.error;
    status = result.status;
    stdout = result.stdout;
    stderr = result.stderr;
  } catch {
    throw keyringFailure(operation, "launch");
  }
  if (childError !== undefined || status !== 0) {
    wipeCaptured(stdout);
    wipeCaptured(stderr);
    throw keyringFailure(operation, childError !== undefined ? "launch" : "exit");
  }
  try {
    const output = capturedOutput(stdout);
    if (!Buffer.isBuffer(stdout)) wipeCaptured(stdout);
    wipeCaptured(stderr);
    return output;
  } catch {
    wipeCaptured(stdout);
    wipeCaptured(stderr);
    throw keyringFailure(operation, "output");
  }
}

function isNonEmptyPassphrase(passphrase: string | Buffer | undefined): passphrase is string | Buffer {
  return typeof passphrase === "string" ? passphrase.length > 0 : Buffer.isBuffer(passphrase) && passphrase.length > 0;
}

function encodeBase64Bytes(value: Buffer): Buffer {
  const output = Buffer.alloc(Math.ceil(value.length / 3) * 4);
  let source = 0;
  let target = 0;
  while (source < value.length) {
    const remaining = value.length - source;
    const first = value[source++]!;
    const second = remaining > 1 ? value[source++]! : 0;
    const third = remaining > 2 ? value[source++]! : 0;
    output[target++] = BASE64_ALPHABET[first >>> 2]!;
    output[target++] = BASE64_ALPHABET[((first & 0x03) << 4) | (second >>> 4)]!;
    output[target++] = remaining > 1
      ? BASE64_ALPHABET[((second & 0x0f) << 2) | (third >>> 6)]!
      : 0x3d;
    output[target++] = remaining > 2 ? BASE64_ALPHABET[third & 0x3f]! : 0x3d;
  }
  return output;
}

function encodeSecretForLineInput(kek: Buffer): Buffer {
  // secret-tool reads until EOF; no newline is included in the stored secret.
  return encodeBase64Bytes(kek);
}

function encodeKeychainStoreInput(kek: Buffer, keyId?: string): Buffer {
  const prefix = Buffer.from(
    `add-generic-password -a ${keyringId(keyId)} -s ${KEYCHAIN_SERVICE} -U -w `,
    "ascii",
  );
  const encoded = encodeBase64Bytes(kek);
  try {
    return Buffer.concat([prefix, encoded, Buffer.from("\n", "ascii")]);
  } finally {
    encoded.fill(0);
  }
}

function decodeCanonicalBase64(value: string): Buffer | undefined {
  if (value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

function decodeLineSecret(output: Buffer, operation: KeyringOperation): Buffer {
  let end = output.length;
  if (end > 0 && output[end - 1] === 0x0a) end -= 1;
  if (end > 0 && output[end - 1] === 0x0d) end -= 1;
  const serialized = output.subarray(0, end);
  if (serialized.length === 0 || serialized.length % 4 !== 0) {
    throw keyringFailure(operation, "output");
  }
  const padding = serialized.at(-1) === 0x3d ? (serialized.at(-2) === 0x3d ? 2 : 1) : 0;
  const decoded = Buffer.alloc((serialized.length / 4) * 3 - padding);
  let target = 0;
  for (let source = 0; source < serialized.length; source += 4) {
    const last = source + 4 === serialized.length;
    const a = BASE64_REVERSE[serialized[source]!] ?? -1;
    const b = BASE64_REVERSE[serialized[source + 1]!] ?? -1;
    const cByte = serialized[source + 2]!;
    const dByte = serialized[source + 3]!;
    const c = cByte === 0x3d && last ? 0 : (BASE64_REVERSE[cByte] ?? -1);
    const d = dByte === 0x3d && last ? 0 : (BASE64_REVERSE[dByte] ?? -1);
    const validPadding = (!last && cByte !== 0x3d && dByte !== 0x3d)
      || (last && padding === 0 && cByte !== 0x3d && dByte !== 0x3d)
      || (last && padding === 1 && cByte !== 0x3d && dByte === 0x3d && (c & 0x03) === 0)
      || (last && padding === 2 && cByte === 0x3d && dByte === 0x3d && (b & 0x0f) === 0);
    if (a < 0 || b < 0 || c < 0 || d < 0 || !validPadding) {
      decoded.fill(0);
      throw keyringFailure(operation, "output");
    }
    if (target < decoded.length) decoded[target++] = (a << 2) | (b >>> 4);
    if (target < decoded.length) decoded[target++] = ((b & 0x0f) << 4) | (c >>> 2);
    if (target < decoded.length) decoded[target++] = ((c & 0x03) << 6) | d;
  }
  if (decoded.length !== KEK_BYTES) {
    decoded.fill(0);
    throw keyringFailure(operation, "output");
  }
  return decoded;
}

function validateKek(kek: Buffer): void {
  if (!Buffer.isBuffer(kek) || kek.length !== KEK_BYTES) {
    throw keyringFailure("wrap", "input");
  }
}

function selectMode(options: KeyringOptions): KekWrapMode {
  if (options.mode !== undefined) return options.mode;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return "dpapi";
  if (platform === "darwin") return "keychain";
  if (platform === "linux") {
    const env = options.env ?? process.env;
    const commandExists = options.commandExists ?? commandExistsOnPath;
    if (commandExists("secret-tool", env)) return "libsecret";
    if (isNonEmptyPassphrase(options.passphrase)) return "passphrase";
  }
  throw new KeyringUnavailableError();
}

/**
 * Wrap/store an existing random KEK in an OS facility.
 *
 * Passphrase mode is intentionally absent: its exact v1 format has only KDF parameters and no
 * encrypted blob, so `createPassphraseKek` derives the KEK instead of pretending to wrap one.
 */
export function wrapKek(kek: Buffer, options: WrapKekOptions = {}): KekDescriptor {
  validateKek(kek);
  const mode = options.mode ?? selectMode(options);
  const spawn = options.spawnSync ?? spawnCaptured;

  if (mode === "dpapi") {
    const output = runCaptured(
      "wrap",
      windowsPowerShellPath(options.env),
      dpapiWrapArgv(),
      kek,
      spawn,
    );
    if (output.length === 0) {
      output.fill(0);
      throw keyringFailure("wrap", "output");
    }
    return { wrap: "dpapi", blob: output.toString("base64") };
  }

  if (mode === "keychain") {
    // SecurityTool's direct add form requires `-w <password>` in the child argv. Interactive mode
    // parses the same bounded command from stdin, keeping the base64 KEK out of the process table.
    const input = encodeKeychainStoreInput(kek, options.keyId);
    try {
      const output = runCaptured("wrap", "security", keychainStoreArgv(), input, spawn);
      output.fill(0);
    } finally {
      input.fill(0);
    }
    return { wrap: "keychain" };
  }

  const input = encodeSecretForLineInput(kek);
  try {
    const output = runCaptured("wrap", "secret-tool", libsecretStoreArgv(options.keyId), input, spawn);
    output.fill(0);
  } finally {
    input.fill(0);
  }
  return { wrap: "libsecret" };
}

function validKdf(kdf: ScryptKdfDescriptor | undefined): kdf is ScryptKdfDescriptor {
  return kdf?.n === 16384
    && kdf.r === 8
    && kdf.p === 1
    && decodeCanonicalBase64(kdf.salt)?.length === SCRYPT_SALT_BYTES;
}

/** Derive one 256-bit KEK without changing caller-owned passphrase bytes. */
export function derivePassphraseKek(
  passphrase: string | Buffer,
  kdf: ScryptKdfDescriptor,
): Buffer {
  if (!isNonEmptyPassphrase(passphrase) || !validKdf(kdf)) {
    throw keyringFailure("unwrap", "kdf");
  }
  const salt = decodeCanonicalBase64(kdf.salt);
  if (!salt) throw keyringFailure("unwrap", "kdf");
  try {
    return scryptSync(passphrase, salt, KEK_BYTES, {
      N: kdf.n,
      r: kdf.r,
      p: kdf.p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    throw keyringFailure("unwrap", "kdf");
  }
}

export function createPassphraseKek(
  passphrase: string | Buffer,
  options: { randomBytes?: KeyringRandomBytes } = {},
): { kek: Buffer; descriptor: KekDescriptor } {
  if (!isNonEmptyPassphrase(passphrase)) throw new KeyringPassphraseRequiredError();
  const salt = (options.randomBytes ?? nodeRandomBytes)(SCRYPT_SALT_BYTES);
  if (!Buffer.isBuffer(salt) || salt.length !== SCRYPT_SALT_BYTES) {
    throw keyringFailure("wrap", "kdf");
  }
  const kdf: ScryptKdfDescriptor = {
    n: 16384,
    r: 8,
    p: 1,
    salt: salt.toString("base64"),
  };
  try {
    return { kek: derivePassphraseKek(passphrase, kdf), descriptor: { wrap: "passphrase", kdf } };
  } finally {
    salt.fill(0);
  }
}

/** Create a KEK using the selected platform custody mechanism. */
export function createKek(options: KeyringOptions = {}): {
  kek: Buffer;
  descriptor: KekDescriptor;
} {
  const mode = selectMode(options);
  if (mode === "passphrase") {
    if (!isNonEmptyPassphrase(options.passphrase)) throw new KeyringPassphraseRequiredError();
    return createPassphraseKek(
      options.passphrase,
      options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes },
    );
  }

  const kek = (options.randomBytes ?? nodeRandomBytes)(KEK_BYTES);
  if (!Buffer.isBuffer(kek) || kek.length !== KEK_BYTES) {
    throw keyringFailure("wrap", "input");
  }
  try {
    const wrapOptions: WrapKekOptions = { mode };
    if (options.platform !== undefined) wrapOptions.platform = options.platform;
    if (options.env !== undefined) wrapOptions.env = options.env;
    if (options.spawnSync !== undefined) wrapOptions.spawnSync = options.spawnSync;
    if (options.commandExists !== undefined) wrapOptions.commandExists = options.commandExists;
    if (options.randomBytes !== undefined) wrapOptions.randomBytes = options.randomBytes;
    if (options.keyId !== undefined) wrapOptions.keyId = options.keyId;
    return {
      kek,
      descriptor: wrapKek(kek, wrapOptions),
    };
  } catch (error) {
    kek.fill(0);
    throw error;
  }
}

/** Lazily recover a KEK. The returned Buffer is owned by the caller. */
export function unwrapKek(descriptor: KekDescriptor, options: KeyringOptions = {}): Buffer {
  const spawn = options.spawnSync ?? spawnCaptured;

  if (descriptor.wrap === "dpapi") {
    if (descriptor.kdf !== undefined || typeof descriptor.blob !== "string") {
      throw keyringFailure("unwrap", "descriptor");
    }
    const blob = decodeCanonicalBase64(descriptor.blob);
    if (!blob) throw keyringFailure("unwrap", "descriptor");
    const output = runCaptured(
      "unwrap",
      windowsPowerShellPath(options.env),
      dpapiUnwrapArgv(),
      blob,
      spawn,
    );
    if (output.length !== KEK_BYTES) {
      output.fill(0);
      throw keyringFailure("unwrap", "output");
    }
    return output;
  }

  if (descriptor.wrap === "keychain") {
    if (descriptor.blob !== undefined || descriptor.kdf !== undefined) {
      throw keyringFailure("unwrap", "descriptor");
    }
    const output = runCaptured("unwrap", "security", keychainLoadArgv(options.keyId), undefined, spawn);
    try {
      return decodeLineSecret(output, "unwrap");
    } finally {
      output.fill(0);
    }
  }

  if (descriptor.wrap === "libsecret") {
    if (descriptor.blob !== undefined || descriptor.kdf !== undefined) {
      throw keyringFailure("unwrap", "descriptor");
    }
    const output = runCaptured("unwrap", "secret-tool", libsecretLoadArgv(options.keyId), undefined, spawn);
    try {
      return decodeLineSecret(output, "unwrap");
    } finally {
      output.fill(0);
    }
  }

  if (descriptor.wrap === "passphrase") {
    if (descriptor.blob !== undefined || !validKdf(descriptor.kdf)) {
      throw keyringFailure("unwrap", "descriptor");
    }
    if (!isNonEmptyPassphrase(options.passphrase)) throw new KeyringPassphraseRequiredError();
    return derivePassphraseKek(options.passphrase, descriptor.kdf);
  }

  throw keyringFailure("unwrap", "descriptor");
}

/** Constant-time helper for tests and callers that verify a passphrase-derived round trip. */
export function sameKek(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
