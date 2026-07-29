/**
 * Env-var name resolution for provider credentials.
 *
 * A provider declares one `authEnv` name, but the same key lives under different
 * names depending on which tool wrote it (`GEMINI_API_KEY` vs `GOOGLEAI_API_KEY`
 * vs `GOOGLE_API_KEY`). Rather than make the user rename an already-working env
 * var, resolve the declared name against a small set of known aliases and pick
 * the first one that is actually set.
 *
 * The candidate list is deliberately a closed set per provider plus names derived
 * from the provider's own name — never a scan of the environment for anything
 * key-shaped. A heuristic match could ship one provider's credential to another
 * provider's endpoint, which is a credential leak, not a convenience.
 */

/** Known alternate spellings, per provider, in preference order after the declared name. */
const PROVIDER_ENV_ALIASES: Record<string, string[]> = {
  gemini: [
    "GEMINI_API_KEY",
    "GOOGLEAI_API_KEY",
    "GOOGLE_AI_API_KEY",
    "GOOGLE_GENAI_API_KEY",
    "GOOGLE_GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  ],
  nim: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY", "NIM_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY", "OPEN_ROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY", "MISTRALAI_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  sambanova: ["SAMBANOVA_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
};

/** `my-provider.2` → `MY_PROVIDER_2`, so a custom provider gets sane derived candidates. */
function slug(providerName: string): string {
  return providerName.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Every env-var name that may carry this provider's credential, most-preferred first:
 * the declared name, then curated aliases, then names derived from the provider name.
 */
export function candidateEnvNames(providerName: string, declared?: string): string[] {
  const s = slug(providerName);
  const ordered = [
    ...(declared ? [declared] : []),
    ...(PROVIDER_ENV_ALIASES[providerName.toLowerCase()] ?? []),
    ...(s ? [`${s}_API_KEY`, `${s}_KEY`, `${s}_TOKEN`] : []),
  ];
  return [...new Set(ordered)];
}

export interface AuthEnvResolution {
  /** The name to read the key from — the first candidate that is set, else the declared name. */
  name: string | undefined;
  /** True when the key was found under a name other than the declared one. */
  viaAlias: boolean;
  /** Every name that was considered, for diagnostics. */
  candidates: string[];
}

/**
 * Whether a credential value counts as PRESENT. The single predicate — three
 * call sites used to disagree (config.ts tested Boolean() with no trim while
 * server.ts and candidates.ts trimmed), so a whitespace-only key read present
 * to the active-key filter and absent to header construction. That gap is how a
 * blank credential slipped past containment entirely.
 */
export function keyIsPresent(value: string | undefined): boolean {
  return (value ?? "").trim().length > 0;
}

/**
 * Whether a provider's credential handling is DECLARED, and if so whether the
 * key is actually there.
 *
 * ⚠ Derived from the config DECLARATION, never from `resolveAuthEnv` having
 * returned a name. Those are different questions: the alias list for anthropic
 * includes ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN, so a provider with NO
 * declared authEnv — an intentional passthrough — still resolves to a name
 * whenever either variable happens to be set in the environment. Deriving state
 * from the name would classify that passthrough as `declared-present`, making it
 * inject a key and strip the caller's own token: the exact inversion of the one
 * behaviour a passthrough exists to provide.
 */
export type CredentialState = "not-declared" | "declared-present" | "declared-missing";

export function credentialState(
  declaredAuthEnv: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CredentialState {
  if (!declaredAuthEnv) return "not-declared";
  return keyIsPresent(env[declaredAuthEnv]) ? "declared-present" : "declared-missing";
}

/**
 * Read a declared provider credential, normalised.
 *
 * Returns the trimmed value when the credential is PRESENT (per `keyIsPresent`) and
 * `undefined` otherwise, so a caller cannot accidentally hold a whitespace-only
 * string that is truthy to `if (key)` but blank on the wire. Every credential read
 * should go through here rather than open-coding `env[name]?.trim()` — that
 * open-coding is what let the presence predicate drift between call sites.
 */
export function readCredential(
  declaredAuthEnv: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!declaredAuthEnv) return undefined;
  const raw = env[declaredAuthEnv];
  return keyIsPresent(raw) ? raw!.trim() : undefined;
}

/**
 * Which header a provider's credential is injected into.
 *
 * Structurally identical to `AuthHeader` in `config.ts` and freely assignable in
 * both directions. It is redeclared here rather than imported so this module keeps
 * ZERO dependency on `config.ts` — `config.ts` imports this one, and `tier-data.ts`
 * already exists as a separate module for exactly that reason.
 */
export type AuthHeaderName = "x-api-key" | "authorization";

/**
 * THE construction site for a provider credential header.
 *
 * Returns `{}` when the credential is absent, so the builder — not each caller —
 * is what guarantees a blank key never reaches the wire as an empty `x-api-key` or
 * a bare `Bearer`. Callers merge the result; they must not test the key themselves.
 *
 * Two normalisations, both deliberate:
 * - The value is trimmed. A key pasted into `~/.llm-relay/.env` with a trailing
 *   newline is a valid key that 401s, which reads as "my key is bad".
 * - `Bearer ` prefixing is idempotent. Three of the existing sites already accept a
 *   value that carries its own `Bearer ` prefix; double-prefixing it would break
 *   them on migration.
 *
 * ⚠ It obeys the DECLARED `authHeader` and never consults `provider.kind`. Three
 * current sites (`key-checker.ts`, `ping/ping.ts`, `pool-health.ts`) additionally
 * force `x-api-key` on any `kind: "anthropic"` provider, which silently discards an
 * explicit `authHeader: "authorization"`. `config.ts` already defaults an
 * anthropic-kind provider's `authHeader` to `x-api-key`, so migrating those sites is
 * behaviour-preserving in every case EXCEPT that explicit override — where honouring
 * the config is the correct answer. It is called out rather than encoded so the
 * change is a visible decision, not a silent one.
 *
 * Non-credential companions (`anthropic-version`, `Content-Type`) stay with the
 * caller: this function builds the auth header and nothing else.
 */
export function buildAuthHeaders(
  key: string | undefined,
  authHeader: AuthHeaderName,
): Record<string, string> {
  if (!keyIsPresent(key)) return {};
  const value = key!.trim();
  if (authHeader === "authorization") {
    return { authorization: value.startsWith("Bearer ") ? value : `Bearer ${value}` };
  }
  return { "x-api-key": value };
}

/**
 * Pick the env-var name this provider's key actually lives under. Falls back to the
 * declared name when nothing is set, so "missing key" diagnostics still name the
 * variable the config asked for.
 */
export function resolveAuthEnv(
  providerName: string,
  declared: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AuthEnvResolution {
  const candidates = candidateEnvNames(providerName, declared);
  const found = candidates.find((n) => keyIsPresent(env[n]));
  return {
    name: found ?? declared,
    viaAlias: Boolean(found && found !== declared),
    candidates,
  };
}
