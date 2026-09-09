# Eligibility triage — 2026-09-09

The unrecognized-refusal queue held **26** signatures when this lap captured it (the backlog
entry said 10; the queue had grown). Every verdict below was checked by this session against the
closed vocabularies the CLI enforces — classes `not-servable | subscription-required |
allowance-exhausted | credential-invalid | rate-limited`, scopes `attempt | group | deployment |
credential | provider | model`, cost classes `free | paid | unknown` — and against the standing
rules in `CLAUDE.md`: a quota is not a rate limit; a bare 429 naming no account states nothing;
scope follows what the message STATES, never a count of failures; "out of free credits" is not
"paid"; a client-side network block is never rejected.

A `free-pool` answer-mode lane (served by `nim/nvidia/nemotron-3-ultra-550b-a55b`, 148 s)
classified items 1–16 under the same rules and agreed with this session on every one; it stopped
at 16, and this session classified 17–26 by the same rules (seven of them share one wording).

**Nothing below changes routing until the owner runs the `accept`/`reject` commands.** Each is
pinned to its digest with `--sig`, so a queue that reorders between listing and accept cannot
land a verdict on a different refusal.

## Verdicts

| # | sig | deployment | HTTP | × | verdict | class | scope | cost | rule |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `c03075bd21` | groq/qwen/qwen3.6-27b | 403 | 281 | **pending** | — | — | — | caller's network (VPN); `reject` would silence the warning forever |
| 2 | `a678a9ca37` | nim/nvidia/nemotron-3-ultra-550b-a55b | 429 | 58 | reject | — | — | — | bare "too many requests" names no account — the breaker already handles it |
| 3 | `e0160ac366` | nim/moonshotai/kimi-k3 | 400 | 48 | accept | not-servable | deployment | — | "degraded function cannot be invoked" — the provider states the deployment cannot be served |
| 4 | `a4ac971903` | groq/qwen/qwen3.6-27b | 429 | 16 | accept | rate-limited | attempt | — | names organization AND model, per-minute throughput (otpm) |
| 5 | `1fb341e3b7` | groq/qwen/qwen3.6-27b | 429 | 16 | reject | — | — | — | "request too large… reduce max_tokens" — a per-request size refusal |
| 6 | `90d6752645` | openrouter/anthropic/claude-fable-5:batch | 404 | 12 | accept | not-servable | deployment | — | "only available through the batch api" |
| 7 | `7707a73846` | openrouter/openai/gpt-5.6-sol:batch | 404 | 12 | accept | not-servable | deployment | — | same |
| 8 | `3f268d72c3` | groq/qwen/qwen3.6-27b | 429 | 12 | accept | rate-limited | attempt | — | organization + model, per-minute (itpm) |
| 9 | `faecdfd0ea` | gemini/models/gemini-3.5-flash-lite | 429 | 5 | accept | allowance-exhausted | credential | free | "resource has been exhausted (check quota)" — a quota, not throttling; the free-tier key |
| 10 | `51dd5469b4` | gemini/models/gemini-2.5-flash | 429 | 5 | accept | allowance-exhausted | credential | free | same |
| 11 | `29d210fe66` | groq/qwen/qwen3.6-27b | 400 | 4 | reject | — | — | — | "failed to call a function… adjust your prompt" — a generation failure |
| 12 | `762a9a7740` | groq/qwen/qwen3.6-27b | 429 | 3 | accept | rate-limited | attempt | — | organization + model, per-minute (itpm) |
| 13 | `bc33ee2b75` | gemini/models/gemini-3.5-flash | 429 | 3 | accept | allowance-exhausted | credential | free | as 9 |
| 14 | `15e155f580` | groq/qwen/qwen3.6-27b | 400 | 3 | reject | — | — | — | "failed to validate json" — a generation failure |
| 15 | `09bb0c777d` | gemini/models/gemini-3.6-flash | 429 | 2 | accept | allowance-exhausted | credential | free | as 9 |
| 16 | `f97a2d99b5` | huggingface/zai-org/GLM-5.2 | 400 | 2 | reject | — | — | — | "max_completion_tokens is limited" — a per-request cap (learned separately as a `max-output` measurement) |
| 17 | `6a8b01dcae` | ollama-cloud/minimax-m2.7 | 402 | 1 | accept | subscription-required | deployment | — | "requires a subscription or usage credits" — not covered by the free plan |
| 18 | `9211cd017e` | ollama-cloud/kimi-k2.7-code | 402 | 1 | accept | subscription-required | deployment | — | same |
| 19 | `55c81addc9` | ollama-cloud/glm-5.1 | 402 | 1 | accept | subscription-required | deployment | — | same |
| 20 | `e2e85dc804` | ollama-cloud/kimi-k2.6 | 402 | 1 | accept | subscription-required | deployment | — | same |
| 21 | `d593fab6d1` | ollama-cloud/minimax-m3 | 402 | 1 | accept | subscription-required | deployment | — | same |
| 22 | `4d20ebf0e9` | ollama-cloud/glm-5.2 | 402 | 1 | accept | subscription-required | deployment | — | same |
| 23 | `55cd2807d3` | ollama-cloud/kimi-k3 | 402 | 1 | accept | subscription-required | deployment | — | same |
| 24 | `d7c8afaaeb` | groq/qwen/qwen3.6-27b | 429 | 1 | accept | rate-limited | attempt | — | organization + model, per-minute (otpm) |
| 25 | `dcaca85a8f` | groq/qwen/qwen3.6-27b | 400 | 1 | reject | — | — | — | "failed to generate json" — a generation failure |
| 26 | `d9e3b5dbca` | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | 429 | 1 | accept | rate-limited | credential | free | "free-models-per-min" — a per-account limit bounded to free models |

Two things the owner should weigh before accepting:

- **Item 3 evicts `nim/moonshotai/kimi-k3` from every pool** until the fact expires or a success
  clears it. NIM has said "degraded function" 48 times; the deployment was this machine's
  workhorse in August. Accepting is what the rule says; declining keeps it in the walk and lets
  the breaker keep absorbing the 400s.
- **Items 17–23 evict seven ollama-cloud deployments** (each seen once). They are paid-plan SKUs
  on a free account, so eviction is correct and cheap — but each was seen only once.

## Commands, ready to run (positions may shift; `--sig` is authoritative)

```bash
llm-relay eligibility accept 3 --sig e0160ac366 --class not-servable --scope deployment
llm-relay eligibility accept 4 --sig a4ac971903 --class rate-limited --scope attempt
llm-relay eligibility accept 6 --sig 90d6752645 --class not-servable --scope deployment
llm-relay eligibility accept 7 --sig 7707a73846 --class not-servable --scope deployment
llm-relay eligibility accept 8 --sig 3f268d72c3 --class rate-limited --scope attempt
llm-relay eligibility accept 9 --sig faecdfd0ea --class allowance-exhausted --scope credential --cost-class free
llm-relay eligibility accept 10 --sig 51dd5469b4 --class allowance-exhausted --scope credential --cost-class free
llm-relay eligibility accept 12 --sig 762a9a7740 --class rate-limited --scope attempt
llm-relay eligibility accept 13 --sig bc33ee2b75 --class allowance-exhausted --scope credential --cost-class free
llm-relay eligibility accept 15 --sig 09bb0c777d --class allowance-exhausted --scope credential --cost-class free
llm-relay eligibility accept 17 --sig 6a8b01dcae --class subscription-required --scope deployment
llm-relay eligibility accept 18 --sig 9211cd017e --class subscription-required --scope deployment
llm-relay eligibility accept 19 --sig 55c81addc9 --class subscription-required --scope deployment
llm-relay eligibility accept 20 --sig e2e85dc804 --class subscription-required --scope deployment
llm-relay eligibility accept 21 --sig d593fab6d1 --class subscription-required --scope deployment
llm-relay eligibility accept 22 --sig 4d20ebf0e9 --class subscription-required --scope deployment
llm-relay eligibility accept 23 --sig 55cd2807d3 --class subscription-required --scope deployment
llm-relay eligibility accept 24 --sig d7c8afaaeb --class rate-limited --scope attempt
llm-relay eligibility accept 26 --sig d9e3b5dbca --class rate-limited --scope credential --cost-class free
llm-relay eligibility reject 2 --sig a678a9ca37
llm-relay eligibility reject 5 --sig 1fb341e3b7
llm-relay eligibility reject 11 --sig 29d210fe66
llm-relay eligibility reject 14 --sig 15e155f580
llm-relay eligibility reject 16 --sig f97a2d99b5
llm-relay eligibility reject 25 --sig dcaca85a8f
```

Item 1 stays pending on purpose and has no command.
