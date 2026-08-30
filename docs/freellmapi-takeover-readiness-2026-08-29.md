# freellmapi takeover readiness — 2026-08-29

**Question (owner, 2026-08-29):** Is llm-relay in a state to take over from freellmapi on this
machine? Can freellmapi retire, with all offload through llm-relay?

**Verdict: yes — llm-relay is ready.** Retirement is a bounded machine-layer cleanup plus three
named losses, not a build. No new llm-relay code is required. llm-relay v0.59.3 already carries
the larger share of free-provider offload on this machine, its provider set covers every keyed
provider freellmapi pools, it autostarts at logon, and dispatch/exhaustion/lane-probing are
already relay-owned by prior owner decisions (2026-08-29, v0.59.2).

⚠ This verdict, if accepted, SUPERSEDES the "running both is the correct configuration" division
of labour in [status-vs-freellmapi-2026-08-16.md](status-vs-freellmapi-2026-08-16.md) §4.3 and
the matching paragraph in the global `~/.claude/CLAUDE.md`. The decision record is §9. Until the
owner accepts, both services keep running and nothing changes.

## 1. Live evidence (collected 2026-08-29 evening local / 2026-08-30 UTC)

| Fact | Value | Source |
|---|---|---|
| llm-relay version, running | 0.59.3, PID answering on 127.0.0.1:8791 | `llm-relay version`, `GET /telemetry` |
| llm-relay autostart | `llm-relay.vbs` in the Startup folder (since 2026-08-27) | Startup folder listing |
| llm-relay traffic, 7d | **8,704 requests** (openrouter 5,259 · nim 940 · kilo 199 · mistral 105 · ollama-cloud 66 · gemini 43 · groq 1) | `llm-relay cost --window 7d` |
| freellmapi traffic, 7d | **1,576 requests**, 70.6% success, 30.7M input tokens | freellmapi `usage_summary` MCP |
| freellmapi top models, 7d | gemini-3.5/3.6-flash(+lite), kilo-auto/free, opencode nemotron-3-ultra-free | same |
| llm-relay providers | 15 configured; keys resolve for all of freellmapi's 12 keyed providers | `llm-relay keys`, `~/.llm-relay/config.json` |
| Pool liveness, now | **40 live of 864** credential×deployment probes; live capacity spans ≥4 quota domains (nim, gemini, groq, openrouter/kilo `:free`) | `llm-relay pools --probe` |
| Wall pattern, now | huggingface/kilo/ollama-cloud/mistral 402 (credits/tier), openrouter paid 403 (weekly spend limit, accepted fact), opencode 401 | same probe |
| freellmapi passthrough lane | `FREELLMAPI_ANTHROPIC_PASSTHROUGH=subagent-offload` is ON, `HOST=127.0.0.1` | grep of `app\.env` (names/modes only) |
| Dispatch ladder | leads with `claude-free-pool` (relay `pool/<tier>` via :8791); agy lanes wrapped; codex rungs disabled (plugin owns Codex) | `llm-relay dispatch` |
| Lane rosters | agy 14 models, codex 9 models, both probed 2026-08-30 by the relay's own cadence | `llm-relay lanes` |
| Offload state | `claude` ON (scope subagents), `default` ON, `codex` OFF; freeOnly OFF explicit | `llm-relay offload status` |

Reading of the probe number: the free-tier weather (402/403 walls) is an **account** state, not a
relay defect. freellmapi draws on the same accounts and shows the same walls (its own health
reports 11 active huggingface cooldowns). 40 live deployments across four quota domains is
enough for lane traffic; the relay served 8,704 requests this week on exactly this weather.

## 2. Capability matrix — what freellmapi provides vs. the llm-relay equivalent

| freellmapi capability | llm-relay equivalent | Status |
|---|---|---|
| Pooled free-provider routing + failover | Effort pools (`pool/low..xhigh`), benchmark-ranked, breaker, provider-interleaved failover | **Live.** Carries 5.5× freellmapi's weekly volume |
| Per-key RPM/RPD/TPM/TPD tracking | Accounting store + quota observations + Gap-12 demotion + operator `limits` + G2 hard caps | **Live.** See loss L3 for the pre-dispatch-lease delta |
| Tool-call dialect rescue | `tool-dialects.ts` + the destructive refusal freellmapi lacks | **Live, stronger** |
| Tool-argument validation/repair | The relay's identity feature (validator + reshaper) | **Live** |
| Subagent offload (credential-decided passthrough lane) | `routing.subagents` + `offload claude on` (currently ON) for relay-routed sessions; `llm-relay dispatch` lanes for bypassing hosts | **Live** |
| Free interactive Claude session (`claude.ps1`) | `llm-relay setup claude-cli` wrapper generation; the dispatch `cliLane` env template holds the full known-good env set | **Exists**; cutover step C5 |
| MCP introspection (list_models, provider_health, usage/cache/compression stats) | `llm-relay models/keys/candidates/cost/telemetry` + the dashboard SPA | **Equivalent surfaces**, CLI-shaped instead of MCP-shaped |
| MCP offload job runner (offload_start/poll/cancel, 5 lanes) | Dispatch ladder + host-run background lanes — already the practiced pattern (free-lane playbook, 2026-08-27) | **Live**; lane-data file rewrite, step C3 |
| Context compression (`FREELLMAPI_COMPRESSION=lossless`) | None. Deliberate non-goal of the relay | **Loss L1** |
| Keyless providers (Pollinations, LLM7) | Not configured | **Loss L2** (two provider entries close it, if wanted) |
| Signed model-catalog snapshot (monthly, api.freellmapi.co) | Live per-provider `/models` catalog, 10-min TTL, + synced tier data | **Equivalent or fresher** |
| Encrypted key custody (freeapi.db + `ENCRYPTION_KEY`) | `keystore.json` (DPAPI KEK) + env/`.env` precedence; `keys import` accepts the freellmapi export envelope | **Live**; reconcile values, step C6 |
| Serves arbitrary OpenAI-compatible clients | `/v1/chat/completions`, `/v1/responses`, `/v1/models` fronts on :8791 | **Live** (loopback) |
| Anthropic-shaped `GET /v1/models` content negotiation | Absent (OpenAI-shaped only) | No known consumer breaks; the relay's own claude lanes run today |

## 3. What retirement breaks, and the fix per item

The recon (2026-08-29) found every machine reference to freellmapi/:3001. Each is an edit, not a
blocker:

1. **MCP server registration + 4 permission entries** (`mcp__freellmapi__offload_*`) in
   `~/.claude/settings.json` / `~/.claude.json` → remove both.
2. **`~/.agent-config/offload-lane-data.mjs`** — 6 lanes reference freellmapi (`freellmapi-router`
   liveness, `mcp-pool`, `mcp-agy-recon`, `mcp-agy-opus`, `mcp-codex-recon`, `mcp-codex-write`,
   `pool-launcher`) → rewrite to relay-dispatch equivalents. The agy/codex lanes never needed
   freellmapi's models; only the job-runner wrapper goes.
3. **Global `~/.claude/CLAUDE.md`** — the FreeLLMAPI section and the claude.ps1 recipe → rewrite
   to a retirement record; then `node ~/.agent-config/sync.mjs` (that also fixes the generated
   opencode `AGENTS.md` and `~/.gemini/GEMINI.md` mirrors, which carry the same text).
4. **`Startup\freellmapi.vbs`** → remove from Startup; archive the file.
5. **`claude.ps1` habit** → replace with an llm-relay wrapper (`llm-relay setup claude-cli`); the
   relay wrapper already isolates `CLAUDE_CONFIG_DIR` and pins the context ceiling.
6. `~/.codex/config.toml`, `~/.llm-relay/config.json`, nightly maintenance: **no references** —
   nothing to do.

## 4. Losses — named, with mitigation

- **L1 — compression.** freellmapi compresses free-pool sessions; the relay never will (three
  runtime deps, no second implementation). **Measured 2026-08-29 (`compression_stats`): 9
  compressed requests, 1,572,929 → 1,571,692 chars, 309 estimated tokens saved — 0.08%.** The
  response cache reports **0 entries and 0 hits ever** (agentic histories never repeat, as
  status-vs-freellmapi §3.7 predicted). On this machine's traffic shape the loss is nominal, not
  substantive. If a token-heavy free lane ever appears, the mitigation stays available: chain a
  second headroom instance (already installed for Codex) in front of :8791.
- **L2 — Pollinations and LLM7 (keyless).** Not in the relay config — and **absent from
  freellmapi's own top-10 fallback chain (`routing_info`) and its 7-day top models**. Measured
  contribution ≈ nil. Two keyless `openai`-kind provider entries recreate them in llm-relay at
  any time (the ollama entry is the working precedent for keyless providers).
- **L3 — pre-dispatch RPM/TPM enforcement with in-flight leases.** The relay is reactive
  (breaker, Retry-After, escalation ladder, quota demotion) plus operator-declared (`limits`,
  hard caps). In-flight leases were already adjudicated INSIDE llm-relay: Gap 16 was DROPPED by
  owner decision 2026-08-23, with spec §5.4 arguing no measured overshoot. Retirement therefore
  removes a second implementation of a mechanism the project of record already declined on
  evidence. Mitigation where pacing pain appears: declare `providers.<name>.limits` for the
  chatty providers — the configured-limits rung exists precisely for this.

## 5. Cutover checklist (owner-gated; runs only after the decision)

1. **C1 — final snapshot.** Run `freellmapi\backup.ps1`. Export keys from the freellmapi
   dashboard (JSON). Store both under `freellmapi\backups\`. Do not delete anything.
2. **C2 — key reconciliation.** Run `llm-relay keys import` on the export where the env value
   differs. Evidence this matters: opencode answered freellmapi 87+ times this week, while the
   env key the relay reads gets 401 — the two stored values likely differ. Do NOT treat the 401
   as a bad key verdict; reconcile, then re-probe.
3. **C3 — rewire the lane data.** Edit `~/.agent-config/offload-lane-data.mjs` per §3 item 2.
4. **C4 — remove the MCP wiring.** §3 item 1.
5. **C5 — replace the launcher.** Generate the relay claude wrapper; retire the `claude.ps1`
   recipe from docs.
6. **C6 — docs.** Rewrite the global `CLAUDE.md` FreeLLMAPI section as a dated retirement record;
   run `sync.mjs`; update the llm-relay memory index.
7. **C7 — stop and disable.** `freellmapi\stop.ps1`; remove `Startup\freellmapi.vbs`. Keep
   `C:\Users\<user>\freellmapi\` dormant and untouched for ≥30 days. Reversal = put the .vbs back
   and run `start.ps1`.
8. **C8 — optional capacity.** Add Pollinations/LLM7 provider entries (L2) and any operator
   `limits` (L3).

## 6. Residual risks

- **Same-account weather.** Retirement does not change free-tier capacity. The walls move with
  the accounts, not with the router. The relay's re-probe cadence (v0.59.x) and breaker already
  manage them.
- **A relay outage has no second pool.** Today a dead relay leaves freellmapi as an accidental
  fallback for free traffic. After retirement the relay is the single free-pool front door. Its
  autostart, restart-safe health/breaker/exhaustion state, and CI-verified releases are the
  compensation. Direct provider access and the agy/codex/anthropic lanes remain independent of
  it.
- **The passthrough session shape carries the known custom-base-URL costs.** A session pointed at
  :8791 loses `/rc` and 1M context exactly as one pointed at :3001 did. No regression, but no
  improvement either — that cost belongs to ANY custom `ANTHROPIC_BASE_URL`.

## 7. Findings in passing (not blockers)

- The live `~/.llm-relay/config.json` `repair.destructiveTools` list lacks Codex's
  `shell_command` and `apply_patch` (the source default gained them 2026-08-14; the operator
  config predates). One-line config addition.
- The probe reports **64 DEAD pool members** (mostly OpenRouter `:batch` variants, HTTP 404) —
  pool hygiene, handled by catalog refresh/eviction, worth a later look.
- The recon subagent printed the freellmapi **unified key** value into its transcript despite
  redaction instructions. The key is loopback-only. Retirement makes it moot; if freellmapi
  stays, rotate it cheaply.
- freellmapi's own `server.log` stopped 2026-08-12 while its DB shows current traffic — its log
  is not a liveness signal (matches the known `/health` false-200 gotcha).

## 8. Friction log (this evaluation)

- The `require-subagent-model` hook denied the first Agent spawn (works as designed; one retry
  with an explicit `haiku`).
- The haiku recon agent leaked one loopback secret into its transcript despite explicit
  secret-safety instructions — subagent instruction adherence is imperfect; scope recon prompts
  to name the exact strings to redact, and treat "non-secret-looking" credentials as secrets.
- `llm-relay pools --probe` held one member for the full 120 s timeout
  (`nim/deepseek-ai/deepseek-v4-flash-0731`); plan probe runs at ≥5 min.
- Liveness endpoints on both services mislead: llm-relay `/health` is 403 by design (use
  `/telemetry`); freellmapi `/health` is an unconditional 200 (use `/api/health`). Both already
  documented; both still cost a first attempt.

## 9. Decision record

- **2026-08-29 — evaluation delivered; decision PENDING.** Options put to the owner: (a) retire
  via §5, (b) keep both per the 2026-08-16 division, (c) partial — move lanes/MCP off freellmapi
  now, keep the :3001 router temporarily. This file is amended when the owner decides.
- **2026-08-29 — owner queried the three losses before deciding.** Measured answers appended to
  §4: compression saved 0.08% (309 tokens, cache 0 hits); Pollinations/LLM7 rank nowhere in
  freellmapi's own chain; in-flight leases were already dropped inside llm-relay on 2026-08-23.
  Recommendation unchanged and strengthened: retire.
