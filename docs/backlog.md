# Backlog — llm-relay

> The work queue. A living to-do list, not a status log.
>
> Distinct from [`../HANDOFF.md`](../HANDOFF.md) §6, which holds recorded trades, deferrals and
> settled decisions for their REASONS and is explicitly not a queue. Remove an entry here once it
> ships; route what survives to its one home (invariants and rationale → `CLAUDE.md`, current
> state → `HANDOFF.md` §0, durable machine facts → project memory).

## Open

- **`packBytes` is within 0.5% of its own ceiling** (1100459 against 1106200, measured 2026-08-30).
  Pre-existing drift, deliberately NOT raised in the v0.60.0 lap. The next change that adds anything
  will trip `check:package`. When it does, **root-cause the growth first** — regenerating the
  baseline is what turns a size ratchet into decoration.

- **Root-cause 9 unexplained package entries.** The baseline's `observed.packageEntries` read 329
  while a clean rebuild at the v0.60.0 lap-start commit packed **338**; the lap's update to 341
  absorbed that gap as a side effect while only +3 was the lap's own new module. Nobody has
  explained the other 9. Find what added them (`npm pack --dry-run --json` at successive commits and
  diff the file lists) before the next baseline refresh, or the ratchet keeps laundering growth.

(The quota-source re-probe shipped 2026-08-29; design and verification record:
[quota-reprobe-design-2026-08-29.md](quota-reprobe-design-2026-08-29.md). The eligibility-and-probe
lap shipped 2026-08-30 as v0.60.0:
[eligibility-and-probe-lap-2026-08-30.md](eligibility-and-probe-lap-2026-08-30.md).)
