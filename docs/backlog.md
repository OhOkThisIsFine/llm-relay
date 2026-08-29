# Backlog — llm-relay

> The work queue. A living to-do list, not a status log.
>
> Distinct from [`../HANDOFF.md`](../HANDOFF.md) §6, which holds recorded trades, deferrals and
> settled decisions for their REASONS and is explicitly not a queue. Remove an entry here once it
> ships; route what survives to its one home (invariants and rationale → `CLAUDE.md`, current
> state → `HANDOFF.md` §0, durable machine facts → project memory).

## Open

- **Re-probe every quota source on a schedule, dead ones included (2026-08-29, owner request).**
  A source recorded as quota-dead is a SNAPSHOT, not a standing fact: a quota can reset at any
  moment, and today's Codex reset landed days before its recorded "dead until Sep 3" expiry. So a
  recorded death currently keeps a healthy lane parked until somebody probes it by hand. The relay
  already re-learns this for HTTP deployments — a breaker cooldown expires and the next walk tests
  the member — but a `cli` lane has no such loop: `lane-probe.ts` runs only as an operator action,
  and a quota-dead note in a doc or in memory expires on nobody's clock.
  **Property:** every quota source the host can route to — the `cli` dispatch rungs, the peer CLI
  hand lanes, and the free providers — is re-probed on a cadence, and a recorded death either
  carries an expiry that something enforces or is retracted by the probe that disproves it. No
  source stays parked on a stale record.
  **Scope note:** the mechanism is llm-relay's (it owns the dispatch ladder and the probe cache),
  but the FACTS it would retract also live in machine-wide memory and in the peer-CLI lanes, so a
  design must say which store is authoritative before it writes one.
  Unstarted, unbounded — no design chosen yet.
