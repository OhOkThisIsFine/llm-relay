# Quota-source re-probe design — 2026-08-29

> STATUS: IMPLEMENTED (same day) — §7 shipped as designed; §8 records how it was verified.
> Backlog origin: docs/backlog.md "Re-probe every quota source on a schedule, dead ones included"
> (2026-08-29, owner request; the entry is retired with this document as its record).

## 1. Problem

A quota source recorded as dead is a snapshot, not a standing fact. A quota can reset at any
moment. Today's evidence: the Codex quota reset on 2026-08-29, days before its recorded
"dead until Sep 3" note expired. Nothing probed it; the owner discovered the reset by hand.

A recorded death currently keeps a healthy lane parked until somebody probes it manually.

## 2. Property to establish

Every quota source the host can route to — the `cli` dispatch rungs, the peer-CLI hand lanes,
and the free HTTP providers — is re-probed on a cadence. A recorded death either carries an
expiry that something enforces, or the probe that disproves it retracts it. No source stays
parked on a stale record.

## 3. Surface classes (where "dead" is recorded today)

| Class | Surface | Recorded where | Expiry enforced? |
|---|---|---|---|
| S1 | HTTP deployments behind the relay | breaker cooldowns (+ disk mirror), target-facts conditions, ping cache | Largely yes — cooldowns lapse, the next walk re-tests; facts carry TTL/until. RECON TBD: confirm citations. |
| S2 | Relay `cli` dispatch rungs | dispatch exhaustion state (15m/1h/vendor retryAfterMs), lane-manifest roster verdicts | Partially. RECON TBD: restart survival; what re-tests after lapse; roster staleness. |
| S3 | Peer-CLI hand lanes (codex exec, agy) outside the ladder | machine-wide memory files, global CLAUDE.md prose | No. Prose expires on nobody's clock. This class produced the motivating incident. |

### 3.1 Live host state (measured 2026-08-29)

- **Lane rosters are 21 days stale.** `llm-relay lanes` reports both manifests probed
  2026-08-08T23:49Z — agy (11 models) and codex (9 models). Nothing has re-probed since;
  `lane-probe.ts` runs only when an operator asks. This is S2's problem made concrete: a
  roster verdict from three weeks ago still gates rung eviction today.
- **The medium-tier ladder** carries 6 disabled codex rungs (the 2026-08-27 move to the
  first-party plugin), then live rungs: `claude-free-pool` (relay `pool/medium`), three agy
  rungs, `openrouter-deepseek`, and the `anthropic` backstop. Codex quota state is therefore
  invisible to the ladder — exactly the S3 class.
- **S3's concrete stores today:** agent memory (`free-lane-playbook`), global `CLAUDE.md`
  peer-lane notes, and HANDOFF operational notes ("Codex quota RESET 2026-08-29,
  owner-reported"). None carries an enforced expiry.
- **The nightly maintenance task is not a free carrier.** `run-headless.ps1` is scoped to
  `C:\Code\audit-tools` (hard `Set-Location`, prompt from `nightly-prompt.txt`). Riding it
  means editing a machine-wide artifact; a dedicated scheduled task is the alternative.
  Either way the cadence carrier is a MACHINE-layer change, so the owner picks it (§5).
- **Probe cost is real but small.** A hand-lane probe spends that lane's own quota
  (`codex exec` on a minimal prompt; `agy -p` with the no-shell instruction). A cadence must
  bound probe frequency, and must not probe more often than the shortest real reset period
  it could detect.

Constraint that shapes everything: **the relay never spawns a `cli` lane on its own clock.**
`lane-probe.ts` is the one place the relay runs a lane command, and only as an operator action;
the request path reads the cache. A background lane-probe loop inside the relay would breach
that line. The host, by contrast, already executes lanes — so the host can probe them.

Second constraint: probing a subscription lane SPENDS that lane's quota. A cadence must be
cheap (minimal prompt) and bounded (no probe storms on an already-dead lane).

## 4. Option space

- **A. Host-side cadence, relay stores authoritative.** A scheduled host task (the existing
  nightly headless maintenance task, or a dedicated one at a shorter period) runs
  `llm-relay lanes --probe` plus a minimal hand-lane probe, and reports results INTO the relay's
  stores. Machine memory keeps narrative pointers only. The relay stays passive on lanes
  (invariant intact) and active on HTTP (ping loop, unchanged).
- **B. Relay-side probe loop (opt-in config).** A PingLoop-style cadence inside the relay that
  runs lane commands. Requires amending the "operator action only" invariant, and puts
  quota-spending process spawns inside a long-running daemon.
- **C. Expiry-discipline only (no new prober).** Every recorded death must carry an enforced
  expiry; recovery happens passively at next use. Cheapest; meets "no source stays parked"
  only in the weak sense (parked until the expiry lapses, not until a probe disproves it).

Working recommendation (pending recon + owner decision): **A, with C's discipline folded in** —
enforced expiries everywhere a death can be recorded, plus a host-side cadence that probes and
retracts.

## 5. Owner decisions (2026-08-29)

- **Authoritative store: the relay's stores.** Dispatch exhaustion state (made durable) and
  the lane manifest hold lane facts; target-facts and the breaker hold HTTP facts. Machine
  memory and CLAUDE.md prose hold pointers only, never their own quota-dead claims with no
  enforced expiry.
- **Cadence carrier: the relay itself.** The owner rejected both host-task options: the
  nightly maintenance run belongs to audit-tools, not to machine-wide work, and background
  polling to keep metadata fresh is the relay's own job (the ping loop already does exactly
  this for HTTP). The lane cadence therefore rides the relay's background loop.
- **Invariant amendment (owner-decided, recorded here and in CLAUDE.md):** the old sentence
  "`--probe` is the ONE place the relay runs a lane command, and only as an operator action"
  narrows to the request path. New boundary: **the request path never spawns a lane**; lane
  spawns exist in exactly two places — the operator CLI probe and the relay's background
  lane cadence. The reasons the old rule existed (client-bound quota, a lane cannot answer
  an HTTP turn) all bind the request path and survive intact.

## 6. Recon findings (Codex read-only recon; load-bearing claims re-verified against source)

The full per-question report with citations lives in the Codex session
(`codex resume 01a05006-1772-7d70-92a1-9e06062df840`). What the design stands on:

| Store | Persistence | Expiry | What re-tests after expiry |
|---|---|---|---|
| Dispatch rung cooldowns | process-only `WeakMap` (`src/dispatch.ts:201`) | enforced, lazy (`cooldownUntil` deletes lapsed rows, `src/dispatch.ts:217`) | nothing active — the next dispatch query renders the rung ready; only a host execution re-tests it |
| Lane roster verdicts | `lane-manifest.json`, per-lane `probedAt` | **none** — `verifyModel` never compares `probedAt` to a clock (`src/lane-manifest.ts:116-131`) | only a later operator `lanes --probe` |
| Target facts (HTTP) | memory + `target-facts.json` | TTL/`until`, read-time filtered | next request walk; success clears; spend poll retracts paid rows |
| Breaker cells (HTTP) | memory + future-only `breaker-state.json` mirror | enforced, lazy | next request walk; cooling members stay walkable |
| Ping probe cache (HTTP) | memory + `probe-cache.json` | backoff + 24h TTL | **actively re-probed** by `PingLoop`, broken entries included |

Facts that shape the design:

- **S1 already satisfies the property.** The ping loop actively re-probes broken HTTP models
  with backoff; breaker cooldowns lapse lazily and the next walk re-tests; facts carry
  TTL/`until`. No S1 code change is needed.
- **`lanes --probe` is a CATALOG probe, not a quota probe.** It runs `codex debug models` /
  `agy models` — metadata queries. Scheduling it refreshes rosters but proves nothing about
  quota. The quota probe does not exist yet.
- **A stale roster can evict healthy rungs, against the loader's own stated intent.** A model
  absent from a KNOWN roster is `not-servable` regardless of roster age; both live rosters are
  21 days old. A vendor model rename plus a config update would evict a healthy lane on
  three-week-old evidence.
- **Dispatch exhaustion does not survive a restart**, and the report route accepts vendor
  `retryAfterMs` up to 30 days (`MAX_EXHAUSTED_MS`) — so the one store that CAN hold a
  long-lived lane death forgets it on restart. (Loss is fail-open — the lane is retried, not
  parked — so this is a cost issue, not a parking issue.)
- **Precedents exist for everything needed**: future-only restore (`breaker-persistence.ts`),
  gated per-key polling (`pollSpendHeadroom`), verdict-downgrade-on-weak-evidence
  (`verifyModel`'s unknown-not-evicted rule).
- `probeLanes` is synchronous (`execFileSync`) — it must never run inside the relay's tick.

## 7. Chosen design (per §5)

- **C1 — roster staleness downgrades eviction (relay).** A roster older than
  `LANE_ROSTER_TTL_MS` (default 7 days) is no longer positive evidence: `verifyModel` returns
  `unknown` (nothing evicted) instead of `not-servable`, and `llm-relay lanes` marks the lane
  stale. Servable stays servable — only the eviction direction demands fresh evidence.
- **C2 — dispatch exhaustion becomes durable (relay).** Mirror the per-config cooldown map to
  a cache-kind file (`dispatch-exhaustion.json`) on change; restore at proxy start only rows
  whose expiry is still in the future (the `breaker-persistence.ts` contract: field-validated,
  one bad row dropped alone, never overwrite a cooldown the live process already learned).
  Load-bearing for C4: a vendor-stated multi-day death must survive a restart for the probe
  to have anything to retract.
- **C3 — the lane quota probe (new module, pure classifier + injected spawner).** Probing one
  quota BUCKET (rungs sharing `quota` share one balance) means one minimal real completion
  through that rung's own command. Classification is fail-safe in both directions: a real
  answer (exit 0, non-trivial output) proves the lane alive and clears that bucket's
  exhaustion; a failure carrying an explicit rate/quota statement records exhaustion through
  the existing outcome classes (vendor-stated duration only when stated); anything else —
  timeout, empty output, unrecognized error — changes NOTHING. Disabled rungs are probed too:
  disabled is a config choice, but the bucket's quota state is still worth knowing.
- **C4 — the cadence rides the relay's background loop.** A gated poll beside
  `pollSpendHeadroom` in `tickOnce`: quota probes fire only for buckets carrying an ACTIVE
  recorded death (default gate 6h per bucket — an alive lane is tested by real use, so
  probing it would spend quota for nothing), and catalog re-probes fire per lane on a long
  gate (default 24h — metadata commands, no quota cost). Spawns are async (`execFile`,
  `windowsHide: true` — CREATE_NO_WINDOW, the verified agy console fix), serialized,
  stamp-before-spawn, error-contained, and never awaited inline by the tick (a lane probe can
  take minutes; HTTP pings must not wait on it). Under VITEST nothing spawns without an
  injected spawner (the `winenv.ts`/`os-keyring.ts` guard). Config block `routing.laneProbe`
  with `enabled` and the two intervals; defaults on.
- **C5 — prose demoted to pointers (machine layer, at closeout).** Global CLAUDE.md lane
  notes and agent memory record WHERE the authoritative state lives (the relay's dispatch
  state + `llm-relay lanes`) and stop carrying their own quota-dead claims without expiries.

## 8. Verification

- **Gate:** `npm run build && npm run check` recorded green through verify-green on the
  implementation tree. New suites: `test/lane-quota-probe.test.ts`,
  `test/lane-cadence.test.ts`, `test/dispatch-exhaustion-persistence.test.ts`; extended:
  `test/lane-manifest.test.ts` (staleness + `laneOfRung`), `test/lane-eviction.test.ts`
  (fresh-fixture correction + stale-roster-evicts-nothing), `test/config.test.ts`
  (`routing.laneProbe` parse). Two pre-existing tests pinned the pre-staleness behaviour through
  a dated fixture literal and were corrected in the same change (the repo's standing
  tests-pin-the-defect lesson).
- **Live, catalog half (no quota spent):** after the release restart, the first tick sees both
  rosters older than `catalogIntervalMs` and refreshes them — `llm-relay lanes` shows a
  same-day `probedAt` for codex AND agy (agy proves the wrapper-aware recognition; before this
  lap it could never refresh). No console window appears (`windowsHide`).
- **Live, quota half (spends one minimal codex request):** set
  `routing.laneProbe.quotaIntervalMs` to `60000` temporarily, restart, record a death on a real
  bucket (`llm-relay dispatch -x codex-sol --outcome quota_exhausted`), and watch: the first
  sighting stamps, the next tick past 60s probes, the OK answer retracts the death
  (`llm-relay dispatch` shows the rung ready again). Revert the interval afterwards.

## 9. Residuals, stated

- The quota probe's failure patterns are a closed, conservative set; a vendor wording outside it
  is `inconclusive` and the recorded death simply stands until its own expiry. Extending the set
  follows evidence, never guesswork.
- `llm-relay lanes` has no manual `--probe-quota` verb; the cadence (with a shortened interval)
  is the verification path. Add the verb only if a real operator need appears.
- S3 hand-lane deaths still need SOMEONE to record them (`llm-relay dispatch -x … --retry-after-ms …`);
  the cadence enforces expiry and retraction once recorded. Machine-side prose (agent memory,
  global CLAUDE.md) now points at the relay's stores instead of carrying its own expiry-less
  quota claims — per §5, the relay is authoritative.
