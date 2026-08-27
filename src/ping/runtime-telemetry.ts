import { relayStatePath } from "../state-paths.js";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { WriteBehindTimer } from "../write-behind.js";

export const MAX_RECENT_CALLS = 50;
export const DEFAULT_MIN_CALLS_FOR_SCORE = 5;

export interface RecentCall {
  timestamp: number;
  ok: boolean;
  latencyMs: number;
  tokens?: number;
}

export interface ModelTelemetry {
  providerKey: string;
  modelId: string;
  totalCalls: number;
  successCalls: number;
  totalLatencyMs: number;
  totalCompletionTokens: number;
  completionTokenCalls: number;
  lastCalledAt: number;
  recentCalls: RecentCall[];
}

export interface TelemetryData {
  version: 2;
  models: Record<string, ModelTelemetry>;
}

export function getRuntimeTelemetryPath(): string {
  if (process.env.VITEST) return join(tmpdir(), "llm-relay-vitest", "runtime-telemetry.json");
  const baseDir = relayStatePath("cache");
  return join(baseDir, "runtime-telemetry.json");
}

let _telemetry: TelemetryData | null = null;
let _telemetryPath: string | null = null;
const _writeBehind = new WriteBehindTimer();

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return nonNegativeFinite(value) && Number.isSafeInteger(value);
}

const MAX_DATE_MS = 8_640_000_000_000_000;
function validTimestamp(value: unknown): value is number {
  return nonNegativeFinite(value) && value <= MAX_DATE_MS;
}

function normalizeRecentCall(value: unknown): RecentCall | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!validTimestamp(row.timestamp) || typeof row.ok !== "boolean" || !nonNegativeFinite(row.latencyMs)) return null;
  if (row.tokens !== undefined && !nonNegativeInteger(row.tokens)) return null;
  return {
    timestamp: row.timestamp,
    ok: row.ok,
    latencyMs: row.latencyMs,
    ...(row.tokens !== undefined ? { tokens: row.tokens } : {}),
  };
}

function normalizeModel(value: unknown, migrateV1: boolean): ModelTelemetry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.providerKey !== "string" || typeof row.modelId !== "string") return null;
  if (!nonNegativeInteger(row.totalCalls) || !nonNegativeInteger(row.successCalls) ||
      row.successCalls > row.totalCalls || !nonNegativeFinite(row.totalLatencyMs) ||
      !validTimestamp(row.lastCalledAt) || !Array.isArray(row.recentCalls)) return null;
  const recentCalls = row.recentCalls.map((entry) => {
    // v1 token history was unwired too; remove it before validation so a bad legacy token
    // field cannot discard otherwise useful call/latency evidence.
    if (migrateV1 && entry && typeof entry === "object") {
      const { tokens: _ignored, ...withoutTokens } = entry as Record<string, unknown>;
      return normalizeRecentCall(withoutTokens);
    }
    return normalizeRecentCall(entry);
  }).filter((v): v is RecentCall => v !== null).slice(-MAX_RECENT_CALLS);
  // v1's token total was never wired to a real recorder. Do not migrate it as if measured.
  const totalCompletionTokens = migrateV1 ? 0 : row.totalCompletionTokens;
  const completionTokenCalls = migrateV1 ? 0 : row.completionTokenCalls;
  if (!nonNegativeInteger(totalCompletionTokens) || !nonNegativeInteger(completionTokenCalls) ||
      completionTokenCalls > row.totalCalls || totalCompletionTokens > Number.MAX_SAFE_INTEGER) return null;
  return {
    providerKey: row.providerKey,
    modelId: row.modelId,
    totalCalls: row.totalCalls,
    successCalls: row.successCalls,
    totalLatencyMs: row.totalLatencyMs,
    totalCompletionTokens,
    completionTokenCalls,
    lastCalledAt: row.lastCalledAt,
    recentCalls,
  };
}

function normalizeTelemetry(value: unknown): TelemetryData | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 && row.version !== 2 || !row.models || typeof row.models !== "object" || Array.isArray(row.models)) return null;
  const migrateV1 = row.version === 1;
  const models: Record<string, ModelTelemetry> = {};
  for (const [key, model] of Object.entries(row.models as Record<string, unknown>)) {
    const normalized = normalizeModel(model, migrateV1);
    if (normalized) models[key] = normalized;
  }
  return { version: 2, models };
}

export function loadRuntimeTelemetry(opts: { path?: string; reload?: boolean } = {}): TelemetryData {
  const target = opts.path ?? getRuntimeTelemetryPath();
  if (!opts.reload && _telemetry && _telemetryPath === target) return _telemetry;
  try {
    const raw = readFileSync(target, "utf8");
    const normalized = normalizeTelemetry(JSON.parse(raw));
    if (normalized) {
      _telemetry = normalized;
      _telemetryPath = target;
      return normalized;
    }
  } catch {
    // Unreadable/corrupt telemetry is not a request failure — fall through to a fresh store.
  }

  _telemetry = { version: 2, models: {} };
  _telemetryPath = target;
  return _telemetry;
}

export function flushRuntimeTelemetry(opts: { path?: string; telemetry?: TelemetryData } = {}): void {
  const target = opts.path ?? _telemetryPath ?? getRuntimeTelemetryPath();
  const data = opts.telemetry ?? _telemetry ?? { version: 2, models: {} };
  if (!opts.path) _writeBehind.clear();
  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmpPath = `${target}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    renameSync(tmpPath, target);
  } catch {
    return;
  }
}

function scheduleRuntimeTelemetryFlush(): void {
  const target = _telemetryPath ?? getRuntimeTelemetryPath();
  const data = _telemetry ?? { version: 2, models: {} };
  _writeBehind.touch(() => flushRuntimeTelemetry({ path: target, telemetry: data }));
}

export function recordModelCall(
  providerKey: string,
  modelId: string,
  callResult: { ok: boolean; latencyMs: number; completionTokens?: number },
  opts: { now?: number; path?: string } = {},
): void {
  const now = opts.now ?? Date.now();
  // Telemetry is best-effort. Reject invalid observations before touching the cache or disk so
  // malformed recorder input can never turn into a schema-corrupting aggregate.
  if (!validTimestamp(now) || !nonNegativeFinite(callResult.latencyMs)) return;
  const data = opts.path ? loadRuntimeTelemetry({ path: opts.path }) : (_telemetry ?? loadRuntimeTelemetry());
  const key = `${providerKey}/${modelId}`;

  if (!data.models[key]) {
    data.models[key] = {
      providerKey,
      modelId,
      totalCalls: 0,
      successCalls: 0,
      totalLatencyMs: 0,
      totalCompletionTokens: 0,
      completionTokenCalls: 0,
      lastCalledAt: now,
      recentCalls: [],
    };
  }

  const m = data.models[key]!;
  // Counters are persisted as safe integers. Once a row reaches the representable ceiling,
  // retaining the last valid aggregate is more truthful than wrapping or emitting an unsafe one.
  if (m.totalCalls >= Number.MAX_SAFE_INTEGER) return;
  m.totalCalls += 1;
  if (callResult.ok) m.successCalls += 1;
  m.totalLatencyMs = Math.min(Number.MAX_VALUE, m.totalLatencyMs + callResult.latencyMs);
  const reportedTokens = callResult.completionTokens !== undefined && nonNegativeInteger(callResult.completionTokens) &&
    m.totalCompletionTokens <= Number.MAX_SAFE_INTEGER - callResult.completionTokens
    ? callResult.completionTokens
    : undefined;
  if (reportedTokens !== undefined) {
    m.totalCompletionTokens += reportedTokens;
    m.completionTokenCalls += 1;
  }
  m.lastCalledAt = now;

  m.recentCalls.push({
    timestamp: now,
    ok: callResult.ok,
    latencyMs: callResult.latencyMs,
    ...(reportedTokens !== undefined ? { tokens: reportedTokens } : {}),
  });

  if (m.recentCalls.length > MAX_RECENT_CALLS) {
    m.recentCalls.shift();
  }

  // Explicit paths are diagnostic/test contracts and stay durable on return. The live default
  // cache is write-behind so a request never synchronously rewrites the complete JSON document.
  if (opts.path) flushRuntimeTelemetry({ path: opts.path, telemetry: data });
  else scheduleRuntimeTelemetryFlush();
}


export function getRealWorldScore(
  providerKey: string,
  modelId: string,
  opts: { minCalls?: number; path?: string; telemetry?: TelemetryData; now?: number } = {},
): number | null {
  const minCalls = opts.minCalls ?? DEFAULT_MIN_CALLS_FOR_SCORE;
  const data = opts.telemetry ?? (opts.path
    ? loadRuntimeTelemetry({ path: opts.path })
    : (_telemetry ?? loadRuntimeTelemetry()));
  const key = `${providerKey}/${modelId}`;
  const m = data.models[key];

  if (!m || m.totalCalls < minCalls) return null;

  // Score from the ROLLING WINDOW, not lifetime totals (adoption review §1.10): a model that
  // degrades today must not hide behind months of good lifetime averages — before this,
  // freshness entered only as the 15%-weight time-since-last-call term, so a run of recent
  // failures barely moved a veteran's score. Lifetime totals still gate minimum evidence
  // (`totalCalls < minCalls` above) and remain the fallback when a caller demands more samples
  // than the window holds.
  const windowed = m.recentCalls.length >= minCalls ? m.recentCalls : null;
  const successRate = windowed
    ? windowed.filter((c) => c.ok).length / windowed.length
    : m.successCalls / m.totalCalls;
  const avgLatency = windowed
    ? windowed.reduce((s, c) => s + c.latencyMs, 0) / windowed.length
    : m.totalLatencyMs / m.totalCalls;
  const speedScore = Math.max(0, Math.min(100, 100 * (1 - avgLatency / 5000)));
  const recencyHours = ((opts.now ?? Date.now()) - m.lastCalledAt) / (1000 * 60 * 60);
  const recencyScore = Math.max(0, Math.min(100, 100 * (1 - recencyHours / 24)));

  const score = 0.6 * (successRate * 100) + 0.25 * speedScore + 0.15 * recencyScore;
  return Math.round(score);
}

/** Most recent successful real request, used to avoid actively probing what traffic just proved. */
export function getLastSuccessfulCallAt(
  providerKey: string,
  modelId: string,
  opts: { path?: string; telemetry?: TelemetryData } = {},
): number | null {
  const data = opts.telemetry ?? (opts.path
    ? loadRuntimeTelemetry({ path: opts.path })
    : (_telemetry ?? loadRuntimeTelemetry()));
  const calls = data.models[`${providerKey}/${modelId}`]?.recentCalls ?? [];
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]?.ok) return calls[i]!.timestamp;
  }
  return null;
}
