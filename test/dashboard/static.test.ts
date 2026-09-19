import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardStaticHandler, getProductionDashboardAssetRoot, type DashboardManifest } from "../../src/dashboard-static.js";

const roots: string[] = [];

function fixture(manifest: DashboardManifest = {
  "index.html": { file: "assets/main-abcdefgh.js", imports: ["chunk.js"], css: ["assets/main-abcdefgh.css"], assets: ["assets/logo-abcdefgh.svg"] },
  "chunk.js": { file: "assets/chunk-abcdefgh.js" },
}) {
  const root = mkdtempSync(join(tmpdir(), "llm-relay-dashboard-"));
  roots.push(root);
  const assets = join(root, "assets");
  mkdirSync(assets);
  writeFileSync(join(root, "index.html"), "<!doctype html><script src=\"/dashboard/assets/main-abcdefgh.js\"></script>");
  writeFileSync(join(assets, "main-abcdefgh.js"), "console.log('main')");
  writeFileSync(join(assets, "chunk-abcdefgh.js"), "console.log('chunk')");
  writeFileSync(join(assets, "main-abcdefgh.css"), "body{} ");
  writeFileSync(join(assets, "logo-abcdefgh.svg"), "<svg/>");
  return { root, handler: createDashboardStaticHandler({ assetRoot: root, manifest }) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("dashboard static resolver", () => {
  it("redirects canonically and serves shell/assets with cache and security headers", () => {
    const { handler } = fixture();
    const redirect = handler.handle({ method: "GET", path: "/dashboard" });
    expect(redirect).toMatchObject({ handled: true, status: 308, headers: { Location: "/dashboard/", "Cache-Control": "no-store", "Content-Length": "0" } });
    const shell = handler.handle({ method: "GET", path: "/dashboard/" });
    expect(shell).toMatchObject({ handled: true, status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (!shell.handled || shell.status !== 200) throw new Error("expected shell");
    expect(shell.body?.toString()).toContain("doctype html");
    expect(shell.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(shell.headers["Content-Security-Policy"]).toContain("style-src 'self'");
    expect(shell.headers["Content-Security-Policy"]).not.toContain("'unsafe-inline'");
    expect(shell.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(shell.headers["X-Frame-Options"]).toBe("DENY");
    expect(shell.headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(shell.headers["Permissions-Policy"]).toContain("camera=()");
    expect(shell.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(shell.headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(shell.headers["Set-Cookie"]).toBeUndefined();
    const asset = handler.handle({ method: "GET", path: "/dashboard/assets/main-abcdefgh.js" });
    expect(asset).toMatchObject({ handled: true, status: 200, headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" } });
  });

  it("makes HEAD byte-identical in status/headers without a body", () => {
    const { handler } = fixture();
    const get = handler.handle({ method: "GET", path: "/dashboard/assets/main-abcdefgh.css" });
    const head = handler.handle({ method: "HEAD", path: "/dashboard/assets/main-abcdefgh.css" });
    expect(head).toEqual({ handled: true, status: 200, headers: (get as { headers: Record<string, string> }).headers });
    expect("body" in head).toBe(false);
  });

  it("serves only the manifest closure and does not become an SPA catch-all", () => {
    const { handler } = fixture();
    expect(handler.handle({ method: "GET", path: "/dashboard/assets/chunk-abcdefgh.js" })).toMatchObject({ status: 200 });
    expect(handler.handle({ method: "GET", path: "/dashboard/assets/not-listed.js" })).toMatchObject({ handled: true, status: 404 });
    expect(handler.handle({ method: "GET", path: "/dashboard/assets" })).toEqual({ handled: false });
    expect(handler.handle({ method: "GET", path: "/dashboard/assetsfoo.js" })).toEqual({ handled: false });
    expect(handler.handle({ method: "GET", path: "/dashboard/unknown" })).toEqual({ handled: false });
    expect(handler.handle({ method: "GET", path: "/dashboard/api/v1/snapshot" })).toEqual({ handled: false });
    expect(handler.handle({ method: "GET", path: "/v1/messages" })).toEqual({ handled: false });
  });

  it("fails closed for shell when manifest is missing, corrupt, cyclic, or broken", () => {
    const { root } = fixture();
    const shell = (handler: ReturnType<typeof createDashboardStaticHandler>) => handler.handle({ method: "GET", path: "/dashboard/" });
    expect(shell(createDashboardStaticHandler({ assetRoot: root }))).toMatchObject({ handled: true, status: 404 });
    expect(shell(createDashboardStaticHandler({ assetRoot: root, manifest: { "index.html": { file: "../outside.js" } } }))).toMatchObject({ handled: true, status: 404 });
    expect(shell(createDashboardStaticHandler({ assetRoot: root, manifest: {
      "index.html": { file: "assets/main.js", imports: ["chunk.js"] },
      "chunk.js": { file: "assets/chunk.js", imports: ["index.html"] },
    } }))).toMatchObject({ handled: true, status: 404 });
    expect(shell(createDashboardStaticHandler({ assetRoot: root, manifest: {
      "index.html": { file: "assets/main.js", imports: ["missing.js"] },
    } }))).toMatchObject({ handled: true, status: 404 });
    // Cross-cycle: index -> A,B; A -> B; B -> A.  A global visited set can
    // incorrectly hide this when B is reached before its back-edge is seen.
    expect(shell(createDashboardStaticHandler({ assetRoot: root, manifest: {
      "index.html": { file: "assets/main.js", imports: ["a.js", "b.js"] },
      "a.js": { file: "assets/a.js", imports: ["b.js"] },
      "b.js": { file: "assets/b.js", imports: ["a.js"] },
    } }))).toMatchObject({ handled: true, status: 404 });
  });

  it("rejects malformed, encoded, traversal, query, separator, and case variants", () => {
    const { handler } = fixture();
    for (const path of [
      "/dashboard/assets/../index.html",
      "/dashboard/assets/%2e%2e/index.html",
      "/dashboard/assets/%2Fmain.js",
      "/dashboard/assets/main%2Ejs",
      "/dashboard/assets/main.js?x=1",
      "/dashboard/assets/main.js#x",
      "/dashboard/assets//main.js",
      "/dashboard/assets/MAIN.js",
    ]) expect(handler.handle({ method: "GET", path })).toMatchObject({ handled: true, status: 404 });
    expect(handler.handle({ method: "GET", path: "/dashboard/assets\\main.js" })).toEqual({ handled: false });
  });

  it("uses explicit method descriptors and fails closed for corrupt/unknown MIME entries", () => {
    const { handler } = fixture({ "index.html": { file: "assets/main.bin" } });
    expect(handler.handle({ method: "POST", path: "/dashboard" })).toMatchObject({ handled: true, status: 405, headers: { Allow: "GET" } });
    expect(handler.handle({ method: "POST", path: "/dashboard/" })).toMatchObject({ handled: true, status: 405, headers: { Allow: "GET, HEAD" } });
    expect(handler.handle({ method: "GET", path: "/dashboard/assets/main.bin" })).toMatchObject({ handled: true, status: 404 });
    const corrupt = fixture({ "index.html": { file: "../outside.js" } });
    expect(corrupt.handler.handle({ method: "GET", path: "/dashboard/assets/main.js" })).toMatchObject({ handled: true, status: 404 });
  });

  it("rejects an otherwise-valid manifest closure with an unhashed artifact", () => {
    const { root } = fixture();
    const handler = createDashboardStaticHandler({ assetRoot: root, manifest: {
      "index.html": { file: "assets/main.js" },
    } });
    expect(handler.handle({ method: "GET", path: "/dashboard/" })).toMatchObject({ handled: true, status: 404 });
  });

  it("rejects a symlink that escapes the injected root when the platform permits symlinks", () => {
    const { root } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "llm-relay-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "escape.js"), "escape");
    try {
      symlinkSync(join(outside, "escape.js"), join(root, "assets", "escape-abcdefgh.js"));
    } catch {
      return;
    }
    const escaping = createDashboardStaticHandler({ assetRoot: root, manifest: { "index.html": { file: "assets/escape-abcdefgh.js" } } });
    expect(escaping.handle({ method: "GET", path: "/dashboard/assets/escape-abcdefgh.js" })).toMatchObject({ handled: true, status: 404 });
  });

  it("dynamically reloads the manifest when updated on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-relay-dashboard-reload-"));
    roots.push(root);
    const viteDir = join(root, ".vite");
    const assetsDir = join(root, "assets");
    mkdirSync(viteDir);
    mkdirSync(assetsDir);
    const manifestPath = join(viteDir, "manifest.json");

    writeFileSync(join(root, "index.html"), "<!doctype html><script src=\"/dashboard/assets/v1-abcdefgh.js\"></script>");
    writeFileSync(join(assetsDir, "v1-abcdefgh.js"), "console.log('v1')");
    writeFileSync(manifestPath, JSON.stringify({
      "index.html": { file: "assets/v1-abcdefgh.js" },
    }));

    const handler = createDashboardStaticHandler({ assetRoot: root, manifestPath });
    expect(handler.handle({ method: "GET", path: "/dashboard/assets/v1-abcdefgh.js" })).toMatchObject({ status: 200 });

    // Update manifest and asset on disk (simulating a dashboard rebuild)
    writeFileSync(join(assetsDir, "v2-12345678.js"), "console.log('v2')");
    writeFileSync(manifestPath, JSON.stringify({
      "index.html": { file: "assets/v2-12345678.js" },
    }));

    // The handler should dynamically pick up the new asset without restarting
    expect(handler.handle({ method: "GET", path: "/dashboard/assets/v2-12345678.js" })).toMatchObject({ status: 200 });
  });

  it("resolves the production dashboard beside the compiled module", () => {
    const moduleDirectory = dirname(fileURLToPath(new URL("../../src/dashboard-static.ts", import.meta.url)));
    expect(getProductionDashboardAssetRoot()).toBe(resolve(moduleDirectory, "dashboard"));
  });
});
