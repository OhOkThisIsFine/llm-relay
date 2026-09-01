import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;
const npmEnvironment = { ...process.env };
delete npmEnvironment.npm_config_allow_scripts;
const runNpm = (args, cwd) => npmCli
  ? execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8", env: npmEnvironment })
  : execFileSync(npm, args, { cwd, encoding: "utf8", env: npmEnvironment, shell: process.platform === "win32" });
const temp = mkdtempSync(join(tmpdir(), "llm-relay-packed-dashboard-"));
try {
  const packedJson = JSON.parse(runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", temp], root));
  const packed = Array.isArray(packedJson) ? packedJson[0] : packedJson?.["llm-relay"];
  if (!packed || typeof packed.filename !== "string") throw new Error("npm pack did not return one tarball");
  const tarball = join(temp, packed.filename);
  writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true }), "utf8");
  // --prefer-offline, not --offline: a fresh CI runner's npm cache has nothing for this tarball's
  // runtime deps, and --offline is ENOTCACHED there. The smoke proves the TARBALL is complete, not that the registry is unreachable.
  runNpm(["install", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund", tarball], temp);
  const installed = join(temp, "node_modules", "llm-relay");
  for (const required of ["LICENSE", "THIRD_PARTY_NOTICES.md", "docs/dashboard-bundle-inventory.json", "dist/dashboard/index.html", "dist/dashboard/.vite/manifest.json"]) {
    if (!existsSync(join(installed, required))) throw new Error(`packed file missing: ${required}`);
  }
  const { createDashboardStaticHandler, getProductionDashboardAssetRoot } = await import(pathToFileURL(join(installed, "dist", "dashboard-static.js")).href);
  const assetRoot = getProductionDashboardAssetRoot();
  assert.equal(assetRoot, resolve(installed, "dist", "dashboard"), "installed production dashboard root must resolve beside dashboard-static.js");
  assert.ok(existsSync(assetRoot), "installed production dashboard root must exist");
  const handler = createDashboardStaticHandler({ assetRoot, manifestPath: join(assetRoot, ".vite", "manifest.json") });
  const shell = handler.handle({ method: "GET", path: "/dashboard/" });
  if (!shell.handled || shell.status !== 200 || shell.headers["Cache-Control"] !== "no-store") throw new Error("packed shell did not serve safely");
  assert.ok(shell.body, "packed shell GET must return the installed index body");
  assert.equal(shell.headers["Content-Length"], String(shell.body.byteLength), "packed shell length must describe its body");
  const head = handler.handle({ method: "HEAD", path: "/dashboard/" });
  if (!head.handled || head.status !== 200 || "body" in head) throw new Error("packed shell HEAD contract failed");
  const manifest = JSON.parse(readFileSync(join(assetRoot, ".vite", "manifest.json"), "utf8"));
  const manifestOwnedUrls = new Set();
  for (const entry of Object.values(manifest)) for (const asset of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]) {
    assert.match(asset, /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u, `packed manifest artifact must be content-hashed: ${asset}`);
    const name = asset.replace(/^assets\//u, "");
    const url = `/dashboard/assets/${name}`;
    manifestOwnedUrls.add(url);
    const response = handler.handle({ method: "GET", path: url });
    if (!response.handled || response.status !== 200 || response.headers["Cache-Control"] !== "public, max-age=31536000, immutable" || !response.headers["Content-Type"]) throw new Error(`packed asset failed: ${asset}`);
  }
  const scriptUrls = [];
  const stylesheetUrls = [];
  for (const match of shell.body.toString("utf8").matchAll(/<(script|link)\b[^>]*>/giu)) {
    const tag = match[0];
    const attributes = new Map(
      [...tag.matchAll(/\b([A-Za-z][A-Za-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)]
        .map((attribute) => [attribute[1].toLowerCase(), attribute[2] ?? attribute[3]]),
    );
    if (match[1].toLowerCase() === "script") {
      assert.ok(attributes.has("src"), "packed dashboard must not contain an inline script");
      scriptUrls.push(attributes.get("src"));
    } else if ((attributes.get("rel") ?? "").toLowerCase().split(/\s+/u).includes("stylesheet")) {
      assert.ok(attributes.has("href"), "packed dashboard stylesheet link must have href");
      stylesheetUrls.push(attributes.get("href"));
    }
  }
  assert.ok(scriptUrls.length > 0, "packed index must reference at least one script");
  assert.ok(stylesheetUrls.length > 0, "packed index must reference at least one stylesheet");
  for (const [kind, urls] of [["script", scriptUrls], ["stylesheet", stylesheetUrls]]) for (const url of urls) {
    assert.equal(typeof url, "string", `packed ${kind} URL must be a string`);
    assert.match(url, /^\/dashboard\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u, `packed ${kind} must use /dashboard/assets: ${url}`);
    assert.ok(manifestOwnedUrls.has(url), `packed ${kind} must be owned by the manifest: ${url}`);
    const response = handler.handle({ method: "GET", path: url });
    assert.ok(response.handled && response.status === 200 && response.body && response.body.byteLength > 0, `packed ${kind} URL must fetch: ${url}`);
    assert.equal(response.headers["Content-Length"], String(response.body.byteLength), `packed ${kind} length must describe its body: ${url}`);
    assert.match(response.headers["Content-Type"] ?? "", kind === "script" ? /javascript/u : /^text\/css/u, `packed ${kind} must have the expected MIME type: ${url}`);
  }
  const missing = handler.handle({ method: "GET", path: "/dashboard/assets/not-in-manifest.js" });
  if (!missing.handled || missing.status !== 404) throw new Error("packed manifest closure leaked");
  console.log(`packed dashboard smoke passed: ${packed.filename}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
