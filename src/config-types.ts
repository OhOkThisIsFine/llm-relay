import type { CredentialId } from "./credential-id.js";

export type Mode = "detect" | "repair" | "strict";

export type AuthHeader = "x-api-key" | "authorization";

export type Kind = "anthropic" | "openai";

export type ProviderTierType = "free" | "mixed" | "subscription";

/**
 * The effort bands, WEAKEST FIRST — one declaration, and the type is derived from it rather than
 * the other way round.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;

/** Requested reasoning/capability band for an automatically discovered pool. */
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Claude tier names, longest-first so "haiku"/"sonnet" match before generic bits. */
export const CLAUDE_TIER_NAMES = ["opus", "sonnet", "haiku", "fable"] as const;
export type ClaudeTierName = (typeof CLAUDE_TIER_NAMES)[number];

/** Which requests a client-specific offload rule may reroute. */
export type OffloadScope = "subagents" | "all";

/** One independently controlled offload rule. */
export interface OffloadRule {
  enabled: boolean;
  scope: OffloadScope;
  /**
   * Refuse — loudly — rather than let this client's rerouted traffic reach a deployment that
   * is not assessed `free`.
   */
  freeOnly?: boolean;
}

/**
 * `false`/`true` is the backwards-compatible global switch. The object form is keyed by
 * originating harness (`claude`, `codex`, or a future client name), with `default` available as
 * an explicit catch-all for a client that has not got a dedicated rule yet.
 */
export type OffloadConfig = boolean | Record<string, OffloadRule>;

export interface ReshaperConfig {
  base: string;
  model: string;
  /** "anthropic": call /v1/messages. "openai": call /chat/completions (NIM/vLLM). */
  kind: Kind;
  /** Provider name for provider-aware credential resolution (auth alias + passthrough rules). */
  provider?: string;
  authEnv?: string;
  authHeader: AuthHeader;
  timeoutMs: number;
}

/**
 * What happens to the CALLER's own `Authorization`/`x-api-key` at a provider that declares no
 * `authEnv` of its own. See `buildForwardHeaders`.
 */
export type CredentialMode = "passthrough" | "contained";

/**
 * What shape a provider's own validator demands of the tool-call ids the relay puts on the wire.
 */
export type ToolCallIdMode = "preserve" | "strict9";

/**
 * Whether a replayed assistant tool call must carry gemini 3.x's `thought_signature` field.
 */
export type ThoughtSignatureMode = "none" | "sentinel";

/**
 * Per-provider WIRE-SHAPE quirks — things a specific host's request validator demands that the
 * protocol itself does not.
 */
export interface ProviderCompatConfig {
  /** Absent ⇒ resolved from the base host by `resolveToolCallIdMode`. */
  toolCallIds?: ToolCallIdMode;
  /** Absent ⇒ resolved from the base host by `resolveThoughtSignatureMode`. */
  thoughtSignature?: ThoughtSignatureMode;
}

/** The closed set of axes an operator may assert: requests/tokens per minute/day. Nothing else. */
export const CONFIGURED_LIMIT_AXES = ["rpm", "rpd", "tpm", "tpd"] as const;

export type ConfiguredLimitAxis = (typeof CONFIGURED_LIMIT_AXES)[number];

/** Flat hard-cap axes, as declared inside a `hard` block. */
export type HardRateLimits = Partial<Record<ConfiguredLimitAxis, number>>;

/** One rate-limit figure per axis; an omitted axis is simply undeclared, never guessed. */
export interface ProviderRateLimits {
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
  /**
   * Operator-set REFUSAL ceilings (G2).
   */
  hard?: HardRateLimits;
}

/**
 * A `limits` block: the flat axes plus optional per-deployment overrides keyed by BACKEND model
 * id.
 */
export interface ProviderLimitsConfig extends ProviderRateLimits {
  models?: Record<string, ProviderRateLimits>;
}

/** A normalized provider credential declaration. Secrets are never held here. */
export interface ProviderCredentialConfig {
  label: string;
  authEnv: string;
  enabled?: boolean;
  /** `null` means all models; an empty array deliberately matches no models. */
  models?: readonly string[] | null;
  /**
   * This slot's own operator-asserted rate limits, overriding the provider-level `limits` for
   * this key alone.
   */
  limits?: ProviderLimitsConfig;
}

/** Non-secret identity and policy for one configured credential slot. */
export interface CredentialSlot {
  readonly credentialId: CredentialId;
  readonly provider: string;
  readonly label: string;
  readonly authEnv: string | undefined;
  readonly enabled: boolean;
  readonly models: readonly string[] | null;
  readonly origin: "implicit" | "legacy-authEnv" | "credentials";
  readonly resolutionMode: "legacy-alias" | "declared-only";
  readonly configIndex: number;
}

/** One HTTP backend provider in the registry (NIM, OpenRouter, Gemini API, …). */
export interface ProviderConfig {
  base: string;
  /**
   * "anthropic": provider speaks Anthropic Messages; forward as-is.
   * "openai": provider is OpenAI-compatible (NIM/vLLM/OpenRouter/Gemini-openai);
   * the proxy translates request+response via llm-bridge.
   */
  kind: Kind;
  authEnv?: string;
  /** Explicit multi-key declarations. Presence of an empty array means an empty fleet. */
  credentials?: ProviderCredentialConfig[];
  /**
   * What to do with the caller's own credential when this provider declares no `authEnv`.
   */
  credentialMode?: CredentialMode;
  /** Maximum concurrent requests for this provider credential domain; null/omitted is unlimited. */
  maxConcurrent?: number | null;
  /** Which header to inject the provider key into. Default: authorization (openai) / x-api-key (anthropic). */
  authHeader: AuthHeader;
  /** Backend request deadline in ms. Default 120000. */
  timeoutMs: number;
  /**
   * Inter-byte stall watchdog for STREAMED responses, in ms.
   */
  stallTimeoutMs?: number;
  /** "free": wholly free/free-tier catalog. "mixed": catalog contains free and paid models. */
  tierType?: ProviderTierType;
  /**
   * Operator-asserted rate limits (spec §4 rung 3, basis "configured").
   */
  limits?: ProviderLimitsConfig;
  /**
   * Wire-shape quirks this host's own request validator enforces.
   */
  compat?: ProviderCompatConfig;
  /** Web URL where users can sign up or obtain API keys. */
  signupUrl?: string;
}

/**
 * How an inbound request's `model` maps to a provider + backend model.
 */
export interface Routing {
  default: string | string[];
  tiers: Record<string, string | string[]>;
  pools?: Record<string, string[]>;
  /** Dynamic pool policies are normalized separately from their materialized target arrays. */
  poolPolicies?: Record<string, PoolPolicy>;
  /**
   * Pool → the specs in its DEGRADE TAIL: live members below the pool's effort band.
   */
  poolDegraded?: Record<string, string[]>;
  /**
   * Tier → spec for SUBAGENT requests only (`cc_is_subagent=true`).
   */
  subagents?: Record<string, string>;
  /**
   * Offload admission.
   */
  offload?: OffloadConfig;
  benchmarkSort?: boolean;
  /** Ephemeral session affinity. Boolean shorthand uses the 30m/1,000-entry defaults. */
  sticky?: StickyConfig;
  /**
   * Quota-as-demotion enforcement (spec §5.4 / Gap 12).
   */
  quota?: QuotaEnforcementConfig;
  /**
   * Sustained MEASURED latency as a demotion term (owner decision 2026-08-30).
   */
  latency?: LatencyDemotionConfig;
  /**
   * Hedged attempts.
   */
  hedge?: HedgeConfig;
  /**
   * Background lane re-probing.
   */
  laneProbe?: LaneProbeSettings;
  /**
   * Settings for `llm-relay mcp`.
   */
  mcp?: McpSettings;
  /**
   * Ordered dispatch ladder consulted by `/dispatch`.
   */
  ladder?: LadderRung[];
  /** Tier-specific dispatch ladders. `dispatch --tier <name>` selects one. */
  ladders?: Record<string, LadderRung[]>;
  /**
   * How to reach a `relay` rung's spec by SHELLING OUT.
   */
  cliLane?: CliLaneTemplate;
}

export interface StickyRoutingConfig {
  enabled: boolean;
  ttlMs?: number;
  maxSessions?: number;
}

export type StickyConfig = boolean | StickyRoutingConfig;

export interface QuotaEnforcementConfig {
  /** Default true. false disables quota demotion entirely. */
  enforce?: boolean;
  /** Default false. true additionally lets `derived:learned` figures gate routing. */
  enforceLearned?: boolean;
  /** Default true. false treats every `hard` cap as an ordinary (soft) configured limit. */
  hardCaps?: boolean;
}

export interface LatencyDemotionConfig {
  /** Default true. false disables latency demotion entirely. */
  enabled?: boolean;
  /** Fallback ceiling: measured absolute p95 in ms. Above it, the candidate is demoted. */
  p95Ms?: number;
  /**
   * PRIMARY ceiling: measured p95 latency per OUTPUT TOKEN, in ms.
   */
  msPerToken?: number;
  /** Minimum measurable samples before latency may demote anything at all. */
  minSamples?: number;
}

export interface HedgeConfig {
  /** Default true. false disables hedging entirely. */
  enabled?: boolean;
  /**
   * The floor under every threshold, in ms.
   */
  floorMs?: number;
  /** How far past the expected time an attempt must run before a hedge starts. */
  margin?: number;
  /** Minimum samples before a measured statistic may set the bar instead of the floor. */
  minSamples?: number;
}

export interface CliLaneTemplate {
  command: string;
  /** Must contain `{spec}`; `{task}` too. */
  args: string[];
  /** Applied by the host when spawning. */
  env?: Record<string, string | null>;
}

/** A fixed configured prefix followed by automatically discovered free models. */
export interface PoolPolicy {
  preferred: string[];
  include: "free";
  /** Permanent user tombstones, applied to both the fixed prefix and discovered tail. */
  exclude?: string[];
  /** Optional evidence-aware effort band for the discovered tail. */
  effort?: EffortLevel;
}

export interface LadderRung {
  id: string;
  kind: "cli" | "relay";
  /** Parked rungs stay visible in the ladder but are never auto-selected. Default true. */
  enabled: boolean;
  quota?: string;
  note?: string;
  /** cli rungs: the binary to run, and its args — one of which must contain the task placeholder. */
  command?: string;
  args?: string[];
  /** cli rungs: environment the HOST applies when spawning the command. */
  env?: Record<string, string | null>;
  /** relay rungs: the spec to address (`pool/<name>`, `<provider>/<model>`, a provider name). */
  spec?: string;
}

/** The request headers needed for protocol-specific subagent markers. */
export type RequestHeaders = Readonly<Record<string, string | string[] | undefined>>;

/** A request routed to a concrete provider + backend model. */
export interface ResolvedTarget {
  provider: string;
  base: string;
  kind: Kind;
  /** Real backend model id (required for openai; absent = anthropic passthrough). */
  model?: string;
  authEnv?: string;
  /** Normalized non-secret credential slots for this provider. */
  credentialSlots?: readonly CredentialSlot[];
  /** Carried from the provider: whether the caller's own credential may travel to this target. */
  credentialMode?: CredentialMode;
  authHeader: AuthHeader;
  timeoutMs: number;
  /** Carried from the provider: inter-byte stall watchdog for streamed responses. */
  stallTimeoutMs?: number;
  /**
   * RESOLVED outbound tool-call-id shape (`resolveToolCallIdMode`).
   */
  toolCallIds?: ToolCallIdMode;
  /**
   * RESOLVED thought-signature mode (`resolveThoughtSignatureMode`).
   */
  thoughtSignature?: ThoughtSignatureMode;
}

export interface Config {
  host: string;
  port: number;
  providers: Record<string, ProviderConfig>;
  routing: Routing;
  mode: Mode;
  /** Explicit global reshaper override; otherwise repair reshapes on the resolved target itself. */
  reshaper?: ReshaperConfig;
  /**
   * Ranked reshaper candidates, from `reshaper: { pool: "<name>" }`.
   */
  reshaperCandidates?: ReshaperConfig[];
  /** Dynamic reshaper pool resolved lazily after its catalog-backed tail is materialized. */
  reshaperPool?: { name: string; timeoutMs?: number };
  repair: { maxAttempts: number; destructiveTools: string[] };
  /**
   * Wall-clock ceiling (ms) on STARTING further failover attempts within one request's pool walk.
   */
  walkBudgetMs?: number;
  /** Maximum inbound request-body size in bytes. Absent ⇒ 36 MiB. */
  maxBodyBytes?: number;
  log: { level: "metadata" | "silent"; file: string | null; maxBytes?: number };
  /**
   * Providers the onboarding nudge must stop asking about (`leave_me_alone` in config.json).
   */
  leaveMeAlone?: string[];
  /** Path this config was loaded from. Set by `loadConfig`; absent for hand-built test configs. */
  sourcePath?: string;
  /**
   * Non-fatal load-time problems.
   */
  warnings?: string[];
}

export interface LaneProbeSettings {
  enabled: boolean;
  /** Gate between quota probes of ONE dead bucket. A probe spends that lane's quota. */
  quotaIntervalMs: number;
  /** Gate between catalog re-probes of ONE lane. Metadata commands, no quota spent. */
  catalogIntervalMs: number;
}

export interface McpSettings {
  allowedRoots?: string[];
}
