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
npm test               # vitest run  (currently 217 tests / 26 files)
npm run typecheck      # tsc --noEmit  (excludes test/*.ts — vitest is what checks those)
npm run dev -- --config config.json   # run from src via tsx, no build
npm run sync:tiers     # regenerate docs/tier-data.json (shipped in the published package)

npx vitest run test/repair.test.ts             # one file
npx vitest run -t "refuses destructive"        # one test by name
```
**Always verify green before AND after a change:** `npm run build && npm test && npm run typecheck`.

**Releasing: use the `/release` skill** ([.claude/skills/release/SKILL.md](.claude/skills/release/SKILL.md)).
Publishing happens in GitHub Actions via npm **Trusted Publishing**, triggered by pushing a `v*`
tag — a local `npm publish` has no credentials and fails with a misleading 404.

## Architecture — file → responsibility (all in `src/`)

| File | Responsibility |
|---|---|
| `cli.ts` | Entry point. Parses flags (`--config`, `--default`, `--mode`, `--listen`, `--provider`, `--refresh`) and dispatches commands (`onboard`, `setup`, `keys`, `telemetry`, `models`, `ping`, `offload`, `candidates`). `offload`/`candidates` talk to a **running** proxy over loopback when there is one, so a toggle takes effect without a restart and the table gets warm health data. |
| `authEnv.ts` | Resolves a provider's declared `authEnv` name against a **closed** per-provider alias list (`GEMINI_API_KEY` vs `GOOGLE_API_KEY`, …). Deliberately never scans the env for key-shaped names — a heuristic match would ship one provider's credential to another's endpoint. |
| `presets.ts` | `FREE_PROVIDER_PRESETS` — built-in free/subscription provider definitions (base, kind, authEnv, signup URL, recommended models) used by onboarding and setup. |
| `config.ts` | Load/validate config. `${ENV}` expansion, loopback enforcement, multi-candidate tier specs (`string | string[]`), **`pool/<name>` routing** (`routing.pools`; `pool` is a reserved provider name; an unknown pool is a loud `RoutingError`, never a silent fall-through to `routing.default`), **subagent-aware routing** (`isSubagentRequest` reads the `cc_is_subagent=true` marker Claude Code stamps into `system`; `subagentSpec` applies `routing.subagents` — **only when `routing.offload` is on, default false** — or an `@relay:` directive read ONLY from the last text block of `messages[0]`, which works with the switch off), reshaper auto-synthesis. |
| `offload.ts` | The subagent-offload switch. `setOffload()` mutates the **live** `Config` (so the next request routes the new way with no restart) and rewrites only `routing.offload` in the file it was loaded from. Never throws — an unpersistable change still applies in memory and reports `persisted:false`. |
| `candidates.ts` | The un-blended decision table for offload targets (`GET /candidates`). Capability, live health, quota, breaker state and observed traffic as **separate** fields, config order, no ranking. Existing composites are quarantined under `sortInputs`, labelled as what they drive. |
| `server.ts` | The proxy. Request routing, context length guardrails (`estimateRequestTokens`), detect vs repair paths, streaming vs buffered, endpoints (`/v1/messages`, `/v1/chat/completions`, `/registry`, `/telemetry`, `/ping`, `/health`). |
| `backend.ts` | `fetchBackend()` → returns an **Anthropic-shaped** `Response` (`anthropic` passthrough, `openai` translation via `llm-bridge`). `fetchOpenAiFront()` → OpenAI-compatible reverse proxy. |
| `validator.ts` | Deterministic Ajv2020 tool_use validator. Verdicts: pass / fail / **uncheckable** (declared tool with no `input_schema`, e.g. built-in `bash`). |
| `reshaper.ts` | The repair model client. Contract: reshaper returns ONLY **corrected inputs per tool_use id** (`{"inputs":{"<id>":{...}}}`); proxy reconstructs + re-validates. `HttpReshaper` (anthropic|openai) + `FailoverReshaper` (ranked candidates from `reshaper: { pool }`; advances on transport failure only — a refusal is returned as-is, never retried elsewhere). |
| `repair.ts` | Repair orchestrator. Destructive-refusal check → reshape ≤ maxAttempts → re-validate each attempt. |
| `sse.ts` | `reconstructFromSse()` — rebuild an AssistantMessage from a captured SSE stream (to validate it). |
| `emitSse.ts` | `emitSse()` / `emitSseTail()` — serialize a (repaired) message back to Anthropic SSE. `emitSseTail` re-emits only trailing blocks (streaming repair). |
| `anthropic.ts` | Minimal Anthropic Messages shapes + `toolSchemaMap()`. Only the fields the proxy inspects. |
| `documents.ts` | `transcodeDocuments()` — Anthropic `document` blocks → markdown text via **MarkItDown** (optional external Python CLI), applied to openai-kind targets before llm-bridge. Refuses (`DocumentError` → 400) rather than letting an unconvertible document through; llm-bridge would stringify it and inject raw base64 into the prompt. Uses a **temp file, not stdin** — pdfminer needs a seekable stream and every piped PDF dies with "No /Root object". |
| `log.ts` | Metadata-only logger (never headers/bodies). |
| `catalog.ts` | Dynamic `/models` catalog cache (`ModelCatalog`) with stale-while-revalidate strategy (`models-cache.json`). Also harvests **per-(provider, model) limits + pricing** via `limitsFromRecord()` — a generic field-alias list (`context_window`/`max_context_length`/…), never a per-provider switch. `limits()` returns null when a provider publishes nothing (NIM), and that null must not be filled with another provider's numbers. |
| `circuit-breaker.ts` | Dynamic failure and rate-limit (HTTP 429) circuit breaker. Sorts targets by Stability Score. |
| `benchmarks.ts` | Pool ranking. `getStrength()` resolves a target's 0-100 strength from the best evidence available and **reports which**: synced snapshot → observed runtime telemetry (≥5 calls, so one lucky request can't promote a model) → neutral 50. `rankTargetsByBenchmark()` sorts by it (stable, so ties keep config order). The old hardcoded `BENCHMARK_DB` was **deleted in 0.6.0** — every pattern it held was already in the snapshot, so it only contributed a stale provenance-free number that outranked synced data. Don't reintroduce one. |
| `tier-data.ts` | Reads the synced capability snapshot (`docs/tier-data.json`). Memoized on mtime (`npm run sync:tiers` lands without a restart). `findTierModel()` matches a spec's last segment — exact against OpenRouter ids, fuzzy only as a last resort, and it says which. Separate module purely to avoid an import cycle: `config.ts` → `benchmarks.ts` → here, so this must never import `config.ts`. |
| `telemetry.ts` | Aggregates structured live JSON telemetry reports across configured providers. |
| `metadata.ts` | `resolveMetadata()` — per-FIELD limit/price resolution with provenance: the serving provider's own published value → another provider's figure for the same id (`reference`, indicative only) → the hardcoded table (`static-table`, including its blanket 128k/4096 guess). Price has no table rung: unknown cost stays null rather than becoming a guess. `getModelMetadata()` is the legacy raw-table lookup — prefer the resolver. |
| `registry.ts` | Assembles composite `/registry` payload combining providers, live models, routing, and leaderboard capability data. Re-exports `loadTierData` from `tier-data.ts`. `joinCapability()` reports `match: exact\|fuzzy` + `matched_name` because a substring join can borrow a different SKU's scores (`glm-5.2` → `glm-5.2-max`). |
| `key-checker.ts` | Pre-flight validator checking provider API key health and remaining rate-limit quota percentages. |
| `onboarding.ts` | Interactive CLI setup wizard for free provider keys (`~/.llm-relay/.env`). |
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
- **Loopback only.** Startup refuses a non-loopback bind (it holds a provider key, does no auth).
- **Logs are metadata only** — never request/response headers or bodies.
- **Destructive tool calls are refused, never fabricated** (repair output may run under
  `--dangerously-skip-permissions`). Unrepairable → fail-clean (502, or a mid-stream SSE `error`).
- **Persistent storage directory:** Local configurations, keys, and probe caches are persisted under `~/.llm-relay/` (`config.json`, `.env`, `models-cache.json`, `probe-cache.json`, `runtime-telemetry.json`).
- **Hand-built `Config` objects in tests must include** `backend.kind` and
  `repair: { maxAttempts, destructiveTools }`.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Scripts inventory (`scripts/`)

Offline / unit-test-safe (no external creds):
- `live-demo.mjs` — runs the compiled CLI against a local flaky backend + stub reshaper. Good smoke test.

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

- **Worktrees.** Work may happen in a git worktree under `.claude/worktrees/…`. Edit and run
  tests **in the worktree path**, not the main checkout — they have separate working trees. vitest
  run from the wrong root will silently pick up the other copy's `src/`.
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
  keep the `provider` / `reference` / `static-table` label. Tests in `test/metadata.test.ts` pin
  this, including that an unknown price stays null instead of being guessed.
- **Capability data is synced, never typed.** Add a source by writing a fetcher in
  `scripts/sync-tiers.mjs`, not a row in `BENCHMARK_DB`. Sources are independently failable — one
  dead endpoint must not cost the others — but **schema drift inside a source still throws** (a
  renamed column is corruption, not absence). Zero working sources is fatal. Coverage probe results
  and the reasons three sources were rejected: [docs/capability-sources.md](docs/capability-sources.md).
- **A source's absence is not a low score.** Models are never penalised for signals nobody
  publishes; `signal_count` travels with the score instead, so a 1-source guess and a 5-source
  consensus are distinguishable. Don't "fix" a sparse row by defaulting it to zero.
- **Never route subagents by editing `routing.tiers`.** A subagent asking for `haiku` and a human
  picking Haiku are byte-identical requests, so a tier→provider mapping silently drops the human's
  own conversation onto a weak model. Tiers stay on the passthrough; `routing.subagents` is the
  only correct place. Full reasoning: [docs/subagent-routing.md](docs/subagent-routing.md).

## Status & open work

Current: **usable end-to-end**, 217 tests green, tsc clean. A real `claude` agentic session
completes through the proxy against NIM. Full assessment: [docs/fcc-replacement-assessment.md](docs/fcc-replacement-assessment.md).

**Subagent offload is live but OPT-IN** (0.3.0; switched off by default in 0.4.0): a Claude Code
subagent — including built-ins like Explore, with no agent file — runs on a non-Anthropic provider
while the human's own conversation stays on an Anthropic passthrough. Verified end-to-end on the
wire. Turn it on with `llm-relay offload on` (no restart); choose a target with `llm-relay
candidates`. Design + evidence: [docs/subagent-routing.md](docs/subagent-routing.md).

Full live probe sweep: [docs/probe-sweep-2026-07-28.md](docs/probe-sweep-2026-07-28.md) (every script,
every endpoint). Everything it found is now fixed; `multimodal-probe.mjs` is 5/5 green live.

**Capability ranking now lives here** (0.5.0), no longer deferred to the router/auditor project:
`npm run sync:tiers` merges OpenRouter + BFCL + LMArena + Aider into `docs/tier-data.json` and
`getStrength()` ranks pools off it. Source probe results, coverage per source, and why EvalPlus /
HF Open LLM / LiveCodeBench were rejected: [docs/capability-sources.md](docs/capability-sources.md).
Older background research: [docs/model-capability-ranking-sources.md](docs/model-capability-ranking-sources.md).

Best-known backend model on NIM: **`z-ai/glm-5.2`** (trip rate 0 across the scenario set; top of the
`coding` pool by synced strength, 4 signals). `llama-3.1-8b` trips 25% of calls and the reshaper
fixes ~2/3 of those — the proxy's use case.

Durable project state also lives in agent memory (`project-repair-proxy`).
