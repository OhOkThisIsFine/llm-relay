import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { WriteBehindTimer } from "./write-behind.js";

/**
 * Context limits LEARNED from what a deployment actually said when it refused a request.
 *
 * The catalog can only report what a provider publishes in `/models`, and most of the free
 * providers this proxy fronts publish nothing at all. But a deployment that rejects an
 * over-length request usually states its real ceiling in the error message — a first-party fact
 * about the exact deployment that will serve the next request, and therefore *better* evidence
 * than a published catalogue figure, which can be generic or stale.
 *
 * ⚠ **Only an explicitly STATED maximum is recorded.** "We sent an estimated N tokens and it was
 * rejected" is not a limit — it is an upper bound on a number this proxy estimated at four
 * characters per token, and persisting it would put a guess into the one store whose whole value
 * is that it contains measurements. If nothing parses, nothing is learned. Same rule as
 * `resolveMetadata`: no rung may be a guess.
 */

/** Learned limits expire, because a provider that raises a ceiling would otherwise never be
 *  believed again. Long, because a ceiling is a slow-moving fact — this is staleness, not health. */
export const OBSERVED_LIMIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A stated ceiling above this is a parse artifact, not a context window. */
const MAX_CREDIBLE_TOKENS = 100_000_000;

interface ObservedLimit {
  tokens: number;
  /** Epoch ms of the observation, for TTL. */
  at: number;
}

interface LimitStore {
  version: 1;
  /** `<provider>/<model>` → the ceiling that deployment stated. */
  limits: Record<string, ObservedLimit>;
}

let _store: LimitStore | null = null;
let _path: string | null = null;
const writer = new WriteBehindTimer();

function defaultPath(): string {
  // ⚠ Redirected under vitest, for the same reason probe-cache is: the suite was found writing
  // `openai_mock` entries into the user's live health data. A learned context limit is exactly the
  // same hazard — a test's fake ceiling persisted here would then cap a real lane.
  if (process.env.VITEST !== undefined) {
    return join(tmpdir(), `llm-relay-test-context-limits-${process.pid}.json`);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const baseDir = xdg && xdg.trim() ? join(xdg, "llm-relay") : join(homedir(), ".llm-relay");
  return join(baseDir, "context-limits.json");
}

function key(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function load(path: string): LimitStore {
  if (_store && _path === path) return _store;
  _path = path;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LimitStore>;
    if (parsed && typeof parsed === "object" && parsed.limits && typeof parsed.limits === "object") {
      _store = { version: 1, limits: parsed.limits as Record<string, ObservedLimit> };
      return _store;
    }
  } catch {
    // Unreadable or corrupt: start clean. A learned limit is an optimization, never a
    // correctness dependency, so losing the file must not fail anything.
  }
  _store = { version: 1, limits: {} };
  return _store;
}

function persist(path: string): void {
  if (!_store) return;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    // Write-then-rename, same as probe-cache: a crash mid-write must not leave a half-file that
    // then parses as an empty store and silently discards everything learned.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(_store, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  } catch {
    // Same contract as the metadata logger: a full disk is a storage problem, never a request
    // failure. The learned limit simply stays in memory for this process's lifetime.
  }
}

/**
 * Patterns that carry an explicitly stated ceiling. Deliberately a small, literal set rather than
 * anything clever: a loose pattern that captured the *requested* count instead of the *maximum*
 * would persist a number larger than the real ceiling and cause exactly the overflow this exists
 * to prevent. Every pattern below must capture the MAXIMUM.
 */
const STATED_LIMIT_PATTERNS: RegExp[] = [
  // OpenAI-style: "This model's maximum context length is 8192 tokens. However, you requested …"
  /maximum context length is\s+(\d[\d,_]*)\s*tokens/i,
  // Anthropic-style: "prompt is too long: 250000 tokens > 200000 maximum"
  /tokens\s*>\s*(\d[\d,_]*)\s*maximum/i,
  // Common variants seen across OpenAI-compatible servers (vLLM, TGI, NIM front-ends).
  /maximum\s+(?:input\s+|prompt\s+)?(?:context|length|tokens)\D{0,24}?(\d[\d,_]*)/i,
  /context\s+(?:window|length)\s+(?:of|is)\s+(\d[\d,_]*)/i,
  /reduce\s+(?:the\s+)?length[^.]*?(?:max(?:imum)?|limit)\D{0,16}(\d[\d,_]*)/i,
];

/**
 * Extract a stated context ceiling from an error body, or null.
 *
 * Returns null for anything it cannot read as an explicit maximum — including a body that merely
 * proves the request was too long. See the file header for why that asymmetry is deliberate.
 */
export function parseStatedContextLimit(body: string): number | null {
  if (typeof body !== "string" || body.length === 0) return null;
  // Bodies are small; this bound only stops a pathological one from driving the regex engine.
  const text = body.length > 8192 ? body.slice(0, 8192) : body;
  for (const re of STATED_LIMIT_PATTERNS) {
    const m = re.exec(text);
    if (!m?.[1]) continue;
    const n = Number(m[1].replace(/[,_]/g, ""));
    if (Number.isFinite(n) && n > 0 && n <= MAX_CREDIBLE_TOKENS) return Math.floor(n);
  }
  return null;
}

/** Does this error body describe a context-length rejection at all? */
export function looksLikeContextLengthError(body: string): boolean {
  return /context (?:length|window)|too long|maximum.*tokens|token.*limit exceeded/i.test(body);
}

/**
 * Record a ceiling a deployment stated about itself. A fresh observation always replaces an older
 * one: the deployment is the authority on its own ceiling, and a provider that raised or lowered
 * it is telling us so.
 */
export function recordObservedContextLimit(
  provider: string,
  model: string,
  tokens: number,
  opts: { path?: string; now?: number } = {},
): void {
  if (!Number.isFinite(tokens) || tokens <= 0 || tokens > MAX_CREDIBLE_TOKENS) return;
  const path = opts.path ?? defaultPath();
  const store = load(path);
  store.limits[key(provider, model)] = { tokens: Math.floor(tokens), at: opts.now ?? Date.now() };
  writer.touch(() => persist(path));
}

/** The learned ceiling for a deployment, or null when none was observed or it has expired. */
export function observedContextLimit(
  provider: string,
  model: string,
  opts: { path?: string; now?: number } = {},
): number | null {
  const path = opts.path ?? defaultPath();
  const store = load(path);
  const hit = store.limits[key(provider, model)];
  if (!hit) return null;
  const now = opts.now ?? Date.now();
  if (now - hit.at > OBSERVED_LIMIT_TTL_MS) return null;
  return hit.tokens;
}

/** Flush pending observations. Called on shutdown, like the other write-behind stores. */
export function flushObservedContextLimits(opts: { path?: string } = {}): void {
  if (!writer.dirty) return;
  writer.clear();
  persist(opts.path ?? defaultPath());
}

/** Test seam: drop the in-memory store so a suite can point at a fresh path. */
export function resetObservedContextLimits(): void {
  _store = null;
  _path = null;
  writer.clear();
}
