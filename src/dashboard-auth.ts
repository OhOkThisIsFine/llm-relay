import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

/** Header carrying a short-lived, read-only dashboard session. */
export const DASHBOARD_SESSION_HEADER = "X-LLM-Relay-Dashboard-Session" as const;

export const DASHBOARD_SCOPE = "dashboard:read" as const;
export const DASHBOARD_BOOTSTRAP_TTL_MS = 60_000;
export const DASHBOARD_IDLE_TTL_MS = 30 * 60_000;
export const DASHBOARD_ABSOLUTE_TTL_MS = 8 * 60 * 60_000;

const TOKEN_BYTES = 32;
const TOKEN_LENGTH = 43;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_BYTES = 32;
const INVALID_TOKEN = "\0invalid-dashboard-token";

export type DashboardAuthFailureReason = "missing" | "malformed" | "wrong" | "expired";
export type DashboardAuthErrorCode = "invalid_auth" | "replay";

export interface DashboardAuthFailure {
  readonly ok: false;
  readonly code: DashboardAuthErrorCode;
  readonly reason: DashboardAuthFailureReason | "consumed";
}

export interface DashboardBootstrap {
  readonly ok: true;
  readonly bootstrap: string;
  readonly expiresAt: number;
}

export interface DashboardSession {
  readonly ok: true;
  readonly session: string;
  readonly scope: typeof DASHBOARD_SCOPE;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

export interface DashboardSessionValidation {
  readonly ok: true;
  readonly scope: typeof DASHBOARD_SCOPE;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

export interface DashboardLogout {
  readonly ok: true;
  readonly revoked: true;
}

export type DashboardBootstrapResult = DashboardSession | DashboardAuthFailure;
export type DashboardSessionResult = DashboardSessionValidation | DashboardAuthFailure;
export type DashboardLogoutResult = DashboardLogout | DashboardAuthFailure;

export interface DashboardAuthOptions {
  /** Milliseconds since Unix epoch. Injected clocks make boundary tests deterministic. */
  readonly clock?: () => number;
  /** Return exactly `size` cryptographically random bytes. */
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly bootstrapTtlMs?: number;
  readonly idleTtlMs?: number;
  readonly absoluteTtlMs?: number;
}

interface BootstrapRecord {
  readonly digest: Buffer;
  readonly expiresAt: number;
}

interface ConsumedBootstrapRecord {
  readonly digest: Buffer;
  readonly expiresAt: number;
}

interface SessionRecord {
  readonly digest: Buffer;
  readonly absoluteExpiresAt: number;
  idleExpiresAt: number;
}

function digestToken(candidate: unknown): Buffer {
  // Hash every candidate, including malformed and wrong-length values, so the comparison below
  // always receives a fixed-size digest. The token itself is never retained in a record.
  const value = typeof candidate === "string" ? candidate : INVALID_TOKEN;
  return createHash("sha256").update(value, "utf8").digest();
}

function validTokenShape(candidate: unknown): boolean {
  return typeof candidate === "string" && candidate.length === TOKEN_LENGTH && TOKEN_PATTERN.test(candidate);
}

function validTtl(value: number | undefined, fallback: number): number {
  const ttl = value ?? fallback;
  if (!Number.isFinite(ttl) || !Number.isInteger(ttl) || ttl <= 0) {
    throw new RangeError("Dashboard auth TTL must be a positive integer");
  }
  return ttl;
}

function nowFrom(clock: () => number): number {
  const now = clock();
  if (!Number.isFinite(now)) throw new RangeError("Dashboard auth clock must return a finite number");
  return now;
}

function randomToken(random: (size: number) => Uint8Array): string {
  const bytes = random(TOKEN_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== TOKEN_BYTES) {
    throw new RangeError("Dashboard auth random source returned an invalid byte count");
  }
  const encoded = Buffer.from(bytes).toString("base64url");
  // This is an invariant of 32-byte base64url encoding; retaining the check guards test seams
  // and future changes to the entropy source.
  if (encoded.length !== TOKEN_LENGTH || !TOKEN_PATTERN.test(encoded)) {
    throw new RangeError("Dashboard auth random source returned invalid entropy");
  }
  return encoded;
}

function digestEquals(left: Buffer, right: Buffer): boolean {
  // Both values are SHA-256 digests. Keep this guard for a defensive fixed-length invariant;
  // callers never use an early-return for user-controlled token length.
  if (left.length !== DIGEST_BYTES || right.length !== DIGEST_BYTES) return false;
  return timingSafeEqual(left, right);
}

function failure(reason: DashboardAuthFailureReason | "consumed"): DashboardAuthFailure {
  return Object.freeze({
    ok: false as const,
    code: reason === "consumed" ? "replay" as const : "invalid_auth" as const,
    reason,
  });
}

/**
 * Synchronous, in-memory bootstrap/session authority for the analytics dashboard.
 *
 * Only SHA-256 token digests are retained. A new instance starts with no records, so process
 * restart naturally revokes all outstanding bootstraps and sessions.
 */
export class DashboardAuthManager {
  readonly #clock: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #bootstrapTtlMs: number;
  readonly #idleTtlMs: number;
  readonly #absoluteTtlMs: number;
  readonly #bootstraps = new Set<BootstrapRecord>();
  readonly #consumedBootstraps = new Set<ConsumedBootstrapRecord>();
  readonly #sessions = new Set<SessionRecord>();

  constructor(options: DashboardAuthOptions = {}) {
    this.#clock = options.clock ?? (() => Date.now());
    this.#randomBytes = options.randomBytes ?? ((size) => nodeRandomBytes(size));
    this.#bootstrapTtlMs = validTtl(options.bootstrapTtlMs, DASHBOARD_BOOTSTRAP_TTL_MS);
    this.#idleTtlMs = validTtl(options.idleTtlMs, DASHBOARD_IDLE_TTL_MS);
    this.#absoluteTtlMs = validTtl(options.absoluteTtlMs, DASHBOARD_ABSOLUTE_TTL_MS);
  }

  /** Issue a one-time bootstrap capability for the control-authorized launcher. */
  createBootstrap(): DashboardBootstrap {
    const now = nowFrom(this.#clock);
    this.cleanup(now);
    const bootstrap = randomToken(this.#randomBytes);
    const record: BootstrapRecord = {
      digest: digestToken(bootstrap),
      expiresAt: now + this.#bootstrapTtlMs,
    };
    this.#bootstraps.add(record);
    return Object.freeze({ ok: true as const, bootstrap, expiresAt: record.expiresAt });
  }

  /** Exchange a live bootstrap exactly once for a read-only dashboard session. */
  exchangeBootstrap(candidate: unknown): DashboardBootstrapResult {
    const now = nowFrom(this.#clock);
    const candidateDigest = digestToken(candidate);
    const active = this.#findBootstrap(candidateDigest);
    if (active) {
      this.#bootstraps.delete(active);
      if (now >= active.expiresAt) {
        this.cleanup(now);
        return failure("expired");
      }

      this.cleanup(now);

      // Keep the digest briefly so a second exchange has a distinct replay outcome. It is
      // removed at the original expiry and never contains the raw bootstrap value.
      this.#consumedBootstraps.add({ digest: active.digest, expiresAt: active.expiresAt });
      const session = this.#issueSession(now);
      return session;
    }

    const consumed = this.#findConsumedBootstrap(candidateDigest);
    if (consumed) {
      if (now < consumed.expiresAt) {
        this.cleanup(now);
        return failure("consumed");
      }
      this.cleanup(now);
      return failure("expired");
    }
    this.cleanup(now);
    return failure(validTokenShape(candidate) ? "wrong" : typeof candidate === "string" ? "malformed" : "missing");
  }

  /** Validate and touch a session's idle expiry, never extending its absolute expiry. */
  validateSession(candidate: unknown): DashboardSessionResult {
    const now = nowFrom(this.#clock);
    const candidateDigest = digestToken(candidate);
    const record = this.#findSession(candidateDigest);
    if (!record) {
      this.cleanup(now);
      return failure(validTokenShape(candidate) ? "wrong" : typeof candidate === "string" ? "malformed" : "missing");
    }
    if (now >= record.absoluteExpiresAt || now >= record.idleExpiresAt) {
      this.#sessions.delete(record);
      this.cleanup(now);
      return failure("expired");
    }

    this.cleanup(now);
    record.idleExpiresAt = Math.min(now + this.#idleTtlMs, record.absoluteExpiresAt);
    return Object.freeze({
      ok: true as const,
      scope: DASHBOARD_SCOPE,
      idleExpiresAt: record.idleExpiresAt,
      absoluteExpiresAt: record.absoluteExpiresAt,
    });
  }

  /** Revoke the addressed session. Invalid candidates fail closed without revealing state. */
  logout(candidate: unknown): DashboardLogoutResult {
    const now = nowFrom(this.#clock);
    const candidateDigest = digestToken(candidate);
    const record = this.#findSession(candidateDigest);
    if (!record) {
      this.cleanup(now);
      return failure(validTokenShape(candidate) ? "wrong" : typeof candidate === "string" ? "malformed" : "missing");
    }
    if (now >= record.absoluteExpiresAt || now >= record.idleExpiresAt) {
      this.#sessions.delete(record);
      this.cleanup(now);
      return failure("expired");
    }
    this.cleanup(now);
    this.#sessions.delete(record);
    return Object.freeze({ ok: true as const, revoked: true as const });
  }

  /** Remove expired records; safe to call at request boundaries or on a periodic timer. */
  cleanup(at: number = nowFrom(this.#clock)): void {
    for (const record of this.#bootstraps) if (at >= record.expiresAt) this.#bootstraps.delete(record);
    for (const record of this.#consumedBootstraps) {
      if (at >= record.expiresAt) this.#consumedBootstraps.delete(record);
    }
    for (const record of this.#sessions) {
      if (at >= record.absoluteExpiresAt || at >= record.idleExpiresAt) this.#sessions.delete(record);
    }
  }

  #findBootstrap(candidateDigest: Buffer): BootstrapRecord | undefined {
    let match: BootstrapRecord | undefined;
    for (const record of this.#bootstraps) {
      if (digestEquals(candidateDigest, record.digest)) match = record;
    }
    return match;
  }

  #findConsumedBootstrap(candidateDigest: Buffer): ConsumedBootstrapRecord | undefined {
    let match: ConsumedBootstrapRecord | undefined;
    for (const record of this.#consumedBootstraps) {
      if (digestEquals(candidateDigest, record.digest)) match = record;
    }
    return match;
  }

  #findSession(candidateDigest: Buffer): SessionRecord | undefined {
    let match: SessionRecord | undefined;
    for (const record of this.#sessions) {
      if (digestEquals(candidateDigest, record.digest)) match = record;
    }
    return match;
  }

  #issueSession(now: number): DashboardSession {
    const session = randomToken(this.#randomBytes);
    const record: SessionRecord = {
      digest: digestToken(session),
      idleExpiresAt: Math.min(now + this.#idleTtlMs, now + this.#absoluteTtlMs),
      absoluteExpiresAt: now + this.#absoluteTtlMs,
    };
    this.#sessions.add(record);
    return Object.freeze({
      ok: true as const,
      session,
      scope: DASHBOARD_SCOPE,
      idleExpiresAt: record.idleExpiresAt,
      absoluteExpiresAt: record.absoluteExpiresAt,
    });
  }
}

export function createDashboardAuthManager(options: DashboardAuthOptions = {}): DashboardAuthManager {
  return new DashboardAuthManager(options);
}
