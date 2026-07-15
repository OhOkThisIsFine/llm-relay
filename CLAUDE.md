# CLAUDE.md — repair-proxy (agent orientation)

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
npm test               # vitest run  (currently 54 tests)
npm run typecheck      # tsc --noEmit  (excludes test/*.ts — vitest is what checks those)
npm run dev -- --config config.json   # run from src via tsx, no build
```
**Always verify green before AND after a change:** `npm run build && npm test && npm run typecheck`.

## Architecture — file → responsibility (all in `src/`)

| File | Responsibility |
|---|---|
| `cli.ts` | Entry point. Parses `--config` + overrides (`--backend-base/--model/--mode/--listen`), `--help`. |
| `config.ts` | Load/validate config. `${ENV}` expansion, loopback enforcement, reshaper auto-synthesis. `loadConfig(path, overrides?)`. |
| `server.ts` | The proxy. Request routing, detect vs repair paths, streaming vs buffered, `count_tokens`/non-messages handling, header/auth filtering, metadata logging. |
| `backend.ts` | `fetchBackend()` → returns an **Anthropic-shaped** `Response` for either `kind`. `anthropic` = passthrough; `openai` = translate req+resp via `llm-bridge`. |
| `validator.ts` | Deterministic Ajv2020 tool_use validator. Verdicts: pass / fail / **uncheckable** (declared tool with no `input_schema`, e.g. built-in `bash`). |
| `reshaper.ts` | The repair model client. Contract: reshaper returns ONLY **corrected inputs per tool_use id** (`{"inputs":{"<id>":{...}}}`); proxy reconstructs + re-validates. `HttpReshaper` (anthropic|openai) + injectable `Reshaper` for tests. |
| `repair.ts` | Repair orchestrator. Destructive-refusal check → reshape ≤ maxAttempts → re-validate each attempt. |
| `sse.ts` | `reconstructFromSse()` — rebuild an AssistantMessage from a captured SSE stream (to validate it). |
| `emitSse.ts` | `emitSse()` / `emitSseTail()` — serialize a (repaired) message back to Anthropic SSE. `emitSseTail` re-emits only trailing blocks (streaming repair). |
| `anthropic.ts` | Minimal Anthropic Messages shapes + `toolSchemaMap()`. Only the fields the proxy inspects. |
| `log.ts` | Metadata-only logger (never headers/bodies). |

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
- **Hand-built `Config` objects in tests must include** `backend.kind` and
  `repair: { maxAttempts, destructiveTools }`.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Scripts inventory (`scripts/`)

Offline / unit-test-safe (no external creds):
- `live-demo.mjs` — runs the compiled CLI against a local flaky backend + stub reshaper. Good smoke test.

Need live creds (`NVIDIA_API_KEY` + `LLM_BACKEND_BASE_URL`, or any OpenAI-compatible provider):
- `nim-front.mjs` — run the compiled proxy fronting a live backend end-to-end.
- `nim-probe.mjs` / `nim-repair.mjs` — one-off tool-call fidelity + repair probes.
- `nim-trip-rate.mjs` — the trip-rate dataset harness (models × schemas × trials → `docs/nim-trip-rate.*`).
- `agentic-loop-probe.mjs` — drives a full agentic STEP (tool_use → tool_result → answer) through a **running** proxy. The end-to-end proof.

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

Current: **usable end-to-end**, 54 tests green, tsc clean. A real `claude` agentic session
completes through the proxy against NIM. Full assessment: [docs/fcc-replacement-assessment.md](docs/fcc-replacement-assessment.md).

Open (enhancements, not blockers):
1. Non-text (image/PDF) + MCP passthrough via llm-bridge is **unverified** — needs a probe.
2. Re-run `nim-trip-rate.mjs` with real NIM IDs (the account has 116 models; earlier "unavailable"
   were wrong IDs) and pick a stronger default loop model than `llama-3.1-70b` (brittle in-loop).
3. Model-capability rankings for dispatch (tool-use + chat scores) — **belongs to the separate
   router/auditor project, not here**; research in [docs/model-capability-ranking-sources.md](docs/model-capability-ranking-sources.md).

Durable project state also lives in agent memory (`project-repair-proxy`).
