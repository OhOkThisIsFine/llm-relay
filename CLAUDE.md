# CLAUDE.md — llm-relay (agent orientation)

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read this first. It's the map; [README.md](README.md) is the short user-facing front door
(kept ~400 words for npm) and [docs/reference.md](docs/reference.md) is the full usage
reference — user-facing detail belongs there, not in the README.

## What this is

A standalone, **loopback-only** LLM traffic control plane: it steers one person's LLM traffic
across providers and quotas — **reliably** (benchmark-ranked pools, failover, circuit breaking,
health that survives restarts), **transparently** (things just work in operation, and the
metadata, logs and metrics answer "what happened" with provenance when you look), and
**lightweight** (only what is necessary; three runtime deps as of `delegate-gate/`'s
`typescript` compiler-API detectors — was two before; no second implementation of
anything). A client (the `claude` CLI, Codex, or anything that honors `ANTHROPIC_BASE_URL`)
points at it; the relay resolves the requested model through pools/tiers/offload rules to a
concrete deployment and forwards. Owner-stated goals and the rubric for judging proposed
changes: [docs/project-goals.md](docs/project-goals.md).

**Tool-call repair is one component, not the identity.** (Earlier revisions of this file called
it the heart of the project; that was an agent's drift, corrected 2026-08-04.) For requests
carrying tools, the relay validates the backend's tool calls and can repair malformed ones, so
the Claude Code harness can run on models that are weaker at tool-use.

**The repair boundary — do not cross it:** the proxy fixes/flags *protocol form* (malformed tool
calls), never *judgment* (bad reasoning). It repairs a tool call whose args violate the schema;
it does not invent intent, and it refuses to fabricate destructive-tool calls. The same line
bounds the whole project: routing decisions come from config and deterministic classification,
never from an LLM's opinion inserted into the request path.

## Build / test / run

```bash
npm install
npm run build          # build:server (TWO tsc passes -> dist/, see below) + build:dashboard (vite, from dashboard/)
npm test               # vitest run  (the suite is the source of truth; do not pin a count here — it drifts)
npm run typecheck      # tsc --noEmit — src/ (tsconfig.json)
npm run typecheck:test # tsc — the SUITE (tsconfig.test.json). See the note below.
npm run check          # typecheck + typecheck:test + test + check:dashboard (tsc for dashboard/ + the dashboard suite's own vitest config) + check:package (bundle inventory check + packed smoke). The one gate; CI runs exactly this.
npm run dev -- --config config.json   # run from src via tsx, no build
npm run sync:tiers     # regenerate docs/tier-data.json (shipped in the published package)

llm-relay keys         # are the CREDENTIALS good?
llm-relay pools --probe # will each configured MODEL actually answer? (the only real liveness check)

npx vitest run test/repair.test.ts             # one file
npx vitest run -t "refuses to reshape a destructive"   # one test by name
```
**Always verify green before AND after a change:** `npm run build && npm run check`.

⚠ **`build:server` runs `tsc` TWICE, and the second pass is load-bearing** (owner decision
2026-08-30, package-size variant C). Pass 1 is the ordinary `tsc -p tsconfig.json` and emits the
`.d.ts` files WITH their doc comments. Pass 2 re-emits only the JavaScript
(`--removeComments --declaration false --declarationMap false`), overwriting `dist/*.js` and
`dist/*.js.map` with comment-free output while leaving pass 1's declarations untouched. Measured:
**29.5% of `dist/*.js` was comment prose** (578657 bytes), and dropping it took the tarball from
1113288 to **861516 packBytes — 22.6% smaller** with the entry count unchanged at 347.
⚠ The split exists so consumers KEEP their IntelliSense text. Collapsing it to a single
`removeComments: true` in `tsconfig.json` would strip the `.d.ts` docs too and save only a further
~122k — that is variant B, and it was rejected for exactly this reason. Do not "simplify" the two
passes into one. ⚠ The only comment surviving in a `dist/*.js` is its `//# sourceMappingURL=` line,
which must stay. Evidence, the four costed variants and the commands to re-measure:
[docs/package-size-2026-08-30.md](docs/package-size-2026-08-30.md).

**`test/` is type-checked by `tsconfig.test.json`, not by `tsconfig.json` or by vitest.**
`tsconfig.json` is `include: ["src/**/*.ts"]` with `exclude: [… "**/*.test.ts"]` because it drives
`dist/`, and vitest **transpiles** tests rather than type-checking them (`vitest.config.ts` declares
no `typecheck` block, deliberately — it would run tsc twice). `tsconfig.test.json` extends the base
with the same strictness, widens `rootDir` and adds `test/`, and `npm run check` runs it. Its first
run found 23 errors, including hand-built `ProviderConfig`/`ReshaperConfig` literals missing a
required field — i.e. tests asserting against a shape the source no longer has.

⚠ A `@ts-expect-error` in a test file was inert for the whole life of the project before this
(never evaluated ⇒ neither passing nor failing), so **any pre-existing one proves nothing about
when it was written**. It is live now, but prefer a runtime assertion where the point is that a
surface does not EXIST — a type-level assertion only says it is untyped. (Two independent workers
were misled by the older "vitest is what checks those" claim here.)

⚠ **`vitest.config.ts` scopes the suite to this checkout's `test/` directory on purpose.**
Without an explicit `include`, vitest's default glob walks the whole tree, so **any nested checkout**
— a git worktree under the repo root, a vendored copy — contributes its own copy of every test file.
Tooling that fanned work out across per-task worktrees inside the repo once made `npm test` run 70
files / 638 tests instead of the real suite. That breaks the gate in both directions: another
worktree's half-finished edit fails this tree's run, and a stale copy passes one. Don't widen it.

**Static analysis is ADVISORY and deliberately outside the gate.** `npm run analysis:run`
(eslint + sonarjs, knip, madge, dependency-cruiser, ts-prune, jscpd) writes to `analysis-reports/`
(gitignored). It is **not** in `npm run check` and CI does not run it — the gate stays the two
typechecks, the server suite, the dashboard checks and the package checks. Several default rules contradict documented invariants here, so they
are switched **off in `eslint.config.mjs` with the invariant named beside each**: this proxy is
loopback-only so `http://127.0.0.1` is the architecture (`no-clear-text-protocols`); the dispatch
ladder names agent CLIs for the HOST to resolve (`no-os-command-from-path`); the suite uses temp
dirs to stay hermetic (`publicly-writable-directories`). What is left as a **warning** —
cognitive complexity, super-linear regexes — is worth reading and not worth blocking on;
restructuring `server.ts`/`config.ts` to clear the first is the enterprise-shaped refactor
[docs/suggestion-review-2026-08-04.md](docs/suggestion-review-2026-08-04.md) already rejected.
⚠ Don't "fix" a finding by deleting an intentional discard: `_`-prefixed names and
`const { key, ...rest }` are conventions here, covered by the rule options rather than by edits.

**CI** (`.github/workflows/ci.yml`) runs `npm ci --ignore-scripts` → `npm run build` →
`npm run check` on every push to `main` and every PR, plus a check that the `postinstall` hook stays
inert on a non-global install. Before this existed, `typecheck` ran in **no** workflow and the suite
ran only inside the publish job — i.e. first at the moment a version was already shipping, so every
"tsc clean / suite green" claim in this repo rested on somebody's unverifiable local run.

**Releasing: use the `/release` skill** ([.claude/skills/release/SKILL.md](.claude/skills/release/SKILL.md)),
which carries the full publish mechanics. Two facts worth knowing before you get there: publishing is
npm **Trusted Publishing** from GitHub Actions — no npm token exists here, the tag push IS the
credential, and a local `npm publish` fails with a misleading 404; and one of the four tag→registry
gates (the `npm-publish` environment's `v*` deployment-branch policy) lives in **repo settings**, not
in the workflow YAML, so don't judge the protection by the YAML alone.

## Architecture — file → responsibility (all in `src/`)

| File | Responsibility |
|---|---|
| `cli.ts` | Entry point. Parses flags (`--config`, `--default`, `--mode`, `--listen`, `--provider`, `--refresh`, `--client`, `--scope`, `--credential`, `--label`, `--env-name`, `--check`, `--out`, `--purge`) and dispatches the commands `CLI_COMMAND_NAMES` declares — `onboard`, `setup`, `keys {check,add,list,rotate,revoke,remove,disable,enable,export,import,unlock}`, `check-keys`, `models`, `ping`, `dashboard`, `telemetry`, `offload`, `lanes`, `dispatch`, `cooldowns`, `eligibility`, `candidates`, `cost`, `pools`, `routing`, `route`, `config`, `help`, `version`. ⚠ That set, not HELP, is the authority — though the three long-standing HELP drifts are now CLOSED: `lanes` and the `route` alias have entries, and `setup` REFUSES an unknown target instead of falling through to the CLI setup (`setup clade-desktop` used to print the Claude CLI setup and exit 0, so a typo silently did the wrong thing; `claude-cli` was documented but matched no branch and is a real token now). ⚠ **`routing answered`** retires the FIRST-RUN notice and changes no routing: `resolveConfigPath` writes `~/.llm-relay/first-run` beside the config it creates, and `routing show` / `offload status` print a notice on **stderr** while it exists (never stdout — both are JSON surfaces, and a synthetic key inside `cfg.routing` would be a lie about the config). The skill tells the agent to ASK the operator what they want on first use. A flag, not a prompt: `resolveConfigPath` runs inside every command and inside the proxy, usually with no terminal. ⚠ **`DEFAULT_CONFIG_TEMPLATE` now declares the Anthropic passthrough** and points `routing.default` and all four tiers at it. It used to declare NO anthropic provider and default to `pool/medium`, so on a clean HOME `resolveTargets("claude-opus-5")` returned `[]` while README, QUICKSTART and SKILL.md all promised Anthropic — false for exactly the stranger `docs/project-goals.md` makes a goal. The template also declares `cerebras` and `cohere` (bases from the live-verified endpoints), so QUICKSTART Stage 2's `CEREBRAS_API_KEY` and `COHERE_API_KEY` rows are no longer silent no-ops. ⚠ Adding the passthrough REQUIRES `reshaper: { pool: "medium" }` in the template: `mode: "repair"` plus an anthropic-kind provider is a hard load error, so without it every fresh install failed to start. `test/first-run.test.ts` caught that and pins the whole contract against the REAL constant (`DEFAULT_CONFIG_TEMPLATE_FOR_TEST`) — a test that rebuilt the object would be testing itself. Pool/routing/config editors validate the complete JSON before writing and require a proxy restart; targeted offload/candidates/dispatch queries talk to a **running** proxy over loopback when there is one, so a client rule takes effect without a restart and status gets warm health data. `cooldowns clear` is stricter: breaker state lives in the running process (its cooling half is now MIRRORED to disk by `breaker-persistence.ts`, but the live Map is the authority and a clear must reach it), so it requires the running relay, carries the control token, and never falls back to editing files. `cost` is the opposite case — it reads the LOCAL accounting store through a **read-only** store (`readOnly: true`: no writer lease, no journal recovery, no quarantine renames, because every one of those writes to a directory a live relay may be committing to), projects through the SAME `readCostReport` roll-up as the contract's `dashboard.cost.v1` (one aggregation, one policy — no second summing of shards), and works whether or not the proxy runs; a live relay's unflushed in-memory deltas are reported as "recent minutes may lag", never repaired. ⚠ **An unrecognized command is REFUSED, not run as the proxy.** `dispatchDashboardOrProxy` ends the `main` ladder, so any positional no branch claimed lands there — and it used to mean "start the proxy", so a mistyped command started a relay instead of reporting a typo. It now exits 1 naming the token unless the positional is in `CLI_COMMAND_NAMES`; a KNOWN name still falls through unchanged, and a bare `llm-relay` still starts the proxy. Second-order: a value-taking flag missing from `VALUE_FLAGS` puts its VALUE in command position, so that long-warned hazard now fails loudly. ⚠ **Extra positionals are refused across the whole command family** (`COMMAND_ARITY` + the pure `commandArityError`): the read-only commands used to accept and DISCARD what they did not understand — `cost --window 1h 7d` reported 24h, `models nim` listed every provider. Bounds are derived from what the DISPATCHER reads, never from HELP (which omits `lanes` and the `route` alias, and documents a `setup` target that matches no branch). `pools`/`routing`/`route` are VARIADIC and deliberately unbounded — multi-candidate specs are a routing feature. `keys`/`cooldowns`/`help`/`version` are exempt in `ARITY_EXEMPT`, the first two because their own parsers are stricter, fail-closed and secret-safe. The guard runs after help/version and before the first side effect (`loadOrExit` CREATES a config file), and never echoes the stray token — unlike the unknown-command guard, a positional can be anything pasted. `test/cli.test.ts` pins the table against `CLI_COMMAND_NAMES` so a new command cannot miss it. |
| `keys-cli.ts` | CLI-local key-custody router and exported lifecycle runners. Validates configured providers/slots and the strict declared-plus-curated write-name gate; owns the injectable echo-off/piped one-line secret and passphrase input seam; calls keystore APIs and renders non-secret metadata only. Rotation refuses a shadowed store before mutation and uses the existing admitted route only for its non-secret credential selector plus `kinds:["credential-fault"]`; every other operation stays local and never edits live fact files. |
| `config-edit.ts` | Shared JSON document editor for the CLI. Preserves unknown config fields, supports dot paths, rejects prototype-pollution path segments, and runs every candidate document through `loadConfig()` before committing it. |
| `state-paths.ts` | **Where state lives — the ONE definition.** `relayBaseDir(kind)` maps `config` → `XDG_CONFIG_HOME` and `cache` → `XDG_CACHE_HOME`, each falling back to `~/.llm-relay` when its variable is unset, empty or whitespace-only; `relayStatePath(kind, segments)` adds the legacy fallback. It replaced THIRTEEN hand-rolled resolvers running THREE policies — `usage/`/`probe-cache.json`/`runtime-telemetry.json` honoured `XDG_CACHE_HOME`, `target-facts.json`/`refusal-interpretations.json` honoured `XDG_CONFIG_HOME`, and the other eight (`config.json`, `.env`, `keystore.json`, the control token, `models-cache.json`, `lane-manifest.json`, `update-check.json`, the `hooks/` script) honoured neither — so with either variable set the state directory SPLIT and "back up `~/.llm-relay/`" was not a complete backup. Owner decision 2026-08-27: honour XDG everywhere. ⚠ **The legacy fallback is the safety story and is not optional:** `relayStatePath` returns the legacy path whenever the XDG one is ABSENT and the legacy one EXISTS, so an existing install keeps reading AND writing where it already does. That is why there is no migration and nothing is copied or deleted — for `keystore.json` the alternative is an operator's credentials reading as an empty store. Once the XDG path exists it wins, even with a legacy file beside it. ⚠ Classification is per ARTIFACT and follows XDG's own distinction — operator-authored or credential-bearing is `config`, re-fetchable is `cache`; never reclassify an artifact to move it. ⚠ Bases identical ⇒ NO `existsSync` call at all, so the common case costs nothing. ⚠ It is NOT a vitest guard: every caller keeps its own `process.env.VITEST` check ABOVE the call (a call-site guard is how the control-token one came to be half-covered). `test/state-paths.test.ts` pins the policy through injected `env`/`home`/`exists` seams AND greps `src/` so no fourteenth resolver can reintroduce a raw XDG read or a hardcoded `homedir(), ".llm-relay"`. |
| `dotenv.ts` | Loads `~/.llm-relay/.env` into `process.env` at startup, **never overwriting an already-set variable**, and records only the names it populated so credential provenance distinguishes `env-file` from the real environment. `onboard` always wrote this file and nothing ever read it, so a wizard-saved key worked for one shell and then "stopped working". The real environment wins because it is the more explicit signal. |
| `pool-health.ts` | `llm-relay pools --probe` — sends a REAL completion to every pool member. Config-time validation cannot see a model that is listed and still dead (de-listed behind the scenes, gated to a paid tier, routed to a missing function), and that is exactly how a pool ends up with one live member and paper failover. Probes at 400 max_tokens because reasoning models return an empty 200 at a low cap — `empty` is a distinct verdict from `missing`, not a synonym. ⚠ **A verdict may only claim what its evidence supports** (2026-08-27). The probe posts a completion for ONE model, so a 401/403 is exactly the entitlement-wall case and reports `denied` — a rejection with no blame assigned, and the CLI advice says in as many words not to rotate a credential on it. `auth` survives only for the case that IS a credential fact: no enabled slot holds a key, so no request was sent. And 400 no longer shares `missing` with 404 — a 400 is a request-validation error (mistral's 9-char tool-call-id refusal; a `max_tokens` complaint), so it maps to `error`. `MemberVerdict`'s consumers are total records, so a new member is a compile error until handled. |
| `authEnv.ts` | Resolves a provider's declared `authEnv` name against a **closed** per-provider alias list (`GEMINI_API_KEY` vs `GOOGLE_API_KEY`, …), then falls back by those same names to the keystore with source-major env precedence and `env`/`env-file`/`keystore` provenance. Explicit fleet slots stay declared-only. Deliberately never scans the env for key-shaped names — a heuristic match would ship one provider's credential to another's endpoint. ⚠ `buildAuthHeaders` writes through a **total writer table** `satisfies Record<AuthHeaderName, …>`, not an if/else: it used to end in an unconditional `return { "x-api-key": value }`, so a future header name would have sent the operator's credential under the wrong one, and an absent `authHeader` (a hand-built test target) was accepted silently as `x-api-key`. A new member is now a compile error at the table. |
| `credential-id.ts` | Stable identity for a configured credential slot — a branded `provider#label` string (`makeCredentialId`/`parseCredentialId`). Labels are bounded to `[A-Za-z0-9_.-]{1,32}` and the provider may not contain `#`, so an id always round-trips to exactly one (provider, label) pair. |
| `credential-fleet.ts` | Normalizes a provider's declared credential slots (`credentials[].label/authEnv/models`) into non-secret descriptors plus source-labelled resolvers for each. Attempt identity always comes from the config slot; keystore entry identity remains provenance only. An empty `models` array deliberately matches NO models; slots from `credentials` resolve **declared-only** (no legacy alias fallback); only enabled + model-allowed + present slots produce an attempt. |
| `resolved-attempt.ts` | The application-layer attempt shape with credential resolution performed exactly once (`ResolvedAttempt` = target + `credentialId` + resolution + slot). A missing slot still returns a frozen attempt carrying `declared-missing`, so legacy callers raise their established credential-config error before any egress. |
| `credential-select.ts` | Ranks credentials WITHIN one deployment (never reorders deployments) and runs the request-local breadth-first `CredentialWalk`. Ranking bands: hard facts → health/cooling/fault → fresh provider-stated headroom (unknown ⇒ neutral band, never a guess) → cost (unknown ties with paid) → LRU → config order. `next()` only OFFERS a candidate; `recordStarted()` immediately before fetch is the sole budget/LRU mutation boundary. |
| `configured-limits.ts` | Operator-asserted rate limits (spec §4 rung 3): the closed axis list (`CONFIGURED_LIMIT_AXES`), the `limits` block parser (hard error on an unknown axis or non-positive value, naming the key — an ignored typo reads as a ceiling while bounding nothing), and the pure per-axis resolver (`resolveConfiguredLimits`: credential-model → provider-model → credential → provider; null when nothing is declared). Every figure is labelled basis `configured`; these never refuse a request by themselves — except a figure under the `hard` sub-block, which is G2's refusal ceiling and lives in `hard-cap.ts`. Carries the axis→quota-vocabulary mapping so consumers join it with header observations without importing config internals. |
| `hard-cap.ts` | The G2 manual per-credential HARD CAP — the refusal half of "a DERIVED number may only demote; an explicit operator-set cap may refuse". Pure `evaluateHardCap` resolves the `limits.hard` block through the same per-axis ladder as the soft figures and compares it against this relay's own in-memory `usedInWindow` — the seam `quota-demotion.ts` uses, whose `bucketRank` it imports rather than re-states. For token axes, an estimated-only window now includes estimated input + output, correcting the pre-M4 input-only undercount, so that completed estimate can move the explicit refusal ceiling. **The read is narrowed by the cap's own SCOPE, taken from `hardSource`:** a flat `credential`/`provider` cap counts that credential's usage across ALL models, a `credential-model`/`provider-model` cap counts only that deployment's — the verdict carries `source`+`scope` so all three consumers (request path, `/candidates`, dashboard producer) ask the ledger the same question. Inclusive (`used >= cap`; 450 admits 450); unknown usage ⇒ null ⇒ no effect; month axes are rejected at CONFIG LOAD because the window read declines month and a cap that could never fire would bound nothing while looking like it did. `routing.quota.hardCaps: false` (default true) turns every cap back into a soft limit. The server wraps it in `nextUncappedAttempt()` on BOTH fronts at the attempt boundary before egress/`recordStarted()`: a capped attempt is skipped with no egress/LRU/breaker/accounting mutation but still counts as `Nxcapped` in pool-attempts; when EVERY candidate was capped the relay answers 429 itself (`respondAllCapped`) with the front's native error body, `x-llm-relay-capped` (at most 5 cells named, `+K more` beyond), and a Retry-After derived only from the soonest UTC period boundary. A cap never registers on the breaker — it is config, not health. |
| `availability.ts` | The spec §5.1-5.3 availability ladders as PURE functions (no IO, no clock — `now` is an argument): `resolveRemaining` (provider-stated → derived limit−localUsed → null; staleness is a READ-TIME eligibility test against the current UTC period, never a repair write; a negative remaining is preserved, not clamped — overshoot is information), `resolveResetsAt` (provider-stated → reviewed-rule → derived UTC boundary → null), `periodStart`/`periodEnd` (UTC only, real month lengths), and the ONE mapping of internal bases onto the dashboard contract spellings. `routingEligible` (true for `provider-stated`, `derived:provider-stated` and `derived:configured` — never for learned or published) is the ROUTING gate Gap 12 reads, not a display flag: `quota-demotion.ts` demotes only a bucket that clears it, or a `derived:learned` one under the `routing.quota.enforceLearned` opt-in, which bypasses the flag rather than flipping it. This module itself stays pure — it never reorders or refuses; it only labels what MAY gate. The reviewed-rule rung is **fed** since 2026-08-23: `factResetInputs` turns the target-facts covering one credential×deployment cell into rung-1/rung-2 inputs, and it is the ONE definition of that policy — the dashboard producer and `candidates.ts` both call it, because two implementations is how one cell comes to read `reviewed_rule` on one surface and `derived_boundary` on the other. A fact answers a bucket only when EVERY gate holds: its kind is in `QUOTA_RESET_FACT_KINDS`, it carries an explicit `untilBasis`, its `until` is still future, the bucket is MEASURED-spent (`remaining <= 0`; unknown has no effect at all) and the eligible observation stated no reset of its own. Within that the most-specific SCOPE wins per basis class — never the soonest expiry, which would let an unrelated short fact pre-empt rung 2 — and both inputs are returned independently so the ladder, not recency, picks the rung. ⚠ A fact carries no axis/period attribution, so those gates ARE the containment; inferring an axis from a fact's kind would be the invention `target-facts.ts` refuses. Still pure — it is handed facts a caller already read. Also `projectLocalUsed` — the ONE projection of a raw ledger window onto a quota axis, shared by `quota-demotion.ts`, `availability-snapshot.ts` and the hard-cap ledger reader. It labels a relay-counted REQUEST total `relay-counted` rather than borrowing the store's `basis`, which describes the TOKEN figure only; `LocalUsedBasis` gained `relay_counted` additively on the wire. ⚠ The vocabulary mappers (`mapRemainingBasis`, `mapLocalUsedBasis`) carry `const _never: never` exhaustiveness assertions, so a new provenance is a COMPILE error rather than a silent null on the dashboard; `DERIVED_BASIS` `satisfies Record<LimitProvenance, …>` so a missing row is reported at the table. `bucketKey` is imported from `quota-observation.ts` — three hand-copies of `${axis}:${period}` existed, one of them added by the commit that gave bucket GATHERING one home. |
| `availability-snapshot.ts` | The producer the dashboard's Quota/Cooldown panels were missing: walks breaker cell state, configured/learned limits, target-fact COOLING conditions and the local ledger IN MEMORY and emits `QuotaRowV1[]`/`CooldownRowV1[]`. No provider egress, no probes, no disk reads; never throws (a failing dependency yields empty panels, which the projection marks as its own coverage). Does NOT truncate — `dashboard-snapshot.ts` owns the row cap and the partial flag. Cooldown reason mapping: retry-after/escalation/429/402 → `rate_limit`, generic → `provider_error`, credential fault → `auth_error`, `allowance-exhausted`/`rate-limited` facts → `rate_limit`, `credential-invalid` → `auth_error`; fact-derived rows carry `observedAt: null` rather than a fabricated time. Quota rows also read those facts for their `resetsAt`: one `factsFor` call per cell (not per bucket), fed through `availability.ts` `factResetInputs`, so a reviewed refusal-interpretation reset renders as `reviewed_rule` and a header/body one as `provider_stated` without this read path ever re-parsing vendor prose. The injected `readFacts` seam covers BOTH halves — a seam only one consumer honours implies coverage it does not have. |
| `key-import.ts` | Parses dotenv files or the documented FreeLLMAPI v1 export envelope into provider/env-name records. Matching is closed: legacy providers accept their declared plus curated aliases and configured fleet slots accept their exact `authEnv`; provider-derived guesses and value-shape heuristics (`sk-…`, length, entropy) never become writes. Onboarding may persist parsed values to `.env`; `keys import` sends them to the keystore. Valid JSON of any other shape is rejected outright, not treated as dotenv. |
| `keystore.ts` | Versioned encrypted credential store: KEK-verifier-checked lazy unwrap memoized process-wide on success and per cooldown epoch on failure, AES-256-GCM rows bound to version/provider/id/envName, salted keyed fingerprints, non-secret descriptors/status, lifecycle mutations (revoke/remove/disable/enable remain metadata-only while locked), passphrase-verifier/wrap-mode introspection, encrypted-only scrypt + AES-256-GCM export/decrypt/restore APIs, zeroization, and atomic restrict-before-publish writes. Existing-but-unparseable or degraded stores refuse every mutation byte-preservingly: credential rows are the operator's only keys, unlike re-learnable target facts, so degrade-to-fresh is unsafe. Read-side candidate walks deliberately cover derived env names wider than the strict `keys add` write gate; read-side env parity is the contract, while entry provider/id remain provenance rather than lookup filters. Parsed-store verdicts, including absence and unreadability, are memoized by normalized path and the practical `mtimeMs` + `size` + `ino` stat token: `path.resolve` coalesces syntactic aliases only, stat-token change invalidates immediately, and unchanged unreadable stores retry automatically after about 30 seconds. Unlock failures are cooldowns keyed by normalized path plus canonical KEK-descriptor identity: they self-heal after about 60 seconds with at most one unwrap spawn per uninterrupted cooldown epoch; same-descriptor stat changes do not bypass the cooldown, descriptor changes do, and explicit `lock()` ends it. Successful `keystoreStatus()` deliberately retains the verified KEK process-wide to serve spawn discipline. |
| `os-keyring.ts` | KEK creation and recovery through DPAPI, Keychain, libsecret, or scrypt passphrase mode. KEK bytes travel only through captured stdin/stdout — Keychain writes use `security -i`, never argv — and child failures are sanitized because diagnostics may echo secrets. Under VITEST, no real keyring process runs without an injected spawner, preventing tests from touching live custody. |
| `secret-file-acl.ts` | Best-effort Windows hardening of secret files (`icacls /inheritance:r /grant:r <user>:F`). Fire-and-forget by design — a missing or broken icacls is a hardening failure, never a reason to make the secret unusable. Skipped under vitest unless the spawner is injected, so the suite can't lock itself out of its own fixtures. |
| `presets.ts` | `FREE_PROVIDER_PRESETS` — built-in free/subscription provider definitions (base, kind, authEnv, signup URL, recommended models) used by onboarding and setup. |
| `config.ts` | Load/validate config. `${ENV}` expansion, loopback enforcement, multi-candidate tier specs (`string | string[]`), **`pool/<name>` routing** (`routing.pools`; `pool` is a reserved provider name; an unknown pool is a loud `RoutingError`, never a silent fall-through to `routing.default`), **client-specific offload routing** (`isSubagentRequest` reads Claude/Codex child markers; `subagentSpec` applies `routing.subagents` through the originating client's `routing.offload` rule, with `scope: "subagents" | "all"`, or an `@relay:` directive read ONLY from the last text block of `messages[0]`; a rule may carry `freeOnly: true` — see the gotcha), reshaper auto-synthesis, and **operator-asserted rate limits** (`providers.<name>.limits`, `credentials[].limits`; parsed by `configured-limits.ts`, basis `configured`). Also **per-provider wire-shape compat** (`providers.<name>.compat`; two keys, `toolCallIds: "preserve" | "strict9"` and `thoughtSignature: "none" | "sentinel"` — an unknown key or value is a hard load error naming it, the `configured-limits` precedent) whose absent values resolve through `resolveToolCallIdMode()` / `resolveThoughtSignatureMode()` from a **labelled provider fact** — a `*.mistral.ai` base host defaults to `strict9` and the exact host `generativelanguage.googleapis.com` to `sentinel`, everything else to `preserve`/`none`, and an explicit value wins in both directions — onto `ResolvedTarget.toolCallIds` / `.thoughtSignature`, so the request mapper is handed a RESOLVED mode and never a provider identity. Also `leave_me_alone` — the onboarding-nudge suppression list, whose entries are deliberately NOT validated against the known providers (see `onboarding.ts`). |
| `session-pin.ts` | Ephemeral sticky-session affinity (`routing.sticky`, off by default): relay-owned `x-llm-relay-session` or a 16-hex SHA-256 first-user-message key, optionally compounded with the documented Claude agent id. Sliding 30m TTL, 1,000-entry LRU default, metadata only. No unverified client-session header is accepted, and request-path promotion is constrained by health and the pool's degrade boundary in `server.ts`. |
| `offload.ts` | Client-specific offload state. `setOffload()` mutates the **live** `Config` (so the next request routes the new way with no restart) and rewrites the targeted `routing.offload.<client>` rule in the file it was loaded from. Never throws — an unpersistable change still applies in memory and reports `persisted:false`. |
| `dispatch.ts` | The dispatch ladder (`GET/POST /dispatch`, `llm-relay dispatch`) — which LANE a host should hand a whole delegated task to, in order, with tier selection (`?tier=`), host override (`?lane=`), walk-past (`?after=`) and host-reported exhaustion (`POST {"exhausted"}`). `routing.ladders.<tier>` supports different CLI models for reasoning/coding/fast; the legacy `routing.ladder` remains valid. An exhaustion report may carry `outcome: "rate_limited"` (15m default) or `"quota_exhausted"` (1h default) and a vendor-stated `retryAfterMs` that beats both (`OUTCOME_DEFAULT_MS`); the relay still never invents the signal. A `cli` rung may declare `env` (string = set, `null` = unset — both needed for a relay-routed `claude -p` child: base URL set, nested-session vars unset), surfaced on `invoke.env` and rendered by the CLI per shell; the task placeholder is never substituted into env values. Distinct from `routing.subagents`, which routes one HTTP turn. **The request path never spawns a `cli` rung** — it owns the order, the host executes; the only lane-spawn sites are the operator probe and the background cadence (owner amendment 2026-08-29, see the ladder gotcha). Exhaustion state is per-Config in memory, mirrored to disk by `dispatch-exhaustion-persistence.ts` (future-only restore), with key-level ops (`markExhaustedKey`/`clearExhaustedKey`/`exportExhaustedRows`/`restoreExhaustedRows`) so the quota probe can write the bucket it tested without a rung lookup. |
| `context-limits.ts` | Context ceilings LEARNED from what a deployment stated when it refused an over-length request. The top rung of `contextWindowResolver` — first-party evidence about the exact deployment, which a published catalogue figure can contradict by being generic or stale. ⚠ **Only an explicitly stated maximum is recorded**: "the request was too long" bounds the ceiling by this proxy's own chars/4 estimate, and a store whose value is that it holds measurements must not accept a guess. Stored as a `context-limit` **fact** in `target-facts.ts` (deployment scope, 30-day TTL) — there is no separate `context-limits.json`. Also holds the OUTPUT-token sibling: `parseStatedMaxOutput`/`recordObservedMaxOutput` learn an EXPLICITLY stated `max_tokens` ceiling (the groq 400 case) as a `max-output` fact, same scope, TTL and fail-safe, wired beside the context observer in `inspectCandidateResponse`. ⚠ Display-only by owner decision ([docs/max-output-caps-design-2026-08-29.md](docs/max-output-caps-design-2026-08-29.md)): renders in `candidates`; nothing clamps the caller's `max_tokens`, nothing refuses, nothing routes on it. |
| `target-facts.ts` | The ONE store for learned facts about targets (`~/.llm-relay/target-facts.json`), each carrying the **scope** it applies to: `attempt` (one credential × model) → `group` (explicit member list) → `deployment` (provider + model) → `credential` (one slot) → `provider` (every credential for it) → `model` (cross-provider, reference-grade). Lookups resolve most-specific-first. Eleven kinds in two halves — five CONDITIONS (`not-servable`, `subscription-required`, `allowance-exhausted`, `credential-invalid`, `rate-limited`) and six MEASUREMENTS (`context-limit`, `max-output`, `rate-limit-rpm|rpd|tpm|tpd`). ⚠ Only `not-servable`/`subscription-required` evict; the rest demote. ⚠ A success clears only CONDITIONS (`clearFacts` excludes every measurement) — a success disproves a condition, never a measurement; measurements are also never cooling and never cost-blocking. ⚠ The persisted key is `<kind>:<scope>` — one scope may carry several kinds at once (a real Groq 429 states an RPM and a TPM ceiling together), which a scope-only key silently collapsed to one; pre-existing scope-keyed rows are migrated at load. ⚠ A row may also carry `untilBasis` — the closed enum (`retry-after` | `reviewed-field` | `stated-body` | `reviewed-fixed`) naming which rung of `server.ts` `resolveReset` produced its expiry, so the availability ladder can rank a reset without re-reading the response. It is bound to the expiry it explains: `recordFact` drops it unless `retryAfterMs` is positive and finite, and `load` drops it on a row with no explicit `until` or with a spelling outside the enum — ABSENT means "a legacy row, or the kind's default TTL", and a fallback wearing a basis is exactly a guess labelled a measurement. An unknown spelling never fails the load. `QUOTA_RESET_FACT_KINDS` (allowance-exhausted + rate-limited) is exported for the quota ladder: COOLING minus `credential-invalid`, because when the relay will next retry a faulted key is not when an allowance refills. `clearCooldownFacts()` is narrower than success clearing: it retracts only active cooling conditions whose whole atomic scope is contained by the provider/model/credential selector; broader rows, eviction conditions, and every measurement remain intact. |
| `rate-limits.ts` | Rate ceilings LEARNED from what a deployment STATED about itself — the sibling of `context-limits.ts`, stored as the four `rate-limit-*` measurement facts. ⚠ **Only an explicit limit with a confidently identified axis AND period is recorded** ("limit 60 requests per minute", "TPM: 6000"); "rate limit exceeded" proves throttling but states no number, and "you used 120 tokens" is a count, not a ceiling — either way a miss learns NOTHING, same fail-safe as the context parser. A body naming several ceilings yields each (`<kind>:<scope>` keying keeps RPM and TPM side by side). Scope follows evidence: attempt → credential ONLY when the wording names the account/key → deployment when no credential is known; never widened by counting siblings. Wired on BOTH fronts in `server.ts` — 429 bodies beside `observeContextLimit`, and the durable `limit` half of provider-stated quota headers (minute/day only). **Display-only today** (`/candidates` renders kind + value + scope); acting on learned limits for routing is spec decision M2, opt-in, not built. |
| `refusal-interpretation.ts` | What a refusal MEANS — deterministic lookup on the request path, judgement strictly out of band. A refusal reduces to a signature (provider + model + message with uuids/ids/numbers/urls stripped); a hit applies, a **miss learns nothing** and queues the signature for offline research. Seeds (reviewed source, derived from first-party probes) bind immediately; a researched verdict binds only once accepted via `llm-relay eligibility`. ⚠ **And it now reaches a RUNNING relay** (2026-08-27). The store memoized on the path alone, so an `accept` written by the CLI process never invalidated the relay's copy — `docs/reference.md` promised "only `accept` makes an interpretation affect routing" and it took a restart. The memo is now keyed by the `keystore.ts` stat token (`mtimeMs:size:ino`, symlink-resolved, normalized path), and `persist` re-reads and MERGES whenever the token moved, so a relay write cannot serialize a stale snapshot over an operator's acceptance: disk wins for `confirmed`, `unknown` rows union, and a signature promoted to `confirmed` on disk is never resurrected into `unknown`. `readStoreFile` is the one parser both paths use. ⚠ `target-facts.ts` deliberately does NOT get this: its writer/reader roles are reversed (relay writes, fresh CLI processes read), so it has no equivalent exposure. ⚠ **Signatures converge across LANES (2026-08-29).** The walk lane hands the observer the relay's own anthropic error envelope, whose `error.message` is the `openai backend HTTP <n>: …` wrapper around a 300-char-truncated provider body — so one provider condition used to normalize DIFFERENTLY per lane and need two accepts (the lane-split defect, [docs/eligibility-triage-2026-08-29.md](docs/eligibility-triage-2026-08-29.md) finding 1). `normalizeRefusalMessage` now unwraps to a FIXPOINT: extract the message (JSON parse, then a deterministic field-regex fallback for truncated/unparseable payloads, unterminated-value tolerant, escape-decoding), strip the relay's own wrapper prefix, repeat. `readStoreFile` re-keys every stored signature through the current normalizer at load (`migrateSignatures` — later acceptance wins a confirmed collision, unknown rows merge counts and update `normalized`/`sample` so `unknownMatchesSignature` keeps holding, ignored keeps the latest; idempotent, and inside the ONE parser so the persist-merge can never resurrect an old key). Residuals, stated: a message CUT by the 300-char cap converges only when both lanes' extractions share the same 240-char signature prefix — otherwise each lane keeps its own signature and binds per-lane; and an EMPTY wrapped body normalizes to "" and learns/queues NOTHING (relay wrapper prose is not a provider statement — one live empty-body row went inert on migration, by design). |
| `network-block.ts` | Recognising a refusal that is about the CALLER'S NETWORK — a VPN exit, a proxy, a blocked egress IP — rather than about the target. Measured 2026-08-29: `groq/qwen/qwen3.6-27b` refused 20 times over 7.9 hours with `access denied. please check your network settings.` while the credential was VALID, the model was in the account's roster and the quota was untouched; it answered HTTP 200 the moment the operator's VPN came off. ⚠ **Display-only, and that is the design.** It records no fact, demotes nothing, refuses nothing and never reaches the request path — every member of the closed `FactKind` vocabulary states something about DEPLOYMENT eligibility, and a client-side network block is none of them, so recording one would assert what the evidence does not support. `test/network-block.test.ts` pins the claim structurally: the module must import NOTHING, so a later edit that pulls in `target-facts.js` to "also record it" fails at the claim. ⚠ Matching is on WORDING and deliberately NOT scoped to the provider first observed — the inverse of `refusal-interpretation.ts`'s per-(provider, model) keying, because the condition belongs to the operator's own network and can strike any vendor; the trade is safe only because the output is one advisory line. ⚠ Every pattern names its provenance and only first-party-observed wording is admitted; plausible additions (Cloudflare `error 1020`, bare `access denied`) are absent as guesses. ⚠ **The advice says LEAVE THE ITEM PENDING, never `reject`** — reject writes the signature to the store's `ignored` set where it stays suppressed, so the tidy-looking verdict would silence the next episode entirely and defeat the module's whole purpose. A permanent queue entry is the price of a warning that still fires. |
| `executable-lookup.ts` | **Finding an executable on PATH — the ONE definition.** `commandExistsOnPath` lived inside `os-keyring.ts`, scoped to picking the Linux `secret-tool` backend, and moved here when `installed-hosts.ts` needed the same question; `os-keyring.ts` now imports and re-exports it, so its public surface is unchanged. ⚠ The keyring's copy had **no PATHEXT handling** — correct for Linux, and silently always false on Windows for anything not spelled with its extension, which would have made `codex` (an npm `.cmd` shim) undetectable on every Windows machine that has it. `executableCandidates` appends PATHEXT on win32 only, falls back to the documented `.COM;.EXE;.BAT;.CMD` when the variable is unset, skips blank entries, and does NOT double-suffix a name that already ends in a known extension (`agy.exe.EXE` exists nowhere; the test is case-insensitive because Windows paths are). ⚠ It never spawns — no `which`/`where` subprocess — so unlike `winenv.ts`/`os-keyring.ts`/`secret-file-acl.ts` it needs no vitest spawn guard; `X_OK` has no effect on Windows (Node treats it as `F_OK`), so one call is correct on both platforms and Linux behaviour is byte-for-byte what it was. Absence is the branch signal, never an exception. |
| `installed-hosts.ts` | Which agent CLIs are **actually installed** on this machine (`claude`, `codex`, `agy`, `opencode`) — a different question from every other detection here, which is why it exists. `lane-probe.ts` asks what an ALREADY-CONFIGURED ladder rung serves and can say nothing about a tool absent from `config.json`; `authEnv.ts` asks whether a DECLARED credential is present. Neither answers "the operator has Codex; should we offer it?", which is what an onboarding conversation needs. ⚠ **Detection requires POSITIVE evidence and reports its basis**: `onPath` (a binary resolved) and `configPath` (an owned path exists) are separate fields, and `installed: false` means NO EVIDENCE FOUND, never "absent" — the `key-checker.ts` `unverified` rule applied to tools. ⚠ **A config path is deliberately weaker than a binary**: `install-skill.mjs` writes into `~/.codex/`, so counting the bare directory would be llm-relay detecting its own footprint and the gate it feeds would be permanently true. Codex is therefore keyed on `.codex/config.toml`, which the installer writes only once Codex is already detected; a caller that must not be fooled reads `onPath`. ⚠ `agy` carries BOTH `agy.exe` and `agy` because a bare `agy` on Windows can resolve to a PowerShell function that opens the IDE — naming both is detection, and nothing here ever runs either. `HOST_PROBES` is a total `Record<AgentHostId, …>` closed with `satisfies`, so a new host is a compile error rather than a member that silently never gets detected. Every environment input (`env`, `platform`, `home`, `exists`, `onPath`) is injectable, and no seam failure can throw out of `detectHost`. |
| `host-routing.ts` | Does the CALLING host's traffic reach this relay? `routed` / `bypassed` / `unknown`, decided on the caller's `ANTHROPIC_BASE_URL` (loopback ⇒ routed, so a chain like headroom in front still counts) and never on `CLAUDE_CODE_ENTRYPOINT`, which only names the host in the message. ⚠ Evaluated in the **CLI** process and forwarded as `?host=` — the server cannot detect a bypassing host, because a bypassing host sends it nothing. |
| `claude-hook.ts` | The `PreToolUse(Agent)` hook that delivers `offload claude on` where HTTP rerouting cannot: it denies the `Agent` call and hands back the transposed command. **Forcing function, not a redirect** — no hook can move an in-process subagent's endpoint. Appends alongside the user's own hooks, refuses to rewrite an unparseable `settings.json`, and the generated script fails **open** on every error. |
| `dynamic-pools.ts` | Materializes `{ preferred: [...], include: "free" }` pools as an invariant fixed prefix plus every catalog-discovered free target in benchmark order. Free-provider unknown prices are admitted unless known paid; mixed providers contribute only zero-priced or explicitly free-labelled models. Replaces the tail after catalog refresh so new models need no manual config edits. |
| `candidates.ts` | The un-blended decision table for offload targets (`GET /candidates`). Capability, live health, quota, breaker state and observed traffic as **separate** fields, config order, no ranking. Existing composites are quarantined under `sortInputs`, labelled as what they drive. Its §5 availability rows resolve through the same `factResetInputs`/`resolveResetsAt` pair the dashboard producer uses, so `llm-relay candidates` and the Quota panel cannot disagree about one cell's reset provenance. |
| `server.ts` | The proxy. Request routing, context length guardrails (`estimateRequestTokens`), the Gap 12 quota demotion term inside `targetUsability()` (reached by both fronts through their shared walk-order helpers), detect vs repair paths, streaming vs buffered, endpoints (`/v1/messages`, `/v1/messages/count_tokens`, `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/registry`, `/telemetry`, `/ping`, `/health`, `/health/stats`, `/candidates`, `/offload`, `/dispatch`, `/cooldowns/clear`, `/dashboard`, `/dashboard/assets/*`, `/dashboard/api/v1/{bootstrap,session,logout,snapshot,requests/:id}`). Front-door paths identify the originating client for offload. **Loopback is not authorization** — `/offload`, `/dispatch`, and `/cooldowns/clear` share one admission boundary: exact bound `Host`, exact match for any present `Origin`, `content-type: application/json` on mutations, and the per-install control token where required; see the gotcha below. `buildForwardHeaders()` decides credential containment from the config **declaration** (`credentialState()`), never from key presence. |
| `backend.ts` | `fetchBackend()` → returns an **Anthropic-shaped** `Response` (`anthropic` passthrough; for `openai` the REQUEST direction is relay-owned — `openai-request.ts` — and only the RESPONSE direction is llm-bridge's). `fetchOpenAiFront()` → bidirectional OpenAI Chat/Responses adapter: direct OpenAI Chat passthrough, or OpenAI↔Anthropic request/response/SSE translation for the other combinations. The RESPONSES request direction is relay-owned too (`responses-request.ts`); llm-bridge keeps only the CHAT request translation (`openaiToUniversal` does model `tool_calls`/`role:"tool"`) and every response/stream direction. Also the wire-shape helpers both paths share: `parseRetryAfterMs()` (both RFC 9110 forms; null, never 0, for garbage) and `normalizeOpenAiErrorBody()` (passes a conforming `{error:{…}}` through byte-exact, unwraps gemini's array envelope, wraps everything else). Cross-protocol usage honours each protocol's inclusion semantics — OpenAI `prompt_tokens` INCLUDES cached tokens, Anthropic `input_tokens` EXCLUDES them — so cache reads/writes are summed in / split out at the two buffered translation seams rather than lost. On the openai-kind path only, both the buffered mapper and the translated SSE stream pass through `tool-use-ids.ts` so a host that reuses a tool-call id cannot make the client drop its own tool calls — announced as `x-llm-relay-tool-use-ids` (buffered) and as the `toolUseIdRewrites` log counter (streamed). The REQUEST direction's sibling is passed at the same seam: the target's resolved `toolCallIds` mode reaches `anthropicRequestToOpenAi`, and its count is announced as `x-llm-relay-tool-call-ids` on BOTH buffered and streamed responses (the figure is final before egress) plus the `toolCallIdRewrites` log counter — forwarded across the Responses front's rebuild like its response-direction twin. The target's resolved `thoughtSignature` mode rides the same seam, but its count (`thoughtSignatureSentinels`) travels ONLY as process-local metadata into the log: it is vendor-protocol padding on the relay's own outbound shape, not a change to the caller's data, so there is no header for a client to read. |
| `openai-request.ts` | `anthropicRequestToOpenAi()` — the Anthropic-Messages → OpenAI-Chat REQUEST mapper, mirror of `backend.ts`'s response-direction `anthropicMessageToOpenAi`. It exists because llm-bridge's `universalToOpenAI` has no case for a `tool_call`/`tool_result` block and stringified its own IR envelope into the OUTBOUND prompt — models read the bogus notation and echoed it back as their answer, results were triplicated and no `role:"tool"` message was ever produced (docs/tool-call-dialect-leak.md §"Second mechanism"). `tool_use` → `tool_calls`; each `tool_result` → its own `{role:"tool", tool_call_id, content}` message (carrying the caller's own function `name`, looked up from the matching `tool_use` — gemini's compat layer folds a tool message into a `functionResponse` part whose `name` is required and never resolved from `tool_calls`; an orphan result with no matching call gets no name, never an invented one), emitted before the turn's remaining blocks; `thinking`/`redacted_thinking`, `metadata` and the request-level `thinking` budget are DROPPED (no representation, and a guessed `reasoning_effort` would be an invention). An image inside a `tool_result` has no OpenAI tool-message representation and is carried losslessly rather than refused — text on the tool message, the image as an `image_url` part on the user message that follows the turn's tool messages (refusing it was a LOCAL 400, which `server.ts` does not fail over, so one screenshot killed the whole request). Anything with no representation at all — an unmodelled block type — is REFUSED as a clean local 400 (`RequestMappingError`, the `documents.ts` precedent), never stringified: the body the relay sends must be the caller's conversation, not the relay's internals. Under a target resolved to `compat.toolCallIds: "strict9"` (mistral) every outbound `tool_calls[].id` AND its answering `tool_call_id` are rewritten through ONE per-run map to mistral's stated `^[a-zA-Z0-9]{9}$` — deterministic SHA-256/base62, no randomness, an already-conforming id kept as-is, collisions resolved by a suffixed counter in first-appearance order, the `name` lookup still keyed by the ORIGINAL id; under `"preserve"` (everyone else, and the default) the outbound bytes are unchanged. Under `compat.thoughtSignature: "sentinel"` (gemini on `generativelanguage.googleapis.com`) EVERY emitted `tool_calls[]` entry additionally carries the raw string `skip_thought_signature_validator` at `extra_content.google.thought_signature` — Google's documented opt-out for a replayed call with no signature, since echoing a real one would need a conversation store (`tool-use-ids.ts`'s "no reverse map, by construction") or a fabricated `thinking` block; counted as `thoughtSignatureSentinels` with deliberately NO response header, and under `"none"` (everyone else, the default) the bytes are unchanged. |
| `responses-request.ts` | `openaiResponsesRequestToAnthropic()` — the OpenAI-Responses → Anthropic-Messages REQUEST mapper, the Responses-front sibling of `openai-request.ts`. llm-bridge's `openaiResponsesToUniversal` models `function_call_output` and nothing else, so an assistant `function_call` (no `role`) was flattened into an empty user turn — the tool call vanished and the `tool_result` after it had nothing to answer, breaking every Responses tool conversation past the first call on BOTH backend kinds — an assistant `output_text` reached the backend as `JSON.stringify(part)`, a `reasoning` item became a bogus user turn, and `instructions` was read by nobody. Ids round-trip unchanged (`function_call.call_id` → `tool_use.id` → `tool_calls[].id`), consecutive same-role items merge into one turn (assistant message + its `function_call`s; consecutive `function_call_output`s, whose `tool_result` blocks lead the user turn), `reasoning` items and `reasoning.effort` are DROPPED (llm-bridge's `budget_tokens: 10240` was an invented figure), hosted tool declarations are dropped as before, and `previous_response_id`, a `text.format` structured-output contract, and any unmodelled item type are REFUSED as a clean local 400 (`RequestMappingError`, shared with `openai-request.ts`) rather than silently reshaping the conversation. `max_output_tokens` absent carries llm-bridge's 1024 — a default, not a measurement. |
| `stream-commit.ts` | Final-wire SSE commit probe shared by both candidate loops. Buffers raw bytes until the client-facing Anthropic/Chat/Responses protocol carries meaningful text, reasoning, or a structured tool call; replays the prefix byte-exact; and classifies pre-content error/empty/cap/cancellation outcomes before any downstream head is written. The 64 KiB limit is shared with `backend.ts` structural preflight. ⚠ An in-band error event is classified `upstream` — i.e. RETRIABLE — by default, because normally it is the provider's. `relayAuthored()` is the one exception: an error carrying a relay-owned code (today `DIALECT_REFUSED_DESTRUCTIVE_CODE`) is classified `local`, so a streamed PRE-COMMIT refusal is terminal exactly like its buffered twin. Without it the same refusal would reroll across the whole pool on one lane and stop dead on the other. |
| `sse-frames.ts` | The boundary rule for the FIVE STREAM MODULES (`openai-dialect`, `stream-commit`, `think-tags`, `tool-use-ids`, `dialect-stream`): mixed-terminator-correct boundary detection, buffered frame iteration, and raw `event:`/`data:` field extraction; each adopter keeps its own trimming/event-name policy. It also owns `parseSseEvent` — the ANTHROPIC-shaped event parse (last `event:` line wins, data lines trimmed and joined, unparseable body degrading to `data: null`, blank block declined) — because `dialect-stream` and `think-tags` held BYTE-IDENTICAL private copies of it, one layer above the extraction this file already unified. ⚠ `openai-dialect` deliberately keeps its own: FIRST event line, a leading space stripped per data line, a `[DONE]` sentinel and a non-nullable return, so sharing one would change its wire behaviour — that is the trimming/event-name boundary above, not an omission. THREE divergent semantics predated it — `dialect-stream`'s inline pure-`\n\n` scan could not match CRLF at all and swallowed such a stream whole (latent; llm-bridge emits `\n\n`). ⚠ Deliberately NOT adopted by: `server.ts` `frameEnd` (byte-level `Buffer` scan so multibyte UTF-8 never splits mid-frame), and the `backend.ts`/`sse.ts`/`usage-observer.ts` internal parsers (review finding 13, deferred). |
| `tool-dialects.ts` / `dialect-stream.ts` / `openai-dialect.ts` | Recovering tool calls a HOST failed to parse. Some free hosts return the model's native dialect as assistant TEXT instead of `tool_calls`, which reached the client as markup it treated as a final answer — no `tool_calls` ⇒ `end_turn` ⇒ zero `tool_use` ⇒ the validator passes ⇒ repair never engages. Parsing, not inference: a CLOSED envelope set, and prose naming a tool stays prose. An unparseable envelope yields `detected`, and the caller fails clean so failover reaches a host that parses. Anthropic-shaped translation uses `openAiResponseToAnthropic` / `dialect-stream.ts`; direct Chat uses `openai-dialect.ts`, emits native `tool_calls`, and joins the final-wire commit probe before headers. **A recovered call naming a tool in `repair.destructiveTools` is REFUSED, not committed** — `recoverToolCalls` takes the matcher as a REQUIRED parameter and returns `refused-destructive`; see the gotcha below. See [docs/tool-call-dialect-leak.md](docs/tool-call-dialect-leak.md) and [docs/dialect-rescue-destructive-refusal-2026-08-24.md](docs/dialect-rescue-destructive-refusal-2026-08-24.md). |
| `tool-use-ids.ts` | Making a translated response's `tool_use` ids unique against the conversation that produced it. A host may reuse an id across turns (`nim/moonshotai/kimi-k3` emits `<ToolName>:<index in this response>`, so `Read:0` recurs), and Claude Code's request-time normalizer DROPS a `tool_use` whose id it has already seen — mangling the model's context and eventually emptying the fresh turn to `[Tool use interrupted]`. Protocol FORM, not judgment: `knownToolUseIds()` reads the request's own `tool_use.id` / `tool_result.tool_use_id`, `uniqueToolUseId()` mints the smallest free `<id>_relay<k>` (deterministic, no randomness), and `rewriteToolUseIds()` / `rewriteToolUseIdsInStream()` apply it to a buffered content array or an SSE `content_block_start`. Pure — no store and no reverse map, because the client echoes the minted id back in both the `tool_use` and the `tool_result` and `openai-request.ts` forwards both verbatim. Wired at the openai-kind seam in `backend.ts` ONLY; a native Anthropic response stays byte-exact. |
| `lane-manifest.ts` / `lane-probe.ts` | What a `cli` lane's own tool says it serves (`llm-relay lanes [--probe]`, `~/.llm-relay/lane-manifest.json`). A rung naming a model the roster omits is `not-servable` — **removed** from selection with its command withheld, following `target-facts.ts` where `allowance-exhausted` demotes and `not-servable` removes. ⚠ Eviction needs POSITIVE evidence: no manifest / unprobed / empty roster / corrupt / unknown command ⇒ UNKNOWN, nothing evicted. ⚠ **"Corrupt" is enforced by DEEP validation in the loader, and that is load-bearing** (2026-08-28): the loader used to check only `version` and that `lanes` was an object, so a `models: ["x"]` roster reached `verifyModel`, where `"x".id` is `undefined` — not a throw — `some()` returned false, and the lane was reported `not-servable` and EVICTED. A corrupt manifest evicting a healthy lane is exactly what this row's own invariant forbids, and what the loader's comment ("a corrupt manifest that evicted every rung would turn a hygiene feature into a total outage") was written to prevent. `isLaneEntry`/`isLaneModel` now validate every entry; anything else ⇒ `null` ⇒ unknown. ⚠ A test asserting only "does not throw" would still pass on the old code — assert `status === "unknown"`. ⚠ **Roster staleness bounds eviction** (2026-08-29): a roster older than `LANE_ROSTER_TTL_MS` (7 days) stops evicting — `not-servable` degrades to `unknown`, and a stated-support arg drop ages the same way — while a LISTED model stays `servable` and observed `rejectedArgs` never age (age weakens eviction evidence, never presence, and never an existence fact). Both live rosters were 21 days old when this landed. ⚠ `laneOfRung` sees through WRAPPER commands by scanning args for a lane binary (exact basename, closed set): the live agy rungs became `pwsh … lane-launch.ps1 … agy.exe` on 2026-08-27 and were invisible to `laneOfCommand` — fail-safe (nothing evicted) but blind, and `--probe` could no longer refresh agy at all. Probers get the matched BINARY, not `rung.command` — probing `pwsh models` probes the wrapper. ⚠ Probes are async (`execFile`, `windowsHide: true` — a console CLI spawned from the console-less daemon would otherwise allocate a console and steal focus). ⚠ **Spawn boundary, owner-amended 2026-08-29** ([docs/quota-reprobe-design-2026-08-29.md](docs/quota-reprobe-design-2026-08-29.md)): the REQUEST PATH never runs a lane command; the operator `--probe` and the background lane cadence are the only two spawn sites. |
| `lane-quota-probe.ts` / `lane-cadence.ts` | The quota re-probe (2026-08-29): is a `cli` lane's BALANCE alive, and the relay's own background loop that re-tests recorded deaths. `lane-quota-probe.ts` is the classifier + spawner seam: one minimal real completion through the rung's own command (`{task}` → probe prompt, args ONLY — env values stay verbatim, the placeholder security rule), fail-safe in BOTH directions — only a real answer (exit 0, non-empty) retracts a death; only an explicit rate/quota statement records one (quota patterns tested FIRST — "the word quota wins", the 0.28.0 lesson); timeout/empty/unrecognized ⇒ inconclusive ⇒ NOTHING changes. A vendor-stated "try again in N units" window is honoured against a closed unit vocabulary; anything else gets the outcome default. `lane-cadence.ts` rides `PingLoop.tickOnce` via the `onTick` hook (fire-and-forget behind an in-flight latch — a minutes-long lane command must never delay an HTTP probe tick): CATALOG re-probes per `catalogIntervalMs` (24h default, no quota cost), QUOTA probes ONLY buckets carrying an ACTIVE recorded death per `quotaIntervalMs` (6h default) — an alive lane is re-tested by real use for free, and a bucket FIRST SEEN dead is stamped, not probed (the report itself is fresh evidence). Config: `routing.laneProbe` (bool or object; unknown key = hard load error; **default ON**, the owner's 2026-08-29 decision). ⚠ Under vitest the cadence no-ops unless BOTH seams are injected and the default spawner refuses outright — the `winenv.ts` guard; a suite must never spend real lane quota. ⚠ Disabled rungs are probed too: disabled is a dispatch choice, not a statement about the balance. |
| `dispatch-exhaustion-persistence.ts` | Durable exhaustion state for the ladder (`dispatch-exhaustion.json`, cache-kind) — `breaker-persistence.ts` applied to `dispatch.ts`'s cooldown map, because the report route accepts vendor-stated cooldowns up to 30 days and a restart forgot them (fail-open, so the cost was spend, not availability). Future-only restore, field-by-field row validation (one bad row dropped alone), never overwrites what the live process already learned, debounced through the shared `WriteBehindTimer`. The CLI's cold `dispatch` fallback restores read-only (no listener ⇒ no write-back), narrowing — not closing — its live-state gap. |
| `mcp/protocol.ts` | JSON-RPC 2.0 over stdio — the MCP wire, hand-rolled, ZERO new dependencies. Four methods (`initialize`, `tools/list`, `tools/call`, `ping`) plus notifications, newline-delimited. `splitMessages` is mixed-terminator-correct (the `sse-frames.ts` rule: a CRLF client must not leave a stray `\r` glued to the JSON) and skips blank padding rather than failing a healthy connection. `negotiateProtocolVersion` echoes a revision only from the closed `SUPPORTED_PROTOCOL_VERSIONS` list — echoing an unimplemented one would claim a capability we lack, the closed-vocabulary defect this file records eight times. ⚠ **NOTHING may be written to stdout except protocol messages**; a stray `console.log` corrupts the stream and the host drops the connection with no useful error, which is why `logStderr` exists. ⚠ The known cost, stated so it is not rediscovered: hand-rolling means owning a spec that moves, so only the stable core is implemented. Extensions (Tasks, Apps, sampling) are deliberately absent — [docs/mcp-dispatch-prior-art-2026-08-30.md](docs/mcp-dispatch-prior-art-2026-08-30.md) §3.1 measured that NO client ships Tasks support today, and the official client matrix does not even list it. |
| `mcp/lane-runner.ts` | Running a dispatch lane, and holding the job while it runs — **the whole argument for the MCP server**. `dispatch --next-command` hands back a COMMAND, and executing it correctly is where every measured failure lives: three client idle watchdogs abort a long think at ~300s unless the lane env lifts all three; an async `execFile` leaves stdin an OPEN pipe and `agy` then waits on it to the timeout; an npm `.cmd` shim needs a shell whose fallback must quote EVERY token (`codex` saw one prompt as seven arguments); a console-subsystem child spawned from a console-less parent allocates a console and steals focus without `windowsHide`. All handled once, here. `quoteCmdArg` is IMPORTED from `lane-probe.ts`, never re-implemented. `LaneJobStore` is deliberately IN MEMORY (a stdio child dies with its host, so a durable store would describe processes that no longer exist) and a **cancelled job stays cancelled** when the child's own exit arrives afterwards. `checkCwd` answers the caller-supplied-directory hazard: existence always, plus `routing.mcp.allowedRoots` containment when the operator declares it — offered, never imposed. ⚠ Its trailing-separator trim is a LOOP, not `/\/+$/`: that pattern backtracks super-linearly on an operator-supplied path. ⚠ The default spawner REFUSES to run under vitest (the `winenv.ts` guard) — a suite must never spend real lane quota. |
| `mcp/server.ts` | The `llm-relay mcp` tool surface: ONE verb (`dispatch`) plus job control (`dispatch_status`/`_result`/`_cancel`) and one read (`dispatch_lanes`). Five tools, against `agent-dispatch`'s twenty — the requirement is "one verb, host-adapted", not a tool per activity. Launched by the HOST over stdio, **never by the relay daemon**, so the rule that no HTTP turn may spawn a lane is untouched: this process answers no HTTP at all. `dispatch` blocks for `waitMs` (default 60s, below a typical client tool timeout) then hands back a job handle, so a fast lane costs ONE call and a slow one degrades to polling instead of failing — the behaviour the Tasks extension would give natively. ⚠ Recursion is bounded by `LLM_RELAY_DISPATCH_DEPTH` (default 3) and the refusal happens BEFORE the spawn, so the bound costs no lane run. ⚠ An exit-0 lane with EMPTY output is reported as a FAILURE, never as an empty answer — that is agy's measured discard mode. ⚠ Provenance rides every answer (lane id + spec + exit + elapsed): `dispatch.ts` never pretends a CLI answered, and a result hiding its lane would do exactly that. Every environment dependency is injected (`buildView`, `spawn`, `now`, `cwd`, `version`) — reading `npm_package_version` here reported "0.0.0" to every real host, because a host launches the binary directly and npm never sets that variable. |
| `validator.ts` | Deterministic Ajv2020 tool_use validator. Verdicts: pass / fail / **uncheckable** (declared tool with no `input_schema`, e.g. built-in `bash`). |
| `reshaper.ts` | The repair model client. Contract: reshaper returns ONLY **corrected inputs per tool_use id** (`{"inputs":{"<id>":{...}}}`); proxy reconstructs + re-validates. `HttpReshaper` (anthropic|openai) + `FailoverReshaper` (ranked candidates from `reshaper: { pool }`; advances on transport failure only — a refusal is returned as-is, never retried elsewhere, and **exhausting every candidate throws `ReshaperTransportError`**, it does not return a refusal). |
| `repair.ts` | Repair orchestrator. Destructive-refusal check → reshape ≤ maxAttempts → re-validate each attempt. `destructiveMatcher()` matches the tool name **exactly** (case-insensitively), with `name*` as an opt-in prefix form; `guardReshaped()` re-checks the reshaped message for destructive calls and for structural conservation (same block count/order, same tool_use `id`+`name`) — an added, dropped or re-pointed call is a contract violation, not a repair. `withEnvelopeOf()` re-attaches the BACKEND's `id`/`model`/`stop_sequence`/`usage` to whatever the reshaper returned — same reasoning as the guard: `Reshaper` is an interface, and a repair changes the tool arguments, never whose answer this is. |
| `sse.ts` | `reconstructFromSse()` — rebuild an AssistantMessage from a captured SSE stream (to validate it). |
| `emitSse.ts` | `emitSse()` / `emitSseTail()` — serialize a (repaired) message back to Anthropic SSE. `emitSseTail` re-emits only trailing blocks (streaming repair). Cache usage fields re-emit on `message_start` exactly as reported — never in `message_delta`, never zero-filled when absent. |
| `anthropic.ts` | Minimal Anthropic Messages shapes + `toolSchemaMap()`. Only the fields the proxy inspects. `usage` carries Anthropic's cache fields (`cache_creation_input_tokens`/`cache_read_input_tokens`) alongside input/output, all optional. |
| `documents.ts` | `transcodeDocuments()` — Anthropic `document` blocks → markdown text via **MarkItDown** (optional external Python CLI), applied to openai-kind targets before the request mapper. The walk covers the top level of a turn **and** the content of a `tool_result` (one level is the whole schema — nothing nests a `tool_result`), because a document a tool returned is otherwise never reached and the mapper refuses the turn. Refuses (`DocumentError` → 400) rather than letting an unconvertible document through; the pre-mapper path stringified it and injected raw base64 into the prompt. Its refuse-don't-mangle rule is the precedent `openai-request.ts` follows for every other unrepresentable block. Uses a **temp file, not stdin** — pdfminer needs a seekable stream and every piped PDF dies with "No /Root object". |
| `log.ts` | Metadata-only logger (never headers/bodies). "Metadata only" is enforced **at the sink**: `write()` projects each record through the `LOG_FIELDS` allow-list, and the bounded `attempts` walk through its own nested allow-list, so a caller that hands over a wider object cannot leak it and a new field is logged only when someone adds it deliberately. Rotates to one `.1` predecessor when the next record would exceed `maxBytes` (default 50 MB) — deliberately NOT token counters: the accounting store is the per-request ledger (see `accounting-store.ts`). Log-write failure is swallowed — a full disk is a logging problem, never a request failure. Records the deployment that ANSWERED (`servedProvider`/`servedModel`, required), status-only `{provider,model,status,ms}` attempts, and `upstreamReportedModel` only when the raw response disagrees with the routed model; upstream claims never replace authoritative routed identity. The model the client asked for is deliberately not a field. Three translation COUNTERS ride the allow-list — `toolUseIdRewrites` (response-direction mint), `toolCallIdRewrites` (outbound `strict9` rewrite) and `thoughtSignatureSentinels` (gemini's stamped sentinel, the one with no response header, so this is its ONLY surface) — counts, never ids or signatures. |
| `catalog.ts` | Dynamic `/models` catalog cache (`ModelCatalog`) with stale-while-revalidate strategy (`models-cache.json`). Also harvests **per-(provider, model) limits + pricing** (and published rate limits rpm/rpd/tpm/tpd, spec §4 rung 2 — expected near-empty) via `limitsFromRecord()` — generic field-alias lists (`context_window`/`max_context_length`/…), never a per-provider switch. `limits()` returns null when a provider publishes nothing (NIM), and that null must not be filled with another provider's numbers; `publishedRateLimits()` reads the harvested block cache-only, with deliberately no `reference` rung — another provider's allowance is meaningless here. ⚠ The DISK loader gates `fetchedAt` on `Number.isFinite`, not `typeof … === "number"` (2026-08-28): `Infinity` passes the latter, and `now - Infinity` is `-Infinity`, which is `< ttlMs` — so a corrupt entry read as **permanently fresh** and never refreshed. (`NaN` was already safe: `NaN < ttlMs` is false, so it fell through to the stale branch.) The disk path also applies `MAX_CATALOG_MODELS` and `MAX_MODEL_ID_CHARS`, which only the wire path enforced. ⚠ A fixture for this CANNOT be built with `JSON.stringify` — JSON has no Infinity literal, so `JSON.stringify({fetchedAt: 1e309})` emits `{"fetchedAt":null}` and the test silently stops testing anything. Write raw JSON text. |
| `circuit-breaker.ts` | Dynamic failure and rate-limit (HTTP 429) circuit breaker. ⚠ **`CircuitBreaker.orderByUsability()` has ZERO `src/` callers** — it is a test-only seam, as is the `orderByUsability` re-export in `server.ts`; the LIVE ordering is `targetUsability()` + `orderDeploymentGroupsByUsability()` in `server.ts`, which additionally consult quota demotion and cost-class facts. This row used to call the breaker method "the ordering API", which is how the two could drift with nothing in production to notice. The method still states the banding contract: it DEMOTES without deleting, into four health bands — ready → credential-faulted → cooling → cooling-and-faulted — and preserves within-band order. ⚠ It deliberately does not re-rank by measured stability; `server.ts` records why (that would be a second ranking pass competing with deployment fitness). Measurement is read separately through `getDeploymentMeasurement()`, whose `stabilityScore` is **null when nothing has been measured**, and every `src/` consumer passes that null through rather than substituting the ordering-only `UNMEASURED_STABILITY` band. A `number` return cannot say "unmeasured", so a scalar accessor gave every caller a plausible score and none could tell a guess from an observation. Credential faults (401/403) are a **separate axis** (`recordCredentialFault` / `hasCredentialFault`) that demotes without tripping and expires, because a revoked key is neither a sick backend nor a healthy one. A 429/503's `Retry-After` sets the cooldown in place of the flat guess; a 429 WITHOUT one escalates through a fixed ladder (`RATE_LIMIT_ESCALATION_MS`: 2m → 10m → 1h → 24h per consecutive unexplained 429), and 402 cools 1h. `clearCooldownState()` resets only addressed cooldown/fault fields and the unexplained-429 ladder; backend failure, ping/stability, and quota-observation history remain evidence. |
| `breaker-persistence.ts` | Durable COOLING state for the breaker (`~/.llm-relay/breaker-state.json`, cache-kind). `circuit-breaker.ts` performs NO file IO, so a restart used to discard every cooldown and the whole unexplained-429 escalation ladder — measured here as a 19.9h cooldown learned from 7 consecutive 429s on `nim/moonshotai/kimi-k3` and another from 26 on `gemini/models/gemini-3.6-flash`, i.e. 33 real failed requests whose lesson a restart threw away. Ping health had survived a restart since `probe-cache.json`; this closes the other half. ⚠ **SCOPE is the design:** cooldown + `cooldownSource` + `unexplained429s` + `lastStatus` only. NOT `pings` (`probe-cache.json` is their one home), NOT `quotaObservations` (point-in-time state the §5.1 staleness ladder already handles, and a second writer on data probe-cache also carries), NOT credential faults (5-minute TTL, and carrying one across a restart makes a rotated key look broken). ⚠ **A row is restored ONLY while its cooldown is still in the future** — once it has lapsed, resurrecting `unexplained429s` would send the next single 429 to the top of the ladder, a 24h penalty invented from a counter nobody re-measured. ⚠ Corrupt/absent/wrong-version ⇒ restore NOTHING; every row is validated field by field and one bad row is dropped without taking the file down (the `lane-manifest.ts` regression, where shallow validation let a malformed entry EVICT a healthy lane — a test asserting only "does not throw" would pass on that bug, so assert the restored count). ⚠ `restoreCooldowns` never overwrites a cooldown this process already learned, the `recordQuotaCooldown` rule. The breaker keeps the IO-free half (`exportCooldowns`/`restoreCooldowns`/`onCoolingChanged`); this module owns the file and debounces writes through the shared `WriteBehindTimer`. A success and `cooldowns clear` both notify, so a retraction reaches disk and cannot come back on the next restart. |
| `cooldown-clear.ts` | ONE operator mutation seam for live cooling state. The ordinary path applies provider/model/credential selectors to breaker cooldowns, the unexplained-429 escalation ladder, credential faults, and active cooling facts. Optional exact `kinds:["credential-fault"]` narrows rotation to breaker credential faults plus `credential-invalid` facts and touches nothing else. Both paths retain failure/ping/stability history, measurements, eviction facts, and accounting; fact mutation still requires whole atomic-scope containment, and results contain counts plus non-secret identifiers only. |
| `benchmarks.ts` | Pool ranking. `getStrength()` resolves a target's 0-100 CAPABILITY strength and **reports which** of exactly two bases it used: synced snapshot → neutral 50 (`StrengthBasis`, no third rung). ⚠ Runtime telemetry deliberately does NOT enter it — telemetry measures whether a deployment *answers*, not whether the model can *reason*; `deploymentFitness()` consumes it on the operational axis, after capability eligibility is decided. `rankTargetsWithProvenance()` (and the thin `rankTargetsByBenchmark()` over it) sorts by `fitness.score`, then `strength.score`, then basis confidence, then signal count — stable, so ties keep config order. The old hardcoded `BENCHMARK_DB` was **deleted in 0.6.0** — every pattern it held was already in the snapshot, so it only contributed a stale provenance-free number that outranked synced data. Don't reintroduce one. |
| `tier-data.ts` | Reads the synced capability snapshot (`docs/tier-data.json`). Memoized on mtime (`npm run sync:tiers` lands without a restart). `findTierModel()` matches a spec's last segment — exact against OpenRouter ids, fuzzy only as a last resort, and it says which. Separate module purely to avoid an import cycle: `config.ts` → `benchmarks.ts` → here, so this must never import `config.ts`. |
| `telemetry.ts` | Aggregates structured live JSON telemetry reports across configured providers. |
| `metadata.ts` | `resolveMetadata()` — per-FIELD limit/price resolution with provenance: the serving provider's own published value (`provider`) → another provider's figure for the same id (`reference`, indicative only) → **null**. There is no hardcoded-table rung: the old blanket 128k/4096 guess was deleted in 0.7.0 because a caller cannot tell a guess from a measurement. Also `estimateTokensFromCharacters()` — the ONE chars/4 rounding convention shared by request and output estimates; `estimateRequestTokens()` walks `system`/`messages`/`tools` AND the Responses `instructions`/`input`, counts tools, and skips base64 — both the Anthropic `data` field and OpenAI's inline `data:` URLs (guardrail on both fronts + local `count_tokens`) — and `assessCost()` — the ONE definition of free/paid/unknown (dynamic pool admission + the `freeOnly` guard both resolve through it; `unknown` is its own class and the guard treats it as paid). |
| `kernel/` | Pure contracts + implementation for the **attempt lifecycle** — the typed begin/complete handshake (`AttemptLifecyclePort`, branded `AttemptHandle`, outcome shapes) that `CircuitBreaker` implements and both request paths account through. Depends only on ECMAScript types; `test/kernel-architecture.test.ts` enforces purity and acyclicity. ⚠ A much larger aspirational contract surface (canonical IR, transport/credential/transcoder ports, lease budgets, `tier-snapshot`) lived here unadopted and was **deleted 2026-08-04** — do not rebuild it; see the history note in `contracts.ts` and [docs/suggestion-review-2026-08-04.md](docs/suggestion-review-2026-08-04.md). |
| `routes/admin.ts` | Control-plane endpoints (`/v1/models`, `/registry`, `/ping`, `/health`, `/candidates`, `/offload`, `/dispatch`, `/cooldowns/clear`, `/telemetry`) factored out of `server.ts`. `handleAdminRoutes()` returns true when it handled a request. Mutations pass exact Host/Origin/content-type/control-token admission before parsing or state changes; cooldown clear rejects unknown keys and accepts only the exact optional `kinds:["credential-fault"]` narrowing. |
| `control-authorization.ts` | Per-install capability token for control-plane mutations (`POST /offload`, `POST /dispatch`, `POST /cooldowns/clear`): 256-bit token at `~/.llm-relay/control-token`, timing-safe comparison, atomic single-token convergence for concurrent starters, nothing secret in errors or logs. |
| `request-log.ts` | `baseLog()` (metadata-only log record construction) and `logSafePath()` (query param names + value lengths, never values) — shared by the data plane and admin routes. |
| `self-update.ts` | Version currency: checks npm (cached 6h, 2.5s timeout) before mutating commands; a stale GLOBAL install downloads and replaces itself and re-execs (with a suppression marker against loops); dev/managed installs just get told the upgrade command. |
| `registry.ts` | Assembles composite `/registry` payload combining providers, live models, routing, and leaderboard capability data. Re-exports `loadTierData` from `tier-data.ts`. `joinCapability()` reports `match: exact\|fuzzy` + `matched_name` because a substring join can borrow a different SKU's scores (`glm-5.2` → `glm-5.2-max`). |
| `key-checker.ts` | Pre-flight key validator. Providers are checked **concurrently** (a dozen-plus providers checked serially, one of them a dead local daemon, turns a status command into a multi-minute one). A 200 from `/models` is NOT accepted as proof: several providers serve that endpoint publicly, so it is re-probed anonymously, and only a genuine 401/403 there makes it evidence. Otherwise it escalates to an authenticated completion **on a model this config actually routes to that provider** — a catalogue's first entry is often a premium SKU the key legitimately cannot touch. A 401/403 on that probe is compared against the same request sent anonymously: a *different* status proves the key authenticated (the wall is the model's plan), an *identical* one proves nothing and reports `unverified` rather than accusing a working key. ⚠ `valid` requires POSITIVE evidence (2026-08-27): 2xx, or a 400/404 that proves the request reached the model-aware layer behind auth. Everything else — every 5xx included — is `unverified`. The old condition was `status !== 401 && status !== 403`, which called a 503 "Key verified" while its own comment named only 2xx/400/404. The initial GET probe's 400/404/405 admission was closed the same way. |
| `onboarding.ts` | Interactive CLI setup wizard for free provider keys (`~/.llm-relay/.env`). Honours `leave_me_alone` — and ONLY here: a suppressed provider stays visible in `llm-relay keys`, `/registry`, telemetry and `candidates`, because silencing a nudge is not hiding state. Entries matching no known provider are legal on purpose; the list stores the negative space, so validating it against the configured providers would reject its main use case. |
| `setup-claude.ts` | Configuration generator for Claude Desktop (`claude_desktop_config.json`) and Claude CLI wrappers. |
| `ping/cadence.ts` | Adaptive background monitoring loop (`PingLoop`) with dynamic mode transitions (`speed`, `normal`, `slow`, `forced`). Also hosts the slow per-credential spend-headroom poll (`pollSpendHeadroom`, `SPEND_POLL_INTERVAL_MS`) that feeds `spend-headroom.ts` — egress only where a provider publishes the figure (`fetchProviderQuota` fetches for an OpenRouter base and no-ops for everyone else), gated per credential slot, stamped before the fetch so a failing endpoint is not re-asked every tick, and contained so a poll failure can never break the ping loop. ⚠ **A probe that answers 200 RETRACTS this cell's cooling conditions** (`recordPing` → `clearFacts`, 2026-08-30). The probe is a REAL completion — `ping.ts` posts one user message at `max_tokens: 1` — sent with the exact credential slot the loop selected, so its success is the same first-party proof a served request is: the deployment exists and the credential has allowance RIGHT NOW. Until this landed, `clearFacts` had exactly ONE caller (`server.ts`), so a long-window `allowance-exhausted` fact survived its whole window unless real traffic happened to reach the demoted candidate — which made an operator-asserted multi-day reset unsafe to record, because nothing could disprove it early. That is now the mechanism behind the 7-day mistral reset accepted 2026-08-30. ⚠ Measurements are untouched (`clearFacts` excludes them — a success disproves a condition, never a measurement), a non-200 clears NOTHING, and one credential's probe never speaks for another's; all three are pinned as negative controls in `test/ping.test.ts`. ⚠ Unlike the served path it does NOT also clear the breaker's credential faults: `PingLoop` holds no breaker reference, and those carry their own 5-minute TTL. |
| `spend-headroom.ts` | Provider-stated PAID-SPEND headroom for one credential — asked for, never inferred (owner decision 2026-08-28: "OpenRouter publishes metadata and we can explicitly request the missing information"). `classifySpendHeadroom` is pure over the figures the provider stated (`limit`/`usage` from the key endpoint): `exhausted` at `usage >= limit` (inclusive, the hard-cap convention; a zero limit has no paid headroom), `headroom` below it, `unknown` when no limit is stated — and unknown has NO effect in either direction. `applySpendHeadroom` feeds the FACT store, not the quota ladder, and that is a design decision: spend is not a `QuotaAxis`, and the credits answer states no reset, so under "the relay never invents a cooldown duration" a spend bucket could never demote through `quota-demotion.ts`. Instead it records the SAME fact the accepted OpenRouter weekly-limit interpretation produces — `allowance-exhausted`, scope `credential`, `costClasses: ["paid"]`, kind-default TTL — so every demotion consumer behaves identically whichever evidence arrived first, and the boundary now updates in BOTH directions: bought credits un-demote on the next poll with no operator action and no lucky paid success. ⚠ Stated headroom retracts ONLY paid-only-filtered rows (`clearPaidAllowanceFacts` in `target-facts.ts`): a paid-credit statement cannot disprove a free-tier exhaustion, so unfiltered and free-filtered rows survive — the "out of free credits is NOT paid" rule facing the other way. |
| `ping/metrics.ts` | Latency statistics (average, p95, jitter, uptime, spike rate) and the composite Stability Score (0-100). ⚠ The composite is **latency quality SCALED by availability**, not latency quality plus a 20% uptime term. `MEASURABLE_CODES` is a LATENCY set (`200`/`401`), so 403/404/429/5xx leave p95/jitter/spike entirely — under the old additive form a mostly-failing deployment kept a clean latency profile and paid only a fifth. Measured live: 1 success in 12 scored **81** while 3 of 3 scored **27**, and 27 zero-success deployments scored above 50; recomputed after the change that last figure is **0**. Every pool here is `{include: "free"}`, so this score IS the pool order. ⚠ `401` deliberately STAYS in the latency terms (the response really did time the network path); the multiplier, not a narrower code set, is what stops a revoked key reading as healthy. ⚠ `-1` means **never probed**, not "no measurable sample" — twelve consecutive 402s is evidence of failure, and returning -1 there made consumers read "unmeasured" and the ordering substitute a neutral 50, ranking an exhausted deployment above one that answered every probe. |
| `ping/ping.ts` | Single probe executor for model latency, status codes, and rate-limit header quota extraction. |
| `ping/probe-cache.ts` | Disk-cached background probe results (`probe-cache.json`) with TTL checks. Each entry keeps a **rolling window of samples** (`MAX_SAMPLES`) plus lifetime `totals` that outlive the window — a scalar `ms`/`code` made p95, jitter and spike rate all restatements of the most recent request. `loadPersistedSamples`/`loadTotals`/`persistedModels` are the read side `cadence.ts` rehydrates from. Under vitest the default path is redirected to a temp dir, because the suite was writing `openai_mock` entries into the user's live health data. ⚠ **The loader validates shallowly on purpose (re-learnable cache), so the CONSUMERS guard — read AND write** (2026-08-28). `loadPersistedSamples`/`loadTotals` were returning `?.samples ?? []` / `?.totals ?? null` with no shape check, and `dynamic-pools.ts` feeds samples straight into `getStabilityScore` and `samples.length / 5`, which decide POOL ORDER — so a corrupt cache fabricated the health evidence routing was ranked on. ⚠ The WRITE guard in `recordProbeResult` is the half a read guard cannot cover: spreading a corrupt `samples: "abc"` makes it three character samples and PERSISTS them, after which the read guard sees a genuine array and passes it through. Degrade to empty; never launder corruption into a measurement. |
| `write-behind.ts` | `WriteBehindTimer` — the one debounced write-behind scheduler (short re-armed delay + max-age clock so steady touches can't defer a flush forever), shared by the catalog, probe cache and runtime telemetry instead of three hand-copies. |
| `usage-observer.ts` | Observes provider-reported token usage plus a separate chars/4 estimate over model-authored text, thinking/reasoning, and tool-argument JSON by wrapping the response body in a byte-exact `TransformStream` — never changes, buffers, or rechunks the response data the client sees. Bounded SSE/JSON parsing and bounded per-field text/tool fragment state skip framing/base64; a skipped content-capable frame taints the estimate back to unknown. Tool-argument JSON is counted whole, including keys and punctuation, while request-side `estimateRequestTokens()` walks string values only. Covers anthropic-messages / openai-chat on both fronts plus reshaper calls (no `openai-responses` — Responses traffic is translated before it is proxied); observer failures are isolated so they can never fail the request. |
| `quota-observation.ts` | Typed quota observations extracted from response headers (`{axis, period, limit, remaining, resetsAt, observedAt, basis: "provider-stated"}`), replacing the old bare `quotaPercent`. Deliberately refuses ambiguity: a generic or malformed header name is declined rather than guessed into an axis/period, and only explicitly attributed limit+remaining pairs become observations. `headroomPercent` is a render-time derivation, never stored. |
| `quota-demotion.ts` | The Gap 12 demotion term as PURE resolution (`createQuotaDemotionFn` → `QuotaDemotionFn`): per credential×deployment cell, resolve every (axis, period) bucket with evidence through the §5.1 ladders, and return ONE spent-and-gateable verdict — soonest lift wins — or null. Gateable = `provider-stated` / `derived:provider-stated` / `derived:configured` by default (a stated limit minus measured local usage stays first-party); `derived:learned` only under `routing.quota.enforceLearned`; `derived:published` never; unknown ⇒ null, no effect whatsoever. No cooldown with a resolvable expiry is refused a duration for (no invented reset ⇒ no demotion). The wrapper never throws (a routing hint must not fail a request) and logs nothing. The server's `cooledByQuota` registers the returned `resetsAt` on the breaker so `/candidates` and the dashboard Cooldowns panel see source "quota". ⚠ Its ledger memo caches the RAW `UsedInWindowReading` per period and projects onto an axis AFTER the lookup. It used to cache an already axis-projected value under an axis-free key, and `bucketRank` puts requests before tokens — so any period carrying both buckets resolved the TOKENS axis from the REQUESTS count and failed to demote a spent token allowance (fixed 2026-08-27; `hard-cap.ts` had always keyed `scope:period:axis` correctly). `projectLocalUsed` in `availability.ts` is now the ONE projection all three ledger consumers share. |
| `accounting.ts` | The accounting event vocabulary: typed request/attempt lifecycle packets (`request-started`, `attempt-started`, `attempt-completed`, `request-completed`) with reported vs estimated tokens kept as SEPARATE accumulators that are never summed into one number. `spend` is priced at attempt completion from PUBLISHED per-(provider, model) prices injected through an `AccountingPricePort` (server builds it from `catalog.cachedLimits` + `resolveMetadata`; no fetch): integer micro-USD, per-kind half-up rounding summed as integers, four-cell provenance (`provider_published`/`reference` x `reported`/`estimated`) with `coverage` full/input_only/partial and unpriced cache kinds counted beside the amount — a null price is UNPRICED, never $0. Request spend projects only the winning serve attempt. |
| `accounting-store.ts` | THE per-request ledger — event-sourced into `~/.llm-relay/usage/` (`lifetime.json`, `recent.json`, `YYYY-MM-DD.json` day shards with minute cells), with dedup, coverage/loss markers, bounded samples, optional day retention and a shutdown close. This superseded spec Gap 3's plan of widening `LOG_FIELDS`: do NOT duplicate token counters into the metadata log. Unknown stays `null` + an `unknown` counter, never 0. Spend aggregates into the four contract cells per aggregate (attempt-side `spend`, request-side `requestSpend`, integer micro-USD) plus `unpricedRequests`/`partiallyPricedRequests`; pre-spend shards carrying `spend: null` still load as empty cells. Also `usedInWindow()` — the availability lane's narrow synchronous in-memory read of current-period usage for one credential (minute/day from the in-memory day shard; month DECLINES BOTH requests and tokens because the lifetime rollup is ROOT-aggregate across all credentials, so neither figure can be narrowed to one slot until the rollup is per-credential; never disk, never the request path). An estimated-basis token scalar includes estimated input + output, correcting the pre-M4 input-only undercount; quota demotion and hard caps read that completed scalar. Also: a window whose requests mix reported and estimated token bases reports NO token number (`tokens: null`, basis `mixed`) unless every measured request carried a report — then the reported figure stands alone as basis `reported`. Also `readOnly: true` construction for OUT-OF-PROCESS readers (`llm-relay cost`): no writer lease, no journal recovery, no quarantine renames — all writes against a directory a live relay may be committing to; it observes committed snapshots only. Under vitest the directory redirects to a temp dir. |
| `accounting-store-schema.ts` | The persisted accounting schemas (`accounting.day.v1`, `.lifetime.v1`, `.recent.v1`, …) and their size/cap constants — deliberately separate from the dashboard wire contract, so the on-disk format can evolve without breaking clients. The 2026-08-22 spend fields are ADDITIVE: the guards accept both the legacy `spend: null` shape and the new aggregate spend cells (any subset of the closed optional-key set), so old shards load instead of quarantining. |
| `accounting-store-io.ts` | The durability primitive under the store: writes a full snapshot journal (`snapshot-journal.json`) before replacing any target, so a later process replays after any crash prefix without applying a delta twice. Knows nothing about accounting's schemas; callers supply snapshots + an explicit target allow-list. |
| `dashboard-contract.ts` | The versioned server-safe wire contract for the analytics dashboard (`dashboard.snapshot.v1`, media type, query spellings) — platform-free by rule, so route/auth/retention/pricing decisions stay with their owners. All request/response bounds are explicit constants here. `SpendTotalsV1` carries the four priced cells plus `unpricedRequests` AND `partiallyPricedRequests` (>0 ⇒ every amount is a LOWER BOUND); the producer ships with the validator, so the field is required, not tolerated-absent. Also `dashboard.cost.v1` (`CostReportV1`/`CostRowV1`/`RepairShareV1` + `assertCostReportV1`) — the `llm-relay cost` roll-up's shapes, closed over the same four cells; its repair share is ATTEMPT-scoped and deliberately carries no lower-bound count, because per-attempt price coverage is not persisted. |
| `dashboard-auth.ts` | In-memory bootstrap/session authority for the dashboard: a control-authorized launcher mints a one-time bootstrap, exchanged exactly once for a read-only session (idle TTL 30m inside an absolute 8h cap; replay gets its own distinct failure). Only SHA-256 digests are retained, every candidate hashes to a fixed length before comparing, and a restart revokes everything. |
| `dashboard-routes.ts` | Dependency-injected, platform-neutral dashboard API routes (`bootstrap`/`session`/`logout`/`snapshot`/`requests/:id`). The server owns socket admission, Host checks and body streaming; this module owns only endpoint policy and the wire contract — keeping it free of `IncomingMessage` makes its check order testable and stops a future catch-all becoming an API. ⚠ `DashboardErrorCode` is IMPORTED from `dashboard-contract.ts`, never re-typed — this module used to restate all ten codes as its own local union, two definitions of one closed set drifting invisibly. Pinned by a source grep, the `destructive-coverage` precedent. ⚠ `bodyReadErrorCode` reads a DECLARED `BODY_TOO_LARGE_CODE` off the rejection; it used to regex the error MESSAGE, i.e. the relay inferring 413-vs-500 from prose it wrote itself. |
| `dashboard-snapshot.ts` | The bounded read-only projection from the accounting store to dashboard views. Knows only the persisted read model — quota/cooldown facts are injected as one already-captured snapshot (built per snapshot read by `createAvailabilityProducer` in `availability-snapshot.ts`), so the projection neither owns the store nor reaches into live provider/breaker state. Projects real spend totals from the aggregates (summary, every dimension row, request rows/detail), keeping unpriced cells amount-null — "Unpriced", never "$0" — and surfacing the lower-bound marker when `partiallyPricedRequests` > 0. Also `readCostReport` (the `llm-relay cost` roll-up, exposed on the same read port): the TOTAL folds root minute-cell aggregates (exact under every row cap) while per-value rows walk dimension rows capped; repair spend is folded from role:"repair" attempt rows directly, never by subtraction (failed serve attempts also carry attempt-side spend); the `lifetime` window declines the split because its month rollups mix serve and repair in one figure; absence — every day shard ABSENT or a MISSING `lifetime.json` — is `empty` ("no accounting data yet"), only a thrown read, corrupt shard or corrupt lifetime rollup is `unavailable`. A THROWN reader must never render as either "absent" or a zero-total success. **`coverage: "partial"` means the store held data this projection omits** (dropped/overflowed counters, capped reads, corrupt shards) — a token/latency/commit kind that was simply never REPORTED (`unknown > 0` alone, no `lost`/`overflow`) nulls that one cell with provenance `"unknown"` but leaves the panel `"complete"`; only an unknown count in EXCESS of what the outcome already explains (`hasUnexpectedMetricLoss`) promotes it to loss. |
| `dashboard-static.ts` | Serves the SPA's static shell and manifest-owned assets with a locked-down CSP/security-header set. Owns the filesystem boundary deliberately, so a future catch-all route cannot accidentally serve the SPA. |
| `json-shape.ts` | Shared JSON shape predicates — `isRecord` plus the exact-keys checks — retiring 20 per-module copies and a naming trap where THREE contracts shared two names. ⚠ Its two exact-keys exports are different contracts on purpose: `hasExactKeys` is the strict `unknown` guard (rejects symbol keys, non-enumerable own props, non-plain prototypes), `hasExactKeysWithOptional` is the keystore's historical looser form (own enumerable keys only) — an empty optional list does NOT make it the strict one. Bundled into the browser SPA via `dashboard-contract.ts`, so it must stay import-free and platform-global-free (pinned transitively by `test/dashboard/contract.test.ts`). |
| `winenv.ts` | Recovers Windows User/Machine-scope environment variables a **long-running** process never received (a User-scope var enters a process only at start; the relay launches at logon and runs for days). Fills gaps only — the real environment always wins, same contract as `dotenv.ts`. ⚠ Never imports `PATH`: the User scope holds a fragment, and importing it wholesale breaks executable lookup. ⚠ **Under VITEST it never spawns `reg` unless the `read` seam is injected** — the same guard `secret-file-acl.ts` and `os-keyring.ts` carry, added 2026-08-25 because this was the last unguarded real-world side effect in `src/`. Two `execFileSync` spawns at `timeout: 5000` each sat on the `loadOrExit()` path inside vitest's own 5000ms budget: ~50-70ms idle, 2806-4045ms under full-suite process contention, which is what intermittently timed out two CLI tests. It also merged the developer's real registry environment into worker `process.env`. `test/winenv.test.ts` injects `read`, so the merge/skip/never-import policy keeps full coverage. |
| `ping/quota.ts` | Provider-specific quota balance fetcher (e.g. OpenRouter key auth endpoint). ⚠ Recognition is an EXACT-host test on the provider's own configured base, and the request URL is REBUILT from that same parsed base (path/query/fragment/userinfo cleared), so a declared credential can never egress to a host the operator did not configure. It used to match a SUBSTRING of the provider's name or base and then post the key to a hardcoded `openrouter.ai` — so `openrouter-proxy` pointing elsewhere, and a base like `openrouter.ai.example.test`, both leaked. Exact host, not the mistral suffix form: the auth/key endpoint exists on one host only. An unparseable base fails closed to the generic branch. |
| `ping/runtime-telemetry.ts` | Real-world proxy request telemetry storage (`runtime-telemetry.json`) and real-world quality scoring. |
| `process-safety-net.ts` | Process-level safety net for LATE transport errors: undici resolves `fetch()`, the request path moves on, then a CDN edge or a discarded failover candidate resets the socket, and the listener-less stream error escalates to an uncaughtException that would exit the whole proxy. Swallows ONLY a closed allow-list of transport codes/messages (pure `classifyProcessError`); everything else keeps Node's fail-fast so genuine bugs still crash loudly. Installed at the top of the serve path, idempotent. |
| `think-tags.ts` | Conservative stripping of one message-opening `<think>…</think>` block from translated OpenAI text (native Anthropic thinking blocks never reach it). A bounded rollback buffer makes an unclosed/nested candidate lossless — every uncertain shape is released byte-for-byte as ordinary text rather than deleted; also the SSE variant `stripThinkTagsInStream`. ⚠ `flush()` decides through a total `FLUSH_RELEASES_HELD` table `satisfies Record<FilterState, boolean>`, not a two-member `if` with a bare `return ""` (2026-08-28): a future HOLDING state would have taken that return and silently deleted the bytes it was holding — a truncated answer that looks successful, in the one module whose whole stated purpose is losslessness. `push()` keeps its two-member test deliberately: its fall-through goes to the HOLDING path, which is the safe direction. |
| `delegate-gate/` | The `llm-relay delegate-gate <diff-file> --repo <root> [--fix]` CLI (wired into `cli.ts`) — a HOST-SIDE quality gate over a diff a delegated agent lane returned, run before judgment/merge. `dispatch.ts`/`lane-manifest.ts` decide the lane order; this reads what a lane already produced, same "the relay never spawns/executes a lane" boundary. `diff-parser.ts` parses unified diffs (raw-line-indexed, for the auto-fixer); `post-image.ts` reconstructs each changed file's post-patch content from `--repo`'s pre-image so every AST detector can restrict itself to lines the diff actually ADDED; `minimality.ts`, `test-assertions.ts`, `cast-necessity.ts` and `shared-state.ts` are the four detectors (indentation churn / non-minimal diffs, tautological test assertions via the `typescript` compiler API, unnecessary `as` casts, module-scope mutation from inside a function); `gate.ts` folds them into one `Verdict`; `fix.ts` auto-repairs only the two MECHANICAL classes (a fully-paired whitespace-only hunk is dropped whole; a trivially-redundant literal cast is rewritten in place) into `<diff-file>.fixed.patch`, never touching the target repo. Full checks list, verdict schema and evidence: [docs/delegate-gate.md](docs/delegate-gate.md). ⚠ Pulls `typescript` into `dependencies` (not just `devDependencies`) — the one exception to "two runtime deps" this file otherwise states, because the AST-based detectors need the real compiler API at run time in an installed package, not just at this repo's own build time. |

**Request flow:** `handle()` in `server.ts` → `orderByUsability()` → a candidate loop (BOTH paths —
`openAiFrontPath` for the OpenAI front, the inline loop for `/v1/messages`) → `fetchBackend()` →
then either `repairPath` (repair mode, invalid tool call) or `transparentPath` (detect/passthrough). Repair splits into
`repairStreamingPath` (SSE: stream text through, buffer from first tool_use) and
`repairBufferedPath` (non-streamed JSON). The validate/repair layer **always sees Anthropic
Messages** regardless of backend kind — translation is isolated in `backend.ts`.

## Invariants (keep these true)
- **Provider knowledge is data, not routing configuration.** Provider URLs, models, and
  credentials that decide routing come from config. Labelled provider facts in `src` — such as
  env-var aliases, parameter quirks, refusal wording, and preset defaults — are allowed when
  config can override them.
- **Provenance:** a guess must never be labelled a measurement. Reported figures use
  `provider-stated`, `derived`, `estimated`, or `operator-declared`; a total mixing bases shows its
  split rather than quietly reporting one undifferentiated number. Unknown stays `null`, never `0`.
  Tunable defaults are allowed, but unpublished provider limits, prices, and context ceilings may
  not be invented.
- **Accounting metering, not custody:** per credential and deployment, record used, left, and
  rate. Counting is unconditional and needs no published limit. Acting on counts is optional,
  always announced, and may only reorder. The ledger meters keys the operator already holds and
  never obtains, stores, mints, or centrally proxies credentials.
- **No hosted relay or pooled consumer accounts:** the relay never operates a login, never asks
  anyone to paste a Claude token into it, and never centrally proxies another person's subscription
  traffic. Each operator runs their own instance with their own keys; this still permits several
  keys belonging to that operator.
- **The repair boundary:** the relay fixes protocol form, never judgment. No LLM opinion enters the
  request path; routing comes from config and deterministic classification.
- **Health demotes, never drops.**

- **Never assert a key is bad without evidence that distinguishes it from an entitlement
  wall.** Free-tier rosters list premium models; a 401/403 on one of them says nothing about
  the credential. `unverified` exists precisely so the check can decline to conclude — a false
  "your key is broken" sends the user to rotate a perfectly good key.
- **Loopback only.** Startup refuses a non-loopback bind (it holds a provider key, does no auth).
  But **loopback is not authorization** — see the admission gotcha below.
- **Logs are metadata only** — never request/response headers or bodies. That includes URL
  *values*: `logSafePath()` keeps the route and each parameter's NAME and replaces its value with
  the value's length, so a long `?task=` cannot write user prose into the log.
- **Destructive tool calls are refused, never fabricated** (repair output may run under
  `--dangerously-skip-permissions`). Unrepairable → fail-clean (502, or a mid-stream SSE `error`).
  The refusal set is `DEFAULT_DESTRUCTIVE` in `config.ts` — **the single definition**; the CLI
  template spreads it, and `config.example.json` is asserted equal to it by
  `test/destructive-coverage.test.ts`. Don't hand-copy the names anywhere.
- **Persistent storage directory:** Local configurations, keys, and caches are persisted under
  `~/.llm-relay/`: `config.json`, `.env`, `keystore.json` (the encrypted credential store),
  `models-cache.json`, `probe-cache.json`,
  `runtime-telemetry.json`, `control-token` (control-plane capability), `target-facts.json`,
  `refusal-interpretations.json`, `lane-manifest.json`, `breaker-state.json`,
  `dispatch-exhaustion.json`, `update-check.json`, the `hooks/` script
  (the Agent hook), and the accounting subtree `usage/` (`lifetime.json`, `recent.json`,
  `YYYY-MM-DD.json` day shards, `snapshot-journal.json`).
  ⚠ **`~/.llm-relay/` is the DEFAULT, not the only answer — every artifact honours XDG** since
  2026-08-27, through the one policy in `state-paths.ts` (config-kind → `XDG_CONFIG_HOME`,
  cache-kind → `XDG_CACHE_HOME`). Until then three policies coexisted and the state directory
  SPLIT whenever either variable was set. ⚠ The legacy fallback means an install whose state is
  already at `~/.llm-relay/` keeps using it: honouring XDG never moves anything that exists. See
  the `state-paths.ts` row, and `docs/reference.md` "Where state actually lives" for users.
  Under vitest every default path
  redirects to a temp dir. ⚠ That sentence was FALSE until 2026-08-27 — seven artifacts honoured
  it and six did not (`.env`, `models-cache.json`, `update-check.json`, the config dir holding
  `control-token`, the hook script, and `config.json`, whose resolver CREATES it). `.env` was the
  sharpest: `loadEnvFile` READS it into `process.env`, so a test run imported live credentials.
  Each resolver now guards itself AT THE RESOLVER — a call-site guard is how the control-token one
  came to be half-covered. `test/persistent-paths-vitest.test.ts` pins the NINE that share the
  `llm-relay-vitest` temp root as one table; the other four — `keystore.json`,
  `target-facts.json`, `refusal-interpretations.json` and the `usage/` subtree — guard themselves
  at their own resolvers into their own temp namespaces (per worker, per PID, per run), which is
  deliberate: they hold cross-test state that a shared root would let one test leak into another.
  ⚠ So the table is not the whole set. A new artifact using the shared root is caught; one that
  invents its own namespace is not, and must carry its own guard and say so here. There is
  deliberately no shared "test mode" helper: each guard names the real state it protects. An
  EXPLICIT path always wins.
  ⚠ Not the same guard as `winenv.ts` / `secret-file-acl.ts` / `os-keyring.ts`, which refuse to
  SPAWN under vitest without an injected seam.
- **Hand-built `Config` objects in tests must include** `repair: { maxAttempts,
  destructiveTools }`, and every provider entry needs its `kind`
  (`"anthropic"`/`"openai"` — load defaults an omitted kind to `"anthropic"`, so a hand-built
  openai-kind fixture that omits it tests a different code path than it claims). The old
  `config.backend.{base,kind}` field is gone since the registry refactor (`774ba18`) — there is no
  top-level `backend` on `Config` any more.
- **Commit trailer:** `Co-Authored-By: <the model doing the work> <noreply@anthropic.com>`
  (e.g. `Claude Fable 5`). Name the model that actually authored the change.

## Scripts inventory (`scripts/`)

Per-script purposes and prerequisites: [scripts/CLAUDE.md](scripts/CLAUDE.md) (loads when working
under `scripts/`). The one thing to know from outside that directory: most `scripts/*.mjs` read
`dist/` — **rebuild (`npm run build`) before running any of them** or you'll test stale code.
(`test/scripts-inventory.test.ts` pins that inventory to the directory, on the
`architecture-map.test.ts` precedent.)

## Gotchas (things that will bite you)

- **⚠ Never classify a CLOSED union with an unconditional `else`, a bare `default:`, or a runtime
  list hand-copied from the type — and never let the fall-through resolve to the STRONGER claim.**
  This is the most repeated defect in this codebase's history: **eight** instances found so far,
  in eight different modules, each written by someone who knew the union's members at the time.
  A provenance fallback must always fall to the WEAKER claim; every instance found fell the other
  way, and none could produce a compile error.
  - v0.50.0: `FactKind` — a nested ternary told the operator that six of the ten kinds meant "gone
    from the provider — excluded from pools".
  - 2026-08-28, all seven remaining (`aabac49`, `ab75f65`): `ContextWindowSource` → "published by
    the serving provider"; `AuthHeaderName` → the credential sent as `x-api-key`; `FilterState` →
    held bytes silently DELETED in the module whose stated purpose is losslessness;
    `FactResetBasis` → an unknown basis promoted to the provider-stated rung; `OutcomeProvenance` →
    the PROVIDER's breaker charged for a RELAY-LOCAL fault; `ErrorOrigin` → `"upstream"`, which
    also means RETRIABLE, so the walk rerolls other members for the relay's own fault;
    `AccountingEvent` → an unhandled event recorded as a SUCCESS THAT DID NOTHING, with no loss
    marker.
  - **The fix is always the same:** a total `Record<Union, …>` closed with `satisfies`, or an
    exhaustive `switch` ending in `const _never: never = x`. Put it where a maintainer adding a
    member is already looking. Then MUTATION-CHECK it: add a member, confirm `npm run typecheck`
    fails AT THE TABLE, remove it. If it does not fail, the change did nothing.
  - ⚠ **A runtime list is the same defect wearing different clothes.** `UNTIL_BASES` was a
    `ReadonlySet<string>`, so the compiler could not connect it to `FactResetBasis`; nine
    `dashboard-contract.ts` unions were written out beside nine `as const` arrays repeating the
    same members. Derive the list from the type (or the type from the list) — never both by hand.
  - ⚠ **Distinguish this from a type merely WIDER than its producers.** If every construction site
    is centralized and validating, a maintainer would have to hand-write the bad state; that is
    hardening, and this repo defers it (four such findings deferred 2026-08-28). The class above is
    different precisely because it fails SILENTLY with no compile error anywhere.
  - ⚠ **Making a classifier total surfaces live bugs the analysis missed** — it did twice on
    2026-08-28. Expect `tsc` and the suite to find an optional field or an incomplete fixture the
    old fall-through was quietly absorbing, and fix that rather than restoring the fall-through.
  - Pinned by `test/closed-vocabulary-coverage.test.ts` and
    `test/closed-vocabulary-routing.test.ts`; full ledger in
    [docs/advisory-findings-verification-2026-08-28.md](docs/advisory-findings-verification-2026-08-28.md).

- **Custody rotation is valid only when the keystore is the winning source.** Credential
  precedence is process env > `.env` > keystore: `keys add` warns when the stored row is shadowed,
  while `keys rotate` refuses byte-preservingly because changing unused ciphertext would change
  nothing on the wire. After an unshadowed rotation, the CLI uses the admitted
  `/cooldowns/clear` seam with `kinds:["credential-fault"]` to retract only that credential's
  breaker faults and `credential-invalid` facts. `allowance-exhausted`, rate-limit cooldowns, and
  the escalation ladder survive because a new key disproves authentication failure, not account
  allowance or back-pressure; the CLI must never race the relay by editing `target-facts.json`.

- **An unset `${ENV}` in a provider `base` disables THAT provider, it does not abort startup.**
  The proxy fronts every client session, so a fatal error there turns one unused optional
  provider into a total outage. Pool members belonging to a disabled provider are dropped with
  a warning; a member naming a provider that was never declared is still a hard error, because
  that is a typo and silently dropping it would spend primary quota via the passthrough.
  **The same degradation now applies to `routing.tiers`, `routing.subagents`, an ARRAY
  `routing.default` and relay ladder rungs** — they were validated against the *post-disabling*
  provider map, so a tier pointing at the degraded provider was reported as naming an unknown one
  and aborted startup, reaching the same total outage by another route. Losing every provider,
  emptying a pool entirely, or a single-spec `routing.default` naming the disabled provider is
  still fatal — there is nowhere left to fall through to — and that last error names the unset
  `${ENV}` rather than accusing the operator of a typo. `Config.warnings` carries all of it so
  startup can print it; the subagent warning states the CONSEQUENCE (that traffic now falls through
  to `routing.default`, i.e. primary quota), because a silent fall-through there looks like a
  successful offload.
- **Worktrees.** Work may happen in a git worktree (e.g. under `.claude/worktrees/…`). Edit and run
  tests **in the worktree path**, not the main checkout — they have separate working trees. vitest
  run from the wrong root will silently pick up the other copy's `src/`. (`vitest.config.ts` stops
  the reverse case — this tree's `npm test` reaching into a worktree nested under the repo root.)
- **vitest reads `src/` directly; scripts read `dist/`.** Tests reflect your edits immediately;
  `scripts/*.mjs` do not until you `npm run build`.
- **Using the `claude` CLI through the proxy needs an isolated `CLAUDE_CONFIG_DIR`.** An active
  claude.ai subscription session conflicts with the proxy token → client-side `Invalid API key` /
  `401` with **no request sent**. The wrappers set this; without it, it looks like a proxy bug but
  isn't. (Also keeps the subscription out of the path — the safe direction.)
- **`count_tokens` and non-`/v1/messages` paths** are handled locally for OpenAI backends (token
  estimate / clean 404) — they must NOT be routed to `/chat/completions`. See `server.ts` `handle()`.
- Backends rate-limit (HTTP 429). The proxy passes it through; the client's retry/backoff handles it.
- **Subagent detection uses THREE signals, any one sufficient — keep it that way.** `routing.subagents`
  applies when the request carries `cc_is_subagent=true` in its `system` block (verified against
  Claude Code 2.1.220), the documented `x-claude-code-agent-id` header (gateway protocol
  reference: present only on requests from an agent Claude Code spawned in the session, and
  gateways may route on it), or Codex's `x-codex-turn-metadata` with `request_kind: "subagent"`. Each covers the others' silent failure: a filtered header dies to the body marker, an attribution-block stripped by
  `CLAUDE_CODE_ATTRIBUTION_HEADER=0` dies to the Claude header, and Codex has no Anthropic `system`
  block at all so its marker cannot carry it. They travel in different carriers, so no single component drops all three. If all ever go, every
  subagent falls back to normal routing — safe (passthrough) but **silent**, so nothing will alert
  you. Re-verify with the capture recipe in
  [docs/subagent-routing.md](docs/subagent-routing.md#re-verifying), which reports each signal
  separately.
- **Pool refs (`pool/<name>`) are legal in `routing.tiers`, `routing.default` and
  `routing.subagents`,** expanded by `expandPoolSpecs()` at resolve time and validated at config
  load (pool-aware `assertSpecResolvable`). Pool members themselves must be provider specs —
  pool-in-pool is rejected at load.
- **Reshaper transport failures THROW (`ReshaperTransportError`), refusals return.** That
  distinction is what makes `FailoverReshaper` real: it advances only on throws. Converting a
  timeout/5xx into a `refuse` result (the pre-0.8 behaviour) silently disabled reshaper failover.
  `repair()` catches the throw and fails clean (`outcome: "failed"`).
  **Exhausting every candidate throws too** — nobody answered, so there is no judgement to report.
  Returning `refuse` there labelled a total outage as a model's decision and logged the turn as
  `refused` (a model declined) rather than `failed` (nothing was reachable). The two outcomes must
  stay distinguishable in the log, because they call for opposite responses.
- **The destructive-tool match is EXACT (case-insensitive), not substring** — a trailing `*` in a
  configured pattern is the opt-in prefix form (`git_*`). Substring matching was wrong in both
  directions at once: none of the old fragment patterns (`rm`, `delete`, `remove`, …) occur in the
  harness's real destructive tools, so the "never fabricate a destructive call" guard covered none
  of the tools that can destroy anything; meanwhile `push` matched `PushNotification` and `reset`
  matched `ResetZoom`, refusing safe calls. `DEFAULT_DESTRUCTIVE` therefore now leads with the
  first-party mutation tools — Claude Code's `Bash`, `BashOutput`, `Write`, `Edit`, `MultiEdit`,
  `NotebookEdit`, and Codex's `shell_command`, `apply_patch` — before the conventional names.
  ⚠ **User-visible behaviour change:** repairs of malformed `Bash`/`Write`/`Edit`/`MultiEdit`/
  `NotebookEdit`/`BashOutput`/`shell_command`/`apply_patch` calls that used to succeed are now
  refused (`repair: "refused_destructive"`), and calls whose names merely *contain* a pattern
  (`PushNotification`, `ResetZoom`, `ForceRefresh`) are now permitted. An **empty**
  `repair.destructiveTools` refuses nothing — there is no hidden built-in set in `src/`, so
  coverage is always traceable to config.
- **The destructive refusal binds at the DIALECT-RESCUE commit point too, and it is TERMINAL
  there (2026-08-24).** Until then `destructive` appeared in exactly five `src/` files — `cli.ts`,
  `config.ts`, `log.ts`, `repair.ts`, `server.ts` — and in NONE of `tool-dialects.ts`,
  `openai-dialect.ts`, `dialect-stream.ts`, so the guard bound only inside `repair()`. A
  **well-formed** destructive call the relay reconstructed out of assistant prose validated cleanly
  and reached the client unfiltered; the real guarantee was only fail-clean refusal of a
  **malformed** one. A backend emitting native `tool_calls` has stated its own protocol intent and
  is untouched — rescue is different because it is the relay deciding that model TEXT is a tool
  call, which for `Bash`/`Write`/`Edit` under `--dangerously-skip-permissions` is the fabrication
  the invariant forbids.
  ⚠ The policy lives in ONE place: `recoverToolCalls` takes `isDestructive` as a **required**
  parameter and returns `{ status: "refused-destructive", dialect, refused }`. Required, not
  optional — there are **four** rescue commit points (buffered/streamed × Anthropic-translated/
  direct-Chat) and an optional parameter would let a fifth silently omit the policy, which is the
  failure mode being fixed. The matcher threads from `createProxy`'s one `destructiveMatcher(...)`
  through `fetchBackend`/`fetchOpenAiFront` args, both required, so the compiler enumerates callers.
  ⚠ **Refused WHOLE, never partially** — committing the surviving calls and dropping the destructive
  one silently changes the model's intent, the reasoning `guardReshaped`'s structural conservation
  rests on.
  ⚠ **Terminal: it never fails over and never charges the deployment.** An unparseable envelope
  fails over on purpose (`origin: "upstream"`, retriable) to reach a host that parses; a refusal is
  a CONFIG decision, so it carries `origin: "local"` — `localFailure` true, `tryNext` false, walk
  outcome `{ kind: "local" }`. Same line the hard cap draws ("a cap never registers on the breaker
  — it is config, not health") and same shape as `refused_destructive`, which "remains a fail-clean
  502 and never rerolls another candidate". ⚠ On a **streamed pre-commit** refusal that terminality
  depends on `stream-commit.ts` `relayAuthored()` reading the relay-owned error code as `local`; an
  in-band error is retriable by default, so without it one lane would reroll and the other would
  not. Both are pinned in `test/dialect-destructive-refusal.test.ts` (every proxy test there walks
  ≥2 candidates and asserts the second backend's `calls()` is 0 — with one candidate "refused and
  stopped" and "refused and had nowhere to go" are the same observation).
  ⚠ **Announced**, like every other automatic fix on this path: buffered refusals carry
  `x-llm-relay-tool-dialect: refused-destructive` plus an error body typed
  `tool_dialect_refused_destructive`; a streamed refusal past the head sends the same code as a
  mid-stream SSE `error`. The refused NAMES travel (they are the operator's own configured list);
  the recovered ARGUMENTS never do. There is deliberately **no log field** — the header and body
  carry it on all four seams, and the metadata log records the 502 like any other.
  ⚠ **User-visible change:** a free host that leaks a `Bash`/`Write`/`Edit` call as dialect text now
  yields a clean 502 (or a mid-stream error) instead of a recovered tool call, and the request is
  not retried against another pool member. An **empty** `repair.destructiveTools` still refuses
  nothing. Design: [docs/dialect-rescue-destructive-refusal-2026-08-24.md](docs/dialect-rescue-destructive-refusal-2026-08-24.md).
  ⚠ `test/openai-dialect-passthrough.test.ts` carried a test named *"validates a recovered
  destructive call without refusing or reshaping it"* asserting HTTP 200 — another case of a test
  written to pin the defect it should have caught. It was flipped in the same commit as the fix.
- **Loopback is not authorization; the mutating endpoints have admission checks.** Any page the
  user visits can POST cross-origin to the listener, and a `text/plain` POST is a CORS *simple
  request* — no preflight. The attacker cannot read the response, but `/offload` rewrites
  `config.json`, `/dispatch` steers the host's lane order, and `/cooldowns/clear` retracts live
  routing state, so reads are not the risk. All three therefore reject a present-but-non-loopback
  `Origin` (403), require
  `content-type: application/json` on a mutating request (which is what forces a preflight a
  hostile page cannot satisfy), and require a loopback `Host` (closing DNS rebinding). An **absent**
  `Origin` is allowed on purpose — that is what a CLI sends, and both the no-restart `llm-relay
  offload` toggle and live-only `llm-relay cooldowns clear` depend on it. There is a test for it;
  don't "tighten" it into a broken CLI.
- **Credential containment is DECLARED, not inferred from key presence.** `credentialState()` reads
  the config declaration first: `not-declared` (a real passthrough — forward the caller's own
  credential) / `declared-present` / `declared-missing`. The old `stripAuth = !!apiKey` was
  identically falsy for the first and last, so a provider declaring an `authEnv` whose variable was
  unset forwarded the caller's own Anthropic token verbatim to a third-party base URL. A
  `declared-missing` target now throws `CredentialConfigError` rather than egressing anything.
  **The other half of the same principle landed 2026-08-05:** passthrough itself is declarable —
  `credentialMode: "passthrough" | "contained"` on the provider. Absence of `authEnv` alone used to
  mean "forward the user's credential to this host", so the most consequential default in the file
  was the one nobody opted into, and it was bounded only by the fact that the sole such provider
  points at Anthropic. Omission still forwards (config load warns instead of failing — this proxy
  fronts every session, so refusing to start would be an outage), `"contained"` strips for a keyless
  backend that is not the caller's vendor, and `"passthrough"` + `authEnv` is a hard error. Scoped
  to `anthropic`-kind: an `openai`-kind target's headers are built from scratch in
  `buildTargetHeaders()` and can never carry an inbound credential, so warning about a keyless
  `ollama` would be a false alarm that teaches the operator to ignore the true one.
  Do not re-derive this from `resolveAuthEnv()` returning a name: the anthropic alias list holds
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, so a provider with **no** declared `authEnv` still
  resolves to a name whenever either is set — which would invert the one behaviour a passthrough
  exists to provide.
- **The breaker records failure on EVERY retriable error response (429/5xx/400/402/404),** including
  on the last candidate — `test/server.test.ts` "circuit breaker accounting" pins that a
  single-candidate 429 is never recorded as a success. **402 is quota exhaustion, not a client
  error** — on the free/router providers this proxy fronts it means depleted monthly credits, so it
  fails over like a 429 but cools the member down for 1 hour (monthly credits don't reset in the
  2-minute 429 window); any success clears it (`test/pool-failover.test.ts`).
- **BOTH request paths must classify outcomes through `classifyStatus()` + `recordAttempt()`.**
  The OpenAI front (`/v1/chat/completions`) had neither failover nor breaker accounting: it was
  handed `healthyTargets[0]` and returned before the Anthropic path's loop, and it reported to
  runtime telemetry only. A 14-member pool served every request from the same rate-limited member
  and returned its 429 to the client — measured, 6 consecutive 429s with `lastStatus: null` on the
  breaker throughout. Two paths, two policies, one of them empty. Keep the policy in one place.
  Full write-up: [docs/pool-failover.md](docs/pool-failover.md).
- **⚠ A failover test with ONE candidate proves nothing.** With a single candidate, "fails over
  correctly" and "cannot fail over at all" are the same observation — which is how the above
  shipped past a suite that covered the front path. `test/pool-failover.test.ts` uses ≥2 throughout.
- **A credential fault (401/403) is neither health data nor a success.** It lives on its own axis
  (`credentialFailures` / `credentialFaultUntil`), fails over when another candidate exists, and
  DEMOTES rather than trips the breaker — so the operator still sees the 401 in `/candidates`
  (`AUTH 401` in the table) instead of it hiding behind a "target unhealthy" skip. It expires
  (5 min) and clears on any success, so a rotated key recovers with no restart. Don't fold it back
  into `recordOutcome`: recording a failure opens the breaker on a *config* problem, recording a
  success launders a permanently broken member into a healthy one, and both were tried.
- **Health DEMOTES candidates; it never drops them.** `orderByUsability()` returns every candidate,
  ordered live → credential-faulted → cooling. Within the cooling band, candidates are ordered by
  soonest known lift time (ascending; `cooldownUntil` from the breaker or target-facts); unknown
  lifts sort last. The old `filter(isHealthy)` deleted cooling candidates whenever any healthy one
  remained, so a pool could narrow to one member and then have nothing left when that member failed
  too. Only an unset credential removes a candidate, and that happens in `resolveTargets` for a
  different reason.
- **Quota is a demotion term, never a drop (Gap 12, spec §5.4).** A spent quota (`remaining <= 0`,
  basis `provider-stated`, `derived:provider-stated` (a STALE observation's stated limit minus
  locally measured usage — first-party enough to gate, same rule as `availability.ts`
  `routingEligible`) or `derived:configured`) demotes a candidate to the same cooling band,
  with breaker source `"quota"`, expiring at the resetsAt the evidence stated. **Learned limits
  never gate unless opted in** via `routing.quota.enforceLearned` (`derived:published` NEVER gates)
  — a regex over vendor prose must
  not throttle a healthy deployment on a number nobody stated. **Unknown has no effect whatsoever**
  (same rule as the context guardrail). **The relay never invents a cooldown duration**: if neither
  a stated reset nor a derivable period boundary exists, there is NO demotion at all — the walk
  learns the truth from the provider's own 429 instead. Demotion reorders only: failure counters
  are untouched, any success clears it through the ordinary cooldown path, and a pool whose every
  member is quota-spent still serves from the cooling band. When a walk's ranked first choice was
  displaced this way and someone else led instead, both fronts announce it in
  `x-llm-relay-quota-demoted: "<spec> (requests/minute remaining 0, provider-stated)"`.
- **A hard cap is the only thing that may refuse on an OPERATOR-DECLARED number; everything
  derived still only demotes (G2).** The provenance line is the whole design: a cap lives under
  the operator's own hand in config, so refusing on it enforces their instruction, while a
  provider header, a learned parse or a published figure may never black-hole a candidate. So:
  caps read usage ONLY from the relay's in-memory ledger (`usedInWindow`) — unknown ⇒ no refusal,
  ever — and month/hour spellings are rejected at CONFIG LOAD, because the window read declines
  month and a cap that could never fire would bound nothing while looking like it did. The cap is
  inclusive (`used >= cap`; 450 admits 450). ⚠ **A cap's SCOPE is part of the cap and comes from
  where it was DECLARED, not from what the caller happens to pass:** a flat `limits.hard` cap
  (provider or slot) is compared against that credential's usage across every model; a
  `limits.models.<id>.hard` cap against that deployment's usage alone. Reading the second at the
  first's scope refuses `m/x` for requests spent entirely on `m/y` — a false refusal on an
  operator-declared number — and it is exactly how enforcement and `/candidates` came to disagree
  while sharing an evaluator: the *evaluator* was shared, the *ledger read* was not. `hardSource`
  decides it inside `evaluateHardCap`, and the callback signature carries the scope so no caller
  can choose. In the walk (`nextUncappedAttempt`, BOTH fronts,
  before egress AND before `recordStarted()`), a capped attempt is skipped with no provider byte,
  no LRU touch, no breaker mutation and no accounting attempt — but it is not dropped: it counts
  as `Nxcapped` in pool-attempts and stays listed. Only an ALL-CAPPED walk refuses the request
  (429, `x-llm-relay-capped`, native error body, Retry-After from the soonest UTC period
  boundary — omitted, never invented, when no boundary resolves); any real provider outcome in
  the walk means the last upstream error is the more honest body. ⚠ A cap never registers on the
  breaker or reorders anything by itself — it is config, not health. ⚠ Refusing must not consume
  the cap: a synthesized 429 produces an unattributable request row (`credentialId: null`), which
  is exactly why the ledger skips it — otherwise every refusal would spend one request of its own
  allowance and the cap would be a countdown.
- **`Retry-After` sets the cooldown; the proxy never sleeps on it.** `parseRetryAfterMs()` handles
  both RFC 9110 forms and returns null (never 0) for garbage. For a pool the right answer to "retry
  in 20s" is "use another candidate now" — blocking the request path would trade one symptom for
  another. `fetchBackend()` must keep carrying the header onto the error Response it synthesizes;
  it builds a NEW Response, so the header was being destroyed there.
- **A conforming error body is passed through BYTE-EXACT.** `normalizeOpenAiErrorBody()` exists only
  for shapes that break an OpenAI client — gemini's array envelope `[{"error":{…}}]` (no `choices`,
  so `response.choices[0]` is `undefined` and a plain 429 reads as "the model returned garbage"),
  and non-JSON bodies. It is not there to reword providers.
- **A pool routes to fewer members than it lists.** `resolveTargets` drops targets whose declared
  `authEnv` is unset, so a 14-member pool can resolve to 7 — and `benchmarkSort` then ranks that
  smaller list, which is why a pool's *tenth* config entry can legitimately be the one that answers.
  ⚠ This also excludes free providers that would serve WITHOUT a key but declare an unset `authEnv`.
- **Offload is off by default.** An absent `routing.offload` and legacy `false` are off; the object
  form is independently keyed by client and each rule defaults to subagents-only. Never infer
  enabled state from the presence of a `subagents` map. Tests pin legacy and client-specific state
  (`test/config.test.ts`, `test/offload.test.ts`).
- **Sticky sessions are off by default and never outrank a guardrail.** `routing.sticky` accepts a
  boolean or bounded `{enabled, ttlMs, maxSessions}` object. A pin is created only after a
  multi-candidate route succeeds, lives only in memory, and may promote only a live member without
  crossing a pool's degrade boundary. The only base keys are the relay-defined
  `x-llm-relay-session` and a 16-hex first-user-message hash; `x-claude-code-agent-id` compounds
  either but is not a base session id. Do not add plausible-looking client headers without repo
  evidence that a supported client actually sends a session identifier.
- **An offload rule is only ever consulted under a `clientForPath()` name** (`claude`, `codex`,
  `openai`, `default` — `FRONT_DOOR_CLIENTS`). A rule keyed anything else ("claude-desktop" was the
  real case) is dead config: the toggle succeeds, status shows it ON, and every request falls
  through to the `default` rule. Creating one is therefore refused — CLI exit 1 and `POST /offload`
  400, both via `unroutableOffloadClient()` — and the CLI must pre-check because `tryServer` treats
  a server 400 as "no proxy" and falls back to writing the file. An already-configured dead key
  stays visible and togglable (turning it OFF must work); status flags it ⚠ and a targeted
  `OffloadState` carries `warning`. `test/offload.test.ts` pins the valid-name set to
  `clientForPath` so they cannot drift apart.
- **`freeOnly` binds RESOLVED candidates, refuses loudly, and outranks `@relay:`.** A rule with
  `freeOnly: true` filters what `subagentSpec`-rerouted traffic may reach down to deployments
  `assessCost()` calls `free` — enforced after pool expansion, because a pool lists free and paid
  members side by side. `unknown` cost counts as paid (a guess must not spend money), the
  Anthropic passthrough is never free, and nothing free resolving is a clean 503 with zero
  egress — never a fall-through to `routing.default`, which is exactly the spend being guarded.
  It applies to a per-call `@relay:` directive too, even with the rule disabled: the flag is the
  owner's standing "this lane never spends money", and a subagent prompt must not outrank it.
  A toggle (`setOffload`) must not strip rule fields it was not asked about — that was a real bug.
  ⚠ **It also covers a DIRECTLY ADDRESSED `pool/<name>`, not just offload-rerouted traffic** (fixed
  2026-08-08). Gating it on `subSpec !== null` meant it never ran for the case it most needed to:
  a dispatch `cliLane` runs `claude -p --model pool/<name>`, whose requests are a MAIN conversation
  — no subagent marker, no directive — so the free-lane traffic the flag bounds walked straight
  past it. A `pool/` spec is by construction relay-routed free-lane traffic and never the vendor
  passthrough, and the guard can only refuse to spend. ⚠ It now also honours what a deployment
  STATED about itself (`isCostBlocked`), which outranks a price table calling it free — but an
  exhausted free allowance is deliberately NOT such a fact; see the eligibility gotchas below.
- **All-429 exhaustion serves the pool's EARLIEST `Retry-After`, and only then.** The body stays
  the last candidate's real error (a true upstream error beats a synthesized one — same maxim as
  the context guardrail), but when every walked candidate 429'd, the served `Retry-After` is the
  minimum across them: the earliest reset is when the POOL next has capacity. A mixed walk (any
  non-429 among the failures) never overrides. Both fronts, one policy
  (`test/pool-failover.test.ts`).
- **Pool depth is not quota independence, and membership is an ASSUMPTION until a deployment
  corrects it.** `assessCost()` admits any unpriced model from a `tierType: "free"` provider on the
  `provider-tier` basis — correct as a default, but it is a claim about a *roster*, and a roster
  holds subscription-gated SKUs and models de-listed behind the scenes. Measured 2026-08-08:
  `pool/xhigh`'s 15 members were 6 huggingface + 4 ollama-cloud + 3 nim + 2 gemini, i.e. **four
  independent quota domains**, so failover spent 13 round-trips to discover 4 facts and the pool
  went from serviceable to zero survivors in one step. `target-facts.ts` now records what
  the deployments themselves stated and feeds it into pool admission and ordering. Full diagnosis
  and probe evidence: [docs/pool-eligibility.md](docs/pool-eligibility.md).
- **An exhausted effort band degrades to weaker MEASURED members — automatically, and never
  silently.** Each effort pool is banded members first, then a degrade tail of everything clearing a
  LOWER band, strongest band first. The tail is reached only after every in-band member has actually
  failed, so a healthy pool is unaffected. When the answer comes from the tail the response carries
  `x-llm-relay-degraded: "<spec> (below <band>)"` — automatic degradation is only acceptable because
  it is announced; an unflagged capability downgrade is indistinguishable from getting what you
  asked for. ⚠ **A model clearing NO band is admitted nowhere, tail included** — unassessed is not
  weak, and sweeping it in would quietly reverse the evidence-aware admission rule. Consequence to
  expect: every effort pool now has near-identical MEMBERSHIP and differs only in order, so
  `{contextWindow}` converges across pools — correct, since the minimum is taken precisely because
  failover can land anywhere, which is now more true than before.
- **Pool order interleaves PROVIDERS within a rank band,** so the first N attempts cover N quota
  domains instead of N members of one. Ranking by fitness alone clustered them: `pool/xhigh` opened
  huggingface, gemini, huggingface, huggingface — three of four behind one credit balance. ⚠ Not the
  "two ranking passes" mistake `orderByUsability` warns about: that is a REQUEST-time re-sort on
  live health competing with deployment fitness; this runs once at materialization, is
  deterministic, never reorders within a provider, and leaves the top-ranked candidate first. It
  only decides who is tried second.
- **A fact's SCOPE is part of the fact, and it comes from evidence — never from counting.** Scope
  and storage keying kept drifting apart independently in every store that learned something: a
  HuggingFace credit balance is stated per ACCOUNT but was rediscovered per model; a revoked key is
  a fact about the CREDENTIAL but `credentialFaultUntil` is keyed per deployment, so every model
  discovers the same 401 on its own clock. `target-facts.ts` makes scope explicit
  (deployment → group → provider → model, resolved most-specific-first) so a new fact kind cannot
  invent its own keying again. ⚠ **Never promote by inference.** "Three models on this provider
  returned 401" is equally three gated models under a working key — the false accusation
  `key-checker.ts` exists to avoid. A provider-scoped fact requires wording that STATES an
  account-level condition; a bare 401/403 produces no fact at all and stays on the breaker's
  credential axis. ⚠ **A group carries its own member list** — no registry, no prefix inference
  (that is the heuristic `authEnv.ts` refuses), and the reviewer sees exactly which models a group
  verdict will cover before accepting it.
  ⚠ **A scope must match the SURFACE the evidence covers, not the noun the message names** (owner
  correction, 2026-08-28). OpenRouter's `403 Key limit exceeded (weekly limit)` names the KEY, which
  reads as a credential-scoped `allowance-exhausted`. It is not: that limit is a **SPEND** limit, so
  its surface is the PAID subset. Measured on one credential inside one minute —
  `cohere/north-mini-code:free` **200**, `dots-studio/dots-3-note-preview:free` **200**,
  `deepseek/deepseek-v4-flash-0731` **403**. A credential-scoped fact would have demoted all 398
  OpenRouter deployments, 18 of them free and answering. This is the mirror of the
  "out of free credits is NOT paid" rule below: collapsing a paid-tier exhaustion onto the free tier
  is the same defect facing the other way.
  ⚠ **No SCOPE can express a dynamic cost subset** — attempt → group → deployment → credential →
  provider → model carry no cost dimension, and a `group` member list goes stale because a provider
  moves models between free, discounted and paid on its own schedule.
  ⚠ **So a fact carries a COST FILTER instead, and it references the CLASSIFIER, not a list**
  (2026-08-28). `StoredFact.costClasses` narrows a fact to `free` / `paid` / `unknown`, and
  `factsFor(..., { costClass })` intersects it with what the CALLER resolved through `assessCost()`
  — which reads catalog prices that refresh on a 10-minute TTL, so a model moving free → discounted
  moves with it and no fact needs editing. Set it with
  `llm-relay eligibility accept <n> --class … --scope … --cost-class paid`.
  - **ABSENT means every class.** Every pre-existing row and every unwired caller behaves exactly as
    before; only the three consumers that DEMOTE pass a class (`dynamic-pools` admission, the
    `freeOnly` guard, and `cooledByAllowance` via the `costClassOf` resolver threaded like
    `quotaDemotion`).
  - ⚠ **A filtered fact matches NOTHING when the caller supplies no class.** A filter is a claim
    about a subset; a caller that cannot say which subset it is in has not shown the fact applies.
    Declining costs one walked request the breaker learns from — demoting a healthy free deployment
    on an unproven classification does not recover as cheaply.
  - ⚠ An EMPTY filter is dropped at load (it would bound nothing while looking like it does — the
    `configured-limits` precedent), and a filter containing an unrecognised class is dropped WHOLE,
    never per-entry: a partially-understood filter would cover a different subset than the reviewer
    accepted. Neither ever fails the load.
  - ⚠ `target-facts.ts` takes a type-and-const import from `metadata.ts` (which has no imports, so
    no cycle) and **must never call `assessCost` itself** — the class is passed in, exactly as
    `availability.ts` is handed the facts it reasons over.
  - ⚠ Every narrowing flag must appear in `eligibilityAcceptCommand` AND in `VALUE_FLAGS`. The
    propose output is copy-pasted, so a flag it omits is silently WIDENED at accept time; and a
    value-taking flag missing from `VALUE_FLAGS` puts its value in command position, which the
    arity guard then rejects. Both were caught during development, by review and by the guard.
    ⚠ And it means EVERY call site: the STATUS listing's "accept with:" line dropped `costClasses`
    from the flag's introduction (v0.52.0, `7412435`) until 2026-08-28, so a later `llm-relay
    eligibility` printed a command wider than the proposal it echoed. Two different halves, two
    different releases: v0.55.2 fixed `acceptInterpretation`'s store persistence and never touched
    `cli.ts`; the listing display half closed with the digest work. Pinned by the listing test in
    `test/cli.test.ts`. (The `3d2fcee` commit message misattributes the miss to v0.55.2 — the
    independent closeout auditor corrected the history; this paragraph is the corrected record.)
  - ⚠ **Accept is digest-keyed (2026-08-28).** The queue is addressed by list position for typing
    convenience, but positions SHIFT between invocations (the sort is count-then-recency), and an
    index-only accept landed a verdict on the wrong refusal twice. Every printed
    propose/accept command now carries `--sig <digest>` (`signatureDigest` — ten hex chars of
    SHA-256 over the signature), the listing prints each item's digest, and when `--sig` is
    present it is AUTHORITATIVE: the entry is resolved by digest, a stale index is corrected with
    a stderr note, an unknown digest exits 1 touching nothing. The bare index stays valid for
    hand-typed use against a fresh listing.
- **The breaker and the fact store COMPOSE; neither replaces the other.** Per-deployment behaviour
  (back-pressure, timeouts, an entitlement wall on one model) stays on the breaker. Only what a
  backend *states* about a wider scope becomes a fact: `rate-limited` fires on a 429 naming the
  account/organization/key and an ordinary 429 produces nothing, because matching plain throttling
  would demote whole providers on routine back-pressure. ⚠ **A proven credential clears its own
  symptoms**: `clearFacts` returns the provider-scoped kinds it disproved, and a disproved
  `credential-invalid` drops that provider's per-deployment credential faults together — otherwise
  a key rotation recovers one model per expiry. Only on a disproved *stated* fact, never on any
  success: clearing bare 403s whenever a sibling succeeds re-tries gated models forever.
- **⚠ "Out of free credits" is NOT "paid", and collapsing the two is the defect to avoid here.**
  A free-tier account that has spent this period's allowance is the normal state of a working free
  lane. `allowance-exhausted` therefore demotes (a cooldown that expires on its own, cleared by any
  success) and is structurally unable to reach the cost path: `isCostBlocked()` excludes it, only
  `cooldownUntil()` reports it. If it could evict, the eviction would outlive the exhaustion that
  caused it. Only `subscription-required` and `not-servable` remove a deployment from a pool.
- **A status code does not carry its meaning — 403 alone is at least four different facts** (revoked
  key, plan gating, license/region gating, policy refusal), distinguished only by vendor-invented
  wording. So interpretation is a **lookup, never an inference**, on the request path: signature →
  confirmed table, and a **miss learns nothing** (same fail-safe as `context-limits.ts`) while
  queuing the message for offline research. ⚠ **Do not move that research inline.** The repair
  boundary at the top of this file governs it: an LLM may author the interpretation data, the
  request path only ever reads it, and a researched verdict binds only after `llm-relay eligibility
  accept`. Signatures are keyed per (provider, model, message) so a verdict cannot leak to a
  sibling SKU. ⚠ **An interpretation carries the whole RULE, not a label**: class, scope, and a
  `reset` saying when the condition clears (`field` = a JSON key in the message, preferred because
  it is re-read from every real response; `fixed` = a reviewer-asserted window, ranked below
  anything the response states). Without it, learning what a message MEANS still left the relay
  re-probing on a TTL it invented. ⚠ **`SEED_INTERPRETATIONS` is a bootstrap, not the mechanism** —
  adding a seed per unfamiliar message means the author learned and the relay did not. ⚠ **A quota
  is not a rate limit**: `rate-limited` is throughput and cools 2 minutes; a 5-hourly/weekly/monthly
  allowance is `allowance-exhausted` (still free, just spent). 0.28.0's rate-limit pattern matched
  the word "quota" and cooled spent quotas for 2 minutes. **The queue is PUSHED, not polled** — a failure carrying uninterpretable refusals
  returns `x-llm-relay-unknown-refusal: <n>` and the skill makes checking it the reflex on a pool
  failure, because a queue nobody opens is a backlog. The dispatcher may `propose`; only the user
  may `accept`. ⚠ Error bodies are untrusted external content and an agent reading them is an
  injection target — the containment is that a proposal is a CLOSED enum on both axes (`--class`
  validated against `FACT_KINDS` itself, `--scope` against the six of `SCOPE_PRECEDENCE`; the class
  list is derived from the store rather than hand-listed, because a kind the store accepts and the
  CLI rejects is invisible until somebody tries it — `rate-limited` shipped exactly that way), that
  signatures are keyed per (provider, model) so one provider can never produce a verdict about
  another, and that the header carries a COUNT, never the message. A `group` scope must also NAME
  its members. Don't trade any of those for convenience.
- **⚠ Never `res.clone()` a backend response on the failover path.** `clone()` tees the body and the
  failover branch cancels the original, so the un-read branch strands the walk and the client gets
  the FIRST candidate's error with the rest of the pool untouched. Read the body where it is already
  being discarded (`discardCandidate()`) or already buffered (the terminal error branches).
  `observeContextLimit` still clones — it is confined to 400/413 and has not been observed to bite,
  but it is the same hazard; don't copy the pattern into a new call site. Three pre-existing 402
  tests caught this, which is what the ≥2-candidate rule in `test/pool-failover.test.ts` is for.
  ⚠ The learned stores are process-global: reset them per test (`resetFacts` /
  `resetInterpretations`) like the breaker, or one test's refusal demotes another's first candidate.
- **The served-response announcement set has ONE owner, and it did not before (2026-08-27).**
  Both fronts assembled it by hand and the two copies had drifted twice, in ways nobody had
  recorded. `x-llm-relay-served-by` was written only below 400 by `responseHeadersForTarget`, so
  the Anthropic front carried NOTHING on a terminal upstream error while the OpenAI front supplied
  the tried-list — contradicting both the header's own declaration ("when every candidate fails it
  carries the list that was tried instead") and `docs/reference.md`. And
  `x-llm-relay-unknown-refusal` was computed by the OpenAI front only inside its `status >= 400`
  branch, so a walk that met an uninterpretable refusal and then SUCCEEDED reported nothing —
  defeating the header's whole purpose, which is to push the eligibility queue at the moment it
  matters. `ServedAnnouncementContext` is now what both fronts build. It is deliberately a narrow
  structural type, not `Ctx`: the OpenAI front has no `Ctx`, and widening it would let a caller
  omit `credentialHeaders` and silently lose the per-attempt credential attribution.
  ⚠ Adopting it moved the OpenAI front's credential pair AFTER the degraded/quota/paid writes,
  because that is the Anthropic front's long-standing order. No value moves — every name in the
  set is a distinct `x-llm-relay-*` constant — and one owner means one order; don't "restore" the
  old order on one front.
  ⚠ SCOPE: this is the ordinary SERVED response only. `walkExitHeaders` owns terminal transport
  and post-header exits, `respondAllCapped` owns the local all-capped 429, and `HARD_CAP_HEADER`
  never rides a served response. The two RECORDED deliberate residues — the transport-exit
  `servedBy` omission and the two dead-stream liveness spellings — are untouched.
- **A pool's error is one member's error, so the walk is reported alongside it.** Every walk of ≥2
  candidates carries `x-llm-relay-pool-attempts: "13 tried, 0 served: 4x402, 5x429, 3x403, 1x400"`
  on BOTH fronts, successes included. A header, never a rewritten body — the served body stays the
  last candidate's real upstream error, same maxim as the context guardrail. A single-candidate walk
  emits nothing: the response already IS the walk.
- **Don't add a blended "best target" score to `candidates.ts`.** The dimensions are deliberately
  separate; averaging them buries the judgement the reader is there to make. Tests assert no
  `score`/`rank` field, that every source keeps its own key under `scores`, and that the one
  scalar (`sortInputs.strength` — which exists only because pool ordering needs an order) never
  travels without `strengthBasis` + `strengthSignals`.
- **Limits and prices are per-(provider, model).** The same model id on two providers is two
  deployments — different context ceilings, different output caps, free on one and metered on the
  other. Never present one provider's figure as another's: resolve through `resolveMetadata()` and
  keep the `provider` / `reference` label. Tests in `test/metadata.test.ts` pin this, including that
  an unknown limit or price stays **null** instead of being guessed.
- **The context guardrail fires only on a limit the SERVING provider published.** Unknown limit ⇒
  no guardrail; the request goes upstream and the backend returns its own authoritative error. It
  reads `catalog.cachedLimits()`, which never fetches — a cold cache degrades to "no guardrail",
  never to a blocking round-trip on the request path. Don't reintroduce a fallback ceiling: a 400
  invented from a number we made up is worse than a true upstream error. **It covers the OpenAI
  front too (0.17.0)** — before that it was gated to `/v1/messages`, so Chat/Responses requests
  reached backends with no context pre-check while a test comment in `test/openai-front.test.ts`
  claimed otherwise (same "two paths, one policy empty" shape as the pool-failover incident).
- **Capability data is synced, never typed.** Add a source by writing a fetcher in
  `scripts/sync-tiers.mjs`, not a row in `BENCHMARK_DB`. Sources are independently failable — one
  dead endpoint must not cost the others — but **schema drift inside a source still throws** (a
  renamed column is corruption, not absence). Zero working sources is fatal. Coverage probe results
  and the reasons three sources were rejected: [docs/capability-sources.md](docs/capability-sources.md).
- **A source's absence is not a low score.** Models are never penalised for signals nobody
  publishes; `signal_count` travels with the score instead, so a 1-source guess and a 5-source
  consensus are distinguishable. Don't "fix" a sparse row by defaulting it to zero.
- **⚠ Never pin a REAL model's band membership in a test — inject the tier rows.** Effort floors are
  calibrated against the whole synced population, so a model's band moves when the population does,
  with no change to that model's own evidence: `kimi-k2.6` drifted 0.794 → 0.799 on a routine
  `npm run sync:tiers` (same two sources, same four signals), crossed into `xhigh`, and emptied the
  degrade tail that `test/dynamic-pools.test.ts` exists to assert. The behaviour was correct and the
  test was right to exist — the *fixture* was live data, so `sync:tiers` could turn the gate red for
  a reason unrelated to any code change. `materializeDynamicPools` takes an optional `tierData` for
  exactly this; production passes nothing and reads the snapshot as before.
- **A host whose traffic never reaches the relay cannot be detected by the relay.** Every
  subagent-reroute mechanism (`routing.subagents`, an `@relay:` directive, a `freeOnly` rule)
  works by answering an HTTP request differently, so it needs the request to arrive. From Claude
  Desktop it never does — the launcher pins `ANTHROPIC_BASE_URL` and beats the `settings.json`
  `env` block (that block's *other* keys still land; only this one is managed). There is therefore
  no request to classify, and `process.env` inside the **server** describes a process launched at
  logon, not whoever is asking. Detection lives in `host-routing.ts`, runs in the **CLI**, and is
  forwarded as `?host=`; `buildDispatch` takes it as an argument and must never sniff for it.
  Absent ⇒ `unknown` ⇒ exactly the pre-existing behaviour.
- **On a bypassed host, `requiresDirective` is never set and relay rungs are transposed.** The
  directive hint is true advice under a routed host and *false* advice under a bypassed one, where
  the `@relay:` line reaches the model as literal prompt text — a hint that cannot work is worse
  than none, because the host acts on it and believes it offloaded. A `relay` rung needing the
  reroute path is instead rendered as a CLI invoke from `routing.cliLane`. **Placeholder rules are
  a security boundary, not a convenience:** `{spec}` and `{contextWindow}` are relay-resolved
  configuration and are substituted in args AND env; `{task}` is request content and is substituted
  in args ONLY — config load *rejects* it in an env value, because it would otherwise pass through
  literally while the operator believed it worked.
  ⚠ **Never put `--permission-mode plan` in a `cliLane` template.** Headless `claude -p` has no
  `ExitPlanMode` tool, so a lane started in plan mode can never leave it: the agent explores with
  its tools, writes a plan document into the config dir's `plans/`, and exits `is_error: false`
  with `permission_denials: []`. Nothing in the result distinguishes "did the work" from "was
  caged", so the lane looks healthy while completing none of its tasks — this machine's template
  shipped that way and it read as "offload can't use tools". Tool use and the multi-turn loop were
  never the problem. Use `acceptEdits` (plus `--allowedTools`, since other shell and network calls
  still abort without it) for a working lane, or `dontAsk` for a read-only one that fails loudly
  instead of silently. Measured evidence and the alternatives others use:
  [docs/offload-agentic-capability.md](docs/offload-agentic-capability.md).
  ⚠ **A lane child needs the client idle watchdogs raised, or a long think kills it.** Claude Code
  has three CLIENT-side idle timers (event-level + byte-level streaming watchdogs and a body idle
  timeout) that abort a silent generation at ~300 s on a custom base URL — and the relay's commit
  probe (`stream-commit.ts`) holds bytes until meaningful content, so a long think IS silent to
  them. The owner's `routing.cliLane.env` therefore sets
  `CLAUDE_STREAM_IDLE_TIMEOUT_MS=1800000`, `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=1800000` and
  `API_FORCE_IDLE_TIMEOUT=0`; put the same three in any hand-written `cli` rung's `env`.
  **`{contextWindow}` has THREE rungs, all real measurements** (`contextWindowResolver` in
  `metadata.ts`): a ceiling this deployment *stated when refusing an over-length request*
  (`context-limits.ts`), then its own published `contextLength`, then `context_length` from the
  synced snapshot for the same model id. There is no guessed rung, same as `resolveMetadata`.
  ⚠ The learning loop is wired into **both** request paths beside `observeAttemptHeaders` — a loop
  running on one front only would silently know nothing about half the traffic, which is the exact
  shape of the pool-failover incident. It reads a CLONE, so the client's body and failover are
  untouched, and it never throws.
  ⚠ **A pool member that resolves to nothing does NOT veto the pool** — the minimum over members
  that DO resolve is used, with `contextWindowUnknownMembers` reporting the gap. The original
  all-or-nothing rule let one model (`Qwen3-235B-A22B-Instruct-2507`) blank three of four pools
  while 28/29, 38/41 and 44/49 members resolved. A pool is a ROUTING construct; membership says
  nothing about a member's window, so "no data on one model" must not read as "nothing known about
  this pool". The residual risk is exactly what the observed rung closes.
  ⚠ Rung 2 is load-bearing, not a nicety: free providers publish almost nothing (NIM publishes
  none), so rung 1 alone covered 0 of 29 `pool/high` members while the snapshot covered 28 of 29
  (measured 2026-08-07). ⚠ **Fuzzy snapshot matches are rejected here** even though
  `findTierModel` offers them — a borrowed SKU's *score* mis-ranks a pool, a borrowed SKU's
  *context window* tells a client it may send tokens the backend will reject. A pool needs every
  member to resolve and uses the MINIMUM (failover can land anywhere), so one unresolvable model
  blocks a whole pool. Unknown ⇒ the entry is dropped, not emptied.
  ⚠ **Never "fix" an unknown with a large speculative value.** Measured pool minimums here are
  131,072–163,840 — *below* the 200k the `claude` CLI already assumes — so a speculative 1M would
  overshoot the weakest member eightfold. Same reasoning as "the context guardrail fires only on a
  limit the serving provider published": a number nobody published is worse than no number.
  ⚠ `buildDispatch`'s LOCAL path must materialize dynamic pools first (`runDispatch` does). Until
  materialized a `{ include: "free" }` pool has zero members, so it resolved to no window while the
  same query against the running proxy resolved one — the fallback may know less about live state,
  never about configuration. ⚠ **A rung pointing at the caller's own vendor passthrough
  is NOT transposed** — an `anthropic`-kind provider with no `authEnv` is reachable as a plain
  `Agent(...)` from anywhere, and that rung *means* "spend primary quota". With no template
  configured the rung is marked `unreachable` and skipped when picking `next`; an explicit
  `?lane=` still reaches it and says why it is blocked.
- **The Agent hook is the DELIVERY of `offload claude on`, not a separate feature — so it must
  track the setting in both directions.** `offload claude off` removes it. A forcing function that
  outlived the rule justifying it would deny subagents nobody asked to redirect. It appends a new
  matcher rather than editing the array (users run their own `Agent` hooks; Claude Code runs every
  match), and it fails **open** everywhere: a hook that denied subagents because the proxy was down
  would turn one unavailable optional lane into a total outage — same reasoning as an unset
  `${ENV}` disabling one provider instead of aborting startup.
- **A host with no subagent mechanism must be handed a COMMAND, and `unknown` is such a host
  (fixed 2026-08-30).** `host-routing.ts` defines three states and says what `unknown` means in as
  many words — *"not running inside a Claude Code session — no subagent routing to adapt to"*. But
  `dispatch.ts` gated transposition on `host === "bypassed"` alone, so `unknown` fell through with
  `routed`: a headless caller (a cron job, a CI step, `run-headless.ps1`) was handed a `target:`
  spec to address as a subagent it does not have, and `--next-command` then refused with exit 2 and
  left it nothing to run at all. That is the closed-vocabulary defect class above — an unhandled
  member resolving to the STRONGER claim ("you can reach this") — and it reproduced with **zero
  flags** in any shell without `CLAUDECODE`. The policy now lives in two named predicates plus one
  reason function (`canAddressAsSubagent`, `mustTransposeEveryRung`, and `unreachableReason`, which
  returns a string). ⚠ For `unknown` EVERY
  relay rung is transposed, the plain Anthropic passthrough included — `reachableWithoutRelay` asks
  whether a bare `Agent(...)` reaches a spec, and there is no `Agent(...)` here at all. ⚠ An
  **absent** verdict is deliberately NOT `unknown`: `buildDispatch` collapses absent into
  `"unknown"` for the rendered view, so the lane builder takes `opts.host` directly and a caller
  that stated nothing keeps the pre-existing path. ⚠ The fix is SERVER-side, so a live host keeps
  the old answer until the relay restarts onto it — the CLI asks the running relay over HTTP.
  Evidence, the three adversarial reviews and the MCP verdict:
  [docs/skill-dispatch-mcp-verification-2026-08-30.md](docs/skill-dispatch-mcp-verification-2026-08-30.md).
- **⚠ THE MCP VERDICT IS REVERSED (owner decision, 2026-08-30 — later the same day).** The
  paragraph below stated its own reversal condition in as many words, and the owner then stated
  it: **agy must be able to DELEGATE, not only be delegated to.** So an MCP server is now WANTED,
  and the backlog carries the work item. Everything below stays on the record and stays binding on
  the DESIGN — the two invalid objections must not be repeated, and the four real design
  constraints (an inert `dispatch()` on a stranger's install, a read tool duplicating `/dispatch`,
  a caller-supplied `cwd`, no representation for a 30-minute lane) are unsolved, not withdrawn.
  ⚠ **RETRACTED, same day, by the owner: agy's missing shell is NOT a security boundary and must
  never be cited as one.** This paragraph first said to carry a security cost forward "because the
  owner accepted it knowingly" — that was false. Owner correction 2026-08-30: *"some agent ordained
  that AGY had certain limitations, that it did not have, that I didn't want"*. The 2026-08-11
  `command(*)` revocation was an AGENT's act, and the global `CLAUDE.md` phrase "the accepted cost"
  describes an acceptance no file history shows. So do not argue that an MCP server "reaches around
  a deliberate revocation through a side door" — the premise does not hold. Design the server on
  its own merits, and treat restoring agy's shell as a separate one-line change that needs explicit
  owner instruction. ⚠ The general lesson is the one this file already teaches about provenance:
  an agent-imposed limitation recorded in prose reads, three days later, exactly like an
  owner-chosen policy. Say who decided, or do not call it a decision.
  ⚠ **A related question was closed the OTHER way in the same decision:** `DEFAULT_CONFIG_TEMPLATE`
  will NOT ship a `routing.ladder` or a `cliLane` (owner decision 2026-08-30, D2). Dispatch is
  deliberately a per-machine feature, so **stop measuring dispatch work against rubric test 1** —
  a stranger's install having no ladder is now a stated design choice, not a gap to close.
- **Do NOT build an MCP server (assessed fresh 2026-08-30, owner-directed — SUPERSEDED above,
  kept for its reasoning).** The 2026-08-16
  ledger rejection was re-opened and re-argued from scratch; two of the obvious objections are
  INVALID and should not be repeated — a minimal JSON-RPC-over-stdio server needs **no** new
  dependency (this repo hand-rolls `sse-frames.ts` and four SSE parsers already), and `packBytes`
  is a regenerable CEILING, not a size wall. The real reasons: a fresh install ships **no**
  `routing.ladder` and no `cliLane` (`DEFAULT_CONFIG_TEMPLATE`, `config.example.json` and
  `onboarding.ts` all have zero), so a `dispatch()` tool would do nothing for anyone but this
  machine and fails rubric test 1; a tool that RETURNS a command is a read tool duplicating
  `/dispatch`; and a tool that EXECUTES needs a caller-supplied `cwd`, escapes the harness's
  permission gate, has no representation for a 30-minute lane, and is precisely the "future async
  spawn site" the quota-reprobe design warned about. ⚠ The strongest argument FOR it is real and
  recorded: **agy has no shell but does have `mcp(*)`**, so an agy session has zero delegation
  mechanisms today. That reverses this verdict if the owner states agy must be able to DELEGATE
  rather than only be delegated to. Reversal conditions are listed in the doc §4.3.
- **The dispatch ladder decides ORDER; the REQUEST PATH never executes a lane.** `routing.ladder`
  may name agent CLIs (`kind: "cli"`), and no lane command is ever spawned to answer an HTTP
  turn: a lane's quota is client-bound, it runs its own tool loop, and it returns only final
  text — so a relay that shelled out mid-request could never return the `tool_use` blocks the
  turn owes its caller. `/dispatch` hands the host a command; the host runs it.
  ⚠ **Owner-amended 2026-08-29** ([docs/quota-reprobe-design-2026-08-29.md](docs/quota-reprobe-design-2026-08-29.md)):
  outside the request path there are exactly TWO lane-spawn sites — the operator CLI probe
  (`lanes --probe`) and the background lane cadence (`lane-cadence.ts`), because keeping lane
  metadata fresh and re-testing recorded quota deaths is the relay's own job, exactly as the
  ping loop already does for HTTP. ⚠ The cadence hook fires only from `PingLoop.start()`'s OWN
  loop iteration, never from `tickOnce` — the admitted `GET /ping` route calls `tickOnce`
  directly, and a hook there let an HTTP request initiate lane work (caught by the 2026-08-30
  closeout audit; pinned in `test/ping.test.ts`). The old flat sentence "the relay never spawns one" narrowed
  to the request path; every reason behind it binds there and survives intact. Exhaustion state
  is durable now (`dispatch-exhaustion-persistence.ts`), and a recorded death is re-probed on
  the `routing.laneProbe` cadence until a real answer retracts it or it expires — no lane stays
  parked on a stale record.
- **Never use `routing.tiers` as an accidental subagent switch.** A subagent asking for `haiku` and a
  human picking Haiku are byte-identical requests. Keep the destination map in `routing.subagents`
  and use the originating client's explicit `routing.offload` scope; `scope: "all"` is the deliberate
  choice when a full conversation should move too. Full reasoning: [docs/subagent-routing.md](docs/subagent-routing.md).
- **The OUTBOUND body is the caller's conversation — never a stringified block the mapper did not
  understand.** For three releases every `openai`-kind agentic request carried llm-bridge's own IR
  envelope (`{"_original":{"provider":"anthropic",…},"tool_call":…}`) as `{type:"text"}` parts,
  because `universalToOpenAI` has no case for `tool_call`/`tool_result` and falls through to
  `JSON.stringify`. Models learned the notation in-context and echoed it back as their final
  answer; prompts inflated ~3.1×, tool results triplicated, and `tool_calls` shipped with no
  `role:"tool"` message to answer them. The request direction is now `openai-request.ts` and an
  unrepresentable block is a clean 400. ⚠ **Do not "also" fix it on the response side** — no JSON
  marker belongs in `DIALECT_MARKERS`: an arbitrary JSON object is not a closed envelope, and
  promoting one to a `tool_use` is the fabricated intent `tool-dialects.ts` forbids. ⚠ The mapper
  runs once **per candidate**, so an outbound-shape test with one candidate proves nothing —
  `test/pool-failover.test.ts` walks ≥2. Diagnosis and the `toolu_*` tell:
  [docs/tool-call-dialect-leak.md](docs/tool-call-dialect-leak.md) §"Second mechanism".
  ⚠ **The Responses front had the same defect by a different route, fixed 2026-08-23**
  (`responses-request.ts`): llm-bridge's `openaiResponsesToUniversal` dropped the assistant's
  `function_call` and stringified its `output_text`, so a Codex multi-turn tool conversation was
  broken past the first call on BOTH backend kinds. Same rule, same refusal policy — and the same
  ≥2-candidate requirement, since that mapper also runs per candidate.
- **A weak host's REPEATED tool-call ids kill Claude Code sessions — the relay mints unique ones at
  the translation seam.** `nim/moonshotai/kimi-k3` emits OpenAI `tool_calls[].id` values of the form
  `<ToolName>:<index in this response>` (`Read:0`, `Bash:0`), so the same id recurs on every turn
  that calls that tool again. Claude Code normalizes the conversation while BUILDING every request:
  it keeps a Set of seen `tool_use` ids, DROPS any repeat, substitutes `[Tool use interrupted]` when
  that empties an assistant turn, and patches the orphaned `tool_result`s. So the model stops seeing
  its own earlier calls (the "weak agentic loop" on kimi lanes — re-reading the same file, `No
  response requested.`), and eventually the fresh turn is emptied and a headless `claude -p` run
  ends with nothing to execute. `src/tool-use-ids.ts` mints `<id>_relay<k>` for a colliding id at the
  openai-kind seam in `backend.ts` — buffered and streamed, after dialect recovery, before anything
  that watches for the first `tool_use`. Announced as `x-llm-relay-tool-use-ids: "<n> rewritten"`
  (buffered only — a stream's headers precede its first tool call) and as the `toolUseIdRewrites`
  log counter, a count and never an id. ⚠ **No reverse map exists, by construction**: the client
  echoes the minted id back in both the `tool_use` and the `tool_result`, and `openai-request.ts`
  forwards both verbatim, so the backend sees a consistent pair with the relay remembering nothing.
  ⚠ Confined to the TRANSLATED path — a native Anthropic response stays byte-exact, and the OpenAI
  front's direct Chat passthrough (openai-kind + Chat) is left alone (different client, and
  byte-exactness is the point). Every OTHER front combination runs through `fetchBackend`, so a
  Codex `/v1/responses` turn on an openai-kind target DOES get the mint — and therefore owes the
  same two announcements: the front forwards `x-llm-relay-tool-use-ids` across its rebuild and its
  served log record carries `toolUseIdRewrites`.
  Diagnostic tell: `[Tool use interrupted]` as the final assistant text of a headless run, with
  `Read:0`-style ids repeating in the transcript.
- **Mistral REFUSES every tool-call id this relay forwards — the outbound rewrite is opt-out, not
  opt-in.** First-party, `mistral-medium-2505`: HTTP 400 `{"object":"error","message":"Tool call id
  was toolu_01AAAAAAAAAAAAAAAAAAAAAA but must be a-z, A-Z, 0-9, with a length of 9.",
  "type":"invalid_function_call","code":"3280"}`. `mistral-common` enforces `^[a-zA-Z0-9]{9}$` on
  BOTH the assistant `tool_calls[].id` and the answering `tool_call_id`, and from v13 also LINKAGE
  (a tool message must answer an id a prior assistant turn called) and UNIQUENESS. Every shape that
  reaches the mapper violates it: `toolu_01…` (Anthropic), `Read:0` (nim kimi-k3), `Read:0_relay1`
  (relay-minted), `call_…` (Codex), `tu_recovered_0` (dialect rescue). So `providers.<name>.compat`
  carries `toolCallIds: "preserve" | "strict9"`, and its ABSENCE resolves through a **labelled
  provider fact**: a `*.mistral.ai` base host ⇒ `strict9`, everything else ⇒ `preserve`. That is the
  "Provider knowledge is data, not routing configuration" invariant's allowance — a fact in `src`
  is legal only because config overrides it, and an explicit value wins in **both** directions
  (`preserve` on mistral, `strict9` on anything else). ⚠ Resolved at TARGET-resolution time onto
  `ResolvedTarget.toolCallIds`: the mapper gets a mode, never a provider name to sniff, so a
  hand-built target with no mode behaves exactly as it did before this existed. ⚠ The rewrite is
  **deterministic** (SHA-256 → base62, 9 chars; `#k` suffix on collision, first-appearance order) —
  the `tool-use-ids.ts` precedent, and load-bearing here because a conversation only appends: a
  random id would detach a `tool_result` from its call the moment the turn was replayed, retried,
  or sent to a second failover candidate. An already-conforming id is kept, so a mistral-native id
  round-trips. ⚠ Announced, like every other automatic fix on this path: `x-llm-relay-tool-call-ids:
  "<n> rewritten"` plus the `toolCallIdRewrites` log counter — a COUNT, never an id — and unlike the
  response-direction mint the header rides a STREAM too, because the figure is final before egress.
  ⚠ An unknown `compat` key or value is a HARD config-load error naming it (the `configured-limits`
  precedent): an ignored typo would read as a declaration that took effect while the wire was
  unchanged. ⚠ The transform is a pure function of (caller body, that candidate's resolved compat),
  so a pool walk can legitimately send DIFFERENT ids to different candidates — the
  `test/pool-failover.test.ts` "same translation both times" assertion is scoped to a same-compat
  fixture and stays true.
  ⚠ **SCOPE — `compat` shapes only request bodies the RELAY AUTHORS, and that is a decision, not a
  gap.** Both keys hang off `anthropicRequestToOpenAi`, so they reach the TRANSLATED lanes (an
  Anthropic `/v1/messages` request to an `openai`-kind target, and a `/v1/responses` request doing
  the same via `responses-request.ts` → this mapper). The OpenAI front's **direct Chat passthrough**
  — `openai`-kind target + `chat` protocol, `backend.ts` `fetchOpenAiFront`'s first branch — posts
  `{...base, model, stream}`, i.e. the caller's own body, and never enters the mapper; a declared
  compat mode is therefore **inert there BY DESIGN**. Do not read that as the "two paths, one policy
  empty" defect shape and go "finish" it: this is the same deliberate asymmetry as the
  response-direction id mint, and the reason is that responsibility tracks AUTHORSHIP. An
  OpenAI-native client wrote its own ids into its own body and gets mistral's 400 verbatim, which is
  its to fix and which byte-exactness exists to preserve; on a translated lane the client cannot fix
  what the relay wrote. State this whenever the question comes up rather than re-deriving it.
- **Gemini 3.x REFUSES a replayed tool call that carries no `thought_signature`, and the relay
  stamps Google's own opt-out token rather than inventing or storing one.** First-party,
  `models/gemini-3.6-flash` via the OpenAI-compatible endpoint on
  `generativelanguage.googleapis.com`: replaying an assistant `tool_calls` turn answers HTTP 400
  *"Function call is missing a thought_signature in functionCall parts…"*. Google's documented
  escape is the **raw string** `skip_thought_signature_validator` at
  `tool_calls[N].extra_content.google.thought_signature` — never base64-encoded, which would make
  it a malformed signature instead of the opt-out. So `compat` carries a SECOND key,
  `thoughtSignature: "none" | "sentinel"`, on the identical mechanism: absence resolves through
  `resolveThoughtSignatureMode()` from the same **labelled provider fact** allowance — base host
  `generativelanguage.googleapis.com` ⇒ `sentinel`, everything else ⇒ `none`, explicit config wins
  both directions — onto `ResolvedTarget.thoughtSignature`. ⚠ The host test is that ONE exact host,
  not `*.googleapis.com`: Vertex is a different product with a different validator.
  ⚠ **EVERY entry of a replayed turn is stamped**, not just the first. Verified live 2026-08-23:
  the sentinel on a single call → 200 and a correct tool-informed answer; on BOTH entries of a
  parallel pair → 200 (which contradicts a public report that a parallel pair rejects it); and on
  only the first of a pair → also 200. Every-entry is the placement whose correctness does not
  depend on which entry the validator inspects. ⚠ **Echoing the REAL signature was rejected, and
  the reasons are invariants**: it would need either a conversation store keyed by tool-call id
  holding vendor-private reasoning between turns — the reverse map `tool-use-ids.ts` deliberately
  does NOT have ("no reverse map, by construction") — or a fabricated `thinking` block smuggled
  into the caller's conversation, which would poison every anthropic-kind failover candidate with
  content the caller never wrote. And there is no real signature in hand anyway: this mapper DROPS
  `thinking`/`redacted_thinking` cross-vendor by rule, the same rule under which "a guessed
  `reasoning_effort` would be an invention". The sentinel is the vendor's own token for "no
  signature available" — a labelled parameter quirk, not an invented measurement — and it is
  config-overridable, which is the condition the "Provider knowledge is data" invariant attaches.
  ⚠ **No response header for this one**, deliberately, and it is the one asymmetry with
  `toolCallIds`: the sentinel is vendor-protocol padding on the relay's OWN outbound shape and
  alters nothing about the caller's data, so there is nothing a client could act on. It is still
  counted — `thoughtSignatureSentinels` on the `LOG_FIELDS` allow-list, a COUNT and never a
  signature — so the operator can see it fired. ⚠ Under `"none"` (everyone else) the outbound bytes
  are byte-identical to before this existed, and the RESPONSE direction is untouched: nothing
  captures `extra_content`, no store exists. ⚠ The authored-bodies SCOPE in the mistral gotcha above
  governs this key too — the direct Chat passthrough is never stamped, deliberately.
  ⚠ **RESIDUAL, stated so nobody mistakes it for verified: the default is HOST-scoped while the
  evidence is MODEL-scoped.** First-party verification covered `models/gemini-3.6-flash` only, but
  `resolveThoughtSignatureMode()` defaults the whole `generativelanguage.googleapis.com` host to
  `sentinel`, so every gemini model routed through that base — 2.5-era included — gets the field.
  Google's `extra_content` is an ENDPOINT-level extension of the OpenAI-compatible layer, so a model
  whose validator does not ask for a signature is expected to ignore it; that expectation is
  UNTESTED here. If a 2.5-era (or any other) model on that host starts 400ing on the extra field,
  the escape hatch is per-provider config, not a code change:
  `compat: { "thoughtSignature": "none" }` — which is precisely why the labelled fact is allowed to
  live in `src` at all. Narrowing the default to a model-id test would need first-party evidence per
  model, and inventing that test without it would be the guess the fact rule forbids.

## Status & open work

⚠ **Read [HANDOFF.md](HANDOFF.md) §0 for the current sprint, not this section.** HANDOFF is the
living state; what follows is the durable residue — decisions, standing warnings and lessons that
outlive any one release. Per-release narration belongs there and in git, never here.

**The last known safety-shaped code gap closed in v0.46.0** — the dialect-rescue destructive
filter (`091cf7c`). `destructive` had reached none of `tool-dialects.ts`, `openai-dialect.ts`,
`dialect-stream.ts`, so a WELL-FORMED destructive call the relay reconstructed out of assistant
prose was served unfiltered. It is now refused whole and terminally at all four rescue commit
points, with provenance declared rather than read off the wire; see the gotcha above and
[docs/dialect-rescue-destructive-refusal-2026-08-24.md](docs/dialect-rescue-destructive-refusal-2026-08-24.md).
HANDOFF §6 still lists only recorded trades — no open code gaps.

**The metering sprint is complete (2026-08-22, evening)** — Stages 0–6 of
`docs/quota-metering-spec-2026-08-16.md` are delivered, through the event-sourced accounting store
(`~/.llm-relay/usage/`, `b4ec7ee`), the usage observer on both fronts, the protected dashboard API
and React SPA, and the evening sprint that closed the remainder: cache fields on
`AssistantMessage.usage` (C3), operator-declared `limits` (Gap 5), learned rate-limit facts on both
fronts (Gap 8, display-only), catalog harvesting of published rate limits (Gap 13), per-attempt
spend priced from published prices into four provenance cells (Gap 11), the availability ladders +
dashboard availability producer (Stage 3), quota as a demotion term on both fronts (Stage 5 /
Gap 12, learned opt-in via `routing.quota.enforceLearned`), and the `llm-relay cost
--include-repair` roll-up. The G2 manual hard cap (`limits.hard`), M3, M4/Gap 10, and the custody
program (`src/os-keyring.ts` + `src/keystore.ts` + the resolver keystore rung + the `keys` lifecycle
CLI) are all delivered too.
[docs/metering-reconciliation-2026-08-22.md](docs/metering-reconciliation-2026-08-22.md) §7 is the
closeout ledger, and
[docs/custody-sprint-plan-2026-08-24.md](docs/custody-sprint-plan-2026-08-24.md) holds the custody
plan, its recon corrections and its seven build decisions. The commit-by-commit trail is in
HANDOFF §0/§6 and in git; the standing DECISIONS are the part worth keeping here:

- **Gaps 15, 16 and P4 were dropped outright.** Gap 7 was resolved by spec amendment (no new
  endpoints).
- **Streaming cross-protocol usage parity in llm-bridge is ACCEPTED AS-IS** (owner decision
  2026-08-23) — the ledger observes the BACKEND stream, so accounting is correct; only the
  client-facing translated SSE loses cache fields.
- ⚠ **Do not "complete" Gap 3 by adding token fields to `LOG_FIELDS`** — the accounting store
  superseded the JSONL-as-ledger plan; see the `log.ts` row above.

✅ Earlier closed work, kept for its lessons: the four confirmed defects fixed 2026-08-14
([docs/audit-2026-08-09.md](docs/audit-2026-08-09.md)) — the `argValue()` parser confusion
(`961a750`), missing Codex destructive-tool defaults (`55ae136`), credential-carrying ping redirects
(`fcc1452`), and case-sensitive `winenv` scope merge (`7f6f6e4`) — each closed with pinning tests.
⚠ That run produced 676 findings but **only 6 were verified against source** — the rest are
advisory output from an offload lane whose severities are a model's estimate, so do not treat such
a report as a to-do list. A full audit was remediated to completion and its follow-up list closed
in v0.12.0; the audit apparatus and handoff doc were then deleted, because a finished run's ledger
is just a stale to-do list — anything that mattered became a code change, a test, or a paragraph
in this file. The 2026-07-30 pool-failover symptoms are likewise fixed and closed — see
[docs/pool-failover.md](docs/pool-failover.md) and the gotchas above.

**Project goals are written down** — [docs/project-goals.md](docs/project-goals.md): personal
tool first (shared with friends; README + `llm-relay onboard` must suffice for a stranger),
traffic steering as the mission, stabilize-and-harden as the trajectory, and a five-test rubric
for judging proposed changes. An external proposal was reviewed against it 2026-08-04
([docs/suggestion-review-2026-08-04.md](docs/suggestion-review-2026-08-04.md)): four small
pieces harvested (all landed), the enterprise-shaped remainder rejected with reasons — read it
before proposing routing refactors, budgets, tracing stores, or LLM-assisted classification.
A second external review (terms compliance + credential handling) was assessed 2026-08-05 —
[docs/codex-review-2026-08-05.md](docs/codex-review-2026-08-05.md): its headline credential finding
was false (it missed that the openai path builds its own headers), two changes were adopted anyway
(`credentialMode`, the OR'd subagent signal), and it carries the verified terms position. Its
2026-08-08 anti-hosting proposal was recalibrated 2026-08-16 into accounting metering plus the
narrow no-hosted-relay/no-pooled-consumer-accounts boundary. Counting, ordering, and holding
several of an operator's own keys remain allowed. ⚠ **Decisions shaped by any invariant must be
stated aloud** — name the rule, what it excluded, and the alternative used.

⚠ **A CLI process's environment is NOT the running relay's environment, and confusing the two
fabricates credential bugs.** On Windows a User-scope environment variable enters a process only at
**process start**, so the long-running relay (launched from `Startup` at logon) predated six keys
that a freshly launched shell had. `llm-relay keys` / `llm-relay candidates` run as new processes and
report *their own* env; `GET /registry` and `GET /candidates` are answered by the relay and are the
authoritative `has_key`. The two disagreed, and the whole "half the pool is dead, seven 401s" finding
of 2026-07-30 was this — **not** bad keys. `pool/coding` (the pools were task-named back then; they
are effort-named — `low`/`medium`/`high`/`xhigh` — since v0.15.4) went from 5 live members to **11**
(`llm-relay pools --probe`: 29/35 live overall). **`winenv.ts` now closes the gap at startup**, so a
key added after logon is picked up on the next relay restart rather than needing a reboot. ⚠ Still
check `curl 127.0.0.1:8791/registry | grep has_key` before ever concluding a key is bad. Genuinely
down: `gemini` (real 429/quota), `ollama/qwen2.5-coder:7b` (local daemon not running),
`nim/deepseek-ai/deepseek-v4-flash` (HTTP 529).

⚠ **Health data must survive a restart, and a verdict must not turn on one sample.** Both were
broken together: `PingLoop` held ping history in memory and read only that while `recordProbeResult`
wrote to disk and nothing read it back (so every restart reset every model to `Pending`/`p95: -1`),
and `getVerdict` was handed `isDown: lastPing.code !== "200"` (so one transient 503 buried fifty good
samples). Now: entries carry a sample window + lifetime totals, `getModelPings()` hydrates from disk,
and `isPersistentlyDown()` needs a RUN of failures plus poor uptime. ⚠ **The transient tolerance is
scoped to transient codes.** A 401/403 is the provider stating a fact about the credential and is
down immediately — otherwise a revoked key reads "Perfect", since fast 401s are still fast. When
threading a probe-cache path through `PingLoop`, thread it to `getModelsDueForProbe` too: the module
keeps a cache keyed by the last path it saw, so a call that omits it silently asks a different cache.

⚠ One durable lesson from it, because it will cost you an hour otherwise: **several tests in this
repo were written to pin the defect they should have caught.** A correct fix here can legitimately
turn the suite red — read the failing test's stated reasoning before assuming your change is wrong,
and change the test in the SAME commit as the source fix.

Current: **usable end-to-end**, suite green, tsc clean — and verified by CI
(`.github/workflows/ci.yml` runs `npm run build` then `npm run check`: both typechecks, both suites,
and the package checks) rather than by a local run only. A real `claude` agentic session completes through the proxy against NIM.
(The point-in-time assessment doc that used to back this claim was deleted 2026-08-04 as a stale
snapshot — CI and the suite are the living evidence.)

**Client-specific offload is live but OPT-IN** (0.3.0; switched off by default in 0.4.0): Claude
and Codex rules can independently route marked children, or their full conversations with
`scope: "all"`, to non-Anthropic providers. Verified end-to-end on the wire. Use
`llm-relay offload <client> on --scope subagents|all` (no restart); choose a target with
`llm-relay candidates`. Design + evidence: [docs/subagent-routing.md](docs/subagent-routing.md).

Every script in `scripts/` and every proxy endpoint has been exercised live against NIM;
`multimodal-probe.mjs` is 5/5 green.

**Capability ranking now lives here** (0.5.0), no longer deferred to the router/auditor project:
`npm run sync:tiers` merges four effective sources — OpenRouter + BFCL + LMArena + Aider; the fifth
fetcher, Artificial Analysis, is key-gated and currently unconfigured so it contributes nothing
(`docs/tier-data.json` records it `model_count: 0, configured: false`) — into `docs/tier-data.json`,
and `getStrength()` ranks pools off it. Source probe results, coverage per
source, and why EvalPlus / HF Open LLM / LiveCodeBench were rejected:
[docs/capability-sources.md](docs/capability-sources.md).

⚠ **Reasoning-effort rows were being shattered, not missing** (fixed 2026-08-08). The sources spell
the same variant three ways — `gpt-5 (high)` (Aider), `gpt-5-high` (LMArena), a bare id
(OpenRouter) — so **0 of 60** effort-qualified rows joined across sources and every one looked like
a 1-signal guess. `normName()` now canonicalizes the notation (8 of 71 joined, best case 3 sources
/ 5 signals). ⚠ It REWRITES to suffix form against a **closed** vocabulary and never STRIPS —
`gpt-5 (high)` → `gpt-5-high`, never `gpt-5`, because collapsing a variant into its base is exactly
the borrowed-score bug. Artificial Analysis is also fetched first-hand now (key-gated; absent key
skips cleanly, undocumented schema so the mapping is a throwing alias list). Neither change moved
the current ladder — no source publishes two effort points for any model this machine routes to.
Full diagnosis: [docs/effort-granularity-gap.md](docs/effort-granularity-gap.md).

Best-known backend model on NIM: **`z-ai/glm-5.2`** (trip rate 0 across the scenario set; it topped
the then-`coding` pool by synced strength, 4 signals — pools are effort-tiered now, see
`config.example.json`). `llama-3.1-8b` trips 25% of calls and the reshaper
fixes ~2/3 of those — the proxy's use case.

Durable project state also lives in agent memory (`project-repair-proxy`).
