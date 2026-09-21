# Architecture

A map of the code for a person who wants to change it. Read this before
[`../CLAUDE.md`](../CLAUDE.md), which is the same map written for an AI coding assistant, at
roughly fifty times the length.

- To install and use the relay, read [`QUICKSTART.md`](QUICKSTART.md).
- For every option and endpoint, read [`reference.md`](reference.md).
- To submit a change, read [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

---

## 1. What the relay is

llm-relay is a loopback HTTP proxy. It sits between one person's LLM clients and many providers.

A client such as Claude Code or Codex points at `http://127.0.0.1:8791`. The client asks for a
model. The relay resolves that request to a real deployment at a real provider, sends it, and
returns the answer. Along the way it ranks candidates, fails over, meters spend, and repairs
malformed tool calls.

Three properties shape every design decision.

- **Reliable.** Candidates are ranked by capability data and by measured health. A failure
  cascades to the next candidate instead of reaching the client.
- **Transparent.** Every automatic decision is announced in a response header. Every reported
  number carries the basis it came from. Unknown is reported as unknown.
- **Lightweight.** Three runtime dependencies. No second implementation of anything.

Two boundaries are absolute.

- **The repair boundary.** The relay fixes protocol *form*. It never supplies *judgment*. No model
  opinion enters the request path.
- **Loopback only.** Startup refuses a non-loopback bind, because the process holds provider keys
  and performs no authentication of its own.

---

## 2. The request path

```
  client
    |
    |  POST /v1/messages          (Anthropic front)
    |  POST /v1/chat/completions  (OpenAI Chat front)
    |  POST /v1/responses         (OpenAI Responses front)
    v
  server.ts  handle()
    |
    |  1. resolve the requested model to a candidate list
    |       config.ts       model name -> spec -> targets
    |       dynamic-pools   pool/<name> -> live catalog members
    |
    |  2. order the candidates
    |       orderByUsability()  in candidate-runner.ts
    |
    |  3. walk the list, one candidate at a time
    |       credential-select.ts   pick a credential slot
    |       hard-cap.ts            skip a candidate over an operator cap
    |       backend.ts             translate the request, send it
    |       hedge-race.ts          optionally start the next candidate beside it
    |
    |  4. inspect the answer
    |       validator.ts       is each tool call schema-valid?
    |       repair.ts          if not, ask the reshaper to correct the arguments
    |       tool-dialects.ts   recover a tool call the host emitted as plain text
    |
    |  5. record what happened
    |       circuit-breaker.ts   health, cooldowns, credential faults
    |       accounting-store.ts  the per-request ledger
    |       log.ts               metadata only
    v
  client
```

Two fronts exist, and **every policy must reach both**. The Anthropic front lives in
`routes/messages.ts`. The OpenAI fronts live in `routes/openai-front.ts`. A rule enforced on one
front while the other walks around it is not a rule. A real outage was caused by exactly that
asymmetry.

The validate-and-repair layer always sees Anthropic Messages, whatever the backend speaks.
Translation is isolated in `backend.ts` and the two request mappers.

---

## 3. Candidate ordering

`orderByUsability()` returns **every** candidate, ordered into bands. It never removes one.

| Band | Meaning |
|---|---|
| `probation` | free, and barely measured. Placed first on purpose, to gather data. |
| `live` | healthy. |
| `slow` | measured latency is sustained above the threshold. |
| `paced` | at a rate ceiling the provider itself stated. Healthy, merely full right now. |
| credential-faulted | answered 401 or 403. A configuration fault, not a sick backend. |
| `cooling` | a breaker cooldown is active. Ordered by soonest known lift. |

Only an unset credential removes a candidate, and that happens earlier, during target resolution.

Four modules contribute a demotion term. Each is a pure resolver, and each answers a different
question.

| Module | Question |
|---|---|
| `quota-demotion.ts` | is this allowance spent until a stated reset? |
| `latency-demotion.ts` | is this deployment sustainedly slow, per token? |
| `pacing.ts` | have we already sent the stated number of requests this window? |
| `hard-cap.ts` | has an operator-declared cap been reached? |

The first three **only reorder**. `hard-cap.ts` is the sole term that may refuse a request, and
only because the number came from the operator's own configuration file.

---

## 4. Module groups

`src/` holds 102 modules at the top level plus eight directories. They fall into nine groups.

### Entry points and configuration

| Module | Responsibility |
|---|---|
| `cli.ts` | every command. Parses flags and dispatches. |
| `server.ts` | the proxy. Routing, guardrails, endpoints, the candidate walk. |
| `config.ts` | load and validate the configuration file. |
| `config-types.ts` | the one declaration of every configuration type. |
| `config/routing-parser.ts` | parse and validate the `routing` block. |
| `spec.ts` | how a routing spec is spelled: `provider`, `provider/model`, `pool/<name>`. |
| `state-paths.ts` | where state lives. One policy, honouring the XDG variables. |

### Fronts and translation

| Module | Responsibility |
|---|---|
| `routes/messages.ts` | the Anthropic `/v1/messages` endpoint. |
| `routes/openai-front.ts` | the OpenAI Chat and Responses endpoints. |
| `routes/admin.ts` | the control endpoints. |
| `backend.ts` | send a request; return an Anthropic-shaped response. |
| `openai-request.ts` | Anthropic Messages to OpenAI Chat, request direction. |
| `responses-request.ts` | OpenAI Responses to Anthropic Messages, request direction. |
| `documents.ts` | convert document blocks to markdown for a backend that has none. |

### Tool-call correctness

| Module | Responsibility |
|---|---|
| `validator.ts` | is a tool call valid against its declared schema? |
| `repair.ts` | orchestrate a repair; refuse a destructive call. |
| `reshaper.ts` | the repair model client, with failover. |
| `tool-dialects.ts` | recover a tool call a host returned as assistant text. |
| `tool-use-ids.ts` | make translated tool-use identifiers unique. |
| `think-tags.ts` | strip one leading reasoning block, losslessly. |

### Health and routing decisions

| Module | Responsibility |
|---|---|
| `circuit-breaker.ts` | failures, cooldowns, credential faults, measurement. |
| `candidate-runner.ts` | the walk, the hedge race, retry classification. |
| `credential-select.ts` | rank credential slots inside one deployment. |
| `dynamic-pools.ts` | materialize a pool from the live catalog. |
| `benchmarks.ts` | rank pool members by capability plus fitness. |
| `target-facts.ts` | what a deployment stated about itself, with a scope. |
| `refusal-interpretation.ts` | what a refusal means. A lookup, never an inference. |

### Metering

| Module | Responsibility |
|---|---|
| `accounting.ts` | the accounting event vocabulary. |
| `accounting-store.ts` | the per-request ledger on disk. |
| `usage-observer.ts` | observe token usage without changing the response bytes. |
| `metadata.ts` | per-field limit and price resolution, with provenance. |

### Credentials

| Module | Responsibility |
|---|---|
| `keystore.ts` | the encrypted credential store. |
| `os-keyring.ts` | key protection through the operating system, or a passphrase. |
| `authEnv.ts` | resolve a provider's credential from a closed alias list. |
| `credential-fleet.ts` | several labelled keys for one provider. |
| `key-checker.ts` | is a key good? Declines to conclude when evidence is absent. |

### Dispatch (agent to agent)

| Module | Responsibility |
|---|---|
| `dispatch.ts` | the lane ladder: which agent should take a whole task. |
| `mcp/server.ts` | the `llm-relay mcp` tool surface, walk orchestration, and restart reconciliation for daemon-owned attempts. |
| `mcp/lane-runner.ts` | local fallback process ownership and job lifecycle bookkeeping. |
| `lane-execution-broker.ts` | daemon-owned, idempotent agent-lane execution that survives an MCP host restart. |
| `configured-lane-execution-launcher.ts` | resolve a broker start back through live daemon config and launch the configured lane. |
| `lane-affinity.ts` | which lane answered, and which one stalled. |
| `lane-activity.ts` | is a running lane still doing work? |

### Background work

| Module | Responsibility |
|---|---|
| `ping/cadence.ts` | the adaptive probe loop. |
| `ping/metrics.ts` | latency statistics and the stability score. |
| `ping/probe-cache.ts` | probe and request samples on disk. |
| `catalog.ts` | the model catalog, cached and refreshed on evidence. |

### Dashboard

| Module | Responsibility |
|---|---|
| `dashboard-contract.ts` | the versioned wire contract. |
| `dashboard-snapshot.ts` | the bounded read-only projection. |
| `dashboard-auth.ts` | a one-time bootstrap exchanged for a read-only session. |
| `dashboard/` | the React single-page application. |

---

## 5. State on disk

Default directory: `~/.llm-relay/`. Each file honours the XDG environment variables through
`state-paths.ts`. Under vitest every default path redirects to a temporary directory.

| File | Holds | Class |
|---|---|---|
| `config.json` | the configuration | operator-authored |
| `.env` | provider keys in plain text | **secret** |
| `keystore.json` | the encrypted credential store | **secret** |
| `control-token` | authorizes control endpoints | **secret** |
| `usage/` | the per-request ledger | measurement |
| `breaker-state.json` | cooldowns and health | measurement |
| `probe-cache.json` | latency samples | measurement |
| `target-facts.json` | what deployments stated | measurement |
| `models-cache.json` | the provider catalogs | cache |
| `lane-manifest.json` | what each agent lane serves | cache |

---

## 6. Where to make a change

| You want to change | Start at |
|---|---|
| a CLI command | `cli.ts`, then the module it calls |
| how a model name resolves | `config.ts`, `spec.ts`, `dynamic-pools.ts` |
| the order candidates are tried in | `candidate-runner.ts` `orderByUsability()` |
| when a candidate is skipped | the four demotion modules in section 3 |
| what a failure does to health | `circuit-breaker.ts` |
| request or response translation | `backend.ts` and the two request mappers |
| tool-call validation or repair | `validator.ts`, `repair.ts` |
| what gets logged | `log.ts`, and its `LOG_FIELDS` allow-list |
| what gets metered | `accounting.ts`, `accounting-store.ts` |
| an endpoint | `routes/` |
| agent-to-agent dispatch | `dispatch.ts`, `mcp/` |

Two reminders that save a review round. A policy change must reach **both** request fronts. A new
configuration key must be validated at load, because an ignored typo reads as a setting that took
effect while the wire stayed unchanged.

---

## 7. What is deliberately absent

Knowing what was rejected saves you from proposing it again.

- **No model opinion in the request path.** Routing is configuration plus deterministic
  classification. Interpretation of an unfamiliar refusal happens out of band, and a verdict binds
  only after a person accepts it.
- **No hosted relay, and no pooled consumer accounts.** Each person runs their own instance with
  their own keys. The relay never operates a login and never proxies another person's subscription
  traffic.
- **No hardcoded capability table.** Scores are synced from leaderboards into
  `docs/tier-data.json`. An earlier hardcoded table contributed a stale number that outranked real
  data, so it was deleted.
- **No invented limits, prices or context ceilings.** If nobody published a figure, the relay
  reports `null` and applies no guardrail.
- **No blended "best target" score.** `candidates.ts` keeps each dimension separate, because an
  average buries the judgement the reader opened the table to make.

---

## 8. Reading further

| Topic | Document |
|---|---|
| Every option and endpoint | [`reference.md`](reference.md) |
| What the project is and is not | [`project-goals.md`](project-goals.md) |
| The convictions that settle a question | [`project-philosophy.md`](project-philosophy.md) |
| Failover and health behaviour | [`pool-failover.md`](pool-failover.md) |
| Pool membership and eligibility | [`pool-eligibility.md`](pool-eligibility.md) |
| Offload design and wire evidence | [`subagent-routing.md`](subagent-routing.md) |
| Where capability scores come from | [`capability-sources.md`](capability-sources.md) |
| Why a specific rule exists | [`../CLAUDE.md`](../CLAUDE.md) |
| What was true on a past date | [`history/`](history/) |
