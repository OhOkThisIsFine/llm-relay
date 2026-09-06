/**
 * How a routing SPEC is spelled — the two reserved names and the one way to take a spec apart.
 *
 * A "spec" is what routing resolves: `provider`, `provider/model`, or the reserved `pool/<name>`.
 * Nine modules reason about that spelling — `config.ts`, `dispatch.ts`, `candidates.ts`,
 * `availability-snapshot.ts`, `cli.ts`, `key-checker.ts`, `pool-health.ts`, `server.ts` and
 * `routes/admin.ts` — and until 2026-09-06 all of them reached into `config.ts` for it.
 *
 * ⚠ It lives in its own leaf so that `config/routing-parser.ts` can be extracted from `config.ts`
 * without the new module importing back into the one it came from (HOTSPOT-03, stage 1). A parser
 * that needs `POOL_PREFIX` and imports `config.js` to get it is a cycle; the alternative — copying
 * the literal `"pool"` into the parser — is the hand-copied-closed-set defect this repository
 * records against `UNTIL_BASES` and `CooldownSource`.
 *
 * ⚠ `config.ts` RE-EXPORTS all three, so every existing `from "./config.js"` importer is unchanged.
 * That is deliberate: the point of the move is to give the parser a leaf to depend on, not to make
 * eight modules edit their import lines.
 *
 * This module imports nothing. Keep it that way.
 */

/** Reserved provider-namespace prefix for `pool/<name>` routing. */
export const POOL_PREFIX = "pool";

/** Reserved model name for auto-dispatch to the ladder's first ready relay rung. */
export const AUTO_MODEL = "auto";

/**
 * Split a "provider/model" spec into its parts.
 *
 * ⚠ The FIRST slash is the boundary and the rest is the model, because a model id legitimately
 * contains slashes (`nim/moonshotai/kimi-k3`, `openrouter/deepseek/deepseek-v4-flash-0731`).
 * Splitting on every slash would rewrite one provider's model id into another provider's name.
 */
export function splitSpec(spec: string): { provider: string; model?: string } {
  const slash = spec.indexOf("/");
  if (slash === -1) return { provider: spec };
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}
