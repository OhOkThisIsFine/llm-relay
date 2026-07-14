# repair-proxy

A standalone, **loopback** Anthropic-Messages-API reverse proxy. It forwards `/v1/messages` to any backend model and **validates tool-call responses** against the request's `tools[].input_schema`, so the Claude Code harness (or any `ANTHROPIC_BASE_URL` client) can run on non-Anthropic models without pre-filtering them by tool competence.

**The one boundary:** it fixes/flags *protocol form* (malformed tool calls), never *judgment* (bad reasoning). See the spec.

## Status — M0 + M1 (of the build plan)

- ✅ M0 passthrough: forwards streaming + non-streaming `/v1/messages` byte-for-byte.
- ✅ M1 validator + `detect` mode: deterministic tool_use gate (ajv), metadata-only logging of pass/fail — **behavior unchanged**, it only observes.
- ⏳ M2 reshaper (repair mode), M3 streaming repair, M4 hardening — not built yet. `repair`/`strict` modes currently behave as `detect`.

## Install & run

```bash
npm install
npm run build
cp config.example.json config.json   # edit backend + auth
DEEPSEEK_API_KEY=sk-... node dist/cli.js --config config.json
# or, no build step:
DEEPSEEK_API_KEY=sk-... npm run dev -- --config config.json
```

Then point a client at it:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8791 \
ANTHROPIC_AUTH_TOKEN=anything \
CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 \
CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
CLAUDE_CODE_ATTRIBUTION_HEADER=0 \
claude -p "list the files here"
```

## Config

```jsonc
{
  "listen": "127.0.0.1:8791",              // loopback ONLY — startup refuses non-loopback
  "backend": {
    "base": "https://api.deepseek.com/anthropic",  // origin; the inbound path is appended
    "authEnv": "DEEPSEEK_API_KEY"           // key injected as x-api-key + Bearer; inbound auth stripped
  },
  "mode": "detect",                         // detect | (repair | strict — M2+, currently == detect)
  "log": { "level": "metadata", "file": null }  // metadata-only; NEVER logs headers/bodies
}
```

## What it logs (per request, metadata only)

`{ ts, path, backendModel, hadTools, streamed, backendStatus, validated: pass|fail|uncheckable|skipped, toolUseCount, uncheckableCount, errorKinds[], latencyMs }`

`uncheckable` = a declared tool with no `input_schema` (built-in `bash`/`text_editor`/…) or a schema that wouldn't compile — surfaced distinctly so an unvalidatable call is never miscounted as a clean pass.

This is the dataset for deciding which backend models are *format-broken* (reshapeable later) vs pass cleanly. Run in `detect` first, measure, then decide on repair.

## Design

Full spec: `repair-proxy-spec.md` (in the design scratchpad). Consumers (audit-tools dispatch, plain `claude` CLI) point `ANTHROPIC_BASE_URL` at this proxy; it validates one backend per request. Target *selection* / token-prediction is a separate concern (the router/auditor), deliberately not here.

## Dev

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (validator, SSE reconstruction, e2e transparency+detection)
```
