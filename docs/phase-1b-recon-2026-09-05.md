# Phase 1b recon — what the free lanes produced, and what verification found

2026-09-05. Written at the Phase 1b lap open, before any code moved.

The owner asked for this lap's work to be offloaded through llm-relay. Reconnaissance for all
seven Phase 1b items was therefore dispatched to free lanes, and each returned packet was then
checked by two adversarial lenses reading the real source: CLAIMS-ARE-REAL (are the named symbols,
line ranges and quoted documents real at HEAD) and BEHAVIOUR-IS-PRESERVED (does the step list
change anything observable).

21 agents, 0 errors, 3.48 M subagent tokens, 21 minutes.

## Headline: the free lane cannot do reconnaissance in this repository

**All 7 lane packets failed both lenses. 14 verdicts, 14 times `packetSound: false`.**

The failures are not shallow. The P1-04 packet invented two symbol names that exist nowhere in the
repository (`stripThinkTagsFromStream`, `rewriteToolUseIdsFromStream`), invented line ranges for
them, invented an `sse.ts` API (`transformSSEStream`, `parseSSE`) and then argued against the real
plan on the strength of that invention — while the real plan document it claimed to be quoting
carries no line numbers at all and says so as an explicit invariant. The P1-06 packet returned an
empty step list and blamed a total tool-access failure; the verifying lens read all six files with
ordinary `cat` and `grep` from the same directory.

⚠ **The `null` fallback did not fire, and could not.** The pipeline was built to fall back to a
paid model when a lane returns nothing. Every lane returned something — plausible, structured and
wrong. A fallback keyed on absence does not catch a confident fabrication. Only the verify stage
did.

Lane record during the run: `free-pool` 7 calls, 5 ok, 2 failed, 2 timed out, served throughout by
`kilo/nvidia/nemotron-3-ultra-550b-a55b:free`. The lane was healthy. The answers were not.

⚠ Separately, an `opencode-muse-spark` probe at `--variant xhigh` — read one file, report its line
count — ran **683 seconds** without answering and was cancelled. The owner reports other agents
dispatching to that lane concurrently, which is the likely cause.

## What verification established, per item

These are the corrected facts. Each was read from source at HEAD by the verifying agent, and the
P1-04 and P1-06 entries were independently confirmed by hand in the orchestrating session.

### P1-04 — SSE scaffold. The plan was right; the packet was not.

The real functions are `stripThinkTagsInStream` (`src/think-tags.ts:142-217`) and
`rewriteToolUseIdsInStream` (`src/tool-use-ids.ts:181-251`) — the names the plan already used. Both
have the signature `(upstream: ReadableStream<Uint8Array>, …) => ReadableStream<Uint8Array>` and
each privately owns a `TextDecoder`, a `TextEncoder`, a `BufferedSseFrames`, a `push()` that
suppresses empty writes, a `for(;;) reader.read()` loop, an end-of-stream `decoder.decode()` plus
final `processFrames()`, `push(frames.takeRemainder())`, a catch that drains then emits the
`event: error` frame, and `controller.close()` in `finally`.

The only differences are the `processFrames` body and one optional `flushHeld()` call, which
`think-tags` makes at the same point in both the success tail and the catch tail and
`tool-use-ids` does not make at all. An extraction that inserts `flushHeld?.()` at that one point
is byte-identical for both callers.

### P1-06 — the plan itself changes behaviour. Do not follow it as written.

Two of its three "After" snippets are wrong:

1. `normalizeTtl` — the plan's "Before" omits the real guard
   `if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs)) return DEFAULT_EXHAUSTED_MS;`. Its
   "After" uses `floorMs: 0`, which sends `Infinity`/`NaN` to 0 ms. `readCooldown` then deletes the
   entry and a spent lane reads `ready` on `GET /dispatch`. It flips `test/dispatch.test.ts:319`
   and `:335`.
2. `failureCooldown`'s `source` is not a debug label. It is written to persisted breaker state.

⚠ And the two clamp families are genuinely different, so one shared evaluator must take its caps as
parameters: `dispatch.ts` clamps to `MAX_EXHAUSTED_MS` (30 days) with floor 0, while
`circuit-breaker.ts` clamps to `MAX_RETRY_AFTER_MS` (15 minutes) with floor `MIN_RETRY_AFTER_MS`.

### HOTSPOT-03 — the closure is wider than the plan says, and there is a cycle to avoid.

Every one of the plan's 12 cited line numbers is correct at HEAD, and the purity claim holds
structurally. But the movable set is **17** symbols, not 11: `parseRouting` plus
`parseQuotaEnforcement`, `parseLatencyDemotion`, `parseHedge`, `parseMcpSettings`, `parseLaneProbe`,
`DEFAULT_LANE_PROBE`, `parseSticky`, `parseOffload`, `hasAsciiControl`, `dropDisabledSpecs`,
`LADDER_TASK_TOKEN`, `LADDER_SPEC_TOKEN`, `LADDER_CONTEXT_TOKEN`, `parseSpawnEnv`, `parseCliLane`,
`parseLadder`, `assertSpecResolvable`. Move all of them or none.

⚠ To avoid a cycle, `routing-parser.ts` must import only from `./config-types.js`. That requires
relocating `POOL_PREFIX`, `AUTO_MODEL` and `splitSpec` to a leaf module, with `config.ts`
re-exporting them for its six existing importers.

### HOTSPOT-10 — clean, and the most ready item in the set.

`src/backend/` does not exist. All seven symbols are private to `src/backend.ts` with zero
references outside it: `ResponseProtocol` (L334), `UpstreamResponseMetadata` (L336),
`ANTHROPIC_STREAM_EVENT_FIELDS` (L430), `invalidEnvelopeReason` (L442), `StreamPreflight` (L503),
`captureReportedModel` (L507), `preflightResponseStream` (L523). No cycle risk. `isRecord` is used
16 times in `backend.ts`, so its import survives the move. There is no
protocol-by-streamed-by-shape table test today.

### CLONE-12 — the backlog names the wrong code.

⚠ The Phase 1b backlog paragraph describes the `revokeEntry` / `setDisabled` prologue. That code is
real and the description of it is accurate, but **it is not catalog item CLONE-12**. The real
CLONE-12, confirmed at HEAD, is the `addEntry` (`src/keystore.ts:1066`) /
`restoreEntryFromExport` (`:1386`) prologue, recorded at
`docs/reviews/duplication-and-complexity-catalog-2026-09-05.md:159` and planned as Family C of
`docs/reviews/refactor-plans/item-p1-02-context-limits-keystore.md`. It still carries its Phase 1a
ACCEPT verdict and is still unextracted.

On the code the backlog actually describes, the recommendation is **record as benign**: the shared
run is three lines across two entry points inside credential custody, and the two sites order their
surrounding preconditions differently, so any helper placement changes an operator-visible message
that the suite does not cover.

### CLONE-26 — ruled and ready, but it moves a second thing the ruling did not name.

The technical claims are confirmed at HEAD. `fromDeepSeekForm` (`src/tool-dialects.ts:263-278`)
commits a scalar payload with empty `{}` arguments, commits an array payload by casting the array
as the arguments, already discards on a `JSON.parse` throw, and leaves a well-formed object
unchanged. `fromKimiTokenForm`'s equivalent guard is at `:296`. No existing test constructs a
scalar or array DeepSeek payload. The fix is one condition, about six lines.

⚠ **The unnamed second change.** Today a scalar or array payload under a name in
`repair.destructiveTools` reaches the destructive filter and yields `refused-destructive`: HTTP 502,
`origin: "local"`, code `tool_dialect_refused_destructive`, the
`x-llm-relay-tool-dialect: refused-destructive` header, no failover, no breaker charge. After the
change that same input is discarded before the filter sees it, so it yields `detected`: HTTP 502,
`origin: "upstream"`, code `tool_dialect_unparseable`, no header, a full pool reroll and a breaker
charge. The safety invariant is unharmed either way — no destructive call is fabricated in either
path — but the error code, the header, the failover and the health accounting all move.

### ESLINT — 82 errors, but **42** distinct (file, rule) pairs, not 41.

The backlog's rule distribution matches live output. Its file-level claims need three corrections:
drop `src/refusal-interpretation.ts`, `src/rate-limits.ts` and `src/quota-observation.ts` (0 errors,
already exempted); add `src/dashboard-routes.ts` (one `no-control-regex`, one
`sonarjs/function-return-type`); and treat the `src/mcp/lane-runner.ts` `no-nested-functions` hit as
a source instance, not a test fixture, which falsifies the backlog's "every one in a test".

## What building then found, after the recon

Five of the seven items landed. Two more findings came from writing the code, not from reading
it — recorded here beside the recon so the whole picture is in one place.

### Three tails in a row had no coverage at all

P1-04's shared `event: error` tail, CLONE-12's prologue ORDER, and (in Phase 1a) the accounting
schema's envelope tail. In every case the extraction was safe and the thing being extracted was
**untested**: deleting P1-04's whole `catch` block left both stream suites green, and moving
CLONE-12's duplicate check to after `unlockStoreForWrite` left all 94 keystore tests green while
letting a rejected add open the keyring. Each is now pinned and mutation-checked.

⚠ The pattern is worth naming: a duplicated block survives duplication precisely because nothing
tests it, so a duplication sweep is also a coverage audit. Mutation-check every extraction; the
green suite is not the evidence.

### P1-06's premise does not survive reading the six sites — recommend DECLINE

SEM-06 says "explicit beats default is re-implemented in `dispatch.ts`, `circuit-breaker.ts`,
`lane-cadence.ts`, `lane-quota-probe.ts`, `target-facts.ts` and `routes/admin.ts`". Read at HEAD,
there is no one rule to extract:

| Site | What it actually does |
|---|---|
| `dispatch.ts` `normalizeTtl` | duration, clamp `[0, MAX_EXHAUSTED_MS]`, non-finite → `DEFAULT_EXHAUSTED_MS` |
| `dispatch.ts` restore (`:373`) | ABSOLUTE time, `min(until, now + MAX)`, non-finite already rejected above |
| `dispatch.ts` `markExhaustedKey` (`:384`) | ABSOLUTE time, `min(max(now, until), now + MAX)` |
| `circuit-breaker.ts` retry-after | duration, clamp `[MIN_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS]`, `undefined` → **null** |
| `circuit-breaker.ts` `failureCooldown` | clamp, then a FLOOR that also changes the reported `source` |
| `lane-cadence.ts:192` | `verdict.retryAfterMs ?? OUTCOME_DEFAULT_MS[verdict.outcome]` |
| `lane-quota-probe.ts:137` | a unit conversion with a ceiling and no floor |
| `target-facts.ts:401` | a validity gate (`finite && > 0`), no clamp at all |
| `routes/admin.ts:423` | a precedence chain, `ttlMs ?? retryAfterMs ?? default` |

Different floors (0 against `MIN_RETRY_AFTER_MS`), different ceilings (30 days against 15 minutes),
different absent-handling (a default against `null`), and three sites whose whole contribution is
the `??` operator. ⚠ `failureCooldown` is the sharpest case: its floor does not raise the value, it
changes the RUNG — a measurement that fails to beat the default is reported `source: "default"`, and
that source is persisted breaker state. A shared evaluator would need a mode flag to express it,
which is the two-policies-one-name shape this repository already warns about.

Wrapping `a ?? b` in a function call makes the code worse. **Recommendation: decline SEM-06 and
record it, the same way CLONE-12's four-line pair was recorded as benign.** What remains, and it is
small, is the intra-`dispatch.ts` pair at `:373` and `:384`, which really do clamp an absolute time
the same way.

⚠ This reverses an ACCEPT verdict from the adversarial verification, so it is the owner's call, not
a silent decision. Nothing was built.

### HOTSPOT-03 is buildable but is its own lap

The verification is right on both counts. All 12 cited line numbers are correct at HEAD and the
purity claim holds — but the movable closure is 17 symbols, not 11, and `routing-parser.ts` cannot
import from `config.ts` without a cycle. `POOL_PREFIX` (`config.ts:305`), `AUTO_MODEL` (`:308`) and
`splitSpec` (`:683`) are exported from `config.ts` and needed by the moved code, so they must first
relocate to a leaf with `config.ts` re-exporting them for its six existing importers. That is two
coordinated moves across a 2,000-line file, and starting it without finishing it leaves the tree
worse than not starting. Scoped, not started.

## The lesson, stated so it is not relearned

`CLAUDE.md` already says lane output is advisory and must be checked against source. This run
measures the size of that gap for reconnaissance specifically: **7 of 7 packets were confidently
wrong**, and the errors were of a kind that reads as competence — real file paths, plausible symbol
names, specific line numbers, confident discrepancy lists. A reviewer who trusted any one of them
would have refactored against invented symbols.

⚠ The corollary for workflow design: **do not key a fallback on a null result.** Key it on
verification. The two lenses cost roughly as much as the recon they checked and were the only thing
standing between a fabricated packet and a wrong refactor.
