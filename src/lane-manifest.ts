import { relayStatePath } from "./state-paths.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * What a CLI harness reports it can serve. Fresh positive roster evidence may remove a model the
 * harness does not serve; missing, stale, or unprobed evidence remains unknown and never evicts.
 */
export interface LaneModel {
  id: string;
  /** Argument values the tool states this model supports, keyed by argument name. */
  supports?: Record<string, string[]>;
}

export interface LaneEntry {
  /** Which command produced this roster, so a reader can tell a listing from an attempt. */
  via: string;
  probedAt: string;
  models: LaneModel[];
  /**
   * Arguments this lane's tool REJECTED for a given model, learned from an observed failure
   * rather than probed. AGY publishes no flag support, so its facts can only arrive this way.
   */
  rejectedArgs?: Record<string, string[]>;
}

export interface LaneManifest {
  version: 1;
  lanes: Record<string, LaneEntry>;
}

/** Tests use an isolated manifest path so local CLI rosters cannot change fixture routing. */
export function getLaneManifestPath(): string {
  if (process.env.VITEST) return join(tmpdir(), "llm-relay-vitest", "lane-manifest.json");
  return relayStatePath("cache", ["lane-manifest.json"]);
}

export const DEFAULT_MANIFEST_PATH = getLaneManifestPath();

function isLaneModel(obj: unknown): obj is LaneModel {
  return typeof obj === "object" && obj !== null && typeof (obj as Record<string, unknown>).id === "string";
}

function isLaneEntry(obj: unknown): obj is LaneEntry {
  if (typeof obj !== "object" || obj === null) return false;
  const e = obj as Record<string, unknown>;
  if (typeof e.via !== "string") return false;
  if (typeof e.probedAt !== "string") return false;
  if (!Array.isArray(e.models)) return false;
  return e.models.every(isLaneModel);
}

export function loadLaneManifest(path: string = DEFAULT_MANIFEST_PATH): LaneManifest | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const j = parsed as Record<string, unknown>;
    if (j["version"] !== 1 || typeof j["lanes"] !== "object" || j["lanes"] === null) return null;
    const manifest = j as unknown as LaneManifest;
    // Deep-validate each lane entry: corrupt ⇒ null ⇒ unknown (the loader's documented contract)
    for (const entry of Object.values(manifest.lanes)) {
      if (!isLaneEntry(entry)) return null;
    }
    return manifest;
  } catch {
    // Unreadable is UNKNOWN, never "nothing is servable". A corrupt manifest that evicted every
    // rung would turn a hygiene feature into a total outage.
    return null;
  }
}

export function saveLaneManifest(m: LaneManifest, path: string = DEFAULT_MANIFEST_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
}

/** The lane a command belongs to. Closed set — an unrecognized command is UNKNOWN, never evicted. */
export function laneOfCommand(command: string): string | null {
  const base = (command.split(/[\\/]/).pop() ?? command).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  if (base === "agy") return "agy";
  if (base === "codex") return "codex";
  return null;
}

/**
 * Identify a known harness in either the command or wrapper args. Exact basenames avoid matching
 * model values that merely contain a harness name. Returns the harness binary token for probing.
 */
export function laneOfRung(
  command: string,
  args?: readonly string[],
): { lane: string; binary: string } | null {
  const direct = laneOfCommand(command);
  if (direct) return { lane: direct, binary: command };
  for (const token of args ?? []) {
    const lane = laneOfCommand(token);
    if (lane) return { lane, binary: token };
  }
  return null;
}

/**
 * Maximum roster age for negative evidence. A stale roster may still confirm a listed model but is
 * too weak to evict an unlisted one.
 */
export const LANE_ROSTER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** True when `probedAt` is unparseable or older than `LANE_ROSTER_TTL_MS`. */
export function rosterIsStale(entry: LaneEntry, now: number = Date.now()): boolean {
  const probed = Date.parse(entry.probedAt);
  if (!Number.isFinite(probed)) return true;
  return now - probed > LANE_ROSTER_TTL_MS;
}

export type ModelVerdict =
  | { status: "unknown"; reason: string }
  | { status: "servable" }
  | { status: "not-servable"; reason: string };

/** Resolve model support from roster evidence. Only a fresh known omission yields `not-servable`. */
export function verifyModel(
  manifest: LaneManifest | null,
  command: string,
  model: string,
  opts: { args?: readonly string[] | undefined; now?: number | undefined } = {},
): ModelVerdict {
  const rung = laneOfRung(command, opts.args);
  if (!rung) return { status: "unknown", reason: "command is not a lane this relay can probe" };
  const lane = rung.lane;
  const entry = manifest?.lanes[lane];
  if (!entry) return { status: "unknown", reason: `lane "${lane}" has never been probed` };
  if (entry.models.length === 0) return { status: "unknown", reason: `lane "${lane}" probed but returned no roster` };
  if (entry.models.some((m) => m.id === model)) return { status: "servable" };
  if (rosterIsStale(entry, opts.now)) {
    return {
      status: "unknown",
      reason: `lane "${lane}"'s roster is stale (probed ${entry.probedAt}) — treated as unprobed; run \`llm-relay lanes --probe\``,
    };
  }
  return {
    status: "not-servable",
    reason: `"${model}" is not in ${lane}'s roster (probed ${entry.probedAt} via \`${entry.via}\`)`,
  };
}

/**
 * Argument values the lane is KNOWN to reject for this model — from a stated support list where the
 * tool publishes one (Codex), or from an observed rejection where it does not (AGY).
 */
export function unsupportedArgValues(
  manifest: LaneManifest | null,
  command: string,
  model: string,
  arg: string,
  value: string,
  opts: { args?: readonly string[] | undefined; now?: number | undefined } = {},
): { unsupported: boolean; reason?: string } {
  const rung = laneOfRung(command, opts.args);
  if (!rung) return { unsupported: false };
  const lane = rung.lane;
  const entry = manifest?.lanes[lane];
  if (!entry) return { unsupported: false };

  // Observed rejections are existence facts about a flag, not roster snapshots — they never age.
  const rejected = entry.rejectedArgs?.[model];
  if (rejected?.includes(arg)) {
    return { unsupported: true, reason: `${lane} rejects "${arg}" for "${model}" (observed)` };
  }
  // A stated support list is roster evidence, and dropping an argument on it is the same eviction
  // move as `not-servable` — so it demands the same freshness (`LANE_ROSTER_TTL_MS`).
  if (rosterIsStale(entry, opts.now)) return { unsupported: false };
  const stated = entry.models.find((m) => m.id === model)?.supports?.[arg];
  // Absence of a support list is UNKNOWN — only a stated list that omits the value is evidence.
  if (stated && !stated.includes(value)) {
    return { unsupported: true, reason: `${lane} states "${model}" supports ${arg}: ${stated.join(",")} (not "${value}")` };
  }
  return { unsupported: false };
}

/** Record an argument this lane rejected for a model. An existence fact — it does not expire. */
export function recordRejectedArg(m: LaneManifest, lane: string, model: string, arg: string): LaneManifest {
  const entry = m.lanes[lane];
  if (!entry) return m;
  const rejected = entry.rejectedArgs ?? {};
  const forModel = new Set(rejected[model] ?? []);
  forModel.add(arg);
  entry.rejectedArgs = { ...rejected, [model]: [...forModel] };
  return m;
}
