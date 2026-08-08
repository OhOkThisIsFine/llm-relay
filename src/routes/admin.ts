import type { IncomingMessage, ServerResponse } from "node:http";
import { unroutableOffloadClient, type Config, type OffloadScope } from "../config.js";
import type { ModelCatalog } from "../catalog.js";
import type { PingLoop } from "../ping/cadence.js";
import type { MetadataLogger } from "../log.js";
import { buildRegistry } from "../registry.js";
import { buildCandidates } from "../candidates.js";
import { offloadState, setOffload } from "../offload.js";
import { buildDispatch, markExhausted, clearExhausted, OUTCOME_DEFAULT_MS, type DispatchOutcome } from "../dispatch.js";
import { parseHostRoutingState } from "../host-routing.js";
import { contextWindowResolver } from "../metadata.js";
import { snapshotContextWindow } from "../tier-data.js";
import { observedContextLimit } from "../context-limits.js";
import { getTelemetryReport } from "../telemetry.js";
import type { CircuitBreaker } from "../circuit-breaker.js";
import { baseLog } from "../request-log.js";

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
  breaker: CircuitBreaker;
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
  const ok = (body: unknown, pretty = false): true => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body));
    h.logger.write(baseLog(started, path, false, false, 200, "skipped", null));
    return true;
  };
  const bad = (status: number, message: string): true => {
    failClosed(res, status, message);
    h.logger.write(baseLog(started, path, false, false, status, "skipped", null));
    return true;
  };

  if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
    const models = relayModels(cfg);
    // `data` is the standard OpenAI shape; Codex's custom-provider catalog reader also accepts
    // the same entries under `models`. Returning both keeps the endpoint useful to both clients.
    return ok({ object: "list", data: models, models });
  }

  // Discovery endpoint for an external dispatcher
  if (req.method === "GET" && pathname === "/registry") {
    const view = await buildRegistry(cfg, h.catalog, h.pingLoop ? { pingLoop: h.pingLoop } : {});
    return ok(view);
  }

  if (req.method === "GET" && pathname === "/ping") {
    if (h.pingLoop) {
      await h.pingLoop.tickOnce();
    }
    return ok({ ok: true, pingMode: h.pingLoop?.getMode(), intervalMs: h.pingLoop?.getIntervalMs() });
  }

  if (req.method === "GET" && (pathname === "/health/stats" || pathname === "/health")) {
    const view = await buildRegistry(cfg, h.catalog, h.pingLoop ? { pingLoop: h.pingLoop } : {});
    const stats: Record<string, unknown> = {
      generated_at: view.generated_at,
      ping_mode: h.pingLoop?.getMode(),
      providers: view.providers,
    };
    return ok(stats);
  }

  if (req.method === "GET" && pathname === "/candidates") {
    const providerFilter = pickQuery(path, "provider");
    const view = await buildCandidates(cfg, {
      catalog: h.catalog,
      breaker: h.breaker,
      ...(h.pingLoop ? { pingLoop: h.pingLoop } : {}),
      ...(providerFilter ? { provider: providerFilter } : {}),
    });
    return ok(view, true);
  }

  if ((req.method === "GET" || req.method === "POST") && pathname === "/offload") {
    const queryClient = pickQuery(path, "client");
    let state = offloadState(cfg, queryClient);
    if (req.method === "POST") {
      const body = (reqJson ?? {}) as { enabled?: unknown; client?: unknown; scope?: unknown };
      const client = typeof body.client === "string" && body.client.length > 0 ? body.client : queryClient;
      const scope = body.scope === undefined ? undefined : body.scope;
      if (body.client !== undefined && (typeof body.client !== "string" || body.client.length === 0)) {
        return bad(400, `POST /offload client must be a non-empty string`);
      }
      if (scope !== undefined && scope !== "subagents" && scope !== "all") {
        return bad(400, `POST /offload scope must be "subagents" or "all"`);
      }
      if (scope !== undefined && client === undefined) {
        return bad(400, `POST /offload scope requires a client`);
      }
      const want = body.enabled;
      if (typeof want !== "boolean") {
        return bad(400, `POST /offload needs {"enabled": true|false, "client"?: string, "scope"?: "subagents"|"all"}`);
      }
      // A toggle keyed to a name no front door produces would be dead config that silently does
      // nothing — refuse it like an unknown pool. An already-configured key stays togglable (an
      // operator must be able to turn a dead rule OFF); offloadState carries the warning for it.
      if (client !== undefined) {
        const unroutable = unroutableOffloadClient(client, cfg);
        if (unroutable?.fatal) {
          return bad(400, `POST /offload: ${unroutable.message}`);
        }
      }
      state = setOffload(cfg, want, client, scope as OffloadScope | undefined);
    }
    return ok(state, true);
  }

  if ((req.method === "GET" || req.method === "POST") && pathname === "/dispatch") {
    let bodyTier: string | undefined;
    let bodyClient: string | undefined = pickQuery(path, "client");
    if (req.method === "POST") {
      const body = (reqJson ?? {}) as { exhausted?: unknown; clear?: unknown; ttlMs?: unknown; tier?: unknown; client?: unknown; outcome?: unknown; retryAfterMs?: unknown };
      let outcome: DispatchOutcome | undefined;
      if (body.outcome !== undefined) {
        if (body.outcome !== "rate_limited" && body.outcome !== "quota_exhausted") {
          return bad(400, `POST /dispatch outcome must be "rate_limited" or "quota_exhausted"`);
        }
        outcome = body.outcome;
      }
      // Explicit wins over vendor-reported wins over the outcome's default; markExhausted's own
      // default covers the plain {"exhausted"} report. normalizeTtl clamps whatever arrives.
      const retryAfterMs = typeof body.retryAfterMs === "number" ? body.retryAfterMs : undefined;
      const ttlMs =
        (typeof body.ttlMs === "number" ? body.ttlMs : undefined) ??
        retryAfterMs ??
        (outcome !== undefined ? OUTCOME_DEFAULT_MS[outcome] : undefined);
      bodyTier = typeof body.tier === "string" ? body.tier : undefined;
      if (body.client !== undefined && (typeof body.client !== "string" || body.client.length === 0)) {
        return bad(400, `POST /dispatch client must be a non-empty string`);
      }
      if (typeof body.client === "string") bodyClient = body.client;
      if (typeof body.clear === "string") {
        clearExhausted(cfg, body.clear, bodyTier);
      } else if (body.clear === true) {
        clearExhausted(cfg);
      } else if (typeof body.exhausted === "string") {
        if (!markExhausted(cfg, body.exhausted, ttlMs, bodyTier)) {
          return bad(400, `POST /dispatch: no lane "${body.exhausted}" in routing.ladder`);
        }
      } else {
        return bad(400, `POST /dispatch needs {"exhausted":"<lane>"} or {"clear":"<lane>"|true}`);
      }
    }
    const rawTask = pickQuery(path, "task");
    if (typeof rawTask === "string" && rawTask.length > MAX_TASK_LEN) {
      return bad(400, `?task= exceeds ${MAX_TASK_LEN} characters`);
    }
    const taskParam = typeof rawTask === "string" && rawTask.length > 0 ? rawTask : undefined;
    // ⚠ `host` is REPORTED by the caller, never derived here. Whether a session's traffic reaches
    // this relay is a fact about the caller's process environment; this process was launched at
    // logon and its own environment describes nothing about whoever is asking. A bypassing host
    // is by definition one that sends no traffic here, so there is no request to infer it from —
    // only the CLI, running as a child of that session, can see it. `buildDispatch` validates the
    // value and falls back to "unknown" (pre-existing behaviour) for anything it cannot parse.
    const hostParam = parseHostRoutingState(pickQuery(path, "host"));
    const entrypointParam = pickQuery(path, "entrypoint");
    const view = buildDispatch(cfg, {
      ...(taskParam ? { task: taskParam } : {}),
      ...(pickQuery(path, "lane") ? { lane: pickQuery(path, "lane") as string } : {}),
      ...(pickQuery(path, "after") ? { after: pickQuery(path, "after") as string } : {}),
      ...((pickQuery(path, "tier") ?? bodyTier) ? { tier: (pickQuery(path, "tier") ?? bodyTier) as string } : {}),
      ...(bodyClient ? { client: bodyClient } : {}),
      ...(hostParam ? { host: hostParam } : {}),
      ...(entrypointParam ? { entrypoint: entrypointParam } : {}),
      // `cachedLimits` never fetches, so a cold cache degrades to "no window stated" rather than
      // turning a dispatch query into a blocking upstream round-trip — same rule as the request
      // -path context guardrail this reads the numbers from.
      publishedContextWindow: contextWindowResolver(
        (provider, model) => h.catalog.cachedLimits(provider, model)?.contextLength ?? null,
        snapshotContextWindow,
        observedContextLimit,
      ),
    });
    return ok(view, true);
  }

  if (req.method === "GET" && pathname === "/telemetry") {
    return ok(getTelemetryReport(cfg, h.breaker), true);
  }

  return false;
}
