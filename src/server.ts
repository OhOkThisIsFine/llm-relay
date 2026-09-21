import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  AUTO_MODEL,
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
import { installDispatchLaneStatsPersistence } from "./dispatch-lane-stats.js";
import { installLaneAffinityPersistence } from "./lane-affinity.js";
import { resolveAutoSpec } from "./dispatch.js";
import { AUTO_HEADER, AUTO_TIER_HEADER } from "./backend.js";
import { LaneCadence } from "./lane-cadence.js";
import { estimateRequestTokens, assessCost, type CostClass } from "./metadata.js";
import { materializeDynamicPools } from "./dynamic-pools.js";
import { baseLog } from "./request-log.js";
import { observedContextLimit } from "./context-limits.js";
import { isCostBlockedForEverySlot } from "./target-facts.js";
import { createQuotaDemotionFn, type QuotaDemotionFn } from "./quota-demotion.js";
import { createLatencyDemotionFn, type LatencyDemotionFn } from "./latency-demotion.js";
import { createPacingFn, type PacingFn } from "./pacing.js";
import { hedgeDelayDecision, resolveHedgeSettings, type HedgeDelayDecision } from "./hedge-trigger.js";
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
  bodyReadStatus,
  failClosed,
  readBody,
} from "./stream-pipeline.js";
import {
  applyStickyOrdering,
  createProbationFn,
  CredentialAttemptTrace,
  credentialEvidence,
  DEFAULT_WALK_BUDGET_MS,
  expandCredentialAttempts,
  freeOnlyApplies,
  orderDeploymentGroupsByUsability,
  stickyProvenanceHeaders,
  type CostClassFn,
  type ProbationDeps,
  type ProbationFn,
  type StickyRequestContext,
} from "./candidate-runner.js";
import { countRequestSamples } from "./ping/probe-cache.js";
import { detectOpenAiFrontProtocol, openAiFrontPath } from "./routes/openai-front.js";
import { anthropicMessagesPath } from "./routes/messages.js";
import { beginLaneRequest, LANE_ACTIVITY_HEADER, laneActivityTag } from "./lane-activity.js";
import { LaneExecutionBroker, type LaneExecutionBrokerPort } from "./lane-execution-broker.js";
import { createConfiguredLaneExecutionLauncher } from "./configured-lane-execution-launcher.js";

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
  "/dispatch/telemetry",
  "/dispatch/activity",
  "/mcp/lane-execution",
  "/registry",
  "/ping",
  "/health/stats",
  "/health",
  "/candidates",
  "/stop",
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
  /** Version loaded by this proxy process; "unknown" when an embedder does not supply one. */
  relayVersion?: string;
  /** Dashboard-only override; otherwise the dashboard uses relayVersion. */
  dashboardRelayVersion?: string;
  dashboardAttributionPolicy?: AttributionPolicy;
  controlAuthorization?: ControlAuthorizationPort | null;
  /**
   * D1 daemon-owned lane execution broker. undefined installs the production configured broker;
   * null explicitly disables it for fail-closed embeds/tests.
   */
  laneExecutionBroker?: LaneExecutionBrokerPort | null;
  /** Optional shutdown callback — called by POST /stop after responding 202. A bare programmatic proxy with no onStop answers 503. */
  onStop?: () => void;
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
  /** Package version loaded by this daemon process; absent only for an unversioned embed. */
  relayVersion?: string;
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
  laneExecutionBroker?: LaneExecutionBrokerPort;
  server: Server;
  quotaDemotion: QuotaDemotionFn;
  latencyDemotion: LatencyDemotionFn;
  probation: ProbationFn;
  pacing: PacingFn;
  hedgeDelay: (attempt: ResolvedAttempt, estimatedInputTokens: number) => HedgeDelayDecision | null;
  hedgeMaxInFlight: number;
  costClassOf: CostClassFn;
  /** See `CandidateRunnerHandlers.catalogStale` — wired to `ModelCatalog.noteProviderStale`. */
  catalogStale: (attempt: ResolvedAttempt) => void;
  hardCap: (attempt: ResolvedAttempt, now: number) => HardCapVerdict | null;
  /** Optional shutdown callback — called by POST /stop after responding 202. */
  onStop?: () => void;
  /** True the first time GET /telemetry observes the loaded config changed on disk, false on
   *  every call after — so the daemon logs the fact exactly once (see config.ts `configStaleness`). */
  claimConfigStalenessLogOnce: () => boolean;
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

/**
 * The context ceiling this relay may hold a deployment to, and WHICH rung stated it.
 *
 * Two rungs, most-authoritative first — the `contextWindowResolver` order, minus its snapshot rung:
 *
 * 1. `observed` — a `context-limit` fact recorded when THIS deployment stated its own maximum while
 *    refusing an over-length request (`context-limits.ts`, deployment scope, 30-day TTL). It is
 *    first-party evidence about the exact deployment, which a catalogue figure can contradict by
 *    being generic or stale.
 * 2. `published` — the serving provider's own `contextLength` from the catalogue, read cache-only.
 *
 * Null when neither rung answers, and null must stay "no guardrail": the request goes upstream and
 * the backend returns its own authoritative error. ⚠ There is deliberately no invented third rung —
 * a 400 built from a number nobody stated is worse than a true upstream error.
 *
 * ⚠ The BASIS travels with the number because the refusal body names it. Reporting a learned
 * measurement as something the provider "publishes" is the one thing the provenance invariant
 * forbids, and the body said exactly that for every rung until 2026-09-01.
 */
export function contextCeilingFor(
  target: ResolvedTarget,
  catalog: Pick<Handlers["catalog"], "cachedLimits">,
): { limit: number; basis: "observed" | "published" } | null {
  if (!target.model) return null;
  const observed = observedContextLimit(target.provider, target.model);
  if (observed) return { limit: observed, basis: "observed" };
  const published = catalog.cachedLimits(target.provider, target.model)?.contextLength;
  if (published) return { limit: published, basis: "published" };
  return null;
}

/**
 * A request that carries a dispatch lane's activity tag (`lane-activity.ts`) touches that tag when
 * it starts, on every response write, and when it ends. `res.write`/`res.end` are the one place
 * every response path on both fronts passes through, so no front can miss a write.
 */
function trackLaneActivity(req: IncomingMessage, res: ServerResponse): void {
  const tag = laneActivityTag(req.headers[LANE_ACTIVITY_HEADER]);
  if (tag === null) return;
  const lane = beginLaneRequest(tag);
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
  res.write = ((...args: unknown[]) => {
    lane.wrote();
    return write(...args);
  }) as ServerResponse["write"];
  res.end = ((...args: unknown[]) => {
    lane.wrote();
    return end(...args);
  }) as ServerResponse["end"];
  res.once("close", lane.ended);
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
  trackLaneActivity(req, res);

  let reqBuf: Buffer;
  try {
    reqBuf = await readBody(req, cfg.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  } catch (e) {
    const msg = (e as Error).message;
    // Classified by the code `readBody` set, never by its message (contract review DR-005).
    const status = bodyReadStatus(e);
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
    let routedModel = subSpec ?? model;
    materializeDynamicPools(cfg, h.catalog);
    if (subSpec !== null) {
      reqBuf = Buffer.from(JSON.stringify(reqJson), "utf8");
      estimatedRequestTokens = estimateRequestTokens(reqJson);
    }
    if (routedModel === AUTO_MODEL) {
      const tierHeader = req.headers[AUTO_TIER_HEADER];
      const autoResolved = resolveAutoSpec(
        cfg,
        typeof tierHeader === "string" ? tierHeader : Array.isArray(tierHeader) ? tierHeader[0] : undefined,
        started,
      );
      routedModel = autoResolved.spec;
      res.setHeader(AUTO_HEADER, `${autoResolved.spec} (${autoResolved.tier})`);
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
        if (assessment?.costClass === "free" && !isCostBlockedForEverySlot(
          t.provider,
          t.model,
          cfg,
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
  const {
    ordered: orderedAttempts,
    quotaDemotedFirst,
    latencyDemotedFirst,
    pacedFirst,
  } = orderDeploymentGroupsByUsability(
    rankedAttempts,
    h.breaker,
    routingNow,
    h.quotaDemotion,
    h.costClassOf,
    h.latencyDemotion,
    h.probation,
    h.pacing,
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
          // `latencyDemotion` intentionally not threaded here — a pre-existing gap at this call
          // site, unchanged by this packet.
          undefined,
          h.probation,
          h.pacing,
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
      // ⚠ The BASIS travels with the number. This guardrail now reads a relay-LEARNED ceiling
      // (`observedContextLimit`, a `context-limit` fact recorded when this deployment itself stated
      // its maximum while refusing) ahead of the provider's published figure. The refusal body used
      // to say the provider "publishes" the limit whatever its source, which reports a measurement
      // as a publication — the provenance invariant's one prohibition. Say which rung answered.
      let firstExceeded: { target: ResolvedTarget; limit: number; basis: "observed" | "published" } | null = null;

      for (const group of groupCredentialAttempts(walkAttempts)) {
        const ceiling = contextCeilingFor(group.attempts[0]!.target, h.catalog);
        if (ceiling && estimatedTokens > ceiling.limit) {
          firstExceeded ??= { target: group.attempts[0]!.target, ...ceiling };
          continue;
        }
        remainingAttempts.push(...group.attempts);
      }

      if (remainingAttempts.length === 0 && firstExceeded) {
        failClosed(
          res,
          400,
          `llm-relay: request prompt estimated tokens (${estimatedTokens}) exceeds the context limit ` +
            (firstExceeded.basis === "observed"
              ? `"${firstExceeded.target.provider}" stated for "${firstExceeded.target.model}" when it refused an earlier over-length request (${firstExceeded.limit})`
              : `"${firstExceeded.target.provider}" publishes for "${firstExceeded.target.model}" (${firstExceeded.limit})`),
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
      estimatedInputTokens: estimatedRequestTokens,
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
      pacedFirst,
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
    estimatedInputTokens: estimatedRequestTokens,
    walkAttempts,
    addressedPool,
    degradedSpecs,
    sticky,
    quotaDemotedFirst,
    latencyDemotedFirst,
    pacedFirst,
    accounting,
    cfg,
    routingNow,
  }, {
    ...h,
    withRepairAccounting,
  });
}

export function createProxy(cfg: Config, deps: ProxyDeps = {}) {
  const validator = new ToolUseValidator();
  const logger = new MetadataLogger(cfg.log);
  // The relay does not hot-reload (see config.ts `configStaleness`). GET /telemetry is the only
  // point inside a running process that evaluates it, so this latch makes the daemon log the fact
  // exactly ONCE per process the first time that route observes the change — never on every poll.
  let configStalenessLogged = false;
  const claimConfigStalenessLogOnce = (): boolean => {
    if (configStalenessLogged) return false;
    configStalenessLogged = true;
    return true;
  };
  const isDestructive = destructiveMatcher(cfg.repair.destructiveTools);
  const catalog = deps.catalog ?? new ModelCatalog();
  const laneExecutionBroker =
    deps.laneExecutionBroker === null
      ? undefined
      : deps.laneExecutionBroker ??
        new LaneExecutionBroker(createConfiguredLaneExecutionLauncher(cfg, { catalog }));
  const laneCadence = process.env.VITEST ? null : new LaneCadence(cfg);
  // The breaker is built BEFORE the ping loop because the loop holds a narrow port onto it
  // (`rateLimitRecovery`, 2026-09-15): a probe that answers 200 ends a 429-sourced cooldown
  // early, and the loop re-probes the cells cooling on the relay's own guessed rungs. The port is
  // the breaker itself — `CircuitBreaker` satisfies `RateLimitRecoveryPort` structurally — so
  // there is no adapter to drift. An injected `deps.pingLoop` (a test's stub) keeps its own wiring.
  const breaker = deps.breaker ?? new CircuitBreaker();
  const pingLoop =
    deps.pingLoop ??
    new PingLoop(cfg, catalog, {
      ...(laneCadence ? { onTick: (now: number) => laneCadence.poke(now) } : {}),
      rateLimitRecovery: breaker,
    });
  if (!process.env.VITEST) installBreakerPersistence(breaker);
  if (!process.env.VITEST) installDispatchExhaustionPersistence(cfg);
  if (!process.env.VITEST) installDispatchLaneStatsPersistence(cfg);
  // Lane pins and demotions survive a restart for the same reason cooldowns do: the daemon is the
  // ONE writer (the MCP child reports, the daemon records), and a preference re-learned from
  // scratch on every restart would send every walk back to the lane it just abandoned.
  if (!process.env.VITEST) installLaneAffinityPersistence(cfg);
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
    relayVersion: deps.dashboardRelayVersion ?? deps.relayVersion ?? "unknown",
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
  /**
   * A 404 stating that a model does not exist is evidence the provider's ROSTER moved, so re-fetch
   * it rather than waiting out the TTL (`ModelCatalog.noteProviderStale`).
   *
   * The containment lives here, where the catalog is: the model must be one the relay CURRENTLY
   * LISTS for that provider. A 404 for a model the catalog never listed (a caller naming something
   * that never existed, a typed id, another provider's SKU) contradicts no roster and there is
   * nothing to refresh — re-fetching on it would let a single client drive a provider's `/models`
   * endpoint with requests that are simply wrong. `cachedModels` is synchronous and cache-only, so
   * this costs no network I/O and never blocks the failing request it is riding on.
   *
   * The provider CONFIG is read through the same map `resolveTargets` used, and a provider that
   * vanished from it resolves to nothing — a refresh for it would be a fetch the config no longer
   * describes, so it is skipped rather than attempted with a synthesized target.
   */
  const catalogStale = (attempt: ResolvedAttempt): void => {
    try {
      const t = attempt.target;
      if (t.kind !== "openai" || !t.model) return;
      const provider = cfg.providers[t.provider];
      if (!provider || provider.kind !== "openai") return;
      if (!catalog.cachedModels(t.provider).includes(t.model)) return;
      catalog.noteProviderStale(t.provider, provider);
    } catch {
      // A catalog hint must never fail a request — same contract as every other best-effort
      // observer on this path.
    }
  };
  // routing.probation (owner direction 2026-09-09): an untested FREE deployment leads its pool
  // so the relay gathers data on it. `readRequestSamples` is `countRequestSamples` from
  // `ping/probe-cache.ts` bound with no explicit path — the real, default probe cache, same
  // singleton `latencyDemotion` above reads through `pingLoop`. Tests inject their own stub
  // through `ProbationDeps.readRequestSamples` rather than this real seam.
  const probationDeps: ProbationDeps = {
    readRequestSamples: countRequestSamples,
    settings: cfg.routing.probation,
    costClassOf,
  };
  const probation: ProbationFn = createProbationFn(probationDeps);
  // routing.pacing (owner direction 2026-09-10): hold this relay's own attempt rate under a
  // ceiling the deployment stated. Reads the breaker's per-cell attempt-start log — the ONE
  // dataset every egress on both fronts feeds through `beginHealthAttempt` — so every client on
  // the machine that routes through the relay is counted against the same window.
  const pacing: PacingFn = createPacingFn({ cfg, breaker, settings: cfg.routing.pacing });
  const hedgeSettings = resolveHedgeSettings(cfg.routing?.hedge);
  const hedgeDelay = (
    attempt: ResolvedAttempt,
    estimatedInputTokens: number,
  ): HedgeDelayDecision | null => {
    const t = attempt.target;
    if (!t.model) return null;
    return hedgeDelayDecision(
      pingLoop.getModelPings(t.provider, t.model),
      costClassOf(attempt) === "free",
      estimatedInputTokens,
      hedgeSettings,
    );
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
      relayVersion: deps.relayVersion ?? "unknown",
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
      ...(laneExecutionBroker ? { laneExecutionBroker } : {}),
      quotaDemotion,
      latencyDemotion,
      probation,
      pacing,
      catalogStale,
      hedgeDelay,
      hedgeMaxInFlight: hedgeSettings.enabled ? 2 : 1,
      costClassOf,
      hardCap: hardCapEvaluator,
      claimConfigStalenessLogOnce,
      ...(deps.onStop ? { onStop: deps.onStop } : {}),
    }).catch((e) => {
      failClosed(res, 502, `llm-relay internal error: ${(e as Error).message}`);
      logger.write(baseLog(started, req.url ?? "/", false, false, 502, "skipped", null));
    });
  });

  if (laneExecutionBroker?.shutdown) server.on("close", () => laneExecutionBroker.shutdown?.());

  if (!process.env.VITEST) {
    server.on("listening", () => {
      materializeDynamicPools(cfg, catalog);
      pingLoop.start();
    });
    server.on("close", () => pingLoop.stop());
  }

  return server;
}
