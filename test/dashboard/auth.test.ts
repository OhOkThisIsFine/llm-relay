import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DASHBOARD_ABSOLUTE_TTL_MS,
  DASHBOARD_BOOTSTRAP_TTL_MS,
  DASHBOARD_IDLE_TTL_MS,
  DASHBOARD_SCOPE,
  DASHBOARD_SESSION_HEADER,
  createDashboardAuthManager,
} from "../../src/dashboard-auth.js";

function entropySource(): (size: number) => Uint8Array {
  let next = 1;
  return (size) => {
    const bytes = new Uint8Array(size);
    bytes.fill(next);
    next = (next + 1) & 0xff;
    return bytes;
  };
}

describe("dashboard bootstrap and session authority", () => {
  it("uses 32 random bytes encoded as 43-character base64url values", () => {
    let requestedSize = 0;
    const auth = createDashboardAuthManager({
      randomBytes: (size) => {
        requestedSize = size;
        return new Uint8Array(size).fill(7);
      },
    });
    const bootstrap = auth.createBootstrap();
    expect(requestedSize).toBe(32);
    expect(bootstrap.bootstrap).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(bootstrap.bootstrap, "base64url")).toHaveLength(32);
  });

  it("exchanges a bootstrap once and identifies a replay separately", () => {
    const auth = createDashboardAuthManager({ clock: () => 10_000, randomBytes: entropySource() });
    const bootstrap = auth.createBootstrap();
    const session = auth.exchangeBootstrap(bootstrap.bootstrap);
    expect(session).toMatchObject({ ok: true, scope: DASHBOARD_SCOPE });
    if (!session.ok) throw new Error("expected session");
    expect(session.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(session.session, "base64url")).toHaveLength(32);
    expect(auth.exchangeBootstrap(bootstrap.bootstrap)).toEqual({
      ok: false,
      code: "replay",
      reason: "consumed",
    });
  });

  it("enforces bootstrap expiry at the exact boundary", () => {
    let now = 0;
    const auth = createDashboardAuthManager({ clock: () => now, randomBytes: entropySource() });
    const bootstrap = auth.createBootstrap();
    now = DASHBOARD_BOOTSTRAP_TTL_MS;
    expect(auth.exchangeBootstrap(bootstrap.bootstrap)).toMatchObject({
      ok: false,
      code: "invalid_auth",
    });
  });

  it("touches idle expiry while respecting the absolute expiry cap", () => {
    let now = 1_000;
    const auth = createDashboardAuthManager({
      clock: () => now,
      randomBytes: entropySource(),
      idleTtlMs: 10,
      absoluteTtlMs: 25,
    });
    const bootstrap = auth.createBootstrap();
    const exchanged = auth.exchangeBootstrap(bootstrap.bootstrap);
    if (!exchanged.ok) throw new Error("expected session");
    expect(exchanged.idleExpiresAt).toBe(1_010);
    expect(exchanged.absoluteExpiresAt).toBe(1_025);

    now = 1_008;
    const touched = auth.validateSession(exchanged.session);
    expect(touched).toMatchObject({ ok: true, idleExpiresAt: 1_018, absoluteExpiresAt: 1_025 });
    now = 1_017;
    const capped = auth.validateSession(exchanged.session);
    expect(capped).toMatchObject({ ok: true, idleExpiresAt: 1_025, absoluteExpiresAt: 1_025 });
    now = 1_025;
    expect(auth.validateSession(exchanged.session)).toMatchObject({ ok: false, code: "invalid_auth" });
  });

  it("rejects exactly at idle expiry when idle is shorter than absolute and cannot revive later", () => {
    let now = 1_000;
    const auth = createDashboardAuthManager({
      clock: () => now,
      randomBytes: entropySource(),
      idleTtlMs: 10,
      absoluteTtlMs: 100,
    });
    const bootstrap = auth.createBootstrap();
    const exchanged = auth.exchangeBootstrap(bootstrap.bootstrap);
    if (!exchanged.ok) throw new Error("expected session");
    expect(exchanged.idleExpiresAt).toBe(1_010);
    expect(exchanged.absoluteExpiresAt).toBe(1_100);

    now = exchanged.idleExpiresAt;
    expect(auth.validateSession(exchanged.session)).toMatchObject({
      ok: false,
      code: "invalid_auth",
      reason: "expired",
    });
    now += 1;
    expect(auth.validateSession(exchanged.session)).toMatchObject({
      ok: false,
      code: "invalid_auth",
    });
  });

  it("revokes on logout and keeps sessions independent", () => {
    const auth = createDashboardAuthManager({ clock: () => 5_000, randomBytes: entropySource() });
    const firstBootstrap = auth.createBootstrap();
    const secondBootstrap = auth.createBootstrap();
    const first = auth.exchangeBootstrap(firstBootstrap.bootstrap);
    const second = auth.exchangeBootstrap(secondBootstrap.bootstrap);
    if (!first.ok || !second.ok) throw new Error("expected sessions");
    expect(first.session).not.toBe(second.session);
    expect(auth.logout(first.session)).toEqual({ ok: true, revoked: true });
    expect(auth.validateSession(first.session)).toMatchObject({ ok: false, code: "invalid_auth" });
    expect(auth.validateSession(second.session)).toMatchObject({ ok: true, scope: DASHBOARD_SCOPE });
  });

  it("rejects malformed and wrong tokens without exposing secret material", () => {
    const auth = createDashboardAuthManager({ clock: () => 5_000, randomBytes: entropySource() });
    const wrong = "A".repeat(43);
    expect(auth.exchangeBootstrap(undefined)).toMatchObject({ ok: false, code: "invalid_auth" });
    expect(auth.exchangeBootstrap("not-a-token")).toMatchObject({ ok: false, code: "invalid_auth" });
    expect(auth.exchangeBootstrap(`${wrong}\n`)).toMatchObject({ ok: false, code: "invalid_auth", reason: "malformed" });
    expect(auth.exchangeBootstrap(wrong)).toMatchObject({ ok: false, code: "invalid_auth" });
  });

  it("keeps only digest and expiry fields in internal record shapes", () => {
    const source = readFileSync(new URL("../../src/dashboard-auth.ts", import.meta.url), "utf8");
    const fieldsFor = (name: string): string[] => {
      const body = source.match(new RegExp(`interface ${name} \\{([\\s\\S]*?)\\r?\\n\\}`))?.[1];
      expect(body, `${name} interface should remain explicit`).toBeDefined();
      return [...(body ?? "").matchAll(/^\s+(?:readonly\s+)?([A-Za-z][A-Za-z0-9_]*)\s*:/gm)]
        .map((match) => match[1] ?? "");
    };

    expect(fieldsFor("BootstrapRecord")).toEqual(["digest", "expiresAt"]);
    expect(fieldsFor("ConsumedBootstrapRecord")).toEqual(["digest", "expiresAt"]);
    expect(fieldsFor("SessionRecord")).toEqual(["digest", "absoluteExpiresAt", "idleExpiresAt"]);
    expect(source).not.toMatch(
      /interface (?:BootstrapRecord|ConsumedBootstrapRecord|SessionRecord)\s*\{[\s\S]*?^\s+(?:readonly\s+)?(?:bootstrap|session|token)\s*:\s*string/m,
    );
  });

  it("revokes all state when a new manager is created", () => {
    const clock = () => 8_000;
    const randomBytes = entropySource();
    const first = createDashboardAuthManager({ clock, randomBytes });
    const bootstrap = first.createBootstrap();
    const session = first.exchangeBootstrap(bootstrap.bootstrap);
    if (!session.ok) throw new Error("expected session");
    const restarted = createDashboardAuthManager({ clock, randomBytes });
    expect(restarted.exchangeBootstrap(bootstrap.bootstrap)).toMatchObject({ ok: false, code: "invalid_auth" });
    expect(restarted.validateSession(session.session)).toMatchObject({ ok: false, code: "invalid_auth" });
  });

  it("exports the exact session header and default expiry values", () => {
    expect(DASHBOARD_SESSION_HEADER).toBe("X-LLM-Relay-Dashboard-Session");
    expect(DASHBOARD_IDLE_TTL_MS).toBe(30 * 60_000);
    expect(DASHBOARD_ABSOLUTE_TTL_MS).toBe(8 * 60 * 60_000);
  });
});
