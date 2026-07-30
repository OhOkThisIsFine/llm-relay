import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import {
  DEFAULT_ANTHROPIC_VERSION,
  resolveTargets,
  reshaperForTarget,
  subagentSpec,
  RoutingError,
  type Config,
  type ResolvedTarget,
} from "./config.js";
import { MetadataLogger, type RequestLog } from "./log.js";
import { credentialState } from "./authEnv.js";
import { ToolUseValidator } from "./validator.js";
import { reconstructFromSse } from "./sse.js";
import { emitSse, emitSseTail, syntheticMessageId } from "./emitSse.js";
import { repair, destructiveMatcher, type RepairOutcome } from "./repair.js";
import { FailoverReshaper, HttpReshaper, type Reshaper } from "./reshaper.js";
import { fetchBackend, fetchOpenAiFront } from "./backend.js";
import { ModelCatalog } from "./catalog.js";
import { buildRegistry } from "./registry.js";
import { buildCandidates } from "./candidates.js";
import { offloadState, setOffload } from "./offload.js";
import { buildDispatch, markExhausted, clearExhausted } from "./dispatch.js";
import { toolSchemaMap, type AssistantMessage, type JsonSchema } from "./anthropic.js";
import { PingLoop } from "./ping/cadence.js";
import { recordModelCall } from "./ping/runtime-telemetry.js";
import { globalCircuitBreaker } from "./circuit-breaker.js";
import { estimateRequestTokens } from "./metadata.js";
import { getTelemetryReport } from "./telemetry.js";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding", "host",
]);
const INBOUND_AUTH = ["authorization", "x-api-key"];

/** Loopback names a Host header may legitimately carry (see config.ts's bind check). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** A task string long enough to be an abuse attempt rather than a task. */
const MAX_TASK_LEN = 4096;

/**
 * Request admission for mutating and command-rendering routes.
 *
 * Binding to loopback is NOT authorization. Any web page the user visits can
 * issue a cross-origin POST to 127.0.0.1, and because the handler JSON-parses
 * whatever body arrives regardless of declared content type, a `text/plain` POST
 * is a CORS *simple request* — no preflight, and it succeeds. The attacker never
 * reads the response, but every interesting operation here is a WRITE: flipping
 * offload routing, rewriting config.json on disk, marking dispatch lanes spent,
 * or spending provider keys.
 *
 * Returns null when the request may proceed, or a reason to reject with 403.
 * A CLI sends no Origin, so an ABSENT Origin is allowed; a present-but-unknown
 * one is not. Host is checked against the loopback names to close DNS rebinding,
 * where a hostile name resolves to 127.0.0.1 and thus looks local to the socket.
 */
function admissionFailure(req: IncomingMessage, mutating: boolean): string | null {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    try {
      const host = new URL(origin).hostname;
      if (!LOOPBACK_HOSTS.has(host)) return `cross-origin request from ${origin} is not allowed`;
    } catch {
      return "malformed Origin header";
    }
  }

  const hostHeader = req.headers.host;
  if (typeof hostHeader === "string" && hostHeader.length > 0) {
    const bare = hostHeader.replace(/:\d+$/, "");
    if (!LOOPBACK_HOSTS.has(bare)) return `Host ${hostHeader} is not a loopback address`;
  }

  if (mutating) {
    const ct = (req.headers["content-type"] ?? "").toString().split(";")[0]?.trim().toLowerCase();
    // Requiring application/json is what makes a body-bearing cross-origin POST
    // need a preflight, which a hostile page cannot satisfy.
    if (ct !== "application/json") {
      return `mutating requests require content-type: application/json (got ${ct || "none"})`;
    }
  }
  return null;
}

const MAX_VALIDATE_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface ProxyDeps {
  reshaper?: Reshaper;
  catalog?: ModelCatalog;
  pingLoop?: PingLoop;
}

export function createProxy(cfg: Config, deps: ProxyDeps = {}) {
  const validator = new ToolUseValidator();
  const logger = new MetadataLogger(cfg.log);
  const isDestructive = destructiveMatcher(cfg.repair.destructiveTools);
  const catalog = deps.catalog ?? new ModelCatalog();
  const pingLoop = deps.pingLoop ?? new PingLoop(cfg, catalog);

  // Reshaper selection is per-resolved-target: an explicit global reshaper (or an
  // injected one) wins for every request; otherwise an openai target reshapes on
  // itself (same base/model/key), built once per (provider, model) and cached.
  // A pool-backed reshaper (cfg.reshaperCandidates) becomes a FailoverReshaper so one de-listed
  // model cannot disable repair; a single pinned reshaper keeps the original single-client path.
  const explicitReshaper: Reshaper | undefined =
    deps.reshaper ??
    (cfg.reshaperCandidates && cfg.reshaperCandidates.length > 1
      ? new FailoverReshaper(cfg.reshaperCandidates.map((c) => new HttpReshaper(c)))
      : cfg.reshaper
        ? new HttpReshaper(cfg.reshaper)
        : undefined);
  const reshaperCache = new Map<string, Reshaper>();
  const resolveReshaper = (target: ResolvedTarget): Reshaper | undefined => {
    if (explicitReshaper) return explicitReshaper;
    const spec = reshaperForTarget(target);
    if (!spec) return undefined;
    const key = `${target.provider}::${target.model ?? ""}`;
    let r = reshaperCache.get(key);
    if (!r) {
      r = new HttpReshaper(spec);
      reshaperCache.set(key, r);
    }
    return r;
  };

  return createServer((req, res) => {
    const started = Date.now();
    handle(req, res, cfg, { validator, logger, isDestructive, resolveReshaper, catalog, pingLoop }).catch((e) => {
      failClosed(res, 502, `llm-relay internal error: ${(e as Error).message}`);
      // Last-resort net. `handle` logs every turn it terminates itself, so reaching
      // here means a turn ended with NO log record — the operator would see a client
      // error with nothing at all in the log to match it against. A duplicate line
      // in some future edge case is much cheaper than an invisible request.
      logger.write(baseLog(started, req.url ?? "/", false, false, 502, "skipped", null));
    });
  });
}

interface Handlers {
  validator: ToolUseValidator;
  logger: MetadataLogger;
  isDestructive: (name: string) => boolean;
  resolveReshaper: (target: ResolvedTarget) => Reshaper | undefined;
  catalog: ModelCatalog;
  pingLoop?: PingLoop;
}

async function handle(req: IncomingMessage, res: ServerResponse, cfg: Config, h: Handlers): Promise<void> {
  const started = Date.now();
  const path = req.url ?? "/";

  let reqBuf: Buffer;
  try {
    reqBuf = await readBody(req);
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg.includes("too large") ? 413 : 400;
    failClosed(res, status, msg);
    h.logger.write(baseLog(started, path, false, false, status, "skipped", null));
    return;
  }

  let reqJson: unknown;
  try {
    reqJson = reqBuf.length ? JSON.parse(reqBuf.toString("utf8")) : undefined;
  } catch {
    reqJson = undefined;
  }
  const tools = toolSchemaMap(reqJson);
  const hadTools = tools.size > 0;
  const model = pickString(reqJson, "model");
  const wantsStream = pickBool(reqJson, "stream");
  const pathname = path.split("?")[0] ?? path;

  // Discovery endpoint for a dispatcher (e.g. audit-tools): providers × live models
  // (best-effort capability) + routing + raw leaderboard scores, one coherent view.
  if (req.method === "GET" && pathname === "/registry") {
    const view = await buildRegistry(cfg, h.catalog, h.pingLoop ? { pingLoop: h.pingLoop } : {});
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(view));
    h.logger.write(baseLog(started, path, false, false, 200, "skipped", null));
    return;
  }

  if (req.method === "GET" && pathname === "/ping") {
    if (h.pingLoop) {
      await h.pingLoop.tickOnce();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pingMode: h.pingLoop?.getMode(), intervalMs: h.pingLoop?.getIntervalMs() }));
    h.logger.write(baseLog(started, path, false, false, 200, "skipped", null));
    return;
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
    return;
  }

  // Un-blended decision table for picking an offload target: benchmarks, live health, quota,
  // observed traffic and breaker state side by side, in config order.
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
    return;
  }

  // The offload switch. POST applies to the LIVE config object the request path reads, so the
  // very next subagent request is routed the new way — no restart — and is persisted back to
  // the config file so the choice survives one.
  if ((req.method === "GET" || req.method === "POST") && pathname === "/offload") {
    const denied = admissionFailure(req, req.method === "POST");
    if (denied) {
      failClosed(res, 403, denied);
      h.logger.write(baseLog(started, path, false, false, 403, "skipped", null));
      return;
    }
    let state = offloadState(cfg);
    if (req.method === "POST") {
      const want = (reqJson as { enabled?: unknown } | undefined)?.enabled;
      if (typeof want !== "boolean") {
        failClosed(res, 400, `POST /offload needs a JSON body {"enabled": true|false}`);
        h.logger.write(baseLog(started, path, false, false, 400, "skipped", null));
        return;
      }
      state = setOffload(cfg, want);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(state, null, 2));
    h.logger.write(baseLog(started, path, false, false, 200, "skipped", null));
    return;
  }

  // The dispatch ladder: which lane the host should hand a delegated task to next. GET reads
  // (with ?lane= to override, ?after= to walk past a spent rung, ?task= to get a runnable
  // command); POST reports a rung spent so the next read walks past it. The relay decides the
  // ORDER and never executes a cli rung itself — spawning agents is the host's job.
  if ((req.method === "GET" || req.method === "POST") && pathname === "/dispatch") {
    const deniedDispatch = admissionFailure(req, req.method === "POST");
    if (deniedDispatch) {
      failClosed(res, 403, deniedDispatch);
      h.logger.write(baseLog(started, path, false, false, 403, "skipped", null));
      return;
    }
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
          return;
        }
      } else {
        failClosed(res, 400, `POST /dispatch needs {"exhausted":"<lane>"} or {"clear":"<lane>"|true}`);
        h.logger.write(baseLog(started, path, false, false, 400, "skipped", null));
        return;
      }
    }
    // Bound the task text: it is unauthenticated query input that ends up in a
    // command the host is told to run, so an unbounded value is both a rendering
    // hazard and a trivial way to bloat the response.
    const rawTask = pickQuery(path, "task");
    if (typeof rawTask === "string" && rawTask.length > MAX_TASK_LEN) {
      failClosed(res, 400, `?task= exceeds ${MAX_TASK_LEN} characters`);
      h.logger.write(baseLog(started, path, false, false, 400, "skipped", null));
      return;
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
    return;
  }

  if (req.method === "GET" && pathname === "/telemetry") {
    const report = getTelemetryReport(cfg, globalCircuitBreaker);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(report, null, 2));
    h.logger.write(baseLog(started, path, false, false, 200, "skipped", null));
    return;
  }


  const isCountTokens = req.method === "POST" && pathname === "/v1/messages/count_tokens";
  const isMessages = req.method === "POST" && pathname.startsWith("/v1/messages") && !isCountTokens;

  // Route the request's model to a concrete provider + backend model candidates.
  //
  // ⚠ `subagentSpec` must run INSIDE this try. It throws `RoutingError` for an
  // unresolvable `@relay:` directive, and while it sat outside, that throw escaped
  // to `createProxy`'s top-level catch and surfaced as `502 llm-relay internal
  // error: …` with NO log line — fail-closed and loud, but mislabelled as a proxy
  // bug and invisible to the operator. A bad directive is a client routing error
  // (400) like any other unresolvable spec.
  let targetCandidates: ResolvedTarget[];
  try {
    // A SUBAGENT request may route somewhere other than its nominal model: either an explicit
    // `@relay: <spec>` in the dispatcher's prompt (stripped here, so the model never sees it) or
    // routing.subagents[<tier>]. Main-conversation requests are untouched, which is what lets
    // routing.tiers stay pointed at an Anthropic passthrough.
    const subSpec = isMessages ? subagentSpec(reqJson, model, cfg) : null;
    const routedModel = subSpec ?? model;
    // Re-serialize whenever a subagent spec applied — the @relay: line was stripped from reqJson
    // in place, and it must not reach the backend even when the spec matches the nominal model.
    if (subSpec !== null) reqBuf = Buffer.from(JSON.stringify(reqJson), "utf8");
    targetCandidates = resolveTargets(routedModel, cfg);
  } catch (e) {
    if (e instanceof RoutingError) {
      failClosed(res, 400, `llm-relay routing: ${e.message}`);
      h.logger.write(baseLog(started, path, hadTools, false, 400, "skipped", null));
      return;
    }
    throw e;
  }

  // Demote candidates whose breaker is open — and do NOTHING else to the order.
  //
  // ⚠ Deliberately NOT `getHealthyTargets()`: that filters AND re-sorts by measured
  // stability, which is a second ranking pass competing with the capability ranking
  // `resolveTargets` (→ `rankTargetsByBenchmark`) already applied. Two ranking passes
  // means neither decides the order, and live health then PROMOTES on evidence that
  // is often a single request's latency. Health is used here only to demote, never
  // to promote: a target the breaker is cooling steps aside, everything else keeps
  // its benchmark rank. (The re-sort was invisible for as long as an untracked target
  // scored a flat 100 and `Array.prototype.sort` is stable — INV-TS-7.)
  //
  // When EVERY candidate is cooling there is nothing left to prefer, so the full
  // ranked list is tried rather than failing the request outright.
  const healthy = targetCandidates.filter((t) => globalCircuitBreaker.isHealthy(t));
  const healthyTargets = healthy.length > 0 ? healthy : targetCandidates;
  let target = healthyTargets[0]!;

  // Context guardrail — enforced ONLY against a limit the serving provider published about its own
  // deployment. An unknown limit means no guardrail: the request goes upstream and the provider
  // answers with its own (authoritative) error.
  //
  // This deliberately does not fall back to another provider's figure for the same model id, nor to
  // a hardcoded guess — both used to happen. Either could reject a request the backend would have
  // accepted, and a 400 invented from a number we made up is worse than an upstream error that is
  // actually true. `cachedLimits` never fetches, so a cold cache degrades to "no guardrail" rather
  // than blocking the request on an upstream round-trip.
  if (isMessages && reqJson && target.model) {
    const limits = h.catalog.cachedLimits(target.provider, target.model);
    if (limits?.contextLength) {
      const estimatedTokens = estimateRequestTokens(reqJson);
      if (estimatedTokens > limits.contextLength) {
        failClosed(
          res,
          400,
          `llm-relay: request prompt estimated tokens (${estimatedTokens}) exceeds the context limit ` +
            `"${target.provider}" publishes for "${target.model}" (${limits.contextLength})`,
        );
        h.logger.write(baseLog(started, path, hadTools, false, 400, "skipped", null));
        return;
      }
    }
  }

  // OpenAI-compatible FRONT: a dispatcher (e.g. audit-tools) POSTs OpenAI Chat
  // Completions with a namespaced model; route by target and reverse-proxy the
  // upstream OpenAI response straight back (OpenAI in, OpenAI out).
  if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
    await openAiFrontPath(res, target, { reqJson, wantsStream, started, path, hadTools, req }, h);
    return;
  }

  // OpenAI-compatible backends expose ONLY /chat/completions — they have no
  // count_tokens route and no other Anthropic paths. Rather than mistranslate
  // those into a chat completion (yielding a spurious 400/garbage), answer
  // count_tokens locally with a cheap estimate and reject other paths cleanly.
  // For an Anthropic backend everything forwards as before (it speaks these).
  if (target.kind === "openai") {
    if (isCountTokens) {
      const input_tokens = estimateInputTokens(reqJson);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens }));
      h.logger.write(baseLog(started, path, hadTools, false, 200, "skipped", null));
      return;
    }
    if (!isMessages) {
      failClosed(res, 404, `llm-relay: path not supported for an openai backend: ${pathname}`);
      h.logger.write(baseLog(started, path, hadTools, false, 404, "skipped", null));
      return;
    }
  }

  // Candidate execution loop with failover across healthyTargets
  for (let i = 0; i < healthyTargets.length; i++) {
    target = healthyTargets[i]!;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), target.timeoutMs);
    const onResClose = () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    };
    res.on("close", onResClose);

    try {
      let backendRes: Response;
      try {
        backendRes = await fetchBackend(target, {
          path,
          method: req.method ?? "POST",
          reqBuf,
          reqJson,
          anthropicHeaders: buildForwardHeaders(req.headers, target),
          wantsStream,
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        res.off("close", onResClose);
        if (e instanceof CredentialConfigError) {
          // A declared-but-unset credential is a CONFIGURATION fault, not a transport
          // one: the target is not unhealthy, so it must not be recorded as a breaker
          // failure, and walking to the next candidate would quietly serve the request
          // from somewhere else while the misconfiguration stayed invisible. Nothing
          // was forwarded — buildForwardHeaders threw before returning any headers.
          failClosed(res, 502, `llm-relay configuration: ${e.message}`);
          h.logger.write(baseLog(started, path, hadTools, false, 502, "skipped", null));
          return;
        }
        const aborted = controller.signal.aborted;
        const status = aborted ? 504 : 502;
        globalCircuitBreaker.recordOutcome(target, { ok: false, status, elapsedMs: Date.now() - started });
        recordCall(target, false, started);

        // Failover if additional candidates exist
        if (i < healthyTargets.length - 1) {
          continue;
        }

        failClosed(res, status, aborted ? "backend timed out" : `backend unreachable: ${(e as Error).message}`);
        h.logger.write(baseLog(started, path, hadTools, false, status, "skipped", target));
        return;
      }

      // Check HTTP 400 / 404 / 429 / 5xx for failover to next candidate
      const isRetriableError = backendRes.status === 400 || backendRes.status === 404 || backendRes.status === 429 || backendRes.status >= 500;
      if (isRetriableError) {
        // A failing response is a breaker failure whether or not another candidate exists —
        // recording "success" on a last-candidate 429/5xx (the common single-candidate case)
        // resets the breaker on every error and it never trips.
        globalCircuitBreaker.recordOutcome(target, { ok: false, status: backendRes.status, elapsedMs: Date.now() - started });
        recordCall(target, false, started);
        if (i < healthyTargets.length - 1) {
          clearTimeout(timer);
          res.off("close", onResClose);
          continue; // Failover to next target
        }
      } else if (backendRes.status < 400) {
        globalCircuitBreaker.recordOutcome(target, { ok: true, status: backendRes.status, elapsedMs: Date.now() - started });
        recordCall(target, true, started);
      } else {
        // A non-retriable 4xx — 401/403 above all — is neither a success nor evidence
        // about the target's health, so the breaker is told NOTHING. It used to be told
        // `ok: true`, which cleared `consecutiveFailures` and refreshed the stability
        // score: a revoked or exhausted key made every request look like a healthy,
        // fast response, so the breaker could never trip and the candidate stayed at the
        // front of the ranking while failing 100% of calls. Recording a failure instead
        // would be the opposite error — it would open the breaker on a credential fault
        // and hide the 401 the operator needs to see behind a "target unhealthy" skip.
        // Telemetry still records the call as unsuccessful; that dataset is about
        // outcomes, not about whether to keep routing here.
        recordCall(target, false, started);
      }

      const streamed = (backendRes.headers.get("content-type") ?? "").includes("text/event-stream");
      const willValidate = isMessages && hadTools && backendRes.status < 400;
      const reshaper = h.resolveReshaper(target);
      const doRepair = cfg.mode === "repair" && willValidate && reshaper !== undefined;

      if (doRepair) {
        await repairPath(res, backendRes, timer, { tools, wantsStream, streamed, started, path, hadTools, reshaper: reshaper!, maxAttempts: cfg.repair.maxAttempts, req, target }, h);
      } else {
        await transparentPath(res, backendRes, timer, { tools, streamed, willValidate, started, path, hadTools, req, target }, h);
      }
      return;
    } finally {
      clearTimeout(timer);
      res.off("close", onResClose);
    }
  }
}

/**
 * Feed the proxy's own request outcome into runtime telemetry — the "observed traffic"
 * evidence `getStrength()` ranks on (basis "telemetry") and `/candidates` reports under
 * `observed`. Only targets with a concrete model id are recorded; the Anthropic passthrough
 * has none. Skipped under vitest so tests never write the user's real telemetry file.
 */
function recordCall(target: ResolvedTarget, ok: boolean, started: number): void {
  if (!target.model || process.env.VITEST) return;
  try {
    recordModelCall(target.provider, target.model, { ok, latencyMs: Date.now() - started });
  } catch {
    /* telemetry is best-effort, never in the request's way */
  }
}

interface Ctx {
  tools: Map<string, JsonSchema | null>;
  streamed: boolean;
  started: number;
  path: string;
  hadTools: boolean;
  req?: IncomingMessage;
  /**
   * The target this response actually came from — the resolved (provider, model)
   * after tier/pool expansion, subagent redirection and failover. Every log record
   * and the reshaper's `backendModel` read it, so a repair attributes the malformed
   * call to the deployment that produced it rather than to whatever id the client
   * happened to send.
   */
  target: ResolvedTarget;
}

/**
 * OpenAI front: reverse-proxy the resolved target's /chat/completions to the client,
 * verbatim (streaming or buffered). No Anthropic translation, no tool-call repair —
 * this is the multiplexer path a dispatcher uses to reach many backends by namespace.
 */
async function openAiFrontPath(
  res: ServerResponse,
  target: ResolvedTarget,
  ctx: { reqJson: unknown; wantsStream: boolean; started: number; path: string; hadTools: boolean; req?: IncomingMessage },
  h: Handlers,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs);
  const onResClose = () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };
  res.on("close", onResClose);

  let upstream: Response;
  try {
    upstream = await fetchOpenAiFront(target, { reqJson: ctx.reqJson, wantsStream: ctx.wantsStream, signal: controller.signal });
    recordCall(target, upstream.status < 400, ctx.started);
  } catch (e) {
    clearTimeout(timer);
    res.off("close", onResClose);
    recordCall(target, false, ctx.started);
    const aborted = controller.signal.aborted;
    const status = aborted ? 504 : 502;
    if (!res.headersSent) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: aborted ? "backend timed out" : `backend unreachable: ${(e as Error).message}`, type: "api_error" } }));
    }
    h.logger.write(baseLog(ctx.started, ctx.path, ctx.hadTools, false, status, "skipped", target));
    return;
  }
  const streamed = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  try {
    res.writeHead(upstream.status, filterResponseHeaders(upstream.headers));
    if (upstream.body) {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        if (!await writeChunk(res, Buffer.from(chunk))) break;
      }
    }
    if (!res.writableEnded) res.end();
  } catch (e) {
    const message = midStreamMessage(e);
    endMidStreamFailure(res, streamed ? openAiSseError(message) : null, message);
    h.logger.write({
      ...baseLog(ctx.started, ctx.path, ctx.hadTools, streamed, upstream.status, "skipped", target),
      errorKinds: [MID_STREAM_ERROR_KIND],
    });
    return;
  } finally {
    clearTimeout(timer);
    res.off("close", onResClose);
  }
  h.logger.write(baseLog(ctx.started, ctx.path, ctx.hadTools, streamed, upstream.status, "skipped", target));
}

/** detect/default: forward bytes unchanged, observe + log if applicable. */
async function transparentPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: Ctx & { willValidate: boolean },
  h: Handlers,
): Promise<void> {
  res.writeHead(backendRes.status, filterResponseHeaders(backendRes.headers));
  let assistant: AssistantMessage | null = null;
  try {
    if (!backendRes.body) {
      if (!res.writableEnded) res.end();
    } else if (ctx.streamed) {
      const decoder = new TextDecoder();
      let acc = "";
      let overflow = false;
      for await (const chunk of backendRes.body as unknown as AsyncIterable<Uint8Array>) {
        if (!await writeChunk(res, Buffer.from(chunk))) break;
        if (ctx.willValidate && !overflow) {
          acc += decoder.decode(chunk, { stream: true });
          if (acc.length > MAX_VALIDATE_BYTES) overflow = true;
        }
      }
      if (!res.writableEnded) res.end();
      if (ctx.willValidate && !overflow) assistant = reconstructFromSse(acc + decoder.decode());
    } else {
      const bytes = Buffer.from(await backendRes.arrayBuffer());
      if (!res.writableEnded) res.end(bytes);
      if (ctx.willValidate && bytes.length <= MAX_VALIDATE_BYTES) assistant = parseAssistant(bytes.toString("utf8"));
    }
  } catch (e) {
    // The head was committed at the top of this function, so the client is already
    // reading a 200. Say the stream broke rather than closing on a truncated answer,
    // and LOG the turn — this throw used to escape to the top-level catch, which
    // could only `res.end()` and never logged.
    const message = midStreamMessage(e);
    endMidStreamFailure(res, ctx.streamed ? sseError(message) : null, message);
    h.logger.write({
      ...baseLog(ctx.started, ctx.path, ctx.hadTools, ctx.streamed, backendRes.status, "skipped", ctx.target),
      errorKinds: [MID_STREAM_ERROR_KIND],
    });
    return;
  } finally {
    clearTimeout(timer);
  }

  let validated: RequestLog["validated"] = "skipped";
  let toolUseCount = 0;
  let uncheckableCount = 0;
  let errorKinds: string[] = [];
  if (ctx.willValidate && assistant) {
    const r = h.validator.validate(assistant, ctx.tools);
    validated = r.errors.length > 0 ? "fail" : r.uncheckableCount > 0 ? "uncheckable" : "pass";
    toolUseCount = r.toolUseCount;
    uncheckableCount = r.uncheckableCount;
    errorKinds = dedupe(r.errors.map((e) => e.kind));
  }
  h.logger.write({
    ...baseLog(ctx.started, ctx.path, ctx.hadTools, ctx.streamed, backendRes.status, validated, ctx.target),
    toolUseCount, uncheckableCount, errorKinds,
  });
}

/**
 * `maxAttempts` is carried from `cfg.repair.maxAttempts` rather than read at the call
 * site. Both `repair()` call sites passed a hardcoded `2`, so the configured value —
 * parsed, validated and documented in `config.ts`, and settable per install — was
 * silently ignored on every request.
 */
type RepairCtx = Ctx & { wantsStream: boolean; reshaper: Reshaper; maxAttempts: number };

/** repair: route to the streaming or buffered variant. */
async function repairPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: RepairCtx,
  h: Handlers,
): Promise<void> {
  if (ctx.streamed) {
    await repairStreamingPath(res, backendRes, timer, ctx, h);
  } else {
    await repairBufferedPath(res, backendRes, timer, ctx, h);
  }
}

/**
 * repair, streaming: forward text-block SSE frames to the client as they arrive;
 * withhold everything from the first tool_use `content_block_start` onward. At
 * end-of-stream, validate the reconstructed message — if the tool calls are valid,
 * flush the withheld frames byte-for-byte (fully transparent); if invalid, repair
 * and re-emit only the corrected trailing blocks. `message_start` and any leading
 * text have already reached the client, so a pure-text response streams through
 * with zero added latency.
 */
async function repairStreamingPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: RepairCtx,
  h: Handlers,
): Promise<void> {
  const filtered = filterResponseHeaders(backendRes.headers);
  const decoder = new TextDecoder();
  let acc = "";                 // full decoded stream, for reconstruction
  let overflow = false;         // acc exceeded the validate cap → give up repair
  let work = Buffer.alloc(0);   // raw bytes not yet split into complete frames
  const held: Buffer[] = [];    // frames withheld from the client (first tool_use onward)
  let buffering = false;
  let firstToolUseIndex = -1;
  let headWritten = false;

  const ensureHead = () => {
    if (!headWritten) {
      res.writeHead(backendRes.status, filtered);
      headWritten = true;
    }
  };
  const forward = async (frame: Buffer) => {
    ensureHead();
    await writeChunk(res, frame);
  };
  const flushHeld = async () => {
    for (const f of held) {
      if (res.destroyed) break;
      await forward(f);
    }
    held.length = 0;
  };

  const processFrame = async (frame: Buffer): Promise<void> => {
    if (!overflow) {
      acc += frame.toString("utf8");
      if (acc.length > MAX_VALIDATE_BYTES) {
        // Too large to validate/repair safely: stop holding, stream the rest.
        overflow = true;
        if (buffering) {
          await flushHeld();
          buffering = false;
        }
      }
    }
    if (buffering) {
      held.push(frame);
      return;
    }
    const toolUseIdx = overflow ? null : frameOpensToolUse(frame);
    if (toolUseIdx !== null) {
      buffering = true;
      firstToolUseIndex = toolUseIdx;
      held.push(frame);
      return;
    }
    await forward(frame);
  };

  try {
    if (backendRes.body) {
      for await (const chunk of backendRes.body as unknown as AsyncIterable<Uint8Array>) {
        if (res.destroyed) break;
        work = work.length ? Buffer.concat([work, Buffer.from(chunk)]) : Buffer.from(chunk);
        let end: number;
        while ((end = frameEnd(work)) !== -1) {
          const frame = work.subarray(0, end);
          work = Buffer.from(work.subarray(end)); // detach from the growing buffer
          await processFrame(frame);
        }
      }
    }
    if (work.length) await processFrame(work); // trailing partial frame
  } catch (e) {
    // The upstream stream broke part-way. Anything withheld in `held` is a partial
    // tool call and is DROPPED rather than flushed — half a tool_use is exactly the
    // malformed call this proxy exists to keep out of the harness — and the client
    // gets an explicit error event instead of a stream that simply stops. If the
    // head has not been written yet (a failure before any text frame) this is still
    // a clean 502. Either way the turn is logged.
    const message = midStreamMessage(e);
    held.length = 0;
    endMidStreamFailure(res, sseError(message), message);
    h.logger.write({
      ...baseLog(ctx.started, ctx.path, ctx.hadTools, true, backendRes.status, "skipped", ctx.target),
      errorKinds: [MID_STREAM_ERROR_KIND],
    });
    return;
  } finally {
    clearTimeout(timer);
  }

  let validated: RequestLog["validated"] = "skipped";
  let toolUseCount = 0;
  let uncheckableCount = 0;
  let errorKinds: string[] = [];
  let repairOutcome: RepairOutcome | "none" = "none";

  if (overflow || !buffering) {
    // Nothing was withheld (pure text, or gave up): stream already complete.
    if (!buffering) {
      const assistant = overflow ? null : reconstructFromSse(acc);
      if (assistant) {
        const r = h.validator.validate(assistant, ctx.tools);
        validated = r.errors.length > 0 ? "fail" : r.uncheckableCount > 0 ? "uncheckable" : "pass";
        toolUseCount = r.toolUseCount;
        uncheckableCount = r.uncheckableCount;
        errorKinds = dedupe(r.errors.map((e) => e.kind));
      }
    }
    ensureHead();
    if (!res.writableEnded) res.end();
  } else {
    const assistant = reconstructFromSse(acc);
    const r = h.validator.validate(assistant, ctx.tools);
    toolUseCount = r.toolUseCount;
    uncheckableCount = r.uncheckableCount;
    if (r.valid) {
      validated = r.uncheckableCount > 0 ? "uncheckable" : "pass";
      await flushHeld();
      ensureHead();
      if (!res.writableEnded) res.end();
    } else {
      validated = "fail";
      errorKinds = dedupe(r.errors.map((e) => e.kind));
      const decision = await repair(assistant, ctx.tools, {
        validator: h.validator,
        reshaper: ctx.reshaper,
        maxAttempts: ctx.maxAttempts,
        isDestructive: h.isDestructive,
        backendModel: ctx.target.model ?? null,
      });
      repairOutcome = decision.outcome;
      ensureHead(); // message_start + leading text already forwarded
      if (decision.outcome === "fixed" && decision.message) {
        if (!res.writableEnded) res.end(emitSseTail(decision.message, firstToolUseIndex));
      } else {
        // Head already committed — surface a mid-stream SSE error, never a fabricated call.
        if (!res.writableEnded) res.end(sseError(`llm-relay: tool call could not be repaired (${decision.outcome})`));
      }
    }
  }

  h.logger.write({
    ...baseLog(ctx.started, ctx.path, ctx.hadTools, true, backendRes.status, validated, ctx.target),
    toolUseCount, uncheckableCount, errorKinds, repair: repairOutcome,
  });
}

/** repair, buffered (non-streamed JSON): buffer, validate; if invalid, reshape and re-emit. */
async function repairBufferedPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: RepairCtx,
  h: Handlers,
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await backendRes.arrayBuffer());
  } catch (e) {
    // Nothing has been written yet on this path, so this is a clean 502 rather than
    // a truncated body — but it still has to be LOGGED, which the bare finally did
    // not do: the throw went straight to the top-level catch.
    const message = midStreamMessage(e);
    endMidStreamFailure(res, null, message);
    h.logger.write({
      ...baseLog(ctx.started, ctx.path, ctx.hadTools, ctx.streamed, backendRes.status, "skipped", ctx.target),
      errorKinds: [MID_STREAM_ERROR_KIND],
    });
    return;
  } finally {
    clearTimeout(timer);
  }
  const assistant = ctx.streamed
    ? reconstructFromSse(bytes.toString("utf8"))
    : parseAssistant(bytes.toString("utf8"));

  const filtered = filterResponseHeaders(backendRes.headers);
  let repairOutcome: RepairOutcome | "none" = "none";
  let validated: RequestLog["validated"] = "skipped";
  let toolUseCount = 0;
  let uncheckableCount = 0;
  let errorKinds: string[] = [];

  if (!assistant) {
    // Couldn't parse — forward unchanged.
    res.writeHead(backendRes.status, filtered);
    if (!res.writableEnded) res.end(bytes);
  } else {
    const r = h.validator.validate(assistant, ctx.tools);
    toolUseCount = r.toolUseCount;
    uncheckableCount = r.uncheckableCount;
    if (r.valid) {
      validated = r.uncheckableCount > 0 ? "uncheckable" : "pass";
      res.writeHead(backendRes.status, filtered); // pass through untouched
      if (!res.writableEnded) res.end(bytes);
    } else {
      validated = "fail";
      errorKinds = dedupe(r.errors.map((e) => e.kind));
      const decision = await repair(assistant, ctx.tools, {
        validator: h.validator,
        reshaper: ctx.reshaper,
        maxAttempts: ctx.maxAttempts,
        isDestructive: h.isDestructive,
        backendModel: ctx.target.model ?? null,
      });
      repairOutcome = decision.outcome;
      if (decision.outcome === "fixed" && decision.message) {
        emitFixed(res, backendRes.status, filtered, decision.message, ctx.wantsStream);
      } else {
        // fail-clean: loud, well-formed error rather than a silently broken call.
        failClosed(res, 502, `llm-relay: tool call could not be repaired (${decision.outcome})`);
      }
    }
  }

  h.logger.write({
    ...baseLog(ctx.started, ctx.path, ctx.hadTools, ctx.streamed, backendRes.status, validated, ctx.target),
    toolUseCount, uncheckableCount, errorKinds, repair: repairOutcome,
  });
}

function emitFixed(
  res: ServerResponse,
  status: number,
  filtered: Record<string, string | string[]>,
  message: AssistantMessage,
  wantsStream: boolean,
): void {
  if (wantsStream) {
    res.writeHead(status, { ...filtered, "content-type": "text/event-stream" });
    if (!res.writableEnded) res.end(emitSse(message));
  } else {
    res.writeHead(status, { ...filtered, "content-type": "application/json" });
    if (!res.writableEnded) res.end(JSON.stringify(toAnthropicMessage(message)));
  }
}

/**
 * Re-serialize a repaired message as a buffered Anthropic Message — the JSON counterpart
 * of `emitSse`, and it now follows the same rules.
 *
 * It used to hardcode `id: "msg_repair"`, take `model` from what the CLIENT asked for (which
 * is routinely not the deployment that answered), and zero-fill `usage`. All three rewrote
 * the response's identity on the way through: every repaired turn looked like the same
 * message, attributed to the wrong model, reporting a token count nobody measured. The
 * backend's own values are carried whenever the response had them; an unknown id falls back
 * to the same relay-marked synthetic id the streaming path uses, and an unreported `usage`
 * is OMITTED rather than stated as zero.
 */
function toAnthropicMessage(msg: AssistantMessage): object {
  return {
    id: msg.id ?? syntheticMessageId(),
    type: "message",
    role: "assistant",
    model: msg.model ?? "",
    content: msg.content,
    stop_reason: msg.stop_reason ?? "end_turn",
    stop_sequence: msg.stop_sequence ?? null,
    ...(msg.usage ? { usage: msg.usage } : {}),
  };
}

/** A provider declared an authEnv whose variable is unset — a configuration error, not a passthrough. */
export class CredentialConfigError extends Error {
  constructor(provider: string, authEnv: string) {
    super(`provider "${provider}" declares authEnv ${authEnv} but it is unset or blank`);
    this.name = "CredentialConfigError";
  }
}

/**
 * The headers forwarded upstream for one request (INV-HS-8).
 *
 * Exported so the `declared-missing` branch is directly assertable: it is meant to
 * be unreachable through the request path (`resolveTargets` drops keyless targets),
 * so an end-to-end test cannot reach it, and an invariant nothing can check is an
 * invariant that quietly stops holding.
 *
 * The three `CredentialState`s are three different obligations:
 *  - `not-declared`   — a real passthrough. The caller's own credential is FORWARDED;
 *                       that is the whole point of the anthropic passthrough.
 *  - `declared-present` — the provider's own key is attached and the caller's inbound
 *                       `Authorization`/`x-api-key` are REMOVED, never merged.
 *  - `declared-missing` — the caller's inbound `Authorization`/`x-api-key` are REMOVED
 *                       *and* the request fails. "Removed" is strictly stronger than
 *                       "we did not add one of our own": the defect this replaces
 *                       satisfied the weaker reading while forwarding the caller's
 *                       Anthropic token verbatim to a third-party base URL.
 */
export function buildForwardHeaders(inbound: IncomingMessage["headers"], target: ResolvedTarget): Record<string, string> {
  const state = credentialState(target.authEnv);
  const apiKey = state === "declared-present" ? process.env[target.authEnv!]?.trim() : undefined;
  // Containment is DECLARED, not inferred from key presence. The old
  // `stripAuth = !!apiKey` was identically falsy for two opposite configurations —
  // "no authEnv declared" (an intentional passthrough: forward the caller's own
  // credential) and "authEnv declared but unset" (a misconfiguration) — so in the
  // second case the caller's own Anthropic token was forwarded verbatim to a
  // third-party base URL. Only a real passthrough forwards inbound auth now.
  const stripAuth = state !== "not-declared";
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inbound)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    // The REMOVAL, for both declared states. It happens before the throw below so
    // that no code path can observe a header map still carrying the caller's
    // credential — not the throw's own error, not a future caller that decides to
    // handle the error and reuse what was built.
    if (stripAuth && INBOUND_AUTH.includes(key)) continue;
    if (v === undefined) continue;
    out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  if (!out["anthropic-version"]) out["anthropic-version"] = DEFAULT_ANTHROPIC_VERSION;
  if (state === "declared-missing") {
    // Should be unreachable — resolveTargets drops keyless targets — but thrown
    // rather than silently proceeding so a routing change that lets one through
    // fails loudly instead of egressing whatever the caller happened to send.
    throw new CredentialConfigError(target.provider, target.authEnv!);
  }
  if (apiKey) {
    if (target.authHeader === "authorization") out["authorization"] = `Bearer ${apiKey}`;
    else out["x-api-key"] = apiKey;
  }
  return out;
}

function filterResponseHeaders(hh: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  hh.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) return;
    if (k === "set-cookie") return;
    out[key] = value;
  });
  if (typeof hh.getSetCookie === "function") {
    const cookies = hh.getSetCookie();
    if (cookies.length > 0) {
      out["set-cookie"] = cookies;
    }
  } else {
    const sc = hh.get("set-cookie");
    if (sc) out["set-cookie"] = sc;
  }
  return out;
}

/**
 * Parse a buffered (non-streamed) backend response into the shape the validator inspects.
 *
 * `id` / `model` / `stop_sequence` are read here for the same reason `reconstructFromSse`
 * reads them off `message_start`: a repaired buffered response is re-serialized from this
 * shape, so anything not captured here is gone by the time it is re-emitted — which is how
 * every repaired non-streamed turn used to go out under the constant `msg_repair` with the
 * backend's real id discarded. Absent fields stay absent; nothing is invented.
 */
function parseAssistant(text: string): AssistantMessage | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (!Array.isArray(j.content)) return null;
    const msg: AssistantMessage = {
      content: j.content as AssistantMessage["content"],
      stop_reason: (j.stop_reason ?? null) as AssistantMessage["stop_reason"],
      usage: j.usage as AssistantMessage["usage"],
    };
    if (typeof j.id === "string" && j.id) msg.id = j.id;
    if (typeof j.model === "string" && j.model) msg.model = j.model;
    if (typeof j.stop_sequence === "string" || j.stop_sequence === null) {
      msg.stop_sequence = j.stop_sequence;
    }
    return msg;
  } catch {
    return null;
  }
}

/**
 * End offset (exclusive) of the first complete SSE frame in `buf`, or -1 if no
 * frame boundary is present yet. Frames are delimited by a blank line — `\n\n`
 * (LF) or `\r\n\r\n` (CRLF); whichever boundary comes first wins. Operates on
 * raw bytes so multibyte UTF-8 in event payloads is never split.
 */
function frameEnd(buf: Buffer): number {
  const lf = buf.indexOf("\n\n", 0, "latin1");
  const crlf = buf.indexOf("\r\n\r\n", 0, "latin1");
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return crlf + 4;
  return lf + 2;
}

/**
 * If `frame` is a `content_block_start` event opening a `tool_use` block, return
 * its block index; otherwise null. This is the trigger to start withholding.
 */
function frameOpensToolUse(frame: Buffer): number | null {
  const dataLines: string[] = [];
  for (const line of frame.toString("utf8").split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  let evt: unknown;
  try {
    evt = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
  if (typeof evt !== "object" || evt === null) return null;
  const e = evt as { type?: unknown; index?: unknown; content_block?: { type?: unknown } };
  if (e.type !== "content_block_start") return null;
  if (!e.content_block || e.content_block.type !== "tool_use") return null;
  return typeof e.index === "number" ? e.index : 0;
}

/** A single Anthropic-style SSE `error` event, for failing an already-open stream. */
function sseError(message: string): string {
  const data = JSON.stringify({ type: "error", error: { type: "api_error", message } });
  return `event: error\ndata: ${data}\n\n`;
}

/** The OpenAI-front equivalent: an error object in a plain `data:` frame. */
function openAiSseError(message: string): string {
  return `data: ${JSON.stringify({ error: { message, type: "api_error" } })}\n\n`;
}

/**
 * The log `errorKinds` entry for an upstream body that failed part-way through.
 *
 * A distinct kind, not a validator error kind: the response was never validated,
 * it was cut off. It is what makes a truncated turn greppable in the log at all.
 */
const MID_STREAM_ERROR_KIND = "backend_stream_failed";

/**
 * Terminate a response whose upstream body threw PART-WAY THROUGH.
 *
 * By the time a body is consumed the head is usually already committed, so
 * `failClosed` degrades to a bare `res.end()` and the client cannot tell a
 * truncated answer from a complete one. Where the committed response is a stream
 * we can still say so — `errorFrame` carries the protocol-appropriate error event
 * (Anthropic `event: error`, or an OpenAI `data:` frame on the OpenAI front) —
 * and where it is not, closing is all that remains. Pass `null` for a committed
 * non-stream response; inventing a frame in the wrong protocol is worse than
 * closing.
 *
 * ⚠ The caller MUST also write a log record. Previously the throw propagated out
 * of these paths past `h.logger.write` to `createProxy`'s top-level catch, so a
 * mid-stream backend failure produced a truncated 200 AND no log line at all —
 * invisible to the operator, and indistinguishable from success to the client.
 */
function endMidStreamFailure(res: ServerResponse, errorFrame: string | null, message: string): void {
  if (res.writableEnded || res.destroyed) return;
  if (!res.headersSent) {
    failClosed(res, 502, message);
    return;
  }
  res.end(errorFrame ?? undefined);
}

/** The client-facing description of a mid-transfer upstream failure. */
function midStreamMessage(e: unknown): string {
  return `llm-relay: backend stream failed mid-response: ${(e as Error).message}`;
}

function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };

    const onData = (c: Buffer) => {
      if (done) return;
      total += c.length;
      if (total > maxBytes) {
        done = true;
        cleanup();
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(c);
    };

    const onEnd = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

async function writeChunk(res: ServerResponse, chunk: Buffer): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  try {
    const ok = res.write(chunk);
    if (!ok && !res.destroyed && !res.writableEnded) {
      await once(res, "drain");
    }
    return !res.destroyed && !res.writableEnded;
  } catch {
    return false;
  }
}

function failClosed(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
}

/**
 * Build the metadata record for one turn.
 *
 * `served` is the target a backend request was actually DISPATCHED to, or `null`
 * when none was — a guardrail rejection, a routing error, an admin endpoint, or
 * anything answered locally. It is a required parameter, without a default, so
 * `tsc` names every call site that has not decided which of the two it is; a
 * default would quietly turn "nobody decided" into a confident claim.
 *
 * The model the CLIENT asked for is deliberately NOT recorded (OBS-b5ade458 is
 * finished): routing resolves a tier/pool spec to a `ResolvedTarget`, so it is
 * routinely not the model that answered, and it was the id every "which model
 * trips the validator" reading of this log was attributed to.
 */
function baseLog(
  started: number, path: string, hadTools: boolean,
  streamed: boolean, backendStatus: number, validated: RequestLog["validated"],
  served: ResolvedTarget | null,
): RequestLog {
  return {
    ts: new Date(started).toISOString(),
    path: logSafePath(path),
    servedProvider: served ? served.provider : null,
    servedModel: served ? served.model ?? null : null,
    hadTools, streamed, backendStatus, validated,
    toolUseCount: 0, uncheckableCount: 0, errorKinds: [], repair: "none",
    latencyMs: Date.now() - started,
  };
}

/**
 * A request path is metadata; the VALUES in its query string are not. `?task=`
 * carries user prose, so logging the raw path put request content into a log this
 * project promises is metadata-only. Keep the route and the parameter NAMES,
 * replace each value with its length.
 */
export function logSafePath(path: string): string {
  const q = path.indexOf("?");
  if (q === -1) return path;
  const route = path.slice(0, q);
  const params = new URLSearchParams(path.slice(q + 1));
  const shape = [...params.keys()].map((k) => `${k}=<${params.get(k)?.length ?? 0}c>`).join("&");
  return shape ? `${route}?${shape}` : route;
}

/**
 * Cheap local token estimate for a /v1/messages/count_tokens request against an
 * OpenAI backend (which has no native count_tokens). ~4 chars/token over all
 * string content in system+messages+tools. Advisory only — the harness uses this
 * for context-budget bookkeeping, not correctness.
 */
function estimateInputTokens(body: unknown): number {
  if (typeof body !== "object" || body === null) return 0;
  let chars = 0;
  const walk = (v: unknown): void => {
    if (typeof v === "string") chars += v.length;
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  const b = body as Record<string, unknown>;
  walk(b.system);
  walk(b.messages);
  walk(b.tools);
  return Math.max(1, Math.ceil(chars / 4));
}

function pickString(obj: unknown, key: string): string | null {
  if (typeof obj === "object" && obj !== null) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return null;
}

/** Read one query-string param off a raw request path. */
function pickQuery(path: string, key: string): string | null {
  const q = path.indexOf("?");
  if (q === -1) return null;
  return new URLSearchParams(path.slice(q + 1)).get(key);
}

function pickBool(obj: unknown, key: string): boolean {
  return typeof obj === "object" && obj !== null && (obj as Record<string, unknown>)[key] === true;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
