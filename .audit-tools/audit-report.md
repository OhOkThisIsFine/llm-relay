<!-- audit-tools/audit-report/v1 -->
# Audit Report

## Executive Summary

The audit of llm-relay identified key architectural and operational areas for improvement across proxy resiliency, credential containment, and server modularity. While core request translation and basic routing functions operate as intended, mid-stream network resets and unhandled socket disconnects present circuit-breaker and memory leak hazards. Refactoring credential lookups, prompt-directive parsing, and monolithic server paths into modular middleware will significantly improve security, stability, and maintainability.

## Summary

- Findings: 173
- Work blocks: 3
- Severity breakdown: high: 8, medium: 95, low: 70
- Lens breakdown: architecture: 42, correctness: 6, maintainability: 123, reliability: 2
- Grounding (S7): grounded: 20
- Fully audited files: 1
- Excluded non-auditable files: 31

## Top Risks

- Unclassified mid-stream network drops and SSE truncations bypass the circuit breaker, leaving downstream clients vulnerable to repeating failure loops.
- Credential lookup mismatches between candidate selection (resolveTargets) and request execution (fetchBackend) cause unauthenticated upstream requests when environment aliases are used.
- Untrusted prompt content containing @relay directives or system prompt markers can hijack subagent routing and cause quota depletion.
- Monolithic coupling of data-plane forwarding with disk I/O, schema validation, and active background probing creates event-loop bottlenecks.

## Themes

### T-001 — Proxy Error Handling and Resiliency Boundary Gaps

- Root cause: The proxy server does not properly classify mid-stream drops, connection disconnects, or stream backpressure, leading to circuit breaker bypasses and hanging promises.
- Findings: ARC-c9155ca2, COR-c9155ca2, REL-b45d964b, REL-b46ebdda, ARC-4e8f64b6, ARC-c9155ca2-6
- Suggested fix pattern: Unify stream lifecycle handlers, enforce explicit response status / socket destruction checks, and integrate mid-stream errors into the global circuit breaker and repair timeout thresholds.

### T-002 — Credential Resolution and Trust Boundary Security Inconsistencies

- Root cause: Inconsistent env-var alias reading between routing and fetch layers, alongside unvalidated in-band system prompt heuristics and regex diagnostic matching, introduces security and credential containment risks.
- Findings: ARC-859ded67, ARC-36748f82, ARC-36748f82-2, COR-a0dab0ad, ARC-a8bf7dce, ARC-36748f82-4
- Suggested fix pattern: Standardize credential lookups via readCredential, validate subagent directives strictly from trusted prompt blocks, and enforce allowlist filtering on diagnostic error logging.

### T-003 — Monolithic Server Architecture and Control/Data Plane Coupling

- Root cause: src/server.ts acts as an oversized hub module coupling high-throughput HTTP proxy routing with active background health pinging, CLI management APIs, and synchronous external tool invocation.
- Findings: ARC-c9155ca2-2, ARC-b4f74d64, ARC-c9155ca2-3, ARC-c9155ca2-4, ARC-38bd017c
- Suggested fix pattern: Decouple control-plane management APIs and active ping loops from data-plane proxying using a modular middleware chain and native document transcoding.

## Work Blocks

### block-1

- Max severity: high
- Units: -github-workflows, root-config, scripts, src-anthropic-ts, src-authEnv-ts, src-backend-ts, src-benchmarks-ts, src-candidates-ts, src-catalog-ts, src-circuit-breaker-ts, src-cli-ts, src-config-ts, src-dispatch-ts, src-documents-ts, src-dotenv-ts, src-emitSse-ts, src-key-checker-ts, src-log-ts, src-metadata-ts, src-offload-ts, src-onboarding-ts, src-ping, src-pool-health-ts, src-presets-ts, src-registry-ts, src-repair-ts, src-reshaper-ts, src-self-update-ts, src-server-ts, src-setup-claude-ts, src-sse-ts, src-telemetry-ts, src-tier-data-ts, src-validator-ts, src-winenv-ts, test-vitest-config-ts, tests-authEnv-test-ts, tests-backend-test-ts, tests-benchmarks-test-ts, tests-breaker-measurement-test-ts, tests-circuit-breaker-test-ts, tests-cli-test-ts, tests-cli-update-gate-test-ts, tests-config-test-ts, tests-credential-containment-test-ts, tests-degraded-config-test-ts, tests-destructive-coverage-test-ts, tests-dispatch-test-ts, tests-documents-test-ts, tests-dotenv-test-ts, tests-emitSse-test-ts, tests-health-persistence-test-ts, tests-install-skill-test-ts, tests-key-checker-test-ts, tests-log-test-ts, tests-loopback-admission-test-ts, tests-metadata-test-ts, tests-mid-stream-failure-test-ts, tests-offload-test-ts, tests-onboarding-test-ts, tests-openai-front-test-ts, tests-ping-test-ts, tests-pool-failover-test-ts, tests-presets-test-ts, tests-registry-test-ts, tests-repair-test-ts, tests-reshaper-test-ts, tests-self-update-security-test-ts, tests-self-update-test-ts, tests-server-safety-test-ts, tests-server-test-ts, tests-setup-claude-test-ts, tests-sse-test-ts, tests-telemetry-test-ts, tests-validator-test-ts, tests-winenv-test-ts
- Owned files: .github/workflows/ci.yml, .github/workflows/publish.yml, config.example.json, package.json, scripts/agentic-loop-probe.mjs, scripts/claude-proxied.ps1, scripts/claude-proxied.sh, scripts/install-skill.mjs, scripts/live-demo.mjs, scripts/multimodal-probe.mjs, scripts/nim-front.mjs, scripts/nim-probe.mjs, scripts/nim-repair.mjs, scripts/nim-trip-rate.mjs, scripts/sync-tiers.mjs, scripts/verify-live-features.mjs, src/anthropic.ts, src/authEnv.ts, src/backend.ts, src/benchmarks.ts, src/candidates.ts, src/catalog.ts, src/circuit-breaker.ts, src/cli.ts, src/config.ts, src/dispatch.ts, src/documents.ts, src/dotenv.ts, src/emitSse.ts, src/key-checker.ts, src/log.ts, src/metadata.ts, src/offload.ts, src/onboarding.ts, src/ping/cadence.ts, src/ping/metrics.ts, src/ping/ping.ts, src/ping/probe-cache.ts, src/ping/quota.ts, src/ping/runtime-telemetry.ts, src/pool-health.ts, src/presets.ts, src/registry.ts, src/repair.ts, src/reshaper.ts, src/self-update.ts, src/server.ts, src/setup-claude.ts, src/sse.ts, src/telemetry.ts, src/tier-data.ts, src/validator.ts, src/winenv.ts, test/authEnv.test.ts, test/backend.test.ts, test/benchmarks.test.ts, test/breaker-measurement.test.ts, test/circuit-breaker.test.ts, test/cli-update-gate.test.ts, test/cli.test.ts, test/config.test.ts, test/credential-containment.test.ts, test/degraded-config.test.ts, test/destructive-coverage.test.ts, test/dispatch.test.ts, test/documents.test.ts, test/dotenv.test.ts, test/emitSse.test.ts, test/health-persistence.test.ts, test/install-skill.test.ts, test/key-checker.test.ts, test/log.test.ts, test/loopback-admission.test.ts, test/metadata.test.ts, test/mid-stream-failure.test.ts, test/offload.test.ts, test/onboarding.test.ts, test/openai-front.test.ts, test/ping.test.ts, test/pool-failover.test.ts, test/presets.test.ts, test/registry.test.ts, test/repair.test.ts, test/reshaper.test.ts, test/self-update-security.test.ts, test/self-update.test.ts, test/server-safety.test.ts, test/server.test.ts, test/setup-claude.test.ts, test/sse.test.ts, test/telemetry.test.ts, test/validator.test.ts, test/winenv.test.ts, tsconfig.json, tsconfig.test.json, vitest.config.ts
- Findings: ARC-36748f82, ARC-36748f82-2, ARC-859ded67, ARC-c9155ca2, ARC-c9155ca2-2, COR-a0dab0ad, COR-c9155ca2, REL-b45d964b, ARC-010dd32d, ARC-15fb5ae5, ARC-3647024e, ARC-36748f82-3, ARC-36748f82-4, ARC-36748f82-5, ARC-38bd017c, ARC-38bd017c-2, ARC-44561783, ARC-4e8f64b6, ARC-61266d6a, ARC-6a02bffc, ARC-6a02bffc-2, ARC-859ded67-2, ARC-9e7df287, ARC-a262deff, ARC-a2c197c9, ARC-a8bf7dce, ARC-ae301e8f, ARC-b3098837, ARC-b4f74d64, ARC-c9155ca2-3, ARC-c9155ca2-4, ARC-c9155ca2-5, ARC-c9155ca2-6, ARC-eaffc6ab, ARC-eaffc6ab-2, ARC-ec623c00, ARC-f544e594, COR-198fbd46, COR-79c2a509, COR-c9155ca2-2, MNT-010dd32d, MNT-03521734, MNT-113524c4, MNT-12e1a02f, MNT-130e6e13, MNT-199a44e6, MNT-1d9e0c5c, MNT-31833353, MNT-323afca3, MNT-3647024e, MNT-36748f82, MNT-386dcba9, MNT-38bd017c, MNT-44561783, MNT-46dbc1fc, MNT-4c2123f8, MNT-4d706fce, MNT-4e8f64b6, MNT-536005e8, MNT-5464c91e, MNT-61266d6a, MNT-69cc0882, MNT-6a02bffc, MNT-6b5169a2, MNT-6f7e84e8, MNT-6fd6b6ee, MNT-777aa7de, MNT-78887177, MNT-85551ee4, MNT-859ded67, MNT-8823bcf0, MNT-8a5c83cd, MNT-902ad999, MNT-9df7093f, MNT-a1f775ab, MNT-a262deff, MNT-a8bf7dce, MNT-ae301e8f, MNT-b2bc6313, MNT-b3098837, MNT-b335bed1, MNT-b4f74d64, MNT-bd785cec, MNT-bf2ef126, MNT-bfd9ca72, MNT-c0e29c12, MNT-c9155ca2, MNT-cfde1f58, MNT-d0c1f72f, MNT-d24c3cc6, MNT-d29b7d7f, MNT-d2f6093b, MNT-d758e799, MNT-dd4663e3, MNT-dd618912, MNT-e4504943, MNT-e82197af, MNT-eb0e6f3f, MNT-eb4269f2, MNT-f544e594, MNT-f687316b, MNT-f84903a0, REL-b46ebdda, ARC-6a02bffc-3, ARC-6b5169a2, ARC-6fa9de59, ARC-859ded67-3, ARC-859ded67-4, ARC-ad223996, ARC-b4f75d6f, ARC-f687316b, COR-f6711540, MNT-00ba6264, MNT-010dd32d-2, MNT-04bf6960, MNT-113524c4-2, MNT-14d1d1d2, MNT-199a44e6-2, MNT-1d9e0c5c-2, MNT-26070e6d, MNT-31833353-2, MNT-36748f82-2, MNT-37ed1b2a, MNT-38bd017c-2, MNT-3c60bc77, MNT-3ef82d26, MNT-48c91372, MNT-4c2123f8-2, MNT-4e8f64b6-2, MNT-536005e8-2, MNT-5464c91e-2, MNT-55fde5ba, MNT-5c9a4e45, MNT-61266d6a-2, MNT-656e2310, MNT-658abff9, MNT-69cc0882-2, MNT-6a02bffc-2, MNT-6b5169a2-2, MNT-6fd6b6ee-2, MNT-7198190b, MNT-765dec40, MNT-777aa7de-2, MNT-78887177-2, MNT-7fa41ae0, MNT-840289e0, MNT-85551ee4-2, MNT-859ded67-2, MNT-8a5c83cd-2, MNT-902ad999-2, MNT-907b137d, MNT-9db5483d, MNT-9e7df287, MNT-9ecffe1f, MNT-9fa55b47, MNT-a1f775ab-2, MNT-ad223996, MNT-bd785cec-2, MNT-bf2ef126-2, MNT-c9155ca2-2, MNT-cfde1f58-2, MNT-d24c3cc6-2, MNT-dd4663e3-2, MNT-dd618912-2, MNT-e6b97b7b, MNT-ea6add59, MNT-eb4269f2-2, MNT-f0ef5d11, MNT-f544e594-2, MNT-f687316b-2, MNT-f84903a0-2
- Depends on: none
- Rationale: Findings share owned units transitively and should remain one non-overlapping remediation block.

### block-2

- Max severity: low
- Units: tests-catalog-test-ts
- Owned files: test/catalog.test.ts
- Findings: MNT-0d49abaa
- Depends on: block-1
- Rationale: All findings map to the same owned unit and should be remediated together.

### block-3

- Max severity: low
- Units: tests-pool-health-test-ts
- Owned files: test/pool-health.test.ts
- Findings: MNT-ec0134c0
- Depends on: block-1
- Rationale: All findings map to the same owned unit and should be remediated together.

## Findings

### ARC-c9155ca2 — Circuit Breaker Coverage Gap for Mid-Stream Network Resets and SSE Truncation

The proxy contract specifies that circuit breaking must track and cool down unhealthy backends that fail during request execution.

- Severity: high
- Confidence: high
- Lens: architecture
- Grounding: grounded
- Systemic: yes
- Files: `src/server.ts`, `src/circuit-breaker.ts`
- Details: The proxy contract specifies that circuit breaking must track and cool down unhealthy backends that fail during request execution. In src/server.ts (openAiFrontPath and transparentPath), HTTP response status classification (classifyStatus) and breaker accounting (recordAttempt) only observe the initial HTTP response status. If a backend returns HTTP 200 OK headers but subsequently truncates the SSE stream or aborts the network connection mid-stream, endMidStreamFailure logs the error but does not report a failure to globalCircuitBreaker.recordOutcome. As a result, backends that systematically drop or abort mid-stream connections are never marked unhealthy or demoted by the circuit breaker, leaving downstream clients exposed to repeating stream failures.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### ARC-859ded67 — Credential Resolution Mismatch Between Routing Filter and Upstream Header Construction

The provider credential containment contract requires that resolved env-var aliases (e.g., GEMINI_API_KEY for GOOGLE_API_KEY) are consistently used whenever sending requests upstream.

- Severity: high
- Confidence: high
- Lens: architecture
- Grounding: grounded
- Systemic: yes
- Files: `src/backend.ts`, `src/authEnv.ts`, `src/server.ts`
- Details: The provider credential containment contract requires that resolved env-var aliases (e.g., GEMINI_API_KEY for GOOGLE_API_KEY) are consistently used whenever sending requests upstream. In src/authEnv.ts, resolveTargetAuthEnv resolves aliases when evaluating credentialState and active targets in resolveTargets. However, in src/backend.ts (fetchBackend and fetchOpenAiFront), credential lookup directly accesses process.env[target.authEnv] instead of using readCredential(target.authEnv, process.env, target.provider). When a credential exists under an alias rather than the declared name, resolveTargets selects the candidate as valid, but fetchBackend fails to read the key and issues an unauthenticated request upstream. fetchBackend and fetchOpenAiFront should call readCredential to ensure consistent alias resolution across routing and header construction.
- Evidence: 3 items (top: "runtime:flow:flow:host:auth-key-management: confirmed — Deterministic runtime command succeeded: npm test") — see audit-findings.json for the full list

### ARC-c9155ca2-2 — Monolithic Proxy Architecture Couples Data-Plane Routing with Control-Plane Side Effects

The single-process proxy server (`src/server.ts`, ~1500 LOC) tightly couples core data-plane request forwarding and tool-call repairing with control-plane concerns including active background health probing (`PingLoop`), dynamic configuration file mutations (`offload.ts` mutating `config.json` on disk during request handling), and administrative management APIs (`/dispatch`, `/offload`, `/registry`, `/candidates`).

- Severity: high
- Confidence: high
- Lens: architecture
- Grounding: grounded
- Systemic: yes
- Files: `src/server.ts`, `src/offload.ts`, `src/ping/cadence.ts`
- Details: The single-process proxy server (`src/server.ts`, ~1500 LOC) tightly couples core data-plane request forwarding and tool-call repairing with control-plane concerns including active background health probing (`PingLoop`), dynamic configuration file mutations (`offload.ts` mutating `config.json` on disk during request handling), and administrative management APIs (`/dispatch`, `/offload`, `/registry`, `/candidates`). Disk file I/O operations or CPU spikes from Ajv JSON schema validation directly affect event-loop availability for streaming response passthrough. A clean architectural separation should decouple high-throughput data-plane proxying from control-plane persistence and active probing using worker threads or modular boundaries.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### COR-c9155ca2 — OpenAI front failover loop continues on client disconnect due to checking writableEnded instead of destroyed

In openAiFrontPath, when a candidate request aborts because the client disconnected, the catch block evaluates `if (!isLast && !res.writableEnded) continue;`.

- Severity: high
- Confidence: high
- Lens: correctness
- Grounding: grounded
- Files: `src/server.ts:714`
- Details: In openAiFrontPath, when a candidate request aborts because the client disconnected, the catch block evaluates `if (!isLast && !res.writableEnded) continue;`. Since res.writableEnded remains false when a client socket is destroyed without res.end(), !res.writableEnded evaluates to true, causing the loop to failover and issue HTTP requests to all remaining candidates against a closed socket.
- Evidence: 2 items (top: "src/server.ts:714 - 'if (!isLast && !res.writableEnded) continue;' evaluates to true on client disconnect because res.writableEnded is false when destroyed.") — see audit-findings.json for the full list

### ARC-36748f82 — Subagent Directive Parsing Vulnerable to Prompt Injection via Untrusted Message Blocks

The directive parsing contract in readRelayDirective (src/config.ts) guarantees that subagent @relay: routing overrides originate strictly from the dispatcher's prompt rather than tool results or injected file contents.

- Severity: high
- Confidence: high
- Lens: architecture
- Grounding: grounded
- Systemic: yes
- Files: `src/config.ts`, `src/server.ts`
- Details: The directive parsing contract in readRelayDirective (src/config.ts) guarantees that subagent @relay: routing overrides originate strictly from the dispatcher's prompt rather than tool results or injected file contents. The implementation iterates backwards through content blocks of messages[0] and only ignores blocks starting with <system-reminder>. If messages[0] contains multiple text blocks—such as ingested repository files or user prompt templates alongside system reminders—an untrusted text block containing @relay: <target> will be matched. This allows untrusted repository content or user input embedded in messages[0] to hijack subagent destination routing and spend arbitrary provider quota. readRelayDirective should be restricted to explicitly designated user text blocks.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### ARC-36748f82-2 — Subagent Offload Routing Relies on Unversioned Client-Side Metadata Heuristic

The subagent offload feature (`routing.subagents`) depends on matching the string `cc_is_subagent=true` within the `system` parameter of incoming request payloads.

- Severity: high
- Confidence: high
- Lens: architecture
- Grounding: grounded
- Systemic: yes
- Files: `src/config.ts`, `src/server.ts`
- Details: The subagent offload feature (`routing.subagents`) depends on matching the string `cc_is_subagent=true` within the `system` parameter of incoming request payloads. This marker is an internal implementation detail of the Claude Code CLI (v2.1.220) rather than an official, versioned Anthropic API parameter or HTTP header. If a future update to Claude Code modifies, renames, or omits this string, subagent requests will silently fall back to `routing.default` (passthrough to primary Anthropic tiers). This failure is completely silent, creating financial exposure for users who assume subagents are being routed to low-cost or free providers. To fix this structural fragility, the proxy should support configurable subagent detection markers, expose explicit telemetry/logging whenever subagents are identified or missed, and provide diagnostic validation endpoints.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### COR-a0dab0ad — Unconfigured namespaced provider specs silently fall back to default routing instead of throwing RoutingError

In pickSpecs(), line 355 checks if the provider prefix of a namespaced model spec (e.g.

- Severity: high
- Confidence: high
- Lens: correctness
- Grounding: grounded
- Files: `src/config.ts:348–363`
- Details: In pickSpecs(), line 355 checks if the provider prefix of a namespaced model spec (e.g. unknown-provider/model) exists in cfg.providers. When the provider is not configured, line 355 evaluates to false and pickSpecs falls through to Claude tier matching or routing.default, causing requests for unconfigured providers to silently succeed against fallback backends rather than returning a 400 RoutingError.
- Evidence: src/config.ts:355 - pickSpecs filters out namespaced model specs whose provider is not in cfg.providers, preventing resolveSingleSpec from throwing RoutingError for unknown providers.

### REL-b45d964b — Unhandled backpressure drain wait causes indefinite hanging promise on client disconnect

In writeChunk, when backpressure occurs and res.write returns false, the code awaits once(res, 'drain').

- Severity: high
- Confidence: high
- Lens: reliability
- Grounding: grounded
- Files: `src/server.ts:1394–1397`
- Details: In writeChunk, when backpressure occurs and res.write returns false, the code awaits once(res, 'drain'). If the client disconnects or the response closes before drain is emitted, drain will never fire and the promise will hang indefinitely, leaking closure state and hanging stream handlers.
- Evidence: 2 items (top: "src/server.ts:1396 - writeChunk awaits once(res, "drain") without handling socket close or error events, causing the promise to hang forever if the client disco…") — see audit-findings.json for the full list

### ARC-b4f74d64 — Active Background Health Probing Risks Self-Inflicted Rate Limiting and Quota Exhaustion

The background monitoring subsystem (`PingLoop`) actively sends completion requests with `400 max_tokens` payloads to configured provider targets to monitor latency, HTTP status codes, and remaining quota headers.

- Severity: medium
- Confidence: high
- Lens: architecture
- Grounding: grounded
- Systemic: yes
- Files: `src/ping/cadence.ts`, `src/ping/ping.ts`, `src/circuit-breaker.ts`
- Details: The background monitoring subsystem (`PingLoop`) actively sends completion requests with `400 max_tokens` payloads to configured provider targets to monitor latency, HTTP status codes, and remaining quota headers. Across multiple providers and models, active probing can consume substantial API token allowances or trigger HTTP 429 rate limits on rate-sensitive or pay-per-use endpoints. This introduces an observer effect where the health probe loop induces the very rate-limiting failures it seeks to measure. Health monitoring should default to passive metric collection from live user proxy traffic (`runtime-telemetry.ts`), reserving active probing for explicitly enabled pools or long-idle backends using zero-token or minimal-cost endpoints.

### COR-79c2a509 — classifyCommand classifies help and version flags as mutating operations, triggering unwanted update checks

In classifyCommand(), any sub argument starting with '-' (including --help, -h, --version, -v) returns 'mutating'.

- Severity: medium
- Confidence: high
- Lens: correctness
- Grounding: grounded
- Files: `src/cli.ts:1066`
- Details: In classifyCommand(), any sub argument starting with '-' (including --help, -h, --version, -v) returns 'mutating'. This causes shouldCheckUpdates() to execute self-update checks and re-exec installers before simply printing help or version information.
- Evidence: src/cli.ts:1066 - classifyCommand treats any flag starting with - as mutating, causing --help and --version to trigger package update checks.

### ARC-36748f82-3 — Dependency cycle: 2 modules

Circular dependency among src/config.ts → src/benchmarks.ts → src/config.ts.

- Severity: medium
- Confidence: high
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/config.ts`, `src/benchmarks.ts`
- Details: Circular dependency among src/config.ts → src/benchmarks.ts → src/config.ts. Cycles increase coupling, complicate testing, and can cause initialization-order bugs.

### ARC-c9155ca2-3 — Hub module: src/server.ts

src/server.ts has 25 incoming and 39 outgoing dependencies.

- Severity: medium
- Confidence: high
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/server.ts`
- Details: src/server.ts has 25 incoming and 39 outgoing dependencies. Hub modules become change bottlenecks and make the dependency graph fragile.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### ARC-c9155ca2-4 — Lack of Extensible Middleware Pipeline for Request/Response Interception

Request translation (Anthropic to OpenAI format via `llm-bridge`), SSE stream parsing (`sse.ts`), Ajv tool schema validation (`validator.ts`), repair orchestration (`repair.ts`), and SSE serialization (`emitSse.ts`) are implemented as hardcoded procedural paths inside `src/server.ts`.

- Severity: medium
- Confidence: high
- Lens: architecture
- Grounding: grounded
- Systemic: yes
- Files: `src/server.ts`, `src/backend.ts`, `src/repair.ts`
- Details: Request translation (Anthropic to OpenAI format via `llm-bridge`), SSE stream parsing (`sse.ts`), Ajv tool schema validation (`validator.ts`), repair orchestration (`repair.ts`), and SSE serialization (`emitSse.ts`) are implemented as hardcoded procedural paths inside `src/server.ts`. Adding new provider protocols (e.g., native Gemini API or Ollama endpoints) or cross-cutting request logic (such as prompt compression, response caching, or custom security filters) requires modifying central monolith functions. Refactoring the request handling flow into a composable middleware interceptor chain would isolate protocol translations, schema validators, and repair handlers into clean, independently testable units.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### ARC-a8bf7dce — Sensitive Credential Leakage Hazard in Failure Diagnostic Safe-Token Filtering

The diagnostic contract in describeFailure (src/key-checker.ts) specifies that error messages logged by llm-relay keys must never expose secret credentials or full error strings, restricting output to classified error identifiers matching /^[A-Za-z][A-Za-z0-9_]{0,39}$/.

- Severity: medium
- Confidence: high
- Lens: architecture
- Grounding: grounded
- Files: `src/key-checker.ts`
- Details: The diagnostic contract in describeFailure (src/key-checker.ts) specifies that error messages logged by llm-relay keys must never expose secret credentials or full error strings, restricting output to classified error identifiers matching /^[A-Za-z][A-Za-z0-9_]{0,39}$/. However, describeFailure inspects err?.cause?.code, err?.code, err?.cause?.name, and err?.name. If an error cause or custom error object embeds an API token or key identifier (e.g. sk_live_1234567890abcdef) into its code or name property that happens to fit the 40-character regex pattern, SAFE_TOKEN.test(v) evaluates to true. The raw credential is then echoed verbatim in KeyCheckResult.message, violating the credential containment boundary. describeFailure should match against a closed allowlist of standard Node/fetch error codes rather than arbitrary regex matching on error properties.
- Evidence: runtime:flow:flow:host:auth-key-management: confirmed — Deterministic runtime command succeeded: npm test

### ARC-4e8f64b6 — Sequential Multi-Attempt Reshaper Loop Introduces Latency and Cost Amplification Risks

When a backend model produces a malformed tool call, the proxy's repair mechanism (`src/repair.ts`, `src/reshaper.ts`) sequentially queries a secondary reshaper model up to `maxAttempts` times to correct the JSON schema.

- Severity: medium
- Confidence: high
- Lens: architecture
- Grounding: grounded
- Systemic: yes
- Files: `src/repair.ts`, `src/reshaper.ts`, `src/emitSse.ts`, `src/server.ts`
- Details: When a backend model produces a malformed tool call, the proxy's repair mechanism (`src/repair.ts`, `src/reshaper.ts`) sequentially queries a secondary reshaper model up to `maxAttempts` times to correct the JSON schema. In streaming mode, initial text blocks are delivered to the client, but tool_use blocks are buffered until validation succeeds. If the reshaper experiences network latency or requires multiple fix attempts, the client encounters noticeable response delays or mid-stream SSE error events. Furthermore, sequential reshaper attempts multiply token usage and costs per invalid turn. The repair loop should enforce strict total latency deadlines, cap reshaper token consumption, and support immediate fail-clean fallbacks when latency thresholds are breached.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### COR-198fbd46 — SHELL_SAFE regex allows backslashes to remain unquoted when rendering arguments for POSIX shell

In cli.ts, SHELL_SAFE includes the backslash character '\\'.

- Severity: medium
- Confidence: high
- Lens: correctness
- Grounding: grounded
- Files: `src/cli.ts:531`
- Details: In cli.ts, SHELL_SAFE includes the backslash character '\\'. As a result, quoteArg(arg, "sh") treats strings with backslashes as safe and leaves them unquoted, which causes POSIX shells to interpret the backslashes as escape characters and mangle file paths or command arguments.
- Evidence: src/cli.ts:531 - SHELL_SAFE regex includes \\, allowing backslash-containing arguments to bypass single-quoting when targeting POSIX shells.

### COR-c9155ca2-2 — Single reshaper candidate is ignored when cfg.reshaper is undefined

When initializing explicitReshaper in createProxy, the expression requires cfg.reshaperCandidates.length > 1.

- Severity: medium
- Confidence: high
- Lens: correctness
- Grounding: grounded
- Files: `src/server.ts:110`
- Details: When initializing explicitReshaper in createProxy, the expression requires cfg.reshaperCandidates.length > 1. If cfg.reshaperCandidates is configured with a single item and cfg.reshaper is undefined, explicitReshaper evaluates to undefined, silently bypassing candidate reshaper selection.
- Evidence: 2 items (top: "src/server.ts:110 - '(cfg.reshaperCandidates && cfg.reshaperCandidates.length > 1' evaluates to false when reshaperCandidates has length 1, causing explicitResh…") — see audit-findings.json for the full list

### ARC-38bd017c — Synchronous External Subprocess Execution (`MarkItDown`) for Document Transcoding

Document transcoding for non-Anthropic backends (`src/documents.ts`) relies on executing an external Python CLI tool (`markitdown`) via subprocess spawns with temporary file creation and cleanup.

- Severity: medium
- Confidence: high
- Lens: architecture
- Grounding: grounded
- Files: `src/documents.ts`
- Details: Document transcoding for non-Anthropic backends (`src/documents.ts`) relies on executing an external Python CLI tool (`markitdown`) via subprocess spawns with temporary file creation and cleanup. This introduces an external Python runtime dependency into a Node.js CLI tool, leading to setup friction across OS platforms (missing Python binaries, missing pip packages, or PATH discrepancies). If Python/MarkItDown is unavailable, requests carrying document attachments fail with HTTP 400. Replacing the external Python subprocess dependency with native JavaScript/TypeScript document parsing libraries (e.g. `pdf-parse`, `mammoth`) or isolated stream converters would simplify operations and eliminate subprocess IPC overhead.

### ARC-36748f82-4 — Unauthenticated Subagent Status Spoofing via In-Band System Prompt Marker

The subagent routing contract specifies that subagent offload rules apply only to genuine Claude Code subagent requests (cc_is_subagent=true).

- Severity: medium
- Confidence: high
- Lens: architecture
- Grounding: grounded
- Systemic: yes
- Files: `src/config.ts`, `src/server.ts`
- Details: The subagent routing contract specifies that subagent offload rules apply only to genuine Claude Code subagent requests (cc_is_subagent=true). In src/config.ts, isSubagentRequest tests whether systemText(reqJson.system).includes("cc_is_subagent=true"). Because any external client sending requests to the proxy can include cc_is_subagent=true within the system parameter of standard API calls, an untrusted caller can spoof subagent status. This forces the proxy to apply routing.subagents rules to main user conversations, redirecting traffic away from primary passthrough models to secondary offload pools without authorization.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### REL-b46ebdda — Unconsumed backend response stream leaked during candidate failover

When candidate targets fail with a retryable or credential error in handle(), the loop fails over to the next candidate without cancelling or reading backendRes.body.

- Severity: medium
- Confidence: high
- Lens: reliability
- Grounding: grounded
- Files: `src/server.ts:515–519`
- Details: When candidate targets fail with a retryable or credential error in handle(), the loop fails over to the next candidate without cancelling or reading backendRes.body. The unconsumed fetch response stream keeps the underlying network socket open in the connection pool, leading to socket leaks and connection pool exhaustion under failover conditions.
- Evidence: 2 items (top: "src/server.ts:516 - handle() skips to the next candidate on failure without calling backendRes.body?.cancel(), leaking the un-consumed response stream and socke…") — see audit-findings.json for the full list

### ARC-eaffc6ab — Architectural seam: package.json ↔ src/cli.ts

The dependency between package.json and src/cli.ts is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `package.json`, `src/cli.ts`
- Details: The dependency between package.json and src/cli.ts is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.

### ARC-44561783 — Architectural seam: scripts/agentic-loop-probe.mjs ↔ scripts/install-skill.mjs

The dependency between scripts/agentic-loop-probe.mjs and scripts/install-skill.mjs is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `scripts/agentic-loop-probe.mjs`, `scripts/install-skill.mjs`
- Details: The dependency between scripts/agentic-loop-probe.mjs and scripts/install-skill.mjs is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.

### ARC-ae301e8f — Architectural seam: scripts/install-skill.mjs ↔ test/install-skill.test.ts

The dependency between scripts/install-skill.mjs and test/install-skill.test.ts is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `scripts/install-skill.mjs`, `test/install-skill.test.ts`
- Details: The dependency between scripts/install-skill.mjs and test/install-skill.test.ts is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.

### ARC-b3098837 — Architectural seam: scripts/sync-tiers.mjs ↔ scripts/verify-live-features.mjs

The dependency between scripts/sync-tiers.mjs and scripts/verify-live-features.mjs is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `scripts/sync-tiers.mjs`, `scripts/verify-live-features.mjs`
- Details: The dependency between scripts/sync-tiers.mjs and scripts/verify-live-features.mjs is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.

### ARC-010dd32d — Architectural seam: src/authEnv.ts ↔ test/authEnv.test.ts

The dependency between src/authEnv.ts and test/credential-containment.test.ts is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/authEnv.ts`, `test/authEnv.test.ts`, `test/credential-containment.test.ts`
- Details: The dependency between src/authEnv.ts and test/credential-containment.test.ts is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.
- Evidence: 4 items (top: "runtime:flow:flow:host:auth-key-management: confirmed — Deterministic runtime command succeeded: npm test") — see audit-findings.json for the full list

### ARC-859ded67-2 — Architectural seam: src/backend.ts ↔ src/documents.ts

The dependency between src/backend.ts and src/documents.ts is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/backend.ts`, `src/documents.ts`
- Details: The dependency between src/backend.ts and src/documents.ts is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### ARC-6a02bffc — Architectural seam: src/cli.ts ↔ src/setup-claude.ts

The dependency between src/cli.ts and src/setup-claude.ts is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/cli.ts`, `src/setup-claude.ts`
- Details: The dependency between src/cli.ts and src/setup-claude.ts is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.

### ARC-36748f82-5 — Architectural seam: src/config.ts ↔ test/degraded-config.test.ts

The dependency between src/config.ts and test/degraded-config.test.ts is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/config.ts`, `test/degraded-config.test.ts`
- Details: The dependency between src/config.ts and test/degraded-config.test.ts is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.

### ARC-38bd017c-2 — Architectural seam: src/documents.ts ↔ test/documents.test.ts

The dependency between src/documents.ts and test/documents.test.ts is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/documents.ts`, `test/documents.test.ts`
- Details: The dependency between src/documents.ts and test/documents.test.ts is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.

### ARC-61266d6a — Architectural seam: src/dotenv.ts ↔ test/dotenv.test.ts

The dependency between src/dotenv.ts and test/dotenv.test.ts is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/dotenv.ts`, `test/dotenv.test.ts`
- Details: The dependency between src/dotenv.ts and test/dotenv.test.ts is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.

### ARC-9e7df287 — Architectural seam: src/presets.ts ↔ test/presets.test.ts

The dependency between src/presets.ts and test/presets.test.ts is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/presets.ts`, `test/presets.test.ts`
- Details: The dependency between src/presets.ts and test/presets.test.ts is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.

### ARC-a262deff — Architectural seam: src/self-update.ts ↔ test/self-update-security.test.ts

The dependency between src/self-update.ts and test/self-update-security.test.ts is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/self-update.ts`, `test/self-update-security.test.ts`
- Details: The dependency between src/self-update.ts and test/self-update-security.test.ts is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.

### ARC-3647024e — Architectural seam: src/setup-claude.ts ↔ test/setup-claude.test.ts

The dependency between src/setup-claude.ts and test/setup-claude.test.ts is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/setup-claude.ts`, `test/setup-claude.test.ts`
- Details: The dependency between src/setup-claude.ts and test/setup-claude.test.ts is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.

### ARC-f544e594 — Architectural seam: src/winenv.ts ↔ test/winenv.test.ts

The dependency between src/winenv.ts and test/winenv.test.ts is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/winenv.ts`, `test/winenv.test.ts`
- Details: The dependency between src/winenv.ts and test/winenv.test.ts is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.

### ARC-15fb5ae5 — Architectural seam: tsconfig.json ↔ tsconfig.test.json

The dependency between tsconfig.json and tsconfig.test.json is a bridge (cut-edge): its removal disconnects the two regions.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `tsconfig.json`, `tsconfig.test.json`
- Details: The dependency between tsconfig.json and tsconfig.test.json is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.

### ARC-a2c197c9 — Hidden coupling: .github/workflows/publish.yml ↔ package.json

.github/workflows/publish.yml and package.json repeatedly change together (Files changed together in 7 commit(s) (temporal coupling).) but have no import/call/reference edge between them.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `.github/workflows/publish.yml`, `package.json`
- Details: .github/workflows/publish.yml and package.json repeatedly change together (Files changed together in 7 commit(s) (temporal coupling).) but have no import/call/reference edge between them. This hidden coupling is invisible to static dependency analysis — a change to one likely needs a matching change to the other, with nothing in the code to signal it.

### ARC-ec623c00 — Hidden coupling: config.example.json ↔ src/cli.ts

config.example.json and src/config.ts repeatedly change together (Files changed together in 6 commit(s) (temporal coupling).) but have no import/call/reference edge between them.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `config.example.json`, `src/cli.ts`, `src/config.ts`
- Details: config.example.json and src/config.ts repeatedly change together (Files changed together in 6 commit(s) (temporal coupling).) but have no import/call/reference edge between them. This hidden coupling is invisible to static dependency analysis — a change to one likely needs a matching change to the other, with nothing in the code to signal it.

### ARC-eaffc6ab-2 — Hidden coupling: package.json ↔ src/config.ts

package.json and test/server.test.ts repeatedly change together (Files changed together in 6 commit(s) (temporal coupling).) but have no import/call/reference edge between them.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `package.json`, `src/backend.ts`, `src/config.ts`, `src/server.ts` +1 more
- Details: package.json and test/server.test.ts repeatedly change together (Files changed together in 6 commit(s) (temporal coupling).) but have no import/call/reference edge between them. This hidden coupling is invisible to static dependency analysis — a change to one likely needs a matching change to the other, with nothing in the code to signal it.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### ARC-6a02bffc-2 — Hidden coupling: src/cli.ts ↔ src/registry.ts

src/cli.ts and test/config.test.ts repeatedly change together (Files changed together in 11 commit(s) (temporal coupling).) but have no import/call/reference edge between them.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/cli.ts`, `src/registry.ts`, `test/config.test.ts`
- Details: src/cli.ts and test/config.test.ts repeatedly change together (Files changed together in 11 commit(s) (temporal coupling).) but have no import/call/reference edge between them. This hidden coupling is invisible to static dependency analysis — a change to one likely needs a matching change to the other, with nothing in the code to signal it.

### ARC-c9155ca2-5 — Hidden coupling: src/server.ts ↔ test/config.test.ts

src/server.ts and test/config.test.ts repeatedly change together (Files changed together in 9 commit(s) (temporal coupling).) but have no import/call/reference edge between them.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/server.ts`, `test/config.test.ts`
- Details: src/server.ts and test/config.test.ts repeatedly change together (Files changed together in 9 commit(s) (temporal coupling).) but have no import/call/reference edge between them. This hidden coupling is invisible to static dependency analysis — a change to one likely needs a matching change to the other, with nothing in the code to signal it.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### MNT-44561783 — High complexity: scripts/agentic-loop-probe.mjs

scripts/agentic-loop-probe.mjs has a duplicate-line-count of 2 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `scripts/agentic-loop-probe.mjs`
- Details: scripts/agentic-loop-probe.mjs has a duplicate-line-count of 2 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-ae301e8f — High complexity: scripts/install-skill.mjs

scripts/install-skill.mjs has a duplicate-line-count of 1 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `scripts/install-skill.mjs`
- Details: scripts/install-skill.mjs has a duplicate-line-count of 1 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-9df7093f — High complexity: scripts/multimodal-probe.mjs

scripts/multimodal-probe.mjs has a duplicate-line-count of 30 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `scripts/multimodal-probe.mjs`
- Details: scripts/multimodal-probe.mjs has a duplicate-line-count of 30 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-b2bc6313 — High complexity: scripts/nim-front.mjs

scripts/nim-front.mjs has a duplicate-line-count of 3 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `scripts/nim-front.mjs`
- Details: scripts/nim-front.mjs has a duplicate-line-count of 3 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-e4504943 — High complexity: scripts/nim-probe.mjs

scripts/nim-probe.mjs has a duplicate-line-count of 2 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `scripts/nim-probe.mjs`
- Details: scripts/nim-probe.mjs has a duplicate-line-count of 2 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-bfd9ca72 — High complexity: scripts/nim-repair.mjs

scripts/nim-repair.mjs has a duplicate-line-count of 3 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `scripts/nim-repair.mjs`
- Details: scripts/nim-repair.mjs has a duplicate-line-count of 3 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-b335bed1 — High complexity: scripts/nim-trip-rate.mjs

scripts/nim-trip-rate.mjs has a duplicate-line-count of 6 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `scripts/nim-trip-rate.mjs`
- Details: scripts/nim-trip-rate.mjs has a duplicate-line-count of 6 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-b3098837 — High complexity: scripts/sync-tiers.mjs

scripts/sync-tiers.mjs has a duplicate-line-count of 14 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `scripts/sync-tiers.mjs`
- Details: scripts/sync-tiers.mjs has a duplicate-line-count of 14 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-f687316b — High complexity: src/anthropic.ts

src/anthropic.ts has a cyclomatic-approx of 23 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/anthropic.ts`
- Details: src/anthropic.ts has a cyclomatic-approx of 23 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-010dd32d — High complexity: src/authEnv.ts

src/authEnv.ts has a cyclomatic-approx of 41 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/authEnv.ts`
- Details: src/authEnv.ts has a cyclomatic-approx of 41 (reach: js-ts-effective). High structural complexity is hard to test and change safely.
- Evidence: 2 items (top: "runtime:flow:flow:host:auth-key-management: confirmed — Deterministic runtime command succeeded: npm test") — see audit-findings.json for the full list

### MNT-859ded67 — High complexity: src/backend.ts

src/backend.ts has a cyclomatic-approx of 93 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/backend.ts`
- Details: src/backend.ts has a cyclomatic-approx of 93 (reach: js-ts-effective). High structural complexity is hard to test and change safely.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### MNT-31833353 — High complexity: src/benchmarks.ts

src/benchmarks.ts has a cyclomatic-approx of 30 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/benchmarks.ts`
- Details: src/benchmarks.ts has a cyclomatic-approx of 30 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-85551ee4 — High complexity: src/candidates.ts

src/candidates.ts has a cyclomatic-approx of 91 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/candidates.ts`
- Details: src/candidates.ts has a cyclomatic-approx of 91 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-6b5169a2 — High complexity: src/catalog.ts

src/catalog.ts has a cyclomatic-approx of 99 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/catalog.ts`
- Details: src/catalog.ts has a cyclomatic-approx of 99 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-4d706fce — High complexity: src/circuit-breaker.ts

src/circuit-breaker.ts has a duplicate-line-count of 11 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/circuit-breaker.ts`
- Details: src/circuit-breaker.ts has a duplicate-line-count of 11 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-6a02bffc — High complexity: src/cli.ts

src/cli.ts has a cyclomatic-approx of 280 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/cli.ts`
- Details: src/cli.ts has a cyclomatic-approx of 280 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-36748f82 — High complexity: src/config.ts

src/config.ts has a cyclomatic-approx of 351 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/config.ts`
- Details: src/config.ts has a cyclomatic-approx of 351 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-69cc0882 — High complexity: src/dispatch.ts

src/dispatch.ts has a cyclomatic-approx of 79 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/dispatch.ts`
- Details: src/dispatch.ts has a cyclomatic-approx of 79 (reach: js-ts-effective). High structural complexity is hard to test and change safely.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### MNT-38bd017c — High complexity: src/documents.ts

src/documents.ts has a cyclomatic-approx of 70 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/documents.ts`
- Details: src/documents.ts has a cyclomatic-approx of 70 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-61266d6a — High complexity: src/dotenv.ts

src/dotenv.ts has a cyclomatic-approx of 18 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/dotenv.ts`
- Details: src/dotenv.ts has a cyclomatic-approx of 18 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-4c2123f8 — High complexity: src/emitSse.ts

src/emitSse.ts has a cyclomatic-approx of 25 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/emitSse.ts`
- Details: src/emitSse.ts has a cyclomatic-approx of 25 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-a8bf7dce — High complexity: src/key-checker.ts

src/key-checker.ts has a duplicate-line-count of 51 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/key-checker.ts`
- Details: src/key-checker.ts has a duplicate-line-count of 51 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Evidence: runtime:flow:flow:host:auth-key-management: confirmed — Deterministic runtime command succeeded: npm test

### MNT-536005e8 — High complexity: src/log.ts

src/log.ts has a cyclomatic-approx of 10 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/log.ts`
- Details: src/log.ts has a cyclomatic-approx of 10 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-d24c3cc6 — High complexity: src/metadata.ts

src/metadata.ts has a cyclomatic-approx of 49 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/metadata.ts`
- Details: src/metadata.ts has a cyclomatic-approx of 49 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-dd618912 — High complexity: src/offload.ts

src/offload.ts has a cyclomatic-approx of 12 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/offload.ts`
- Details: src/offload.ts has a cyclomatic-approx of 12 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-5464c91e — High complexity: src/onboarding.ts

src/onboarding.ts has a cyclomatic-approx of 64 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/onboarding.ts`
- Details: src/onboarding.ts has a cyclomatic-approx of 64 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-b4f74d64 — High complexity: src/ping/cadence.ts

src/ping/cadence.ts has a duplicate-line-count of 9 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/ping/cadence.ts`
- Details: src/ping/cadence.ts has a duplicate-line-count of 9 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-d0c1f72f — High complexity: src/ping/metrics.ts

src/ping/metrics.ts has a duplicate-line-count of 12 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/ping/metrics.ts`
- Details: src/ping/metrics.ts has a duplicate-line-count of 12 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-bd785cec — High complexity: src/ping/ping.ts

src/ping/ping.ts has a cyclomatic-approx of 41 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/ping/ping.ts`
- Details: src/ping/ping.ts has a cyclomatic-approx of 41 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-386dcba9 — High complexity: src/ping/probe-cache.ts

src/ping/probe-cache.ts has a duplicate-line-count of 23 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/ping/probe-cache.ts`
- Details: src/ping/probe-cache.ts has a duplicate-line-count of 23 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-d2f6093b — High complexity: src/ping/quota.ts

src/ping/quota.ts has a cyclomatic-approx of 28 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/ping/quota.ts`
- Details: src/ping/quota.ts has a cyclomatic-approx of 28 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-323afca3 — High complexity: src/ping/runtime-telemetry.ts

src/ping/runtime-telemetry.ts has a duplicate-line-count of 7 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/ping/runtime-telemetry.ts`
- Details: src/ping/runtime-telemetry.ts has a duplicate-line-count of 7 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-c0e29c12 — High complexity: src/pool-health.ts

src/pool-health.ts has a duplicate-line-count of 6 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/pool-health.ts`
- Details: src/pool-health.ts has a duplicate-line-count of 6 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-902ad999 — High complexity: src/registry.ts

src/registry.ts has a cyclomatic-approx of 30 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/registry.ts`
- Details: src/registry.ts has a cyclomatic-approx of 30 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-4e8f64b6 — High complexity: src/repair.ts

src/repair.ts has a cyclomatic-approx of 47 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/repair.ts`
- Details: src/repair.ts has a cyclomatic-approx of 47 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-bf2ef126 — High complexity: src/reshaper.ts

src/reshaper.ts has a cyclomatic-approx of 52 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/reshaper.ts`
- Details: src/reshaper.ts has a cyclomatic-approx of 52 (reach: js-ts-effective). High structural complexity is hard to test and change safely.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### MNT-a262deff — High complexity: src/self-update.ts

src/self-update.ts has a duplicate-line-count of 37 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/self-update.ts`
- Details: src/self-update.ts has a duplicate-line-count of 37 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-c9155ca2 — High complexity: src/server.ts

src/server.ts has a cyclomatic-approx of 397 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/server.ts`
- Details: src/server.ts has a cyclomatic-approx of 397 (reach: js-ts-effective). High structural complexity is hard to test and change safely.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### MNT-3647024e — High complexity: src/setup-claude.ts

src/setup-claude.ts has a duplicate-line-count of 8 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/setup-claude.ts`
- Details: src/setup-claude.ts has a duplicate-line-count of 8 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-199a44e6 — High complexity: src/sse.ts

src/sse.ts has a cyclomatic-approx of 83 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/sse.ts`
- Details: src/sse.ts has a cyclomatic-approx of 83 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-8a5c83cd — High complexity: src/telemetry.ts

src/telemetry.ts has a cyclomatic-approx of 29 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/telemetry.ts`
- Details: src/telemetry.ts has a cyclomatic-approx of 29 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-eb0e6f3f — High complexity: src/tier-data.ts

src/tier-data.ts has a duplicate-line-count of 5 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/tier-data.ts`
- Details: src/tier-data.ts has a duplicate-line-count of 5 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-a1f775ab — High complexity: src/validator.ts

src/validator.ts has a cyclomatic-approx of 34 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/validator.ts`
- Details: src/validator.ts has a cyclomatic-approx of 34 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-f544e594 — High complexity: src/winenv.ts

src/winenv.ts has a cyclomatic-approx of 22 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/winenv.ts`
- Details: src/winenv.ts has a cyclomatic-approx of 22 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-78887177 — High complexity: test/backend.test.ts

test/backend.test.ts has a cyclomatic-approx of 10 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/backend.test.ts`
- Details: test/backend.test.ts has a cyclomatic-approx of 10 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-dd4663e3 — High complexity: test/cli.test.ts

test/cli.test.ts has a cyclomatic-approx of 18 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/cli.test.ts`
- Details: test/cli.test.ts has a cyclomatic-approx of 18 (reach: js-ts-effective). High structural complexity is hard to test and change safely.
- Evidence: runtime:flow:flow:surface:test-cli-test-ts: confirmed — Deterministic runtime command succeeded: npm test

### MNT-777aa7de — High complexity: test/config.test.ts

test/config.test.ts has a cyclomatic-approx of 13 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/config.test.ts`
- Details: test/config.test.ts has a cyclomatic-approx of 13 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-6f7e84e8 — High complexity: test/degraded-config.test.ts

test/degraded-config.test.ts has a duplicate-line-count of 41 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/degraded-config.test.ts`
- Details: test/degraded-config.test.ts has a duplicate-line-count of 41 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-8823bcf0 — High complexity: test/destructive-coverage.test.ts

test/destructive-coverage.test.ts has a duplicate-line-count of 19 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/destructive-coverage.test.ts`
- Details: test/destructive-coverage.test.ts has a duplicate-line-count of 19 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-6fd6b6ee — High complexity: test/dispatch.test.ts

test/dispatch.test.ts has a cyclomatic-approx of 23 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/dispatch.test.ts`
- Details: test/dispatch.test.ts has a cyclomatic-approx of 23 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-46dbc1fc — High complexity: test/health-persistence.test.ts

test/health-persistence.test.ts has a duplicate-line-count of 25 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/health-persistence.test.ts`
- Details: test/health-persistence.test.ts has a duplicate-line-count of 25 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-e82197af — High complexity: test/key-checker.test.ts

test/key-checker.test.ts has a duplicate-line-count of 134 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/key-checker.test.ts`
- Details: test/key-checker.test.ts has a duplicate-line-count of 134 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-d29b7d7f — High complexity: test/loopback-admission.test.ts

test/loopback-admission.test.ts has a duplicate-line-count of 36 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/loopback-admission.test.ts`
- Details: test/loopback-admission.test.ts has a duplicate-line-count of 36 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-cfde1f58 — High complexity: test/metadata.test.ts

test/metadata.test.ts has a cyclomatic-approx of 17 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/metadata.test.ts`
- Details: test/metadata.test.ts has a cyclomatic-approx of 17 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-113524c4 — High complexity: test/offload.test.ts

test/offload.test.ts has a cyclomatic-approx of 10 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/offload.test.ts`
- Details: test/offload.test.ts has a cyclomatic-approx of 10 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-03521734 — High complexity: test/openai-front.test.ts

test/openai-front.test.ts has a duplicate-line-count of 29 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/openai-front.test.ts`
- Details: test/openai-front.test.ts has a duplicate-line-count of 29 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-130e6e13 — High complexity: test/pool-failover.test.ts

test/pool-failover.test.ts has a duplicate-line-count of 54 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/pool-failover.test.ts`
- Details: test/pool-failover.test.ts has a duplicate-line-count of 54 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-f84903a0 — High complexity: test/reshaper.test.ts

test/reshaper.test.ts has a cyclomatic-approx of 15 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/reshaper.test.ts`
- Details: test/reshaper.test.ts has a cyclomatic-approx of 15 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-12e1a02f — High complexity: test/self-update.test.ts

test/self-update.test.ts has a duplicate-line-count of 58 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/self-update.test.ts`
- Details: test/self-update.test.ts has a duplicate-line-count of 58 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-d758e799 — High complexity: test/server-safety.test.ts

test/server-safety.test.ts has a duplicate-line-count of 19 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/server-safety.test.ts`
- Details: test/server-safety.test.ts has a duplicate-line-count of 19 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-1d9e0c5c — High complexity: test/server.test.ts

test/server.test.ts has a cyclomatic-approx of 50 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/server.test.ts`
- Details: test/server.test.ts has a cyclomatic-approx of 50 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### MNT-eb4269f2 — High complexity: test/telemetry.test.ts

test/telemetry.test.ts has a cyclomatic-approx of 11 (reach: js-ts-effective).

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/telemetry.test.ts`
- Details: test/telemetry.test.ts has a cyclomatic-approx of 11 (reach: js-ts-effective). High structural complexity is hard to test and change safely.

### ARC-c9155ca2-6 — Unbounded Memory Accumulation During Tool Repair Loops on Event Streams

The server resource management contract sets body size limits (MAX_BODY_BYTES = 10MB, MAX_VALIDATE_BYTES = 8MB) to prevent Node.js memory exhaustion.

- Severity: medium
- Confidence: medium
- Lens: architecture
- Grounding: grounded
- Systemic: yes
- Files: `src/server.ts`, `src/repair.ts`
- Details: The server resource management contract sets body size limits (MAX_BODY_BYTES = 10MB, MAX_VALIDATE_BYTES = 8MB) to prevent Node.js memory exhaustion. However, when operating in repair mode (src/server.ts and src/repair.ts), stream chunks from upstream SSE responses are buffered into memory during tool validation and reshaper retries. If a rogue or misconfigured backend yields large or infinite SSE event streams during a tool repair attempt, the proxy buffers the full stream payload without enforcing MAX_VALIDATE_BYTES backpressure, causing memory heap exhaustion and proxy process crashes.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### COR-f6711540 — runDispatch positional lane argument is ignored when CLI flags precede the lane name

In main() and runDispatch(), arg3 (process.argv[3]) is assumed to be the positional lane name.

- Severity: low
- Confidence: high
- Lens: correctness
- Grounding: grounded
- Files: `src/cli.ts:594–599`
- Details: In main() and runDispatch(), arg3 (process.argv[3]) is assumed to be the positional lane name. If flags like --task precede the lane name, arg3 starts with '-' and runDispatch falls back to argValue('--lane'), causing positional lane arguments specified after options to be ignored.
- Evidence: src/cli.ts:599 - runDispatch only checks if process.argv[3] is non-flag, ignoring positional lane arguments if flags appear before lane.

### ARC-6fa9de59 — 1 orphan unit(s) with no graph connections

Units [test-vitest-config-ts] have no import, call, or reference edges in the dependency graph.

- Severity: low
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `vitest.config.ts`
- Details: Units [test-vitest-config-ts] have no import, call, or reference edges in the dependency graph. They may be dead code, or the graph extraction missed their connections.

### MNT-14d1d1d2 — Duplicated code: scripts/live-demo.mjs

scripts/live-demo.mjs has a duplicate-line-count of 15 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `scripts/live-demo.mjs`
- Details: scripts/live-demo.mjs has a duplicate-line-count of 15 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-04bf6960 — Duplicated code: scripts/verify-live-features.mjs

scripts/verify-live-features.mjs has a duplicate-line-count of 12 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `scripts/verify-live-features.mjs`
- Details: scripts/verify-live-features.mjs has a duplicate-line-count of 12 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-f687316b-2 — Duplicated code: src/anthropic.ts

src/anthropic.ts has a duplicate-line-count of 4 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/anthropic.ts`
- Details: src/anthropic.ts has a duplicate-line-count of 4 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-010dd32d-2 — Duplicated code: src/authEnv.ts

src/authEnv.ts has a duplicate-line-count of 16 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/authEnv.ts`
- Details: src/authEnv.ts has a duplicate-line-count of 16 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Evidence: 2 items (top: "runtime:flow:flow:host:auth-key-management: confirmed — Deterministic runtime command succeeded: npm test") — see audit-findings.json for the full list

### MNT-859ded67-2 — Duplicated code: src/backend.ts

src/backend.ts has a duplicate-line-count of 28 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/backend.ts`
- Details: src/backend.ts has a duplicate-line-count of 28 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### MNT-31833353-2 — Duplicated code: src/benchmarks.ts

src/benchmarks.ts has a duplicate-line-count of 2 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/benchmarks.ts`
- Details: src/benchmarks.ts has a duplicate-line-count of 2 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-85551ee4-2 — Duplicated code: src/candidates.ts

src/candidates.ts has a duplicate-line-count of 12 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/candidates.ts`
- Details: src/candidates.ts has a duplicate-line-count of 12 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-6b5169a2-2 — Duplicated code: src/catalog.ts

src/catalog.ts has a duplicate-line-count of 30 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/catalog.ts`
- Details: src/catalog.ts has a duplicate-line-count of 30 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-6a02bffc-2 — Duplicated code: src/cli.ts

src/cli.ts has a duplicate-line-count of 113 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/cli.ts`
- Details: src/cli.ts has a duplicate-line-count of 113 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-36748f82-2 — Duplicated code: src/config.ts

src/config.ts has a duplicate-line-count of 86 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/config.ts`
- Details: src/config.ts has a duplicate-line-count of 86 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-69cc0882-2 — Duplicated code: src/dispatch.ts

src/dispatch.ts has a duplicate-line-count of 25 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/dispatch.ts`
- Details: src/dispatch.ts has a duplicate-line-count of 25 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### MNT-38bd017c-2 — Duplicated code: src/documents.ts

src/documents.ts has a duplicate-line-count of 9 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/documents.ts`
- Details: src/documents.ts has a duplicate-line-count of 9 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-61266d6a-2 — Duplicated code: src/dotenv.ts

src/dotenv.ts has a duplicate-line-count of 1 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/dotenv.ts`
- Details: src/dotenv.ts has a duplicate-line-count of 1 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-4c2123f8-2 — Duplicated code: src/emitSse.ts

src/emitSse.ts has a duplicate-line-count of 20 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/emitSse.ts`
- Details: src/emitSse.ts has a duplicate-line-count of 20 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-536005e8-2 — Duplicated code: src/log.ts

src/log.ts has a duplicate-line-count of 5 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/log.ts`
- Details: src/log.ts has a duplicate-line-count of 5 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-d24c3cc6-2 — Duplicated code: src/metadata.ts

src/metadata.ts has a duplicate-line-count of 6 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/metadata.ts`
- Details: src/metadata.ts has a duplicate-line-count of 6 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-dd618912-2 — Duplicated code: src/offload.ts

src/offload.ts has a duplicate-line-count of 1 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/offload.ts`
- Details: src/offload.ts has a duplicate-line-count of 1 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-5464c91e-2 — Duplicated code: src/onboarding.ts

src/onboarding.ts has a duplicate-line-count of 6 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/onboarding.ts`
- Details: src/onboarding.ts has a duplicate-line-count of 6 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-bd785cec-2 — Duplicated code: src/ping/ping.ts

src/ping/ping.ts has a duplicate-line-count of 10 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/ping/ping.ts`
- Details: src/ping/ping.ts has a duplicate-line-count of 10 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-9e7df287 — Duplicated code: src/presets.ts

src/presets.ts has a duplicate-line-count of 41 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/presets.ts`
- Details: src/presets.ts has a duplicate-line-count of 41 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-902ad999-2 — Duplicated code: src/registry.ts

src/registry.ts has a duplicate-line-count of 2 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/registry.ts`
- Details: src/registry.ts has a duplicate-line-count of 2 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-4e8f64b6-2 — Duplicated code: src/repair.ts

src/repair.ts has a duplicate-line-count of 5 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/repair.ts`
- Details: src/repair.ts has a duplicate-line-count of 5 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-bf2ef126-2 — Duplicated code: src/reshaper.ts

src/reshaper.ts has a duplicate-line-count of 15 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/reshaper.ts`
- Details: src/reshaper.ts has a duplicate-line-count of 15 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### MNT-c9155ca2-2 — Duplicated code: src/server.ts

src/server.ts has a duplicate-line-count of 259 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/server.ts`
- Details: src/server.ts has a duplicate-line-count of 259 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Evidence: runtime:flow:flow:host:proxy-server: confirmed — Deterministic runtime command succeeded: npm test

### MNT-199a44e6-2 — Duplicated code: src/sse.ts

src/sse.ts has a duplicate-line-count of 4 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/sse.ts`
- Details: src/sse.ts has a duplicate-line-count of 4 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-8a5c83cd-2 — Duplicated code: src/telemetry.ts

src/telemetry.ts has a duplicate-line-count of 2 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/telemetry.ts`
- Details: src/telemetry.ts has a duplicate-line-count of 2 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-a1f775ab-2 — Duplicated code: src/validator.ts

src/validator.ts has a duplicate-line-count of 15 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/validator.ts`
- Details: src/validator.ts has a duplicate-line-count of 15 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-f544e594-2 — Duplicated code: src/winenv.ts

src/winenv.ts has a duplicate-line-count of 3 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `src/winenv.ts`
- Details: src/winenv.ts has a duplicate-line-count of 3 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-ad223996 — Duplicated code: test/authEnv.test.ts

test/authEnv.test.ts has a duplicate-line-count of 14 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/authEnv.test.ts`
- Details: test/authEnv.test.ts has a duplicate-line-count of 14 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Evidence: runtime:unit:tests-authEnv-test-ts: confirmed — Deterministic runtime command succeeded: npm test

### MNT-78887177-2 — Duplicated code: test/backend.test.ts

test/backend.test.ts has a duplicate-line-count of 100 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/backend.test.ts`
- Details: test/backend.test.ts has a duplicate-line-count of 100 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-656e2310 — Duplicated code: test/benchmarks.test.ts

test/benchmarks.test.ts has a duplicate-line-count of 18 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/benchmarks.test.ts`
- Details: test/benchmarks.test.ts has a duplicate-line-count of 18 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-3ef82d26 — Duplicated code: test/breaker-measurement.test.ts

test/breaker-measurement.test.ts has a duplicate-line-count of 24 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/breaker-measurement.test.ts`
- Details: test/breaker-measurement.test.ts has a duplicate-line-count of 24 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-0d49abaa — Duplicated code: test/catalog.test.ts

test/catalog.test.ts has a duplicate-line-count of 23 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/catalog.test.ts`
- Details: test/catalog.test.ts has a duplicate-line-count of 23 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-26070e6d — Duplicated code: test/circuit-breaker.test.ts

test/circuit-breaker.test.ts has a duplicate-line-count of 42 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/circuit-breaker.test.ts`
- Details: test/circuit-breaker.test.ts has a duplicate-line-count of 42 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-37ed1b2a — Duplicated code: test/cli-update-gate.test.ts

test/cli-update-gate.test.ts has a duplicate-line-count of 7 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/cli-update-gate.test.ts`
- Details: test/cli-update-gate.test.ts has a duplicate-line-count of 7 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Evidence: runtime:flow:flow:surface:test-cli-update-gate-test-ts: confirmed — Deterministic runtime command succeeded: npm test

### MNT-dd4663e3-2 — Duplicated code: test/cli.test.ts

test/cli.test.ts has a duplicate-line-count of 58 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/cli.test.ts`
- Details: test/cli.test.ts has a duplicate-line-count of 58 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Evidence: runtime:flow:flow:surface:test-cli-test-ts: confirmed — Deterministic runtime command succeeded: npm test

### MNT-777aa7de-2 — Duplicated code: test/config.test.ts

test/config.test.ts has a duplicate-line-count of 169 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/config.test.ts`
- Details: test/config.test.ts has a duplicate-line-count of 169 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-e6b97b7b — Duplicated code: test/credential-containment.test.ts

test/credential-containment.test.ts has a duplicate-line-count of 18 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/credential-containment.test.ts`
- Details: test/credential-containment.test.ts has a duplicate-line-count of 18 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.
- Evidence: runtime:unit:tests-credential-containment-test-ts: confirmed — Deterministic runtime command succeeded: npm test

### MNT-6fd6b6ee-2 — Duplicated code: test/dispatch.test.ts

test/dispatch.test.ts has a duplicate-line-count of 81 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/dispatch.test.ts`
- Details: test/dispatch.test.ts has a duplicate-line-count of 81 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-9db5483d — Duplicated code: test/documents.test.ts

test/documents.test.ts has a duplicate-line-count of 21 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/documents.test.ts`
- Details: test/documents.test.ts has a duplicate-line-count of 21 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-765dec40 — Duplicated code: test/dotenv.test.ts

test/dotenv.test.ts has a duplicate-line-count of 15 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/dotenv.test.ts`
- Details: test/dotenv.test.ts has a duplicate-line-count of 15 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-7198190b — Duplicated code: test/emitSse.test.ts

test/emitSse.test.ts has a duplicate-line-count of 12 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/emitSse.test.ts`
- Details: test/emitSse.test.ts has a duplicate-line-count of 12 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-00ba6264 — Duplicated code: test/install-skill.test.ts

test/install-skill.test.ts has a duplicate-line-count of 10 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/install-skill.test.ts`
- Details: test/install-skill.test.ts has a duplicate-line-count of 10 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-907b137d — Duplicated code: test/log.test.ts

test/log.test.ts has a duplicate-line-count of 23 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/log.test.ts`
- Details: test/log.test.ts has a duplicate-line-count of 23 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-cfde1f58-2 — Duplicated code: test/metadata.test.ts

test/metadata.test.ts has a duplicate-line-count of 58 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/metadata.test.ts`
- Details: test/metadata.test.ts has a duplicate-line-count of 58 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-9fa55b47 — Duplicated code: test/mid-stream-failure.test.ts

test/mid-stream-failure.test.ts has a duplicate-line-count of 20 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/mid-stream-failure.test.ts`
- Details: test/mid-stream-failure.test.ts has a duplicate-line-count of 20 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-113524c4-2 — Duplicated code: test/offload.test.ts

test/offload.test.ts has a duplicate-line-count of 79 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/offload.test.ts`
- Details: test/offload.test.ts has a duplicate-line-count of 79 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-658abff9 — Duplicated code: test/onboarding.test.ts

test/onboarding.test.ts has a duplicate-line-count of 32 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/onboarding.test.ts`
- Details: test/onboarding.test.ts has a duplicate-line-count of 32 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-5c9a4e45 — Duplicated code: test/ping.test.ts

test/ping.test.ts has a duplicate-line-count of 37 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/ping.test.ts`
- Details: test/ping.test.ts has a duplicate-line-count of 37 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-ec0134c0 — Duplicated code: test/pool-health.test.ts

test/pool-health.test.ts has a duplicate-line-count of 26 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/pool-health.test.ts`
- Details: test/pool-health.test.ts has a duplicate-line-count of 26 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-ea6add59 — Duplicated code: test/presets.test.ts

test/presets.test.ts has a duplicate-line-count of 3 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/presets.test.ts`
- Details: test/presets.test.ts has a duplicate-line-count of 3 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-f0ef5d11 — Duplicated code: test/registry.test.ts

test/registry.test.ts has a duplicate-line-count of 10 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/registry.test.ts`
- Details: test/registry.test.ts has a duplicate-line-count of 10 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-840289e0 — Duplicated code: test/repair.test.ts

test/repair.test.ts has a duplicate-line-count of 64 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/repair.test.ts`
- Details: test/repair.test.ts has a duplicate-line-count of 64 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-f84903a0-2 — Duplicated code: test/reshaper.test.ts

test/reshaper.test.ts has a duplicate-line-count of 46 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/reshaper.test.ts`
- Details: test/reshaper.test.ts has a duplicate-line-count of 46 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-55fde5ba — Duplicated code: test/self-update-security.test.ts

test/self-update-security.test.ts has a duplicate-line-count of 5 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/self-update-security.test.ts`
- Details: test/self-update-security.test.ts has a duplicate-line-count of 5 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-1d9e0c5c-2 — Duplicated code: test/server.test.ts

test/server.test.ts has a duplicate-line-count of 355 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/server.test.ts`
- Details: test/server.test.ts has a duplicate-line-count of 355 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-48c91372 — Duplicated code: test/setup-claude.test.ts

test/setup-claude.test.ts has a duplicate-line-count of 8 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/setup-claude.test.ts`
- Details: test/setup-claude.test.ts has a duplicate-line-count of 8 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-3c60bc77 — Duplicated code: test/sse.test.ts

test/sse.test.ts has a duplicate-line-count of 37 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/sse.test.ts`
- Details: test/sse.test.ts has a duplicate-line-count of 37 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-eb4269f2-2 — Duplicated code: test/telemetry.test.ts

test/telemetry.test.ts has a duplicate-line-count of 23 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/telemetry.test.ts`
- Details: test/telemetry.test.ts has a duplicate-line-count of 23 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-7fa41ae0 — Duplicated code: test/validator.test.ts

test/validator.test.ts has a duplicate-line-count of 19 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/validator.test.ts`
- Details: test/validator.test.ts has a duplicate-line-count of 19 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### MNT-9ecffe1f — Duplicated code: test/winenv.test.ts

test/winenv.test.ts has a duplicate-line-count of 9 (reach: js-ts-effective).

- Severity: low
- Confidence: medium
- Lens: maintainability
- Grounding: not assessed
- Files: `test/winenv.test.ts`
- Details: test/winenv.test.ts has a duplicate-line-count of 9 (reach: js-ts-effective). Duplicated code multiplies the cost of every future change to that logic.

### ARC-ad223996 — Excessive single-file units

74 of 78 units contain only a single file.

- Severity: low
- Confidence: medium
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `test/authEnv.test.ts`, `test/credential-containment.test.ts`, `src/authEnv.ts`, `src/anthropic.ts` +1 more
- Details: 74 of 78 units contain only a single file. This fragmentation may indicate that the unit grouping is too granular to reflect meaningful architectural boundaries.
- Evidence: 5 items (top: "runtime:flow:flow:host:auth-key-management: confirmed — Deterministic runtime command succeeded: npm test") — see audit-findings.json for the full list

### ARC-859ded67-3 — Behavioral cluster spans declared boundaries: 4 files

These 4 files are tightly coupled by behavior (call/import, co-change, and/or shared state) yet no single declared boundary (directory, doc, or comment grouping) contains most of them (best overlap 25%).

- Severity: low
- Confidence: low
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/backend.ts`, `src/documents.ts`, `test/backend.test.ts`, `test/documents.test.ts`
- Details: These 4 files are tightly coupled by behavior (call/import, co-change, and/or shared state) yet no single declared boundary (directory, doc, or comment grouping) contains most of them (best overlap 25%). A coupling cluster no declared purpose owns is accidental complexity or a dead subsystem — a lead for the conceptual charter pass to confirm.
- Evidence: 3 items (top: "Behavioral coupling consensus across 15 resolution levels.") — see audit-findings.json for the full list

### ARC-f687316b — Behavioral cluster spans declared boundaries: 54 files

These 54 files are tightly coupled by behavior (call/import, co-change, and/or shared state) yet no single declared boundary (directory, doc, or comment grouping) contains most of them (best overlap 44%).

- Severity: low
- Confidence: low
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/anthropic.ts`, `src/authEnv.ts`, `src/benchmarks.ts`, `src/candidates.ts` +50 more
- Details: These 54 files are tightly coupled by behavior (call/import, co-change, and/or shared state) yet no single declared boundary (directory, doc, or comment grouping) contains most of them (best overlap 44%). A coupling cluster no declared purpose owns is accidental complexity or a dead subsystem — a lead for the conceptual charter pass to confirm.
- Evidence: 7 items (top: "Behavioral coupling consensus across 15 resolution levels.") — see audit-findings.json for the full list

### ARC-6b5169a2 — Declared purpose is behaviorally smeared: 2 files

A doc/comment grouping declares these 2 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 50%).

- Severity: low
- Confidence: low
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/catalog.ts`, `src/dotenv.ts`, `src/metadata.ts`, `src/winenv.ts` +2 more
- Details: A doc/comment grouping declares these 2 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 50%). A purpose smeared across the codebase and never modularized is often the highest-value refactor — a lead for the conceptual charter pass.
- Evidence: 3 items (top: "Declared as one unit by an intent-declared source (doc/comment).") — see audit-findings.json for the full list

### ARC-859ded67-4 — Declared purpose is behaviorally smeared: 4 files

A doc/comment grouping declares these 4 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 25%).

- Severity: low
- Confidence: low
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/backend.ts`, `src/dotenv.ts`, `src/server.ts`, `test/pool-failover.test.ts`
- Details: A doc/comment grouping declares these 4 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 25%). A purpose smeared across the codebase and never modularized is often the highest-value refactor — a lead for the conceptual charter pass.
- Evidence: 3 items (top: "Declared as one unit by an intent-declared source (doc/comment).") — see audit-findings.json for the full list

### ARC-b4f75d6f — Declared purpose is behaviorally smeared: 49 files

A doc/comment grouping declares these 49 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 49%).

- Severity: low
- Confidence: low
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, `package.json`, `scripts/agentic-loop-probe.mjs` +50 more
- Details: A doc/comment grouping declares these 49 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 49%). A purpose smeared across the codebase and never modularized is often the highest-value refactor — a lead for the conceptual charter pass.
- Evidence: 6 items (top: "Declared as one unit by an intent-declared source (doc/comment).") — see audit-findings.json for the full list

### ARC-6a02bffc-3 — Declared purpose is behaviorally smeared: 8 files

A doc/comment grouping declares these 8 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 38%).

- Severity: low
- Confidence: low
- Lens: architecture
- Grounding: not assessed
- Systemic: yes
- Files: `src/cli.ts`, `src/dispatch.ts`, `src/pool-health.ts`, `src/self-update.ts` +4 more
- Details: A doc/comment grouping declares these 8 files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap 38%). A purpose smeared across the codebase and never modularized is often the highest-value refactor — a lead for the conceptual charter pass.
- Evidence: 5 items (top: "Declared as one unit by an intent-declared source (doc/comment).") — see audit-findings.json for the full list

## Scope and Coverage

This report is deterministic output from the completed audit. Non-auditable files were excluded from scope before task generation.
