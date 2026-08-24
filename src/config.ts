import { readFileSync } from "node:fs";
import { rankTargetsByBenchmark } from "./benchmarks.js";
import {
  credentialCandidateEnvNames,
  credentialState,
  keyIsPresent,
  resolveAuthEnv,
} from "./authEnv.js";
import { CREDENTIAL_LABEL_PATTERN, makeCredentialId } from "./credential-id.js";
import { parseConfiguredLimits, type ProviderLimitsConfig } from "./configured-limits.js";
import {
  providerCredentialSlots,
  resolveCredentialSlot,
  type CredentialSlot,
  type ProviderCredentialConfig,
} from "./credential-fleet.js";
import {
  createKeystoreResolutionWalk,
  keystoreStatus,
  listEntries,
  type KeystoreOptions,
} from "./keystore.js";

export type Mode = "detect" | "repair" | "strict";

export type AuthHeader = "x-api-key" | "authorization";

export type Kind = "anthropic" | "openai";

export type ProviderTierType = "free" | "mixed" | "subscription";

/** Requested reasoning/capability band for an automatically discovered pool. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh";

const EFFORT_LEVELS = new Set<EffortLevel>(["low", "medium", "high", "xhigh"]);

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
 * What shape a provider's own validator demands of the tool-call ids the relay puts on the wire.
 *
 *  - `"preserve"` — forward the caller's ids verbatim. The default everywhere, and what the relay
 *    did for its whole life before 2026-08-23: an id is linkage, so not touching it is the safest
 *    thing a translation can do.
 *  - `"strict9"` — rewrite every outbound `tool_calls[].id` / `tool_call_id` to mistral's stated
 *    `^[a-zA-Z0-9]{9}$` shape. Mistral's `mistral-common` validator enforces it on BOTH halves of
 *    the pair (and, from v13, linkage and uniqueness on top), so an Anthropic `toolu_01…` id is a
 *    hard 400 there — see `src/openai-request.ts`.
 */
export type ToolCallIdMode = "preserve" | "strict9";

/**
 * Whether a replayed assistant tool call must carry gemini 3.x's `thought_signature` field.
 *
 *  - `"none"` — emit nothing. The default everywhere, and byte for byte what this relay put on the
 *    wire before 2026-08-23.
 *  - `"sentinel"` — stamp Google's own documented opt-out token,
 *    `skip_thought_signature_validator`, at `tool_calls[].extra_content.google.thought_signature`
 *    on every replayed tool call. See `src/openai-request.ts` for the 400 that states the rule and
 *    for why echoing a REAL signature is not an option here.
 */
export type ThoughtSignatureMode = "none" | "sentinel";

/**
 * Per-provider WIRE-SHAPE quirks — things a specific host's request validator demands that the
 * protocol itself does not. Deliberately not routing configuration and deliberately not a
 * per-provider switch in `src/`: a labelled provider fact may live in code only while config can
 * override it (see the "Provider knowledge is data" invariant), which is exactly the shape here —
 * a base-host default that any explicit value beats in both directions.
 *
 * Two keys today, one per vendor rule the relay has first-party evidence for. An unknown key or
 * value is a HARD load error naming it: the `configured-limits` precedent — an ignored typo
 * silently no-ops while reading like a declaration that took effect.
 */
export interface ProviderCompatConfig {
  /** Absent ⇒ resolved from the base host by `resolveToolCallIdMode`. */
  toolCallIds?: ToolCallIdMode;
  /** Absent ⇒ resolved from the base host by `resolveThoughtSignatureMode`. */
  thoughtSignature?: ThoughtSignatureMode;
}

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
 * Validate `routing.quota`. A malformed block is a hard error rather than silently ignored:
 * an operator who wrote `"enforceLearned": "yes"` believes they opted into gating on learned
 * limits when they have not, which is precisely the silent-divergence shape this file's other
 * parsers reject by name.
 */
function parseQuotaEnforcement(raw: unknown): QuotaEnforcementConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.routing.quota must be an object");
  }
  const value = raw as Record<string, unknown>;
  const out: QuotaEnforcementConfig = {};
  if (value.enforce !== undefined) {
    if (typeof value.enforce !== "boolean") throw new Error("config.routing.quota.enforce must be a boolean");
    out.enforce = value.enforce;
  }
  if (value.enforceLearned !== undefined) {
    if (typeof value.enforceLearned !== "boolean") {
      throw new Error("config.routing.quota.enforceLearned must be a boolean");
    }
    out.enforceLearned = value.enforceLearned;
  }
  if (value.hardCaps !== undefined) {
    if (typeof value.hardCaps !== "boolean") {
      throw new Error("config.routing.quota.hardCaps must be a boolean");
    }
    out.hardCaps = value.hardCaps;
  }
  return out;
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
  /** relay rungs: the spec to address (`pool/<name>`, `<provider>/<model>`, a provider name). */
  spec?: string;
}

/** Reserved provider-namespace prefix for `pool/<name>` routing. */
export const POOL_PREFIX = "pool";

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

/** The request headers needed for protocol-specific subagent markers. */
export type RequestHeaders = Readonly<Record<string, string | string[] | undefined>>;

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
   * Non-fatal load-time problems (a provider disabled for an unset `${ENV}`, a pool member
   * dropped with it). Present so startup can print them — a degraded config that boots
   * silently is how you end up running on one provider without noticing.
   */
  warnings?: string[];
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
const TIER_NAMES = ["opus", "sonnet", "haiku", "fable"] as const;

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

/** Split a "provider/model" spec into its parts (model may contain further slashes). */
export function splitSpec(spec: string): { provider: string; model?: string } {
  const slash = spec.indexOf("/");
  if (slash === -1) return { provider: spec };
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
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
  let targets = specs.map((spec) => resolveSingleSpec(spec, cfg, model));

  // Prioritize targets whose credential is usable: no authEnv declared (a real passthrough or a
  // keyless local provider) or a declared authEnv that is actually present.
  //
  // ⚠ Presence is decided by `credentialState`, the SAME predicate `server.ts`'s
  // `buildForwardHeaders` uses — not an open-coded `Boolean(process.env[...])`. This site used to
  // test truthiness without trimming while header construction trimmed, so a whitespace-only key
  // read PRESENT here and ABSENT there: the blank-key target survived the filter, the
  // keep-everything fallback below never ran, and the request went to a provider the proxy could
  // not authenticate to. Any drift between the two answers reopens that gap, so both must keep
  // calling the one predicate.
  const activeTargets = targets.filter((t) =>
    credentialState(t.authEnv, process.env, t.provider, scopedKeystoreOptions) !== "declared-missing"
  );
  if (activeTargets.length > 0) {
    targets = activeTargets;
  }

  // Dynamic pools are already materialized as an invariant fixed prefix followed by a fitness-ranked
  // discovery tail. Sorting the entire result again would destroy the user's preferred order.
  const pickedPool = picked.length === 1 && picked[0]?.startsWith(`${POOL_PREFIX}/`) ? picked[0] : undefined;
  const dynamicPool =
    pickedPool !== undefined && cfg.routing.poolPolicies?.[pickedPool.slice(POOL_PREFIX.length + 1)] !== undefined;
  if (!dynamicPool && cfg.routing.benchmarkSort !== false && targets.length > 1) {
    targets = rankTargetsByBenchmark(targets);
  }
  return targets;
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
    // An unset ${ENV} in `base` disables just this provider — see expandEnvSoft. Parse the
    // provider's credential declaration before applying that soft disable so malformed fleet
    // declarations cannot hide behind an unavailable endpoint.
    const expanded = expandEnvSoft(p.base);
    const kind: Kind = p.kind === "openai" ? "openai" : "anthropic";
    const defaultAuthHeader: AuthHeader = kind === "openai" ? "authorization" : "x-api-key";
    const declaredAuthEnv = typeof p.authEnv === "string" ? p.authEnv.trim() : undefined;
    const declaresAuthEnv = typeof declaredAuthEnv === "string" && declaredAuthEnv.length > 0;
    const hasCredentialsDeclaration = p.credentials !== undefined;
    let credentialMode: CredentialMode | undefined =
      p.credentialMode === "passthrough" || p.credentialMode === "contained" ? p.credentialMode : undefined;
    if (p.credentialMode !== undefined && credentialMode === undefined) {
      throw new Error(`config.providers.${name}.credentialMode must be "passthrough" or "contained"`);
    }
    // A typo with a credential consequence, so it fails loudly at load rather than resolving to
    // whichever branch the header builder happens to test first.
    if (credentialMode === "passthrough" && declaresAuthEnv) {
      throw new Error(
        `config.providers.${name}: credentialMode "passthrough" forwards the CALLER's own credential, ` +
        `but authEnv ${String(declaredAuthEnv)} declares one of its own — declare exactly one`,
      );
    }
    if (hasCredentialsDeclaration && p.authEnv !== undefined) {
      throw new Error(
        `config.providers.${name}: authEnv and credentials cannot both be declared — declare exactly one`,
      );
    }
    if (hasCredentialsDeclaration && credentialMode === "passthrough") {
      throw new Error(
        `config.providers.${name}: credentialMode "passthrough" cannot be combined with credentials`,
      );
    }
    // An explicit fleet, including `credentials: []`, is a provider-owned credential policy.
    // Normalize it to contained so the absence of a usable slot can never fall through to the
    // legacy Anthropic caller-credential passthrough.
    if (hasCredentialsDeclaration) credentialMode = "contained";
    let credentials: ProviderCredentialConfig[] | undefined;
    if (hasCredentialsDeclaration) {
      credentials = parseCredentialDeclarations(name, p.credentials, warnings);
    }
    let maxConcurrent: number | null | undefined;
    if (p.maxConcurrent !== undefined) {
      if (p.maxConcurrent === null) {
        maxConcurrent = null;
      } else if (
        typeof p.maxConcurrent !== "number" ||
        !Number.isSafeInteger(p.maxConcurrent) ||
        p.maxConcurrent <= 0
      ) {
        throw new Error(
          `config.providers.${name}.maxConcurrent must be a positive safe integer or null`,
        );
      } else {
        maxConcurrent = p.maxConcurrent;
      }
    }
    // Operator-asserted rate limits. Hard error on a malformed block — same reasoning as inside
    // credentials[] above: an ignored typo reads as a ceiling nobody actually declared. Parsed
    // BEFORE the unset-${ENV} soft disable below, mirroring the fleet precedent: the parse is
    // purely syntactic (no provider-map lookups), so it cannot reintroduce the failure shape
    // where a tier naming a degraded provider aborts startup.
    const limits = parseConfiguredLimits(p.limits, `config.providers.${name}.limits`);
    // Same reasoning, same placement: a compat typo that were merely ignored would read as a
    // declaration that took effect while changing nothing on the wire.
    const compat = parseProviderCompat(p.compat, `config.providers.${name}.compat`);
    if (expanded.missing.length > 0) {
      warnings.push(
        `provider "${name}" DISABLED — base references unset env var ` +
          `${expanded.missing.map((n) => `\${${n}}`).join(", ")}. ` +
          `Set it and restart, or remove the provider. Everything else still works.`,
      );
      disabled.add(name);
      continue;
    }
    // Warn, don't fail: this proxy fronts every client session, so refusing to start over a
    // config that has worked for months would turn a hardening step into an outage. Scoped to
    // `anthropic` kind because that is the only path whose upstream headers come from the inbound
    // request at all — an `openai`-kind target gets a freshly built header map and can never
    // receive the caller's credential, so warning about `ollama` would be a false alarm.
    if (kind === "anthropic" && !declaresAuthEnv && credentialMode === undefined) {
      warnings.push(
        `provider "${name}" forwards the CALLER's own credential to ${expanded.value} — inferred from ` +
          `having no authEnv. Declare credentialMode "passthrough" to confirm that is intended, or ` +
          `"contained" to strip it.`,
      );
    }
    out[name] = {
      base: expanded.value.trim().replace(/\/+$/, ""),
      kind,
      authHeader: parseAuthHeader(p.authHeader, defaultAuthHeader),
      timeoutMs: typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs) && p.timeoutMs > 0 ? p.timeoutMs : 120000,
      ...(typeof p.stallTimeoutMs === "number" && Number.isFinite(p.stallTimeoutMs) && p.stallTimeoutMs >= 0
        ? { stallTimeoutMs: Math.floor(p.stallTimeoutMs) }
        : {}),
      // The declared name is a default, not a requirement: if the key is present under
      // a known alias instead, use that so an already-working env var doesn't have to
      // be renamed. Resolved here so routing, key checks and the backend all agree.
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
  if (Object.keys(out).length === 0) {
    throw new Error(`config.providers must define at least one provider`);
  }
  return out;
}

function parseRouting(
  raw: unknown,
  providers: Record<string, ProviderConfig>,
  overrideDefault: string | undefined,
  warnings: string[] = [],
  disabledProviders: Set<string> = new Set(),
): Routing {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as {
    default?: unknown;
    tiers?: unknown;
    pools?: unknown;
    offload?: unknown;
    subagents?: unknown;
    benchmarkSort?: unknown;
    sticky?: unknown;
    quota?: unknown;
    ladder?: unknown;
    ladders?: unknown;
    cliLane?: unknown;
  };
  // "pool" as a provider name would make `pool/<name>` ambiguous. Reject at load, not at request.
  if (providers[POOL_PREFIX]) {
    throw new Error(`config.providers."${POOL_PREFIX}" is reserved — it would shadow "pool/<name>" routing`);
  }
  const dfltRaw = overrideDefault !== undefined ? overrideDefault : r.default;
  let dflt: string | string[];

  if (Array.isArray(dfltRaw)) {
    dflt = dfltRaw.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (dflt.length === 0) {
      throw new Error(`config.routing.default array must contain at least one valid spec string`);
    }
  } else if (typeof dfltRaw === "string" && dfltRaw.length > 0) {
    dflt = dfltRaw;
  } else {
    throw new Error(`config.routing.default ("provider/model") is required`);
  }

  const tiers: Record<string, string | string[]> = {};
  if (typeof r.tiers === "object" && r.tiers !== null) {
    for (const [k, v] of Object.entries(r.tiers as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        const arr = v.filter((s): s is string => typeof s === "string" && s.length > 0);
        if (arr.length > 0) tiers[k] = arr;
      } else if (typeof v === "string" && v.length > 0) {
        tiers[k] = v;
      }
    }
  }

  const pools: Record<string, string[]> = {};
  const poolPolicies: Record<string, PoolPolicy> = {};
  if (typeof r.pools === "object" && r.pools !== null) {
    for (const [k, v] of Object.entries(r.pools as Record<string, unknown>)) {
      let declared: string[];
      if (Array.isArray(v)) {
        declared = v.filter((s): s is string => typeof s === "string" && s.length > 0);
      } else if (typeof v === "object" && v !== null) {
        const policy = v as { preferred?: unknown; include?: unknown; exclude?: unknown; effort?: unknown };
        if (!Array.isArray(policy.preferred) || policy.preferred.some((s) => typeof s !== "string" || s.length === 0)) {
          throw new Error(`config.routing.pools.${k}.preferred must be an array of non-empty "provider/model" specs`);
        }
        if (policy.include !== "free") {
          throw new Error(`config.routing.pools.${k}.include must be "free"`);
        }
        if (
          policy.exclude !== undefined &&
          (!Array.isArray(policy.exclude) ||
            policy.exclude.some(
              (s) =>
                typeof s !== "string" ||
                !/^\S+\/\S+$/.test(s) ||
                s.startsWith(`${POOL_PREFIX}/`),
            ))
        ) {
          throw new Error(`config.routing.pools.${k}.exclude must be an array of "provider/model" specs`);
        }
        if (policy.effort !== undefined && !EFFORT_LEVELS.has(policy.effort as EffortLevel)) {
          throw new Error(`config.routing.pools.${k}.effort must be low, medium, high, or xhigh`);
        }
        const exclude = [...((policy.exclude as string[] | undefined) ?? [])];
        const excluded = new Set(exclude);
        declared = (policy.preferred as string[]).filter((spec) => !excluded.has(spec));
        poolPolicies[k] = {
          preferred: declared,
          include: "free",
          ...(exclude.length > 0 ? { exclude } : {}),
          ...(policy.effort ? { effort: policy.effort as EffortLevel } : {}),
        };
      } else {
        throw new Error(
          `config.routing.pools.${k} must be an array of specs or {"preferred":[...],"include":"free"}`,
        );
      }
      // Members of a DISABLED provider are dropped, not fatal — the pool's whole purpose is
      // surviving the loss of one candidate. A member naming a provider that simply doesn't
      // exist is still an error below: that's a typo, and silently dropping it would spend
      // primary quota via the passthrough instead of failing loudly.
      const arr = declared.filter((s) => {
        const { provider } = splitSpec(s);
        if (!disabledProviders.has(provider)) return true;
        warnings.push(`routing.pools.${k}: dropped "${s}" — provider "${provider}" is disabled`);
        return false;
      });
      if (arr.length === 0 && !poolPolicies[k]) {
        throw new Error(`config.routing.pools.${k} must contain at least one valid spec string`);
      }
      // Members are provider specs only — pool-in-pool would make expansion recursive.
      const nested = arr.find((s) => s.startsWith(`${POOL_PREFIX}/`));
      if (nested) {
        throw new Error(`config.routing.pools.${k} member "${nested}" — a pool cannot reference another pool`);
      }
      pools[k] = arr;
      if (poolPolicies[k]) poolPolicies[k] = { ...poolPolicies[k]!, preferred: arr, include: "free" };
    }
  }

  const subagents: Record<string, string> = {};
  if (typeof r.subagents === "object" && r.subagents !== null) {
    for (const [k, v] of Object.entries(r.subagents as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) subagents[k] = v;
    }
  }

  const benchmarkSort = typeof r.benchmarkSort === "boolean" ? r.benchmarkSort : true;
  const offload = parseOffload(r.offload);
  const routing: Routing = { default: dflt, tiers, benchmarkSort, offload };
  const sticky = parseSticky(r.sticky);
  if (sticky) routing.sticky = sticky;
  const quota = parseQuotaEnforcement(r.quota);
  if (quota) routing.quota = quota;
  if (Object.keys(pools).length > 0) routing.pools = pools;
  if (Object.keys(poolPolicies).length > 0) routing.poolPolicies = poolPolicies;
  if (Object.keys(subagents).length > 0) routing.subagents = subagents;
  const ladder = parseLadder(r.ladder, "config.routing.ladder");
  if (ladder.length > 0) routing.ladder = ladder;
  if (r.ladders !== undefined && (typeof r.ladders !== "object" || r.ladders === null || Array.isArray(r.ladders))) {
    throw new Error(`config.routing.ladders must be an object of named ladder arrays`);
  }
  const ladders: Record<string, LadderRung[]> = {};
  for (const [tier, rawLadder] of Object.entries((r.ladders ?? {}) as Record<string, unknown>)) {
    const parsed = parseLadder(rawLadder, `config.routing.ladders.${tier}`);
    if (parsed.length === 0) throw new Error(`config.routing.ladders.${tier} must contain at least one rung`);
    ladders[tier] = parsed;
  }
  if (Object.keys(ladders).length > 0) routing.ladders = ladders;
  const cliLane = parseCliLane(r.cliLane, "config.routing.cliLane");
  if (cliLane) routing.cliLane = cliLane;

  // A spec naming a DISABLED provider is dropped with a warning, exactly like a pool member;
  // a spec naming a provider that was never declared is still fatal below. Doing this before
  // the assertions is what keeps "one optional provider lost its ${ENV}" from being a total
  // outage: assertSpecResolvable sees the post-disabling provider map, so it cannot tell the
  // two apart and used to abort startup for the degraded case too.
  for (const [tier, spec] of Object.entries(tiers)) {
    const kept = dropDisabledSpecs(spec, disabledProviders, warnings, `routing.tiers.${tier}`);
    if (kept === null) delete tiers[tier];
    else tiers[tier] = kept;
  }
  for (const [tier, spec] of Object.entries(subagents)) {
    // A subagent entry is a single spec, so the result is a string or nothing.
    const kept = dropDisabledSpecs(spec, disabledProviders, warnings, `routing.subagents.${tier}`) as
      | string
      | null;
    if (kept === null) delete subagents[tier];
    else subagents[tier] = kept;
  }
  if (Array.isArray(routing.default)) {
    // Only an ARRAY default can degrade — the survivors still answer. A single-spec default
    // has nothing left to fall back to, so it stays fatal below.
    const kept = dropDisabledSpecs(routing.default, disabledProviders, warnings, "routing.default");
    if (kept !== null) routing.default = kept;
  }
  routing.ladder = ladder.filter((rung) => {
    if (rung.kind !== "relay" || !rung.spec) return true;
    return dropDisabledSpecs(rung.spec, disabledProviders, warnings, `routing.ladder[${rung.id}].spec`) !== null;
  });
  if (routing.ladder.length === 0) delete routing.ladder;
  for (const [tier, tierLadder] of Object.entries(routing.ladders ?? {})) {
    const kept = tierLadder.filter((rung) => {
      if (rung.kind !== "relay" || !rung.spec) return true;
      return dropDisabledSpecs(rung.spec, disabledProviders, warnings, `routing.ladders.${tier}[${rung.id}].spec`) !== null;
    });
    if (kept.length === 0) delete routing.ladders![tier];
    else routing.ladders![tier] = kept;
  }
  if (routing.ladders && Object.keys(routing.ladders).length === 0) delete routing.ladders;

  // Fail loudly at load time if any spec names an unknown provider or pool. Only
  // `routing.default` can still trip on a DISABLED provider — everything else degraded
  // above — and it is fatal on purpose: it is the fall-through for everything, so there
  // is nowhere left to fall through to.
  assertSpecResolvable(routing.default, providers, pools, "routing.default", disabledProviders);
  for (const [tier, spec] of Object.entries(tiers)) {
    assertSpecResolvable(spec, providers, pools, `routing.tiers.${tier}`);
  }
  for (const [pool, specs] of Object.entries(pools)) {
    assertSpecResolvable(specs, providers, {}, `routing.pools.${pool}`);
  }
  for (const [tier, spec] of Object.entries(subagents)) {
    assertSpecResolvable(spec, providers, pools, `routing.subagents.${tier}`);
  }
  for (const rung of routing.ladder ?? []) {
    if (rung.kind === "relay" && rung.spec) {
      assertSpecResolvable(rung.spec, providers, pools, `routing.ladder[${rung.id}].spec`);
    }
  }
  for (const [tier, tierLadder] of Object.entries(routing.ladders ?? {})) {
    for (const rung of tierLadder) {
      if (rung.kind === "relay" && rung.spec) {
        assertSpecResolvable(rung.spec, providers, pools, `routing.ladders.${tier}[${rung.id}].spec`);
      }
    }
  }
  return routing;
}

function parseSticky(raw: unknown): StickyRoutingConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") {
    return { enabled: raw, ttlMs: 1_800_000, maxSessions: 1000 };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config.routing.sticky must be a boolean or an object`);
  }

  const sticky = raw as Record<string, unknown>;
  if (typeof sticky.enabled !== "boolean") {
    throw new Error(`config.routing.sticky.enabled must be a boolean`);
  }

  let ttlMs = 1_800_000;
  if (sticky.ttlMs !== undefined) {
    if (
      typeof sticky.ttlMs !== "number" ||
      !Number.isFinite(sticky.ttlMs) ||
      sticky.ttlMs < 1000 ||
      sticky.ttlMs > 86_400_000
    ) {
      throw new Error(`config.routing.sticky.ttlMs must be between 1000 and 86400000 ms (1s to 24h)`);
    }
    ttlMs = Math.floor(sticky.ttlMs);
  }

  let maxSessions = 1000;
  if (sticky.maxSessions !== undefined) {
    if (
      typeof sticky.maxSessions !== "number" ||
      !Number.isFinite(sticky.maxSessions) ||
      sticky.maxSessions < 10 ||
      sticky.maxSessions > 100_000
    ) {
      throw new Error(`config.routing.sticky.maxSessions must be an integer between 10 and 100000`);
    }
    maxSessions = Math.floor(sticky.maxSessions);
  }

  return { enabled: sticky.enabled, ttlMs, maxSessions };
}

/** Parse the legacy global switch or the independently keyed client-rule form. */
export function parseOffload(raw: unknown): OffloadConfig {
  // Absent => false. Offload is opt-in: a missing key must never mean "send every request to
  // another provider, which is what an implicit-on default would do to an existing config.
  let out: OffloadConfig = false;

  if (typeof raw === "boolean") {
    out = raw;
  } else if (raw !== undefined) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`config.routing.offload must be a boolean or an object keyed by client`);
    }

    const parsed: Record<string, OffloadRule> = {};
    for (const [client, value] of Object.entries(raw as Record<string, unknown>)) {
      if (client.length === 0) throw new Error(`config.routing.offload client name must not be empty`);
      if (typeof value === "boolean") {
        parsed[client] = { enabled: value, scope: "subagents" };
        continue;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`config.routing.offload.${client} must be a boolean or {"enabled":bool,"scope":...}`);
      }
      const rule = value as { enabled?: unknown; scope?: unknown; freeOnly?: unknown };
      if (typeof rule.enabled !== "boolean") {
        throw new Error(`config.routing.offload.${client}.enabled must be true or false`);
      }
      const scope = rule.scope === undefined ? "subagents" : rule.scope;
      if (scope !== "subagents" && scope !== "all") {
        throw new Error(`config.routing.offload.${client}.scope must be "subagents" or "all"`);
      }
      if (rule.freeOnly !== undefined && typeof rule.freeOnly !== "boolean") {
        throw new Error(`config.routing.offload.${client}.freeOnly must be true or false`);
      }
      // ⚠ Stored EXACTLY as configured — absent stays absent. The default is applied where the
      // rule is consulted (`freeOnlyApplies` in server.ts), not baked in here, because "unset"
      // and "explicitly false" have to stay distinguishable: an unset flag defaults ON for
      // offload-rerouted traffic and OFF for a directly addressed pool, and materializing a value
      // here would collapse that into one answer. It also keeps `setOffload` from inventing a
      // field the operator never wrote.
      parsed[client] = { enabled: rule.enabled, scope, ...(rule.freeOnly !== undefined ? { freeOnly: rule.freeOnly } : {}) };
    }
    out = parsed;
  }

  return out;
}

/** ASCII control characters are never valid in environment variable names. */
function hasAsciiControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
/**
 * Drop the members of a spec (or spec list) whose provider was disabled by an unset `${ENV}`,
 * warning for each. Returns the survivors, or `null` when nothing survives.
 *
 * ⚠ The warning states the CONSEQUENCE, not just the fact. When a `routing.subagents` entry
 * disappears, that traffic falls through to `routing.default` — the Anthropic passthrough — so
 * the dispatcher believes it offloaded while spending primary quota, and nothing in the
 * response says otherwise. That is the same hazard an unresolvable `@relay:` directive is a
 * hard error for; the difference is that this one is visible once, at startup, where the
 * operator can act on it, and the alternative (aborting) takes down every client session for
 * a provider that may not even be in use.
 */
function dropDisabledSpecs(
  spec: string | string[],
  disabled: Set<string>,
  warnings: string[],
  where: string,
): string | string[] | null {
  if (disabled.size === 0) return spec;
  const specs = Array.isArray(spec) ? spec : [spec];
  const kept = specs.filter((s) => {
    const { provider } = splitSpec(s);
    if (provider === POOL_PREFIX || !disabled.has(provider)) return true;
    warnings.push(
      `config.${where}: dropped "${s}" — provider "${provider}" is disabled. ` +
        `That routing now falls through to routing.default, which for a passthrough default ` +
        `means primary quota.`,
    );
    return false;
  });
  if (kept.length === 0) return null;
  return Array.isArray(spec) ? kept : kept[0]!;
}

/** Placeholder a cli rung's args must contain. Duplicated from dispatch.ts as a literal rather
 *  than imported, to keep config.ts free of dependencies on modules that import it. */
const LADDER_TASK_TOKEN = "{task}";

/** Placeholder a cliLane template's args must contain, replaced by the rung's routing spec. */
const LADDER_SPEC_TOKEN = "{spec}";

/** Optional cliLane placeholder for the spec's published context window. Legal in args AND env. */
const LADDER_CONTEXT_TOKEN = "{contextWindow}";

/**
 * Environment a HOST applies when spawning a rendered command — shared by `cli` rungs and the
 * `cliLane` template, because a divergence between the two would be a silent one: both are
 * handed to the same spawn site, and the stricter of two copies is whichever was edited last.
 */
function parseSpawnEnv(raw: unknown, where: string): Record<string, string | null> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where}.env must be an object mapping variable names to a string (set) or null (unset)`);
  }
  const env: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    // "=", whitespace and control characters cannot appear in an environment variable NAME on any
    // platform this runs on; accepting one would render a command that silently sets a different
    // variable than the config names.
    if (name.length === 0 || name.includes("=") || /\s/.test(name) || hasAsciiControl(name)) {
      throw new Error(`${where}.env has an invalid variable name ${JSON.stringify(name)}`);
    }
    if (typeof value !== "string" && value !== null) {
      throw new Error(`${where}.env.${name} must be a string (set) or null (unset)`);
    }
    env[name] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Validate `routing.cliLane` at load. A template missing `{spec}` cannot address a target: every
 * rung it rendered would invoke the same default model, so the ladder would appear to fail over
 * while sending every lane to one place. That is worse than having no template at all, which is
 * why it is a hard error rather than a warning.
 */
function parseCliLane(raw: unknown, root: string): CliLaneTemplate | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${root} must be an object`);
  const e = raw as Record<string, unknown>;

  if (typeof e.command !== "string" || e.command.length === 0) {
    throw new Error(`${root}.command must be a non-empty string`);
  }
  if (!Array.isArray(e.args) || e.args.some((a) => typeof a !== "string")) {
    throw new Error(`${root}.args must be an array of strings`);
  }
  const args = e.args as string[];
  if (!args.some((a) => a.includes(LADDER_SPEC_TOKEN))) {
    throw new Error(
      `${root}.args must contain "${LADDER_SPEC_TOKEN}" in one argument — otherwise every transposed rung ` +
        `invokes ${e.command} with the same model and the ladder only appears to fail over`,
    );
  }
  if (!args.some((a) => a.includes(LADDER_TASK_TOKEN))) {
    throw new Error(`${root}.args must contain "${LADDER_TASK_TOKEN}" in one argument — otherwise the task is never passed to ${e.command}`);
  }

  const lane: CliLaneTemplate = { command: e.command, args };
  const env = parseSpawnEnv(e.env, root);
  if (env) {
    // `{task}` in an env value would put text a model or user wrote into a spawned process's
    // environment. It is never substituted, so leaving it legal would silently pass the literal
    // string `{task}` to the child — the operator would believe it worked. Reject it by name.
    // `{contextWindow}` IS substituted here, deliberately: it is a number this relay resolved from
    // published provider metadata, i.e. configuration rather than request content.
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === "string" && value.includes(LADDER_TASK_TOKEN)) {
        throw new Error(
          `${root}.env.${name} must not contain "${LADDER_TASK_TOKEN}" — task text is never placed in a spawned ` +
            `process's environment (use args for the task; "${LADDER_CONTEXT_TOKEN}" is available here)`,
        );
      }
    }
    lane.env = env;
  }
  return lane;
}

/**
 * Validate `routing.ladder` at load, not at request time — a ladder whose rung cannot be invoked
 * is a configuration mistake, and discovering it only when the host is mid-fallback is exactly
 * when it is least useful. Absent/empty is legal and simply means "no opinion".
 */
function parseLadder(raw: unknown, root: string): LadderRung[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${root} must be an array of rungs`);

  const out: LadderRung[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const where = `${root}[${i}]`;
    if (typeof entry !== "object" || entry === null) throw new Error(`${where} must be an object`);
    const e = entry as Record<string, unknown>;

    const id = e.id;
    if (typeof id !== "string" || id.length === 0) throw new Error(`${where}.id must be a non-empty string`);
    // Ids address rungs in /dispatch overrides and exhaustion reports; a duplicate would make
    // "use lane X" ambiguous, and silently picking the first is not a decision to make for the user.
    if (seen.has(id)) throw new Error(`${where}.id "${id}" is already used by an earlier rung`);
    seen.add(id);

    const kind = e.kind;
    if (kind !== "cli" && kind !== "relay") throw new Error(`${where}.kind must be "cli" or "relay" (got ${JSON.stringify(kind)})`);

    const rung: LadderRung = { id, kind, enabled: e.enabled !== false };
    if (typeof e.quota === "string" && e.quota.length > 0) rung.quota = e.quota;
    if (typeof e.note === "string" && e.note.length > 0) rung.note = e.note;

    if (kind === "cli") {
      if (typeof e.command !== "string" || e.command.length === 0) {
        throw new Error(`${where}.command must be a non-empty string for a "cli" rung`);
      }
      if (!Array.isArray(e.args) || e.args.some((a) => typeof a !== "string")) {
        throw new Error(`${where}.args must be an array of strings for a "cli" rung`);
      }
      const args = e.args as string[];
      // Without the placeholder the task text has nowhere to go and the rung would invoke the
      // agent with an empty prompt — a failure that looks like the model ignoring the request.
      if (!args.some((a) => a.includes(LADDER_TASK_TOKEN))) {
        throw new Error(`${where}.args must contain "${LADDER_TASK_TOKEN}" in one argument — otherwise the task is never passed to ${e.command}`);
      }
      rung.command = e.command;
      rung.args = args;
      const env = parseSpawnEnv(e.env, where);
      if (env) rung.env = env;
    } else {
      if (typeof e.spec !== "string" || e.spec.length === 0) {
        throw new Error(`${where}.spec must be a non-empty string for a "relay" rung`);
      }
      rung.spec = e.spec;
    }
    out.push(rung);
  }
  return out;
}

function assertSpecResolvable(
  spec: string | string[],
  providers: Record<string, ProviderConfig>,
  pools: Record<string, string[]>,
  where: string,
  disabled: Set<string> = new Set(),
): void {
  const specs = Array.isArray(spec) ? spec : [spec];
  for (const s of specs) {
    const { provider, model } = splitSpec(s);
    if (provider === POOL_PREFIX) {
      if (!model || !pools[model]) {
        throw new Error(
          `config.${where} "${s}" names unknown pool "${model ?? ""}" (available: ${Object.keys(pools).join(", ") || "none"})`,
        );
      }
      continue;
    }
    const p = providers[provider];
    // A disabled provider is absent from `providers`, so without this it is reported as a
    // typo — sending the operator to look for a misspelling that isn't there instead of at
    // the unset environment variable that actually caused it.
    if (!p && disabled.has(provider)) {
      throw new Error(
        `config.${where} "${s}" names provider "${provider}", which is DISABLED because its ` +
          `base references an unset \${ENV} (see the warning above). Set the variable, or point ` +
          `${where} somewhere else.`,
      );
    }
    if (!p) throw new Error(`config.${where} "${s}" names unknown provider "${provider}"`);
    if (p.kind === "openai" && !model) throw new Error(`config.${where} "${s}" needs a model id for openai provider "${provider}"`);
  }
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
