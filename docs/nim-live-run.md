# Live run against NVIDIA NIM (2026-07-14)

Ran `scripts/nim-probe.mjs` — hits real NIM models (OpenAI format, `https://integrate.api.nvidia.com/v1`) and runs their tool calls through the proxy's REAL `ToolUseValidator` + `repair` orchestrator. NIM is OpenAI-compatible, so this exercises the validator/repair logic directly (not the Anthropic HTTP proxy path — the proxy would need an Anthropic⇄OpenAI backend adapter to *front* NIM; see "gap" below).

## Findings

1. **Availability/tool-support varies wildly per model+account — you cannot know without probing.** Of the models tried: `meta/llama-3.1-8b-instruct` and `meta/llama-3.1-70b-instruct` worked; `mistralai/mixtral-8x7b` → HTTP 400 (auto tool-choice not enabled on that deployment); `nvidia/llama-3.1-nemotron-70b` → 404 (not provisioned for account); `qwen/qwen2.5-coder-32b` → 410 (retired); `google/gemma-2-9b-it` → 404; `meta/llama-3.3-70b` → timeout. **This directly validates the "measure first / detect mode" thesis.**

2. **The tool-capable models here are GOOD.** Both Llama-3.1 8b and 70b produced schema-valid calls on a simple tool, respected an enum `["C","F"]` despite the prompt saying "Celsius", AND nested arguments correctly under a required `location` object. For these models the validator is a rarely-firing safety net, not a constant repair driver.

3. **A real NIM model performs the reshape correctly.** Injecting the common weaker-model failure (flattened args `{city,unit}` against a nested schema) → validator flags `schema_violation` → the real `meta/llama-3.1-70b-instruct` reshaper (via `repair()`) restructured it to `{location:{city,unit}}` = valid. **Real-model repair works end-to-end.**

## Gap surfaced
The proxy forwards Anthropic `/v1/messages` and expects an **Anthropic-compatible backend** (DeepSeek `/anthropic`, Kimi, Z.AI). **NIM is OpenAI-compatible**, so to *front* NIM (and vLLM/OpenRouter/LM Studio) the proxy needs an **Anthropic⇄OpenAI backend adapter** — a worthwhile next feature, since most cheap providers are OpenAI-shaped and only a few offer native Anthropic endpoints.

## Repro
`npm run build && node scripts/nim-probe.mjs` (uses `NVIDIA_API_KEY` + `LLM_BACKEND_BASE_URL`).
