import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dashboard = join(root, "dist", "dashboard");
const graph = readJson(join(dashboard, ".vite", "dashboard-bundle-graph.json"));
const inventory = readJson(join(root, "docs", "dashboard-bundle-inventory.json"));
const baseline = readJson(join(root, "docs", "dashboard-package-baseline.json"));
const manifest = readJson(join(dashboard, ".vite", "manifest.json"));
const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  throw new Error(`dashboard package check: ${message}`);
}

function assertPackage(value, label) {
  if (
    typeof value !== "object" || value === null ||
    typeof value.packagePath !== "string" ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    typeof value.license !== "string" ||
    !value.packagePath.startsWith("node_modules/") ||
    value.packagePath.includes("\\") ||
    value.packagePath.includes("..")
  ) {
    fail(`${label} is not a portable resolved package record`);
  }
}

function canonicalPackages(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((entry, index) => {
    assertPackage(entry, `${label}[${index}]`);
    return { packagePath: entry.packagePath, name: entry.name, version: entry.version, license: entry.license };
  }).sort((left, right) => left.packagePath.localeCompare(right.packagePath));
}

function canonicalVirtualModules(value, label) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) fail(`${label} must be an array of module IDs`);
  return [...value].sort();
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} differs from the production Vite/Rollup module graph`);
  }
}

if (graph.schemaVersion !== 1 || inventory.schemaVersion !== 1) fail("unsupported inventory schema version");
const graphPackages = canonicalPackages(graph.packages, "generated graph packages");
const inventoryPackages = canonicalPackages(inventory.packages, "checked inventory packages");
assertEqual(inventoryPackages, graphPackages, "checked package inventory");

const graphVirtualModules = canonicalVirtualModules(graph.virtualModules, "generated graph virtual modules");
if (!Array.isArray(inventory.virtualRuntime)) fail("checked virtual-runtime inventory must be an array");
const inventoryVirtualModules = inventory.virtualRuntime.map((entry, index) => {
  if (typeof entry !== "object" || entry === null || typeof entry.moduleId !== "string" || typeof entry.kind !== "string") {
    fail(`checked virtual-runtime inventory[${index}] is invalid`);
  }
  assertPackage(entry.attribution, `checked virtual-runtime inventory[${index}].attribution`);
  return entry.moduleId;
}).sort();
assertEqual(inventoryVirtualModules, graphVirtualModules, "checked virtual-runtime inventory");

if (!Array.isArray(inventory.generatedAssets)) fail("checked generated-asset inventory must be an array");
const generatedAssetAttributions = inventory.generatedAssets.map((entry, index) => {
  if (
    typeof entry !== "object"
    || entry === null
    || typeof entry.assetKind !== "string"
    || typeof entry.source !== "string"
  ) {
    fail(`checked generated-asset inventory[${index}] is invalid`);
  }
  assertPackage(entry.attribution, `checked generated-asset inventory[${index}].attribution`);
  return entry.attribution;
});
const tailwindCss = inventory.generatedAssets.find((entry) => entry.attribution?.name === "tailwindcss");
if (
  tailwindCss?.source !== "dashboard/src/styles.css"
  || !tailwindCss.assetKind.includes("Tailwind-generated CSS")
) {
  fail("Tailwind-generated CSS must retain its explicit asset attribution");
}

const commonjsHelper = inventory.virtualRuntime.find((entry) => entry.moduleId === "commonjsHelpers.js");
if (graphVirtualModules.includes("commonjsHelpers.js") && (
  commonjsHelper?.attribution?.name !== "vite"
  || !commonjsHelper.kind.includes("@rollup/plugin-commonjs")
)) {
  fail("commonjsHelpers.js must retain its Vite-embedded @rollup/plugin-commonjs attribution");
}

for (const expected of [
  ...inventoryPackages,
  ...inventory.virtualRuntime.map((entry) => entry.attribution),
  ...generatedAssetAttributions,
]) {
  const packageJson = readJson(join(root, expected.packagePath, "package.json"));
  if (packageJson.name !== expected.name || packageJson.version !== expected.version || packageJson.license !== expected.license) {
    fail(`installed metadata differs for ${expected.packagePath}`);
  }
  if (!notices.includes(`${expected.name}@${expected.version}`)) {
    fail(`missing third-party notice for ${expected.name}@${expected.version}`);
  }
}

const requiredNotices = ["Tailwind Labs, Inc."];
if (inventoryPackages.some((entry) => entry.name === "lodash")) {
  requiredNotices.push("Jeremy Ashkenas", "DocumentCloud", "Investigative Reporters & Editors");
}
if (graphVirtualModules.includes("commonjsHelpers.js")) requiredNotices.push("@rollup/plugin-commonjs");
for (const requiredNotice of requiredNotices) {
  if (!notices.includes(requiredNotice)) fail(`missing required third-party attribution: ${requiredNotice}`);
}

const hash = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u;
const assets = new Set();
for (const entry of Object.values(manifest)) {
  for (const asset of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]) {
    if (!hash.test(asset)) fail(`manifest asset is not content-hashed: ${asset}`);
    assets.add(asset);
  }
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

const files = listFiles(dashboard);
const sizes = { jsBytes: 0, cssBytes: 0, htmlBytes: 0, manifestBytes: 0 };
for (const file of files) {
  const size = statSync(file).size;
  const dashboardPath = relative(dashboard, file).replace(/\\/gu, "/");
  if (dashboardPath.endsWith(".js")) sizes.jsBytes += size;
  if (dashboardPath.endsWith(".css")) sizes.cssBytes += size;
  if (dashboardPath.endsWith(".html")) sizes.htmlBytes += size;
  if (dashboardPath === ".vite/manifest.json") sizes.manifestBytes += size;
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;
const runNpm = (args) => npmCli
  ? execFileSync(process.execPath, [npmCli, ...args], { cwd: root, encoding: "utf8" })
  : execFileSync(npm, args, { cwd: root, encoding: "utf8", shell: process.platform === "win32" });

function normalizePackRecord(value) {
  const record = Array.isArray(value)
    ? value.length === 1 ? value[0] : null
    : value;
  if (typeof record !== "object" || record === null) return null;
  const wrapped = record.llm_relay ?? record["llm-relay"];
  return typeof wrapped === "object" && wrapped !== null ? wrapped : record;
}

// npm 10/11 returns a one-element array while npm 12 may key the record by
// package name. Keep CI/publish portability inside the packaging gate itself.
const packShapeFixture = { size: 1, unpackedSize: 2, entryCount: 3 };
for (const shape of [
  [packShapeFixture],
  { llm_relay: packShapeFixture },
  { "llm-relay": packShapeFixture },
]) {
  if (normalizePackRecord(shape) !== packShapeFixture) fail("npm pack result normalizer rejected a supported shape");
}

const dryRun = JSON.parse(runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"]));
const packed = normalizePackRecord(dryRun);
if (!packed || !Number.isInteger(packed.size) || !Number.isInteger(packed.unpackedSize) || !Number.isInteger(packed.entryCount)) {
  fail("npm pack dry-run did not report package metrics");
}

const observed = {
  dashboardFiles: files.length,
  dashboardRawBytes: files.reduce((sum, file) => sum + statSync(file).size, 0),
  ...sizes,
  packBytes: packed.size,
  unpackedBytes: packed.unpackedSize,
  packageEntries: packed.entryCount,
};
const observedMetricKeys = [
  "dashboardFiles",
  "dashboardRawBytes",
  "jsBytes",
  "cssBytes",
  "htmlBytes",
  "manifestBytes",
  "packBytes",
  "unpackedBytes",
  "packageEntries",
];
const exactMetricKeys = [
  "dashboardFiles",
  "dashboardRawBytes",
  "jsBytes",
  "cssBytes",
  "htmlBytes",
  "manifestBytes",
];
const ceilingMetricKeys = ["dashboardRawBytes", "packBytes", "unpackedBytes", "packageEntries"];

function assertMetricRecord(value, label, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail(`${label} must contain exactly ${keys.join(", ")}`);
  }
  for (const key of keys) {
    if (!Number.isFinite(value[key]) || !Number.isInteger(value[key]) || value[key] < 0) {
      fail(`${label}.${key} must be a non-negative integer`);
    }
  }
}

assertMetricRecord(baseline.observed, "baseline observed metrics", observedMetricKeys);
assertMetricRecord(baseline.ceilings, "baseline ceilings", ceilingMetricKeys);
if (JSON.stringify(baseline.exactMetrics) !== JSON.stringify(exactMetricKeys)) {
  fail(`baseline exactMetrics must be ${exactMetricKeys.join(", ")}`);
}
// Tarball bytes and entry metadata can vary across supported npm majors. They
// remain measured and ceiling-ratcheted, while built asset facts stay exact.
for (const field of exactMetricKeys) {
  const value = observed[field];
  if (baseline.observed[field] !== value) fail(`observed ${field} is ${value}, baseline records ${baseline.observed[field]}`);
}
for (const [field, ceiling] of Object.entries(baseline.ceilings ?? {})) {
  if (typeof ceiling !== "number" || observed[field] > ceiling) fail(`${field} ${observed[field]} exceeds ceiling ${ceiling}`);
}

console.log(JSON.stringify({ assets: assets.size, ...observed }, null, 2));
