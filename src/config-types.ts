import type { CredentialId } from "./credential-id.js";

export type Mode = "detect" | "repair" | "strict";

export type AuthHeader = "x-api-key" | "authorization";

export type Kind = "anthropic" | "openai";

export type ProviderTierType = "free" | "mixed" | "subscription";

/**
 * The effort bands, WEAKEST FIRST — one declaration, and the type is derived from it rather than
 * the other way round.
 *
 * ⚠ Order is load-bearing: `dynamic-pools.ts` derives the degrade tail from this array's index, so
 * a band inserted out of order silently reorders which weaker members an exhausted pool falls back
 * to.
 *
 * ⚠ Why an ordered tuple and not four hand-lists: the member list stood restated in four places
 * across three modules, and only ONE of them was exhaustiveness-checked. `new Set<EffortLevel>([…])`
 * and `EffortLevel[]` both accept a SUBSET, and `cli.ts` validated against a bare `string[]` with
 * no link to the type at all — so a fifth band would have compiled everywhere and silently failed
 * in three of the four. `Record<EffortLevel, …>` (`EFFORT_FLOORS` in `benchmarks.ts`) is the shape
 * that already caught it, and is why that one is left as it is.
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
   * is not assessed `free` (see `assessCost`; `unknown` counts as paid on purpose). Applies to
   * everything `subagentSpec` reroutes for this client, INCLUDING a per-call `@relay:` directive:
   * the flag is the owner's standing "this lane never spends money", and a subagent prompt must
   * not be able to out-rank it. The Anthropic passthrough is primary quota and is never free.
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
 * Outbound tool-call-id policy: preserve caller ids, or rewrite them to the strict nine-character
 * form required by providers that validate that shape.
 */
export type ToolCallIdMode = "preserve" | "strict9";

/** Whether replayed tool calls need Google's documented thought-signature sentinel. */
export type ThoughtSignatureMode = "none" | "sentinel";

/**
 * Outbound reasoning mapping. `none` emits no provider-specific reasoning controls; `deepseek`
 * maps supported caller/pool effort and defaults unspecified thinking off for replay safety.
 */
export type ReasoningMode = "none" | "deepseek";

/**
 * Provider wire-shape compatibility overrides. Host-derived defaults may be overridden explicitly;
 * unknown keys/values are load errors rather than silent no-ops.
 */
export interface ProviderCompatConfig {
  /** Resolved outbound tool-call-id policy. Absent on hand-built targets means `preserve`. */
  toolCallIds?: ToolCallIdMode;
  /** Resolved thought-signature policy. Absent on hand-built targets means `none`. */
  thoughtSignature?: ThoughtSignatureMode;
  /** Resolved reasoning-mapping policy. Absent on hand-built targets means `none`. */
  reasoning?: ReasoningMode;
}

/** Upstream OpenAI-family endpoint: Chat Completions or Responses. Anthropic-kind providers cannot set this. */
export const PROVIDER_WIRE_MODES = ["chat", "responses"] as const;
/** Derived from `PROVIDER_WIRE_MODES` — one list, never a hand-copied second declaration. */
export type ProviderWireMode = (typeof PROVIDER_WIRE_MODES)[number];

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
   * What to do with the caller's own credential when this provider declares no `authEnv`:
   *  - `"passthrough"` — forward it. This is the declaration that makes an Anthropic
   *    passthrough deliberate rather than a side effect of leaving `authEnv` out.
   *  - `"contained"` — strip it and send none. The right answer for a keyless backend that
   *    is not the caller's own vendor: a local daemon, a second relay, someone else's
   *    Anthropic-format endpoint.
   *
   * Omitting it still forwards, so existing configs keep working, but config load warns for an
   * `anthropic`-kind provider. "This backend needs no key of its own" and "send this host the
   * user's subscription credential" are different intentions, and only the first one should be
   * inferable from an omission. Illegal together with `authEnv` — that pair states both at once.
   */
  credentialMode?: CredentialMode;
  /** Maximum concurrent requests for this provider credential domain; null/omitted is unlimited. */
  maxConcurrent?: number | null;
  /** Which header to inject the provider key into. Default: authorization (openai) / x-api-key (anthropic). */
  authHeader: AuthHeader;
  /** Backend request deadline in ms. Default 120000. */
  timeoutMs: number;
  /**
   * Inter-byte stall watchdog for STREAMED responses, in ms. Once a stream is being served, the
   * total `timeoutMs` deadline disarms — one flat deadline kills a healthy long generation at
   * minute two while letting a dead stream hang until the same minute two — and this watchdog
   * aborts only when NO byte arrives for this long. 0 keeps the old single-deadline behavior.
   * Default 90000 (fork-validated in freellmapi). Adoption review §1.2.
   */
  stallTimeoutMs?: number;
  /** Resolved non-streamed first-byte/header deadline; absent means no separate first-byte deadline. */
  firstByteTimeoutMs?: number;
  /** "free": wholly free/free-tier catalog. "mixed": catalog contains free and paid models. */
  tierType?: ProviderTierType;
  /**
   * Operator-asserted rate limits (spec §4 rung 3, basis "configured"). The provider-level block
   * is the default for every credential of this provider; a slot's own `limits` overrides it per
   * credential; a `models` entry overrides per deployment — each axis independently. See
   * `src/configured-limits.ts`. These never refuse a request by themselves; they feed the
   * availability/headroom surfaces.
   */
  limits?: ProviderLimitsConfig;
  /**
   * Wire-shape quirks this host's own request validator enforces. Absent keys fall back to a
   * labelled base-host default (`resolveToolCallIdMode`, `resolveThoughtSignatureMode`); an
   * explicit value always wins.
   */
  compat?: ProviderCompatConfig;
  /** Resolved upstream wire mode. Absent on hand-built targets means `chat`. */
  wire?: ProviderWireMode;
  /** Web URL where users can sign up or obtain API keys. */
  signupUrl?: string;
}

/**
 * How an inbound request's `model` maps to a provider + backend model.
 *  - `default`: fallback "provider/model" spec (string or array of target specs) when nothing else matches.
 *  - `tiers`: Claude tier name ("opus"/"sonnet"/"haiku"/"fable") → "provider/model" spec or array.
 *  - `pools`: named candidate list addressed as "pool/<name>" — the ranked, discovery-friendly
 *    alternative to pinning one model. A pool resolves to ALL its specs, so `benchmarkSort` ranks
 *    them and the existing failover walks them in order. This is the only routing form that lets a
 *    caller say "the best available coding model" instead of naming one; a bare namespaced spec is
 *    deliberately verbatim and never ranked.
 * A request may also address a provider directly with a namespaced model id
 * ("nim/z-ai/glm-5.2") — the prefix picks the provider, the rest is the model.
 */
export interface Routing {
  default: string | string[];
  tiers: Record<string, string | string[]>;
  pools?: Record<string, string[]>;
  /** Dynamic pool policies are normalized separately from their materialized target arrays. */
  poolPolicies?: Record<string, PoolPolicy>;
  /**
   * Pool → the specs in its DEGRADE TAIL: live members below the pool's effort band, appended so
   * an exhausted band still has somewhere to go.
   *
   * Materialized alongside `pools`, never written to config.json — it is derived state, and the
   * same refresh that rebuilds a pool rebuilds this. It exists so a served response can say the
   * answer came from below the requested band: degrading automatically is only acceptable if it is
   * never silent, since a capability downgrade that reads as an ordinary success is indistinguishable
   * from having got what you asked for.
   */
  poolDegraded?: Record<string, string[]>;
  /**
   * Tier → spec for SUBAGENT requests only (`cc_is_subagent=true`). Lets the dispatcher pick a
   * destination with the one per-call knob it actually has — the Agent tool's `model` enum
   * (sonnet|opus|haiku|fable) — without writing an agent file. `default` catches anything that
   * matches no tier. Main-conversation requests never consult this, which is what keeps
   * `routing.tiers` free to stay on an Anthropic passthrough.
   */
  subagents?: Record<string, string>;
  /**
   * Offload admission. The legacy boolean is a global subagent-only switch. The object form is
   * independently keyed by originating client (`claude`, `codex`, or a future name), and each
   * rule chooses whether it applies to marked subagents only or to every conversation from that
   * client. **Default false** in either form.
   */
  offload?: OffloadConfig;
  benchmarkSort?: boolean;
  /** Ephemeral session affinity. Boolean shorthand uses the 30m/1,000-entry defaults. */
  sticky?: StickyConfig;
  /**
   * Quota-as-demotion enforcement (spec §5.4 / Gap 12). `enforce` (default true) lets a SPENT
   * quota demote a candidate to the cooling band — provider-stated observations and
   * operator-declared limits only. `enforceLearned` (default false) additionally admits limits
   * LEARNED from vendor prose (decision M2): display-only until this is set to true.
   *
   * A demotion never drops and never refuses — it only reorders, expiring at the resetsAt the
   * evidence stated. Unknown quota has no effect whatsoever.
   */
  quota?: QuotaEnforcementConfig;
    /** Latency demotion policy. Default on; reorders only and has no effect without enough samples. */
  latency?: LatencyDemotionConfig;
    /**
   * Hedging policy. Default on for free deployments with known pricing; may duplicate one in-flight
   * request and aborts the loser once a winner commits.
   */
  hedge?: HedgeConfig;
    /** Probation policy for under-sampled free deployments. Default on; reorders only. */
  probation?: ProbationConfig;
    /** Self-pacing policy from stated/learned rate ceilings. Default on; reorders only. */
  pacing?: PacingConfig;
    /** Post-commit sustained-slow-stream watchdog. Default on; `false` disables it. */
  crawl?: CrawlWatchdogConfig;
  /**
   * Background lane re-probing (owner decision 2026-08-29,
   * docs/history/quota-reprobe-design-2026-08-29.md): keeping lane metadata fresh is the relay's own
   * job, the way the ping loop already does for HTTP. **Default ON** — catalog probes are
   * metadata commands that spend no quota, and quota probes fire only for buckets carrying an
   * ACTIVE recorded death (an alive lane is re-tested by real use for free). Boolean shorthand
   * toggles `enabled` with the default intervals. Absent on a hand-built `Config` means the
   * defaults too — the cadence resolves absence itself.
   */
  laneProbe?: LaneProbeSettings;
  /**
   * The automatic dispatch lane WALK (owner request 2026-09-06,
   * docs/history/dispatch-lane-walk-design-2026-09-06.md). **Default ON.**
   *
   * Before it, `dispatch` ran ONE lane and reported a failure when that lane was slow; the calling
   * agent then picked the next lane by hand, which is the friction the owner reported. With it,
   * the relay walks the ladder past a lane only after it has remained idle for `idleMs` with no
   * relay traffic, output, owned-process CPU increase or working-tree change; it pins the lane
   * that answers and demotes the lane it left.
   *
   * ⚠ Read ONLY by `llm-relay mcp`, exactly like `mcp` below — the MCP walk owns delegation
   * policy even when D1 asks the daemon's token-gated broker to own the physical process tree.
   * No PUBLIC MODEL HTTP turn spawns a lane. The daemon also reads the PIN and DEMOTION those
   * walks record, because ordering a ladder is not choosing to delegate.
   *
   * `false` is the shorthand for `{ enabled: false }` and restores the pre-walk behaviour exactly:
   * one lane per call, no memory.
   */
  dispatchWalk?: DispatchWalkSettings;
  /**
   * Settings for `llm-relay mcp`, the stdio MCP server that exposes the dispatch verb to any MCP
   * host. Read ONLY by that server — the daemon never consults this block, because the daemon
   * never serves MCP and never spawns a lane for an HTTP turn.
   *
   * Absent means every default: the lane runs in the MCP server's own working directory unless the
   * caller names another, and any existing directory is accepted.
   */
  mcp?: McpSettings;
  /**
   * Ordered dispatch ladder consulted by `/dispatch` — which LANE a host agent should hand a
   * whole delegated task to, and in what order to fall back. Distinct from `subagents`, which
   * routes one HTTP turn: a ladder rung may be an agent CLI that never traverses this proxy,
   * because its quota is client-bound and only the vendor's own binary can spend it.
   *
   * Absent means the relay expresses no opinion and dispatch order stays the host's to choose.
   */
  ladder?: LadderRung[];
  /** Tier-specific dispatch ladders. `dispatch --tier <name>` selects one. */
  ladders?: Record<string, LadderRung[]>;
  /**
   * How to reach a `relay` rung's spec by SHELLING OUT, for a host whose own traffic does not
   * reach this relay (see `src/host-routing.ts`). `/dispatch` substitutes the rung's spec into
   * `{spec}` and the task into `{task}`, and hands back an ordinary `cli` invoke.
   *
   * Declared, never invented: the relay must not learn what a `claude` binary is or how to
   * address one — that is the provider/model-agnostic invariant applied to lane rendering. Absent
   * means no transposition is possible, and such rungs are reported unreachable rather than
   * quietly replaced with something the operator never authorised.
   */
  cliLane?: CliLaneTemplate;
}

export interface StickyRoutingConfig {
  enabled: boolean;
  ttlMs?: number;
  maxSessions?: number;
}

export type StickyConfig = boolean | StickyRoutingConfig;

/**
 * `routing.quota`. Both keys are optional booleans with deliberate defaults: enforcement of
 * provider-stated/derived-from-configured figures is ON unless switched off (decision M1), and
 * learned prose parses stay display-only unless explicitly admitted (decision M2). An object with
 * neither key is legal and means exactly the defaults — writing it down is documentation, not a
 * behaviour change.
 *
 * G2 adds `hardCaps` (default true): an operator who wrote a `hard` block inside a `limits`
 * declaration meant it, so the refusal ceilings are live unless this switch turns every one of
 * them into a soft limit. false demotes nothing per request and logs nothing.
 */
export interface QuotaEnforcementConfig {
  /** Default true. false disables quota demotion entirely. */
  enforce?: boolean;
  /** Default false. true additionally lets `derived:learned` figures gate routing. */
  enforceLearned?: boolean;
  /** Default true. false treats every `hard` cap as an ordinary (soft) configured limit. */
  hardCaps?: boolean;
}

/**
 * `routing.latency`: one-way demotion of sufficiently sampled slow candidates. It reorders only;
 * nothing is dropped or refused. `false` disables the term.
 */
export interface LatencyDemotionConfig {
  /** Default true. false disables latency demotion entirely. */
  enabled?: boolean;
  /** Fallback ceiling: measured absolute p95 in ms. Above it, the candidate is demoted. */
  p95Ms?: number;
  /**
   * PRIMARY ceiling: measured p95 latency per OUTPUT TOKEN, in ms.
   *
   * Absolute latency cannot compare a probe with a generation - a probe asks for one token, a real
   * request may produce hundreds and amortise the same fixed overhead. The per-token rate is the
   * fair figure, so it is tested first, over real request samples only.
   */
  msPerToken?: number;
  /** Minimum measurable samples before latency may demote anything at all. */
  minSamples?: number;
}

/**
 * `routing.hedge`: start the next free candidate beside a slow in-flight attempt. Hedging may
 * duplicate work, so unknown-price candidates are treated as paid and are not hedged. `false`
 * disables the feature.
 */
export interface HedgeConfig {
  /** Default true. false disables hedging entirely. */
  enabled?: boolean;
  /**
   * The floor's flat component, in ms. Owner direction 2026-09-04: the floor is no longer flat on
   * its own — see `msPerInputToken` — but this still bounds the SMALL-prompt case, where the
   * size-scaled component is negligible. Without it a deployment with a tiny p90 is hedged on
   * ordinary noise, and a fast pool duplicates almost every request.
   */
  minFloorMs?: number;
  /**
   * LEGACY alias of `minFloorMs`, kept for backward compatibility — an operator config written
   * before 2026-09-04 (`{"floorMs": 8000}`) keeps loading and keeps meaning exactly what it always
   * meant: the floor never drops below 8000 ms. Honoured only when `minFloorMs` itself is absent;
   * `resolveHedgeSettings` in `hedge-trigger.ts` is the ONE place that resolves the alias, so a new
   * caller of that function can never re-decide the precedence.
   */
  floorMs?: number;
  /**
   * The floor's size-scaled component, in ms per estimated INPUT token
   * (`estimateRequestTokens` in `metadata.ts`). Without it a large prompt is hedged against the
   * time it simply takes a healthy deployment to read the prompt, not against real slowness.
   */
  msPerInputToken?: number;
  /** How far past the expected time an attempt must run before a hedge starts. */
  margin?: number;
  /** Minimum samples before a measured statistic may set the bar instead of the floor. */
  minSamples?: number;
}

/**
 * `routing.probation`: temporarily lead with under-sampled free candidates so they gather served
 * request data. Breaker/quota/latency evidence still outranks probation. `false` disables it.
 */
export interface ProbationConfig {
  /** Default true. false disables the probation band entirely. */
  enabled?: boolean;
  /** Minimum SERVED-REQUEST samples before a free deployment counts as measured. Default 5. */
  minSamples?: number;
}

/**
 * `routing.pacing`: demote a credential/model cell when this relay's trailing-window attempts
 * reach a stated or learned rate ceiling. Pacing reorders only and drains automatically.
 */
export interface PacingConfig {
  /** Default true. false disables the paced band entirely. */
  enabled?: boolean;
}

/**
 * `routing.crawl`: abort a committed stream whose sustained per-token rate over a full trailing
 * window is below the configured threshold after enough output has been observed.
 */
export interface CrawlWatchdogConfig {
  /** Default true. false disables the crawl watchdog entirely. */
  enabled?: boolean;
  /**
   * The threshold, in ms per output token. A committed stream whose measured rate over a FULL
   * trailing window (`windowMs / tokensInWindow`) exceeds this is CRAWLING and gets aborted.
   */
  msPerToken?: number;
  /** Width, in ms, of the trailing window the rate is measured over — judged only once this much
   * time has elapsed since commit. */
  windowMs?: number;
  /** Minimum output tokens that must be observed SINCE COMMIT — across the whole stream, not just
   * the trailing window — before any judgement runs at all. */
  minTokens?: number;
}

/**
 * Template for rendering a `relay` rung as a shelled-out CLI command.
 *
 * Same executable shape as a `cli` rung — the host runs `command` with `args`, applying `env`
 * (string sets, `null` unsets) — with one extra placeholder: `{spec}`, replaced by the rung's
 * routing spec so ONE template serves every pool and pinned model in the ladder.
 */
export interface CliLaneTemplate {
  command: string;
  /** Must contain `{spec}`; `{task}` too, on the same reasoning as a cli rung's args. */
  args: string[];
  /** Applied by the host when spawning. Placeholders are never substituted here. */
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

/**
 * One rung of `routing.ladder`.
 *
 * `cli` rungs are executed by the HOST (the relay never spawns a process — it is a proxy, not a
 * process supervisor); `relay` rungs are addressed through this proxy in the ordinary way.
 * `quota` names the balance a rung draws on so that rungs sharing one are cooled down together
 * and rungs that merely share a binary are not: one CLI can meter two model families against
 * two independent balances, and treating those as one bucket would skip a live lane.
 */
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
  /**
   * cli rungs: environment the HOST applies when spawning the command. A string value sets the
   * variable; `null` unsets an inherited one. Both directions are load-bearing for the lane this
   * exists for — a `claude -p` child routed through this proxy: `ANTHROPIC_BASE_URL` must be SET
   * (a terminal-spawned `claude` honours it even though Claude Desktop pins its own sessions to
   * api.anthropic.com), and `CLAUDECODE`/`CLAUDE_CODE_SSE_PORT`/`CLAUDE_CODE_ENTRYPOINT`/
   * `ANTHROPIC_API_KEY` must be UNSET or a child spawned from inside a Claude session inherits
   * the parent's harness wiring and refuses to start cleanly. The task placeholder is never
   * substituted here — env values are operator-authored routing, not task content.
   */
  env?: Record<string, string | null>;
  /**
   * cli rungs: the most jobs this MCP server process will run against THIS rung at once. A
   * dispatch walk whose turn reaches a rung already at this many spawned processes SKIPS it for
   * that walk rather than starting a competing one — see `mcp/lane-runner.ts` `LaneJobStore.inFlight`
   * and `mcp/server.ts`'s walk. Absent means unbounded, which is the byte-for-byte pre-existing
   * behaviour: nothing here changes for an operator who never sets it.
   *
   * ⚠ The ADMISSION count remains per MCP SERVER PROCESS by design, even though D1 moves physical
   * process ownership to the daemon. The originating MCP job store counts its own/recovered jobs;
   * another simultaneously-live MCP process is not folded into that count. Two host sessions can
   * therefore still exceed this figure together: this is a per-host cap, not a machine-wide semaphore.
   */
  maxConcurrent?: number;
  /**
   * Legacy compatibility key. Parsed values warn and have NO routing effect; dispatch derives lane
   * capability from synced model evidence (or the dynamic pool's effort band). Retained in the type
   * so programmatic/older configs remain structurally readable while the key is phased out.
   */
  capability?: EffortLevel;
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
   * RESOLVED time-to-first-byte deadline for a non-streamed attempt (`resolveFirstByteTimeoutMs`)
   * — an explicit `ProviderConfig.firstByteTimeoutMs`, or `stallTimeoutMs` as the default, or
   * absent when neither is set. Resolved here so the attempt runner is handed a number and never
   * re-derives a default from two provider fields. Absent (a hand-built target) means no
   * first-byte deadline, the pre-2026-09-09 behaviour byte for byte.
   */
  firstByteTimeoutMs?: number;
  /**
   * RESOLVED outbound tool-call-id shape (`resolveToolCallIdMode`) — an explicit
   * `compat.toolCallIds` or the labelled base-host default. Resolved here so the request mapper
   * is handed a mode and never a provider identity to re-derive one from. Absent (a hand-built
   * target) reads as `"preserve"`, which is the pre-2026-08-23 behaviour byte for byte.
   */
  toolCallIds?: ToolCallIdMode;
  /**
   * RESOLVED thought-signature mode (`resolveThoughtSignatureMode`) — an explicit
   * `compat.thoughtSignature` or the labelled base-host default. Resolved here for the same reason
   * as `toolCallIds`: the request mapper is handed a mode, never a provider identity to sniff one
   * from. Absent (a hand-built target) reads as `"none"` — the pre-2026-08-23 bytes exactly.
   */
  thoughtSignature?: ThoughtSignatureMode;
  /**
   * RESOLVED wire mode (`ProviderConfig.wire`, absent ⇒ `"chat"`) — carried onto the target at
   * resolution time, exactly like `toolCallIds`/`thoughtSignature`, so `src/backend.ts` is handed
   * a mode and never re-derives one from provider identity. Absent (a hand-built target) reads as
   * `"chat"`, the pre-2026-09-09 behaviour byte for byte.
   */
  wire?: ProviderWireMode;
  /**
   * RESOLVED reasoning-mapping mode (`resolveReasoningMode`) — an explicit `compat.reasoning` or
   * the labelled base-host default (`api.deepseek.com` ⇒ `"deepseek"`). Resolved here for the same
   * reason as `toolCallIds`/`thoughtSignature`: the request mapper is handed a mode, never a
   * provider identity to sniff one from. Absent (a hand-built target) reads as `"none"` — the
   * pre-2026-09-10 bytes exactly.
   */
  reasoning?: ReasoningMode;
  /**
   * The routed POOL's effort band, when the request was resolved through a single dynamic pool
   * whose policy declares an `effort`. Stamped at resolution time so the request mapper can map
   * "pool effort → `reasoning_effort`" for a `"deepseek"` target without reaching back into
   * routing. Absent for a direct spec or a static pool — then the mapper has no effort to map and
   * a deepseek target defaults its thinking OFF.
   */
  effort?: EffortLevel;
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
   * Ranked reshaper candidates, from `reshaper: { pool: "<name>" }`. Tried in order, so a single
   * de-listed model cannot take repair down with it — the whole point of not pinning one model.
   * `reshaper` is candidates[0] so every existing single-reshaper path keeps working unchanged.
   */
  reshaperCandidates?: ReshaperConfig[];
  /** Dynamic reshaper pool resolved lazily after its catalog-backed tail is materialized. */
  reshaperPool?: { name: string; timeoutMs?: number };
  repair: { maxAttempts: number; destructiveTools: string[] };
  /**
   * Wall-clock ceiling (ms) on STARTING further failover attempts within one request's pool
   * walk. The first two attempts are always allowed and an attempt already in flight is never
   * aborted — the budget bounds the walk, not the answer. 0 disables. Absent ⇒ the server's
   * DEFAULT_WALK_BUDGET_MS (45s).
   */
  walkBudgetMs?: number;
  /** Maximum inbound request-body size in bytes. Absent ⇒ 36 MiB. */
  maxBodyBytes?: number;
  log: { level: "metadata" | "silent"; file: string | null; maxBytes?: number };
  /**
   * Providers the onboarding nudge must stop asking about (`leave_me_alone` in config.json).
   *
   * Scope is deliberately narrow: it silences the "❌ Missing Key / 👉 get one here" prompt in
   * `llm-relay onboard`, and nothing else. Suppressed providers still appear in `llm-relay keys`,
   * in `/registry` and in every status surface — silencing a nudge is not hiding state, and a
   * provider that vanished from the status commands would be undebuggable later.
   *
   * Names that match no known provider are legal (see `parseLeaveMeAlone`).
   */
  leaveMeAlone?: string[];
  /** Path this config was loaded from. Set by `loadConfig`; absent for hand-built test configs.
   *  Only consumer is the runtime offload toggle, which persists back to the same file. */
  sourcePath?: string;
  /**
 * Config-file mtime at the last successful load/reload, paired with `sourcePath` for staleness
 * reporting. Non-enumerable and absent for hand-built configs.
 */
  sourceMtimeMs?: number;
  /**
   * Non-fatal load-time problems (a provider disabled for an unset `${ENV}`, a pool member
   * dropped with it). Present so startup can print them — a degraded config that boots
   * silently is how you end up running on one provider without noticing.
   */
  warnings?: string[];
}

/** Background lane re-probing settings — see the `laneProbe` field doc on `Routing`. */
export interface LaneProbeSettings {
  enabled: boolean;
  /** Gate between quota probes of ONE dead bucket. A probe spends that lane's quota. */
  quotaIntervalMs: number;
  /** Gate between catalog re-probes of ONE lane. Metadata commands, no quota spent. */
  catalogIntervalMs: number;
}

/** Automatic dispatch lane-walk settings — see the `dispatchWalk` field doc on `Routing`. */
export interface DispatchWalkSettings {
  enabled: boolean;
  /**
 * Maximum observed inactivity before a walk may stop a non-final lane. Activity includes relay
 * traffic, lane output, owned-process CPU, or working-tree change. The final lane is never idle-stopped.
 */
  idleMs: number;
  /**
   * Legacy pre-v0.84 attempt-budget floor. Retained and validated so existing configs keep loading,
   * but it no longer affects lane stopping; an explicit setting produces a load warning.
   */
  attemptMs: number;
  /** Legacy agent-mode budget floor; retained for compatibility, no longer used to stop a lane. */
  agentAttemptMs: number;
  /** Legacy attempt-budget quantile; retained for compatibility, no longer used to stop a lane. */
  attemptQuantile: number;
  /**
   * Sample floor before a more-specific lane-history window is trusted over a legacy fallback,
   * and the minimum samples each side of recent-vs-history outlier demotion needs. Default 5.
   * Too little history means no opinion, never "slow".
   */
  attemptMinSamples: number;
  /**
   * How many lanes one dispatch may try. Bounded so a ladder of a dozen dead rungs cannot consume
   * a dozen attempts before reporting; the walk states how many it tried and how many it skipped,
   * because a silent cap reads as "everything was tried" when it was not.
   */
  maxLanes: number;
  /** How long a lane that answered is preferred. See `lane-affinity.ts` for the promote-only rule. */
  pinMs: number;
  /** How long a lane the walk abandoned is ordered behind undemoted lanes. */
  demoteMs: number;
  /**
 * Recent-versus-earlier own-history outlier demotion. Default on; `false` disables the reordering
 * term while retaining recorded history.
 */
  outlier: false | DispatchWalkOutlierSettings;
}

/**
 * Automatic dispatch outlier-demotion settings — see the `outlier` field doc on
 * `DispatchWalkSettings`.
 */
export interface DispatchWalkOutlierSettings {
  /**
   * How many of the window's most recent samples form the "recent" half of the comparison.
   * Default 5. Both halves need at least `attemptMinSamples` samples or the rule is silent.
   */
  recentCount: number;
  /**
   * Which point of the EARLIER window the recent median is judged against. Default 0.8;
   * strictly inside (0, 1).
   */
  historyQuantile: number;
  /**
   * How far above the earlier quantile the recent median must sit to demote. Default 2.5
   * (calibrated — see `DEFAULT_OUTLIER_FACTOR` in `lane-affinity.ts`). Greater than 1.
   */
  outlierFactor: number;
}

/** `llm-relay mcp` settings — see the `mcp` field doc on `Routing`. */
export interface McpSettings {
  /**
   * Directories a caller-supplied `cwd` must sit under. Absent or empty ⇒ no bound beyond the
   * directory existing.
   *
   * ⚠ Offered, never imposed. The MCP caller is already a trusted agent on the operator's own
   * machine, and defaulting to a bound would make the tool useless for its stated purpose. Whether
   * to narrow it is the operator's decision to record here, not this file's to assume.
   */
  allowedRoots?: string[];
  /**
   * Ceiling (ms) on how long one `dispatch` tool call blocks before handing back a pollable job
   * id. A `waitMs` above it is clamped to it (and the clamp announced); a non-positive,
   * non-finite or non-numeric `waitMs` is refused. Absent ⇒ `DEFAULT_MCP_MAX_WAIT_MS`.
   */
  maxWaitMs?: number;
  /**
   * Ceiling (ms) on the blocking wait for a host that tolerates a long tool call and asked for
   * progress (`BLOCKING_WAIT_CLIENTS` in `mcp/server.ts`). Such a host gets the answer in ONE call,
   * the way its own subagents answer. `0` turns the blocking wait off, so every host gets
   * `maxWaitMs`. Absent ⇒ `DEFAULT_MCP_BLOCKING_WAIT_MS`.
   */
  blockingWaitMs?: number;
}

/**
 * Default `routing.mcp.blockingWaitMs` — 25 minutes.
 *
 * Measured and documented 2026-09-17 (`docs/history/mcp-host-timeouts-2026-09-17.md`): Claude Code's
 * wall-clock tool limit (`MCP_TOOL_TIMEOUT`) defaults to about 28 hours, and a 240 s call succeeded
 * headless with and without progress. Its stdio idle timeout is 30 minutes, and the documentation
 * says a progress notification resets it. The default stays under 30 minutes so the call survives
 * even if that reset does not happen. A lane still running at the cap degrades to polling.
 */
export const DEFAULT_MCP_BLOCKING_WAIT_MS = 1_500_000;

/**
 * Default `routing.mcp.maxWaitMs` — the longest one `dispatch` tool call blocks before handing
 * back a job id to poll.
 *
 * It must end before the SHORTEST host limit, because above a host's limit the host fails the call
 * AND loses the job handle. Two limits are measured on this machine: Claude Code fails an MCP call
 * somewhere between 45 s and 100 s, and Codex's code-mode `exec` tool yields its script at 31.0 s
 * with empty output ("Script running with cell ID N / Wall time 31.0 seconds"). The 2026-09-10
 * transcript sweep counted 29 of 266 first Codex dispatch calls that lost their job id that way
 * while this default was 40 s (`docs/history/dispatch-giveup-diagnosis-2026-09-10.md` §8). 25 s sits under
 * both. The tool description names the config key rather than this figure, so an operator override
 * never leaves the text stale.
 */
export const DEFAULT_MCP_MAX_WAIT_MS = 25_000;
