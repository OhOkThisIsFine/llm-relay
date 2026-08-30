# Backlog — llm-relay

> The work queue. A living to-do list, not a status log.
>
> Distinct from [`../HANDOFF.md`](../HANDOFF.md) §6, which holds recorded trades, deferrals and
> settled decisions for their REASONS and is explicitly not a queue. Remove an entry here once it
> ships; route what survives to its one home (invariants and rationale → `CLAUDE.md`, current
> state → `HANDOFF.md` §0, durable machine facts → project memory).

## Open

- **Build an MCP server so agy can DELEGATE** (owner decision 2026-08-30, reversing the
  2026-08-30 verdict). The reversal condition recorded in `CLAUDE.md` was stated in as many words:
  *"That reverses this verdict if the owner states agy must be able to DELEGATE rather than only be
  delegated to."* The owner has now stated it.

  ⚠ **OWNED BY ANOTHER AGENT** (owner, 2026-08-30). A design pass is in progress in a different
  session. Do not start the design here; coordinate through the owner.

  ⚠⚠ **THE STATED JUSTIFICATION EXPIRED ~70 MINUTES AFTER THE DECISION, AND THE DESIGNER MUST
  KNOW.** D4 rested on one argument: *"agy has no shell but does have `mcp(*)`, so an agy session
  has zero delegation mechanisms today."* **agy has a shell again.** Verified against the authority
  — `~/.gemini/antigravity-cli/settings.json` now reads
  `read_file(*) write_file(*) read_url(*) mcp(*) command(*)`. Timeline, from file timestamps:

  | Time (PDT, 2026-08-30) | Event |
  |---|---|
  | ~09:40 | Owner answers D4 — agy must delegate, reopen MCP |
  | 10:16:30 | The security-cost framing is retracted (commit `6b1753d`) |
  | 10:50:59 | `settings.json.bak-2026-08-30-pre-shell-restore` written |
  | **10:51:13** | **`command(*)` restored** |

  So with a shell, agy can already delegate by running `codex exec`, `claude -p` or `npx acpx`
  directly. MCP is no longer the ONLY mechanism, which is the entire argument D4 turned on. ⚠ This
  does NOT by itself reverse D4 — the owner's GOAL (agy must be able to delegate) is unchanged, and
  MCP may still be wanted as a cleaner interface than a shell-out. But the decision was taken under
  a premise that no longer holds, so **confirm with the owner before building.**
  ⚠ Attribution: the `command(*)` restore and its live `echo` check were done by another session
  and are recorded in the global `CLAUDE.md`. What THIS entry verified first-hand is only the
  contents of the live settings file and the timestamps above.

  ⚠ **Do NOT gate this on agy's missing shell, and do NOT call that a security boundary.**
  An earlier version of this entry did both, and it was wrong. Owner correction, 2026-08-30:
  *"some agent ordained that AGY had certain limitations, that it did not have, that I didn't
  want"* — the 2026-08-11 `command(*)` revocation was an AGENT's act, not an owner decision, and
  the global `CLAUDE.md` phrase "the accepted cost" describes an acceptance no file history shows.
  So "an MCP server reaches around a deliberate revocation through a side door" rests on a premise
  that does not hold. Design the server on its own merits. Restoring agy's shell is a one-line
  change, on explicit owner instruction only — it is not this work item's business either way.

  Still true and still binding on the design, from
  [skill-dispatch-mcp-verification-2026-08-30.md](skill-dispatch-mcp-verification-2026-08-30.md) §4:
  a fresh install ships no `routing.ladder` and no `cliLane`, so a `dispatch()` tool is inert for a
  stranger; a tool that RETURNS a command duplicates `/dispatch`; a tool that EXECUTES needs a
  caller-supplied `cwd`, escapes the harness permission gate, and has no representation for a
  30-minute lane. Two objections were checked and found INVALID — no new dependency is needed, and
  `packBytes` is a regenerable ceiling, not a size wall. Do not repeat those two.

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
