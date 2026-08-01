#!/usr/bin/env node
/**
 * Install/refresh the llm-relay skill for Claude Code and Codex from the same
 * shipped source (skills/llm-relay/SKILL.md).
 *
 * Runs from npm `postinstall`, but only acts on GLOBAL installs (`npm i -g llm-relay`)
 * so that a repo-local `npm install` (dev checkout, CI) never touches the developer's
 * ~/.claude or ~/.codex. Because the self-updater reinstalls the global package on a new
 * version, both skill descriptions refresh on every upgrade with no extra step.
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

/** Report why neither skill can be installed, and leave the package install itself alone. */
function skipAll(reason) {
  process.stderr.write(`llm-relay: Claude Code and Codex skills not installed — ${reason}\n`);
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
} catch (e) {
  // Never fail the install over the skills — but always say why neither could be attempted.
  process.stderr.write(`llm-relay: Claude Code and Codex skills not installed — ${e?.message ?? e}\n`);
  process.exit(0);
}
