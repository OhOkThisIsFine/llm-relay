# Architecture

A source map for contributors. Start here, then consult the relevant section of
[`../CLAUDE.md`](../CLAUDE.md) for detailed invariants and rationale.

For setup, read [`QUICKSTART.md`](QUICKSTART.md); for commands and configuration, read
[`reference.md`](reference.md); for the contribution workflow, read
[`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## 1. What the relay is

llm-relay is a loopback traffic control plane with two entry points: an HTTP proxy for LLM
clients, and an MCP server for dispatching complete tasks to configured agent lanes.

The proxy resolves a requested model to configured deployments, orders candidates, forwards the
request, and records the result. It supports failover, usage accounting and tool-call repair.

Three principles guide changes:

- **Reliable:** retain fallback candidates and distinguish availability from capability.
- **Transparent:** expose routing and failure evidence through response metadata, status and logs;
  report unknown values as unknown rather than inventing measurements.
- **Lightweight:** reuse existing mechanisms rather than adding parallel implementations.

The relay repairs protocol **form**, not judgment. It may correct malformed tool-call arguments;
it must not invent intent or fabricate destructive calls. Routing is deterministic and configured,
not decided by a model in the request path.

Startup accepts only the supported loopback hosts. Loopback is not authorization: request
admission checks the listener authority, protected control routes require the per-install control
token, and the dashboard uses its own read-only session. The data plane uses configured
client/provider credentials; it is not a remotely authenticated relay service.

## 2. The request path

```text
client
  POST /v1/messages          Anthropic front
  POST /v1/chat/completions  OpenAI Chat front
  POST /v1/responses         OpenAI Responses front
    |
    v
server.ts / routes/
  1. Resolve model -> routing spec -> configured targets.
  2. Order deployments and select credential slots.
  3. Walk candidates, applying request policy, failover and optional hedging.
  4. Translate responses; validate and, when enabled, repair tool calls.
  5. Record health, accounting and metadata-only diagnostics.
    |
    v
client
```

The Anthropic front is in `routes/messages.ts`; the OpenAI fronts are in
`routes/openai-front.ts`. Shared policy must reach **both**. The validation and repair layer uses
Anthropic-shaped messages internally; backend and request-mapping modules handle wire translation.

## 3. Candidate ordering

`orderByUsability()` retains every candidate it receives, ordering them into probation, live,
slow, paced, credential-faulted and cooling bands. Health demotes candidates; it does not remove
them. Earlier target resolution can exclude declared-missing credentials when alternatives exist;
when none are usable, it retains the list so the failure remains explicit.

| Module | Decision |
|---|---|
| `quota-demotion.ts` | Reorder for exhausted allowances with stated resets. |
| `latency-demotion.ts` | Reorder for sustained measured latency. |
| `pacing.ts` | Reorder for a stated request-rate ceiling. |
| `hard-cap.ts` | Enforce an operator-configured cap. |

The first three affect ordering. An operator-declared hard cap can refuse an attempt; an unknown
provider limit must not become an invented cap.

## 4. Module groups

Paths below are relative to `src/` unless noted otherwise.

### Entry points and configuration

| Module | Responsibility |
|---|---|
| `cli.ts` | Parse arguments and dispatch commands. |
| `server.ts` | Compose the proxy, admission checks, shared policy and runtime services. |
| `config.ts`, `config-types.ts` | Load, validate and resolve configuration; declare its types. |
| `config/routing-parser.ts`, `spec.ts` | Parse routing policy and routing-spec syntax. |
| `config-reload.ts` | Apply supported changes transactionally; reject restart-only changes without partial application. |
| `state-paths.ts` | Resolve state locations with XDG and legacy fallback. |

### Fronts and translation

| Module | Responsibility |
|---|---|
| `routes/messages.ts` | Anthropic Messages endpoint. |
| `routes/openai-front.ts` | OpenAI Chat and Responses endpoints. |
| `routes/admin.ts` | Control endpoints. |
| `backend.ts` | Send backend requests and normalize responses. |
| `openai-request.ts`, `responses-request.ts` | Request translation between supported wire formats. |
| `documents.ts` | Convert document blocks for backends without native support. |

### Tool-call correctness

| Module | Responsibility |
|---|---|
| `validator.ts` | Validate calls against declared tool schemas. |
| `repair.ts`, `reshaper.ts` | Orchestrate repair and its model failover; enforce the destructive-call boundary. |
| `tool-dialects.ts` | Recover supported tool-call forms emitted as text. |
| `tool-use-ids.ts`, `think-tags.ts` | Normalize identifiers and handle leading reasoning blocks. |

### Health and routing decisions

| Module | Responsibility |
|---|---|
| `candidate-runner.ts` | Candidate ordering, retry classification and the candidate walk. |
| `circuit-breaker.ts` | Failures, cooldowns, credential faults and health measurements. |
| `credential-select.ts` | Rank credential slots within a deployment. |
| `dynamic-pools.ts`, `benchmarks.ts` | Materialize catalog-backed pools and rank their members. |
| `target-facts.ts`, `refusal-interpretation.ts` | Store scoped deployment evidence and accepted refusal interpretations. |

### Metering

| Module | Responsibility |
|---|---|
| `accounting.ts`, `accounting-store.ts` | Accounting events and the persisted request ledger. |
| `usage-observer.ts` | Observe token usage without changing response bytes. |
| `metadata.ts` | Resolve limits and prices with provenance. |

### Credentials

| Module | Responsibility |
|---|---|
| `keystore.ts`, `os-keyring.ts` | Encrypted credential storage and key protection. |
| `authEnv.ts`, `credential-fleet.ts` | Resolve provider credentials and labelled credential fleets. |
| `key-checker.ts` | Check credential status without inventing a verdict when evidence is absent. |
| `control-authorization.ts` | Manage and validate the per-install control token. |

### Dispatch (agent to agent)

| Module | Responsibility |
|---|---|
| `dispatch.ts` | Select lanes for a complete task. |
| `mcp/server.ts` | MCP tools, walk orchestration and reconciliation of daemon-owned attempts. |
| `mcp/lane-runner.ts` | Local fallback process ownership and job bookkeeping. |
| `lane-execution-broker.ts` | Daemon-owned, idempotent lane execution that survives an MCP host restart while the daemon remains alive. |
| `configured-lane-execution-launcher.ts` | Resolve broker starts against live daemon configuration and launch the lane. |
| `lane-affinity.ts`, `lane-activity.ts` | Track lane outcomes and activity evidence. |

Restart-safe ownership is implemented. Resuming an interrupted harness session after an active
hard-cap event is a separate, unimplemented feature; see [`backlog.md`](backlog.md).

### Background work

| Module | Responsibility |
|---|---|
| `ping/cadence.ts`, `ping/metrics.ts` | Adaptive probes, latency statistics and stability measurements. |
| `ping/probe-cache.ts`, `catalog.ts` | Persist probe samples and refresh provider catalogs. |

### Dashboard

| Module | Responsibility |
|---|---|
| `dashboard-contract.ts`, `dashboard-snapshot.ts` | Versioned wire types and bounded read-only projections. |
| `dashboard-auth.ts` | Exchange a one-time bootstrap for a read-only session. |
| `../dashboard/` | React application. |

## 5. State on disk

The legacy default is `~/.llm-relay/`. `state-paths.ts` resolves config and cache artifacts under
`XDG_CONFIG_HOME` and `XDG_CACHE_HOME` when set. If the preferred artifact is absent but its legacy
counterpart exists, the legacy path remains in use. No files are moved, copied or deleted.
An explicitly loaded config also determines where its control token lives.

| Artifact | Purpose |
|---|---|
| `config.json` | Operator configuration. |
| `.env` | Provider keys in plaintext; secret. |
| `keystore.json` | Encrypted credentials; secret. |
| `control-token` | Authorization for protected control routes; secret. |
| `usage/` | Request ledger. |
| `breaker-state.json`, `probe-cache.json` | Health and latency measurements. |
| `target-facts.json` | Scoped deployment evidence. |
| `models-cache.json`, `lane-manifest.json` | Provider catalogs and lane capabilities. |

Callers must isolate persistent state in tests. The path resolver itself does not provide a
vitest guard. The full path and storage reference is in [`reference.md`](reference.md).

## 6. Where to make a change

| Change | Start at |
|---|---|
| CLI behavior | `cli.ts` and the command's module. |
| Model resolution or pool membership | `config.ts`, `spec.ts`, `dynamic-pools.ts`. |
| Candidate order or failure handling | `candidate-runner.ts`, `circuit-breaker.ts` and the policy modules in section 3. |
| Configuration reload | `config-reload.ts` and its server integration. |
| Translation or tool-call correctness | The relevant request mapper, `backend.ts`, `validator.ts`, `repair.ts`. |
| Logging or metering | `log.ts`, `accounting.ts`, `accounting-store.ts`. |
| HTTP endpoints or admission | `routes/`, `server.ts`, `control-authorization.ts`. |
| Agent dispatch and lifecycle | `dispatch.ts`, `mcp/`, `lane-execution-broker.ts`. |

Cover both HTTP fronts for shared policy changes. Validate new configuration fields explicitly;
an ignored typo must not look like an applied setting.

## 7. What is deliberately absent

- **Model judgment in routing.** Unfamiliar refusals are interpreted out of band and require an
  accepted verdict before affecting policy.
- **A hosted relay or pooled consumer accounts.** Each operator runs their own instance with their
  own credentials.
- **Invented capability, limits or prices.** Capability data is synced; absent measurements remain
  unknown. Do not replace missing evidence with hardcoded assumptions.
- **A blended “best target” score.** Decision surfaces keep relevant dimensions separate rather
  than hiding their tradeoffs in an average.

## 8. Reading further

[`reference.md`](reference.md) is the user reference. [`project-goals.md`](project-goals.md) and
[`project-philosophy.md`](project-philosophy.md) explain scope and design choices.
[`pool-failover.md`](pool-failover.md), [`pool-eligibility.md`](pool-eligibility.md),
[`subagent-routing.md`](subagent-routing.md) and [`capability-sources.md`](capability-sources.md)
cover their respective subsystems. Use [`../CLAUDE.md`](../CLAUDE.md) for detailed invariants and
[`history/`](history/) for dated evidence, not as a substitute for the live backlog.
