# Lane field notes — measured behaviour of llm-relay dispatch and its lanes

Every note here was MEASURED on this machine, with its date. They moved out of the machine-wide
backlog on 2026-09-17 (owner instruction: llm-relay-specific instructions belong with the llm-relay
skill, not in a shared to-do file). Each note is REFERENCE, not work: it is deleted when it becomes
untrue, never because something shipped. A defect in llm-relay itself belongs in
`C:\Code\llm-relay\docs\backlog.md` in product terms.

Ask the live tools first. `dispatch_lanes` and `llm-relay dispatch` carry the current lane record
and quota; never copy a dated roster out of prose.

## 1. Reading a dispatch reply

- **A `cli` rung's reply body is NOT the lane's answer (2026-09-16).** A `relay` rung such as
  `free-pool` returns the raw answer. A `cli` rung such as `agy-gemini` returns its harness's own
  record — `{"conversation_id":…,"status":"SUCCESS","response":"<the real answer>",
  "duration_seconds":…,"usage":{…}}` — so the answer sits inside `response`. Code that binds the
  body to a schema fails on exactly the calls the ladder sent to a CLI rung, and the failure looks
  like a bad lane. Measured in audit-tools, 2026-09-16: 28 of 62 sweep calls lost, 19 to this
  envelope. (llm-relay packet M1 will unwrap it in the relay and announce an `unwrapped:` line;
  until that release, unwrap it yourself.)
- **A `SUCCESS` status is not an answer (2026-09-16, owner decided not to fix this in the relay).**
  A `posttooluse-typecheck.mjs` dispatch (job-0021) returned `"status":"SUCCESS"` around 40 repeated
  lines of "Waiting for test execution to complete." and no work product. Read the content by hand.
- **A completed job can carry no usable answer (2026-09-07 and 2026-09-09).** Agent-mode jobs
  exited after 302 s and 623 s with the single words `Now` and `Let`, and their worktrees were
  clean. Job `job-0005` exited 0 after 765 s and returned `I`. A review job completed after 813 s
  with a completion claim and no findings. Treat a terminal status as evidence of TERMINATION only,
  then inspect the answer and the worktree. None of these outcomes proves a provider quota is
  spent.
- **`status: "running"` after a long `waitMs` is normal (2026-09-16).** The server clamps `waitMs`
  to `routing.mcp.maxWaitMs`. Poll `dispatch_status`, then `dispatch_result`. In audit-tools 9 of
  62 calls were lost by treating this as a fault.
- **Map a lane's verdict table to the file by HEADING, never by row number (2026-09-10).** A
  read-only lane numbered 74 backlog entries out of file order (one moved from row 20 to row 8),
  so its row numbers would have deleted the wrong entries. Re-derive rows with a script and match
  each verdict by its heading text.

## 2. Waits, restarts and lost jobs

- **A large `waitMs` loses the job id (2026-09-06).** `waitMs: 180000` returned `Error: Request
  timed out` with no job id, so the lane could not be polled, resumed or cancelled. The same task
  at `waitMs: 40000` returned `job-0001` at once and finished in 145 s. Leave `waitMs` unset.
- **Codex's code-mode `exec` gives up on a tool call at 31.0 s (2026-09-10).** It returns "Wall
  time 31.0 seconds" with empty output, so a longer MCP call loses its answer: 29 of 266 first
  Codex `dispatch` calls, 2026-09-07 to 2026-09-10. Keep every MCP call from a Codex host under
  30 s. llm-relay blocks 25 s by default since v0.81.0 and then hands back a job id.
  Since v0.83.x the server waits longer only for hosts measured to survive it: Claude Code with a
  progress token gets the answer in one call, Claude Desktop gets 50 s, every other host keeps the
  ceiling (llm-relay `docs/mcp-host-timeouts-2026-09-17.md`).
- **An MCP server restart KILLS every lane it was running (2026-09-06, re-measured 2026-09-17).**
  The old symptom — `unknown jobId` for every job, numbering restarted at `job-0001`, nothing on
  disk — is fixed: the running-job journal reports each such job as `killed` (v0.80.0) and the job
  archive keeps finished jobs and the id counter across restarts (v0.82.0). The WORK is still
  lost: 14 of 83 archived jobs on 2026-09-17 were `killed`, 11 of them `agy-gemini`. Give every
  lane its own worktree, because that directory is the only record of what a killed lane did, and
  dispatch a killed job again.
- **One `llm-relay mcp` process can outlive a release (2026-09-10).** The Claude desktop app keeps
  one MCP connection across its sessions, so after a global reinstall that connection runs the old
  code until the app restarts. Since v0.81.0 a reply from a process older than the installed
  package says so.
- **A session that hits its usage limit mid-turn loses every in-flight job (2026-09-04).** Three
  `relay` subagents lost their lane jobs when the limit hit: the MCP connection was replaced, job
  ids restarted at `job-0001`, and each agent saw `Request timed out` then `Connection closed`.
  Keep the job handles in the main session rather than in subagents, and re-dispatch after the
  reset.
- **An unrunnable lane is not a quota verdict (2026-09-09).** `Lane "anthropic" cannot be run from
  here: it is a relay target (anthropic) with no cliLane template configured` means no answer was
  produced. It says nothing about any account's quota. Keep the exact error.

## 3. Lane capacity and concurrency

- **Cap concurrent lanes at three or four; seven died together (2026-09-06).** Five
  `opencode-muse-spark` and two `agy-gemini` lanes all hit the 2100 s timeout at the same moment,
  exit 124, empty output, four packets lost — one had written 348 lines. Three lanes ran
  comfortably afterwards. The relay does not cap this; the caller must.
  - The tell is SIMULTANEITY. One silent lane is a lane problem; a cohort dying at the same
    elapsed second is a load problem.
  - The usual cause is asking every lane to run the full repository gate. Give a lane its TARGETED
    suites plus lint, and keep the full gate for the orchestrating session.
  - The orchestrator's own gate runs count toward the same budget: a cohort of only three lanes
    also died together at 1800 s while the orchestrating session ran five full gates. Pause
    dispatching while you verify, or drop to two lanes.
  - A killed lane holds its worktree directory open, so `git worktree remove` reports "Permission
    denied" although git DOES unregister the worktree. Believe `git worktree list`, not the
    filesystem.
  - A gate step that reaches the network flakes under this load: `npm audit` returned an error
    payload while three lanes ran. Rerun such a step alone before believing it.
- **Two concurrent Muse Spark lanes starve, not only three (2026-09-09).** Two packets dispatched
  together ran to the 2100 s timeout with empty output and no file written; single lanes finish in
  minutes. Its rungs carry `maxConcurrent: 1` since llm-relay v0.78.0; keep it that way.

## 4. What each lane can carry

- **`opencode-muse-spark`** carries a whole implementation packet ALONE (101–998 s, 2026-09-09),
  and starves as a second or third concurrent lane. Always pass `cwd`. Keep the task text under
  4,096 characters and put a long brief in a file: a longer task makes the MCP server fall back to
  its start-time config snapshot. It runs as the `relay-lane` OpenCode agent.
  ⚠ Headless OpenCode auto-rejects every permission set to `ask`, and the global default sets
  `edit` and `bash` to `ask`, so without that agent a lane can read but cannot edit or run a suite,
  and the failure looks like a model failure (measured 2026-09-04: `permission requested: edit …;
  auto-rejecting`). A lane dispatched with no `cwd` had every READ rejected as
  `external_directory`. The agent lives in `~/.config/opencode/opencode.json`; a repository-level
  `opencode.json` merges over it, and `agent=<name>` on the run's `stream` lines in
  `~/.local/share/opencode/log/opencode.log` is the only proof of which agent ran.
  ⚠ The agent did not end the zero-output mode (2026-09-04/05): with everything correct, two lanes
  ran 918 s and 895 s and wrote zero bytes. Read-only recon on this lane is 35–70 s, so no file
  change in the worktree after about five minutes is the signal to cancel and re-dispatch.
- **`agy-gemini`** is the steady CLI lane: 24 of 24 answered at a 240 s median on 2026-09-06, and
  it carried packets at 348–561 s. It ran two lanes in one worktree (authoring plus a read-only
  review) without interference.
  ⚠ It obeys an absolute path written INSIDE the brief over the `cwd` you passed, even when the
  task says not to (2026-09-06). Never write an absolute worktree path into a shared brief, or
  regenerate the brief per lane. Before concluding a lane produced nothing, look where its brief
  pointed.
- **`agy-claude-opus`** drops the stream on long outputs (2026-09-04/05): `The stream was
  interrupted` after a report summary, and `There was a network issue connecting to the server`
  after 490 s. Split the work into packets and run them on `agy-gemini`.
- **Codex Spark** reads its whole usage window and writes nothing (2026-09-09, twice): 193k and
  477k tokens, every test file read whole, then "You've hit your usage limit". A preamble limiting
  reads changed nothing. Give it a review of a bounded diff, or nothing.
- **A shape that scored 10/10 yesterday is not a cure (2026-09-06).** Three `opencode-muse-spark`
  lanes using the exact shape recorded as reliable the day before wrote nothing in 25 minutes while
  `dispatch_status` said `running` and ten `opencode.exe` processes sat at about 500 MB each. Read
  `dispatch_lanes` before choosing a lane; the same day it read 72 calls / 6 timed out / median
  616 s for Muse Spark against 24 / 24 ok / median 240 s for `agy-gemini`.

## 5. Writing a brief, and trusting what comes back

- **A brief's wording is NOT a boundary (2026-09-06, measured twice).** A lane told to AUDIT a
  closeout spent 19 minutes writing its own `closeout-input.json` into a live repository root, with
  a fabricated verification section. Five later lanes each opened with "Do NOT edit any file.
  Report findings only"; one still ran suites in the shared tree, wrote to the repository root,
  performed the repository's own closeout ceremony, and an untracked deliverable of the
  orchestrating session vanished at the same minute. The controls that DO work: give every writing
  lane its own worktree, use `mode: "answer"` when the lane needs no file access, use
  `readOnly: true` for an agent lane (llm-relay binds the lane's own read-only tool flags since
  v0.82.0), commit an in-progress deliverable before dispatching into the same tree, and run
  `git status --porcelain` after EVERY lane returns or is cancelled. A cancelled lane leaves its
  files behind exactly like a completed one.
- **A brief that says "never print the key" does not stop a lane writing the key (2026-09-09).** A
  capture lane put `export DEEPSEEK_API_KEY="sk-…"` into a scratch `start-relay.sh`. Tell the lane
  to read a secret from the environment at run time and never copy the value into a file, and grep
  every scratch launcher for `sk-` before running it or passing it on.
- **Ask a lane to EXTRACT, not to give a VERDICT (2026-09-06).** A free-pool lane given a rubric
  and asked for `clear`/`defective` answered `clear` for all 97 records: a rubric whose rules
  mostly say "this is not a defect" pushes a weak model to the null answer, and the output looks
  well formed. The same job as an extraction — list the terms a cold reader cannot resolve, rate
  0–10 — did not collapse. Always check a lane's label DISTRIBUTION before using its labels.
- **Well-formed output can still be wrong, and that is the version that gets believed
  (2026-09-06).** A lane produced 120 clean records in the requested shape; against a hand-labelled
  overlap its best agreement was 64%, while answering "clear" every time scored 73%. Never fold
  lane labels into a count, a training set or a conclusion without measuring agreement on a
  hand-labelled overlap, and always against the always-answer-the-majority baseline.
- **A lane that returns one large JSON object at the end returns NOTHING when it stops early
  (2026-09-06, three lanes lost).** Have the lane append one JSON line per record as it works, and
  slice the job to about 40 records rather than 100.
- **Free lanes cannot do open-ended reconnaissance here (2026-09-05, 7 of 7 packets fabricated).**
  They CAN review a concrete diff against a stated claim, and they carry a mechanical rewrite with
  a stated rule. The test is whether the output can be checked by running or reading something
  specific.

## 6. Hooks, keys and the daemon

- **A relay lane loads NO global hook (2026-09-17).** `dispatch` launches each Claude lane with
  `CLAUDE_CONFIG_DIR=~/.llm-relay-claude`, so the lane reads `~/.llm-relay-claude/settings.json`
  and never `~/.claude/settings.json`. A global hook guards the orchestrator's own tool calls only.
  Codex, OpenCode and AGY lanes have no hook surface at all; for them the orchestrator-side
  `dispatch-cwd-guard.mjs` and the lane's own worktree are the only controls.
- **Provider API keys are NOT environment variables on this machine (2026-09-09).** `llm-relay
  keys` prints an `Env var` column, which is the NAME the relay looks for, not proof the variable
  exists: `NVIDIA_API_KEY` is empty in every scope while the same key reads `VALID`, because the
  secret lives DPAPI-wrapped in `~/.llm-relay/keystore.json`. A direct `curl` therefore sends an
  empty bearer, and NVIDIA answers HTTP 500 with a Rust `axum::Extension` message that reads like a
  provider fault. Probe through the relay instead: `POST http://127.0.0.1:8791/v1/messages` with
  `"model": "<provider>/<model id>"`. A public `/v1/models` answer proves nothing about a key.
- **A provider timeout turns a slow model into a fake "not servable" (2026-09-09).** With `nim` at
  `timeoutMs: 100000`, a 32-token probe of `deepseek-ai/deepseek-v4-flash-0731` returned HTTP 504
  at 100.03 s, while its sibling answered 200 after 81.6 s for two output tokens; the same Flash
  model had answered in 38 s on 2026-08-27. A 504 at the configured timeout is evidence about the
  QUEUE. Raise `providers.<name>.timeoutMs` and probe again before recording a model as dead.
  `firstByteTimeoutMs` (v0.78.0) fails over fast when nothing arrives at all, while a slow body
  still runs to its end.
- **The daemon reads `config.json` ONCE at start.** A rung or provider edit is invisible until the
  daemon restarts — confirmed live: after a rung edit the `agy.exe` command line still carried the
  old `--model`, and a re-probe after a timeout raise timed out again at exactly the old value.
  Each `llm-relay mcp` process loads the file once too, so a host restart is needed for it as well.
  `GET /telemetry` carries `config.changedOnDisk`, and `routing show|get`, `config show|get` and
  `offload status` print a notice when the running relay has not loaded an edit. Restart: stop the
  node process running `dist\cli.js` with no subcommand (`llm-relay stop` since v0.78.0), then
  relaunch `wscript.exe "…\Startup\llm-relay.vbs"`; verify with `GET /telemetry` and
  `llm-relay dispatch --tier high`.
- **A pool request to DeepSeek runs with thinking ON, which spends output tokens on reasoning
  (2026-09-09, causes since addressed).** Two authorized paid calls to `deepseek/deepseek-v4-pro`
  returned HTTP 200 and `max_tokens` with zero final text. llm-relay forwards the caller's thinking
  control since 2026-09-10 and `dispatch` takes a `model` argument since v0.81.0. For a pool
  request, give a large `max_tokens` or send `thinking: {"type": "disabled"}`.
- **Codex Desktop cannot reach a relay pool through a collaboration child (2026-08-31).** With a
  ChatGPT account the launcher validates `pool/medium` against the parent account before contacting
  llm-relay and fails with HTTP 400 `The 'pool/medium' model is not supported when using Codex with
  a ChatGPT account.` Use the MCP `dispatch` tool there. Generated agent files stay valid for
  clients that honour custom providers.
