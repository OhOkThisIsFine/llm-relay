# CLAUDE.md — llm-relay (agent orientation)

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read this first. It's the map; [README.md](README.md) is the user-facing usage guide.

## What this is

A standalone, **loopback-only** reverse proxy for the Anthropic `/v1/messages` API. A client
(the `claude` CLI, or anything that honors `ANTHROPIC_BASE_URL`) points at it; it forwards to a
configured backend model and **validates + repairs the model's tool calls**, so the Claude Code
harness can run on non-Anthropic models that are weaker at tool-use.

**The one boundary — do not cross it:** the proxy fixes/flags *protocol form* (malformed tool
calls), never *judgment* (bad reasoning). It repairs a tool call whose args violate the schema;
it does not invent intent, and it refuses to fabricate destructive-tool calls.

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

**CI** (`.github/workflows/ci.yml`) runs `npm ci --ignore-scripts` → `npm run build` →
`npm run check` on every push to `main` and every PR, plus a check that the `postinstall` hook stays
inert on a non-global install. Before this existed, `typecheck` ran in **no** workflow and the suite
ran only inside the publish job — i.e. first at the moment a version was already shipping, so every
"tsc clean / suite green" claim in this repo rested on somebody's unverifiable local run.

**Releasing: use the `/release` skill** ([.claude/skills/release/SKILL.md](.claude/skills/release/SKILL.md)).
Publishing happens in GitHub Actions via npm **Trusted Publishing** — there is no npm token here, so
the *trigger* is the credential. A local `npm publish` has no credentials and fails with a misleading
404. `.github/workflows/publish.yml` now stands four gates between a tag and the registry:

1. a job-level `if` — this repository only, ref under `refs/tags/v*`;
2. `environment: npm-publish`; its protection rules live in **repo settings** (Settings →
   Environments → npm-publish), not in the workflow, and GitHub auto-creates the environment with
   **no** rules. It now carries a **custom deployment branch policy limiting it to the `v*` tag
   pattern** (`gh api repos/OhOkThisIsFine/llm-relay/environments/npm-publish/deployment-branch-policies`
   to inspect), so the ref restriction is enforced by the platform and not only by the workflow's
   own `if`. No required reviewer — a release stays one command, by the owner's decision;
3. the tag's commit must be **contained in the default branch**;
4. the tag must **match `package.json`'s version** — an npm mistake is permanent.

The `release: published` trigger was **removed**: it was a second independent path to the registry
that also double-fired for a release cut from a tag. Actions are pinned to commit SHAs.

## Architecture — file → responsibility (all in `src/`)

| File | Responsibility |
|---|---|
| `cli.ts` | Entry point. Parses flags (`--config`, `--default`, `--mode`, `--listen`, `--provider`, `--refresh`) and dispatches commands (`onboard`, `setup`, `keys`, `telemetry`, `models`, `ping`, `offload`, `candidates`). `offload`/`candidates` talk to a **running** proxy over loopback when there is one, so a toggle takes effect without a restart and the table gets warm health data. |
| `dotenv.ts` | Loads `~/.llm-relay/.env` into `process.env` at startup, **never overwriting an already-set variable**. `onboard` always wrote this file and nothing ever read it, so a wizard-saved key worked for one shell and then "stopped working". The real environment wins because it is the more explicit signal. |
| `pool-health.ts` | `llm-relay pools --probe` — sends a REAL completion to every pool member. Config-time validation cannot see a model that is listed and still dead (de-listed behind the scenes, gated to a paid tier, routed to a missing function), and that is exactly how a pool ends up with one live member and paper failover. Probes at 400 max_tokens because reasoning models return an empty 200 at a low cap — `empty` is a distinct verdict from `missing`, not a synonym. |
| `authEnv.ts` | Resolves a provider's declared `authEnv` name against a **closed** per-provider alias list (`GEMINI_API_KEY` vs `GOOGLE_API_KEY`, …). Deliberately never scans the env for key-shaped names — a heuristic match would ship one provider's credential to another's endpoint. |
| `presets.ts` | `FREE_PROVIDER_PRESETS` — built-in free/subscription provider definitions (base, kind, authEnv, signup URL, recommended models) used by onboarding and setup. |
| `config.ts` | Load/validate config. `${ENV}` expansion, loopback enforcement, multi-candidate tier specs (`string | string[]`), **`pool/<name>` routing** (`routing.pools`; `pool` is a reserved provider name; an unknown pool is a loud `RoutingError`, never a silent fall-through to `routing.default`), **subagent-aware routing** (`isSubagentRequest` reads the `cc_is_subagent=true` marker Claude Code stamps into `system`; `subagentSpec` applies `routing.subagents` — **only when `routing.offload` is on, default false** — or an `@relay:` directive read ONLY from the last text block of `messages[0]`, which works with the switch off), reshaper auto-synthesis. Also `leave_me_alone` — the onboarding-nudge suppression list, whose entries are deliberately NOT validated against the known providers (see `onboarding.ts`). |
| `offload.ts` | The subagent-offload switch. `setOffload()` mutates the **live** `Config` (so the next request routes the new way with no restart) and rewrites only `routing.offload` in the file it was loaded from. Never throws — an unpersistable change still applies in memory and reports `persisted:false`. |
| `dispatch.ts` | The dispatch ladder (`GET/POST /dispatch`, `llm-relay dispatch`) — which LANE a host should hand a whole delegated task to, in order, with host override (`?lane=`), walk-past (`?after=`) and host-reported exhaustion (`POST {"exhausted"}`). Distinct from `routing.subagents`, which routes one HTTP turn. **The relay never spawns a `cli` rung** — it owns the order, the host executes. Exhaustion is host-reported for every rung kind because the relay cannot see a CLI's credit balance, and a `quota` bucket cools sibling rungs together (one binary can meter two independent balances — cooling both would skip a live lane). |
| `candidates.ts` | The un-blended decision table for offload targets (`GET /candidates`). Capability, live health, quota, breaker state and observed traffic as **separate** fields, config order, no ranking. Existing composites are quarantined under `sortInputs`, labelled as what they drive. |
| `server.ts` | The proxy. Request routing, context length guardrails (`estimateRequestTokens`), detect vs repair paths, streaming vs buffered, endpoints (`/v1/messages`, `/v1/chat/completions`, `/registry`, `/telemetry`, `/ping`, `/health`, `/candidates`, `/offload`, `/dispatch`). **Loopback is not authorization** — the mutating endpoints (`/offload`, `/dispatch`) carry admission checks; see the gotcha below. `buildForwardHeaders()` decides credential containment from the config **declaration** (`credentialState()`), never from key presence. |
| `backend.ts` | `fetchBackend()` → returns an **Anthropic-shaped** `Response` (`anthropic` passthrough, `openai` translation via `llm-bridge`). `fetchOpenAiFront()` → OpenAI-compatible reverse proxy. |
| `validator.ts` | Deterministic Ajv2020 tool_use validator. Verdicts: pass / fail / **uncheckable** (declared tool with no `input_schema`, e.g. built-in `bash`). |
| `reshaper.ts` | The repair model client. Contract: reshaper returns ONLY **corrected inputs per tool_use id** (`{"inputs":{"<id>":{...}}}`); proxy reconstructs + re-validates. `HttpReshaper` (anthropic|openai) + `FailoverReshaper` (ranked candidates from `reshaper: { pool }`; advances on transport failure only — a refusal is returned as-is, never retried elsewhere, and **exhausting every candidate throws `ReshaperTransportError`**, it does not return a refusal). |
| `repair.ts` | Repair orchestrator. Destructive-refusal check → reshape ≤ maxAttempts → re-validate each attempt. `destructiveMatcher()` matches the tool name **exactly** (case-insensitively), with `name*` as an opt-in prefix form; `guardReshaped()` re-checks the reshaped message for destructive calls and for structural conservation (same block count/order, same tool_use `id`+`name`) — an added, dropped or re-pointed call is a contract violation, not a repair. `withEnvelopeOf()` re-attaches the BACKEND's `id`/`model`/`stop_sequence`/`usage` to whatever the reshaper returned — same reasoning as the guard: `Reshaper` is an interface, and a repair changes the tool arguments, never whose answer this is. |
| `sse.ts` | `reconstructFromSse()` — rebuild an AssistantMessage from a captured SSE stream (to validate it). |
| `emitSse.ts` | `emitSse()` / `emitSseTail()` — serialize a (repaired) message back to Anthropic SSE. `emitSseTail` re-emits only trailing blocks (streaming repair). |
| `anthropic.ts` | Minimal Anthropic Messages shapes + `toolSchemaMap()`. Only the fields the proxy inspects. |
| `documents.ts` | `transcodeDocuments()` — Anthropic `document` blocks → markdown text via **MarkItDown** (optional external Python CLI), applied to openai-kind targets before llm-bridge. Refuses (`DocumentError` → 400) rather than letting an unconvertible document through; llm-bridge would stringify it and inject raw base64 into the prompt. Uses a **temp file, not stdin** — pdfminer needs a seekable stream and every piped PDF dies with "No /Root object". |
| `log.ts` | Metadata-only logger (never headers/bodies). "Metadata only" is enforced **at the sink**: `write()` projects each record through the `LOG_FIELDS` allow-list, so a caller that hands over a wider object cannot leak it and a new field is logged only when someone adds it to that list. Log-write failure is swallowed — a full disk is a logging problem, never a request failure. Records the deployment that ANSWERED (`servedProvider`/`servedModel`, required); the model the client asked for is deliberately not a field. |
| `catalog.ts` | Dynamic `/models` catalog cache (`ModelCatalog`) with stale-while-revalidate strategy (`models-cache.json`). Also harvests **per-(provider, model) limits + pricing** via `limitsFromRecord()` — a generic field-alias list (`context_window`/`max_context_length`/…), never a per-provider switch. `limits()` returns null when a provider publishes nothing (NIM), and that null must not be filled with another provider's numbers. |
| `circuit-breaker.ts` | Dynamic failure and rate-limit (HTTP 429) circuit breaker. Orders targets by `getMeasuredStability()`, which returns **null when nothing has been measured** — the mid-band placeholder is applied locally in `getHealthyTargets`, not by an accessor. There is deliberately no scalar `getStabilityScore()`: a `number` return cannot say "unmeasured", so every caller got a plausible score and none could tell a guess from an observation. |
| `benchmarks.ts` | Pool ranking. `getStrength()` resolves a target's 0-100 strength from the best evidence available and **reports which**: synced snapshot → observed runtime telemetry (≥5 calls, so one lucky request can't promote a model) → neutral 50. `rankTargetsByBenchmark()` sorts by it (stable, so ties keep config order). The old hardcoded `BENCHMARK_DB` was **deleted in 0.6.0** — every pattern it held was already in the snapshot, so it only contributed a stale provenance-free number that outranked synced data. Don't reintroduce one. |
| `tier-data.ts` | Reads the synced capability snapshot (`docs/tier-data.json`). Memoized on mtime (`npm run sync:tiers` lands without a restart). `findTierModel()` matches a spec's last segment — exact against OpenRouter ids, fuzzy only as a last resort, and it says which. Separate module purely to avoid an import cycle: `config.ts` → `benchmarks.ts` → here, so this must never import `config.ts`. |
| `telemetry.ts` | Aggregates structured live JSON telemetry reports across configured providers. |
| `metadata.ts` | `resolveMetadata()` — per-FIELD limit/price resolution with provenance: the serving provider's own published value (`provider`) → another provider's figure for the same id (`reference`, indicative only) → **null**. There is no hardcoded-table rung: the old blanket 128k/4096 guess was deleted in 0.7.0 because a caller cannot tell a guess from a measurement. Plus `estimateRequestTokens()`. |
| `registry.ts` | Assembles composite `/registry` payload combining providers, live models, routing, and leaderboard capability data. Re-exports `loadTierData` from `tier-data.ts`. `joinCapability()` reports `match: exact\|fuzzy` + `matched_name` because a substring join can borrow a different SKU's scores (`glm-5.2` → `glm-5.2-max`). |
| `key-checker.ts` | Pre-flight key validator. Providers are checked **concurrently** (a dozen-plus providers checked serially, one of them a dead local daemon, turns a status command into a multi-minute one). A 200 from `/models` is NOT accepted as proof: several providers serve that endpoint publicly, so it is re-probed anonymously, and only a genuine 401/403 there makes it evidence. Otherwise it escalates to an authenticated completion **on a model this config actually routes to that provider** — a catalogue's first entry is often a premium SKU the key legitimately cannot touch. A 401/403 on that probe is compared against the same request sent anonymously: a *different* status proves the key authenticated (the wall is the model's plan), an *identical* one proves nothing and reports `unverified` rather than accusing a working key. |
| `onboarding.ts` | Interactive CLI setup wizard for free provider keys (`~/.llm-relay/.env`). Honours `leave_me_alone` — and ONLY here: a suppressed provider stays visible in `llm-relay keys`, `/registry`, telemetry and `candidates`, because silencing a nudge is not hiding state. Entries matching no known provider are legal on purpose; the list stores the negative space, so validating it against the configured providers would reject its main use case. |
| `setup-claude.ts` | Configuration generator for Claude Desktop (`claude_desktop_config.json`) and Claude CLI wrappers. |
| `ping/cadence.ts` | Adaptive background monitoring loop (`PingLoop`) with dynamic mode transitions (`speed`, `normal`, `slow`, `forced`). |
| `ping/metrics.ts` | Latency statistical calculations (average, p95, jitter, uptime, spike rate) and composite Stability Score calculation (0-100). |
| `ping/ping.ts` | Single probe executor for model latency, status codes, and rate-limit header quota extraction. |
| `ping/probe-cache.ts` | Disk-cached background probe results (`probe-cache.json`) with TTL checks. |
| `ping/quota.ts` | Provider-specific quota balance fetcher (e.g. OpenRouter key auth endpoint). |
| `ping/runtime-telemetry.ts` | Real-world proxy request telemetry storage (`runtime-telemetry.json`) and real-world quality scoring. |

**Request flow:** `handle()` in `server.ts` → `fetchBackend()` → then either `repairPath` (repair
mode, invalid tool call) or `transparentPath` (detect/passthrough). Repair splits into
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
- **Commit trailer:** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Scripts inventory (`scripts/`)

Offline / unit-test-safe (no external creds):
- `live-demo.mjs` — runs the compiled CLI against a local flaky backend + stub reshaper. Good smoke test.
- `install-skill.mjs` — npm `postinstall` hook: copies `skills/llm-relay/SKILL.md` to
  `~/.claude/skills/llm-relay/` on GLOBAL installs only (env var or global-tree path detection);
  a repo-local `npm install` never touches `~/.claude`. `--force` overrides for manual runs.
  Ships in the package, so the self-updater refreshes the skill on every upgrade.

Need live creds (`NVIDIA_API_KEY` + `LLM_BACKEND_BASE_URL`, or any OpenAI-compatible provider):
- `nim-front.mjs` — run the compiled proxy fronting a live backend end-to-end.
- `nim-probe.mjs` / `nim-repair.mjs` — one-off tool-call fidelity + repair probes.
- `nim-trip-rate.mjs` — the trip-rate dataset harness (models × schemas × trials → `docs/nim-trip-rate.*`).
- `agentic-loop-probe.mjs` — drives a full agentic STEP (tool_use → tool_result → answer) through a **running** proxy. The end-to-end proof.
- `verify-live-features.mjs` — boots the proxy on a temp config against live NIM and exercises the runtime endpoints (`/registry`, `/telemetry`, `/ping`, …).
- `multimodal-probe.mjs` — image / PDF / MCP-block passthrough through the Anthropic→OpenAI translation. Needs a **running** proxy pointed at a vision model (`PROXY=... node scripts/multimodal-probe.mjs`).

Needs network (no provider key):
- `sync-tiers.mjs` (`npm run sync:tiers`) — snapshots **OpenRouter** (Artificial Analysis intelligence/coding/agentic indices, Design Arena Elo, context length, pricing, tool support — and the only source whose ids match our routing specs exactly), **BFCL** (tool-use accuracy), **LMArena** (general) and **Aider polyglot** (edit benchmark + edit-format compliance) into `docs/tier-data.json` (~770 models). Each source is independently failable and records a warning; schema drift inside a source still throws loudly — don't "fix" that by softening the check. Zero working sources is fatal.

Usage wrappers (for pointing a real `claude` CLI at a running proxy):
- `claude-proxied.ps1` / `claude-proxied.sh` — see README "Use it from your projects".

`scripts/*.mjs` import from `dist/` — **rebuild (`npm run build`) before running them** or you'll
test stale code.

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
- **Subagent routing depends on a Claude Code client behaviour, not an API contract.**
  `routing.subagents` only applies when the request carries `cc_is_subagent=true` in its `system`
  block (verified against Claude Code 2.1.220). If a Claude Code upgrade drops that marker, every
  subagent silently falls back to normal routing — safe (passthrough) but **silent**, so nothing
  will alert you. Re-verify with the capture recipe in
  [docs/subagent-routing.md](docs/subagent-routing.md#re-verifying).
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
  Do not re-derive this from `resolveAuthEnv()` returning a name: the anthropic alias list holds
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, so a provider with **no** declared `authEnv` still
  resolves to a name whenever either is set — which would invert the one behaviour a passthrough
  exists to provide.
- **The breaker records failure on EVERY retriable error response (429/5xx/400/404),** including
  on the last candidate — `test/server.test.ts` "circuit breaker accounting" pins that a
  single-candidate 429 is never recorded as a success.
- **Offload is off by default and an absent `routing.offload` is false.** Don't "helpfully" default
  it on when a `subagents` map exists — that was the 0.3.x behaviour and it silently changed which
  vendor answered every built-in subagent. Two tests pin this (`test/config.test.ts` "offload
  defaults to OFF", `test/offload.test.ts` "flips routing for the NEXT request").
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
  invented from a number we made up is worse than a true upstream error.
- **Capability data is synced, never typed.** Add a source by writing a fetcher in
  `scripts/sync-tiers.mjs`, not a row in `BENCHMARK_DB`. Sources are independently failable — one
  dead endpoint must not cost the others — but **schema drift inside a source still throws** (a
  renamed column is corruption, not absence). Zero working sources is fatal. Coverage probe results
  and the reasons three sources were rejected: [docs/capability-sources.md](docs/capability-sources.md).
- **A source's absence is not a low score.** Models are never penalised for signals nobody
  publishes; `signal_count` travels with the score instead, so a 1-source guess and a 5-source
  consensus are distinguishable. Don't "fix" a sparse row by defaulting it to zero.
- **The dispatch ladder decides ORDER, never execution.** `routing.ladder` may name agent CLIs
  (`kind: "cli"`), but `src/` must never spawn one: their quota is client-bound, they run their
  own tool loop, and they return only final text — so a relay that shelled out could never return
  the `tool_use` blocks an HTTP turn owes its caller, and the subagent's granted tools would go
  silently unused. `/dispatch` hands the host a command; the host runs it. Keep it that way.
- **Never route subagents by editing `routing.tiers`.** A subagent asking for `haiku` and a human
  picking Haiku are byte-identical requests, so a tier→provider mapping silently drops the human's
  own conversation onto a weak model. Tiers stay on the passthrough; `routing.subagents` is the
  only correct place. Full reasoning: [docs/subagent-routing.md](docs/subagent-routing.md).

## Status & open work

**Nothing is pending.** A full audit was remediated to completion and its follow-up list closed in
v0.12.0; the audit apparatus, its artifacts and its handoff doc have all been deleted, because a
finished run's ledger is just a stale to-do list. Anything that mattered from it is a code change,
a test, or a paragraph in this file.

⚠ One durable lesson from it, because it will cost you an hour otherwise: **several tests in this
repo were written to pin the defect they should have caught.** A correct fix here can legitimately
turn the suite red — read the failing test's stated reasoning before assuming your change is wrong,
and change the test in the SAME commit as the source fix.

Current: **usable end-to-end**, suite green, tsc clean — and verified by CI
(`.github/workflows/ci.yml` runs `npm run check`, which type-checks `src/` AND `test/`) rather than
by a local run only. A real `claude` agentic session completes through the proxy against NIM. Full
assessment: [docs/fcc-replacement-assessment.md](docs/fcc-replacement-assessment.md).

**Subagent offload is live but OPT-IN** (0.3.0; switched off by default in 0.4.0): a Claude Code
subagent — including built-ins like Explore, with no agent file — runs on a non-Anthropic provider
while the human's own conversation stays on an Anthropic passthrough. Verified end-to-end on the
wire. Turn it on with `llm-relay offload on` (no restart); choose a target with `llm-relay
candidates`. Design + evidence: [docs/subagent-routing.md](docs/subagent-routing.md).

Every script in `scripts/` and every proxy endpoint has been exercised live against NIM;
`multimodal-probe.mjs` is 5/5 green.

**Capability ranking now lives here** (0.5.0), no longer deferred to the router/auditor project:
`npm run sync:tiers` merges OpenRouter + BFCL + LMArena + Aider into `docs/tier-data.json` and
`getStrength()` ranks pools off it. Source probe results, coverage per source, and why EvalPlus /
HF Open LLM / LiveCodeBench were rejected: [docs/capability-sources.md](docs/capability-sources.md).

Best-known backend model on NIM: **`z-ai/glm-5.2`** (trip rate 0 across the scenario set; top of the
`coding` pool by synced strength, 4 signals). `llama-3.1-8b` trips 25% of calls and the reshaper
fixes ~2/3 of those — the proxy's use case.

Durable project state also lives in agent memory (`project-repair-proxy`).
