# Architecture refactor plan

**Status:** implementation plan; no runtime changes are represented as complete.  
**Direction:** accepted by the owner in the architectural review on 2026-09-21; the detailed implementation choices and acceptance conditions are recorded here.  
**Reviewed baseline:** `078b9a939f65178f73466b2d296b4f9eb6d373a0` (`main`, package version `0.86.0`). Reconcile intervening changes before implementation.

## 1. Objective and authority

Build the smallest coherent system that accomplishes llm-relay's actual goals: reliable personal traffic routing, transparent accounting and decisions, useful agent dispatch, and straightforward local installation.

**Minimize the complexity of the finished system, not the size of the diff.** A substantial replacement is preferable to a small patch that preserves duplicated ownership. Prefer maintained libraries when they remove more maintenance responsibility than they introduce. Neither existing code nor a low dependency count receives special protection.

This clarifies the minimal-mechanism rubric in [project-goals.md](project-goals.md). It does not relax credential containment, loopback admission, protocol fidelity, accounting provenance, destructive-tool safeguards, or process-lifetime correctness. Those protect the product rather than its present topology.

This plan supersedes the *target ownership and implementation sequence* of the earlier [D1 design](history/mcp-restart-safe-lane-execution-design-2026-09-20.md) and the relevant parts of the [development sequence](history/development-plan-2026-09-21.md). Their measurements remain evidence; do not rewrite them as though the new architecture already exists. The [hard-cap continuation evidence gate](history/active-hard-cap-harness-survey-2026-09-21.md) remains binding.

### Scope

Replace duplicated request orchestration, MCP-owned dispatch supervision, multi-process job-file coordination, handwritten MCP protocol plumbing, and repeated structural contract definitions. Evaluate translation/gateway replacements before committing to a new implementation around the old translators.

Do not introduce microservices, Redis, a general workflow platform, a universal message representation without demonstrated need, a plugin framework for hypothetical users, or new prompt-retention guarantees. This is one local application with two application services, not an enterprise platform.

## 2. Target architecture: one owner per decision

```text
External HTTP clients             MCP hosts / CLI callers
         |                                  |
HTTP protocol adapters              Thin command adapters
         |                          (official MCP SDK for MCP)
         |                                  |
         +-------------- relay daemon ------+
                         |                  |
                  RequestService     DispatchService
                         ^                  |
                         |---- answer mode -+
                         |                  |
                provider adapters    lane process runner
                         |                  |
                    providers          agent harnesses

Shared, explicit dependencies:
  validated config snapshots; credentials; routing evidence;
  accounting; SQLite job store; read-only status projections
```

The two services are modules in the same application. The diagram does not require another server, another package, or another framework. Names below describe responsibilities; do not create empty interfaces and directories merely to match the diagram.

| Responsibility | Sole owner | What adapters must not do |
|---|---|---|
| Provider candidate execution | RequestService | Reimplement retry, hedge, commit, or finalization policy |
| Whole dispatch job and lane walk | DispatchService in the daemon | Supervise jobs in each MCP/CLI process |
| A live child process tree | Lane runner called by DispatchService | Adopt a persisted PID or launch a competing fallback |
| Job persistence and migrations | SQLite job store, mutated through the daemon | Maintain per-host journals or a second terminal archive |
| Protocol translation | Selected provider/front adapters | Decide routing or health policy |
| Configuration meaning | Shared normalization and semantic validation | Resolve contradictory defaults independently |
| Status and accounting presentation | Projections of authoritative outcomes | Infer execution decisions from output silence or elapsed time |

Keep evidence-based routing functions and the useful attempt lifecycle kernel. Reuse existing credential, process, repair, and accounting behavior where it passes the new contracts. File size and class count are not acceptance criteria.

## 3. RequestService

### One execution lifecycle

Replace the orchestration loops in `src/routes/messages.ts` and `src/routes/openai-front.ts` with one service that owns candidate offers, credential selection, provider egress, deadlines, hedging, stream commitment, retry eligibility, cancellation, and finalization.

A request captures a validated configuration generation and one routing instant. Provider attempts receive stable identities. Every actual egress is accounted once, and every started attempt reaches one terminal outcome. A rejected candidate is not a provider failure. A duplicate completion cannot update health or accounting twice.

Make the lifecycle explicit: preparation; provider execution before commitment; committed response; terminal outcome. Distinguish client cancellation, relay-abandoned hedge losers, deadline expiry, upstream failure, and local mapper failure. Build on the existing lifecycle enforcement rather than adding a generic state-machine framework by default.

Protocol adapters supply request preparation, response inspection, and output encoding. They do not control the candidate walk. Keep original protocol content available for compatible pass-through; do not normalize away opaque blocks, tool identities, cache-usage distinctions, or vendor fields merely to satisfy an internal type.

### Streams and repair

The service owns the irreversible commitment decision. Before that boundary a failed attempt may be replaced; afterwards the relay must not splice another model's answer into the committed response. The adapter must not expose irreversible content before the service records commitment. Pin the exact existing wire boundary with fixtures rather than redefining it casually.

Retain backpressure, bounded buffering, disconnect propagation, first-byte/stall/crawl distinctions, and prompt cancellation of losing attempts. A request with streaming enabled must not become a fully buffered response just because orchestration moved.

Keep tool validation and bounded form repair in the pipeline, with the existing destructive-call boundary. A successful reshaper response is not permission to invent intent. Local mapping failures must not be reported as provider health failures.

### Internal callers and projections

Answer-mode dispatch calls RequestService directly through a bounded response-consumer interface. It must not construct a fake HTTP request/response object or make a self-HTTP request just to obtain routing behavior. External HTTP response writers and internal result collectors share the execution decisions, not necessarily their buffers or message representations.

Produce one typed outcome/decision record from which health, usage, headers, logs, and dashboard summaries are derived. Use direct typed calls; a distributed event bus or event-sourcing subsystem is unnecessary. Retain metadata-only logging and unknown/provenance distinctions. A relay-lane dispatch must not count the provider traffic again as separate lane spend.

## 4. DispatchService: daemon-owned jobs, not daemon-owned fragments

### Ownership and lifetime

Move task state, lane selection, concurrency reservations, activity evaluation, failover, cancellation, and result retention into the daemon. MCP and executing CLI commands submit, wait, inspect, and cancel. Preserve genuinely advisory CLI commands as reads; do not turn them into execution implicitly.

A host disconnect only ends that caller's wait. An accepted job continues. Explicit job cancellation is separate from cancelling a protocol request or abandoning a poll. Document this distinction in tool descriptions and test both paths.

Keep the complete task and remaining walk state in daemon memory, bounded for the duration of the job. This allows the whole walk to continue across MCP restarts without introducing full prompt persistence. Release task-bearing memory after completion according to a defined short retention policy.

A daemon restart is different: persisted metadata and completed results remain readable, but unfinished jobs are reported as interrupted/unknown as appropriate, never silently reconstructed or rerun. A durable row alone is not proof that a process exists or that it is safe to resume.

### Job, attempt, and execution identity

Retain three distinct identities:

- **Job:** the caller's request and its final result.
- **Lane attempt:** one selection from the job's ladder.
- **Execution incarnation:** the particular process running that attempt.

Initially an attempt has one incarnation. Additional incarnations are used only when a verified continuation feature actually needs them; do not build unused resumability infrastructure in advance.

Exactly one owner may reserve/start an attempt. Apply lane concurrency across all callers, before asynchronous launch. Preserve current skip/admission behavior unless an explicitly documented product change replaces it; do not add a general queue as a side effect of centralization.

Do not advance to another lane while the previous process tree might still be running. Cancellation requests, confirmed termination, and terminal job outcomes are different states. If termination cannot be established, report stopping/unavailable and retain ownership instead of claiming cancellation succeeded and launching more work. Reuse and strengthen the cross-platform process-boundary tests.

### Submission, retries, and admission

Use an opaque submission key for transport retries. The same key and payload returns the same job; the same key with a different payload is a conflict. Include all execution-relevant options in the private comparison, not only task text. Retain bounded deduplication metadata independently of output pruning and state the retention window. Do not claim indefinite exactly-once execution.

The MCP adapter must not substitute a session-local JSON-RPC request ID for this key. An explicit optional key can support retries across host reconnects; an unknown submission outcome must be reconciled, not blindly resubmitted under a fresh identity.

Use the existing authenticated local control boundary. The daemon resolves configured lane IDs and applies allowed roots, read-only restrictions, depth limits, credential containment, and current admission policy. Caller-supplied commands, environment maps, executable paths, or PIDs are not a broker API.

All clients share one daemon for a canonical installation/configuration state root. Concurrent startup attempts must converge using the existing service lifetime and an OS-backed exclusivity mechanism, not another homegrown stale-lock protocol. A listener alone is insufficient when two different ports address the same state root: reject conflicting ownership. Readiness must verify the expected authenticated daemon, not just an occupied port.

Remove automatic MCP-local execution fallback. Establish/connect to the managed daemon or report unavailable. An explicit standalone execution mode is out of scope unless a real supported workflow requires it; it must reuse DispatchService, not own another walk implementation.

### Configuration during work

Keep the transactional hot-reload behavior. Capture routing configuration for an admitted HTTP request or job so a reload cannot partially rewrite its semantics. Read live health/quota evidence at the existing decision boundaries. Recheck revocation and security admission before new external effects; a captured configuration must not authorize a newly forbidden launch. Document whether an explicit disable affects only new attempts or cancels existing work; do not silently reinterpret it in an adapter.

Public status is a projection of the daemon's authoritative activity and walk verdict. CPU, traffic, output, and working-tree signals remain evidence, not a second decision engine in every frontend. Polling frequency must not determine whether a job progresses, completes, or is archived.

## 5. Storage and durability

### Destination

Use SQLite for operational job state with one normal mutation authority. Prefer explicit SQL and a small repository API over a generic ORM or event store.

The initial logical model is jobs, lane attempts, and execution metadata, with terminal result content attached to the job or a directly related result row. Include schema versioning, foreign keys, unique submission identities, bounded retention, and indexes for the actual status/result queries. Do not migrate configuration, credentials, provider caches, and the complete accounting ledger merely to make all persistence look uniform.

Commit terminal status, final attempt outcome, and bounded result together. There must not be an interval in which the running journal has been cleared but the terminal archive has not committed. Administrative output caps and truncation markers remain explicit. Treat result text and existing bounded task labels as sensitive artifacts, not metadata suitable for tokenless dashboard output.

### What SQLite does not solve

Database transactions do not make process creation transactional. Cover crashes before admission commit, after admission but before spawn, and after spawn but before execution metadata is committed. Record intent before effects, preserve stable identities, and never automatically replay an uncertain launch after daemon death. Do not adopt a PID from disk to close that gap.

Admission persistence failure refuses a new managed job before launch. A result-write failure for an already running job preserves the in-memory result, reports persistence degradation, and uses bounded retry; it must not misreport the underlying work as successful durable recovery. State whether recovery survives process death versus power loss and select the SQLite durability settings accordingly.

Keep transactions short and never hold one across provider, harness, or network work. Bound busy handling and queries. A synchronous driver must not introduce seconds of blocking into cancellation or streaming; use an appropriate asynchronous driver or a small internal database worker when needed. A worker thread is an implementation detail, not a second job owner.

Use a local filesystem. Choose journal mode deliberately; WAL is not a synonym for unlimited writers and adds checkpoint/sidecar handling. SQLite's documentation describes serialized writes and possible busy responses. Backups must be transactionally consistent, including any active WAL state. Protect the database, backups, and sidecars with the installation's restricted-file policy. Disable arbitrary extension loading. [S1, S2]

### Migration and rollback

Perform one controlled ownership/storage cutover, not persistent dual-writing:

1. Stop admissions and drain existing jobs, or require explicit cancellation. Verify old MCP writers and the old daemon are stopped before import. Refuse migration while ownership is uncertain.
2. Locate legacy state through the existing XDG/legacy path rules. Never read an unrelated default directory just because the new one is empty.
3. Preserve a consistent pre-migration backup. Validate legacy records, preserve IDs and terminal outputs, and import in a transaction with an idempotent migration marker. Report malformed rows without silently discarding the original files.
4. Import unresolved old running records as interrupted/unknown evidence, not resumable processes. Keep terminal records authoritative when both legacy stores describe the same completed job.
5. Start the new daemon only after schema/import success. Retire legacy writers; leave backups inert, never as a second live source of truth.
6. Test rollback before release. Rollback requires quiescing the new daemon and restoring the old binary plus its matched state snapshot. Do not promise that an old binary understands the new database. Export/preserve results created since cutover before restoring an older snapshot.

A daemon/schema mismatch or a stale MCP must fail with an actionable upgrade/restart message before launch. An upgrade must not silently strand active work to complete the refactor.

## 6. Dependencies and structural contracts

### Decide replacements before building around the current code

R1 below is a required decision packet, not an open-ended research backlog. Evaluate maintained translation components and complete gateways against the same fixtures. Include the existing implementation as the control, not the presumptive winner. Candidates include the current `llm-bridge`, LiteLLM, and Bifrost; no candidate is declared suitable by this plan.

Assess protocol fidelity, streamed tool cycles, cancellation/backpressure, opaque content, IDs, cache usage, actual configured providers, routing hooks, credentials, accounting provenance, licensing, maintenance, and local installation. Count adapters and compatibility patches required by a dependency as owned code. Treat additional runtime/service installation as an ongoing product cost, not a refactor-size objection.

Select one implementation per responsibility and write down the result in the PR. A gateway is acceptable if it genuinely replaces enough machinery without violating the product contracts. Disable any overlapping retry/routing machinery so exactly one layer owns those decisions. Do not create a second router around a gateway that still routes independently.

If a mature translation solution passes, replace the custom implementation. If none passes, retain only the necessary narrow adapters and record the failed contract; do not replace that evidence with a universal intermediate representation. Positive evidence can change the dependency choice, but unknown external support is not a reason to pause unrelated storage/dispatch work.

### MCP SDK

Adopt the official TypeScript MCP server SDK for framing, initialization, negotiation, standard errors, and notifications. Keep the existing small dispatch tool surface and waiting/progress contract unless a separate explicit change improves it. Do not bundle a switch to MCP Tasks or a different job API into this replacement.

At preparation time the official repository describes v2 as its stable line, with split server/client packages and Standard Schema integration. Prefer the supported server line that passes the real host matrix; verify package versions, supported protocol revisions, Node requirements, and cancellation behavior at implementation time. Do not advertise revisions merely because they are newer. The SDK does not supply llm-relay's job semantics. [S3]

### Schemas

Use one authoritative structural definition per owned boundary contract. Generate or infer TypeScript types and runtime schemas from that definition using maintained tooling; do not hand-maintain an interface, an allowed-key set, and a matching parser.

Prefer reusing Ajv where it is a good fit, including arbitrary tool JSON Schema. Select the schema-authoring approach together with the MCP SDK integration. If an SDK-compatible authoring library generates the JSON Schema used by Ajv, that is one definition with two consumers, not two competing schemas. Do not invent a generic schema-conversion framework just to avoid one dependency.

Keep structural validation separate from normalization and semantic checks. Preserve useful field-specific diagnostics, explicitly supported shorthand, unknown-key rejection where required, and open vendor payloads where fidelity requires them. No silent coercion, dropped properties, or validation-time mutation. Compile/cache validators rather than rebuilding them per request. Exhaustively test discriminated unions; Ajv's TypeScript helpers alone do not prove every union member is represented. [S4]

### Node and package support

The baseline declares `node >=22`. Do not assume that means every `node:sqlite` API is available: the official history records introduction in 22.5 and removal of the experimental flag in 22.13; DatabaseSync is synchronous. Choose a supported runtime floor or a maintained driver explicitly, with clean-install tests. Package selection must not silently raise the minimum Node version or require users to compile a native dependency without a supported installation path. [S5]

## 7. Implementation sequence

Each packet lands working behavior, its tests, and deletion of the obsolete ownership it replaces. A packet is a unit of proof, not a requirement to keep diffs small. Combine adjacent packets when that avoids throwaway compatibility code. Do not merge an unused parallel architecture as progress.

| Packet | Dependencies | Deliverable and exit condition |
|---|---|---|
| **R0 — baseline and urgent correctness** | None | Reconcile main and open PRs; preserve contract fixtures; verify the reported lock race; patch it before relying on the old store during migration if reproduced. Establish a green baseline. |
| **R1 — dependency and boundary decisions** | R0 fixtures | Select translation/gateway approach, MCP SDK, schema tooling, SQLite driver/runtime floor, and journal/durability settings. Complete an executable install/contract comparison. No major rewrite starts around an undecided gateway choice. |
| **R2 — shared request execution** | R1 | Route all HTTP fronts through RequestService. Share lifecycle decisions and outcome recording. Provide the internal answer consumer. Delete both old orchestration loops. |
| **R3 — authoritative job store** | R1 | Implement SQLite repositories, import/rollback tooling, persistence failure behavior, and contract tests. Wire a real consumer in this packet or land it atomically with R4; no inert parallel store. |
| **R4 — whole-job daemon ownership** | R2 and R3 | Move the walk, activity, global lane concurrency, result handling, and cancellation into DispatchService. Answer mode uses RequestService. Complete controlled cutover; delete host journals, adoption, and local execution fallback. |
| **R5 — thin MCP/CLI and shared schemas** | R1 and R4 | Switch MCP to the SDK; keep adapters thin; finish owned boundary-schema consolidation and version compatibility. Delete hand-written MCP framing/negotiation and duplicate structural parsers. |
| **R6 — deletion, release, and documentation** | R2–R5 | Remove dead imports/shims/configuration, update public behavior and installation docs, pass release checks and live host tests, and ship one coherent implementation. |

R2 and the store/import work in R3 can proceed in parallel after R1. Schema work starts in R1 and is used by R2–R4; R5 completes adoption rather than creating schemas after consumers are built. A proven SDK adapter may land with R4 if that avoids a temporary transport layer. There is no quota-dependent prerequisite for offline architectural work.

### R0 details

The earlier conceptual review reported a stale-lock reclamation race in `src/storage/file-lock.ts`: a check of a dead owner and subsequent directory deletion may race with another reclaimer publishing a new owner. This planning change does not independently certify the earlier reproduction or claim the current installation lost data.

Reproduce with the repository implementation in separate processes and deterministic barriers around reclamation; verify Windows and Linux. Do not use arbitrary sleeps as the proof. If the defect is present, land the safety fix and a regression before long-lived refactor work. Preserve the mutual-exclusion property as a store-level test after the custom lock is deleted. Do not spend the refactor polishing a bespoke lock as the final design.

Build a compact matrix of behavior contracts, not snapshots of implementation internals. Label each existing test as protecting a product contract, a confirmed defect, or replaceable structure. Preserve the first two and replace obsolete structural assertions; never treat the old implementation as the correct oracle for a known bug.

## 8. Acceptance tests

### Shared request scenarios

Parameterize the same lifecycle scenarios across Anthropic Messages, OpenAI Chat, OpenAI Responses, streaming/non-streaming where applicable, and the internal answer consumer. Use at least two candidates for failover tests. Verify:

- credential rotation, explicit caps, quota/latency ordering, probation, sticky routing, and unknown limits;
- egress starts, hedged winner/loser outcomes, local versus upstream failures, and accounting exactly once;
- first-byte/stall/crawl timeout, caller abort, backpressure, bounded buffers, pre-commit failover, and post-commit failure without answer splicing;
- complete tool-call/result cycles, form repair, destructive refusal, opaque/vendor fields, usage/cache distinctions, IDs, and explicit unsupported-content errors.

Use fake providers and recorded sanitized fixtures for deterministic tests. Compare decisions across fronts, not only final response text. Do not duplicate live side-effecting requests as a production shadow test.

### Dispatch and process scenarios

Test multiple MCP hosts and executing CLI callers against one daemon. Kill the original MCP before acknowledgement, while a lane runs, between lanes, and after completion. Verify that the same job remains queryable and that the entire walk progresses without polling. Reconnect and cancel from another host.

Verify same-key deduplication, payload conflicts, global concurrency, read-only/allowed-root admission, no arbitrary launch inputs, credential isolation, stale-client rejection, competing daemon starts, and removal of silent local fallback. Test activity evidence becoming unavailable without falsely declaring the lane idle or dead.

Force exit/completion/cancel/timeout races. Do not start the next process until the previous one is confirmed terminated. Exercise real Windows npm shims, hidden-process behavior, process-tree cleanup, and parent-death cases; Linux success is not a substitute.

Kill the daemon separately. Verify honest interrupted/unknown records, accessible committed results, no PID adoption, and no automatic replay of uncertain side effects. Prove that replacement admission cannot create overlapping work from survivors; use the existing OS process-boundary mechanisms or report the unresolved condition instead of inventing liveness from database rows.

### Storage, privacy, and compatibility scenarios

Inject failures around admission and terminal commits, disk full, lock contention, corrupt legacy files, interrupted import, unsupported schema, output pruning, idempotency retention, and rollback. Exercise the maximum supported retained outputs while streaming/cancelling other work to detect event-loop blocking.

Confirm that full prompts, credential values, environment maps, and raw process IDs are not newly persisted. Check permissions on all database-related files and verify result content cannot leak into metadata-only views. Preserve existing historical usage/provenance and state-path selection.

Run fresh global installation and upgrade fixtures on supported operating systems and the selected minimum Node version. Verify existing MCP hosts' initialization, discovery/negotiation, tool schemas, progress, wait limits, request cancellation, explicit job cancellation, and stdout purity. Unavailable live-host or provider checks remain explicitly unverified, not inferred from mocks.

## 9. Deletion map and completion criteria

| Current area | Required end state |
|---|---|
| `src/routes/messages.ts`, `src/routes/openai-front.ts` | Protocol adapters; no private candidate-execution lifecycle |
| `src/candidate-runner.ts`, `src/kernel/` | One adopted lifecycle owner plus focused policy functions; no duplicated finalization |
| `src/mcp/server.ts` | SDK tool wiring, wait/progress adaptation, and presentation only |
| `src/mcp/lane-runner.ts`, `src/lane-execution-broker.ts` | Shared process primitive under daemon-owned DispatchService; execution bookkeeping does not compete with job ownership |
| `src/configured-lane-execution-launcher.ts` and MCP launch path | One configured-lane resolution/normalization path |
| `src/mcp/job-journal.ts`, `src/mcp/job-archive.ts`, `src/mcp/persistence-lock.ts` | Retired runtime writers; only bounded legacy import logic remains while needed |
| `src/storage/file-lock.ts` | Removed once no legitimate consumer remains; migrate every consumer rather than leave an unsafe orphan utility |
| `src/storage/json-store.ts` | Only genuinely appropriate single-owner configuration/cache operations; no bespoke job transaction system |
| `src/mcp/protocol.ts` | Replaced by the SDK; only application-specific conversion remains if required |
| Routing/config/broker structural parsers | Single-source schemas plus explicit semantic validation |
| Translation implementation | One selected implementation per direction; deleted superseded adapters and IR workarounds |

Do not delete a file wholesale when it still contains valid unrelated behavior; relocate that behavior to its actual owner and prove its callers. Conversely, do not keep obsolete code as an undocumented fallback. Temporary migration shims need an explicit removal condition within R6.

Completion requires `npm run gate` on the final tree, the targeted Windows process/persistence suite, the new cross-front/job/storage contract tests, package checks, and documented live-host results. Keep static analysis advisory; enforce a few real dependency boundaries, not another governance framework.

Compare startup, first-response latency, stream memory bounds, cancellation responsiveness, state-write behavior, and package installation against R0. Set explicit regression budgets before implementation from those measurements; do not manufacture target numbers or quietly loosen tests to accommodate a dependency.

Update [architecture.md](architecture.md), [reference.md](reference.md), [QUICKSTART.md](QUICKSTART.md), [the handoff](../HANDOFF.md), and the agent guide when behavior actually changes. Explain managed-daemon dependency, host-versus-daemon restart guarantees, any Node floor change, submission deduplication, persistence failure semantics, and migration/rollback. Keep rationale in this plan and short invariants beside code; do not regenerate a release narrative in every module comment.

The final proof is structural and behavioral: one request lifecycle; one job supervisor; one durable job model; standard protocol/schema machinery; unchanged safety/provenance guarantees; and no second implementation left behind.

## 10. First implementation action and deferred work

**Start with R0 and R1, then implement toward the chosen architecture.** Do not start with directory renames, more helper extraction, or a generic continuation substrate.

The continuation feature remains a separate follow-on after ownership is stable. A harness must pass exact-ID interruption/resume and same-cwd isolation before it can gain automatic continuation. Wire it into the daemon-owned logical attempt with at most one live incarnation; do not build it in the MCP client and later move it.

Vendor-blocked routing, missing AGY envelope evidence, and live operator checks remain separate [backlog](backlog.md) items. They do not block this refactor's offline work, and the refactor does not make their missing evidence disappear.

## Sources and baseline map

Repository links above describe the reviewed baseline or historical rationale, not proof that the target is implemented. Relevant implementation starting points: [request lifecycle](../src/kernel/contracts.ts), [candidate runner](../src/candidate-runner.ts), [MCP server](../src/mcp/server.ts), [execution broker](../src/lane-execution-broker.ts), [running journal](../src/mcp/job-journal.ts), [terminal archive](../src/mcp/job-archive.ts), [file lock](../src/storage/file-lock.ts), [routing parser](../src/config/routing-parser.ts), and [package manifest](../package.json). Update these links as files move.

First-party references checked during plan preparation; select and verify exact dependency versions in R1:

- **S1:** [SQLite transactions](https://sqlite.org/lang_transaction.html) — transaction boundaries, serialized writes, and busy handling.
- **S2:** [SQLite WAL](https://www.sqlite.org/wal.html) — concurrency limits, checkpoints, sidecar files, and filesystem constraints.
- **S3:** [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — supported server SDK, transport, version line, and schema integration.
- **S4:** [Ajv and TypeScript](https://ajv.js.org/guide/typescript.html) — schema/type integration and union limitations.
- **S5:** [Node SQLite documentation](https://nodejs.org/api/sqlite.html) — version history and synchronous database API; consult the selected Node line before using individual methods.
- **S6:** [LiteLLM Anthropic-format endpoint](https://docs.litellm.ai/docs/anthropic_unified) — one candidate's documented surface, not a claim of compatibility with all relay contracts.
