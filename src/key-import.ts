import { existsSync, readFileSync } from "node:fs";
import type { Config } from "./config.js";
import { curatedEnvNames } from "./authEnv.js";
import { defaultEnvPath, parseDotEnv } from "./dotenv.js";
import { saveKeysToEnv } from "./onboarding.js";
import { ALL_PROVIDER_PRESETS } from "./presets.js";

export interface CredentialImportEntry {
  name: string;
  value: string;
}

export interface ParsedCredentialImport {
  format: "dotenv" | "freellmapi-json";
  entries: CredentialImportEntry[];
}

export interface CredentialImportOutcome {
  name: string;
  provider?: string | undefined;
  envName?: string | undefined;
  outcome: "imported" | "skipped";
  reason?: string | undefined;
}

export interface CredentialImportResult {
  format: ParsedCredentialImport["format"];
  envPath: string;
  outcomes: CredentialImportOutcome[];
}

export interface CredentialImportTarget {
  provider: string;
  envName: string;
  aliases: string[];
}

/**
 * Extra input names emitted by supported exporters. This is deliberately a closed table.
 * In particular, there is no value-shape fallback: guessing from `sk-...`, length or entropy can
 * attach one provider's credential to another provider's endpoint.
 */
const IMPORT_NAME_ALIASES: Record<string, string[]> = {
  gemini: ["gemini", "google", "GEMINI_KEY", "GOOGLE_KEY"],
  nim: ["nim", "nvidia", "NIM_KEY", "NVIDIA_KEY"],
  openrouter: ["openrouter", "OPENROUTER_KEY", "OPEN_ROUTER_KEY"],
  groq: ["groq", "GROQ_KEY"],
  mistral: ["mistral", "MISTRAL_KEY"],
  cerebras: ["cerebras", "CEREBRAS_KEY"],
  sambanova: ["sambanova", "SAMBANOVA_KEY"],
  openai: ["openai", "OPENAI_KEY"],
  anthropic: ["anthropic", "ANTHROPIC_KEY"],
};

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function importProviders(cfg?: Config): CredentialImportTarget[] {
  const providers = cfg?.providers ?? ALL_PROVIDER_PRESETS;
  const result: CredentialImportTarget[] = [];
  for (const [provider, configured] of Object.entries(providers)) {
    const envName = configured.authEnv ?? ALL_PROVIDER_PRESETS[provider]?.authEnv;
    if (!envName?.trim()) continue;
    const aliases = [
      envName,
      ...curatedEnvNames(provider),
      ...(IMPORT_NAME_ALIASES[provider.toLowerCase()] ?? []),
    ];
    result.push({ provider, envName, aliases: [...new Set(aliases.map(normalizeName))] });
  }
  return result;
}

/** Match only the same closed name table used by onboarding imports. */
export function matchCredentialImportName(
  name: string,
  cfg?: Config,
): CredentialImportTarget | undefined {
  const normalized = normalizeName(name);
  if (cfg === undefined) {
    return importProviders().find((candidate) => candidate.aliases.includes(normalized));
  }

  // CLI-to-keystore imports are stricter than legacy onboarding: only declarations in the
  // loaded config can become destinations. The onboarding helper intentionally retains its
  // preset fallback, but using that here would invent an authEnv for keyless/passthrough or
  // fleet-only providers whose slug happens to equal a preset name.
  const exactTargets: CredentialImportTarget[] = [];
  const aliasTargets: CredentialImportTarget[] = [];
  for (const [provider, configured] of Object.entries(cfg.providers)) {
    if (configured.authEnv !== undefined) {
      const aliases = [...new Set([
        ...curatedEnvNames(provider),
        ...(IMPORT_NAME_ALIASES[provider.toLowerCase()] ?? []),
      ].map(normalizeName))];
      const target = { provider, envName: configured.authEnv, aliases };
      if (normalizeName(configured.authEnv) === normalized) exactTargets.push(target);
      if (aliases.includes(normalized)) aliasTargets.push(target);
      continue;
    }

    const slots = configured.credentials ?? [];
    for (const slot of slots) {
      if (normalizeName(slot.authEnv) === normalized) {
        exactTargets.push({ provider, envName: slot.authEnv, aliases: [normalized] });
      }
    }
    // An exporter often names only the provider. That closed alias is safe when there is one
    // declared destination, but ambiguous fleets require the exact slot authEnv name.
    if (slots.length === 1) {
      const aliases = [...new Set([
        ...curatedEnvNames(provider),
        ...(IMPORT_NAME_ALIASES[provider.toLowerCase()] ?? []),
      ].map(normalizeName))];
      if (aliases.includes(normalized)) {
        aliasTargets.push({ provider, envName: slots[0]!.authEnv, aliases });
      }
    }
  }
  // Exact loaded declarations outrank every alias across the whole provider map. Duplicate exact
  // declarations and alias collisions are ambiguous and therefore never select by insertion order.
  if (exactTargets.length === 1) return exactTargets[0];
  if (exactTargets.length > 1) return undefined;
  const uniqueAliases = [...new Map(
    aliasTargets.map((target) => [`${target.provider}\0${target.envName}`, target]),
  ).values()];
  return uniqueAliases.length === 1 ? uniqueAliases[0] : undefined;
}

/** Parse only the documented FreeLLMAPI v1 export envelope. */
export function parseFreeLlmApiExportJson(text: string): CredentialImportEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1 || obj.source !== "freellmapi" || !Array.isArray(obj.keys)) return null;

  return obj.keys.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { name: `entry ${index + 1}`, value: "" };
    }
    const row = entry as Record<string, unknown>;
    const rawName = typeof row.platform === "string" ? row.platform.trim() : "";
    // Exported platform names are identifiers, not free text. Refusing other characters keeps
    // an attacker-controlled field from becoming terminal output while still never examining the
    // secret value itself.
    const name = /^[A-Za-z0-9_.-]+$/.test(rawName) ? rawName : `entry ${index + 1}`;
    return { name, value: typeof row.key === "string" ? row.key : "" };
  });
}

export function parseCredentialImport(text: string): ParsedCredentialImport {
  const exportEntries = parseFreeLlmApiExportJson(text);
  if (exportEntries !== null) return { format: "freellmapi-json", entries: exportEntries };

  // Valid JSON of any other shape is explicitly out. It must not fall through and be treated as
  // dotenv merely because a string inside it contains `=`.
  try {
    JSON.parse(text);
  } catch {
    const entries = Object.entries(parseDotEnv(text)).map(([name, value]) => ({ name, value }));
    if (entries.length > 0) return { format: "dotenv", entries };
    throw new Error("import file is neither dotenv nor a FreeLLMAPI v1 export JSON file");
  }
  throw new Error("JSON import must be a FreeLLMAPI v1 export");
}

export function importKeysFromFile(
  importPath: string,
  cfg?: Config,
  opts: { envPath?: string; force?: boolean; writeLine?: (line: string) => void } = {},
): CredentialImportResult {
  const parsed = parseCredentialImport(readFileSync(importPath, "utf8"));
  const envPath = opts.envPath ?? defaultEnvPath();
  const providers = importProviders(cfg);
  const existing = existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf8")) : {};
  const existingNames = new Set(Object.keys(existing).map(normalizeName));
  const pendingProviders = new Set<string>();
  const addedKeys: Record<string, string> = {};
  const outcomes: CredentialImportOutcome[] = [];

  for (const entry of parsed.entries) {
    const provider = providers.find((candidate) => candidate.aliases.includes(normalizeName(entry.name)));
    if (!provider) {
      outcomes.push({
        name: entry.name,
        outcome: "skipped",
        reason: "unknown name (not in the closed provider alias list)",
      });
      continue;
    }
    if (!entry.value.trim()) {
      outcomes.push({
        name: entry.name,
        provider: provider.provider,
        envName: provider.envName,
        outcome: "skipped",
        reason: "empty value",
      });
      continue;
    }
    if (pendingProviders.has(provider.provider)) {
      outcomes.push({
        name: entry.name,
        provider: provider.provider,
        envName: provider.envName,
        outcome: "skipped",
        reason: "another alias for this provider was already imported",
      });
      continue;
    }
    const alreadySet = provider.aliases.some((alias) => existingNames.has(alias));
    if (alreadySet && !opts.force) {
      outcomes.push({
        name: entry.name,
        provider: provider.provider,
        envName: provider.envName,
        outcome: "skipped",
        reason: "already set in the destination .env (use --force to replace)",
      });
      continue;
    }

    addedKeys[provider.envName] = entry.value;
    pendingProviders.add(provider.provider);
    outcomes.push({
      name: entry.name,
      provider: provider.provider,
      envName: provider.envName,
      outcome: "imported",
    });
  }

  if (Object.keys(addedKeys).length > 0) saveKeysToEnv(envPath, addedKeys);

  const writeLine = opts.writeLine ?? console.log;
  for (const outcome of outcomes) {
    if (outcome.outcome === "imported") {
      writeLine(`Imported ${outcome.name} -> ${outcome.provider} as $${outcome.envName}`);
    } else {
      const provider = outcome.provider ? ` -> ${outcome.provider}` : "";
      writeLine(`Skipped ${outcome.name}${provider}: ${outcome.reason}`);
    }
  }
  const imported = outcomes.filter((outcome) => outcome.outcome === "imported").length;
  writeLine(`Import complete: ${imported} imported, ${outcomes.length - imported} skipped.`);

  return { format: parsed.format, envPath, outcomes };
}
