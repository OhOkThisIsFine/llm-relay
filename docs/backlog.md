# Backlog — llm-relay

> The work queue. A living to-do list, not a status log.
>
> Distinct from [`../HANDOFF.md`](../HANDOFF.md) §6, which holds recorded trades, deferrals and
> settled decisions for their REASONS and is explicitly not a queue. Remove an entry here once it
> ships; route what survives to its one home (invariants and rationale → `CLAUDE.md`, current
> state → `HANDOFF.md` §0, durable machine facts → project memory).

## Open

- **The `packBytes` ceiling TRIPPED and was raised, with the growth root-caused first**
  (2026-08-30). It had been predicted here and it happened exactly as written: adding two modules
  pushed `packBytes` to **1109072** against the old 1106200 ceiling.

  **Root cause, established BEFORE regenerating** (`npm pack --dry-run --json --ignore-scripts`,
  file list diffed): `packageEntries` went **341 → 347, exactly +6**, and all six are the new
  modules' build outputs — `dist/executable-lookup.{js,d.ts,js.map}` and
  `dist/installed-hosts.{js,d.ts,js.map}`, 16531 unpacked bytes — plus `dist/cli.js` growth from
  the first-run environment report. Nothing unaccounted for. Baseline raised to observed 1109072
  with the ceiling at 1115000, the same ~0.5% headroom it carried before. `packageEntries`
  (347/352) and `unpackedBytes` were both already inside their ceilings and needed no change.

  ⚠ **This regeneration did NOT resolve the 9-entry mystery below, and did not absorb it either.**
  341 + 6 = 347 exactly, so the pre-existing gap is carried forward unchanged, still unexplained.
  Keep them separate: the rule is that a ratchet may be raised for growth you can name, and this
  growth is named.

  ⚠ **Re-measured again after the adversarial-review fixes: 1113288, leaving only 1712 bytes.**
  The +4216 is explained — expanded doc comments in `executable-lookup.ts`, `installed-hosts.ts`
  and `install-skill.mjs`, all recording why each fix exists. `packageEntries` did NOT move (still
  347), so nothing new was added to the package; this is text growth inside files that already
  ship. **The ceiling was deliberately NOT raised a second time in the same lap** — raising it
  twice to accommodate one lap's own work is how a ratchet becomes decoration. So the next change
  that adds anything WILL trip `check:package`, on purpose, and whoever hits it must root-cause
  before regenerating. The honest question waiting there is whether shipping this much comment
  prose to npm is worth its size.

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
