# Review-Approval Gate — approve or disapprove before implementation

Before any code changes, every audit finding is presented below, bucketed by how
much of **your** judgment it needs. This gate exists so that strategic
(design/architecture) findings are never quietly closed without your sight — so
walk the user through them, especially the **Strategic** tier, with the trade-offs
of acting vs. leaving each as-is.

- Total findings: **46**
- Strategic: **22** · Concrete: **23** · Mechanical: **1**

## Strategic — your call — 22 item(s)

Design/architecture or cross-cutting decisions. Genuine tradeoffs only you should make.
### ARC-c9155ca2 — Circuit Breaker Coverage Gap for Mid-Stream Network Resets and SSE Truncation

The proxy contract specifies that circuit breaking must track and cool down unhealthy backends that fail during request execution.

- Severity: high
- Confidence: low
- Lens: architecture
- Files: `src/server.ts`, `src/circuit-breaker.ts`
- Details: The proxy contract specifies that circuit breaking must track and cool down unhealthy backends that fail during request execution. In src/server.ts (openAiFrontPath and transparentPath), HTTP response status classification (classifyStatus) and breaker accounting (recordAttempt) only observe the initial HTTP response status. If a backend returns HTTP 200 OK headers but subsequently truncates the SSE stream or aborts the network connection mid-stream, endMidStreamFailure logs the error but does not report a failure to globalCircuitBreaker.recordOutcome. As a result, backends that systematically drop or abort mid-stream connections are never marked unhealthy or demoted by the circuit breaker, leaving downstream clients exposed to repeating stream failures.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-859ded67 — Credential Resolution Mismatch Between Routing Filter and Upstream Header Construction

The provider credential containment contract requires that resolved env-var aliases (e.g., GEMINI_API_KEY for GOOGLE_API_KEY) are consistently used whenever sending requests upstream.

- Severity: high
- Confidence: low
- Lens: architecture
- Files: `src/backend.ts`, `src/authEnv.ts`, `src/server.ts`
- Details: The provider credential containment contract requires that resolved env-var aliases (e.g., GEMINI_API_KEY for GOOGLE_API_KEY) are consistently used whenever sending requests upstream. In src/authEnv.ts, resolveTargetAuthEnv resolves aliases when evaluating credentialState and active targets in resolveTargets. However, in src/backend.ts (fetchBackend and fetchOpenAiFront), credential lookup directly accesses process.env[target.authEnv] instead of using readCredential(target.authEnv, process.env, target.provider). When a credential exists under an alias rather than the declared name, resolveTargets selects the candidate as valid, but fetchBackend fails to read the key and issues an unauthenticated request upstream. fetchBackend and fetchOpenAiFront should call readCredential to ensure consistent alias resolution across routing and header construction.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-c9155ca2-2 — Monolithic Proxy Architecture Couples Data-Plane Routing with Control-Plane Side Effects

The single-process proxy server (`src/server.ts`, ~1500 LOC) tightly couples core data-plane request forwarding and tool-call repairing with control-plane concerns including active background health probing (`PingLoop`), dynamic configuration file mutations (`offload.ts` mutating `config.json` on disk during request handling), and administrative management APIs (`/dispatch`, `/offload`, `/registry`, `/candidates`).

- Severity: high
- Confidence: low
- Lens: architecture
- Files: `src/server.ts`, `src/offload.ts`, `src/ping/cadence.ts`
- Details: The single-process proxy server (`src/server.ts`, ~1500 LOC) tightly couples core data-plane request forwarding and tool-call repairing with control-plane concerns including active background health probing (`PingLoop`), dynamic configuration file mutations (`offload.ts` mutating `config.json` on disk during request handling), and administrative management APIs (`/dispatch`, `/offload`, `/registry`, `/candidates`). Disk file I/O operations or CPU spikes from Ajv JSON schema validation directly affect event-loop availability for streaming response passthrough. A clean architectural separation should decouple high-throughput data-plane proxying from control-plane persistence and active probing using worker threads or modular boundaries.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-36748f82 — Subagent Directive Parsing Vulnerable to Prompt Injection via Untrusted Message Blocks

The directive parsing contract in readRelayDirective (src/config.ts) guarantees that subagent @relay: routing overrides originate strictly from the dispatcher's prompt rather than tool results or injected file contents.

- Severity: high
- Confidence: low
- Lens: architecture
- Files: `src/config.ts`, `src/server.ts`
- Details: The directive parsing contract in readRelayDirective (src/config.ts) guarantees that subagent @relay: routing overrides originate strictly from the dispatcher's prompt rather than tool results or injected file contents. The implementation iterates backwards through content blocks of messages[0] and only ignores blocks starting with <system-reminder>. If messages[0] contains multiple text blocks—such as ingested repository files or user prompt templates alongside system reminders—an untrusted text block containing @relay: <target> will be matched. This allows untrusted repository content or user input embedded in messages[0] to hijack subagent destination routing and spend arbitrary provider quota. readRelayDirective should be restricted to explicitly designated user text blocks.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-36748f82-2 — Subagent Offload Routing Relies on Unversioned Client-Side Metadata Heuristic

The subagent offload feature (`routing.subagents`) depends on matching the string `cc_is_subagent=true` within the `system` parameter of incoming request payloads.

- Severity: high
- Confidence: low
- Lens: architecture
- Files: `src/config.ts`, `src/server.ts`
- Details: The subagent offload feature (`routing.subagents`) depends on matching the string `cc_is_subagent=true` within the `system` parameter of incoming request payloads. This marker is an internal implementation detail of the Claude Code CLI (v2.1.220) rather than an official, versioned Anthropic API parameter or HTTP header. If a future update to Claude Code modifies, renames, or omits this string, subagent requests will silently fall back to `routing.default` (passthrough to primary Anthropic tiers). This failure is completely silent, creating financial exposure for users who assume subagents are being routed to low-cost or free providers. To fix this structural fragility, the proxy should support configurable subagent detection markers, expose explicit telemetry/logging whenever subagents are identified or missed, and provide diagnostic validation endpoints.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-c9155ca2-3 — Hub module: src/server.ts

src/server.ts has 25 incoming and 39 outgoing dependencies.

- Severity: medium
- Confidence: low
- Lens: architecture
- Files: `src/server.ts`
- Details: src/server.ts has 25 incoming and 39 outgoing dependencies. Hub modules become change bottlenecks and make the dependency graph fragile.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-c9155ca2-4 — Lack of Extensible Middleware Pipeline for Request/Response Interception

Request translation (Anthropic to OpenAI format via `llm-bridge`), SSE stream parsing (`sse.ts`), Ajv tool schema validation (`validator.ts`), repair orchestration (`repair.ts`), and SSE serialization (`emitSse.ts`) are implemented as hardcoded procedural paths inside `src/server.ts`.

- Severity: medium
- Confidence: low
- Lens: architecture
- Files: `src/server.ts`, `src/backend.ts`, `src/repair.ts`
- Details: Request translation (Anthropic to OpenAI format via `llm-bridge`), SSE stream parsing (`sse.ts`), Ajv tool schema validation (`validator.ts`), repair orchestration (`repair.ts`), and SSE serialization (`emitSse.ts`) are implemented as hardcoded procedural paths inside `src/server.ts`. Adding new provider protocols (e.g., native Gemini API or Ollama endpoints) or cross-cutting request logic (such as prompt compression, response caching, or custom security filters) requires modifying central monolith functions. Refactoring the request handling flow into a composable middleware interceptor chain would isolate protocol translations, schema validators, and repair handlers into clean, independently testable units.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-a8bf7dce — Sensitive Credential Leakage Hazard in Failure Diagnostic Safe-Token Filtering

The diagnostic contract in describeFailure (src/key-checker.ts) specifies that error messages logged by llm-relay keys must never expose secret credentials or full error strings, restricting output to classified error identifiers matching /^[A-Za-z][A-Za-z0-9_]{0,39}$/.

- Severity: medium
- Confidence: low
- Lens: architecture
- Files: `src/key-checker.ts`
- Details: The diagnostic contract in describeFailure (src/key-checker.ts) specifies that error messages logged by llm-relay keys must never expose secret credentials or full error strings, restricting output to classified error identifiers matching /^[A-Za-z][A-Za-z0-9_]{0,39}$/. However, describeFailure inspects err?.cause?.code, err?.code, err?.cause?.name, and err?.name. If an error cause or custom error object embeds an API token or key identifier (e.g. sk_live_1234567890abcdef) into its code or name property that happens to fit the 40-character regex pattern, SAFE_TOKEN.test(v) evaluates to true. The raw credential is then echoed verbatim in KeyCheckResult.message, violating the credential containment boundary. describeFailure should match against a closed allowlist of standard Node/fetch error codes rather than arbitrary regex matching on error properties.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-4e8f64b6 — Sequential Multi-Attempt Reshaper Loop Introduces Latency and Cost Amplification Risks

When a backend model produces a malformed tool call, the proxy's repair mechanism (`src/repair.ts`, `src/reshaper.ts`) sequentially queries a secondary reshaper model up to `maxAttempts` times to correct the JSON schema.

- Severity: medium
- Confidence: low
- Lens: architecture
- Files: `src/repair.ts`, `src/reshaper.ts`, `src/emitSse.ts`, `src/server.ts`
- Details: When a backend model produces a malformed tool call, the proxy's repair mechanism (`src/repair.ts`, `src/reshaper.ts`) sequentially queries a secondary reshaper model up to `maxAttempts` times to correct the JSON schema. In streaming mode, initial text blocks are delivered to the client, but tool_use blocks are buffered until validation succeeds. If the reshaper experiences network latency or requires multiple fix attempts, the client encounters noticeable response delays or mid-stream SSE error events. Furthermore, sequential reshaper attempts multiply token usage and costs per invalid turn. The repair loop should enforce strict total latency deadlines, cap reshaper token consumption, and support immediate fail-clean fallbacks when latency thresholds are breached.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-36748f82-4 — Unauthenticated Subagent Status Spoofing via In-Band System Prompt Marker

The subagent routing contract specifies that subagent offload rules apply only to genuine Claude Code subagent requests (cc_is_subagent=true).

- Severity: medium
- Confidence: low
- Lens: architecture
- Files: `src/config.ts`, `src/server.ts`
- Details: The subagent routing contract specifies that subagent offload rules apply only to genuine Claude Code subagent requests (cc_is_subagent=true). In src/config.ts, isSubagentRequest tests whether systemText(reqJson.system).includes("cc_is_subagent=true"). Because any external client sending requests to the proxy can include cc_is_subagent=true within the system parameter of standard API calls, an untrusted caller can spoof subagent status. This forces the proxy to apply routing.subagents rules to main user conversations, redirecting traffic away from primary passthrough models to secondary offload pools without authorization.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-010dd32d — Architectural seam: src/authEnv.ts ↔ test/authEnv.test.ts

The dependency between src/authEnv.ts and test/credential-containment.test.ts is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: low
- Lens: architecture
- Files: `src/authEnv.ts`, `test/authEnv.test.ts`, `test/credential-containment.test.ts`
- Details: The dependency between src/authEnv.ts and test/credential-containment.test.ts is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-859ded67-2 — Architectural seam: src/backend.ts ↔ src/documents.ts

The dependency between src/backend.ts and src/documents.ts is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: low
- Lens: architecture
- Files: `src/backend.ts`, `src/documents.ts`
- Details: The dependency between src/backend.ts and src/documents.ts is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-eaffc6ab-2 — Hidden coupling: package.json ↔ src/config.ts

package.json and test/server.test.ts repeatedly change together (Files changed together in 6 commit(s) (temporal coupling).) but have no import/call/reference edge between them.

- Severity: medium
- Confidence: low
- Lens: architecture
- Files: `package.json`, `src/backend.ts`, `src/config.ts`, `src/server.ts` +1 more
- Details: package.json and test/server.test.ts repeatedly change together (Files changed together in 6 commit(s) (temporal coupling).) but have no import/call/reference edge between them. This hidden coupling is invisible to static dependency analysis — a change to one likely needs a matching change to the other, with nothing in the code to signal it.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-c9155ca2-5 — Hidden coupling: src/server.ts ↔ test/config.test.ts

src/server.ts and test/config.test.ts repeatedly change together (Files changed together in 9 commit(s) (temporal coupling).) but have no import/call/reference edge between them.

- Severity: medium
- Confidence: low
- Lens: architecture
- Files: `src/server.ts`, `test/config.test.ts`
- Details: src/server.ts and test/config.test.ts repeatedly change together (Files changed together in 9 commit(s) (temporal coupling).) but have no import/call/reference edge between them. This hidden coupling is invisible to static dependency analysis — a change to one likely needs a matching change to the other, with nothing in the code to signal it.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-c9155ca2-6 — Unbounded Memory Accumulation During Tool Repair Loops on Event Streams

The server resource management contract sets body size limits (MAX_BODY_BYTES = 10MB, MAX_VALIDATE_BYTES = 8MB) to prevent Node.js memory exhaustion.

- Severity: medium
- Confidence: low
- Lens: architecture
- Files: `src/server.ts`, `src/repair.ts`
- Details: The server resource management contract sets body size limits (MAX_BODY_BYTES = 10MB, MAX_VALIDATE_BYTES = 8MB) to prevent Node.js memory exhaustion. However, when operating in repair mode (src/server.ts and src/repair.ts), stream chunks from upstream SSE responses are buffered into memory during tool validation and reshaper retries. If a rogue or misconfigured backend yields large or infinite SSE event streams during a tool repair attempt, the proxy buffers the full stream payload without enforcing MAX_VALIDATE_BYTES backpressure, causing memory heap exhaustion and proxy process crashes.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-ad223996 — Excessive single-file units

74 of 78 units contain only a single file.

- Severity: low
- Confidence: low
- Lens: architecture
- Files: `test/authEnv.test.ts`, `test/credential-containment.test.ts`, `src/authEnv.ts`, `src/anthropic.ts` +1 more
- Details: 74 of 78 units contain only a single file. This fragmentation may indicate that the unit grouping is too granular to reflect meaningful architectural boundaries.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-859ded67-3 — Behavioral cluster spans declared boundaries: 4 files

These 4 files are tightly coupled by behavior (call/import, co-change, and/or shared state) yet no single declared boundary (directory, doc, or comment grouping) contains most of them (best overlap 25%).

- Severity: low
- Confidence: low
- Lens: architecture
- Files: `src/backend.ts`, `src/documents.ts`, `test/backend.test.ts`, `test/documents.test.ts`
- Details: These 4 files are tightly coupled by behavior (call/import, co-change, and/or shared state) yet no single declared boundary (directory, doc, or comment grouping) contains most of them (best overlap 25%). A coupling cluster no declared purpose owns is accidental complexity or a dead subsystem — a lead for the conceptual charter pass to confirm.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-f687316b — Behavioral cluster spans declared boundaries: 54 files

These 54 files are tightly coupled by behavior (call/import, co-change, and/or shared state) yet no single declared boundary (directory, doc, or comment grouping) contains most of them (best overlap 44%).

- Severity: low
- Confidence: low
- Lens: architecture
- Files: `src/anthropic.ts`, `src/authEnv.ts`, `src/benchmarks.ts`, `src/candidates.ts` +50 more
- Details: These 54 files are tightly coupled by behavior (call/import, co-change, and/or shared state) yet no single declared boundary (directory, doc, or comment grouping) contains most of them (best overlap 44%). A coupling cluster no declared purpose owns is accidental complexity or a dead subsystem — a lead for the conceptual charter pass to confirm.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-6b5169a2 — Declared purpose is behaviorally smeared: 2 files

A doc/comment grouping declares these 2 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 50%).

- Severity: low
- Confidence: low
- Lens: architecture
- Files: `src/catalog.ts`, `src/dotenv.ts`, `src/metadata.ts`, `src/winenv.ts` +2 more
- Details: A doc/comment grouping declares these 2 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 50%). A purpose smeared across the codebase and never modularized is often the highest-value refactor — a lead for the conceptual charter pass.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-859ded67-4 — Declared purpose is behaviorally smeared: 4 files

A doc/comment grouping declares these 4 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 25%).

- Severity: low
- Confidence: low
- Lens: architecture
- Files: `src/backend.ts`, `src/dotenv.ts`, `src/server.ts`, `test/pool-failover.test.ts`
- Details: A doc/comment grouping declares these 4 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 25%). A purpose smeared across the codebase and never modularized is often the highest-value refactor — a lead for the conceptual charter pass.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-b4f75d6f — Declared purpose is behaviorally smeared: 49 files

A doc/comment grouping declares these 49 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 49%).

- Severity: low
- Confidence: low
- Lens: architecture
- Files: `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, `package.json`, `scripts/agentic-loop-probe.mjs` +50 more
- Details: A doc/comment grouping declares these 49 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 49%). A purpose smeared across the codebase and never modularized is often the highest-value refactor — a lead for the conceptual charter pass.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### ARC-6a02bffc-3 — Declared purpose is behaviorally smeared: 8 files

A doc/comment grouping declares these 8 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 38%).

- Severity: low
- Confidence: low
- Lens: architecture
- Files: `src/cli.ts`, `src/dispatch.ts`, `src/pool-health.ts`, `src/self-update.ts` +4 more
- Details: A doc/comment grouping declares these 8 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 38%). A purpose smeared across the codebase and never modularized is often the highest-value refactor — a lead for the conceptual charter pass.
- Why this tier: Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.
- Implementation cost (blast radius): `high`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

## Concrete — some latitude — 23 item(s)

Real fixes with a clear-ish path but a design choice worth a yes/no.
### COR-c9155ca2 — OpenAI front failover loop continues on client disconnect due to checking writableEnded instead of destroyed

In openAiFrontPath, when a candidate request aborts because the client disconnected, the catch block evaluates `if (!isLast && !res.writableEnded) continue;`.

- Severity: high
- Confidence: high
- Lens: correctness
- Files: `src/server.ts`
- Details: In openAiFrontPath, when a candidate request aborts because the client disconnected, the catch block evaluates `if (!isLast && !res.writableEnded) continue;`. Since res.writableEnded remains false when a client socket is destroyed without res.end(), !res.writableEnded evaluates to true, causing the loop to failover and issue HTTP requests to all remaining candidates against a closed socket.
- Why this tier: High-impact but bounded fix — the path is clear, but its severity warrants a confirmation before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### COR-a0dab0ad — Unconfigured namespaced provider specs silently fall back to default routing instead of throwing RoutingError

In pickSpecs(), line 355 checks if the provider prefix of a namespaced model spec (e.g.

- Severity: high
- Confidence: high
- Lens: correctness
- Files: `src/config.ts`
- Details: In pickSpecs(), line 355 checks if the provider prefix of a namespaced model spec (e.g. unknown-provider/model) exists in cfg.providers. When the provider is not configured, line 355 evaluates to false and pickSpecs falls through to Claude tier matching or routing.default, causing requests for unconfigured providers to silently succeed against fallback backends rather than returning a 400 RoutingError.
- Why this tier: High-impact but bounded fix — the path is clear, but its severity warrants a confirmation before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### REL-b45d964b — Unhandled backpressure drain wait causes indefinite hanging promise on client disconnect

In writeChunk, when backpressure occurs and res.write returns false, the code awaits once(res, 'drain').

- Severity: high
- Confidence: high
- Lens: reliability
- Files: `src/server.ts`
- Details: In writeChunk, when backpressure occurs and res.write returns false, the code awaits once(res, 'drain'). If the client disconnects or the response closes before drain is emitted, drain will never fire and the promise will hang indefinitely, leaking closure state and hanging stream handlers.
- Why this tier: High-impact but bounded fix — the path is clear, but its severity warrants a confirmation before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### COR-79c2a509 — classifyCommand classifies help and version flags as mutating operations, triggering unwanted update checks

In classifyCommand(), any sub argument starting with '-' (including --help, -h, --version, -v) returns 'mutating'.

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: `src/cli.ts`
- Details: In classifyCommand(), any sub argument starting with '-' (including --help, -h, --version, -v) returns 'mutating'. This causes shouldCheckUpdates() to execute self-update checks and re-exec installers before simply printing help or version information.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### COR-198fbd46 — SHELL_SAFE regex allows backslashes to remain unquoted when rendering arguments for POSIX shell

In cli.ts, SHELL_SAFE includes the backslash character '\\'.

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: `src/cli.ts`
- Details: In cli.ts, SHELL_SAFE includes the backslash character '\\'. As a result, quoteArg(arg, "sh") treats strings with backslashes as safe and leaves them unquoted, which causes POSIX shells to interpret the backslashes as escape characters and mangle file paths or command arguments.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### COR-c9155ca2-2 — Single reshaper candidate is ignored when cfg.reshaper is undefined

When initializing explicitReshaper in createProxy, the expression requires cfg.reshaperCandidates.length > 1.

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: `src/server.ts`
- Details: When initializing explicitReshaper in createProxy, the expression requires cfg.reshaperCandidates.length > 1. If cfg.reshaperCandidates is configured with a single item and cfg.reshaper is undefined, explicitReshaper evaluates to undefined, silently bypassing candidate reshaper selection.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### REL-b46ebdda — Unconsumed backend response stream leaked during candidate failover

When candidate targets fail with a retryable or credential error in handle(), the loop fails over to the next candidate without cancelling or reading backendRes.body.

- Severity: medium
- Confidence: high
- Lens: reliability
- Files: `src/server.ts`
- Details: When candidate targets fail with a retryable or credential error in handle(), the loop fails over to the next candidate without cancelling or reading backendRes.body. The unconsumed fetch response stream keeps the underlying network socket open in the connection pool, leading to socket leaks and connection pool exhaustion under failover conditions.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-010dd32d — High complexity: src/authEnv.ts

src/authEnv.ts has a cyclomatic-approx of 41 (reach: js-ts-effective).

- Severity: medium
- Confidence: low
- Lens: maintainability
- Files: `src/authEnv.ts`
- Details: src/authEnv.ts has a cyclomatic-approx of 41 (reach: js-ts-effective). High structural complexity is hard to test and change safely.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-859ded67 — High complexity: src/backend.ts

src/backend.ts has a cyclomatic-approx of 93 (reach: js-ts-effective).

- Severity: medium
- Confidence: low
- Lens: maintainability
- Files: `src/backend.ts`
- Details: src/backend.ts has a cyclomatic-approx of 93 (reach: js-ts-effective). High structural complexity is hard to test and change safely.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-69cc0882 — High complexity: src/dispatch.ts

src/dispatch.ts has a cyclomatic-approx of 79 (reach: js-ts-effective).

- Severity: medium
- Confidence: low
- Lens: maintainability
- Files: `src/dispatch.ts`
- Details: src/dispatch.ts has a cyclomatic-approx of 79 (reach: js-ts-effective). High structural complexity is hard to test and change safely.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-a8bf7dce — High complexity: src/key-checker.ts

src/key-checker.ts has a duplicate-line-count of 51 (reach: js-ts-effective).

- Severity: medium
- Confidence: low
- Lens: maintainability
- Files: `src/key-checker.ts`
- Details: src/key-checker.ts has a duplicate-line-count of 51 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-bf2ef126 — High complexity: src/reshaper.ts

src/reshaper.ts has a cyclomatic-approx of 52 (reach: js-ts-effective).

- Severity: medium
- Confidence: low
- Lens: maintainability
- Files: `src/reshaper.ts`
- Details: src/reshaper.ts has a cyclomatic-approx of 52 (reach: js-ts-effective). High structural complexity is hard to test and change safely.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-c9155ca2 — High complexity: src/server.ts

src/server.ts has a cyclomatic-approx of 397 (reach: js-ts-effective).

- Severity: medium
- Confidence: low
- Lens: maintainability
- Files: `src/server.ts`
- Details: src/server.ts has a cyclomatic-approx of 397 (reach: js-ts-effective). High structural complexity is hard to test and change safely.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-dd4663e3 — High complexity: test/cli.test.ts

test/cli.test.ts has a cyclomatic-approx of 18 (reach: js-ts-effective).

- Severity: medium
- Confidence: low
- Lens: maintainability
- Files: `test/cli.test.ts`
- Details: test/cli.test.ts has a cyclomatic-approx of 18 (reach: js-ts-effective). High structural complexity is hard to test and change safely.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-010dd32d-2 — Duplicated code: src/authEnv.ts

src/authEnv.ts has a duplicate-line-count of 16 (reach: js-ts-effective).

- Severity: low
- Confidence: low
- Lens: maintainability
- Files: `src/authEnv.ts`
- Details: src/authEnv.ts has a duplicate-line-count of 16 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-859ded67-2 — Duplicated code: src/backend.ts

src/backend.ts has a duplicate-line-count of 28 (reach: js-ts-effective).

- Severity: low
- Confidence: low
- Lens: maintainability
- Files: `src/backend.ts`
- Details: src/backend.ts has a duplicate-line-count of 28 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-69cc0882-2 — Duplicated code: src/dispatch.ts

src/dispatch.ts has a duplicate-line-count of 25 (reach: js-ts-effective).

- Severity: low
- Confidence: low
- Lens: maintainability
- Files: `src/dispatch.ts`
- Details: src/dispatch.ts has a duplicate-line-count of 25 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-bf2ef126-2 — Duplicated code: src/reshaper.ts

src/reshaper.ts has a duplicate-line-count of 15 (reach: js-ts-effective).

- Severity: low
- Confidence: low
- Lens: maintainability
- Files: `src/reshaper.ts`
- Details: src/reshaper.ts has a duplicate-line-count of 15 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-c9155ca2-2 — Duplicated code: src/server.ts

src/server.ts has a duplicate-line-count of 259 (reach: js-ts-effective).

- Severity: low
- Confidence: low
- Lens: maintainability
- Files: `src/server.ts`
- Details: src/server.ts has a duplicate-line-count of 259 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-ad223996 — Duplicated code: test/authEnv.test.ts

test/authEnv.test.ts has a duplicate-line-count of 14 (reach: js-ts-effective).

- Severity: low
- Confidence: low
- Lens: maintainability
- Files: `test/authEnv.test.ts`
- Details: test/authEnv.test.ts has a duplicate-line-count of 14 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-37ed1b2a — Duplicated code: test/cli-update-gate.test.ts

test/cli-update-gate.test.ts has a duplicate-line-count of 7 (reach: js-ts-effective).

- Severity: low
- Confidence: low
- Lens: maintainability
- Files: `test/cli-update-gate.test.ts`
- Details: test/cli-update-gate.test.ts has a duplicate-line-count of 7 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-dd4663e3-2 — Duplicated code: test/cli.test.ts

test/cli.test.ts has a duplicate-line-count of 58 (reach: js-ts-effective).

- Severity: low
- Confidence: low
- Lens: maintainability
- Files: `test/cli.test.ts`
- Details: test/cli.test.ts has a duplicate-line-count of 58 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

### MNT-e6b97b7b — Duplicated code: test/credential-containment.test.ts

test/credential-containment.test.ts has a duplicate-line-count of 18 (reach: js-ts-effective).

- Severity: low
- Confidence: low
- Lens: maintainability
- Files: `test/credential-containment.test.ts`
- Details: test/credential-containment.test.ts has a duplicate-line-count of 18 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Why this tier: Concrete fix with some design latitude — worth a quick yes/no before acting.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

## Mechanical — FYI — 1 item(s)

Obvious, low-risk, high-confidence cleanups; minimal review.
### COR-f6711540 — runDispatch positional lane argument is ignored when CLI flags precede the lane name

In main() and runDispatch(), arg3 (process.argv[3]) is assumed to be the positional lane name.

- Severity: low
- Confidence: high
- Lens: correctness
- Files: `src/cli.ts`
- Details: In main() and runDispatch(), arg3 (process.argv[3]) is assumed to be the positional lane name. If flags like --task precede the lane name, arg3 starts with '-' and runDispatch falls back to argValue('--lane'), causing positional lane arguments specified after options to be ignored.
- Why this tier: Low-severity, high-confidence finding — a rote/mechanical fix needing little review.
- Implementation cost (blast radius): `low`
- **Present to the user with the pros/cons of acting vs. not acting, then record their decision.**

---

## Record the user's decision

The default is to **proceed with every finding**. You only need to record the
items the user wants to **disapprove** (skip). Write JSON to exactly:

`C:\Code\llm-relay\.audit-tools\remediation\review_resolution.json`

```json
{
  "disapproved_findings": ["FINDING-ID-the-user-declined"],
  "disapproved_tiers": []
}
```

- Leave `disapproved_findings` empty (`[]`) to approve everything.
- Use `disapproved_tiers` (e.g. `["mechanical"]`) to decline an entire tier at once.
- Disapproved findings are recorded as a declined disposition with a reason —
  they are not acted on, and they are not silently dropped.

Then run `remediate-code next-step`.
