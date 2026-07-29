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
 *
 * Best-effort, but never SILENT. Every abnormal path prints a one-line reason on stderr and then
 * exits 0, so THIS FILE owns the "a skill problem must never fail the package install" guarantee.
 * It used to be owned by `postinstall: … || exit 0` in package.json, which discarded the exit code
 * with no message at all — hiding a hard crash (bad syntax, unreadable package) exactly as
 * thoroughly as a deliberate skip, so a user whose skill silently stopped updating had nothing to
 * go on. The one quiet path is the designed one: a non-global install does nothing by design and
 * says nothing, because printing on every `npm install` in a dev checkout is noise, not signal.
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** Report why the skill is not there, and leave the install itself alone. */
function skip(reason) {
  process.stderr.write(`llm-relay: Claude Code skill not installed — ${reason}\n`);
  process.exit(0);
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
    process.exit(0); // local/dev install — leave the user's ~/.claude alone
  }

  const src = join(here, "..", "skills", "llm-relay", "SKILL.md");
  if (!existsSync(src)) skip(`this package does not contain ${src}`);

  const dest = join(homedir(), ".claude", "skills", "llm-relay", "SKILL.md");
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  process.stderr.write(`llm-relay: installed Claude Code skill at ${dest}\n`);
} catch (e) {
  // Never fail the install over the skill — but always say why it did not happen.
  process.stderr.write(`llm-relay: Claude Code skill not installed — ${e?.message ?? e}\n`);
  process.exit(0);
}
