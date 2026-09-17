# Reasoning-effort granularity in the capability snapshot

**Diagnosed and fixed 2026-08-08.** Measured against `docs/tier-data.json` and the live source feeds.

## The question

Can pool and ladder ordering account for reasoning effort — is `luna` at xhigh stronger than
`terra` at low? Published data comparing effort levels exists, so the snapshot should answer it.

## What the sources publish

Two of the four sources publish effort-qualified rows, in **incompatible notation**:

| Source | Entries | Effort-qualified | Notation |
|---|---|---|---|
| openrouter (relays the AA indices) | 400 | 1 | none — base ids only |
| lmarena | 385 | 38 | suffix: `gpt-5.6-sol-xhigh` |
| bfcl | 82 | 0 | — |
| aider | 68 | 19 | parenthetical: `gpt-5 (high)`, `o3-mini (medium)` |

## The defect

`normName()` stripped only `(FC…)` / `(Prompt…)`, so an effort qualifier survived verbatim into the
join key and the three notations never met:

```
aider      "gpt-5 (high)"        -> "gpt-5 (high)"
lmarena    "gpt-5-high"          -> "gpt-5-high"
openrouter "openai/gpt-5-high"   -> "gpt-5-high"   (via normId)
```

**0 of 60 effort-qualified rows carried more than one source.** Every one was a single-signal
orphan. This is why effort variants uniformly reported `signal_count: 1` — a *failed join*, not thin
publishing. The "a source's absence is not a low score" invariant held; its sibling (a 1-source
guess and a 5-source consensus must stay distinguishable) was being undermined from the other
direction, with consensus shattered into guesses.

## The fix

`normName()` now **rewrites** a trailing effort qualifier into suffix notation, against a **closed
vocabulary** (`none|minimal|low|medium|high|xhigh|max|thinking|reasoning|no thinking`, plus Aider's
`32k thinking [tokens]` budgets).

⚠ It rewrites, it never strips: `gpt-5 (high)` → `gpt-5-high`, **never** `gpt-5`. An effort variant
must stay a separate row from its base model — collapsing them is precisely the borrowed-score bug
the merge comment in `main()` warns about. The vocabulary is closed for the same reason
`src/authEnv.ts` refuses to pattern-match env names: a heuristic would eventually decide the `-max`
in `glm-5.2-max` (a SKU tier) is an effort level and merge two different models.

Only a **trailing** parenthetical is considered, so Aider's composites (`o3 (high) + gpt-4.1`)
and dated snapshots (`chatgpt-4o-latest (2025-02-15)`) are left alone.

**Result: 8 of 71 effort-qualified rows now carry >1 source, up from 0 of 60.** Best case
`o3-mini-high`, previously three separate 1-signal orphans, is now one row with 3 sources and 5
signals. `npm run sync:tiers` prints the count on every run, because a silent regression to zero is
exactly how this went unnoticed.

## Artificial Analysis, added first-hand

AA's intelligence/coding/agentic indices already reached the snapshot **second-hand** via
OpenRouter's `benchmarks.artificial_analysis` block — but that block is keyed by OpenRouter
catalogue ids, which carry no effort dimension. Measured: 154 of 400 OpenRouter models carry an AA
block; 6 encode anything effort-like in the id, and only `openai/o3-mini-high` is a genuine effort
variant rather than a SKU name (`qwen3.8-max`, `kimi-k2-thinking` are distinct models).

`fetchArtificialAnalysis()` now reads AA directly and is absorbed **after** OpenRouter, so a
first-hand figure outranks the same figure relayed through a catalogue.

⚠ **Key-gated, and cleanly skipped when absent.** The endpoint 401s without a key and has no public
mirror. No key ⇒ the source reports `configured: false` and contributes nothing — a neutral `-`
in the report, not a warning, because an operator who never signed up is not suffering an outage.
Get a free key at <https://artificialanalysis.ai/> and put `ARTIFICIALANALYSIS_API_KEY` in
`~/.llm-relay/.env` (read with `dotenv.ts` semantics: the real environment wins).

⚠ **The response schema is not publicly documented** — `artificialanalysis.ai/docs/…` 404s, and the
API confirms only the endpoint and the `x-api-key` header (the error changes from "API key is
required" to "Invalid API key"). The field mapping is therefore an **alias list**, in the style of
`limitsFromRecord()` in `src/catalog.ts`, and it **throws** if a payload arrives in which no model
resolves a single score. That is this repo's established contract: schema drift inside a source is
corruption and fails that source loudly. **If it throws on your first keyed run, extend the alias
lists — do not soften the check.** This path has not been exercised against a real keyed response.

## What it did and did not change

It did **not** change the current dispatch ladder. Aider's polyglot leaderboard carries no
5.6-generation, `claude-opus-5` or `gemini-3.6` rows at all, and for those models LMArena publishes
exactly one effort point each (`sol-xhigh`, `terra-xhigh`, `luna-xhigh`, `claude-opus-5-high`/`-max`,
`claude-sonnet-5-high`). So `luna @ xhigh` vs `terra @ low` is still unanswerable — because no source
publishes two effort points for either model, not because data is being discarded. The AA source is
what can close that, once keyed.

## Ordering decision this informed

Non-free ladder rungs are ordered by the snapshot's **composite strength** — the same
`getStrength()` figure that ranks every pool member — with reasoning effort treated as the tier's
knob rather than a ranking dimension: one ordered lane list applied to all four tiers, effort set
from the tier.

| # | Lane | strength | signals |
|---|---|---|---|
| 2 | `agy-claude-opus` | 1.000 | 3 |
| 3 | `codex-sol` | 0.997 | 3 |
| 4 | `codex-terra` | 0.963 | 3 |
| 5 | `agy-claude-sonnet` | 0.931 | 3 |
| 6 | `codex-luna` | 0.913 | 3 |
| 7 | `agy-gemini` | 0.883 | 4 |
| 8 | `codex-spark` | — | 0 |

⚠ Ranking on the AA **coding index alone** puts `gemini-3.6-flash` (84.2) above `gpt-5.6-luna`
(84.0); the composite reverses it, because Gemini's agentic score is the weaker one. The composite
wins — it is what orders everything else, and a per-column ranking that disagrees with pool ordering
would make the ladder and the pools inconsistent.

`gpt-5.3-codex-spark` has **no snapshot entry** and is placed last among the Codex rungs:
unassessed is not weak, but an unmeasured model must not outrank a measured one.

Stability is deliberately **not** a factor for the CLI lanes. The relay's health data for
`openrouter/openai/gpt-5.6-sol` and `gemini/models/gemini-3.6-flash` describes OpenRouter's and
Google's API deployments; it has never seen a request to the ChatGPT subscription or to
Antigravity, so those numbers do not transfer.
