/**
 * The tokenless, static portion of the analytics dashboard.
 *
 * This module intentionally has no HTTP-server dependency.  It turns a method
 * and raw request target into a small response descriptor which a route layer
 * can write to a Node response.  Keeping the filesystem boundary here makes
 * it difficult for a future catch-all route to accidentally serve the SPA.
 */
import { isRecord } from "./json-shape.js";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DASHBOARD_STATIC_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
export const DASHBOARD_STATIC_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": DASHBOARD_STATIC_CSP,
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
});

const DEFAULT_MANIFEST_LIMIT = 4 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 4_096;
const MAX_MANIFEST_ARRAY = 512;
const MAX_MANIFEST_STRING = 1_024;
const MAX_CLOSURE_ENTRIES = 4_096;
const MAX_CLOSURE_DEPTH = 128;
const MAX_TARGET_LENGTH = 8_192;

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".cjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
});

export interface DashboardManifestEntry {
  readonly file: string;
  readonly src?: string;
  readonly name?: string;
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly css?: readonly string[];
  readonly assets?: readonly string[];
}

export type DashboardManifest = Readonly<Record<string, DashboardManifestEntry>>;

export interface DashboardStaticOptions {
  /** Directory containing index.html, assets, and the Vite manifest. */
  readonly assetRoot: string;
  /** Parsed Vite manifest, or a path to one. */
  readonly manifest?: DashboardManifest | string;
  /** Optional manifest path; useful when `manifest` is omitted. */
  readonly manifestPath?: string;
  /** Maximum manifest file size when loading from disk. */
  readonly maxManifestBytes?: number;
}

export interface DashboardStaticRequest {
  readonly method: string;
  /** Raw Node request target (`url`), including any query if present. */
  readonly path?: string;
  /** Alias accepted for direct use with `http.IncomingMessage`. */
  readonly url?: string;
}

export interface DashboardStaticHandled {
  readonly handled: true;
  readonly status: 200 | 308 | 404 | 405;
  readonly headers: Readonly<Record<string, string>>;
  /** Omitted for HEAD and for empty error/redirect responses. */
  readonly body?: Buffer;
}

export interface DashboardStaticNotHandled {
  readonly handled: false;
}

export type DashboardStaticResponse = DashboardStaticHandled | DashboardStaticNotHandled;

type Artifact = { readonly target: string; readonly mime: string | null };

function isSafeManifestPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_MANIFEST_STRING) return false;
  if (value.includes("\\") || value.includes("%") || value.includes("?") || value.includes("#")) return false;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value) || value.startsWith("/") || isAbsolute(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && !part.includes("\\"));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_MANIFEST_ARRAY && value.every(isSafeManifestPath);
}

function parseManifest(value: unknown): DashboardManifest | null {
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).length > MAX_MANIFEST_ENTRIES) return null;
  const output: Record<string, DashboardManifestEntry> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isSafeManifestPath(key) || !isRecord(raw) || !isSafeManifestPath(raw.file)) return null;
    const optionalStrings = ["src", "name"] as const;
    for (const field of optionalStrings) {
      if (raw[field] !== undefined && !isSafeManifestPath(raw[field])) return null;
    }
    for (const field of ["imports", "dynamicImports", "css", "assets"] as const) {
      if (raw[field] !== undefined && !isStringArray(raw[field])) return null;
    }
    for (const field of ["isEntry", "isDynamicEntry"] as const) {
      if (raw[field] !== undefined && typeof raw[field] !== "boolean") return null;
    }
    const entry = { file: raw.file as string } as {
      file: string;
      src?: string;
      name?: string;
      isEntry?: boolean;
      isDynamicEntry?: boolean;
      imports?: string[];
      dynamicImports?: string[];
      css?: string[];
      assets?: string[];
    };
    if (raw.src !== undefined) entry.src = raw.src as string;
    if (raw.name !== undefined) entry.name = raw.name as string;
    if (raw.isEntry !== undefined) entry.isEntry = raw.isEntry as boolean;
    if (raw.isDynamicEntry !== undefined) entry.isDynamicEntry = raw.isDynamicEntry as boolean;
    if (raw.imports !== undefined) entry.imports = raw.imports as string[];
    if (raw.dynamicImports !== undefined) entry.dynamicImports = raw.dynamicImports as string[];
    if (raw.css !== undefined) entry.css = raw.css as string[];
    if (raw.assets !== undefined) entry.assets = raw.assets as string[];
    output[key] = entry as DashboardManifestEntry;
  }
  return Object.freeze(output);
}

function readManifest(options: DashboardStaticOptions): DashboardManifest | null {
  if (options.manifest !== undefined && typeof options.manifest !== "string") return parseManifest(options.manifest);
  const path = typeof options.manifest === "string" ? options.manifest : options.manifestPath;
  if (!path || !existsSync(path)) return null;
  const max = Math.min(options.maxManifestBytes ?? DEFAULT_MANIFEST_LIMIT, DEFAULT_MANIFEST_LIMIT);
  if (!Number.isSafeInteger(max) || max <= 0) return null;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > max) return null;
    return parseManifest(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function extensionMime(path: string): string | null {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? null : MIME_TYPES[path.slice(dot).toLowerCase()] ?? null;
}

function routeAssetName(value: string): string {
  return value.startsWith("assets/") ? value.slice("assets/".length) : value;
}

/** Vite's production `[name]-[hash].[ext]` assets; unhashed files must never be immutable. */
function isContentHashedArtifact(value: string): boolean {
  return /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u.test(value);
}

function addArtifact(artifacts: Map<string, Artifact>, value: string): boolean {
  if (!isSafeManifestPath(value) || !isContentHashedArtifact(value)) return false;
  const routeName = routeAssetName(value);
  if (routeName.length === 0 || routeName.includes("/../") || routeName === "..") return false;
  // The manifest `file` is already the exact root-relative path (Vite emits
  // `assets/foo.js`), while its URL name stays `foo.js` under /dashboard/assets/.
  const target = value;
  const mime = extensionMime(target);
  if (!mime) return false;
  const previous = artifacts.get(routeName);
  if (previous && previous.target !== target) return false;
  artifacts.set(routeName, { target, mime });
  return true;
}

function buildClosure(manifest: DashboardManifest): Map<string, Artifact> | null {
  const index = manifest["index.html"] ?? Object.values(manifest).find((entry) => entry.isEntry && (entry.src === "index.html" || entry.name === "index"));
  if (!index) return null;
  const indexKey = manifest["index.html"] ? "index.html" : Object.keys(manifest).find((key) => manifest[key] === index);
  if (!indexKey) return null;
  const artifacts = new Map<string, Artifact>();
  type VisitState = "visiting" | "visited";
  const states = new Map<string, VisitState>();

  // DFS with tri-color state is deliberate: a global visited set alone can
  // hide a cycle that crosses sibling branches (index -> A,B; A -> B; B -> A).
  // The depth cap bounds recursion even for a hostile manifest.
  const visit = (key: string, depth: number): boolean => {
    if (depth > MAX_CLOSURE_DEPTH) return false;
    const state = states.get(key);
    if (state === "visiting") return false;
    if (state === "visited") return true;
    if (states.size >= MAX_CLOSURE_ENTRIES) return false;
    const entry = manifest[key];
    if (!entry) return false;
    states.set(key, "visiting");
    if (!addArtifact(artifacts, entry.file)) return false;
    for (const value of [...(entry.css ?? []), ...(entry.assets ?? [])]) {
      if (!addArtifact(artifacts, value)) return false;
    }
    for (const imported of [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])]) {
      // Vite imports are manifest keys.  Accepting an output file here would
      // make a corrupt manifest look complete, so reject missing references.
      if (!visit(imported, depth + 1)) return false;
    }
    states.set(key, "visited");
    return true;
  };

  return visit(indexKey, 0) ? artifacts : null;
}

function commonHeaders(): Record<string, string> {
  return { ...DASHBOARD_STATIC_SECURITY_HEADERS };
}

function emptyResponse(status: 308 | 404 | 405, extra: Record<string, string> = {}): DashboardStaticHandled {
  return { handled: true, status, headers: { ...commonHeaders(), "Content-Length": "0", ...extra } };
}

function safeTarget(target: string): boolean {
  if (target.length === 0 || target.length > MAX_TARGET_LENGTH) return false;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(target)) return false;
  // Keeping percent escapes out of this tokenless surface prevents alternate
  // spellings of separators, dot segments, NUL, and UTF-8 control characters.
  if (target.includes("%") || target.includes("?") || target.includes("#") || target.includes("\\")) return false;
  if (!target.startsWith("/") || target.includes("//")) return false;
  return target.split("/").every((part) => part !== "." && part !== "..");
}

function exactCasePath(root: string, target: string): string | null {
  const parts = target.split("/").filter(Boolean);
  let current = root;
  try {
    for (const part of parts) {
      const match = readdirSync(current, { withFileTypes: true }).find((entry) => entry.name === part);
      if (!match) return null;
      current = join(current, match.name);
    }
    return current;
  } catch {
    return null;
  }
}

function insideRoot(root: string, target: string): boolean {
  try {
    const rootReal = realpathSync(root);
    const targetReal = realpathSync(target);
    const rest = relative(rootReal, targetReal);
    return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
  } catch {
    return false;
  }
}

function readRegularFile(root: string, target: string): Buffer | null {
  const exact = exactCasePath(root, target);
  if (!exact || !insideRoot(root, exact)) return null;
  try {
    if (!lstatSync(exact).isFile()) return null;
    return readFileSync(exact);
  } catch {
    return null;
  }
}

export class DashboardStaticHandler {
  readonly #root: string;
  readonly #options: DashboardStaticOptions;
  readonly #manifestPath: string | null;
  #manifestMtimeMs: number = -1;
  #manifest: DashboardManifest | null = null;
  #artifacts: Map<string, Artifact> | null = null;

  constructor(options: DashboardStaticOptions) {
    this.#root = resolve(options.assetRoot);
    this.#options = options;
    this.#manifestPath = typeof options.manifest === "string"
      ? options.manifest
      : (options.manifest === undefined ? options.manifestPath ?? null : null);
    this.#syncManifest();
  }

  #syncManifest(force = false): void {
    if (this.#manifestPath) {
      try {
        const stat = lstatSync(this.#manifestPath);
        if (!force && stat.mtimeMs === this.#manifestMtimeMs) return;
        this.#manifestMtimeMs = stat.mtimeMs;
      } catch {
        this.#manifestMtimeMs = -1;
        this.#manifest = null;
        this.#artifacts = null;
        return;
      }
    }
    this.#manifest = readManifest(this.#options);
    this.#artifacts = this.#manifest ? buildClosure(this.#manifest) : null;
  }

  handle(request: DashboardStaticRequest): DashboardStaticResponse;
  handle(method: string, path: string): DashboardStaticResponse;
  handle(requestOrMethod: DashboardStaticRequest | string, suppliedPath?: string): DashboardStaticResponse {
    const method = typeof requestOrMethod === "string" ? requestOrMethod : requestOrMethod.method;
    const path = typeof requestOrMethod === "string" ? suppliedPath ?? "" : requestOrMethod.path ?? requestOrMethod.url ?? "";
    const recognized = path === "/dashboard" || path === "/dashboard/" || path.startsWith("/dashboard/assets/");
    if (!recognized) return { handled: false };
    if (!safeTarget(path)) return emptyResponse(404);

    if (path === "/dashboard") {
      if (method !== "GET") return emptyResponse(405, { Allow: "GET" });
      return emptyResponse(308, { Location: "/dashboard/", "Cache-Control": "no-store" });
    }
    if (path === "/dashboard/") {
      if (method !== "GET" && method !== "HEAD") return emptyResponse(405, { Allow: "GET, HEAD" });
      if (this.#manifestPath) this.#syncManifest();
      // The shell is useful only when the same validated manifest can account
      // for the entry's complete asset closure.  Never serve an index that
      // points at an unknown, broken, or cyclic asset graph.
      if (!this.#artifacts) return emptyResponse(404);
      const body = readRegularFile(this.#root, "index.html");
      if (!body) return emptyResponse(404);
      return {
        handled: true,
        status: 200,
        headers: { ...commonHeaders(), "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Length": String(body.byteLength) },
        ...(method === "HEAD" ? {} : { body }),
      };
    }
    if (!path.startsWith("/dashboard/assets/")) return emptyResponse(404);
    if (method !== "GET" && method !== "HEAD") return emptyResponse(405, { Allow: "GET, HEAD" });
    const assetName = path.slice("/dashboard/assets/".length);
    let artifact = this.#artifacts?.get(assetName);
    if (!artifact && this.#manifestPath) {
      this.#syncManifest(true);
      artifact = this.#artifacts?.get(assetName);
    }
    if (!artifact || !artifact.mime) return emptyResponse(404);
    const body = readRegularFile(this.#root, artifact.target);
    if (!body) return emptyResponse(404);
    return {
      handled: true,
      status: 200,
      headers: { ...commonHeaders(), "Content-Type": artifact.mime, "Cache-Control": "public, max-age=31536000, immutable", "Content-Length": String(body.byteLength) },
      ...(method === "HEAD" ? {} : { body }),
    };
  }

  resolve(request: DashboardStaticRequest): DashboardStaticResponse;
  resolve(method: string, path: string): DashboardStaticResponse;
  resolve(requestOrMethod: DashboardStaticRequest | string, suppliedPath?: string): DashboardStaticResponse {
    return typeof requestOrMethod === "string" ? this.handle(requestOrMethod, suppliedPath ?? "") : this.handle(requestOrMethod);
  }
}

export function createDashboardStaticHandler(options: DashboardStaticOptions): DashboardStaticHandler {
  return new DashboardStaticHandler(options);
}

/** Production helper; tests should inject a temporary root instead. */
export function getProductionDashboardAssetRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "dashboard");
}
