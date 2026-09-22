# llm-relay quick start

Set up the loopback proxy and MCP dispatch server, then enable only the routing you need.
The proxy routes selected client requests to your configured providers; MCP dispatch delegates
complete tasks to configured agent lanes. Each stage is optional after the basic installation.

## One dispatch rule for every host

When an assistant has llm-relay MCP tools, use `dispatch` for a self-contained task. The MCP
server chooses the lane and returns its answer; the assistant does not need to identify its host
or construct a lane command.

Without MCP, use the advisory CLI fallback:

```bash
llm-relay dispatch --next-command -t "<the whole task>"
```

Follow the returned command or target. Do not assume that a host's native child agents can use
`pool/*` model names. Use MCP `dispatch` for Codex Desktop and Claude Desktop rather than relying
on their native child traffic reaching the proxy.

A global install registers the MCP server for local Codex. For Claude, register it once:

```bash
claude mcp add --scope user llm-relay -- llm-relay mcp
```

Other MCP hosts should register the stdio command `llm-relay mcp` in their MCP settings.

## What this actually does

The HTTP proxy supports clients that honor a custom API base URL. With the starter Anthropic
passthrough configuration, ordinary conversations retain their normal route; enabling subagent
only offload sends marked child requests to the configured offload targets. Repair mode can
correct malformed tool calls, but it does not supply judgment or invent intent.

MCP dispatch is separate: it hands a whole task to a lane and can launch the configured agent
process. It does not require the host's own HTTP traffic to pass through the relay.

> **Credential handling:** create provider accounts and enter keys locally. Do not paste keys into
> an assistant conversation. Treat `.env`, `keystore.json` and `control-token` as secrets.

## Stage 1 — install and run

Use Node.js 22 or later:

```bash
npm install -g llm-relay
llm-relay onboard
llm-relay
```

Onboarding creates a starter configuration. The legacy default is `~/.llm-relay/config.json`.
With XDG variables set, config and cache artifacts prefer their XDG locations, but an existing
legacy artifact remains in use when its preferred counterpart is absent. Nothing is migrated
automatically. Use the paths reported by the CLI when they differ from the legacy examples below.

The default listener is `127.0.0.1:8791`. Other valid ports and the supported loopback hosts
`localhost` and `::1` are configurable; non-loopback hosts are rejected. The data plane uses
configured client/provider credentials. Protected control routes separately require the
per-install token, which the CLI manages automatically.

For a terminal-launched Claude CLI that honors a custom base URL, add this environment setting
to `~/.claude/settings.json`, preserving any existing settings:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8791" } }
```

Verify that requests reach the relay: launchers can override inherited environment settings.
A desktop host that bypasses custom base URLs should use MCP dispatch instead. Check required
host features before changing its base URL; direct-provider features and extended-context support
may behave differently behind a proxy. See [reference.md](reference.md) for recorded host caveats.

With the starter passthrough configuration, verify ordinary requests before enabling offload.

## Stage 2 — add providers

Choose providers and models for which you have access. Free tiers, prices and allowances depend
on the account and model and can change; verify the provider's current terms rather than treating
this guide as a quota promise. Multiple providers give the relay alternatives when one is unavailable.

| Provider | Account/key page | Env var |
|---|---|---|
| Cerebras | https://cloud.cerebras.ai | `CEREBRAS_API_KEY` |
| Groq | https://console.groq.com/keys | `GROQ_API_KEY` |
| Google AI Studio | https://aistudio.google.com/app/apikey | `GEMINI_API_KEY` |
| NVIDIA NIM | https://build.nvidia.com | `NVIDIA_API_KEY` |
| Mistral | https://console.mistral.ai/api-keys | `MISTRAL_API_KEY` |
| OpenRouter | https://openrouter.ai/keys | `OPENROUTER_API_KEY` |
| Cohere | https://dashboard.cohere.com/api-keys | `COHERE_API_KEY` |

Persist keys locally. For a shell-launched relay on macOS/Linux, add an export to the shell's
startup file:

```bash
export CEREBRAS_API_KEY="<your key>"
```

On Windows, `setx` changes the environment for **new** processes:

```bash
setx CEREBRAS_API_KEY "<your key>"
```

Restart the relay from an environment containing the new values. Alternatively, use `KEY=value`
lines in the relay's `.env` file (legacy default `~/.llm-relay/.env`). It is read at startup;
already-set environment variables take precedence. Config reload does not refresh the process's
inherited environment.

For multiple keys on one provider, replace its `authEnv` with a credential fleet. For example,
inside `providers` in the active configuration:

```json
"nim": {
  "base": "https://integrate.api.nvidia.com/v1",
  "kind": "openai",
  "credentials": [
    { "label": "personal", "authEnv": "NVIDIA_API_KEY" },
    { "label": "work", "authEnv": "NVIDIA_WORK_API_KEY" }
  ]
}
```

Use `authEnv` or `credentials[]`, never both. Fleet env names are exact; they do not use legacy
provider aliases. Labels are visible metadata, so do not put secrets in them. Adding providers
or changing credential identity requires a restart.

Verify credentials and actual model access separately:

```bash
llm-relay keys
llm-relay pools --probe
```

`keys` checks configured credential slots. `pools --probe` makes real completion requests through
one serviceable slot per unique deployment in the routing pools, not once per credential.
A listed model can still be unavailable to your account.

| Verdict | Meaning and action |
|---|---|
| `AUTH` | No enabled, model-eligible slot held a key; no request was sent. Check the key, slot enablement and model restrictions. |
| `DENIED` | The provider answered 401/403. Check both credential validity and model entitlement; the probe does not distinguish them. |
| `DEAD` | Deployment-level failure evidence; inspect it before changing pool membership. |

A credential failure does not invalidate sibling slots or prove the deployment is dead. Probe an
exact model spec before adding it to a pool; do not substitute a plausible-looking model name.

## Stage 3 — choose client-specific offload

Offload affects only HTTP requests that already reach the relay. It is not needed for MCP dispatch
and cannot intercept native children from a bypassed host. It is off by default.

```bash
llm-relay offload <client> <on|off> [--scope <scope>]
```

The built-in client keys are `claude`, `codex`, `openai` and `default`. They are derived from request
paths, not arbitrary application names. `default` supplies the fallback rule when a client has no
specific rule. Other configured labels match no front door.

The default scope, `subagents`, applies only to marked child requests and keeps the parent on its
normal route. `--scope all` also applies the configured offload mapping to the client's parent
conversation. Offload changes take effect on the next request without a restart.

```bash
llm-relay offload claude on --scope subagents
llm-relay offload status
llm-relay offload claude off
```

The legacy boolean config form remains a global subagents-only rule; CLI changes require a client
name. To override one marked subagent request on an already-routed client, put a directive in its
initial prompt using a configured pool or provider spec:

```text
@relay: pool/high
```

The directive is stripped before forwarding. An unknown pool or provider fails explicitly rather
than silently spending the primary route's quota.

Use `llm-relay candidates` to compare capability, price, latency and quota separately. Treat
delegated output as advisory and verify claims against source material before acting.

## Stage 4 (optional) — local models

A local provider uses your hardware rather than a hosted model allowance. Choose a model,
quantization and context size suited to that hardware; parameter count alone is not a memory budget.

For example, with Ollama installed:

```bash
ollama pull qwen2.5-coder:7b
```

Add a provider entry inside `providers` in the active config, then restart:

```json
"ollama": { "base": "http://localhost:11434/v1", "kind": "openai" }
```

Add and probe the exact local model spec before relying on it for routed work. A local endpoint
and a provider's cloud offering are separate configurations; do not assume they share access or quotas.

## Stage 5 (optional) — your other subscriptions

Configured agent CLIs can use their own authenticated subscriptions. Each lane spends its own
provider/account allowance; llm-relay does not convert one vendor's subscription into another's.

Configure `routing.ladder` with only the tools available on your machine. The CLI command below
is advisory: it returns a ladder and the command to run, rather than executing the selected lane.

```bash
llm-relay dispatch -t "trace every caller of parseConfig"
```

By contrast, **MCP `dispatch` can launch configured CLI lanes** and return their results. Daemon-owned
attempts can survive an MCP host restart while the daemon remains alive. This is not automatic
continuation of a killed harness session; active hard-cap continuation remains planned in
[backlog.md](backlog.md).

To exclude an unavailable lane and request the next choice:

```bash
llm-relay dispatch -x codex
```

Only availability failures justify walking the ladder. Do not treat disagreement or an unwanted
answer as a transport failure and keep retrying for a preferred judgment.

## Troubleshooting

**A client stops working behind the proxy.** Restore its prior base-URL setting. For the Claude
configuration above, remove only the added `ANTHROPIC_BASE_URL` entry, preserving other settings.

**A provider is disabled at startup.** An unset `${SOME_VAR}` in its `base` disables that provider
with a warning. Supply the variable or a literal base URL and restart. If required routing is left
unusable, resolve that configuration error rather than assuming startup can continue.

**`keys` succeeds but requests fail.** Run `llm-relay pools --probe` to test actual deployment access.
A valid credential does not prove that a particular model is available on its plan.

**One slot is `INVALID_KEY`.** Fix, rotate or disable the named `provider#label`, not every slot on
the deployment. `llm-relay candidates` shows affected deployment cells and policy.

**`keys` reports `UNVERIFIED`.** The check produced no conclusive credential evidence; it does not
mean the key is invalid. Read the row's explanation, then probe the exact model.

**A request returns 403.** Check credential and model entitlement as well as network restrictions,
including VPN egress. The status alone does not identify the cause.

**An edit has not taken effect.** Run `llm-relay reload` for supported config changes. If it reports
restart-only fields, the candidate was not partially applied: restart to load them. Environment
changes also require a process started with the new values; `setx` does not update existing shells.

## Machine-specific: this is not part of the standard setup

Do not copy another machine's proxy chain, startup scripts, dispatch ladder or model list without
checking them. The standard setup does not require a second compression proxy or platform-specific
autostart scripts. Configure only installed lanes, and build pools from current candidates verified
by probes. Start with `mode: "detect"`; use repair mode only with the required reshaper configuration.
