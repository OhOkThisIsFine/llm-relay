# Backlog — llm-relay

> The work queue. A living to-do list, not a status log.
>
> Distinct from [`../HANDOFF.md`](../HANDOFF.md) §6, which holds recorded trades, deferrals and
> settled decisions for their REASONS and is explicitly not a queue. Remove an entry here once it
> ships; route what survives to its one home (invariants and rationale → `CLAUDE.md`, current
> state → `HANDOFF.md` §0, durable machine facts → project memory).

## Open


- **Investigate why the llm-relay offload lane STALLS and returns nothing** (owner-directed,
  2026-08-30). Measured this lap: a `dispatch --next-command` lane on `pool/medium` ran for about
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

## Closed

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
