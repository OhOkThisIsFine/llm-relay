# Scripts inventory (`scripts/`)

⚠ Nearly every `.mjs` here reads the compiled `dist/` — **rebuild (`npm run build`) before running
one** or you'll test stale code. (The root CLAUDE.md repeats this warning because it applies even
when this file isn't loaded.) The three that do NOT touch `dist/` are `analysis-run.mjs`,
`sync-tiers.mjs` and `tier-scoring.mjs`; they read the source tree, the package tree, or the
network. Rebuilding first is still never wrong.

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

Offline / unit-test-safe (no external creds):
- `live-demo.mjs` — runs the compiled CLI against a local flaky backend + stub reshaper. Good smoke test.
- `install-skill.mjs` — npm `postinstall` hook: copies the `skills/llm-relay/` bundle to THREE host
  directories — `~/.claude/skills/llm-relay/`, `~/.codex/skills/llm-relay/` and
  `<XDG_CONFIG_HOME or ~/.config>/opencode/skills/llm-relay/` — on GLOBAL installs only (env var or
  global-tree path detection); a repo-local `npm install` touches no host directory. The primary
  `SKILL.md` is deliberately single-response sized and routes advanced work to three focused
  `references/` files, so all four files must be copied together. `--force` overrides for manual
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
  - ⚠ **`normName()` canonicalizes reasoning-effort notation** — the sources spell the same variant three ways (`gpt-5 (high)` / `gpt-5-high` / bare id), which left 0 of 60 effort rows joined. It REWRITES to suffix form against a closed vocabulary, and never STRIPS: `gpt-5 (high)` → `gpt-5-high`, never `gpt-5`. Collapsing a variant into its base is the borrowed-score bug. Full diagnosis: [../docs/effort-granularity-gap.md](../docs/effort-granularity-gap.md).

Usage wrappers (for pointing a real `claude` CLI at a running proxy):
- `claude-proxied.ps1` / `claude-proxied.sh` — see docs/reference.md "Using it from your projects".
