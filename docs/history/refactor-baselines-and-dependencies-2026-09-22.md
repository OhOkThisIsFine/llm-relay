# Refactor baseline and infrastructure decisions

Date: 2026-09-22. Continues the [R0 safety checkpoint](refactor-r0-2026-09-21.md) and the
[architecture refactor plan](../architecture-refactor-plan.md).

**Status:** executable R0 measurements and R1 infrastructure proofs are implemented. The gateway
comparison, final performance-budget calibration and service cutovers are not complete. Production
request/job ownership, dependencies, package version and Node engine declaration are unchanged by
this continuation. PR #74 remains the integration branch; documentation PR #72 is separate.

## Executable evidence

The programs and commands are in [scripts/refactor](../../scripts/refactor/README.md). They use
synthetic requests and private temporary state, not provider credentials or the operator's config.
They are not included in the published package or imported by production code.

Source checkpoint: `e49ea1693c29116fc24e5b5b1d8d16668dab38a5`.
[Refactor evidence run 3](https://github.com/OhOkThisIsFine/llm-relay/actions/runs/35700637052)
passed all four Linux/Windows runtime and dependency jobs.
[CI run 795](https://github.com/OhOkThisIsFine/llm-relay/actions/runs/35700637065)
passed the full build/check/package gate and the Windows process-boundary job. The local environment
ran syntax checks and the SQLite probe, not the full repository gate. SDK and full application
measurements were executed in GitHub CI.

### Runtime observations

Both runners used Node 22.23.2 x64. Linux: Ubuntu 24.04.5, image 20260907.300.1. Windows:
Server 2025, image 20260907.229.1. Each run measures three new relay processes, 30 nonstreamed
requests per front after three warmups, two stream sizes, three cancellations per front, and
30 legacy JSON transactions per row count. Upstream, client and relay are separate processes;
only relay memory is sampled. Full samples remain in the linked run's job logs.

| Measurement | Linux | Windows |
|---|---:|---:|
| Relay start, median / p95, ms (3 samples) | 227.70 / 234.43 | 378.49 / 401.48 |
| Messages response, median / p95, ms | 5.09 / 12.65 | 18.87 / 32.00 |
| Chat response, median / p95, ms | 4.64 / 4.95 | 25.71 / 32.09 |
| Responses response, median / p95, ms | 4.68 / 5.04 | 31.36 / 32.21 |
| Messages abort to upstream close, median / p95, ms | 4.97 / 7.78 | 11.18 / 11.18 |
| Chat abort to upstream close, median / p95, ms | 5.50 / 5.93 | 11.90 / 11.94 |
| Responses abort to upstream close, median / p95, ms | 5.94 / 6.16 | 10.49 / 14.61 |
| 64-row state write, median / p95, ms | 0.37 / 0.49 | 2.66 / 3.01 |
| 512-row state write, median / p95, ms | 1.01 / 1.04 | 3.48 / 7.51 |

| 8 MiB synthetic stream | Linux first wire chunk, ms | Windows first wire chunk, ms | Linux RSS growth, MiB | Windows RSS growth, MiB |
|---|---:|---:|---:|---:|
| Messages | 16.93 | 34.00 | 35.38 | 19.63 |
| Chat | 18.74 | 14.41 | 7.38 | 13.86 |
| Responses | 16.67 | 12.72 | 136.54 | 149.00 |

Responses emitted 25,422,668 wire bytes for 8,388,608 synthetic text bytes and reached peak RSS
278.70 MiB on Linux / 246.57 MiB on Windows. Preserve this as a translation-comparison workload;
it is an observation to investigate, not proof of a leak or permission to omit protocol-required
terminal content. All fronts delivered a first wire chunk before completing their stream.

The fixed front order, JIT warmup, GC and retained allocator pages affect these observations.
An RSS delta is not a constant-space proof. The wire-byte assertion is a performance-fixture sanity
check, not a replacement for the protocol-fidelity tests below. The cancellation measurement includes
IPC/polling latency. Disk timings do not exercise maximum retained result sizes or power loss.

The first probe revision had an incorrect relative import; it was corrected before measurements.
The next revision passed Linux but its Windows stream hit the fixture's 20-second client deadline.
Timer calibration subsequently measured a 1 ms requested delay at a 13.70 ms median on Windows
(1.13 ms on Linux). The old 8 MiB producer scheduled 2,048 such pauses; version 2 schedules one per
64 KiB burst instead. Both platforms pass with the relay's deadlines and fixture deadline unchanged.
Version-1 and version-2 stream timings must not be compared as a runtime improvement.

### Budget boundary

These are initial observations, not statistically established release thresholds. Before R2/R3,
repeat baseline and candidate on matched runners with identical probe version, front order and
payloads; record variance and explicit startup/latency/memory/cancellation budgets in the comparison.
Do not promote a single observed maximum to an arbitrary CI limit. Preserve the existing bounded
stream, deadline, cancellation and package-size assertions meanwhile. This calibration remains an
R0 exit item; a green measurement program alone does not close it.

## Contract migration map

P = product behavior to preserve; D = confirmed defect regression; S = replaceable structure.
Every existing test remains P by default until its assertions are explicitly classified otherwise.
The table identifies the principal migration boundaries and specific S exceptions, not a claim that
every assertion in the repository was individually re-audited. Mixed suites keep their P/D assertions
when imports, fixtures or structural assertions change. No existing tests were weakened here.

| Area / starting fixtures | Class and retained contract | Cutover requirement |
|---|---|---|
| `cross-front-convergence`, `pool-failover`, credential selection, configured limits, quota/latency/sticky routing | P: all three fronts make equivalent decisions; a failed first candidate can reach a second; unknown evidence remains unknown | Drive these through RequestService and add its internal answer consumer; do not preserve private route loops |
| `attempt-lifecycle`, request identity, accounting lifecycle, abandoned spend, failure provenance | P: actual egress and terminal outcomes counted once; local failure/caller cancellation are not provider failure | One outcome owner; duplicate completions and hedge losers still tested |
| `stream-commit`, `deferred-commit`, `hedge-wiring`, `mid-stream-failure`, `stream-stop-cause` | P/D: meaningful final-wire commitment, no answer splicing, losing-attempt cancellation and translated abort provenance | Preserve wire fixtures and backpressure/deadline distinctions, not the old adapter call graph |
| `repair`, destructive refusal/coverage, dialect/tool-ID/signature/Responses fixtures | P: repair form only; refuse destructive fabrication; preserve IDs, opaque fields and supported tool cycles | Compare translation candidates on these fixtures; do not use the current implementation as the oracle for known defects |
| Usage observer, accounting schema/store, dashboard contract and log fixtures | P: provenance, cache distinctions, bounded metadata-only presentation and no duplicated lane spend | Keep the accounting ledger separate from operational job storage |
| Loopback/control authorization, credential containment, read-only dispatch and configured launch fixtures | P: authenticated local admission, allowed roots and credential boundaries | Apply daemon-side checks before effects; structural schemas do not replace security semantics |
| Config normalization/vocabulary and reload fixtures | P: diagnostics, shorthand, unknown-key rejection and transactional generations | Single schema definition plus explicit normalization/semantic validation; no coercion |
| MCP wait/progress/status, lane walk/activity and process-boundary fixtures | P: useful wait/status contract, honest liveness and confirmed process termination | Add complete-job survival and polling-independent progress; D1 fragment survival is not proof of R4 |
| `mcp-persistence-concurrency`, `storage/json-store`, `file-lock` | P/D: no lost rows, mutual exclusion, fail-closed invalid state, terminal result before journal retirement | Retain behavioral regressions at the new store/service boundary; lock format and journal topology are S |
| `candidate-runner-exports` | S: module location and the assertion requiring more than 50 exports; retain no-unused-API intent | Remove obsolete count/path assertions with the owner replacement |
| `one-declaration` | S: more than 500 exported names and current path-pair exceptions; retain one authoritative vocabulary | Retarget the useful duplicate-definition check to the new definitions |
| `kernel-architecture`, architecture-map, scripts inventory | S: current directories, import placement and filename inventories; retain real dependency boundaries and accurate docs | Change these only alongside the responsibility they describe, not to hide behavioral failures |

R3/R4 must add admission/result-write failure, import/rollback, deduplication retention, competing-daemon
ownership, no PID adoption/replay, and no local fallback coverage. R5 must prove caller-wait cancellation
is distinct from explicit job cancellation. The existing baseline does not already certify these
new contracts. Exhaustive assertion review stays with each affected cutover; unreviewed tests remain
protected rather than being silently discarded under a family-level S label.

## R1 infrastructure choices

These choices are supported by executable specimens, not yet adopted production components.

| Responsibility | Selected approach | Proof and remaining boundary |
|---|---|---|
| MCP protocol | Official `@modelcontextprotocol/server` 2.0.0, stdio transport | Fresh hook-free install and fragmented CRLF initialization, tool schemas/calls/errors, progress, cancellation and ping pass on both OSes for 2025-03-26, 2025-06-18 and 2025-11-25 |
| Owned structural contracts | Zod 4.3.6 definitions with inferred types; generated input JSON Schema consumed by existing Ajv 8.17.1 where appropriate | Nine structural fixtures agree between Zod/Ajv without coercion or mutation; both discriminated-union members exercised; strict owned objects reject unknown keys and open vendor objects retain them |
| Job persistence | `node:sqlite` DatabaseSync behind one database worker, explicit SQL; Node 22.13 minimum API level when adopted | Linux and Windows probes pass at exactly 22.13.0 without an addon build/install hook; production engine changes wait for the real consumer and clean-install gate |
| Journal / durability | DELETE rollback journal with `synchronous=EXTRA`, foreign keys on, extension loading disabled, bounded busy handling in the worker | Compared with WAL/FULL. Both preserve committed results and roll back a killed writer; contention leaves the parent event loop responsive. Choose simpler single-owner storage, not the faster microbenchmark by default |

The SDK experiment resolved eight packages: SDK server/core 2.0.0, Zod 4.3.6, Ajv 8.17.1,
fast-deep-equal 3.1.3, fast-uri 3.1.8, json-schema-traverse 1.0.0 and require-from-string 2.0.2.
Exact transitive versions and integrity hashes are printed in the run. Direct versions are pinned;
this isolated experimental install is not a production lockfile. Commit the resolved lockfile and
recheck advisories/installation when adopting the dependencies. No claim that these are the latest
available versions is needed for this proof.

Zod's ordinary object behavior must not silently strip owned fields: use explicit strict/open
boundaries as tested. Keep transformations, defaults and semantic validation outside generated input
schemas. The JavaScript specimen proves runtime/schema agreement; production TypeScript inference,
exhaustive unions and existing field-specific diagnostics still need compile-time/integration tests.
The SDK owns framing, not jobs: cancellation here aborts a waiting handler, not a daemon-owned job.
Live host versions, discovery, existing full tool descriptions and host reconnect behavior remain
integration checks, not conclusions inferred from these wire fixtures.

SQLite's [synchronous documentation](https://www.sqlite.org/pragma.html#pragma_synchronous) distinguishes
rollback FULL from EXTRA: the latter also syncs the directory after unlinking the rollback journal.
The choice requests durable commits on storage that honors synchronization; the process-kill tests
do not simulate power loss. WAL is not required for one worker's short transactions and would add
checkpoint/sidecar/backup responsibilities. SQLite also documents a
[WAL-reset race](https://www.sqlite.org/wal.html#walreset) affecting older engines including the
3.47.2 engine bundled with the tested API-floor Node version; the WAL probe does not certify absence
of that rare race. DELETE avoids that mode. The API-floor test is not a recommendation to deploy an
old security patch: installations should use a current supported Node patch.

The worker is an I/O implementation detail, never a second job owner. It must bound queued work as
well as lock waits; admission failure still refuses launch. R3 must exercise real maximum output
sizes, persistence degradation/retries, backups and migration failures. Windows ACL installation,
macOS full-sync behavior, arbitrary driver/schema mismatch and power-loss simulation are unverified.
Database locking does not settle singleton daemon ownership or make process creation transactional.

## Remaining R1 gate and next implementation

Run the plan's executable translation/gateway comparison with **llm-bridge as the control, LiteLLM
and Bifrost as candidates**. None was replaced or declared a winner by these infrastructure probes.
Use the same protocol/tool/opaque-content/accounting fixtures and the Responses memory workload;
include cancellation/backpressure and installation cost. A gateway must not retain an independent
retry/router beneath another owner. Record failed contracts as well as passing ones.

Finish the paired performance budgets above, then start R2 with the selected translation boundary.
R3 may prepare import/rollback work, but must land with a real consumer or atomically with R4.
Do not introduce empty production services, an inert second store, or continuation machinery as
substitutes for these cutovers. The continuation live-evidence gate remains unchanged.
