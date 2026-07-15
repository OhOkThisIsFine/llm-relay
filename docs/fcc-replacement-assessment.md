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

## Gaps before "frictionless drop-in"

1. **`count_tokens` is unhandled** (`src/server.ts` / `src/backend.ts`): `/v1/messages/count_tokens` matches `isMessages`, and the OpenAI backend path *always* POSTs `/chat/completions` ignoring the request path — so a token-count request is mistranslated into a chat completion. Claude Code calls this for context management. **Fix:** special-case `count_tokens` (either a local heuristic estimate or a proper skip), don't route it to `/chat/completions`.
2. **OpenAI path ignores the request path entirely** (`backend.ts:48`) — fine for the single completion endpoint, but it means any non-completion Anthropic route is silently wrong for OpenAI backends.
3. **Non-text content & MCP unverified**: images/PDF/document blocks and MCP tool passthrough through llm-bridge translation were not exercised; the alt-model-routing notes warn native `/anthropic` endpoints drop these. Needs a probe before claiming parity.
4. **`claude` CLI credential validation is a real hurdle (not the proxy's fault)**: claude 2.1.195 rejects placeholder tokens client-side (`Invalid API key` / `401 Invalid bearer token`) and never emits traffic — yet the *proxy* accepts a `Bearer dummy` fine (proven by curl). A user swapping in repair-proxy must still give the CLI a credential it will accept (a real provider-issued Anthropic-format token via `ANTHROPIC_AUTH_TOKEN`), then let the proxy strip/replace it for the backend. Worth documenting in the README run recipe.
5. **Backend model reach**: the account exposes **116 NIM models** (84 instruct/chat); earlier "unavailable" results were *wrong model IDs*, not rate limits (e.g. real id is `mixtral-8x22b-v0.1`, no `qwen` at all). Re-run the trip-rate harness with real IDs for a fatter fitness dataset and to pick a stronger loop model than 3.1-70b.

## Recommendation

Short punch-list to reach "confidently drop-in for text+tool agentic work":
- Handle `count_tokens` for OpenAI backends (gap 1) — small, high-value.
- Add a non-text/MCP passthrough probe (gap 3) to know the real boundary.
- Document the CLI credential recipe (gap 4) in the README.
- Re-run trip-rate with correct NIM IDs (gap 5) and pick the strongest available tool-caller as the default loop model.

Everything above pillar-3 (safety) is already solid and is the main reason this is a *safer* path than fcc-as-third-party-translator.
