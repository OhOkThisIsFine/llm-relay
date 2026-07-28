import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

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
  lastCalledAt: number;
  recentCalls: RecentCall[];
}

export interface TelemetryData {
  version: number;
  models: Record<string, ModelTelemetry>;
}

export function getRuntimeTelemetryPath(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const baseDir = xdg && xdg.trim() ? join(xdg, "llm-relay") : join(homedir(), ".llm-relay");
  return join(baseDir, "runtime-telemetry.json");
}

let _telemetry: TelemetryData | null = null;

export function loadRuntimeTelemetry(opts: { path?: string } = {}): TelemetryData {
  const target = opts.path ?? getRuntimeTelemetryPath();
  try {
    const raw = readFileSync(target, "utf8");
    const parsed = JSON.parse(raw) as TelemetryData;
    if (parsed && typeof parsed === "object" && parsed.models) {
      _telemetry = parsed;
      return parsed;
    }
  } catch {}

  _telemetry = { version: 1, models: {} };
  return _telemetry;
}

export function flushRuntimeTelemetry(opts: { path?: string; telemetry?: TelemetryData } = {}): void {
  const target = opts.path ?? getRuntimeTelemetryPath();
  const data = opts.telemetry ?? _telemetry ?? { version: 1, models: {} };
  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmpPath = `${target}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    renameSync(tmpPath, target);
  } catch {}
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

  flushRuntimeTelemetry({ ...(opts.path ? { path: opts.path } : {}), telemetry: data });
}


export function getRealWorldScore(
  providerKey: string,
  modelId: string,
  opts: { minCalls?: number; path?: string } = {},
): number | null {
  const minCalls = opts.minCalls ?? DEFAULT_MIN_CALLS_FOR_SCORE;
  const data = opts.path ? loadRuntimeTelemetry({ path: opts.path }) : (_telemetry ?? loadRuntimeTelemetry());
  const key = `${providerKey}/${modelId}`;
  const m = data.models[key];

  if (!m || m.totalCalls < minCalls) return null;

  const successRate = m.successCalls / m.totalCalls;
  const avgLatency = m.totalLatencyMs / m.totalCalls;
  const speedScore = Math.max(0, Math.min(100, 100 * (1 - avgLatency / 5000)));
  const recencyHours = (Date.now() - m.lastCalledAt) / (1000 * 60 * 60);
  const recencyScore = Math.max(0, Math.min(100, 100 * (1 - recencyHours / 24)));

  const score = 0.6 * (successRate * 100) + 0.25 * speedScore + 0.15 * recencyScore;
  return Math.round(score);
}
