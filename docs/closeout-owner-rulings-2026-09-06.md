# Closeout — C:\Code\llm-relay

Rendered 2026-09-06T19:18:09.984Z by ~/.agent-config/render-closeout.mjs.
Verification below is rendered from commands, arguments, and the verify-green ledger.

## Identity

- Branch: `main`
- HEAD: `ac6c38046bad7b13a80c651f229e784cdb1e4437`
- Sprint start: `b610dc1`

## Commits in the sprint range

- ac6c380 docs: name the release the Phase 1b completion lap shipped as
- acb2e00 chore: release v0.73.1
- 408c8b1 docs: record the owner's three rulings and what they closed
- 449bf9d refactor(dispatch): one clamp for both absolute-deadline write sites
- 057fca7 fix(dialects): the destructive check runs before the argument check

## Working tree and remote

- Working tree: clean — PASS
- `origin/main` equals HEAD — PASS

## verify-green ledger

- Ledger: `npm run check` recorded 2026-09-06T19:13:54.004Z on tree `16245fee8001`
- `verify-green check`: verify-green: PASS — tree 16245fee8001 matches the passing run recorded 2026-09-06T19:13:54.004Z (npm run check) — PASS

## CI for exact HEAD

- CI: completed/success (run 34054226111) — PASS
  https://github.com/OhOkThisIsFine/llm-relay/actions/runs/34054226111

## Operator-provided narrative (not machine-derived)

# The owner-rulings lap — shipped as v0.73.1

## What this lap did

You ruled on the three questions Phase 1b had left open. Two were built the same lap; the third is
scheduled with its risk written down. **Phase 1b is now closed.**

| Commit | Ruling acted on | Pinning test | Mutation check |
|---|---|---|---|
| `057fca7` | Restore the destructive refusal ahead of the argument check | yes, 6 refusals + 2 controls | yes |
| `449bf9d` | Extract only the surviving cooldown-clamp pair in `dispatch.ts` | existing dispatch suites | n/a, identical by construction |
| `408c8b1` | Schedule the `parseRouting` decomposition; record the rulings | — | — |

## The defect the first ruling fixed, and why it matters beyond itself

`recoverToolCalls` read the calls the four dialect parsers had **committed**, and only then asked
whether any of them named a destructive tool. CLONE-26 (shipped the previous day) made three of
those parsers discard a call whose arguments are not a JSON object — which removed the name from
the matcher's view entirely.

The consequence: a `Bash` call the relay had recognised in model TEXT stopped yielding
`refused-destructive` — 502, blamed on the relay, no failover, no health penalty — and became an
ordinary unparseable envelope: still 502, but blamed upstream, retried across the whole provider
pool, and charged against that provider's health.

Each parser now returns a `DialectScan` carrying every name it RECOGNISED, including names whose
call it discarded, and the refusal reads that list first.

⚠⚠ **The generalisable lesson: a check that reads what an earlier stage COMMITTED inherits that
stage's discard policy as its own trigger condition.** An unrelated parser fix moved a
safety-shaped behaviour. No test failed, no typecheck failed, no gate failed. It surfaced only
because the change was verified afterwards rather than trusted — and even then, only because the
verification asked "what else does this touch" rather than "does the suite still pass".

⚠ **Behaviour change beyond restoring the DeepSeek case, stated rather than left to be found:** a
destructive name with a malformed payload on the Kimi or `<function=NAME>` form now refuses where
it previously fell through. Both move in the ruling's direction. Leaving the four parsers
inconsistent is what let the original defect hide, so consistency is the point rather than a side
effect. The `<tool_call>` form carries its name inside the payload, so an unparseable one
recognises no name at all — containment, not an exemption.

CLONE-26 itself is untouched: a NON-destructive name with a malformed payload still commits nothing
and still fails clean, so failover reaches a host that parses. That is one of the two negative
controls.

## The second ruling, and what it declined

You declined the general claim that one cooldown rule is written out six times, and took only the
pair that survived reading all six sites: `restoreExhaustedRows` and `markExhaustedKey` both clamp
an absolute deadline into the window this relay will hold one for. They differed only in a floor
that is a no-op at the first site, because it already rejects a past deadline one line earlier —
so `clampExhaustedDeadline` is identical by construction, not merely tested to be.

## The third ruling, scheduled rather than done

`parseRouting` will be decomposed in a later lap. It is still cognitive complexity 125; the
HOTSPOT-03 move relocated the hotspot without shrinking it.

⚠ The backlog entry records the risk that actually matters, and it is not size. `parseRouting`
validates sub-blocks in a sequence, and which error an operator sees for a config with two mistakes
depends on that sequence. **A reordering is invisible to the suite** — exactly how the keystore
prologue's precondition order turned out to be uncovered this week, where moving one check past
another left all 94 tests green. Pin the order before splitting, not after.

## Friction hit during the lap

Rewalked from the transcript.

1. **A script writing TypeScript through JavaScript template literals crashed on unescaped
   backticks**, silently leaving the source unmodified — so the suite that ran next was testing the
   OLD code and passed. That is the dangerous shape: a failed edit plus a green suite reads exactly
   like a successful no-op change. The fix is to check the writer's own exit before believing the
   run after it.
2. **A `sed` pattern spanning a line break matched nothing and reported success.** Same class as
   above: the edit silently did not happen.
3. **`shell-conventions-guard.mjs` blocked a generator chained with `&&`** twice more. Verdict
   correct; noted because "run the generator, then check it" is a natural one-liner and must be two
   calls.
4. **The `AskUserQuestion` clarity guard refused the first attempt**, correctly: I used an internal
   catalogue label without explaining it. Rewriting for a cold reader took one pass and made the
   questions genuinely answerable without context.

## Verdict

- All machine-derived sections PASS.
