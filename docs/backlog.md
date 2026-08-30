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

- **Decide which package-size variant to adopt** — the measured answer to the question this backlog
  used to ask in prose. Full evidence, commands and the four measured variants:
  [package-size-2026-08-30.md](package-size-2026-08-30.md) §3.

  29.5% of `dist/*.js` is comment prose (578657 bytes). Measured against the real tarball:

  | Variant | `packBytes` | Saving | Cost |
  |---|---|---|---|
  | A. Ship as today | 1113288 | — | 1712 bytes of headroom; the next change trips the ceiling |
  | B. `removeComments: true` | 739390 | −373898 (33.6%) | `.d.ts` loses doc comments |
  | C. Strip `.js` comments, keep `.d.ts` docs | 861480 | −251808 (22.6%) | A second `tsc` pass |
  | D. Drop source maps | 870204 | −243084 (21.8%) | No stack-trace mapping for users |

  C and D are orthogonal and combine. **Owner decision**, because every variant changes what users
  receive. Variant A needs no action beyond accepting that the next change trips the ceiling on
  purpose — which remains the standing instruction: root-cause before regenerating, and never raise
  a ratchet twice in one lap for that lap's own work.

## Closed

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
