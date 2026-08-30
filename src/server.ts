import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  DEFAULT_ANTHROPIC_VERSION,
  resolveTargets,
  reshaperForTarget,
  subagentSpec,
  clientForPath,
  offloadRule,
  RoutingError,
  type Config,
  type ResolvedTarget,
} from "./config.js";
import {
  MAX_LOG_ATTEMPTS,
  MetadataLogger,
  type RequestAttemptLog,
  type RequestAttemptStatus,
  type RequestLog,
} from "./log.js";
import { buildAuthHeaders, resolveCredential } from "./authEnv.js";
import { parseCredentialId } from "./credential-id.js";
import { resolveAttempt, type ResolvedAttempt } from "./resolved-attempt.js";
import { resolveAttemptForSlot } from "./credential-fleet.js";
import {
  CredentialLru,
  CredentialWalk,
  groupCredentialAttempts,
  rankCredentialAttempts,
  type CredentialWalkOutcome,
} from "./credential-select.js";
import { ToolUseValidator } from "./validator.js";
import { reconstructFromSse } from "./sse.js";
import { emitSse, emitSseTail, syntheticMessageId } from "./emitSse.js";
import { repair, destructiveMatcher, type RepairOutcome } from "./repair.js";
import {
  CredentialWalkReshaper,
  HttpReshaper,
  type Reshaper,
  type ReshaperAccountingHooks,
} from "./reshaper.js";
import { DIALECT_REFUSED_DESTRUCTIVE_CODE } from "./tool-dialects.js";
import { dialectRefusalSignalOf, ERROR_ORIGIN_HEADER, TOOL_DIALECT_HEADER, fetchBackend, fetchOpenAiFront, normalizeOpenAiErrorBody, parseRetryAfterMs, postHeaderBodyFailure, upstreamReportedModel, toolUseIdRewrites, toolCallIdRewrites, thoughtSignatureSentinels, SERVED_BY_HEADER, POOL_ATTEMPTS_HEADER, UNKNOWN_REFUSAL_HEADER, DEGRADED_HEADER, PAID_HEADER, QUOTA_DEMOTED_HEADER, CREDENTIAL_HEADER, CREDENTIAL_ATTEMPTS_HEADER, HARD_CAP_HEADER, errorOrigin, type ErrorOrigin, type OpenAiFrontProtocol, type PostHeaderBodyFailure } from "./backend.js";
import { probeStreamForCommit, type StreamCommitProtocol } from "./stream-commit.js";
import { ModelCatalog } from "./catalog.js";
import { handleAdminRoutes } from "./routes/admin.js";
import { toolSchemaMap, type AssistantMessage, type JsonSchema } from "./anthropic.js";
import type { RecoveredOpenAiChat, RecoveredOpenAiChatProcessor } from "./openai-dialect.js";
import { PingLoop } from "./ping/cadence.js";
import { recordModelCall } from "./ping/runtime-telemetry.js";
import { createUsageAccumulator, type UsageAccumulator } from "./usage-observer.js";
import {
  createAccountingRequest,
  NOOP_ACCOUNTING_RECORDER,
  type AccountingAttempt,
  type AccountingPricePort,
  type AccountingRecorder,
  type AccountingRequest,
  type TokenFactsInput,
} from "./accounting.js";
import type { AccountingReader, AccountingStore } from "./accounting-store.js";
import { DashboardAuthManager } from "./dashboard-auth.js";
import { BODY_TOO_LARGE_CODE, handleDashboardRoute, type DashboardHeaderMap, type DashboardRouteHandled } from "./dashboard-routes.js";
import { createDashboardSnapshotReadPort } from "./dashboard-snapshot.js";
import { createAvailabilityProducer } from "./availability-snapshot.js";
import {
  DASHBOARD_STATIC_SECURITY_HEADERS,
  DashboardStaticHandler,
  getProductionDashboardAssetRoot,
} from "./dashboard-static.js";
import type { AttributionPolicy } from "./dashboard-contract.js";
import { CircuitBreaker, globalCircuitBreaker } from "./circuit-breaker.js";
import { installBreakerPersistence } from "./breaker-persistence.js";
import { installDispatchExhaustionPersistence } from "./dispatch-exhaustion-persistence.js";
import { LaneCadence } from "./lane-cadence.js";
import { estimateRequestTokens, assessCost, resolveMetadata, type CostClass } from "./metadata.js";
import { findTierModel, loadTierData, type TierModel } from "./tier-data.js";
import { specOfTarget } from "./benchmarks.js";
import { extractQuotaObservations, type QuotaObservation } from "./quota-observation.js";
import { materializeDynamicPools } from "./dynamic-pools.js";
import { baseLog } from "./request-log.js";
import {
  looksLikeContextLengthError,
  looksLikeMaxOutputError,
  parseStatedContextLimit,
  parseStatedMaxOutput,
  recordObservedContextLimit,
  recordObservedMaxOutput,
} from "./context-limits.js";
import { looksLikeRateLimitError, parseStatedRateLimit, recordObservedRateLimit } from "./rate-limits.js";
import { clearFacts, cooldownUntil, factsFor, isCostBlocked, recordFact, type FactResetBasis } from "./target-facts.js";
import { createQuotaDemotionFn, quotaDemotionLabel, type QuotaDemotionFn } from "./quota-demotion.js";
/**
 * Resolves a deployment's cost class LIVE from the catalog, for facts that apply to one class
 * only. Threaded exactly like `QuotaDemotionFn`: built once per proxy with its dependencies bound,
 * and read fresh per call so it follows the catalog's own refresh rather than a snapshot.
 * `undefined` means "could not classify" — a cost-filtered fact then does not apply, which is the
 * fail-safe direction.
 */
type CostClassFn = (attempt: ResolvedAttempt) => CostClass | undefined;
import { createHardCapLedgerReader, evaluateHardCap, hardCapLabel, type HardCapVerdict } from "./hard-cap.js";
import { applyResetRule, interpretRefusal, materializeScope, parseStatedResetMs, recordUnknownRefusal, type Interpretation } from "./refusal-interpretation.js";
import type {
  AttemptFailed,
  AttemptHandle,
  OutcomeProvenance,
  ProviderTargetIdentity,
} from "./kernel/contracts.js";
import {
  CONTROL_AUTHORIZATION_HEADER,
  createControlAuthorization,
  resolveControlAuthorizationConfigDir,
  validateControlAuthorization,
  type ControlAuthorizationPort,
} from "./control-authorization.js";
import {
  deriveSessionKey,
  STICKY_PROVENANCE_HEADER,
  STICKY_SESSION_HEADER,
  StickySessionManager,
} from "./session-pin.js";

export { baseLog, logSafePath } from "./request-log.js";


const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding", "host",
]);
const INTERNAL_REQUEST_HEADERS = new Set([
  "x-codex-turn-metadata",
  "x-llm-relay-dashboard-session",
  STICKY_SESSION_HEADER,
  CONTROL_AUTHORIZATION_HEADER,
]);
const INBOUND_AUTH = ["authorization", "x-api-key"];

// `MAX_TASK_LEN` lived here until the admin routes moved to `routes/admin.ts`, which owns the
// `?task=` bound now. Two copies of a limit drift; the one at the boundary that accepts the
// request is the one that counts.

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

  // Header presence is significant: Origin: null and Origin: "" are present-invalid,
  // rather than falling into the trusted non-browser/CLI path.
  if (Object.hasOwn(req.headers, "origin")) {
    const origin = parseOrigin(req.headers.origin);
    if (!origin || origin.scheme !== "http:" || origin.hostname !== expected.hostname || origin.port !== expected.port) {
      return "Origin does not match the bound listener";
    }
  }

  const mutating = req.method !== "GET" && req.method !== "HEAD";

  if (mutating) {
    const ct = (req.headers["content-type"] ?? "").toString().split(";")[0]?.trim().toLowerCase();
    // Requiring application/json is what makes a body-bearing cross-origin POST
    // need a preflight, which a hostile page cannot satisfy.
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

const MAX_VALIDATE_BYTES = 8 * 1024 * 1024;
/** 25 MiB decoded document × base64 expansion, plus JSON-envelope headroom. */
export const DEFAULT_MAX_BODY_BYTES = 36 * 1024 * 1024;

/** A bare programmatic proxy has no persistence owner, so dashboard reads fail closed as empty. */
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
  /** Optional per-attempt accounting seam; injected recorders always run. */
  modelCallRecorder?: ModelCallRecorder;
  /** Request-scoped accounting is observational and never controls proxy flow. */
  accountingRecorder?: AccountingRecorder;
  /** The production accounting store supplies this same reader and recorder instance. */
  accountingReader?: AccountingReader;
  /** Test/dev override for the published-price lookup; production derives it from the catalog. */
  accountingPricePortOverride?: AccountingPricePort | undefined;
  /** Test/dev-only explicit asset root; production resolves the compiled dashboard once. */
  dashboardAssetRoot?: string;
  /** Version shown by dashboard projections; a bare proxy deliberately remains unknown. */
  dashboardRelayVersion?: string;
  /** Explicit projection policy label; a bare proxy deliberately remains unknown. */
  dashboardAttributionPolicy?: AttributionPolicy;
  /** null deliberately exercises fail-closed control authorization. */
  controlAuthorization?: ControlAuthorizationPort | null;
}

export type ModelCallRecorder = (
  providerKey: string,
  modelId: string,
  callResult: { ok: boolean; latencyMs: number; completionTokens?: number },
) => void;

export function createProxy(cfg: Config, deps: ProxyDeps = {}) {
  const validator = new ToolUseValidator();
  const logger = new MetadataLogger(cfg.log);
  const isDestructive = destructiveMatcher(cfg.repair.destructiveTools);
  const catalog = deps.catalog ?? new ModelCatalog();
  /**
   * The lane cadence rides the ping tick (owner decision 2026-08-29): catalog re-probes keep
   * rosters fresh, and quota probes re-test recorded lane deaths so no lane stays parked on a
   * stale record. Skipped under vitest — the suite exercises `LaneCadence` directly with
   * injected seams, and a test proxy must never spawn a real lane.
   */
  const laneCadence = process.env.VITEST ? null : new LaneCadence(cfg);
  const pingLoop =
    deps.pingLoop ??
    new PingLoop(cfg, catalog, laneCadence ? { onTick: (now) => laneCadence.poke(now) } : {});
  const breaker = deps.breaker ?? new CircuitBreaker();
  /**
   * Cooling state survives a restart, like ping health already did.
   *
   * Without this the relay discarded every cooldown and the whole unexplained-429 escalation
   * ladder on restart, then walked back into the same walls — measured here as a 19.9-hour
   * cooldown learned from 7 consecutive 429s on one deployment and 26 on another.
   *
   * ⚠ Skipped under vitest for the reason the probe loop is: a test proxy must not read or write
   * the developer's live cooling state. `getBreakerStatePath()` also redirects under vitest, so
   * this is belt and braces — the suite exercises the mechanism directly with an explicit path.
   */
  if (!process.env.VITEST) installBreakerPersistence(breaker);
  // The ladder's exhaustion state survives a restart for the same reason — the report route
  // accepts vendor-stated cooldowns up to 30 days, exactly the rows worth keeping.
  if (!process.env.VITEST) installDispatchExhaustionPersistence(cfg);
  // Process-local and deliberately credential-wide: a deployment switch must not reset fairness.
  const credentialLru = new CredentialLru();
  const modelCallRecorder: ModelCallRecorder | undefined = deps.modelCallRecorder ?? (process.env.VITEST ? undefined : recordModelCall);
  const accountingRecorder = deps.accountingRecorder ?? NOOP_ACCOUNTING_RECORDER;
  // One port per proxy: both request fronts price through the SAME published figures.
  const accountingPricePort = deps.accountingPricePortOverride ?? buildAccountingPricePort(catalog, cfg);
  // Do not create a second persistence store here.  The CLI owns the production store lifecycle
  // and supplies the same object as recorder and reader; a bare in-memory proxy reports no data.
  const dashboardAuth = new DashboardAuthManager();
  const dashboardAssetRoot = deps.dashboardAssetRoot ?? getProductionDashboardAssetRoot();
  const dashboardStatic = new DashboardStaticHandler({
    assetRoot: dashboardAssetRoot,
    // Vite writes this only at build time. Source-driven runs therefore fail closed for assets
    // rather than discovering or probing a development server on each request.
    manifestPath: join(dashboardAssetRoot, ".vite", "manifest.json"),
  });
  const dashboardRead = createDashboardSnapshotReadPort({
    accounting: deps.accountingReader ?? UNAVAILABLE_ACCOUNTING_READER,
    relayVersion: deps.dashboardRelayVersion ?? "unknown",
    attributionPolicy: deps.dashboardAttributionPolicy ?? "unknown",
    // The Quota/Cooldown panels' producer. `usedInWindow` is store-only, so a bare in-memory
    // proxy passes null and its quota rows simply carry localUsed null.
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
  // Gap 12: the deployment-level quota demotion term. Built once per proxy; each call re-reads
  // live breaker state and the store's in-memory window. `deps.accountingReader` is narrowed the
  // same way the dashboard producer above narrows it, so a bare programmatic proxy simply has no
  // localUsed figure and the term stays inert.
  const quotaDemotion = createQuotaDemotionFn({
    cfg,
    breaker,
    accounting:
      deps.accountingReader !== undefined && typeof (deps.accountingReader as { usedInWindow?: unknown }).usedInWindow === "function"
        ? (deps.accountingReader as unknown as Pick<AccountingStore, "usedInWindow">)
        : null,
  });
  // The cost class of a deployment, resolved LIVE from the catalog, for facts that apply to only
  // one class. Built once per proxy like `quotaDemotion` above, and read fresh on every call so it
  // tracks the catalog's own 10-minute refresh.
  //
  // ⚠ Why this exists: OpenRouter's `403 Key limit exceeded (weekly limit)` names the KEY, but it
  // is a SPEND limit — its surface is the PAID subset. A credential-scoped demotion took out 18
  // free models that were answering 200 (measured 2026-08-28). A `group` scope with a member list
  // cannot fix it either, because a provider moves models between free, discounted and paid on its
  // own schedule. Referencing the CLASSIFIER rather than a list is what cannot go stale.
  //
  // ⚠ Anthropic passthrough is definitionally not free — it spends primary quota — so it reports
  // `paid` rather than a guess, exactly as the `targetCandidates` assessment above does.
  const costClassOf = (attempt: ResolvedAttempt): CostClass | undefined => {
    const t = attempt.target;
    if (t.kind !== "openai" || !t.model) return "paid";
    try {
      return assessCost(t.model, catalog.cachedLimits(t.provider, t.model), cfg.providers[t.provider]?.tierType).costClass;
    } catch {
      // Unknown class ⇒ a cost-filtered fact simply does not apply. Never demote on a
      // classification we could not make.
      return undefined;
    }
  };
  // G2: the operator-set refusal ceilings. Narrowed to the SAME in-memory `usedInWindow` seam the
  // demotion term reads — a bare programmatic proxy has no ledger and its caps simply never fire
  // (unknown usage ⇒ no refusal). Built once per proxy; each call re-reads the live window.
  //
  // ⚠ The read is NARROWED BY THE CAP'S OWN SCOPE, which `evaluateHardCap` states per call: a
  // `limits.models.<id>.hard` ceiling is compared against that deployment's usage, a flat
  // credential/provider ceiling against the credential's usage across every model. Passing one
  // fixed scope is how enforcement and `/candidates` drifted apart — they shared the evaluator
  // but asked the ledger different questions, so a per-deployment cap refused `m/x` for requests
  // spent entirely on `m/y`. All three consumers now narrow on exactly this rule (see
  // `candidates.ts` and `availability-snapshot.ts`).
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
      // A routing guard must not be able to fail a request; degrade to no opinion.
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
      // Data-plane and tokenless status reads remain available. Protected control
      // work fails closed through the absent port instead of preventing startup.
      controlAuthorization = undefined;
    }
  }

  // Secret-bearing reshapers are request-local. Provider-backed forms are rehydrated from the
  // provider config at the repair decision so current fleet slots and current env snapshots bind
  // the egress. The implicit form instead keeps the exact credential that served the bad answer.
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
      // A legacy standalone endpoint owns only its declared authEnv. It has no provider identity,
      // so never infer one from a coincidentally matching base/model and never attach a fleet.
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
      costClassOf,
      hardCap: hardCapEvaluator,
    }).catch((e) => {
      failClosed(res, 502, `llm-relay internal error: ${(e as Error).message}`);
      // Last-resort net. `handle` logs every turn it terminates itself, so reaching
      // here means a turn ended with NO log record — the operator would see a client
      // error with nothing at all in the log to match it against. A duplicate line
      // in some future edge case is much cheaper than an invisible request.
      logger.write(baseLog(started, req.url ?? "/", false, false, 502, "skipped", null));
    });
  });

  /**
   * Actually run the background health loop.
   *
   * ⚠ `PingLoop.start()` was called from NOWHERE in `src/`. The class has a complete adaptive
   * cadence — speed/normal/slow modes, idle detection, `noteUserActivity()` — and every bit of it
   * was dead code, so the only probes ever recorded were the ones a human triggered by hitting
   * `/ping` by hand. That is the real reason a long-running relay reported `verdict: Pending` and
   * an empty `p95` for every model it had supposedly been monitoring for days: nothing was
   * monitoring anything. Persisting samples (probe-cache) and rehydrating them (cadence) are both
   * pointless without this line.
   *
   * Skipped under vitest: a test proxy must not start probing real providers in the background.
   */
  if (!process.env.VITEST) {
    server.on("listening", () => {
      // Give the probe loop a concrete routing roster before its first tick. On a warm restart
      // this is immediate from the catalog cache; a cold network refresh expands it later.
      materializeDynamicPools(cfg, catalog);
      pingLoop.start();
    });
    server.on("close", () => pingLoop.stop());
  }

  return server;
}

interface Handlers {
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
  /**
   * The store's in-memory window read when a store was handed in (see ProxyDeps). Feeds
   * `/candidates`' G2 cap column and nothing else on the admin surface — narrowed to exactly
   * the seam the cap evaluator takes, so the display cannot read anything enforcement cannot.
   */
  readonly accountingReader?: Pick<AccountingStore, "usedInWindow">;
  /** Published-price lookup for spend; built once per proxy, shared by both fronts. */
  accountingPricePort: AccountingPricePort | undefined;
  dashboardAuth: DashboardAuthManager;
  dashboardStatic: DashboardStaticHandler;
  dashboardRead: ReturnType<typeof createDashboardSnapshotReadPort>;
  stickySessions?: StickySessionManager;
  controlAuthorization?: ControlAuthorizationPort;
  server: Server;
  /**
   * Gap 12's deployment-level quota term (see `quota-demotion.ts`). Inert — returns null without
   * touching any evidence — while `routing.quota.enforce` stays false, so an operator who opted
   * out pays one property read per candidate and nothing else.
   */
  quotaDemotion: QuotaDemotionFn;
  costClassOf: CostClassFn;
  /**
   * G2's operator-set refusal ceilings (see `hard-cap.ts`). Null ⇒ no opinion; unlike the demotion
   * term this may REFUSE, and only ever on a figure the operator declared plus this relay's own
   * ledger reading — never on anything derived from a provider or catalogue.
   */
  hardCap: (attempt: ResolvedAttempt, now: number) => HardCapVerdict | null;
}

type ProxyAccountingAttribution = "relay_held" | "caller_operated" | "unknown";
type ProxyAccountingFailureKind = "timeout" | "provider_error" | "auth_error" | "rate_limit" | "aborted" | "protocol" | "unknown";

function isCallerVisibleAccountingPath(method: string | undefined, pathname: string): boolean {
  if (method !== "POST") return false;
  return pathname === "/v1/messages"
    || pathname === "/v1/chat/completions"
    || pathname === "/chat/completions"
    || pathname === "/v1/responses"
    || pathname === "/responses";
}

/** Records caller-visible terminals that occur before parsed-request accounting exists. */
function recordEarlyTerminalAccounting(
  recorder: AccountingRecorder,
  startedAt: number,
  client: string,
): void {
  try {
    // failureKind "unknown", not "protocol": the enum's only protocol kind means a
    // PROVIDER answered with a malformed envelope, and this request never left the
    // relay — nothing reached any provider to be protocol about.
    createAccountingRequest({ recorder, startedAt, client }).complete({
      outcome: "error",
      failureKind: "unknown",
      attribution: "unknown",
      endedAt: Date.now(),
    });
  } catch {
    // Accounting is observational and must never change caller traffic.
  }
}

function serveAccountingAttribution(attempt: ResolvedAttempt): ProxyAccountingAttribution {
  if (attempt.credential.state === "declared-present") return "relay_held";
  if (attempt.credential.state === "not-declared" && attempt.target.credentialMode !== "contained") {
    return "caller_operated";
  }
  return "unknown";
}

function repairAccountingAttribution(state: ResolvedAttempt["credential"]["state"]): ProxyAccountingAttribution {
  return state === "declared-present" ? "relay_held" : "unknown";
}

function accountingTokens(
  usage: UsageAccumulator,
  estimatedInputTokens: number,
  includeEstimatedOutput: boolean,
): TokenFactsInput {
  const estimatedOutputTokens = includeEstimatedOutput ? usage.estimatedOutputTokens : undefined;
  const hasEstimatedOutput = typeof estimatedOutputTokens === "number"
    && Number.isSafeInteger(estimatedOutputTokens)
    && estimatedOutputTokens > 0;
  const estimated = {
    ...(estimatedInputTokens > 0
      ? { inputTokens: estimatedInputTokens, inputMethod: "relay_estimate" }
      : {}),
    ...(hasEstimatedOutput
      ? { outputTokens: estimatedOutputTokens, outputMethod: "relay_estimate" }
      : {}),
  };
  return {
    reported: {
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      ...(usage.cacheCreationInputTokens !== undefined
        ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
        : {}),
      ...(usage.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: usage.cacheReadInputTokens } : {}),
    },
    ...(estimatedInputTokens > 0 || hasEstimatedOutput
      ? { estimated }
      : {}),
  };
}

/**
 * Build the published-price lookup the accounting lifecycle prices spend through.
 *
 * Request-path safe by construction: `cachedLimits()` reads the in-memory catalog
 * cache and NEVER fetches (same contract as the context guardrail's lookup), and the
 * synced capability snapshot is memoized on its file mtime. A deployment that
 * publishes no price resolves to null and stays UNPRICED — never priced at a
 * fallback or a default. The reference rung uses the snapshot for the same model id,
 * labelled `reference`, exactly as `/candidates` already labels it.
 */
function buildAccountingPricePort(catalog: ModelCatalog, cfg: Config): AccountingPricePort {
  return (provider, model) => {
    const p = cfg.providers[provider];
    const providerLimits = p?.kind === "openai" && model
      ? catalog.cachedLimits(provider, model)
      : null;
    const data = loadTierData();
    const matched = data
      ? findTierModel<TierModel>(model, data.byNorm, data.exactByNorm)
      : null;
    // A FUZZY match borrows a different SKU's row (`glm-5.2` → `glm-5.2-max`). A
    // borrowed score mis-ranks a pool; a borrowed PRICE would mis-state spend — so
    // this path takes the stricter exact-only rule, like `contextWindowResolver`.
    const tier = matched?.match === "exact" ? matched.rec : undefined;
    const meta = resolveMetadata(model, {
      providerLimits,
      reference: tier
        ? {
          pricePromptPerToken: typeof tier.price_prompt === "number" ? tier.price_prompt : null,
          priceCompletionPerToken: typeof tier.price_completion === "number" ? tier.price_completion : null,
          from: `openrouter:${tier.norm}`,
        }
        : null,
    });
    if (meta.priceSource === null) return null;
    return {
      pricePerMillionIn: meta.pricePerMTokIn,
      pricePerMillionOut: meta.pricePerMTokOut,
      priceSource: meta.priceSource,
    };
  };
}

/**
 * Request accounting is intentionally separate from health state: health owns
 * routing decisions, while this helper only observes actual egress and the
 * downstream response lifetime. Every method is fail-open for proxy traffic.
 */
class RequestAccountingState {
  private readonly request: AccountingRequest | null;
  private readonly active = new Set<AccountingAttempt>();
  private readonly committed = new Set<AccountingAttempt>();
  private responseTerminal: "finished" | "cancelled" | null = null;
  private finalized = false;
  private successfulServe = false;
  private committedServeAttribution: ProxyAccountingAttribution | null = null;
  private lastFailure: ProxyAccountingFailureKind = "unknown";
  private lastAttribution: ProxyAccountingAttribution = "unknown";

  constructor(
    recorder: AccountingRecorder,
    response: ServerResponse,
    startedAt: number,
    private readonly estimatedInputTokens: number,
    client: string,
    private readonly pricePort?: AccountingPricePort,
  ) {
    try {
      this.request = createAccountingRequest({ recorder, startedAt, client, pricePort });
    } catch {
      this.request = null;
    }

    response.once("finish", () => {
      if (this.responseTerminal === null) this.responseTerminal = "finished";
      this.finalizeIfReady();
    });
    response.once("close", () => {
      if (this.responseTerminal === null) {
        this.responseTerminal = response.writableFinished ? "finished" : "cancelled";
      }
      this.finalizeIfReady();
    });
  }

  startServe(attempt: ResolvedAttempt, startedAt: number): AccountingAttempt | null {
    return this.start("serve", {
      startedAt,
      attribution: serveAccountingAttribution(attempt),
      provider: attempt.target.provider,
      model: attempt.target.model ?? null,
      credentialId: attempt.credentialId,
    });
  }

  /**
   * CONTRACT: the returned handle MUST be completed exactly once, on every exit
   * path (success, refusal, transport error, cancellation). Only `complete()`
   * removes an entry from `active`, and `finalizeIfReady()` refuses to finish the
   * request while `active` is non-empty — so a custom `Reshaper` that starts an
   * attempt and drops the handle stalls this request's `request-completed` event
   * until the store LRU-evicts it, and the day aggregate silently misses the turn.
   *
   * Deliberately NO eager sweep here: once the caller response is terminal, a
   * still-active attempt is usually a REAL repair in flight being aborted by the
   * disconnect, and its own `complete(cancelled/aborted)` lands a few ticks later.
   * Sweeping at finalize time races that and would relabel honest cancellations as
   * `error/unknown`; the in-tree reshapers all complete in `finally`.
   */
  startRepair(options: {
    readonly resolvedAttempt: ResolvedAttempt | null;
    readonly credentialState: ResolvedAttempt["credential"]["state"];
    readonly provider: string | null;
    readonly model: string | null;
    readonly credentialId: string | null;
    readonly startedAt: number;
  }): AccountingAttempt | null {
    return this.start("repair", {
      startedAt: options.startedAt,
      attribution: repairAccountingAttribution(options.credentialState),
      provider: options.resolvedAttempt?.target.provider ?? options.provider,
      model: options.resolvedAttempt?.target.model ?? options.model,
      credentialId: options.resolvedAttempt?.credentialId ?? options.credentialId,
    });
  }

  markCommitted(attempt: AccountingAttempt | null, at: number): void {
    if (attempt === null) return;
    try {
      if (attempt.markCommitted({ at })) {
        this.committed.add(attempt);
        if (attempt.role === "serve") this.committedServeAttribution = attempt.attribution;
      }
    } catch {
      // Accounting must not perturb a successful response write.
    }
  }

  complete(
    attempt: AccountingAttempt | null,
    outcome: "success" | "error" | "cancelled",
    failureKind: ProxyAccountingFailureKind | null,
    usage: UsageAccumulator,
    endedAt = Date.now(),
  ): void {
    if (attempt === null) return;
    try {
      // The backend observer also sees a provisional prefix that stream-commit may
      // withhold for failover. Only a committed serve attempt actually forwarded it;
      // repair output is consumed internally and remains independently metered.
      attempt.complete({
        outcome,
        failureKind,
        endedAt,
        tokens: accountingTokens(
          usage,
          attempt.role === "serve" ? this.estimatedInputTokens : 0,
          attempt.role === "repair" || this.committed.has(attempt),
        ),
      });
    } catch {
      // The recorder and its packets are strictly observational.
    }
    this.active.delete(attempt);
    this.committed.delete(attempt);
    this.lastAttribution = attempt.attribution;
    if (attempt.role === "serve" && outcome === "success") this.successfulServe = true;
    if (outcome !== "success" && failureKind !== null) this.lastFailure = failureKind;
    this.finalizeIfReady();
  }

  private start(
    role: "serve" | "repair",
    options: {
      readonly startedAt: number;
      readonly attribution: ProxyAccountingAttribution;
      readonly provider: string | null;
      readonly model: string | null;
      readonly credentialId: string | null;
    },
  ): AccountingAttempt | null {
    if (this.request === null || this.finalized || this.responseTerminal === "cancelled") return null;
    try {
      const attempt = this.request.startAttempt({ role, ...options });
      this.active.add(attempt);
      this.lastAttribution = options.attribution;
      return attempt;
    } catch {
      return null;
    }
  }

  isRequestClosed(): boolean {
    return this.responseTerminal !== null || this.finalized;
  }

  private finalizeIfReady(): void {
    if (this.finalized || this.request === null || this.responseTerminal === null) return;
    if (this.active.size > 0) {
      // Two very different reasons for a still-active attempt:
      //
      // - On "close" (client disconnect mid-turn) a REAL repair is usually still in
      //   flight, being aborted by that same disconnect; its own
      //   complete("cancelled"/"aborted") lands within a few ticks. Returning here
      //   lets that honest completion happen instead of relabelling it.
      // - On "finish" the handler has fully written, so every in-tree reshaper has
      //   long since completed its handle in `finally`. Anything still active is a
      //   DROPPED handle from a custom Reshaper that ignored the startRepair
      //   contract; sweeping it keeps the request from stalling unfinalized until
      //   store eviction. Recorded as error/unknown — the one honest statement,
      //   since nothing observed how the abandoned egress ended. A late real
      //   completion is harmlessly ignored: complete() is idempotent and this
      //   object is finalized immediately after.
      if (this.responseTerminal !== "finished") return;
      for (const attempt of [...this.active]) {
        this.complete(attempt, "error", "unknown", createUsageAccumulator());
      }
    }
    this.finalized = true;
    try {
      if (this.responseTerminal === "cancelled") {
        this.request.complete({
          outcome: "cancelled",
          failureKind: "aborted",
          attribution: this.committedServeAttribution ?? this.lastAttribution,
        });
      } else if (this.successfulServe) {
        this.request.complete();
      } else {
        this.request.complete({
          outcome: "error",
          failureKind: this.lastFailure,
          attribution: this.committedServeAttribution ?? this.lastAttribution,
        });
      }
    } catch {
      // A malformed accounting packet must never affect the caller response.
    }
  }
}

function withRepairAccounting(reshaper: Reshaper, accounting: RequestAccountingState | null): Reshaper {
  if (accounting === null) return reshaper;
  const hooks: ReshaperAccountingHooks = {
    startRepairAttempt(options) {
      const attempt = accounting.startRepair(options);
      if (attempt === null) return null;
      return {
        complete(completion) {
          accounting.complete(
            attempt,
            completion.outcome,
            completion.failureKind,
            completion.usage,
            completion.endedAt,
          );
        },
      };
    },
    isRequestClosed() {
      return accounting.isRequestClosed();
    },
  };
  return {
    reshape(request) {
      return reshaper.reshape(request, hooks);
    },
  };
}

function dashboardHeaders(req: IncomingMessage): DashboardHeaderMap {
  const headers: Record<string, string[]> = {};
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index];
    const value = req.rawHeaders[index + 1];
    if (name === undefined || value === undefined) continue;
    const key = name.toLowerCase();
    (headers[key] ??= []).push(value);
  }
  return headers;
}

/** Canonical dashboard origin synthesis, including the brackets required by IPv6 URLs. */
export function dashboardExpectedOriginForAuthority(hostname: string, port: number): string {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `http://${host}:${port}`;
}

function dashboardExpectedOrigin(server: Server, cfg: Config): string | null {
  const authority = listenerAuthority(server, cfg);
  if (!authority) return null;
  return dashboardExpectedOriginForAuthority(authority.hostname, authority.port);
}

/**
 * Treat percent spellings of the dashboard namespace as dashboard requests even when malformed.
 * They are never canonicalized or served; this is only a fail-closed egress boundary.
 */
function dashboardNamespaceTarget(path: string): boolean {
  const rawPath = path.split("?", 1)[0] ?? "";
  // Literal routes retain their deliberately narrow mount. Percent-bearing lookalikes take the
  // stricter path below so an encoded separator/query/dot/backslash can never fall through.
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

  // Static handling is synchronous and intentionally receives the raw target: query strings and
  // alternate spellings are not cache variants on this tokenless surface.
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
        // Bootstrap is a dashboard-specific control operation. The generic admission above
        // remains unchanged for every existing route; this only supplies the route contract.
        controlAuthorized: validateControlAuthorization(h.controlAuthorization, req.headers),
      },
      readBody: (maxBytes) => readBody(req, maxBytes),
    },
    { auth: h.dashboardAuth, read: h.dashboardRead },
  );
  if (response.handled) {
    writeDashboardResponse(res, response);
    // One metadata record per dashboard answer, mirroring the admin-route convention:
    // status + logSafePath(path) only. The session/bootstrap tokens travel as headers and
    // body bytes, neither of which this record can carry (`served` is null, no attempts).
    h.logger.write(baseLog(started, path, false, false, response.status, "skipped", null));
    return true;
  }

  // Do not let a dashboard lookalike reach proxy routing. This covers unknown API paths and
  // every other /dashboard/* spelling while preserving all existing non-dashboard routes.
  failDashboardClosed(res, 404, "dashboard route not found");
  h.logger.write(baseLog(started, path, false, false, 404, "skipped", null));
  return true;
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

  // The dashboard owns a deliberately tiny route namespace.  It must run before the generic
  // proxy body reader: static GET/HEAD never buffer, and dashboard writes retain their 16 KiB
  // cap rather than inheriting the data-plane's 36 MiB allowance.
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

  // ONE full-body token walk per request, shared with the context guardrail below.
  // estimateRequestTokens walks the entire parsed body — potentially tens of MB — so
  // computing it once per consumer paid that twice on every caller-visible request.
  // ⚠ Reassigned below: a stripped `@relay:` directive shrinks the body, and the
  // guardrail must judge the body that will actually reach the backend.
  let estimatedRequestTokens = estimateRequestTokens(reqJson);

  // Only exact caller-visible inference routes create a request lifecycle.
  // Admin/control aliases and prefix lookalikes remain outside accounting.
  // (Deliberately constructed even under the NOOP recorder: the lifecycle also owns
  // `isRequestClosed()`, which is how a running repair learns the client went away.)
  const accounting = isCallerVisibleAccountingPath(req.method, pathname)
    ? new RequestAccountingState(
      h.accountingRecorder,
      res,
      started,
      estimatedRequestTokens,
      requestClient,
      h.accountingPricePort,
    )
    : null;



  const isCountTokens = req.method === "POST" && pathname === "/v1/messages/count_tokens";
  const isMessages = req.method === "POST" && pathname.startsWith("/v1/messages") && !isCountTokens;

  // Real traffic is the signal the adaptive cadence was built around: probe briskly while the
  // proxy is in use, drop to `slow` once it has been idle. `noteUserActivity()` had no callers
  // either, so the loop could never have left its startup mode even if it had been running.
  h.pingLoop?.noteUserActivity();

  // Route the request's model to a concrete provider + backend model candidates.
  //
  // ⚠ `subagentSpec` must run INSIDE this try. It throws `RoutingError` for an
  // unresolvable `@relay:` directive, and while it sat outside, that throw escaped
  // to `createProxy`'s top-level catch and surfaced as `502 llm-relay internal
  // error: …` with NO log line — fail-closed and loud, but mislabelled as a proxy
  // bug and invisible to the operator. A bad directive is a client routing error
  // (400) like any other unresolvable spec.
  let targetCandidates: ResolvedTarget[];
  // Hoisted out of the try: the served response has to say whether the answer came from below the
  // requested effort band, and that is only knowable from the pool that was actually addressed.
  let degradedSpecs: Set<string> | null = null;
  let addressedPool: string | null = null;
  try {
    // A SUBAGENT request may route somewhere other than its nominal model: either an explicit
    // `@relay: <spec>` in the dispatcher's prompt (stripped here, so the model never sees it),
    // Claude's cc_is_subagent marker, or Codex's request metadata header. Main-conversation
    // requests remain untouched unless that front door's rule explicitly uses scope "all".
    const subSpec = subagentSpec(reqJson, model, cfg, req.headers, requestClient);
    const routedModel = subSpec ?? model;
    materializeDynamicPools(cfg, h.catalog);
    // Re-serialize whenever a subagent spec applied — the @relay: line was stripped from reqJson
    // in place, and it must not reach the backend even when the spec matches the nominal model.
    if (subSpec !== null) {
      reqBuf = Buffer.from(JSON.stringify(reqJson), "utf8");
      // The body just shrank, so the shared token estimate is stale for anything downstream
      // of this point — notably the context guardrail. Accounting already captured the
      // pre-strip figure, which is correct there: that walk measured what the CLIENT sent.
      estimatedRequestTokens = estimateRequestTokens(reqJson);
    }
    targetCandidates = resolveTargets(routedModel, cfg);
    if (typeof routedModel === "string" && routedModel.startsWith("pool/")) {
      addressedPool = routedModel.slice("pool/".length);
      const tail = cfg.routing.poolDegraded?.[addressedPool];
      degradedSpecs = tail && tail.length > 0 ? new Set(tail) : null;
    }

    // The freeOnly guard: rerouted-by-offload traffic must not spend money. Enforced on the
    // RESOLVED candidates, not the spec — a pool lists free and paid members side by side, and
    // "the pool is mostly free" is exactly the assumption this exists to not rely on. Refusal is
    // loud (a clean 503 naming the rule), never a fall-through: falling through to
    // `routing.default` is the Anthropic passthrough, i.e. the very spend being guarded against.
    // ⚠ The guard covers a DIRECTLY ADDRESSED pool too, not only offload-rerouted traffic.
    // Gating it on `subSpec !== null` meant it never ran for the case it most needed to: a
    // dispatch `cliLane` runs `claude -p --model pool/<name>`, whose requests are a MAIN
    // conversation — no subagent marker, no `@relay:` directive — so the free-lane traffic this
    // flag exists to bound walked straight past it. `pool/<name>` is by construction relay-routed
    // free-lane traffic and never the vendor passthrough, and the guard can only ever refuse to
    // spend, so extending it there cannot cost anyone an answer they were entitled to.
    const addressesPool = typeof routedModel === "string" && routedModel.startsWith("pool/");
    if ((subSpec !== null || addressesPool) && freeOnlyApplies(offloadRule(cfg, requestClient), subSpec !== null)) {
      const kept: ResolvedTarget[] = [];
      let blocked: { spec: string; why: string } | null = null;
      for (const t of targetCandidates) {
        const assessment = t.kind === "openai" && t.model
          ? assessCost(t.model, h.catalog.cachedLimits(t.provider, t.model), cfg.providers[t.provider]?.tierType)
          : null; // anthropic passthrough — primary quota, definitionally not free
        // A deployment that STATED it is not free outranks a price table that says it is. The
        // `provider-tier` basis is an assumption about a roster; a 403 naming a subscription is
        // that deployment correcting us. (`isCostBlocked` excludes `allowance-exhausted` — a
        // spent allowance is not a price, and must not be laundered into one here either.)
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

  // Demote unusable candidates — and do NOTHING else to the order.
  //
  // ⚠ Deliberately NOT `getHealthyTargets()`: that filters AND re-sorts by measured
  // stability, which is a second ranking pass competing with the deployment-fitness ranking
  // `resolveTargets` already applied. Two ranking passes
  // means neither decides the order, and live health then PROMOTES on evidence that
  // is often a single request's latency. Health is used here only to demote, never
  // to promote: a target the breaker is cooling steps aside, everything else keeps
  // its fitness order. (The re-sort was invisible for as long as an untracked target
  // scored a flat 100 and `Array.prototype.sort` is stable — INV-TS-7.)
  // The OpenAI front (Chat Completions / Responses) is detected BEFORE the context guardrail so
  // the guardrail covers it: both fronts resolve concrete target deployments, and the estimator
  // walks all three wire shapes. The front went without this pruning until 0.17.0 — the same
  // "two paths, two policies, one of them empty" failure mode as the pool-failover incident.
  const openAiFrontProtocol = detectOpenAiFrontProtocol(req.method, pathname);

  const routingNow = Date.now();
  // Resolve the credential once per configured candidate after all route-level pruning. The
  // resulting attempt is immutable for this request: retries and both public fronts must not
  // observe an environment change halfway through a provider attempt.
  const attempts = expandCredentialAttempts(targetCandidates);
  // An explicit empty/disabled/model-scoped/missing fleet cannot make egress.  Keeping a
  // synthetic first attempt here would accidentally turn a configuration error into a request.
  if (attempts.length === 0) {
    failClosed(res, 502, "llm-relay configuration: no enabled credential slot is available for the resolved target");
    h.logger.write(baseLog(started, path, hadTools, false, 502, "skipped", null));
    return;
  }
  const rankedAttempts = rankCredentialAttempts(attempts, h.credentialLru, {
    evidenceFor: (attempt) => credentialEvidence(attempt, cfg, h.breaker, routingNow),
  });
  const { ordered: orderedAttempts, quotaDemotedFirst } = orderDeploymentGroupsByUsability(
    rankedAttempts,
    h.breaker,
    routingNow,
    h.quotaDemotion,
    h.costClassOf,
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

  // Context guardrail — enforced ONLY against a limit the serving provider published about its own
  // deployment. An unknown limit means no guardrail: the request goes upstream and the provider
  // answers with its own (authoritative) error.
  //
  // Candidates whose published context limits are exceeded by the estimated prompt tokens are pruned.
  // If all candidates are pruned, fail closed with 400 naming the context limit.
  if ((isMessages || openAiFrontProtocol) && reqJson) {
    // The single walk computed above (re-run here ONLY if an `@relay:` directive was
    // stripped, which shrinks the body this guardrail is judging).
    const estimatedTokens = estimatedRequestTokens;
    if (estimatedTokens > 0) {
      const remainingAttempts: ResolvedAttempt[] = [];
      let firstExceeded: { target: ResolvedTarget; limit: number } | null = null;

      for (const group of groupCredentialAttempts(walkAttempts)) {
        const candidate = group.attempts[0]!;
        const t = candidate.target;
        if (t.model) {
          const limits = h.catalog.cachedLimits(t.provider, t.model);
          if (limits?.contextLength && estimatedTokens > limits.contextLength) {
            if (!firstExceeded) {
              firstExceeded = { target: t, limit: limits.contextLength };
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

  let target = walkAttempts[0]!.target;
  const credentialWalk = new CredentialWalk(walkAttempts, {
    lru: h.credentialLru,
    walkBudgetMs: cfg.walkBudgetMs ?? DEFAULT_WALK_BUDGET_MS,
    selectionNow: routingNow,
    evidenceFor: (attempt) => credentialEvidence(attempt, cfg, h.breaker, routingNow),
  });
  const credentialTrace = new CredentialAttemptTrace(cfg);

  // OpenAI-compatible FRONT: route both Chat Completions and Responses requests through the
  // resolved target. The adapter supports OpenAI-compatible and Anthropic backends, so Codex and
  // OpenAI-native IDEs can use the same relay that Claude clients use in the other direction.
  if (openAiFrontProtocol) {
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
    }, h);
    return;
  }

  // OpenAI-compatible backends expose ONLY /chat/completions — they have no
  // count_tokens route and no other Anthropic paths. Rather than mistranslate
  // those into a chat completion (yielding a spurious 400/garbage), answer
  // count_tokens locally with a cheap estimate and reject other paths cleanly.
  // For an Anthropic backend everything forwards as before (it speaks these).
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

  // Candidate execution loop: CredentialWalk owns breadth-first slot expansion,
  // request-local suppression, and the wall-clock start budget.
  const attemptTrace = new RequestAttemptTrace();
  const pool429 = new Pool429Tracker();
  const tried: string[] = [];

  while (!res.destroyed) {
    // G2's attempt boundary: an offer whose operator-set hard cap is reached is refused here,
    // before any egress, and the loop comes straight back for the next candidate.
    const resolvedAttempt = nextUncappedAttempt(h, credentialWalk, attemptTrace, pool429);
    if (!resolvedAttempt) break;
    target = resolvedAttempt.target;
    const controller = new AbortController();
    const callerController = new AbortController();
    const timer = setTimeout(() => controller.abort(), target.timeoutMs);
    const onResClose = abortOnClientClose(res, callerController, controller);
    res.on("close", onResClose);
    let attempt: HealthAttempt | undefined;
    const usage = createUsageAccumulator();
      let egressCallbackCalled = false;
      const onEgress = () => {
        egressCallbackCalled = true;
        pool429.noteEgress();
        const egressAt = Date.now();
        attempt = beginHealthAttempt(h, resolvedAttempt, egressAt, attemptTrace, usage, accounting) ?? undefined;
        if (!attempt) throw new Error("llm-relay: could not begin provider attempt");
        attempt.accountingAttempt = accounting?.startServe(resolvedAttempt, egressAt) ?? null;
        recordCredentialStarted(credentialWalk, credentialTrace, resolvedAttempt);
      tried.push(specOfTarget(target));
    };
    let credentialRecorded = false;

    try {
      let forwardHeaders: Record<string, string>;
      try {
        forwardHeaders = buildForwardHeaders(req.headers, resolvedAttempt);
      } catch (e) {
        credentialWalk.recordRejected(resolvedAttempt);
        if (e instanceof CredentialConfigError) {
          failClosed(res, 502, `llm-relay configuration: ${e.message}`);
          h.logger.write(baseLog(started, path, hadTools, false, 502, "skipped", null, attemptTrace.snapshot()));
          return;
        }
        throw e;
      }

      let backendRes: Response;
      try {
        backendRes = await fetchBackend(resolvedAttempt, {
          path,
          method: req.method ?? "POST",
          reqBuf,
          reqJson,
          anthropicHeaders: forwardHeaders,
          wantsStream,
          // Reaches the dialect-rescue commit points: a tool call the relay reconstructs out of
          // model TEXT is refused when it names a destructive tool.
          isDestructive: h.isDestructive,
          usage,
          signal: controller.signal,
          onEgress,
        });
        if (!attempt) {
          credentialWalk.recordRejected(resolvedAttempt);
          if (errorOrigin(backendRes) === "local") {
            await forwardLocalResponse(res, backendRes);
            h.logger.write(baseLog(started, path, hadTools, false, backendRes.status, "skipped", null, attemptTrace.snapshot()));
          } else {
            await backendRes.body?.cancel().catch(() => {});
            failClosed(res, 502, "llm-relay: backend returned before provider egress");
            h.logger.write(baseLog(started, path, hadTools, false, 502, "skipped", null, attemptTrace.snapshot()));
          }
          return;
        }
      } catch (e) {
        if (!attempt) {
          if (credentialWalk.pending === resolvedAttempt) {
            credentialWalk.recordRejected(resolvedAttempt);
          }
          if (res.destroyed) return;
          const status = controller.signal.aborted ? 504 : 502;
          failClosed(res, status, egressCallbackCalled
            ? "llm-relay: could not begin provider attempt"
            : "llm-relay: backend preparation failed");
          h.logger.write(baseLog(started, path, hadTools, false, status, "skipped", null, attemptTrace.snapshot()));
          return;
        }
        const aborted = controller.signal.aborted;
        const status = aborted ? 504 : 502;
        if (res.destroyed) {
          completeAttemptCancelled(h, attempt, "client disconnected");
          recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, { kind: "cancelled" });
          credentialRecorded = true;
          return;
        }

        completeAttemptFailure(h, attempt, {
          failure: "transport",
          provenance: aborted ? "deadline" : "upstream",
          status,
        });
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          aborted ? { kind: "timeout" } : { kind: "provider-transport" },
        );
        credentialRecorded = true;
        const walkEnd = endWalk(
          h,
          res,
          "anthropic",
          credentialWalk,
          attemptTrace,
          pool429,
          status,
          sticky,
          credentialTrace,
          () => baseLog(started, path, hadTools, false, status, "skipped", target, attemptTrace.snapshot()),
          {
            kind: "transport",
            message: aborted ? "backend timed out" : `backend unreachable: ${(e as Error).message}`,
            // Preserved cross-front residue: this handle exit omits served-by while its OpenAI
            // twin includes it. Unifying it is now a one-line `servedBy` follow-up.
          },
        );
        if (walkEnd) continue;
        return;
      }

      const reportedModelSource = backendRes;
      const cls = classifyStatus(backendRes.status);
      const retryAfterMs = parseRetryAfterMs(backendRes.headers.get("retry-after"));
      observeAttemptHeaders(h, attempt, backendRes.status, retryAfterMs, backendRes.headers);

      const inspected = await inspectCandidateResponse(backendRes, resolvedAttempt, retryAfterMs);
      if (inspected.kind === "post-header-body-failure") {
        const disposition = completePostHeaderBodyFailure(
          h, res, controller.signal, attempt, credentialWalk, credentialTrace, resolvedAttempt,
        );
        credentialRecorded = true;
        if (disposition === "cancelled") return;
        const status = disposition === "timeout" ? 504 : 502;
        const walkEnd = endWalk(
          h,
          res,
          "anthropic",
          credentialWalk,
          attemptTrace,
          pool429,
          status,
          sticky,
          credentialTrace,
          () => baseLog(
            started, path, hadTools, false, status, "skipped", target, attemptTrace.snapshot(),
          ),
          {
            kind: "post-header-body-failure",
            message: disposition === "timeout"
              ? "backend timed out while reading response body"
              : "llm-relay: provider response body failed after headers",
            servedBy: tried.join(", "),
          },
        );
        if (walkEnd) continue;
        return;
      }
      backendRes = inspected.response;
      if (inspected.eligibility.unknown) pool429.noteUnknownRefusal();

      const localFailure = errorOrigin(backendRes) === "local";
      const tryNext = !localFailure && shouldTryNext(cls);
      if (backendRes.status >= 400) {
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          walkOutcomeForResponse(backendRes.status, localFailure, inspected.eligibility.scope),
        );
        credentialRecorded = true;

        const next = tryNext && !res.destroyed ? nextUncappedAttempt(h, credentialWalk, attemptTrace, pool429) : undefined;
        if (next) {
          await backendRes.body?.cancel().catch(() => {});
          pool429.recordFailover(backendRes.status, retryAfterMs);
          completeAttemptFailure(h, attempt, {
            failure: "http",
            provenance: localFailure ? "relay-mapper-defect" : "upstream",
            status: backendRes.status,
            retryAfterMs,
          });
          continue;
        }
      }

      const streamed = (backendRes.headers.get("content-type") ?? "").includes("text/event-stream");
      if (streamed && backendRes.status < 400) {
        const probe = backendRes.body
          ? await probeStreamForCommit(backendRes.body, "anthropic-messages", {
              isCancelled: () => res.destroyed,
              malformedProvenance: target.kind === "openai" ? "local" : "upstream",
              // Declared, never inferred from the wire: only a stream the dialect wrapper actually
              // wrapped has a signal, so an upstream echoing the refusal code cannot mint `local`
              // provenance for itself and thereby dodge both failover and breaker accounting.
              ...(dialectRefusalSignalOf(backendRes) ? { relayRefusal: dialectRefusalSignalOf(backendRes)! } : {}),
            })
          : { kind: "dead" as const, reason: "stream has no body", provenance: "upstream" as const };

        if (probe.kind === "cancelled") {
          completeAttemptCancelled(h, attempt, "client disconnected before stream commit");
          recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, { kind: "cancelled" });
          credentialRecorded = true;
          return;
      }
      if (probe.kind === "dead") {
        const deadline = controller.signal.aborted;
        completeAttemptFailure(h, attempt, deadline
          ? { failure: "transport", provenance: "deadline", status: 504 }
          : {
              failure: "protocol",
              provenance: probe.provenance === "local"
                ? "relay-mapper-defect"
                : "invalid-upstream-envelope",
              status: 502,
            });
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          deadline
            ? { kind: "timeout" }
            : probe.provenance === "local" ? { kind: "local" } : { kind: "protocol" },
        );
          credentialRecorded = true;
          const walkEnd = endWalk(
            h,
            res,
            "anthropic",
            credentialWalk,
            attemptTrace,
            pool429,
            502,
            sticky,
            credentialTrace,
            () => baseLog(
              started,
              path,
              hadTools,
              true,
              502,
              "skipped",
              target,
              attemptTrace.snapshot(),
              upstreamReportedModel(reportedModelSource),
            ),
            {
              kind: "dead-stream",
              message: `llm-relay: ${probe.reason}`,
              errorType: probe.errorType,
                // Who produced this status. A dead PRE-COMMIT stream the relay judged `local` is the
                // proxy's own verdict, and saying so is the header's documented job — it was simply
                // never written on this path.
              errorOrigin: probe.provenance,
              servedBy: tried.join(", "),
              shouldTryNext: probe.provenance === "upstream",
              // Preserved residue: handle gates dead streams on `!res.destroyed`; the OpenAI
              // front additionally requires `!res.writableEnded`.
            },
          );
          if (walkEnd) continue;
          return;
        }

        backendRes = new Response(probe.body, {
          status: backendRes.status,
          headers: backendRes.headers,
        });
      }

      const stallMs = target.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
      if (streamed && backendRes.status < 400 && stallMs > 0) {
        clearTimeout(timer);
        backendRes = withStallWatchdog(backendRes, controller, stallMs);
      }

      const willValidate = isMessages && hadTools && backendRes.status < 400;
      const rawReshaper = cfg.mode === "repair" && willValidate
        ? h.resolveReshaper(resolvedAttempt)
        : undefined;
      const reshaper = rawReshaper ? withRepairAccounting(rawReshaper, accounting) : undefined;
      const doRepair = reshaper !== undefined;
      const streamCommitted = streamed && backendRes.status < 400;
      const responseCtx: Ctx = {
        tools,
        streamed,
        started,
        path,
        hadTools,
        req,
        target,
      attempt,
      signal: controller.signal,
      callerSignal: callerController.signal,
      reportedModelSource,
        retryAfterOverrideMs: pool429.overrideMs(backendRes.status, retryAfterMs),
        poolSummary: null,
        poolUnknownRefusals: pool429.unknownCount(),
        tried,
        degraded: degradedLabel(addressedPool, degradedSpecs, target),
        quotaDemoted: quotaDemotedFirst,
        paid: paidLabel(cfg, h, target),
        credentialHeaders: backendRes.status < 400
          ? credentialTrace.headers(resolvedAttempt)
          : credentialTrace.headers(),
        sticky,
      };

      if (streamCommitted) {
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          { kind: "success", status: backendRes.status },
        );
        credentialRecorded = true;
        responseCtx.credentialHeaders = credentialTrace.headers();
        pool429.recordFinal(backendRes.status);
        responseCtx.poolSummary = pool429.summary();
        res.writeHead(backendRes.status, responseHeadersForTarget(backendRes, responseCtx));
      }

      if (doRepair) {
        const repairResult = await repairPath(
          res,
          backendRes,
          timer,
          {
            ...responseCtx,
            wantsStream,
            reshaper: reshaper!,
            maxAttempts: cfg.repair.maxAttempts,
            pool429,
          },
          h,
        );
      if (repairResult !== null) {
        recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, { kind: "protocol" });
        credentialRecorded = true;
        // Deliberate endWalk holdout: this records a dead turn, never records final, and its
        // continue branch never records failover because recordDeadTurn already counted the cell
        // and cleared only429. Converting it would need skipFinal/skipFailover flags — exactly the
        // silent-skip hazard endWalk exists to prevent.
        pool429.recordDeadTurn();
          const next = !res.destroyed ? nextUncappedAttempt(h, credentialWalk, attemptTrace, pool429) : undefined;
          if (next) continue;

        const headers = walkExitHeaders(pool429, sticky, credentialTrace);
          failClosed(
            res,
            502,
            "llm-relay: tool call could not be repaired (failed)",
            Object.keys(headers).length > 0 ? headers : undefined,
          );
          h.logger.write({
            ...baseLog(
              started,
              path,
              hadTools,
              false,
              backendRes.status,
              repairResult.validated,
              target,
              attemptTrace.snapshot(),
              upstreamReportedModel(reportedModelSource),
            ),
            toolUseCount: repairResult.toolUseCount,
            uncheckableCount: repairResult.uncheckableCount,
            errorKinds: repairResult.errorKinds,
            repair: "failed",
          });
          return;
        }

        if (!credentialRecorded) {
          const outcome: CredentialWalkOutcome = attempt.terminal === "succeeded"
            ? { kind: "success", status: backendRes.status }
            : attempt.terminal === "cancelled" || res.destroyed
              ? { kind: "cancelled" }
              : { kind: "local" };
          recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, outcome);
          credentialRecorded = true;
        }
        return;
      }

      if (!streamCommitted) {
        if (backendRes.status < 400) {
          recordCredentialOutcome(
            credentialWalk,
            credentialTrace,
            resolvedAttempt,
            { kind: "success", status: backendRes.status },
          );
          credentialRecorded = true;
          responseCtx.credentialHeaders = credentialTrace.headers();
        }
        pool429.recordFinal(backendRes.status);
        responseCtx.poolSummary = pool429.summary();
      }
      await transparentPath(res, backendRes, timer, { ...responseCtx, willValidate }, h);
      return;
    } finally {
      if (!credentialRecorded && attempt) {
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          res.destroyed ? { kind: "cancelled" } : { kind: "local" },
        );
        credentialRecorded = true;
      } else if (!credentialRecorded && credentialWalk.pending === resolvedAttempt) {
        credentialWalk.recordRejected(resolvedAttempt);
      }
      if (attempt && !attempt.completed) {
        if (res.destroyed) completeAttemptCancelled(h, attempt, "client disconnected");
        else {
          completeAttemptFailure(h, attempt, {
            failure: "mapping",
            provenance: "relay-mapper-defect",
            status: 502,
          });
        }
      }
      clearTimeout(timer);
      res.off("close", onResClose);
    }
  }

  // THE all-capped refusal site — the only one on this front, deliberately.
  //
  // `allCapped()` requires `!egressed`, and every failover arm above runs only after a candidate
  // egressed, so a check inside one could never be true: the loop exit is the sole place the
  // condition can hold. (Eight such inner checks existed and were dead code on the request path;
  // the rule they LOOK like they enforce — a walk that mixes caps with real failures keeps its
  // last upstream error — is enforced by `egressed`, and pinned by the mixed-walk tests.) A walk
  // that exhausted for any other reason reaches here with nothing capped and must stay silent:
  // its caller already replied.
  if (!res.headersSent && !res.destroyed && pool429.allCapped()) {
    respondAllCapped(res, h, { started, path, hadTools, streamed: wantsStream }, "anthropic", pool429, attemptTrace.snapshot());
  }
}

/**
 * Order candidates worst-last WITHOUT dropping any: live, then credential-faulted, then cooling.
 *
 * Three states, and the distinction between them is the whole point:
 *   - live               — breaker closed, no standing 401/403. Keeps its fitness order.
 *   - credential-faulted — answered 401/403 recently. It is not sick, it is unusable, and it
 *                          must not cost a round-trip per request ahead of a working member.
 *   - cooling            — breaker open (rate-limited or repeatedly failing).
 *
 * Demotion, not filtering. The previous `filter(isHealthy)` with a keep-everything fallback
 * removed cooling candidates outright whenever at least one was healthy, so a pool could be
 * narrowed to a single member and then have nothing to fall back to when that one failed too.
 * Ordering is strictly better: a demoted target is only ever reached after every better one has
 * actually failed on this request, and a pool with 14 members always has 14 chances.
 *
 * Stable within each band, so the already-computed deployment fitness still decides among equals.
 */
/**
 * `"<spec> (below <band>)"` when this answer came from the pool's degrade tail, else null.
 *
 * The "loudly" half of automatic degradation. Falling back to a weaker live model is the right
 * behaviour — a band with nothing behind it turns "the strongest models are busy" into "no answer
 * at all" — but only because the caller is told. An unannounced downgrade is indistinguishable
 * from getting what you asked for.
 */
function paidLabel(cfg: Config, h: Handlers, target: ResolvedTarget): string | null {
  // Only openai-kind targets carry a price we can assess; the anthropic passthrough is the
  // caller's own subscription and is reported by the absence of any pool at all.
  if (target.kind !== "openai" || !target.model) return null;
  const assessment = assessCost(target.model, h.catalog.cachedLimits(target.provider, target.model), cfg.providers[target.provider]?.tierType);
  if (assessment.costClass === "free") return null;
  return `${specOfTarget(target)} (${assessment.costClass}, ${assessment.basis})`;
}

function degradedLabel(pool: string | null, degraded: Set<string> | null, target: ResolvedTarget): string | null {
  if (pool === null || degraded === null) return null;
  const spec = specOfTarget(target);
  return degraded.has(spec) ? `${spec} (below ${pool})` : null;
}

/** Is a learned allowance exhaustion still cooling this target? Never throws — no store, no cooling. */
function cooledByAllowance(attempt: ResolvedAttempt, now: number, costClass: CostClass | undefined): boolean {
  try {
    const { target } = attempt;
    // `exactOptionalPropertyTypes` is on: an explicit `undefined` is not the same as absent, and
    // absent is what "the caller could not classify this" must look like to `factsFor`.
    const until = cooldownUntil(target.provider, attempt.credentialId, target.model ?? null, {
      now,
      ...(costClass === undefined ? {} : { costClass }),
    });
    return until !== null && now < until;
  } catch {
    return false;
  }
}

interface StickyRequestContext {
  key: string;
  multiCandidateRoute: boolean;
  /** The previously stored pin's routing evaluation; null means a new pin may be created. */
  provenance: string | null;
}

type TargetUsability = "live" | "credential-fault" | "cooling";

/**
 * Gap 12: a SPENT quota demotes to the same cooling band as an outage (spec §5.4), because both
 * mean "this cell cannot serve right now, and it comes back on its own". A spent allowance is not
 * a sick backend, so the term never touches failure counters; registering the cooldown with
 * source "quota" exists purely so `/candidates`, the dashboard Cooldowns panel and
 * `llm-relay candidates` can SEE why the member stepped aside — and so a sticky pin or a degrade
 * tail check later in this same request reads the demotion too, without a second resolver pass.
 *
 * Learned limits gate only under `routing.quota.enforceLearned`; unknown quota yields null here
 * and has no effect whatsoever. Never throws, never drops, never refuses.
 */
function cooledByQuota(
  attempt: ResolvedAttempt,
  breaker: CircuitBreaker,
  quotaDemotion: QuotaDemotionFn | null | undefined,
  now: number,
): boolean {
  if (!quotaDemotion) return false;
  const spent = quotaDemotion(attempt, now);
  if (spent === null) return false;
  breaker.recordQuotaCooldown(targetIdentity(attempt), spent.resetsAt, now);
  return true;
}

function targetUsability(
  attempt: ResolvedAttempt,
  breaker: CircuitBreaker,
  now: number,
  quotaDemotion?: QuotaDemotionFn | null,
  costClassOf?: CostClassFn | null,
): TargetUsability {
  const identity = targetIdentity(attempt);
  if (!breaker.isHealthy(identity, now)) return "cooling";
  if (cooledByAllowance(attempt, now, costClassOf?.(attempt))) return "cooling";
  // A stated/declared quota at zero belongs in the SAME band as allowance-exhaustion above: both
  // are temporary conditions on a deployment that is otherwise healthy, and ordering them ahead
  // of live members is the whole point — the walk should spend its round-trips where capacity is.
  if (cooledByQuota(attempt, breaker, quotaDemotion, now)) return "cooling";
  if (breaker.hasCredentialFault(identity, now)) return "credential-fault";
  return "live";
}

/** Resolve every configured slot once, then retain deployment order while taking credential rounds. */
function expandCredentialAttempts(targets: readonly ResolvedTarget[]): ResolvedAttempt[] {
  const expanded: ResolvedAttempt[] = [];
  for (const target of targets) {
    const slots = target.credentialSlots;
    if (slots === undefined) {
      expanded.push(resolveAttempt(target));
      continue;
    }
    for (const slot of slots) {
      const attempt = resolveAttemptForSlot(target, slot);
      if (attempt) expanded.push(attempt);
    }
  }
  return expanded;
}

function credentialEvidence(
  attempt: ResolvedAttempt,
  cfg: Config,
  breaker: CircuitBreaker,
  now: number,
) {
  const identity = targetIdentity(attempt);
  const provider = cfg.providers[attempt.target.provider];
  const state = breaker.getState(identity);
  let facts: ReturnType<typeof factsFor> = [];
  try { facts = factsFor(attempt.target.provider, attempt.credentialId, attempt.target.model ?? null, { now }); } catch { /* persistent evidence is best effort */ }
  const cost = attempt.target.kind === "openai" && attempt.target.model
    ? assessCost(attempt.target.model, null, provider?.tierType).costClass
    : "paid";
  return {
    facts,
    health: breaker.isHealthy(identity, now) ? "unknown" as const : "unhealthy" as const,
    credentialFault: breaker.hasCredentialFault(identity, now),
    // `cost` here is deliberately assessed with NO catalog limits (see above), so it can say
    // `free` from a provider tier but never `paid` from a price. Passing it would under-report a
    // paid deployment as unclassified, so this evidence view reports cooling for cost-filtered
    // facts the same fail-safe way any unclassified caller does: they simply do not apply.
    cooling: cooledByAllowance(attempt, now, undefined),
    saturated: provider?.maxConcurrent != null && breaker.inFlightCredential(attempt.credentialId) >= provider.maxConcurrent,
    quota: state?.quotaObservations ?? [],
    cost,
  };
}

/**
 * Get the soonest cooldown lift time for a cooling attempt.
 * Checks breaker state first (covers breaker cooling + quota demotion), then target-facts for allowance facts.
 * Returns null if no known lift time (unknown).
 */
function coolingLiftTime(
  attempt: ResolvedAttempt,
  breaker: CircuitBreaker,
  now: number,
  costClassOf?: CostClassFn | null,
): number | null {
  const identity = targetIdentity(attempt);
  // 1. Breaker cooldown (covers failure/429/402 cooling AND quota demotion cooling)
  const breakerState = breaker.getState(identity);
  if (breakerState && breakerState.cooldownUntil > now) {
    return breakerState.cooldownUntil;
  }
  // 2. Allowance exhaustion fact (target-facts) - only if not already covered by breaker
  const costClass = costClassOf?.(attempt);
  const factCooldown = cooldownUntil(attempt.target.provider, attempt.credentialId, attempt.target.model ?? null, {
    now,
    ...(costClass === undefined ? {} : { costClass }),
  });
  if (factCooldown !== null && factCooldown > now) {
    return factCooldown;
  }
  return null;
}

/**
 * Keep every credential row of a deployment together while ordering deployments by their
 * best-ranked row. CredentialWalk performs the breadth-first interleaving when it offers rows.
 * Tracked like `orderByUsabilityTracked` so the request path can announce a displaced first choice.
 *
 * Within the COOLING band, order by soonest known lift time (ascending). Unknown lifts sort last.
 * Stable within ties and unknowns.
 */
function orderDeploymentGroupsByUsability(
  attempts: readonly ResolvedAttempt[],
  breaker: CircuitBreaker,
  now: number,
  quotaDemotion?: QuotaDemotionFn | null,
  costClassOf?: CostClassFn | null,
): { ordered: ResolvedAttempt[]; quotaDemotedFirst: string | null } {
  type Group = ReturnType<typeof groupCredentialAttempts>[number];
  const preferred = groupCredentialAttempts(attempts)[0]?.attempts[0];
  const live: Group[] = [];
  const faulted: Group[] = [];
  const cooling: Group[] = [];
  for (const group of groupCredentialAttempts(attempts)) {
    const usability = targetUsability(group.attempts[0]!, breaker, now, quotaDemotion, costClassOf);
    if (usability === "cooling") cooling.push(group);
    else if (usability === "credential-fault") faulted.push(group);
    else live.push(group);
  }

  // Sort cooling band by soonest lift time (ascending). Unknown (null) sorts last.
  // Stable sort preserves original order for ties and unknowns.
  cooling.sort((a, b) => {
    const liftA = coolingLiftTime(a.attempts[0]!, breaker, now, costClassOf);
    const liftB = coolingLiftTime(b.attempts[0]!, breaker, now, costClassOf);
    if (liftA === null && liftB === null) return 0; // both unknown - preserve order
    if (liftA === null) return 1; // A unknown sorts after B
    if (liftB === null) return -1; // B unknown sorts after A
    return liftA - liftB; // both known - ascending by lift time
  });

  const ordered = [...live, ...faulted, ...cooling].flatMap((group) => group.attempts);
  let quotaDemotedFirst: string | null = null;
  if (
    preferred !== undefined &&
    quotaDemotion !== undefined &&
    quotaDemotion !== null &&
    ordered[0] !== undefined &&
    ordered[0] !== preferred &&
    quotaDemotion(preferred, now) !== null
  ) {
    quotaDemotedFirst = quotaDemotionLabel(specOfTarget(preferred.target), quotaDemotion(preferred, now)!);
  }
  return { ordered, quotaDemotedFirst };
}

type CredentialAttemptLabel = number | "transport" | "timeout" | "protocol" | "local" | "client" | "cancelled";

/** Metadata-only trace: credential values and storage locations never enter it. */
class CredentialAttemptTrace {
  private readonly entries: Array<{
    provider: string;
    deployment: string;
    credentialId: ResolvedAttempt["credentialId"];
    multiSlot: boolean;
    outcome?: CredentialWalkOutcome;
  }> = [];

  constructor(private readonly cfg: Config) {}

  recordStarted(attempt: ResolvedAttempt): void {
    const configured = this.cfg.providers[attempt.target.provider]?.credentials;
    const multiSlot = configured !== undefined && configured.filter((slot) => slot.enabled !== false).length >= 2;
    this.entries.push({
      provider: attempt.target.provider,
      deployment: specOfTarget(attempt.target),
      credentialId: attempt.credentialId,
      multiSlot,
    });
  }

  record(attempt: ResolvedAttempt, outcome: CredentialWalkOutcome): void {
    const pending = [...this.entries].reverse().find((entry) => entry.outcome === undefined);
    if (
      !pending ||
      pending.provider !== attempt.target.provider ||
      pending.deployment !== specOfTarget(attempt.target) ||
      pending.credentialId !== attempt.credentialId
    ) {
      throw new Error("credential attempt trace outcome does not match a started attempt");
    }
    pending.outcome = Object.freeze({ ...outcome });
  }

  headers(servedAttempt?: ResolvedAttempt): Record<string, string> {
    if (!this.entries.some((entry) => entry.multiSlot)) return {};
    const previewServed = servedAttempt
      ? [...this.entries].reverse().find((entry) =>
          entry.outcome === undefined &&
          entry.provider === servedAttempt.target.provider &&
          entry.deployment === specOfTarget(servedAttempt.target) &&
          entry.credentialId === servedAttempt.credentialId,
        )
      : undefined;
    const served = this.entries.find((entry) => entry.outcome?.kind === "success") ?? previewServed;
    const headers: Record<string, string> = {};
    if (served?.multiSlot) headers[CREDENTIAL_HEADER] = served.credentialId;

    const failures = this.entries.filter(
      (entry) => entry !== served && entry.outcome?.kind !== "success",
    );
    if (this.entries.length >= 2 || served === undefined) {
      const tallies: Array<{ label: CredentialAttemptLabel; count: number }> = [];
      for (const entry of failures) {
        const label = credentialAttemptLabel(entry.outcome);
        const existing = tallies.find((candidate) => candidate.label === label);
        if (existing) existing.count += 1;
        else tallies.push({ label, count: 1 });
      }
      const summary = tallies.map(({ label, count }) => `${count}x${label}`).join(", ");
      headers[CREDENTIAL_ATTEMPTS_HEADER] =
        `${this.entries.length} tried, ${served ? 1 : 0} served${summary ? `: ${summary}` : ""}`;
    }
    return headers;
  }
}

function credentialAttemptLabel(outcome: CredentialWalkOutcome | undefined): CredentialAttemptLabel {
  if (outcome?.status !== undefined) return outcome.status;
  if (outcome?.kind === "provider-transport") return "transport";
  if (outcome?.kind === "timeout") return "timeout";
  if (outcome?.kind === "protocol") return "protocol";
  if (outcome?.kind === "client") return "client";
  if (outcome?.kind === "cancelled") return "cancelled";
  return "local";
}

function recordCredentialStarted(
  walk: CredentialWalk,
  trace: CredentialAttemptTrace,
  attempt: ResolvedAttempt,
): void {
  walk.recordStarted(attempt);
  trace.recordStarted(attempt);
}

function recordCredentialOutcome(
  walk: CredentialWalk,
  trace: CredentialAttemptTrace,
  attempt: ResolvedAttempt,
  outcome: CredentialWalkOutcome,
): void {
  walk.record(attempt, outcome);
  trace.record(attempt, outcome);
}

/**
 * G2's attempt boundary — EVERY `CredentialWalk.next()` on both public fronts goes through here.
 *
 * A candidate whose operator-set hard cap is reached is refused IN THIS PROCESS, before any
 * egress and before `recordStarted()`: no provider request, no LRU touch, no breaker mutation,
 * no accounting attempt — the capped key spends literally nothing. It is still announced three
 * ways: a status-only `capped` entry in the metadata log's attempt list, an `Nxcapped` tally in
 * `x-llm-relay-pool-attempts`, and the soonest cap boundary kept on the tracker so an ALL-CAPPED
 * walk can state its Retry-After instead of inventing one. "Health demotes, never drops" still
 * governs the WALK — the capped cell stays listed everywhere and lifts at the period boundary;
 * only this attempt is refused.
 */
function nextUncappedAttempt(
  h: Handlers,
  walk: CredentialWalk,
  attemptTrace: RequestAttemptTrace,
  tracker: Pool429Tracker,
): ResolvedAttempt | undefined {
  const now = Date.now();
  for (;;) {
    const candidate = walk.next();
    if (!candidate) return undefined;
    const verdict = h.hardCap(candidate, now);
    if (verdict === null) {
      // Announce the offer BEFORE returning: the tracker needs to know a candidate is in flight so
      // a cap it sees while the loop asks for the next one is ordered after this candidate.
      tracker.noteOffered();
      return candidate;
    }
    tracker.recordCapped(
      hardCapLabel(parseCredentialId(candidate.credentialId)?.label ?? null, specOfTarget(candidate.target), verdict),
      verdict.resetsAt,
    );
    attemptTrace.recordCapped(candidate.target, now);
    walk.recordRejected(candidate);
  }
}

type WalkExitKind = "transport" | "post-header-body-failure" | "dead-stream";

interface WalkExitData {
  kind: WalkExitKind;
  message: string;
  errorType?: string | undefined;
  errorOrigin?: ErrorOrigin;
  servedBy?: string;
  shouldTryNext?: boolean;
}

function walkExitHeaders(
  tracker: Pool429Tracker,
  sticky: StickyRequestContext | null | undefined,
  credentialTrace: CredentialAttemptTrace,
  {
    errorOrigin,
    errorType,
    servedBy,
  }: Pick<WalkExitData, "errorOrigin" | "errorType" | "servedBy"> = {},
): Record<string, string> {
  const before: Record<string, string> = {};
  if (servedBy !== undefined) before[SERVED_BY_HEADER] = servedBy;
  if (errorOrigin !== undefined) before[ERROR_ORIGIN_HEADER] = errorOrigin;

  const after = errorType === DIALECT_REFUSED_DESTRUCTIVE_CODE
    ? { [TOOL_DIALECT_HEADER]: "refused-destructive" }
    : {};
  const headers: Record<string, string> = {
    ...before,
    ...(stickyProvenanceHeaders(sticky) ?? {}),
    ...credentialTrace.headers(),
    ...after,
  };
  const summary = tracker.summary();
  if (summary) headers[POOL_ATTEMPTS_HEADER] = summary;
  return headers;
}

function endWalk(
  h: Handlers,
  res: ServerResponse,
  front: "anthropic" | "openai",
  walk: CredentialWalk,
  attemptTrace: RequestAttemptTrace,
  tracker: Pool429Tracker,
  status: number,
  sticky: StickyRequestContext | null | undefined,
  credentialTrace: CredentialAttemptTrace,
  log: () => RequestLog,
  exit: WalkExitData,
): boolean {
  const shouldTryNext = exit.shouldTryNext ?? true;
  let next: ResolvedAttempt | undefined;

  if (exit.kind === "dead-stream") {
    // Dead streams gate liveness BEFORE advancing the walk. That preserves the old lazy policy:
    // capped/rejected cells are not recorded after the client side is already dead. The two
    // fronts' liveness spellings intentionally remain different pending a separate unification.
    const canContinue = front === "anthropic"
      ? !res.destroyed
      : !res.writableEnded && !res.destroyed;
    next = shouldTryNext && canContinue
      ? nextUncappedAttempt(h, walk, attemptTrace, tracker)
      : undefined;
  } else {
    // Transport and post-header failures advance BEFORE checking response liveness. Preserve that
    // eager ordering: recordCapped/walk.recordRejected must still fire for skipped capped cells.
    next = shouldTryNext ? nextUncappedAttempt(h, walk, attemptTrace, tracker) : undefined;
    // A response that died mid-walk forces the FINALIZE path even with a next candidate in hand
    // (the pre-refactor shape): walking on for a gone client would spend another upstream request
    // with no recordFinal and no log record at this exit. Unreachable today only because every
    // eager caller pre-guards on res liveness — this keeps the helper safe if one stops.
    if (res.writableEnded || res.destroyed) next = undefined;
  }

  if (next) {
    tracker.recordFailover(status, null);
    return true;
  }

  tracker.recordFinal(status);
  const headers = walkExitHeaders(tracker, sticky, credentialTrace, exit);
  if (front === "anthropic") {
    failClosed(
      res,
      status,
      exit.message,
      Object.keys(headers).length > 0 ? headers : undefined,
      exit.errorType,
    );
  } else if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({
      error: { message: exit.message, type: exit.errorType ?? "api_error" },
    }));
  }
  h.logger.write(log());
  return false;
}

/**
 * The ALL-CAPPED refusal — the loud half of G2.
 *
 * Every walked candidate was refused by an operator-set cap, so the relay answers 429 itself:
 * there is no upstream error to pass through, and staying silent would hang the client. The body
 * names the caps (axis/period, inclusive used/cap, basis `operator-declared`) in each front's
 * NATIVE error shape, so an ordinary client's rate-limit handling just works. `Retry-After` is
 * derived ONLY from the soonest UTC period boundary any walked cap lifts at; when no boundary
 * resolves the header is omitted and the body says so — a duration is never invented. Metadata
 * only: labels, numbers, no message text, no key material.
 */
function respondAllCapped(
  res: ServerResponse,
  h: Handlers,
  ctx: { started: number; path: string; hadTools: boolean; streamed: boolean },
  front: "anthropic" | "openai",
  tracker: Pool429Tracker,
  attempts: readonly RequestAttemptLog[],
): void {
  if (res.headersSent) return;
  const summary = tracker.summary();
  // One rendering, shared by the body and the header: two calls could disagree about the bound.
  const capped = tracker.cappedSummary();
  const labels = capped ?? "every candidate";
  const resetAt = tracker.cappedResetAt();
  // The reset is a DERIVED UTC boundary (minute/day), so it always resolves for any cap this
  // module can declare — but the fail-safe stays: when it somehow does not, the header is omitted
  // and the body says the lift time is unknown rather than inventing a duration.
  const message =
    `llm-relay: request refused by operator-declared hard cap(s): ${labels}. ` +
    `No provider was contacted.` +
    (resetAt !== null
      ? ` The earliest cap lifts at ${new Date(resetAt).toISOString()} (its UTC period boundary).`
      : ` No reset boundary could be derived, so no retry-after is offered.`);
  const headers: Record<string, string> = {};
  if (summary) headers[POOL_ATTEMPTS_HEADER] = summary;
  if (capped !== null) headers[HARD_CAP_HEADER] = capped;
  if (resetAt !== null && resetAt > Date.now()) {
    headers["retry-after"] = String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)));
  }
  const body = front === "openai"
    ? { error: { message, type: "rate_limit_error", code: "llm_relay_capped" } }
    : { type: "error" as const, error: { type: "rate_limit_error", message } };
  res.writeHead(429, { ...headers, "content-type": "application/json" });
  res.end(JSON.stringify(body));
  h.logger.write(baseLog(ctx.started, ctx.path, ctx.hadTools, ctx.streamed, 429, "skipped", null, attempts));
}

/**
 * Promote a pin only inside its live capability segment. In particular, a live degrade-tail pin
 * never jumps a live in-band member; the tail remains a fallback after the requested band.
 */
function applyStickyOrdering(
  ordered: ResolvedAttempt[],
  pinnedSpec: string,
  breaker: CircuitBreaker,
  degraded: Set<string> | null,
  now: number,
  quotaDemotion?: QuotaDemotionFn | null,
  costClassOf?: CostClassFn | null,
): { targets: ResolvedAttempt[]; status: string } {
  const groups = groupCredentialAttempts(ordered);
  const pinnedIndex = groups.findIndex((group) => specOfTarget(group.attempts[0]!.target) === pinnedSpec);
  const pinnedGroup = pinnedIndex < 0 ? undefined : groups[pinnedIndex];
  const pinned = pinnedGroup?.attempts[0];
  if (!pinned || !pinnedGroup) return { targets: ordered, status: "bypassed: not-in-pool" };

  // The first row is the credential selector's best-ranked usable slot for this deployment.
  const usability = targetUsability(pinned, breaker, now, quotaDemotion, costClassOf);
  if (usability !== "live") return { targets: ordered, status: `bypassed: ${usability}` };

  if (degraded?.has(pinnedSpec)) {
    const hasLiveInBand = groups.some(
      (group) => {
        const candidate = group.attempts[0]!;
        return !degraded.has(specOfTarget(candidate.target)) &&
          targetUsability(candidate, breaker, now, quotaDemotion, costClassOf) === "live";
      },
    );
    if (hasLiveInBand) return { targets: ordered, status: "bypassed: degraded" };
  }

  if (pinnedIndex === 0) return { targets: ordered, status: "pinned, natural" };
  // Move the deployment group, not an individual row. CredentialWalk will still offer one slot
  // per deployment round, so the pin cannot cluster every credential ahead of other deployments.
  const reordered = [pinnedGroup, ...groups.filter((_, index) => index !== pinnedIndex)]
    .flatMap((group) => group.attempts);
  return { targets: reordered, status: "pinned, reordered" };
}

function stickyHeaderValue(
  sticky: StickyRequestContext | null | undefined,
  target: ResolvedTarget,
  status: number,
): string | null {
  if (!sticky) return null;
  if (sticky.provenance) return sticky.provenance;
  if (status < 400 && sticky.multiCandidateRoute) return `${specOfTarget(target)} (new)`;
  return null;
}

function stickyProvenanceHeaders(
  sticky: StickyRequestContext | null | undefined,
): Record<string, string> | undefined {
  return sticky?.provenance ? { [STICKY_PROVENANCE_HEADER]: sticky.provenance } : undefined;
}

function recordStickySuccess(
  h: Handlers,
  sticky: StickyRequestContext | null | undefined,
  target: ResolvedTarget,
  status: number,
): void {
  if (status >= 400 || !sticky?.multiCandidateRoute) return;
  h.stickySessions?.setPin(sticky.key, specOfTarget(target));
}

export function orderByUsability(
  attempts: ResolvedAttempt[],
  breaker = globalCircuitBreaker,
  now = Date.now(),
): ResolvedAttempt[] {
  const { ordered } = orderByUsabilityTracked(attempts, breaker, now);
  return ordered;
}

/**
 * Gap 12's walk-order orderer. Kept pure: its exported shape must not change, and the
 * quota-demotion ANNOUNCEMENT lives in exactly one place —
 * `orderDeploymentGroupsByUsability` above — because two copies of the displacement check
 * would drift silently (the first version of this block was unreachable here).
 *
 * Within the COOLING band, order by soonest known lift time (ascending). Unknown lifts sort last.
 * Stable within ties and unknowns.
 */
function orderByUsabilityTracked(
  attempts: ResolvedAttempt[],
  breaker: CircuitBreaker,
  now: number,
  quotaDemotion?: QuotaDemotionFn | null,
  costClassOf?: CostClassFn | null,
): { ordered: ResolvedAttempt[]; quotaDemotedFirst: string | null } {
  const live: ResolvedAttempt[] = [];
  const faulted: ResolvedAttempt[] = [];
  const cooling: ResolvedAttempt[] = [];
  for (const attempt of attempts) {
    // A learned allowance exhaustion cools a target the breaker may know nothing about. That is
    // the whole point of the ACCOUNT scope: one member's stated "you have depleted your monthly
    // included credits" is a fact about the credential, so its siblings are spent too and should
    // step aside without each first spending a round-trip to be told so individually. Measured
    // here: `pool/xhigh`'s 15 members share only four independent quota domains, so the walk was
    // rediscovering four facts fifteen times.
    //
    // Demotion, never exclusion — same contract as the rest of this function, and doubly so here:
    // an exhausted allowance is a temporary condition on a deployment that is still free, and a
    // pool with nothing else left must still be able to try it.
    const usability = targetUsability(attempt, breaker, now, quotaDemotion, costClassOf);
    if (usability === "cooling") cooling.push(attempt);
    else if (usability === "credential-fault") faulted.push(attempt);
    else live.push(attempt);
  }

  // Sort cooling band by soonest lift time (ascending). Unknown (null) sorts last.
  // Stable sort preserves original order for ties and unknowns.
  cooling.sort((a, b) => {
    const liftA = coolingLiftTime(a, breaker, now, costClassOf);
    const liftB = coolingLiftTime(b, breaker, now, costClassOf);
    if (liftA === null && liftB === null) return 0;
    if (liftA === null) return 1;
    if (liftB === null) return -1;
    return liftA - liftB;
  });

  return { ordered: [...live, ...faulted, ...cooling], quotaDemotedFirst: null };
}

/**
 * What one backend status means for failover and for the breaker. THE single policy — both the
 * Anthropic path and the OpenAI front read it, because the bug this exists to prevent is exactly
 * the two of them disagreeing.
 *
 *   ok         — serve it; the target is proven healthy.
 *   retriable  — the deployment could not serve this request (429/5xx, a 400/404 that here is
 *                nearly always "this model won't take this shape", a 402 — on the free/router
 *                providers this proxy fronts, "payment required" means depleted monthly credits,
 *                i.e. a 429 with a monthly window — or a 410: the deployment is GONE, which is a
 *                fact about one member, never about the request, so a sibling can still serve it.
 *                NVIDIA retired models with real 410 End-of-Life responses on 2026-08-07; before
 *                410 joined this class those returned straight to the client with a healthy pool
 *                standing by. Breaker failure, try the next.
 *   credential — 401/403. Try the next candidate, but tell the breaker's HEALTH side nothing:
 *                see `recordCredentialFault`.
 *   client     — a genuine client-side 4xx (413, 422, …). The next candidate would reject it
 *                identically, so failing over would just multiply one bad request by 14.
 */
export type OutcomeClass = "ok" | "retriable" | "credential" | "client";

export function classifyStatus(status: number): OutcomeClass {
  if (status < 400) return "ok";
  if (status === 401 || status === 403) return "credential";
  if (status === 400 || status === 402 || status === 404 || status === 410 || status === 429 || status >= 500) return "retriable";
  return "client";
}

/** Whether another pool candidate is useful; health mutation occurs only at terminal completion. */
function shouldTryNext(cls: OutcomeClass): boolean {
  return cls === "retriable" || cls === "credential";
}

/**
 * Wall-clock ceiling on STARTING further failover attempts — one policy, both fronts, same maxim
 * as `classifyStatus`. A deep pool could legitimately spend members × timeoutMs on one request;
 * the budget bounds the walk, never the answer: an attempt already in flight is not aborted, and
 * the first TWO attempts are always allowed, so a slow-failing first candidate cannot starve the
 * request of its one retry. 0 disables. Default fork-validated in freellmapi (45s) — adoption
 * review §1.5.
 */
export const DEFAULT_WALK_BUDGET_MS = 45_000;

/**
 * Streamed-response deadline split (adoption review §1.2) — one policy, both fronts.
 *
 * One flat `timeoutMs` spanning the whole attempt mis-serves streams in both directions: a
 * healthy long generation still emitting bytes at the deadline is killed mid-answer, while a
 * genuinely dead stream is not detected until the same deadline. So once a stream is chosen for
 * serving, the total deadline DISARMS and an inter-byte watchdog takes over: every arriving
 * chunk re-arms it, and only silence for the full window aborts — through the same controller,
 * so the existing mid-stream error path reports it honestly. Default fork-validated in
 * freellmapi (90s); `stallTimeoutMs: 0` keeps the old single-deadline behavior.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 90_000;

function withStallWatchdog(upstream: Response, controller: AbortController, stallMs: number): Response {
  if (!upstream.body) return upstream;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), stallMs);
  };
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const watchdog = new TransformStream<Uint8Array, Uint8Array>({
    start: arm,
    transform(chunk, ctrl) {
      arm();
      ctrl.enqueue(chunk);
    },
    flush: disarm,
  });
  return new Response(upstream.body.pipeThrough(watchdog), {
    status: upstream.status,
    headers: upstream.headers,
  });
}

/**
 * How many capped cells `x-llm-relay-capped` may NAME before the rest are counted (`+K more`).
 *
 * The header is diagnostic, not a manifest: five lines is enough to see which credentials and
 * which axis stopped the request, and it keeps a fully capped 30-member dynamic pool from
 * emitting a ~1.2 KB header — a capped attempt costs no walk budget, so every member reaches it.
 */
const MAX_CAPPED_HEADER_CELLS = 5;

/**
 * All-429 exhaustion policy — one policy, both fronts (same maxim as `classifyStatus`).
 *
 * When the whole pool is rate-limited, the client is served the LAST candidate's real 429, but
 * that candidate's Retry-After may be the pool's worst: the earliest reset among the walked 429s
 * is when the POOL next has capacity. Only an all-429 walk qualifies — a mixed walk says nothing
 * about when the pool frees up, so any non-429 failure leaves the final header untouched.
 */
class Pool429Tracker {
  private minRetryAfterMs: number | null = null;
  private only429 = true;
  /** status → how many candidates answered it. Ordering lives in `firstSeenAt`. */
  private readonly counts = new Map<number | "dead-turn", number>();
  /**
   * Outcome kind → the walk position it was FIRST seen at, so the breakdown reads in WALK order.
   *
   * ⚠ Positions are stamped, not appended, because the two kinds of outcome arrive out of order:
   * a cap is recorded while the walk is being asked for the next candidate — i.e. BEFORE the
   * candidate already in flight has been counted. Appending made a walk that went `A:429 →
   * B:capped` render `1xcapped, 1x429`, reversing what actually happened. See `stampCapped`.
   */
  private readonly firstSeenAt = new Map<number | "dead-turn" | "capped", number>();
  /** Monotonic walk position handed out by `stamp()`; never a candidate count. */
  private order = 0;
  /** True while a candidate has been offered and its provider outcome has not been counted yet. */
  private inFlight = false;
  /** Caps observed while a candidate was in flight: they follow that candidate's own outcome. */
  private deferredCapped = false;
  /** G2: candidates skipped before egress because an operator-set hard cap was reached. */
  private readonly cappedLabels: string[] = [];
  /** Soonest UTC boundary any walked cap lifts at — the pool's own next capacity instant. */
  private soonestCapResetAt: number | null = null;
  /** Set at the ONE true egress boundary (`onEgress`), so "no provider was contacted" stays provable. */
  private egressed = false;

  /** Called exactly where a backend request is about to start — see `onEgress` on both fronts. */
  noteEgress(): void {
    this.egressed = true;
  }

  /**
   * A candidate was OFFERED to the loop (it passed the cap gate and will be attempted). Nothing
   * is tallied here — this only marks that an outcome for it is still to come, which is what
   * lets a cap seen in the meantime be stamped AFTER it.
   */
  noteOffered(): void {
    this.inFlight = true;
  }

  private stamp(key: number | "dead-turn" | "capped"): void {
    if (!this.firstSeenAt.has(key)) this.firstSeenAt.set(key, ++this.order);
  }

  /** Place the deferred `capped` term once the in-flight candidate's own outcome is counted. */
  private stampCapped(): void {
    if (!this.deferredCapped) return;
    this.deferredCapped = false;
    this.stamp("capped");
  }

  /** Record a response being failed over past. */
  recordFailover(status: number, retryAfterMs: number | null): void {
    this.count(status);
    if (status === 429) {
      if (retryAfterMs !== null) {
        this.minRetryAfterMs = this.minRetryAfterMs === null ? retryAfterMs : Math.min(this.minRetryAfterMs, retryAfterMs);
      }
    } else {
      this.only429 = false;
    }
  }

  /** Record the response actually served — the walk's last candidate, success or failure. */
  recordFinal(status: number): void {
    this.count(status);
  }

  /**
   * Record a candidate skipped BEFORE egress by an operator-set hard cap (G2).
   *
   * Deliberately NOT folded into `recordFailover`: a cap is not a provider answer, so it must
   * neither trip the breaker nor set `only429 = false` — when every candidate is capped, that
   * flag's meaning ("nothing else went wrong") is exactly what licenses the synthesized refusal.
   */
  recordCapped(label: string, resetsAt: number): void {
    // One tally entry per OUTCOME KIND, matching how statuses count: two distinct capped cells
    // are still one `Nxcapped` term in the breakdown. Its POSITION waits for the candidate
    // already in flight, whose outcome the loop has not counted yet.
    if (this.inFlight) this.deferredCapped = true;
    else this.stamp("capped");
    this.cappedLabels.push(label);
    this.soonestCapResetAt =
      this.soonestCapResetAt === null ? resetsAt : Math.min(this.soonestCapResetAt, resetsAt);
  }

  /** The soonest cap boundary across the walk, for the all-capped Retry-After; null otherwise. */
  cappedResetAt(): number | null {
    return this.soonestCapResetAt;
  }

  /**
   * True when this walk offered at least one candidate and EVERY one of them was refused by an
   * operator-set hard cap before egress — no provider answered anything at all. That is the exact
   * license for the relay-synthesized 429: any real provider outcome among the failures means the
   * last real upstream error is the more honest body, and the caps ride beside it in the
   * pool-attempts tally instead.
   */
  allCapped(): boolean {
    return this.cappedLabels.length > 0 && this.counts.size === 0 && !this.egressed;
  }

  /**
   * `"a/nim/m requests/day 450/450"` lines, in walk order — metadata only, and BOUNDED.
   *
   * A capped attempt consumes no walk start budget (`credential-select.ts` gates that on
   * `#started`), so every member of a fully capped 30-member dynamic pool reaches this list and
   * an unbounded join is a ~1.2 KB header. At most `MAX_CAPPED_HEADER_CELLS` cells are named and
   * the remainder is counted — the client learns the shape of the refusal without the response
   * carrying the whole roster.
   */
  cappedSummary(): string | null {
    if (this.cappedLabels.length === 0) return null;
    if (this.cappedLabels.length <= MAX_CAPPED_HEADER_CELLS) return this.cappedLabels.join("; ");
    const shown = this.cappedLabels.slice(0, MAX_CAPPED_HEADER_CELLS).join("; ");
    return `${shown}; +${this.cappedLabels.length - MAX_CAPPED_HEADER_CELLS} more`;
  }

  /** A backend answered 200, but its malformed tool call remained unusable after repair. */
  recordDeadTurn(): void {
    this.only429 = false;
    this.count("dead-turn");
  }

  /** A refusal in this walk whose meaning the relay could not look up. */
  private unknownRefusals = 0;
  noteUnknownRefusal(): void {
    this.unknownRefusals += 1;
  }

  /** How many, or null when every refusal was understood. */
  unknownCount(): number | null {
    return this.unknownRefusals > 0 ? this.unknownRefusals : null;
  }

  private count(status: number | "dead-turn"): void {
    this.counts.set(status, (this.counts.get(status) ?? 0) + 1);
    this.stamp(status);
    // This candidate's outcome is in; anything capped while it was in flight comes next.
    this.inFlight = false;
    this.stampCapped();
  }

  /**
   * The walk, as one line: `"13 tried, 0 served: 4x402, 5x429, 3x403, 1x400"`.
   *
   * ⚠ ASCII only. This is an HTTP header value, and Node latin1-encodes those — a `×` reaches a
   * UTF-8 client as mojibake. Caught on a live pool, where the header read `6�402`.
   *
   * A pool's error is one member's error, and that is genuinely misleading when the other twelve
   * failed for three other reasons: the client is handed HuggingFace's 402 and told to go buy
   * credits, when the correct action is "use another pool". The BODY still carries that member's
   * real upstream error — a true upstream error beats a synthesized one, the same maxim the
   * context guardrail and the all-429 policy follow — so the aggregate rides alongside it in a
   * header and in the log, where it costs the client nothing and answers "what actually happened"
   * without a round of manual probing.
   *
   * G2 caps appear in the breakdown as `Nxcapped`, in walk order beside the provider outcomes:
   * they ARE candidates this request consumed, even though no provider saw them.
   *
   * Null for a single-candidate walk: there is no aggregate to report, and emitting one would
   * dress up an ordinary passthrough error as a pool exhaustion.
   */
  summary(): string | null {
    let tried = 0;
    let served = 0;
    for (const [status, n] of this.counts) {
      tried += n;
      if (typeof status === "number" && status < 400) served += n;
    }
    tried += this.cappedLabels.length;
    if (tried < 2) return null;
    // A walk that ended while a candidate was still in flight never counted its outcome, so a cap
    // deferred behind it would otherwise be dropped from the breakdown entirely.
    this.stampCapped();
    const parts = [...this.firstSeenAt.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([key]) => (key === "capped" ? `${this.cappedLabels.length}xcapped` : `${this.counts.get(key) ?? 0}x${key}`));
    return `${tried} tried, ${served} served: ${parts.join(", ")}`;
  }

  /** Retry-After (ms) to serve on the FINAL response, or undefined to leave its real header alone. */
  overrideMs(finalStatus: number, finalRetryAfterMs: number | null): number | undefined {
    if (finalStatus !== 429 || !this.only429 || this.minRetryAfterMs === null) return undefined;
    return Math.min(this.minRetryAfterMs, finalRetryAfterMs ?? Infinity);
  }
}

/**
 * Feed the proxy's own request outcome into runtime telemetry — the "observed traffic"
 * evidence consumed by `deploymentFitness()` on the operational axis (after capability
 * eligibility is decided by `getStrength()`) and reported under `observed` in `/candidates`.
 * `getStrength()` ranks capability using ONLY the synced capability snapshot (basis
 * "snapshot" → neutral 50); it does not consume runtime telemetry. Only targets with a
 * concrete model id are recorded; the Anthropic passthrough has none. Skipped under vitest
 * so tests never write the user's real telemetry file.
 */
function recordCall(h: Handlers, attempt: HealthAttempt, ok: boolean, completedAt: number): void {
  const { target, usage } = attempt;
  // Keep the historical default writer out of the test filesystem, but never suppress an
  // explicit recorder: that seam is how ledger callers observe every terminal attempt.
  if (!target.model || !h.modelCallRecorder) return;
  try {
    h.modelCallRecorder(target.provider, target.model, {
      ok,
      latencyMs: completedAt - attempt.started,
      ...(usage.completionTokens !== undefined ? { completionTokens: usage.completionTokens } : {}),
    });
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
   * Earliest reset (ms) among the 429s this request failed over past, set only when the
   * response being served is itself a 429 and every skipped response was one too. Overrides
   * the served Retry-After: the last candidate's figure is one deployment's answer, but the
   * earliest reset is when the POOL next has capacity — the honest number for a client backoff.
   */
  retryAfterOverrideMs?: number | undefined;
  /**
   * The whole walk in one line — see `Pool429Tracker.summary()`. Null when only one candidate was
   * tried, because then the response IS the walk and an aggregate would add nothing.
   */
  poolSummary?: string | null;
  /** Unrecognized refusals among the candidates stepped over. See the caveat at the emit site. */
  poolUnknownRefusals?: number | null;
  /**
   * Every deployment this walk addressed, in order. `SERVED_BY_HEADER` names the winner below
   * 400 and this list at or above it, which is what makes an exhausted pool self-describing.
   */
  tried?: readonly string[];
  /** Credential diagnostics are slot identities only; values never leave the process. */
  credentialHeaders?: Record<string, string>;
  /** Set when the answering deployment came from the pool's degrade tail. See `degradedLabel`. */
  degraded?: string | null;
  /**
   * Set when the walk's ranked first choice was quota-demoted and a later candidate led instead.
   * Computed once by `orderDeploymentGroupsByUsability`, beside the order it explains.
   */
  quotaDemoted?: string | null;
  /** Set when the answering deployment is not free. See `PAID_HEADER`. */
  paid?: string | null;
  /** Request-local sticky key and the previously stored pin's evaluation. */
  sticky?: StickyRequestContext | null;
  /**
   * The target this response actually came from — the resolved (provider, model)
   * after tier/pool expansion, subagent redirection and failover. Every log record
   * and the reshaper's `backendModel` read it, so a repair attributes the malformed
   * call to the deployment that produced it rather than to whatever id the client
   * happened to send.
   */
  target: ResolvedTarget;
  attempt: HealthAttempt;
  signal: AbortSignal;
  /** Actual client response lifetime, kept separate from provider deadlines. */
  callerSignal: AbortSignal;
  /** Original adapter response retaining private raw-upstream provenance across stream wrappers. */
  reportedModelSource: Response;
}

/** Request-scoped, bounded attempt metadata shared by both public fronts. */
class RequestAttemptTrace {
  private readonly entries: RequestAttemptLog[] = [];

  record(target: ResolvedTarget, status: RequestAttemptStatus, started: number, completedAt: number): void {
    if (this.entries.length >= MAX_LOG_ATTEMPTS) return;
    this.entries.push({
      provider: target.provider,
      model: target.model ?? null,
      status,
      ms: Math.max(0, completedAt - started),
    });
  }

  /** G2: an operator-set hard cap refused this candidate BEFORE any provider egress. */
  recordCapped(target: ResolvedTarget, at: number): void {
    this.record(target, "capped", at, at);
  }

  snapshot(): RequestAttemptLog[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

interface HealthAttempt {
  readonly handle: AttemptHandle;
  readonly identity: ProviderTargetIdentity;
  /** The immutable credential snapshot used for this exact provider attempt. */
  readonly resolvedAttempt: ResolvedAttempt;
  readonly target: ResolvedTarget;
  readonly started: number;
  readonly trace: RequestAttemptTrace;
  readonly usage: UsageAccumulator;
  readonly accounting: RequestAccountingState | null;
  accountingAttempt: AccountingAttempt | null;
  completed: boolean;
  terminal?: "succeeded" | "failed" | "cancelled";
}

function targetIdentity(attempt: ResolvedAttempt): ProviderTargetIdentity {
  const { target } = attempt;
  return Object.freeze({
    provider: target.provider,
    model: target.model ?? null,
    kind: target.kind,
    credentialId: attempt.credentialId,
    base: target.base,
  });
}

function beginHealthAttempt(
  h: Handlers,
  resolvedAttempt: ResolvedAttempt,
  started: number,
  trace: RequestAttemptTrace,
  usage: UsageAccumulator,
  accounting: RequestAccountingState | null,
): HealthAttempt | null {
  const identity = targetIdentity(resolvedAttempt);
  const begun = h.breaker.beginAttempt(identity);
  if (!begun.ok) return null;
  return {
    handle: begun.value,
    identity,
    resolvedAttempt,
    target: resolvedAttempt.target,
    started,
    trace,
    usage,
    accounting,
    accountingAttempt: null,
    completed: false,
  };
}

/**
 * The candidate loops' client-gone reaction, shared by both fronts: when the client connection
 * closes before the response is finished, abort the caller-facing work and the in-flight backend
 * fetch together. One definition, so the two loops cannot drift.
 */
function abortOnClientClose(
  res: ServerResponse,
  callerController: AbortController,
  controller: AbortController,
): () => void {
  return () => {
    if (!res.writableEnded) {
      callerController.abort();
      controller.abort();
    }
  };
}

/**
 * Learn a deployment's real context ceiling from an error it just returned.
 *
 * ⚠ Called from BOTH request paths, right beside `observeAttemptHeaders`, and for the same reason
 * that helper is shared: this repo has already shipped one defect where the OpenAI front had no
 * copy of a policy the Anthropic path enforced ("two paths, two policies, one of them empty" — see
 * docs/pool-failover.md). A learning loop that only ran on one front would silently know less
 * about half the traffic.
 *
 * Called only with bytes already buffered by inspectCandidateResponse, so learning never tees or
 * consumes the Response that may still need to become the client's terminal real error.
 */
function observeContextLimit(status: number, target: ResolvedTarget, body: string): void {
  // Context-length rejections are 400 (OpenAI-compatible) or 413. Anything else is a different
  // fault, and scanning every error body would be work for nothing.
  if (status !== 400 && status !== 413) return;
  if (target.model === undefined) return;
  try {
    if (!looksLikeContextLengthError(body)) return;
    const stated = parseStatedContextLimit(body);
    if (stated === null) return;
    recordObservedContextLimit(target.provider, target.model, stated);
  } catch {
    // Learning is best-effort and never in the request's way.
  }
}

/**
 * Learn a deployment's stated OUTPUT-token ceiling (`max_tokens`) from an error it just returned.
 *
 * ⚠ Called from BOTH request paths beside `observeContextLimit`, for the same reason that helper
 * documents: a learning loop wired into only one front would silently know nothing about half the
 * traffic (docs/pool-failover.md). Called with bytes already buffered by
 * `inspectCandidateResponse`, so it never tees or consumes the Response that may still become the
 * client's terminal real error.
 *
 * Display-only by owner decision (docs/max-output-caps-design-2026-08-29.md): the fact renders in
 * `llm-relay candidates`; nothing clamps, refuses, or routes on it.
 */
function observeMaxOutput(status: number, target: ResolvedTarget, body: string): void {
  // A max_tokens rejection is a request-validation 400 (or a 413 variant); same gate as the
  // context observer beside it.
  if (status !== 400 && status !== 413) return;
  if (target.model === undefined) return;
  try {
    if (!looksLikeMaxOutputError(body)) return;
    const stated = parseStatedMaxOutput(body);
    if (stated === null) return;
    recordObservedMaxOutput(target.provider, target.model, stated);
  } catch {
    // Learning is best-effort and never in the request's way.
  }
}

/**
 * Record the durable half of provider-stated quota observations as learned rate-limit facts.
 *
 * A header pair like `x-ratelimit-limit-requests-day: 1000` is the deployment stating its own
 * ceiling — first-party evidence, same standing as an error body that says it. The observation
 * already had to be explicitly attributed (axis AND period named in the header, limit AND
 * remaining in one bucket), so nothing here guesses.
 *
 * ⚠ minute/day only. `quota-observation.ts` also recognizes month and unknown periods; there is no
 * measurement kind for either (a monthly ceiling is allowance territory, not rate), so they are
 * skipped rather than forced into a kind that would misstate them.
 */
function observeStatedRateLimits(attempt: HealthAttempt, observations: QuotaObservation[]): void {
  if (observations.length === 0) return;
  const { target } = attempt;
  if (target.model === undefined) return;
  try {
    for (const o of observations) {
      if (!Number.isFinite(o.limit) || o.limit <= 0) continue;
      // Month/unknown have no fact kind on purpose (see above); only minute/day are measurements.
      if (o.period !== "minute" && o.period !== "day") continue;
      recordObservedRateLimit(target.provider, attempt.resolvedAttempt.credentialId, target.model, [
        { axis: o.axis, period: o.period, limit: Math.floor(o.limit) },
      ]);
    }
  } catch {
    // Learning is best-effort and never in the request's way — observeAttemptHeaders itself may
    // throw when the breaker rejects an observation, but this must not.
  }
}

/**
 * Learn a deployment's stated rate limits from an error body it just returned.
 *
 * ⚠ Called from BOTH request paths beside `observeContextLimit`, for the same reason that helper
 * documents: this repo has already shipped one defect where the OpenAI front had no copy of a
 * policy the Anthropic path enforced ("two paths, two policies, one of them empty" — see
 * docs/pool-failover.md). A learning loop that only ran on one front would silently know less
 * about half the traffic. Called with bytes already buffered by `inspectCandidateResponse`, so it
 * never tees or consumes the Response that may still become the client's terminal real error.
 *
 * ⚠ 429 only. A 402 (credits) or 403 (gating) is a different fact about a DIFFERENT axis, already
 * handled by the eligibility/refusal machinery; scanning those bodies for rate wording risks
 * recording a ceiling from prose that merely mentions one. Conservative default; revisit only with
 * evidence of a real provider stating its limit on a non-429.
 */
function observeRateLimit(attempt: ResolvedAttempt, status: number, body: string): void {
  if (status !== 429) return;
  if (attempt.target.model === undefined) return;
  try {
    if (!looksLikeRateLimitError(body)) return;
    const stated = parseStatedRateLimit(body);
    if (stated === null) return;
    recordObservedRateLimit(attempt.target.provider, attempt.credentialId, attempt.target.model, stated);
  } catch {
    // Learning is best-effort and never in the request's way.
  }
}

/**
 * Learn what a refusal proved about a deployment — or, when nothing confirmed covers it, learn
 * NOTHING and queue the message for offline research.
 *
 * ⚠ Called from BOTH request paths beside `observeContextLimit`, for the reason that helper
 * documents: a learning loop running on one front knows nothing about half the traffic, which is
 * the exact shape of the pool-failover incident (docs/pool-failover.md).
 *
 * ⚠ The request path does not INTERPRET anything. `interpretRefusal` is a deterministic lookup
 * against confirmed entries and reviewed seeds; a miss records the signature and stops. Judgement
 * about an unrecognized message happens out of band — see `refusal-interpretation.ts` — because
 * an LLM's opinion must never decide a live routing decision.
 *
 * ⚠ Takes a body STRING, never a `Response`, and is called only where that body was going to be
 * read or discarded anyway. The obvious implementation — `res.clone()` — breaks failover:
 * `clone()` TEES the body, and the failover branch immediately
 * cancels the original, so the un-read tee branch strands the walk and the client is served the
 * first candidate's error with the rest of the pool untouched. Caught by
 * `test/pool-failover.test.ts` (three pre-existing 402 tests went red), which is the whole reason
 * those tests insist on ≥2 candidates.
 *
 * Never throws: the worst outcome of a failure here is that nothing is learned this time.
 */
type EligibilityObservation = { readonly unknown: boolean; readonly scope?: ReturnType<typeof materializeScope> };

/**
 * Relay protocol adapters sometimes wrap a provider's JSON refusal inside their own error
 * message. Interpret the original nested payload as well as the outer wire body so a confirmed
 * signature means the same thing on every front. This is deterministic unwrapping only: no text
 * is classified or inferred here.
 */
function refusalBodyCandidates(body: string): string[] {
  const candidates: string[] = [];
  const queued: string[] = [body];
  const seen = new Set<string>();
  while (queued.length > 0 && candidates.length < 24) {
    const text = queued.shift()!;
    if (!text || seen.has(text)) continue;
    seen.add(text);
    candidates.push(text);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      for (let index = 0; index < text.length; index++) {
        if (text[index] !== "{" && text[index] !== "[") continue;
        const nested = text.slice(index);
        try {
          JSON.parse(nested);
          queued.push(nested);
          break;
        } catch {
          // Keep looking for the start of a nested JSON payload.
        }
      }
      continue;
    }

    const visit = (value: unknown, depth: number): void => {
      if (depth > 6 || candidates.length + queued.length >= 24) return;
      if (typeof value === "string") {
        if (!seen.has(value)) queued.push(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      if (typeof value === "object" && value !== null) {
        for (const item of Object.values(value as Record<string, unknown>)) {
          visit(item, depth + 1);
        }
      }
    };
    visit(parsed, 0);
  }
  return candidates;
}

function observeEligibility(attempt: ResolvedAttempt, status: number, retryAfterMs: number | null, body: string): EligibilityObservation {
  const { target } = attempt;
  if (target.model === undefined) return { unknown: false };
  try {
    let matchedBody = body;
    let verdict: ReturnType<typeof interpretRefusal> = null;
    for (const candidate of refusalBodyCandidates(body)) {
      verdict = interpretRefusal(target.provider, target.model, status, candidate);
      if (verdict !== null) {
        matchedBody = candidate;
        break;
      }
    }
    if (verdict === null) {
      // The fail-safe: an unrecognized refusal changes nothing about routing. It is held so a
      // researcher can say what it means, and only then will it ever bind.
      recordUnknownRefusal(target.provider, target.model, status, body);
      return { unknown: true };
    }
    // The verdict's scope TEMPLATE becomes a concrete scope here, using this request's provider
    // and model. A provider-scoped verdict therefore covers every deployment behind that
    // credential from one observation — which is the whole point: a stated credit balance or a
    // rejected key is one fact, and rediscovering it once per model is pure waste.
    const scope = materializeScope(
      verdict.scope,
      target.provider,
      attempt.credentialId,
      target.model,
    );
    const reset = resolveReset(verdict, retryAfterMs, matchedBody);
    recordFact(verdict.class, scope, {
      retryAfterMs: reset?.ms ?? null,
      ...(reset === null ? {} : { untilBasis: reset.basis }),
      // The verdict's cost filter travels with it. Without this the reviewer's "paid deployments
      // only" would be accepted, displayed, and then silently dropped on the way to the store —
      // the verdict would demote everything the scope covers, which is the defect it was written
      // to prevent.
      ...(verdict.costClasses === undefined ? {} : { costClasses: verdict.costClasses }),
    });
    return { unknown: false, scope };
  } catch {
    /* learning is best-effort and never in the request's way */
  }
  return { unknown: false };
}

/**
 * Does the free-only guard bind this request?
 *
 *   explicit `true`  → always. The owner's standing "this lane never spends money", which a
 *                      per-call `@relay:` directive and a dispatch cliLane must not outrank.
 *   explicit `false` → never. Spending was opted into deliberately.
 *   UNSET            → defaults ON for offload-rerouted traffic, OFF for a directly addressed pool.
 *
 * ⚠ That asymmetry is the whole point, and it is why `loadConfig` keeps "unset" distinguishable
 * from "false". Offload exists to spend somebody else's free capacity instead of your
 * subscription, so an install that has never thought about cost must not discover the feature by
 * being billed for it — the default belongs there. But a request that *names* `pool/<name>` is an
 * explicit routing choice by someone who knows what a pool is, and silently gating all of it on a
 * flag they never set would turn every unpriced deployment into a 503 for a decision they did not
 * make. Defaulting both the same way was tried: it failed 29 tests, all of them pool traffic that
 * had nothing to do with offload, which is exactly the surprise a user would have hit.
 */
function freeOnlyApplies(rule: { freeOnly?: boolean }, rerouted: boolean): boolean {
  return rule.freeOnly ?? rerouted;
}

/**
 * When the condition this refusal describes clears, best evidence first.
 *
 *   1. `Retry-After` — the header, stated by THIS response.
 *   2. A reviewed `field` rule — also read from THIS response, just from a place only a reviewer
 *      knew to look (Google's `retryDelay`, which no header carries).
 *   3. The generic body parse — the same class of evidence, found without being told where.
 *   4. A reviewed `fixed` window — a reviewer's knowledge of the provider, not a measurement of
 *      this response, so it ranks below everything the response actually said.
 *   5. null ⇒ the fact kind's default TTL.
 *
 * ⚠ The ordering is the point. A reviewer may know MORE than the response (that a daily quota
 * resets in hours when the body says nothing), but never more than the response about itself — so
 * an assertion can fill a gap and can never overrule a statement.
 *
 * Returns the value AND which rung produced it, so `recordFact` can persist the provenance
 * (`untilBasis`) beside the expiry rather than the availability producer having to re-derive it
 * from vendor prose in a read path.
 */
function resolveReset(
  interpretation: Interpretation,
  headerMs: number | null,
  body: string,
): { ms: number; basis: FactResetBasis } | null {
  if (headerMs !== null) return { ms: headerMs, basis: "retry-after" };
  if (interpretation.reset?.kind === "field") {
    const fromField = applyResetRule(interpretation.reset, body);
    if (fromField !== null) return { ms: fromField, basis: "reviewed-field" };
  }
  const generic = parseStatedResetMs(body);
  if (generic !== null) return { ms: generic, basis: "stated-body" };
  if (interpretation.reset?.kind === "fixed") {
    const fixed = applyResetRule(interpretation.reset, body);
    if (fixed !== null) return { ms: fixed, basis: "reviewed-fixed" };
  }
  return null;
}

/**
 * Statuses whose body can carry a durable fact.
 *
 * 429 is included, but narrowly: an ordinary rate limit stays the breaker's business and produces
 * no fact, because only the small set of messages that NAME an account-level limit matches a seed.
 * Reading the body costs nothing here — it is already being discarded — and the alternative was
 * never learning the one 429 that is worth learning.
 */
function carriesEligibilityFact(status: number): boolean {
  return (
    status === 400 ||
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 410 ||
    status === 429
  );
}

type InspectedCandidateResponse =
  | {
      kind: "response";
      response: Response;
      eligibility: EligibilityObservation;
    }
  | PostHeaderBodyFailure;

/**
 * Inspect an error response once and rebuild it from the same bytes. The caller may either discard
 * the rebuilt response when CredentialWalk offers another candidate or serve it as the terminal
 * real upstream error. A body failure after headers is returned as a distinct protocol outcome;
 * it must never be rebuilt as an empty response under the provider's original credential status.
 */
async function inspectCandidateResponse(
  res: Response,
  attempt: ResolvedAttempt,
  retryAfterMs: number | null,
): Promise<InspectedCandidateResponse> {
  const propagatedFailure = postHeaderBodyFailure(res);
  if (propagatedFailure) return propagatedFailure;
  const status = res.status;
  if (status < 400) {
    return { kind: "response", response: res, eligibility: { unknown: false } };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (cause) {
    return { kind: "post-header-body-failure", cause };
  }
  const body = bytes.toString("utf8");
  observeContextLimit(status, attempt.target, body);
  observeMaxOutput(status, attempt.target, body);
  observeRateLimit(attempt, status, body);
  const eligibility = carriesEligibilityFact(status) && body
    ? observeEligibility(attempt, status, retryAfterMs, body)
    : { unknown: false };
  return {
    kind: "response",
    response: new Response(bytes, {
      status,
      statusText: res.statusText,
      headers: res.headers,
    }),
    eligibility,
  };
}

function walkOutcomeForResponse(
  status: number,
  localFailure: boolean,
  scope?: EligibilityObservation["scope"],
): CredentialWalkOutcome {
  if (localFailure) return { kind: "local", status, ...(scope ? { scope } : {}) };
  const cls = classifyStatus(status);
  if (cls === "client") return { kind: "client", status, ...(scope ? { scope } : {}) };
  if (status === 401 || status === 403 || status === 402 || status === 429) {
    return { kind: "credential", status, ...(scope ? { scope } : {}) };
  }
  return { kind: "deployment", status, ...(scope ? { scope } : {}) };
}

function observeAttemptHeaders(
  h: Handlers,
  attempt: HealthAttempt,
  status: number,
  retryAfterMs: number | null,
  headers?: Headers,
): void {
  const observedAt = Date.now();
  // Provider-stated quota from the response that just served real traffic. Keep every attributed
  // axis/period pair: reducing it to one scalar can conflate requests/day with tokens/minute.
  const quotaObservations = headers
    ? extractQuotaObservations(headers, { observedAt })
    : [];
  // The `limit` half of a provider-stated quota observation is DURABLE — it is what the deployment
  // says it allows — so it is also recorded as a learned rate-limit fact (spec §4 Rung 1: header
  // observations are not their own rung; the limit IS the rung-1 measurement). `remaining` and
  // `resetsAt` stay volatile here with the breaker.
  observeStatedRateLimits(attempt, quotaObservations);
  const result = h.breaker.observeHeaders(attempt.handle, {
    target: attempt.identity,
    status,
    observedAt,
    elapsedMs: observedAt - attempt.started,
    ...(quotaObservations.length > 0 ? { quotaObservations } : {}),
    ...(retryAfterMs !== null ? { retryAfterMs } : {}),
  });
  if (!result.ok) throw new Error(`attempt header observation rejected: ${result.error.kind}`);
}

function accountingFailureForAttempt(options: {
  readonly failure: AttemptFailed["failure"];
  readonly provenance: OutcomeProvenance;
  readonly status: number | null;
}): ProxyAccountingFailureKind {
  if (options.status === 401 || options.status === 403) return "auth_error";
  if (options.status === 429) return "rate_limit";
  if (options.failure === "protocol" || options.failure === "mapping") return "protocol";
  if (options.failure === "transport" && options.provenance === "deadline") return "timeout";
  return "provider_error";
}

function markAttemptCommitted(attempt: HealthAttempt): void {
  attempt.accounting?.markCommitted(attempt.accountingAttempt, Date.now());
}

function completeAttemptSuccess(h: Handlers, attempt: HealthAttempt, status: number): void {
  if (attempt.completed) return;
  const completedAt = Date.now();
  const result = h.breaker.completeAttempt(attempt.handle, {
    terminal: "succeeded",
    target: attempt.identity,
    provenance: "upstream",
    completedAt,
    elapsedMs: completedAt - attempt.started,
    status,
  });
  if (!result.ok) throw new Error(`attempt completion rejected: ${result.error.kind}`);
  attempt.completed = true;
  attempt.terminal = "succeeded";
  attempt.trace.record(attempt.target, status, attempt.started, completedAt);
  recordCall(h, attempt, true, completedAt);
  attempt.accounting?.complete(attempt.accountingAttempt, "success", null, attempt.usage, completedAt);
  // A served request is first-party proof that this deployment exists and that the credential has
  // allowance RIGHT NOW — strictly better evidence than any stored refusal, so it clears the
  // record, including the account-scoped one. That is how a topped-up balance or a rolled-over
  // month recovers well before the TTL would have expired, with no restart. Same contract as the
  // breaker clearing a credential fault on success.
  try {
    const cleared = clearFacts(
      attempt.target.provider,
      attempt.resolvedAttempt.credentialId,
      attempt.target.model ?? null,
    );
    // A stated bad credential has just been disproved, so the per-deployment 401s it caused are
    // stale evidence about a problem that no longer exists. Clearing them together is what makes a
    // key rotation recover the WHOLE provider at once instead of one model per expiry.
    if (cleared.includes("credential-invalid")) {
      h.breaker.clearCredentialFaults(attempt.resolvedAttempt.credentialId);
    }
  } catch {
    /* best-effort */
  }
}

function completeAttemptFailure(
  h: Handlers,
  attempt: HealthAttempt,
  options: {
    failure: AttemptFailed["failure"];
    provenance: OutcomeProvenance;
    status: number | null;
    retryAfterMs?: number | null;
    logStatus?: RequestAttemptStatus;
  },
): void {
  if (attempt.completed) return;
  const completedAt = Date.now();
  const result = h.breaker.completeAttempt(attempt.handle, {
    terminal: "failed",
    target: attempt.identity,
    provenance: options.provenance,
    completedAt,
    elapsedMs: completedAt - attempt.started,
    failure: options.failure,
    status: options.status,
    retryAfterMs: options.retryAfterMs ?? null,
  });
  if (!result.ok) throw new Error(`attempt completion rejected: ${result.error.kind}`);
  attempt.completed = true;
  attempt.terminal = "failed";
  attempt.trace.record(
    attempt.target,
    options.logStatus ?? options.status ?? "failed",
    attempt.started,
    completedAt,
  );
  recordCall(h, attempt, false, completedAt);
  attempt.accounting?.complete(
    attempt.accountingAttempt,
    "error",
    accountingFailureForAttempt(options),
    attempt.usage,
    completedAt,
  );
}

function completeAttemptCancelled(h: Handlers, attempt: HealthAttempt, reason: string | null): void {
  if (attempt.completed) return;
  const completedAt = Date.now();
  const result = h.breaker.completeAttempt(attempt.handle, {
    terminal: "cancelled",
    target: attempt.identity,
    provenance: "client-cancellation",
    completedAt,
    elapsedMs: completedAt - attempt.started,
    reason,
  });
  if (!result.ok) throw new Error(`attempt completion rejected: ${result.error.kind}`);
  attempt.completed = true;
  attempt.terminal = "cancelled";
  attempt.trace.record(attempt.target, "cancelled", attempt.started, completedAt);
  attempt.accounting?.complete(attempt.accountingAttempt, "cancelled", "aborted", attempt.usage, completedAt);
}

type PostHeaderBodyDisposition = "cancelled" | "timeout" | "protocol";

/**
 * A Response proves fetch reached the provider and received headers. A later body rejection is
 * therefore not a provider-wide transport failure and a credential-looking status is not usable
 * evidence about the credential. Close only this deployment unless the client or deadline won.
 */
function completePostHeaderBodyFailure(
  h: Handlers,
  downstream: ServerResponse,
  signal: AbortSignal,
  attempt: HealthAttempt,
  credentialWalk: CredentialWalk,
  credentialTrace: CredentialAttemptTrace,
  resolvedAttempt: ResolvedAttempt,
): PostHeaderBodyDisposition {
  if (downstream.destroyed) {
    completeAttemptCancelled(h, attempt, "client disconnected while reading provider response body");
    recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, { kind: "cancelled" });
    return "cancelled";
  }
  if (signal.aborted) {
    completeAttemptFailure(h, attempt, {
      failure: "transport",
      provenance: "deadline",
      status: 504,
    });
    recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, { kind: "timeout" });
    return "timeout";
  }
  completeAttemptFailure(h, attempt, {
    failure: "protocol",
    provenance: "invalid-upstream-envelope",
    status: 502,
  });
  recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, { kind: "protocol" });
  return "protocol";
}

function detectOpenAiFrontProtocol(method: string | undefined, pathname: string): OpenAiFrontProtocol | null {
  if (method !== "POST") return null;
  if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") return "chat";
  if (pathname === "/v1/responses" || pathname === "/responses") return "responses";
  return null;
}

/**
 * OpenAI front: serve a resolved candidate's Chat Completions or Responses request, preserving
 * the OpenAI wire contract. Direct OpenAI Chat Completions remain verbatim; translated paths use
 * the backend adapter, which keeps the internal Anthropic-shaped seam but does not run the
 * Anthropic tool-repair layer for OpenAI callers.
 *
 * ⚠ This path failed over across candidates for exactly as long as this comment has existed,
 * which is to say it never did. It was handed `healthyTargets[0]` and returned before the
 * Anthropic path's failover loop, and it reported outcomes to runtime telemetry but never to the
 * circuit breaker — so a rate-limited candidate was neither stepped over within a request nor
 * demoted for the next one, and a 14-member pool served every single request from the same dead
 * member. Measured: 8 sequential requests to a 14-candidate pool, 6 consecutive 429s, 0 other
 * candidates tried, breaker `lastStatus: null` throughout. Both halves are fixed here; the
 * classification and breaker accounting come from the SAME helpers the Anthropic path uses, so
 * the two cannot drift apart again.
 */
async function openAiFrontPath(
  res: ServerResponse,
  credentialWalk: CredentialWalk,
  credentialTrace: CredentialAttemptTrace,
  ctx: {
    reqJson: unknown;
    wantsStream: boolean;
    protocol: OpenAiFrontProtocol;
    inboundHeaders: IncomingMessage["headers"];
    started: number;
    path: string;
    hadTools: boolean;
    req?: IncomingMessage;
    /** The addressed pool and its degrade tail, so a below-band answer can say so. */
    addressedPool?: string | null;
    degradedSpecs?: Set<string> | null;
    sticky?: StickyRequestContext | null;
    cfg?: Config;
    accounting: RequestAccountingState | null;
    /** The walk's ranked first choice was quota-demoted; see `QUOTA_DEMOTED_HEADER`. */
    quotaDemotedFirst?: string | null;
  },
  h: Handlers,
): Promise<void> {
  const tried: string[] = [];
  const attemptTrace = new RequestAttemptTrace();
  const directTools = toolSchemaMap(ctx.reqJson);
  const pool429 = new Pool429Tracker();

  while (!res.destroyed) {
    // G2's attempt boundary, shared with the Anthropic front: a capped offer is refused here
    // before any egress and the loop comes straight back for the next candidate.
    const resolvedAttempt = nextUncappedAttempt(h, credentialWalk, attemptTrace, pool429);
    if (!resolvedAttempt) break;
    const target = resolvedAttempt.target;
    const controller = new AbortController();
    const callerController = new AbortController();
    const timer = setTimeout(() => controller.abort(), target.timeoutMs);
    const onResClose = abortOnClientClose(res, callerController, controller);
    res.on("close", onResClose);
    let attempt: HealthAttempt | undefined;
    const usage = createUsageAccumulator();
    let egressCallbackCalled = false;
    const onEgress = () => {
      egressCallbackCalled = true;
      pool429.noteEgress();
      const egressAt = Date.now();
      attempt = beginHealthAttempt(h, resolvedAttempt, egressAt, attemptTrace, usage, ctx.accounting) ?? undefined;
      if (!attempt) throw new Error("llm-relay: could not begin provider attempt");
      attempt.accountingAttempt = ctx.accounting?.startServe(resolvedAttempt, egressAt) ?? null;
      recordCredentialStarted(credentialWalk, credentialTrace, resolvedAttempt);
      tried.push(specOfTarget(target));
    };
    let credentialRecorded = false;

    try {
      let forwardHeaders: Record<string, string>;
      try {
        forwardHeaders = buildForwardHeaders(ctx.inboundHeaders, resolvedAttempt);
      } catch (e) {
        credentialWalk.recordRejected(resolvedAttempt);
        if (e instanceof CredentialConfigError) {
          failClosed(res, 502, `llm-relay configuration: ${e.message}`);
          h.logger.write(baseLog(
            ctx.started,
            ctx.path,
            ctx.hadTools,
            false,
            502,
            "skipped",
            null,
            attemptTrace.snapshot(),
          ));
          return;
        }
        throw e;
      }

      /* attempt begins at the real egress callback */
    const recoveryAudit: { value: {
      validated: RequestLog["validated"];
      toolUseCount: number;
      uncheckableCount: number;
      errorKinds: string[];
      repair: RepairOutcome | "none";
    } | null } = { value: null };
    const processRecoveredChat: RecoveredOpenAiChatProcessor = async (recovered) => {
      const assistant: AssistantMessage = {
        content: [
          ...(recovered.text ? [{ type: "text", text: recovered.text } as const] : []),
          ...recovered.calls.map((call) => ({
            type: "tool_use" as const,
            id: call.id,
            name: call.name,
            input: call.input,
          })),
        ],
        stop_reason: "tool_use",
      };
      const validation = h.validator.validate(assistant, directTools);
      recoveryAudit.value = {
        validated: validation.errors.length > 0
          ? "fail"
          : validation.uncheckableCount > 0 ? "uncheckable" : "pass",
        toolUseCount: validation.toolUseCount,
        uncheckableCount: validation.uncheckableCount,
        errorKinds: dedupe(validation.errors.map((error) => error.kind)),
        repair: "none",
      };
      if (validation.valid || ctx.cfg?.mode !== "repair") return recovered;

      const rawReshaper = h.resolveReshaper(resolvedAttempt);
      const reshaper = rawReshaper ? withRepairAccounting(rawReshaper, ctx.accounting) : undefined;
      if (!reshaper) return recovered;
      const decision = await repair(assistant, directTools, {
        validator: h.validator,
        reshaper,
        maxAttempts: ctx.cfg.repair.maxAttempts,
        isDestructive: h.isDestructive,
        backendModel: target.model ?? null,
        signal: callerController.signal,
      });
      recoveryAudit.value.repair = decision.outcome;
      if (decision.outcome !== "fixed" || !decision.message) {
        throw new Error(`tool call could not be repaired (${decision.outcome})`);
      }

      const fixed: RecoveredOpenAiChat = { text: "", calls: [] };
      for (const block of decision.message.content) {
        if (block.type === "text" && typeof block.text === "string") fixed.text += block.text;
        if (
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string" &&
          typeof block.input === "object" &&
          block.input !== null &&
          !Array.isArray(block.input)
        ) {
          fixed.calls.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
        }
      }
      return fixed;
    };

    let upstream: Response;
      try {
        upstream = await fetchOpenAiFront(resolvedAttempt, {
          reqJson: ctx.reqJson,
          wantsStream: ctx.wantsStream,
          protocol: ctx.protocol,
          anthropicHeaders: forwardHeaders,
          signal: controller.signal,
          isDestructive: h.isDestructive,
          processRecoveredChat,
          usage,
          onEgress,
        });
        if (!attempt) {
          credentialWalk.recordRejected(resolvedAttempt);
          if (errorOrigin(upstream) === "local") {
            await forwardLocalResponse(res, upstream);
            h.logger.write(baseLog(
              ctx.started,
              ctx.path,
              ctx.hadTools,
              false,
              upstream.status,
              "skipped",
              null,
              attemptTrace.snapshot(),
            ));
          } else {
            await upstream.body?.cancel().catch(() => {});
            failClosed(res, 502, "llm-relay: backend returned before provider egress");
            h.logger.write(baseLog(
              ctx.started,
              ctx.path,
              ctx.hadTools,
              false,
              502,
              "skipped",
              null,
              attemptTrace.snapshot(),
            ));
          }
          return;
        }
    } catch (e) {
      if (!attempt) {
        if (credentialWalk.pending === resolvedAttempt) {
          credentialWalk.recordRejected(resolvedAttempt);
        }
          if (res.destroyed) return;
          const status = controller.signal.aborted ? 504 : 502;
          failClosed(res, status, egressCallbackCalled
            ? "llm-relay: could not begin provider attempt"
            : "llm-relay: backend preparation failed");
          h.logger.write(baseLog(
            ctx.started,
            ctx.path,
            ctx.hadTools,
            false,
            status,
            "skipped",
            null,
            attemptTrace.snapshot(),
          ));
          return;
        }
        const aborted = controller.signal.aborted;
        const status = aborted ? 504 : 502;
        if (res.destroyed) {
          completeAttemptCancelled(h, attempt, "client disconnected");
          recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, { kind: "cancelled" });
          credentialRecorded = true;
          return;
        }

        completeAttemptFailure(h, attempt, {
          failure: "transport",
          provenance: aborted ? "deadline" : "upstream",
          status,
        });
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          aborted ? { kind: "timeout" } : { kind: "provider-transport" },
        );
        credentialRecorded = true;
        const walkEnd = endWalk(
          h,
          res,
          "openai",
          credentialWalk,
          attemptTrace,
          pool429,
          status,
          ctx.sticky,
          credentialTrace,
          () => baseLog(
            ctx.started,
            ctx.path,
            ctx.hadTools,
            false,
            status,
            "skipped",
            target,
            attemptTrace.snapshot(),
          ),
          {
            kind: "transport",
            message: aborted ? "backend timed out" : `backend unreachable: ${(e as Error).message}`,
            servedBy: tried.join(", "),
          },
        );
        if (walkEnd) continue;
        return;
      }

      const reportedModelSource = upstream;
      const localFailure = errorOrigin(upstream) === "local";
      const cls = classifyStatus(upstream.status);
      const retryAfterMs = parseRetryAfterMs(upstream.headers.get("retry-after"));
      observeAttemptHeaders(h, attempt, upstream.status, retryAfterMs, upstream.headers);

      const inspected = await inspectCandidateResponse(upstream, resolvedAttempt, retryAfterMs);
      if (inspected.kind === "post-header-body-failure") {
        const disposition = completePostHeaderBodyFailure(
          h, res, controller.signal, attempt, credentialWalk, credentialTrace, resolvedAttempt,
        );
        credentialRecorded = true;
        if (disposition === "cancelled") return;
        const status = disposition === "timeout" ? 504 : 502;
        const walkEnd = endWalk(
          h,
          res,
          "openai",
          credentialWalk,
          attemptTrace,
          pool429,
          status,
          ctx.sticky,
          credentialTrace,
          () => baseLog(
            ctx.started, ctx.path, ctx.hadTools, false, status, "skipped", target, attemptTrace.snapshot(),
          ),
          {
            kind: "post-header-body-failure",
            message: disposition === "timeout"
              ? "backend timed out while reading response body"
              : "llm-relay: provider response body failed after headers",
            servedBy: tried.join(", "),
          },
        );
        if (walkEnd) continue;
        return;
      }
      upstream = inspected.response;
      if (inspected.eligibility.unknown) pool429.noteUnknownRefusal();

      const tryNext = !localFailure && shouldTryNext(cls);
      if (upstream.status >= 400) {
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          walkOutcomeForResponse(upstream.status, localFailure, inspected.eligibility.scope),
        );
        credentialRecorded = true;
        const next = tryNext && !res.writableEnded && !res.destroyed
          ? nextUncappedAttempt(h, credentialWalk, attemptTrace, pool429)
          : undefined;
        if (next) {
          await upstream.body?.cancel().catch(() => {});
          pool429.recordFailover(upstream.status, retryAfterMs);
          completeAttemptFailure(h, attempt, {
            failure: "http",
            provenance: localFailure ? "relay-mapper-defect" : "upstream",
            status: upstream.status,
            retryAfterMs,
          });
          continue;
        }
      }

      const streamed = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
      if (streamed && upstream.status < 400) {
        const protocol: StreamCommitProtocol =
          ctx.protocol === "responses" ? "openai-responses" : "openai-chat";
        const probe = upstream.body
          ? await probeStreamForCommit(upstream.body, protocol, {
              isCancelled: () => res.destroyed,
              malformedProvenance:
                target.kind === "openai" && ctx.protocol === "chat" ? "upstream" : "local",
              ...(dialectRefusalSignalOf(upstream) ? { relayRefusal: dialectRefusalSignalOf(upstream)! } : {}),
            })
          : { kind: "dead" as const, reason: "stream has no body", provenance: "upstream" as const };

        if (probe.kind === "cancelled") {
          completeAttemptCancelled(h, attempt, "client disconnected before stream commit");
          recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, { kind: "cancelled" });
          credentialRecorded = true;
          return;
      }
      if (probe.kind === "dead") {
        const deadline = controller.signal.aborted;
        completeAttemptFailure(h, attempt, deadline
          ? { failure: "transport", provenance: "deadline", status: 504 }
          : {
              failure: "protocol",
              provenance: probe.provenance === "local"
                ? "relay-mapper-defect"
                : "invalid-upstream-envelope",
              status: 502,
            });
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          deadline
            ? { kind: "timeout" }
            : probe.provenance === "local" ? { kind: "local" } : { kind: "protocol" },
        );
          credentialRecorded = true;
          const walkEnd = endWalk(
            h,
            res,
            "openai",
            credentialWalk,
            attemptTrace,
            pool429,
            502,
            ctx.sticky,
            credentialTrace,
            () => baseLog(
              ctx.started,
              ctx.path,
              ctx.hadTools,
              true,
              502,
              "skipped",
              target,
              attemptTrace.snapshot(),
              upstreamReportedModel(reportedModelSource),
            ),
            {
              kind: "dead-stream",
              message: `llm-relay: ${probe.reason}`,
              errorType: probe.errorType,
              errorOrigin: probe.provenance,
              servedBy: tried.join(", "),
              shouldTryNext: probe.provenance === "upstream",
              // Preserved residue: OpenAI dead streams require both writable-open and not
              // destroyed; handle's Anthropic path checks only `!res.destroyed`.
            },
          );
          if (walkEnd) continue;
          return;
        }

        upstream = new Response(probe.body, {
          status: upstream.status,
          headers: upstream.headers,
        });
      }

      const stallMs = target.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
      if (streamed && upstream.status < 400 && stallMs > 0) {
        clearTimeout(timer);
        upstream = withStallWatchdog(upstream, controller, stallMs);
      }

      if (upstream.status < 400) {
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          { kind: "success", status: upstream.status },
        );
        credentialRecorded = true;
      }
      pool429.recordFinal(upstream.status);

      let responseBytesWritten = false;
      try {
        // One announcement set for both fronts — see `ServedAnnouncementContext`. The credential
        // headers are read here, after `recordCredentialOutcome` above settled the winning slot,
        // which is the per-attempt attribution a bare shared call would otherwise lose.
        const headers: Record<string, string | string[]> = responseHeadersForTarget(upstream, {
          target,
          tried,
          retryAfterOverrideMs: pool429.overrideMs(upstream.status, retryAfterMs),
          poolSummary: pool429.summary(),
          poolUnknownRefusals: pool429.unknownCount(),
          credentialHeaders: credentialTrace.headers(),
          degraded: degradedLabel(ctx.addressedPool ?? null, ctx.degradedSpecs ?? null, target),
          // The announcement computed at walk-order time, beside the same demotion that produced it.
          quotaDemoted: ctx.quotaDemotedFirst,
          paid: ctx.cfg ? paidLabel(ctx.cfg, h, target) : null,
          sticky: ctx.sticky,
        });

        if (upstream.status >= 400) {
          const raw = await upstream.text();
          const normalized = normalizeOpenAiErrorBody(raw, upstream.status);
          const out = Buffer.from(normalized ?? raw, "utf8");
          res.writeHead(upstream.status, { ...headers, "content-type": "application/json" });
          res.end(out);
          completeAttemptFailure(h, attempt, {
            failure: "http",
            provenance: localFailure ? "relay-mapper-defect" : "upstream",
            status: upstream.status,
            retryAfterMs,
          });
        } else {
          res.writeHead(upstream.status, headers);
          if (upstream.body) {
            for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
              const bytes = Buffer.from(chunk);
              if (!await writeChunk(res, bytes, () => {
                if (attempt) markAttemptCommitted(attempt);
              })) break;
              if (bytes.length > 0) responseBytesWritten = true;
            }
          }
          if (!res.writableEnded) res.end();
          if (res.destroyed) completeAttemptCancelled(h, attempt, "client disconnected");
          else {
            completeAttemptSuccess(h, attempt, upstream.status);
            recordStickySuccess(h, ctx.sticky, target, upstream.status);
          }
        }
      } catch (e) {
        handleMidStreamError(
          res,
          e,
          ctx.started,
          ctx.path,
          ctx.hadTools,
          streamed,
          upstream.status,
          target,
          attempt,
          h,
          (msg) => streamed ? openAiSseError(msg) : null,
          reportedModelSource,
          controller.signal.aborted,
          responseBytesWritten,
        );
        return;
      }

      const audit = recoveryAudit.value;
      const log = {
        ...baseLog(
          ctx.started,
          ctx.path,
          ctx.hadTools,
          streamed,
          upstream.status,
          audit?.validated ?? "skipped",
          target,
          attemptTrace.snapshot(),
          upstreamReportedModel(reportedModelSource),
          resolvedAttempt.credentialId,
        ),
        // This front's TRANSLATED lane (anything but openai-kind + Chat) runs through
        // `fetchBackend`, so a Codex `/v1/responses` turn on an openai-kind target gets the same
        // id mint the Messages front does — and it must be reported on the SERVED turn, not only
        // on the mid-stream error path that already carried it.
        ...toolUseIdRewriteField(reportedModelSource),
      };
      h.logger.write(audit ? {
        ...log,
        toolUseCount: audit.toolUseCount,
        uncheckableCount: audit.uncheckableCount,
        errorKinds: audit.errorKinds,
        repair: audit.repair,
      } : log);
      return;
    } finally {
      if (!credentialRecorded && attempt) {
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          res.destroyed ? { kind: "cancelled" } : { kind: "local" },
        );
        credentialRecorded = true;
      } else if (!credentialRecorded && credentialWalk.pending === resolvedAttempt) {
        credentialWalk.recordRejected(resolvedAttempt);
      }
      if (attempt && !attempt.completed) {
        if (res.destroyed) completeAttemptCancelled(h, attempt, "client disconnected");
        else {
          completeAttemptFailure(h, attempt, {
            failure: "mapping",
            provenance: "relay-mapper-defect",
            status: 502,
          });
        }
      }
      clearTimeout(timer);
      res.off("close", onResClose);
    }
  }

  // Same single refusal site as the Anthropic front (see the note there): a walk whose every
  // candidate was refused before the first egress reaches here with nothing sent, and owes the
  // client its refusal. Anything that egressed keeps its own upstream error instead.
  if (!res.headersSent && !res.destroyed && pool429.allCapped()) {
    respondAllCapped(res, h, { started: ctx.started, path: ctx.path, hadTools: ctx.hadTools, streamed: ctx.wantsStream }, "openai", pool429, attemptTrace.snapshot());
  }
}
/**
 * The metadata-only `tool_use` id-minting counter for this response, or nothing when the host's
 * own ids were already unique.
 *
 * Read from the response the backend adapter produced, and only at LOG time: on a stream the pass
 * runs while the body drains, so the figure is final once the request is over and would be a guess
 * any earlier. A count, never an id.
 */
function toolUseIdRewriteField(source: Response): {
  toolUseIdRewrites?: number;
  toolCallIdRewrites?: number;
  thoughtSignatureSentinels?: number;
} {
  const rewrites = toolUseIdRewrites(source);
  // The REQUEST-direction sibling: ids the mapper rewrote to the provider's stated shape
  // (`compat.toolCallIds: "strict9"`). Final before egress, but read here so both counters travel
  // together and a stream reports both in the one place it can.
  const outbound = toolCallIdRewrites(source);
  // The other request-direction pass (`compat.thoughtSignature: "sentinel"`). It has NO response
  // header of its own, so this is the only surface the operator can see it on.
  const sentinels = thoughtSignatureSentinels(source);
  return {
    ...(rewrites === undefined ? {} : { toolUseIdRewrites: rewrites }),
    ...(outbound === undefined ? {} : { toolCallIdRewrites: outbound }),
    ...(sentinels === undefined ? {} : { thoughtSignatureSentinels: sentinels }),
  };
}

/**
 * The served-response announcement set: the ONE definition BOTH fronts emit.
 *
 * Deliberately a narrow structural context rather than the Anthropic `Ctx` — the OpenAI front has
 * no `Ctx`, and widening this to accept one would either drag that front's shape toward the
 * Anthropic path's or let a caller omit `credentialHeaders` silently. `Ctx` satisfies it
 * structurally, so the Anthropic callers pass their existing object unchanged.
 *
 * ⚠ This covers only an ordinary SERVED upstream response. `walkExitHeaders` owns terminal
 * transport and post-header exits, and `respondAllCapped` owns the local all-capped 429 where no
 * provider was contacted; both are different response classes and stay separate. `HARD_CAP_HEADER`
 * therefore never appears here.
 *
 * ⚠ Adopting this on the OpenAI front changed the ORDER its announcement headers are written in —
 * that front used to spread the credential pair before the degraded/quota/paid/pool-attempts
 * assignments, and now writes it after them, because this is the Anthropic front's long-standing
 * order and one owner means one order. No VALUE moves: every name here is a distinct `x-llm-relay-*`
 * constant, so nothing in this set can collide with anything else in it. Do not "restore" the old
 * order on one front — two orders is the state this function exists to end.
 */
interface ServedAnnouncementContext {
  readonly target: ResolvedTarget;
  readonly tried?: readonly string[] | undefined;
  readonly retryAfterOverrideMs?: number | undefined;
  readonly poolSummary?: string | null | undefined;
  readonly poolUnknownRefusals?: number | null | undefined;
  readonly credentialHeaders?: Record<string, string> | undefined;
  readonly degraded?: string | null | undefined;
  readonly quotaDemoted?: string | null | undefined;
  readonly paid?: string | null | undefined;
  readonly sticky?: StickyRequestContext | null | undefined;
}

/** Winning-candidate response metadata, shared by transparent and repair streaming paths. */
function responseHeadersForTarget(
  backendRes: Response,
  ctx: ServedAnnouncementContext,
): Record<string, string | string[]> {
  const responseHeaders = filterResponseHeaders(backendRes.headers);
  // The winner below 400, every deployment tried at or above it. The header's own declaration is
  // the contract — "when every candidate fails it carries the list that was tried instead, so an
  // exhausted pool is self-describing" — and `docs/reference.md` states it to users. This front
  // used to omit it entirely on a terminal error while the OpenAI front supplied it, so the same
  // documented behaviour was delivered by one path and not the other.
  // ⚠ Not the transport-exit omission at the `handle` catch, which is a RECORDED deliberate
  // residue: a transport exhaustion has no HTTP response to describe.
  responseHeaders[SERVED_BY_HEADER] = backendRes.status < 400 || !ctx.tried?.length
    ? specOfTarget(ctx.target)
    : ctx.tried.join(", ");
  if (ctx.retryAfterOverrideMs !== undefined && Number.isFinite(ctx.retryAfterOverrideMs)) {
    responseHeaders["retry-after"] = String(Math.max(1, Math.ceil(ctx.retryAfterOverrideMs / 1000)));
  }
  if (ctx.poolSummary) responseHeaders[POOL_ATTEMPTS_HEADER] = ctx.poolSummary;
  // Counts only candidates stepped over: terminal refusal bodies are not buffered on this path.
  // ⚠ Emitted on SUCCESS too, and that is the point: the count is the push half of the eligibility
  // queue — "a NEW kind of refusal just appeared, run `llm-relay eligibility` while the context is
  // still in hand". A later candidate answering does not un-see the refusal. The OpenAI front used
  // to compute it only inside its own `status >= 400` branch and so swallowed exactly that case.
  // The count is positive-or-null and never 0, so this truthy test is exact.
  if (ctx.poolUnknownRefusals) responseHeaders[UNKNOWN_REFUSAL_HEADER] = String(ctx.poolUnknownRefusals);
  if (ctx.degraded) responseHeaders[DEGRADED_HEADER] = ctx.degraded;
  if (ctx.quotaDemoted) responseHeaders[QUOTA_DEMOTED_HEADER] = ctx.quotaDemoted;
  if (ctx.paid) responseHeaders[PAID_HEADER] = ctx.paid;
  if (ctx.credentialHeaders) Object.assign(responseHeaders, ctx.credentialHeaders);
  const sticky = stickyHeaderValue(ctx.sticky, ctx.target, backendRes.status);
  if (sticky) responseHeaders[STICKY_PROVENANCE_HEADER] = sticky;
  return responseHeaders;
}

/** detect/default: forward bytes unchanged, observe + log if applicable. */
async function transparentPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: Ctx & { willValidate: boolean },
  h: Handlers,
): Promise<void> {
  if (!res.headersSent) res.writeHead(backendRes.status, responseHeadersForTarget(backendRes, ctx));
  let assistant: AssistantMessage | null = null;
  let responseBytesWritten = false;
  try {
    if (!backendRes.body) {
      if (!res.writableEnded) res.end();
    } else if (ctx.streamed) {
      const decoder = new TextDecoder();
      let acc = "";
      let overflow = false;
      for await (const chunk of backendRes.body as unknown as AsyncIterable<Uint8Array>) {
        const bytes = Buffer.from(chunk);
        if (!await writeChunk(
          res,
          bytes,
          backendRes.status < 400 ? () => markAttemptCommitted(ctx.attempt) : undefined,
        )) break;
        if (bytes.length > 0) responseBytesWritten = true;
        if (ctx.willValidate && !overflow) {
          acc += decoder.decode(chunk, { stream: true });
          if (acc.length > MAX_VALIDATE_BYTES) overflow = true;
        }
      }
      if (!res.writableEnded) res.end();
      if (ctx.willValidate && !overflow) assistant = reconstructFromSse(acc + decoder.decode());
    } else {
      const bytes = Buffer.from(await backendRes.arrayBuffer());
      if (!res.writableEnded) {
        if (backendRes.status < 400 && bytes.length > 0) markAttemptCommitted(ctx.attempt);
        res.end(bytes);
      }
      // Same as the OpenAI front's terminal branch: the served response is the last candidate's,
      // and for a single-member pool the only refusal we will ever see. Errors are never streamed,
      // so this branch is where they land.
      // NOTE: observeEligibility was already called in inspectCandidateResponse for this response.
      // Calling it again here would double-count the refusal signature in the eligibility queue.
      if (ctx.willValidate && bytes.length <= MAX_VALIDATE_BYTES) assistant = parseAssistant(bytes.toString("utf8"));
    }
  } catch (e) {
    // The head was committed at the top of this function, so the client is already
    // reading a 200. Say the stream broke rather than closing on a truncated answer,
    // and LOG the turn — this throw used to escape to the top-level catch, which
    // could only `res.end()` and never logged.
    handleMidStreamError(
      res, e, ctx.started, ctx.path, ctx.hadTools, ctx.streamed, backendRes.status,
      ctx.target, ctx.attempt, h,
      (msg) => ctx.streamed ? sseError(msg) : null,
      ctx.reportedModelSource,
      ctx.signal.aborted,
      responseBytesWritten,
    );
    return;
  } finally {
    clearTimeout(timer);
  }

  // A client disconnect can make writeChunk stop without throwing. Leave the handle pending so
  // the routing-level finally records cancellation instead of validating a partial response and
  // charging it to provider health.
  if (res.destroyed) return;

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
  if (backendRes.status >= 400) {
    completeAttemptFailure(h, ctx.attempt, {
      failure: "http",
      provenance: errorOrigin(backendRes) === "local" ? "relay-mapper-defect" : "upstream",
      status: backendRes.status,
      retryAfterMs: parseRetryAfterMs(backendRes.headers.get("retry-after")),
    });
  } else if (ctx.willValidate && (!assistant || validated !== "pass")) {
    completeAttemptFailure(h, ctx.attempt, {
      failure: "protocol",
      provenance: "invalid-upstream-envelope",
      status: 502,
      ...(ctx.streamed && res.headersSent ? { logStatus: "committed" as const } : {}),
    });
  } else {
    completeAttemptSuccess(h, ctx.attempt, backendRes.status);
    recordStickySuccess(h, ctx.sticky, ctx.target, backendRes.status);
  }
  h.logger.write({
    ...baseLog(
      ctx.started,
      ctx.path,
      ctx.hadTools,
      ctx.streamed,
      backendRes.status,
      validated,
      ctx.target,
      ctx.attempt.trace.snapshot(),
      upstreamReportedModel(ctx.reportedModelSource),
      ctx.attempt.resolvedAttempt.credentialId,
    ),
    toolUseCount, uncheckableCount, errorKinds,
    ...toolUseIdRewriteField(ctx.reportedModelSource),
  });
}

/**
 * `maxAttempts` is carried from `cfg.repair.maxAttempts` rather than read at the call
 * site. Both `repair()` call sites passed a hardcoded `2`, so the configured value —
 * parsed, validated and documented in `config.ts`, and settable per install — was
 * silently ignored on every request.
 */
type RepairCtx = Ctx & {
  wantsStream: boolean;
  reshaper: Reshaper;
  maxAttempts: number;
  /** Request-local aggregate shared with the outer candidate walk. */
  pool429: Pool429Tracker;
};

interface BufferedRepairDeadTurn {
  validated: RequestLog["validated"];
  toolUseCount: number;
  uncheckableCount: number;
  errorKinds: string[];
}

/** repair: route to the streaming or buffered variant. */
async function repairPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: RepairCtx,
  h: Handlers,
): Promise<BufferedRepairDeadTurn | null> {
  if (ctx.streamed) {
    await repairStreamingPath(res, backendRes, timer, ctx, h);
    return null;
  } else {
    return repairBufferedPath(res, backendRes, timer, ctx, h);
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
  const filtered = responseHeadersForTarget(backendRes, ctx);
  let acc = "";                 // full decoded stream, for reconstruction
  let overflow = false;         // acc exceeded the validate cap → give up repair
  let work = Buffer.alloc(0);   // raw bytes not yet split into complete frames
  const held: Buffer[] = [];    // frames withheld from the client (first tool_use onward)
  let buffering = false;
  let firstToolUseIndex = -1;
  let headWritten = res.headersSent;
  let responseBytesWritten = false;

  const ensureHead = () => {
    if (!headWritten && !res.headersSent) {
      res.writeHead(backendRes.status, filtered);
      headWritten = true;
    }
  };
  const forward = async (frame: Buffer) => {
    ensureHead();
    if (await writeChunk(res, frame, () => markAttemptCommitted(ctx.attempt)) && frame.length > 0) responseBytesWritten = true;
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
    held.length = 0;
    handleMidStreamError(
      res,
      e,
      ctx.started,
      ctx.path,
      ctx.hadTools,
      true,
      backendRes.status,
      ctx.target,
      ctx.attempt,
      h,
      sseError,
      ctx.reportedModelSource,
      ctx.signal.aborted,
      responseBytesWritten,
    );
    return;
  } finally {
    clearTimeout(timer);
  }

  if (res.destroyed) return;

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
        signal: ctx.callerSignal,
      });
      repairOutcome = decision.outcome;
      ensureHead(); // message_start + leading text already forwarded
      if (decision.outcome === "fixed" && decision.message) {
        if (!res.writableEnded) {
          const tail = emitSseTail(decision.message, firstToolUseIndex);
          if (tail.length > 0) markAttemptCommitted(ctx.attempt);
          res.end(tail);
        }
      } else {
        // Head already committed — surface a mid-stream SSE error, never a fabricated call.
        if (!res.writableEnded) res.end(sseError(`llm-relay: tool call could not be repaired (${decision.outcome})`));
      }
    }
  }

  if (backendRes.status >= 400) {
    completeAttemptFailure(h, ctx.attempt, {
      failure: "http",
      provenance: errorOrigin(backendRes) === "local" ? "relay-mapper-defect" : "upstream",
      status: backendRes.status,
      retryAfterMs: parseRetryAfterMs(backendRes.headers.get("retry-after")),
    });
  } else if (
    (validated === "fail" && repairOutcome !== "fixed") ||
    (repairOutcome !== "none" && repairOutcome !== "fixed")
  ) {
    completeAttemptFailure(h, ctx.attempt, {
      failure: "protocol",
      provenance: "invalid-upstream-envelope",
      status: 502,
      logStatus: "committed",
    });
  } else {
    completeAttemptSuccess(h, ctx.attempt, backendRes.status);
    recordStickySuccess(h, ctx.sticky, ctx.target, backendRes.status);
  }
  h.logger.write({
    ...baseLog(
      ctx.started,
      ctx.path,
      ctx.hadTools,
      true,
      backendRes.status,
      validated,
      ctx.target,
      ctx.attempt.trace.snapshot(),
      upstreamReportedModel(ctx.reportedModelSource),
      ctx.attempt.resolvedAttempt.credentialId,
    ),
    toolUseCount, uncheckableCount, errorKinds, repair: repairOutcome,
    ...toolUseIdRewriteField(ctx.reportedModelSource),
  });
}

/** repair, buffered (non-streamed JSON): buffer, validate; if invalid, reshape and re-emit. */
async function repairBufferedPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: RepairCtx,
  h: Handlers,
): Promise<BufferedRepairDeadTurn | null> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await backendRes.arrayBuffer());
  } catch (e) {
    // Nothing has been written yet on this path, so this is a clean 502 rather than
    // a truncated body — but it still has to be LOGGED, which the bare finally did
    // not do: the throw went straight to the top-level catch.
    handleMidStreamError(res, e, ctx.started, ctx.path, ctx.hadTools, ctx.streamed, backendRes.status, ctx.target, ctx.attempt, h, () => null, ctx.reportedModelSource, ctx.signal.aborted);
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (res.destroyed) return null;
  const assistant = ctx.streamed
    ? reconstructFromSse(bytes.toString("utf8"))
    : parseAssistant(bytes.toString("utf8"));

  // W8's winning-candidate metadata assembly is shared with transparent and streaming repair;
  // sticky provenance must describe the candidate that actually commits here too.
  const filtered = responseHeadersForTarget(backendRes, ctx);
  let repairOutcome: RepairOutcome | "none" = "none";
  let validated: RequestLog["validated"] = "skipped";
  let toolUseCount = 0;
  let uncheckableCount = 0;
  let errorKinds: string[] = [];

  const recordFinalWalk = (
    status: number,
    headers?: Record<string, string | string[]>,
  ): Record<string, string | string[]> | undefined => {
    ctx.pool429.recordFinal(status);
    const summary = ctx.pool429.summary();
    if (!summary) return headers;
    if (headers) headers[POOL_ATTEMPTS_HEADER] = summary;
    return headers ?? { [POOL_ATTEMPTS_HEADER]: summary };
  };

  if (!assistant) {
    if (backendRes.status < 400) {
      // A successful status with no Anthropic message is not a successful provider attempt.
      // Nothing has been committed yet on this buffered path, so return a bounded clean 502.
      validated = "fail";
      errorKinds = ["invalid_upstream_envelope"];
      failClosed(
        res,
        502,
        "llm-relay: invalid Anthropic upstream envelope",
        recordFinalWalk(502, stickyProvenanceHeaders(ctx.sticky)),
      );
    } else {
      recordFinalWalk(backendRes.status, filtered);
      res.writeHead(backendRes.status, filtered);
          if (!res.writableEnded) {
            if (backendRes.status < 400 && bytes.length > 0) markAttemptCommitted(ctx.attempt);
            res.end(bytes);
          }
    }
  } else {
    const r = h.validator.validate(assistant, ctx.tools);
    toolUseCount = r.toolUseCount;
    uncheckableCount = r.uncheckableCount;
    if (r.valid) {
      validated = r.uncheckableCount > 0 ? "uncheckable" : "pass";
      recordFinalWalk(backendRes.status, filtered);
      res.writeHead(backendRes.status, filtered); // pass through untouched
        if (!res.writableEnded) {
          if (backendRes.status < 400 && bytes.length > 0) markAttemptCommitted(ctx.attempt);
          res.end(bytes);
        }
    } else {
      validated = "fail";
      errorKinds = dedupe(r.errors.map((e) => e.kind));
      const decision = await repair(assistant, ctx.tools, {
        validator: h.validator,
        reshaper: ctx.reshaper,
        maxAttempts: ctx.maxAttempts,
        isDestructive: h.isDestructive,
        backendModel: ctx.target.model ?? null,
        signal: ctx.callerSignal,
      });
      repairOutcome = decision.outcome;
      if (decision.outcome === "fixed" && decision.message) {
        recordFinalWalk(backendRes.status, filtered);
      emitFixed(res, backendRes.status, filtered, decision.message, ctx.wantsStream, () => markAttemptCommitted(ctx.attempt));
      } else if (decision.outcome === "failed") {
        // Nothing has been committed on the buffered path. The outer candidate loop decides
        // whether this request can resume or whether this remains the terminal fail-clean 502.
      } else {
        // fail-clean: loud, well-formed error rather than a silently broken call.
        failClosed(
          res,
          502,
          `llm-relay: tool call could not be repaired (${decision.outcome})`,
          recordFinalWalk(502, stickyProvenanceHeaders(ctx.sticky)),
        );
      }
    }
  }

  if (backendRes.status >= 400) {
    completeAttemptFailure(h, ctx.attempt, {
      failure: "http",
      provenance: errorOrigin(backendRes) === "local" ? "relay-mapper-defect" : "upstream",
      status: backendRes.status,
      retryAfterMs: parseRetryAfterMs(backendRes.headers.get("retry-after")),
    });
  } else if (
    (validated === "fail" && repairOutcome !== "fixed") ||
    (repairOutcome !== "none" && repairOutcome !== "fixed")
  ) {
    completeAttemptFailure(h, ctx.attempt, {
      failure: "protocol",
      provenance: "invalid-upstream-envelope",
      status: 502,
      ...(repairOutcome === "failed" ? { logStatus: "dead-turn" as const } : {}),
    });
  } else {
    completeAttemptSuccess(h, ctx.attempt, backendRes.status);
    recordStickySuccess(h, ctx.sticky, ctx.target, backendRes.status);
  }
  if (repairOutcome === "failed") {
    return { validated, toolUseCount, uncheckableCount, errorKinds };
  }

  h.logger.write({
    ...baseLog(
      ctx.started,
      ctx.path,
      ctx.hadTools,
      ctx.streamed,
      backendRes.status,
      validated,
      ctx.target,
      ctx.attempt.trace.snapshot(),
      upstreamReportedModel(ctx.reportedModelSource),
      ctx.attempt.terminal === "succeeded" ? ctx.attempt.resolvedAttempt.credentialId : null,
    ),
    toolUseCount, uncheckableCount, errorKinds, repair: repairOutcome,
    ...toolUseIdRewriteField(ctx.reportedModelSource),
  });
  return null;
}

function emitFixed(
  res: ServerResponse,
  status: number,
  filtered: Record<string, string | string[]>,
  message: AssistantMessage,
  wantsStream: boolean,
  beforeBody?: () => void,
): void {
  if (wantsStream) {
    res.writeHead(status, { ...filtered, "content-type": "text/event-stream" });
    if (!res.writableEnded) {
      const body = emitSse(message);
      if (body.length > 0) beforeBody?.();
      res.end(body);
    }
  } else {
    res.writeHead(status, { ...filtered, "content-type": "application/json" });
    if (!res.writableEnded) {
      const body = JSON.stringify(toAnthropicMessage(message));
      if (body.length > 0) beforeBody?.();
      res.end(body);
    }
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
 *                       that is the whole point of the anthropic passthrough. A provider may
 *                       DECLARE this with `credentialMode: "passthrough"`, and declare the
 *                       opposite with `credentialMode: "contained"` — a keyless backend that is
 *                       not the caller's own vendor (a local daemon, a second relay, someone
 *                       else's Anthropic-format endpoint) must not receive their credential just
 *                       because it needs none of its own. Omitting the field still forwards, so
 *                       existing configs keep working, and config load warns instead.
 *  - `declared-present` — the provider's own key is attached and the caller's inbound
 *                       `Authorization`/`x-api-key` are REMOVED, never merged.
 *  - `declared-missing` — the caller's inbound `Authorization`/`x-api-key` are REMOVED
 *                       *and* the request fails. "Removed" is strictly stronger than
 *                       "we did not add one of our own": the defect this replaces
 *                       satisfied the weaker reading while forwarding the caller's
 *                       Anthropic token verbatim to a third-party base URL.
 */
export function buildForwardHeaders(inbound: IncomingMessage["headers"], attempt: ResolvedAttempt): Record<string, string> {
  const { target, credential } = attempt;
  // Containment is DECLARED, not inferred from key presence. The old
  // `stripAuth = !!apiKey` was identically falsy for two opposite configurations —
  // "no authEnv declared" (an intentional passthrough: forward the caller's own
  // credential) and "authEnv declared but unset" (a misconfiguration) — so in the
  // second case the caller's own Anthropic token was forwarded verbatim to a
  // third-party base URL. Only a real passthrough forwards inbound auth now.
  const stripAuth = credential.state !== "not-declared" || target.credentialMode === "contained";
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inbound)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (INTERNAL_REQUEST_HEADERS.has(key)) continue;
    // The REMOVAL, for both declared states. It happens before the throw below so
    // that no code path can observe a header map still carrying the caller's
    // credential — not the throw's own error, not a future caller that decides to
    // handle the error and reuse what was built.
    if (stripAuth && INBOUND_AUTH.includes(key)) continue;
    if (v === undefined) continue;
    out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  if (!out["anthropic-version"]) out["anthropic-version"] = DEFAULT_ANTHROPIC_VERSION;
  if (credential.state === "declared-missing") {
    // Should be unreachable — resolveTargets drops keyless targets — but thrown
    // rather than silently proceeding so a routing change that lets one through
    // fails loudly instead of egressing whatever the caller happened to send.
    throw new CredentialConfigError(target.provider, target.authEnv!);
  }
  Object.assign(out, buildAuthHeaders(credential.value, target.authHeader));
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

async function forwardLocalResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!res.headersSent) res.writeHead(response.status, headers);
  res.end(bytes);
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

/**
 * Handle a mid-stream failure (socket reset / network drop mid-response).
 *
 * Emits protocol-appropriate error frames (SSE event/data or none for non-stream),
 * completes the attempt's still-provisional health handle as a failure and writes a
 * metadata log record with `MID_STREAM_ERROR_KIND`.
 */
function handleMidStreamError(
  res: ServerResponse,
  e: unknown,
  started: number,
  path: string,
  hadTools: boolean,
  streamed: boolean,
  backendStatus: number,
  target: ResolvedTarget,
  attempt: HealthAttempt,
  h: Handlers,
  errorFrameBuilder: (msg: string) => string | null,
  reportedModelSource: Response,
  deadlineAborted = false,
  committed = false,
): void {
  const message = midStreamMessage(e);
  const errorFrame = errorFrameBuilder(message);
  endMidStreamFailure(res, errorFrame, message);
  if (res.destroyed) {
    completeAttemptCancelled(h, attempt, "client disconnected");
  } else {
    completeAttemptFailure(h, attempt, {
      failure: deadlineAborted ? "transport" : "protocol",
      provenance: deadlineAborted ? "deadline" : "upstream",
      status: deadlineAborted ? 504 : 502,
      ...(committed ? { logStatus: "committed" as const } : {}),
    });
  }
  h.logger.write({
    ...baseLog(
      started,
      path,
      hadTools,
      streamed,
      backendStatus,
      "skipped",
      target,
      attempt.trace.snapshot(),
      upstreamReportedModel(reportedModelSource),
    ),
    errorKinds: [MID_STREAM_ERROR_KIND],
    ...toolUseIdRewriteField(reportedModelSource),
  });
}

/** The client-facing description of a mid-transfer upstream failure. */
function midStreamMessage(e: unknown): string {
  const errStr =
    e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string"
      ? (e as { message: string }).message
      : String(e);
  return `llm-relay: backend stream failed mid-response: ${errStr}`;
}

function readBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<Buffer> {
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
        // Drain without retaining the rest so the client can receive the explicit 413 response.
        req.resume();
        // Tagged, not described: the dashboard route classifies 413-vs-500 from this CODE. It used
        // to regex-match this very message string, i.e. the relay inferring its own intent from
        // prose — see `BODY_TOO_LARGE_CODE`. Harmless for the other caller, which ignores it.
        reject(Object.assign(new Error("request body too large"), { code: BODY_TOO_LARGE_CODE }));
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

async function writeChunk(res: ServerResponse, chunk: Buffer, beforeWrite?: () => void): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  try {
    if (chunk.length > 0) beforeWrite?.();
    const ok = res.write(chunk);
    if (!ok && !res.destroyed && !res.writableEnded) {
      await new Promise<void>((resolve) => {
        const cleanup = () => {
          res.removeListener("drain", onEvent);
          res.removeListener("close", onEvent);
          res.removeListener("error", onEvent);
        };
        const onEvent = () => {
          cleanup();
          resolve();
        };
        res.once("drain", onEvent);
        res.once("close", onEvent);
        res.once("error", onEvent);
      });
    }
    return !res.destroyed && !res.writableEnded;
  } catch {
    return false;
  }
}

function failClosed(
  res: ServerResponse,
  status: number,
  message: string,
  headers?: Record<string, string | string[]>,
  /**
   * Error type for the body. Defaults to `api_error`, which is what every caller wanted before a
   * relay-authored refusal could reach here — so an omitted argument is byte-identical to before.
   */
  errorType = "api_error",
): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(status, { ...headers, "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: errorType, message } }));
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

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
