# Closeout — C:/Code/llm-relay

Rendered 2026-09-09T06:36:50.448Z by ~/.agent-config/render-closeout.mjs.
Verification below is rendered from commands, arguments, and the verify-green ledger.

## Identity

- Branch: `main`
- HEAD: `88685202f2768d16b64afe12f98fed51fe2ad1e0`
- Sprint start: `74d8dfe836b620f38afd85ee612b836e4dd14725`

## Commits in the sprint range

- 8868520 chore: release v0.77.0
- 7feacd8 backlog: close the keyring path-sensitivity item; file the missing MCP budget line
- 896616e feat(breaker): persist the whole circuit-breaker cell across a restart, and flush every store at shutdown

## Working tree and remote

- Working tree: NOT clean — FAIL
```
M HANDOFF.md
 M docs/history/breaker-persistence-audit-2026-09-08.md
?? docs/history/closeout-breaker-persistence-2026-09-08.md
```
- `origin/main` equals HEAD — PASS

## verify-green ledger

- Ledger: `npm run check` recorded 2026-09-09T06:15:24.855Z on tree `18d78329dfc2`
- `verify-green check` FAILED: verify-green: FAIL
content changed AFTER the recorded passing run (2026-09-09T06:15:24.855Z).
Files changed since that run:
M	HANDOFF.md
M	docs/history/breaker-persistence-audit-2026-09-08.md
M	docs/history/closeout-breaker-persistence-2026-09-08.md
Re-run the suite through `record` before claiming green. — FAIL

## CI for exact HEAD

- Publish to npm: completed/success (run 34318170298) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/34318170298
- CI: completed/success (run 34318167373) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/34318167373

## Operator-provided narrative (not machine-derived)

## Operator narrative — the breaker-persistence lap

**Goal (lap record):** Persist circuit-breaker state across relay restarts: measure what breaker
state is still memory-only and close the gap. Owner decision at approval: persist credential faults
too, so the WHOLE cell survives.

**Premise check.** The owner's premise was partly true. The cooling half already survived a
restart; the failure counters, the credential fault, the served-request ping window that
`GET /telemetry` scores stability from, and the quota observations did not, and no store flushed at
shutdown. Measured on the released v0.76.0 binary with an isolated relay against a mock upstream
(`docs/history/breaker-persistence-audit-2026-09-08.md` §3): after a hard kill and restart, `candidates`
read `closed` where it had read `AUTH 401`, and telemetry read `stabilityScore null,
observedTargets 0`.

**What shipped (commit 896616e).** `breaker-state.json` carries every field of every cell and is
restored faithfully (a lapsed cooldown restores as lapsed and keeps its escalation ladder; a cell
the process already created is never touched; version stays 1 with optional fields). Every
write-behind store flushes at a graceful shutdown (`WriteBehindTimer.flushNow`,
`WriteBehindRegistry`, four `flush<Store>Persistence()` exports, called in both `runProxy`
shutdown sites). The after-proof (§4) shows every surface reading after a hard kill + restart
exactly as before the kill, with zero requests re-learned.

**Verification.** Suite 3182 passed / 5 skipped across 165 files, dashboard 32, package check
green, recorded through verify-green on tree 264ae8e8c5a6. `test/breaker-persistence.test.ts`
rewritten (25 tests), `test/write-behind.test.ts` (5), one shutdown-flush test per sibling store.
Mutation checks: the old future-only restore fails twelve of the file's 25 tests; removing the
credential-fault notify fails exactly the listener test. (The commit message of 896616e says
"eight" — a count read off a truncated listing, corrected here and in the audit document after
the independent audit flagged it.)

**Deliberate behaviour changes, stated:** (1) faithful restore, not future-only; (2) a credential
fault survives a restart while its 5-minute window is open — accepted cost: a key rotated during a
restart reads as faulted for at most that long; (3) every outcome dirties the file, bounded by the
write-behind timer.

**Residue, filed:** the logon-started daemon is stopped by `TerminateProcess`, so the graceful
flush never runs on this machine and a hard kill loses at most the last two seconds
(`docs/backlog.md`, with the property a fix must meet). Also filed: the MCP `dispatch_lanes` view
omits the per-lane walk budget the CLI prints.

**Two worktree-sensitive checks fixed on the way:** the keyring sanitizer test's English needle
matched a 4-gram of the worktree path (high-entropy needles now), and the dashboard bundle graph
recorded a junction-resolved `node_modules` path (`packageRelativePath` in
`dashboard/vite.config.ts`). Package ceilings moved to 1100000 / 5500000 after this lap's
validators and doc comments crossed 5,000,000 unpacked bytes.

**Pipeline, through its last step.** v0.77.0 (MINOR) published by the tag-triggered workflow
(run 34318170298, success), CI for the release commit green (run 34318167373), registry
`dist-tags.latest` 0.77.0, global binary reinstalled (`llm-relay --version` → 0.77.0), and the
production daemon restarted onto it (`Stop-Process` on PID 53892, relaunched by the Startup
launcher; new listener PID 52152, ready in about one second). Live check on that restart: the
state file written by v0.76.0 (41 cooling-only rows) restored — `llm-relay candidates` showed the
four still-active cooldowns as `OPEN` before any new traffic — and after one warm request the
daemon rewrote the file with 42 rows, every one carrying `pings`, `consecutiveFailures` and
`credentialFaultUntil`. The launcher's comment claiming breaker state is lost on restart was
corrected in place.

**This closeout's own commit is docs-only and lands after the certified tree.** The ledger and CI
runs cited above certify the release commit 8868520; the commit that adds this file (and the
handoff line about the live restart) changes no code, and no further render chases it.

**Independent audit: RAN** (a Sonnet subagent, given only the repository path, the start commit
and this closeout; it reconstructed the range from `git log`, the diffs, the GitHub API and the
registry). Seventeen claims verified; four flags, each resolved:

1. *"Mutation check fails eight tests" — partially substantiated; the auditor counted 10–12.*
   Re-run untruncated on `main`: **twelve** of 25. The "eight" came from a `head -8` listing.
   Corrected in `docs/history/breaker-persistence-audit-2026-09-08.md` §4a and above; the commit message
   of 896616e keeps the wrong figure, because a pushed commit on `main` is not rewritten.
2. *`HANDOFF.md` modified after the render.* Deliberate: the live-restart bullet, committed with
   this closeout in the docs-only commit the paragraph above describes.
3. *The commit trailer names only Fable 5.1 while the narrative credits a lane model and a Sonnet
   subagent.* True. The lane's answering model is not known — the job timed out before returning
   provenance — and the Sonnet subagent's test file was reviewed, extended and mutation-checked
   here before it was committed. The trailer under-credits; it is stated here rather than
   rewritten. Future lane-drafted commits carry a `Co-Authored-By` for the lane model whenever the
   provenance names one.
4. *`job-0001` is unverifiable from disk.* Correct by design — `LaneJobStore` is in-memory. The
   auditor found the circumstantial corroboration: `dispatch-lane-stats.json` records four
   `free-pool` runs ending at the 1800 s ceiling, and the live config resolves `free-pool` at
   `high` to `pool/high`.

**Offload record.** The implementation packet went to the llm-relay free pool (MCP `dispatch`,
`job-0001`, `pool/high`); the lane wrote the whole source half faithfully to the brief, then hit
its 1800 s ceiling before the test file. The test file was written by a Sonnet subagent, the
fallback the owner named. Source cleanup, the sibling flushes, docs, the live proofs and every
verification were done in the owning session; nothing a lane wrote was taken on trust.

## Verdict

- 2 section(s) FAIL: working tree, verify-green check.
