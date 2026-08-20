# llm-relay quick start

**Hand this file to your AI coding assistant and say "set this up for me."** It is written to
be followed by an assistant with shell access, but a human can follow it too.

Goal: run Claude Code (or any Anthropic-API client) so that **bulk background work runs on
free third-party quota** while your own conversation keeps using your own subscription.

Nothing here is required all at once. Stage 1 is useful on its own; each later stage adds
capability. **Stop wherever it stops being worth it.**

---

## What this actually does

llm-relay is a loopback proxy for the Anthropic `/v1/messages` API. Your client points at it
instead of `api.anthropic.com`. It then:

- forwards your **own** conversation to real Anthropic, untouched (your subscription, your model);
- optionally routes **subagents** to free providers instead (this is the quota saving);
- validates and repairs the tool calls weaker models emit, so they can drive an agent loop.

The key idea: a subagent doing "read 20 files and summarise" does not need a frontier model.
Free providers are plenty, and that work is where the tokens go.

> **Assistant note:** the user must create the accounts and paste the keys themselves. Never
> ask them to send you a key, and never type one into a file on their behalf if you can have
> them set an environment variable instead.

---

## Stage 1 — install and run (10 minutes)

```bash
npm install -g llm-relay
```

Generate a starter config:

```bash
llm-relay onboard
```

That writes `~/.llm-relay/config.json`. Then start it:

```bash
llm-relay
```

It listens on `127.0.0.1:8791` and refuses to bind anything non-loopback — it holds provider
keys. Its data plane relies on the configured client/provider credentials; stateful and costly
control routes independently require the per-install capability that the CLI manages automatically.

**Point Claude Code at it** by adding to the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8791" } }
```

> ⚠️ Use the settings file, not a shell environment variable. Some launchers set
> `ANTHROPIC_BASE_URL` into the process environment themselves, which silently overrides a
> user-level variable — and then nothing looks wrong while the proxy is not in the path.

**Known cost of a custom base URL:** Claude Code's `/remote-control` is hard-gated to
`api.anthropic.com` and will not work behind any proxy. There is no workaround; if you rely
on it, stop here. Claude Code also drops the 1M-context beta header behind a custom base URL.

At this point everything still goes to Anthropic. Nothing is saved yet — but nothing is broken
either, which is the right place to verify from.

---

## Stage 2 — add free providers (the actual savings)

Every provider below has a genuinely free tier. **Get as many as you have patience for; two
or three is enough to be useful.** More providers mainly buys resilience, since any one can
rate-limit you.

| Provider | Free allowance | Sign up | Env var |
|---|---|---|---|
| **Cerebras** | 1M tokens/day, no card | https://cloud.cerebras.ai | `CEREBRAS_API_KEY` |
| **Groq** | ~14,400 req/day on small models | https://console.groq.com/keys | `GROQ_API_KEY` |
| **Google AI Studio** | generous on Flash models | https://aistudio.google.com/app/apikey | `GEMINI_API_KEY` |
| **NVIDIA NIM** | 40 req/min | https://build.nvidia.com | `NVIDIA_API_KEY` |
| **Mistral** | large per-model token budgets | https://console.mistral.ai/api-keys | `MISTRAL_API_KEY` |
| **OpenRouter** | 20 req/min, 50 req/day, many `:free` models | https://openrouter.ai/keys | `OPENROUTER_API_KEY` |
| **Cohere** | 20 req/min, 1,000 req/month | https://dashboard.cohere.com/api-keys | `COHERE_API_KEY` |

Set the keys so they persist across restarts.

**macOS / Linux** — add to `~/.zshrc` or `~/.bashrc`:

```bash
export CEREBRAS_API_KEY="csk-..."
```

**Windows** — `setx` writes to the registry, and only affects *new* processes:

```bash
setx CEREBRAS_API_KEY "csk-..."
```

Either way, **restart the relay afterwards** or it will not see the new keys.

Alternatively put them in `~/.llm-relay/.env` as `KEY=value` lines — llm-relay reads that file
at startup. A variable already set in your environment always wins over the file.

Optional: if one provider has multiple accounts, replace that provider's `authEnv` with a
credential fleet in `~/.llm-relay/config.json`:

```jsonc
"nim": {
  "base": "https://integrate.api.nvidia.com/v1",
  "kind": "openai",
  "credentials": [
    { "label": "personal", "authEnv": "NVIDIA_API_KEY" },
    { "label": "work", "authEnv": "NVIDIA_WORK_API_KEY" }
  ],
  "tierType": "free"
}
```

Use `authEnv` or `credentials[]` on a provider, never both. A fleet slot's env name is exact (it
does not use the legacy provider alias lookup), and its label is visible non-secret metadata.

Now verify, and **do not skip this** — the two checks answer different questions:

```bash
llm-relay keys
```

```bash
llm-relay pools --probe
```

`keys` checks every configured credential slot. `pools --probe` spends one real completion per
unique deployment in your routing pools, through one serviceable slot — not once per credential.
It is the only way to catch a model that is configured, listed by the provider, and nonetheless
dead. Remove a deployment from `routing.pools` only for deployment-level `DEAD` evidence. An
`AUTH` result belongs to one credential slot: fix, rotate, or disable that slot. It does not by
itself invalidate sibling slots or prove that the deployment is dead. `keys` names each slot as
`provider#label`.

> **Assistant note:** never add a model to a pool without probing that exact spec first. A
> plausible-looking model id that 404s will sit at the top of a pool and burn a failover hop
> on every single request.

---

## Stage 3 — choose client-specific offload

Offload is **off by default**, deliberately. Enable only the harnesses and request scope you want:

```bash
llm-relay offload <harness> <on|off> [--scope <scope>]
```

`<harness>`: `claude` | `codex` | another configured client. `<scope>`: `subagents` | `all`
(default: `subagents`).

Claude Code subagents (Explore, general-purpose, custom agents) now route to your free pools while
the Claude conversation stays on its normal route. Codex is independently configured; `--scope all`
also routes the Codex parent conversation through the pool. Changes take effect on the next request;
no restart.

```bash
llm-relay offload status
```

Use `llm-relay offload <harness> off` to disable one harness. The legacy boolean form remains
supported in config files as a global subagents-only rule, but CLI changes require a harness name.

To offload a **single** dispatch without turning the switch on globally, put this as the first
line of that subagent's prompt:

```
@relay: pool/high
```

The line is stripped before forwarding, so the model never sees it.

**Choosing targets:**

```bash
llm-relay candidates
```

That prints capability, price, latency and quota as separate columns — deliberately not blended
into one score, because which column matters depends on the task.

> ⚠️ Offloaded output is **advisory**. It comes from a different, usually weaker model. Verify
> claims against real files before acting on them. Do not delegate judgement to this lane.

---

## Stage 4 (optional) — local models

Free, unlimited, offline, and no rate limits — but bounded by your hardware.

```bash
ollama pull qwen2.5-coder:7b
```

Roughly: a 7B model needs ~8 GB of VRAM, 14B ~16 GB, 32B ~24 GB. Below that it runs on CPU and
gets slow. Add to `~/.llm-relay/config.json`:

```json
"ollama": { "base": "http://localhost:11434/v1", "kind": "openai" }
```

No key needed. Ollama also offers a **cloud** tier (`https://ollama.com/v1`, `OLLAMA_API_KEY`)
with some free hosted models and some subscription-only ones — probe before relying on any.

---

## Stage 5 (optional) — your other subscriptions

If you pay for other AI CLIs, they are additional capacity that llm-relay cannot reach
directly: their quota is tied to their own client credentials. **Each subscription spends its
own quota — there is no way to make one vendor's client spend another's.**

The relay can still tell you which lane to use next:

```bash
llm-relay dispatch -t "trace every caller of parseConfig"
```

It returns an ordered ladder and the exact command to run. **You (or your assistant) run it —
the relay never spawns a CLI.** Configure the order in `routing.ladder`; add a rung per CLI you
actually have, e.g. `codex exec` for a ChatGPT subscription. Omit the ones you don't.

If a lane is out of credit, record it and get the next:

```bash
llm-relay dispatch -x codex
```

> A refusal or a bad answer is a *judgement*, not a transport failure. Only availability
> failures (quota, rate limit, missing CLI) justify walking to the next rung — otherwise you
> are just shopping for a more agreeable answer.

---

## Troubleshooting

**Everything fails to start.** The proxy is now in the path of every session. Escape hatch:
remove `ANTHROPIC_BASE_URL` from `~/.claude/settings.json`.

**A provider is disabled at startup.** If a provider's `base` contains `${SOME_VAR}` and that
variable is unset, that one provider is disabled with a warning and everything else keeps
working. Set the variable, or use a literal value, and restart.

**`keys` says a key is fine but requests fail.** Run `llm-relay pools --probe` — the key can be
valid while the specific *model* is dead or not on your plan. With a credential fleet, `keys`
checks every slot while the probe deliberately uses only one serviceable slot per deployment.

**`keys` reports one credential slot as `INVALID_KEY`.** Its row names the `provider#label`; fix, rotate,
or disable that slot. `llm-relay candidates` shows the slot's affected deployment cells and policy.
Do not remove the whole deployment or its sibling slots unless you also have deployment-level
evidence that the model is unavailable.

**`keys` reports UNVERIFIED.** That means the provider serves its model list publicly *and*
answers the probe identically with and without your key, so nothing could be concluded. It is
not an accusation. `pools --probe` is the ground truth.

**A 403 that appears out of nowhere.** Check whether a VPN is running — some providers block
VPN egress, which looks exactly like a rejected key.

**Windows: launching from a stale shell fails.** A process inherits the environment of whatever
started it, not the registry. If you `setx` a variable, shells opened *before* that will not
have it, and anything they launch will not either.

---

## Machine-specific: this is not part of the standard setup

The author's own machine layers extra things on top. **You do not need any of it**, and copying
it blindly will cause problems:

- **A second proxy (`headroom`) in front of llm-relay** for context compression. It means two
  processes must be running for anything to work at all.
- **Windows `.vbs` autostart scripts** in the Startup folder. Platform-specific; on
  macOS/Linux use `launchd`/`systemd` or just run it in a terminal.
- **A dispatch ladder naming specific agent CLIs** (`agy`, `codex`) that you probably do not
  have installed. Configure `routing.ladder` with your own tools, or leave it out.
- **Specific pool membership.** Model ids churn constantly — that config is a snapshot of what
  was live on one account on one day, not a recommendation. Build your pools from
  `llm-relay candidates` and confirm with `pools --probe`.
- **`mode: "repair"` with a configured reshaper.** Sensible when driving weak models hard;
  `mode: "detect"` is the simpler starting point and needs no reshaper.
