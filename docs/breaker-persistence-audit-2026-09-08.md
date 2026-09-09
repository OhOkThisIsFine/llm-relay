# Circuit-breaker state across a relay restart — audit and fix (2026-09-08)

**Owner premise:** "the circuit breaker state lives only in memory, and disappears when the relay is
restarted."

**Verdict:** partly true. The COOLING half of every cell already survived a restart (shipped as
`breaker-persistence.ts`, `breaker-state.json`). Everything else in the cell did not: the failure
counters, the credential fault, the served-request ping window that `GET /telemetry` scores stability
from, and the quota observations. Nothing flushed the file at shutdown either.

**Owner decision 2026-09-08:** persist the WHOLE cell, credential faults included. The recorded
exclusions in the module header were an agent's design, not an owner decision.

## 1. What the breaker holds, who reads it, and where it lived

Every row is one `CircuitState` field in `src/circuit-breaker.ts`. "Before" is v0.76.0; "after" is
this lap.

| Field | Read by | Before | After |
|---|---|---|---|
| `cooldownUntil`, `cooldownSource` | the walk order (`targetUsability`), `candidates`, the dashboard Cooldowns panel, `GET /telemetry` (`cooldownRemainingMs`) | `breaker-state.json`, restored only while still in the future | `breaker-state.json`, restored as-is (a lapsed cooldown restores as lapsed; the cell reads ready) |
| `unexplained429s` (the escalation ladder index) | the next unexplained 429 | persisted, but DROPPED with a lapsed cooldown | persisted and restored — a restart is not a success, and the counter alone demotes nothing |
| `lastStatus` | `candidates`, `GET /telemetry` | persisted | persisted |
| `consecutiveFailures` | `MAX_FAILURES_BEFORE_TRIP` (2), `candidates` | memory only | persisted |
| `lastFailureTime` | the dashboard Cooldowns panel (`observedAt`) | memory only | persisted |
| `credentialFailures`, `lastCredentialStatus`, `credentialFaultUntil` | `hasCredentialFault` (the credential-faulted band), `candidates` (`AUTH 401`), the dashboard (`auth_error`) | memory only, by design ("a rotated key would look broken") | persisted; active only while `credentialFaultUntil` is in the future (5 minutes) |
| `pings` (served-request window, 10 samples) | `GET /telemetry` stability, `getDeploymentMeasurement` | memory only ("probe-cache.json is their one home") | persisted; the probe cache holds the PROBE dataset, a different series, so this is not a second home |
| `quotaObservations` | `quota-demotion.ts`, `availability-snapshot.ts`, `candidates` | memory only ("point-in-time state") | persisted; the read-time staleness ladder in `availability.ts` discards a stale one on read |

The one exclusion that stays: nothing. The one cost that is new: a key rotated during a restart reads
as faulted for at most five minutes, cleared by the first success or by `llm-relay cooldowns clear`.

## 2. Method — an isolated relay against a mock upstream, no real egress

Script: `breaker-restart-proof.mjs` (session scratchpad; not shipped). It starts a relay with its own
`USERPROFILE`, port 8792, `routing.laneProbe: false`, `routing.hedge: false`, and two openai-kind
providers pointing at a local mock: `mocka` answers HTTP 500, `mockb` answers HTTP 401. Pool `p` lists
both. Then:

1. Two `POST /v1/messages` through `pool/p`. Each walks both members
   (`x-llm-relay-pool-attempts: 2 tried, 0 served: 1x500, 1x401`). After the second, `mocka` has
   tripped (two consecutive failures) and `mockb` carries a credential fault.
2. Wait 2.6 s, past `MAX_FLUSH_DELAY_MS`, so the write-behind timer has written. Read the file,
   `GET /telemetry`, and run `llm-relay candidates`.
3. HARD-kill the relay (`child.kill()` on Windows is `TerminateProcess`; no signal handler runs).
   Restart it. Read the same three surfaces. The mock counts requests, so a re-learned fact shows as
   a mock hit.
4. One more request, then a kill 50 ms later: the unflushed window on a hard kill.

## 3. Baseline — the released v0.76.0 binary

| Surface | Before the kill | After hard kill + restart |
|---|---|---|
| `breaker-state.json` | 1 row: `mocka/m1` cooling, source `default`, lastStatus 500. No row for `mockb` (a credential fault is not a cooldown). | unchanged |
| `candidates` | `mocka/m1 … OPEN 57s`, `mockb/m1 … AUTH 401` | `mocka/m1 … OPEN 56s` (restored), `mockb/m1 … closed` — **the credential fault is gone** |
| `GET /telemetry` `mocka` | `isHealthy false, stabilityScore 0, observedTargets 1, lastStatus 500, cooldownRemainingMs 57394` | `isHealthy null, stabilityScore null, observedTargets 0, lastStatus 500, cooldownRemainingMs 56023` — **stability and the observed count are gone** |
| mock hits after the restart | — | 0 (nothing re-probed; the losses are silent) |
| kill 50 ms after a request | — | file unchanged: the outcome inside the write-behind window is lost |

So on v0.76.0 a restart keeps the cooldown and its source, and loses the credential fault, the
failure counter, the ping window and therefore the telemetry stability. The last-two-seconds window is
lost on any hard kill, and on Windows every kill of the logon-started daemon is a hard kill.

## 4. After — this lap's binary (`dist/cli.js` built from the worktree, same script, same mock)

| Surface | Before the kill | After hard kill + restart |
|---|---|---|
| `breaker-state.json` | 2 rows: `mocka/m1` cooling, `consecutiveFailures 2`, 2 pings; `mockb/m1` `credentialFailures 2`, fault active, 0 pings (a credential fault pushes no ping — the credential axis is not health) | identical |
| `candidates` | `mocka/m1 … OPEN 57s`, `mockb/m1 … AUTH 401` | `mocka/m1 … OPEN 56s`, `mockb/m1 … AUTH 401` — **the credential fault survives** |
| `GET /telemetry` `mocka` | `isHealthy false, stabilityScore 0, observedTargets 1, lastStatus 500, cooldownRemainingMs 57384` | `isHealthy false, stabilityScore 0, observedTargets 1, lastStatus 500, cooldownRemainingMs 56058` — **stability and the observed count survive** |
| mock hits after the restart | — | 0: nothing re-learned from the upstream |
| kill 50 ms after a request | — | file unchanged, as on v0.76.0: a hard kill still loses the debounce window (see §5) |

Every surface that went blank on v0.76.0 now reads after the restart exactly as it read before the
kill. The one line that did not move is the hard-kill window, which no persistence design closes
without a graceful stop; it is filed in `docs/backlog.md` with the property a fix must meet.

## 4a. Verification beyond the live proof

- `test/breaker-persistence.test.ts` (25 tests) pins every restored field, the lapsed-ladder
  semantics with a fresh-breaker negative control, the old-format row, per-element validation of
  the new fields, the ten-sample trim, the flush handle, and that the credential-axis writers
  notify the listener. `test/write-behind.test.ts` (5) pins `flushNow` and the registry; one test
  in each sibling store's suite pins its shutdown flush.
- Mutation-checked: restoring the old future-only rule in `restoreState` fails eight tests;
  removing the notify from `applyCredentialFault` fails exactly the listener test. Both mutants
  were reverted and the file is back at 25 passing.
- The escalation-ladder assertion in the lapsed test uses the 24-hour top rung, so it also dies if
  the counter were restored but the ladder index were reset.

## 5. Decisions taken in this lap, with their reasons

- **Faithful restore, not future-only.** The old loader dropped a row whose cooldown had lapsed, and
  with it the escalation counter, arguing that "resurrecting a stale `unexplained429s` would send the
  next single 429 straight to the top of the ladder". The running process does exactly that: a
  lapsed cooldown keeps its counter in memory, the counter alone demotes nothing, and only a FRESH
  429 — a new measurement of the same condition — applies it. Measured on the live file tonight:
  `gemini/models/gemini-3.1-pro-preview` sits at `unexplained429s: 78`; under the old rule one
  restart after its 24-hour cooldown lapsed would have cost four real 429s (2 min, 10 min, 1 h, 24 h)
  to relearn a rung the file already held.
- **Never overwrite what the live process learned.** A row restores only into a cell the process has
  not created yet. At startup that is every row; a late or repeated call touches nothing.
- **Version stays 1.** Every added field is optional on the wire. A file written by v0.76.0 loads with
  fresh-cell defaults, and a file written by this binary still loads on v0.76.0, which reads only the
  cooling fields. The version is bumped when the MEANING of an existing field changes, never when an
  optional field is added.
- **Every outcome now dirties the file.** The old notify fired only on a cooling change so that "a
  healthy relay does not write on every request". With the ping window persisted that saving is
  gone; `WriteBehindTimer` bounds it to one write per 250 ms of quiet and one per 2 s under load.
  The file is at most one row per credential×model cell, each with a ten-sample window.
- **Shutdown flush.** `installBreakerPersistence` returns a handle with `flush()`, and
  `flushBreakerPersistence()` flushes every installed handle; `runProxy` calls it beside the six
  sibling flushes in both shutdown sites. ⚠ On Windows this helps only a shutdown that delivers a
  signal (Ctrl+C in a console). The logon-started daemon is stopped by `TerminateProcess`, which
  runs no handler, so the bounded two-second window remains the real guarantee there. Stated, not
  hidden.
- **Sibling stores shared the shutdown gap, and are closed with it.** `dispatch-exhaustion-persistence.ts`,
  `dispatch-lane-stats.ts` and `lane-affinity.ts` each held a local `WriteBehindTimer` that nothing
  could flush at shutdown. `WriteBehindTimer.flushNow()` plus a per-store `WriteBehindRegistry`
  (`src/write-behind.ts`) give each store a `flush<Store>Persistence()` export, and `runProxy`
  calls all four beside the six older flushes. One test per store pins that a change recorded
  inside the debounce window reaches the file on flush.
- **The remaining residue is filed, not hidden.** The logon-started daemon on this machine is
  stopped by `TerminateProcess`, so the graceful path never runs there; `docs/backlog.md` carries
  the property a fix must meet (a control-token-admitted stop, or a launcher that delivers a
  console signal).
