# Free provider setup — 2026-07-29

Final state of llm-relay's free capacity, what was broken, and what remains.
Backups: `~/.llm-relay/config.json.bak-2026-07-29`, `.bak2-2026-07-29`.

## ⚠ Action required: rotate two Mistral keys

During this session a PowerShell helper function named `H` collided with the built-in `h`
alias for `Get-History`. The resulting error message **printed the values** of
`MISTRAL_API_KEY` and `CODESTRAL_API_KEY` into the session transcript.

**Rotate both at https://console.mistral.ai/api-keys.** No other key was exposed.

## Final state — 15 providers, 34 verified pool members

| Provider | Key | Free allowance | In pools |
|---|---|---|---|
| nim | `NVIDIA_API_KEY` | 40 req/min | ✅ |
| gemini | `GOOGLEAI_API_KEY` | per-model; Pro is tight | ✅ |
| mistral | `MISTRAL_API_KEY` | 25k–20M tok/min per model | ✅ |
| codestral | `MISTRAL_API_KEY` | 30 req/min, 2,000/day — **separate bucket** | ✅ |
| groq | `GROQ_API_KEY` | ~14,400 req/day on 8B | ✅ |
| cerebras | `CEREBRAS_API_KEY` | 1M tokens/day | ✅ |
| cohere | `COHERE_API_KEY` | 20 req/min, 1,000/month | ✅ |
| huggingface | `HUGGINGFACE_API_KEY` | $0.10/month credit | ✅ |
| openrouter | `OPENROUTER_API_KEY` | 20 req/min, 50/day, 14 free models | — |
| opencode | `OPENCODE_API_KEY` | 6 `-free` models | ✅ |
| kilo | `KILO_API_KEY` | 11 `:free` models | ✅ |
| cloudflare | `CLOUDFLARE_API_KEY` | 10,000 neurons/day | ✅ |
| ollama-cloud | `OLLAMA_API_KEY` | 8 of 19 hosted models free | ✅ |
| ollama (local) | none | unlimited, offline | ✅ |
| anthropic | passthrough | — | n/a |

**Rejected: Vercel AI Gateway** (`VERCEL_API_KEY`). Returns HTTP 403 — *"AI Gateway
requires a valid credit card on file"*. Not free; not added.

**Ollama Cloud free vs. paid** — probed all 19 individually:

- Free ✓ `nemotron-3-ultra` · `gpt-oss:120b` · `gpt-oss:20b` · `minimax-m3` ·
  `minimax-m2.5` · `gemma4:31b` · `nemotron-3-super` · `nemotron-3-nano:30b`
- 403 subscription: `glm-5.2`, `glm-5.1`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`,
  `kimi-k2.5`, `deepseek-v4-pro`, `deepseek-v4-flash`, `minimax-m2.7`,
  `mistral-large-3:675b`, `qwen3.5:397b`

**Local Ollama**: `qwen2.5-coder:7b` pulled (4.7 GB). Sized to the RTX 5060 Ti's **8 GB**
VRAM — note `Win32_VideoController.AdapterRAM` reports 4 GB, which is the well-known 32-bit
overflow; `nvidia-smi` gives the true 8151 MiB. With 64 GB system RAM a 14B would run
partially on CPU, but slowly.

## What was broken

`llm-relay keys` reported 5/6 healthy. It was wrong twice, because it probes `/models`,
which several providers serve **unauthenticated** — a revoked OpenRouter key reported
`VALID | Models: 367` while every completion returned `401 User not found`.

**The pools were mostly dead specs.** All three pointed only at NIM:

| Old member | Result |
|---|---|
| `nim/moonshotai/kimi-k2.6` | ❌ HTTP 404 — not servable on this account |
| `nim/deepseek-ai/deepseek-v4-pro` | ❌ empty response, twice, at 90s |

`pool/coding` had **1 live member of 3**; `pool/reasoning` **1 of 2**. Offload was running
single-model, single-provider, with failover that existed only on paper.

## Verification

Every one of the 34 pool members was probed individually with a real completion through the
relay. **30 LIVE.** Three transient (not removed — failover covers them):

- `gemini/gemini-2.5-pro` — 429, free-tier quota
- `cerebras/zai-glm-4.7` — "high traffic", passed directly minutes earlier
- `mistral/magistral-medium-latest` — slow reasoning model, exceeded the probe timeout

All three pools resolve end-to-end after a `.vbs` restart:

```
pool/coding    -> gemini-2.5-flash       "OK"
pool/reasoning -> z-ai/glm-5.2           "OK"
pool/fast      -> gemini-2.5-flash-lite  "OK"
```

## Two traps worth remembering

**1. `${ENV}` in a provider `base` is a whole-relay outage risk.** Cloudflare's URL embeds
an account ID. Written as `${CLOUDFLARE_ACCOUNT_ID}`, an unset value makes `config.ts:381`
throw and the **entire relay refuses to start** — and since headroom→relay is in the path of
every Claude Code session, that is a total outage caused by one optional provider. It is now
a **literal** account ID; the config has zero `${}` references.

This also explains a confusing symptom: launching the `.vbs` from a shell whose environment
predates a `setx` fails, because `wscript` inherits the *calling process's* environment, not
the registry. At real boot it inherits the true User env and works.

**2. `~/.llm-relay/.env` is written by `onboard` but never read.** Only `process.env` is
consulted (`config.ts:328`, `config.ts:380`). Keys must be **User-scope** (`setx`) plus a
relay restart. `CODESTRAL_API_KEY`, `LLM_BACKEND_API_KEY` and `LLM_BACKEND_BASE_URL` are
currently process-scope only — invisible to the relay. Codestral doesn't need its own key
(see below), so only address the others if something depends on them.

## Notes

- **`MISTRAL_API_KEY` and `CODESTRAL_API_KEY` are interchangeable.** Same signup, same
  account. The two variables hold different strings but **both authenticate against
  `codestral.mistral.ai`** (HTTP 200 each). The `codestral` provider therefore declares
  `authEnv: MISTRAL_API_KEY`, and `CODESTRAL_API_KEY` is redundant. It is still a separate
  provider entry because that host meters its own free bucket.
- **A Groq 403 may be network, not credentials.** The earlier 403 was a VPN: Groq blocks
  some VPN egress. Check egress before concluding a key is bad.
- **The relay's "provider does not list model" warning is a false positive for Gemini.** Its
  catalog stores `models/gemini-2.5-flash`; Google's OpenAI-compat endpoint accepts the bare
  id. Both forms return 200. The warning can be ignored.
- **The `.vbs` runs the globally installed llm-relay**
  (`%APPDATA%\npm\node_modules\llm-relay\dist\cli.js`), not this repo's `dist/`. Both are
  0.9.0 today; after a repo change they diverge until a global reinstall.

## Follow-up worth fixing in llm-relay

1. **`keys` gives false confidence.** It calls `/models`, which OpenRouter and others serve
   unauthenticated, so a revoked key reports VALID. It should issue a minimal authenticated
   completion, or use key-introspection (`/auth/key` for OpenRouter) where available.
2. **`~/.llm-relay/.env` is written but never read.** Load it at startup, or stop `onboard`
   from implying persistence.
3. **Nothing detects a dead pool member.** `kimi-k2.6` 404'd on every call and stayed top of
   `coding`. The ping loop already exists and could demote a member that never answers.
4. **An unset `${ENV}` in a provider `base` should not be fatal to the whole relay.**
   Disabling that one provider with a warning is proportionate; refusing to start is not.
