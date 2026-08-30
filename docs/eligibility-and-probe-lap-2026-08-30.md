# The eligibility-and-probe lap — 2026-08-30

Lap start commit `7ec761d`. Opened with `/start-lap` against an EMPTY backlog and a HANDOFF §6
that reported nothing awaiting the owner. The work came instead from two places the trackers do
not cover: the live eligibility queue, and the baseline check itself.

Every owner decision in this document was asked as a direct question and answered. Where a verdict
here reverses an earlier one of mine, the reversal and its evidence are stated rather than quietly
corrected.

---

## 1. The baseline was red, and the cause was not in the repo

`verify-green check` refused green, so the suite was re-recorded. It **failed**:

```
Error: dashboard package check: generated graph packages[0] is not a portable resolved package record
```

Root cause: **this worktree's `node_modules/` held zero packages.** Node resolution walked up three
levels and satisfied every import from the parent checkout at `C:\Code\llm-relay`. `npm run build`
succeeded, `tsc` was clean, and the entire vitest suite passed — against a dependency tree that was
not this worktree's.

The only check that noticed was `check:package`, and it reported the *symptom*
(`../../../node_modules/react` where `node_modules/react` is required), not the cause. After
`npm ci --ignore-scripts` (370 packages) the gate passed and the baseline was recorded green.

**This is the dangerous shape: a green gate certifying the wrong tree.** It breaks in both
directions — the parent's half-finished edit can fail this worktree's run, and the parent's stale
copy can pass one.

Owner decision: fix it **machine-wide**, and **warn rather than install** (an unrequested
multi-minute `npm ci` at session start, or a partial one, is harder to notice than a message).
Delivered as `~/.claude/hooks/worktree-deps-guard.mjs`, a global SessionStart hook on
`startup|resume`. It fires only for a LINKED worktree — the test is that `.git` is a FILE, not a
directory — so an ordinary clone stays silent. Verified across seven cases: warns with no
`node_modules`, warns with an empty one, warns from a nested subdirectory, and stays silent for a
populated worktree, for a main checkout with no `node_modules` at all, and on any error (fail-open).

---

## 2. The eligibility queue: two conditions, two different answers

### 2.1 groq — a client-side network block, not a provider fault

`groq/qwen/qwen3.6-27b`, HTTP 403 ×20, `access denied. please check your network settings.`

| Evidence | Finding |
|---|---|
| Account roster | `qwen/qwen3.6-27b` IS one of groq's 14 listed models |
| Credential | `llm-relay keys` reports groq VALID, "Key verified & healthy" |
| Time distribution | All 20 refusals inside 2026-08-28T16:36Z → 2026-08-29T00:32Z (7.94 h); none in the 27.8 h since |
| Live probe | HTTP 200 with a real completion |

**Owner supplied the cause: a temporarily connected VPN.** So the refusal was true, durable in
meaning, and said nothing whatever about the deployment.

No member of the closed `FactKind` vocabulary describes this. `not-servable`,
`subscription-required`, `allowance-exhausted`, `credential-invalid` and `rate-limited` all state
something about DEPLOYMENT eligibility; the deployment and the credential were both fine. Recording
any of them would assert what the evidence does not support.

Owner decision: **build an advisory this lap**, and do NOT build egress interface binding — a VPN
split-tunnel solves it at the right layer, and interface binding would add a networking surface
this project deliberately does not have.

### 2.2 mistral — a spent FREE quota, not a missing subscription

`mistral/mistral-medium-3-5` and `mistral/ministral-3b-latest`, HTTP 402,
`Check your subscription on https://admin.mistral.ai/subscription`.

⚠ **I proposed `subscription-required` first, and that was wrong.** The message names a
subscription, so it reads as a plan requirement — which EVICTS. The owner supplied the decisive
evidence: Mistral had emailed that the account used **100% of its free quota**, resetting in a few
days. A spent free allowance is `allowance-exhausted`, which DEMOTES. This is the CLAUDE.md rule
"out of free credits is NOT paid" hitting from the direction where the vendor's own prose misleads.

Supporting measurements:

- Live probe reproduces the 402 on demand.
- **Control probe** on the cheapest model (`ministral-3b-latest`) returns the identical 402, so the
  condition is **not** limited to a paid subset ⇒ **no `--cost-class` filter**. Had only the
  expensive model been tested, a `paid` filter would have looked right and would have been wrong.
  (That control probe is what raised the second queue entry.)
- `llm-relay keys` reports the whole mistral provider UNREACHABLE on 402 ⇒ not model-specific.
- Scope `credential`, not `provider`: the quota belongs to the account behind this key, and a
  future second key could belong to a different account.

**Can the reset be queried programmatically? No — not on a free account.** Mistral's Admin API
(`https://api.mistral.ai/v1/admin`, usage-metrics) is **Enterprise-only** and needs a dedicated
Admin-role key; the Admin Console Limits page is the authoritative source, and Mistral no longer
publishes free-tier numbers. Empirically its 402 carries no rate-limit header either: after a live
probe the newest mistral quota observation was still 38 hours stale. Mistral also uses
rolling-window resets, so there may be no single reset moment to read.

Owner decision: assert **one week** from the email, with the requirement that the relay keep
probing so an early recovery is used. That requirement was not met — see §3.

### 2.3 The groq item is deliberately LEFT PENDING

The obvious tidy-up is `reject` — it means nothing durable, after all. **That would have been a
mistake, and the advisory's first draft recommended it.** `reject` writes the signature to the
store's `ignored` set, where it "stays suppressed": a later occurrence queues nothing. Following
that advice would silence the next VPN episode completely and defeat the advisory's entire purpose.

A permanent queue entry is the price of a warning that still fires. The advisory now says so, and
`test/network-block.test.ts` pins that it never recommends rejecting.

---

## 3. The gap that made the 7-day reset unsafe

Before accepting a week-long window, the owner's requirement was checked rather than assumed: does
the relay actually re-probe and clear early?

**It did not.** `clearFacts()` had exactly **one** caller — `src/server.ts`, on a served request
success. Neither `src/ping/cadence.ts` nor `src/ping/ping.ts` called it.

That is a genuine asymmetry, not a deliberate one:

- `ping.ts` sends a **REAL completion** — `messages: [{role:"user", content:"hi"}]`,
  `max_tokens: 1` — not a `/models` call or a HEAD.
- `cadence.ts` resolves the **exact credential slot** it probed with, so the evidence is
  attributable.
- `server.ts`'s own comment justifies clearing as "first-party proof that this deployment exists
  and that the credential has allowance RIGHT NOW". A probe success is the same proof.

So the relay probed every deployment on a cadence and threw that evidence away. A long-window
`allowance-exhausted` fact survived its whole window unless real traffic happened to reach the
demoted candidate.

**Fixed** in `recordPing`: a `200` retracts that cell's cooling conditions. Decided without asking,
and stated here so it can be overridden: it clears the **same set** a served request clears, full
symmetry rather than `allowance-exhausted` only — two policies for one question ("did this
deployment just work?") is the "two paths, one policy empty" shape this repo has repeatedly been
bitten by.

Residuals, stated:

- The probe is a **weaker** request (1 token), so it could in principle succeed while real traffic
  is still throttled. Bounded: clearing only affects DEMOTE-class conditions, and the next real
  failure re-records the fact.
- Unlike the served path it does **not** also clear the breaker's credential faults. `PingLoop`
  holds no breaker reference, and injecting one to reach it would widen the coupling for a fault
  that already carries its own 5-minute TTL.

Negative controls pinned in `test/ping.test.ts`: a non-200 clears nothing, measurements are never
retracted, and one credential's probe never speaks for another's. **Mutation-checked** — with the
condition disabled the positive test fails and all three controls still pass, which is the correct
signature for a control.

---

## 4. What shipped

| Change | Kind |
|---|---|
| `src/ping/cadence.ts` — probe success retracts cooling facts | behaviour |
| `src/network-block.ts` + `llm-relay eligibility` rendering | new, display-only |
| `test/ping.test.ts` (+4), `test/network-block.test.ts` (+9) | tests |
| `CLAUDE.md` — `network-block.ts` row, `ping/cadence.ts` row | docs |
| `docs/dashboard-package-baseline.json` — `packageEntries` ceiling 340 → 352 | baseline |
| `~/.claude/hooks/worktree-deps-guard.mjs` + registration | MACHINE |
| `~/.claude/scheduled-tasks/nightly-maintenance/run-headless.ps1` — pins its own endpoint | MACHINE |
| `HKCU:\Environment` — stale `ANTHROPIC_BASE_URL` deleted | MACHINE |

The package ceiling was raised **knowingly**: the new module emits exactly three artifacts
(`.js`, `.d.ts`, `.js.map`), 338 → 341, and 352 keeps the same ~3.3% slack the other ceilings use.

⚠ **`packBytes` is now within 0.5% of its own ceiling** (1100459 against 1106200). That is
pre-existing drift, not this lap's doing, and it is recorded rather than raised — the next lap that
adds anything will hit it and should root-cause the growth rather than regenerate the baseline.

---

## 5. The nightly maintenance failure — root-caused

The 2026-08-29 headless nightly run died immediately, exit 1, with a two-line log:

> API returned an empty or malformed response (HTTP 200) — check for a proxy or gateway
> intercepting the request … the non-streaming request was answered with a stream.

**Cause: a User-scope OS variable `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` (headroom) that the
2026-08-09 unwiring never removed.** The `settings.json` entry was deleted then; the OS variable
was not.

Why only the nightly noticed: the Claude launch path force-sets the variable into the process
environment, overriding the User scope — a live interactive session was verified reading
`https://api.anthropic.com`. `run-headless.ps1` invokes `claude.exe` **directly**, with no
launcher, so it inherited the residue and was proxied through headroom — which serves Codex/OpenAI,
not Anthropic. Hence a non-streaming request answered with an event stream.

Nothing depended on the User-scope copy: `scripts/claude-proxied.ps1` and the llm-relay
`routing.cliLane.env` each set the variable explicitly.

Owner decision: delete the variable **and** pin the task. Both done.

⚠ **Windows trap worth keeping:**
`[Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $null, 'User')` does **not** delete
the value — it leaves it present and **empty** in `HKCU:\Environment`, which is a set-but-invalid
base URL rather than an absent one. `Remove-ItemProperty` deletes it. Verify at the registry, not
through `GetEnvironmentVariable`, which reports the empty string indistinguishably from the removal
you intended.

---

## 6. Friction

- **The `posttooluse-typecheck` eslint baseline is line-number sensitive.** A one-line import shift
  surfaced a PRE-EXISTING `sonarjs/no-identical-functions` pair as a NEW finding, because the
  rule's own message embeds a line number ("identical to the one on line 265"). `git show
  HEAD:<file>` confirmed three `makeStream` copies already there. Confirm against HEAD before
  "fixing" what that hook reports.
- **`sync.mjs` measures raw bytes**, so its generated `It is X KB` line varies with a working
  tree's line endings. This worktree's `CLAUDE.md` is CRLF while the main checkout's is LF, giving
  180.2 KB against 179.1 KB for the same commit — and `.gitattributes` declares `* text=auto
  eol=lf`, so the CRLF copy is the deviation. Not fixed: normalizing the measurement would churn
  every project's `AGENTS.md` for a cosmetic number.
- **The shell-conventions guard blocks `cd <dir> && node <generator>`** as a chained generator, so
  generator invocations must run as a bare command from the session cwd.
- **A background Bash task's reported exit code is the pipeline's, not the suite's.** Both gate
  runs reported "exit code 0" while `verify-green` had recorded a FAILING run, because the command
  ended in `| tail`. The ledger is the authority; the wrapper's summary is not.

---

## 7. Remaining, each with its home

- **`AGENTS.md` regeneration** — the committed copy is stale against `CLAUDE.md`. `sync.mjs`
  targets `C:/Code/llm-relay` (the MAIN checkout), never a worktree, so this cannot be completed
  from here. It must run in the main checkout after this lap is pushed. Named in the hand-back.
- **`packBytes` ceiling headroom** — recorded in §4 above; no action this lap.
