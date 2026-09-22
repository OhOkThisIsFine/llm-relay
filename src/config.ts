import { readFileSync, statSync } from "node:fs";
import { POOL_PREFIX, splitSpec } from "./spec.js";
import { parseRouting } from "./config/routing-parser.js";
import { rankTargetsByBenchmark } from "./benchmarks.js";
import {
  credentialCandidateEnvNames,
  credentialState,
  keyIsPresent,
} from "./authEnv.js";
import { CREDENTIAL_LABEL_PATTERN, makeCredentialId } from "./credential-id.js";
import { parseConfiguredLimits } from "./configured-limits.js";
import {
  providerCredentialSlots,
  resolveCredentialSlot,
  type ProviderCredentialConfig,
} from "./credential-fleet.js";
import {
  createKeystoreResolutionWalk,
  keystoreStatus,
  listEntries,
  type KeystoreOptions,
} from "./keystore.js";
import {
  CLAUDE_TIER_NAMES,
  type Mode,
  type AuthHeader,
  type Kind,
  type OffloadRule,
  type ReshaperConfig,
  type CredentialMode,
  type ToolCallIdMode,
  type ThoughtSignatureMode,
  type ReasoningMode,
  type EffortLevel,
  type ProviderCompatConfig,
  PROVIDER_WIRE_MODES,
  type ProviderWireMode,
  type ProviderConfig,
  type Routing,
  type RequestHeaders,
  type ResolvedTarget,
  type Config,
} from "./config-types.js";

// Configuration vocabulary lives in config-types.ts. These leaf/parser symbols are re-exported
// from config.ts to preserve the public import surface without introducing parser cycles.
export { AUTO_MODEL, POOL_PREFIX, splitSpec } from "./spec.js";
export { DEFAULT_LANE_PROBE, parseOffload, parseRouting } from "./config/routing-parser.js";

export {
  EFFORT_LEVELS,
  CLAUDE_TIER_NAMES,
  type Mode,
  type AuthHeader,
  type Kind,
  type ProviderTierType,
  type EffortLevel,
  type ClaudeTierName,
  type OffloadScope,
  type OffloadRule,
  type OffloadConfig,
  type ReshaperConfig,
  type CredentialMode,
  type ToolCallIdMode,
  type ThoughtSignatureMode,
  type ReasoningMode,
  type ProviderCompatConfig,
  type ProviderWireMode,
  type ProviderConfig,
  type Routing,
  type StickyRoutingConfig,
  type StickyConfig,
  type QuotaEnforcementConfig,
  type LatencyDemotionConfig,
  type HedgeConfig,
  type CliLaneTemplate,
  type PoolPolicy,
  type LadderRung,
  type RequestHeaders,
  type ResolvedTarget,
  type Config,
  type DispatchWalkSettings,
  type LaneProbeSettings,
  type McpSettings,
} from "./config-types.js";

/** The closed set of `compat` keys, so an unknown one can be named in the error. */
const COMPAT_KEYS = ["toolCallIds", "thoughtSignature", "reasoning"] as const satisfies readonly (keyof ProviderCompatConfig)[];

const TOOL_CALL_ID_MODES: readonly ToolCallIdMode[] = ["preserve", "strict9"];

const THOUGHT_SIGNATURE_MODES: readonly ThoughtSignatureMode[] = ["none", "sentinel"];

const REASONING_MODES: readonly ReasoningMode[] = ["none", "deepseek"];

/** Validate every declared compatibility key; unknown keys and values are load errors. */
function parseProviderCompat(raw: unknown, where: string): ProviderCompatConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be an object`);
  }
  const out: ProviderCompatConfig = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(COMPAT_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `${where}.${key} is not a known compat option (known: ${COMPAT_KEYS.join(", ")})`,
      );
    }
    if (key === "toolCallIds") {
      if (typeof value !== "string" || !TOOL_CALL_ID_MODES.includes(value as ToolCallIdMode)) {
        throw new Error(`${where}.toolCallIds must be one of: ${TOOL_CALL_ID_MODES.join(", ")}`);
      }
      out.toolCallIds = value as ToolCallIdMode;
    }
    if (key === "thoughtSignature") {
      if (typeof value !== "string" || !THOUGHT_SIGNATURE_MODES.includes(value as ThoughtSignatureMode)) {
        throw new Error(`${where}.thoughtSignature must be one of: ${THOUGHT_SIGNATURE_MODES.join(", ")}`);
      }
      out.thoughtSignature = value as ThoughtSignatureMode;
    }
    if (key === "reasoning") {
      if (typeof value !== "string" || !REASONING_MODES.includes(value as ReasoningMode)) {
        throw new Error(`${where}.reasoning must be one of: ${REASONING_MODES.join(", ")}`);
      }
      out.reasoning = value as ReasoningMode;
    }
  }
  return Object.keys(out).length > 0 ? out : {};
}

/** Reject unknown wire modes and declarations on providers that do not speak the OpenAI wire. */
function parseProviderWire(raw: unknown, kind: Kind, name: string): ProviderWireMode | undefined {
  if (raw === undefined) return undefined;
  if (kind === "anthropic") {
    throw new Error(
      `config.providers.${name}.wire is only valid on an openai-kind provider (this provider is anthropic-kind)`,
    );
  }
  if (typeof raw !== "string" || !PROVIDER_WIRE_MODES.includes(raw as ProviderWireMode)) {
    throw new Error(`config.providers.${name}.wire must be one of: ${PROVIDER_WIRE_MODES.join(", ")}`);
  }
  return raw as ProviderWireMode;
}

/** An explicitly declared first-byte deadline must be a positive integer; never silently ignore it. */
function parseProviderFirstByteTimeout(raw: unknown, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`config.providers.${name}.firstByteTimeoutMs must be a positive integer`);
  }
  return raw;
}

/** Use the explicit first-byte deadline, otherwise the stall timeout; absent values remain absent. */
export function resolveFirstByteTimeoutMs(p: { stallTimeoutMs?: number; firstByteTimeoutMs?: number }): number | undefined {
  return p.firstByteTimeoutMs !== undefined ? p.firstByteTimeoutMs : p.stallTimeoutMs;
}

/** The host of a base URL, lowercased — or null when it is not a URL at all. */
function baseHost(base: string): string | null {
  try {
    return new URL(base).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Is this base URL's host mistral's — `api.mistral.ai`, `codestral.mistral.ai`, any of them? */
function isMistralHost(base: string): boolean {
  const host = baseHost(base);
  if (host === null) return false;
  return host === "mistral.ai" || host.endsWith(".mistral.ai");
}

/** Match the Generative Language API only; other Google API hosts have different wire contracts. */
function isGoogleGenerativeLanguageHost(base: string): boolean {
  return baseHost(base) === "generativelanguage.googleapis.com";
}

/**
 * Default Mistral hosts to strict nine-character tool IDs; explicit compatibility settings win
 * in either direction. The provider evidence is documented in openai-request.ts.
 */
export function resolveToolCallIdMode(p: { base: string; compat?: ProviderCompatConfig }): ToolCallIdMode {
  if (p.compat?.toolCallIds !== undefined) return p.compat.toolCallIds;
  return isMistralHost(p.base) ? "strict9" : "preserve";
}

/**
 * Default the Generative Language API to sentinel signatures; explicit compatibility settings
 * win in either direction. The provider evidence is documented in openai-request.ts.
 */
export function resolveThoughtSignatureMode(p: { base: string; compat?: ProviderCompatConfig }): ThoughtSignatureMode {
  if (p.compat?.thoughtSignature !== undefined) return p.compat.thoughtSignature;
  return isGoogleGenerativeLanguageHost(p.base) ? "sentinel" : "none";
}

/** Is this base URL DeepSeek's own API host? Deliberately the ONE exact host. */
function isDeepSeekHost(base: string): boolean {
  return baseHost(base) === "api.deepseek.com";
}

/**
 * Resolve provider reasoning compatibility. DeepSeek's own API defaults to its native reasoning
 * mapping; explicit `compat.reasoning` overrides the host-derived default in either direction.
 */
export function resolveReasoningMode(p: { base: string; compat?: ProviderCompatConfig }): ReasoningMode {
  if (p.compat?.reasoning !== undefined) return p.compat.reasoning;
  return isDeepSeekHost(p.base) ? "deepseek" : "none";
}

/**
 * Claude Code's subagent attribution marker, verified on wire in 2.1.220. Tier names alone
 * cannot distinguish a child request from a human conversation using the same model.
 */
const SUBAGENT_MARKER = "cc_is_subagent=true";

/**
 * Claude Code's documented child-agent header. Check it alongside the body marker: middleware
 * can strip the header, while disabled attribution can remove the marker. Neither is required
 * when the other supplies evidence of a child request.
 */
const CLAUDE_AGENT_ID_HEADER = "x-claude-code-agent-id";

/** Codex's local Responses client marks child-agent turns in this JSON header. */
const CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";
const CODEX_SUBAGENT_REQUEST_KIND = "subagent";

/** Case-insensitive single-value header lookup (node lowercases, hand-built maps may not). */
function headerValue(headers: RequestHeaders | undefined, name: string): string | undefined {
  const raw = Object.entries(headers ?? {}).find(([n]) => n.toLowerCase() === name)?.[1];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Routing directive the dispatcher may put on its own line in a subagent prompt. */
const RELAY_DIRECTIVE = /^[ \t]*@relay:[ \t]*(\S+)[ \t]*$/m;

/** True when this request is a marked Claude Code or local Codex child turn. */
export function isSubagentRequest(reqJson: unknown, headers?: RequestHeaders): boolean {
  if (typeof reqJson === "object" && reqJson !== null) {
    const system = (reqJson as { system?: unknown }).system;
    // The marker contains no newline, so it cannot span joined block boundaries.
    if (typeof system === "string") {
      if (system.includes(SUBAGENT_MARKER)) return true;
    } else if (Array.isArray(system)) {
      for (const b of system) {
        const text = typeof b === "string" ? b : ((b as { text?: unknown }).text ?? "");
        if (typeof text === "string" && text.includes(SUBAGENT_MARKER)) return true;
      }
    }
  }

  // A nonblank child-agent header is independent evidence; its value is not a user identity.
  const agentId = headerValue(headers, CLAUDE_AGENT_ID_HEADER);
  if (typeof agentId === "string" && agentId.trim().length > 0) return true;

  // Unrecognized Codex metadata does not establish a child request. Do not forward this header.
  const metadataText = headerValue(headers, CODEX_TURN_METADATA_HEADER);
  if (typeof metadataText !== "string") return false;
  try {
    const metadata = JSON.parse(metadataText) as unknown;
    return typeof metadata === "object" && metadata !== null &&
      (metadata as { request_kind?: unknown }).request_kind === CODEX_SUBAGENT_REQUEST_KIND;
  } catch {
    return false;
  }
}

/**
 * Read and optionally strip a directive from the first message's string content or last
 * non-system-reminder text block. Never scan later messages or tool results for routing intent.
 */
export function readRelayDirective(reqJson: unknown, strip = false): string | null {
  if (typeof reqJson !== "object" || reqJson === null) return null;
  const messages = (reqJson as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const firstMsg = messages[0] as { content?: unknown } | undefined;
  if (!firstMsg) return null;
  const content = firstMsg.content;

  if (typeof content === "string") {
    const m = RELAY_DIRECTIVE.exec(content);
    if (!m) return null;
    if (strip) {
      firstMsg.content = content.replace(RELAY_DIRECTIVE, "").replace(/^\n+/, "");
    }
    return m[1]!;
  }
  if (!Array.isArray(content)) return null;

  // Locate the prompt text block — the last text block in messages[0] that is not a system-reminder.
  let promptBlock: { type?: unknown; text?: unknown } | null = null;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type?: unknown; text?: unknown };
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    if (block.text.trim().startsWith("<system-reminder>")) continue;
    promptBlock = block;
    break;
  }

  if (!promptBlock || typeof promptBlock.text !== "string") return null;

  const m = RELAY_DIRECTIVE.exec(promptBlock.text);
  if (!m) return null;
  if (strip) {
    promptBlock.text = promptBlock.text.replace(RELAY_DIRECTIVE, "").replace(/^\n+/, "");
  }
  return m[1]!;
}

/**
 * Require an explicit configured pool or provider, plus a model for OpenAI providers.
 * A Claude-like tier name is not a valid directive: falling back would spend primary quota
 * while appearing to have offloaded the task.
 */
function directiveUnresolvableReason(spec: string, cfg: Config): string | null {
  const names = (o: object | undefined) => Object.keys(o ?? {}).join(", ") || "none";
  const { provider, model } = splitSpec(spec);
  if (provider === POOL_PREFIX) {
    if (model && cfg.routing.pools?.[model]) return null;
    return `names unknown pool "${model ?? ""}" (available: ${names(cfg.routing.pools)})`;
  }
  const p = cfg.providers[provider];
  if (!p) {
    const isDisabled = cfg.warnings?.some((w) => w.includes(`provider "${provider}" DISABLED`));
    if (isDisabled) {
      return `names disabled provider "${provider}" (disabled due to unset environment variable)`;
    }
    return `names unknown provider "${provider}" (available: ${names(cfg.providers)})`;
  }
  if (p.kind === "openai" && !model) return `names openai provider "${provider}" but carries no model id`;
  return null;
}

/** Built-in offload rule keys. Request paths select these names; arbitrary client names do not match. */
export const CLAUDE_CLIENT = "claude";
export const CODEX_CLIENT = "codex";
export const OPENAI_CLIENT = "openai";
export const DEFAULT_CLIENT = "default";

/** Map a relay front-door path to the offload rule key; unknown paths use `default`. */
export function clientForPath(pathname: string): string {
  if (pathname === "/v1/messages" || pathname.startsWith("/v1/messages/")) return CLAUDE_CLIENT;
  if (pathname === "/v1/responses" || pathname === "/responses") return CODEX_CLIENT;
  if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") return OPENAI_CLIENT;
  return DEFAULT_CLIENT;
}

/** Every client name `clientForPath` can produce — the complete set of rule keys a request consults. */
export const FRONT_DOOR_CLIENTS: readonly string[] = [CLAUDE_CLIENT, CODEX_CLIENT, OPENAI_CLIENT, DEFAULT_CLIENT];

/**
 * Explain an unreachable client rule. New unknown keys are errors; existing ones produce a
 * warning so their state stays visible and the operator can disable them.
 */
export function unroutableOffloadClient(
  client: string,
  cfg: Pick<Config, "routing">,
): { fatal: boolean; message: string } | null {
  if (FRONT_DOOR_CLIENTS.includes(client)) return null;
  const doors = FRONT_DOOR_CLIENTS.join(", ");
  const configured = cfg.routing.offload;
  if (typeof configured === "object" && client in configured) {
    return {
      fatal: false,
      message: `rule "${client}" matches no front door — no request ever consults it (front doors: ${doors})`,
    };
  }
  return {
    fatal: true,
    message:
      `no request ever identifies as client "${client}" — the front doors resolve to ${doors}, ` +
      `so this rule would be dead config that silently changes nothing`,
  };
}

/** Return the effective rule for one originating client. Legacy booleans apply everywhere. */
export function offloadRule(cfg: Pick<Config, "routing">, client = CLAUDE_CLIENT): OffloadRule {
  const configured = cfg.routing.offload;
  if (typeof configured === "boolean" || configured === undefined) {
    return { enabled: configured === true, scope: "subagents" };
  }
  return configured[client] ?? configured[DEFAULT_CLIENT] ?? { enabled: false, scope: "subagents" };
}

/** Whether any named client rule is active; used by aggregate status surfaces. */
export function anyOffloadEnabled(cfg: Pick<Config, "routing">): boolean {
  const configured = cfg.routing.offload;
  if (typeof configured === "boolean" || configured === undefined) return configured === true;
  return Object.values(configured).some((rule) => rule.enabled);
}

/**
 * Resolve a subagent override without changing ordinary routing when none applies.
 * An explicit directive on a marked child wins even with offload disabled; otherwise use the
 * enabled rule's tier mapping, then its default. `scope: "all"` also admits main conversations.
 * An unresolvable directive throws rather than silently spending primary quota.
 */
export function subagentSpec(
  reqJson: unknown,
  model: string | null,
  cfg: Config,
  headers?: RequestHeaders,
  client = CLAUDE_CLIENT,
): string | null {
  const isSubagent = isSubagentRequest(reqJson, headers);
  // An explicit directive remains a subagent-only, per-call opt-in. A human conversation must
  // never be able to reroute itself by having matching text in its own prompt.
  const directive = isSubagent ? readRelayDirective(reqJson, true) : null;
  if (directive) {
    const why = directiveUnresolvableReason(directive, cfg);
    if (why !== null) {
      throw new RoutingError(
        `@relay: "${directive}" ${why} — refusing to fall back to routing.default, ` +
          `which would spend primary quota while looking like a successful offload`,
      );
    }
    return directive;
  }
  const rule = offloadRule(cfg, client);
  if (!rule.enabled || (!isSubagent && rule.scope !== "all")) return null;
  const map = cfg.routing.subagents;
  if (!map) return null;
  const tier = model ? detectTier(model) : null;
  return (tier ? map[tier] : undefined) ?? map["default"] ?? null;
}

/**
 * Single default list of tool names that repaired calls may never invoke. Matching is exact, so the
 * entries are concrete tool names rather than destructive-looking substrings.
 */
export const DEFAULT_DESTRUCTIVE = [
  // Claude Code / harness tools that write, delete, or execute.
  "Bash",
  "BashOutput",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  // Codex tools that execute or write.
  "shell_command",
  "apply_patch",
  // Conventional names an MCP server or custom tool may use.
  "rm",
  "delete",
  "delete_file",
  "remove",
  "overwrite",
  "drop",
  "reset",
  "force_push",
];

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
export { DEFAULT_ANTHROPIC_VERSION };

/** Tier aliases matched against requested model IDs. */
const TIER_NAMES = CLAUDE_TIER_NAMES;

/** A routing failure — surfaced to the client as a clean 400, never a crash. */
export class RoutingError extends Error {}

/** Detect the Claude tier a model id belongs to, or null. */
function detectTier(model: string): string | null {
  const m = model.toLowerCase();
  for (const t of TIER_NAMES) if (m.includes(t)) return t;
  return null;
}

/**
 * Resolve pool specs first, then known provider/model specs, tier mappings and the default.
 * Unknown namespaced providers use the default; unknown pools fail during expansion.
 */
function pickSpecs(model: string | null, cfg: Config): string[] {
  if (model) {
    const slash = model.indexOf("/");
    // Pools are checked before providers so the reserved `pool/` prefix can never be
    // shadowed (config load also rejects a provider named "pool"). Expansion — and the
    // loud unknown-pool error — happens in expandPoolSpecs.
    if (slash !== -1) {
      const prefix = model.slice(0, slash);
      if (prefix === POOL_PREFIX || cfg.providers[prefix]) return [model];
      return Array.isArray(cfg.routing.default) ? cfg.routing.default : [cfg.routing.default];
    }
    const tier = detectTier(model);
    if (tier && cfg.routing.tiers[tier]) {
      const val = cfg.routing.tiers[tier]!;
      return Array.isArray(val) ? val : [val];
    }
  }
  return Array.isArray(cfg.routing.default) ? cfg.routing.default : [cfg.routing.default];
}

/**
 * Expand configured pools wherever a routing spec is accepted. Members are provider specs,
 * not nested pools. Unknown pools throw rather than silently falling back to another model.
 */
export function expandPoolSpecs(specs: string[], cfg: Config): string[] {
  const out: string[] = [];
  for (const s of specs) {
    const slash = s.indexOf("/");
    if (slash === -1 || s.slice(0, slash) !== POOL_PREFIX) {
      out.push(s);
      continue;
    }
    const name = s.slice(slash + 1);
    const pool = cfg.routing.pools?.[name];
    if (!pool) {
      throw new RoutingError(
        `no pool "${name}" configured (available: ${Object.keys(cfg.routing.pools ?? {}).join(", ") || "none"})`,
      );
    }
    out.push(...pool);
  }
  return out;
}

/** Resolve a single spec string to a ResolvedTarget. */
function resolveSingleSpec(spec: string, cfg: Config, modelForError: string | null): ResolvedTarget {
  const { provider, model: realModel } = splitSpec(spec);
  const p = cfg.providers[provider];
  if (!p) {
    throw new RoutingError(`no provider "${provider}" configured (routed from model "${modelForError ?? "<none>"}" → "${spec}")`);
  }
  if (p.kind === "openai" && !realModel) {
    throw new RoutingError(`provider "${provider}" is openai and needs a model id (spec "${spec}")`);
  }
  const firstByteTimeoutMs = resolveFirstByteTimeoutMs(p);
  return {
    provider,
    base: p.base,
    kind: p.kind,
    authHeader: p.authHeader,
    timeoutMs: p.timeoutMs,
    ...(p.stallTimeoutMs !== undefined ? { stallTimeoutMs: p.stallTimeoutMs } : {}),
    ...(firstByteTimeoutMs !== undefined ? { firstByteTimeoutMs } : {}),
    ...(realModel !== undefined ? { model: realModel } : {}),
    ...(p.authEnv ? { authEnv: p.authEnv } : {}),
    credentialSlots: providerCredentialSlots(provider, p),
    ...(p.credentialMode !== undefined ? { credentialMode: p.credentialMode } : {}),
    toolCallIds: resolveToolCallIdMode(p),
    thoughtSignature: resolveThoughtSignatureMode(p),
    reasoning: resolveReasoningMode(p),
    ...(p.wire !== undefined ? { wire: p.wire } : {}),
  };
}

/** Exclude declared-missing credentials when alternatives exist; otherwise retain the full list. */
function filterUsableTargets(
  targets: readonly ResolvedTarget[],
  scopedKeystoreOptions: KeystoreOptions,
): ResolvedTarget[] {
  const activeTargets = targets.filter((t) =>
    credentialState(t.authEnv, process.env, t.provider, scopedKeystoreOptions) !== "declared-missing"
  );
  return activeTargets.length > 0 ? activeTargets : [...targets];
}

/**
 * Rank targets by benchmark unless the pool is a dynamic pool with predefined fitness order.
 */
function rankNonDynamicTargets(
  picked: readonly string[],
  targets: readonly ResolvedTarget[],
  cfg: Config,
): ResolvedTarget[] {
  const pickedPool = picked.length === 1 && picked[0]?.startsWith(`${POOL_PREFIX}/`) ? picked[0] : undefined;
  const dynamicPool =
    pickedPool !== undefined && cfg.routing.poolPolicies?.[pickedPool.slice(POOL_PREFIX.length + 1)] !== undefined;
  if (!dynamicPool && cfg.routing.benchmarkSort !== false && targets.length > 1) {
    return rankTargetsByBenchmark([...targets]);
  }
  return [...targets];
}

/**
 * Resolve an inbound `model` to an array of concrete targets (primary + fallbacks).
 */
export function resolveTargets(
  model: string | null,
  cfg: Config,
  keystoreOptions: KeystoreOptions = {},
): ResolvedTarget[] {
  // One request-resolution walk owns one filesystem observation per store path. Never reuse a
  // caller-provided scope or mutate its options: separate resolveTargets calls must re-stat so an
  // out-of-process store replacement becomes visible, while every credentialState call below
  // shares this invocation's parsed in-memory snapshot.
  const scopedKeystoreOptions: KeystoreOptions = {
    ...keystoreOptions,
    resolutionWalk: createKeystoreResolutionWalk(),
  };
  const picked = pickSpecs(model, cfg);
  const specs = expandPoolSpecs(picked, cfg);
  const rawTargets = specs.map((spec) => resolveSingleSpec(spec, cfg, model));
  const activeTargets = filterUsableTargets(rawTargets, scopedKeystoreOptions);
  // Carry an explicit dynamic pool effort band to the mapper; direct specs and static pools
  // leave it absent. Do not overwrite effort already present on a target.
  const poolEffort = poolEffortFor(picked, cfg);
  if (poolEffort !== undefined) {
    for (const t of activeTargets) if (t.effort === undefined) t.effort = poolEffort;
  }
  return rankNonDynamicTargets(picked, activeTargets, cfg);
}

/** The effort band of the ONE dynamic pool `picked` resolved through, or undefined. */
function poolEffortFor(picked: string[], cfg: Config): EffortLevel | undefined {
  if (picked.length !== 1) return undefined;
  const first = picked[0];
  if (first === undefined || !first.startsWith(`${POOL_PREFIX}/`)) return undefined;
  return cfg.routing.poolPolicies?.[first.slice(POOL_PREFIX.length + 1)]?.effort;
}

/**
 * Resolve an inbound `model` to the primary concrete target.
 */
export function resolveTarget(
  model: string | null,
  cfg: Config,
  keystoreOptions: KeystoreOptions = {},
): ResolvedTarget {
  const targets = resolveTargets(model, cfg, keystoreOptions);
  if (targets.length === 0) {
    throw new RoutingError(`could not resolve any target for model "${model ?? "<none>"}"`);
  }
  return targets[0]!;
}

/** The reshaper for a resolved target when no explicit global reshaper is set. */
export function reshaperForTarget(target: ResolvedTarget): ReshaperConfig | undefined {
  if (target.kind === "openai" && target.model !== undefined) {
    return {
      base: target.base,
      model: target.model,
      kind: "openai",
      provider: target.provider,
      authHeader: target.authHeader,
      timeoutMs: Math.min(target.timeoutMs, 60000),
      ...(target.authEnv ? { authEnv: target.authEnv } : {}),
    };
  }
  return undefined;
}

/** CLI overrides, applied over the file so routing can be repointed without editing it. */
export interface ConfigOverrides {
  listen?: string | undefined;
  /** Override routing.default with a "provider/model" spec. */
  routeDefault?: string | undefined;
  mode?: string | undefined;
}

/** Expand config environment references, rejecting unset variables instead of substituting blanks. */
function expandEnv(value: string, where: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`config.${where} references unset env var \${${name}}`);
    return v;
  });
}

/**
 * Expand provider-base environment references while collecting missing names. A missing variable
 * disables that optional provider with a warning rather than preventing the whole relay from starting.
 */
function expandEnvSoft(value: string): { value: string; missing: string[] } {
  const missing: string[] = [];
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      missing.push(name);
      return "";
    }
    return v;
  });
  return { value: out, missing };
}

function parseAuthHeader(raw: unknown, dflt: AuthHeader): AuthHeader {
  return raw === "authorization" ? "authorization" : raw === "x-api-key" ? "x-api-key" : dflt;
}

const KEYSTORE_UNREADABLE_WARNING =
  "keystore unreadable — keystore-only providers resolve declared-missing and are unavailable " +
  "to routing; where alternatives exist, traffic falls through to remaining candidates. " +
  "The relay retries automatically; startup continues.";

/** Append custody availability diagnostics without ever changing admission or refusing startup. */
function appendKeystoreDegradationWarnings(
  providers: Record<string, ProviderConfig>,
  warnings: string[],
  env: NodeJS.ProcessEnv = process.env,
  keystoreOptions: KeystoreOptions = {},
): void {
  try {
    let entries: ReturnType<typeof listEntries>;
    try {
      entries = listEntries(keystoreOptions);
    } catch {
      warnings.push(KEYSTORE_UNREADABLE_WARNING);
      return;
    }
    if (entries.length === 0) return;

    const now = keystoreOptions.now ?? Date.now();
    const liveEnvNames = new Set(entries
      .filter((entry) => !entry.disabled
        && entry.revokedAt === null
        && (entry.expiresAt === null || entry.expiresAt > now))
      .map((entry) => entry.envName));
    if (liveEnvNames.size === 0) return;

    const affectedProviders = new Set<string>();
    for (const [provider, config] of Object.entries(providers)) {
      for (const slot of providerCredentialSlots(provider, config)) {
        if (!slot.enabled || slot.authEnv === undefined || slot.models?.length === 0) continue;
        const candidates = slot.resolutionMode === "declared-only"
          ? [slot.authEnv]
          : credentialCandidateEnvNames(slot.authEnv, slot.provider);
        if (candidates.some((name) => keyIsPresent(env[name]))) continue;
        // Custody has env-var parity: descriptor provider/id are provenance only. Coverage and
        // resolution both match the operator-declared NAME, exactly as a real env var would.
        if (!candidates.some((name) => liveEnvNames.has(name))) continue;
        if (resolveCredentialSlot(slot, env, keystoreOptions).state === "declared-missing") {
          affectedProviders.add(provider);
        }
      }
    }

    // A status read verifies/decrypts the store and may unwrap its KEK. If no provider can be
    // affected, diagnostics have no reason to pay that cost (notably a DPAPI spawn on Windows).
    if (affectedProviders.size === 0) return;

    const status = keystoreStatus(keystoreOptions);
    if (status.status === "unreadable") {
      warnings.push(KEYSTORE_UNREADABLE_WARNING);
      return;
    }
    if (status.status !== "locked" && status.status !== "degraded") return;

    const detail = status.status === "degraded"
      ? ` (${status.droppedCount} unreadable row${status.droppedCount === 1 ? "" : "s"})`
      : "";
    for (const provider of affectedProviders) {
      warnings.push(
        `provider "${provider}" credential custody ${status.status}${detail} — its env-missing ` +
        "keystore credential(s) resolve declared-missing and are unavailable to routing; where " +
        "alternatives exist, traffic falls through to remaining candidates. The relay retries " +
        "automatically; startup continues.",
      );
    }
  } catch {
    // A custody diagnostic must never become a relay outage. This is deliberately aggregate:
    // if metadata cannot be trusted, attributing failure to a provider would be a guess.
    warnings.push(KEYSTORE_UNREADABLE_WARNING);
  }
}

/** Load + validate a config file, failing loudly on anything unusable. */
export function loadConfig(
  path: string,
  overrides: ConfigOverrides = {},
  keystoreOptions: KeystoreOptions = {},
): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`could not read/parse config at ${path}: ${(e as Error).message}`, { cause: e });
  }
  // A failed metadata stat must not undo a successful config read.
  let sourceMtimeMs: number | undefined;
  try {
    sourceMtimeMs = statSync(path).mtimeMs;
  } catch {
    sourceMtimeMs = undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`config at ${path} is not a JSON object`);
  }
  const c = parsed as Record<string, unknown>;

  if (overrides.listen !== undefined) c.listen = overrides.listen;
  if (overrides.mode !== undefined) c.mode = overrides.mode;

  const listen = typeof c.listen === "string" ? expandEnv(c.listen, "listen") : "127.0.0.1:8791";
  const [host, portStr] = splitHostPort(listen);
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`config.listen has invalid port: "${listen}"`);
  }
  // The data plane carries provider credentials, while the separate control capability protects
  // stateful/costly administrative work. Neither boundary makes a non-loopback bind acceptable.
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `config.listen must bind loopback (127.0.0.1/localhost/::1), got "${host}". ` +
        `Refusing to expose a keyed, unauthenticated proxy on a non-loopback address.`,
    );
  }

  const warnings: string[] = [];
  const disabledProviders = new Set<string>();
  const providers = parseProviders(c.providers, warnings, disabledProviders);
  appendKeystoreDegradationWarnings(providers, warnings, process.env, keystoreOptions);
  const routing = parseRouting(c.routing, providers, overrides.routeDefault, warnings, disabledProviders);

  const mode = normalizeMode(c.mode);

  // Anthropic targets need an explicit reshaper. Pool-backed reshapers retain fallback candidates;
  // a valid empty dynamic pool is resolved lazily after catalog materialization.
  const reshaperCandidates = resolveReshaperPool(c.reshaper, routing, providers);
  const reshaper = reshaperCandidates?.[0] ?? parseReshaper(c.reshaper);
  const reshaperPoolRaw = typeof c.reshaper === "object" && c.reshaper !== null
    ? c.reshaper as Record<string, unknown>
    : null;
  const dynamicReshaperPool = reshaperCandidates?.length === 0 && typeof reshaperPoolRaw?.pool === "string"
    ? {
        name: reshaperPoolRaw.pool,
        ...(typeof reshaperPoolRaw.timeoutMs === "number" && Number.isFinite(reshaperPoolRaw.timeoutMs) && reshaperPoolRaw.timeoutMs > 0
          ? { timeoutMs: reshaperPoolRaw.timeoutMs }
          : {}),
      }
    : undefined;
  if (mode === "repair" && !reshaper && !dynamicReshaperPool) {
    const anthropicProvider = Object.entries(providers).find(([, p]) => p.kind === "anthropic");
    if (anthropicProvider) {
      throw new Error(
        `mode "repair" requires a config.reshaper — either { pool: "<name>" } (preferred: ranked ` +
          `candidates, survives a de-listed model) or { base, model, authEnv } — because provider ` +
          `"${anthropicProvider[0]}" is anthropic (no fixed model to reshape on)`,
      );
    }
  }

  const repairRaw = (c.repair ?? {}) as { maxAttempts?: unknown; destructiveTools?: unknown };
  const maxAttempts =
    typeof repairRaw.maxAttempts === "number" && Number.isFinite(repairRaw.maxAttempts) && repairRaw.maxAttempts > 0
      ? Math.floor(repairRaw.maxAttempts)
      : 2;
  const destructiveTools = Array.isArray(repairRaw.destructiveTools)
    ? repairRaw.destructiveTools.filter((s): s is string => typeof s === "string")
    : DEFAULT_DESTRUCTIVE;

  const logRaw = (c.log ?? {}) as { level?: unknown; file?: unknown; maxBytes?: unknown };
  const level = logRaw.level === "silent" ? "silent" : "metadata";
  const file = typeof logRaw.file === "string" ? logRaw.file : null;
  let logMaxBytes: number | undefined;
  if (logRaw.maxBytes !== undefined) {
    const maxConfiguredLogBytes = 1024 * 1024 * 1024;
    if (!Number.isSafeInteger(logRaw.maxBytes) || (logRaw.maxBytes as number) <= 0 || (logRaw.maxBytes as number) > maxConfiguredLogBytes) {
      throw new Error(
        `config.log.maxBytes must be a positive integer no greater than ${maxConfiguredLogBytes}; got ${JSON.stringify(logRaw.maxBytes)}`,
      );
    }
    logMaxBytes = logRaw.maxBytes as number;
  }

  const walkBudgetRaw = (c as { walkBudgetMs?: unknown }).walkBudgetMs;
  let walkBudgetMs: number | undefined;
  if (walkBudgetRaw !== undefined) {
    if (typeof walkBudgetRaw !== "number" || !Number.isFinite(walkBudgetRaw) || walkBudgetRaw < 0) {
      throw new Error(
        `config.walkBudgetMs must be a non-negative number of milliseconds (0 disables); got ${JSON.stringify(walkBudgetRaw)}`,
      );
    }
    walkBudgetMs = Math.floor(walkBudgetRaw);
  }

  const maxBodyBytesRaw = (c as { maxBodyBytes?: unknown }).maxBodyBytes;
  let maxBodyBytes: number | undefined;
  if (maxBodyBytesRaw !== undefined) {
    const maxConfiguredBodyBytes = 256 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBodyBytesRaw) || (maxBodyBytesRaw as number) <= 0 || (maxBodyBytesRaw as number) > maxConfiguredBodyBytes) {
      throw new Error(
        `config.maxBodyBytes must be a positive integer no greater than ${maxConfiguredBodyBytes}; got ${JSON.stringify(maxBodyBytesRaw)}`,
      );
    }
    maxBodyBytes = maxBodyBytesRaw as number;
  }

  const leaveMeAlone = parseLeaveMeAlone(c["leave_me_alone"]);

  const cfg: Config = {
    host,
    port,
    providers,
    routing,
    mode,
    ...(reshaper ? { reshaper } : {}),
    ...(reshaperCandidates && reshaperCandidates.length > 1 ? { reshaperCandidates } : {}),
    ...(dynamicReshaperPool ? { reshaperPool: dynamicReshaperPool } : {}),
    repair: { maxAttempts, destructiveTools },
    ...(walkBudgetMs !== undefined ? { walkBudgetMs } : {}),
    ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
    log: { level, file, ...(logMaxBytes !== undefined ? { maxBytes: logMaxBytes } : {}) },
    ...(leaveMeAlone.length > 0 ? { leaveMeAlone } : {}),
    sourcePath: path,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  if (sourceMtimeMs !== undefined) {
    // Keep load metadata out of serialized config and enumerable comparisons.
    Object.defineProperty(cfg, "sourceMtimeMs", {
      value: sourceMtimeMs,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
  return cfg;
}

export interface ConfigStalenessReport {
  /** The config file this process loaded from, or null for a hand-built Config with no file. */
  path: string | null;
  /** This config's recorded mtime (ms since epoch) at load time, or null if never recorded. */
  loadedAt: number | null;
  /** True for a missing/unreadable file, an absent recorded mtime, or an mtime mismatch.
   *  False when no sourcePath was recorded because there is no file-backed state to compare. */
  changedOnDisk: boolean;
  /** The file's CURRENT mtime (ms since epoch), read live at call time; null when it cannot be
   *  stat'd (missing, permission denied, or no source recorded at all). */
  diskMtime: number | null;
}

/** Shared config-staleness notice for telemetry and config-reading CLI commands. */
export const CONFIG_STALENESS_NOTICE =
  'config changed on disk since the relay loaded it — run "llm-relay reload"; a restart is required if the changed fields are not reloadable';

/**
 * Compare the recorded mtime with disk without applying changes. Missing or unreadable files
 * report changedOnDisk with a null diskMtime; a config without sourcePath has nothing to compare.
 * Telemetry and CLI use this evidence to request an explicit reload. Restart-only fields still
 * require a restart; merely editing the file does not apply a reload.
 */
export function configStaleness(
  cfg: Pick<Config, "sourcePath" | "sourceMtimeMs">,
  stat: (path: string) => { mtimeMs: number } = (p) => statSync(p),
): ConfigStalenessReport {
  const path = cfg.sourcePath ?? null;
  const loadedAt = cfg.sourceMtimeMs ?? null;
  if (path === null) {
    // No file-backed state exists to have changed on disk.
    return { path: null, loadedAt: null, changedOnDisk: false, diskMtime: null };
  }
  let diskMtime: number | null;
  try {
    diskMtime = stat(path).mtimeMs;
  } catch {
    diskMtime = null;
  }
  const changedOnDisk = diskMtime === null || loadedAt === null || diskMtime !== loadedAt;
  return { path, loadedAt, changedOnDisk, diskMtime };
}

/**
 * Validate suppression-list shape, not provider membership. Unknown names are legal because
 * the operator may suppress onboarding suggestions for providers they have not configured.
 */
function parseLeaveMeAlone(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`config.leave_me_alone must be an array of provider names (got ${typeof raw})`);
  }
  const bad = raw.find((v) => typeof v !== "string" || v.trim().length === 0);
  if (bad !== undefined) {
    throw new Error(
      `config.leave_me_alone entries must be non-empty provider-name strings (got ${JSON.stringify(bad)})`,
    );
  }
  return (raw as string[]).map((s) => s.trim());
}

function parseCredentialDeclarations(
  provider: string,
  raw: unknown,
  warnings: string[],
): ProviderCredentialConfig[] {
  if (!Array.isArray(raw)) {
    throw new Error(`config.providers.${provider}.credentials must be an array`);
  }
  const labels = new Set<string>();
  const envNames = new Set<string>();
  const out: ProviderCredentialConfig[] = [];
  raw.forEach((entry, index) => {
    const where = `config.providers.${provider}.credentials[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      warnings.push(`${where} dropped — expected an object`);
      return;
    }
    const value = entry as {
      label?: unknown;
      authEnv?: unknown;
      enabled?: unknown;
      models?: unknown;
      limits?: unknown;
    };
    const label = typeof value.label === "string" ? value.label : "";
    const authEnv = typeof value.authEnv === "string" ? value.authEnv : "";
    if (!CREDENTIAL_LABEL_PATTERN.test(label)) {
      warnings.push(`${where} dropped — label must match [A-Za-z0-9_.-]{1,32}`);
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authEnv)) {
      warnings.push(`${where} dropped — authEnv must be a valid environment variable name`);
      return;
    }
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
      warnings.push(`${where} dropped — enabled must be boolean`);
      return;
    }
    let models: readonly string[] | null | undefined;
    if (value.models !== undefined) {
      if (value.models === null) {
        models = null;
      } else {
        if (!Array.isArray(value.models) || value.models.some((model) => typeof model !== "string")) {
          warnings.push(`${where} dropped — models must be an array of model id strings`);
          return;
        }
        models = Object.freeze([...new Set((value.models as string[]).map((model) => model.trim()).filter(Boolean))]);
      }
    }
    // Invalid limits must throw: dropping the slot or ignoring its limits would silently remove
    // an operator-declared quota boundary. The parser names the offending path.
    const limits = parseConfiguredLimits(value.limits, `${where}.limits`);
    if (labels.has(label) || envNames.has(authEnv)) {
      const duplicate = labels.has(label) ? `label "${label}"` : `authEnv "${authEnv}"`;
      warnings.push(`${where} dropped — duplicate ${duplicate}; first valid slot wins`);
      return;
    }
    labels.add(label);
    envNames.add(authEnv);
    out.push({
      label,
      authEnv,
      ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
      ...(models !== undefined ? { models } : {}),
      ...(limits !== undefined ? { limits } : {}),
    });
  });
  return out;
}

function validateProviderCredentialMode(
  name: string,
  declaresAuthEnv: boolean,
  hasCredentialsDeclaration: boolean,
  rawCredentialMode: unknown,
): CredentialMode | undefined {
  let credentialMode: CredentialMode | undefined =
    rawCredentialMode === "passthrough" || rawCredentialMode === "contained" ? rawCredentialMode : undefined;
  if (rawCredentialMode !== undefined && credentialMode === undefined) {
    throw new Error(`config.providers.${name}.credentialMode must be "passthrough" or "contained"`);
  }
  if (credentialMode === "passthrough" && declaresAuthEnv) {
    throw new Error(
      `config.providers.${name}: credentialMode "passthrough" forwards the CALLER's own credential, ` +
        `but authEnv declares one of its own — declare exactly one`,
    );
  }
  if (hasCredentialsDeclaration && declaresAuthEnv) {
    throw new Error(
      `config.providers.${name}: authEnv and credentials cannot both be declared — declare exactly one`,
    );
  }
  if (hasCredentialsDeclaration && credentialMode === "passthrough") {
    throw new Error(
      `config.providers.${name}: credentialMode "passthrough" cannot be combined with credentials`,
    );
  }
  if (hasCredentialsDeclaration) credentialMode = "contained";
  return credentialMode;
}

function validateProviderConcurrency(name: string, rawMaxConcurrent: unknown): number | null | undefined {
  if (rawMaxConcurrent === undefined) return undefined;
  if (rawMaxConcurrent === null) return null;
  if (
    typeof rawMaxConcurrent !== "number" ||
    !Number.isSafeInteger(rawMaxConcurrent) ||
    rawMaxConcurrent <= 0
  ) {
    throw new Error(`config.providers.${name}.maxConcurrent must be a positive safe integer or null`);
  }
  return rawMaxConcurrent;
}

/** Raw (unvalidated) shape of one `config.providers.<name>` entry. */
interface RawProviderFields {
  base?: unknown;
  kind?: unknown;
  authEnv?: unknown;
  credentials?: unknown;
  credentialMode?: unknown;
  maxConcurrent?: unknown;
  authHeader?: unknown;
  timeoutMs?: unknown;
  stallTimeoutMs?: unknown;
  firstByteTimeoutMs?: unknown;
  tierType?: unknown;
  signupUrl?: unknown;
  limits?: unknown;
  compat?: unknown;
  wire?: unknown;
}

/** Assemble a validated `ProviderConfig` from the pieces parsed by `parseSingleProvider`. */
function buildProviderConfig(
  p: RawProviderFields,
  expanded: { value: string },
  kind: Kind,
  defaultAuthHeader: AuthHeader,
  declaredAuthEnv: string | undefined,
  credentials: ProviderCredentialConfig[] | undefined,
  credentialMode: CredentialMode | undefined,
  maxConcurrent: number | null | undefined,
  limits: ReturnType<typeof parseConfiguredLimits>,
  compat: ProviderCompatConfig | undefined,
  wire: ProviderWireMode | undefined,
  firstByteTimeoutMs: number | undefined,
): ProviderConfig {
  return {
    base: expanded.value.trim().replace(/\/+$/, ""),
    kind,
    authHeader: parseAuthHeader(p.authHeader, defaultAuthHeader),
    timeoutMs: typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs) && p.timeoutMs > 0 ? p.timeoutMs : 120000,
    ...(typeof p.stallTimeoutMs === "number" && Number.isFinite(p.stallTimeoutMs) && p.stallTimeoutMs >= 0
      ? { stallTimeoutMs: Math.floor(p.stallTimeoutMs) }
      : {}),
    ...(firstByteTimeoutMs !== undefined ? { firstByteTimeoutMs } : {}),
    ...(declaredAuthEnv ? { authEnv: declaredAuthEnv } : {}),
    ...(credentials !== undefined ? { credentials } : {}),
    ...(credentialMode !== undefined ? { credentialMode } : {}),
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    ...(p.tierType === "free" || p.tierType === "mixed" || p.tierType === "subscription"
      ? { tierType: p.tierType }
      : {}),
    ...(limits !== undefined ? { limits } : {}),
    ...(compat !== undefined ? { compat } : {}),
    ...(wire !== undefined ? { wire } : {}),
    ...(typeof p.signupUrl === "string" && p.signupUrl.length > 0 ? { signupUrl: p.signupUrl } : {}),
  };
}

function parseSingleProvider(
  name: string,
  v: unknown,
  warnings: string[],
  disabled: Set<string>,
): ProviderConfig | null {
  if (typeof v !== "object" || v === null) {
    throw new Error(`config.providers.${name} must be an object`);
  }
  const p = v as RawProviderFields;
  try {
    makeCredentialId(name);
  } catch {
    throw new Error(
      `config.providers.${name} is not a valid provider name — provider names must be non-empty and must not contain '#'`,
    );
  }
  if (typeof p.base !== "string") {
    throw new Error(`config.providers.${name}.base (string URL) is required`);
  }
  const expanded = expandEnvSoft(p.base);
  const kind: Kind = p.kind === "openai" ? "openai" : "anthropic";
  const defaultAuthHeader: AuthHeader = kind === "openai" ? "authorization" : "x-api-key";
  const declaredAuthEnv = typeof p.authEnv === "string" ? p.authEnv.trim() : undefined;
  const declaresAuthEnv = typeof declaredAuthEnv === "string" && declaredAuthEnv.length > 0;
  const hasCredentialsDeclaration = p.credentials !== undefined;
  const credentialMode = validateProviderCredentialMode(name, declaresAuthEnv, hasCredentialsDeclaration, p.credentialMode);
  let credentials: ProviderCredentialConfig[] | undefined;
  if (hasCredentialsDeclaration) {
    credentials = parseCredentialDeclarations(name, p.credentials, warnings);
  }
  const maxConcurrent = validateProviderConcurrency(name, p.maxConcurrent);
  const limits = parseConfiguredLimits(p.limits, `config.providers.${name}.limits`);
  const compat = parseProviderCompat(p.compat, `config.providers.${name}.compat`);
  const wire = parseProviderWire(p.wire, kind, name);
  const firstByteTimeoutMs = parseProviderFirstByteTimeout(p.firstByteTimeoutMs, name);

  if (expanded.missing.length > 0) {
    warnings.push(
      `provider "${name}" DISABLED — base references unset env var ` +
        `${expanded.missing.map((n) => `\${${n}}`).join(", ")}. ` +
        `Set it and restart, or remove the provider. Everything else still works.`,
    );
    disabled.add(name);
    return null;
  }
  if (kind === "anthropic" && !declaresAuthEnv && credentialMode === undefined) {
    warnings.push(
      `provider "${name}" forwards the CALLER's own credential to ${expanded.value} — inferred from ` +
        `having no authEnv. Declare credentialMode "passthrough" to confirm that is intended, or ` +
        `"contained" to strip it.`,
    );
  }

  return buildProviderConfig(
    p, expanded, kind, defaultAuthHeader, declaredAuthEnv, credentials, credentialMode, maxConcurrent, limits, compat, wire,
    firstByteTimeoutMs,
  );
}

function parseProviders(
  raw: unknown,
  warnings: string[] = [],
  disabled: Set<string> = new Set(),
): Record<string, ProviderConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config.providers (object of named providers) is required`);
  }
  const out: Record<string, ProviderConfig> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const provider = parseSingleProvider(name, v, warnings, disabled);
    if (provider !== null) {
      out[name] = provider;
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`config.providers must define at least one provider`);
  }
  return out;
}

/**
 * Expand the pool's configured OpenAI targets into reshaper candidates. An empty dynamic pool
 * is deferred only if an OpenAI provider can contribute; other empty pools are load errors.
 */
function resolveReshaperPool(
  raw: unknown,
  routing: Routing,
  providers: Record<string, ProviderConfig>,
): ReshaperConfig[] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const poolName = (raw as Record<string, unknown>).pool;
  if (typeof poolName !== "string" || poolName.length === 0) return undefined;

  const specs = routing.pools?.[poolName];
  if (!specs) {
    throw new Error(
      `config.reshaper.pool "${poolName}" is not defined in routing.pools (available: ${Object.keys(routing.pools ?? {}).join(", ") || "none"})`,
    );
  }

  const timeoutOverride = (raw as Record<string, unknown>).timeoutMs;
  const out: ReshaperConfig[] = [];
  for (const spec of specs) {
    const { provider, model } = splitSpec(spec);
    const p = providers[provider];
    if (!p || p.kind !== "openai" || !model) continue;
    out.push({
      base: p.base,
      model,
      kind: "openai",
      provider,
      authHeader: p.authHeader,
      timeoutMs:
        typeof timeoutOverride === "number" && Number.isFinite(timeoutOverride) && timeoutOverride > 0
          ? timeoutOverride
          : Math.min(p.timeoutMs, 60000),
      ...(p.authEnv ? { authEnv: p.authEnv } : {}),
    });
  }
  if (out.length === 0) {
    // Catalog-backed pools are materialized after load. Do not defer an all-Anthropic
    // configuration that cannot supply any reshaper.
    if (routing.poolPolicies?.[poolName] && Object.values(providers).some((p) => p.kind === "openai")) {
      return [];
    }
    throw new Error(`config.reshaper.pool "${poolName}" contains no openai-kind target that can reshape`);
  }
  return out;
}

function parseReshaper(raw: unknown): ReshaperConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.base !== "string" || typeof r.model !== "string") return undefined;
  const kind: Kind = r.kind === "openai" ? "openai" : "anthropic";
  const defaultAuthHeader: AuthHeader = kind === "openai" ? "authorization" : "x-api-key";
  return {
    base: expandEnv(r.base, "reshaper.base").trim().replace(/\/+$/, ""),
    model: expandEnv(r.model, "reshaper.model"),
    kind,
    authHeader: parseAuthHeader(r.authHeader, defaultAuthHeader),
    timeoutMs: typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs) && r.timeoutMs > 0 ? r.timeoutMs : 60000,
    ...(typeof r.authEnv === "string" ? { authEnv: r.authEnv } : {}),
  };
}

function splitHostPort(listen: string): [string, string] {
  const bracket = /^\[(.+)\]:(\d+)$/.exec(listen);
  if (bracket) return [bracket[1]!, bracket[2]!];
  const idx = listen.lastIndexOf(":");
  if (idx === -1) return ["127.0.0.1", listen];
  return [listen.slice(0, idx) || "127.0.0.1", listen.slice(idx + 1)];
}

function normalizeMode(v: unknown): Mode {
  if (v === "detect" || v === "repair" || v === "strict") return v;
  return "detect";
}
