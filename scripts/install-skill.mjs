#!/usr/bin/env node
/**
 * Install/refresh the llm-relay skill for Claude Code and Codex from the same
 * shipped source (skills/llm-relay/SKILL.md), and provision Codex's global
 * provider/child-agent setup.
 *
 * Runs from npm `postinstall`, but only acts on GLOBAL installs (`npm i -g llm-relay`)
 * so that a repo-local `npm install` (dev checkout, CI) never touches the developer's
 * ~/.claude or ~/.codex. Because the self-updater reinstalls the global package on a new
 * version, both skill descriptions and the missing Codex setup refresh on every upgrade with
 * no extra step.
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
  process.stderr.write(`llm-relay: Claude Code and Codex skills not installed — ${reason}\n`);
  process.exit(0);
}

const CODEX_PROVIDER_SECTION = "[model_providers.llm-relay]";
const CODEX_PROVIDER_BLOCK = `${CODEX_PROVIDER_SECTION}\nname = "llm-relay"\nbase_url = "http://127.0.0.1:8791/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n`;
const CODEX_AGENTS = [
  {
    name: "default",
    contents: `name = "default"\ndescription = "General-purpose read-only child routed through llm-relay."\ndeveloper_instructions = "Work read-only. Return a concise result to the parent and do not modify files."\n\nmodel_provider = "llm-relay"\nmodel = "pool/coding"\nmodel_reasoning_effort = "medium"\n`,
  },
  {
    name: "relay_coding",
    contents: `name = "relay_coding"\ndescription = "Read-only coding child routed through llm-relay to the configured non-OpenAI pool."\ndeveloper_instructions = "Work read-only. Return a concise result to the parent and do not modify files."\n\nmodel_provider = "llm-relay"\nmodel = "pool/coding"\nmodel_reasoning_effort = "medium"\n`,
  },
];

/** Add the provider section without disturbing unrelated Codex settings or duplicating it. */
function ensureCodexProvider(configPath) {
  if (!existsSync(configPath)) {
    writeFileSync(configPath, CODEX_PROVIDER_BLOCK, "utf8");
    return "configured";
  }

  const current = readFileSync(configPath, "utf8");
  // Accept both the normal unquoted TOML table and the equivalent quoted table spelling.
  if (/^\s*\[\s*model_providers\.(?:llm-relay|"llm-relay")\s*\]\s*$/m.test(current)) {
    return "already configured";
  }

  const separator = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
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
  const inGlobalTree = /(^|[\\/])(npm|lib)[\\/]node_modules[\\/]llm-relay$/i.test(pkgDir.replace(/[\\/]+$/, ""));
  const isGlobal = process.env.npm_config_global === "true" || inGlobalTree;

  if (!isGlobal && !force) {
    process.exit(0); // local/dev install — leave the user's host skill directories alone
  }

  const src = join(here, "..", "skills", "llm-relay", "SKILL.md");
  if (!existsSync(src)) skipAll(`this package does not contain ${src}`);

  const home = homedir();
  const targets = [
    { host: "Claude Code", dest: join(home, ".claude", "skills", "llm-relay", "SKILL.md") },
    { host: "Codex", dest: join(home, ".codex", "skills", "llm-relay", "SKILL.md") },
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

  try {
    installCodexSetup(home);
  } catch (e) {
    process.stderr.write(`llm-relay: Codex global setup not installed — ${e?.message ?? e}\n`);
  }
} catch (e) {
  // Never fail the install over the skills — but always say why neither could be attempted.
  process.stderr.write(`llm-relay: Claude Code and Codex skills not installed — ${e?.message ?? e}\n`);
  process.exit(0);
}
