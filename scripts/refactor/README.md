# Refactor evidence probes

Offline, synthetic fixtures for R0/R1 of the [architecture refactor](../../docs/architecture-refactor-plan.md).
These are test programs, not a second implementation or shipped runtime dependencies. The
[dated checkpoint](../../docs/history/refactor-baselines-and-dependencies-2026-09-22.md) records
measurements, infrastructure choices and the remaining comparison gates.

- `runtime-baseline.mjs`: build the server first, then run with Node. Three separate relay process
  starts; 30 warm nonstreamed requests per HTTP front; 1/8 MiB streams with a throttled reader;
  three client-abort propagation measurements per front; 64/512-row legacy state-write timings.
  Upstream, relay and client run in separate processes. Only the relay's memory is sampled.
  All providers and state are temporary; provider credentials and user config are not inherited.
  Output version 2 records timer granularity and paces the producer once per 64 KiB burst, avoiding
  thousands of timer pauses that dominated the original Windows fixture. Relay deadlines are unchanged.
- `sqlite-probe.mjs`: no installation required on Node 22.13+. Compares DELETE/EXTRA with WAL/FULL:
  constraints, atomic terminal results, killed uncommitted writers, extension refusal, POSIX sidecar
  permissions and worker-isolated busy handling. Does not test power loss, migration, Windows ACL
  installation or daemon/process ownership. EXTRA includes the rollback-journal directory sync that
  FULL does not promise; see [SQLite's synchronous documentation](https://www.sqlite.org/pragma.html#pragma_synchronous).
- `sdk-probe/`: isolated, private package with exact direct dependency versions. Run
  `npm install --prefix scripts/refactor/sdk-probe --ignore-scripts`, then
  `node scripts/refactor/sdk-probe/probe.mjs`. Exercises a single Zod definition via Ajv and the
  official SDK, then legacy stdio negotiation, schema discovery, errors, progress and request
  cancellation. These are protocol fixtures, not live-host or daemon-owned-job verification.

Each executable prints JSON evidence. The dedicated workflow runs the probes on Linux and Windows;
SDK/SQLite probes use the proposed Node 22.13.0 API floor without changing the production engine range.
This old patch is a compatibility test, not an operational recommendation; use a supported current
security patch for installations. The SDK probe prints resolved transitive versions/integrities:
its initial install is an experiment, not a production lockfile. Preserve the measured resolution
when adopting the dependency.

Timing results are observations, not machine-independent thresholds. Record runner/runtime and
compare like-for-like runs. Stream first-chunk timing means first received wire chunk, not semantic
commit time. Memory is sampled at 10 ms and includes relay parsing/translation; it is not an allocation
proof. Tiny commit timings on virtual/local filesystems do not establish power-loss durability.

Run `npm run gate` separately. Do not replace behavior assertions or widen the existing gate to
accommodate a failed probe. These probes do not settle the gateway comparison required before R2.
