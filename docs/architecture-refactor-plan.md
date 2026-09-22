# Architecture refactor plan — adopt full-agent dispatch

**Updated:** 2026-09-22. **Status:** implementation plan, not an installed replacement.
**Reviewed relay baseline:** `cf6d16bbf9d35cb35a232e633a1d2836f17d941d`, package `0.86.0`.

## 1. Decision and authority

Build one complete delegation service for Claude Desktop, Codex Desktop, and other local MCP hosts. A host submits an objective and context; a worker inspects the workspace, uses tools, edits files, runs tests, iterates, and returns a result. The host can observe, answer required questions, cancel, and continue the same work. The user must not shuttle model responses or execute the worker's individual tool calls.

**Adopt `opencode-mcp` + a persistent OpenCode server + the standard LiteLLM proxy.** Keep llm-relay only for installation, configuration, migration, and short host instructions that upstream does not already supply. If upstream packaging makes that shell unnecessary, retire it too.

This follows the owner's September 22 clarification: smooth full-agent dispatch is the purpose; preserving every existing relay feature is not. Repair is not essential. Finished-system maintenance burden matters more than refactor size or dependency count. AX is explicitly excluded for now.

This document replaces the September 21 custom-service plan and supersedes the R1 decision to retain custom request execution. **Do not implement the former R2 RequestService, R3 bespoke SQLite job store, or R4 DispatchService first.** R0's lock fix remains valid for the existing runtime. R0/R1 measurements and gateway failures remain historical evidence, not a mandate to reproduce the old architecture or repair every retiring path. The previous plan is retained in [git history](https://github.com/OhOkThisIsFine/llm-relay/blob/cf6d16bbf9d35cb35a232e633a1d2836f17d941d/docs/architecture-refactor-plan.md).

For replacement design, this plan and the dated amendment in [project-goals.md](project-goals.md) take precedence over conflicting legacy topology, repair, health-policy, and storage prescriptions in the agent guide or historical records. While old code remains deployed, do not weaken its safeguards under the guise of preparation. Changes to actual access, spending, retention, and supported destinations must be disclosed before cutover.

## 2. Selected architecture

```text
Claude Desktop / Codex Desktop / another local MCP host
                         |
           local stdio connection in each host
                         |
              opencode-mcp (upstream)
                         |
                 authenticated HTTP
                         |
           one independently managed OpenCode server
          sessions + full agent/tool loop + permissions
                         |
             standard LiteLLM proxy, single instance
           configured endpoints + ordinary retry/fallback
                         |
                  approved model endpoints
```

This is one user workflow, not separate answer-only and coding products. OpenCode is the delegated worker, not a replacement desktop interface. Its Build agent supplies the execution loop and tools; LiteLLM supplies that worker's model calls. The connection between OpenCode and LiteLLM is already documented upstream. [S1, S3]

| Responsibility | Selected owner | llm-relay's remaining role |
|---|---|---|
| MCP tools, task submission, observation, input and result formatting | `AlaeddineMessadi/opencode-mcp` | Install and configure the upstream bridge; no second MCP server by default |
| Agent reasoning/tool loop, coding tools, conversations and follow-up | OpenCode | Configure approved workspaces, models and tool access |
| Provider transport, model aliases, ordinary request retry/fallback and usage facilities | Standard Python LiteLLM proxy | Supply native LiteLLM configuration, not a routing wrapper |
| Long-lived service processes | Existing operating-system service facilities | Small install/start/stop/health scripts, not a job supervisor |
| Sessions and job handles | OpenCode storage and the bridge's upstream task store | Locate, protect and back up those stores; no third job database |
| Host integration | Native MCP configuration and short host instructions | Preserve user settings and make the same workflow discoverable in both hosts |

### Why this combination

The bridge's released v3.0.0 documents asynchronous delegation, stored job handles, explicit input-required states and session follow-up. Its implementation submits through OpenCode's asynchronous API rather than making the parent host execute tools. Its source also distinguishes an observation timeout from cancellation. These are directly relevant capabilities, not a requirement to pass every old relay test. [S2]

The standard LiteLLM proxy is chosen instead of the LiteLLM Agent Control Plane bundle. The latter contains an OpenCode runtime but uses its own gateway service and a broader platform; the reviewed initial MCP sub-agent call waits for output with a five-minute limit. Adopt the direct bridge and standard gateway without that extra agent-platform layer. Bifrost and ACP runtimes remain alternatives only for a demonstrated unmet requirement, not parallel implementations. No AX, Kubernetes, generic workflow engine, or new agent framework belongs in this migration. [S8]

**Evidence boundary:** the bridge review baseline is v3.0.0, not a promise that every later release is compatible. Upstream documentation, selected source and release evidence support this choice; the combined stack has not been qualified in the owner's desktop applications. Pin an actual tested OpenCode/LiteLLM/bridge/runtime version set in A1. Do not copy an old probe's dependency versions or use floating `latest` at normal startup.

## 3. One complete host workflow

Use the upstream `essential` tool profile initially. It retains delegation, observation and required-input workflows without exposing the full administration catalog. It is not a sandbox or a reduced-capability worker: OpenCode still executes the complete task under its configured permissions. Do not add a renaming proxy merely to preserve old tool names. [S2]

| User action | Integration behavior |
|---|---|
| Delegate | Supply the objective, relevant context, absolute workspace, permitted scope and acceptance criteria; start a dedicated OpenCode session/job with the configured Build agent and model alias |
| Check or wait | Use upstream job/status tools and bounded waits; execution progresses without polling |
| Return after a host restart | Rediscover the stored job/session and observe the existing work; do not resubmit the objective |
| Answer required input | Present the worker's question or permission request and forward the user's response through the upstream tools |
| Continue | Submit a follow-up in the same known session, after checking whether another turn is active |
| Cancel | Use the explicit upstream job/session cancellation operation; stopping observation is not cancellation |
| Review | Return the worker's summary, test outcome and workspace changes; the parent can inspect artifacts without performing the worker's tool loop |

The host must pass relevant decisions and files or accessible references. The worker does not inherit the parent's entire conversation, attachments, cloud connectors or secrets. Configure required external MCP tools on OpenCode once, and disclose unavailable tools before delegation. Disable recursive exposure of the dispatcher inside its own worker. For non-coding work, qualify the required external tools in the same full-agent workflow rather than substituting a text-only call. [S3, S4]

Short host instructions must teach submission, handle retention, bounded waiting, input handling and follow-up. Test whether each desktop actually follows that workflow. A protocol handshake is not user-experience acceptance. The bridge does not promise notifications that wake an idle assistant; native MCP Tasks are optional, and ordinary fire/check/wait tools are the baseline. A user may return and ask for status, but should not need to copy job IDs manually. If normal interaction loses handles or strands completed work, fix that focused integration issue before cutover. Do not solve it with an invented notification guarantee. [S2, S7]

## 4. Installation and configuration

### Local-first, Windows-first qualification

Run OpenCode natively on the workstation so it sees the intended repository paths and installed development tools. Install the bridge in a pinned Node environment and LiteLLM in an isolated Python environment. Keep OpenCode and LiteLLM independent of desktop/MCP process lifetime. Use per-user OS service facilities; qualify Windows first, then other platforms actually claimed by the release. Do not introduce a cross-platform process-monitoring framework or require containers merely for packaging.

The setup command should install or validate the version set, create private configuration, register the two services, verify authenticated readiness, and add the local MCP entry to both hosts. It must preserve unrelated host settings, report missing prerequisites, and support stop, restart, diagnostics and removal. It is an interactive install/update step, not work hidden in package postinstall or desktop tool startup. If native LiteLLM installation fails qualification, evaluate its supported container deployment as a bounded packaging correction before changing architecture.

Use one OpenCode instance for this dispatch installation and one shared bridge store for its same-user hosts. Set `OPENCODE_AUTO_SERVE=false`: the reviewed bridge terminates an OpenCode child it auto-started when that MCP process closes. Attach development TUIs to the managed server rather than starting competing servers against its storage. [S2]

Both HTTP services bind to loopback and require authentication. Provider keys belong in the gateway's private configuration/environment, not prompts or ordinary worker shell environments. The bridge receives only its OpenCode connection credentials. Do not expose a LAN listener, public tunnel, or cloud-brokered remote MCP connector to make a local desktop configuration work. Claude Desktop's local MCP mechanism is distinct from remote connectors, which connect from Anthropic's infrastructure. [S7]

### Native configuration, not a new configuration framework

LiteLLM's `model_list` owns endpoint identities, gateway aliases and approved fallbacks. OpenCode owns worker/tool settings and the model metadata it actually requires. The bridge owns its supported connection and tool-profile settings. A small setup routine can populate the required overlap and check alias agreement; do not invent another universal schema or use two-way synchronization.

Use the documented OpenAI-compatible OpenCode-to-LiteLLM provider as the default wire. Do not require the new service to reproduce three old inbound protocol fronts when only this worker connection is used. Declare actual tool support, context/output limits and modalities from verified endpoint information; a listing alone does not establish those capabilities. The upstream guide specifically requires OpenCode-side modality declarations for image-bearing requests. Preserve task-bearing inputs, and use narrow documented compatibility settings rather than global silent parameter dropping. [S1, S5]

Configure the default and auxiliary OpenCode agents, including summarization/title/compaction models where applicable, to use approved routes. Review OpenCode's effective configuration: `OPENCODE_CONFIG` is not isolation from project configuration, which can override it. Qualify supported precedence/override settings and approve project plugins and MCP servers before running untrusted project configuration. [S3, S4]

Start with one gateway process and file-backed route configuration; Redis and PostgreSQL are not baseline requirements merely to proxy this installation. Do not advertise persistent virtual-key budgets or historical spend from this minimal configuration. If an existing explicit spending constraint needs durable state, use LiteLLM's supported persistence facilities or a verified provider-side control before enabling that destination; otherwise leave it disabled pending an explicit owner decision. Never replace a required cap with a volatile counter or silently remove it. Do not build another ledger to avoid adopting an upstream database. [S5, S6]

### Endpoint access is a migration requirement

Inventory actual destinations and authentication methods before switching. A model API credential, a desktop subscription and a native coding-agent login are not interchangeable. OpenCode using a model does not mean it runs the native Claude/Codex/Antigravity harness or inherits that harness's quota.

For each used destination, record: routable through the selected stack, supported upstream native integration required, or explicitly retired with owner agreement. Preserve any necessary native-agent capability through an existing supported integration only when that need is demonstrated; do not silently discard it or prebuild a second general dispatcher. Do not copy consumer tokens into LiteLLM, fabricate session identities, or promise that changing the worker fixes a vendor access restriction. A1 must resolve required destinations before calling the replacement sufficient.

## 5. Execution, safety and state semantics

### Retry and continuation

LiteLLM owns configured endpoint selection and ordinary model-request retry/fallback. OpenCode owns the agent/tool loop and conversation. Review their actual retry settings together: they may both retry at different layers, so record and test the combined request bound rather than claim retries exist in only one process. The bridge and setup shell must not add a third retrying dispatcher.

A failed model request may fall back within the approved endpoint set. An uncertain task submission must not cause automatic resubmission of the whole task. Do not replay a file edit or external action merely because an observation failed. Do not enable hedging or automatic whole-job migration between workers in the first release. Follow-up uses the worker's saved session, not replay of a synthesized transcript.

| Event | Supported target behavior |
|---|---|
| Parent tool wait expires or MCP disconnects | OpenCode continues; a later observation retrieves the existing work |
| Parent desktop restarts | Stored handles allow rediscovery against the same worker and credential scope |
| OpenCode process dies or the machine restarts | Preserve available history/results; report interrupted/unknown work honestly; do not promise automatic completion or replay |
| Explicit cancellation | Request cancellation of the selected dedicated session; qualify actual cessation of tools and effects, not only the acknowledgement |
| Follow-up after a completed turn | Continue that same session with its retained context |
| Harness hard limit or gateway outage | Use supported upstream behavior; universal hard-cap continuation is deferred, not a replacement gate |

The reviewed bridge expires job records 24 hours after creation. `OPENCODE_TASK_STORE` selects a directory; do not assume it configures retention. OpenCode session history is separate. Verify rediscovery for intended task durations and explain what remains after handle expiry. Upstream retained sessions are not proof of durable active execution across a worker crash. [S2]

### Workspace and permissions

A full agent needs effective tools, not blanket approval. Configure an appropriate Build-agent policy for the approved workspace: routine edits/tests can be permitted while publishing, destructive operations and broader access require the intended approval. Prove both an allowed multistep task and a denied or input-required action. Do not carry forward tool-call repair as a prerequisite for safety; permissions now belong at tool execution. [S3]

Dedicated sessions isolate conversations, not files. Use separate worktrees for overlapping editing tasks; for a simple installation, one editing task per workspace is acceptable. Setup/instructions must make the chosen rule visible. Shell access under the user's account is not an OS sandbox, and a project path or tool-discovery profile does not confine an arbitrary command. Do not advertise stronger isolation than implemented. [S2, S3]

### Privacy and accounting

OpenCode conversations, tool output and bridge results may contain full task content. This is a material change from the old plan's metadata-only job persistence, not something to hide behind the word "session." Before pilot use with real data, document actual stores, permissions, retention, deletion and backup behavior. Keep diagnostics metadata-only; review upstream debug/logging/callback defaults and disable unnecessary payload collection, remote telemetry and sharing. Do not feed service credentials to the model. A local same-user setup still does not protect secrets from every permitted shell command. [S2, S4, S6]

Use useful upstream usage/cost facilities without promising parity with every old ledger dimension. Keep unknown values unknown and distinguish configured aliases from the actual served model where observable. Preserve explicit spending/access restrictions or flag them as unmapped before enabling use. No custom accounting dashboard, pricing catalog or provider-limit inference system is required for the first replacement.

## 6. Scope reduction and deletion

| Area | Target disposition |
|---|---|
| `src/routes/messages.ts`, `src/routes/openai-front.ts`, `candidate-runner.ts`, request lifecycle kernel | Retire with the custom serving path; do not first consolidate them into RequestService |
| `backend.ts`, request translators, SSE/commit/repair/dialect machinery | Replace their required role with OpenCode/LiteLLM; remove obsolete runtime paths and `llm-bridge` if no consumer remains |
| `src/mcp/server.ts`, custom lane runners, broker, launch clients | Replace required delegation with upstream bridge/worker; resolve actual native destinations before deleting their only supported path |
| Host job journal/archive and custom transaction/lock code | Retire writers; preserve old results as inert archives rather than importing fictitious OpenCode sessions |
| Custom health, quota, hedge, capability-ranking and accounting presentation | Prefer upstream configuration/facilities; retain only a documented requirement not otherwise supplied |
| Installer, state-path resolution, host configuration, credential migration | Keep narrowly where needed; prefer existing mechanisms and remove obsolete options |
| Old proxy interception and host subagent-routing hooks | Remove owned wiring at cutover; primary host conversations remain direct by default |
| Agent instructions, docs and tests | Describe the adopted system and user workflows; remove obsolete assertions only with the retired behavior they protect |

Repair, exact old ranking/health algorithms, transparent interception, the current dashboard and universal hard-cap continuation are not acceptance requirements for full-agent dispatch. Retiring a feature does not mean its old defect was fixed. The native Responses defect remains real while its old route is reachable; fix it only if continued use requires that route, or retire the route with migration notices. Historical gateway comparisons do not certify this new combined stack.

Do not fork upstreams by default. Resolve a concrete failure in this order: supported configuration, compatible released version, focused upstream contribution, then a small documented patch if essential. Every retained patch needs a regression, upstream reference and removal condition. Reopen a component choice only when an essential workflow cannot be supplied reasonably; do not respond to one edge case by rebuilding the whole relay.

## 7. Implementation sequence

These adoption packets replace the old R2–R6 sequence. They are complete units of proof, not empty interfaces or directories.

| Packet | Work | Exit condition |
|---|---|---|
| **A0 — resolve the actual installation** | Inventory hosts/versions, workspaces, endpoints and auth, required external tools, caps, owned host hooks and retained results. Produce a compact migration map without secrets. | Required destinations and data/access changes are mapped; no silent substitution of APIs for subscriptions/native runtimes |
| **A1 — prove the integrated stack** | Pin upstream versions; start isolated OpenCode and standard LiteLLM; configure upstream bridge in both hosts; perform the acceptance matrix below before writing a new runtime | Full real task and follow-up work from both desktops, including restart/recovery observation; only concrete integration gaps remain |
| **A2 — package the proven path** | Add minimal setup/service/health/update/removal support, native config templates and short host instructions. Prefer upstream packages unchanged | Fresh installation and reconnection do not require manual process management or copying handles; versions/state/secrets stay controlled |
| **A3 — controlled cutover** | Back up settings and state; drain or explicitly cancel old jobs; switch owned host entries and remove interception hooks; use the replacement for ordinary work | Both hosts use the new service, required destinations remain available, old runtime is not a fallback, and rollback is rehearsed |
| **A4 — delete and release** | Remove superseded code/dependencies/tests/workflows; publish accurate installation, permissions, retention and limitation docs | One adopted dispatch path remains; retained tests and clean-install checks pass; no custom request engine or parallel job store survives without a demonstrated need |

A0 should be a short inventory, not another platform survey. A1 may uncover an upstream bug; fix or report that mechanism rather than weakening the full-task requirement. Live paid/provider tests require controlled opt-in and available credentials/quota; mocks can prove integration mechanics but cannot establish model quality or desktop usability. Lack of live access is an explicit incomplete acceptance item, not a reason to implement old R2 as substitute progress.

## 8. Acceptance matrix

Run the following against the pinned combined build. Save concise results with host/runtime versions, endpoint aliases, commands and evidence locations; redact secrets and private work. Upstream CI is supporting evidence, not our own end-to-end pass.

| Test | Required observation |
|---|---|
| Full task from Claude Desktop and separately Codex Desktop | Worker reads a disposable repository, changes code, executes tests, fixes a deliberately exposed failure and returns a useful result without the parent driving tool calls |
| Two actual approved endpoints | Both can complete the same representative tool-using workflow through LiteLLM; a text-only response test is insufficient |
| Long job / parent restart | A task running longer than an ordinary host tool wait survives bridge/host shutdown, remains discoverable and completes without polling; repeat with both hosts and inspect from the other host |
| Follow-up | Parent continues the same worker session, with the prior changes/context available and no manual ID transfer |
| Required input and cancellation | Worker questions/permissions are surfaced and resolved; denied actions remain denied; cancelling one dedicated session stops its work without affecting another |
| Failure and fallback | Synthetic endpoint failure exercises approved gateway fallback within the same agent workflow; gateway loss and ambiguous submission do not duplicate whole jobs or turn partial work into success |
| Privacy, restrictions and access | Missing credentials fail clearly; routing does not widen to unauthorized/paid endpoints; diagnostic output contains no payloads/secrets; required external worker tools function |
| Conflicting work and lifecycle | Parallel edits use separate worktrees or are explicitly serialized; worker restart and handle expiry are honestly represented; service start/stop cannot create duplicate workers sharing a store |
| Install, update and rollback | Fresh Windows setup, private storage, authenticated readiness, host configuration preservation, controlled update and restoration all work; qualify other OSes before claiming support |

Measure user-facing costs during A1: installation friction, first delegation, time to usable progress/result, cancellation and idle resource use. Use a local fake backend to separate integration delay from model time when needed. Do not transplant R0's synthetic proxy microbenchmark budgets into a different agent product or make statistical calibration a prerequisite to trying it. No fixed unmeasured performance or memory claims.

## 9. Migration and rollback

Run the pilot on separate ports/config/state with disposable workspaces. Never shadow a live editing task into both old and new systems. Keep old installation behavior unchanged until qualification and explicit cutover.

Before switching, back up the old binary/version, config/credential stores, results and exact owned host settings using the existing XDG/legacy path selection. Stop new old-system admissions and drain jobs or obtain explicit cancellation; verify relevant old writers are stopped. Retain the R0 lock upgrade warning while that code is used. Do not relabel legacy job IDs as OpenCode sessions or attempt to adopt persisted PIDs.

Prefer inert, readable legacy archives over building a new importer or dual-writing store. Keep their private permissions. Preserve new OpenCode conversations/results and workspace changes separately from those archives. Remove or replace only installer-owned MCP entries, proxy environment settings and routing hooks; never erase unrelated user configuration or general agent instructions.

Rollback means quiescing the new worker, preserving its artifacts, stopping its services, and restoring the matched old software/settings/state and owned host entries. It does not undo file edits or external side effects, and old code cannot read new upstream session storage. Preserve/export post-cutover results before restoring snapshots. Service upgrades also need quiescence: restarting OpenCode is not transparent continuation of active work.

Update `README.md`, `docs/QUICKSTART.md`, `docs/reference.md`, `docs/architecture.md`, `CLAUDE.md`, the handoff and backlog as their behavior changes. Until then, those runtime references must not advertise adoption as already shipped. Keep this plan authoritative instead of maintaining competing implementation sequences in several files.

## 10. Completion and evidence

Done means ordinary full-agent delegation works from both desktop hosts through the adopted service, with follow-up, useful status, controlled access and a workable install. The old custom execution paths are removed. A passing upstream suite, a health check, another architectural diagram, or a reduced text-only demo is not completion.

Keep `npm run gate` and Windows checks for the code still retained. As code is deleted, replace only its obsolete topology/feature assertions with focused configuration, lifecycle and end-to-end acceptance coverage. Do not retain thousands of old tests by reimplementing the retired system in adapters, and do not delete a live safety regression to obtain green CI. Maintain a small release-tested version set and rerun the user workflows on dependency upgrades; no new governance framework is needed.

This planning change installs nothing, changes no production dependency, and does not certify live hosts or provider credentials. The first implementation action is **A0 followed by A1**, not a custom service rewrite.

### Primary references

Read on 2026-09-22; upstream pages may change. Version-pin implementation evidence in A1.

- **S1:** [LiteLLM's OpenCode integration](https://docs.litellm.ai/docs/tutorials/opencode_integration) — provider wiring, aliases, modalities and narrow compatibility settings.
- **S2:** `opencode-mcp` v3.0.0: [README](https://github.com/AlaeddineMessadi/opencode-mcp/blob/v3.0.0/README.md), [architecture](https://github.com/AlaeddineMessadi/opencode-mcp/blob/v3.0.0/docs/architecture.md), [configuration](https://github.com/AlaeddineMessadi/opencode-mcp/blob/v3.0.0/docs/configuration.md), [job implementation](https://github.com/AlaeddineMessadi/opencode-mcp/blob/v3.0.0/src/jobs.ts), [server lifecycle](https://github.com/AlaeddineMessadi/opencode-mcp/blob/v3.0.0/src/server-manager.ts), [release](https://github.com/AlaeddineMessadi/opencode-mcp/releases/tag/v3.0.0).
- **S3:** OpenCode [server API](https://opencode.ai/docs/server/), [agents](https://opencode.ai/docs/agents/), [permissions](https://opencode.ai/docs/permissions/).
- **S4:** OpenCode [configuration precedence](https://opencode.ai/docs/config/) and [external MCP tools](https://opencode.ai/docs/mcp-servers/).
- **S5:** Standard LiteLLM [configuration](https://docs.litellm.ai/docs/proxy/configs) and [CLI installation](https://docs.litellm.ai/docs/proxy/quick_start).
- **S6:** LiteLLM [virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys), [production persistence/logging](https://docs.litellm.ai/docs/proxy/prod), [logging controls](https://docs.litellm.ai/docs/proxy/logging).
- **S7:** [Claude Desktop local MCP](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), [remote connector network boundary](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Codex MCP configuration](https://developers.openai.com/codex/mcp/).
- **S8:** LiteLLM Agent Control Plane at reviewed commit `53bfd20e2fec51fc8f665fb614512c6b138367da`: [Compose bundle](https://github.com/LiteLLM-Labs/litellm-agent-control-plane/blob/53bfd20e2fec51fc8f665fb614512c6b138367da/compose.yaml), [OpenCode wrapper](https://github.com/LiteLLM-Labs/litellm-agent-control-plane/blob/53bfd20e2fec51fc8f665fb614512c6b138367da/templates/opencode/README.md), [initial MCP sub-agent call](https://github.com/LiteLLM-Labs/litellm-agent-control-plane/blob/53bfd20e2fec51fc8f665fb614512c6b138367da/src/http/platform_mcps/tools.rs).
