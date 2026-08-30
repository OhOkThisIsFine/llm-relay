# Backlog — llm-relay

> The work queue. A living to-do list, not a status log.
>
> Distinct from [`../HANDOFF.md`](../HANDOFF.md) §6, which holds recorded trades, deferrals and
> settled decisions for their REASONS and is explicitly not a queue. Remove an entry here once it
> ships; route what survives to its one home (invariants and rationale → `CLAUDE.md`, current
> state → `HANDOFF.md` §0, durable machine facts → project memory).

## Open

- **Build an MCP server so agy can DELEGATE** (owner decision 2026-08-30, D4, reversing the
  2026-08-30 "no MCP" verdict).

  **⚠ OWNED BY ANOTHER AGENT.** A design pass runs in a different session. Do not start the design
  here; coordinate through the owner. This entry exists to hand that designer everything already
  established, so nothing below has to be rediscovered or re-argued.

  **The goal, which has not changed:** agy must be able to hand work to another agent, rather than
  only receive it. The reversal condition was written into the `CLAUDE.md` gotcha in as many words
  — *"That reverses this verdict if the owner states agy must be able to DELEGATE rather than only
  be delegated to"* — and the owner stated it.

  ### ⚠⚠ Read this first: the argument that WON the reversal has since expired

  D4 turned on exactly one claim: *"agy has no shell but does have `mcp(*)`, so an agy session has
  zero delegation mechanisms today."* **That is no longer true. agy has a shell.**

  Verified against the authority rather than from prose — `~/.gemini/antigravity-cli/settings.json`
  reads `read_file(*)  write_file(*)  read_url(*)  mcp(*)  command(*)`.

  | Time (PDT, 2026-08-30) | Event |
  |---|---|
  | ~09:40 | Owner answers D4 — agy must delegate, reopen MCP |
  | 10:16:30 | The security-cost framing is retracted (commit `6b1753d`) |
  | 10:50:59 | `settings.json.bak-2026-08-30-pre-shell-restore` written |
  | **10:51:13** | **`command(*)` restored — about 70 minutes after the decision** |

  With a shell, agy can already delegate by running `codex exec`, `claude -p` or `npx acpx`
  directly. So MCP is no longer the ONLY mechanism, which is the whole of what D4 rested on.

  ⚠ **This does not by itself reverse D4.** The GOAL is unchanged, and MCP may still be the better
  interface — a typed tool call beats a shell-out that must be composed, quoted and parsed. But the
  decision was taken under a premise that no longer holds, so **confirm the item is still wanted
  before building it.** Three questions worth putting to the owner:

  1. Now that agy can shell out, is MCP still wanted — or is the goal already met?
  2. If still wanted, is it wanted for agy specifically, or for every host?
  3. Does it need to EXECUTE work, or only to RETURN a command the caller runs? That single answer
     decides most of the design (see the constraints below).

  ⚠ **Attribution, kept honest:** the `command(*)` restore and its live `echo` check were done by
  another session and are recorded in the global `CLAUDE.md`. What THIS entry verified first-hand
  is the contents of the live settings file and the timestamps in the table.

  ### Two dead arguments — do not revive either

  **1. Never gate this on agy's shell, and never call that shell state a security boundary.**
  An earlier version of this very entry did both, and it was wrong. Owner correction, 2026-08-30:
  *"some agent ordained that AGY had certain limitations, that it did not have, that I didn't
  want."* The 2026-08-11 `command(*)` revocation was an AGENT's act, not an owner decision, and the
  global `CLAUDE.md` phrase "the accepted cost" described an acceptance no file history shows. The
  revocation has since been undone. So "an MCP server reaches around a deliberate revocation
  through a side door" is false twice over — the revocation was never the owner's, and it is no
  longer in force. Design the server on its own merits.

  **2. Two objections were checked and found INVALID.** A minimal JSON-RPC-over-stdio server needs
  **no** new dependency — this repo already hand-rolls `sse-frames.ts` and four SSE parsers. And
  `packBytes` is a regenerable CEILING, not a size wall. Do not repeat either.

  ### What still binds on the design

  All four are unsolved rather than withdrawn, from
  [skill-dispatch-mcp-verification-2026-08-30.md](skill-dispatch-mcp-verification-2026-08-30.md) §4:

  - **A `dispatch()` tool is INERT for a stranger.** A fresh install ships no `routing.ladder` and
    no `cliLane`, so it would do nothing for anyone but this machine. ⚠ And that gap will not be
    closed from the config side: D2 was settled the other way on 2026-08-30 —
    `DEFAULT_CONFIG_TEMPLATE` will NOT ship a ladder, because dispatch is deliberately a per-machine
    feature.
  - **A tool that RETURNS a command** duplicates `/dispatch`, which already exists.
  - **A tool that EXECUTES** needs a caller-supplied `cwd`, escapes the harness permission gate, and
    has no representation for a 30-minute lane.
  - **The request path never spawns a lane.** That invariant stands; outside it there are exactly
    two sanctioned spawn sites, the operator `lanes --probe` and the background lane cadence.

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
