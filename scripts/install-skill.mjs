#!/usr/bin/env node
/**
 * Install/refresh the Claude Code skill that ships with llm-relay into the user's
 * global skills directory (~/.claude/skills/llm-relay/SKILL.md).
 *
 * Runs from npm `postinstall`, but only acts on GLOBAL installs (`npm i -g llm-relay`)
 * so that a repo-local `npm install` (dev checkout, CI) never touches the developer's
 * ~/.claude. Because the self-updater reinstalls the global package on a new version,
 * the skill refreshes itself on every upgrade with no extra step.
 *
 * `--force` installs regardless of install context (for manual runs and tests).
 * Best-effort by design: a failure here must never fail the package install.
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const force = process.argv.includes("--force");

// Two signals, either suffices: npm's lifecycle env var, or the package physically living in
// an npm global tree (…/npm/node_modules/llm-relay on Windows, …/lib/node_modules/llm-relay
// elsewhere) — the env var alone is npm-version-dependent.
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const inGlobalTree = /(^|[\\/])(npm|lib)[\\/]node_modules[\\/]llm-relay$/i.test(pkgDir.replace(/[\\/]+$/, ""));
const isGlobal = process.env.npm_config_global === "true" || inGlobalTree;

if (!isGlobal && !force) {
  process.exit(0); // local/dev install — leave the user's ~/.claude alone
}

try {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "llm-relay", "SKILL.md");
  if (!existsSync(src)) process.exit(0); // packed without the skill — nothing to do

  const dest = join(homedir(), ".claude", "skills", "llm-relay", "SKILL.md");
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  process.stderr.write(`llm-relay: installed Claude Code skill at ${dest}\n`);
} catch (e) {
  // Never fail the install over the skill — say why and move on.
  process.stderr.write(`llm-relay: skill install skipped (${e?.message ?? e})\n`);
}
