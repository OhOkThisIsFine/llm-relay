---
title: "Documentation pass and code tidy — 2026-08-27"
date: 2026-08-27
status: closed
---

# Documentation pass and code tidy — 2026-08-27

A pass over the whole documentation set against source, plus the code tidy it turned up.
Ten parallel auditors (six doc groups, four code dimensions), each finding adversarially
re-verified, then re-checked first-hand before anything was changed.

Released as **v0.50.0**. Commits `f077a4d`..`63248ec`.

## What the numbers were

| | |
|---|---|
| Raw findings from the ten auditors | 76 |
| Survived adversarial verification | 23 |
| Acted on after first-hand re-check | 31 (the 23, plus 8 found directly) |
| Refuted, or judged deliberate and left | 45 |

⚠ **The verification pass was incomplete and the result did not say so.** 43 of the 81 agents
died on a spend limit mid-run, including the synthesis step and roughly twenty verifiers. A
finding whose verifier died carries no verdict, and the run's own filter — `verdict.real === true`
— folded those into the refuted pile, which is where the loss became invisible. Recovering them
meant reading `journal.jsonl` and diffing the raw findings against the confirmed ones: 53 of 76 had
never been judged at all. Eight of those turned out to be real, including two of the most
consequential in the whole pass (the subagent-signal count, and where state actually lives).

**The lesson generalises past this tool.** A fan-out verify stage must distinguish *"the verifier
said no"* from *"the verifier never answered"*. A schema with only `real: boolean` cannot express
the second, so the two collapse into one, and the collapse is silent in exactly the direction that
loses work.

## What was wrong, by class

**Named things that no longer exist.** CLAUDE.md's `circuit-breaker.ts` row opened on
`getMeasuredStability()` and `getHealthyTargets` — neither is in `src/`, and the one surviving
mention of the second is a comment saying deliberately *not* that. Its `benchmarks.ts` row
described a three-rung `getStrength()` including runtime telemetry; `StrengthBasis` has two members
and the source says telemetry deliberately does not appear there. The documented one-test example
matched zero of 2,322 tests. A test comment pointed at an identifier renamed a release earlier.

**Claims that had inverted.** `AGENTS.md` — the file every non-Claude host reads first, and whose
generated region says *text above this region takes precedence* — told them CLAUDE.md and
`project-goals.md` state four rules the owner removed and that "the rewrite is outstanding".
HANDOFF says the opposite: it is applied and both files are authoritative. CLAUDE.md called
`routingEligible` "display-only today" when it is the live gate `quota-demotion.ts` reads.
QUICKSTART told operators to rotate a credential on an `AUTH` verdict, which since `b7d2311` means
no key was present and no request was sent — advice the CLI's own output contradicts.

**Under- and over-stated facts.** `--help` does not short-circuit for `keys` and `cooldowns`. The
npm version check runs only on mutating invocations, not every start. `Retry-After` is clamped to
1 s–15 min, not honoured "exactly". The eligibility tables listed 4 of 6 scopes and 4 of 5
condition verdicts, and gave `provider` the meaning of `credential`. The destructive default
omitted Codex's two tools. The offload key set omitted `openai`. Three live files printed the
pool-attempts tally with `×` where the relay emits ASCII `x`.

**Sections that had become changelogs**, against this project's own rule for them. CLAUDE.md's
"Status & open work" opened on v0.46.0 three releases after it shipped and described v0.42.0,
v0.43.0 and v0.45.0 work as "queued for". HANDOFF carried six more of those, a parenthetical
asserting v0.48.0 "never existed" thirty lines below the entry describing v0.48.0, and listed
C2 N10 as standing nine lines above its own struck-through FIXED entry.

**Links that never worked.** 106 links across two 2026-08-14 design docs were written
repo-root-relative from inside `docs/`, so every one resolved to `docs/src/…` and 404'd from the
day it was written. Three more pointed a `#L397-L401` fragment at a rendered `.md` page, which has
no line anchors.

## The two findings worth reading on their own

**Subagent detection has THREE signals; the design doc documented two.**
`docs/subagent-routing.md` is where CLAUDE.md sends you for the re-verification recipe. It said
"Two independent signals" throughout and never mentioned `x-codex-turn-metadata` at all, and its
capture recipe filtered to `/v1/messages` and read only the marker and the Claude header. So it
could not observe a Codex subagent even in principle: a Codex `/v1/responses` turn has no Anthropic
`system` field, which means that header is not one signal of three for Codex — it is the whole set,
with nothing to fall back on. A recipe that reports "both signals gone" while the only signal Codex
can send is working is worse than no recipe. Now it listens on both fronts and reports all three.

**`~/.llm-relay/` is the answer only when no XDG variable is set.** Twelve resolvers implement
three different policies: `usage/`, `probe-cache.json` and `runtime-telemetry.json` honour
`XDG_CACHE_HOME`; `target-facts.json` and `refusal-interpretations.json` honour `XDG_CONFIG_HOME`;
the other eight honour neither. With either variable set the state directory **splits** —
`XDG_CACHE_HOME` moves the health caches while `models-cache.json` stays, `XDG_CONFIG_HOME` moves
the learned facts while `config.json` and the keystore stay. Nothing is broken, every resolver is
internally consistent, and XDG appeared in no document at all.

**Raised as an owner decision and answered the same day: honour XDG everywhere** (v0.51.0). The
thirteen resolvers collapse into `src/state-paths.ts`. The option's stated cost — that it moves
`config.json`, `.env` and the keystore for anyone with the variable set — is bought off by a
legacy fallback rather than a migration: the legacy path still wins whenever it holds the file and
the XDG one does not, so an existing install keeps reading and writing where it already does, and a
fresh install with XDG set is fully XDG. Nothing is copied, nothing is deleted, and there is no
migration step to forget. `test/state-paths.test.ts` pins the policy through injected seams and
greps `src/` so a fourteenth resolver cannot reintroduce a raw XDG read.

## Code changes

- **`llm-relay eligibility` told the operator six of ten fact kinds meant "gone from the provider —
  excluded from pools".** A three-arm ternary with an unconditional else-branch, so `rate-limited`
  and all five measurements inherited `not-servable`'s meaning. That contradicts the store it
  reads: `COST_BLOCKING` holds exactly `not-servable` and `subscription-required`. Now a
  `Record<FactKind, string>`, so a new kind is a compile error rather than a wrong sentence.
- **Four hand-copied helpers given one owner each** — the byte-identical `SseEvent`/`parseEvent`
  pair in `dialect-stream.ts` and `think-tags.ts` (→ `sse-frames.ts`, with `openai-dialect.ts`'s
  four-point policy difference stated so nobody "finishes" it); the three copies of one
  security-relevant classification in `dashboard-auth.ts`; the closed `EffortLevel` member list,
  restated four times with only one of the four exhaustiveness-checked; and `sameTarget`,
  implemented identically in `circuit-breaker.ts` and `kernel/request-lifecycle.ts`.
- **Four exports with no callers deleted**, two of them carrying comments naming consumers that do
  not exist.
- **Two mechanical doc guards added** — `test/scripts-inventory.test.ts` and
  `test/doc-links.test.ts`. Both confirmed to fail on the pre-fix tree.

## Deliberately not done

- ~~Unifying the XDG resolvers.~~ **DONE** — owner chose "honour XDG everywhere" the same day; see
  above. Kept in this list so the sequence is legible: it was raised as a decision, not silently
  taken.
- **The four large `server.ts` clones** between the Anthropic and OpenAI candidate loops
  (~19–40 lines each). This is the refactor `36de89d` already measured as net +160 lines against a
  −150 forecast, and that `docs/suggestion-review-2026-08-04.md` rejected in its enterprise-shaped
  form. Observed and left.
- **`server.ts:4365 ↔ 4511`** — near-identical attempt-outcome accounting in the streamed and
  buffered repair paths, differing in `logStatus` and in one `recordStickySuccess` call. A shared
  helper would need parameters for both differences; the win does not cover it.
- **`#completed` in `AttemptLifecycle`** is now written and never read, because the `view()` it fed
  was deleted. It records a real lifecycle event; removing the increment is a judgement call beyond
  a tidy.
- **knip's 230 "unused `src/` exports".** knip is configured without tests as consumers, so the
  list is dominated by deliberate test seams. CLAUDE.md's own rule stands: static analysis is
  advisory, and a finding must not be "fixed" by deleting an intentional discard. Only exports with
  zero references *including* tests were removed.
- **`AGENTS.md` links into gitignored `.audit-code/` and `.remediate-code/` paths**, which break on
  a fresh clone. Those blocks are marker regions owned by their installers, and the multi-host sync
  rule forbids editing generated regions by hand. `test/doc-links.test.ts` excludes them
  deliberately, and says so.
- **45 refuted or deliberate findings.** Chief among them: several proposals to shorten dense
  prose, and several "gaps" that are recorded asymmetries.

## Friction

Rewalked from the transcript, not recalled.

- ⚠ **Never run `python -` in the Bash tool on this machine.** `python3 - <<'PY'` and
  `python - <<'PYEOF'` both launched an **interactive REPL** that consumed the heredoc as
  keystrokes and hung to the 2-minute timeout — twice, about four minutes lost, with a screenful of
  `_pyrepl` tracebacks as the only symptom. `python3` is not on PATH, so the fallback ran `python`,
  which has no `-` stdin handling here. Write a `.mjs` file and run it with node.
- ⚠ **The Bash tool is Git Bash, not PowerShell.** A PowerShell here-string
  (`git commit -m @'…'@`) is not a syntax error — it *succeeds*, and produces a commit whose
  subject literally begins with `@`. Caught only by reading `git log` afterwards. Multi-line
  messages need `-F - <<'EOF'`.
- ⚠ **Subagent shells leaked zero-byte junk files into the repo root again** (`2-candidate`,
  `are`), the hazard the standing "stage with explicit pathspecs" rule exists for. Two independent
  auditors reported them, which is the only reason they were noticed before a `git add`.
- **The spend limit is not a graceful degradation.** See the box at the top: it killed 43 of 81
  agents, and the run's result shape could not represent the loss.
- **Chained `sleep` polling is blocked by the harness.** Use `until <check>; do sleep 2; done` with
  `run_in_background`.
- **Mixing `sed -i` and the Edit tool on one file** forces a re-read between them. Workable, but
  pick one per file.
- **The publish workflow's negative test emits a red `::error::` annotation on a SUCCESSFUL run.**
  `Smoke-test the packed artifact` deliberately deletes `docs/tier-data.json` and asserts the
  loader fails; that intentional failure surfaces as `X tier-data.json missing or empty` in the
  run's annotation list, directly under the ✓ that says the job passed. The test is correct and the
  release was fine — but the annotation is indistinguishable at a glance from a real packaging
  failure, and `gh run watch` prints it as the last thing you see. Check the job's `conclusion`,
  not the annotations.
