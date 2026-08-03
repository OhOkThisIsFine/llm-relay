import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";

export const MAX_RECENT_CALLS = 50;
export const DEFAULT_MIN_CALLS_FOR_SCORE = 5;
export const DEFAULT_TELEMETRY_FLUSH_DELAY_MS = 250;
export const MAX_TELEMETRY_FLUSH_DELAY_MS = 2_000;

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
  lastCalledAt: number;
  recentCalls: RecentCall[];
}

export interface TelemetryData {
  version: number;
  models: Record<string, ModelTelemetry>;
}

export function getRuntimeTelemetryPath(): string {
  if (process.env.VITEST) return join(tmpdir(), "llm-relay-vitest", "runtime-telemetry.json");
  const xdg = process.env.XDG_CACHE_HOME;
  const baseDir = xdg && xdg.trim() ? join(xdg, "llm-relay") : join(homedir(), ".llm-relay");
  return join(baseDir, "runtime-telemetry.json");
}

let _telemetry: TelemetryData | null = null;
let _telemetryPath: string | null = null;
let _flushTimer: NodeJS.Timeout | null = null;
let _dirtySince: number | null = null;

export function loadRuntimeTelemetry(opts: { path?: string; reload?: boolean } = {}): TelemetryData {
  const target = opts.path ?? getRuntimeTelemetryPath();
  if (!opts.reload && _telemetry && _telemetryPath === target) return _telemetry;
  try {
    const raw = readFileSync(target, "utf8");
    const parsed = JSON.parse(raw) as TelemetryData;
    if (parsed && typeof parsed === "object" && parsed.models) {
      _telemetry = parsed;
      _telemetryPath = target;
      return parsed;
    }
  } catch {}

  _telemetry = { version: 1, models: {} };
  _telemetryPath = target;
  return _telemetry;
}

export function flushRuntimeTelemetry(opts: { path?: string; telemetry?: TelemetryData } = {}): void {
  const target = opts.path ?? _telemetryPath ?? getRuntimeTelemetryPath();
  const data = opts.telemetry ?? _telemetry ?? { version: 1, models: {} };
  if (_flushTimer && !opts.path) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  if (!opts.path) _dirtySince = null;
  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmpPath = `${target}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    renameSync(tmpPath, target);
  } catch {}
}

function scheduleRuntimeTelemetryFlush(): void {
  const now = Date.now();
  _dirtySince ??= now;
  if (_flushTimer) clearTimeout(_flushTimer);
  const remaining = Math.max(0, MAX_TELEMETRY_FLUSH_DELAY_MS - (now - _dirtySince));
  const target = _telemetryPath ?? getRuntimeTelemetryPath();
  const data = _telemetry ?? { version: 1, models: {} };
  _flushTimer = setTimeout(
    () => {
      _flushTimer = null;
      _dirtySince = null;
      flushRuntimeTelemetry({ path: target, telemetry: data });
    },
    Math.min(DEFAULT_TELEMETRY_FLUSH_DELAY_MS, remaining),
  );
}

export function recordModelCall(
  providerKey: string,
  modelId: string,
  callResult: { ok: boolean; latencyMs: number; completionTokens?: number },
  opts: { now?: number; path?: string } = {},
): void {
  const now = opts.now ?? Date.now();
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
      lastCalledAt: now,
      recentCalls: [],
    };
  }

  const m = data.models[key]!;
  m.totalCalls += 1;
  if (callResult.ok) m.successCalls += 1;
  m.totalLatencyMs += callResult.latencyMs;
  m.totalCompletionTokens += callResult.completionTokens ?? 0;
  m.lastCalledAt = now;

  m.recentCalls.push({
    timestamp: now,
    ok: callResult.ok,
    latencyMs: callResult.latencyMs,
    ...(callResult.completionTokens !== undefined ? { tokens: callResult.completionTokens } : {}),
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

  const successRate = m.successCalls / m.totalCalls;
  const avgLatency = m.totalLatencyMs / m.totalCalls;
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
