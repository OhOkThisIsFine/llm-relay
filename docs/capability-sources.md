# Capability sources — probe results

Which model-ranking sources are live, machine-readable, and actually cover the models this relay
routes to. Probed **2026-07-29**. Re-run the probes before trusting any row.

The test that matters is not "does the source exist" but **"does it score the models in our pools"**
— a 125-model leaderboard of 2024-era open code models adds nothing to a NIM roster.

Roster used for the coverage column: `z-ai/glm-5.2`, `deepseek-ai/deepseek-v4-pro`,
`moonshotai/kimi-k2.6`, `openai/gpt-oss-20b`, `meta/llama-3.1-8b-instruct`.

| Source | Endpoint | Format | Models | Roster coverage | Verdict |
|---|---|---|---|---|---|
| **OpenRouter** | `openrouter.ai/api/v1/models` | JSON | 367 | **5/5, exact ids** | **Adopt — best single source** |
| **LMArena** | HF parquet (`lmarena-ai/leaderboard-dataset`) | parquet | 433 | 5/5 (fuzzy names) | Keep |
| **BFCL** | `gorilla.cs.berkeley.edu/data_overall.csv` | CSV | ~100 | 1/5 | Keep — uniquely relevant |
| **Aider polyglot** | raw.githubusercontent (`polyglot_leaderboard.yml`) | YAML | 69 | 2/5 | Adopt, flag as stale |
| **Artificial Analysis** (direct) | `artificialanalysis.ai/api/v2/data/llms/models` | JSON | — | — | Wired first-hand 2026-08-08; **key-gated** (`ARTIFICIALANALYSIS_API_KEY`). Currently unconfigured on this install, so it contributes nothing — the shipped snapshot records it `model_count: 0, configured: false`. Set the key to enable. |
| HF Open LLM | HF parquet (`open-llm-leaderboard/contents`) | parquet | 4576 | 1/5 (glm only) | **Skip** |
| EvalPlus | raw.githubusercontent (`results.json`) | JSON | 125 | **0/5** | **Skip** |
| LiveCodeBench | `livecodebench.github.io/leaderboard.html` | HTML only | — | — | **Skip** |

⚠ The AA figures cited below this table come from OpenRouter's embedded copy of them, not from a
first-hand AA fetch — so today's snapshot has **four effective sources**, and every AA number in
it is one step removed.

## Why OpenRouter is the spine

It is the only source whose **model ids are the same shape as our routing specs**
(`z-ai/glm-5.2`, `openai/gpt-oss-20b`) — every other source publishes display names
("GLM-5.2 (FC)", "Gemini 2.0 Pro exp-02-05") and needs the fuzzy join that already
mis-attributed `glm-5.2` → `glm-5.2-max`. Exact ids remove a whole class of silent error.

194 of its 367 models carry a `benchmarks` object:

- `artificial_analysis`: `intelligence_index`, `coding_index`, **`agentic_index`** — present for all
  five roster models. `agentic_index` is the closest published proxy for "can drive a tool loop",
  which is what a subagent actually does.
- `design_arena`: per-category Elo/rank, including `arena: "agents"` categories.

It also carries `context_length`, `pricing`, and `supported_parameters` (i.e. whether the model
declares `tools` at all).

⚠ **This exposed a second stale hardcoded table — since REMOVED.** OpenRouter reported
`context_length` 1048576 for `z-ai/glm-5.2` while `src/metadata.ts` handed out a blanket 128k, so
the `ctx` column in `llm-relay candidates` was wrong by 8×. Same disease as `BENCHMARK_DB`: a
hand-typed table the roster outgrew. That rung was deleted in 0.7.0 — see "There is no third,
guessing rung" below. An unknown limit now renders blank rather than as a guess.

## Sources that disagree

For the `coding` pool, the sources do **not** agree on order:

| Model | AA coding | AA agentic | LMArena composite_rank | BFCL |
|---|---|---|---|---|
| glm-5.2 | 68.8 | 43.1 | 31 (via `glm-5.2-max`) | — |
| kimi-k2.6 | 61.8 | 30.3 | 42 | — |
| deepseek-v4-pro | 59.4 | 36.4 | 51 | — |

Coding index ranks kimi above deepseek; agentic index ranks deepseek above kimi. This is why the
merged snapshot keeps **every source's raw value** and why the ranking scalar reports how many
signals backed it — a one-source score and a four-source consensus must not look alike.

## How routing avoids coverage bias

The snapshot does not average whichever columns happen to exist. Raw values are mapped through
persisted quantile anchors, then combined into fixed dimensions: 40% agentic/tool use (AA Agentic
and BFCL Overall), 35% coding (AA Coding and Aider pass rate), and 25% general reasoning (AA
Intelligence and LMArena). A wholly missing dimension is estimated by ridge regression over models
with overlapping dimensions, and imputation quality is reported in capability confidence.

Design Arena's agent-category mean is not globally comparable when one model has three categories
and another has thirteen. It therefore joins BFCL irrelevance and Aider well-formed as a separate,
confidence-adjusted task-fit input. Those signals can order otherwise close deployments but cannot
inflate raw capability or grant an effort tier.

Calibration anchors persist across routine syncs, so adding unrelated leaderboard rows does not
rerank the existing roster. Effort admission compares whole-point capability against 50/60/70/80;
an existing member has a two-point exit band to prevent snapshot noise from flapping membership.

## Rejected, with reasons

- **EvalPlus** — 125 models, none of them ours. It scores HumanEval/MBPP for 2024-era open code
  models (OpenCoder-8B, Artigenz-Coder). Wiring it would add a brittle fetch that contributes
  nothing to any current routing decision.
- **HF Open LLM Leaderboard** — 4576 rows but only `glm` matches, and those are small open-weight
  variants, not the served frontier SKUs. High volume, near-zero relevance.
- **LiveCodeBench** — publishes HTML only; no JSON/CSV asset found at the obvious paths. Would need
  DOM scraping, the most breakage-prone integration for a benchmark already partly represented via
  Artificial Analysis' coding index.

These are skipped **deliberately**, not overlooked. Revisit if a roster shifts toward open-weight
models, where HF/EvalPlus coverage is real.

## Limits and prices are per-(provider, model)

Separate from *capability*, which is a property of the model. A **deployment's** ceilings and price
are properties of the host, and the two must not be conflated:

| Provider | What its `/models` publishes |
|---|---|
| Groq | `context_window`, `max_completion_tokens`, `pricing` |
| OpenRouter | `context_length`, `top_provider.max_completion_tokens`, `pricing` |
| Mistral | `max_context_length` only |
| **NIM** | **nothing** — `id`, `object`, `created`, `owned_by` |

`catalog.ts` harvests whatever a provider publishes (generic field-alias list, no per-provider
switch, so a new provider using `context_window` is picked up with no code change).
`resolveMetadata()` then resolves **per field**, because coverage is ragged — Mistral gives context
but no output ceiling — and labels each one:

- `provider` — the serving provider published it about its own deployment;
- `reference` (`~`) — borrowed from another provider serving the same id. Indicative only;
- `null` — nobody publishes it. Rendered blank.

There is no third, guessing rung. `metadata.ts` used to hand out a blanket 128k/4096 for anything it
did not recognise; that was deleted in 0.7.0, because a caller cannot tell a guess from a
measurement and the context guardrail was rejecting requests against it. The guardrail now fires
**only** on a `provider` figure.

This is why every NIM row renders `1049k~` and `$2.402~` — those are OpenRouter's figures for the
same model id, and NIM's real ceilings and rates are simply not published anywhere.
