# Backlog — llm-relay

> The work queue. A living to-do list, not a status log.
>
> Distinct from [`../HANDOFF.md`](../HANDOFF.md) §6, which holds recorded trades, deferrals and
> settled decisions for their REASONS and is explicitly not a queue. Remove an entry here once it
> ships; route what survives to its one home (invariants and rationale → `CLAUDE.md`, current
> state → `HANDOFF.md` §0, durable machine facts → project memory).

## Open

_Nothing open._

## Closed

- ✅ **The offload lane "stall" — root-caused, then FIXED** (owner-directed, 2026-08-30).
  Filed as *"investigate why the llm-relay offload lane STALLS and returns nothing"*; it turned out
  not to be a stall at all, and the fix the owner chose ships as `src/latency-demotion.ts`
  (`routing.latency`, default ON, announced by `x-llm-relay-latency-demoted`). The original entry
  and its evidence follow, because the measurements are the reason the fix looks the way it does.

  Measured at filing: a `dispatch --next-command` lane on `pool/medium` ran for about
  17 minutes, spawned roughly 19 `node` children that all sat at near-zero CPU, and produced no
  output at all beyond one line —

  ```
  [claude-code:unrecognized_model] {"model":"pool/medium","query_source":"generate_session_title"}
  ```

  The relay itself was healthy throughout (`GET /telemetry` 200) and had served traffic in the
  window, so the request reached the pool. The task was a small read-only git verification, which
  should take a few turns rather than minutes.

  ⚠ **Start with that one diagnostic line**, because it is the only one the lane emitted: the
  session-title query path reports `pool/medium` as an unrecognized model. That is a SIDE query,
  not the main turn, so it may be harmless — but it is evidence that something on the client side
  does not resolve a `pool/` spec, and it is the only thread available.

  ⚠ The free-lane playbook already records "a lane returning two words and exit 0 is a failure,
  retry". This is the stronger form — no output and no exit — so establish first whether it is a
  lane stall, a relay stall, or a client-side hang, and do not assume which.

  ✅ **Reproduced through a SECOND, independent path (2026-08-30, v0.63.0 release verification),
  which narrows it usefully.** The same `pool/medium` lane stalled when spawned by the new
  `llm-relay mcp` server rather than by a shell running `dispatch --next-command`. That rules out
  one whole class of cause: the MCP server closes stdin, lifts all three idle timeouts from the
  rung's own `env`, sets `windowsHide`, and quotes the `.cmd` fallback per token — so the stall is
  NOT caused by any of the four known command-execution mistakes. It survives a correct invocation.

  ⚠ It is intermittent, not constant, and that matters for whoever investigates: the SAME code and
  the SAME lane answered in 33 s and (via agy) in 7 s earlier the same day, then stalled past 100 s
  and past 420 s within the hour. Treat it as a load- or time-dependent condition, not a broken
  path.

  ✅ **ROOT-CAUSED 2026-08-30. It is not a stall at all — it is cumulative pool-walk latency.**
  A `pool/medium` lane dispatched through the MCP tool completed normally with **exit 0 after
  333 s** and returned a complete, correct answer. So the lane does not hang, the child is not
  wedged, and none of the four known command-execution mistakes is involved. What takes the time
  is the relay's own candidate walk. Measured in that lane's window, from `usage/recent.json`:

  | started | latency | outcome | attempts | served |
  |---|---|---|---|---|
  | 19:34:08 | 120222 ms | `provider_error` | 2 | — |
  | 19:34:08 | 120280 ms | `provider_error` | 2 | — |
  | 19:36:08 | 5321 ms | success | 1 | `nim/nvidia/nemotron-3-ultra-550b-a55b` |
  | 19:36:08 | 15457 ms | success | 1 | `nim/nvidia/nemotron-3-ultra-550b-a55b` |
  | 19:36:24 | 123343 ms | **`timeout`** | **6** | — |
  | 19:38:28 | 70750 ms | success | 2 | `nim/nvidia/nemotron-3-ultra-550b-a55b` |

  A single agent turn costing 120 s, times the several turns a `claude -p` run makes, is the
  whole reported duration. The `~19 idle node children` are those turns waiting on the relay, and
  the absent output is just `claude -p` buffering its answer until exit — a fact `CLAUDE.md`
  already records as meaning nothing.

  ⚠ **Why the walk is that expensive: latency is not part of health banding, deliberately.**
  `llm-relay candidates --tier medium`, same window — five of the top-ranked members carry an
  OPEN breaker (`nim/moonshotai/kimi-k3` for 72838 s, `huggingface/moonshotai/Kimi-K3` 927 s,
  `ollama-cloud/minimax-m3` 928 s, `nim/minimaxai/minimax-m3` 649 s), and
  `nim/deepseek-ai/deepseek-v4-flash` is **breaker-CLOSED with a p95 of 70364 ms**. `server.ts`
  ordering demotes on breaker state and nothing else (`src/server.ts:1257-1265`, with the reason
  stated: a second ranking pass on stability "means neither decides the order"). So a healthy-but-
  glacial member is walked AHEAD of a cooling one, and each such candidate can cost 60–70 s before
  the walk moves on. Even the member that finally served has p95 23478 ms and answered one
  request in 70750 ms.

  ⚠ **Two recorded threads are now disproved; do not re-pull them.**
  - *"`usage/recent.json` held no rows for the stalled attempts, so the request may not be reaching
    the accounting store."* **False.** The rows are there. `recent.json` `rows` is **not sorted by
    time**, so reading its tail shows an hour-old row while `max(startedAt)` is current. I made
    exactly that mistake twice before sorting. Sort before concluding anything from this file.
  - *"the `[claude-code:unrecognized_model]` line on the session-title path is the only thread."*
    It remains a harmless side query. `CLAUDE.md` already records that warning as carrying no
    information.

  **DECIDED by the owner, 2026-08-30, and SHIPPED the same day: let sustained latency DEMOTE into
  the cooling band.** Two other options were offered and declined — bounding the per-candidate
  attempt, and accepting the behaviour with the MCP job handle as the mitigation.

  Delivered as `src/latency-demotion.ts`, folded into `targetUsability` beside the quota term:
  `routing.latency` (default ON, `p95Ms` 30000, `minSamples` 5), announced by
  `x-llm-relay-latency-demoted`. 17 tests, of which 6 drive a real two-candidate walk on BOTH
  fronts; mutation-checked. Details in `CLAUDE.md`'s `latency-demotion.ts` row and
  `docs/reference.md`.

  Size cost, root-caused BEFORE the ceiling moved, measured against the PUBLISHED v0.63.1 tarball
  rather than a local guess: `unpackedBytes` 4654284 → 4670709 (**+16425**), `packageEntries`
  356 → 359, `packBytes` 881636 → 886142 (+4506). ⚠ The decomposition is stated on
  **unpackedBytes**, deliberately: `packBytes` is gzip output, so it is neither additive across
  files nor byte-reproducible (an independent rebuild measured 886146 against the same tree). Treat
  it as a ceiling only, never as an equality. The delta decomposes with **no residue** —
  9257 B of new `dist/latency-demotion.*` (3 files, matching the +3 entries exactly) + 4010 B
  `config` + 2081 B `server` + 1077 B `backend` = 16425. ⚠ `dist/backend.d.ts` grew 962 B while
  `dist/backend.js` grew 69 B, which is the two-pass build doing its job: the header constant's doc
  comment survives in the declaration and is stripped from the JavaScript. ⚠ `docs/reference.md` and
  `CLAUDE.md` are NOT packed, so documentation growth costs the tarball nothing. Ceilings were
  raised ONCE, keeping the ~0.5% headroom the previous baseline carried.

  ⚠ **This deliberately reverses a rationale recorded in place.** `src/server.ts:1257-1265` argues
  against exactly this, in these words: a second ranking pass on stability "means neither decides
  the order", and "live health then PROMOTES on evidence that is often a single request's latency".
  The owner was shown that cost in the question and chose this option anyway, so it is an
  **owner override of a recorded agent decision, not drift** — say so wherever the comment is
  edited, and do not let a later reader "restore" the old behaviour as a regression fix.

  The recorded objection also bounds the design, and every bound below is a direct answer to it:
  - **Demote only. Never promote, never drop, never re-sort.** The objection is about a competing
    ranking PASS; a one-way demotion term is not one. Same shape as the existing quota demotion.
  - **Never act on a single request's latency** — that is the objection's own worst case. Require a
    sustained, measured statistic.
  - **Unmeasured has NO effect whatsoever**, matching `getDeploymentMeasurement`'s null contract
    and the relay's standing "unknown stays null, never 0" invariant.
  - **Announce it**, like every other automatic reorder here.

  ⚠ The MCP server does not fix this and does not claim to. What it changes is the SYMPTOM: the
  caller receives a `jobId` after `waitMs` and can poll or `dispatch_cancel` it, instead of a shell
  that blocks with no output and no exit.

- ✅ **Offload announces itself — the operator no longer has to ask for it** (2026-08-30).
  The owner's report was blunt: *"the llm-relay skill or MCP or whatever should obviate me
  explicitly saying 'use llm-relay for offload' … it should make itself known to the agent without
  me having to say so."* Three measured causes, all closed in the repo so every host and every
  stranger gets the fix:
  1. **The MCP `initialize` instructions stated only WHAT the tool is.** A host puts that text in
     the model's system prompt unconditionally, so it is the one channel that cannot be deferred
     or missed — and it never said WHEN to delegate. It does now (`MCP_INSTRUCTIONS`, exported
     from `src/mcp/server.ts`).
  2. **The `dispatch` tool is a DEFERRED tool on a real host**, so only its bare name loads and its
     description is invisible until a tool search. The trigger sentence now rides the description
     as well, for a host that ignores `instructions`.
  3. **The skill description triggered on the DECISION, not the situation** — "use when offloading
     bulk work" only fires once the model has already chosen to offload. It now names the
     situations (a broad search, a file-by-file sweep, a survey, a draft, a second opinion) and
     says outright that nobody has to ask first. A new skill section carries the policy.

  ⚠ **The lesson worth keeping: prose the model must go and find is not a trigger.** This machine's
  global `CLAUDE.md` already said *"PREFER THE MCP TOOL"* in bold, and the owner still had to say
  it out loud. That is the machine's own "rules become tooling, not prose" policy failing in the
  one place nobody had applied it.

  Pinned by three tests in `test/mcp-server.test.ts` — the served instructions must equal the
  exported constant, and both the constant and the `dispatch` description must carry the trigger.
  ⚠ Commit `61b4ec6`'s message claims "four tests". It is three; the independent closeout auditor
  caught the miscount after the push, and this is the corrected record.
  Mutation-checked both ways: removing the trigger from the constant fails exactly one test, and
  removing it from the tool description fails exactly the other, so neither assertion is carrying
  the other.

- ✅ **Package-size variant C adopted and shipped** (owner decision, 2026-08-30).
  `build:server` runs `tsc` twice: pass 1 emits `.d.ts` WITH docs, pass 2 re-emits only the
  JavaScript with `--removeComments`. Consumers keep their IntelliSense text.
  **`packBytes` 1113288 → 861516, a 251772 (22.6%) reduction**, `packageEntries` unchanged at 347,
  and `dist/*.d.ts` bytes unchanged. Ceilings ratcheted DOWN with it (`packBytes` → 866000,
  `unpackedBytes` → 4602000), each keeping the ~0.5% headroom the baseline carried before — a
  ceiling left at the old figure after a 22.6% drop would be decoration.
  Evidence and the rejected variants: [package-size-2026-08-30.md](package-size-2026-08-30.md) §3.1.
  ⚠ This also retires the "1712 bytes of headroom" warning: the next change no longer trips the
  ceiling by design. The standing rule is unchanged — root-cause growth before regenerating, and
  never raise a ratchet twice in one lap for that lap's own work.
- ✅ **`llm-relay mcp` — the MCP dispatch server, SHIPPED** (2026-08-30). One verb (`dispatch`)
  plus job control and one ladder read, served over JSON-RPC on stdio by a HOST-launched process.
  Any MCP host — Claude Code, Codex, agy, OpenCode — now delegates a whole task with one call that
  returns an ANSWER, not a command it must then execute correctly itself. Prior-art survey and the
  design it mimics: [mcp-dispatch-prior-art-2026-08-30.md](mcp-dispatch-prior-art-2026-08-30.md).

  ⚠ **Why it was built after this entry said "confirm before building".** The entry was right that
  D4's stated premise had expired — agy has a shell again, so MCP is no longer its ONLY delegation
  route. The owner then gave a direct, newer instruction: *"Just figure out the best way to get
  dispatch working and capable, and do it."* And the case for MCP never depended on agy's shell.
  It rests on two things a shell-out cannot fix: the answer's SHAPE stops depending on the host,
  and lane EXECUTION stops being the caller's problem. That second one is the substance — five
  distinct measured ways to run a lane command wrongly (three idle watchdogs, the open-stdin stall,
  `.cmd` shell quoting, console focus theft) are now handled once, in `src/mcp/lane-runner.ts`.

  How the four recorded constraints resolved:
  - *Inert for a stranger* — **not an objection.** Owner decision D2 settled that dispatch is
    deliberately per-machine, and directed that dispatch work stop being measured against rubric
    test 1. The tool ships inert for a stranger exactly as `llm-relay dispatch` already does, and
    `dispatch_lanes` says so plainly.
  - *A tool that RETURNS a command duplicates `/dispatch`* — **correct, and it argued FOR the
    executing design.** No prior-art server returns a command; every one of them executes.
  - *Needs a caller-supplied `cwd`* — **solved.** The caller names a LANE, never a path. The
    directory is the server's own unless the caller overrides it, bounded by the new optional
    `routing.mcp.allowedRoots`. Request content never becomes process configuration.
  - *No representation for a 30-minute lane* — **solved.** Start, poll, fetch, cancel as four
    ordinary tools. The MCP Tasks extension standardises this shape, but the official client matrix
    does not list Tasks and no client ships it — measured, not assumed.
  - *Escapes the harness permission gate* — **the one real residue.** Bounded by a recursion cap of
    3 (`LLM_RELAY_DISPATCH_DEPTH`, refused BEFORE the spawn so the bound costs no lane run) and by
    per-lane config. A host that wants an approval prompt can annotate the tool with
    `anthropic/requiresUserInteraction`; that is not wired by default.

  ⚠ **The "agy has NO shell" premise stays rejected**, and agy's `command(*)` is restored and
  verified live. Nothing in this design is gated on it.

  Verified: 37 unit tests, four mutation checks, and live end to end — a real `pool/medium` lane
  answered through the tool in 33 s, and the handle/poll/result/cancel path was driven over real
  stdio. One mutation check found a test that proved nothing on a single mutation; it is now
  recorded as redundantly guarded rather than quietly left green.

  Size cost, root-caused exactly BEFORE any ceiling moved, and measured on top of variant C:
  `packBytes` 861516 -> 879010 (+17494), `unpackedBytes` +68973, `packageEntries` +9. The +9 is
  exactly the nine new `dist/mcp/` files. The byte delta decomposes with no residue - 58351 B of
  `dist/mcp/` plus 10622 B of `cli`/`config` growth, the second measured against an `origin/main`
  rebuild, and 58351 + 10622 = 68973. Ceilings were re-ratcheted keeping variant C's ~0.5%
  headroom. This is the lap's own work, so the ratchet moved ONCE.


- ✅ **`check:package` now names the build instead of throwing a raw ENOENT** (2026-08-30).
  `scripts/dashboard-package-check.mjs` reads two BUILD OUTPUTS through `readBuiltJson`, which
  reports *"… is missing. It is a BUILD OUTPUT, and `npm run check` does not build. Run
  `npm run build` first…"*. Mutation-checked: the guard fires with the file absent and the check
  passes with it present. Cost one verify-green cycle at the v0.61.0 lap start before this existed.

- ✅ **The 9 unexplained package entries are root-caused** (2026-08-30), with no residue:
  three modules added by `ba3bd2a` (v0.59.0, the quota re-probe) × three `tsc` outputs each. The
  arithmetic closes exactly — 329 + 9 + 3 = 341. Evidence and the independent decomposition:
  [package-size-2026-08-30.md](package-size-2026-08-30.md) §1. A stale `observed.unpackedBytes`
  found during that work was corrected to the measured figure; see §2 — it is the same defect class,
  because a CEILING metric's `observed` value is never compared for equality and so cannot be caught.

(The quota-source re-probe shipped 2026-08-29; design and verification record:
[quota-reprobe-design-2026-08-29.md](quota-reprobe-design-2026-08-29.md). The eligibility-and-probe
lap shipped 2026-08-30 as v0.60.0:
[eligibility-and-probe-lap-2026-08-30.md](eligibility-and-probe-lap-2026-08-30.md).)
