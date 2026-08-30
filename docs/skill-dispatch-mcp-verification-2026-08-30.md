# Skill installation, dispatch uniformity, and MCP — verification, 2026-08-30

Lap start commit `48282fd`. Baseline green (`npm run build` then `npm run check`, tree
`bcf25e38e7bf`) on a worktree whose `node_modules` was installed first — the empty-worktree trap
HANDOFF §0 records was present again and was closed before any result was recorded.

Three questions, put by the owner:

1. Is the skill installed correctly, with instructions an agent can act on, and is it generated
   from a single source of truth?
2. Does an agent dispatch through llm-relay with **one** syntax in every case, so it never needs to
   know whether the mechanism is a CLI, a proxy, or something else?
3. Does MCP make sense here? Assess fresh — the 2026-08-16 rejection covered a different situation.

---

## 1. Skill installation — PASS

**The mechanism.** `scripts/install-skill.mjs` copies one shipped file to exactly two hosts:

- `skills/llm-relay/SKILL.md` → `~/.claude/skills/llm-relay/SKILL.md`
- `skills/llm-relay/SKILL.md` → `~/.codex/skills/llm-relay/SKILL.md`

The copy is `copyFileSync` (`scripts/install-skill.mjs:135-141`), so it is byte-for-byte. Host
failures are independent by design (`:132-134`): a broken `~/.claude` must not stop Codex getting
the same file.

**Verified live.** MD5 of all three:

| File | MD5 | Bytes |
|---|---|---|
| When | Source | `~/.claude` copy | `~/.codex` copy |
|---|---|---|---|
| At lap start (`48282fd`) | `8aa883fe…` | `8aa883fe…` | `8aa883fe…` |
| After v0.61.0 shipped and the global bin was reinstalled | `8e08061d…` | `8e08061d…` | `8e08061d…` |

The two installed copies are identical to the source. The installation is correct.

⚠ **Both rows are stated because the first went stale inside this lap, and the independent closeout
auditor caught it.** An earlier draft quoted only `8aa883fe…`. Commit `9d09691` then edited
`SKILL.md` (Fix 2), so that hash described a file that no longer existed by the time the document
was read. The conclusion survived and is in fact **stronger** at the second row: the three copies
agree again at a NEW hash, which shows the whole pipeline works end to end — edit, publish,
`npm i -g`, postinstall, both hosts refreshed. A measured figure must be re-measured after anything
in the same lap changes what it measured.

**Guards that hold.**

- Global-only: a repo-local `npm install` never touches the operator's host directories
  (`:118-120`). Two independent signals decide "global" (`:110-117`), so an npm version change
  cannot silently disable it.
- Fail-open but never silent: every abnormal path prints a reason on stderr and exits 0
  (`:16-22`, `:147-152`). `package.json` `postinstall` carries a second message if the hook itself
  crashes.
- `package.json` `files` ships both `skills` and `scripts/install-skill.mjs`.
- `test/install-skill.test.ts` (160 lines, 7 cases) pins: the local no-op, both hosts on a global
  install, `--force`, idempotency, Codex config preservation, exit 0 with an explanation, and one
  host installing when the other directory is broken.

**Two hosts is the complete and correct answer for this repository.** An earlier draft filed the
stale OpenCode copy as a repo gap. Adversarial review refuted that, and a direct check confirms the
refutation: `README.md`, `CLAUDE.md`, `docs/reference.md` and `SKILL.md` contain **zero** mentions
of OpenCode. The repo never declared, documented, tested or shipped OpenCode as a skill host. The
observation is real but belongs to the machine, and it moved to section 5.

---

## 2. Single source of truth — TRUE for the skill file, FALSE for instruction content

**The skill file itself is single-source and test-pinned.** One file, two byte-identical copies,
one test asserting it.

**Agent-facing instruction content is not.** A second, independent copy lives inside the installer:

- `scripts/install-skill.mjs:35` — `CODEX_PROVIDER_BLOCK` hardcodes
  `base_url = "http://127.0.0.1:8791/v1"`.
- `scripts/install-skill.mjs:39-44` — `CODEX_AGENTS` hardcodes `model = "pool/medium"` and two
  `developer_instructions` strings that tell a Codex child how to behave.

⚠ **Correction, after adversarial review.** An earlier draft of this section said those literals
were "pinned against nothing". That was false, and the review refuted it with the assertions.
`test/install-skill.test.ts:74-75` and `:112` DO pin them:

```ts
expect(readFileSync(paths.codexConfig, "utf8")).toContain('base_url = "http://127.0.0.1:8791/v1"');
expect(readFileSync(paths.defaultAgent, "utf8")).toContain('model = "pool/medium"');
```

The accurate, narrower claim is this: those literals are **self-pinned only**. The test asserts the
installer still writes the same string it always wrote. Nothing cross-checks them against
`SKILL.md`'s own prose, against `DEFAULT_CONFIG_TEMPLATE`, or against the pool names the config
actually defines. That is a genuine but modest single-source gap — not an absent pin.

**Consistency tests that DO exist** (all verified by reading the assertions, not the summaries):

| Test | Pins |
|---|---|
| `test/destructive-coverage.test.ts:145` | `config.example.json` `repair.destructiveTools` **equals** `DEFAULT_DESTRUCTIVE` |
| `test/destructive-coverage.test.ts:149-152` | the `src/cli.ts` config template against the same constant |
| `test/architecture-map.test.ts` | the `CLAUDE.md` architecture table against the real `src/` tree |
| `test/scripts-inventory.test.ts` | `scripts/CLAUDE.md` against the real `scripts/` directory |
| `test/install-skill.test.ts` | byte identity of the two installed skill copies |

**The gap that matters for this lap:** no test pins `SKILL.md` against the CLI surface it teaches.
Finding 3 is an instance of exactly that drift.

---

## 3. Dispatch uniformity — FAIL

The owner's requirement: *"in order for an agent to dispatch via llm-relay, they shouldn't need to
know the difference between a CLI or proxy or whatever … they dispatch with the same syntax to
llm-relay in all cases, and llm-relay makes it consistent."*

The design already intends this. `skills/llm-relay/SKILL.md:292` is headed **"One verb,
host-adapted"** and states: *"`llm-relay dispatch -t "<task>"` is the **only** thing you need to
ask, from any harness. Do not branch on which one you are in."*

**The ask is one verb. The answer is not one action.**

### 3a. The correct headless form is `--next-command`, and the machine instructions name the wrong flag

`llm-relay help:30` documents `llm-relay dispatch --next-command -t <task>` — *"Print only the
runnable command for the next lane."* Measured on this host, it returns **one command, 890 bytes**.
That is the uniform surface.

The global `~/.claude/CLAUDE.md` instead tells every agent on this machine:

```
llm-relay dispatch -t "<task>"      # headless — hands you the first ready lane's command
```

Measured, `-t` prints **the whole ladder: 7305 bytes**, ten rungs with notes, ending in a `use:`
line that names a lane but does not isolate its command. The agent must then scan back up the
output and find that lane's block. The comment is wrong about what the flag does, and it costs
roughly 1800 tokens per dispatch instead of about 220.

### 3b. On a routed host the single-verb form fails outright

Measured with an explicit host override:

```
$ llm-relay dispatch --next-command -t "x" --host routed
llm-relay dispatch: lane "claude-free-pool" is a relay target (pool/medium), not a command
exit=2
```

**Cause.** `src/dispatch.ts:692-693`:

```ts
const bypassed = host === "bypassed";
if (!bypassed) {
  lane.requiresDirective = !offloadRule(cfg, client).enabled;
} else if (!reachableWithoutRelay(rung.spec, cfg)) {
  … lane.invoke = transposeToCli(…); lane.transposed = true;
```

Transposition through `routing.cliLane` runs **only when the host is bypassed**. A routed host
keeps every relay rung as a `target:` spec. `src/cli.ts:2139-2143` then refuses to print a command,
with an honest comment: *"there is no command to print and inventing one would be a lie about the
mechanism."*

**Consequence.** An agent on a routed host must run the verb, detect exit code 2, understand that
"relay target" means a different mechanism, and switch from Bash to the Agent tool. That is
precisely the CLI-versus-proxy distinction the requirement says an agent should never need to make.

⚠ An earlier draft added a fifth step, "re-query with `--json` to recover the spec". Adversarial
review struck it correctly: the spec is already inline in the stderr text
(`… is a relay target (pool/medium), not a command`). No second call is needed.

### 3b-ii. The same failure is the DEFAULT for any host with no Claude harness — and there it is a logic defect

Found by adversarial review, then verified directly. **No override is needed to reproduce it:**

```
$ env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u ANTHROPIC_BASE_URL llm-relay dispatch --next-command -t "x"
llm-relay dispatch: lane "claude-free-pool" is a relay target (pool/medium), not a command
exit=2
```

**Two modules disagree about what `unknown` means.**

`src/host-routing.ts:86-92` classifies any shell without `CLAUDECODE` as `unknown`, and states the
reason in its own words:

```ts
return {
  state: "unknown",
  entrypoint,
  reason: "not running inside a Claude Code session — no subagent routing to adapt to",
};
```

`src/host-routing.ts:23` says the same again: *"`unknown` — not a Claude harness at all, so there is
no subagent mechanism to adapt to."*

But `src/dispatch.ts:692` asks only `host === "bypassed"`. `unknown` is therefore `!bypassed`, takes
the same branch as `routed`, is never transposed, and comes back as a `target:` spec — **a spec to
address as a subagent, handed to a host the classifier has just declared has no subagent
mechanism.**

**Why this is materially worse than 3b.** A routed interactive session that gets exit 2 has a
legitimate fallback: call the Agent tool, which `routing.subagents` reroutes in-process. A headless
caller has no Agent tool at all. Every cron job, every CI step, `run-headless.ps1`, and the nightly
maintenance task hits this path by default, and the only escape found was `--after <lane-id>`, which
requires already knowing the id of the rung to skip — reintroducing exactly the advance knowledge of
mechanism that the requirement forbids.

This is no longer a documentation or ergonomics gap. It is two modules holding different definitions
of one closed vocabulary member, with the fall-through resolving to the **stronger** claim ("you can
reach this as a subagent") — the same shape as the closed-vocabulary defect class `CLAUDE.md`
already documents eight times.

**Severity correction, found while checking test coverage.** The only consumer of
`--next-command` inside this repo is the generated `PreToolUse(Agent)` hook, and
`src/claude-hook.ts:120` passes **`--host bypassed` as a hardcoded argument**:

```js
const args = [cliScript, "dispatch", "--next-command", "-t", task, "--host", "bypassed", "--client", "claude"];
```

Forcing `bypassed` forces transposition, so the hook can never reach the exit-2 path. The hook is
correct, and the exit-2 path is therefore unreachable from the only in-repo caller.

Two consequences follow, and they pull in opposite directions:

- **The defect is narrower than first stated.** It bites only an agent that runs the verb by hand
  from a genuinely routed session. It does not break the hook, and it does not break this machine
  today, which is bypassed.
- **A workaround already exists in the codebase and is undocumented for agents.** Passing
  `--host bypassed` always yields a runnable command. `SKILL.md` never mentions this. But it is
  also not correct advice in general: on a genuinely routed host with offload ON, an ordinary
  `Agent()` call is rerouted by `routing.subagents` in-process, which is cheaper and faster than
  spawning a `claude -p` child. Telling agents to force `bypassed` would trade correctness for
  uniformity.

So the honest problem is not "the relay refuses to print a command". It is that **the verb returns
its answer as an exit code plus a re-query**, when it could return one machine-readable answer that
names the mechanism. That framing preserves the refusal comment's principle — never invent a
command — while still giving the agent one call and one contract.

### 3c. The residual branch the skill itself documents

`SKILL.md:307` tells the agent: *"A `run:` line is for you to execute (Bash). A `target:` line is a
spec to address as a subagent."* The skill is honest, and that honesty is the proof: the agent is
told to branch on mechanism.

### 3d. A third mechanism exists that the verb never reports at all

Every Codex rung is disabled. Verified against `~/.llm-relay/config.json`: `codex-sol`,
`codex-spark`, `codex-terra` and `codex-luna` are `enabled: false` in all four tiers — 14 rungs.
The owner disabled them on 2026-08-27 because the first-party `openai/codex-plugin-cc` plugin took
ownership of Codex dispatch. Revert file: `config.json.bak-2026-08-27-pre-codex-to-plugin`.

That decision is sound on its own terms. Its effect on THIS requirement is not:

| Lane | How an agent must reach it |
|---|---|
| `claude-free-pool`, `openrouter-deepseek`, the `agy` rungs | `run:` — execute a shell command |
| `anthropic` on a routed host | `target:` — call the Agent tool |
| **Codex** | **neither — a separate plugin's skill, outside the verb** |

So an agent that asks the one verb is never told Codex is reachable. The uniform surface now has
three mechanisms behind it, and reports two.

⚠ This is a MACHINE-configuration consequence, not a repo defect. The repo behaves correctly: a
disabled rung is correctly withheld. It is recorded here because it bears directly on whether the
owner's stated requirement is met on this machine today.

---

## 4. MCP — provisional assessment, to be attacked

The 2026-08-16 ledger (`docs/rejection-ledger-2026-08-16.md:27`) rejected a "hand-rolled MCP
server" because it "duplicates data the admin routes already serve", with the reversal condition
"a client exists that can only speak MCP". The owner has directed that this question be reopened
fresh, because the situation differs.

**What changed since 2026-08-16.**

- freellmapi was retired 2026-08-29. llm-relay is now the only free-provider offload runtime on
  this machine, so its dispatch surface is load-bearing for every host rather than one of two.
- All four hosts can now call MCP tools. Antigravity's `mcp(*)` permission was proven working
  2026-08-27. Codex ships `codex mcp` client config. OpenCode loads plugins. Claude Code has
  first-class MCP support.
- The dispatch ladder grew wrapper commands (`lane-launch.ps1`) and long environment prefixes, so
  the shell-quoting surface an agent must handle is larger than it was.

**The case FOR a narrow MCP server.** It is the only mechanism that makes the *answer* uniform, not
just the question. A single tool — `dispatch(task)` — has the same call shape from every host, has
no shell quoting at all (JSON over stdio), and can return a result rather than a command the caller
must then execute correctly. It would close finding 3 structurally rather than by convention.

**The case AGAINST.**

- The stated dependency budget is three runtime dependencies, and `CLAUDE.md` names "no second
  implementation of anything" as an invariant. An MCP SDK is a fourth.
- `docs/backlog.md` records `packBytes` at 1100462 against a 1106200 ceiling — 0.5% headroom. An
  SDK does not fit.
- Read tools (`candidates`, `cost`, `pools`) would genuinely duplicate the admin routes, which is
  the 2026-08-16 objection and is still correct for that subset.
- A tool that EXECUTES a lane sits next to the invariant "the request path never spawns a `cli`
  rung". Whether it crosses that line depends on whether a host-launched stdio child counts as
  "the relay" — the invariant's stated reasons are about an HTTP turn owing `tool_use` blocks to
  its caller, which an MCP tool call does not owe.

### 4.1 VERDICT after adversarial review — do NOT build an MCP server

The review invalidated **two of the three arguments against** MCP that this section first made. Both
corrections are recorded here, because a verdict must not survive on reasoning that does not hold.

- ❌ **"An MCP SDK is a fourth dependency" — invalid.** MCP is JSON-RPC 2.0 over stdio: `initialize`,
  `tools/list`, `tools/call`. This repo already hand-rolls `sse-frames.ts`, four SSE parsers,
  `openai-request.ts` and `responses-request.ts` rather than import a large protocol library. A
  minimal `src/mcp.ts` needs **zero** new dependencies. The real objection is different and narrower:
  hand-rolling means owning a spec that moves — the maintenance-treadmill reasoning already used to
  reject per-provider adapters.
- ❌ **"`packBytes` does not fit" — invalid.** `packBytes` is a **ceiling** metric, not an exact one,
  and `docs/backlog.md:12-15` explicitly contemplates regenerating it. The recorded baseline is
  **1100459** against 1106200 (`docs/dashboard-package-baseline.json:18,24`); this document's earlier
  figure of 1100462 was the current build's measurement, not the baseline. Either way, size is not
  the blocker.

**The decisive fact, which this section originally missed.** A fresh install has **no dispatch
ladder at all**. Verified three ways:

| Where a ladder could ship | `ladder` / `cliLane` occurrences |
|---|---|
| `DEFAULT_CONFIG_TEMPLATE`, `src/cli.ts:392-483` | **0** |
| `config.example.json` | **0** |
| `src/onboarding.ts` | **0** |

So on a stranger's install, `llm-relay dispatch` returns `next: null` with the reason *"no
routing.ladder configured — dispatch order is the host's to choose"* (`src/dispatch.ts:812-813`).

`docs/project-goals.md` makes "this installation first" the first rubric test, and requires that
`README.md` plus `llm-relay onboard` suffice for a stranger. An MCP `dispatch()` tool would ship to
every installer and **do nothing for anyone except this machine**, whose CLI already works. That is
a rubric-1 failure by definition. It sinks the cheaper `cliLane` alternative for exactly the same
reason: transposition needs a `routing.cliLane` a fresh install does not have.

**Why there is no middle design.** An MCP dispatch tool is one of two things, and both fail:

- **A tool that RETURNS a command** is a read tool. It reads `/dispatch` and relays the same
  two-kind union (`invoke` or `spec`, `src/dispatch.ts:81,83`) as JSON. The branch moves into the
  tool result; nothing is unified. This falls squarely inside the 2026-08-16 objection, which this
  section had wrongly scoped to `candidates`/`cost`/`pools` only.
- **A tool that EXECUTES the lane** is a new spawn site, and it brings problems the relay has never
  had to answer. The sharpest is the **working directory**: a dispatched lane is a coding task, so
  `claude -p` and `agy.exe` must run in the user's repo. Today the host runs the command in its own
  cwd, which is why `DispatchLane.invoke` carries `command`/`args`/`env` and **no `cwd`**. An
  executing tool would have to accept a filesystem path from a caller and spawn a process there —
  a strictly larger version of the hazard `src/dispatch.ts:359-371` already refuses, where request
  content may not become process configuration.

**Three further costs of the executing variant**, each grounded in this repo's own record:

1. **It removes the spawn from the harness's permission gate.** Today the agent runs the lane
   through Bash, so the operator sees `claude -p --permission-mode acceptEdits` in the transcript.
   Approve one MCP tool once and every later spawn is invisible. A project that refuses to
   *fabricate* a `Bash` call should not quietly acquire the power to *spawn* one.
2. **Long lanes have no representation.** agy runs at `--print-timeout 30m`. A 30-minute
   `tools/call` exceeds every host's default tool timeout, and the fix is a job handle plus polling
   plus a status store — the shape `docs/suggestion-review-2026-08-04.md:87-93` already rejected.
3. **It is precisely the future async spawn site the repo warned about.**
   `docs/quota-reprobe-design-2026-08-29.md:200-203` records two Windows spawn traps that each cost
   a fix release, that **the suite could not catch**, and ends: *"A future async spawn site should
   copy `runLaneCommand` whole."*

**The invariant question splits by transport, and that split is itself evidence against.**

- **MCP over HTTP/SSE on the daemon** — a **violation**. The `/ping` precedent is directly on point:
  `docs/quota-reprobe-design-2026-08-29.md:98-101` records that a cadence hook firing from
  `tickOnce` was judged a violation and fixed the same night, because the admitted `GET /ping` route
  also calls it, *"so an HTTP request could initiate lane work"*. On this project's own operative
  reading, "the request path" means anything a caller can initiate.
- **MCP over stdio, launched by the host** — outside the invariant's stated scope. It is not the
  daemon, answers no HTTP turn, and spends the host's own client-bound quota from a host-owned
  process.

A proposal whose invariant answer depends on a transport choice it has not yet made is not minimal.

**The five-test rubric** (`docs/project-goals.md:33-48`): this installation first — **fail** (does
nothing on a fresh install); transparency — **fail** (opaque 30-minute calls, spawns the permission
gate cannot see); minimal mechanism — **fail** (a third front door beside the CLI and the admin
routes); provenance — **weak fail** (returning another agent's text as an llm-relay result softens
`src/dispatch.ts:15`'s "never pretends a CLI answered"); toward boring — **fail**.

### 4.2 The strongest argument FOR MCP, stated fairly

It is not the one this section originally made, and the owner should see it before accepting the
verdict.

**Antigravity has no shell, and Antigravity can call MCP tools.** `command(*)` was revoked from
agy's settings on 2026-08-11 and that revocation stands; `mcp(*)` is in its live allow list and was
proven working on 2026-08-27. For an agy session, a printed command is **structurally unusable** —
agy cannot execute it — and agy has no subagent tool either. An agy session that wants to delegate
has **zero** mechanisms today. MCP is the only one that could exist. That argument passes rubric
test 1 on measured evidence.

**Why it does not carry the verdict, stated so it can be overruled:**

1. It reverses a deliberate security decision through a side door. agy's shell was revoked on
   purpose — the accepted cost of making the offload lanes read-only. An MCP `dispatch(task)` that
   spawns `claude -p --permission-mode acceptEdits` would give a host that cannot run `ls` the power
   to spawn a **writing agent**. That is strictly larger than the capability removed.
2. No record treats agy as an orchestrating host here. Every record treats it as a lane at the
   bottom of ladders — the delegatee, never the delegator.
3. agy holds `read_url(*)`, so it can already ask `GET /dispatch?task=…`. What it lacks is the
   ability to execute, which is exactly what was revoked on purpose.

**This is a live owner question, not a settled one.** If the requirement is that agy must be able to
*delegate*, MCP becomes the right answer and this verdict reverses.

### 4.3 Recorded reversal conditions

Any one of these, verified, reopens the question:

1. The owner states that a shell-less host (agy, or any other) must be able to **delegate**, not
   only be delegated to.
2. A host appears that llm-relay must serve and that can **only** speak MCP — the 2026-08-16
   ledger's own stated condition, which remains unmet: Claude Code, Codex and OpenCode all run
   shell commands.
3. A measured **failure rate** for the CLI path that a JSON-RPC surface demonstrably fixes. Nothing
   here measures a failure; finding 3a measures token overhead caused by a wrong flag name in a
   machine file.
4. A shipped default ladder and `cliLane`, so dispatch means something on a fresh install. This
   does not justify MCP by itself, but without it **no** dispatch-uniformity work can pass rubric
   test 1.

### 4.4 The deepest point, which no amount of relay-side work can fix

If the relay does not execute, the **caller** must. An agent harness has exactly two executors: the
shell, and its own subagent tool. Those are different host capabilities. No relay-side cleverness
collapses them. The relay can make the answer uniform only by always choosing the shell — which is
the heavier mechanism, and which `src/dispatch.ts:454-457` already argues against — or by executing
itself, which is a new process model.

**The non-uniformity lives in the hosts, not in llm-relay.** What llm-relay can and should fix is
narrower: give the caller **one call and one stable contract**, so the branch is cheap, explicit and
correct — rather than an exit code plus an inference.

---

## 4.5 What was FIXED in this lap

### Fix 1 — `src/dispatch.ts`: a stated `unknown` host is no longer treated as `routed`

The gate `host === "bypassed"` became two named predicates plus one reason function, so the
decision has one home and a
maintainer adding a host state is looking straight at it:

- `canAddressAsSubagent(host)` — true for `routed` and for an **absent** verdict.
- `mustTransposeEveryRung(host)` — true only for a stated `unknown`, which has no subagent
  mechanism of any kind, so even the plain Anthropic passthrough must be transposed.
- `unreachableReason(host, who)` — names the real condition. Telling a cron job it *"does not route
  its traffic through this relay"* described a Claude-harness problem it does not have and pointed
  at a fix that would not help it.

⚠ **An ABSENT host verdict is deliberately NOT treated as `unknown`.** `buildDispatch` collapses
absent into `"unknown"` for the rendered view, so the lane builder is now passed `opts.host`
directly. A caller that stated nothing keeps the pre-existing path; the CLI always states one, so
this costs real callers nothing and the pinned backward-compatibility test at
`test/host-adaptive-dispatch.test.ts:218` still passes unchanged.

**Verification.** Six new tests: **two** genuine negative controls (`bypassed` keeps the per-spec
test; `routed` unchanged) plus four that verify the new behaviour. ⚠ An earlier draft called
`requiresDirective` never set for `unknown` a third negative control. The auditor refuted that
correctly: before the fix, `unknown` took the `routed` branch and DID set `requiresDirective`, so
that test verifies changed behaviour and is not a control for anything untouched.
**Mutation-checked**: with
`mustTransposeEveryRung` forced to `false`, exactly the two dependent tests failed — the two that
should. Live, on the local path with `CLAUDECODE` unset:

```
before: exit 2, lane "claude-free-pool" is a relay target (pool/medium), not a command
after:  exit 0, one runnable `claude -p … --model pool/medium …` command line
```

⚠ **The fix reaches a live host only after the relay restarts onto it.** The CLI is answered by the
running relay over HTTP, so a relay predating this change still returns the untransposed lane and
the CLI still exits 2. That is expected for a server-side change and the release step handles it,
but it is worth stating: this is exactly the wire-skew hazard the review flagged.

### Fix 2 — `skills/llm-relay/SKILL.md`: the "One verb" section now leads with the acting flag

`SKILL.md:348-350` was already accurate about both flags. What was wrong is that the **"One verb,
host-adapted"** section led with `-t`, the survey form, for an agent whose intent is to act. It now
leads with `--next-command`, states the roughly eightfold token difference, and gives the two
outcomes as an explicit contract table — including the fact that exit 2 cannot occur on a
harness-less host, which is what Fix 1 guarantees.

**Gate after both fixes:** `npm run build` then `npm run check` green on tree `19106e4dc92f`.
`packBytes` 1101934 against the 1106200 ceiling — the skill addition cost 1475 bytes and left 4266.

---

## 5. Machine-scoped observations (not repo defects)

### 5a. The OpenCode skill copy is stale, and no tool on this machine owns it

`~/.config/opencode/skills/llm-relay/SKILL.md` is MD5 `3cf646cc04c688b66bda58c657470dcb`, 39285
bytes, dated 2026-08-25. The shipped source is 41160 bytes. The copy is **1875 bytes behind**.

Two machine policies each assume the other covers it:

- `scripts/install-skill.mjs:126-130` declares exactly two targets, correctly — this repo makes no
  OpenCode promise.
- The machine-wide mirror `~/.agent-config/skills-sync.mjs` deliberately skips installer-owned
  skill directories, and `llm-relay` is named as one.

So an OpenCode session reads five-day-stale instructions, and nothing reports it. The fix is an
owner decision at the machine layer: refresh the copy, delete it, or add OpenCode as a third
installer target. It is not a repo defect as things stand.

### 5b. Stored mojibake in the live config

- `~/.llm-relay/config.json` contains stored mojibake: 40 occurrences of the UTF-8 encoding of
  `â€`. Lane notes render as `Codex Sol â€” snapshot strength` and `âš ` instead of `⚠`. Some notes
  are clean, so the corruption is in the stored data, not the output path. Repairing it is a
  machine-config task, not a repo change.

### 5c. Every Codex rung is disabled, so the one verb never reports Codex

See §3d. An owner decision from 2026-08-27, correct on its own terms; its effect on the uniformity
requirement is that a third mechanism exists outside the verb entirely.

### 5d. `~/.claude/CLAUDE.md:13` names the wrong flag

```
llm-relay dispatch -t "<task>"      # headless — hands you the first ready lane's command
```

Measured: `-t` prints the whole ladder (7305 bytes) and ends with a `use:` line naming a lane, not
its command. `--next-command` is the flag that does what the comment describes, at roughly one
eighth the tokens. Every agent on this machine reads this line. It is the highest
value-to-cost item found in the whole lap, and it is a **machine** change, not a repo one.

---

## 6. Owner decisions — none of these were taken unilaterally

Four questions this lap surfaced. Each is scoped, and none is a defect.

**D1. Should `~/.claude/CLAUDE.md:13` be corrected to `--next-command`?** Machine layer. Zero code.
Saves roughly 1600 tokens per dispatch for every agent on this machine, and stops them reading a
description that does not match the flag. *Recommended: yes.*

**D2. Should a minimal `routing.ladder` + `routing.cliLane` ship in `DEFAULT_CONFIG_TEMPLATE`?**
Repo, and the largest question here. Today `llm-relay dispatch` is inert on a stranger's install,
so `docs/project-goals.md`'s first rubric test cannot be passed by any dispatch work — this lap's
fix included. Against it: a shipped ladder makes claims about lanes a stranger may not have
installed, and `test/first-run.test.ts` pins the current template deliberately.

**D3. Should OpenCode become a third `install-skill.mjs` target?** Repo, but scope expansion rather
than a defect — the repo has never promised OpenCode, and the two adversarial reviewers disagreed
on this exact point. The stale copy at `~/.config/opencode/skills/llm-relay/SKILL.md` is real
either way; it can equally be deleted or refreshed by hand at the machine layer.

**D4. Must agy be able to DELEGATE, or only be delegated to?** This is the one that reverses the
MCP verdict. agy has no shell and does have `mcp(*)`, so an agy session that wants to hand off work
has no mechanism at all today, and MCP is the only one that could exist. Building it would hand a
host that cannot run `ls` the power to spawn a writing agent — reversing a deliberate 2026-08-11
security decision through a side door. Worth doing only if agy orchestrating is a real requirement,
and no record so far treats agy as anything but a lane.

---

## 7. Friction log (rewalked from the transcript, not recalled)

1. **`npm run check` fails with a raw ENOENT stack when the build has not run.**
   `scripts/dashboard-package-check.mjs:15` reads `dist/dashboard/.vite/dashboard-bundle-graph.json`
   and throws an unhandled `ENOENT` with a Node stack trace. Nothing says "run `npm run build`
   first". This cost a full verify-green cycle at lap start. `CLAUDE.md` does say to run
   `npm run build && npm run check`, so the knowledge exists — it is the ERROR that does not carry
   it. **Worth a one-line guard** that names the missing build. Candidate backlog item.
2. **The empty-worktree trap recurred**, exactly as HANDOFF §0 predicted. The SessionStart hook
   warned, and the warning was correct and load-bearing: `node_modules` held zero packages. The
   hook did its job; this is recorded to confirm the guard works, not as a complaint.
3. **A server-side fix is invisible to a local CLI test until the relay restarts.** The CLI asks the
   running relay over HTTP, so the first live verification of Fix 1 showed the OLD behaviour with
   the NEW binary. Diagnosing that took a config copy on a dead port to force the local path. The
   `--config` escape works but is not documented for this purpose.
4. **`posttooluse-typecheck.mjs` blocks on an unavoidable intermediate state.** Extracting three
   helpers is naturally two edits — define, then wire — and the hook failed the first with
   `no-unused-vars` on functions that were about to be used. It also correctly caught that my change
   raised `toLane`'s cognitive complexity, which is what prompted the extraction. Net positive, but
   a multi-edit refactor costs one blocked call per intermediate step.
5. **Agent recon must be verified, and verifying it paid off every time.** The source-of-truth recon
   missed `test/destructive-coverage.test.ts:138-152`, which reads `config.example.json` — the exact
   assertion that decided a claim. Three of this document's own claims were wrong until adversarial
   review broke them, and two of the three *reviews* also contained inaccuracies. Nothing here
   survived on an agent's summary alone.
6. **Stored mojibake makes `dispatch` output hard to read** on this machine — see §5b.
