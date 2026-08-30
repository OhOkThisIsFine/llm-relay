import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandExistsOnPath } from "./executable-lookup.js";

/**
 * Which agent CLIs are actually INSTALLED on this machine.
 *
 * ⚠ This is a different question from every other detection in this repo, and the distinction is
 * the whole reason the module exists. `lane-probe.ts` asks "what does a lane the operator ALREADY
 * CONFIGURED serve?" — it walks `routing.ladders` and can say nothing about a tool nobody has
 * written into `config.json`. `authEnv.ts` asks "is the credential this provider DECLARED present?"
 * Neither can answer "the operator has Codex; should we offer to use it?", which is what an
 * onboarding conversation needs.
 *
 * ⚠ **Detection requires POSITIVE evidence, and reports its own basis.** A host is `installed`
 * only when a binary resolves on PATH, or a config path it owns AND llm-relay never writes exists.
 * Anything else is `installed: false`, which means "no evidence found" and never "this tool is
 * absent" — the same rule `lane-manifest.ts` applies to eviction and `key-checker.ts` to
 * `unverified`. Callers must not turn a negative into an assertion; the honest phrasing is
 * "not detected".
 *
 * ⚠ **THE FOOTPRINT RULE, and it is the sharpest thing here.** A config path counts as evidence
 * ONLY if llm-relay never creates it. An adversarial review caught the first version of this file
 * failing its own stated guard: it excluded the bare `~/.codex/` directory as circular but then
 * keyed Codex on `~/.codex/config.toml` — which **every llm-relay before v0.62.0 wrote
 * unconditionally**. So on every existing install that path exists regardless of Codex, and the
 * detection gate built on it would have been permanently open: a no-op dressed as a check. The
 * same held for `~/.claude` and `~/.config/opencode`, both of which `install-skill.mjs` creates
 * with `mkdirSync(..., { recursive: true })` when it copies the skill.
 *
 * Therefore only ONE host keeps a config path: `agy`, whose
 * `~/.gemini/antigravity-cli/settings.json` llm-relay has never written and does not manage. For
 * `claude`, `codex` and `opencode`, `installed` is exactly `onPath` — a binary is the only
 * evidence that is not our own footprint.
 *
 * ⚠ It never spawns. `commandExistsOnPath` is a pure `accessSync` walk, so unlike `winenv.ts`,
 * `os-keyring.ts` and `secret-file-acl.ts` this module needs no vitest spawn guard — but every
 * environment input is injectable so a test never reads the developer's real machine.
 */

export const AGENT_HOST_IDS = ["claude", "codex", "agy", "opencode"] as const;
export type AgentHostId = (typeof AGENT_HOST_IDS)[number];

interface HostProbe {
  readonly label: string;
  /** Binaries to try on PATH, in order. PATHEXT is applied by `commandExistsOnPath`. */
  readonly binaries: readonly string[];
  /**
   * Home-relative paths whose existence corroborates an install.
   *
   * ⚠ EMPTY unless llm-relay provably never creates the path — see the footprint rule above. An
   * entry here is a claim that finding this file proves the HOST is present, and llm-relay writing
   * it itself would make that claim false on every machine it has run on.
   */
  readonly configPaths: readonly string[];
}

/**
 * ⚠ A total record over `AgentHostId`, closed with `satisfies` — a new host is a COMPILE error
 * here rather than a member that silently never gets detected. That is the closed-vocabulary rule
 * `CLAUDE.md` documents eight instances of.
 *
 * ⚠ `agy` carries BOTH spellings deliberately: the launcher on this machine is an absolute path to
 * `agy.exe`, and a bare `agy` on Windows can resolve to a PowerShell function that opens the IDE
 * instead of the headless CLI. Naming both is detection, not invocation — nothing here runs either.
 */
const HOST_PROBES = {
  claude: {
    label: "Claude Code",
    binaries: ["claude"],
    // `~/.claude` is created by install-skill.mjs when it copies the skill. Footprint, not evidence.
    configPaths: [],
  },
  codex: {
    label: "Codex",
    binaries: ["codex"],
    // `~/.codex/config.toml` was written unconditionally by every llm-relay before v0.62.0, and
    // `~/.codex/` is still created for the skill copy. Both are footprint, not evidence.
    configPaths: [],
  },
  agy: {
    label: "Antigravity",
    binaries: ["agy.exe", "agy"],
    // The ONLY admitted config path: llm-relay has never written anything under ~/.gemini.
    configPaths: [join(".gemini", "antigravity-cli", "settings.json")],
  },
  opencode: {
    label: "OpenCode",
    binaries: ["opencode"],
    // install-skill.mjs creates the OpenCode skills directory under the XDG config home (or
    // `~/.config` when that is unset). Footprint, not evidence.
    // ⚠ The variable is described, not named: `test/state-paths.test.ts` greps `src/` for the
    // literal token so `state-paths.ts` stays the one owner of XDG resolution. This module
    // resolves no state path — the guard matches prose, so the prose gives way rather than the
    // guard being weakened.
    configPaths: [],
  },
} satisfies Record<AgentHostId, HostProbe>;

/** What was found for one host, with the evidence kept separate from the verdict. */
export interface AgentHostDetection {
  id: AgentHostId;
  label: string;
  /** A binary resolved on PATH. The strong signal — never llm-relay's own footprint. */
  onPath: boolean;
  /** The binary name that resolved, so a caller can report WHICH spelling was found. */
  binary: string | null;
  /** An owned config path that exists, admitted only under the footprint rule above. */
  configPath: string | null;
  /** `onPath || configPath !== null`. False means NO EVIDENCE, never "absent". */
  installed: boolean;
}

/** Injectable environment, so a test never reads the developer's real machine. */
export interface DetectHostsOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Seam for path existence. Defaults to `existsSync`. */
  exists?: (path: string) => boolean;
  /** Seam for PATH lookup. Defaults to the shared `commandExistsOnPath`. */
  onPath?: (command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => boolean;
}

/**
 * The detection reported for a host id this build does not know.
 *
 * ⚠ `detectHost` documents "never throws", and the one caller that can pass an unchecked id is
 * `scripts/install-skill.mjs` — plain JavaScript, so TypeScript's `AgentHostId` proves nothing
 * there. A bare `HOST_PROBES[id].binaries` on an unknown id throws a TypeError, and in a
 * postinstall hook that lands in a catch that then provisions anyway with no message. An unknown
 * id is "no evidence", which is what every other absence here means.
 */
function unknownHost(id: AgentHostId): AgentHostDetection {
  return { id, label: String(id), onPath: false, binary: null, configPath: null, installed: false };
}

/** Detect one host. Never throws — a detection failure must never break a caller's start-up. */
export function detectHost(id: AgentHostId, opts: DetectHostsOptions = {}): AgentHostDetection {
  // ⚠ Widened on purpose. TypeScript proves this lookup total for `AgentHostId`, so a narrow read
  // makes the guard below look dead — the linter says so. But the caller that can actually pass a
  // bad id is `scripts/install-skill.mjs`, which is plain JavaScript where that proof does not
  // exist. The cast is what keeps the runtime guard honest instead of deleting it.
  const probe = (HOST_PROBES as Record<string, HostProbe | undefined>)[id];
  if (probe === undefined) return unknownHost(id);

  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const lookup = opts.onPath ?? commandExistsOnPath;

  let binary: string | null = null;
  for (const candidate of probe.binaries) {
    try {
      if (lookup(candidate, env, platform)) {
        binary = candidate;
        break;
      }
    } catch {
      // A lookup that throws is not evidence of absence; keep trying the other spellings.
    }
  }

  let configPath: string | null = null;
  const home = opts.home ?? homedir();
  for (const relative of probe.configPaths) {
    const absolute = join(home, relative);
    try {
      if (exists(absolute)) {
        configPath = absolute;
        break;
      }
    } catch {
      // Same rule: an unreadable path is unknown, not absent.
    }
  }

  return {
    id,
    label: probe.label,
    onPath: binary !== null,
    binary,
    configPath,
    installed: binary !== null || configPath !== null,
  };
}

/** Detect every known host, in a stable order. Never throws. */
export function detectHosts(opts: DetectHostsOptions = {}): AgentHostDetection[] {
  return AGENT_HOST_IDS.map((id) => detectHost(id, opts));
}
