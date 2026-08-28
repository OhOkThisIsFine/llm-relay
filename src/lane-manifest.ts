import { relayStatePath } from "./state-paths.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

/**
 * What a `cli` lane's own tool says it can serve.
 *
 * A `cli` rung is opaque config rendered verbatim into a command the host runs, so nothing
 * validated it. Measured 2026-08-08: the ladder handed an agent
 * `agy --model claude-opus-5 --effort medium`, in which BOTH halves were wrong independently —
 * AGY serves no Claude 5 at all, and `--effort` is rejected outright for its Claude models. The
 * lane looked healthy and completed nothing. See docs/lane-discovery.md.
 *
 * ⚠ A model the vendor does not serve is `not-servable` — an EXISTENCE fact, so the rung is
 * REMOVED, not demoted. `target-facts.ts` already draws that line: `allowance-exhausted` demotes
 * because it expires, `not-servable` removes because it will not start existing.
 *
 * ⚠ Eviction requires POSITIVE evidence. "This lane's roster is known and the model is not in it"
 * evicts; "no manifest, or this lane was never probed" is UNKNOWN and changes nothing. Same
 * fail-safe as a signature miss in `refusal-interpretation.ts`, and the same reasoning that makes
 * an unset `${ENV}` disable one provider rather than abort startup — a stale manifest must never
 * be able to empty the ladder, because this proxy fronts every session.
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

/**
 * ⚠ Under vitest, never read the developer's real manifest — same rule and same reason as
 * `getProbeCachePath()`. A suite fixture naming a made-up model (`agy-gemini`, `codex`) would be
 * evicted by the machine's ACTUAL roster, so three pre-existing dispatch tests went red the moment
 * a real `lanes --probe` had been run. A test's ladder must be decided by its own config, not by
 * whichever CLIs happen to be installed. Tests needing a manifest pass one explicitly.
 */
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
    const j = JSON.parse(readFileSync(path, "utf8")) as LaneManifest;
    if (j?.version !== 1 || typeof j.lanes !== "object" || j.lanes === null) return null;
    // Deep-validate each lane entry: corrupt ⇒ null ⇒ unknown (the loader's documented contract)
    for (const entry of Object.values(j.lanes)) {
      if (!isLaneEntry(entry)) return null;
    }
    return j;
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

export type ModelVerdict =
  | { status: "unknown"; reason: string }
  | { status: "servable" }
  | { status: "not-servable"; reason: string };

/**
 * Is this model one the lane's tool says it serves?
 *
 * ⚠ Every negative path that is not positive evidence returns `unknown`. Only a KNOWN roster that
 * omits the model produces `not-servable`.
 */
export function verifyModel(
  manifest: LaneManifest | null,
  command: string,
  model: string,
): ModelVerdict {
  const lane = laneOfCommand(command);
  if (!lane) return { status: "unknown", reason: "command is not a lane this relay can probe" };
  const entry = manifest?.lanes[lane];
  if (!entry) return { status: "unknown", reason: `lane "${lane}" has never been probed` };
  if (entry.models.length === 0) return { status: "unknown", reason: `lane "${lane}" probed but returned no roster` };
  if (entry.models.some((m) => m.id === model)) return { status: "servable" };
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
): { unsupported: boolean; reason?: string } {
  const lane = laneOfCommand(command);
  if (!lane) return { unsupported: false };
  const entry = manifest?.lanes[lane];
  if (!entry) return { unsupported: false };

  const rejected = entry.rejectedArgs?.[model];
  if (rejected?.includes(arg)) {
    return { unsupported: true, reason: `${lane} rejects "${arg}" for "${model}" (observed)` };
  }
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
