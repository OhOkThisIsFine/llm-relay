# CLAUDE.md — llm-relay (agent orientation)

**llm-relay is retired (2026-09-23).** The repository is archived. Do not start work here: read
[HANDOFF.md](HANDOFF.md) for the replacement. The rest of this file describes the last release,
v0.86.0, and is kept for reference only.

Read [HANDOFF.md](HANDOFF.md) first for the current checkpoint and immediate next step.
This file holds durable engineering rules and the source map, not release status or a work queue.
[docs/backlog.md](docs/backlog.md) is the queue; [docs/README.md](docs/README.md) is the documentation
index. Read the relevant source and tests before changing a subsystem: an old comment or design
record is evidence to check, not proof of current behavior.

## What this is

A personal, loopback-only LLM traffic control plane, built to be shareable. It routes requests
across configured providers, models and credentials, and delegates complete tasks through agent
lanes. Reliability, observable decisions and minimal mechanism are the priorities. Tool-call
repair is one component, not the project's identity.

The HTTP data plane serves Anthropic Messages and OpenAI Chat/Responses. MCP dispatch is a separate
execution surface: it can launch configured agent processes. Do not insert agent CLI execution
into a model-serving HTTP turn or mistake advisory CLI dispatch for MCP execution.

[docs/project-goals.md](docs/project-goals.md) and
[docs/project-philosophy.md](docs/project-philosophy.md) define the owner's scope and rubric.
Prefer a small adopted mechanism to a speculative framework or a second implementation of an
existing policy. Distinguish owner decisions from agent assumptions. When an invariant changes
what you build, explain the constraint and the alternative rather than narrowing the task silently.

## Build / test / run

Use Node.js 22 or later. Work and run tests in the intended checkout or worktree.

```bash
npm ci --ignore-scripts
npm run gate                         # build, then all checks
npm run dev -- --config config.json  # run source with an existing config
npx vitest run test/repair.test.ts    # focused test, not the full gate
npm run sync:tiers                   # refresh the capability snapshot
```

`npm run gate` is `npm run build && npm run check`. The check phase covers source types, test types,
core tests, dashboard types/tests, and package inventory/smoke checks. CI also checks the inert
non-global postinstall hook and runs `windows-process-boundary` for process, spawning, broker and
persistence behavior. Static analysis is advisory and outside the gate.

Keep these build and verification contracts:

- Run the gate before and after changes when the environment permits. Report the exact tree,
  checks and results; distinguish local runs, CI and live provider probes. Do not substitute a
  focused suite or a previous green commit for the final-tree gate.
- Build/typecheck scripts explicitly use `node_modules/@typescript/native/bin/tsc`. Classic
  `typescript` remains a runtime Compiler API dependency for `delegate-gate/`; do not collapse the
  two packages or replace script invocations with an ambiguous bare `tsc`.
- The server build has two compiler passes: retain documentation in declarations, then emit
  comment-free JavaScript without replacing those declarations. Preserve source-map directives.
- Vitest reads `src/` and transpiles tests; `typecheck:test` checks their types separately.
  Keep test discovery scoped to this checkout. Most measurement scripts consume `dist/`, so
  rebuild before running them. See [scripts/CLAUDE.md](scripts/CLAUDE.md) for prerequisites.
- Measure package size after all edits, including declaration comments. Update intentional
  bundle/baseline changes together and leave meaningful headroom; an observation is not an
  exact-byte requirement.
- Stage added or moved documents before link tests: link targets resolve against the Git index.
  Preserve the source-map and script-inventory checks rather than weakening them to fit edits.
- Failover tests need at least two candidates. Inject tier data instead of pinning real models'
  changing bands. Reset process-global evidence between tests and give hand-built configs the
  required repair fields and provider kinds.
- Verify a regression's mechanism before weakening an assertion or raising its timeout. Tests can
  encode an old defect; change such a test with the source fix only after proving that distinction.
  For closed-vocabulary checks, add a temporary union member and confirm the intended compile error.

The owner's external `verify-green` ledger may record `npm run gate` when installed; it is not a
repository prerequisite. For releases, follow
[.claude/skills/release/SKILL.md](.claude/skills/release/SKILL.md), including the workflow and repository
settings checks. Do not replace the trusted-publishing path with an assumed local npm credential.
Attribute model-authored commits to the actual model, using an appropriate attribution address.

## Invariants (keep these true)

1. **Repair form, not judgment.** Routing is deterministic/configured; no model opinion enters the
   request path. Repairs may correct arguments, not invent intent, add/drop/repoint calls, or change
   the backend answer's identity. Destructive calls are refused, never fabricated.
2. **Keep provenance.** Unknown is not zero or weak capability. Distinguish reported, estimated,
   provider-stated, reference and operator-declared values. Keep mixed bases separate. Tunable
   defaults are allowed; invented provider limits, prices and context ceilings are not.
3. **Provider knowledge is data.** Routing destinations and credentials come from configuration.
   Labelled aliases, protocol quirks and preset facts may live in source when configuration can
   override them. Do not guess credentials, model identities or scopes from similar names.
4. **Health demotes, never drops.** Retain unhealthy candidates for failover/recovery. Configuration,
   eligibility and explicit cost/cap rules are different boundaries; do not disguise those as
   health filtering. Unknown evidence must not become a negative verdict.
5. **Counting is not permission to refuse.** Meter without requiring a published allowance. Quota,
   pacing and latency policies normally reorder. Only an explicit operator hard cap may refuse on
   a usage count. Hedging is the separately approved duplication exception: free-class deployments
   only, abort the loser at winning commit, and announce it.
6. **Credentials stay contained.** Declaration, not key presence, decides whether caller credentials
   may pass through. A declared-but-missing key must not leak the caller's credential to a different
   provider. Local encrypted custody is separate from accounting; neither authorizes obtaining
   consumer tokens, operating logins, a hosted relay or pooled consumer accounts.
7. **Loopback is not authorization.** Reject unsupported bind hosts. Match `Host` and any present
   `Origin` to the actual listener; allow absent `Origin` for CLI clients. Mutations require JSON.
   Protected control routes also require the per-install token; data-plane provider credentials
   and dashboard read-only sessions have different roles.
8. **Log metadata only.** Enforce allow-lists at the sink, including nested attempt records. Never log
   headers, bodies, secrets or URL parameter values. Query names and value lengths are sufficient.
   Counters do not justify logging tool IDs, arguments or vendor-private reasoning.
9. **Shared policy reaches both HTTP fronts.** Keep candidate outcomes, health, accounting,
   guardrails and announcements consistent across Anthropic and OpenAI paths. Deliberate
   translation-versus-passthrough differences follow authorship, not accidental missing wiring.
10. **Own lifecycle and persistence explicitly.** One logical lane attempt may own at most one live
    process incarnation. Preserve foreign journal/archive rows, acknowledge recovery only after
    durable terminal storage, and never infer death from unavailable transport or activity data.
11. **Tests cannot use real operator state or quota.** Guard persistent-path resolvers and real
    keyring/registry/process spawners; inject seams and temporary state. `state-paths.ts` alone is
    not a test guard. Redact machine paths and use fictional fixture identities.
12. **Closed vocabularies stay exhaustive.** Use total typed tables or exhaustive switches. Derive
    runtime lists and unions from one definition. A fallback must not promote uncertainty into
    success, upstream blame, authorization or a stronger provenance claim.

## Architecture — file → responsibility (all in `src/`)

Each source file or containing directory has a row; `test/architecture-map.test.ts` checks coverage.
Responsibilities below are a navigation aid. Detailed user behavior belongs in
[docs/reference.md](docs/reference.md), not another copy of this table.

| File | Responsibility |
|---|---|
| `cli.ts` | Commands, argument validation, startup composition and host-facing setup/status. |
| `keys-cli.ts` | Local credential lifecycle commands and secret-safe input/output. |
| `config-edit.ts` | Validate complete config edits; preserve unrelated fields and reject unsafe paths. |
| `state-paths.ts` | Shared XDG/default path policy with per-artifact legacy fallback. |
| `dotenv.ts` | Load environment-file values without overwriting existing environment values. |
| `pool-health.ts` | Probe actual deployment access; keep auth, denial, missing and empty outcomes distinct. |
| `authEnv.ts` | Declared/curated credential resolution and source provenance; no heuristic key discovery. |
| `credential-id.ts` | Stable, validated identity for configured credential slots. |
| `credential-fleet.ts` | Normalize slots and enforce enablement, model restrictions and exact env names. |
| `resolved-attempt.ts` | Bind a target, slot and one credential-resolution result to an attempt. |
| `credential-select.ts` | Rank slots within a deployment and manage request-local offer/start/outcome state. |
| `configured-limits.ts` | Validate and resolve operator-declared limits and their scope. |
| `hard-cap.ts` | Compare explicit caps with scoped local usage; no invented usage or reset. |
| `availability.ts` | Pure remaining/reset/provenance ladders and shared local-usage projection. |
| `availability-snapshot.ts` | In-memory quota/cooldown projection; no provider calls or disk reads. |
| `key-import.ts` | Parse supported imports through declared/curated names, never value-shape guesses. |
| `keystore.ts` | Encrypted credential storage, guarded mutations, caching and lifecycle. |
| `os-keyring.ts` | OS-backed or passphrase key protection through secret-safe process seams. |
| `secret-file-acl.ts` | Best-effort Windows secret-file access hardening. |
| `presets.ts` | Configurable onboarding/provider defaults. |
| `spec.ts` | Import-free routing-spec vocabulary; split provider/model at the first slash. |
| `config/routing-parser.ts` | I/O-free routing validation; preserve its tested validation order. |
| `config-types.ts` | Shared config types/constants, re-exported by the loader. |
| `config.ts` | Load/resolve config, enforce loopback, resolve targets and report disk staleness. |
| `config-reload.ts` | Transactionally apply supported policy changes or reject restart-only differences. |
| `session-pin.ts` | Bounded in-memory session affinity, constrained by live routing policy. |
| `offload.ts` | Targeted live offload updates and persistence status. |
| `dispatch.ts` | Build/select the ordered lane view without executing a lane. |
| `daemon-dispatch-view.ts` | Shared daemon view for dispatch reads and configured broker launches. |
| `context-limits.ts` | Learn explicitly stated context/output ceilings for the exact deployment. |
| `target-facts.ts` | Scoped conditions and measurements, expiry, cost filters and selective clearing. |
| `rate-limits.ts` | Learn explicitly attributed rate ceilings; a parse miss learns nothing. |
| `refusal-interpretation.ts` | Signature lookup, unknown queue, accepted interpretations and catalog-stale evidence. |
| `network-block.ts` | Display-only advice for evidenced network refusals; no routing or fact mutation. |
| `executable-lookup.ts` | Shell-free PATH/PATHEXT lookup. |
| `installed-hosts.ts` | Positive installation evidence, distinguishing binaries from weaker config evidence. |
| `host-routing.ts` | Determine the calling host's routing relationship in the caller, not the daemon. |
| `claude-hook.ts` | Owned offload hook installation/removal; preserve user hooks and fail open. |
| `dynamic-pools.ts` | Materialize configured prefixes and evidence-ranked catalog tails. |
| `candidates.ts` | Separate capability, health, cost and quota dimensions with provenance. |
| `server.ts` | Compose admission, request services, policy, persistence, reload and lane broker. |
| `backend.ts` | Backend transport and Chat/Responses wire translation; preserve failure provenance. |
| `backend/envelope-validator.ts` | Structural envelope validation without depending on transport. |
| `backend/health-prober.ts` | Structural stream preflight and model evidence with consumed-byte replay. |
| `openai-request.ts` | Anthropic-to-Chat request mapping and target-resolved compatibility. |
| `responses-request.ts` | Responses-to-Anthropic request mapping, including multi-turn tool linkage. |
| `stream-commit.ts` | Final-wire meaningful-content commitment and pre-commit failure classification. |
| `sse-frames.ts` | Shared SSE framing/transform lifecycle; callers retain protocol-specific field policy. |
| `tool-dialects.ts` | Closed-envelope tool recovery and required destructive-name refusal. |
| `dialect-stream.ts` | Dialect handling on Anthropic-shaped streams. |
| `openai-dialect.ts` | Dialect handling on direct Chat responses/streams. |
| `tool-use-ids.ts` | Deterministic response-side collision repair without a conversation store. |
| `lane-manifest.ts` | Cached lane roster/support evidence and freshness rules. |
| `lane-probe.ts` | Operator/background lane metadata probes. |
| `lane-quota-probe.ts` | Minimal completion probes with conclusive-success/explicit-exhaustion classification. |
| `lane-cadence.ts` | Background lane catalog and recorded-exhaustion re-probing. |
| `dispatch-exhaustion-persistence.ts` | Restore/persist unexpired dispatch exhaustion and flush on shutdown. |
| `dispatch-lane-stats.ts` | Per-tier/mode/lane counts and bounded completed-run duration history. |
| `lane-activity.ts` | Bounded execution-tagged relay traffic; internal tags never reach providers. |
| `lane-launch-env.ts` | Shared credential-scrub and operator env-delta policy for lane launches. |
| `lane-execution-broker.ts` | Daemon-owned idempotent execution, cancellation, activity and bounded results. |
| `configured-lane-execution-launcher.ts` | Resolve configured lanes and apply cwd/read-only/env/depth/spawn policy. |
| `lane-affinity.ts` | Bounded persisted pins/demotions; neither resurrect nor remove candidates. |
| `mcp/job-journal.ts` | Shared running-job ownership and bounded restart-recovery metadata. |
| `mcp/readonly-boundary.ts` | Enforce cwd and supported harness read-only mechanisms. |
| `mcp/persistence-lock.ts` | Shared journal/archive transaction contention policy. |
| `mcp/job-archive.ts` | Bounded terminal archive and cross-host result lookup. |
| `mcp/process-cpu.ts` | CPU measurements for owned process trees; unavailable is not idle. |
| `mcp/tree-delta.ts` | Git-status change reporting and dirty-file activity evidence; never revert edits. |
| `mcp/lane-execution-client.ts` | Strict broker client and opaque execution IDs; distinguish rejection from uncertainty. |
| `mcp/agy-quota-log.ts` | Fresh, attributable AGY log evidence; ambiguous/shared-log data proves nothing. |
| `mcp/protocol.ts` | Supported JSON-RPC/MCP stdio methods and version negotiation. |
| `mcp/lane-runner.ts` | Jobs, local process ownership/reaping, output bounds and journal/archive integration. |
| `mcp/windows-npm-shim.ts` | Resolve supported npm shims to Node entrypoints without shelling task text. |
| `mcp/server.ts` | Dispatch tools, whole-job walks, wait/liveness contracts and broker reconciliation. |
| `validator.ts` | Tool-schema validation: pass, fail or uncheckable. |
| `reshaper.ts` | Corrected-input client and transport-only repair-model failover. |
| `repair.ts` | Destructive refusal, bounded repair, structural conservation and revalidation. |
| `sse.ts` | Reconstruct Anthropic-shaped messages for validation. |
| `emitSse.ts` | Emit repaired Anthropic SSE while preserving reported usage semantics. |
| `anthropic.ts` | Inspected message/tool/usage shapes and schema lookup. |
| `documents.ts` | Convert supported documents before mapping; refuse unrepresentable content. |
| `log.ts` | Sink-enforced metadata allow-lists, bounded attempts and log rotation. |
| `catalog.ts` | Cached provider rosters/metadata, bounded validation and evidence-triggered refresh. |
| `circuit-breaker.ts` | Attempt outcomes, separate credential faults, recovery cooldowns and pacing starts. |
| `breaker-persistence.ts` | Restore/persist full validated breaker cells without overwriting fresh live evidence. |
| `cooldown-clear.ts` | Selector-scoped live cooldown clearing; narrow credential-rotation mode. |
| `benchmarks.ts` | Capability and deployment fitness ranking with distinct evidence bases. |
| `tier-data.ts` | Synced snapshot loading and explicit exact/fuzzy/price-suffix match provenance. |
| `telemetry.ts` | Daemon version, config staleness, health and accounting writer diagnostics. |
| `metadata.ts` | Per-field price/limit provenance, cost classification and shared token estimates. |
| `kernel/` | Pure adopted attempt-lifecycle contracts; not a speculative transport or IR framework. |
| `storage/` | Validated JSON reads, cross-process transactions and atomic replacement. |
| `accounting-state.ts` | Per-request accounting lifecycle and price-port integration. |
| `candidate-runner.ts` | Production candidate policy/walk, deadlines, hedging, commitment and announcements. |
| `stream-pipeline.ts` | Body bounds, stall/crawl watchdogs, stream helpers and typed failure responses. |
| `routes/admin.ts` | Admitted control endpoints, including broker, reload, stop and live state. |
| `routes/messages.ts` | Anthropic Messages front. |
| `routes/openai-front.ts` | OpenAI Chat/Responses fronts and translated-stream terminal handling. |
| `control-authorization.ts` | Per-install control capability; timing-safe checks and secret-safe failures. |
| `request-log.ts` | Shared metadata records and safe route/query summaries. |
| `self-update.ts` | Bounded update checks for mutating invocations and global-install re-execution. |
| `registry.ts` | Provider/catalog/routing registry with labelled capability joins. |
| `key-checker.ts` | Evidence-based credential checks, including anonymous comparison and model entitlement. |
| `onboarding.ts` | Local account/key setup; suppression changes nudges, not visibility or routing. |
| `setup-claude.ts` | Owned Desktop MCP entries, routed CLI setup and relay-agent installation. |
| `ping/cadence.ts` | HTTP probes, recovery probes, spend polls and self-scheduled background hooks. |
| `spend-headroom.ts` | Provider-stated paid allowance; clear only the paid-only facts it disproves. |
| `ping/metrics.ts` | Sample-aware latency/availability statistics; keep unmeasured distinct from failed. |
| `ping/ping.ts` | One HTTP completion probe and quota-header observation. |
| `ping/probe-cache.ts` | Persist validated probe/request samples without conflating their scheduling metadata. |
| `write-behind.ts` | Debounce plus maximum-age flush scheduling and shutdown registry. |
| `usage-observer.ts` | Byte-preserving usage observation with separate reported/estimated accumulators. |
| `quota-observation.ts` | Unambiguous provider-stated axis/period observations. |
| `quota-demotion.ts` | Allowance-based reordering with evidence-gated limits and resolvable resets. |
| `latency-demotion.ts` | Sustained latency demotion: request per-token evidence, then probe-only fallback. |
| `pacing.ts` | Sliding-window attempt-rate demotion against stated/configured/learned ceilings. |
| `hedge-trigger.ts` | Evidence-labelled hedge delay with an input-size floor. |
| `hedge-race.ts` | Concurrent attempt race and loser cancellation, independent of HTTP. |
| `accounting.ts` | Request/attempt events and separately attributed token/spend cells. |
| `accounting-store.ts` | Bounded persisted ledger, in-memory usage reads and writer health. |
| `accounting-store-schema.ts` | On-disk validators and explicit additive compatibility seams. |
| `dashboard-contract.ts` | Platform-free, versioned analytics wire vocabulary and bounds. |
| `dashboard-auth.ts` | One-time bootstrap exchange and digest-only read-only session authority. |
| `dashboard-routes.ts` | Injected dashboard endpoint policy, separate from socket admission. |
| `dashboard-snapshot.ts` | Read-only bounded projections, coverage and shared cost roll-up. |
| `dashboard-static.ts` | Manifest-owned static assets and security headers; no catch-all file serving. |
| `json-shape.ts` | Platform-free shared shape guards; strict and optional-key guards differ intentionally. |
| `winenv.ts` | Windows environment gap-filling; real env wins and PATH is never imported wholesale. |
| `ping/quota.ts` | Quota fetches restricted to the exact configured provider host. |
| `ping/runtime-telemetry.ts` | Proxy-request telemetry; not a home for whole-agent wall-clock samples. |
| `process-safety-net.ts` | Narrow late-transport-error handling; other uncaught errors remain fail-fast. |
| `think-tags.ts` | Conservative leading-reasoning removal with lossless rollback of uncertain shapes. |
| `delegate-gate/` | Host-side review of returned diffs; mechanical fixes write a separate patch, not the repo. |

The browser application lives in root `dashboard/`, not `src/dashboard/`.
The request path is resolve → order/select → execute/commit → validate or repair → account/announce.
The internal validation shape is Anthropic Messages; wire translation belongs at the backend/front
seams. Production ordering is the candidate runner's deployment-group path, not the breaker's
standalone ordering helper.

## Scripts inventory (`scripts/`)

[scripts/CLAUDE.md](scripts/CLAUDE.md) owns script purposes and prerequisites.
`test/scripts-inventory.test.ts` checks its coverage. Do not copy that inventory here or run a
measurement against stale compiled output.

## Gotchas (things that will bite you)

### Configuration, credentials and local state

**Reload is explicit and transactional.** Disk staleness is an mtime observation, not a file watcher.
The daemon loads a complete candidate with startup CLI overrides and materializes its dynamic
pools before committing. Preserve the live `Config` identity; no await or fallible preparation may
split the mutation. Unsupported differences reject the whole candidate and report paths, not values.
`config-reload.ts` owns the reloadable/restart-only sets. Provider membership/identity, listener,
logger, destructive matcher and startup-owned policy require restart. Config reload does not
refresh inherited environment values. Targeted offload updates are a separate live mutation.

**Optional failure is not a total outage.** An unset variable in an optional provider base disables
that provider with warnings. References to never-declared providers are errors; losing all usable
providers or a required route can still be fatal. Preserve unknown fields when editing config,
validate the whole document before writing, and retain option/arity guards before side effects.
Help/version must not start the proxy or create configuration. Keep JSON stdout free of notices;
MCP stdout contains protocol messages only.

**Credential identity and custody provenance are different.** Attempt identity comes from the
configured slot. Fleet env names are exact; legacy aliases form a closed list. Resolve environment
sources before keystore sources and do not infer routing identity from the keystore row's labels.
A missing declared key fails before egress. Authenticated 401/403 alone cannot distinguish a bad key
from model entitlement; preserve `unverified`. Probes and redirects must not send keys to hosts the
operator did not configure.

**Rotation is narrow.** Refuse a shadowed keystore rotation without changing bytes. A successful
rotation may clear only that credential's authentication faults through the admitted live seam,
not allowance exhaustion, rate limits or unrelated evidence. Never race a daemon by editing its
fact files. Corrupt/degraded credential stores refuse mutations rather than resetting to empty;
re-learnable caches may degrade to missing data. Secrets do not belong in argv or child diagnostics.

**XDG is path selection, not migration.** An existing preferred artifact wins; otherwise an existing
legacy artifact remains in use. Nothing is moved or copied. Preserve artifact classification and
explicit path overrides; the loaded config determines its control-token directory. Test guards
belong in the individual resolvers/spawn seams. Windows environment recovery fills gaps only,
compares names case-insensitively and does not import a user-scope PATH fragment as a complete PATH.

### Candidate selection, evidence and recovery

**Use the shared walk.** Health bands preserve candidates and ordering within the appropriate
boundaries. Slot selection must not reorder deployments. Offering an attempt consumes nothing;
the start boundary owns budget/LRU/egress bookkeeping. Re-offer an unstarted pending attempt and
keep concurrent callbacks in per-attempt records. Record retriable outcomes even on the final
candidate. Keep relay-local failures, provider failures and credential faults distinct.

**Do not confuse cost, capability and availability.** Dynamic pools can place paid/unknown members
behind free members within each effort band; `include: "free"` is not a free-only guarantee.
`freeOnly` applies to resolved targets, including direct pool addresses and explicit directives;
unknown cost cannot spend as free, and an empty allowed set must not fall through to primary quota.
Measured pool bands and their degrade tails require qualifying capability evidence, whereas
unknown *lane* capability is non-restrictive. Pins never cross guardrails or resurrect unavailable
lanes. Announce capability degradation rather than silently changing the promised band.

**Context limits have surface-specific evidence ladders.** The request guardrail uses an explicit
ceiling learned from the exact deployment, then that provider's cached publication; unknown means
no guardrail, not a guessed cap or a blocking lookup. Dispatch template context additionally accepts
an exact synced snapshot match, never a fuzzy borrowed SKU. A pool uses the minimum known member
window and reports unknown members separately; missing evidence is not a claim that every member
supports that window. Keep these ladders distinct rather than widening request admission by accident.

**Facts apply only where evidence supports them.** Preserve scope, explicit group members, kind,
cost-class filters and reset provenance. A filtered fact matches nothing when the caller supplies
no class; success clears it only within its class. Success can disprove conditions, not measurements.
Exhausted free allowance is not a paid-only model, and paid allowance says nothing about free
capacity. Only the appropriate eligibility conditions evict. Bare status codes or several sibling
failures do not justify a broader credential/provider fact.

**Interpretation stays out of band.** The request path does signature lookup; a miss learns nothing
and queues evidence. Proposals may be agent-authored; acceptance is the operator's decision.
Generated commands retain signature digests and every scope/cost narrowing flag. Treat provider
messages as untrusted input. Network-block advice is display-only; do not suppress its recurring
warning by rejecting the queue item merely to tidy the list.

**Allowance, pacing and hard caps are distinct.** Quota demotion needs gateable evidence and a
resolvable reset; learned allowance limits require the explicit opt-in, published reference data
never gates, and unknown evidence has no effect. Pacing uses this relay's trailing attempt-start
window and may consume explicitly learned rate ceilings without that allowance opt-in. It never
sleeps, refuses or adds an invented cooldown. Hard caps use operator-declared numbers at their
declared credential/deployment scope; skipped attempts consume no quota/LRU/health/accounting
attempt. An all-capped refusal must not count against its own cap.

**Cooldowns are evidence-labelled recovery policy.** Keep provider `Retry-After`, measured elapsed
cooldowns and tunable fallback/escalation sources distinguishable. Retry another candidate rather
than sleeping on `Retry-After`. A successful probe retracts only conditions/cooldowns its exact
cell and source/status gates permit; it does not reset the real-traffic failure ladder wholesale.
Persist full breaker evidence, including lapsed cooldown rows and counters: restarting is not a
success. Never restore over fresh live state. Catalog refresh requires a listed model's evidenced
absence, not any 404 or a caller's typo; refresh the roster rather than editing it from the error.

**Keep latency datasets separate.** Request per-token measurements are primary and final once they
have enough evidence; absolute fallback uses measurable probe samples only. A request without a
token count belongs in neither statistic. Request samples must not update probe scheduling fields.
Unknown latency is no demotion. Lane wall-clock history counts only completed answers as durations;
failures/abandonment remain counts, not times-to-answer, and do not enter HTTP latency data.

**Hedges win at meaningful-content commit, not headers or a metadata preamble.** Errors that the
walk would retry are not winners. Resolve the second candidate when needed, abort losers through
the explicit abandoned path, and keep their spend separate without charging provider health.
After commit, watchdog failure ends the stream; a hedge cannot replace bytes the client already
received. The production hedge decision has no output tokens before commit, so do not describe its
per-token branch as active there. Its floor scales with input estimates; defaults are not measured
provider limits. Ordinary client cancellation has a different, commit-state-based health policy.

### Translation, repair and streaming

**Preserve conversation structure.** Map tool calls/results with consistent IDs and ordering;
refuse unrepresentable content with a local error instead of stringifying internal envelopes.
Document conversion covers tool-result content too. Keep supported images lossless; do not promote
arbitrary JSON or prose into a tool call. Direct native Chat passthrough and relay-authored translated
requests intentionally have different compatibility responsibilities.

**Destructive refusal happens before argument acceptance.** Use the one configured matcher:
case-insensitive exact names, with an explicit trailing `*` for prefix matching; an empty list
refuses nothing. Dialect parsers report every recognized name, including malformed calls they cannot
commit. Refuse a destructive envelope whole, terminally and with local provenance on buffered and
streamed paths; never reroll another provider or charge its health. Native well-formed calls remain
the backend's intent. Repairs conserve block order/count, call IDs/names and the backend envelope.
Transport failure throws through reshaper failover; a model refusal returns and is not retried.

**Compatibility follows the resolved target.** Outbound strict-nine-character ID mapping is
deterministic and preserves call/result linkage across retries. Response-side collision repair
needs no reverse store because the client echoes the new ID. Sentinel thought signatures are the
vendor's raw opt-out token, not invented reasoning; stamp through the authored Chat mapper, not
native direct-Chat passthrough. Keep explicit overrides and record counts, never signatures.
A host-scoped default is not evidence that every model on that host was live-tested.

**Reasoning and output caps need explicit semantics.** Generic cross-vendor mapping does not invent
a reasoning budget. DeepSeek's compatibility path may use caller reasoning or routed effort, but
forced tool choice or replay without usable reasoning disables incompatible thinking and announces
it. Never treat encrypted/redacted content as reasoning text. An absent Responses output limit
stays absent for OpenAI targets; a required Anthropic limit is resolved at the target, with any
fallback labelled as an implementation default. Learned output ceilings do not authorize clamping
an explicit caller limit. A capped response is incomplete, not a successful whole answer.

**Commit probes and stream transforms must be lossless.** Structural preflight and final-wire
commitment are separate checks; both replay consumed prefixes. Do not clone a discarded failover
body and leave an unread tee. Preserve each parser's event/whitespace policy, mixed line terminators
and held-byte release on errors. Unknown think-tag shapes remain text. Stall, crawl, first-byte and
total deadlines are different mechanisms; a zero-token crawl window leaves silence to the stall
watchdog. A translator can emit an error and close normally after abort: inspect the attempt's
signal before recording success, without sending a second error frame.

### Dispatch, process ownership and restart recovery

**Use MCP for portable task execution.** CLI `dispatch --next-command` and `/dispatch` are advisory.
The model-serving data plane never shells out to an agent; operator/background probes and the
admitted MCP broker are separate execution paths. Background lane hooks run only from the
self-scheduled loop, not an HTTP-triggered probe tick. Default config deliberately has no
machine-specific ladder or CLI template.

**Host capability belongs to the caller.** The daemon cannot infer a bypassed host from its own
environment. Preserve routed/bypassed/unknown and absent-verdict compatibility semantics.
Transposition supplies executable commands where native children cannot address a relay spec;
`requester=mcp` must reach the shared daemon view. Offload keys come from paths (`claude`, `codex`,
`openai`, `default`), not arbitrary app names. Any supported child signal suffices; absent evidence
does not become a child request. Keep explicit directives confined to the initial marked-child
prompt, never later messages/tool results. Toggling offload preserves other rule fields and removes
only its owned hook; generated host files must not overwrite user edits. Preserve the Desktop-specific
MCP server name and explicitly selected relay-wrapper model rather than inheriting the caller's model.

**Read-only is a mechanism, not a prompt.** Enforce cwd/allowed-root and supported harness-tool
boundaries, skipping unsupported harnesses. Do not use headless plan mode as an editing lane or
claim it completed work merely because it exited successfully. Preserve isolated routed-Claude
configuration and configured idle-watchdog settings. Template task substitution is argv-only;
config-resolved spec/context substitutions may also enter env. Windows npm shims resolve to verified
Node entrypoints without a shell. Launchers share credential scrubbing, explicit operator env
overrides/null unsets, recursion depth and owned-process cleanup.

**Broker ownership survives the MCP host, not the daemon.** Fresh agent attempts prefer the daemon
broker. Persist the execution identity before sending an idempotent start. Once a start may have
been sent, transport uncertainty must not trigger a duplicate local launch. Resolve lane IDs against
live daemon config; clients cannot supply arbitrary command/argv/env. A replacement MCP process
claims only a dead owner's broker row and reconciles with the daemon; live foreign jobs remain
foreign. Daemon shutdown cancels its owned trees. Hard-cap harness continuation is a different,
unimplemented feature governed by the live evidence gate in the handoff/backlog.

**Status carries the verdict.** Use the public liveness snapshot instead of asking callers to infer
activity. Output, attributable relay traffic, tree changes and owned-tree CPU are evidence; a missing
signal is not idle and the first CPU sample is only a baseline. Idle-only walk advancement must
respect the last/no-reliable-next lane protections. Keep host-aware waits short enough for the tool
transport and return a job handle for longer work; terminal polling includes the result. Cancellation
and timeout do not justify claiming an owned process was reaped without checking its outcome.

**Recovery must not erase its evidence.** Journal/archive read-merge-write operations share a
transaction lock. Preserve unrelated rows and use conditional ownership/identity checks for claims
and clears. Keep the journal until terminal archival succeeds. Bounded Windows replacement retries
hold the lock and never unlink the destination first. Preserve bounded starting-tree metadata across
lane changes, but not the prior attempt's broker identity. Missing legacy/oversized tree baselines
are not an empty clean tree. Report status deltas and scope flags without reverting files or claiming
causal attribution in a shared cwd; same-status edits may be absent from the delta even when mtime
shows activity. AGY log evidence must be fresh and attributable; ambiguity remains inconclusive.

### Accounting, dashboard and diagnostics

**One ledger, explicit bases.** Keep reported and estimated tokens separate; never add them into a
single claimed measurement. Price per deployment into integer micro-USD provenance cells, keeping
unpriced/partial coverage visible. Served-answer spend, repair spend and abandoned-attempt spend
have different meanings; do not fold losers into the answer total or duplicate token accounting in
`LOG_FIELDS`. Raw backend usage is the ledger source. Do not silently expand accepted translated-SSE
usage-parity limitations into a new translation project.

**Persisted validity is part of correctness.** Schema additions need write/reload tests, not only
in-memory assertions. Missing, corrupt and thrown reads have different meanings; a thrown read is
not empty or zero. Writer failures remain observable without stopping serving. Read-only external
readers do not repair or rewrite state. Atomic per-file writes are not a multi-file transaction;
retain the documented bounded crash window rather than claiming replay/quarantine machinery exists.
Flush write-behind stores on graceful shutdown; a hard process kill can still lose buffered changes.

**Projection must not invent data.** Unknown metrics do not alone mean lost coverage; mark partial
when held data was actually omitted/lost. Keep bounded projections and platform-free wire contracts.
Cost CLI and dashboard use the same roll-up; print actual covered bounds and excluded partial buckets
without moving the window to disguise them. Keep flush lag distinct from window coverage. Dashboard
bootstrap/session authority is read-only, separate from control tokens, and revoked on restart.

**Diagnose the process that serves the request.** A new CLI's environment can differ from a running
daemon's. Consult live, admitted status before blaming credentials. Distinguish actual routed
identity from upstream-reported model claims, capability from operational fitness, and no evidence
from evidence of failure. Keep candidate dimensions separate rather than adding a blended best-target
score. Capability data comes from sync; source absence is not a zero score, schema drift is not a
successful empty source, effort variants are not base models, and price suffixes borrow weights only
through the supported exact match, never prices or an unrelated SKU's context window.

## Status & open work

Current status belongs in [HANDOFF.md](HANDOFF.md); unmet properties belong in
[docs/backlog.md](docs/backlog.md). Do not repeat test counts, account quotas, best-model claims,
release diaries or blanket assertions that every gap is closed here.

For subsystem detail, use the live [reference](docs/reference.md),
[pool failover](docs/pool-failover.md), [pool eligibility](docs/pool-eligibility.md),
[subagent routing](docs/subagent-routing.md), [host dispatch](docs/host-adaptive-dispatch.md),
[agent capabilities](docs/offload-agentic-capability.md), [capability sources](docs/capability-sources.md),
[dialect handling](docs/tool-call-dialect-leak.md) and [delegate gate](docs/delegate-gate.md) guides.

Dated records belong directly in [docs/history/](docs/history/); read its index before treating an
old plan as instructions. In particular, the former MCP rejection and never-spawn wording were
superseded, the unused kernel framework was removed, and restart-safe ownership/config reload are
implemented rather than pending. The full pre-cleanup narrative remains in git history; this guide
retains the contracts rather than another copy of the incidents. Keep links and existing heading
anchors stable when editing documentation, and update the live guide when its behavior changes.
