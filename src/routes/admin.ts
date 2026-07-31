import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.js";
import type { ModelCatalog } from "../catalog.js";
import type { PingLoop } from "../ping/cadence.js";
import type { MetadataLogger } from "../log.js";
import { buildRegistry } from "../registry.js";
import { buildCandidates } from "../candidates.js";
import { offloadState, setOffload } from "../offload.js";
import { buildDispatch, markExhausted, clearExhausted } from "../dispatch.js";
import { getTelemetryReport } from "../telemetry.js";
import { globalCircuitBreaker } from "../circuit-breaker.js";
import { baseLog } from "../server.js";

const MAX_TASK_LEN = 4096;

export interface AdminHandlers {
  catalog: ModelCatalog;
  pingLoop?: PingLoop;
  logger: MetadataLogger;
}

function failClosed(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "error", message } }));
}

function pickQuery(url: string, param: string): string | undefined {
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return undefined;
  const search = new URLSearchParams(url.slice(qIdx + 1));
  return search.get(param) ?? undefined;
}

/**
 * Handles control-plane administrative endpoints.
 * Returns true if the request was an admin route and has been handled, false otherwise.
 */
export async function handleAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  path: string,
  started: number,
  reqJson: unknown,
  cfg: Config,
  h: AdminHandlers,
): Promise<boolean> {
  // Discovery endpoint for an external dispatcher
  if (req.method === "GET" && pathname === "/registry") {
    const view = await buildRegistry(cfg, h.catalog, h.pingLoop ? { pingLoop: h.pingLoop } : {});
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(view));
    h.logger.write(baseLog(started, path, false, false, 200, "skipped", null));
    return true;
  }

  if (req.method === "GET" && pathname === "/ping") {
    if (h.pingLoop) {
      await h.pingLoop.tickOnce();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pingMode: h.pingLoop?.getMode(), intervalMs: h.pingLoop?.getIntervalMs() }));
    h.logger.write(baseLog(started, path, false, false, 200, "skipped", null));
    return true;
  }

  if (req.method === "GET" && (pathname === "/health/stats" || pathname === "/health")) {
    const view = await buildRegistry(cfg, h.catalog, h.pingLoop ? { pingLoop: h.pingLoop } : {});
    const stats: Record<string, unknown> = {
      generated_at: view.generated_at,
      ping_mode: h.pingLoop?.getMode(),
      providers: view.providers,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(stats));
    h.logger.write(baseLog(started, path, false, false, 200, "skipped", null));
    return true;
  }

  if (req.method === "GET" && pathname === "/candidates") {
    const providerFilter = pickQuery(path, "provider");
    const view = await buildCandidates(cfg, {
      catalog: h.catalog,
      ...(h.pingLoop ? { pingLoop: h.pingLoop } : {}),
      ...(providerFilter ? { provider: providerFilter } : {}),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(view, null, 2));
    h.logger.write(baseLog(started, path, false, false, 200, "skipped", null));
    return true;
  }

  if ((req.method === "GET" || req.method === "POST") && pathname === "/offload") {
    let state = offloadState(cfg);
    if (req.method === "POST") {
      const want = (reqJson as { enabled?: unknown } | undefined)?.enabled;
      if (typeof want !== "boolean") {
        failClosed(res, 400, `POST /offload needs a JSON body {"enabled": true|false}`);
        h.logger.write(baseLog(started, path, false, false, 400, "skipped", null));
        return true;
      }
      state = setOffload(cfg, want);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(state, null, 2));
    h.logger.write(baseLog(started, path, false, false, 200, "skipped", null));
    return true;
  }

  if ((req.method === "GET" || req.method === "POST") && pathname === "/dispatch") {
    if (req.method === "POST") {
      const body = (reqJson ?? {}) as { exhausted?: unknown; clear?: unknown; ttlMs?: unknown };
      const ttlMs = typeof body.ttlMs === "number" ? body.ttlMs : undefined;
      if (typeof body.clear === "string") {
        clearExhausted(cfg, body.clear);
      } else if (body.clear === true) {
        clearExhausted(cfg);
      } else if (typeof body.exhausted === "string") {
        if (!markExhausted(cfg, body.exhausted, ttlMs)) {
          failClosed(res, 400, `POST /dispatch: no lane "${body.exhausted}" in routing.ladder`);
          h.logger.write(baseLog(started, path, false, false, 400, "skipped", null));
          return true;
        }
      } else {
        failClosed(res, 400, `POST /dispatch needs {"exhausted":"<lane>"} or {"clear":"<lane>"|true}`);
        h.logger.write(baseLog(started, path, false, false, 400, "skipped", null));
        return true;
      }
    }
    const rawTask = pickQuery(path, "task");
    if (typeof rawTask === "string" && rawTask.length > MAX_TASK_LEN) {
      failClosed(res, 400, `?task= exceeds ${MAX_TASK_LEN} characters`);
      h.logger.write(baseLog(started, path, false, false, 400, "skipped", null));
      return true;
    }
    const taskParam = typeof rawTask === "string" && rawTask.length > 0 ? rawTask : undefined;
    const view = buildDispatch(cfg, {
      ...(taskParam ? { task: taskParam } : {}),
      ...(pickQuery(path, "lane") ? { lane: pickQuery(path, "lane") as string } : {}),
      ...(pickQuery(path, "after") ? { after: pickQuery(path, "after") as string } : {}),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(view, null, 2));
    h.logger.write(baseLog(started, path, false, false, 200, "skipped", null));
    return true;
  }

  if (req.method === "GET" && pathname === "/telemetry") {
    const report = getTelemetryReport(cfg, globalCircuitBreaker);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(report, null, 2));
    h.logger.write(baseLog(started, path, false, false, 200, "skipped", null));
    return true;
  }

  return false;
}
