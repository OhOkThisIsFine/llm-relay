# Duplication & Complexity Runbook (2026-09-05)

Official runbook for llm-relay's duplication, complexity, and churn-correlation
tooling. Produced as Phase 1 of the Duplication, Complexity, and Refactoring
Audit. All Phase 1 artifacts live in `analysis-reports/duplication-audit-2026-09-05/`.

## 1. Tool setup

All tools are already in `devDependencies` / `node_modules` — no new installs.
Requires Node >= 22 (repo `engines` floor; measured run used Node v26.7.0).

| Tool | Package (pinned in repo) | Purpose |
|------|--------------------------|---------|
| jscpd | `jscpd@^5.0.14` (measured: 5.0.14) | Token-based exact-clone detection |
| Complexity | `typescript@^5.7.2` compiler AST via committed script | Cyclomatic + cognitive per function/file |
| Churn | git itself via committed script | 90-day commit-count per file, correlated with complexity |

No ESLint-based complexity plugin is used: `eslint-plugin-sonarjs` is present
but its cognitive rule is per-function-error output, not a JSON report, so the
committed AST script is the instrument of record.

## 2. Exact invocation commands

Run from the repo root. PowerShell shown; flags are shell-independent.

### 2a. Duplication (jscpd)

```powershell
# Calibration sweep (all three; one output dir per threshold)
npx jscpd src --min-tokens 50 --min-lines 5 --format typescript `
  --ignore "**/*.test.ts,**/*.spec.ts,test/**,dist/**,dashboard/**,analysis-reports/**" `
  --reporters json,markdown --output analysis-reports/duplication-audit-2026-09-05/jscpd-50-5 `
  --silent --no-tips
npx jscpd src --min-tokens 60 --min-lines 5 --format typescript `
  --ignore "**/*.test.ts,**/*.spec.ts,test/**,dist/**,dashboard/**,analysis-reports/**" `
  --reporters json,markdown --output analysis-reports/duplication-audit-2026-09-05/jscpd-60-5 `
  --silent --no-tips
npx jscpd src --min-tokens 70 --min-lines 5 --format typescript `
  --ignore "**/*.test.ts,**/*.spec.ts,test/**,dist/**,dashboard/**,analysis-reports/**" `
  --reporters json,markdown --output analysis-reports/duplication-audit-2026-09-05/jscpd-70-5 `
  --silent --no-tips

# Promote the calibrated operating point (60/5) to the canonical report names
Copy-Item analysis-reports/duplication-audit-2026-09-05/jscpd-60-5/jscpd-report.json `
  analysis-reports/duplication-audit-2026-09-05/jscpd-report.json
Copy-Item analysis-reports/duplication-audit-2026-09-05/jscpd-60-5/jscpd-report.md `
  analysis-reports/duplication-audit-2026-09-05/jscpd-report.md
```

Notes:

- `--format typescript` scopes the scan to TS sources (123 files, 55,410 lines,
  317,668 tokens on 2026-09-05). Subdirectories (`routes/`, `mcp/`, `kernel/`,
  `delegate-gate/`, `ping/`, `storage/`) are included automatically via `src`.
- `--ignore` is comma-separated with NO spaces (spaces become part of the glob
  and silently fail to match). Quote the whole value so the shell passes it
  through as one argument.
- jscpd exits 0 with `--silent` even when clones are found (no `--exit-code`
  flag passed); gating is done by comparing report numbers (§6), not exit codes.
- The `fragment` field in jscpd 5.x JSON output is empty; always verify a clone
  by reading the cited `firstFile`/`secondFile` line ranges in `src/` directly.

### 2b. Complexity

```powershell
node analysis-reports/duplication-audit-2026-09-05/measure-complexity.mjs
# -> analysis-reports/duplication-audit-2026-09-05/complexity-report.json
```

### 2c. Churn x Complexity hotspots

```powershell
node analysis-reports/duplication-audit-2026-09-05/measure-churn.mjs
# -> analysis-reports/duplication-audit-2026-09-05/hotspots.json
```

Requires `complexity-report.json` to exist first (churn joins on its per-file
max cognitive values) and a git checkout with history.

### 2d. Full rerun (one block)

```powershell
node analysis-reports/duplication-audit-2026-09-05/measure-complexity.mjs
node analysis-reports/duplication-audit-2026-09-05/measure-churn.mjs
npx jscpd src --min-tokens 60 --min-lines 5 --format typescript `
  --ignore "**/*.test.ts,**/*.spec.ts,test/**,dist/**,dashboard/**,analysis-reports/**" `
  --reporters json,markdown --output analysis-reports/duplication-audit-2026-09-05/jscpd-60-5 `
  --silent --no-tips
```

## 3. Calibration rationale

### 3a. jscpd thresholds

Measured 2026-09-05 on `src/` (numbers also in `jscpd-calibration.json`):

| `min-tokens` / `min-lines` | Clones | Duplicated lines | % of codebase |
|-----------------------------|--------|------------------|---------------|
| 50 / 5 | 63 | 697 | 1.26% |
| **60 / 5 (operating point)** | **41** | **519** | **0.94%** |
| 70 / 5 (high-signal subset) | 26 | 381 | 0.69% |

What each band contains (verified by reading clone ranges in source):

- **50–59 tokens (dropped at 60): 22 clones, all idiom-level.** JSON-RPC
  type-guard chains (`mcp/protocol.ts` `isJsonRpcRequest` /
  `isJsonRpcNotification`), SSE `split/filter/map/join/trim` parse chains
  (`backend.ts` `inspectEvent` / `captureEventModel`), `out: string[]` + `push`
  closures (`emitSse.ts` / `emitSseTail`), `console.log` print loops
  (`onboarding.ts`), 6-line accessor/loop bodies (`keystore.ts`,
  `mcp/lane-runner.ts`, `ping/cadence.ts`). Extracting these would *add*
  indirection without removing a maintenance hazard — classic false positives
  for a refactoring audit.
- **60–69 tokens (kept at 60, dropped at 70): within-file repetitions worth
  reviewing.** SSE boundary-scan loops (`backend.ts`), parse → validate →
  try-read guard chains repeated 3x in `dashboard-routes.ts`, a 15-line
  resolver/materialize/`tryServer` block pair in `cli.ts`, 9-line
  attempt-record guard sequences in `circuit-breaker.ts`. Actionable as
  extract-helper candidates, not idioms.
- **>= 70 tokens / >= 20 lines (kept at every threshold): the substantive
  debt.** `routes/messages.ts` <-> `routes/openai-front.ts` multi-block pairs
  (21–33 lines, up to 183 tokens — the Anthropic/OpenAI front-end overlap),
  `config.ts` 33-line twin blocks, `delegate-gate/cast-necessity.ts` <->
  `delegate-gate/shared-state.ts` (21 lines). These survive all three
  thresholds, so recall on real debt is threshold-independent.

**Decision: `--min-tokens 60 --min-lines 5` is the operating point.** It drops
the 50–59-token idiom band (35% clone-count reduction, 63 -> 41) while keeping
every >= 20-line substantive clone and the actionable within-file repetitions.
`--min-tokens 70` is retained as the high-signal subset for CI gating (§6).
`min-lines 5` is held constant: with token gating doing the noise suppression,
raising `min-lines` would only blind the scan to dense 6-line clones that carry
60+ tokens (e.g. `dashboard-snapshot.ts` 6 lines / 71 tokens) — token density,
not line count, is the signal.

### 3b. Complexity thresholds

Instrument counts, 2026-09-05: 123 files, 2,937 functions, max cyclomatic 104,
max cognitive 197. Distribution tails:

- Cognitive >= 15: 201 functions (6.8%) — Phase 2 triage pool ("complex").
- Cognitive >= 10: 361 functions (12.3%) — watch level.
- Cyclomatic >= 10: 303 functions (10.3%) — branch-count screen.

Cognitive 15 is the refactor-candidate bar (Sonar's default maintainability
threshold family; matches the observed knee where handlers become
unreviewable). Cyclomatic 10 is the classic McCabe screen, used only to
corroborate — cognitive is the primary ranking key because it penalizes
nesting, which is the dominant readability cost in the route handlers.

Guard-clause / trivial-accessor suppression falls out of the metric choice:
flat guard chains score ~1 cognitive per guard with no nesting penalty, so a
10-guard function scores ~10 and stays below the bar, while one triply-nested
conditional scores the same as six flat guards. No explicit guard exclusion
list is needed or maintained.

### 3c. Cognitive approximation (what the script actually computes)

`measure-complexity.mjs` implements a documented Sonar-inspired approximation:

- `if` / `else-if` / ternary / `catch`: +1 + current nesting depth.
- Bare `else`: +1, no nesting penalty.
- `for` / `for-in` / `for-of` / `while` / `do` / `switch`: +1 + nesting; bodies
  nest one deeper. Each non-default `case`: +1.
- Logical operators: +1 per maximal operator group (`a && b && c` = 1;
  `a && b || c` = 2). No nesting penalty.
- Nested functions/classes reset nesting to 0 for their subtree; their
  complexity is attributed to the inner function record, never the outer one.
  Methods are recorded as `Class.method`; assigned arrows take the LHS name.

Known deviations from Sonar: no points for `else` + nesting (matches Sonar),
no sequence-of-logical-operator distinction beyond operator groups, no JSX or
decorator handling. Absolute scores are therefore comparable *within* this
repo and across reruns of this script, not against SonarQube dashboards.

## 4. Exclusion criteria

| Excluded | Reason |
|----------|--------|
| `test/**`, `**/*.test.ts`, `**/*.spec.ts` | Test fixtures/duplication is intentional (table tests, setup repetition). No test files currently exist under `src/` (verified 2026-09-05), so the patterns are belt-and-braces for future moves. |
| `dist/**` | Build output; not source. |
| `dashboard/**` | Separate Vite/React app with its own tsconfig and test gate (`check:dashboard`); different duplication norms (JSX). Audit separately if ever needed. |
| `analysis-reports/**` | The audit's own scripts and JSON output — scanning them would flag the instrument as the subject. |
| Barrel re-exports | `export *` / `export { x } from` lines carry near-zero tokens and never reach `min-tokens 60`; no explicit exclusion needed. |

## 5. Churn x Complexity methodology

`measure-churn.mjs` implements exactly:

1. `git log --since="90 days ago" --name-only --format= -- src/` — one row
   per file touched per commit; count rows per normalized (`/`-separated,
   `.ts`-only) path. That count is **Churn** (commit-touch count, not
   lines-changed: a 1-line fix and a rewrite both cost one unit of
   defect/opportunity exposure).
2. Join with `complexity-report.json` per-file `maxCognitive`. Files absent
   from the complexity report (deleted since, or non-`.ts`) score
   `maxCognitive = 0` and sink to the bottom — churn alone never hotspots.
3. `Score = Churn * MaxCognitiveComplexity`, ranked two ways in
   `hotspots.json`: `byScore` (fix priority) and `byChurn` (activity rank).

Reading the two ranks together is the method, not either alone:

- **High churn x high complexity** (`server.ts` 109x108, `cli.ts` 109x95,
  `config.ts` 70x137) — active debt: the files most likely to produce the
  next defect. Refactor first.
- **Low churn x high complexity** (`routes/messages.ts` 5x197,
  `routes/openai-front.ts` 4x196) — stable-but-risky: understood today,
  dangerous on the next touch. These are also the jscpd hotspot pair, which
  cross-confirms the Phase 2 target.
- **High churn x low complexity** (`circuit-breaker.ts` 24x23,
  `catalog.ts` 22x16) — healthy activity; leave alone.

Window notes: 90 days covers ~290 `src/`-touching commits here. Churned-file
count (128) can exceed the current file count (123) because renames and
deletions leave historical rows; that is expected, not an error. Re-run after
large renames if the top-10 looks stale.

## 6. Threshold ratchets for CI / pre-commit

> ⚠ **Status: Tier 1 is DEFERRED, not adopted — owner decision, 2026-09-05 (the Phase 1a lap).**
>
> Tier 1 as written contradicts a standing invariant in `CLAUDE.md`: *"Static analysis is ADVISORY
> and deliberately outside the gate… it is **not** in `npm run check` and CI does not run it — the
> gate stays the two typechecks, the server suite, the dashboard checks and the package checks."*
> The owner deferred the choice until after one full green release cycle, which is what this section
> already proposes for its own Tiers 2 and 3.
>
> **Revisited the same day, after v0.72.2 published with CI green: still DEFERRED.** One publish is
> a thin cycle, and the duplication numbers have not had a chance to move yet. Raise it again after
> a few more releases.
>
> Nothing below is in force. Adopting it means amending that `CLAUDE.md` paragraph in the same
> change, so the two documents cannot state opposite rules. Declining it means saying so here.
> Tracked in [`../backlog.md`](../backlog.md).

Recommended three-tier gating. Tier 1 ships first; tiers 2–3 are opt-in once
Tier 1 is green for a full release cycle.

**Tier 1 — duplication ceiling (CI, blocking).** Fail the build if EITHER:

- jscpd at 70/5 reports more than **26 clones** or more than **0.69%
  duplicated lines**, OR
- jscpd at 60/5 reports more than **41 clones** or more than **0.94%**.

The 70/5 gate blocks new substantive debt; the 60/5 gate blocks new
repetition creep. Baselines are the 2026-09-05 numbers; ratchet DOWN (never
up) after each merged refactor. Suggested job (runs in seconds, no build
needed):

```yaml
# sketch: .github/workflows/duplication-gate.yml
- run: npx jscpd src --min-tokens 70 --min-lines 5 --format typescript
    --ignore "**/*.test.ts,**/*.spec.ts,test/**,dist/**,dashboard/**,analysis-reports/**"
    --reporters json --output /tmp/jscpd-gate --silent --no-tips
- run: node scripts/check-jscpd-baseline.mjs /tmp/jscpd-gate/jscpd-report.json
    # exit 1 when clones > 26 or percentage > 0.69 (baseline file committed in-repo)
```

**Tier 2 — complexity caps on changed code (pre-commit / PR, advisory
first).** Flag any *new or modified* function with cognitive >= 15 or
cyclomatic >= 10. Compare per-function records in `complexity-report.json`
before/after on the PR diff — never gate on repo totals (they legitimately
grow with features). Promote to blocking after one green cycle.

**Tier 3 — hotspot review trigger (quarterly, manual).** Re-run §2d and open a
review whenever a file enters the top-10 `byScore` that was not there the
previous quarter, or whenever any single function exceeds cognitive 100
(current max: 197 — the goal is to pull the ceiling down, not to bless it).

Explicit non-goals: no gating on the 50-token band (idiom noise), no
total-complexity budgets, no dashboard scans in this pipeline.

## 7. Phase 1 baseline snapshot (2026-09-05)

Top 10 churned files (`hotspots.json` `byChurn`):

| Churn | File | MaxCog | Score |
|------:|------|-------:|------:|
| 109 | `src/server.ts` | 108 | 11,772 |
| 109 | `src/cli.ts` | 95 | 10,355 |
| 70 | `src/config.ts` | 137 | 9,590 |
| 48 | `src/backend.ts` | 89 | 4,272 |
| 32 | `src/candidates.ts` | 64 | 2,048 |
| 24 | `src/circuit-breaker.ts` | 23 | 552 |
| 23 | `src/routes/admin.ts` | 180 | 4,140 |
| 22 | `src/dispatch.ts` | 46 | 1,012 |
| 22 | `src/refusal-interpretation.ts` | 41 | 902 |
| 22 | `src/catalog.ts` | 16 | 352 |

Top 10 most complex functions (`complexity-report.json` `topFunctions`):

| Cog | Cyc | Lines | Location |
|----:|----:|------:|----------|
| 197 | 78 | 491 | `src/routes/messages.ts:663` `anthropicMessagesPath` |
| 196 | 77 | 589 | `src/routes/openai-front.ts:118` `openAiFrontPath` |
| 180 | 104 | 278 | `src/routes/admin.ts:253` `handleAdminRoutes` |
| 137 | 83 | 228 | `src/config.ts:1320` `parseRouting` |
| 108 | 63 | 303 | `src/server.ts:412` `handle` |
| 98 | 38 | 108 | `src/dashboard-snapshot.ts:1454` `processRows` |
| 95 | 69 | 189 | `src/cli.ts:2612` `runDispatch` |
| 90 | 58 | 167 | `src/dashboard-routes.ts:634` `handleDashboardRoute` |
| 89 | 44 | 60 | `src/backend.ts:442` `invalidEnvelopeReason` |
| 87 | 49 | 204 | `src/cli.ts:3759` `runPools` |

Cross-signal note for Phase 2: the duplication hotspot
(`routes/messages.ts` <-> `routes/openai-front.ts`), the complexity ceiling
(the same two handlers), and the hotspot rank (`admin.ts` #5 by score)
converge on the route layer plus `server.ts` / `cli.ts` / `config.ts` as the
refactor frontier.

## 8. Artifact inventory

| Path | Contents |
|------|----------|
| `analysis-reports/duplication-audit-2026-09-05/phase1_brief.md` | Phase 1 task brief (input) |
| `analysis-reports/duplication-audit-2026-09-05/measure-complexity.mjs` | Complexity instrument (TS AST) |
| `analysis-reports/duplication-audit-2026-09-05/measure-churn.mjs` | Churn x complexity instrument |
| `analysis-reports/duplication-audit-2026-09-05/complexity-report.json` | Per-function + per-file complexity (2,937 functions) |
| `analysis-reports/duplication-audit-2026-09-05/hotspots.json` | `byScore` + `byChurn` rankings, 128 files |
| `analysis-reports/duplication-audit-2026-09-05/jscpd-report.json` | Canonical duplication report (60/5, 41 clones) |
| `analysis-reports/duplication-audit-2026-09-05/jscpd-report.md` | Same report, Markdown |
| `analysis-reports/duplication-audit-2026-09-05/jscpd-50-5/` | Calibration run: full recall |
| `analysis-reports/duplication-audit-2026-09-05/jscpd-60-5/` | Calibration run: operating point |
| `analysis-reports/duplication-audit-2026-09-05/jscpd-70-5/` | Calibration run: high-signal subset |
| `analysis-reports/duplication-audit-2026-09-05/jscpd-calibration.json` | Threshold numbers + verdict, machine-readable |
| `docs/reviews/duplication-and-complexity-runbook-2026-09-05.md` | This file |
