# Backlog — llm-relay

> The work queue. A living to-do list, not a status log.
>
> Distinct from [`../HANDOFF.md`](../HANDOFF.md) §6, which holds recorded trades, deferrals and
> settled decisions for their REASONS and is explicitly not a queue. Remove an entry here once it
> ships; route what survives to its one home (invariants and rationale → `CLAUDE.md`, current
> state → `HANDOFF.md` §0, durable machine facts → project memory).

## Open

- **`packBytes` is within 0.4% of its own ceiling** (**1102172** against 1106200, re-measured
  2026-08-30 after v0.62.0 — was 1100459 before this pair of laps). Pre-existing drift, deliberately
  NOT raised in the v0.60.0 lap. ⚠ **Two laps have now consumed 1713 bytes of the remaining
  headroom, both disclosed rather than absorbed:** v0.61.0 spent 1474 on the `--next-command`
  contract table in `skills/llm-relay/SKILL.md`, which the package ships, and v0.62.0 spent 239 on
  the third install target. **4028 bytes remain.** The next change that adds anything will trip
  `check:package`. When it does, **root-cause the growth first** — regenerating the baseline is what
  turns a size ratchet into decoration. ⚠ Re-measure this figure in the same change that alters it;
  a stale measured number is what the v0.61.0 closeout auditor caught elsewhere.

- **`check:package` should say "run the build first" instead of throwing a raw ENOENT.**
  `scripts/dashboard-package-check.mjs:15` reads `dist/dashboard/.vite/dashboard-bundle-graph.json`
  and, when `dist/` is absent, dies with an unhandled Node stack trace that names the missing file
  but not the cause. `CLAUDE.md` already says to run `npm run build && npm run check`; the gap is
  that the ERROR does not carry that knowledge, so anyone who runs `npm run check` alone loses a
  full cycle. Cost one at the v0.61.0 lap start. A one-line existence check naming `npm run build`
  fixes it.

- **Root-cause 9 unexplained package entries.** The baseline's `observed.packageEntries` read 329
  while a clean rebuild at the v0.60.0 lap-start commit packed **338**; the lap's update to 341
  absorbed that gap as a side effect while only +3 was the lap's own new module. Nobody has
  explained the other 9. Find what added them (`npm pack --dry-run --json` at successive commits and
  diff the file lists) before the next baseline refresh, or the ratchet keeps laundering growth.

(The quota-source re-probe shipped 2026-08-29; design and verification record:
[quota-reprobe-design-2026-08-29.md](quota-reprobe-design-2026-08-29.md). The eligibility-and-probe
lap shipped 2026-08-30 as v0.60.0:
[eligibility-and-probe-lap-2026-08-30.md](eligibility-and-probe-lap-2026-08-30.md).)
