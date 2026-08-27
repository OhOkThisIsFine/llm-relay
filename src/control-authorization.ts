import { relayStatePath } from "./state-paths.js";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { restrictSecretFileOnWindows } from "./secret-file-acl.js";

/** Header carried by local CLI control requests. */
export const CONTROL_AUTHORIZATION_HEADER = "x-llm-relay-control-token";

/** Per-install capability file, relative to the relay config directory. */
export const CONTROL_AUTHORIZATION_FILENAME = "control-token";

const CAPABILITY_BYTES = 32;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVALID_CANDIDATE = "\0invalid-control-capability";
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/** Default config directory used when a Config was assembled in memory and has no sourcePath. */
export function defaultRelayConfigDir(): string {
  // ⚠ Under vitest, never touch the developer's real config directory.
  // Tests needing persistence pass an explicit `fallbackDir` to `resolveControlAuthorizationConfigDir`.
  if (process.env.VITEST) return join(tmpdir(), "llm-relay-vitest");
  return relayStatePath("config");
}

/**
 * Resolve the one install directory shared by the server and CLI.
 *
 * A loaded config's `sourcePath` wins, including an explicit relative `--config` path. In-memory
 * configs fall back to the standard per-user relay directory; callers/tests may inject a different
 * fallback without changing process globals.
 */
export function resolveControlAuthorizationConfigDir(
  sourcePath: string | undefined,
  fallbackDir: string = defaultRelayConfigDir(),
): string {
  return typeof sourcePath === "string" && sourcePath.trim().length > 0
    ? dirname(resolve(sourcePath))
    : resolve(fallbackDir);
}

export type ControlAuthorizationHeaders =
  | Readonly<Record<string, string | string[] | undefined>>
  | { get(name: string): string | null };

/**
 * The narrow dependency injected into request admission.
 *
 * Keeping only validation on the port means callers cannot obtain the installed capability from
 * an admission dependency. The file-backed implementation additionally has explicit CLI helpers.
 */
export interface ControlAuthorizationPort {
  validate(candidateToken: unknown): boolean;
}

export interface FileControlAuthorization extends ControlAuthorizationPort {
  readonly headerName: typeof CONTROL_AUTHORIZATION_HEADER;
  validateHeaders(headers: ControlAuthorizationHeaders | undefined): boolean;
  /** Return a new header record carrying the capability; the input is never mutated. */
  attach(headers?: Readonly<Record<string, string>>): Record<string, string>;
}

export class ControlAuthorizationError extends Error {
  constructor() {
    super("Control authorization is unavailable");
    this.name = "ControlAuthorizationError";
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "EEXIST";
}

function serializedCapability(token: string): string {
  return `${token}\n`;
}

function parseCapability(raw: string): string {
  // Deliberately do not trim: accepting surrounding bytes would give the file more than one
  // representation and could conceal partial/corrupt writes.
  if (raw.length !== 44 || raw[43] !== "\n") throw new ControlAuthorizationError();
  const token = raw.slice(0, 43);
  if (!CAPABILITY_PATTERN.test(token)) throw new ControlAuthorizationError();
  return token;
}

function restrictFile(path: string): void {
  if (process.platform === "win32") {
    restrictSecretFileOnWindows(path);
    return;
  }
  chmodSync(path, FILE_MODE);
}

function readInstalledCapability(path: string): string | undefined {
  try {
    if (!lstatSync(path).isFile()) throw new ControlAuthorizationError();
    restrictFile(path);
    return parseCapability(readFileSync(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    if (error instanceof ControlAuthorizationError) throw error;
    throw new ControlAuthorizationError();
  }
}

/**
 * Publish a fully-written candidate without replacing an existing winner.
 *
 * A hard link gives us the two properties rename alone cannot provide together: atomic visibility
 * and no overwrite. Concurrent starters therefore either publish their completed temporary file
 * or observe EEXIST and load the same winning capability.
 */
function publishCapability(configDir: string, targetPath: string, token: string): boolean {
  const suffix = randomBytes(12).toString("hex");
  const temporaryPath = join(configDir, `.${CONTROL_AUTHORIZATION_FILENAME}.${process.pid}.${suffix}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      FILE_MODE,
    );
    writeFileSync(descriptor, serializedCapability(token), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    restrictFile(temporaryPath);

    try {
      linkSync(temporaryPath, targetPath);
      restrictFile(targetPath);
      return true;
    } catch (error) {
      if (isAlreadyPresent(error)) return false;
      throw error;
    }
  } catch (error) {
    if (error instanceof ControlAuthorizationError) throw error;
    throw new ControlAuthorizationError();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The normalized failure below is more useful and cannot reveal capability material.
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // A restrictive, randomly-named leftover is preferable to masking a successfully published
      // capability. It contains the same secret and remains mode 0600 where modes are available.
    }
  }
}

function loadOrCreateCapability(configDir: string): string {
  try {
    mkdirSync(configDir, { recursive: true, mode: DIRECTORY_MODE });
  } catch {
    throw new ControlAuthorizationError();
  }

  const targetPath = join(configDir, CONTROL_AUTHORIZATION_FILENAME);
  // More than one iteration is only needed if another local process removes a race winner between
  // our EEXIST and read. Stay bounded and fail closed under persistent interference.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const installed = readInstalledCapability(targetPath);
    if (installed !== undefined) return installed;

    const candidate = randomBytes(CAPABILITY_BYTES).toString("base64url");
    if (publishCapability(configDir, targetPath, candidate)) return candidate;
  }
  throw new ControlAuthorizationError();
}

/** Read the configured control header from either WHATWG Headers or Node-style header records. */
export function readControlAuthorizationHeader(
  headers: ControlAuthorizationHeaders | undefined,
): string | undefined {
  if (!headers) return undefined;
  if ("get" in headers && typeof headers.get === "function") {
    const value = headers.get(CONTROL_AUTHORIZATION_HEADER);
    return value === null ? undefined : value;
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== CONTROL_AUTHORIZATION_HEADER) continue;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/** Fail closed when the injected port is unavailable or rejects the request header. */
export function validateControlAuthorization(
  authorization: ControlAuthorizationPort | undefined,
  headers: ControlAuthorizationHeaders | undefined,
): boolean {
  if (!authorization) return false;
  try {
    return authorization.validate(readControlAuthorizationHeader(headers));
  } catch {
    return false;
  }
}

/**
 * Synchronously load (or initialize) the per-install capability and return a closure-backed port.
 * No secret-bearing property is placed on the returned object, error, or serializable snapshot.
 * Repeated calls read the existing file; they never rotate or rewrite a valid capability.
 */
export function createControlAuthorization(configDir: string): FileControlAuthorization {
  const capability = loadOrCreateCapability(configDir);
  const expectedDigest = createHash("sha256").update(capability, "utf8").digest();

  const validate = (candidateToken: unknown): boolean => {
    // Hash before comparing so timingSafeEqual always receives two fixed-size values. In
    // particular, wrong-length candidates do not take an observable early-return branch.
    const candidate = typeof candidateToken === "string" ? candidateToken : INVALID_CANDIDATE;
    const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
    const equal = timingSafeEqual(expectedDigest, candidateDigest);
    return typeof candidateToken === "string" && equal;
  };

  return Object.freeze({
    headerName: CONTROL_AUTHORIZATION_HEADER,
    validate,
    validateHeaders: (headers: ControlAuthorizationHeaders | undefined) =>
      validate(readControlAuthorizationHeader(headers)),
    attach: (headers: Readonly<Record<string, string>> = {}) => {
      const attached: Record<string, string> = {};
      // Avoid a differently-cased duplicate being comma-joined by fetch's Headers implementation.
      for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() !== CONTROL_AUTHORIZATION_HEADER) attached[name] = value;
      }
      attached[CONTROL_AUTHORIZATION_HEADER] = capability;
      return attached;
    },
  });
}
