# Model-capability ranking sources (for auto-ranking backend tool-fitness)

Purpose: programmatically fetch a capability score per backend model to inform which providers the fleet/router prefers — weighted toward **tool-use/agentic** capability, which is what this proxy cares about. Researched 2026-07-14; treat specific scores as source-dependent (post-Jan-2026 data unverifiable), but the retrieval mechanisms below are stable.

## Key reframe
**LMArena Elo ≠ tool capability.** Arena measures human *chat preference*; it has Hard-Prompts and Coding sub-boards but **no function-calling arena**. Weakest fit. Use tool/agentic-specific sources instead.

## Ranked, programmatically-retrievable sources

### 1. Berkeley Function-Calling Leaderboard (BFCL) — truest tool-use signal
- Repo https://github.com/ShishirPatil/gorilla (`berkeley-function-call-leaderboard/`), board https://gorilla.cs.berkeley.edu/leaderboard.html, pkg `bfcl-eval` (PyPI).
- **License Apache-2.0 (redistributable).** V4 Overall = Agentic 40% + Multi-Turn 30% + Live 10% + Non-Live 10% + Hallucination 10% — exactly the target signal.
- **Catch:** no canonical committed score JSON. HF dataset `gorilla-llm/Berkeley-Function-Calling-Leaderboard` is *questions only*. Scores are generated locally by running `bfcl-eval`, or scraped from `leaderboard.html`'s client-side data. Model ids carry `-FC` suffix (e.g. `claude-3-5-sonnet-20241022-FC`). Irregular versioned cadence.

### 2. Artificial Analysis API — best fetchability + solves id-mapping
- `GET https://artificialanalysis.ai/api/v2/data/llms/models`, auth `x-api-key`, ~1,000 req/day free. Docs https://artificialanalysis.ai/documentation.
- Returns stable machine ids (`id` UUID, `slug`, `model_creator`) + `evaluations` composites (`artificial_analysis_intelligence_index`, `..._coding_index`, `livecodebench`, `scicode`, …).
- **Tool-use caveat:** agentic evals are folded into composites, NOT broken out as a standalone function-calling score. A Pro-tier `artificial_analysis_agentic_index` + `openrouter_api_id` was hinted but UNCONFIRMED — verify before relying. **Attribution required; commercial redistribution needs a contract.**
- Best used as the **id spine** (join everything else onto its stable ids) + coding/agentic composite.

### 3. Aider polyglot (YAML) + SWE-bench (JSON) — easy coding-agent proxies
- Aider: `GET https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml` — fields incl `pass_rate_2`, `percent_cases_well_formed`, `edit_format`. Apache-2.0. (`percent_cases_well_formed` is a decent tool/format-adherence proxy.)
- SWE-bench: `GET https://raw.githubusercontent.com/SWE-bench/swe-bench.github.io/main/data/leaderboards.json`.
- Both: no auth, raw-GitHub, permissive, commit-cadence. **Free-text model names** (need normalization).

Also-ran: τ-bench/tau2-bench (ideal pure-agentic, but **no clean feed** — assemble from repo `submission.json`s); ToolBench (no maintained ranking feed — skip).

## The real friction: id mapping
Every board names models as free text and differently (`claude-3-5-sonnet-20241022-FC`, `gpt-5 (high)`, `DeepSeek-V3`). Only **Artificial Analysis** (and **OpenRouter `/api/v1/models`**) publish stable machine ids. Plan: use AA or OpenRouter as the canonical id spine; join BFCL/Aider/SWE-bench on by normalized name (regex + alias table — expect maintenance when boards add naming styles).

## Recommendation
Feasible, but not single-source. **Start with the Artificial Analysis API** (official, rate-limited, stable ids → your mapping spine + coding/agentic composite); **overlay BFCL** (Apache-2.0, scrape or `bfcl-eval`) for the tool-use-specific ranking. This ranking work belongs to the **router/auditor** project, not to repair-proxy — repair-proxy just measures per-model validator trip-rates empirically (its `detect` logs), which is a *complementary, ground-truth* signal about tool fitness on YOUR traffic.
