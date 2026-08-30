#!/usr/bin/env node
/**
 * Install/refresh the llm-relay skill for Claude Code, Codex and OpenCode from the same
 * shipped source (skills/llm-relay/SKILL.md), and provision Codex's global
 * provider/child-agent setup.
 *
 * Runs from npm `postinstall`, but only acts on GLOBAL installs (`npm i -g llm-relay`)
 * so that a repo-local `npm install` (dev checkout, CI) never touches the developer's
 * ~/.claude, ~/.codex or the XDG config dir. Because the self-updater reinstalls the global
 * package on a new version, every host's skill description and the missing Codex setup refresh
 * on every upgrade with no extra step.
 *
 * `--force` installs regardless of install context (for manual runs and tests).
 *
 * Best-effort, but never SILENT. Every abnormal path prints a one-line reason on stderr and then
 * exits 0, so THIS FILE owns the "a skill problem must never fail the package install" guarantee.
 * It used to be owned by `postinstall: … || exit 0` in package.json, which discarded the exit code
 * with no message at all — hiding a hard crash (bad syntax, unreadable package) exactly as
 * thoroughly as a deliberate skip, so a user whose skill silently stopped updating had nothing to
 * go on. The one quiet path is the designed one: a non-global install does nothing by design and
 * says nothing, because printing on every `npm install` in a dev checkout is noise, not signal.
 */
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** Report why neither skill can be installed, and leave the package install itself alone. */
function skipAll(reason) {
  process.stderr.write(`llm-relay: host skills not installed — ${reason}\n`);
  process.exit(0);
}

const CODEX_PROVIDER_SECTION = "[model_providers.llm-relay]";
const CODEX_PROVIDER_BLOCK = `${CODEX_PROVIDER_SECTION}\nname = "llm-relay"\nbase_url = "http://127.0.0.1:8791/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n`;
const CODEX_AGENTS = [
  {
    name: "default",
    contents: `name = "default"\ndescription = "General-purpose read-only child routed through llm-relay."\ndeveloper_instructions = "Work read-only. Return a concise result to the parent and do not modify files."\n\nmodel_provider = "llm-relay"\nmodel = "pool/medium"\nmodel_reasoning_effort = "medium"\n`,
  },
  {
    name: "relay_coding",
    contents: `name = "relay_coding"\ndescription = "Read-only medium-effort child routed through llm-relay to the configured non-OpenAI pool."\ndeveloper_instructions = "Work read-only. Return a concise result to the parent and do not modify files."\n\nmodel_provider = "llm-relay"\nmodel = "pool/medium"\nmodel_reasoning_effort = "medium"\n`,
  },
];

/** Add the provider section without disturbing unrelated Codex settings or duplicating it. */
function hasConfiguredCodexProvider(current) {
  // Accept the normal unquoted TOML table and the equivalent quoted spelling, and tolerate
  // whitespace inside the brackets — `[ model_providers.llm-relay ]` is the SAME table.
  // ⚠ Comparing the trimmed line against the literal string is not enough: a config written by
  // hand with inner spaces reads as "not configured", so postinstall appends a SECOND provider
  // block and the user's config.toml ends up with a duplicate table. Collapsing whitespace keeps
  // the match tolerant without the backtracking regex this replaced.
  return current.split("\n").some((line) => {
    const collapsed = line.replace(/\s/g, "");
    return collapsed === CODEX_PROVIDER_SECTION || collapsed === '[model_providers."llm-relay"]';
  });
}

function ensureCodexProvider(configPath) {
  if (!existsSync(configPath)) {
    writeFileSync(configPath, CODEX_PROVIDER_BLOCK, "utf8");
    return "configured";
  }

  const current = readFileSync(configPath, "utf8");
  if (hasConfiguredCodexProvider(current)) {
    return "already configured";
  }

  let separator = "";
  if (current.length !== 0) {
    separator = current.endsWith("\n") ? "\n" : "\n\n";
  }
  writeFileSync(configPath, `${current}${separator}${CODEX_PROVIDER_BLOCK}`, "utf8");
  return "configured";
}

/** Create a relay child agent only when the user has not already chosen that filename. */
function ensureCodexAgent(agentDir, agent) {
  const path = join(agentDir, `${agent.name}.toml`);
  if (existsSync(path)) return { path, status: "already exists" };
  writeFileSync(path, agent.contents, "utf8");
  return { path, status: "installed" };
}

function installCodexSetup(home) {
  const codexDir = join(home, ".codex");
  const agentDir = join(codexDir, "agents");
  mkdirSync(agentDir, { recursive: true });

  const configPath = join(codexDir, "config.toml");
  const providerStatus = ensureCodexProvider(configPath);
  process.stderr.write(`llm-relay: Codex provider ${providerStatus} at ${configPath}\n`);

  for (const agent of CODEX_AGENTS) {
    const result = ensureCodexAgent(agentDir, agent);
    process.stderr.write(`llm-relay: Codex agent ${result.status} at ${result.path}\n`);
  }
}

try {
  const force = process.argv.includes("--force");

  const here = dirname(fileURLToPath(import.meta.url));
  // Two signals, either suffices: npm's lifecycle env var, or the package physically living in
  // an npm global tree (…/npm/node_modules/llm-relay on Windows, …/lib/node_modules/llm-relay
  // elsewhere) — the env var alone is npm-version-dependent.
  const pkgDir = join(here, "..");
  const normalizedPkgDir = pkgDir.replace(/\\/g, "/");
  const cleanPkgDir = normalizedPkgDir.endsWith("/") ? normalizedPkgDir.slice(0, -1) : normalizedPkgDir;
  const pkgParts = cleanPkgDir.split("/");
  const parentDir = pkgParts.at(-2);
  const grandparentDir = pkgParts.at(-3);
  const inGlobalTree = parentDir === "node_modules" && (grandparentDir === "npm" || grandparentDir === "lib");
  const isGlobal = process.env.npm_config_global === "true" || inGlobalTree;

  if (!isGlobal && !force) {
    process.exit(0); // local/dev install — leave the user's host skill directories alone
  }

  const src = join(here, "..", "skills", "llm-relay", "SKILL.md");
  if (!existsSync(src)) skipAll(`this package does not contain ${src}`);

  const home = homedir();
  // OpenCode keeps its configuration under the XDG config dir, unlike Claude Code and Codex which
  // use fixed dotfolders in HOME. Honour XDG_CONFIG_HOME when it is set to a real value and fall
  // back to ~/.config — the same policy `src/state-paths.ts` applies to this relay's own
  // config-kind state, and the path observed live on this machine.
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  const configHome = xdgConfig && xdgConfig.trim() !== "" ? xdgConfig : join(home, ".config");
  const targets = [
    { host: "Claude Code", dest: join(home, ".claude", "skills", "llm-relay", "SKILL.md") },
    { host: "Codex", dest: join(home, ".codex", "skills", "llm-relay", "SKILL.md") },
    { host: "OpenCode", dest: join(configHome, "opencode", "skills", "llm-relay", "SKILL.md") },
  ];

  // Keep host failures independent: a broken ~/.claude must not prevent Codex from receiving
  // the same canonical description, or vice versa.
  for (const { host, dest } of targets) {
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      process.stderr.write(`llm-relay: installed ${host} skill at ${dest}\n`);
    } catch (e) {
      process.stderr.write(`llm-relay: ${host} skill not installed — ${e?.message ?? e}\n`);
    }
  }

  // ⚠ Only provision Codex when Codex is actually here (owner decision 2026-08-30). This used to
  // run unconditionally, so every global install created `~/.codex/config.toml` and two agent
  // TOMLs on machines with no Codex at all — configuration for a tool the operator does not have,
  // written silently.
  //
  // ⚠ The detector is IMPORTED from `dist/`, never re-implemented here: a second copy of the
  // PATH-and-config test would be the duplicate the project forbids, and it is the copy that
  // would drift. `dist/` ships in `files`, so it is present in an installed package — but this is
  // a postinstall hook, so an unreadable `dist/` must not break anything. It fails to the OLD
  // behaviour (provision anyway), because the cost of an unused config directory is far smaller
  // than the cost of a Codex user silently getting no provider block.
  let codexDetected = true;
  try {
    const { detectHost } = await import("../dist/installed-hosts.js");
    // `home` explicitly: `homedir()` reads the real user, and the postinstall tests redirect
    // HOME/USERPROFILE at a temp dir precisely so nothing consults the developer's machine.
    //
    // ⚠ `onPath`, NOT `installed`. Adversarial review caught this reading `installed`, which is a
    // no-op gate for every existing user: llm-relay before v0.62.0 wrote `~/.codex/config.toml`
    // unconditionally, so a config-path signal would be llm-relay detecting its own footprint and
    // the gate would be permanently open. `installed-hosts.ts` now returns no config path for
    // Codex at all, so the two agree — reading `onPath` states the intent at the call site so a
    // later widening of that module cannot silently reopen the gate.
    const codex = detectHost("codex", { home });
    codexDetected = codex.onPath;
    if (!codexDetected) {
      process.stderr.write(
        "llm-relay: Codex not detected (no codex binary on PATH) — skipping Codex provider setup.\n" +
          `llm-relay: install Codex, then run: node "${here}/install-skill.mjs" --force\n`,
      );
    }
  } catch (e) {
    // ⚠ Say so. This branch used to leave `codexDetected` true and fall through to the `if
    // (!codexDetected)` message, which therefore NEVER printed — the reason string was dead code
    // and a failed detector was completely silent. That breaks this file's own stated contract:
    // best-effort, but never SILENT. It still fails OPEN (provision anyway), because an unused
    // config directory costs far less than a real Codex user silently losing their provider block.
    process.stderr.write(
      `llm-relay: Codex detection unavailable (${e?.message ?? e}) — provisioning Codex anyway.\n`,
    );
  }

  // The "not detected" message is printed above, beside the evidence that produced it, so this
  // reads as a plain positive condition rather than an empty branch.
  if (codexDetected) {
    try {
      installCodexSetup(home);
    } catch (e) {
      process.stderr.write(`llm-relay: Codex global setup not installed — ${e?.message ?? e}\n`);
    }
  }
} catch (e) {
  // Never fail the install over the skills — but always say why none could be attempted.
  process.stderr.write(`llm-relay: host skills not installed — ${e?.message ?? e}\n`);
  process.exit(0);
}
