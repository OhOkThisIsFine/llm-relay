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

function collectModelAliases(value: unknown, out: Set<string>): void {
  if (typeof value === "string" && value.length > 0) {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModelAliases(item, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectModelAliases(item, out);
  }
}

/** OpenAI-compatible model discovery for clients such as local Codex. */
function relayModels(cfg: Config): Array<Record<string, unknown>> {
  const ids = new Set<string>();
  collectModelAliases(cfg.routing.default, ids);
  collectModelAliases(cfg.routing.tiers, ids);
  collectModelAliases(cfg.routing.subagents, ids);
  for (const name of Object.keys(cfg.routing.pools ?? {})) ids.add(`pool/${name}`);
  return [...ids].sort().map((id) => ({
    id,
    slug: id,
    display_name: id,
    description: "Model routed through llm-relay.",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "minimal", description: "Fast responses with minimal reasoning" },
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
      { effort: "high", description: "Greater reasoning depth for complex problems" },
      { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    additional_speed_tiers: ["fast"],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: "",
    model_messages: { instructions_template: "", instructions_variables: null },
    include_skills_usage_instructions: false,
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "medium",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 272000,
    max_context_window: 272000,
    comp_hash: "llm-relay",
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: true,
    use_responses_lite: false,
    tool_mode: "code_mode_only",
    multi_agent_version: "v2",
    object: "model",
    created: 0,
    owned_by: "llm-relay",
  }));
}

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
  if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
    const models = relayModels(cfg);
    res.writeHead(200, { "content-type": "application/json" });
    // `data` is the standard OpenAI shape; Codex's custom-provider catalog reader also accepts
    // the same entries under `models`. Returning both keeps the endpoint useful to both clients.
    res.end(JSON.stringify({ object: "list", data: models, models }));
    h.logger.write(baseLog(started, path, false, false, 200, "skipped", null));
    return true;
  }

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
    let bodyTier: string | undefined;
    if (req.method === "POST") {
      const body = (reqJson ?? {}) as { exhausted?: unknown; clear?: unknown; ttlMs?: unknown; tier?: unknown };
      const ttlMs = typeof body.ttlMs === "number" ? body.ttlMs : undefined;
      bodyTier = typeof body.tier === "string" ? body.tier : undefined;
      if (typeof body.clear === "string") {
        clearExhausted(cfg, body.clear, bodyTier);
      } else if (body.clear === true) {
        clearExhausted(cfg);
      } else if (typeof body.exhausted === "string") {
        if (!markExhausted(cfg, body.exhausted, ttlMs, bodyTier)) {
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
      ...((pickQuery(path, "tier") ?? bodyTier) ? { tier: (pickQuery(path, "tier") ?? bodyTier) as string } : {}),
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
