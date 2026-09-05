# Muse Spark 1.3 on OpenCode Zen — how llm-relay can carry it (2026-09-04)

Investigation record. Every claim below was measured on 2026-09-04 against the live services and
the running relay (global install of v0.70.0). Re-run the probes before trusting a row that has
aged; Zen calls the free tier "limited time".

## Findings first

1. **The model exists and is free on OpenCode Zen.** Id `muse-spark-1.3-contributor-free`, released
   2026-09-02. models.dev: cost 0/0, context 1,048,576, max output 131,072, tool calls, reasoning
   with effort `minimal|low|medium|high|xhigh`, multimodal input. Zen's own list (`GET
   /zen/v1/models`, 66 ids) carries it; the relay's cached catalog for provider `opencode` already
   lists it (`llm-relay models -p opencode`).
2. **"Contributor" is a data-use term, not a tier name.** Meta serves this SKU free (on Zen) or at
   $0.10/$0.20 per Mtok (Meta Model API, Vercel, llmgateway, nano-gpt) *in exchange for permission
   to train on the prompts and completions*. The non-contributor `muse-spark-1.3` is $1.25/$4.25
   everywhere. Zen is the only zero-price source of Muse Spark 1.3 in the models.dev catalog. This
   is an owner decision before any automatic routing — see §5.
3. **Zen serves Muse Spark only on the OpenAI Responses API.** `POST /zen/v1/responses` answers
   200. `POST /zen/v1/chat/completions` and `POST /zen/v1/messages` answer **HTTP 500 "Internal
   server error"** for both `muse-spark-1.3-contributor-free` and `muse-spark-1.2-contributor-free`,
   with or without a key, at budgets 64/256/1024. A sibling free model
   (`nemotron-3.5-lightning-free`) answers 200 on chat completions through the same path and key,
   so the credential and the provider entry are fine; the dialect is the wall. models.dev marks the
   difference: the Muse rows carry `provider.npm: "@ai-sdk/openai"` (Responses client) while the
   provider default is `@ai-sdk/openai-compatible` (chat).
4. **llm-relay has no Responses upstream.** `Kind = "anthropic" | "openai"`
   (`src/config-types.ts:7`); upstream requests go to `/chat/completions` (`src/backend.ts:799`,
   `:1586`) or `/v1/messages` (`:1723`). `src/responses-request.ts` is the *front* direction
   (Codex's Responses request → Anthropic Messages), not a backend. So today
   `opencode/muse-spark-1.3-contributor-free` through the relay returns Zen's 500 verbatim —
   measured three times on `/v1/messages` and once on the relay's `/v1/chat/completions` front.
5. **The OpenCode CLI reaches it now, with no Zen credential.**
   `opencode run --model opencode/muse-spark-1.3-contributor-free "Reply with exactly the word OK"`
   printed `OK` in 6 s from an empty directory. `opencode auth list` holds no Zen key (anthropic,
   openai, github-copilot, google only). Direct anonymous curls confirm it: Zen's `-free` models
   need no `Authorization` header at all. That makes a `kind: "cli"` dispatch rung possible today
   (§3, route A).
6. **Even with a Responses backend, the model would not enter `pool/*` on its own.** Automatic
   effort-pool eligibility requires a tier-data row matched **exactly** by normalized SKU with at
   least three published signals (`src/benchmarks.ts:164-172`); an unmatched id gets
   `basis: "neutral"` and is neither in-band nor in the degrade tail (`src/dynamic-pools.ts:259-266`).
   `docs/tier-data.json` knows `muse-spark-1.1`, `muse-spark-1.2`, `muse-spark-1.2-xhigh` — no 1.3
   and no `-contributor-free` variant. `preferred` (the fixed prefix) is the lever.

## 1. Probe ledger

All prompts were "Reply with exactly the word OK and nothing else." unless noted. Under the
contributor terms those prompts are now Meta training data; nothing else was sent.

| # | Path | Auth | Model | Result |
|---|---|---|---|---|
| 1 | relay `POST 127.0.0.1:8791/v1/messages` | keystore `opencode#default` | muse 1.3 free | **500** in 395 ms — `openai backend HTTP 500: Internal server error` |
| 2 | same | same | `nemotron-3.5-lightning-free` | 200 in 2.3 s (key valid, provider entry valid) |
| 3 | same, `max_tokens` 64 / 1024 | same | muse 1.3 free | 500 / 500 |
| 4 | same, `max_tokens` 256 | same | muse 1.2 free | 500 |
| 5 | relay `POST /v1/chat/completions` front | same | muse 1.3 free | 500 |
| 6 | Zen `POST /zen/v1/chat/completions` direct | **none** | muse 1.3 free | 500 |
| 7 | Zen `POST /zen/v1/messages` direct | none | muse 1.3 free | 500 |
| 8 | Zen `POST /zen/v1/responses` direct | none | muse 1.3 free | **200** (`status: incomplete` at 32 output tokens — reasoning spends budget) |
| 9 | Zen chat direct | none | nemotron 3.5 free | 200 (anonymous free tier confirmed) |
| 10 | Zen responses, `reasoning.effort: low`, 512 budget | none | muse 1.3 free | 200, `OK`, usage 17 in / 187 out of which 176 reasoning |
| 11 | Zen responses, `reasoning.effort: xhigh`, 2048 budget | none | muse 1.3 free | 200, effort echoed `xhigh`, 121 reasoning tokens |
| 12 | Zen responses, one `function` tool, "Use the add tool to compute 17 + 25" | none | muse 1.3 free | 200: `reasoning` item (encrypted), `message` item, `function_call {"a":17,"b":25}`; usage reports `cached_tokens: 113`, `reasoning_tokens: 166` |
| 13 | Zen responses, `stream: true` | none | muse 1.3 free | standard events: `response.created`, `in_progress`, `output_item.added/done`, `content_part.added/done`, `output_text.delta`, `completed`, `ping` |
| 14 | `opencode run --model opencode/muse-spark-1.3-contributor-free` (CLI 1.18.28, empty dir) | CLI has no Zen key | muse 1.3 free | `OK`, 6 s, exit 0; CLI log: `llm.runtime=ai-sdk llm.provider=opencode` |
| 15 | `opencode-ai\bin\opencode.exe run --pure --model … --variant high` (the exe a rung would name) | none | muse 1.3 free | `OK`, 9 s, exit 0; stdout = ANSI reset, `> build · <model>` banner, blank, `OK` |

Zen returned no rate-limit headers (only `Server: cloudflare`, `CF-RAY`); the free tier's ceiling
is unpublished. Rows 10-13 are what a Responses backend has to speak.

## 2. Why the relay shows the model but cannot serve it

- Provider `opencode` in `~/.llm-relay/config.json`: `base https://opencode.ai/zen/v1`,
  `kind: "openai"`, `authEnv: OPENCODE_API_KEY`, `timeoutMs: 120000`, `tierType: "mixed"`. The
  credential lives in the relay keystore (`opencode#default`, added 2026-08-25, `active`), not in
  any environment scope — `OPENCODE_API_KEY` is absent from HKCU, HKLM and the process. That is
  fine: the keystore is what the relay reads, and Zen's free models do not need it anyway.
- `kind: "openai"` means `/chat/completions`, which Zen does not serve for Muse. There is no
  config-only fix: no provider kind speaks Responses, and Zen's `/messages` (Anthropic-format)
  endpoint also 500s for Muse, so `kind: "anthropic"` does not help either (row 7).
- `llm-relay keys` reports the credential `UNVERIFIED — /models is public and the probe model
  answers HTTP 401 with or without the key`. The probe model is a **paid** Zen SKU that answers
  `401 no payment method` regardless of the key; row 2 verifies the key in one call. The key check
  should probe a free-class model when the provider has one (backlog).

## 3. Three routes, in order of availability

### Route A — a `cli` dispatch rung on the OpenCode CLI (LIVE since 2026-09-04)

**Status: live.** Four `opencode-muse-spark` rungs — one per ladder, `--variant
low|medium|high|xhigh` — sit right after `claude-free-pool` in `~/.llm-relay/config.json`
(inserted 13:34 local; revert file `config.json.bak-2026-09-04-pre-opencode-muse`). The daemon
restarted onto v0.71.1 at 13:42 loaded them: `dispatch_lanes medium` lists the rung `[ready]` at
position 4, and MCP `dispatch` with `lane: "opencode-muse-spark"` from an empty directory answered
`OK` in 6 s (`job-0001`, exit 0). Owner decisions behind it: automatic routing of the contributor
SKU allowed; route A now, route B as a lap (§5).

Mirror the agy rungs: same launcher, same timeout, the binary named by full path. One rung per
ladder so the tier carries the effort, exactly as the agy Gemini rungs bake the effort into the id.

```json
{
  "id": "opencode-muse-spark",
  "kind": "cli",
  "command": "pwsh",
  "args": [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", "C:\\Users\\<user>\\.llm-relay\\bin\\lane-launch.ps1", "--timeout", "2100",
    "C:\\Users\\<user>\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
    "run", "--pure", "--model", "opencode/muse-spark-1.3-contributor-free",
    "--variant", "<low|medium|high|xhigh — one rung per ladder>",
    "{task}"
  ],
  "quota": "opencode-zen-free",
  "enabled": true,
  "note": "Meta Muse Spark 1.3, contributor tier on OpenCode Zen: free, prompts and completions are Meta training data (owner accepted <date>). Zen serves this SKU on the Responses API only, which the relay cannot speak yet — see docs/muse-spark-1.3-opencode-zen-2026-09-04.md."
}
```

What is verified and what is not:

- Verified: the exe path exists (`opencode-ai/bin/opencode.exe`, 179 MB, hard-linked from
  `opencode-ai/node_modules/opencode-windows-x64/bin/`; the `opencode` on PATH is an npm `.cmd`
  shim, which a `shell: false` spawn cannot start); `opencode run` accepts
  `--model`, `--variant` ("provider-specific reasoning effort"), `--format json`, `--pure`
  (no external plugins), `--dir`; the model answers with no credential.
- Measured: the exe run with `--pure --variant high` from an empty directory exits 0 in 9 s and
  prints an ANSI reset, the banner `> build · muse-spark-1.3-contributor-free`, a blank line and
  `OK`, CRLF-terminated (row 15).
- Not verified: that `--variant xhigh` reaches Zen as `reasoning.effort: xhigh` (the API accepts
  the value, row 11; the CLI runs with the flag, but its mapping is unmeasured); that the launcher keeps the window hidden
  for this binary — the relay spawns with `windowsHide: true` and `lane-launch.ps1` was validated
  for agy on 2026-08-31, so run the same top-level-window watcher once before enabling the rung.
- Known limits: `laneOfCommand` (`src/lane-manifest.ts:101`) recognises only `agy` and `codex`,
  so `llm-relay lanes --probe` will not validate this rung's model id and a typo surfaces only at
  run time; quota cooldowns, exhaustion recording and hidden launch still work because they key on
  the rung, not the vocabulary. `opencode run` is an agent with tools: its permissions come from
  `opencode.json` in the run directory (this repo's file says `ask` for edit and bash), and headless
  `ask` behaviour is unmeasured; never add `--auto`. Default output carries a `> build ·
  <model>` banner line before the answer.

### Route B — a Responses upstream backend in the relay (a feature lap)

The relay already owns every neighbouring translation: Messages→Chat (`src/openai-request.ts`,
624 lines), Chat SSE→Anthropic (`src/dialect-stream.ts`, `src/stream-pipeline.ts`), and the
Responses **front** (`src/responses-request.ts`). What is missing is the mirror of the front:

- request: Anthropic Messages → Responses (`instructions` ← system; `input` items ← turns, with
  `function_call` / `function_call_output` for tool turns; `tools` as flat `{type:"function",
  name, parameters}`; `max_output_tokens`; `reasoning.effort` ← the pool's effort tier;
  `stream`);
- response: `output[]` items → content blocks (`message.output_text` → text, `function_call` →
  `tool_use` with `call_id` round-tripped, `reasoning` → dropped or thinking); usage incl.
  `output_tokens_details.reasoning_tokens` and `input_tokens_details.cached_tokens` (row 12);
- stream: the event set in row 13 plus `response.function_call_arguments.delta/done` → Anthropic
  SSE.

Shape choice for the config: a third `Kind` value (`"responses"`) touches every `kind ===`
branch (about 55 sites in 19 files — `grep -c 'kind === "openai"'`), whereas a `wire:
"responses"` option on `kind: "openai"` keeps discovery, catalog and key-check paths unchanged
and only forks the request/response builders. Prefer the option. After it lands,
`opencode/muse-spark-1.3-contributor-free` becomes an exact `provider/model` target on both fronts,
MCP `dispatch` `mode: "answer"` works, and the relay can carry it keyless (Zen needs none).

### Route C — pools

Automatic admission will not happen (finding 6) until a benchmark source publishes the 1.3 SKU
and the sync lands an exact row; the `-contributor-free` suffix also defeats the match against the
base row, since `muse-spark-1.2-contributor-free` finds nothing although `muse-spark-1.2` exists.
Once route B works, pin it: `llm-relay pools add <tier> opencode/muse-spark-1.3-contributor-free`
(the `preferred` prefix). If the owner rejects the terms, the opposite lever exists per pool:
`routing.poolPolicies.<tier>.exclude` (`src/config-types.ts:486`).

## 4. Side findings (each verified, each with a home)

1. **Paid Zen SKUs sit in the "free" pools — deliberately — and the guard meant to bound them is
   off here.** Cost stopped gating pool ADMISSION in the server decomposition (`28efb91`;
   `test/dynamic-pools.test.ts`: "Reversed deliberately… Paid capacity is now reachable but ordered
   strictly behind every free member, and the `freeOnly` guard (default ON for offload) is what
   keeps a pool free-only"). Zen's `/models` carries no prices, so `assessCost` classes
   `opencode/claude-fable-5`, `gpt-5.6-sol`, `kimi-k3` … as `unknown` and `orderBandByCost` places
   them after the free entries (`src/dynamic-pools.ts:206-208`); they have exact tier-data rows, so
   they are in-band for every tier: 27 `opencode/*` members in `pool/medium` at 09:55, beside
   `openrouter/anthropic/claude-opus-5` and `kilo/anthropic/claude-fable-5`. The live config has
   `freeOnly: false` on all three offload rules, so a walk whose free members all fail reaches
   them; today they all refuse (Zen `401 no payment method`, OpenRouter and Kilo 402), so nothing is
   spent. Each Zen 401 re-confirms the accepted interpretation (`subscription-required`, scope
   `credential`, `costClasses: ["paid","unknown"]`, 2026-08-29) for 24 h — `runtime-telemetry`
   counts `gemini-3.5-flash-lite` 11/0, `minimax-m2.7` 11/0, `gpt-5.1` 9/0, `kimi-k2.5` 9/0,
   `gpt-5` 5/0 (calls/successes) — and at 09:47 that fact had 837 min left, yet by 09:55 it was
   gone, right after row 2's success on a **free** deployment of the same credential, which the
   fact never covered. Trigger not confirmed in a log; the relay writes none. The
   `dynamic-pools.ts` row of `CLAUDE.md` still described the pre-reversal rule; corrected today.
   → backlog (owner decision on `freeOnly`; cost-class-aware retraction).
2. **`llm-relay keys` cannot verify a mixed provider whose probe model is paid** (§2). → backlog.
3. **The OpenCode CLI had been dead since an update.** `opencode` 1.18.27 was installed without
   its postinstall (`~/.npmrc` `allow-scripts=llm-relay,esbuild` did not list it) and every
   invocation exited with "postinstall script was not run". Reinstalled 1.18.28 with
   `--allow-scripts=opencode-ai` and added `opencode-ai` to the `.npmrc` list so the next update
   cannot repeat it. Machine-wide fact → `C:\Code\docs\backlog.md` standing traps and project
   memory.
4. **NIM serves a different free Meta model.** `nim/meta/muse-glimmer-30b` (Muse Glimmer 30B,
   131k context) is priced 0 on NIM and already sits behind a configured provider; it is not Muse
   Spark and was not probed.

## 5. Decision for the owner

Everything in routes A-C is engineering; one thing is not. Sending offloaded subagent traffic —
file contents, diffs, instructions — to a contributor SKU makes it Meta training data. Options:

- **A. Allow contributor SKUs in automatic routing.** Most free capacity; every pool walk that
  lands on it ships the task text to Meta.
- **B. Explicit only.** Reachable as a named dispatch lane (route A now, route B later) and as an
  exact `provider/model` spec; both contributor ids added to every pool's `exclude` so no
  automatic walk selects them.
- **C. Do not use contributor SKUs.** Nothing to build; revisit if Zen or Meta publishes a
  non-contributor free tier.

Route B (the Responses backend) is worth building under A or B; under C it is only worth building
if another Responses-only provider appears.

**Decided 2026-09-04 (owner):** option **A** — contributor SKUs may be routed automatically. Build
route A now (done, §3) and route B as a lap (backlog). On the side finding, `freeOnly` stays
`false` on all three offload rules: paid capacity strictly behind every free member is the
deliberate last resort, and the pools' free-first contract is stated in the `dynamic-pools.ts` row
of `CLAUDE.md` and in HANDOFF §6.

**Owner decision 2026-09-04: A — allow contributor SKUs in automatic routing.** The terms
question is settled; what remains is engineering. Route B (the Responses upstream) is the enabling
work, and finding 6 still holds: with no tier-data row the model enters no effort pool on its own,
so both contributor ids are to be pinned as `preferred` once route B lands. Route A (the
OpenCode-CLI dispatch rung in §3) is available before that with no relay change. Work items:
`docs/backlog.md`.

## Sources

- Announcement: <https://x.com/opencode/status/2095332254855647493>
- Zen docs (endpoints, contributor terms): <https://opencode.ai/docs/zen/>
- Meta model page and pricing: <https://developer.meta.com/ai/models/muse-spark/>
- Catalog: <https://models.dev/api.json> (provider `opencode`, 97 ids incl. deprecated)
- Live list: <https://opencode.ai/zen/v1/models> (66 ids, no price fields)
