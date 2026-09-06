import { readFileSync } from "node:fs";
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
  type ProviderCompatConfig,
  type ProviderConfig,
  type Routing,
  type RequestHeaders,
  type ResolvedTarget,
  type Config,
} from "./config-types.js";

// The configuration vocabulary has ONE declaration, in `config-types.ts` (DR-001, 2026-09-04).
// Re-exported here so every `from "./config.js"` importer keeps its binding.
// Spec spelling moved to its own leaf so `config/routing-parser.ts` can depend on it without a
// cycle back into this file (HOTSPOT-03 stage 1). Re-exported so no importer had to change.
export { AUTO_MODEL, POOL_PREFIX, splitSpec } from "./spec.js";

// The routing block's parser moved to its own module (HOTSPOT-03 stage 2). These three are
// re-exported because `offload.ts`, `lane-cadence.ts` and `test/config.test.ts` import them from
// here; the move was not supposed to make anyone edit an import line.
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
  type ProviderCompatConfig,
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
  type LaneProbeSettings,
  type McpSettings,
} from "./config-types.js";

/** The closed set of `compat` keys, so an unknown one can be named in the error. */
const COMPAT_KEYS = ["toolCallIds", "thoughtSignature"] as const satisfies readonly (keyof ProviderCompatConfig)[];

const TOOL_CALL_ID_MODES: readonly ToolCallIdMode[] = ["preserve", "strict9"];

const THOUGHT_SIGNATURE_MODES: readonly ThoughtSignatureMode[] = ["none", "sentinel"];

/**
 * Parse a provider's `compat` block. Adding the next key is one entry in `COMPAT_KEYS` plus its
 * own value check below.
 */
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
  }
  return Object.keys(out).length > 0 ? out : {};
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

/**
 * Is this base URL Google's Generative Language API — the host whose gemini 3.x models enforce the
 * `thought_signature` rule? Deliberately the ONE exact host, not `*.googleapis.com`: Vertex and
 * every other Google surface are different products with different validators.
 */
function isGoogleGenerativeLanguageHost(base: string): boolean {
  return baseHost(base) === "generativelanguage.googleapis.com";
}

/**
 * The resolved outbound tool-call-id shape for one provider.
 *
 * A LABELLED PROVIDER FACT, allowed by the "Provider knowledge is data, not routing configuration"
 * invariant precisely because config overrides it: mistral's own validator states the rule
 * (`^[a-zA-Z0-9]{9}$`, first-party evidence in `src/openai-request.ts`), so a mistral base host
 * defaults to `"strict9"` and every other host to `"preserve"`. An explicit `compat.toolCallIds`
 * wins in BOTH directions — `"preserve"` on a mistral host, `"strict9"` on anything else.
 */
export function resolveToolCallIdMode(p: { base: string; compat?: ProviderCompatConfig }): ToolCallIdMode {
  if (p.compat?.toolCallIds !== undefined) return p.compat.toolCallIds;
  return isMistralHost(p.base) ? "strict9" : "preserve";
}

/**
 * The resolved thought-signature mode for one provider.
 *
 * The SAME labelled-fact mechanism as `resolveToolCallIdMode`, and allowed by the SAME invariant —
 * "Provider knowledge is data, not routing configuration" permits a labelled provider fact in
 * `src/` only while config can override it. Google's Generative Language API states the rule (its
 * gemini 3.x models 400 a replayed tool call carrying no signature; first-party evidence in
 * `src/openai-request.ts`), so that base host defaults to `"sentinel"` and every other host to
 * `"none"`. An explicit `compat.thoughtSignature` wins in BOTH directions.
 */
export function resolveThoughtSignatureMode(p: { base: string; compat?: ProviderCompatConfig }): ThoughtSignatureMode {
  if (p.compat?.thoughtSignature !== undefined) return p.compat.thoughtSignature;
  return isGoogleGenerativeLanguageHost(p.base) ? "sentinel" : "none";
}

/**
 * Marker Claude Code stamps into the `system` block of SUBAGENT requests only (verified on wire,
 * Claude Code 2.1.220): `x-anthropic-billing-header: …; cc_entrypoint=…; cc_is_subagent=true;`.
 * Built-in subagents (Explore, general-purpose) carry it too, not just custom `.md` agents.
 *
 * This is what makes tier-based subagent routing safe. Without it, a subagent declaring
 * `model: haiku` and a HUMAN picking Haiku for their own conversation are byte-identical, so any
 * tier→provider mapping silently drops the human's own conversation onto a weak model.
 */
const SUBAGENT_MARKER = "cc_is_subagent=true";

/**
 * Claude Code's documented per-request agent identifier: "Identifier of the subagent that issued
 * the request, present only on requests from an agent Claude Code spawned inside the session"
 * (gateway protocol reference), which the same page explicitly permits a gateway to consume for
 * routing. Same semantics as SUBAGENT_MARKER.
 *
 * ⚠ Checked ALONGSIDE the marker, never instead of it — each covers the other's silent failure,
 * and the failure is the same either way: an undetected subagent falls through to the passthrough
 * and spends PRIMARY quota while looking like a successful offload.
 *  - The header dies to any middleware that filters unknown request headers (this relay commonly
 *    runs behind one), and Anthropic's own advice is to treat `x-claude-code-*` as an open list.
 *  - The marker dies to `CLAUDE_CODE_ATTRIBUTION_HEADER=0`, which drops the attribution block —
 *    and therefore the marker — from the system prompt entirely.
 * The header travels outside the body, the marker inside it, so no single component drops both.
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
    // Check if system contains SUBAGENT_MARKER. Since the marker contains no newline,
    // it cannot span join boundaries — safe to check each block independently.
    if (typeof system === "string") {
      if (system.includes(SUBAGENT_MARKER)) return true;
    } else if (Array.isArray(system)) {
      for (const b of system) {
        const text = typeof b === "string" ? b : ((b as { text?: unknown }).text ?? "");
        if (typeof text === "string" && text.includes(SUBAGENT_MARKER)) return true;
      }
    }
  }

  // Claude Code's own subagent header — present on exactly the requests the marker is present on,
  // and independent of it. Presence alone is the signal; the value identifies WHICH agent, and per
  // the protocol reference identifies an agent rather than a person, so it is never used as one.
  const agentId = headerValue(headers, CLAUDE_AGENT_ID_HEADER);
  if (typeof agentId === "string" && agentId.trim().length > 0) return true;

  // Codex's Responses requests do not have an Anthropic `system` field. Its local clients identify
  // child-agent turns in `x-codex-turn-metadata`; parse it defensively and fail open for ordinary
  // turns or metadata we do not recognize. This header is intentionally not forwarded upstream.
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
 * Read (and optionally strip) an `@relay: <spec>` directive from the dispatcher's prompt.
 *
 * ⚠ Only the LAST text block of `messages[0]` is inspected — that is the dispatcher-authored
 * prompt. Block 0 is Claude Code's injected `<system-reminder>` (CLAUDE.md, date, …) and later
 * messages carry tool results, i.e. file contents. Reading those would let any file the subagent
 * happens to read redirect its own routing.
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
 * Why routing could not reach this spec, or null when it can.
 *
 * Mirrors what `pickSpecs` + `resolveSingleSpec` will do with it: `pool/<name>` needs a configured
 * pool, anything else needs a declared provider (plus a model id when that provider is openai-kind).
 * Deliberately does NOT accept "detectTier thinks this looks like a Claude id" as resolvable — that
 * route ends at the passthrough, which for a directive means a typo like `opus-coder` is answered
 * by primary quota instead of failing.
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

/**
 * The client names used by the built-in front doors. Other clients may use their own key in the
 * object form of `routing.offload`, or fall back to the explicit `default` rule.
 */
export const CLAUDE_CLIENT = "claude";
export const CODEX_CLIENT = "codex";
export const OPENAI_CLIENT = "openai";
export const DEFAULT_CLIENT = "default";

/** Map a relay front-door path to the originating harness name used by offload settings. */
export function clientForPath(pathname: string): string {
  if (pathname === "/v1/messages" || pathname.startsWith("/v1/messages/")) return CLAUDE_CLIENT;
  if (pathname === "/v1/responses" || pathname === "/responses") return CODEX_CLIENT;
  if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") return OPENAI_CLIENT;
  return DEFAULT_CLIENT;
}

/** Every client name `clientForPath` can produce — the complete set of rule keys a request consults. */
export const FRONT_DOOR_CLIENTS: readonly string[] = [CLAUDE_CLIENT, CODEX_CLIENT, OPENAI_CLIENT, DEFAULT_CLIENT];

/**
 * Why a targeted offload rule for `client` could never affect a request, or null when it can.
 *
 * The request path looks up ONLY the name `clientForPath()` derived from the front-door path. A
 * rule keyed anything else ("claude-desktop" was the real case) is dead config: the toggle
 * succeeds, status shows it ON, and every request falls through to the `default` rule — so the
 * operator's `--scope all` silently did nothing. Same principle as an unknown pool: refuse loudly
 * and name what IS valid. A key that already exists in the config stays legal (`fatal: false`) so
 * state remains visible and an operator can still turn a dead rule off — callers surface the
 * message as a prominent warning instead.
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
 * The spec a request should route to, or null to leave routing unchanged.
 *
 * Precedence: an explicit `@relay:` directive (per-call opt-in, works even with the client rule off) >
 * `routing.subagents[<tier>]` > `routing.subagents.default` — the last two only when
 * the effective client rule is enabled. A `scope: "subagents"` rule only applies to marked child
 * requests; `scope: "all"` also applies to the client's main conversation.
 *
 * ⚠ An unresolvable directive is a loud `RoutingError`, never a quiet fall-through. The map forms
 * are validated at config load (`assertSpecResolvable`), but a directive arrives per request and
 * had no check at all: a typo'd provider or pool name matched nothing in `pickSpecs`, so it landed
 * on `routing.default` — the Anthropic passthrough. That spends PRIMARY quota while the dispatcher
 * believes it offloaded, and nothing in the response says otherwise. Same rule as an unknown pool:
 * fail and name what IS configured.
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
 * Tools a repaired call is never allowed to name. THE single definition — the
 * shipped config template, config.example.json and the docs all derive from or
 * are asserted equal to this list, because they previously disagreed: this array
 * had 8 entries including "remove" while the other three had 7, so a config that
 * omitted repair.destructiveTools got different coverage than a generated one.
 *
 * Matching is exact (see destructiveMatcher), so these are real tool names, not
 * fragments. The clients' own destructive tools are listed first — they are the
 * ones that can actually destroy something, and the previous fragment list
 * ("rm", "delete", …) matched none of them.
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

/** Claude tier names, longest-first so "haiku"/"sonnet" match before generic bits. */
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
 * Pick the "provider/model" spec(s) for an inbound model id:
 *  1. `pool/<name>` → that pool's full candidate list (ranked + failed over downstream);
 *  2. namespaced (`known-provider/…`) → use verbatim;
 *  3. a Claude tier with a configured mapping → that tier's spec(s);
 *  4. otherwise the routing default.
 *
 * Pools are checked FIRST so the reserved `pool/` prefix can never be shadowed by a provider that
 * happens to be named "pool" (config load also rejects that name outright).
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
 * Expand any `pool/<name>` spec into that pool's candidate list. Applied to whatever
 * pickSpecs chose, so pools work uniformly whether addressed directly by the request,
 * from routing.tiers/default, or via routing.subagents. Pool members themselves are
 * provider specs only (config load rejects pool-in-pool), so no recursion.
 *
 * An unknown pool must NOT silently fall through to routing.default — that is exactly the
 * "succeeded against a much weaker model than you asked for" failure. Fail loudly instead.
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
  return {
    provider,
    base: p.base,
    kind: p.kind,
    authHeader: p.authHeader,
    timeoutMs: p.timeoutMs,
    ...(p.stallTimeoutMs !== undefined ? { stallTimeoutMs: p.stallTimeoutMs } : {}),
    ...(realModel !== undefined ? { model: realModel } : {}),
    ...(p.authEnv ? { authEnv: p.authEnv } : {}),
    credentialSlots: providerCredentialSlots(provider, p),
    ...(p.credentialMode !== undefined ? { credentialMode: p.credentialMode } : {}),
    toolCallIds: resolveToolCallIdMode(p),
    thoughtSignature: resolveThoughtSignatureMode(p),
  };
}

/**
 * Filter targets to those with active/usable credentials, falling back to full list if none are active.
 */
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
  return rankNonDynamicTargets(picked, activeTargets, cfg);
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

/**
 * Expand `${ENV}` references in a config string against process.env, failing
 * loudly if a referenced variable is unset — so a missing provider URL/key is a
 * clear startup error, never a silent empty value.
 */
function expandEnv(value: string, where: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`config.${where} references unset env var \${${name}}`);
    return v;
  });
}

/**
 * Like `expandEnv`, but reports the missing variable names instead of throwing.
 *
 * Used ONLY for a provider's `base`. An unset `${ENV}` there used to be fatal, which meant
 * one optional provider (e.g. Cloudflare, whose URL embeds an account id) could stop the
 * whole proxy from starting — and since the proxy fronts every client session, that is a
 * total outage caused by a provider nobody was using. Disabling that one provider with a
 * loud warning is proportionate; refusing to boot is not.
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

  // A repair-mode target reshapes on itself (openai) or via the explicit global
  // reshaper. An anthropic provider has no fixed model id, so if any provider is
  // anthropic and no explicit reshaper is set, repair can't reshape it — reject.
  // `reshaper: { pool: "<name>" }` is the resilient form: it expands to the pool's ranked
  // candidates, so repair survives one model being de-listed. Pinning a single {base, model} still
  // works but is fragile — the provider dropping that id silently disables repair.
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

  return {
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
}

/**
 * Parse `leave_me_alone` — the provider suppression list.
 *
 * ⚠ A name matching NO known provider is deliberately legal and produces neither an error nor a
 * warning. Storing only the negative space is the whole point: you suppress the nudge for a
 * provider you have chosen not to configure, which by definition is not in `config.providers`,
 * and most of them are only ever preset names. Validating against the known set would reject
 * exactly the entries the feature exists for.
 *
 * The VALUE's shape is still checked loudly — a string where a list belongs, or a number in the
 * list, is a mistake with no plausible reading, and silently ignoring it would leave the user
 * being nagged with no idea why.
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
    // A malformed limits block THROWS rather than following the drop-with-a-warning convention
    // above: dropping the slot would silently remove a whole key (and its quota domain) from the
    // fleet, and keeping the slot while ignoring the block would leave the operator believing a
    // ceiling is asserted when none is. Both failure modes are worse than refusing to start.
    // parseConfiguredLimits throws naming the exact offending key/path.
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

function parseSingleProvider(
  name: string,
  v: unknown,
  warnings: string[],
  disabled: Set<string>,
): ProviderConfig | null {
  if (typeof v !== "object" || v === null) {
    throw new Error(`config.providers.${name} must be an object`);
  }
  const p = v as {
    base?: unknown;
    kind?: unknown;
    authEnv?: unknown;
    credentials?: unknown;
    credentialMode?: unknown;
    maxConcurrent?: unknown;
    authHeader?: unknown;
    timeoutMs?: unknown;
    stallTimeoutMs?: unknown;
    tierType?: unknown;
    signupUrl?: unknown;
    limits?: unknown;
    compat?: unknown;
  };
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

  return {
    base: expanded.value.trim().replace(/\/+$/, ""),
    kind,
    authHeader: parseAuthHeader(p.authHeader, defaultAuthHeader),
    timeoutMs: typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs) && p.timeoutMs > 0 ? p.timeoutMs : 120000,
    ...(typeof p.stallTimeoutMs === "number" && Number.isFinite(p.stallTimeoutMs) && p.stallTimeoutMs >= 0
      ? { stallTimeoutMs: Math.floor(p.stallTimeoutMs) }
      : {}),
    ...(declaredAuthEnv ? { authEnv: declaredAuthEnv } : {}),
    ...(credentials !== undefined ? { credentials } : {}),
    ...(credentialMode !== undefined ? { credentialMode } : {}),
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    ...(p.tierType === "free" || p.tierType === "mixed" || p.tierType === "subscription"
      ? { tierType: p.tierType }
      : {}),
    ...(limits !== undefined ? { limits } : {}),
    ...(compat !== undefined ? { compat } : {}),
    ...(typeof p.signupUrl === "string" && p.signupUrl.length > 0 ? { signupUrl: p.signupUrl } : {}),
  };
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
 * Expand `reshaper: { pool: "<name>" }` into ranked reshaper candidates.
 *
 * Only openai-kind targets can reshape (an anthropic passthrough has no fixed model id to send),
 * so anthropic entries in the pool are skipped rather than failing the whole pool. A pool naming
 * no usable target IS an error — silently ending up with no reshaper would disable repair without
 * saying so, which is the failure this whole form exists to prevent.
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
    // A catalog-backed pool can legitimately have an empty configured prefix. Its discovered
    // tail is materialized after load, so remember the pool and resolve it lazily in server.ts.
    // This is allowed only when an OpenAI provider could actually contribute a reshaper; an
    // all-Anthropic config would otherwise defer a deterministic startup error until first use.
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

