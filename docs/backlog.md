# Backlog — llm-relay

> The work queue. Each entry states an unmet **Property** and is deleted once that property is met.
> Shipped work belongs in git history and dated records under [`history/`](history/).
> [`../HANDOFF.md`](../HANDOFF.md) holds current state and the immediate next step; the current
> development sequence is in
> [`history/development-plan-2026-09-21.md`](history/development-plan-2026-09-21.md).
> This file is not a status log.

## Open

- **The post-v0.85.0 architecture has not been released yet.**
  `main` contains restart-safe daemon-owned lane execution, config hot reload, liveness/status
  changes, persistence hardening, derived lane capability, failure escalation, and the completed D5
  toolchain upgrades beyond the published v0.85.0 checkpoint.
  **Property:** the accumulated delta is audited by subsystem, live D1/D2/status behavior is
  re-verified, both required CI checks are green, package/install smoke passes, and the resulting
  tree is published as the next release before another large architectural feature begins.

- **Active hard-cap continuation is designed but not implemented.**
  Today an active lane that reaches its absolute runtime ceiling is terminated even when first-party
  liveness evidence says it is still working. The approved design is in
  [`history/active-hard-cap-lane-continuation-plan-2026-09-20.md`](history/active-hard-cap-lane-continuation-plan-2026-09-20.md).
  **Property:** where a harness exposes an exact resumable session identity, an active hard-cap event
  rolls the same logical attempt into a new process incarnation without overlap, without consuming
  another walk rung, and without counting the rollover as lane-failure evidence. Unsupported or
  inactive lanes retain ordinary timeout behavior.

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
