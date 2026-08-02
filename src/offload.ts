import { readFileSync, writeFileSync } from "node:fs";
import {
  DEFAULT_CLIENT,
  offloadRule,
  type Config,
  type OffloadConfig,
  type OffloadRule,
  type OffloadScope,
} from "./config.js";

/** Runtime view of one or all client-specific offload rules. */
export interface OffloadState {
  /** Selected client's state, or true when any client rule is enabled in aggregate status. */
  enabled: boolean;
  /** Selected scope; aggregate status reports `mixed` when rules disagree. */
  scope: OffloadScope | "mixed";
  /** Originating harness selected by the caller, when this is a targeted view. */
  client?: string;
  /** Tier → spec map consulted when the selected rule applies. */
  subagents: Record<string, string>;
  /** All independently configurable client rules. Empty for the legacy boolean form. */
  clients: Record<string, OffloadRule>;
  persisted: boolean;
  configPath?: string;
  /** Why persistence failed, when it did. */
  persistError?: string;
}

function normalizedClients(cfg: Config): Record<string, OffloadRule> {
  const configured = cfg.routing.offload;
  if (typeof configured === "boolean" || configured === undefined) return {};
  return { ...configured };
}

function aggregateScope(clients: Record<string, OffloadRule>): OffloadScope | "mixed" {
  const scopes = [...new Set(Object.values(clients).map((rule) => rule.scope))];
  if (scopes.length === 0) return "subagents";
  return scopes.length === 1 ? scopes[0]! : "mixed";
}

export function offloadState(cfg: Config, client?: string): OffloadState {
  const configured = cfg.routing.offload;
  const clients = normalizedClients(cfg);
  const targeted = client !== undefined ? offloadRule(cfg, client) : null;
  const enabled = targeted?.enabled ??
    (typeof configured === "boolean" || configured === undefined
      ? configured === true
      : Object.values(configured).some((rule) => rule.enabled));
  const scope = targeted?.scope ??
    (typeof configured === "boolean" || configured === undefined ? "subagents" : aggregateScope(clients));

  return {
    enabled,
    scope,
    ...(client !== undefined ? { client } : {}),
    subagents: cfg.routing.subagents ?? {},
    clients,
    persisted: true,
    ...(cfg.sourcePath ? { configPath: cfg.sourcePath } : {}),
  };
}

function ruleFor(configured: OffloadConfig | undefined, client: string): OffloadRule {
  if (typeof configured === "boolean" || configured === undefined) {
    return { enabled: configured === true, scope: "subagents" };
  }
  return configured[client] ?? configured[DEFAULT_CLIENT] ?? { enabled: false, scope: "subagents" };
}

function setInMemory(cfg: Config, enabled: boolean, client?: string, scope?: OffloadScope): void {
  const configured = cfg.routing.offload;
  if (client === undefined) {
    if (typeof configured === "boolean" || configured === undefined) {
      cfg.routing.offload = enabled;
      return;
    }
    const next = { ...configured };
    for (const [name, rule] of Object.entries(next)) next[name] = { ...rule, enabled };
    cfg.routing.offload = next;
    return;
  }

  const next: Record<string, OffloadRule> =
    typeof configured === "object" && configured !== null ? { ...configured } :
      { [DEFAULT_CLIENT]: ruleFor(configured, client) };
  const existing = next[client] ?? ruleFor(configured, client);
  next[client] = { enabled, scope: scope ?? existing.scope };
  cfg.routing.offload = next;
}

/**
 * Flip one client rule, or the legacy/global set when no client is supplied, on the live Config.
 * A scope may be supplied when setting a targeted rule; existing scopes are preserved otherwise.
 * The next request sees the in-memory change without a restart.
 */
export function setOffload(
  cfg: Config,
  enabled: boolean,
  client?: string,
  scope?: OffloadScope,
): OffloadState {
  setInMemory(cfg, enabled, client, scope);
  const state = offloadState(cfg, client);

  if (!cfg.sourcePath) {
    return { ...state, persisted: false, persistError: "config was not loaded from a file" };
  }
  try {
    const raw = JSON.parse(readFileSync(cfg.sourcePath, "utf8")) as Record<string, unknown>;
    const routing = (typeof raw.routing === "object" && raw.routing !== null ? raw.routing : {}) as Record<
      string,
      unknown
    >;
    const configured = routing.offload;
    if (client === undefined) {
      if (typeof configured === "object" && configured !== null && !Array.isArray(configured)) {
        const next = { ...(configured as Record<string, unknown>) };
        for (const [name, value] of Object.entries(next)) {
          if (typeof value === "boolean") next[name] = { enabled, scope: "subagents" };
          else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            next[name] = { ...(value as Record<string, unknown>), enabled };
          }
        }
        routing.offload = next;
      } else {
        routing.offload = enabled;
      }
    } else {
      const next: Record<string, unknown> =
        typeof configured === "object" && configured !== null && !Array.isArray(configured)
          ? { ...(configured as Record<string, unknown>) }
          : { [DEFAULT_CLIENT]: { enabled: typeof configured === "boolean" ? configured : false, scope: "subagents" } };
      const existing = next[client];
      const existingScope =
        typeof existing === "object" && existing !== null && !Array.isArray(existing) &&
        ((existing as Record<string, unknown>).scope === "subagents" || (existing as Record<string, unknown>).scope === "all")
          ? (existing as Record<string, unknown>).scope
          : "subagents";
      next[client] = { ...(typeof existing === "object" && existing !== null && !Array.isArray(existing) ? existing : {}), enabled, scope: scope ?? existingScope };
      routing.offload = next;
    }
    raw.routing = routing;
    writeFileSync(cfg.sourcePath, JSON.stringify(raw, null, 2) + "\n", "utf8");
    return state;
  } catch (e) {
    return { ...state, persisted: false, persistError: (e as Error).message };
  }
}
