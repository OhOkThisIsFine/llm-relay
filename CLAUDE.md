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
**lightweight** (only what is necessary; two runtime deps; no second implementation of
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
npm run build          # tsc -> dist/
npm test               # vitest run  (the suite is the source of truth; do not pin a count here — it drifts)
npm run typecheck      # tsc --noEmit — src/ (tsconfig.json)
npm run typecheck:test # tsc — the SUITE (tsconfig.test.json). See the note below.
npm run check          # both typechecks + test. The one gate; CI runs exactly this.
npm run dev -- --config config.json   # run from src via tsx, no build
npm run sync:tiers     # regenerate docs/tier-data.json (shipped in the published package)

llm-relay keys         # are the CREDENTIALS good?
llm-relay pools --probe # will each configured MODEL actually answer? (the only real liveness check)

npx vitest run test/repair.test.ts             # one file
npx vitest run -t "refuses destructive"        # one test by name
```
**Always verify green before AND after a change:** `npm run build && npm run check`.

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
typechecks plus the suite. Several default rules contradict documented invariants here, so they
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
| `cli.ts` | Entry point. Parses flags (`--config`, `--default`, `--mode`, `--listen`, `--provider`, `--refresh`, `--client`, `--scope`) and dispatches commands (`onboard`, `setup`, `keys`, `telemetry`, `models`, `ping`, `offload`, `pools`, `routing`, `config`, `candidates`, `dispatch`). Pool/routing/config editors validate the complete JSON before writing and require a proxy restart; targeted offload/candidates/dispatch queries talk to a **running** proxy over loopback when there is one, so a client rule takes effect without a restart and status gets warm health data. |
| `config-edit.ts` | Shared JSON document editor for the CLI. Preserves unknown config fields, supports dot paths, rejects prototype-pollution path segments, and runs every candidate document through `loadConfig()` before committing it. |
| `dotenv.ts` | Loads `~/.llm-relay/.env` into `process.env` at startup, **never overwriting an already-set variable**. `onboard` always wrote this file and nothing ever read it, so a wizard-saved key worked for one shell and then "stopped working". The real environment wins because it is the more explicit signal. |
| `pool-health.ts` | `llm-relay pools --probe` — sends a REAL completion to every pool member. Config-time validation cannot see a model that is listed and still dead (de-listed behind the scenes, gated to a paid tier, routed to a missing function), and that is exactly how a pool ends up with one live member and paper failover. Probes at 400 max_tokens because reasoning models return an empty 200 at a low cap — `empty` is a distinct verdict from `missing`, not a synonym. |
| `authEnv.ts` | Resolves a provider's declared `authEnv` name against a **closed** per-provider alias list (`GEMINI_API_KEY` vs `GOOGLE_API_KEY`, …). Deliberately never scans the env for key-shaped names — a heuristic match would ship one provider's credential to another's endpoint. |
| `presets.ts` | `FREE_PROVIDER_PRESETS` — built-in free/subscription provider definitions (base, kind, authEnv, signup URL, recommended models) used by onboarding and setup. |
| `config.ts` | Load/validate config. `${ENV}` expansion, loopback enforcement, multi-candidate tier specs (`string | string[]`), **`pool/<name>` routing** (`routing.pools`; `pool` is a reserved provider name; an unknown pool is a loud `RoutingError`, never a silent fall-through to `routing.default`), **client-specific offload routing** (`isSubagentRequest` reads Claude/Codex child markers; `subagentSpec` applies `routing.subagents` through the originating client's `routing.offload` rule, with `scope: "subagents" | "all"`, or an `@relay:` directive read ONLY from the last text block of `messages[0]`; a rule may carry `freeOnly: true` — see the gotcha), reshaper auto-synthesis. Also `leave_me_alone` — the onboarding-nudge suppression list, whose entries are deliberately NOT validated against the known providers (see `onboarding.ts`). |
| `offload.ts` | Client-specific offload state. `setOffload()` mutates the **live** `Config` (so the next request routes the new way with no restart) and rewrites the targeted `routing.offload.<client>` rule in the file it was loaded from. Never throws — an unpersistable change still applies in memory and reports `persisted:false`. |
| `dispatch.ts` | The dispatch ladder (`GET/POST /dispatch`, `llm-relay dispatch`) — which LANE a host should hand a whole delegated task to, in order, with tier selection (`?tier=`), host override (`?lane=`), walk-past (`?after=`) and host-reported exhaustion (`POST {"exhausted"}`). `routing.ladders.<tier>` supports different CLI models for reasoning/coding/fast; the legacy `routing.ladder` remains valid. An exhaustion report may carry `outcome: "rate_limited"` (15m default) or `"quota_exhausted"` (1h default) and a vendor-stated `retryAfterMs` that beats both (`OUTCOME_DEFAULT_MS`); the relay still never invents the signal. A `cli` rung may declare `env` (string = set, `null` = unset — both needed for a relay-routed `claude -p` child: base URL set, nested-session vars unset), surfaced on `invoke.env` and rendered by the CLI per shell; the task placeholder is never substituted into env values. Distinct from `routing.subagents`, which routes one HTTP turn. **The relay never spawns a `cli` rung** — it owns the order, the host executes. |
| `context-limits.ts` | Context ceilings LEARNED from what a deployment stated when it refused an over-length request (`~/.llm-relay/context-limits.json`). The top rung of `contextWindowResolver` — first-party evidence about the exact deployment, which a published catalogue figure can contradict by being generic or stale. ⚠ **Only an explicitly stated maximum is recorded**: "the request was too long" bounds the ceiling by this proxy's own chars/4 estimate, and a store whose value is that it holds measurements must not accept a guess. Keyed per (provider, model), newest observation wins in either direction, 30-day TTL. |
| `target-facts.ts` | The ONE store for learned facts about targets (`~/.llm-relay/target-facts.json`), each carrying the **scope** it applies to: `deployment` → `group` (explicit member list) → `provider` (the credential) → `model` (cross-provider, reference-grade). Lookups resolve most-specific-first. Kinds: `not-servable` (existence), `subscription-required` (cost), `allowance-exhausted` (temporal), `credential-invalid` (the key). ⚠ The last two only ever DEMOTE — never evict — and any success clears every fact covering that deployment, including provider-scoped ones. |
| `refusal-interpretation.ts` | What a refusal MEANS — deterministic lookup on the request path, judgement strictly out of band. A refusal reduces to a signature (provider + model + message with uuids/ids/numbers/urls stripped); a hit applies, a **miss learns nothing** and queues the signature for offline research. Seeds (reviewed source, derived from first-party probes) bind immediately; a researched verdict binds only once accepted via `llm-relay eligibility`. |
| `host-routing.ts` | Does the CALLING host's traffic reach this relay? `routed` / `bypassed` / `unknown`, decided on the caller's `ANTHROPIC_BASE_URL` (loopback ⇒ routed, so a chain like headroom in front still counts) and never on `CLAUDE_CODE_ENTRYPOINT`, which only names the host in the message. ⚠ Evaluated in the **CLI** process and forwarded as `?host=` — the server cannot detect a bypassing host, because a bypassing host sends it nothing. |
| `claude-hook.ts` | The `PreToolUse(Agent)` hook that delivers `offload claude on` where HTTP rerouting cannot: it denies the `Agent` call and hands back the transposed command. **Forcing function, not a redirect** — no hook can move an in-process subagent's endpoint. Appends alongside the user's own hooks, refuses to rewrite an unparseable `settings.json`, and the generated script fails **open** on every error. |
| `dynamic-pools.ts` | Materializes `{ preferred: [...], include: "free" }` pools as an invariant fixed prefix plus every catalog-discovered free target in benchmark order. Free-provider unknown prices are admitted unless known paid; mixed providers contribute only zero-priced or explicitly free-labelled models. Replaces the tail after catalog refresh so new models need no manual config edits. |
| `candidates.ts` | The un-blended decision table for offload targets (`GET /candidates`). Capability, live health, quota, breaker state and observed traffic as **separate** fields, config order, no ranking. Existing composites are quarantined under `sortInputs`, labelled as what they drive. |
| `server.ts` | The proxy. Request routing, context length guardrails (`estimateRequestTokens`), detect vs repair paths, streaming vs buffered, endpoints (`/v1/messages`, `/v1/messages/count_tokens`, `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/registry`, `/telemetry`, `/ping`, `/health`, `/health/stats`, `/candidates`, `/offload`, `/dispatch`). Front-door paths identify the originating client for offload. **Loopback is not authorization** — the mutating endpoints (`/offload`, `/dispatch`) carry admission checks; see the gotcha below. `buildForwardHeaders()` decides credential containment from the config **declaration** (`credentialState()`), never from key presence. |
| `backend.ts` | `fetchBackend()` → returns an **Anthropic-shaped** `Response` (`anthropic` passthrough, `openai` translation via `llm-bridge`). `fetchOpenAiFront()` → bidirectional OpenAI Chat/Responses adapter: direct OpenAI Chat passthrough, or OpenAI↔Anthropic request/response/SSE translation for the other combinations. Also the wire-shape helpers both paths share: `parseRetryAfterMs()` (both RFC 9110 forms; null, never 0, for garbage) and `normalizeOpenAiErrorBody()` (passes a conforming `{error:{…}}` through byte-exact, unwraps gemini's array envelope, wraps everything else). |
| `validator.ts` | Deterministic Ajv2020 tool_use validator. Verdicts: pass / fail / **uncheckable** (declared tool with no `input_schema`, e.g. built-in `bash`). |
| `reshaper.ts` | The repair model client. Contract: reshaper returns ONLY **corrected inputs per tool_use id** (`{"inputs":{"<id>":{...}}}`); proxy reconstructs + re-validates. `HttpReshaper` (anthropic|openai) + `FailoverReshaper` (ranked candidates from `reshaper: { pool }`; advances on transport failure only — a refusal is returned as-is, never retried elsewhere, and **exhausting every candidate throws `ReshaperTransportError`**, it does not return a refusal). |
| `repair.ts` | Repair orchestrator. Destructive-refusal check → reshape ≤ maxAttempts → re-validate each attempt. `destructiveMatcher()` matches the tool name **exactly** (case-insensitively), with `name*` as an opt-in prefix form; `guardReshaped()` re-checks the reshaped message for destructive calls and for structural conservation (same block count/order, same tool_use `id`+`name`) — an added, dropped or re-pointed call is a contract violation, not a repair. `withEnvelopeOf()` re-attaches the BACKEND's `id`/`model`/`stop_sequence`/`usage` to whatever the reshaper returned — same reasoning as the guard: `Reshaper` is an interface, and a repair changes the tool arguments, never whose answer this is. |
| `sse.ts` | `reconstructFromSse()` — rebuild an AssistantMessage from a captured SSE stream (to validate it). |
| `emitSse.ts` | `emitSse()` / `emitSseTail()` — serialize a (repaired) message back to Anthropic SSE. `emitSseTail` re-emits only trailing blocks (streaming repair). |
| `anthropic.ts` | Minimal Anthropic Messages shapes + `toolSchemaMap()`. Only the fields the proxy inspects. |
| `documents.ts` | `transcodeDocuments()` — Anthropic `document` blocks → markdown text via **MarkItDown** (optional external Python CLI), applied to openai-kind targets before llm-bridge. Refuses (`DocumentError` → 400) rather than letting an unconvertible document through; llm-bridge would stringify it and inject raw base64 into the prompt. Uses a **temp file, not stdin** — pdfminer needs a seekable stream and every piped PDF dies with "No /Root object". |
| `log.ts` | Metadata-only logger (never headers/bodies). "Metadata only" is enforced **at the sink**: `write()` projects each record through the `LOG_FIELDS` allow-list, so a caller that hands over a wider object cannot leak it and a new field is logged only when someone adds it to that list. Log-write failure is swallowed — a full disk is a logging problem, never a request failure. Records the deployment that ANSWERED (`servedProvider`/`servedModel`, required); the model the client asked for is deliberately not a field. |
| `catalog.ts` | Dynamic `/models` catalog cache (`ModelCatalog`) with stale-while-revalidate strategy (`models-cache.json`). Also harvests **per-(provider, model) limits + pricing** via `limitsFromRecord()` — a generic field-alias list (`context_window`/`max_context_length`/…), never a per-provider switch. `limits()` returns null when a provider publishes nothing (NIM), and that null must not be filled with another provider's numbers. |
| `circuit-breaker.ts` | Dynamic failure and rate-limit (HTTP 429) circuit breaker. Orders targets by `getMeasuredStability()`, which returns **null when nothing has been measured** — the mid-band placeholder is applied locally in `getHealthyTargets`, not by an accessor. There is deliberately no scalar `getStabilityScore()`: a `number` return cannot say "unmeasured", so every caller got a plausible score and none could tell a guess from an observation. Credential faults (401/403) are a **separate axis** (`recordCredentialFault` / `hasCredentialFault`) that demotes without tripping and expires, because a revoked key is neither a sick backend nor a healthy one. A 429/503's `Retry-After` sets the cooldown in place of the flat guess. |
| `benchmarks.ts` | Pool ranking. `getStrength()` resolves a target's 0-100 strength from the best evidence available and **reports which**: synced snapshot → observed runtime telemetry (≥5 calls, so one lucky request can't promote a model) → neutral 50. `rankTargetsByBenchmark()` sorts by it (stable, so ties keep config order). The old hardcoded `BENCHMARK_DB` was **deleted in 0.6.0** — every pattern it held was already in the snapshot, so it only contributed a stale provenance-free number that outranked synced data. Don't reintroduce one. |
| `tier-data.ts` | Reads the synced capability snapshot (`docs/tier-data.json`). Memoized on mtime (`npm run sync:tiers` lands without a restart). `findTierModel()` matches a spec's last segment — exact against OpenRouter ids, fuzzy only as a last resort, and it says which. Separate module purely to avoid an import cycle: `config.ts` → `benchmarks.ts` → here, so this must never import `config.ts`. |
| `telemetry.ts` | Aggregates structured live JSON telemetry reports across configured providers. |
| `metadata.ts` | `resolveMetadata()` — per-FIELD limit/price resolution with provenance: the serving provider's own published value (`provider`) → another provider's figure for the same id (`reference`, indicative only) → **null**. There is no hardcoded-table rung: the old blanket 128k/4096 guess was deleted in 0.7.0 because a caller cannot tell a guess from a measurement. Also `estimateRequestTokens()` — the ONE token estimator (guardrail on both fronts + local `count_tokens`; walks `system`/`messages`/`tools` AND the Responses `instructions`/`input`, counts tools, skips base64 — both the Anthropic `data` field and OpenAI's inline `data:` URLs) — and `assessCost()` — the ONE definition of free/paid/unknown (dynamic pool admission + the `freeOnly` guard both resolve through it; `unknown` is its own class and the guard treats it as paid). |
| `kernel/` | Pure contracts + implementation for the **attempt lifecycle** — the typed begin/complete handshake (`AttemptLifecyclePort`, branded `AttemptHandle`, outcome shapes) that `CircuitBreaker` implements and both request paths account through. Depends only on ECMAScript types; `test/kernel-architecture.test.ts` enforces purity and acyclicity. ⚠ A much larger aspirational contract surface (canonical IR, transport/credential/transcoder ports, lease budgets, `tier-snapshot`) lived here unadopted and was **deleted 2026-08-04** — do not rebuild it; see the history note in `contracts.ts` and [docs/suggestion-review-2026-08-04.md](docs/suggestion-review-2026-08-04.md). |
| `routes/admin.ts` | The control-plane endpoints (`/v1/models`, `/registry`, `/ping`, `/health`, `/candidates`, `/offload`, `/dispatch`, `/telemetry`), factored out of `server.ts`. `handleAdminRoutes()` returns true when it handled the request; mutating routes go through the admission checks + control authorization. |
| `control-authorization.ts` | Per-install capability token for control-plane mutations (`POST /offload`, `POST /dispatch`): 256-bit token at `~/.llm-relay/control-token`, timing-safe comparison, atomic single-token convergence for concurrent starters, nothing secret in errors or logs. |
| `request-log.ts` | `baseLog()` (metadata-only log record construction) and `logSafePath()` (query param names + value lengths, never values) — shared by the data plane and admin routes. |
| `self-update.ts` | Version currency: checks npm (cached 6h, 2.5s timeout) before mutating commands; a stale GLOBAL install downloads and replaces itself and re-execs (with a suppression marker against loops); dev/managed installs just get told the upgrade command. |
| `registry.ts` | Assembles composite `/registry` payload combining providers, live models, routing, and leaderboard capability data. Re-exports `loadTierData` from `tier-data.ts`. `joinCapability()` reports `match: exact\|fuzzy` + `matched_name` because a substring join can borrow a different SKU's scores (`glm-5.2` → `glm-5.2-max`). |
| `key-checker.ts` | Pre-flight key validator. Providers are checked **concurrently** (a dozen-plus providers checked serially, one of them a dead local daemon, turns a status command into a multi-minute one). A 200 from `/models` is NOT accepted as proof: several providers serve that endpoint publicly, so it is re-probed anonymously, and only a genuine 401/403 there makes it evidence. Otherwise it escalates to an authenticated completion **on a model this config actually routes to that provider** — a catalogue's first entry is often a premium SKU the key legitimately cannot touch. A 401/403 on that probe is compared against the same request sent anonymously: a *different* status proves the key authenticated (the wall is the model's plan), an *identical* one proves nothing and reports `unverified` rather than accusing a working key. |
| `onboarding.ts` | Interactive CLI setup wizard for free provider keys (`~/.llm-relay/.env`). Honours `leave_me_alone` — and ONLY here: a suppressed provider stays visible in `llm-relay keys`, `/registry`, telemetry and `candidates`, because silencing a nudge is not hiding state. Entries matching no known provider are legal on purpose; the list stores the negative space, so validating it against the configured providers would reject its main use case. |
| `setup-claude.ts` | Configuration generator for Claude Desktop (`claude_desktop_config.json`) and Claude CLI wrappers. |
| `ping/cadence.ts` | Adaptive background monitoring loop (`PingLoop`) with dynamic mode transitions (`speed`, `normal`, `slow`, `forced`). |
| `ping/metrics.ts` | Latency statistical calculations (average, p95, jitter, uptime, spike rate) and composite Stability Score calculation (0-100). |
| `ping/ping.ts` | Single probe executor for model latency, status codes, and rate-limit header quota extraction. |
| `ping/probe-cache.ts` | Disk-cached background probe results (`probe-cache.json`) with TTL checks. Each entry keeps a **rolling window of samples** (`MAX_SAMPLES`) plus lifetime `totals` that outlive the window — a scalar `ms`/`code` made p95, jitter and spike rate all restatements of the most recent request. `loadPersistedSamples`/`loadTotals`/`persistedModels` are the read side `cadence.ts` rehydrates from. Under vitest the default path is redirected to a temp dir, because the suite was writing `openai_mock` entries into the user's live health data. |
| `write-behind.ts` | `WriteBehindTimer` — the one debounced write-behind scheduler (short re-armed delay + max-age clock so steady touches can't defer a flush forever), shared by the catalog, probe cache and runtime telemetry instead of three hand-copies. |
| `winenv.ts` | Recovers Windows User/Machine-scope environment variables a **long-running** process never received (a User-scope var enters a process only at start; the relay launches at logon and runs for days). Fills gaps only — the real environment always wins, same contract as `dotenv.ts`. ⚠ Never imports `PATH`: the User scope holds a fragment, and importing it wholesale breaks executable lookup. |
| `ping/quota.ts` | Provider-specific quota balance fetcher (e.g. OpenRouter key auth endpoint). |
| `ping/runtime-telemetry.ts` | Real-world proxy request telemetry storage (`runtime-telemetry.json`) and real-world quality scoring. |

**Request flow:** `handle()` in `server.ts` → `orderByUsability()` → a candidate loop (BOTH paths —
`openAiFrontPath` for the OpenAI front, the inline loop for `/v1/messages`) → `fetchBackend()` →
then either `repairPath` (repair mode, invalid tool call) or `transparentPath` (detect/passthrough). Repair splits into
`repairStreamingPath` (SSE: stream text through, buffer from first tool_use) and
`repairBufferedPath` (non-streamed JSON). The validate/repair layer **always sees Anthropic
Messages** regardless of backend kind — translation is isolated in `backend.ts`.

## Invariants (keep these true)

- **Provider/model agnostic.** No hardcoded provider URLs, models, or keys in `src/`. Everything
  comes from config: `backend.base`, `backend.model`, `backend.kind`, `backend.authEnv` (env var
  NAME, not the key), `backend.authHeader`. NIM/llama in `src/` are doc-comment examples only.
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
- **Persistent storage directory:** Local configurations, keys, and probe caches are persisted under `~/.llm-relay/` (`config.json`, `.env`, `models-cache.json`, `probe-cache.json`, `runtime-telemetry.json`).
- **Hand-built `Config` objects in tests must include** `backend.kind` and
  `repair: { maxAttempts, destructiveTools }`.
- **Commit trailer:** `Co-Authored-By: <the model doing the work> <noreply@anthropic.com>`
  (e.g. `Claude Fable 5`). Name the model that actually authored the change.

## Scripts inventory (`scripts/`)

Per-script purposes and prerequisites: [scripts/CLAUDE.md](scripts/CLAUDE.md) (loads when working
under `scripts/`). The one thing to know from outside that directory: `scripts/*.mjs` import from
`dist/` — **rebuild (`npm run build`) before running any of them** or you'll test stale code.

## Gotchas (things that will bite you)

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
- **Subagent detection uses TWO signals, either sufficient — keep it that way.** `routing.subagents`
  applies when the request carries the documented `x-claude-code-agent-id` header (gateway protocol
  reference: present only on requests from an agent Claude Code spawned in the session, and
  gateways may route on it) **or** `cc_is_subagent=true` in its `system` block (verified against
  2.1.220). Each covers the other's silent failure: the header dies to middleware that filters
  unknown request headers (this relay runs behind one), the marker dies to
  `CLAUDE_CODE_ATTRIBUTION_HEADER=0`, which removes the attribution block that carries it. One
  travels in the headers, the other in the body, so nothing drops both. If both ever go, every
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
  harness's own tools — `Bash`, `BashOutput`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` —
  before the conventional names. ⚠ **User-visible behaviour change:** repairs of malformed `Bash`/
  `Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`BashOutput` calls that used to succeed are now refused
  (`repair: "refused_destructive"`), and calls whose names merely *contain* a pattern
  (`PushNotification`, `ResetZoom`, `ForceRefresh`) are now permitted. An **empty**
  `repair.destructiveTools` refuses nothing — there is no hidden built-in set in `src/`, so
  coverage is always traceable to config.
- **Loopback is not authorization; the mutating endpoints have admission checks.** Any page the
  user visits can POST cross-origin to the listener, and a `text/plain` POST is a CORS *simple
  request* — no preflight. The attacker cannot read the response, but `/offload` rewrites
  `config.json` and `/dispatch` steers the host's lane order, so reads are not the risk. `/offload`
  and `/dispatch` therefore reject a present-but-non-loopback `Origin` (403), require
  `content-type: application/json` on a mutating request (which is what forces a preflight a
  hostile page cannot satisfy), and require a loopback `Host` (closing DNS rebinding). An **absent**
  `Origin` is allowed on purpose — that is what a CLI sends, and the no-restart `llm-relay offload`
  toggle depends on it. There is a test for it; don't "tighten" it into a broken CLI.
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
  ordered live → credential-faulted → cooling. The old `filter(isHealthy)` deleted cooling
  candidates whenever any healthy one remained, so a pool could narrow to one member and then have
  nothing left when that member failed too. Only an unset credential removes a candidate, and that
  happens in `resolveTargets` for a different reason.
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
  went from serviceable to zero survivors in one step. `deployment-eligibility.ts` now records what
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
  injection target — the containment is that a proposal is a 3-class/2-scope enum, signatures are
  keyed per (provider, model) so one provider can never produce a verdict about another, and the
  header carries a COUNT, never the message. Don't trade any of those for convenience.
- **⚠ Never `res.clone()` a backend response on the failover path.** `clone()` tees the body and the
  failover branch cancels the original, so the un-read branch strands the walk and the client gets
  the FIRST candidate's error with the rest of the pool untouched. Read the body where it is already
  being discarded (`discardCandidate()`) or already buffered (the terminal error branches).
  `observeContextLimit` still clones — it is confined to 400/413 and has not been observed to bite,
  but it is the same hazard; don't copy the pattern into a new call site. Three pre-existing 402
  tests caught this, which is what the ≥2-candidate rule in `test/pool-failover.test.ts` is for.
  ⚠ The learned stores are process-global: reset them per test (`resetEligibility` /
  `resetInterpretations`) like the breaker, or one test's refusal demotes another's first candidate.
- **A pool's error is one member's error, so the walk is reported alongside it.** Every walk of ≥2
  candidates carries `x-llm-relay-pool-attempts: "13 tried, 0 served: 4×402, 5×429, 3×403, 1×400"`
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
- **The dispatch ladder decides ORDER, never execution.** `routing.ladder` may name agent CLIs
  (`kind: "cli"`), but `src/` must never spawn one: their quota is client-bound, they run their
  own tool loop, and they return only final text — so a relay that shelled out could never return
  the `tool_use` blocks an HTTP turn owes its caller, and the subagent's granted tools would go
  silently unused. `/dispatch` hands the host a command; the host runs it. Keep it that way.
- **Never use `routing.tiers` as an accidental subagent switch.** A subagent asking for `haiku` and a
  human picking Haiku are byte-identical requests. Keep the destination map in `routing.subagents`
  and use the originating client's explicit `routing.offload` scope; `scope: "all"` is the deliberate
  choice when a full conversation should move too. Full reasoning: [docs/subagent-routing.md](docs/subagent-routing.md).

## Status & open work

**Nothing is pending in the code.** (Re-verified 2026-08-04 after the goals review: the
half-adopted kernel contract surface — the one open item this line previously missed — was
resolved by deletion; what remains of `src/kernel/` is fully adopted.) A full audit was
remediated to completion and its follow-up list closed in v0.12.0; the audit apparatus, its
artifacts and its handoff doc have all been deleted, because a finished run's ledger is just a
stale to-do list. Anything that mattered from it is a code change, a test, or a paragraph in
this file. The 2026-07-30 pool-failover symptoms are likewise fixed and closed — see
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
(`credentialMode`, the OR'd subagent signal), and it carries the verified terms position. Its one
open proposal — **"credentials stay user-operated"** — was **ratified 2026-08-08** into
[docs/project-goals.md](docs/project-goals.md): llm-relay never operates a login, never centrally
proxies subscription traffic, never pools consumer accounts. ⚠ **Decisions made on the strength of
that invariant must be stated out loud** — name it, say what it ruled out, say what was done
instead. A constraint the owner is never told was applied is one they cannot overrule; the same
goes for any project invariant that changes what gets built.

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
(`.github/workflows/ci.yml` runs `npm run check`, which type-checks `src/` AND `test/`) rather than
by a local run only. A real `claude` agentic session completes through the proxy against NIM.
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
`npm run sync:tiers` merges OpenRouter + BFCL + LMArena + Aider into `docs/tier-data.json` and
`getStrength()` ranks pools off it. Source probe results, coverage per source, and why EvalPlus /
HF Open LLM / LiveCodeBench were rejected: [docs/capability-sources.md](docs/capability-sources.md).

Best-known backend model on NIM: **`z-ai/glm-5.2`** (trip rate 0 across the scenario set; it topped
the then-`coding` pool by synced strength, 4 signals — pools are effort-tiered now, see
`config.example.json`). `llama-3.1-8b` trips 25% of calls and the reshaper
fixes ~2/3 of those — the proxy's use case.

Durable project state also lives in agent memory (`project-repair-proxy`).
