# Scripts inventory (`scripts/`)

⚠ Nearly every `.mjs` here reads the compiled `dist/` — **rebuild (`npm run build`) before running
one** or you'll test stale code. (The root CLAUDE.md repeats this warning because it applies even
when this file isn't loaded.) The four that do NOT touch `dist/` are `analysis-run.mjs`,
`calibrate-hedge-floor.mjs`, `sync-tiers.mjs` and `tier-scoring.mjs`; they read the source tree, the
package tree, this machine's own local accounting history, or the network. Rebuilding first is
still never wrong.

⚠ **`install-skill.mjs` JOINED the dist-reading set on 2026-08-30 (v0.62.0), and that is a change
of kind worth knowing.** It now `await import`s `../dist/installed-hosts.js` to decide whether Codex
is present. Two consequences: a stale `dist/` gives a stale detector, and — the surprising one —
**`test/install-skill.test.ts` now needs a BUILT tree**, which no other test in the suite does. That
cuts against the usual split ("vitest reads `src/`; scripts read `dist/`"), so the gate tests carry
an explicit PRECONDITION assertion naming `npm run build`; without it a missing `dist/` reads as
three unrelated Codex failures. The import fails OPEN (provision anyway) and now says so on stderr.

⚠ This file is the inventory of `scripts/`, and `test/scripts-inventory.test.ts` pins it: every
`.mjs` here must be named, and a name here must resolve to a real file. The build- and gate-path
scripts were the ones the inventory omitted for months, so the omission was invisible exactly
where it cost most.

On the build and gate path — these run for you, from `package.json`, and a change here can turn CI
red without anyone invoking a script by hand:
- `clean-dist.mjs` (`npm run build:server`, before `tsc`) — the build's **only** recursive removal.
  It refuses any target that is not this checkout's exact `dist/`, and refuses a symlinked one, so
  a mis-resolved root cannot delete a tree. Don't loosen either guard.
- `dashboard-package-check.mjs` (`npm run check:package`, first half) — compares the built dashboard
  against `docs/dashboard-bundle-inventory.json` (the production Vite/Rollup module graph),
  `docs/dashboard-package-baseline.json` (the size ratchet) and `THIRD_PARTY_NOTICES.md` (every
  bundled package must have an attribution). ⚠ Regenerate the baseline in the SAME change that adds
  or removes bundle weight, or the gate goes red.
- `packed-dashboard-smoke.mjs` (`npm run check:package`, second half) — `npm pack`s the tarball,
  installs it, and serves the dashboard out of the INSTALLED tree: the shell fetches, every asset is
  content-hashed and manifest-owned, no inline script survives, and each `Content-Length` describes
  its own body. It is the only check that sees what a consumer actually receives.
- `tier-scoring.mjs` (+ `tier-scoring.d.mts`) — the pure capability-scoring policy `sync-tiers.mjs`
  imports: capability, evidence and behaviour kept as three separate questions. No I/O, so the
  policy stays deterministic and directly testable. **Ships in the package**, so treat its exports
  as a published surface.
- `analysis-run.mjs` (`npm run analysis:run`) — the ADVISORY static-analysis sweep (eslint+sonarjs,
  knip, madge, dependency-cruiser, ts-prune, jscpd) into the gitignored `analysis-reports/`.
  ⚠ Deliberately NOT in `npm run check`, and CI does not run it. Tools are invoked through `npx`, so
  knip cannot see them — keep the `ignoreDependencies` list in `knip.config.json` in step when
  adding a step here.
  ⚠ `run-summary.txt` prints each tool's process EXIT CODE, labelled as such (`jscpd: exit 0`),
  never a finding count. Until 2026-09-04 it printed the bare number under the tool's name beside
  `Failures: none` while the run it summarized held 572 clone blocks (audit DR-018). A `.json`
  report is written only from stdout and only when it parses; jscpd's JSON comes from its own
  reporter (`jscpd-report.json` in the report directory).
  ⚠ **`--only <step>` runs ONE step and exits with THAT step's status** (2026-09-16). It exists for
  the machine-wide nightly sweep (`~/.claude/scheduled-tasks/nightly-maintenance/
  static-analysis-runner.mjs`), which reads `.claude/static-analysis.json`, runs each declared
  tool's `command`, and keys its report by that tool's `name`. llm-relay used to be declared as ONE
  entry whose `name` was the whole six-tool list, so a failure anywhere inside the sweep surfaced as
  a single opaque `FINDING llm-relay — eslint + sonarjs, knip, …: exit 1` naming none of the six —
  and the runner captures only two `npm notice` lines, not this script's summary.
  `.claude/static-analysis.json` therefore declares **six** entries, one per step, each running
  `npm run analysis:run -- --only <step>`. ⚠ The swept names are the STEP names
  (`eslint-after-fixes`, `knip-after-fixes`, `madge`, `dependency-cruiser`, `ts-prune`, `jscpd`), not
  the tool names — `--only eslint` is refused by name, listing the real ones. `similarity-ts-attempt`
  is deliberately NOT declared: it is `optional: true`, the sweep would report it as a permanent
  finding, and its non-zero exits are expected.
  ⚠ An `--only` run does **not** rewrite `run-summary.txt`: it would otherwise leave the file
  describing only whichever step ran last, reading as a clean sweep of one tool. It still writes the
  per-step report and `<step>.exit.txt`, which is the attribution the sweep consumes. An unknown
  `--only` name, or any other argument, exits 2 touching nothing.

Needs a locally authenticated harness account (manual measurement; never CI):
- `measure-agy-continuation.mjs` — Phase 5.1 exact-resume measurement for active hard-cap
  continuation. Run `npm run build:server` first, then
  `node scripts/measure-agy-continuation.mjs`. It starts AGY in a fresh temp workspace with
  `--output-format stream-json`, captures the exact `conversation_id`, waits until AGY emits an
  ACTIVE agent-response event, terminates that process tree, then starts a NEW AGY process with
  `--conversation <captured-id>`. The resumed process must report the same conversation id and
  recover a random marker that appears only in the interrupted user turn. It never uses
  `--continue`, requests no tools, and prints one `AGY_CONTINUATION_MEASUREMENT {...}` line. A
  negative `success:false` is a valid capability measurement; setup/protocol failures throw.

Offline / unit-test-safe (no external creds):
- `measure-lane-orphan.mjs` (Windows only; run `npm run build:server` first) — S4's real
  process-lifetime measurement. It starts the built `llm-relay mcp` on an isolated config/port,
  dispatches a fake CLI lane that writes once per second for 60 seconds, force-kills ONLY the MCP
  PID with `taskkill /F` (deliberately no `/T`), then reports whether the lane survived the
  parent, finished, and produced all 60 lines. This is a measurement harness, not a CI regression
  test; a temporary CI invocation may be used to capture a Windows result, but do not leave the
  one-minute measurement on the normal gate.
- `calibrate-lane-outlier.mjs` (`node scripts/calibrate-lane-outlier.mjs [--file <dispatch-lane-stats.json>]
  [--recent 5] [--quantile 0.8] [--min-samples 5]`) — fits
  `routing.dispatchWalk.outlier.outlierFactor` (backlog item 9, 2026-09-09: a `cli` lane whose RECENT
  runs are an outlier against its OWN earlier history is demoted — see `checkLaneOutlier` in
  `src/lane-affinity.ts`) from THIS machine's `~/.llm-relay/dispatch-lane-stats.json` (or
  `XDG_CACHE_HOME`'s copy, or `--file`) — never `dist/`, never the network. Method: for every (lane,
  tier) window with enough history, slide a split across the window in time order and pool every
  `median(recent 5) / p80(earlier)` ratio; propose the pooled p95; ACCEPT it only inside [1.5, 5.0],
  else print the built-in 2.5 and say so. Nearest-rank quantiles, so every figure is an observed
  sample. ⚠ Output is perishable and machine-local — record it beside the default with its date.
- `calibrate-hedge-floor.mjs` (`node scripts/calibrate-hedge-floor.mjs [--path <recent.json>]`) —
  fits `routing.hedge.msPerInputToken` (owner direction 2026-09-04: the hedge floor grows with a
  request's own estimated input size — see `src/hedge-trigger.ts`) from THIS machine's own
  `~/.llm-relay/usage/recent.json` (or `XDG_CACHE_HOME`'s copy, or `--path`) — never `dist/`, never
  the network. Method: the p25 (lower quartile) of `latencyMs / inputTokens` ratios among successful
  SERVE attempts carrying >= 10,000 input tokens, across every deployment in the window, chosen over
  an OLS-through-origin slope on "the fast deployments" because a typical window here cannot support
  that classification robustly (a handful of deployments, several with 1-2 samples). ⚠ Applies the
  SAME guardrail `hedge-trigger.ts` documents: a fit outside [0.05, 0.5] ms/token is REJECTED in
  favour of the built-in 0.15 default, exactly the fail-safe direction as an unmeasured latency or
  an unpublished context ceiling elsewhere in this relay — run 2026-09-04 against this machine's
  window (100 samples, 55 >= 10,000 tokens), the fit came back 0.036 ms/token and was rejected. Exits
  1 with no accounting history to fit against, rather than inventing a number.
- `live-demo.mjs` — runs the compiled CLI against a local flaky backend + stub reshaper. Good smoke test.
- `install-skill.mjs` — npm `postinstall` hook: copies the `skills/llm-relay/` bundle to THREE host
  directories — `~/.claude/skills/llm-relay/`, `~/.codex/skills/llm-relay/` and
  `<XDG_CONFIG_HOME or ~/.config>/opencode/skills/llm-relay/` — on GLOBAL installs only (env var or
  global-tree path detection); a repo-local `npm install` touches no host directory. The primary
  `SKILL.md` is deliberately single-response sized and routes advanced work to four focused
  `references/` files, so all five files must be copied together. ⚠ `references/lane-field-notes.md`
  joined the bundle on 2026-09-17: it is the one home for MEASURED traps about USING dispatch and
  the lanes (owner instruction the same day — such notes belong with the skill every host reads, not
  in `C:\Code\docs\backlog.md`, which keeps only what breaks every repository the same way).
  The file list lives in TWO places, `install-skill.mjs` and `test/install-skill.test.ts`; add a
  reference to both, or the test proves the old bundle. `--force` overrides for manual
  runs. Host failures are independent. Ships in the package, so the self-updater refreshes every
  host's complete skill bundle on every upgrade.
  ⚠ **OpenCode was added 2026-08-30 (v0.62.0) and it is the only target that is not a fixed
  dotfolder in HOME** — it honours `XDG_CONFIG_HOME`, matching OpenCode's own `~/.config`
  convention and `src/state-paths.ts`'s config-kind policy. Before that the installer wrote two
  hosts, so an OpenCode copy placed there by any other means went stale with nothing to refresh
  it — measured 1875 bytes behind on this machine.
  ⚠ **Codex provisioning is MCP-first since the post-v0.68.4 routing correction.** The installer
  appends both the direct Responses provider and `[mcp_servers.llm-relay]`, then retires the exact
  legacy generated `default.toml` / `relay_coding.toml` bytes. Codex Desktop rejects those
  `pool/*` children against the ChatGPT account before consulting `model_provider`; leaving them
  installed makes the model choose a path the relay never sees. Only byte-identical templates are
  removed—any user edit proves ownership and must be preserved.
  ⚠ **It ALSO installs `~/.codex/agents/relay.toml` (2026-09-04), the direct replacement for the
  two retired agents above.** Confirmed against Codex's own subagent docs
  (`/codex/agent-configuration/subagents`) and three sibling files this exact machine already runs
  (`~/.codex/agents/codebase-memory*.toml`, from codebase-memory-mcp): `name`, `description` and
  `developer_instructions` are the three REQUIRED custom-agent-file fields; `model` is optional and
  documented as `model_provider` is NOT — one likely reason the legacy pair needed retiring, since
  they set both. This template pins NEITHER, so it inherits whatever model/provider the calling
  session already uses instead of ever presenting a `pool/*` value for Desktop to reject. Its
  `developer_instructions` carry the SAME pass-through contract as the Claude `relay` agent in
  `src/setup-claude.ts` — call the `dispatch` MCP tool once, poll `dispatch_status`/`dispatch_result`,
  return the answer with its `provenance:` line, never answer directly — ported to Codex's bare
  (unprefixed) MCP tool names, with its own `[mcp_servers.llm-relay]` block scoped to exactly those
  three tools (the same `enabled_tools` scoping pattern the codebase-memory-mcp siblings use).
  `installCodexRelayAgent()` mirrors `installRelayAgent`'s ownership test — a `#`-comment marker
  prefix (`# llm-relay:codex-relay-agent`), not an exact-version match, so an older-versioned file
  upgrades in place rather than being refused as foreign. ⚠ Unverified by this change: whether a
  spawned Codex subagent can reach the `llm-relay` MCP tools from every Codex surface — `codex
  exec`'s own top-level session exposes none at all (see the user's global `CLAUDE.md`, "Peer agent
  CLI lanes"); Codex Desktop is the confirmed working host for MCP `dispatch` generally.

Need live creds (`NVIDIA_API_KEY` + `LLM_BACKEND_BASE_URL`, or any OpenAI-compatible provider):
- `nim-front.mjs` — run the compiled proxy fronting a live backend end-to-end.
- `nim-probe.mjs` / `nim-repair.mjs` — one-off tool-call fidelity + repair probes.
- `nim-trip-rate.mjs` — the trip-rate dataset harness (models × schemas × trials → `docs/nim-trip-rate.*`).
- `agentic-loop-probe.mjs` — drives a full agentic STEP (tool_use → tool_result → answer) through a **running** proxy. The end-to-end proof.
- `verify-live-features.mjs` — boots the proxy on a temp config against live NIM and exercises the runtime endpoints (`/registry`, `/telemetry`, `/ping`, …).
- `multimodal-probe.mjs` — image / PDF / MCP-block passthrough through the Anthropic→OpenAI translation. Needs a **running** proxy pointed at a vision model (`PROXY=... node scripts/multimodal-probe.mjs`).

Needs network (no provider key):
- `sync-tiers.mjs` (`npm run sync:tiers`) — snapshots **OpenRouter** (Artificial Analysis intelligence/coding/agentic indices, Design Arena Elo, context length, pricing, tool support — and the only source whose ids match our routing specs exactly), **BFCL** (tool-use accuracy), **LMArena** (general), **Aider polyglot** (edit benchmark + edit-format compliance) and **Artificial Analysis first-hand** into `docs/tier-data.json` (~800 models). Each source is independently failable and records a warning; schema drift inside a source still throws loudly — don't "fix" that by softening the check. Zero working sources is fatal.
  - ⚠ **Artificial Analysis is KEY-GATED and skips cleanly.** No `ARTIFICIALANALYSIS_API_KEY` (env, or `~/.llm-relay/.env`) ⇒ `configured: false`, zero rows, a neutral `-` in the report and **no warning** — not signing up is not an outage. Its response schema is undocumented, so the field mapping is an alias list that THROWS when nothing resolves; extend the aliases, don't soften it. Absorbed last so a first-hand AA figure outranks the same number relayed via OpenRouter.
  - ⚠ **`normName()` canonicalizes reasoning-effort notation** — the sources spell the same variant three ways (`gpt-5 (high)` / `gpt-5-high` / bare id), which left 0 of 60 effort rows joined. It REWRITES to suffix form against a closed vocabulary, and never STRIPS: `gpt-5 (high)` → `gpt-5-high`, never `gpt-5`. Collapsing a variant into its base is the borrowed-score bug. Full diagnosis: [../docs/history/effort-granularity-gap.md](../docs/history/effort-granularity-gap.md).

Usage wrappers (for pointing a real `claude` CLI at a running proxy):
- `claude-proxied.ps1` / `claude-proxied.sh` — see docs/reference.md "Using it from your projects".
