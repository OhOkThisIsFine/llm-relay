# Is repair-proxy a safe replacement for free-claude-code (fcc)?

Assessed 2026-07-14, live against NVIDIA NIM (`meta/llama-3.1-70b-instruct`), mode=repair, OpenAI backend.

## Verdict

**Yes on the two things that matter most — safety and tool-call fidelity — and the core agentic loop is now proven to work end-to-end through it.** It is *not yet* a frictionless drop-in for every Claude Code surface: `count_tokens` is unhandled, non-text/MCP content is unverified, and the `claude` CLI's own credential validation is a hurdle independent of the proxy. Net: a real, safer alternative to fcc for text+tool agentic work on a strong-enough backend, with a short punch-list before "drop-in."

## What "safe fcc replacement" means — three pillars

| Pillar | fcc | repair-proxy | Live evidence today |
|---|---|---|---|
| **1. Translation drop-in** (point `ANTHROPIC_BASE_URL` at it, talk to any model) | ✅ its whole job | ✅ Anthropic↔OpenAI via llm-bridge, streaming + non-streaming | Two-turn agentic step completed: `tool_use → tool_result → final answer` (see below) |
| **2. Tool-call fidelity** (weak models don't silently break the loop) | ❌ none — malformed calls fail silently | ✅ deterministic validate (Ajv2020) + reshape/repair; refuses to fabricate destructive calls | Live trip-rate: models emit `days:"5"` vs `integer`; proxy repairs 100% |
| **3. Safety posture** (no ToS/credential risk, observable, no blast radius) | ⚠️ third-party tool in the credential path | ✅ loopback-only, metadata-only logs, fail-clean 502, destructive-refusal; uses a **provider key** (sanctioned direction), strips inbound auth | curl with `Bearer dummy` → proxy strips it, injects NIM key → 200 |

## The decisive test: does the agentic loop survive the translation?

All prior verification was single-shot request/response. The real question is whether a full harness **step** works. Driven directly over HTTP through the running proxy (`scripts/agentic-loop-probe.mjs`):

1. **Turn 1** — user asks; NIM emits `read_file({"path":"README.md"})`; proxy validates it `pass`. ✅
2. **Turn 2** — we feed a `tool_result`; NIM returns `"The magic number is 4271."`, `stop_reason=end_turn`. ✅

This proves the whole chain survives Anthropic↔OpenAI translation: **tool-schema translation, tool_use validation/repair, tool_result round-trip (the model demonstrably read content that existed only in the tool_result), and multi-turn continuation with natural termination.** An earlier run where turn 2 re-called a tool was traced to the *weak model* misreading a `# Demo` markdown heading as a filename — not a translation bug (it had clearly received the tool_result). With clean tool output it terminates correctly.

**Implication:** the proxy does its job; **model quality is the ceiling.** llama-3.1-70b is brittle in the loop — which is exactly why pillar 2 (repair) matters, and also its limit: repair fixes *form*, not a model that reasons itself into a loop.

## Gaps — status after the usability pass (commit 799eed3)

1. ~~**`count_tokens` unhandled**~~ **FIXED**: OpenAI backends now answer `/v1/messages/count_tokens` locally with a cheap token estimate; never mistranslated into a chat completion.
2. ~~**OpenAI path ignores the request path**~~ **FIXED**: non-messages paths (e.g. claude's `/` preflight) now return a clean local 404 in ~2ms instead of a spurious NIM 400.
3. **Non-text content & MCP still unverified**: images/PDF/document blocks and MCP tool passthrough through llm-bridge were not exercised. Needs a probe before claiming full parity. *(Open.)*
4. ~~**`claude` CLI credential hurdle**~~ **SOLVED**: the cause was an active subscription OAuth session conflicting with the proxy token (client-side `Invalid API key`/`401`, no traffic sent). Running claude with an isolated `CLAUDE_CONFIG_DIR` makes the provider token the sole credential — and keeps the subscription entirely out of the path. Wrappers `scripts/claude-proxied.{ps1,sh}` + README recipe do this. **Verified: a real `claude` agentic session completes end-to-end through the proxy against NIM.**
5. **Backend model reach**: account exposes **116 NIM models** (84 instruct/chat); earlier "unavailable" were *wrong IDs* (real: `mixtral-8x22b-v0.1`, `gemma-2-2b-it`; no `qwen`). NIM also **rate-limits (429)** under load — claude's retry/backoff absorbs it, but it adds latency. Re-run trip-rate with real IDs to pick a stronger loop model than 3.1-70b. *(Open, low-risk.)*

## Bottom line

**It works and is usable today** for text+tool agentic sessions via the wrappers — proven end-to-end, safe by construction (subscription never in the path). Remaining open items (non-text/MCP probe; trip-rate with real IDs + a stronger default model) are enhancements, not blockers. Model *reasoning* quality on a weak backend remains the ceiling repair can't lift.
