# Refactor consistency audit — 2026-09-01

Scope: the 98 uncommitted paths present at lap start (`ec5c16f`). Another model decomposed
`src/server.ts` (5,799 → 863 lines, a net −4,936) into `routes/messages.ts`, `routes/openai-front.ts`,
`candidate-runner.ts`, `stream-pipeline.ts`, `accounting-state.ts`, `config-types.ts`,
`storage/json-store.ts` and `kernel/protocol-ir.ts`.

**The gate was green before this audit began.** `npm run check` passed on tree `2666aff05ed2`:
server 147 files / 2,860 passed / 5 skipped; dashboard 5 files / 32 passed; package checks passed.
Every defect below therefore passed the suite. Green did not mean correct.

## Method

- All 104 top-level functions of the original `server.ts` were located in the new tree. None was
  lost.
- Each old function body was extracted, comment-stripped and compared against its new home.
- Survivors were then read against the invariants `CLAUDE.md` records for them.

⚠⚠ **PROVENANCE OF THE "BEFORE" STATE — read this before checking any claim here against `git`.**
Every defect below was found and repaired in the WORKING TREE, before the first commit of the
sprint. The broken state therefore exists in no commit and cannot be reconstructed from history.
An independent auditor confirmed this on 2026-09-01: `git show ec5c16f:package.json` and
`package.json` at HEAD are byte-identical for `build:server`, and `git log ec5c16f..HEAD --
package.json` is empty — exactly what a defect repaired before commit looks like.

So the evidence for each "was broken" claim is a MEASUREMENT taken at the time, named in place
below, not a diff. Where a claim can be checked at HEAD it says so, and every such claim was
independently confirmed. A future reader wanting the broken state has only this document.

## Confirmed defects

### 1. The two-pass build was deleted — an owner decision reverted

`package.json` `build:server` lost its second `tsc` pass. `CLAUDE.md` marks that pass load-bearing
(owner decision 2026-08-30, package-size variant C) and says in bold not to collapse the two passes.

Measured cost, same tree, only the script differing:

| | packBytes | unpackedBytes | entries |
|---|---|---|---|
| Pre-refactor baseline | 916,365 | 4,787,349 | 368 |
| Refactor, one pass | 1,180,450 | 5,474,033 | 392 |
| Refactor, two passes restored | 936,693 | 4,872,345 | 392 |
| Final, after deleting `protocol-ir.ts` | 937,955 | 4,875,246 | 389 |

⚠ The final row is three entries smaller and ~1.3 KB larger, which is the two-pass split doing
exactly its job: the deleted module drops three `dist/` entries, while the invariant prose restored
in this lap lands in the `.d.ts` files, which pass 1 keeps on purpose.

⚠ `check:package` measures whatever `dist/` holds. A gate run immediately after deleting a source
module still reported 392 entries, because it measured a stale `dist/`. Rebuild before trusting a
package figure.

The deleted pass accounted for 243,757 `packBytes`. The honest refactor cost is +20,328 `packBytes`
and +24 entries.

`docs/dashboard-package-baseline.json` had been regenerated with the inflated figures and its
ceilings raised to match, so the gate stayed green over the regression.

**Action taken:** the second pass is restored; the baseline now records the honest figures with the
same proportional ceiling headroom the file used before.

### 2. `readBody` stopped declaring its error code — an oversized body now answers 500, not 413

`src/stream-pipeline.ts` rewrote `readBody` to throw a plain `Error` whose *message* embeds
`BODY_TOO_LARGE_CODE` as text. `bodyReadErrorCode` in `dashboard-routes.ts` classifies on
`error.code === BODY_TOO_LARGE_CODE`, so the property is absent and every oversized dashboard
request downgrades from `oversized` (413) to `internal` (500).

This reinstates the exact defect `CLAUDE.md` records as fixed:

> ⚠ `bodyReadErrorCode` reads a DECLARED `BODY_TOO_LARGE_CODE` off the rejection; it used to regex
> the error MESSAGE, i.e. the relay inferring 413-vs-500 from prose it wrote itself.

The rewrite also dropped `req.resume()`, the drain that lets the client receive the explicit
response, and dropped the `DEFAULT_MAX_BODY_BYTES` default.

No test caught it: `test/dashboard/routes.test.ts` injects its own `readBody` stub.

**Action taken:** the reviewed implementation is restored. `test/stream-pipeline.test.ts` is new and
pins the declared code, the drain, error propagation and the default ceiling.

### 3. `parseAssistant` demanded a field its own contract does not declare

The rewrite gated on `parsed.role === "assistant"`. `AssistantMessage` in `src/anthropic.ts`
declares no `role` field. A body that omits it parsed as `null`, which silently skips validation and
repair — the project's core path.

The rewrite also cast the parsed object wholesale instead of copying fields, so an absent
`stop_reason` became `undefined` rather than `null`. `emitSse` writes that field back to the wire,
where `undefined` omits the key and `null` states it.

**Action taken:** the reviewed constructor is restored, with the reason recorded beside it.

### 4. `frameOpensToolUse` stopped joining multi-line SSE data

The rewrite parsed each `data:` line on its own and split on `"\n"` alone. SSE permits one payload
spread over several `data:` lines, and `sse-frames.ts` already establishes joining as the
convention here. A multi-line `content_block_start` frame therefore answered `null`, so the
tool_use withholding trigger never fired for it.

**Action taken:** the collect-and-join form is restored, with CRLF-tolerant splitting.

### 5. 1,267 lines of invariant prose were deleted from the request path

`server.ts` carried 1,350 comment lines. **As received**, its six successor files on the request
path carried 83 — a 94 percent loss, with `src/server.ts` itself at zero.

⚠ Counted as `grep -cE "^\s*(//|/\*|\*)"` over exactly `src/server.ts`, `routes/messages.ts`,
`routes/openai-front.ts`, `candidate-runner.ts`, `stream-pipeline.ts` and `accounting-state.ts`.
`config-types.ts` and `storage/json-store.ts` are excluded: they are newly authored type and
infrastructure modules, not homes `server.ts`'s prose moved into. **At HEAD the same six count 138**,
because this lap restored 55 lines. Both figures are correct for their own tree, and an auditor
measuring HEAD will not reproduce 83 — that is the point of stating which tree each describes.

This is not cosmetic in this repository. `CLAUDE.md` cites `server.ts` as the *home* of recorded
arguments and instructs later readers to obey them. The `latency-demotion.ts` row says the
`server.ts` argument against re-ranking on stability "BOUNDS the design" and that a later reader
"must not 'restore' the old behaviour as a regression fix". That argument is now gone from the code.

Phrases confirmed absent from the whole new request path: "two ranking passes", "second ranking
pass", "relay-abandoned", "never invents", "loopback is not authorization", "byte-exact",
"fail-clean".

**Status:** partly repaired. See "Owner decisions and residue" below.

## Verified sound

- All 104 original top-level functions survive.
- `completeAttemptCancelled`, `completeAttemptAbandoned`, `nextUncappedAttempt`,
  `respondAllCapped`, `runAttemptWithHedge`, `walkWouldFailOver`, `targetUsability`,
  `ServedAnnouncementContext` and `AttemptRun` all live once, in `candidate-runner.ts`, and both
  fronts import them. The "two fronts, one policy" rule holds structurally.
- `frameEnd` changed form (a manual byte loop in place of a `latin1` `indexOf`) but is
  behaviourally equivalent, and it remains a byte scan, which is the recorded invariant.
- `PROVENANCE_REACHES_HEALTH_PATH`, `CANCELLATION_REACHES_HEALTH_PATH` and
  `CANCELLATION_EVIDENCE_MS` are untouched in `circuit-breaker.ts`.

## Owner decisions and residue

- **`src/kernel/protocol-ir.ts` was a fifth defect, not a neutral design question.** The refactor
  REINTRODUCED the canonical IR that `CLAUDE.md` and `src/kernel/contracts.ts` both say was deleted
  on 2026-08-04 and must not be rebuilt. Filing it under "owner decision" alone reads as a clean
  architectural call; it was a forbidden surface re-added and walked back the same day. That framing
  correction comes from the independent closeout auditor and is the right one.

  DELETED by owner decision 2026-09-01, with its test. It was 116 lines of `Normalized*` types plus
  three type guards, imported by no `src/` file.

  It passed `test/architecture-map.test.ts` only because that test accepts a row naming the
  containing directory, and `kernel/` has one — the very row that says the canonical-IR surface was
  deleted on 2026-08-04 and must not be rebuilt. So the file satisfied the test while contradicting
  the sentence the test was pointing at.

  The four technical reasons — a rival hub beside `src/anthropic.ts`; closed where `ContentBlock`'s
  `OpaqueBlock` and `StopReason`'s `| string` are deliberately open; a `NormalizedUsage` that can
  express neither the separately-priced cache split nor unknown-as-null; and llm-bridge's universal
  IR already being this project's worst shipped defect — are recorded in `src/kernel/contracts.ts`
  beside the original history note, which is their one home.
- **15 static-analysis rules had been switched off** in `eslint.config.mjs` with generic
  justifications. Reverted by owner decision 2026-09-01; the four added stream globals
  (`TransformStream`, `WritableStream`, `ReadableStreamDefaultReader`,
  `TransformStreamDefaultController`) are genuinely needed and stay.

  ⚠ **Correction to this audit's first reading.** The revert surfaces 63 errors, and the CODE that
  produces them is PRE-EXISTING. The suppressions were reducing inherited advisory noise, not
  concealing the refactor's own findings. They were still wrong to add unlabelled — the file's
  convention is one named invariant per disabled rule — but they were not a cover-up, and this
  document should not be read as claiming they were.

  ⚠⚠ **A SECOND correction, from the independent closeout auditor.** This paragraph first said the
  errors were "in files the refactor never touched". **That phrasing is false**, and the difference
  matters. Of the 16 `src/` files carrying the 63 errors, only four are genuinely untouched
  (`circuit-breaker.ts`, `dashboard-routes.ts`, `dashboard-snapshot.ts`, `dashboard-static.ts`); the
  other twelve were modified in the sprint, and one — `candidate-runner.ts` — the refactor CREATED.

  The defensible claim is about the CODE, not the files, and it rests on three measurements:
  `candidate-runner.ts`'s single error sits on `credentialAttemptLabel`, a body moved BYTE-FOR-BYTE
  from `server.ts:2430`; the `rate-limits.ts` and `refusal-interpretation.ts` regexes carry
  identical complexity scores on unchanged lines; and the whole tree scored **155 errors at
  `ec5c16f` under that commit's own config against 63 at HEAD**, so the refactor left the codebase
  cleaner by this measure, not dirtier. "Moved code keeps its findings" is the accurate statement.
  "The refactor never touched those files" was a convenient shorthand that the evidence does not
  support, and I should not have written it.

  ⚠ One further unmentioned change stands: the file also swaps the base `no-redeclare` off for
  `@typescript-eslint/no-redeclare: 'error'`. That is kept deliberately — the TypeScript-aware rule
  is required for declaration merging, and it is set to `error`, so it is stricter than what it
  replaces, not a suppression.
- **`vitest.config.ts` gained `pool: "forks"`** with nothing recorded about why. Measured: the full
  suite passes with it and without it (148 files, 2,865 passed, 5 skipped, same duration either
  way), so it is not load-bearing for correctness. Kept by owner decision 2026-09-01, for Windows
  flake resistance, with that reasoning now recorded beside the line.
- **`opencode.json` lost 26 lines**; `knip.config.json` gained five ignored dependencies.
- **The invariant prose loss (defect 5)** is only partly repaired. Three recorded arguments that
  `CLAUDE.md` cites by name are restored at their new homes: the "two ranking passes" rejection and
  its 2026-08-30 owner amendment above `orderByUsability`, the `SERVED_BY_HEADER` contract inside
  `responseHeadersForTarget`, and the reason `markAttemptCommitted` records on the attempt itself.
  The remaining loss is not mechanically recoverable, because much of it described code that moved.

- **The eight installer-owned files** (`.agent/skills/`, `.gemini/commands/`, `.github/agents/`,
  `.github/prompts/`, `opencode.json`) are unrelated to the refactor. They drop `allow` entries and
  add none, so the change is fail-safe, but nothing records why they were regenerated.

## Result

After the repairs, `npm run check` passes on tree `25037a8a4cc3`: server 148 files, 2,865 passed,
5 skipped; dashboard 5 files, 32 passed; package `packBytes` 937,955 against a 939,900 ceiling, 389 entries.

## Round two — control flow, after the release (2026-09-01)

The first pass compared function BODIES. That cannot see a reordered guard, because `handle` shrank
683 → 271 lines and `openAiFrontPath` grew 17 → 561: those two handlers were RESTRUCTURED, not
moved. A second pass covered exactly that, and found three more behaviour changes. All three are
confirmed against `git show ec5c16f:src/server.ts`, and all three shipped in v0.68.7.

⚠ **The second pass was NOT completed, and its coverage is one region of four.** A multi-agent
verification was launched over four regions — `anthropic-walk`, `openai-front`, `repair-streaming`
and `headers-accounting`. Nine of its ten agents died on an account spend limit. Only
`repair-streaming` was analyzed, and its findings' adversarial refuters died too, so the run
reported them as "refuted" with EMPTY reason lists — a zero-vote result read as a unanimous one.
The findings below were then verified by hand instead. **`anthropic-walk`, `openai-front` and
`headers-accounting` have had no control-flow review at all.** That is the largest open gap in this
audit; the body-level comparison covering them is not a substitute.

### 6. The Anthropic front re-read the clock per candidate

The original built ONE `CredentialWalk`, before the front branch, on the frozen `routingNow`:
`selectionNow: routingNow` and `evidenceFor: (attempt) => credentialEvidence(…, routingNow)`. The
same instant drove `orderDeploymentGroupsByUsability`, `rankCredentialAttempts` and the walk.

The decomposition split it into two walks. `server.ts` kept `routingNow` for the OpenAI front;
`routes/messages.ts` built its own with `selectionNow: Date.now()` **and an `evidenceFor` that calls
`Date.now()` again on every invocation**. So the Anthropic front's walk disagreed with the ordering
that produced its own candidate list, its two fronts ran different policies, and a cooldown lapsing
mid-walk changed the answer part-way through — the walk was no longer deterministic.

**Action taken:** `routingNow` is threaded through `MessagesContext` and used for both. One clock,
one policy, both fronts.

### 7. The context guardrail gained a second rung, and its refusal body lied about the source

`observedContextLimit` has ZERO hits in `ec5c16f:src/server.ts`. The new guardrail reads it AHEAD of
the published figure, so a relay-LEARNED ceiling now drops candidates from the walk and can refuse
the request locally with a 400 — where the request previously went upstream.

The behaviour is kept: a `context-limit` fact is recorded only when the deployment itself STATED its
maximum while refusing, which is first-party evidence about the exact deployment, and
`contextWindowResolver` already ranks it above a catalogue figure for the same reason.

**The defect was the provenance label.** The 400 body said the limit was what the provider
"publishes" whatever rung produced it — a measurement reported as a publication, which is the one
thing the provenance invariant forbids.

**Action taken:** the two rungs are extracted into `contextCeilingFor`, which returns the basis
alongside the number; the refusal body now names the rung. `CLAUDE.md`'s guardrail gotcha is
amended, including the two residual costs (a 30-day TTL keeps a raised ceiling stale, and the
refusal is reachable where the request previously went upstream). `test/context-ceiling.test.ts`
pins the rung order, the basis and the null-means-no-guardrail rule.

⚠ Extracting the helper also cut `handle`'s cognitive complexity from 101 to 94. An intermediate
version of the fix RAISED it to 105; the working note that claimed a reduction at that point was
wrong and is corrected here.

### 8. `forwardLocalResponse` inverted its fail-clean ordering

Original: `const bytes = Buffer.from(await response.arrayBuffer()); if (!res.headersSent)
res.writeHead(…); res.end(bytes);` — body first, head second.

New: `writeHead` first, then the body streamed chunk-by-chunk.

This is the local-failure exit of BOTH candidate loops — `RequestMappingError` 400s, `DocumentError`
400s, dialect destructive refusals — where the contract is to fail CLEAN. While the head is unsent
the caller can still answer with a proper status; once it is sent, a body read that rejects leaves
the client a truncated body under a committed status.

⚠ Practical risk was low: these are relay-authored, already-materialized in-memory `Response`
objects, so a body-read rejection is close to impossible. The ordering is still the reviewed one and
costs nothing to keep.

**Action taken:** the buffered form is restored, with the reason recorded beside it.
`test/stream-pipeline.test.ts` pins that a rejecting body leaves the head UNSENT — a test the
streaming version fails twice over, because it commits the head and never throws at all.

## Round three — the three remaining regions, reviewed by hand (2026-09-01)

Owner decision 2026-09-01: review the gap by hand rather than re-running the workflow. Method: for
each region, extract the ORIGINAL control flow from `ec5c16f:src/server.ts`, strip comments and
blank lines, collapse whitespace, and diff it line-for-line against the new home.

⚠ **This corrects a measurement in round two.** That section reported `openAiFrontPath` growing
"17 → 561 lines". Wrong: the ORIGINAL is 630 lines (`ec5c16f:src/server.ts` 4112–4742) and the new
one is 590. The earlier figure came from a textual extractor that matched the multi-line
signature's parameter braces instead of the body — the same false-match this document already warns
about. The front largely MOVED; it was not rewritten, and the risk was lower than round two implied.

### Result

| Region | Verdict |
|---|---|
| `openai-front` | ONE defect (below). Otherwise control-flow identical. |
| `anthropic-walk` | The SAME defect. Otherwise control-flow identical. |
| `headers-accounting` | Clean. |

### 9. Both fronts hand-built `ProviderTargetIdentity` instead of calling `targetIdentity`

The original called `beginHealthAttempt(h, run.resolvedAttempt, egressAt, attemptTrace, run.usage,
accounting)`, which builds the identity through `targetIdentity` — ONE definition, shared.

The decomposition inlined that on BOTH fronts, rebuilding the identity field by field:

```
const identity = { provider: run.target.provider, model: run.target.model ?? null,
                   kind: run.target.kind, credentialId: run.resolvedAttempt.credentialId,
                   base: run.target.base };
```

That makes a THIRD private copy of target-identity construction. `kernel/contracts.ts` records
having already closed exactly this drift once, between `circuit-breaker.ts` and
`kernel/request-lifecycle.ts`, with the reason stated in place: *"nothing in the type system would
have caught the two drifting: adding a field to `ProviderTargetIdentity` that ONE copy compares
makes the breaker and the lifecycle disagree about whether a handle belongs to the …"*.

⚠ The copies also dropped `targetIdentity`'s `Object.freeze`, so the identity a completed attempt
carried was mutable on both fronts where it had been frozen.

⚠ The VALUES are identical today, so no behaviour changed and no user was affected. This is the
drift hazard itself, caught before it cost anything.

**Action taken:** both fronts call `beginHealthAttempt` again, with the reason recorded beside each.
After the fix both regions diff clean against the original except for the mechanical rebinding of
free variables onto a context object (`path` → `ctx.path`) and two type renames.

### Checked and cleared — NOT defects

- **The deleted `credentialRecorded = true;`** in the OpenAI front's `finally`. It looked like a
  dropped flag write, but `credentialRecorded` is declared INSIDE the `while` loop and the `finally`
  ends that iteration, so nothing reads the value afterwards and the next iteration re-declares it
  `false`. The assignment was already dead in the original.
- **`target` moved from an outer variable to a loop-local `let`.** The original reassigned it at the
  top of every iteration and the post-loop code — the all-capped refusal site — never reads it.
- **`paidLabel`** gained `?? null` on `cachedLimits(...)`, normalising `undefined` to `null` for the
  widened parameter type. Same logic.
- **`respondAllCapped`, `walkExitHeaders`, `degradedLabel`, `completeAttemptSuccess`,
  `recordCredentialOutcome`, `withRepairAccounting`, `recordEarlyTerminalAccounting`** — bodies
  equivalent. `completeAttemptSuccess` still completes the breaker attempt, records the trace and
  the model call, completes accounting, calls `clearFacts`, and clears credential faults on a
  disproved `credential-invalid`.
- **`responseHeadersForTarget`** — `!== undefined` became `typeof === "number"`, which is stricter
  in the safe direction. Same order, same names.

⚠ **A method note worth keeping.** A textual function-body extractor mis-identifies a body whenever
the signature spans lines, because it takes the first `{` — which is then a parameter's inline type.
It produced a false "17 → 561" in round two and three false "CHANGED" rows here. Diff a LINE RANGE,
or read the body, before believing such a tool.
