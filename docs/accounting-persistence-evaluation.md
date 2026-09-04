# Accounting Storage Schema & Engine Evaluation (`ARC-8ef54874-2`)

## 1. Executive Summary

This evaluation analyzes the persistence architecture of `llm-relay`'s accounting subsystem ([`src/accounting-store.ts`](../src/accounting-store.ts), historical `src/accounting-store-io.ts`, [`src/accounting-store-schema.ts`](../src/accounting-store-schema.ts)), specifically assessing the trade-offs between the existing multi-file transactional snapshot journal model and an embedded SQLite/WAL storage engine.

---

## 2. Current Architecture Overview

The current accounting storage engine is designed around:
1. **Multi-File Sharding by Day (`YYYY-MM-DD.json`)**: Daily detail and minute-rollup aggregates are partitioned into discrete daily JSON files.
2. **Global Lifetime (`lifetime.json`) & Recent Window (`recent.json`)**: Persistent summaries holding lifetime token/spend counters and rolling recent request detail.
3. **Atomic Snapshot Journal (`SNAPSHOT_JOURNAL_SCHEMA`)**: All mutations write a single journal file before touching target snapshot shards, using temporary file writes and atomic filesystem renames (`fsyncSync` + `renameSync`).
4. **Crash Recovery & Idempotent Replay**: Upon restart, `recoverPendingJournal()` replays any uncommitted journal directly, ensuring zero partial state mutation.
5. **In-Memory Windowing & Write-Behind Debounce**: In-flight requests mutate in-memory mutable aggregates immediately, buffering disk writes to periodic flushes.

---

## 3. Storage Engine Comparison: Snapshot Journal vs Embedded SQLite/WAL

| Dimension | Current Snapshot Journal Engine | Embedded SQLite (e.g. `better-sqlite3`) |
| :--- | :--- | :--- |
| **Dependencies & Portability** | **Zero native dependencies** (pure Node.js standard library `fs`/`crypto`). Works out-of-the-box on Windows, macOS, Linux without `node-gyp` or C++ build chains. | Requires native binary bindings or WASM. Native compilation frequently causes installation failures in enterprise / corporate environments. |
| **Read Latency (Dashboard/CLI)** | **Sub-millisecond**: Active minute cells and lifetime rollups reside directly in memory; loading historical shards reads standard JSON. | Fast indexed queries, but requires SQL query parsing, execution, and type deserialization. |
| **Write Durability & Atomicity** | **Atomic replacement via journal**: Crash-consistent; write-ahead snapshot journal guarantees target shards are replaced in full or restored. | Standard ACID transactions with WAL (Write-Ahead Logging); multi-table consistency. |
| **File Footprint & Portability** | Flat directory of human-readable JSON files (`~/.llm-relay/accounting/`), easily inspectable, backable, and archivable. | Single or dual binary database files (`.db`, `-wal`), requiring sqlite tools to inspect or extract. |
| **Retention & Pruning** | Deterministic day-level file unlinking with tombstone cursor tracking in `lifetime.json`. | Row deletion and `VACUUM` / auto-vacuum management to prevent fragmentation. |

---

## 4. Architectural Findings & Decision

### 4.1 Dependency Invariant (`CLAUDE.md`)
`llm-relay` maintains a strict core invariant of remaining lightweight and self-contained with minimal runtime dependencies (`ajv`, `llm-bridge`, `typescript`). Introducing a native SQLite dependency (`better-sqlite3` or similar) would violate this core constraint and degrade cross-platform installation reliability on user workstations.

### 4.2 Concurrency & Workload Profile
`llm-relay` operates as a dedicated loopback proxy for a single user/workstation. Accounting mutations originate within a single Node.js process. The in-memory aggregation layer combined with `accounting-store-io.ts`'s transactional journal fully satisfies all durability, atomicity, and retention guarantees required for this workload.

### 4.3 Retention of In-Memory Sliding Windows
The in-memory 60-minute sliding window and bounded lifetime rollups provide instantaneous telemetry and cost figures to CLI commands (`llm-relay cost`, `llm-relay dashboard`) with zero IO overhead during read bursts.

---

## 5. Backwards Compatibility & Migration Strategy

1. **Schema Versioning**: All accounting artifacts (`accounting.minute.v1`, `accounting.day.v1`, `accounting.lifetime.v1`, `llm-relay.snapshot-journal.v1`) include explicit `schema` and `version` fields validated on read.
2. **One-Way Upward Migration**: When reading legacy shards missing new fields (such as granular token breakdown or attribution policies), schema normalizers synthesize default zero-value metrics without corrupting persisted files.
3. **Future Extensibility**: Should an operator desire export to external analytical databases (DuckDB, ClickHouse, SQLite), historical daily shards (`YYYY-MM-DD.json`) can be ingested directly via standard JSON/Parquet pipelines.

---

## 6. Conclusion

The historical transactional snapshot journal engine in `src/accounting-store-io.ts` was **confirmed as the optimal storage architecture** for `llm-relay` as of 2026-08-05. It satisfied all ACID durability and crash-safety requirements while preserving the zero-native-dependency lightweight footprint of the project.

---

## 7. 2026-09-03 Amendment: Storage Shrink (DR-020)

**Owner decision 2026-09-03 (DR-020, Option A: "SHRINK IT")**:
The custom transactional write-ahead snapshot journal, replay engine, quarantine renames, orphan tmp file management, and in-process writer lease in `accounting-store-io.ts` have been retired in favor of the shared atomic JSON writer (`atomicWriteJsonSync` from [`src/storage/json-store.ts`](../src/storage/json-store.ts)).

The 2026-08-05 evaluation above is preserved for historical context. While the snapshot journal provided multi-file atomic commit guarantees, the operational reality of a personal single-user workstation proxy does not justify maintaining an ad-hoc 500+ line write-ahead journal and crash recovery engine for personal token counters. The accepted engineering trade-off is:
- Target files (`lifetime.json`, `recent.json`, and daily shards `YYYY-MM-DD.json`) are written individually using atomic temp-file-and-rename (`atomicWriteJsonSync`).
- A process crash between writing individual files can leave shards from two adjacent snapshot flushes on disk. The next write-behind flush re-converges the files from in-memory state; there is no journal replay or quarantine.
- Legacy `snapshot-journal.json`, `.corrupt-*`, or `tmp-*` files pre-existing on disk are ignored without crashing, replay, or quarantine.
- The `WriteBehindTimer` debouncing and in-memory aggregation remain unchanged.
