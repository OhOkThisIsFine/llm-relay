# HANDOFF

Entry point for any agent picking up llm-relay, on any provider. Read this before `CLAUDE.md`.

**State as of 2026-08-20:** Stage 0 and Stage 1 env-backed multi-key pooling are complete on
`codex/stage-1-credential-pooling`, and the invariant recalibration packet is applied and complete.
The authoritative final gate is green:
`npm run build && npm run check` completed on Windows with 77 test files, 1,351 passed and 4
expected Windows/POSIX-permission skips. The Stage 1 completion point is the commit containing
this handoff; no not-yet-created commit hash is claimed here.

The full Analytics SPA implementation design is complete at
[`docs/spa-dashboard-design-2026-08-20.md`](docs/spa-dashboard-design-2026-08-20.md). No SPA
implementation, build dependencies, measurements, or green implementation gate is claimed.

## 0. Stage 1 completion checkpoint — read this first

The branch builds on these landed packets, in order:

| Commit | Packet |
|---|---|
| `7217ce0` | Stage 0 credential-aware attempt identity |
| `024837e` | Normalized `credentials[]` provider fleets |
| `5206d64` | Deterministic credential selection and breadth-first walk core |
| `f8f7360` | Fleet-aware ancillary egress (keys, ping, pool probes, onboarding) |
| `7d9eca2` | Both-front routing integration, credential leases and diagnostic surfaces |

The commit containing this handoff closes Stage 1 with these settled behaviours:

- explicit fleet slots resolve only their exact env name; legacy `authEnv` retains aliases;
- providers declare either legacy `authEnv` or `credentials[]`; every explicit fleet, including
  an empty one, is contained and cannot fall through to caller-credential passthrough;
- empty, disabled, model-scoped-out and missing fleet slots cannot egress;
- learned entitlement exclusions retain survivor fallback;
- selection preserves deployment ordering and ranks credentials by health/demotion, fresh observed
  headroom, free versus paid/unknown, credential-wide LRU, then config order;
- credential expansion is breadth-first, and only credential-attributable outcomes unlock a
  sibling slot; provider transport failures suppress that provider for the request;
- in-flight concurrency is counted credential-wide across models and only demotes saturated slots;
- attempt leases, LRU touches, walk budgets and usage binding begin only at real backend egress and
  release exactly once across buffered, streaming, transport, cancellation and mapper exits;
- Messages and OpenAI fronts emit credential identity/attempt headers for multi-slot providers and
  record `servedCredential` through the metadata-only log sink; sticky ordering stays grouped by
  deployment rather than splitting credential siblings;
- `/candidates` renders one row per `(spec, credentialId)`, `/registry` nests credential
  diagnostics, and `/telemetry` remains credential-free/provider-aggregate;
- CLI candidate/key output distinguishes credential slots; ancillary probes use serviceable slots
  without exceeding their existing real-egress budgets (`keys` checks every slot; pool probes spend
  one completion per unique deployment through one serviceable slot);
- dispatch reachability uses normalized passthrough/contained policy, and dynamic-pool discovery is
  credential-neutral until a concrete slot is selected;
- reshapers are request-local: self-repair reuses the exact serving credential snapshot, while
  provider-backed static and dynamic reshaper pools re-expand current fleets;
- public configuration examples, CLI help and operating guidance describe fleet configuration,
  per-cell diagnostics, protected control reads and credential response headers.

Do not start custody/keystore work in this branch. Stage 1 is deliberately env-backed pooling;
custody is the next design stage now that routing and observability behaviour are closed.

---

## 1. ⚠ READ THIS BEFORE YOU READ ANYTHING ELSE

The 2026-08-20 invariant recalibration packet is applied. Rubric §2 is now authoritative in
`CLAUDE.md` and `docs/project-goals.md`; do not reintroduce the retired rules or reasoning below.

The retired rules and their replacement are recorded here for historical guardrails:

| Former location | Former text | Replacement |
|---|---|---|
| `docs/project-goals.md:86` | "## Credentials stay user-operated (owner-ratified 2026-08-08)" | **REMOVED.** No longer a reason for anything. |
| `docs/project-goals.md:39` | "One place per policy." | **REMOVED.** |
| `CLAUDE.md:167` | "Provider/model agnostic. No hardcoded provider URLs, models, or keys in `src/`" | **REMOVED** as an absolute. (It was already false: `src/ping/ping.ts:59` hardcodes a provider list, and `src/presets.ts` is per-provider by design.) |
| `CLAUDE.md:612` | describes the credentials invariant as ratified and binding | **Superseded.** |

**Two reasoning patterns are also retired and may not be cited again:**

- *"No client of this relay needs it."* The owner does not consider this useful reasoning.
- *"We built this and deleted it before."* The 2026-08-04 `src/kernel/` deletion it appeals to was
  caused by miscommunication between agents working in parallel across different IDEs, plus quota
  limits causing data loss — **not** a design conclusion.

**One rule survives but was narrowed:** *"a guess must never look like a measurement."* An unlabelled
estimate presented as an observation is still forbidden. Needing a tunable default is **not** grounds
to block a feature.

**Reinstated as a founding goal: accounting and metering.** Owner scope is the full fleet model —
metering + local key custody + multi-key pooling — serving observability, enforcement, routing input,
and cost accounting.

The replacement is grounded in **`docs/rubric-recalibration-2026-08-16.md` §2** and is now applied.

Retired rules: credentials-stay-user-operated as a bar on an operator's own key pooling; one
place per policy; absolute provider/model agnosticism; and the claim that accounting metering was
outside this relay. The first three blocked the reinstated accounting goal or contradicted existing
provider-specific data; the last was retired because metering is now a founding goal. For the related
provenance recalibration—including tunable defaults and labelled provider facts—see rubric §2.

## 2. What still binds

These were **not** removed and are load-bearing. Do not relax them:

- **Loopback only.** Startup refuses a non-loopback bind. But loopback is not authorization —
  mutating endpoints carry admission checks plus a capability token.
- **Logs are metadata only**, enforced at the sink by an allow-list in `src/log.ts`. Never headers,
  never bodies, never URL parameter *values*.
- **The repair boundary.** The proxy fixes protocol *form* (malformed tool calls), never *judgment*.
  No LLM opinion may enter the request path. Routing comes from config and deterministic
  classification.
- **Destructive tool calls are refused, never fabricated.**
- **Health demotes, never drops.** Learned from a real outage where filtering unhealthy candidates
  narrowed a pool to nothing.

## 3. Historical Stage 0 brief (complete at `7217ce0`)

This section is retained as design history. Do not treat it as the current task; use §0 above.

**Stage 0 of the credential fleet, with three counter defects folded in.** Full design:
`docs/credential-fleet-design-2026-08-16.md` §8. Owner has approved this order (Stage 0, then
multi-key pooling; custody follows).

Stage 0 is a precondition — without it custody cannot work at all, because a keystore-only provider
would be dropped from routing entirely.

1. **`credentialState` refactor.** `src/config.ts:729` filters targets on it and `src/server.ts`
   throws on `declared-missing`. Touch points identified: `src/server.ts:2610,2638-2640`,
   `src/catalog.ts:373-378`, `src/reshaper.ts:180-184`, `src/telemetry.ts:88`.
2. **Per-credential keying.** New `src/credential-id.ts`, minting `CredentialId = "<provider>#<label>"`.
   The identity is the **slot**, never the key material and never the storage location — deriving it
   from storage means moving a key from env to keystore resets all of its accounting and health.
   Single-slot providers get the implicit label `default`. Make the parameter **required**, not
   optional, so the typecheck forces every call site to be triaged.
3. **`target-facts` v2 store bump.** The existing `provider` scope is already documented at
   `src/target-facts.ts:77` as "every deployment behind that credential" — the word in the source is
   already *credential*; it was named after the provider only because the two were 1:1. So this is a
   naming correction, not a new axis. v1 `p:` facts **cannot be migrated** (they never named a
   credential), so bump the version and drop them. Related latent bug: `load()` does no schema
   validation — `src/target-facts.ts:198-200` parses and casts, so stale entries keep loading silently.

Fold in these three defects — they live in exactly the code Stage 0 touches:

- **`src/ping/ping.ts:27-35`** collapses seven distinct rate-limit headers (`remaining-requests`,
  `remaining-requests-day`, `remaining-tokens`, `remaining-tokens-minute`, …) into one untyped
  percentage and discards which axis it was. Consecutive requests can render different quantities
  under one label. Also `latestQuota` is keyed per *provider* but written from a per-*model* probe.
- **`ModelTelemetry.totalCompletionTokens` has read `0` for the life of the file.**
  `recordModelCall()` accepts a `completionTokens` argument that its sole production call site,
  `src/server.ts:1262`, never passes.
- **The OpenAI front accumulates nothing** on the streaming path (`src/server.ts:1974-1980` pipes
  chunks straight to the socket), so half the traffic is invisible to every counter.

⚠ **Both request paths, always.** This codebase has had the same bug three times: a policy wired into
`/v1/messages` but not `openAiFrontPath`. Any counter, observer or gate must be wired into both.

## 4. Verification — the one gate

```bash
npm run build && npm run check
```

`npm run check` is both typechecks (`src/` and `test/`) plus the full vitest suite. **CI runs exactly
this and nothing else.** Green means green.

- Tests read `src/` directly; `scripts/*.mjs` read `dist/` — rebuild before running any script.
- 4 tests are `skipIf(win32)` POSIX-permission tests. A green local Windows run is **not** full
  coverage of secret-file permissions; CI's ubuntu leg is the only place those run.
- A failing test may be pinning a defect it should have caught. Read its stated reasoning before
  assuming your change is wrong, and fix test and source in the same commit.
- Static analysis (`npm run analysis:run`) is advisory and deliberately outside the gate.

## 5. Where to read

| Document | For |
|---|---|
| `CLAUDE.md` | Architecture map, file→responsibility table, gotchas. Invariants are authoritative (§1); it carries ~12 known drift items. |
| `docs/rubric-recalibration-2026-08-16.md` | What went wrong, the revised invariants (copy-ready), 55 re-adjudicated rejections |
| `docs/credential-fleet-design-2026-08-16.md` | Custody, pooling, cost accounting — 12 components, staged build order |
| `docs/quota-metering-spec-2026-08-16.md` | The metering pipeline — 20 metrics, collection sites, storage, 6 stages |
| `docs/spa-dashboard-design-2026-08-20.md` | Read-only Analytics SPA implementation design, protocol, contract, and staged gates |
| `docs/open-decisions-2026-08-16.md` | 18 owner decisions; 4 resolved, 14 with recommendations |
| `docs/rejection-ledger-2026-08-16.md` | Every past rejection and its reason, grouped by reason-kind |
| `docs/evidence-2026-08-16/` | Machine-readable audit trail: 375 claim verdicts, 55 re-adjudications |
| `docs/reference.md` | Full user-facing reference, including provider credential fleets and protected diagnostic surfaces. |

## 6. Things that will bite you

- **Do not trust this repo's documentation without checking source.** That is not cynicism, it is the
  finding of a 2026-08-16 audit: `CLAUDE.md` tells test authors to call `resetEligibility` (the
  function is `resetFacts`), references a deleted module in four places including one that ships to
  npm consumers in a `.d.ts`, documents 4 of 6 fact kinds, and lists 5 state files where source
  writes 10. The evidence directory exists so you can check claims rather than inherit them.
- **A CLI process's environment is not the running relay's environment.** On Windows a User-scope var
  enters a process only at start, and the relay launches at logon. `llm-relay keys` reports *its own*
  env; `GET /registry` is authoritative. A whole "half the pool is dead" finding was once this.
- **Worktrees.** If work happens in a git worktree, edit and run tests *in that path*. `vitest.config.ts`
  scopes the suite to this checkout's `test/` on purpose — do not widen it.
- **Liveness checks.** llm-relay's `/health` and `/ping` return **403 by design** (they are control
  routes); use `/telemetry`. freellmapi's `/health` returns **200 unconditionally** from an SPA
  catch-all — its real route is `/api/health`.
- **Never put `--permission-mode plan` in a `cliLane` template.** Headless `claude -p` has no
  `ExitPlanMode`, so the lane can never leave plan mode and looks healthy while completing nothing.

## 7. Definition of done

- `npm run build && npm run check` green on a clean, committed tree.
- Both request paths covered by any new policy.
- New behaviour pinned by a test. Failover tests use **≥2 candidates** — with one candidate,
  "fails over correctly" and "cannot fail over" are the same observation.
- Commit trailer names the model that authored the change:
  `Co-Authored-By: <model> <noreply@anthropic.com>`.
- No half-done state. Deliberate intermediate states must be called out explicitly so they are not
  mistaken for bugs.

## 8. Outstanding, unclaimed

1. **Implement the Analytics SPA — design complete; implementation unclaimed.**
   See [the design](docs/spa-dashboard-design-2026-08-20.md). Implementation is gated on canonical
   meter/read P0, then P1–P3 before linking, and P4 before package/release.
2. Re-audit the remaining documentation drift items in
   `docs/status-vs-freellmapi-2026-08-16.md` §5 against current source; Stage 1 corrected its
   credential-surface and phantom-header items.
3. Render the **effective** `freeOnly` in `llm-relay offload status` (`grep freeOnly src/cli.ts` = 0
   hits). ⚠ Not a raw field print: unset means **ON** for rerouted traffic and **OFF** for a directly
   addressed pool, so printing the bare optional would be a new transparency bug.
4. The 14 unresolved decisions in `docs/open-decisions-2026-08-16.md`. None block the completed Stage 1 checkpoint.
