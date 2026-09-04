# Audit triage 2026-09-04 — every finding of the 2026-09-03 audit, with a verdict

Lap goal (`.claude/lap-start.json`, start commit `8973500`): *Triage the 2026-09-03 audit findings
against HEAD; remediate or explicitly accept the verified items.* Approved by the owner on
2026-09-04. Shipped as **v0.71.0**.

**Scope.** The 35 findings present in [audit-findings-2026-09-03.md](audit-findings-2026-09-03.md):
27 merged conceptual and 8 contract-review findings. The 6 process findings the file's totals line
names were never written into it. That audit was a two-lens run under a nine-lens label —
architecture and maintainability produced every finding, and concurrency and provenance were not
reviewed — so the absence of a finding here is absence of evidence, never evidence of absence.

**Older artifacts are not open work.** The 2026-08-31 remediation run in `.audit-tools/` changed
nothing (165 findings, 0 resolved, its repository gate did not run). The 2026-08-09 audit closed on
2026-08-14 with four fixes.

## 1. Verdict vocabulary

| Verdict | Meaning |
|---|---|
| FIXED | The defect no longer exists at HEAD, with a pinning test wherever a test can pin it. |
| BUILT | The owner directed a capability rather than a fix; built, measured, mutation-checked. |
| RECORDED DECISION | The finding restates an owner decision or a documented rationale; the home is named. |
| OPINION | An architecture or product opinion with no defect to verify; the counter-position is named. |
| OPEN | Verified still present at HEAD; a [`backlog.md`](backlog.md) entry carries the unmet property. |
| OWNER | Needs an owner decision; asked in the lap hand-back and carried in the backlog. |

## 2. What changed in this lap

| Change | Findings | Files | Pinned by |
|---|---|---|---|
| The configuration vocabulary has ONE declaration in `config-types.ts`; `config.ts` imports and re-exports it. The copies had drifted: lap 2's `HedgeConfig` keys `minFloorMs`/`msPerInputToken` existed in `config.ts` only. `openai-request.ts` lost a third copy of `ToolCallIdMode`/`ThoughtSignatureMode`. | DR-001, contract DR-001 | `src/config-types.ts`, `src/config.ts`, `src/openai-request.ts` | `test/config-vocabulary.test.ts` |
| A general guard: no exported name may be declared in two `src/` modules. It found two more pairs, consolidated in the same lap: `QuotaAxis`/`QuotaPeriod` (now imported by `quota-observation.ts` from `dashboard-contract.ts`) and `AccountingSpendCoverage` (now a list plus derived type in `accounting-store-schema.ts`, re-exported by `accounting.ts`; the schema's validator reads the list). `Verdict` is allow-listed as two different concepts sharing a word. | DR-004, contract DR-008 | `src/quota-observation.ts`, `src/accounting.ts`, `src/accounting-store-schema.ts` | `test/one-declaration.test.ts` |
| The duplicate `ProxyAccountingFailureKind` declaration is gone; `accountingFailureForAttempt` classifies a relay-authored provenance FIRST through a total `RELAY_AUTHORED_PROVENANCE` table, so a `relay-mapper-defect` outcome is `protocol` in the ledger and never `provider_error`. | contract DR-003, orchestrator item 4 | `src/candidate-runner.ts` | `test/accounting-failure-kind.test.ts` (lists closed against the kernel unions) |
| `GET /v1/models` advertises `context_window`/`max_context_window` only when a rung resolved one; an unresolvable id carries neither field, and `description` states the figure and its provenance. The relay-reserved `auto` id resolves through `resolveAutoSpec` first — it had borrowed `openrouter/auto`'s 2,000,000-token snapshot window. Codex v0.153.2 was measured tolerating the omission against a scratch relay on port 8792: it fetched `/v1/models?client_version=…` and proceeded to `/v1/responses`. | contract DR-004 | `src/routes/admin.ts` | `test/models-endpoint.test.ts` |
| `BODY_TOO_LARGE_CODE` is owned by `stream-pipeline.ts` with `bodyReadStatus` (413 for the tag, 400 otherwise); `server.ts` classifies by the code, and `dashboard-routes.ts` re-exports it. The data plane used to match the message text, and the data-plane module imported the code from the dashboard module. | contract DR-005, DR-014 | `src/stream-pipeline.ts`, `src/server.ts`, `src/dashboard-routes.ts` | `test/stream-pipeline.test.ts` |
| The hedge race settles at COMMIT (first meaningful content). `withCommitProbe` runs the stream-commit probe inside each attempt's promise, `attemptWon` requires a `ready` verdict, and both fronts consume the attached verdict through `takeCommitProbe`. The stale prose in `hedge-trigger.ts` ("nothing in src/ calls it yet") is corrected. | DR-002, DR-014 | `src/candidate-runner.ts`, `src/routes/messages.ts`, `src/routes/openai-front.ts`, `src/hedge-trigger.ts` | `test/hedge-wiring.test.ts`: six new cases on both fronts; mutation A (wrapper off) ⇒ 4 red, mutation B (probe ignored) ⇒ 2 red |
| The DR-020 residue is gone: `SnapshotMutationResult` names only live members, `AccountingReadHooks` replaces the journal hooks. The never-adopted `JsonStore` class and its test are deleted. | DR-020 residue, DR-011 (part) | `src/accounting-store.ts`, `src/storage/json-store.ts` | existing suites |
| `scripts/analysis-run.mjs` prints each tool's exit code AS an exit code, writes a `.json` report only from stdout and only when it parses, and lets jscpd's own reporter write `jscpd-report.json`. | DR-018, orchestrator item 5 | `scripts/analysis-run.mjs` | none (script) |

**On DR-002, what was measured.** `fetchBackend`'s structural preflight already made "response
resolution" mean the first VALID DATA EVENT, so a provider that sent headers and then nothing was
hedged before this lap. The first version of the pinning test sent exactly that, and with the
wrapper disabled it stayed green. The uncovered shape was headers plus a metadata event (a role-only
chunk, a `message_start`) and then silence — how hidden-reasoning providers open a stream. The test
backend now sends that preamble, and the mutation checks turn red. Per-token (rule 1) stays inert on
the hedge path by construction: no output token exists before commit. Its only honest home is a
post-commit policy, which is an owner decision (§5).

## 3. Verdicts — merged conceptual findings (27)

| # | Finding | Verdict | Evidence, reason, home |
|---|---|---|---|
| DR-001 | `config-types.ts` duplicates the configuration surface | FIXED | §2. `test/config-vocabulary.test.ts` asserts the two `EFFORT_LEVELS` bindings are one object. |
| DR-002 | The hedge's per-token rung is unreachable while the feature is default-ON | BUILT | Owner direction: the hedge exists for wedged requests. Race-to-commit built and mutation-checked; per-token documented as inert on the hedge path (`CLAUDE.md` hedge rows, hedge design §12). Post-commit remedy → OWNER (§5). |
| DR-003 | Hedging duplicates third-party free-tier traffic; the terms review predates it | OWNER | True as stated: D1 confines hedging to free deployments, and `codex-review-2026-08-05.md` covers Anthropic only. Backlog entry "does hedging need a terms review?". |
| DR-004 | Defect prevention is per-instance; the next duplicate lands free | FIXED | `test/one-declaration.test.ts` is the general guard; it found and closed three more duplicates in this lap. |
| DR-005 | The decomposed request path has no test boundaries; the canonical ordering proof runs dead code | RECORDED DECISION | `CLAUDE.md` `circuit-breaker.ts` row records `orderByUsability` as a test-only seam and names the live path (`targetUsability` + `orderDeploymentGroupsByUsability`). Residual, noted: the live ordering has no direct unit test; `test/hedge-wiring.test.ts` and the new tests now import the route and runner modules directly. |
| DR-006 | The metering subsystem cannot report that it stopped metering | OPEN | Verified: `writerStatus`/`lastWrite` have zero consumers outside `accounting-store.ts`. Backlog entry with the property. |
| DR-007 | No Demotion value type; the cooling comparator inverts latency demotion | PARTLY STALE / OPINION | The inversion was fixed before this lap: latency-demoted members form the `slow` band (`bbe1d20`, 2026-09-03; `candidate-runner.ts` `targetUsability` returns `"slow"`). A `Demotion` value type is a refactor opinion; no defect remains to verify. |
| DR-008 | `checkCwd` never resolves `..` | FIXED | `cadefcc` (2026-09-03), the same defect as contract DR-002. |
| DR-009 | The ledger's writer lease is process-local and the store opens before the listener binds | OPEN | Verified: `cli.ts` creates the store (line 962) before `server.listen` (line 972); `server.ts` registers no `error` handler. Backlog entry with the property. |
| DR-010 | The never-spend-money guard resolves through a regex over the model id when prices are cold | RECORDED DECISION | `assessCost` admits a free-labelled id on the `free-labelled` basis and a free-tier provider's unpriced model on `provider-tier`; `unknown` counts as paid. `CLAUDE.md` `dynamic-pools.ts` and `metadata.ts` rows state both rules. |
| DR-011 | Consolidation modules land but adoption never finishes | PARTLY FIXED | `JsonStore` (zero consumers) deleted this lap. `backend.ts`'s three private SSE pipelines are a recorded deferral (`sse-frames.ts` row, review finding 13). `SPEND_CELL_KEYS` vs `SHARE_CELL_KEYS` (two lists of one set) → folded into the export-pruning backlog entry. |
| DR-012 | The decomposition published a namespace, not modules (87 exports, 37 unconsumed) | OPEN | Verified: 90 exports at HEAD (three added by this lap's race-to-commit seam). Backlog entry with the property. |
| DR-013 | One unsupervised process, no back-pressure, catalog work on the request path | OPINION | `docs/project-goals.md`: a personal tool for one operator's traffic. Pool materialization is memoized (30 s epoch). No measured incident. |
| DR-014 | Decomposition seams are declared in prose that has rotted | FIXED | All three instances: the `hedge-trigger.ts` header, the 413 prose match, and the data-plane→dashboard import. |
| DR-015 | The dashboard tier serves one reader; version negotiation rejects legitimate requests | OPINION | The 406 on an `Accept` that does not name the contract is the API's design; the SPA sets its `Accept`. Not verified as a defect. |
| DR-016 | `typescript` is a 23 MB runtime dependency for delegate-gate | RECORDED DECISION | `CLAUDE.md` `delegate-gate/` row states the reason: the AST detectors need the compiler API in an installed package. |
| DR-017 | The contributor map is one 231 KB file guarded only for presence | OPINION | The map is the project's chosen form. Residual, noted: `test/architecture-map.test.ts` checks a row's presence, not its truth. |
| DR-018 | The analysis channel grades exit codes as findings | FIXED | §2. |
| DR-019 | Two persisted performance stores yield two scores averaged into one term | RECORDED DECISION | `CLAUDE.md` `benchmarks.ts` row: capability and operational axes are separate by design, joined in `deploymentFitness`. |
| DR-020 | A hand-built write-ahead log guards a personal token counter | FIXED | `751fb52` (owner decision: shrink); residue removed this lap. |
| DR-021 | `cli.ts` is a second 4,312-line entry point with a hand-rolled parser | OPINION | The parser's two known hazards carry guards (`CLI_COMMAND_NAMES`, `COMMAND_ARITY`, the alias table); a framework rewrite is the enterprise-shaped refactor `suggestion-review-2026-08-04.md` rejects. |
| DR-022 | Dispatch is a second product with four front doors; the MCP door holds cold state | RECORDED DECISION | Four doors are the recorded design (`dispatch.ts`, `mcp/server.ts` rows). The cold-state half is contradicted: answer mode posts to the live relay (`lane-runner.ts` `relayLoopbackUrl`). |
| DR-023 | The keystore ranks last and is inert on the supported install path | RECORDED DECISION | Precedence env > `.env` > keystore is documented (`authEnv.ts`, `dotenv.ts` rows; the custody-rotation gotcha). |
| DR-024 | Sixteen routing keys with defaults that spend or duplicate on a fresh install | OPINION + OPEN (docs) | The defaults are owner decisions (hedge, latency, laneProbe). The disclosure gap in `docs/reference.md` is a backlog entry. |
| DR-025 | Five fact kinds are parsed and expired but route nothing | RECORDED DECISION | Display-only by owner decision (`context-limits.ts`, `rate-limits.ts`, `network-block.ts` rows; spec decision M2 opt-in). |
| DR-026 | llm-bridge is trusted for half its job with no stated boundary | RECORDED DECISION | The boundary is written: `backend.ts`, `openai-request.ts`, `responses-request.ts` rows name which direction is relay-owned. |
| DR-027 | The fundamental approach is sound; consolidations need a grep guard | POSITIVE | Agreed; `test/one-declaration.test.ts` is that guard, generalized. |

## 4. Verdicts — contract review findings (8)

| # | Finding | Verdict | Evidence, reason, home |
|---|---|---|---|
| DR-001 | Two live definitions of the config vocabulary; `EFFORT_LEVELS` exists twice at runtime | FIXED | Same as merged DR-001. |
| DR-002 | `allowedRoots` containment is bypassed by a `..` segment | FIXED | `cadefcc`; `CLAUDE.md` `mcp/lane-runner.ts` row. |
| DR-003 | The ledger blames the provider for relay-authored refusals | FIXED | §2; `test/accounting-failure-kind.test.ts`. |
| DR-004 | `GET /v1/models` advertises an invented 272000-token window | FIXED | §2; Codex measured tolerating the omission. |
| DR-005 | The declared `BODY_TOO_LARGE_CODE` tag is ignored by the data plane | FIXED | §2. |
| DR-006 | Forward-path credential containment is a two-entry deny list | OPEN | Verified: `INBOUND_AUTH = ["authorization", "x-api-key"]` (`candidate-runner.ts`). Backlog entry with the property. |
| DR-007 | 36 of 87 `candidate-runner.ts` exports have no consumer | OPEN | Same as merged DR-012; one backlog entry. |
| DR-008 | The closed-vocabulary guard suites are blind to duplicate vocabularies | FIXED | `test/one-declaration.test.ts`. |

## 5. Owner decisions taken and pending

Taken on 2026-09-04: the lap plan as stated; the groq TPM 429 interpretation accepted
(`rate-limited` / `attempt`; the seconds-unit signature `a568e0cbe2` was already confirmed and the
millisecond-unit sibling `e50c11ddc0` was accepted this lap); the 63 advisory eslint errors →
switch off per file with the invariant named, outside this lap; the hedge — *"The point of the
hedge is to handle wedged requests, or requests so slow as to be practically wedged. Rule 1 seems
important to that."* — → race-to-commit built.

Pending, asked in the hand-back and carried in [`backlog.md`](backlog.md):

1. **The post-commit remedy.** A stream that commits and then stalls or crawls cannot be hedged;
   the client holds its bytes. Option A: abort on a measured per-token stall threshold and let the
   client retry, after measuring what Claude Code and Codex do on a mid-stream error. Option B:
   leave in-flight streams alone; latency demotion and the `slow` band move the NEXT request.
2. **A terms review for hedging.** Duplicate free-tier requests are the design (D1); no terms
   review covers the providers this relay fronts.

## 6. Lane sweep and verification

The 27 findings outside the orchestrator's verified five were swept by three `claude-free-pool`
(`pool/medium`) jobs through MCP `dispatch` (job-0002: DR-003..DR-011, 1246 s; job-0003:
DR-012..DR-021, 415 s; job-0004: DR-022..DR-027 + contract DR-006..DR-008, 670 s). Lane output is
advisory: every claim adopted into a verdict above was re-checked against source in this session
(the `slow` band, `writerStatus` consumers, the store-before-listen order, the free-label rung,
the three SSE pipelines, the export count, the deny list). Two lane claims were rejected on that
check: DR-007's ordering inversion (fixed before the audit was triaged) and DR-022's cold MCP
state (answer mode is live).

The first attempt through three `relay` subagents lost every job when the session hit its usage
limit mid-run — the MCP connection was replaced and the job ids reset. Recorded as a machine-wide
standing trap in `C:\Code\docs\backlog.md`.

## 7. What remains, each with its home

- Owner decisions 1 and 2 above — `docs/backlog.md` Open, and the hand-back.
- DR-006, DR-009, DR-012 / contract DR-007, contract DR-006, DR-024 (docs) — `docs/backlog.md`
  Open, each with its unmet property.
- The ESLint decision's execution, the `publish.yml` timeout, the Codex Desktop `relay` check, the
  path-sensitive keyring test — `docs/backlog.md` Open (pre-existing entries).
- Nothing else from the 2026-09-03 audit is unaddressed. The audit-tool defects stay out of scope
  (owner decision 2026-09-03).
