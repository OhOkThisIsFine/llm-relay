import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  DEFAULT_CLIENT,
  offloadRule,
  parseOffload,
  unroutableOffloadClient,
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
  /** Advisory: the targeted client name is one no request path ever produces (dead rule). */
  warning?: string;
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

  // A targeted view of a name no request path produces carries the warning on the state itself,
  // so every surface reading it (CLI, GET/POST /offload, live or file-only) reports the dead rule.
  const unroutable = client !== undefined ? unroutableOffloadClient(client, cfg) : null;

  return {
    enabled,
    scope,
    ...(client !== undefined ? { client } : {}),
    subagents: cfg.routing.subagents ?? {},
    clients,
    persisted: true,
    ...(cfg.sourcePath ? { configPath: cfg.sourcePath } : {}),
    ...(unroutable ? { warning: unroutable.message } : {}),
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

  const next: Record<string, OffloadRule> = typeof configured === "object"
    ? { ...configured }
    : { [DEFAULT_CLIENT]: ruleFor(configured, client) };
  const existing = next[client] ?? ruleFor(configured, client);
  // Spread first: a toggle must not strip rule details it was not asked about (freeOnly).
  next[client] = { ...existing, enabled, scope: scope ?? existing.scope };
  cfg.routing.offload = next;
}

function setInFile(
  raw: Record<string, unknown>,
  enabled: boolean,
  client?: string,
  scope?: OffloadScope,
): void {
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
    next[client] = {
      ...(typeof existing === "object" && existing !== null && !Array.isArray(existing) ? existing : {}),
      enabled,
      scope: scope ?? existingScope,
    };
    routing.offload = next;
  }
  raw.routing = routing;
}

let tempSequence = 0;

function tempConfigPath(configPath: string): string {
  const directory = dirname(configPath);
  const name = `.${basename(configPath)}.${process.pid}.${Date.now()}.${tempSequence++}.tmp`;
  return join(directory, name);
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
  const nextCfg = structuredClone(cfg);
  setInMemory(nextCfg, enabled, client, scope);

  if (!cfg.sourcePath) {
    cfg.routing.offload = nextCfg.routing.offload!;
    const state = offloadState(cfg, client);
    return { ...state, persisted: false, persistError: "config was not loaded from a file" };
  }

  let temporaryPath: string | undefined;
  try {
    // Publish beside the canonical target. Renaming over cfg.sourcePath directly would replace a
    // symlink instead of atomically updating the file it intentionally points at.
    const persistencePath = realpathSync(cfg.sourcePath);
    const raw = JSON.parse(readFileSync(persistencePath, "utf8")) as Record<string, unknown>;
    const existingMode = statSync(persistencePath).mode & 0o777;
    setInFile(raw, enabled, client, scope);
    const routing = raw.routing as Record<string, unknown>;
    // Parse the exact value about to be published. This both rejects a concurrently corrupted
    // offload section and keeps live memory aligned with valid edits made since cfg was loaded.
    const persistedOffload = parseOffload(routing.offload);

    const directory = dirname(persistencePath);
    mkdirSync(directory, { recursive: true });
    temporaryPath = tempConfigPath(persistencePath);
    writeFileSync(temporaryPath, JSON.stringify(raw, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: existingMode,
    });
    // Creation mode is filtered through the process umask. Apply the original bits explicitly,
    // then flush complete contents before making the temporary inode visible as the config.
    if (process.platform !== "win32") chmodSync(temporaryPath, existingMode);
    // Windows requires a writable handle for FlushFileBuffers/fsync.
    const descriptor = openSync(temporaryPath, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, persistencePath);
    temporaryPath = undefined;
    // POSIX requires the containing directory to be flushed for the rename itself to survive a
    // crash. Directory fsync is unavailable on Windows and can be unsupported on some filesystems,
    // so this durability enhancement is best-effort after the atomic publication succeeds.
    if (process.platform !== "win32") {
      let directoryDescriptor: number | undefined;
      try {
        directoryDescriptor = openSync(directory, "r");
        fsyncSync(directoryDescriptor);
      } catch {
        // The file is already atomically published; do not report a false failed transaction.
      } finally {
        if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
      }
    }

    cfg.routing.offload = persistedOffload;
    return offloadState(cfg, client);
  } catch (e) {
    if (temporaryPath !== undefined) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Best effort only: preserve the persistence error that prevented the commit.
      }
    }
    return { ...offloadState(cfg, client), persisted: false, persistError: (e as Error).message };
  }
}
