# Scripts inventory (`scripts/`)

⚠ Every `.mjs` here imports from `dist/` — **rebuild (`npm run build`) before running one** or
you'll test stale code. (The root CLAUDE.md repeats this warning because it applies even when this
file isn't loaded.)

Offline / unit-test-safe (no external creds):
- `live-demo.mjs` — runs the compiled CLI against a local flaky backend + stub reshaper. Good smoke test.
- `install-skill.mjs` — npm `postinstall` hook: copies the single
  `skills/llm-relay/SKILL.md` source to both `~/.claude/skills/llm-relay/` and
  `~/.codex/skills/llm-relay/` on GLOBAL installs only (env var or global-tree path detection);
  a repo-local `npm install` touches neither host directory. `--force` overrides for manual runs.
  Host failures are independent. Ships in the package, so the self-updater refreshes both skill
  descriptions on every upgrade.

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
