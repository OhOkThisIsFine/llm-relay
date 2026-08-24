# HANDOFF

Entry point for any agent picking up llm-relay, on any provider. Read this before `CLAUDE.md`.

## 0. State as of 2026-08-24

The 2026-08-24 sprint delivered two commits queued for **v0.44.0**. `32f31c3` delivered Gap 10 /
M4: attempt-scoped estimated output now lands from the usage observer in its own `relay_estimate`
cell, and the completed input+output `usedInWindow` scalar means an operator's own tpm/tpd hard cap
refuses sooner and the `derived:configured` demotion rung moves instead of both acting on the old
systematic input-only undercount. `1ee1ad2` delivered M3: `POST /cooldowns/clear` and
`llm-relay cooldowns clear` share the existing control-route admission path, fail closed on scope
grammar, clear only cooling state and retain measurements, history and accounting. Both were
implemented by Codex (GPT-5.6 Sol) and adversarially reviewed: native Opus returned
MERGE-WITH-FIXES on M4 with every fix applied; fresh-context Codex returned REWORK on M3 and all
four findings, including both fail-open scope-widening majors, were fixed and pinned.

Branch `main`. The metering closeout is **complete**: every sprint lane merged (nine commits).
Since then: **v0.39.0** (`883a804`, released `cb273b0`) fixed the request-side tool-call IR leak with a
relay-owned Anthropic→OpenAI request mapper (`src/openai-request.ts`), and the **G2 hard cap** landed
(`5e06a56`, v0.40.0): `limits.hard` refuses before egress on both fronts.

This afternoon's sprint landed three more fixes, released as **v0.41.0**: `50e8233`
fixed dashboard/`cost` coverage-partial semantics (partial now means lost/omitted data, never a
merely-unmeasured token kind); `8473cb1` added `src/tool-use-ids.ts` to mint unique `tool_use` ids
when an openai-kind host repeats its own tool-call ids (NIM kimi-k3); `3253a53` added
`src/responses-request.ts`, the OpenAI Responses→Anthropic request mapper that closes the s6
dropped-`function_call` gap.

Two more commits landed after that, queued for **v0.42.0**: `d75b143` fixed gemini's
OpenAI-compatible tool messages — outbound `role:"tool"` messages now carry the caller's function
`name`, looked up from the assistant `tool_use` the result answers (gemini requires
`functionResponse.name` and never resolves it from `tool_calls`); `a407ee0` feeds the reviewed-rule
rung of `resolveResetsAt` — facts persist `untilBasis` beside an explicit expiry, and both the
dashboard availability producer and `llm-relay candidates` resolve through the new
`factResetInputs` gate.

Queued for **v0.43.0**: `providers.<name>.compat`, which closes the last two open findings in §6.
`a509cab` rewrites outbound tool-call ids to mistral's stated `^[a-zA-Z0-9]{9}$`
(`toolCallIds: "strict9"`, deterministic SHA-256→base62, announced as `x-llm-relay-tool-call-ids`);
`405602f` stamps gemini's documented `skip_thought_signature_validator` sentinel on replayed tool
calls (`thoughtSignature: "sentinel"`, live-verified). Both are base-host-defaulted labelled
provider facts that config overrides in either direction, and both shape only bodies the relay
AUTHORS — the direct Chat passthrough stays byte-exact by design (`docs/reference.md`
§"Provider wire-shape quirks"). `0de0584` closed the review of the pair: the streamed Responses
rebuild, the Responses front's outbound wire bytes, the sentinel's fetchBackend wiring, the `#k`
collision policy (injected-digest seam) and two `as never` fixture casts.

- The metering program is delivered through Stage 5. Merged lanes, by commit:
  - `7abdaf2` — C3 / Gap 4: `AssistantMessage.usage` widened; cache tokens survive repair and translation.
  - `ca9e75e` — Gap 5: operator-declared rate limits (`limits`) on providers and credential slots.
  - `3611647` — Gap 8: learned rate-limit measurement facts on both fronts (display-only).
  - `82cf8e9` — Gap 13: catalog harvesting of published rpm/rpd/tpm/tpd.
  - `a386058` — Gap 11 / Stage 4: every attempt priced from published prices into four provenance cells.
  - `a2cd375` (+ baseline regen `dd19780`) — Stage 3: availability ladders, in-memory usage window, dashboard availability producer.
  - `f29e18e` — Stage 5 / Gap 12: quota joins both fronts' walk order as a demotion term.
  - `9fd9f36` — Stage 4 / C1: the `llm-relay cost` spend roll-up with `--include-repair`.
- [docs/metering-reconciliation-2026-08-22.md](docs/metering-reconciliation-2026-08-22.md) is THE
  ledger of implemented-vs-open against `docs/quota-metering-spec-2026-08-16.md`; its §7 records
  the closeout: M4/Gap 10 and M3 are delivered for v0.44.0, Gaps 15/16/P4 were dropped, and P1
  rolls into the approved custody program. The reviewed-rule rung of `resolveResetsAt` (`a407ee0`)
  and streaming cross-protocol usage parity in llm-bridge are both closed as of 2026-08-23,
  delivered and accepted-as-is respectively (§6 below).
- Earlier state, for orientation: env-backed multi-key credential pooling landed as `7217ce0` ..
  `3795e60`; the accounting foundation + Analytics SPA (P0-P4) as `b4ec7ee`, followed by
  review-driven hardening (`3c3edd2`) and the Gap 7 spec amendment (`90e5e55`).

## 1. What still binds

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

The invariant recalibration is applied and authoritative in `CLAUDE.md` §Invariants and
`docs/project-goals.md`; the retired rules and their replacements are recorded in
[docs/rubric-recalibration-2026-08-16.md](docs/rubric-recalibration-2026-08-16.md) §2 and in git
history - do not reintroduce them.

## 2. Where to read

| Document | For |
|---|---|
| `CLAUDE.md` | Architecture map, file-to-responsibility table, gotchas. Invariants are authoritative there. |
| `docs/metering-reconciliation-2026-08-22.md` | Implemented vs open against the quota-metering spec: gap/stage/decision tables, both-fronts and provenance checks, remaining-items list. |
| `docs/rubric-recalibration-2026-08-16.md` | What went wrong, the revised invariants (copy-ready), 55 re-adjudicated rejections |
| `docs/credential-fleet-design-2026-08-16.md` | Custody, pooling, cost accounting - components, staged build order |
| `docs/quota-metering-spec-2026-08-16.md` | The metering pipeline - metrics, collection sites, storage, stages |
| `docs/spa-dashboard-design-2026-08-20.md` | Read-only Analytics SPA implementation design, protocol, contract, staged gates |
| `docs/open-decisions-2026-08-16.md` | Owner decisions; all recommendations approved 2026-08-21 |
| `docs/rejection-ledger-2026-08-16.md` | Every past rejection and its reason, grouped by reason-kind |
| `docs/evidence-2026-08-16/` | Machine-readable audit trail |
| `docs/reference.md` | Full user-facing reference, including provider credential fleets and protected diagnostic surfaces. |

## 3. Verification — the one gate

```bash
npm run build && npm run check
```

`npm run check` = both typechecks (`src/` and `test/`) + the server vitest suite + the dashboard
checks (`tsc -p dashboard/tsconfig.json --noEmit` and the dashboard suite) + the package checks
(bundle-inventory equality, size ratchets, packed smoke). **CI runs exactly this and nothing
else.**

- Bundle sizes live in `docs/dashboard-package-baseline.json` and are ratcheted: regenerate the
  baseline in the SAME change that adds or removes bundle weight, or `check:package` goes red.
- Tests read `src/` directly; `scripts/*.mjs` read `dist/` - rebuild before running any script.
- Four POSIX-permission tests skip on Windows; CI's ubuntu leg is the only place they run, so a
  green local Windows run is not full coverage of secret-file permissions.
- A failing test may be pinning a defect it should have caught. Read its stated reasoning before
  assuming your change is wrong, and fix test and source in the same commit.
- Static analysis (`npm run analysis:run`) is advisory and deliberately outside the gate.

## 4. Things that will bite you

- **Do not trust this repo's documentation without checking source.** Drift here has been
  recurrent; `test/architecture-map.test.ts` now pins every non-index `src/` file to a
  `CLAUDE.md` table row, but only that one axis is guarded. Verify claims before inheriting them.
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
- **Headless offload lanes must be told not to stop and ask.** An Ox-Alpha or `claude -p` lane
  that ends its turn with a clarifying question reads as a completed task that did nothing.
  Instruct it to decide and proceed on its own judgement, and to report rather than await approval.
- **FIXED 2026-08-22 — the owner's `cliLane` template no longer places `{task}` after the variadic
  `--allowedTools`;** it now sits directly after `-p` (pre-order backup at
  `~/.llm-relay/config.json.bak-2026-08-22-pre-clilane-task-order`). The lesson stays: some shells
  let a variadic option swallow what follows it, so keep `{task}` BEFORE any variadic flag, and
  confirm a template with one real headless run before trusting a lane built from it.
- **Claude Code has THREE client-side idle timers that abort a long silent generation at ~300 s
  on a custom base URL** — event-level + byte-level streaming watchdogs, and the body idle
  timeout. The relay's commit probe (`src/stream-commit.ts`) holds bytes until meaningful
  content, so a long think looks idle to all three. `routing.cliLane.env` now carries
  `CLAUDE_STREAM_IDLE_TIMEOUT_MS=1800000`, `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=1800000` and
  `API_FORCE_IDLE_TIMEOUT=0` so a lane child outlives its own thinking; set the same three in any
  hand-written CLI rung.
- **FIXED in v0.39.0 — the tool-call IR envelope that reached `claude -p` clients as TEXT.** Root
  cause was REQUEST-side (`docs/tool-call-dialect-leak.md` §"Second mechanism"): `backend.ts` handed the
  Anthropic conversation to llm-bridge's `universalToOpenAI`, which stringified its IR envelope into the
  outbound prompt (no `tool_call`/`tool_result` case), so models echoed the notation, agentic prompts
  were ~3x inflated, tool results triplicated and no `role:"tool"` messages were sent.
  `src/openai-request.ts` now owns the request direction; llm-bridge keeps responses. Expect prompts to
  shrink ~3x (provider caches miss once) and `role:"tool"` messages to appear for every `openai`-kind
  target; run `llm-relay pools --probe` after an upgrade. Diagnostic tell for any recurrence: leaked
  ids are the model's own (uuid / `Grep:0`), never `toolu_*`.
- **When the preferred pool member is rate-limited, `pool/xhigh` falls through to members with
  standing 402/403 refusals whose error ends a headless claude session.** Addressing a member
  directly (`--model openrouter/stealth/ox-alpha`) avoids the fall-through. Health demotes, never
  drops — so spent members stay walkable by design; the fix direction is eligibility facts or the
  G2 cap, not dropping.
- **Free-lane reliability, 2026-08-24:** ollama-cloud free tier returned 429 "weekly usage limit".
  Codex quota reset on 2026-08-24 (live-probed), so the dispatch ladders are back to the 2026-08-08
  promotion arrangement: codex-sol leads every tier; spark is second in low/medium only; terra and
  luna stay parked (backup `config.json.bak-2026-08-23-pre-codex-reenable`). NIM is DOWN for this
  account since ~21:51 PT 2026-08-23: every kimi-k3 and minimax-m3 completion returns 403
  `{"detail":"Authorization failed"}` identically through the relay and direct with the same key,
  while `/models` still authenticates, so `llm-relay keys` reports VALID. This was account-wide at
  NVIDIA and relay-blameless — RESOLVED 2026-08-24 by rotating the NVIDIA key: kimi-k3 and
  minimax-m3 answer 200 again, direct and through the relay (relay restarted with the fresh key —
  note a User-scope rotation reaches a process only at start, so the relay and any old shell must
  be restarted to see it). Kimi-k3's repeated tool-call ids are still fixed in v0.41.0 (`8473cb1`,
  `src/tool-use-ids.ts`) once NIM recovers.
  `openrouter/nvidia/nemotron-3-ultra-556b-v2` is also de-listed on OpenRouter (400 "not a valid
  model ID"); cached candidates can be stale about both failures.
- **Two heredoc groups in one Bash call break quoting in this harness.** One heredoc per call.

## 5. Definition of done

- `npm run build && npm run check` green on a clean, committed tree.
- Both request paths covered by any new policy.
- New behaviour pinned by a test. Failover tests use **≥2 candidates** — with one candidate,
  "fails over correctly" and "cannot fail over" are the same observation.
- Commit trailer names the model that authored the change:
  `Co-Authored-By: <model> <noreply@anthropic.com>`.
- No half-done state. Deliberate intermediate states must be called out explicitly so they are not
  mistaken for bugs.

## 6. Outstanding, unclaimed

After the metering sprint, from [docs/metering-reconciliation-2026-08-22.md](docs/metering-reconciliation-2026-08-22.md) §7:

- **Resolved 2026-08-23 (v0.41.0)** — dashboard/`cost` coverage-partial semantics (`50e8233`):
  partial now means lost/omitted data, never a merely-unmeasured token kind.
- **Resolved 2026-08-23 (v0.41.0)** — OpenAI Responses front's dropped `function_call`
  (`3253a53`, `src/responses-request.ts`).
- **Resolved —** the ollama-cloud 403 "Pro plan" refusal was learned by a seed interpretation as
  `subscription-required` (`ollama-cloud#default/kimi-k3`, excluded from free pools); nothing to accept.
- **Resolved 2026-08-23 (v0.42.0, `d75b143`)** — gemini's OpenAI-compatible endpoint refusing tool
  messages with no `name`.
- **DELIVERED (v0.42.0, `a407ee0`)** — the reviewed-rule rung of `resolveResetsAt` is fed: facts
  persist `untilBasis`, and both the dashboard availability producer and `llm-relay candidates`
  resolve through the new `factResetInputs` gate.
- **ACCEPTED AS-IS (owner decision 2026-08-23)** — streaming cross-protocol usage parity in
  llm-bridge: the ledger observes the BACKEND stream, so accounting is correct; only the
  client-facing translated SSE loses cache fields. (The G2 hard cap is delivered: `5e06a56`,
  `limits.hard`.)
- **Resolved 2026-08-23 (queued for v0.43.0, `405602f` + review fix-up `0de0584`)** — gemini 3.6
  requiring a `thought_signature` on tool-calling turns. `compat.thoughtSignature: "sentinel"`
  stamps Google's own documented opt-out token at
  `tool_calls[N].extra_content.google.thought_signature`, defaulted for the base host
  `generativelanguage.googleapis.com`. Live-verified against the real endpoint: single and parallel
  placements all 200, contradicting the public report that a parallel pair rejects the sentinel.
  No real signature is stored or echoed. Residual (stated in `CLAUDE.md`): the default is
  host-scoped while verification covered `models/gemini-3.6-flash` only; the override is
  `compat: { "thoughtSignature": "none" }`.
- **Resolved 2026-08-23 (queued for v0.43.0, `a509cab` + review fix-up `0de0584`)** — mistral
  (medium-2505) enforcing a 9-char alphanumeric `tool_call_id`. `compat.toolCallIds: "strict9"`
  rewrites both halves of every pair to `^[a-zA-Z0-9]{9}$` — deterministic SHA-256→base62, no
  randomness, so a replayed turn and a failover retry map identically — defaulted for a
  `*.mistral.ai` base host and announced as `x-llm-relay-tool-call-ids` plus the
  `toolCallIdRewrites` log counter. This also subsumes the `tool-use-ids.ts` interaction: a minted
  `Read:0_relay1` id is rewritten like any other shape.
- **Resolved:** Gap 7 by spec amendment 2026-08-22 (no new endpoints).
- **DELIVERED (v0.44.0, `32f31c3`) — Gap 10 / M4.** The attempt-scoped usage observer now records
  model-authored text, thinking/reasoning and whole tool-argument JSON through one chars/4
  `relay_estimate` cell, separate from reported usage; base64 is skipped, any taint nulls the whole
  estimate, serve estimates require final-wire commit and repair attempts are metered
  unconditionally. Consequence: `usedInWindow` now completes estimated-basis tokens to
  input+output, so an operator tpm/tpd `limits.hard` cap refuses sooner and the
  `derived:configured` demotion rung moves; the old input-only scalar fired both late.
- **DELIVERED (v0.44.0, `1ee1ad2`) — M3.** `POST /cooldowns/clear` and
  `llm-relay cooldowns clear <provider>[/<model>] [--credential <label>]` shipped with the §6.2
  security precondition through the same `admissionFailure()` path as `/offload` and `/dispatch`.
  The body rejects every unknown key and the CLI enforces exact arity plus a flag allow-list before
  sending; the clear removes breaker/Retry-After/escalation cooldowns, credential faults,
  quota-sourced cooldowns and cooling condition facts, while retaining measurement/eviction facts,
  failure/stability history and the accounting store. No running relay means exit 1, never a file
  fallback.
- **DROPPED (owner decision 2026-08-23), not deferred — Gaps 15/16, P4.** Removed from the program
  of record entirely, not a future ask: Gap 15 (single-file HTML dashboard) was superseded by the
  shipped SPA, Gap 16 (in-flight quota leases) had spec §5.4 arguing against it with no measured
  overshoot, P4 (server-enforced system prompts / `client_profiles` part 2) never acquired a
  purpose.

Review findings deliberately NOT fixed on 2026-08-22 (report named beside each):

- Destructive-name filter at the dialect-rescue commit point - the one known safety-shaped code
  gap (`docs/status-vs-freellmapi-2026-08-16.md` §3.1 / §6 rec 2).
- Orphan `tmp-*` journal files are never swept (C1 RISK-1 residue; retention itself landed).
- `methodSnapshot` accepts bounded arbitrary JSON as an estimation "method" (C1 NIT-6).
- Dashboard session token rides `sessionStorage`; the mitigation is the strict CSP. Trade
  recorded, not changed (C2 R2). Also standing: the type escape at `materializeDimensions`'
  aggregate return (C2 N5), misleading error codes for body problems (C2 N8),
  regex-sniffing `bodyReadErrorCode` (C2 N9), and `llm-relay dashboard <anything>` ignoring
  extra positionals (C2 N10).
- SPA/test nits standing (C3): flat 30 s poll with no failure backoff (mitigated by
  abort-on-hide/offline), CSS-structure test mirroring styles.css, a few wall-clock-sleep tests,
  dashboard fixtures cast via `as unknown as`, `aria-description` support patchier than
  described-by, theme preference not persisted, SIGKILL leaking the test interpretations file.
- Unverified residual (reconciliation §5): rotation-triggered fact clearing is verified only in
  adjacent machinery, not the rotation path itself. (The >=2-candidate accounting walk IS pinned on
  both fronts: `test/accounting-lifecycle.test.ts` "records failed and committed winning serve
  attempts" walks a 429 candidate then a winner for each front.)

Custody/keystore was gated on the metering closeout; that gate was already lifted (the metering
program is delivered through Stage 5). **The owner decision itself landed 2026-08-23: APPROVED,
queued as the next sprint** — work starts from `docs/credential-fleet-design-2026-08-16.md`'s
staged build order (which carries P1's platform-coverage question along with it), not tonight.
