# Backlog — llm-relay

> The work queue. Each entry states an unmet **Property** and is deleted once that property is met.
> Shipped work belongs in git history and dated records under [`history/`](history/).
> [`../HANDOFF.md`](../HANDOFF.md) holds current runtime state. The architecture refactor sequence is
> in [`architecture-refactor-plan.md`](architecture-refactor-plan.md); the earlier continuation
> sequence remains in [`history/development-plan-2026-09-21.md`](history/development-plan-2026-09-21.md).
> This file is not a status log.

## Open

- **Architecture refactor: single-owner request routing and dispatch.**
  Follow [`architecture-refactor-plan.md`](architecture-refactor-plan.md). Next: the executable
  translation/gateway comparison and paired performance budgets, then the ownership cutovers.
  Runtime baselines, contract boundaries and tested SDK/schema/SQLite choices are recorded in
  [`history/refactor-baselines-and-dependencies-2026-09-22.md`](history/refactor-baselines-and-dependencies-2026-09-22.md).
  The [R0 lock safety fix](history/refactor-r0-2026-09-21.md) is not the target storage architecture.
  Optimize the finished architecture rather than diff size; preserve product guarantees, not
  duplicated implementations. Probes do not certify the unimplemented service or migration contracts.
  **Property:** all API fronts share one request-execution lifecycle; the daemon owns each complete
  dispatch job; transactional job state has one mutation authority; maintained MCP/schema machinery
  replaces commodity handwritten code; migration is verified and superseded runtime paths are deleted.

- **Active hard-cap continuation is designed but not implemented.**
  Survey and measurement tooling are complete for AGY, Claude, Codex and OpenCode, but no harness is
  yet verified resumable by both the exact-ID interruption/resume probe and the same-cwd isolation
  probe. Runtime implementation remains gated on that live evidence. The approved design is in
  [`history/active-hard-cap-lane-continuation-plan-2026-09-20.md`](history/active-hard-cap-lane-continuation-plan-2026-09-20.md).
  Integrate continuation into daemon-owned attempts after the refactor's ownership boundary is stable;
  do not build another MCP-owned continuation path. Offline refactor work does not wait for harness quota.
  **Property:** where a verified harness exposes an exact resumable session identity, an active
  hard-cap event rolls the same logical attempt into a new process incarnation without overlap,
  without consuming another walk rung, and without counting the rollover as lane-failure evidence.
  Unsupported or inactive lanes retain ordinary timeout behavior.

- **AGY answer-envelope unwrapping needs first-party evidence before implementation (M1).**
  The repository still has no raw archived successful AGY envelope from which to freeze the exact
  schema. Do not implement from an assumed JSON shape.
  **Property:** once one real archived AGY success envelope exists, either implement narrowly scoped
  AGY response unwrapping from that observed schema with raw stdout preserved, or explicitly decline
  the feature.

- **Route B is vendor-blocked.**
  Relay egress to OpenCode Zen over the Responses wire was demonstrated, but the current free-tier
  response is `HTTP 400 MissingSessionID`: the vendor requires session identity associated with its
  own client. The relay must not manufacture another client's identity.
  **Property:** either OpenCode confirms a supported relay-forwarded session path and one streamed
  tool-calling request is served successfully through each front, or this route is explicitly
  recorded as unsupported and removed from active expectations.

- **Live owner/operator verification remains.**
  These are not repository implementation packets:
  - verify a >60 s dispatch through a freshly restarted MCP host and confirm the public activity
    verdict remains sufficient;
  - verify the Codex Desktop `relay` agent end to end and observe real `provenance:`;
  - review chronically unsuccessful lanes before changing their enabled state;
  - clear or deliberately retain the outstanding refusal/eligibility queue.
  **Property:** each live check is completed and recorded, or explicitly declined by the owner.

## Historical plans

[`history/stabilization-plan-2026-09-17.md`](history/stabilization-plan-2026-09-17.md) is historical
evidence. D1, D2, D5, D6 and the other completed stabilization packets are not an active queue.
