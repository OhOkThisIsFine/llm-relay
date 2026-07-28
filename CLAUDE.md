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
npm test               # vitest run  (currently 175 tests / 25 files)
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
| `cli.ts` | Entry point. Parses flags (`--config`, `--default`, `--mode`, `--listen`, `--provider`, `--refresh`) and dispatches commands (`onboard`, `setup`, `keys`, `telemetry`, `models`, `ping`). |
| `authEnv.ts` | Resolves a provider's declared `authEnv` name against a **closed** per-provider alias list (`GEMINI_API_KEY` vs `GOOGLE_API_KEY`, …). Deliberately never scans the env for key-shaped names — a heuristic match would ship one provider's credential to another's endpoint. |
| `presets.ts` | `FREE_PROVIDER_PRESETS` — built-in free/subscription provider definitions (base, kind, authEnv, signup URL, recommended models) used by onboarding and setup. |
| `config.ts` | Load/validate config. `${ENV}` expansion, loopback enforcement, multi-candidate tier specs (`string | string[]`), **`pool/<name>` routing** (`routing.pools`; `pool` is a reserved provider name; an unknown pool is a loud `RoutingError`, never a silent fall-through to `routing.default`), reshaper auto-synthesis. |
| `server.ts` | The proxy. Request routing, context length guardrails (`estimateRequestTokens`), detect vs repair paths, streaming vs buffered, endpoints (`/v1/messages`, `/v1/chat/completions`, `/registry`, `/telemetry`, `/ping`, `/health`). |
| `backend.ts` | `fetchBackend()` → returns an **Anthropic-shaped** `Response` (`anthropic` passthrough, `openai` translation via `llm-bridge`). `fetchOpenAiFront()` → OpenAI-compatible reverse proxy. |
| `validator.ts` | Deterministic Ajv2020 tool_use validator. Verdicts: pass / fail / **uncheckable** (declared tool with no `input_schema`, e.g. built-in `bash`). |
| `reshaper.ts` | The repair model client. Contract: reshaper returns ONLY **corrected inputs per tool_use id** (`{"inputs":{"<id>":{...}}}`); proxy reconstructs + re-validates. `HttpReshaper` (anthropic|openai). |
| `repair.ts` | Repair orchestrator. Destructive-refusal check → reshape ≤ maxAttempts → re-validate each attempt. |
| `sse.ts` | `reconstructFromSse()` — rebuild an AssistantMessage from a captured SSE stream (to validate it). |
| `emitSse.ts` | `emitSse()` / `emitSseTail()` — serialize a (repaired) message back to Anthropic SSE. `emitSseTail` re-emits only trailing blocks (streaming repair). |
| `anthropic.ts` | Minimal Anthropic Messages shapes + `toolSchemaMap()`. Only the fields the proxy inspects. |
| `documents.ts` | `transcodeDocuments()` — Anthropic `document` blocks → markdown text via **MarkItDown** (optional external Python CLI), applied to openai-kind targets before llm-bridge. Refuses (`DocumentError` → 400) rather than letting an unconvertible document through; llm-bridge would stringify it and inject raw base64 into the prompt. Uses a **temp file, not stdin** — pdfminer needs a seekable stream and every piped PDF dies with "No /Root object". |
| `log.ts` | Metadata-only logger (never headers/bodies). |
| `catalog.ts` | Dynamic `/models` catalog cache (`ModelCatalog`) with stale-while-revalidate strategy (`models-cache.json`). |
| `circuit-breaker.ts` | Dynamic failure and rate-limit (HTTP 429) circuit breaker. Sorts targets by Stability Score. |
| `benchmarks.ts` | Coding benchmark database (SWE-bench, HumanEval, LiveCodeBench, Arena Elo) and target ranking algorithms. |
| `telemetry.ts` | Aggregates structured live JSON telemetry reports across configured providers. |
| `metadata.ts` | Lookup table for model context windows, token limits, and prompt token estimation logic. |
| `registry.ts` | Assembles composite `/registry` payload combining providers, live models, routing, and leaderboard capability data. |
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
- `sync-tiers.mjs` (`npm run sync:tiers`) — snapshots BFCL (tool-use accuracy, the primary tiering signal) + LMArena into `docs/tier-data.json`. Both sources are brittle by design and it fails loudly on a missing column rather than silently degrading — don't "fix" that by softening the check.

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

## Status & open work

Current: **usable end-to-end**, 175 tests green, tsc clean. A real `claude` agentic session
completes through the proxy against NIM. Full assessment: [docs/fcc-replacement-assessment.md](docs/fcc-replacement-assessment.md).

Full live probe sweep: [docs/probe-sweep-2026-07-28.md](docs/probe-sweep-2026-07-28.md) (every script,
every endpoint). Everything it found is now fixed; `multimodal-probe.mjs` is 5/5 green live.

Still open — one item, unchanged and **not this repo's**: model-capability rankings for dispatch
(tool-use + chat scores) belong to the separate router/auditor project; research in
[docs/model-capability-ranking-sources.md](docs/model-capability-ranking-sources.md).

Best-known backend model on NIM: **`z-ai/glm-5.2`** (trip rate 0 across the scenario set; SWE-bench
42%). `llama-3.1-8b` trips 25% of calls and the reshaper fixes ~2/3 of those — the proxy's use case.

Durable project state also lives in agent memory (`project-repair-proxy`).
