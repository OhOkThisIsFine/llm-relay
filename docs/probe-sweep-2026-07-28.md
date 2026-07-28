# Probe sweep — 2026-07-28

Full live probe of every runnable surface: build/test/typecheck, every script in `scripts/`,
every proxy endpoint, and the three items previously listed as **open/unverified** in
[CLAUDE.md](../CLAUDE.md). Backend was live NVIDIA NIM (plus groq/openrouter/mistral/gemini keys
for the multi-provider paths).

## Headline

| Open item (was) | Now |
|---|---|
| 1. Non-text (image/PDF) + MCP passthrough via llm-bridge **unverified** | **Resolved.** Images work (base64 + url). **PDF does not** — root cause found, see below. MCP fields do not break the proxy but are not translated either. |
| 2. Re-run `nim-trip-rate.mjs` with real NIM ids | **Done.** The "unavailable" models were indeed wrong ids — but the corrected ids revealed a *second*, different cause. `docs/nim-trip-rate.*` regenerated. |
| 3. Capability rankings for dispatch | Still out of scope for this repo (router/auditor project). Unchanged. |

## Baseline

- `npm run build && npm test && npm run typecheck` → green, **135 tests / 23 files**.
- `scripts/live-demo.mjs` (offline) → detect leaves `{}` broken, repair rewrites it to
  `{"city":"Paris"}`. Both log lines correct.

## 1. Non-text content + MCP passthrough

New probe: [`scripts/multimodal-probe.mjs`](../scripts/multimodal-probe.mjs). Run it against a proxy
whose default target is vision-capable (`nim/nvidia/nemotron-nano-12b-v2-vl`):

```bash
PROXY=http://127.0.0.1:8792 node scripts/multimodal-probe.mjs
```

| Case | Verdict | Evidence |
|---|---|---|
| `image` / base64 PNG | **PASS** | Model answered "red" for a synthesized solid-red PNG — it genuinely received the pixels. |
| `image` / url source | **PASS** | Described a remote PNG correctly. |
| `document` / base64 PDF | **DEGRADED** | HTTP 200, but the model never sees the PDF; it hallucinated around it. |
| `mcp_servers` top-level field | **PASS** | Ignored cleanly, request still succeeds (no 400). |
| `mcp_tool_use` / `mcp_tool_result` in history | **PASS (incidentally)** | The value `SEVENTEEN` did survive — but see the caveat below. |

**Root cause for PDF, confirmed by reading `llm-bridge`:** `parseAnthropicContent`
(`node_modules/llm-bridge/dist/index.js`) branches on `text`, `image`, `tool_use`, `tool_result`
only. Every other block type hits the fallback

```js
return { _original: {...}, text: JSON.stringify(block), type: "text" };
```

So a `document` block is **not dropped — it is stringified**. The entire base64 payload is injected
into the prompt as literal text. Consequences, in order of severity:

1. The model cannot read the PDF (it sees base64, not a document).
2. Token count scales with the *base64* size — a few-MB PDF will blow the context guardrail or
   burn a large paid prompt, silently. This is a cost/DoS-shaped footgun, not just a missing feature.
3. Same fallback is why the MCP-block case "passed": `mcp_tool_use`/`mcp_tool_result` were
   stringified into text and the model happened to read the answer out of the JSON. That is
   incidental, not translation — do not rely on it for real MCP tool loops.

Recommended follow-up (not done here, it changes request semantics): reject or explicitly
down-convert `document` blocks in `backend.ts` before handing off to llm-bridge, rather than letting
base64 reach the prompt.

## 2. Trip-rate with real NIM ids

`llm-relay models --provider nim --refresh` lists **102 models**. Of the 8 ids hardcoded as
`DEFAULT_MODELS` in `nim-trip-rate.mjs`, five do not exist any more
(`meta/llama-3.1-70b-instruct`, `mixtral-8x22b-instruct-v0.1`, `phi-3-medium-4k-instruct`,
`gemma-2-9b-it`, `qwen/qwen2.5-coder-7b-instruct`). The old "unavailable" column was wrong ids —
confirmed.

Re-run with corrected ids (`RP_TRIALS=3`, reshaper `z-ai/glm-5.2`), regenerated
`docs/nim-trip-rate.{md,json,jsonl}`:

| Model | Trip rate | Repair-fix rate | Notes |
|---|---|---|---|
| `meta/llama-3.1-8b-instruct` | 0.25 | 0.667 | Format-broken but mostly repairable — the proxy's exact use case. |
| `nvidia/nemotron-3-super-120b-a12b` | 0 | — | Clean, but **skipped the tool twice of 12** (`no_tool_call`). |
| `z-ai/glm-5.2` | 0 | — | Clean on all 12. Best default loop model of the three. |

Two further findings the harness surfaced, both distinct from "wrong id":

- **Catalog listing ≠ inference availability.** `mistralai/mistral-7b-instruct-v0.3`,
  `google/gemma-3-12b-it` and `microsoft/phi-3.5-moe-instruct` are all in `/models` yet return
  **HTTP 404** from `/chat/completions`. The startup warning in `server.ts` that validates a routing
  target against the catalog therefore gives false confidence — a listed id can still be dead.
- **`meta/llama-3.3-70b-instruct` is not unavailable, it is cold-start slow.** It was scored
  `timeout` by the harness's 70 s cap; a direct curl returned **HTTP 200 in 86 s**. Any provider
  timeout below ~90 s will misclassify this model.

Default loop model recommendation: **`z-ai/glm-5.2`** (also the highest SWE-bench in the catalog at
42%). `scripts/nim-front.mjs` was hardcoded to the retired `llama-3.1-70b` id; it now defaults to
`glm-5.2` and honours `RP_MODEL`.

## 3. Endpoint + CLI sweep (live)

All against a running proxy (`mode=repair`, `nim/z-ai/glm-5.2`) unless noted.

| Surface | Result |
|---|---|
| `agentic-loop-probe.mjs` | **PASS** — tool_use → tool_result → final answer citing `4271`, both turns HTTP 200. The end-to-end agentic proof holds on glm-5.2. |
| `nim-front.mjs` | **PASS** — non-stream `stop_reason=tool_use` with valid input; stream emits the full event sequence with tool args streamed. |
| `verify-live-features.mjs` | **PASS** — tier failover (bad NIM id → groq fallback returned a completion) and the context-limit guardrail (400 at 150k vs 128k limit). |
| `POST /v1/chat/completions` (OpenAI front) | **PASS** — well-formed `chat.completion` with usage. |
| `POST /v1/messages/count_tokens` | **PASS** — `{"input_tokens":4}`, handled locally, not forwarded. |
| Unknown path (`/v1/complete`) | **PASS** — clean 404. |
| Streamed `usage` | **PASS** — `message_delta` carried `output_tokens: 7` (non-zero), i.e. the `stream_options.include_usage` fix in `65853de` holds live. |
| `llm-relay keys` | **PASS** — all 5 providers VALID. Note `gemini` resolved via the **`GOOGLEAI_API_KEY` alias** (`GEMINI_API_KEY` is unset) — `authEnv.ts` alias resolution verified live. |
| `llm-relay telemetry` | **PASS** — 5/5 healthy, structured JSON. |
| `llm-relay ping --provider nim` | **Runs**, but a single invocation reports nearly every model `Pending`/`Not Active` with no latency. Ping is designed to accumulate over a background cadence; one-shot output is close to useless. Cosmetic, not a defect. |
| `scripts/verify-with-nim.mjs` | **BROKEN / dead** — exits 1 immediately looking for `.audit-tools/audit/audit-report.md`, a path from another project. It is not a proxy verification script despite the name. Candidate for deletion. |

## Remaining work this sweep created

- `document`-block handling in `backend.ts` (base64 reaching the prompt) — the one real defect found.
- `scripts/verify-with-nim.mjs` is dead code referencing a foreign path.
- `nim-trip-rate.mjs` `DEFAULT_MODELS` still contains five dead ids and a 70 s timeout that
  misclassifies slow-cold-start models.
