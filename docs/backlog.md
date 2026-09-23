# Backlog — llm-relay

> **Closed 2026-09-23: llm-relay is retired** (see [`../HANDOFF.md`](../HANDOFF.md)). The entries
> below are closed without action and are kept for reference only.

> The work queue. Each entry states an unmet **Property** and is deleted once that property is met.
> Shipped work belongs in git history and dated records under [`history/`](history/).
> [`../HANDOFF.md`](../HANDOFF.md) holds current runtime state. The authoritative implementation
> sequence is [`architecture-refactor-plan.md`](architecture-refactor-plan.md), now adoption-first.
> Earlier R2–R6 and continuation sequences are not the active queue.

## Open

- **Adopt complete agent dispatch from existing desktop hosts.**
  Use upstream `opencode-mcp`, an independently managed OpenCode worker and the standard LiteLLM
  proxy. Start with A0's actual endpoint/auth/workspace inventory, then A1's pinned-stack trial
  from Claude Desktop and Codex Desktop. Do not first build custom RequestService, DispatchService
  or SQLite job infrastructure. Tool-call repair and exact legacy policy parity are not gates.
  **Property:** both hosts can delegate a real multistep tool-using task, observe/recover its result,
  handle required input, cancel and follow up in the same worker session without manual shuttling
  or the parent executing the worker's tool loop. Accepted work survives parent/bridge disconnect.

- **Package and migrate the proven upstream stack without hidden losses.**
  Follow A2–A4 in the [plan](architecture-refactor-plan.md). Keep native/subscription access distinct
  from model API access. Preserve or explicitly resolve required destinations, tools, access/cost
  restrictions and historical results before cutover. Document full-content session retention and
  the lack of automatic worker-crash/hard-cap recovery. Retire owned interception hooks and custom
  runtime paths rather than leave a second implementation as fallback. AX is out of scope.
  **Property:** fresh installation, shared local service lifetime, authenticated readiness, host
  configuration preservation, updates, safe cutover and rollback are verified; obsolete runtime,
  dependencies and tests are removed with their consumers. No unneeded custom gateway or job store
  remains.

## Legacy-only obligations until cutover

- **Native Responses traffic loses protocol information in a translation round-trip.**
  `gateway-boundaries.mjs relay` reproduces lost extensions, changed item/event identity,
  Chat-shaped usage and rewrapped native errors. Cancellation itself still reaches upstream.
  [Recorded evidence](history/refactor-r1-decisions-2026-09-22.md) remains valid even though that
  record's choice to retain custom execution is superseded. Do not describe the defect as fixed.
  **Property:** either correct required ongoing use of the old route, or retire it with an explicit
  migration notice and verified replacement. Fixing every retiring protocol path is not a
  prerequisite to the new full-agent pilot.

- **Existing owner/operator checks are not implied by a plan or upstream CI.**
  Earlier checks include long dispatch/restarted-host liveness, Codex Desktop relay-agent use,
  unsuccessful lanes and the refusal/eligibility queue. Reconcile those with A0/A1 rather than
  silently carrying old runtime-specific UI requirements into the replacement.
  **Property:** still-relevant checks are performed against the appropriate runtime, or explicitly
  retired with the corresponding feature; live settings/queues are not changed without authority.

## Deferred and evidence/vendor-blocked

- **Automatic active hard-cap continuation.**
  Probe tooling exists for AGY, Claude, Codex and OpenCode, but recorded evidence does not certify
  any harness with both exact-ID interruption/resume and same-cwd isolation. Use upstream session
  follow-up now; automatic continuation is not an adoption gate. Do not build another continuation
  supervisor unless an actual remaining requirement justifies it after adoption.
  **Property:** any future automatic recovery uses a verified exact session, avoids overlapping
  execution/replayed side effects, and reports uncertainty honestly. Until then unsupported
  interruption remains visible rather than falsely resumed.

- **AGY answer-envelope unwrapping (M1).**
  No real archived success envelope is recorded for freezing the exact schema. This may disappear
  with retirement of the custom launch path; do not implement from an assumed JSON shape.
  **Property:** supply an evidenced necessary integration, or explicitly retire the requirement
  with that path, without misreporting raw output as a successfully decoded result.

- **Route B access is vendor-blocked in the existing evidence.**
  Old relay traffic to OpenCode Zen's Responses route received `HTTP 400 MissingSessionID`.
  Changing to an OpenCode worker does not itself prove entitlement or a supported auth route.
  **Property:** a required destination passes a supported end-to-end tool-using access test, or is
  explicitly recorded as unavailable/retired. Never manufacture another client's session identity.

## Historical plans

The previous custom architecture remains in git history. R0's lock correction is still required
while its runtime is used. R1's [decision record](history/refactor-r1-decisions-2026-09-22.md), the
[continuation sequence](history/development-plan-2026-09-21.md) and
[stabilization plan](history/stabilization-plan-2026-09-17.md) retain evidence, not authority over
this adoption sequence. An unmet property is not marked completed merely because it was deferred.
