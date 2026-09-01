import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  resolveTargets,
  reshaperForTarget,
  subagentSpec,
  clientForPath,
  offloadRule,
  RoutingError,
  type Config,
  type ResolvedTarget,
} from "./config.js";
import { MetadataLogger } from "./log.js";
import { resolveCredential } from "./authEnv.js";
import { parseCredentialId } from "./credential-id.js";
import type { ResolvedAttempt } from "./resolved-attempt.js";
import {
  CredentialLru,
  CredentialWalk,
  groupCredentialAttempts,
  rankCredentialAttempts,
} from "./credential-select.js";
import { ToolUseValidator } from "./validator.js";
import { destructiveMatcher } from "./repair.js";
import {
  CredentialWalkReshaper,
  HttpReshaper,
  type Reshaper,
} from "./reshaper.js";
import { ModelCatalog } from "./catalog.js";
import { handleAdminRoutes } from "./routes/admin.js";
import { toolSchemaMap } from "./anthropic.js";
import { PingLoop } from "./ping/cadence.js";
import { recordModelCall } from "./ping/runtime-telemetry.js";
import {
  NOOP_ACCOUNTING_RECORDER,
  type AccountingPricePort,
  type AccountingRecorder,
} from "./accounting.js";
import {
  RequestAccountingState,
  withRepairAccounting,
  isCallerVisibleAccountingPath,
  recordEarlyTerminalAccounting,
  buildAccountingPricePort,
  type ModelCallRecorder,
} from "./accounting-state.js";
import type { AccountingReader, AccountingStore } from "./accounting-store.js";
import { DashboardAuthManager } from "./dashboard-auth.js";
import { handleDashboardRoute, type DashboardHeaderMap, type DashboardRouteHandled } from "./dashboard-routes.js";
import { createDashboardSnapshotReadPort } from "./dashboard-snapshot.js";
import { createAvailabilityProducer } from "./availability-snapshot.js";
import {
  DASHBOARD_STATIC_SECURITY_HEADERS,
  DashboardStaticHandler,
  getProductionDashboardAssetRoot,
} from "./dashboard-static.js";
import type { AttributionPolicy } from "./dashboard-contract.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { installBreakerPersistence } from "./breaker-persistence.js";
import { installDispatchExhaustionPersistence } from "./dispatch-exhaustion-persistence.js";
import { LaneCadence } from "./lane-cadence.js";
import { estimateRequestTokens, assessCost, type CostClass } from "./metadata.js";
import { materializeDynamicPools } from "./dynamic-pools.js";
import { baseLog } from "./request-log.js";
import { observedContextLimit } from "./context-limits.js";
import { isCostBlocked } from "./target-facts.js";
import { createQuotaDemotionFn, type QuotaDemotionFn } from "./quota-demotion.js";
import { createLatencyDemotionFn, type LatencyDemotionFn } from "./latency-demotion.js";
import { hedgeDelayDecision, resolveHedgeSettings, type HedgeVerdict } from "./hedge-trigger.js";
import { createHardCapLedgerReader, evaluateHardCap, type HardCapVerdict } from "./hard-cap.js";
import {
  createControlAuthorization,
  resolveControlAuthorizationConfigDir,
  validateControlAuthorization,
  type ControlAuthorizationPort,
} from "./control-authorization.js";
import {
  deriveSessionKey,
  StickySessionManager,
} from "./session-pin.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  failClosed,
  readBody,
} from "./stream-pipeline.js";
import {
  applyStickyOrdering,
  CredentialAttemptTrace,
  credentialEvidence,
  DEFAULT_WALK_BUDGET_MS,
  expandCredentialAttempts,
  freeOnlyApplies,
  orderDeploymentGroupsByUsability,
  stickyProvenanceHeaders,
  type CostClassFn,
  type StickyRequestContext,
} from "./candidate-runner.js";
import { detectOpenAiFrontProtocol, openAiFrontPath } from "./routes/openai-front.js";
import { anthropicMessagesPath } from "./routes/messages.js";

export { baseLog, logSafePath } from "./request-log.js";
export { DEFAULT_MAX_BODY_BYTES } from "./stream-pipeline.js";
export { orderByUsability, classifyStatus, buildForwardHeaders, CredentialConfigError } from "./candidate-runner.js";

export const TOKENLESS_CONTROL_READ_PATHS = Object.freeze([
  "/v1/models",
  "/models",
  "/offload",
  "/dispatch",
  "/telemetry",
] as const);
const TOKENLESS_CONTROL_READS = new Set<string>(TOKENLESS_CONTROL_READ_PATHS);

const CONTROL_ROUTES = new Set([
  ...TOKENLESS_CONTROL_READS,
  "/cooldowns/clear",
  "/registry",
  "/ping",
  "/health/stats",
  "/health",
  "/candidates",
]);

interface NormalizedAuthority {
  hostname: string;
  port: number;
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

function parseAuthority(raw: string | undefined, scheme: "http:" | "https:"): NormalizedAuthority | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes(",")) return null;
  try {
    const url = new URL(`${scheme}//${raw}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    const port = url.port ? Number(url.port) : scheme === "https:" ? 443 : 80;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
    return { hostname: normalizeHostname(url.hostname), port };
  } catch {
    return null;
  }
}

function parseOrigin(raw: string | string[] | undefined): (NormalizedAuthority & { scheme: string }) | null {
  if (typeof raw !== "string" || raw.length === 0 || raw === "null" || raw.includes(",")) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
    return { scheme: url.protocol, hostname: normalizeHostname(url.hostname), port };
  } catch {
    return null;
  }
}

function listenerAuthority(server: Server, cfg: Config): NormalizedAuthority | null {
  const address = server.address();
  if (!address || typeof address === "string") return null;
  const configuredHost = typeof cfg.host === "string" && cfg.host.length > 0 ? cfg.host : address.address;
  return { hostname: normalizeHostname(configuredHost), port: address.port };
}

function admissionFailure(
  req: IncomingMessage,
  pathname: string,
  server: Server,
  cfg: Config,
  authorization: ControlAuthorizationPort | undefined,
): string | null {
  const expected = listenerAuthority(server, cfg);
  if (!expected) return "listener authority is unavailable";

  const rawHostValues = req.rawHeaders
    .filter((_, index) => index % 2 === 0)
    .filter((name) => name.toLowerCase() === "host");
  const host = parseAuthority(req.headers.host, "http:");
  if (rawHostValues.length !== 1 || !host || host.hostname !== expected.hostname || host.port !== expected.port) {
    return "Host authority does not match the bound listener";
  }

  if (Object.hasOwn(req.headers, "origin")) {
    const origin = parseOrigin(req.headers.origin);
    if (!origin || origin.scheme !== "http:" || origin.hostname !== expected.hostname || origin.port !== expected.port) {
      return "Origin does not match the bound listener";
    }
  }

  const mutating = req.method !== "GET" && req.method !== "HEAD";
  if (mutating) {
    const ct = (req.headers["content-type"] ?? "").toString().split(";")[0]?.trim().toLowerCase();
    if (ct !== "application/json") {
      return `mutating requests require content-type: application/json (got ${ct || "none"})`;
    }
  }

  const isControlRoute = CONTROL_ROUTES.has(pathname);
  const isTokenlessRead = req.method === "GET" && TOKENLESS_CONTROL_READS.has(pathname);
  if (isControlRoute && !isTokenlessRead && !validateControlAuthorization(authorization, req.headers)) {
    return "control authorization required";
  }
  return null;
}

const UNAVAILABLE_ACCOUNTING_READER: AccountingReader = Object.freeze({
  readDay: () => ({ status: "missing" as const, value: null }),
  readDays: () => ({
    status: "missing" as const,
    days: [],
    results: [],
    missingDates: [],
    corruptDates: [],
    capped: false,
  }),
  readLifetime: () => ({ status: "missing" as const, value: null }),
  readRecent: () => ({ status: "missing" as const, value: null }),
  readDetail: () => ({ status: "missing" as const, value: null }),
});

export interface ProxyDeps {
  reshaper?: Reshaper;
  catalog?: ModelCatalog;
  pingLoop?: PingLoop;
  breaker?: CircuitBreaker;
  modelCallRecorder?: ModelCallRecorder;
  accountingRecorder?: AccountingRecorder;
  accountingReader?: AccountingReader;
  accountingPricePortOverride?: AccountingPricePort | undefined;
  dashboardAssetRoot?: string;
  dashboardRelayVersion?: string;
  dashboardAttributionPolicy?: AttributionPolicy;
  controlAuthorization?: ControlAuthorizationPort | null;
}

function dashboardHeaders(req: IncomingMessage): DashboardHeaderMap {
  const headers: Record<string, string[]> = {};
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const key = (req.rawHeaders[index] ?? "").toLowerCase();
    const value = req.rawHeaders[index + 1] ?? "";
    if (key.length === 0) continue;
    const existing = headers[key];
    if (existing) existing.push(value);
    else headers[key] = [value];
  }
  return headers;
}

export function dashboardExpectedOriginForAuthority(hostname: string, port: number): string {
  const renderedHost = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `http://${renderedHost}:${port}`;
}

function dashboardExpectedOrigin(server: Server, cfg: Config): string | null {
  const expected = listenerAuthority(server, cfg);
  if (!expected) return null;
  return dashboardExpectedOriginForAuthority(expected.hostname, expected.port);
}

function dashboardNamespaceTarget(path: string): boolean {
  const rawPath = path.split("?", 1)[0] ?? "";
  if (!rawPath.includes("%")) return rawPath === "/dashboard" || rawPath.startsWith("/dashboard/");
  const percentTolerant = rawPath.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return percentTolerant.startsWith("/dashboard") || rawPath.startsWith("/dashboard%");
}

function writeDashboardResponse(res: ServerResponse, response: DashboardRouteHandled): void {
  res.writeHead(response.status, response.headers);
  res.end(response.body);
}

function failDashboardClosed(res: ServerResponse, status: number, message: string): void {
  failClosed(res, status, message, { ...DASHBOARD_STATIC_SECURITY_HEADERS, "Cache-Control": "no-store" });
}

async function handleDashboardAdapter(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  started: number,
  cfg: Config,
  h: Handlers,
): Promise<boolean> {
  if (!dashboardNamespaceTarget(path)) return false;

  const staticResponse = h.dashboardStatic.handle({ method: req.method ?? "GET", path });
  if (staticResponse.handled) {
    const staticHeaders = staticResponse.status === 404 || staticResponse.status === 405
      ? { ...DASHBOARD_STATIC_SECURITY_HEADERS, "Cache-Control": "no-store", ...staticResponse.headers }
      : staticResponse.headers;
    res.writeHead(staticResponse.status, staticHeaders);
    res.end(staticResponse.body);
    h.logger.write(baseLog(started, path, false, false, staticResponse.status, "skipped", null));
    return true;
  }

  const expectedOrigin = dashboardExpectedOrigin(h.server, cfg);
  if (expectedOrigin === null) {
    failDashboardClosed(res, 403, "listener authority is unavailable");
    h.logger.write(baseLog(started, path, false, false, 403, "skipped", null));
    return true;
  }

  const response = await handleDashboardRoute(
    {
      method: req.method ?? "GET",
      target: path,
      headers: dashboardHeaders(req),
      admission: {
        hostAuthorized: true,
        expectedOrigin,
        controlAuthorized: validateControlAuthorization(h.controlAuthorization, req.headers),
      },
      readBody: (maxBytes) => readBody(req, maxBytes),
    },
    { auth: h.dashboardAuth, read: h.dashboardRead },
  );

  if (response.handled) {
    writeDashboardResponse(res, response);
    h.logger.write(baseLog(started, path, false, false, response.status, "skipped", null));
    return true;
  }

  failDashboardClosed(res, 404, "dashboard route not found");
  h.logger.write(baseLog(started, path, false, false, 404, "skipped", null));
  return true;
}

export interface Handlers {
  validator: ToolUseValidator;
  logger: MetadataLogger;
  isDestructive: (name: string) => boolean;
  resolveReshaper: (attempt: ResolvedAttempt) => Reshaper | undefined;
  catalog: ModelCatalog;
  pingLoop?: PingLoop;
  breaker: CircuitBreaker;
  credentialLru: CredentialLru;
  modelCallRecorder?: ModelCallRecorder;
  accountingRecorder: AccountingRecorder;
  readonly accountingReader?: Pick<AccountingStore, "usedInWindow">;
  accountingPricePort: AccountingPricePort | undefined;
  dashboardAuth: DashboardAuthManager;
  dashboardStatic: DashboardStaticHandler;
  dashboardRead: ReturnType<typeof createDashboardSnapshotReadPort>;
  stickySessions?: StickySessionManager;
  controlAuthorization?: ControlAuthorizationPort;
  server: Server;
  quotaDemotion: QuotaDemotionFn;
  latencyDemotion: LatencyDemotionFn;
  hedgeDelay: (attempt: ResolvedAttempt) => { readonly delayMs: number; readonly basis: HedgeVerdict["basis"] } | null;
  hedgeMaxInFlight: number;
  costClassOf: CostClassFn;
  hardCap: (attempt: ResolvedAttempt, now: number) => HardCapVerdict | null;
}

function pickString(obj: unknown, key: string): string | null {
  if (typeof obj === "object" && obj !== null) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return null;
}

function pickBool(obj: unknown, key: string): boolean {
  return typeof obj === "object" && obj !== null && (obj as Record<string, unknown>)[key] === true;
}

async function handle(req: IncomingMessage, res: ServerResponse, cfg: Config, h: Handlers): Promise<void> {
  const started = Date.now();
  const path = req.url ?? "/";
  const pathname = path.split("?")[0] ?? path;
  const requestClient = clientForPath(pathname);

  const admissionErr = admissionFailure(req, pathname, h.server, cfg, h.controlAuthorization);
  if (admissionErr) {
    if (dashboardNamespaceTarget(path)) failDashboardClosed(res, 403, admissionErr);
    else failClosed(res, 403, admissionErr);
    h.logger.write(baseLog(started, path, false, false, 403, "skipped", null));
    return;
  }

  if (await handleDashboardAdapter(req, res, path, started, cfg, h)) return;

  let reqBuf: Buffer;
  try {
    reqBuf = await readBody(req, cfg.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg.includes("too large") ? 413 : 400;
    if (isCallerVisibleAccountingPath(req.method, pathname)) {
      recordEarlyTerminalAccounting(h.accountingRecorder, started, requestClient);
    }
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
  const handled = await handleAdminRoutes(req, res, pathname, path, started, reqJson, cfg, h);
  if (handled) return;

  let estimatedRequestTokens = estimateRequestTokens(reqJson);

  const accounting = isCallerVisibleAccountingPath(req.method, pathname)
    ? new RequestAccountingState(
      h.accountingRecorder,
      res,
      started,
      estimatedRequestTokens,
      requestClient,
      h.accountingPricePort,
      (provider, model, ms, tokens) => {
        h.pingLoop?.recordRequestLatency(
          provider,
          model,
          tokens === undefined ? { ms } : { ms, tokens },
        );
      },
    )
    : null;

  const isCountTokens = req.method === "POST" && pathname === "/v1/messages/count_tokens";
  const isMessages = req.method === "POST" && pathname === "/v1/messages";

  h.pingLoop?.noteUserActivity();

  let targetCandidates: ResolvedTarget[];
  let degradedSpecs: Set<string> | null = null;
  let addressedPool: string | null = null;
  try {
    const subSpec = subagentSpec(reqJson, model, cfg, req.headers, requestClient);
    const routedModel = subSpec ?? model;
    materializeDynamicPools(cfg, h.catalog);
    if (subSpec !== null) {
      reqBuf = Buffer.from(JSON.stringify(reqJson), "utf8");
      estimatedRequestTokens = estimateRequestTokens(reqJson);
    }
    targetCandidates = resolveTargets(routedModel, cfg);
    if (typeof routedModel === "string" && routedModel.startsWith("pool/")) {
      addressedPool = routedModel.slice("pool/".length);
      const tail = cfg.routing.poolDegraded?.[addressedPool];
      degradedSpecs = tail && tail.length > 0 ? new Set(tail) : null;
    }

    const addressesPool = typeof routedModel === "string" && routedModel.startsWith("pool/");
    if ((subSpec !== null || addressesPool) && freeOnlyApplies(offloadRule(cfg, requestClient), subSpec !== null)) {
      const kept: ResolvedTarget[] = [];
      let blocked: { spec: string; why: string } | null = null;
      for (const t of targetCandidates) {
        const assessment = t.kind === "openai" && t.model
          ? assessCost(t.model, h.catalog.cachedLimits(t.provider, t.model), cfg.providers[t.provider]?.tierType)
          : null;
        if (assessment?.costClass === "free" && !isCostBlocked(
          t.provider,
          null,
          t.model,
          { costClass: assessment.costClass },
        )) kept.push(t);
        else if (!blocked) {
          blocked = {
            spec: t.model ? `${t.provider}/${t.model}` : t.provider,
            why: !assessment
              ? "anthropic passthrough (primary quota)"
              : assessment.costClass === "free"
                ? "observed not free (the deployment stated it requires a subscription, or is gone)"
                : `${assessment.costClass} (${assessment.basis})`,
          };
        }
      }
      if (kept.length === 0) {
        failClosed(
          res, 503,
          `llm-relay: routing.offload.${requestClient}.freeOnly is on and "${routedModel}" resolved no free candidate` +
            (blocked ? ` — first blocked: ${blocked.spec}, assessed ${blocked.why}` : ""),
        );
        h.logger.write(baseLog(started, path, hadTools, false, 503, "skipped", null));
        return;
      }
      targetCandidates = kept;
    }
  } catch (e) {
    if (e instanceof RoutingError) {
      failClosed(res, 400, `llm-relay routing: ${e.message}`);
      h.logger.write(baseLog(started, path, hadTools, false, 400, "skipped", null));
      return;
    }
    throw e;
  }

  const openAiFrontProtocol = detectOpenAiFrontProtocol(req.method, pathname);
  const routingNow = Date.now();
  const attempts = expandCredentialAttempts(targetCandidates);
  if (attempts.length === 0) {
    failClosed(res, 502, "llm-relay configuration: no enabled credential slot is available for the resolved target");
    h.logger.write(baseLog(started, path, hadTools, false, 502, "skipped", null));
    return;
  }
  const rankedAttempts = rankCredentialAttempts(attempts, h.credentialLru, {
    evidenceFor: (attempt) => credentialEvidence(attempt, cfg, h.breaker, routingNow),
  });
  const { ordered: orderedAttempts, quotaDemotedFirst, latencyDemotedFirst } = orderDeploymentGroupsByUsability(
    rankedAttempts,
    h.breaker,
    routingNow,
    h.quotaDemotion,
    h.costClassOf,
    h.latencyDemotion,
  );
  let walkAttempts = orderedAttempts;
  let sticky: StickyRequestContext | null = null;
  if ((isMessages || openAiFrontProtocol) && h.stickySessions) {
    const key = deriveSessionKey(req.headers, reqJson);
    if (key) {
      const pinnedSpec = h.stickySessions.getPin(key, routingNow);
      sticky = {
        key,
        multiCandidateRoute: targetCandidates.length > 1,
        provenance: null,
      };
      if (pinnedSpec) {
        const applied = applyStickyOrdering(
          walkAttempts,
          pinnedSpec,
          h.breaker,
          degradedSpecs,
          routingNow,
          h.quotaDemotion,
          h.costClassOf,
        );
        walkAttempts = applied.targets;
        sticky.provenance = `${pinnedSpec} (${applied.status})`;
      }
    }
  }

  if ((isMessages || openAiFrontProtocol) && reqJson) {
    const estimatedTokens = estimatedRequestTokens;
    if (estimatedTokens > 0) {
      const remainingAttempts: ResolvedAttempt[] = [];
      let firstExceeded: { target: ResolvedTarget; limit: number } | null = null;

      for (const group of groupCredentialAttempts(walkAttempts)) {
        const candidate = group.attempts[0]!;
        const t = candidate.target;
        if (t.model) {
          const observed = observedContextLimit(t.provider, t.model);
          const limits = h.catalog.cachedLimits(t.provider, t.model);
          const limit = observed ?? limits?.contextLength ?? null;
          if (limit && estimatedTokens > limit) {
            if (!firstExceeded) {
              firstExceeded = { target: t, limit };
            }
            continue;
          }
        }
        remainingAttempts.push(...group.attempts);
      }

      if (remainingAttempts.length === 0 && firstExceeded) {
        failClosed(
          res,
          400,
          `llm-relay: request prompt estimated tokens (${estimatedTokens}) exceeds the context limit ` +
            `"${firstExceeded.target.provider}" publishes for "${firstExceeded.target.model}" (${firstExceeded.limit})`,
          stickyProvenanceHeaders(sticky),
        );
        h.logger.write(baseLog(started, path, hadTools, false, 400, "skipped", null));
        return;
      }

      if (remainingAttempts.length > 0) {
        walkAttempts = remainingAttempts;
      }
    }
  }

  const credentialTrace = new CredentialAttemptTrace(cfg);

  if (openAiFrontProtocol) {
    const credentialWalk = new CredentialWalk(walkAttempts, {
      lru: h.credentialLru,
      walkBudgetMs: cfg.walkBudgetMs ?? DEFAULT_WALK_BUDGET_MS,
      selectionNow: routingNow,
      evidenceFor: (attempt) => credentialEvidence(attempt, cfg, h.breaker, routingNow),
      maxInFlight: h.hedgeMaxInFlight,
    });
    await openAiFrontPath(res, credentialWalk, credentialTrace, {
      reqJson,
      wantsStream,
      protocol: openAiFrontProtocol,
      inboundHeaders: req.headers,
      started,
      path,
      hadTools,
      req,
      addressedPool,
      degradedSpecs,
      sticky,
      cfg,
      accounting,
      quotaDemotedFirst,
      latencyDemotedFirst,
    }, {
      ...h,
      withRepairAccounting,
    });
    return;
  }

  const target = walkAttempts[0]!.target;
  if (target.kind === "openai") {
    if (isCountTokens) {
      const input_tokens = Math.max(1, estimateRequestTokens(reqJson));
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

  await anthropicMessagesPath(res, {
    req,
    reqBuf,
    reqJson,
    path,
    pathname,
    started,
    hadTools,
    tools,
    wantsStream,
    walkAttempts,
    addressedPool,
    degradedSpecs,
    sticky,
    quotaDemotedFirst,
    latencyDemotedFirst,
    accounting,
    cfg,
  }, {
    ...h,
    withRepairAccounting,
  });
}

export function createProxy(cfg: Config, deps: ProxyDeps = {}) {
  const validator = new ToolUseValidator();
  const logger = new MetadataLogger(cfg.log);
  const isDestructive = destructiveMatcher(cfg.repair.destructiveTools);
  const catalog = deps.catalog ?? new ModelCatalog();
  const laneCadence = process.env.VITEST ? null : new LaneCadence(cfg);
  const pingLoop =
    deps.pingLoop ??
    new PingLoop(cfg, catalog, laneCadence ? { onTick: (now) => laneCadence.poke(now) } : {});
  const breaker = deps.breaker ?? new CircuitBreaker();
  if (!process.env.VITEST) installBreakerPersistence(breaker);
  if (!process.env.VITEST) installDispatchExhaustionPersistence(cfg);
  const credentialLru = new CredentialLru();
  const modelCallRecorder: ModelCallRecorder | undefined = deps.modelCallRecorder ?? (process.env.VITEST ? undefined : recordModelCall);
  const accountingRecorder = deps.accountingRecorder ?? NOOP_ACCOUNTING_RECORDER;
  const accountingPricePort = deps.accountingPricePortOverride ?? buildAccountingPricePort(catalog, cfg);
  const dashboardAuth = new DashboardAuthManager();
  const dashboardAssetRoot = deps.dashboardAssetRoot ?? getProductionDashboardAssetRoot();
  const dashboardStatic = new DashboardStaticHandler({
    assetRoot: dashboardAssetRoot,
    manifestPath: join(dashboardAssetRoot, ".vite", "manifest.json"),
  });
  const dashboardRead = createDashboardSnapshotReadPort({
    accounting: deps.accountingReader ?? UNAVAILABLE_ACCOUNTING_READER,
    relayVersion: deps.dashboardRelayVersion ?? "unknown",
    attributionPolicy: deps.dashboardAttributionPolicy ?? "unknown",
    availability: createAvailabilityProducer({
      breaker,
      config: cfg,
      accounting:
        deps.accountingReader !== undefined && typeof (deps.accountingReader as { usedInWindow?: unknown }).usedInWindow === "function"
          ? (deps.accountingReader as unknown as Pick<AccountingStore, "usedInWindow">)
          : null,
    }),
  });
  const stickyConfig = cfg.routing.sticky;
  const stickySessions = stickyConfig === true || (typeof stickyConfig === "object" && stickyConfig.enabled)
    ? new StickySessionManager(typeof stickyConfig === "object" ? stickyConfig : undefined)
    : undefined;
  const quotaDemotion = createQuotaDemotionFn({
    cfg,
    breaker,
    accounting:
      deps.accountingReader !== undefined && typeof (deps.accountingReader as { usedInWindow?: unknown }).usedInWindow === "function"
        ? (deps.accountingReader as unknown as Pick<AccountingStore, "usedInWindow">)
        : null,
  });
  const latencyDemotion = createLatencyDemotionFn({
    readPings: (provider, model) => pingLoop.getModelPings(provider, model),
    settings: cfg.routing?.latency,
  });
  const costClassOf = (attempt: ResolvedAttempt): CostClass | undefined => {
    const t = attempt.target;
    if (t.kind !== "openai" || !t.model) return "paid";
    try {
      return assessCost(t.model, catalog.cachedLimits(t.provider, t.model), cfg.providers[t.provider]?.tierType).costClass;
    } catch {
      return undefined;
    }
  };
  const hedgeSettings = resolveHedgeSettings(cfg.routing?.hedge);
  const hedgeDelay = (
    attempt: ResolvedAttempt,
  ): { readonly delayMs: number; readonly basis: HedgeVerdict["basis"] } | null => {
    const t = attempt.target;
    if (!t.model) return null;
    return hedgeDelayDecision(pingLoop.getModelPings(t.provider, t.model), costClassOf(attempt) === "free", hedgeSettings);
  };
  const hardCapEvaluator = (attempt: ResolvedAttempt, now: number): HardCapVerdict | null => {
    try {
      const parsed = parseCredentialId(attempt.credentialId);
      const model = attempt.target.model ?? null;
      return evaluateHardCap({
        cfg,
        provider: attempt.target.provider,
        credentialLabel: parsed?.label ?? null,
        model,
        usedInWindow: createHardCapLedgerReader(deps.accountingReader, attempt.credentialId, model, now),
        now,
      });
    } catch {
      return null;
    }
  };
  let controlAuthorization: ControlAuthorizationPort | undefined;
  if (deps.controlAuthorization !== undefined) {
    controlAuthorization = deps.controlAuthorization ?? undefined;
  } else if (!process.env.VITEST || cfg.sourcePath) {
    try {
      controlAuthorization = createControlAuthorization(resolveControlAuthorizationConfigDir(cfg.sourcePath));
    } catch {
      controlAuthorization = undefined;
    }
  }

  const providerBackedReshaper = (
    targets: readonly ResolvedTarget[],
    now: number,
  ): Reshaper => new CredentialWalkReshaper(expandCredentialAttempts(targets), {
    lru: credentialLru,
    walkBudgetMs: cfg.walkBudgetMs ?? DEFAULT_WALK_BUDGET_MS,
    selectionNow: now,
    evidenceFor: (attempt) => credentialEvidence(attempt, cfg, breaker, now),
  });

  const rehydrateStaticReshaperTargets = (): ResolvedTarget[] => {
    const specs = cfg.reshaperCandidates ?? (cfg.reshaper?.provider ? [cfg.reshaper] : []);
    return specs.flatMap((spec) => {
      if (!spec.provider) return [];
      return resolveTargets(`${spec.provider}/${spec.model}`, cfg)
        .filter((target) => target.kind === "openai" && target.model === spec.model)
        .map((target) => Object.freeze({ ...target, timeoutMs: spec.timeoutMs }));
    });
  };

  const resolveReshaper = (servedAttempt: ResolvedAttempt): Reshaper | undefined => {
    if (deps.reshaper) return deps.reshaper;

    if (cfg.reshaperCandidates || cfg.reshaper?.provider) {
      const now = Date.now();
      return providerBackedReshaper(rehydrateStaticReshaperTargets(), now);
    }

    if (cfg.reshaperPool) {
      const targets = resolveTargets(`pool/${cfg.reshaperPool.name}`, cfg)
        .filter((target) => target.kind === "openai" && target.model)
        .map((target) => Object.freeze({
          ...target,
          timeoutMs: cfg.reshaperPool?.timeoutMs ?? Math.min(target.timeoutMs, 60_000),
        }));
      if (targets.length === 0) {
        return {
          async reshape() {
            throw new Error(`dynamic reshaper pool "${cfg.reshaperPool?.name ?? "unknown"}" has no materialized OpenAI target`);
          },
        };
      }
      const now = Date.now();
      return providerBackedReshaper(targets, now);
    }

    if (cfg.reshaper) {
      return new HttpReshaper(
        cfg.reshaper,
        resolveCredential(cfg.reshaper.authEnv),
      );
    }

    const spec = reshaperForTarget(servedAttempt.target);
    return spec ? new HttpReshaper(spec, servedAttempt.credential, fetch, undefined, servedAttempt) : undefined;
  };

  const server = createServer((req, res) => {
    const started = Date.now();
    handle(req, res, cfg, {
      validator,
      logger,
      isDestructive,
      resolveReshaper,
      catalog,
      pingLoop,
      breaker,
      credentialLru,
      ...(modelCallRecorder ? { modelCallRecorder } : {}),
      accountingRecorder,
      ...(deps.accountingReader !== undefined &&
        typeof (deps.accountingReader as { usedInWindow?: unknown }).usedInWindow === "function"
        ? { accountingReader: deps.accountingReader as unknown as Pick<AccountingStore, "usedInWindow"> }
        : {}),
      accountingPricePort,
      dashboardAuth,
      dashboardStatic,
      dashboardRead,
      ...(stickySessions ? { stickySessions } : {}),
      server,
      ...(controlAuthorization ? { controlAuthorization } : {}),
      quotaDemotion,
      latencyDemotion,
      hedgeDelay,
      hedgeMaxInFlight: hedgeSettings.enabled ? 2 : 1,
      costClassOf,
      hardCap: hardCapEvaluator,
    }).catch((e) => {
      failClosed(res, 502, `llm-relay internal error: ${(e as Error).message}`);
      logger.write(baseLog(started, req.url ?? "/", false, false, 502, "skipped", null));
    });
  });

  if (!process.env.VITEST) {
    server.on("listening", () => {
      materializeDynamicPools(cfg, catalog);
      pingLoop.start();
    });
    server.on("close", () => pingLoop.stop());
  }

  return server;
}
