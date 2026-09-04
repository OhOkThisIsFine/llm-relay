# Dispatch lanes and ordering

Read this reference when choosing a lane deliberately, diagnosing dispatch execution, or changing
the ladder. Ordinary delegation needs only MCP `dispatch`.

## Choosing a target

```bash
llm-relay candidates         # one row per offload target, all dimensions side by side
```

The table keeps every raw dimension visible — capability from each leaderboard separately (AA
agentic/coding, BFCL tool-use, Aider polyglot, LMArena), price, context, live health (verdict,
p95), quota, breaker state, and traffic observed through this proxy. Pool ordering is transparent:

- `raw` is fixed at 40% agentic/tool use, 35% coding, and 25% general reasoning. Source values use
  persisted calibration anchors; a wholly missing dimension is estimated from overlapping models
  instead of disappearing from the denominator. Specialized Design Arena categories, BFCL
  irrelevance, and Aider formatting are task-fit signals, not capability.
- Automatic membership uses whole-point capability floors, an exact SKU match, and at least three
  published capability/task-fit signals. A member is retained until two points below its floor to
  prevent refresh flapping. Confidence never lowers a strong model below a floor.
- `cap` is the confidence-adjusted capability used for ordering. Direct dimension coverage,
  published capability signals, and imputation quality determine confidence; fuzzy matches get
  half confidence. `/4c5p` means four direct capability signals and five total publications;
  `neut` means no capability evidence.
- `fit` orders a pool: 75% `cap`, 20% deployment operations, 5% task-fit metadata. Operations use
  measured probe stability plus success/speed/recency from at least five real calls. Metadata uses
  exact-SKU tool support, the separate task-fit benchmark score, and provider/reference
  context/output limits. Unknown inputs are neutral, never zero. Known tool incompatibility is
  excluded from automatic effort pools; breaker-open and credential-faulted targets are demoted
  rather than averaged away.
- `~` on ctx/$ means the figure belongs to a **different host** serving the same model id
  (e.g. NIM publishes nothing, so OpenRouter's numbers are shown as reference). Never quote a `~`
  figure as the serving provider's real ceiling or rate.
- Capability is synced (`npm run sync:tiers` in the repo), never hand-typed.

`GET 127.0.0.1:8791/candidates` returns one deployment × credential-slot row with `credentialId`,
policy/state/modelAllowed, quota, breaker, learned facts, raw scores, jitter, and observed calls.

## The dispatch ladder — including agent-CLI lanes (Antigravity, Codex)

Subscription and CLI-credit quotas are **client-bound**: only the vendor's own client can spend
them, so the relay cannot front them as providers (Antigravity's endpoint is compiled into its
binary; Codex's ChatGPT path uses client-bound OAuth on `/v1/responses`). They are still dispatch
targets — the host agent reaches them by shelling out to the vendor CLI, and they participate in
**one ordered ladder** together with the relay's pools. Walk it top to bottom; each rung falls
back to the next on failure or quota exhaustion, exactly like candidates inside a relay pool.

### The lanes, and how to drive each

- **Relay pools** — `@relay: pool/medium` on a subagent prompt, or the tier mapping in
  `routing.subagents` when the originating client's offload rule is on. Spends provider API keys. *Exhausted when:* the pool
  4xx/5xxs after failover walks every candidate, or `llm-relay candidates` shows the breaker open
  / quota drained across the pool.
  ⚠ Reaching a pool this way requires the dispatching session's own HTTP traffic to traverse the
  relay. **Claude Desktop sessions do not** — the Desktop launcher pins `ANTHROPIC_BASE_URL` to
  `api.anthropic.com` and no setting overrides it — so from a Desktop session a subagent
  `@relay:` directive silently reaches real Anthropic (the directive line goes to the model as
  prompt text). **You do not have to detect this or work around it**: `llm-relay dispatch`
  classifies the calling host and hands back a shell-out for any lane a subagent cannot reach.
  See "One verb, host-adapted" below.
- **Claude CLI (relay-routed)** — a `cli` rung running `claude -p "<task>" --model pool/<name>`
  with rung `env` setting `ANTHROPIC_BASE_URL` to the relay, `ANTHROPIC_AUTH_TOKEN=dummy`, an
  isolated absolute `CLAUDE_CONFIG_DIR`, and `null`-unsetting `CLAUDECODE`,
  `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`, `ANTHROPIC_API_KEY` (a child spawned inside
  a Claude session inherits those and refuses to start cleanly). A terminal-spawned `claude`
  honours the env var even though Desktop pins its own sessions, so **shelling out IS the
  redirect** — this is how a Desktop session reaches relay pools at all. Spends the pool's
  provider keys, with the relay's ranking/failover/repair in the path. *Exhausted when:* the
  pool it addresses is (same signals as Relay pools).
- **Antigravity (`agy`)** — `agy -p "<task>" --model <id> --output-format json` (`agy.exe` on
  Windows). The dispatch API automatically changes a configured bare `agy` to `agy.exe` on
  Windows so a same-named PowerShell function cannot open the IDE instead of the headless CLI.
  Explicit command paths are preserved. Ask `agy models` (`agy.exe models` on Windows) for the
  roster; ids may carry a reasoning-level suffix (`…-high|-medium|-low`),
  and `--effort low|medium|high` tunes ids that don't. Other flags: `--add-dir <path>` to scope
  the workspace, `--json-schema` for structured output, `--print-timeout` (default 5m),
  `--mode plan` for analysis-only runs. ⚠ **AGY meters its Gemini and its Claude models against
  two independent credit balances** — exhausting one leaves the other fully available, so they
  are two distinct rungs, not one.
  For unattended read-only agent work, combine `--mode plan --sandbox` with
  `--dangerously-skip-permissions`; otherwise print mode can stop after emitting an internal tool
  action instead of finishing the delegated review. Use permission skipping only with a task whose
  write authority is constrained by plan mode and sandboxing.
- **Codex** — `codex exec --model <id> "<task>"`, spending the ChatGPT subscription. Reasoning
  level is a config override, not a flag (there is no `--effort`):
  `-c model_reasoning_effort="minimal|low|medium|high|xhigh"`, defaulting to whatever
  `~/.codex/config.toml` sets; `plan_mode_reasoning_effort` sets it separately for plan mode.
  ⚠ Codex's own guidance is that high effort burns subscription rate limits fast — match the
  level to the task rather than leaving it high for mechanical work. `codex exec review` runs a
  repo review.
- **Anthropic subagent** — plain `Agent(...)`, no directive. Spends primary quota; always works,
  so it is the natural bottom of any ladder.

The CLIs' own model lists are the authority on what exists — re-check them rather than trusting
ids written down anywhere, since a de-listed id fails a whole rung.

### The best way to delegate: the `dispatch` MCP tool

**If your host has llm-relay's MCP tools, use `dispatch`. It is one call and it returns an
ANSWER**, not a command you then have to run correctly:

```
dispatch(task: "<the whole task>")            -> the lane's answer, plus which lane produced it
dispatch(task: "...", tier: "high")           -> pick a capability tier
dispatch(task: "...", lane: "agy-gemini")     -> force one rung
dispatch(task: "...", mode: "answer")         -> no harness — a direct call, for speed
```

If the lane outlives `waitMs` (default 60 s) you get a `jobId` instead. Then:
`dispatch_status(jobId)` -> `dispatch_result(jobId)`, and `dispatch_cancel(jobId)` to stop it.
`dispatch_lanes()` shows the ladder if you want to choose deliberately.

⚠ **Prefer this over the CLI whenever it is available.** The CLI hands you a command, and running a
lane command correctly is the hard part — three client idle timeouts must be lifted or a long think
dies at ~300 s, stdin must be closed or `agy` stalls to its timeout, an npm `.cmd` shim needs a
shell with every token quoted, and a console child steals the desktop focus without window
suppression. The MCP server does all of that for you.

#### `mode: "agent"` (default) vs `mode: "answer"`

Agent mode spawns the lane's own harness — full tool access, and the only form a `cli`-kind rung
(agy, codex) has. Answer mode is for a `relay`-kind rung (a pool spec) only: it skips the harness
entirely and POSTs straight to the relay's own `/v1/messages`, which is measurably faster — a
one-line task ran 5.7–10.8 s direct against 22 s through a spawned `claude -p` harness for the
same pool. **Use answer mode for a question, draft, summary, or second opinion that needs no file
access; keep agent mode whenever the lane must read or edit files or run commands.** A `cli`-kind
rung behaves exactly like agent mode either way, since it has no direct-HTTP form.

```
dispatch(task: "is this diff safe to merge? answer yes or no with one reason", mode: "answer")
dispatch(task: "draft a one-paragraph summary of this doc", mode: "answer", maxTokens: 300)
dispatch(task: "rate this PR 1-5", mode: "answer",
         schema: { type: "object", properties: { score: { type: "number" } }, required: ["score"] })
```

`system` sets an optional system prompt; `schema` (a JSON Schema) forces a single `answer` tool
call and hands back that tool's input, JSON-stringified — pass it when the result should be
structured data rather than prose to re-parse. `maxTokens` overrides the 4096 default.

If the resolved spec happens to be the plain Anthropic passthrough, the dummy credential this
mode sends fails there and the walk moves on to another candidate — the same failover a real
credential failure would trigger.

Not present? Add it once: `claude mcp add --scope user llm-relay -- llm-relay mcp`.

### One verb, host-adapted (the CLI form)

Use this when the MCP tools are not available to you.

`llm-relay dispatch` is the **only** thing you need to ask, from any harness. Do not branch on which
one you are in, and do not reason about whether a subagent can reach a pool from here — the relay
works that out and answers with something you can actually run.

Two flags, and pick by what you are doing:

```bash
llm-relay dispatch --next-command -t "<task>"   # TO ACT: just the command, ~220 tokens
llm-relay dispatch -t "<task>"                  # TO SURVEY: the whole ladder, ~1800 tokens
```

⚠ **Use `--next-command` when you intend to delegate.** Bare `-t` prints every rung with its notes
and ends with a `use:` line naming the winner — useful when you are choosing or diagnosing, and
roughly eight times the tokens when you only wanted the command.

`--next-command` has exactly two outcomes, and that is the whole contract:

| Exit | Output | What you do |
|---|---|---|
| `0` | one runnable command line | Run it in your shell, verbatim. |
| `2` | `lane "<id>" is a relay target (<spec>), not a command` on **stderr** | Address `<spec>` as an ordinary subagent. |

Exit 2 means the relay judged a subagent to be the *better* mechanism here, not that something
failed — your traffic reaches the relay, so `routing.subagents` reroutes an ordinary `Agent(...)`
call in place, with no second process. The spec is already in that message; you never need a second
call to find it.

⚠ You will only ever see exit 2 from a session whose traffic reaches the relay. A host with no
Claude harness at all — a script, a cron job, CI — has no subagent to fall back on, so every relay
rung comes back transposed into a command and `--next-command` always exits 0 there.

It classifies the calling session as **routed** (its traffic reaches the relay, so relay rungs work
as written) or **bypassed** (it does not — Claude Desktop, or any session with no loopback
`ANTHROPIC_BASE_URL`). On a bypassed host, every relay rung a subagent cannot reach comes back
already **transposed** into a `claude -p --model <spec>` command via `routing.cliLane`, marked
`transposed: true` and printed as `run:` rather than `target:`. A rung pointing at the plain
Anthropic passthrough is left alone — an ordinary `Agent(...)` reaches that from anywhere.

Two consequences worth internalising:

- A `run:` line is for you to execute (Bash). A `target:` line is a spec to address as a subagent.
  The relay has already decided which is possible here; trust it over your own guess.
- On a bypassed host the `@relay:` hint is never emitted, because the directive is *inert* there —
  not merely insufficient. If you find yourself about to add one, ask dispatch instead.

A transposed lane also carries the spec's **context window** when the serving provider published
one, via a `{contextWindow}` placeholder in the template (typically
`CLAUDE_CODE_MAX_CONTEXT_TOKENS`). Without it a spawned CLI assumes a window for the model it does
not recognize — `claude` assumes 200k — and compacts against that, throwing away most of a
1M-context model. `dispatch` prints which happened:

```
   context: 1,048,576 tokens (published by the serving provider)
   context: 163,840 tokens (synced snapshot, same model id on another host)
   context: not published anywhere for this spec — the variable is omitted and the CLI uses its own default
```

Three sources, all real measurements, in descending authority: a ceiling the deployment **stated
when it refused an over-length request** (learned automatically and persisted), the serving
provider's own published figure, then the synced snapshot's `context_length` for the same model id
(exact matches only — a fuzzy match can borrow a different SKU's window). There is no guessed value.

A pool reports the **minimum over members that resolve**, since failover can land on any of them,
and says how many members are unmeasured. That gap is self-correcting: the first over-length
rejection from an unmeasured member states its ceiling, and the next dispatch reports the corrected
floor.

⚠ **Never hand-set the variable to a large value to work around an unknown.** Measured pool minimums
are 131,072–163,840, *below* the 200k `claude` already assumes; a speculative 1M would overshoot the
weakest member eightfold and overflow the real backend. A number nobody published is worse than no
number.

If no `routing.cliLane` is configured, an unreachable rung is reported `[unreachable]` with the
reason and skipped when choosing `next`, rather than being offered as a lane that cannot work.

### Order — ask the relay, don't guess

The ordering is **config, not prose**: `routing.ladder` in `~/.llm-relay/config.json`, an ordered
list of rungs. Ask for the next lane rather than deciding yourself:

```bash
llm-relay dispatch -t "<the task>"     # ordered ladder + the exact command to run
llm-relay dispatch --json              # same, machine-readable
llm-relay dispatch --next-command -t "<task>"   # JUST the runnable command line for `next`
```

Use `--tier low|medium|high|xhigh` when task effort matters; tier-specific configurations live
under `routing.ladders.<tier>`. Without it, the ladder matching `subagents.default` is selected
(normally `medium`). `next` is the lane to use and `reason` says why. Then:

- **Override with a specific target:** `llm-relay dispatch <lane> -t "<task>"` (or
  `GET /dispatch?lane=<id>`). Honoured even if that rung is cooling down — you asked for it.
- **A lane failed on availability** (quota gone, rate-limited, CLI missing): report it and get
  the next one — `llm-relay dispatch -x <lane>`, or
  `POST /dispatch {"exhausted":"<lane>","ttlMs":…}`. Say WHICH way it was spent when you know:
  `--outcome rate_limited` (15m cooldown) vs `--outcome quota_exhausted` (1h), and
  `--retry-after-ms <n>` when the vendor stated its reset — that beats both defaults. Rungs
  sharing a `quota` bucket cool down together; rungs that merely share a binary do not.
  `{"clear":true}` resets.
- **Walk manually:** `GET /dispatch?after=<lane>` for the first ready rung past one.
- **Turn client routing on/off:** `llm-relay offload <client> on|off [--scope subagents|all]` —
  `/dispatch?client=<client>` reports that rule, and flags relay rungs `requiresDirective: true`
  while it is off, meaning a bare subagent will *not* offload and you must put `@relay: <spec>` in
  its prompt or enable the client rule.

The relay decides order and remembers what is spent; **it never runs a `cli` rung for you** — it
hands you the command and you execute it. That boundary is deliberate: a CLI agent runs its own
tool loop and returns only final text, so nothing it produces could serve an HTTP turn.

⚠ Config lives in `~/.llm-relay/config.json`, which npm never touches, so a ladder survives
reinstalls. **Never write a user's ordering into this skill file** — `postinstall` overwrites it
from the package on every global install and the edit would be silently lost.

With no `routing.ladder` configured, `/dispatch` says so and expresses no opinion; fall back to
the user's `CLAUDE.md`, or to relay pools first and primary quota last.

Rules for walking it:

- **Skip a rung whose CLI is not installed** (`Get-Command agy.exe` / `codex` on Windows,
  `command -v agy` / `codex` on POSIX). `Get-Command agy -All` can diagnose a shadowing
  PowerShell function, but it is not proof that the headless executable is installed. This
  ladder degrades gracefully to "relay pools, then Anthropic" on machines without the peer CLIs.
- Both CLIs are **full agents with their own tool loops** — hand them a self-contained prompt with
  file paths, run long tasks in the background, and treat output as advisory (verify against
  source) exactly like relay-offloaded output. Do NOT wrap them in a bare one-shot HTTP helper.
- A **refusal or a wrong answer is not a transport failure** — do not walk the ladder to shop for
  a more compliant model. Only availability failures (errors, quota, rate limits) advance a rung.
- **The rungs draw on five independent buckets**, so exhausting one never implies the next is
  gone: AGY-Gemini, AGY-Claude (separate balances despite one CLI), ChatGPT, provider API keys,
  Anthropic primary. Re-check the rung you skipped on the next dispatch — a reset refills it.
- Interactive-only quotas (e.g. an IDE-bound plan with no CLI) are unreachable by any dispatcher;
  don't try to MITM them into the ladder.

## Reordering dispatch

Ordering exists at three levels; change the right one:

- **Which lane is tried first** (`routing.ladders.<tier>`, or legacy `routing.ladder`, in
  `~/.llm-relay/config.json`): reorder the array; rung order *is* the ladder. Add
  `"enabled": false` to park a rung without deleting it.
  A `cli` rung may carry `env` (string = set, `null` = unset), applied by the host when spawning
  and rendered into the printed command — the primitive behind the relay-routed Claude CLI lane.
  Validated at load — a bad spec, a duplicate id, a malformed `env`, or a `cli` rung whose `args` lack `{task}`
  fails at startup, not mid-fallback. ⚠ Never put a personal ordering in the installed
  `~/.claude/skills/llm-relay/SKILL.md` or `~/.codex/skills/llm-relay/SKILL.md` copies:
  `postinstall` generates both from this package source on every global install.
- **Which pool a tier lands on** (`routing.subagents` in `~/.llm-relay/config.json`): maps the
  Agent tool's `model` param (opus/sonnet/haiku/…) to a pool or pinned spec. Takes effect on the
  next request; no restart.
- **Candidate order inside a pool** (`routing.pools`): prefer the automatic form
  `{ "preferred": [], "include": "free", "effort": "medium" }`. `effort` may be
  `low|medium|high|xhigh`; these are cumulative raw-capability floors (50/60/70/80), not ceilings.
  Floors compare whole-point capability, and an existing member leaves only after falling two
  points below its floor. Every automatic member must also be an exact SKU match backed by at least
  three published capability/task-fit signals. Confidence, stability, and metadata order eligible
  deployments but never gate them.
  A strong free model remains eligible for `low`, while higher effort narrows upward:
  `xhigh ⊆ high ⊆ medium ⊆ low`. Models without sufficient capability evidence and exact SKUs
  known not to support tools stay out of automatic effort pools. A non-empty `preferred` array is an
  explicit fixed prefix and bypasses the band, while mixed catalogs contribute only zero-priced or
  explicitly free models. Catalog refreshes update the tail with no manual edits. Legacy dynamic
  pools without `effort` retain the full discovered tail; legacy arrays with `benchmarkSort: true`
  rank the whole array.
  To make the array order authoritative, set `"benchmarkSort": false`. Either way the circuit
  breaker still demotes unhealthy targets — that is live health, not preference, and it is what
  you want. For an absolutely fixed destination, pin `<provider>/<model>`; a pin is never
  reordered and never fails over.
