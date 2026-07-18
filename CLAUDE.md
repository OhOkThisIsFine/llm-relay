# CLAUDE.md — repair-proxy (agent orientation)

Read this first. It's the map; [README.md](README.md) is the user-facing usage guide.

## What this is

A standalone, **loopback-only** reverse proxy for the Anthropic `/v1/messages` API. A client
(the `claude` CLI, or anything that honors `ANTHROPIC_BASE_URL`) points at it; it forwards to a
configured backend and **validates + repairs the model's tool calls**, so the Claude Code
harness can run on non-Anthropic models that are weaker at tool-use.

**The one boundary — do not cross it:** the proxy fixes/flags *protocol form* (malformed tool
calls), never *judgment* (bad reasoning). It repairs a tool call whose args violate the schema;
it does not invent intent, and it refuses to fabricate destructive-tool calls.

**Division of labor (deliberate):** this proxy does ONLY the validate/repair layer. Provider
translation, model routing, retries/fallbacks, and model discovery belong to the backend it
fronts — typically a **LiteLLM proxy**, which serves the Anthropic Messages format
(`/v1/messages`, streaming + tools) for any provider model. Chain:
`claude → repair-proxy → LiteLLM → provider`. Do not re-add translation/routing here.

## Build / test / run

```bash
npm install
npm run build          # tsc -> dist/
npm test               # vitest run  (currently 53 tests)
npm run typecheck      # tsc --noEmit  (excludes test/*.ts — vitest is what checks those)
npm run dev -- --config config.json   # run from src via tsx, no build
```
**Always verify green before AND after a change:** `npm run build && npm test && npm run typecheck`.

## Architecture — file → responsibility (all in `src/`)

| File | Responsibility |
|---|---|
| `cli.ts` | Entry point. Parses `--config` + overrides (`--backend-base/--model/--mode/--listen`), `--help`. |
| `config.ts` | Load/validate config. Single `backend` (Anthropic-format), `${ENV}` expansion, loopback enforcement, repair-mode-requires-reshaper. `loadConfig(path, overrides?)`. |
| `server.ts` | The proxy. Request routing, detect vs repair paths, streaming vs buffered, count_tokens fallback, header/auth filtering, metadata logging. |
| `backend.ts` | `fetchBackend()` — Anthropic passthrough with optional fixed-model rewrite (`backend.model`). No translation. |
| `validator.ts` | Deterministic Ajv2020 tool_use validator. Verdicts: pass / fail / **uncheckable** (declared tool with no `input_schema`, e.g. built-in `bash`). |
| `reshaper.ts` | The repair model client. Contract: reshaper returns ONLY **corrected inputs per tool_use id** (`{"inputs":{"<id>":{...}}}`); proxy reconstructs + re-validates. `HttpReshaper` (anthropic\|openai transport) + injectable `Reshaper` for tests. |
| `repair.ts` | Repair orchestrator. Destructive-refusal check → reshape ≤ maxAttempts → re-validate each attempt. |
| `sse.ts` | `reconstructFromSse()` — rebuild an AssistantMessage from a captured SSE stream (to validate it). |
| `emitSse.ts` | `emitSse()` / `emitSseTail()` — serialize a (repaired) message back to Anthropic SSE. `emitSseTail` re-emits only trailing blocks (streaming repair). |
| `anthropic.ts` | Minimal Anthropic Messages shapes + `toolSchemaMap()`. Only the fields the proxy inspects. |
| `log.ts` | Metadata-only logger (never headers/bodies). |

**Request flow:** `handle()` in `server.ts` → `fetchBackend()` → then either `repairPath` (repair
mode, invalid tool call) or `transparentPath` (detect/passthrough). Repair splits into
`repairStreamingPath` (SSE: stream text through, buffer from first tool_use) and
`repairBufferedPath` (non-streamed JSON). Everything is Anthropic Messages end to end — the
backend (LiteLLM) already speaks it.

## Invariants (keep these true)

- **Anthropic-format only, no translation.** The backend must serve `/v1/messages` natively;
  translation/routing is LiteLLM's job (see `docs/litellm-config.example.yaml`). Don't re-add
  provider kinds, catalogs, or an OpenAI front here.
- **Provider/model agnostic.** No hardcoded provider URLs, models, or keys in `src/`. Everything
  comes from config: `backend.base`, optional `backend.model` (fixed rewrite), `backend.authEnv`
  (env var NAME, not the key), `backend.authHeader`.
- **Loopback only.** Startup refuses a non-loopback bind (it holds a provider key, does no auth).
- **Logs are metadata only** — never request/response headers or bodies.
- **Destructive tool calls are refused, never fabricated** (repair output may run under
  `--dangerously-skip-permissions`). Unrepairable → fail-clean (502, or a mid-stream SSE `error`).
- **Repair mode requires an explicit `reshaper` config block** (load-time error otherwise).
- **Hand-built `Config` objects in tests must include** `backend` (with `authHeader`, `timeoutMs`)
  and `repair: { maxAttempts, destructiveTools }`.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Scripts inventory (`scripts/`)

Offline / unit-test-safe (no external creds):
- `live-demo.mjs` — runs the compiled CLI against a local flaky backend + stub reshaper. Good smoke test.

Need live creds:
- `litellm-front.mjs` — run the compiled proxy fronting a live LiteLLM (`LITELLM_BASE_URL`, optional `LITELLM_MODEL`/`LITELLM_API_KEY`).
- `nim-repair.mjs` — stub Anthropic backend + real NIM reshaper (openai-kind transport) through the compiled CLI (`NVIDIA_API_KEY`, `LLM_BACKEND_BASE_URL`).
- `nim-probe.mjs` / `nim-trip-rate.mjs` — raw provider probes (hit `/chat/completions` directly, import validator/reshaper from `dist/`); the trip-rate harness writes `docs/nim-trip-rate.*`.
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
- **`count_tokens`**: forwarded to the backend; a 404/405 from a backend that doesn't implement
  it (LiteLLM, version-dependent) triggers a local estimate answer. See `server.ts` `handle()`.
- Backends rate-limit (HTTP 429). The proxy passes it through; LiteLLM's router retries and the
  client's backoff handle it.

## Status & open work

Current: **usable end-to-end**, 53 tests green, tsc clean. Reshaped (2026-07) to delegate all
provider translation/routing to LiteLLM — the old llm-bridge translation, multi-provider
registry/routing, model catalog, `GET /registry`, and OpenAI-compatible front were removed.
Full assessment (pre-reshape): [docs/fcc-replacement-assessment.md](docs/fcc-replacement-assessment.md).

Open (enhancements, not blockers):
1. **Live e2e against a real LiteLLM instance is unverified** — run `litellm --config docs/litellm-config.example.yaml`,
   then `scripts/litellm-front.mjs` and `scripts/agentic-loop-probe.mjs`; confirm streaming tool_use
   fidelity and whether LiteLLM serves `/v1/messages/count_tokens` (fallback covers a 404 either way).
2. **Dispatcher follow-up (separate project):** the dispatcher used this proxy's `GET /registry` +
   OpenAI front; it should now point at LiteLLM directly (`/v1/models`, `/v1/chat/completions`).
3. Non-text (image/PDF) + MCP passthrough via LiteLLM is unverified — needs a probe.
4. Model-capability rankings for dispatch — **belongs to the separate router/auditor project, not
   here**; research in [docs/model-capability-ranking-sources.md](docs/model-capability-ranking-sources.md).

Durable project state also lives in agent memory (`project-repair-proxy`).
