# llm-relay reference

The full usage reference. The [README](../README.md) is the short version; this file covers
config, routing, pools, offload, repair, the CLI, endpoints, and the caveats.

---

## What it does

- **Transparent passthrough** — forwards streaming and non-streaming `/v1/messages` byte-for-byte.
- **`detect` mode** — deterministic tool_use validation (Ajv2020) with metadata-only logging of
  pass/fail/uncheckable. Behavior is unchanged; it only observes.
- **`repair` mode** — on a validation failure, a cheap reshaper model corrects the call, the
  result is **re-validated**, and the corrected response is re-emitted (JSON or SSE).
  Destructive-tool calls are **refused, never fabricated**; unrepairable calls **fail clean**
  (502). Valid calls pass through untouched.
- **OpenAI-compatible backends** (`kind: "openai"`) — front NIM / vLLM / OpenRouter / LM Studio.
  The two REQUEST directions that carry tool calls are relay-owned (Anthropic→OpenAI-Chat and
  OpenAI-Responses→Anthropic); the OpenAI-Chat request direction and every response/stream
  direction are translated via [`llm-bridge`](https://github.com/supermemoryai/llm-bridge).
  The validate/repair layer always sees Anthropic Messages regardless of backend.
- **Bidirectional OpenAI front** — `POST /v1/chat/completions` and `POST /v1/responses` work
  against both `openai` and `anthropic` targets, streaming and tool calls included. Direct Chat
  recovers recognized tool-call dialect envelopes when the request declares functions; no-tools
  traffic remains byte-exact. **Responses multi-turn tool conversations are supported**: a
  `function_call` / `function_call_output` pair keeps its `call_id` all the way to the backend.
  Responses input items the relay does not model are refused as a clean local 400 with no provider
  egress rather than silently reshaped — `item_reference`, `local_shell_call`, `custom_tool_call`,
  `web_search_call`, `computer_call`, `image_generation_call` and any future item type, plus
  `previous_response_id` (the relay stores no responses) and a `text.format` of
  `json_schema`/`json_object` (Anthropic Messages has no equivalent, and dropping it would return
  prose to a caller that parses JSON). The same refusal covers a content part with no
  representation — an `input_file` that is not a base64 PDF, a non-text part of a
  `system`/`developer` item, an image the relay cannot resolve — and a `tools` field that is not a
  list. `reasoning` items and `reasoning.effort` are dropped; hosted tool declarations
  (`web_search_preview`, `file_search`, …) are dropped as before.
- **Streaming repair** — text SSE frames stream to the client as they arrive; the proxy only
  withholds from the first `tool_use` block. Pure-text responses are byte-for-byte passthrough
  with zero added latency. A mid-stream repair failure surfaces as an SSE `error` event, never a
  fabricated call.

**The one boundary:** the relay fixes/flags *protocol form* (malformed tool calls), never
*judgment* (bad reasoning). Routing decisions come from config and deterministic classification,
never from an LLM's opinion inserted into the request path.

### Live demo (no external creds)

```bash
npm run build && node scripts/live-demo.mjs
```

Runs the compiled CLI against a local flaky-model backend + stub reshaper, showing detect
(logs the failure) then repair (delivers the fixed call).

---

## Install & run

```bash
NVIDIA_API_KEY=nvapi-... npx llm-relay    # instant, no install
npm install -g llm-relay && llm-relay      # global
```

A global install also drops the generated **llm-relay skill bundle** into three host directories —
`~/.claude/skills/llm-relay/`, `~/.codex/skills/llm-relay/` and
`$XDG_CONFIG_HOME/opencode/skills/llm-relay/` (falling back to `~/.config` when that variable is
unset or blank). Each gets the compact `SKILL.md` plus its three selectively loaded `references/`
files byte-for-byte from one source bundle and is refreshed on every upgrade; a failure at one host
never stops the others. It also provisions local Codex with two independent
entries in `~/.codex/config.toml`: the `llm-relay` Responses provider for direct routing and the
`llm-relay` MCP server for portable `dispatch`. Releases through v0.68.4 also generated
`default`/`relay_coding` child agents; current postinstall retires only byte-identical generated
copies because Codex Desktop rejects their `pool/*` model before reaching the relay. User-edited
agent files are preserved.

If your npm blocks unknown install scripts (`npm warn install-scripts … blocked`), allow this one
— `npm config set allow-scripts=llm-relay --location=user` — or run the installer by hand:
`node "$(npm root -g)/llm-relay/scripts/install-skill.mjs" --force`.

### Staying current

Only a **mutating** invocation compares against the npm registry — a bare proxy start, `onboard`,
`setup claude-desktop`, `offload <client> on|off`, `cooldowns clear`, and the writing subcommands of
`keys`, `config`, `routing`/`route`, `pools` and `eligibility`. Cached 6h, 2.5s timeout, silent on
failure. Every read-only command skips the check entirely, and `help`/`version` (or a
`--help`/`--version` flag) suppress it even on a mutating line — reinstalling the package
underneath a question about your credentials is a side effect nobody asked for.
A **global install updates itself** (installs the new version,
re-execs, continues your command; a failed install says so and continues on the old version).
Any other copy just prints the upgrade command. Stale bin shims from the old version are removed
in all of npm's spellings. Set `LLM_RELAY_NO_SELF_UPDATE=1` to skip the check entirely.

---

## Verifying a setup — two checks, two questions

`keys` answers *are my credentials good?* `pools --probe` answers *will the models I configured
actually answer?* Both are needed:

- A 200 from a provider's `/models` proves nothing when that endpoint is public — a revoked key
  still returns the full catalogue. `keys` re-probes anonymously and escalates to an
  authenticated completion when it must.
- A 401/403 does **not** prove a key is bad — free-tier rosters list premium models a valid key
  cannot touch. When nothing can be concluded, `keys` reports `UNVERIFIED` rather than accusing
  a working key.
- `keys` checks every configured credential slot, but neither key validation nor a catalog listing
  proves that a configured model will answer. Only `pools --probe` can — it sends one real
  completion per unique deployment through one serviceable slot, not once per pool membership or
  credential.

Keys are read from the environment and, if present, from `~/.llm-relay/.env` (one `KEY=value`
per line). **A variable already set in the environment always wins over the file.**

`llm-relay onboard --import <file>` imports dotenv files and FreeLLMAPI v1 export JSON. Credential
names must match the closed alias list for a configured provider; unknown names are explained and
skipped, and key values are never printed. Existing entries in `~/.llm-relay/.env` are preserved
unless `--force` is supplied. CSV, JSONC, generic JSON and value-shape guessing are not supported.

---

### First run — the relay asks what you want

A fresh install writes a config that **changes nothing**: every Claude model id reaches real
Anthropic through the passthrough, and the four free pools exist but nothing routes to them. That
is deliberate — installing a proxy should not silently move your traffic — and it is also not the
final state anybody wants, so the relay drops a marker file (`~/.llm-relay/first-run`) recording
that the question has never been put.

While that marker exists, `llm-relay routing show` and `llm-relay offload status` print a notice on
**stderr** (never stdout, so nothing parsing their JSON breaks). An agent following
`skills/llm-relay/SKILL.md` is told to ask you what you want, apply your answer with the ordinary
verbs, and then run:

```
llm-relay routing answered
```

which retires the notice and touches no routing. "Leave it as it is" is a real answer, so silencing
the prompt deliberately does not require a config edit.

## Config

`~/.llm-relay/config.json` (or `--config <path>`): a `providers{}` registry plus a `routing`
block. State lives under `~/.llm-relay/`: `config.json`, `.env`, `keystore.json`,
`control-token`, `models-cache.json`, `probe-cache.json`, `runtime-telemetry.json`,
`target-facts.json`, `refusal-interpretations.json`, `lane-manifest.json`,
`dispatch-exhaustion.json`, `dispatch-lane-stats.json`, `lane-affinity.json`, `breaker-state.json`, `update-check.json`, the `hooks/` script, and
the `usage/` accounting subtree.

### Where state actually lives

`~/.llm-relay/` is the default. If you set an XDG base directory, **every** artifact honours it,
split by what the artifact is:

| Honours | Artifacts |
|---|---|
| `XDG_CONFIG_HOME/llm-relay/` | `config.json`, `.env`, `keystore.json`, `control-token`, `target-facts.json`, `refusal-interpretations.json`, the `hooks/` script |
| `XDG_CACHE_HOME/llm-relay/` | `models-cache.json`, `probe-cache.json`, `runtime-telemetry.json`, `lane-manifest.json`, `dispatch-exhaustion.json`, `dispatch-lane-stats.json`, `lane-affinity.json`, `breaker-state.json`, `update-check.json`, the `usage/` ledger |

The rule is the XDG spec's own: anything you authored or that holds a credential is config;
anything the relay can rebuild by asking a provider again is cache. A variable that is unset,
empty, or whitespace-only counts as absent.

⚠ **Upgrading never moves anything.** If a file already exists under `~/.llm-relay/` and not under
the XDG path, the relay keeps reading *and writing* the old one. So setting `XDG_CONFIG_HOME` on an
install that already has a keystore does not hide it, and there is no migration step to run or
forget. A fresh install with the variable set is fully XDG from the start.

To move an existing install deliberately, stop the relay, copy the files to the locations in the
table, and delete the originals — the XDG path wins as soon as it exists. Back up first
(`llm-relay keys export` for the credentials), because `keystore.json` is the one artifact that
cannot be re-fetched.

Before 2026-08-27 only five of these honoured a variable and the rest did not, so the directory
split in two. That is fixed; if you are on an older version, treat `~/.llm-relay/` plus both XDG
locations as the full backup set.

```jsonc
{
  "listen": "127.0.0.1:8791",              // loopback ONLY — startup refuses non-loopback
  "providers": {
    "nim":        { "base": "https://integrate.api.nvidia.com/v1", "kind": "openai", "authEnv": "NVIDIA_API_KEY" },
    "openrouter": { "base": "https://openrouter.ai/api/v1",        "kind": "openai", "authEnv": "OPENROUTER_API_KEY" },
    "anthropic":  { "base": "https://api.anthropic.com", "kind": "anthropic", "credentialMode": "passthrough" }
  },
  "routing": {
    "default": "pool/medium",
    "tiers":  { "opus": "pool/xhigh", "fable": "pool/xhigh", "sonnet": "pool/high", "haiku": "pool/medium" },
    "pools": {
      "low":    { "preferred": [], "include": "free", "effort": "low" },
      "medium": { "preferred": [], "include": "free", "effort": "medium" },
      "high":   { "preferred": [], "include": "free", "effort": "high" },
      "xhigh":  { "preferred": [], "include": "free", "effort": "xhigh" }
    },
    "sticky": false,                        // opt-in session affinity; see below
    "quota": { "enforce": true }            // spent-quota demotion; see Failover below
  },
  "mode": "repair",                        // detect | repair
  "repair": { "maxAttempts": 2, "destructiveTools": ["Bash", "Write", "Edit", "..."] },
  "maxBodyBytes": 37748736,                 // optional; 36 MiB default, 256 MiB maximum
  "log": { "level": "metadata", "file": null, "maxBytes": 52428800 }
}
```

### Provider credential fleets

A provider declares either the legacy `authEnv` field or an explicit `credentials[]` fleet, never
both. Use a fleet when one backend account has multiple independently metered keys:

```jsonc
"nim": {
  "base": "https://integrate.api.nvidia.com/v1",
  "kind": "openai",
  "credentials": [
    { "label": "personal", "authEnv": "NVIDIA_API_KEY" },
    { "label": "work", "authEnv": "NVIDIA_WORK_API_KEY", "models": ["meta/llama-3.1-70b-instruct"] },
    { "label": "spare", "authEnv": "NVIDIA_SPARE_API_KEY", "enabled": false, "models": [] }
  ],
  "tierType": "free"
}
```

Each slot has a non-secret, user-visible `label` (`[A-Za-z0-9_.-]{1,32}`), an exact `authEnv`
name, and optional `enabled` and `models`. The `models` entries are backend model ids, not
provider-prefixed specs. Omitting `models` (or setting it to `null`) allows every backend model;
`[]` allows none. A missing env var, disabled slot, or model-scoped-out slot is not
serviceable and cannot start an upstream request. Unlike legacy provider `authEnv`, which retains
its compatibility alias lookup, a slot's `authEnv` is exact.

Any explicit fleet — including `credentials: []` — makes the provider contained. It cannot be
combined with passthrough. Provider `maxConcurrent` is enforced independently for each
`provider#label`, so one account's in-flight limit does not consume a sibling account's allowance.

Config strings may reference env vars as `${NAME}`. An unset `${NAME}` in a provider `base`
**disables that provider** (its pool members are dropped with a warning) rather than aborting
startup — losing *every* route is still fatal. CLI startup overrides (`--default`, `--mode`,
`--listen`) win over the file.

### Key custody

`llm-relay keys` manages an encrypted keystore at `~/.llm-relay/keystore.json`. Secrets are
encrypted individually with AES-256-GCM under a store key recovered through the platform
mechanism or scrypt passphrase mode below. A secret is never accepted on argv: an interactive
command uses an echo-off prompt, and automation may pipe one line per secret prompt on stdin; each
prompt consumes exactly one line, and end-of-input before a line is refused.

The threat boundary is deliberately narrow:

- **What it stops:** a copy of `keystore.json` alone — committed in a repo, synced to cloud
  storage, pulled from a partial backup, or moved to another machine — is useless.
- **What it does not stop:** a copy of the **whole user profile together with the account
  password**. `%APPDATA%\Microsoft\Protect` travels in a whole-profile backup, and an offline
  attacker holding it plus the password (or its hash, or a domain backup key) can decrypt
  CurrentUser blobs. This is routine, not exotic.
- **What nothing user-side stops:** code already running as you.
- An **admin-forced password reset** on a non-domain machine destroys the DPAPI master key and
  every entry becomes undecryptable. A normal password change is fine.

Design 1's phrasing — "there is no key file at all", "lifted out of a backup is undecryptable" —
was overstated and is corrected here. The DPAPI master key *is* a file, in the same profile; what
changes is that it is wrapped by the logon credential. That remains a strict improvement over a
master key sitting beside the ciphertext, and saying so precisely costs nothing.

⚠ **Measured, do not re-derive:** `ProtectedData.Unprotect(blob, null, 'LocalMachine')` on a
`CurrentUser`-protected blob **succeeds**. The scope argument is not validated on unprotect; the
blob carries its own scope. Do not treat passing it as a safety check.

The authenticated entry metadata protects against a writer that has **not** unlocked the store
key, such as a restored backup, sync service, repo checkout, torn write, or hand edit. Code already
running as the user can unwrap the key and re-encrypt with valid metadata. Envelope encryption
also leaves the unwrapped key subject to JavaScript garbage-collector lifetime; do not run a
credential-bearing relay with `--inspect`, `--heapsnapshot-signal`, or `--report-on-fatalerror`.

#### Resolution and coexistence

Credential precedence is source-major: **process environment > `~/.llm-relay/.env` > keystore**.
The first two sources therefore shadow a stored entry. `keys add` still stores the new entry but
prints the winning variable and whether it came from the process environment or the dotenv file.
`keys rotate` is stricter: it refuses without changing the store or live state unless the keystore
entry is what actually resolves. Otherwise rotation would change nothing on the wire while
deleting learned facts about the credential that is still serving.

There is a deliberate read/write asymmetry. A legacy read walks the full existing candidate-name
family, including provider-derived names, to preserve environment compatibility. `keys add` and
`keys import` accept only names declared by the loaded provider configuration plus that provider's
closed curated alias list. An inferred or guessed name is never accepted for a write. Explicit
`credentials[]` slots remain exact-name reads.

`keys list` shows the provider, credential id, winning source (`env`, `env-file`, or `keystore`),
fingerprint-derived mask, added/rotated dates, expiry, and revoked/disabled state. It never derives
a mask from secret bytes and never prints a secret. Its store summary always reports the three-way
count `N listed, C undecryptable, D dropped`; `C` is the subset of listed metadata rows whose
ciphertext cannot be decrypted, while `D` rows were rejected before listing. It also names a
degraded, locked, or unreadable store state.
This is the newly started CLI process's view; it is not proof of what environment a relay process
that started earlier can see.

#### Lifecycle commands

| Command | Behaviour |
| :--- | :--- |
| `llm-relay keys` / `llm-relay keys check` / `llm-relay check-keys` | Check every configured credential slot; bare `keys` and `check-keys` retain the historical status output. |
| `llm-relay keys add <provider> [--label <label>] [--env-name <NAME>] [--check]` | Store one stdin/prompted secret. The provider must exist, declare an auth environment name or matching credential slot, and not be passthrough; the name must pass the strict write gate above. The default label is `default`, or the matching slot label; the default name is the provider/slot declaration. `--check` validates after storing, and a failed or inconclusive check never rolls storage back. If an environment or env-file value shadows the stored row, the check names that winning variable and source and says the stored key was not probed. Every successful add prints the threat boundary above. |
| `llm-relay keys list` | List non-secret resolution and lifecycle metadata plus store status. |
| `llm-relay keys rotate <provider[#label]>` | Replace ciphertext under the same id and set `rotatedAt`; a bare provider means `provider#default`. Rotation deliberately un-revokes an entry and says so when it does. It refuses a shadowed entry. |
| `llm-relay keys revoke <id>` | Set `revokedAt` and retain the row, so the missing credential remains explained. |
| `llm-relay keys disable <id>` / `llm-relay keys enable <id>` | Toggle selection without deleting the row. |
| `llm-relay keys remove <id> [--purge]` | Remove the row. Even overwrite-then-unlink would be theatre on a journaling filesystem or SSD; `--purge` does **not** claim secure erase. |
| `llm-relay keys export --out <file>` | Export only a versioned encrypted envelope: scrypt with the keystore passphrase parameters, then AES-256-GCM over the full decrypted entries payload. The non-whitespace export passphrase is typed with echo off and confirmed before anything is written. There is no plaintext export path, and the store must be unlockable. |
| `llm-relay keys import <file>` | Import an encrypted custody export, a plaintext FreeLLMAPI v1 envelope, or dotenv using the closed alias matcher. The destination is the keystore, and output names providers and environment variables but never values. After a plaintext import, remove/shred the source yourself; old contents may still survive in backups, filesystem journals, or unallocated SSD blocks. |
| `llm-relay keys unlock` | Verify the passphrase-mode store verifier. Other wrap modes need no CLI unlock, so this is a no-op there. There is no cross-process KEK cache; each new command prompts when its selected wrap mode requires a passphrase. |

The export file is protected by a restricted ACL on Windows and mode `0600` elsewhere; once it is
moved off-machine, its confidentiality rests entirely on the export passphrase.

Any other `keys` subcommand exits 1 and names the valid set. Older releases silently treated an
unknown word as the status check; failing loudly avoids disguising a mistyped mutation.

Revocation, removal, disabling, and enabling work even while secret material is locked because those
lifecycle fields are not part of an entry's authenticated identity.

All custody commands operate locally; there is no secret-bearing HTTP endpoint. The sole HTTP
touch is after a successful, unshadowed rotation: when a relay is running, the CLI sends the
credential selector and `kinds:["credential-fault"]` to the existing token-gated
`POST /cooldowns/clear`. The request contains no secret and still passes the existing exact Host,
Origin, content-type, and control-token admission checks. This narrow clear retracts breaker
credential-fault state and `credential-invalid` cooling facts only. It does **not** clear
`allowance-exhausted`, `not-servable`, `subscription-required`, rate-limit cooldowns, or the
escalation ladder: replacing a key disproves an authentication fact, not an account allowance or
back-pressure observation. If no relay is running, rotation still succeeds; live faults converge
through their normal expiry or the relay's next successful use. The CLI never edits
`target-facts.json` behind a running relay's write-behind cache.

#### Platform and verification matrix

| Platform / mode | KEK protection | Honest coverage label |
| :--- | :--- | :--- |
| Windows | DPAPI CurrentUser through Windows PowerShell 5.1 | Shipped and live-verifiable on the Windows development machine; this is real DPAPI coverage, not a portable claim. |
| macOS | Login Keychain through `security` | Shipped; exercised with injected process doubles only. There is no macOS CI leg or live machine measurement. |
| Linux with `secret-tool` | Desktop libsecret/keyring | Shipped; exercised with injected process doubles only. The Ubuntu CI leg does not provide a real desktop keyring. |
| Linux passphrase mode | scrypt-derived KEK, prompted as needed | Shipped; the real cryptography path is exercised on Ubuntu CI. |
| Linux without an available keyring or usable passphrase mode | None | Storage is refused. There is no plaintext or beside-the-ciphertext fallback. |

### Operator-declared rate limits (`limits`)

A provider (or one of its credential slots) may carry a `limits` block asserting the rate
ceilings **you** know that account has:

```jsonc
"nim": {
  "base": "https://integrate.api.nvidia.com/v1",
  "kind": "openai",
  "limits": {
    "rpm": 40, "rpd": 1000, "tpm": 100000, "tpd": 150000,
    "models": { "meta/llama-3.1-8b-instruct": { "rpm": 10 } }
  },
  "credentials": [
    { "label": "personal", "authEnv": "NVIDIA_API_KEY", "limits": { "rpd": 500 } }
  ]
}
```

- The axes are exactly `rpm`, `rpd`, `tpm`, `tpd` — requests or tokens per minute or per day.
  Every figure must be a positive integer. Any other key (`RPM`, `rps`, `tph`) is a config
  **error naming the key**, because a typo that were silently ignored would read as a ceiling
  while bounding nothing.
- Every limit is a **per-credential (per-key) ceiling** as you assert it. A provider-level
  `limits` is the default for every credential of that provider; a slot's own `limits` overrides
  it for that key; a `models["<backend model id>"]` entry overrides per deployment. Each axis is
  resolved independently: a model override naming only `rpm` inherits `rpd`/`tpm`/`tpd` from
  above. Per axis, most-specific wins: credential-level model override → provider-level model
  override → credential-level → provider-level.
- `models` keys are backend model ids, verbatim; they are never checked against any catalog.
- The relay never sums limits across credentials and never infers a limit that is not declared.
  An undeclared axis stays unknown — no default, no published-figure fill-in.
- These figures feed the availability/headroom surfaces and are labelled **`configured`**
  wherever they appear — operator-asserted evidence, distinct from `provider-stated` header
  observations and from anything derived from the local ledger. They never refuse a request by
  themselves.
- A `hard` sub-block turns selected axes into **refusal ceilings** — see
  [Hard caps](#hard-caps-limitshard) just below for the shape, and
  [Hard caps refuse, loudly](#hard-caps-refuse-loudly) for what the request path does with one.
  The soft axes above demote; the `hard` axes refuse.

#### Hard caps (`limits.hard`)

Inside any `limits` block (provider level, credential slot, or a `models` entry), a `hard`
sub-block declares the ceilings at which the relay **refuses** rather than fails over:

```jsonc
"nim": {
  "limits": { "rpm": 40, "rpd": 1000 },
  "credentials": [
    { "label": "a", "authEnv": "NIM_KEY_A",
      "limits": { "rpd": 500, "hard": { "rpd": 450, "tpd": 2000000 } } }
  ]
}
```

- A cap is an **operator assertion**, exactly like the soft limits: any positive integer above or
  below whatever the provider publishes; the relay never infers one. Same closed axes
  (`rpm`/`rpd`/`tpm`/`tpd`), same positive-integer rule, same per-axis precedence ladder
  (credential-model → provider-model → credential → provider), same unknown-keys-are-a-hard-error
  rule. A per-deployment cap rides inside that deployment's own `models` entry
  (`"models": { "m/x": { "hard": { "rpd": 100 } } }`).
- **Minute/day only.** `mpd`/`mpm` and every other spelling outside the four axes are rejected by
  name at config load: the relay reads usage only from its own in-memory accounting window, which
  measures minute and day and deliberately declines month (the lifetime rollup is not
  per-credential), so a month cap could never fire and would bound nothing while looking like it
  did.
- The comparison is **inclusive**: `used >= cap` refuses, so a cap of 450 admits 450 requests and
  stops the 451st. Usage comes ONLY from this relay's own ledger — never from a provider header,
  never estimated forward. **Unknown usage (no store, no traffic recorded) refuses nothing** — a
  guess must not be able to refuse.
  For an estimated-only request, the token window is estimated input plus estimated output; token
  hard caps read that completed estimated basis, correcting the pre-M4 input-only undercount.
- **Where you declare a cap decides whose usage it counts**, per axis:
  - a **flat** cap (`limits.hard.<axis>` on the provider block or on a credential slot) bounds
    that credential as a whole, and is compared against the credential's usage **across all
    models** it served this period;
  - a **per-deployment** cap (`limits.models.<id>.hard.<axis>`, at either level) bounds one
    deployment, and is compared against **that model's** usage on that credential only.

  So `limits.models["m/x"].hard.rpd = 100` is not reached by 100 requests spent on `m/y`, while a
  slot-level `limits.hard.rpd = 100` is reached by any 100 requests that slot served. The request
  path, `/candidates` and the dashboard all read the ledger by this same rule, so a displayed cap
  and an enforced cap cannot disagree.
- `routing.quota.hardCaps: false` turns every declared cap back into an ordinary soft limit
  (default is `true`: writing a `hard` block means it).

### Model addressing (split on the first `/`, first match wins)

1. **`pool/<name>`** — expands to the pool's candidate list, benchmark-ranked with failover. An
   unknown pool is a **400, never a silent fallback** — a typo must not quietly succeed against
   a different model.
2. **`provider/model`** — a configured provider name routes there directly; the entire tail
   (nested slashes, `:free` suffixes) is the backend model, verbatim. A pinned spec is never
   re-ranked.
3. **Tier** — otherwise a Claude model id is substring-matched against `routing.tiers`
   (`opus`/`sonnet`/`haiku`/`fable`). This also catches Claude Code's internal side-calls.
4. **Default** — anything else falls to `routing.default`.

`pool/<name>` exists because some callers can only send **one model string** — notably Claude
Code subagent frontmatter. A pool gives them ranking and failover anyway. `pool` is a reserved
provider name. Pool refs are legal in `routing.tiers`, `routing.default` and `routing.subagents`;
pool-in-pool is rejected at load.

**`auto` model:** Callers can address `model: "auto"` so requests never have to name a concrete model or pool. It resolves to the spec of the first ready rung of kind `relay` in the dispatch ladder for a tier. The tier is selected by the `x-llm-relay-tier` request header (`low` | `medium` | `high` | `xhigh`), defaulting to `medium`. If the ladder for that tier has no ready relay rung, or no ladder is configured, `auto` falls back to `routing.default`. The served response carries an `x-llm-relay-auto: <spec> (<tier>)` header announcing what `auto` resolved to. `auto` is a reserved provider name.

A dynamic pool (`{ "preferred": [...], "include": "free" }`) may also declare
`"exclude": ["provider/model", ...]`. These are permanent user tombstones: they remove matching
entries from both the preferred prefix and the discovered tail. Unknown or no-longer-catalogued
entries are intentionally inert, so a tombstone can outlive the deployment it excludes.

**Passthrough:** a true passthrough is an `anthropic`-kind provider with no provider-owned
`authEnv` or `credentials[]`, and whose mode is not `contained`. It forwards the caller's own
credentials byte-for-byte (`authorization`/`x-api-key` *and* `anthropic-beta`). Point every tier
at it and real Claude traffic stays on real Anthropic while `pool/*` routes elsewhere — one proxy,
both behaviours.

Say so with **`"credentialMode": "passthrough"`**. Omitting it still forwards, so existing
configs keep working, but startup warns: "needs no key of its own" and "may be sent the user's
subscription credential" are different intentions, and only the first should follow from an
omission. The opposite declaration, **`"credentialMode": "contained"`**, is the one to use for a
keyless `anthropic`-kind backend that is *not* your own vendor — a local daemon, a second relay,
someone else's Anthropic-format endpoint — and strips the caller's credential instead. Contained
Anthropic-format providers with their own credentials strip caller auth too. Only
`credentialMode: "passthrough"` conflicts with `authEnv` or `credentials[]`; contained mode may be
explicit alongside provider-owned auth. `openai`-kind providers never receive inbound credentials
at all: their upstream headers are built from scratch, which is why a keyless `ollama` needs no
declaration and gets no warning.

### Provider wire-shape quirks (`compat`)

Some hosts enforce request rules the OpenAI protocol itself does not, and reject a conversation
that every other provider accepts. `compat` states what a provider demands:

```jsonc
"providers": {
  "mistral": { "base": "https://api.mistral.ai/v1", "kind": "openai",
               "compat": { "toolCallIds": "strict9" } },
  "gemini":  { "base": "https://generativelanguage.googleapis.com/v1beta/openai", "kind": "openai",
               "compat": { "thoughtSignature": "sentinel" } }
}
```

- **`toolCallIds`: `"preserve"` (default) | `"strict9"`.** Mistral's `mistral-common` validator
  requires `^[a-zA-Z0-9]{9}$` on both the assistant `tool_calls[].id` and the answering
  `tool_call_id` (and, from v13, that the pair is linked and that ids are unique), so every id shape
  a client produces — `toolu_01…`, `Read:0`, `call_…` — is HTTP 400 there:
  `Tool call id was … but must be a-z, A-Z, 0-9, with a length of 9`. Under `strict9` the relay
  rewrites both halves of each pair through one per-request map: deterministic (SHA-256 → base62,
  no randomness, so a replayed or retried turn maps identically and a `tool_result` never loses the
  call it answers), an already-conforming id kept as-is, collisions resolved in first-appearance
  order. Under `preserve` the outbound bytes are unchanged.
- **`thoughtSignature`: `"none"` (default) | `"sentinel"`.** Gemini 3.x on Google's Generative
  Language API answers HTTP 400 — *"Function call is missing a thought_signature in functionCall
  parts…"* — to a replayed assistant tool call. Under `sentinel` the relay stamps Google's own
  documented opt-out, the raw string `skip_thought_signature_validator`, at
  `tool_calls[N].extra_content.google.thought_signature` on every replayed call. The relay does not
  store or echo a real signature: keeping vendor-private reasoning between turns is not something
  this proxy does, and inventing one would be a fabrication. Under `none` nothing is added.

**Defaults are labelled provider facts, and config always wins.** An absent key resolves from the
provider's base host — `*.mistral.ai` ⇒ `strict9`, the exact host
`generativelanguage.googleapis.com` ⇒ `sentinel` (not `*.googleapis.com`: Vertex is a different
product with a different validator), everything else ⇒ `preserve` / `none`. An explicit value beats
the default in **both** directions, so `"toolCallIds": "preserve"` on a mistral host and
`"toolCallIds": "strict9"` on any other host both do exactly what they say.

**An unknown `compat` key or value is a hard startup error naming it** — same rule as `limits`. A
typo that were merely ignored would read as a declaration that took effect while the wire was
unchanged.

**What it announces.** An id rewrite sets `x-llm-relay-tool-call-ids: "<n> rewritten"` on the
response — buffered *and* streamed, because unlike the response-direction mint the count is final
before the request is sent — plus the `toolCallIdRewrites` log field. The sentinel is counted in
the log as `thoughtSignatureSentinels` and deliberately has **no** response header: it is
vendor-protocol padding on the relay's own outbound shape, not a change to your data, so there is
nothing a client could act on. Both are counts, never ids or signatures.

⚠ **`compat` shapes only request bodies the relay AUTHORS.** Those are the translated lanes — an
Anthropic `/v1/messages` request going to an `openai`-kind target, and a `/v1/responses` request
doing the same. The OpenAI front's **direct Chat passthrough** (an `openai`-kind target reached
over `/v1/chat/completions`) forwards the caller's own body essentially byte-for-byte and is left
alone, so a declared compat mode is **inert there by design** — not an unfinished path. Same
deliberate asymmetry as tool-use-id minting, and for the same reason: responsibility tracks
authorship. An OpenAI-native client wrote its own ids and sees mistral's 400 verbatim, which is
its own to fix; on a translated lane the client cannot fix what the relay wrote.

### Pools — static and dynamic

A pool is either a static array of specs, or a dynamic free pool:

```jsonc
"medium": { "preferred": [], "include": "free", "effort": "medium" }
```

The `preferred` prefix stays first in written order; the relay then appends every free model
discovered from the live catalogs, ranked by capability. `effort` (`low`|`medium`|`high`|`xhigh`)
is a cumulative capability floor, not a ceiling. Admission needs an exact SKU match and at least
three published capability signals; a member exits only when it falls two points below its floor
(no flapping); known tool-incompatible SKUs are excluded. Catalog refreshes re-materialize pools
automatically — new free models never need a config edit.

⚠ **A pool routes to fewer members than it lists** when some declare an `authEnv` that is unset —
those are dropped before ranking, so a 14-member pool can resolve to 7 and the config's tenth
entry can legitimately be the one that answers. `llm-relay candidates` reports the count.

### Failover (both fronts, one policy)

- **429 / 5xx / 400 / 402 / 404 / 410** → recorded as a breaker failure, next candidate tried. A
  `Retry-After` sets that candidate's cooldown to what the provider asked, **bounded to 1 s–15 min**
  — so an hour-scale reset is re-probed after 15 minutes rather than parking the member for the
  whole hour. 402 (depleted credits) cools for 1 hour when it carries no `Retry-After`; a 402 that
  does carry one uses the same bounded value, i.e. at most 15 minutes. A 410 whose body states end-of-life additionally
  records a `not-servable` fact, so a retired model stops burning a walk slot per request.
- **401 / 403** → the exact credential slot is marked `AUTH` and the walk may try a sibling slot or
  the next deployment. `llm-relay candidates` exposes the fault instead of hiding it. It expires
  after 5 minutes, so a rotated key recovers with no restart. One slot's auth failure never
  invalidates its siblings or the whole deployment; remove a deployment only on deployment-level
  evidence.
- **A genuine client 4xx** (413, 422, …) → returned as-is; every candidate would reject it
  identically.
- **Every candidate failed** → the last real upstream error, never a synthesized one. If every
  failure was a 429, the served `Retry-After` is the earliest across the pool.
- **Walk budget** — a wall-clock ceiling on *starting* further attempts, so a deep pool cannot
  spend `members × timeoutMs` on one request. The first two attempts are always allowed and an
  attempt in flight is never aborted. Default 45 s; tune with top-level `"walkBudgetMs"` in
  config.json (`0` disables).
- **Deferred streamed commit** — downstream headers remain provisional through comments,
  heartbeats, role/usage frames, and other metadata. The first meaningful text, reasoning, or
  structured tool call commits the response. Before that point an in-band error, empty completion,
  broken socket, or 64 KiB pre-content prefix fails cleanly and can advance to the next candidate;
  after it, errors are forwarded honestly and never replayed elsewhere.
- **Streamed deadline split** — a provider's `timeoutMs` covers the request through that first
  meaningful content, then disarms; from there an inter-byte stall watchdog (per-provider
  `"stallTimeoutMs"`, default 90 s, `0` restores the single deadline) aborts only when no byte
  arrives for the whole window. A healthy long generation is never killed by the total deadline,
  and a dead stream is detected by silence, not by waiting out the deadline.

Health **demotes** candidates, never drops them (live → credential-faulted → cooling). Responses
carry `x-llm-relay-served-by`: the deployment that served, or on error every deployment tried,
in order. Background: [pool-failover.md](pool-failover.md).

Credential choice is deterministic and breadth-first: the walk spreads first attempts across
deployments before consuming their next credential slots. A credential-attributable outcome may
unlock a sibling slot. A provider transport failure suppresses the remaining rows for that
provider on the same request; a protocol/deployment failure closes only that deployment, so the
walk may continue to another deployment.

Any walk of **two or more** candidates also carries `x-llm-relay-pool-attempts` — what happened to
each of them, in one line:

```
x-llm-relay-pool-attempts: 13 tried, 0 served: 4x402, 5x429, 3x403, 1x400
```

Without it a pool's error is one member's error: a 402 pointing at a billing page, while the other
twelve failed for three unrelated reasons and the right move was "use another pool". The body is
left alone — it stays the last candidate's real upstream error — so the aggregate rides in a header.
It appears on successes too, where it warns that a pool is thinning before it runs out.

Credential headers are enabled only when the walk involves a provider with at least two enabled
slots. When the serving provider is one of them, a successful response names its winner as
`x-llm-relay-credential: provider#label`. After multiple credential starts — or when there is no
winner — the response includes the aggregate:

```
x-llm-relay-credential-attempts: 3 tried, 1 served: 1x401, 1x503
```

These headers are present on both API fronts, including streamed responses. Labels and credential
ids are non-secret metadata; key values are never exposed.

When the answer came from **below** the requested effort band, the response carries
`x-llm-relay-degraded: gemini/models/gemini-2.5-flash (below xhigh)`.

An effort pool is its banded members first, then a degrade tail of everything clearing a lower band
— strongest band first. The tail is reached only after every in-band member has actually failed on
that request, so a healthy pool behaves exactly as before. This exists because a band selects on
capability and capability correlates with the providers that meter hardest, so the top band is both
the narrowest and the first to run dry: measured 2026-08-08, `pool/xhigh` returned 0 served from 12
members while `pool/low` answered from 46 on the same credentials at the same moment.

⚠ Degradation is automatic but never silent — an unflagged capability downgrade is indistinguishable
from getting what you asked for. ⚠ A model that clears **no** band is admitted nowhere, tail
included: unassessed is not the same as weaker.

Ordering also **interleaves providers** within a rank band, so the first N attempts land in N
distinct quota domains rather than N members sharing one credential. The top-ranked candidate is
still tried first; interleaving only decides who is tried second.

**Four routing terms are ON by default**, each reverting with one boolean. Each is documented in
full below, except the two that belong to dispatch rather than to the HTTP request path —
`routing.laneProbe` under [Background lane re-probing](#background-lane-re-probing-routinglaneprobe)
and `routing.dispatchWalk` under [The automatic lane walk](#the-automatic-lane-walk-routingdispatchwalk).
This table is the index — it states no policy of its own.

| Key | Default | Revert | What the term does |
|---|---|---|---|
| `routing.latency` | ON | `"latency": false` | Demotes a candidate whose MEASURED p95 exceeds a ceiling, into the `slow` band. |
| `routing.hedge` | ON, and confined to FREE deployments | `"hedge": false` | Starts the next candidate BESIDE a slow one and serves whichever commits first. The only term that duplicates a request. |
| `routing.laneProbe` | ON | `"laneProbe": false` | Re-probes recorded `cli` lane deaths and stale rosters on the relay's own background cadence. |
| `routing.dispatchWalk` | ON | `"dispatchWalk": false` | Walks the DISPATCH ladder past a lane that does not answer, pins the lane that does. Read by `llm-relay mcp`, not by the request path. |

Each `false` is the boolean shorthand for `{ "enabled": false }` and is a byte-for-byte revert to
the behaviour before the term existed. `routing.quota` below is also on by default, but it has no
single boolean: it gates on provider-stated and configured figures always, and on learned figures
only under the `enforceLearned` opt-in.

#### Quota as a demotion term (`routing.quota`)

When a candidate's own quota evidence says its allowance is **spent** (`remaining ≤ 0`), that
candidate joins the cooling band — demoted behind live members, never dropped, never refused — and
lifts on its own at the reset the evidence stated. This is on by default for figures the relay can
trust:

```jsonc
"quota": {
  "enforce": true,          // default. false disables quota demotion entirely.
  "enforceLearned": false   // default. true also lets LEARNED limits gate routing.
}
```

- Three bases gate by default: `provider-stated` (a limit/remaining pair read from this
  deployment's response headers, still inside the current period), `derived:provider-stated`
  (a **stale** observation's stated limit minus what the local ledger says this credential used
  this period — the limit was first-party and a header limit states entitlement rather than
  point-in-time state, so only the subtraction is ours), and `derived:configured` (the
  operator-declared `limits` block minus that same ledger reading). In each case something the
  provider or operator asserted bounds the figure; the arithmetic alone does not.
- `derived:learned` — a ceiling parsed from a provider's refusal prose — is **display-only unless
  you set `enforceLearned: true`**. A regex over vendor prose must not throttle a healthy
  deployment on a mis-parsed number. `derived:published` (a catalogue figure for the model id)
  **never gates**, under any setting.
- **Unknown quota has no effect whatsoever**: a candidate with no observations and no resolvable
  limit keeps exactly its pre-quota position.
- The cooldown expires at `resetsAt` — what the provider stated, or the UTC period boundary when
  the ladder derived one. If neither exists (no stated reset, unknown period), there is **no
  demotion at all**: the relay does not invent a duration.
- Demotion reorders only. Failure counters stay untouched; any success clears it through the
  ordinary breaker path; a pool whose every member is spent still serves from the cooling band.
- When the walk's ranked first choice was displaced this way, the response announces it:

```
x-llm-relay-quota-demoted: nim/z-ai/glm-5.2 (requests/minute remaining 0, provider-stated)
```

`llm-relay candidates` shows the same fact per row as `QUOTA <seconds>s (<axis>/<period>, <basis>)`
in the breaker column; the dashboard Cooldowns panel lists it with reason `rate_limit`.

#### Sustained latency as a demotion term (`routing.latency`)

**On by default.** A candidate whose MEASURED 95th-percentile latency exceeds a ceiling joins the
same cooling band, so the walk stops leading with a member that answers but takes a minute.

Why it exists: measured 2026-08-30, a member with a healthy (closed) breaker and a p95 of
**70364 ms** was walked ahead of every cooling one, because health banding read breaker state and
nothing else. Single requests were costing 120–123 s across 2–6 attempts, which read from outside
as an offload lane "stalling".

- It only ever REORDERS. It never drops a candidate and never refuses a request.
- It needs a **sustained** measurement — a p95 over at least `minSamples` measurable probes — so a
  single slow request can never demote anything.
- **Unmeasured latency has no effect whatsoever**, the same rule as unknown quota. A deployment
  nobody has probed keeps its place.
- No cooldown is registered, because latency states no reset and the relay does not invent
  durations. The demotion simply lifts by itself once the measurement recovers.

```json
"routing": {
  "latency": { "enabled": true, "msPerToken": 250, "p95Ms": 30000, "minSamples": 5 }
}
```

`"latency": false` is shorthand for `{ "enabled": false }` and restores the previous behaviour
exactly. An unknown key is a hard config error rather than a silently ignored one.

When the walk's ranked first choice was displaced this way, the response says so:

```
x-llm-relay-latency-demoted: gemini/models/gemini-3.6-flash (p95 687.8ms/token > 250ms/token over 8 request samples)
```

⚠ That header is this demotion's **only** surface. Unlike quota it registers no breaker cooldown, so
`llm-relay candidates` and the dashboard Cooldowns panel — which read breaker state — will not show
it.

### What it measures: latency per token

The primary signal is **milliseconds per output token**, not total round-trip time. That matters,
because total latency scales with how much was generated: a member that answers a long question in
40 seconds is not slow, and a member that takes 40 seconds to produce 60 tokens is.

- **Per-token wins when it has evidence.** With at least `minSamples` real request samples, its
  verdict is final — a healthy per-token rate is *not* then overridden by the absolute ceiling.
- **Absolute p95 is the fallback**, used only when there is not enough per-token evidence. It still
  catches a deployment that is slow before it emits anything.
- **Probes never enter the per-token rate.** A probe asks for a single token, so almost all of its
  time is fixed overhead. Counting it would make every healthy deployment look catastrophic.
- **Real requests never enter the absolute p95.** The separation runs both ways. The absolute
  ceiling is calibrated on one-token probes, so judging a full generation against it compares two
  different measurements — and it demotes exactly the deployment that is working, because the
  deployment serving the most traffic produces the longest answers. A request sample carrying no
  reported token count therefore reaches **neither** statistic: it is a generation of unknown
  length, so it cannot be normalised and it is not what the absolute ceiling describes.

Samples live in the same `probe-cache.json` that `llm-relay candidates` reads, so the two surfaces
agree and the evidence survives a restart. Real served requests are added to that dataset with
their output-token counts; recording one never changes probe scheduling.

The defaults are measured, not guessed. Over 68 real requests on the author's machine the
population ran 40 ms/token at the median and 70 at p75, while one bad deployment ran 688. Re-run
that check against your own traffic before tuning:

```bash
node -e "const r=require(require('os').homedir()+'/.llm-relay/usage/recent.json');const v=r.rows.filter(x=>x.outcome==='success'&&x.tokens?.reported?.reportedOutput?.value>0).map(x=>x.latencyMs/x.tokens.reported.reportedOutput.value).sort((a,b)=>a-b);console.log('n',v.length,'p50',v[v.length>>1]?.toFixed(1),'p90',v[Math.floor(v.length*0.9)]?.toFixed(1))"
```

#### Hedged attempts (`routing.hedge`)

**On by default, and confined to FREE deployments.** When an attempt has been running longer than
this deployment's own expected time, the relay starts the next candidate **beside** it instead of
after it, and serves whichever answers first. The loser is aborted the moment a winner commits.

⚠ **This is the one thing here that DUPLICATES a request rather than reordering the walk.** That is
why it is confined to deployments the relay can establish are free: an unpriced deployment counts as
paid, so a hedge can never spend money you did not expect to spend. The cost of that safety is that
hedging silently will not fire on members whose prices nobody publishes.

Why it exists: a timeout has to choose between abandoning a slow success and waiting out a hang, and
on a real free pool the two are indistinguishable by duration — measured, successful requests on one
provider ran from 559 ms to 96959 ms while a hang sat at the 120000 ms timeout, so a 25000 ms cap
would have cut 22.5% of real successes. A hedge does not choose.

- A primary that answers **inside** the delay starts no hedge at all, so a healthy pool never
  duplicates.
- A primary that answers with a status the walk would fail over from (a 429, say) does **not** win —
  it would have been failed over anyway, so the hedge is left running.
- The hedge is the candidate the walk was going to try next. Nothing competes with your pool order.
- A hedge with no next candidate degrades to the ordinary serial wait.

```json
"routing": {
  "hedge": { "enabled": true, "minFloorMs": 3000, "msPerInputToken": 0.15, "margin": 2, "minSamples": 5 }
}
```

`"hedge": false` is shorthand for `{ "enabled": false }` and restores the previous behaviour
exactly. An unknown key is a hard config error rather than a silently ignored one. `floorMs` is
still accepted as a LEGACY ALIAS of `minFloorMs` — a config written before 2026-09-04
(`{"floorMs": 8000}`) keeps loading and keeps meaning exactly what it always meant: the floor never
drops below 8000 ms.

**The floor GROWS with the request's own estimated input size** (owner direction 2026-09-04):

```
floorMs = max(minFloorMs, msPerInputToken × estimatedInputTokens)
```

`estimatedInputTokens` is the relay's own chars/4 estimate of the PROMPT (the same figure the
context-window guardrail already computes), not anything about the answer. Without this, a large
prompt was hedged against the time it simply takes a healthy deployment to read it, and a small one
needed the flat minimum alone to avoid duplicating on ordinary noise — `minFloorMs` still does that
job, unchanged.

Every hedge is announced — whether it won or lost, because the duplication happened either way:

```
x-llm-relay-hedged: nim/deepseek-ai/deepseek-v4-flash -> nim/nvidia/nemotron-3-ultra-550b-a55b (hedge won after 3210ms, input-size 1180 tokens)
```

The last field is the rung of evidence that set the delay: `per-token` from real request samples,
`absolute` from probe samples, or `input-size` when this deployment is unmeasured — carrying the
estimated input-token count that decided the floor. A `per-token`/`absolute` verdict never carries a
token count: the DEPLOYMENT's own evidence set that bar, not the request's size, even on the (rarer)
occasions where the size-scaled floor would have set a larger number — only the rung reporting no
evidence at all changes its name. ⚠ Unlike `routing.latency`, an **unmeasured deployment IS
hedged**. The two rules point opposite ways on purpose: a demotion punishes, so with no evidence it
must do nothing, while a hedge only starts an attempt the walk was already going to make.

⚠ `margin` and `minSamples` are still **placeholders awaiting calibration**, unlike
`routing.latency`'s measured 250 ms/token. The population they need — how long an attempt runs
before its first token — is not recorded yet. `msPerInputToken` is different: it IS calibrated
(`scripts/calibrate-hedge-floor.mjs`, run against this machine's own accounting history), and its
built-in default is 0.15 ms/token — the value that script fell back to on 2026-09-04 when its own
fit came back too low to trust (0.036 ms/token, from a window with too little large-prompt traffic
on enough distinct deployments to fit robustly). Re-run the script as traffic accumulates, and watch
the header's basis field on your own traffic before tuning `margin`/`minSamples`.

⚠ An aborted loser teaches the circuit breaker nothing, so a hedged request does not record the
slowness it routed around. Requests that do **not** hedge still cool a slow deployment for as long
as it wasted, which is what keeps that slowness visible.

#### Hard caps refuse, loudly

Everything above demotes — and then there is the one thing that may refuse: an operator-declared
`hard` cap (see [Hard caps](#hard-caps-limitshard) for the config shape). The dividing line is
provenance. A **derived** figure — provider headers, learned parses, published tables — may only
demote a candidate, because a mis-parsed number must not be able to black-hole a healthy
deployment. An **explicit operator-set cap** may refuse, because refusing on it is enforcing the
operator's own instruction.

The mechanics, per request:

- The cap is evaluated **per attempt, before egress**. A candidate whose credential is at its cap
  is skipped in-process: no provider request, no LRU touch, no breaker mutation, no accounting
  attempt — the capped key spends literally nothing. The walk continues to the next credential or
  deployment, so a partially capped pool serves from whoever remains.
- The capped cell is still **listed everywhere** — health demotes, never drops, and a cap is not
  health. It counts in `x-llm-relay-pool-attempts` as an `Nxcapped` tally beside the provider
  outcomes (`3 tried, 1 served: 1xcapped, 1x429`), and appears in the metadata log as a
  status-only `capped` attempt.
- Only when **every walked candidate** was capped does the relay refuse the request itself, with
  HTTP 429 and its own synthesized body in the front's native error shape (Anthropic
  `{type:"error", error:{type:"rate_limit_error", …}}`; OpenAI
  `{error:{type:"rate_limit_error", code:"llm_relay_capped", …}}`). The body names each cap —
  credential/deployment, axis/period, inclusive used/cap, basis `operator-declared` — and states
  that no provider was contacted. There is no upstream error to pass through, and staying silent
  would hang the client; this is the one case where a synthesized body is the honest one.
- **A MIXED walk keeps its upstream error.** If any walked candidate actually reached a provider —
  even if every one of those attempts failed — the response is that last real upstream error, with
  the caps counted beside it in `x-llm-relay-pool-attempts` and no `x-llm-relay-capped` header. A
  true upstream error beats a synthesized one (the same maxim as the context guardrail and the
  all-429 policy), and "no provider was contacted" must never be claimed when one was.
- The refusal carries `x-llm-relay-capped` — one line per capped cell,
  `a/nim/z-ai/glm-5.2 requests/day 450/450` (label/deployment, axis/period, used/cap; metadata
  only, never key material) — and a `Retry-After` derived ONLY from the soonest UTC period
  boundary any walked cap lifts at. When no boundary can be derived the header is omitted and the
  body says so; a duration is never invented. **The header names at most 5 cells and counts the
  rest** (`…; +K more`): a capped attempt costs no walk budget, so every member of a fully capped
  30-member pool would otherwise land in it.
- A cap never reorders anything by itself and never registers on the breaker: it is config, not
  health. `llm-relay candidates` shows a reached cap on its row as
  `CAPPED <axis>/<period> <used>/<cap> (operator-declared, <scope>-scope, resets in Ns)`; the
  dashboard Cooldowns panel lists it with reason `manual`.

### Sticky sessions (opt-in)

`routing.sticky` preserves backend affinity across a multi-turn session without weakening health,
cost, or effort-band guardrails. It is **off by default**. Enable the defaults with `true`, or set
the bounded in-memory lifetime and capacity explicitly:

```jsonc
"sticky": { "enabled": true, "ttlMs": 1800000, "maxSessions": 1000 }
```

The TTL is sliding (30 minutes by default), capacity eviction is least-recently-used, and all pins
are ephemeral: a relay restart clears them. The map stores only a session key, deployment spec,
timestamps, and use count—never request or response text.

There are exactly two verified base key sources:

1. `x-llm-relay-session: <id>` — the relay-defined, client-agnostic opt-in header. It is consumed
   by the relay and never forwarded to a provider.
2. Otherwise, the first user message's extracted text is SHA-256 hashed and only the first 16 hex
   characters are retained. Anthropic/Chat `text` and Responses `input_text` blocks are supported;
   `<system-reminder>` blocks are skipped. A first user turn with no text creates no pin.

The relay accepts **no client session header as a sticky base key** — not `x-claude-code-session-id`,
not `x-session-id`, and no session-looking field inside `x-codex-turn-metadata`. This hedge is about
sticky-session ids only: the same Codex header IS consumed for subagent *detection* (its
`request_kind: "subagent"` marker), but never as a session identity. When the documented
`x-claude-code-agent-id` is present, it compounds either verified base key so a subagent cannot
overwrite its parent session's pin.

Only pool or multi-spec routes with at least two resolved candidates record a successful winner;
single-spec routes create no no-op pin. A stored pin may reorder live candidates, but the current
request's guardrails always win: `freeOnly` filters first, transport failures can skip the rest of a
provider, breaker cooling and credential faults are bypassed, and `@relay:` selects the request's
pool. A pin in a pool's degrade tail is also bypassed while any in-band live candidate exists, so
affinity never crosses the effort degrade boundary.

Responses on both public fronts announce the decision in `x-llm-relay-sticky`:

```text
p2/m2 (new)
p2/m2 (pinned, natural)
p2/m2 (pinned, reordered)
p2/m2 (bypassed: cooling)
p2/m2 (bypassed: credential-fault)
p2/m2 (bypassed: degraded)
p2/m2 (bypassed: not-in-pool)
```

A failure whose refusals the relay could not interpret also carries
`x-llm-relay-unknown-refusal: <n>` — a **count, never the message**. The learned-eligibility store
converges only as fast as somebody explains what an unrecognised refusal means, and a queue that
must be polled is a backlog nobody works; this tells the caller to run `llm-relay eligibility` while
it still has the context. The message itself stays out of the header deliberately: it is untrusted
text from an external service, and a response header is exactly the field a client tends to trust.

⚠ On `/v1/messages` a terminal HTTP refusal still contributes only after its body is consumed, so
the response header can count only the candidates **stepped over**; a single-member pool's own
refusal still reaches `llm-relay eligibility`. Successful SSE is different: its head is withheld
until meaningful content, and semantic failures before that point are counted as synthetic 502s.

### Other relay headers

- `x-llm-relay-error-origin: upstream|local` — who produced an error status. Every failure out of
  `fetchBackend` is a synthesized Response (a refused document, a translation bug and a dead
  provider all arrive as a bare status), so without this marker the circuit breaker charged the
  proxy's own local bugs to the provider. `fetchBackend` states it; the caller decides.
- `x-llm-relay-paid: <deployment> (<assessment>)` — this answer came from a deployment that is NOT
  free, e.g. `openrouter/anthropic/claude-sonnet-5 (paid, published-price)`. Pools rank free
  capacity first but no longer exclude paid, so an unflagged paid response would be
  indistinguishable from a free one — and the difference is money.
- `x-llm-relay-tool-dialect` — `recovered` when this response contains a tool call reconstructed
  from a recognized text dialect envelope (the host returned the model's native tool syntax as
  assistant TEXT and the relay recovered it as native tool calls), or `refused-destructive` when
  the relay refused to commit such a reconstruction because it named a tool in
  `repair.destructiveTools`.

  A **refusal** is a 502 whose body is typed `tool_dialect_refused_destructive` and names the
  refused tools; when the response head is already flushed (a streamed rescue past the first
  meaningful content) the same code arrives as a mid-stream SSE `error` event instead, since there
  are no headers left to write. The refusal is **terminal**: the request is not retried against
  another pool member and the deployment's failure budget is untouched (`x-llm-relay-error-origin:
  local`) — it is a decision about your configuration, not a statement about the backend.

  A **streamed refusal before the stream commits** — the envelope arrived before any meaningful
  content, so no head had been written yet — is served as a 502 like the buffered case rather than
  as a mid-stream event, and carries the same code and the same two headers. All three fronts
  (`/v1/messages`, `/v1/chat/completions`, `/v1/responses`) say the same thing.

  Why rescue is treated differently from an ordinary tool call: a backend that emits real
  `tool_calls` has stated its own intent, and `repair.destructiveTools` has never governed that.
  Recovery is the relay deciding that model *text* is a tool call — doing that for `Bash`, `Write`
  or `Edit`, whose output may run under `--dangerously-skip-permissions`, would be the relay
  authoring a destructive call the host never made. An **empty** `repair.destructiveTools` refuses
  nothing, and the whole envelope is refused rather than partially stripped, because dropping one
  call and committing the rest would silently change what the model asked for.
- `x-llm-relay-tool-use-ids: "<n> rewritten"` — the relay had to mint `<id>_relay<k>` for `n` tool
  calls because the serving host reused ids the conversation already carried (kimi-style
  `Read:0`), which makes Claude Code drop the call while building its next request. **Buffered
  responses only**: a stream's headers are written before its first tool call exists, so there the
  count is reported in the metadata-only `toolUseIdRewrites` log field instead. A count, never an
  id — and only on `openai`-kind targets; a native Anthropic response is untouched.
- `x-llm-relay-tool-call-ids: "<n> rewritten"` — the REQUEST-direction sibling: `n` outbound
  tool-call ids were rewritten to the shape the serving provider's validator states
  (`compat.toolCallIds`, [above](#provider-wire-shape-quirks-compat)). Present on **buffered and
  streamed** responses alike, because this count is final before the request is even sent. Also a
  count, never an id.
- `x-llm-relay-dashboard-session: <token>` — REQUEST header on dashboard API calls, carrying the
  read-only session token minted by the bootstrap exchange. It is consumed by the relay, never
  forwarded upstream, and never persisted (only its SHA-256 digest is held in memory).

### Usage fields on repaired and translated responses

A response that passes through untouched reaches you byte-for-byte — cache token figures included.
When the relay re-emits a response it repaired or translated, it carries the same figures through:

- **Anthropic front:** `cache_creation_input_tokens` and `cache_read_input_tokens` ride
  `message_start` exactly as reported (never re-stated in `message_delta`, where Anthropic sends
  only final `output_tokens`). A field the backend did not report stays absent — never emitted as
  `0`. Reported zero is kept; absent means unknown.
- **OpenAI front (Anthropic backend):** `prompt_tokens = input_tokens + cache_read +
  cache_creation` (OpenAI's prompt figure INCLUDES cached tokens; Anthropic's excludes them),
  with `prompt_tokens_details.cached_tokens = cache_read_input_tokens`.
- **Anthropic front (OpenAI backend):** `input_tokens = prompt_tokens - cached_tokens`,
  `cache_read_input_tokens = cached_tokens`. If a host reports `cached_tokens > prompt_tokens`
  (malformed), the split is dropped and `prompt_tokens` passes through unchanged rather than
  becoming negative.

Only a cache READ becomes `cached_tokens`: a cache write is billed work, not a cache hit.
This guarantee covers buffered repaired/translated responses and same-protocol paths; **streaming
cross-protocol translation** (an OpenAI-front client streaming from an Anthropic-kind backend, or
the reverse — translated inside the `llm-bridge` dependency) still drops the cache fields and
zero-fills missing usage, because the translated stream is passed through as the dependency emits it.

### Context guardrail

The relay estimates each request's prompt tokens against the target model's context limit and
rejects an oversized request with a 400 before any network egress. ⚠ **It only fires against a
limit the serving provider published** (from the warm catalog cache — never a fetch on the
request path). Unknown limit ⇒ no guardrail; the backend returns its own authoritative error.
The relay never rejects a request against a number it guessed.

### Quieting the onboarding nudge (`leave_me_alone`)

```jsonc
"leave_me_alone": ["openai", "anthropic"]
```

`llm-relay onboard` stops prompting for these providers' keys. A name matching no configured
provider is deliberately legal (the list is the negative space — most entries are preset names
you never configured). It suppresses the nudge only: a listed provider still appears in `keys`,
`/registry`, telemetry and `candidates`, and still routes normally.

---

## Repair details

### Destructive-tool refusal (`repair.destructiveTools`)

A repaired tool call may run under `--dangerously-skip-permissions`, so the relay refuses to
emit one that names a destructive tool — it never guesses arguments for it.

- **Matching is exact on the tool name, case-insensitively** — not substring. A trailing `*` is
  an opt-in prefix form (`"git_*"` covers `git_push`, not `gitlab_read`); a bare `"*"` matches
  nothing.
- **The default list leads with the harness's own write/execute tools** — Claude Code's (`Bash`,
  `BashOutput`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`) and Codex's (`shell_command`,
  `apply_patch`) — then the conventional names (`rm`, `delete`, `delete_file`, `remove`,
  `overwrite`, `drop`, `reset`, `force_push`).
- An **empty** list refuses nothing — there is no hidden built-in set, so coverage is always
  traceable to your config. Refused repairs are logged `repair: "refused_destructive"`.

### The reshaper

In `repair` mode an `openai`-kind target reshapes on itself; an `anthropic` provider needs an
explicit top-level `reshaper` block. **Prefer the pool form:**

```jsonc
"reshaper": { "pool": "medium" }     // ranked candidates, tried in order
```

A pinned `{ "base": …, "model": … }` works, but dies silently if the provider de-lists that id.
Self-repair and per-target repair reuse the exact credential snapshot that served the original
response. Provider-backed static and dynamic reshaper pools resolve request-locally and re-expand
credential fleets; a standalone `{ "base": …, "model": …, "authEnv": … }` target remains one
credential.

The pool form may walk on **transport or protocol failures** — a refusal is a real judgement and is
terminal (retrying would be shopping for a more compliant answer). Every candidate failing at the
transport/protocol level is logged `repair: "failed"` (nothing usable came back), never `"refused"`
(a model declined); the two call for opposite responses. The reshaper is asked only for
**corrected arguments per tool-call id**, which is far more reliable on weak models; the proxy
reconstructs the message and re-validates.

---

## Offload (`routing.offload` + `routing.subagents`)

Independently route Claude, Codex, and future clients' marked subagents — or whole
conversations — to other providers. **Off by default.**

```jsonc
"routing": {
  "subagents": {
    "opus": "pool/xhigh", "fable": "pool/xhigh",
    "sonnet": "pool/high", "haiku": "pool/medium", "default": "pool/medium"
  },
  "offload": {
    "claude": { "enabled": true,  "scope": "subagents", "freeOnly": true },
    "codex":  { "enabled": false, "scope": "all" }
  }
}
```

Rules are keyed by originating client (Claude uses the `/v1/messages` front door, Codex
`/v1/responses`, and `openai` the OpenAI-compatible chat front door `/v1/chat/completions`; an
explicit `default` rule is the opt-in catch-all). `scope: "subagents"`
reroutes only marked child requests; `scope: "all"` also moves the main conversation — useful
when a quota is exhausted. The CLI toggles one client **without a restart**:

```bash
llm-relay offload status
llm-relay offload claude on --scope subagents
```

**How subagents are recognized:** any ONE of three signals — Claude Code's `cc_is_subagent=true`
stamped into the `system` block of subagent requests, Claude Code's documented
`x-claude-code-agent-id` request header (present only on requests from a spawned agent), or local
Codex's `x-codex-turn-metadata` header carrying `request_kind: "subagent"`. This is a client
behaviour, not an API contract — re-verify after a client upgrade
([subagent-routing.md](subagent-routing.md#re-verifying)).

### Hosts whose traffic never arrives

Rerouting a subagent means answering its HTTP request differently, which requires the request to
arrive. A **Claude Desktop** session's does not: the launcher pins `ANTHROPIC_BASE_URL` to
`api.anthropic.com`, overriding both the User-scope variable and the `env` block of
`~/.claude/settings.json` (the block's other keys still land — only that one is managed). The
switch then reports ON and nothing changes.

`llm-relay setup claude-desktop` configures the working path: it registers `llm-relay mcp` in
`claude_desktop_config.json`. When migrating a setup written through v0.68.4, it removes only the
exact stale relay proxy environment values that old command authored and preserves every unrelated
Desktop setting. Direct API routing remains available to a terminal-launched Claude CLI.

Both `llm-relay setup claude-desktop` and `llm-relay setup claude-cli` (or bare `setup`) also install a custom `relay` agent definition at `~/.claude/agents/relay.md`. This allows Claude Code Workflow scripts (`agent(task, {agentType: "relay"})`) and the Agent tool (`subagent_type: relay`) to offload tasks directly to llm-relay's MCP dispatch lanes. Setup writes the definition when absent, updates it when the marker is present, and refuses to overwrite foreign agent files. The installed agent pins no model (`model: inherit`, since the v4 marker) — it runs on whatever model the calling session is on, never a hard-coded alias. Pass `model` on the `agent()`/Agent call to choose a different one for a single call. Measured 2026-09-04: pinned to `haiku` the wrapper answered a trivial echo task itself instead of dispatching (no provenance line), while a realistic task dispatched correctly; pinned to `sonnet` even the echo dispatched — `inherit` avoids picking either fixed point for every install.

`llm-relay offload status` detects this and says so. And on such a host, `llm-relay offload claude
on` installs a **`PreToolUse(Agent)` hook** into `~/.claude/settings.json` — the delivery mechanism
for the setting where HTTP rerouting cannot work, not a separate feature. `offload claude off`
removes it again.

The hook denies the `Agent(...)` call and returns the relay-routed command
(`llm-relay dispatch --next-command`) for the agent to run. It is a **forcing function, not a
redirect**: no hook can move an in-process subagent's endpoint — it is served by the same process
over the same pinned connection, `SubagentStart` is context-only by specification, and rewriting
the prompt or `model` via `updatedInput` changes neither the host nor the vendor. It **appends**
alongside any `Agent` hook you already have, refuses to touch an unparseable settings file, and
**fails open** — every error path allows the call, so a stopped proxy never becomes "no subagent
works at all".

**Per-call pin:** put a directive on its own line at the start of the subagent's prompt:

```
@relay: nim/z-ai/glm-5.2
Trace every caller of parseConfig and report the file:line of each.
```

The line is stripped before forwarding, so the model never sees it. It works **whether or not
the offload switch is on** — the per-call opt-in. It is read only from the last text block of
`messages[0]` (the dispatcher's authored prompt), never from tool results — otherwise any file a
subagent reads could redirect its own routing.

Precedence for a marked subagent request: `@relay:` directive → `subagents[<tier>]` →
`subagents.default` → normal routing.

**`freeOnly: true` is the money guard:** the client's rerouted traffic may only reach
deployments assessed **free**. Unknown cost counts as paid, the Anthropic passthrough is never
free, and nothing free resolving is a clean 503 naming the rule — never a silent fall-through to
`routing.default`. It also binds `@relay:` directives, so a subagent prompt cannot spend money
past it.

**Unset vs explicit:** an absent `freeOnly` is **ON for offload-rerouted traffic** (subagent
reroutes and `@relay:` directives) and **OFF for a directly addressed `pool/<name>`** spec (a
dispatch CLI lane, for instance). The two defaults are deliberate — see the guard's own comment in
`server.ts` — so `llm-relay offload status` never prints one collapsed boolean: each rule shows
`ON (explicit)` / `OFF (explicit)` / `ON (default)`, with a legend stating how a direct pool is
governed.

Full design and wire evidence: [subagent-routing.md](subagent-routing.md).

### What backends said about themselves: `llm-relay eligibility`

A pool's membership is an assumption until a deployment corrects it. `assessCost()` admits any
unpriced model from a `tierType: "free"` provider as free — right as a default, wrong for the
subscription-gated SKUs and de-listed models every roster carries. This command shows what the
backends have since stated, and what has not been understood yet:

```
llm-relay eligibility
```

Five condition verdicts, and they are **not interchangeable**:

| Verdict | Means | Effect |
|---|---|---|
| `not-servable` | the model is gone from the provider | excluded from pools |
| `subscription-required` | exists, but is not covered by our plan | excluded from **free** pools |
| `allowance-exhausted` | free, but spent until it refreshes | **demoted only**, expires by itself |
| `credential-invalid` | the provider says this key is bad | **demoted only**, cleared by any success |
| `rate-limited` | the provider is throttling throughput | **demoted only**, expires by itself |

`--class` also accepts the six MEASUREMENT kinds the relay learns for itself — `context-limit`,
`max-output` and `rate-limit-rpm|rpd|tpm|tpd`. They record what a deployment stated about its own ceilings and
are display-only: a measurement never demotes, never cools, and never blocks a free pool. You would
rarely propose one by hand; the list is open because it is derived from the store rather than
retyped here, which is how `rate-limited` came to be accepted by the store and rejected by the CLI
for a release.

Each is stored at the **scope its evidence supports**, and lookups resolve most-specific-first:

| Scope | Covers | Typical evidence |
|---|---|---|
| `attempt` | one credential slot × one (provider, model) | a refusal naming this key on this model |
| `group` | an explicit list of models on one provider | a family-wide gate, members named |
| `deployment` | one (provider, model), whichever credential | "this model requires a subscription" |
| `credential` | every deployment reached through one configured slot | a credit balance, a revoked key |
| `provider` | every deployment behind **every** credential for that provider | a provider-wide outage or de-listing |
| `model` | the same id wherever served | reference-grade only; never cost or availability |

⚠ Scope comes from what the evidence **states**, never from counting failures — several models
failing identically is equally several gated models under a working key. ⚠ A `group` carries its own
member list; there is no family registry and no prefix inference, so a group verdict can never
quietly widen to a model nobody reviewed.

⚠ The last is never treated as "paid" — a free account that has spent this period's credits is the
normal state of a working free lane, not a discovery about price. It is scoped to the **account**,
so one member's stated credit balance also steps its siblings aside instead of each spending a
round-trip to be told individually. Any success clears it.

A refusal whose message the relay does not recognise changes **nothing** and is listed as pending.
Resolve one by researching what that message means for that provider and model on this account:

```
llm-relay eligibility propose 1 --class subscription-required --scope deployment --rationale "..."
llm-relay eligibility propose 2 --class subscription-required --scope group --members pro-1,pro-2 --rationale "..."
llm-relay eligibility accept 1 --sig 3f2a91c04d --class subscription-required --scope deployment
llm-relay eligibility reject 1
```

A proposal may also carry `--cost-class free|paid|unknown` so the verdict covers only deployments
of that class, resolved live from catalog prices — the case it exists for is a provider spend
limit that names the key but only gates its paid models.

Each pending item is listed with a short **signature digest** (`sig 3f2a91c04d`), and every
printed accept command carries it as `--sig`. The digest pins the command to the refusal itself:
the queue is sorted by count-then-recency, so item numbers shift whenever a new refusal arrives,
and an index-only accept can land a verdict on a different refusal than the one proposed. With
`--sig` present the digest decides; a stale index is corrected with a note, and an unknown digest
exits 1 without touching anything. The bare index still works when typed against a listing you are
looking at.

Only `accept` makes an interpretation affect routing. That gate is deliberate: research may be done
by an agent, but the request path only ever reads confirmed data — it never asks a model what an
error means mid-request. Design and evidence: [pool-eligibility.md](pool-eligibility.md).

### Provider-stated spend headroom

Where a provider **publishes** its credit state, the relay asks instead of inferring. OpenRouter's
key endpoint (`GET /api/v1/auth/key`) states the key's credit `limit` and `usage`; the background
ping loop asks each configured OpenRouter credential every 15 minutes (no other provider produces
any request) and feeds the answer into the same learned-fact mechanism the eligibility store uses:

- `usage >= limit` records `allowance-exhausted` at credential scope, covering **paid deployments
  only** — free models on the same key stay fully routable.
- `usage < limit` retracts that condition, including one learned earlier from a refusal — so
  buying credits un-demotes on the next poll, with no operator action and no lucky paid success.
- no stated limit (an unlimited key, or a failed request) changes **nothing**, in either direction.

The resulting fact is visible in `llm-relay eligibility`, `llm-relay candidates` and the
dashboard's Cooldowns panel like any other learned condition.

### Choosing a target: `llm-relay candidates`

Every configured deployment × credential-slot target with its dimensions **side by side and
deliberately un-blended**:
capability from each leaderboard separately, live behaviour (verdict, p95, jitter, uptime),
availability now (quota, breaker state, auth faults, still-listed), cost, and traffic observed
through the proxy. The sources disagree on purpose — weigh the columns for the task at hand.
`GET /candidates` returns the full JSON, including `credentialId`, policy/state/modelAllowed,
quota, breaker state, and learned facts for each cell. A provider with two configured slots
therefore has two rows for the same deployment rather than one blended health record; missing,
disabled, and model-scoped-out rows remain visible for diagnosis even though they cannot egress.

Capability comes from `npm run sync:tiers`, which merges OpenRouter (Artificial Analysis
indices, pricing, context, tool support), BFCL (tool-call accuracy), LMArena, and Aider into
`docs/tier-data.json` (~770 models). A blank cell means *not measured*, never *bad*. Sources,
scoring formulas and rejected alternatives: [capability-sources.md](capability-sources.md).

**Limits and prices are per-(provider, model), and labelled.** The same model id on two
providers is two deployments. Where a provider publishes its own figures they are shown
unmarked; where it publishes none (NIM), another provider's figure for the same id is shown
marked `~`; where nobody publishes one, the cell is blank — the relay does not guess.

### Local Codex setup

A global install creates these automatically. The portable split-provider setup is the MCP server:

```toml
[mcp_servers.llm-relay]
command = "llm-relay"
args = ["mcp"]
```

Use its `dispatch` tool for relay-backed work while the parent stays on its normal Codex provider.

⚠ **Do not create a `pool/*` collaboration child for Codex Desktop.** With a ChatGPT account,
Desktop validates the child model against the account and ignores `model_provider` before the
request reaches llm-relay, producing HTTP 400. MCP `dispatch` is the working Desktop route.

A global install also provisions a Codex **`relay` subagent** at `~/.codex/agents/relay.toml` —
Codex's own file-based custom-agent mechanism (`name`/`description`/`developer_instructions`
required, `model`/`model_reasoning_effort`/`sandbox_mode`/`mcp_servers` optional; confirmed against
Codex's subagent documentation and three sibling agent files already installed on this class of
machine). It pins **neither** `model` nor `model_provider`, so it inherits whatever the calling
session already uses — the same fix as the `pool/*` warning above, generalized: with nothing
non-standard to validate, Desktop's collaboration launcher has nothing to reject. Its own
`developer_instructions` mirror the Claude `relay` agent's pass-through contract exactly (call
`dispatch` once with the task verbatim, poll `dispatch_status`/`dispatch_result`, return the
answer with its `provenance:` line, never answer directly). Reach it with an ordinary delegation
request in the session ("spawn a relay agent for this") — Codex has no dedicated tool call for
addressing a named subagent the way Claude Code's Agent tool does. Setup writes the file when
absent, upgrades it in place when the marker is present, and refuses to overwrite a foreign one,
mirroring `installRelayAgent`. ⚠ Unverified end-to-end by this change: whether a spawned Codex
subagent can reach the `llm-relay` MCP tools from every Codex surface. `codex exec`'s own
top-level session exposes no MCP tools at all; Codex Desktop is the confirmed working host for MCP
`dispatch` generally.

Clients verified to honor custom providers can additionally use the direct Responses provider:

```toml
[model_providers.llm-relay]
name = "llm-relay"
base_url = "http://127.0.0.1:8791/v1"
wire_api = "responses"
requires_openai_auth = true
```

That provider supports a client whose own traffic is deliberately pointed at the relay. It is not
a workaround for Desktop collaboration validation. Hosted ChatGPT/Cloud tasks cannot reach a
loopback relay — those remain separate dispatch lanes.

### Dispatch ladder

`llm-relay dispatch` answers a different question than offload: which **lane** (peer CLI, relay
pool, passthrough) should a host hand a whole task to, in what order. The order is config
(`routing.ladder`, or per-tier `routing.ladders.{low,medium,high,xhigh}`); the relay hands the
host a command and **never spawns a CLI to answer a request**. Mark a spent lane with
`llm-relay dispatch -x <lane> --outcome rate_limited|quota_exhausted` (or
`--retry-after-ms <n>` for a vendor-stated reset).

Exhaustion reports survive a relay restart: still-future cooldowns are mirrored to
`dispatch-exhaustion.json` (cache directory) and restored at startup, so a vendor-stated
"spent until <date>" is not forgotten on a bounce. Lapsed rows are never restored.

#### Lane telemetry

Every settled agent-mode lane run teaches the relay two things, reported by `llm-relay mcp`
to the daemon's `POST /dispatch/telemetry` (counts and lengths only — never the task text,
never the lane's output). Forwarded for agent-mode jobs only: answer-mode jobs already POST
to the daemon's own `/v1/messages`, whose pipeline meters them, so a second report would
double count; cancelled jobs are discarded, never reported.

The daemon records lane stats for EVERY rung kind — calls, successes, failures, timeouts
and a bounded wall-clock window per lane, mirrored to `dispatch-lane-stats.json` (cache
directory) and rendered as an advisory `stats:` column on `dispatch_lanes`,
`llm-relay dispatch` and `GET /dispatch`. Lane stats never reorder the ladder and never
feed HTTP pool scoring: a CLI wall-clock includes process launch and tool execution, which
would poison the provider latency figures.

For `cli`-kind lanes ONLY, the daemon also records one accounting request — a `relay`-kind
lane's harness traffic already flows through the daemon's own HTTP pipeline with reported
tokens, so a second row would double count. The ledger row carries the ESTIMATED ENVELOPE:
chars/4 of the task text and chars/4 of the lane's final output, labelled `estimated`,
attribution `unknown`, client `mcp-dispatch`, no credential, unpriced. It is NOT the lane's
provider consumption, which the relay cannot see (the lane's own harness runs its own tool
loop against its own credentials); `llm-relay cost --by client` prints this caveat beside
any `mcp-dispatch` row. For `cli` lanes, which carry no spec, the ledger `model` is the
lane id.

#### The automatic lane walk (`routing.dispatchWalk`)

Before this existed, one `dispatch` call ran exactly ONE lane. If that lane was slow, the calling
agent had to notice, give up, and name a different lane by hand — which is what this replaces.

A dispatch now WALKS the ladder:

- Each lane gets an **attempt budget** drawn from ITS OWN recorded runs: the 80th percentile of
  the last 100 wall-clock times for that lane. If it has not answered by then, the relay stops it
  and starts the next one. A lane with fewer than `attemptMinSamples` recorded runs gets the flat
  `attemptMs` instead — unmeasured means no opinion, never "slow" — and the budget never falls
  below that flat figure however fast a lane's history is.
- ⚠ **The LAST lane gets no budget.** There is nowhere to move to, so killing a lane that is still
  working would throw away the only answer still coming. Its own `--timeout` still bounds it.
- The lane that answers is **pinned** for `pinMs` (default 15 min), so the next dispatch on that
  tier takes it first. A lane that did not answer is **demoted** for `demoteMs` and is tried after
  the lanes that carry no demotion.
- When every lane is spent, the answer is an instruction to do the work in the calling session
  instead. The relay cannot start your agent's own subagent — it decides ORDER, the host executes —
  so the last rung of the ladder is an answer, not a spawn.
- ⚠ That instruction says "every lane has been tried", so it appears ONLY when that is true. When
  the walk stopped at its own `maxLanes` bound, the answer says lanes remain and invites a retry
  instead — the lanes it just tried are now demoted, so a second dispatch reaches different ones.
  With `dispatchWalk: false` there is no such instruction at all, because one lane was tried and
  nothing was learned about the rest.

```jsonc
"routing": {
  "dispatchWalk": {
    "enabled": true,
    "attemptMs": 90000,        // the budget for a lane with too little history, and the floor
    "attemptQuantile": 0.8,    // which point of a lane's own history the budget sits at
    "attemptMinSamples": 5,    // recorded runs a lane needs before its own history is used
    "maxLanes": 4,        // how many lanes one dispatch may try
    "pinMs": 900000,      // how long the lane that answered is preferred
    "demoteMs": 900000    // how long a lane that did not answer is ordered behind the rest
  }
  // or the boolean shorthand: "dispatchWalk": false
}
```

Default ON; `"dispatchWalk": false` is a byte-for-byte revert to one lane per call with no memory.
An unknown key is a config error.

⚠ **The METHOD comes from the request path; none of its NUMBERS do.** Deriving a threshold from
what an endpoint has actually done is the same mechanism `hedge-trigger.ts` and
`latency-demotion.ts` use. But their figures (250 ms/token, a 30 s ceiling) are calibrated for
single completions, and a lane legitimately runs an agent loop for minutes — pointing them at a
lane would stop every healthy one at once. Every figure here comes from lane data.

⚠ **The quantile is 0.8, not the 0.95 the request path uses, and the measurement says why.** On
this machine the three working lanes read p80 at 165 s, 224 s and 1383 s; at p90 and p95 the
slowest lane's figure IS its own configured timeout, so a budget there could never fire for the one
lane most in need of bounding. p80 is the highest point still carrying information for every lane.

⚠ **The token-normalised half of that ladder is deliberately absent.** A walk budget fires BEFORE
any answer arrives, so there is no output token to normalise by — the same reason the request
path's own per-token rung is inert when it decides whether to hedge.

⚠ **A pin promotes; it never resurrects.** A pinned lane that is exhausted, disabled, unreachable
or not servable is still not selected — the pin only reorders lanes that were already selectable.

⚠ **The memory is the daemon's.** `llm-relay mcp` runs the walk and reports each attempt to
`POST /dispatch/telemetry`; the daemon records the pin and the demotion in `lane-affinity.json`, so
they survive an MCP restart and are visible to `llm-relay dispatch` as well. With the daemon
unreachable the walk still runs, but the memory has nowhere to go and the ladder falls back to
configured order.

#### Background lane re-probing (`routing.laneProbe`)

A recorded lane death is a snapshot, not a standing fact — a quota can reset early. The relay
therefore re-probes on its own background cadence (the same loop that pings HTTP providers):

- **Catalog probes** re-run each lane's roster command (`codex debug models`, `agy models`) once
  per `catalogIntervalMs` (default 24h). Metadata only; no quota is spent. A roster older than
  7 days stops counting as eviction evidence — a model missing from a stale roster reads as
  UNKNOWN, never `not-servable`, until a fresh probe answers.
- **Quota probes** send one minimal real completion through a lane's own configured command —
  but ONLY for a quota bucket currently recorded as exhausted, once per `quotaIntervalMs`
  (default 6h). An alive lane is never probed (real use re-tests it for free). A real answer
  retracts the recorded death immediately; an explicit rate/quota statement in the failure
  refreshes it (a vendor-stated "try again in N hours" wins over the defaults); anything else —
  timeout, empty output, unrecognized error — changes nothing.

```jsonc
"routing": {
  "laneProbe": { "enabled": true, "quotaIntervalMs": 21600000, "catalogIntervalMs": 86400000 }
  // or the boolean shorthand: "laneProbe": false
}
```

Default ON. A quota probe spends the lane's own quota, so it is bounded: only dead buckets, one
prompt ("Reply with the single word OK."), and a freshly reported death waits one full interval
before its first re-probe. Disable with `"laneProbe": false`; an unknown key is a config error.

A `cli` rung may declare `env`: string values are set on the spawned command, `null` values are
unset (`llm-relay dispatch` renders both into the printed line — `env -u X NAME=value cmd …` for
sh, `$env:`/`Remove-Item Env:` statements for PowerShell). This is what makes a **relay-routed
`claude` CLI rung** declarable — the lane for hosts whose own HTTP traffic cannot be redirected
(Claude Desktop pins its sessions to `api.anthropic.com`; a terminal-spawned `claude` honours
`ANTHROPIC_BASE_URL`, so shelling out IS the redirect):

```jsonc
{
  "id": "claude-pool", "kind": "cli", "command": "claude",
  "args": ["-p", "--model", "pool/medium", "--permission-mode", "acceptEdits", "{task}"],
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8791",
    "ANTHROPIC_AUTH_TOKEN": "dummy",           // relay strips it for contained providers
    "CLAUDE_CONFIG_DIR": "/home/me/.llm-relay-claude", // isolated: no OAuth conflict with a
                                               // subscription. ABSOLUTE path — env values are
                                               // passed verbatim, `~` is never expanded
    "CLAUDECODE": null, "CLAUDE_CODE_SSE_PORT": null, "CLAUDE_CODE_ENTRYPOINT": null,
    "ANTHROPIC_API_KEY": null                  // nested-session vars a parent claude leaks
  }
}
```

#### Host-adaptive lanes (`routing.cliLane`)

`llm-relay dispatch` is meant to be the **one verb** a host agent uses, whatever harness it runs
in. To make that true it classifies the calling session — **routed** (its traffic reaches the
relay, so `relay` rungs work as written) or **bypassed** (it does not) — and adapts the answer.

The verdict comes from the caller's `ANTHROPIC_BASE_URL`: a loopback address means routed (a proxy
chain in front, e.g. headroom, still counts), anything else or unset inside a Claude session means
bypassed. It is detected by the **CLI**, which is a child of that session, and forwarded as
`?host=`; the relay cannot work it out from a request, because a bypassing host sends none.
`--host routed|bypassed|unknown` overrides it.

On a bypassed host, a `relay` rung whose spec needs the subagent-reroute path is **transposed** into
a CLI invocation using `routing.cliLane`, so one template replaces a hand-written CLI rung per pool
per tier:

```jsonc
"routing": {
  "cliLane": {
    "command": "claude",
    "args": ["-p", "{task}", "--model", "{spec}", "--permission-mode", "acceptEdits"],
    "env": {
      "ANTHROPIC_BASE_URL": "http://127.0.0.1:8791",
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "{contextWindow}",   // dropped when unpublished
      "CLAUDECODE": null
    }
  }
}
```

**Placeholders.** `{spec}` (required) is the rung's routing spec and `{task}` (required) the
delegated task. `{contextWindow}` (optional) is the spec's published context window in tokens.

| Placeholder | In `args` | In `env` | Why |
|---|---|---|---|
| `{spec}` | yes | yes | relay-resolved routing |
| `{contextWindow}` | yes | yes | relay-resolved provider metadata |
| `{task}` | yes | **rejected at config load** | request content must never become process configuration |

**Idle watchdogs.** Claude Code aborts a long silent generation (~300 s on a custom base URL) via
three client-side idle timers — event-level and byte-level streaming watchdogs plus a body idle
timeout — and the relay's final-wire commit probe holds bytes back until meaningful content, so a
long think looks idle to all three. A lane meant to run reasoning models should set
`CLAUDE_STREAM_IDLE_TIMEOUT_MS=1800000`, `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=1800000` and
`API_FORCE_IDLE_TIMEOUT=0` in its `env`; this machine's own `routing.cliLane.env` does.

A rung pointing at the plain Anthropic passthrough is **not** transposed — a bare `Agent(...)`
reaches that from any host. With no template configured, such a rung is reported `unreachable` and
skipped when picking `next` (an explicit `?lane=` still reaches it, and says why it is blocked).
`requiresDirective` is never set on a bypassed host, because an `@relay:` line there is inert, not
merely insufficient.

#### The context window (`{contextWindow}`)

A CLI told to use a model it does not recognize assumes a window and compacts against it — the
`claude` CLI assumes 200k — so a lane pointed at a 1M-context model silently throws away most of
it. The relay already harvests per-(provider, model) limits for the request-path guardrail, so it
substitutes the number it has.

Three rungs, **all real measurements** — there is deliberately no guessed rung, the same rule that
keeps `resolveMetadata` honest and the request-path guardrail silent on an unknown limit:

1. **`observed`** — a ceiling this deployment *stated when it refused an over-length request*.
   The strongest evidence available: a first-party fact about the exact deployment that will serve
   the next request. See "Learned limits" below.
2. **`provider`** — the serving deployment's own published `contextLength`.
3. **`snapshot`** — `context_length` from the synced capability data (`docs/tier-data.json`, from
   OpenRouter), matched **exactly** on the spec's last segment.

`llm-relay dispatch` prints which rung answered, because a first-party figure and a same-model
figure measured on another host are different claims:

```
   context: 1,048,576 tokens (published by the serving provider)
   context: 163,840 tokens (synced snapshot, same model id on another host)
   context: not published anywhere for this spec — the variable is omitted and the CLI uses its own default
```

⚠ **Rung 2 is what makes this usable.** Free providers publish little metadata and NIM publishes
none, so rung 1 alone is nearly empty — measured 2026-08-07, 0 of 29 `pool/high` members carry a
provider-published window while 28 of 29 carry a snapshot one.

⚠ **Fuzzy snapshot matches are rejected.** `findTierModel` will fall back to containment, which can
borrow a different SKU's row (`glm-5.2` → `glm-5.2-max`). A wrong capability score mis-ranks a pool;
a wrong context window tells a client it may send tokens the backend will reject, so this path takes
the stricter rule.

For a **`pool/<name>`**, the **minimum across members that resolve** is used — failover can land the
request on any member, so the pool's usable window is the smallest one known. An unresolvable member
does **not** veto the pool; the count of unmeasured members is reported alongside the number, so a
floor drawn from 28 of 29 members does not read like one drawn from all of them:

```
   context: 163,840 tokens (synced snapshot, same model id on another host; 1 pool member unmeasured)
```

**Nothing known at all** drops the env entry entirely rather than setting it empty (which a child
would read as zero or garbage), leaving the client on its own default.

⚠ **Do not "fix" an unknown by hand-setting a large value.** The measured pool minimums here are
131,072–163,840 — *below* the 200k the `claude` CLI already assumes for an unrecognized model. A
speculative 1M would overshoot the weakest member by six to eight times and overflow the real
backend, which is strictly worse than the conservative default it replaced.

#### Learned limits (`context-limit` and `max-output` facts in `~/.llm-relay/target-facts.json`)

There is no separate `context-limits.json`: ceilings are stored as deployment-scoped facts by
the shared learned-facts store, so scope and keying are decided in one place.

Providers publish little, but a deployment that *rejects* an over-length request usually states its
real ceiling in the error message. The proxy reads that and remembers it, so a pool's floor gets
more accurate the more it is used:

- Fires on a backend **400/413** whose body reads as a context-length rejection, on **both**
  request paths.
- Records **only an explicitly stated maximum**. "The request was too long" is *not* recorded — it
  bounds the ceiling by this proxy's own chars/4 estimate, and a store whose value is that it holds
  measurements must not accept a guess.
- Reads bytes the relay already buffered on the error path, so the client's body and any failover
  are untouched. Every failure path simply learns nothing.
- Keyed per `(provider, model)`, since the same model id on two hosts is two deployments. A fresh
  observation always replaces an older one in either direction — the deployment is the authority on
  its own ceiling — and entries expire after 30 days so a raised ceiling is not disbelieved forever.

The same mechanism learns a stated **output** ceiling. A 400 whose body explicitly states the
maximum `max_tokens` (Groq's `` `max_tokens` must be less than or equal to `8192` ``) records a
`max-output` fact under the same rules — explicit statements only, deployment scope, 30-day TTL.
Unlike `context-limit`, which feeds the `{contextWindow}` resolver, `max-output` is **display-only**:
`llm-relay candidates` renders it, and nothing clamps, refuses, or routes on it.

This is what makes the "unmeasured member" case self-correcting: the first over-length rejection
from that member states its ceiling, and the next dispatch reports the corrected floor.

Rate limits are learned the same way: a 429 whose body states an explicit ceiling ("limit 60
requests per minute", "TPM: 6000") — or a response carrying attributed `x-ratelimit-*-limit` /
`-remaining` header pairs for a minute/day period — is remembered as a `rate-limit-*` fact, shown
per member in `/candidates`. Like learned context ceilings these are **display-only by default**:
they never gate traffic unless you turn on the Stage 5 opt-in `routing.quota.enforceLearned`.

`llm-relay dispatch --next-command -t "<task>"` prints just the runnable line for `next`, for
callers that want something executable rather than the human ladder.

### `llm-relay mcp` — dispatch as an MCP tool

`llm-relay mcp` serves the dispatch verb over the Model Context Protocol on stdio. Any MCP host
then delegates a whole task with **one call that returns an answer**, instead of a command it has
to execute itself.

This is the preferred entry point for every MCP host—Claude, Codex, desktop, CLI, or otherwise.
The model should not classify its host or choose a native child mechanism. In particular, Codex
Desktop must use MCP `dispatch`, because its ChatGPT collaboration launcher rejects a `pool/*`
child before the custom provider or relay is contacted. If MCP is unavailable, use the one generic
fallback: `llm-relay dispatch --next-command -t "<task>"`, then follow exactly the returned command
or target rather than guessing what this host can reach.

Why that difference matters: executing a lane command correctly is the hard part. The lane needs
three client idle timeouts lifted or a long think is aborted at about 300 seconds; it needs its
stdin closed or `agy` waits on it until the timeout; an npm `.cmd` shim needs a shell whose every
token is quoted; and a console-subsystem child needs `windowsHide` or it steals the desktop focus.
`llm-relay mcp` does all of that once, so a caller never builds a command line.

Add it to a host:

```bash
claude mcp add --scope user llm-relay -- llm-relay mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.llm-relay]
command = "llm-relay"
args = ["mcp"]
```

Five tools:

| Tool | Purpose |
|---|---|
| `dispatch(task, mode?, system?, schema?, maxTokens?, tier?, lane?, cwd?, waitMs?, timeoutMs?)` | Hand a task to the best ready lane and return its answer. |
| `dispatch_status(jobId)` | Is a long lane still running? |
| `dispatch_result(jobId)` | Collect a finished lane's answer. |
| `dispatch_cancel(jobId)` | Stop a running lane. |
| `dispatch_lanes(tier?)` | Show the ladder, to choose a lane deliberately. |

`dispatch` blocks for `waitMs` (default 60 s) and then hands back a `jobId`. A fast lane therefore
costs one call, and a long one degrades to polling rather than hitting the host's tool timeout.
Every answer names the lane that produced it — the relay never presents another agent's text as
its own.

### `mode: "agent"` vs `mode: "answer"`

`mode` defaults to `"agent"` — a lane's own harness runs with full tool access, exactly as
`dispatch` has always behaved. Pass `mode: "answer"` for a question, draft, summary, or second
opinion that needs no file access: for a `relay`-kind rung (a pool spec) it skips the spawned
harness entirely and POSTs straight to this relay's own `/v1/messages`, which is faster —
measured 5.7–10.8 s direct against 22 s through a spawned `claude -p` harness for a one-line task.
Use the default agent mode whenever the lane must read or edit files or run commands; a `cli`-kind
rung (agy, codex) behaves exactly like agent mode in either `mode`, since it has no direct-HTTP
form of its own.

Three answer-mode-only parameters:

- `system` — an optional system prompt for the direct call.
- `schema` — a JSON Schema. When given, the call forces a single `answer` tool call and the
  result is that tool's `input`, JSON-stringified, instead of free text — useful for a
  structured second opinion (a verdict, a list, a score) rather than prose to re-parse.
- `maxTokens` — `max_tokens` for the direct call (default 4096).

Answer mode still returns a `jobId`/polls/cancels exactly like agent mode; `dispatch_cancel`
aborts the in-flight fetch. Its provenance line also carries whichever of the relay's own
`x-llm-relay-served-by` / `-pool-attempts` / `-hedged` / `-latency-demoted` / `-degraded`
headers the response announced, when it answered 2xx — a non-2xx response is reported as a
failure carrying the HTTP status and a bounded excerpt of the body, never headers. If the
resolved spec happens to be the plain Anthropic passthrough, the dummy credential this mode
sends fails there and the pool walk moves on to the next candidate, same as any other rejected
attempt.

**Bounds.** Delegation depth is capped at 3 through `LLM_RELAY_DISPATCH_DEPTH`, because a
dispatched lane can reach this server again. A lane runs in the server's own working directory
unless the caller names another; declare `routing.mcp.allowedRoots` to bound which directories a
caller may name (the containment check resolves `..` before comparing, so a traversal segment
cannot escape a declared root):

```json
{ "routing": { "mcp": { "allowedRoots": ["C:/Code"] } } }
```

Answer mode needs no working directory at all — the `cwd`/`allowedRoots` check applies only to
agent mode and to a `cli`-kind rung in answer mode, both of which spawn a process.

**A timed-out dispatch never returns nothing.** Whether the timeout kills a spawned child (agent
mode) or aborts the fetch (answer mode), the job's status becomes the distinct `timed_out` —
never a bare `failed` that hides *why* — and `dispatch`/`dispatch_result` render whatever partial
output survived plus a one-line reason, so a caller polling a long lane is never left with an
empty response to interpret.

**A content-empty answer is reported as a failure, not a success.** A lane can exit 0 (or answer
HTTP 200) with text that is syntactically nonempty but carries nothing usable — a lone `#`, a bare
`---`. After stripping whitespace, punctuation, and Markdown scaffolding, if nothing alphanumeric
remains, both dispatch modes report it as a distinct `empty-output` failure rather than a
successful empty answer. This is a structural check only — a short real answer like `OK` or `42`
still reads as content, and the check never tries to judge whether the content actually answers
the task.

**Scope.** This is a separate process that the host launches. It is not part of the relay daemon,
and it does not change the rule that no HTTP request causes a lane to be spawned — answer mode's
own HTTP call is this server's OWN outbound request to the relay, not an inbound one triggering a
spawn. It needs a configured `routing.ladder`, which is a per-machine choice — a fresh install
ships none, and `dispatch_lanes` says so plainly.

When an agent-mode lane run settles (anything but cancelled), the server forwards one
metadata-only telemetry report to the daemon's `POST /dispatch/telemetry` — the lane id and
kind, the wall-clock, the exit code, the terminal status, and the two estimated token counts
(chars/4 of the task text and of the lane's final output). The forward is best-effort and
never interrupts the stdio protocol: a lane answer is never held for a telemetry write.
`dispatch_lanes` shows each rung's recorded stats as an advisory `stats:` segment
(`stats: 4 calls, 3 ok, 1 failed, 0 timed out, median 24s`; `median n/a` when the lane never
ran here) — see Lane telemetry above for what the daemon records and what the ledger row
means.

---

## The OpenAI front and `/registry`

OpenAI-native clients point their base URL at `http://127.0.0.1:8791/v1` and use a namespaced
model (`anthropic/claude-sonnet-4-20250514`, `pool/medium`). Codex uses `/v1/responses`; most
IDEs use `/v1/chat/completions`. OpenAI Chat to an OpenAI backend is byte-transparent unless a
tool-bearing response contains a recognized text dialect envelope, which is reconstructed as
native `tool_calls`; no-tools traffic remains byte-exact. Other combinations translate through the
Anthropic seam, streaming and tool calls included. The Anthropic front with tool-call repair runs
in parallel — no mode switch.

`GET /registry` returns one JSON view for an external dispatcher: every provider with aggregate
`has_key`, `reachable`, and its live models (each with raw capability scores, never collapsed to
tiers), plus current routing and the full leaderboard dataset. Every provider also exposes nested
credential metadata: `credentialId`, `label`, env name (`authEnv`), `enabled`, `models`, `state`,
and slot `has_key`. Fleets have one entry per configured slot; legacy and keyless providers expose
their implicit `default` slot. These are identities and state only; secret values are never returned.

`/telemetry` deliberately remains provider-aggregate, and `/health` strips nested credential
details. Use `/registry` for fleet inventory and `/candidates` for deployment × credential policy,
state, quota, breaker, and fact cells.

### Document attachments on non-Anthropic backends

Anthropic `document` blocks (PDF, docx, pptx, xlsx, CSV, HTML, …) are converted to markdown via
[MarkItDown](https://github.com/microsoft/markitdown) before reaching an OpenAI-compatible
backend. MarkItDown is optional (`pip install 'markitdown[all]'`, or set
`LLM_RELAY_MARKITDOWN`); without it, a document request gets a clear 400 naming the install
command. An unconvertible document is **refused, never truncated or inlined raw**. Images pass
through natively.

### Model discovery

Model ids are discovered live from each provider's `/models` endpoint — never hand-maintained —
and cached in `~/.llm-relay/models-cache.json` (10-min TTL, fail-open). On startup the proxy
warms routed and free providers and warns about any routing target its provider doesn't serve.
Where a provider publishes rate limits in its `/models` records (rpm/rpd/tpm/tpd), those are
harvested alongside the other limits; most providers publish none.

```bash
llm-relay models                 # every provider
llm-relay models -p nim -r       # one provider, force re-fetch
```

### Local analytics dashboard

Keep the proxy running, then launch its read-only dashboard from another terminal:

```bash
llm-relay dashboard
```

This command does **not** start another proxy. It reads the configured relay address and local
control capability, asks the already-running relay for a short-lived one-use bootstrap, and opens
the platform's default browser at `/dashboard/`. If the browser launcher is unavailable, it prints
the one-use URL instead; if the relay or its control authorization is unavailable, the command
fails closed.

The bootstrap travels in the URL fragment (which is not sent in the HTTP request). The SPA reads
and removes it from the address bar before exchanging it once for a scoped dashboard session.
A printed fallback URL is machine-local — the relay accepts the exchange only from its own
listener's Origin — and expires after 60 seconds, so a link pasted elsewhere is inert. The
static shell is tokenless, but snapshot, detail, and logout operations require that session. The
dashboard never receives the persistent control capability.

Views use the relay's bounded accounting read model: caller-visible requests, serving and repair
attempts, reported versus estimated tokens, latency and commit timing, normalized outcomes, recent
request detail, provider/model/client/credential dimensions, and available quota/cooldown facts.
Every committed serving attempt (and every repair attempt) whose model-authored content is safely
parsed within the observer's bounds carries a separate `relay_estimate` output figure: chars/4 over
decoded text, thinking/reasoning, and tool-call argument JSON, excluding SSE/JSON framing and base64
payloads. With no parsed content, the estimate remains unknown rather than zero; a malformed or
oversized content-capable frame also leaves the estimate unknown. That taint discards the whole
attempt's count, including content from earlier valid frames, not just the offending frame. This
estimate never replaces or changes a provider-reported output figure, reported window basis, or
current spend pricing.
Missing coverage and unknown values stay explicit. Reads do not probe providers, perform egress,
scan logs, or expose prompts, bodies, tool arguments, raw provider errors, or key material.

**"Partial" means the store held data this projection could not surface** — a dropped row, an
overflowed counter, a capped read, an unreadable shard — never merely a token kind nobody reported.
A request whose backend never sends cache tokens, or that only carries an estimate with no reported
usage at all, renders that cell as null with provenance `"unknown"` while the panel around it stays
`"complete"`: nothing the store held is missing, a host simply never stated that figure. Only actual
loss (or, for latency/commit, an unknown count in EXCESS of what an outcome like `cancelled` already
explains) degrades a panel to `"partial"`.

**Spend figures.** Each request is priced at completion from PUBLISHED per-(provider, model)
prices only — the serving deployment's own publication where it exists, otherwise another
provider's figure for the same model id (labelled `reference`). There is no fallback price, no
tunable default, and no cache multiplier, so a deployment that publishes nothing is **Unpriced**
(rendered as "Unpriced", never "$0") and its request counts in `unpricedRequests`. Amounts are
integer micro-USD in four cells (provider-published/reference × reported/estimated), never blended.
Cache token kinds are deliberately NOT priced: Anthropic's cache creation/read are separate from
`input_tokens`, and OpenAI includes cached tokens in `prompt_tokens` at an unpublished discount —
since no published price covers them they ride beside the amount as unpriced counts, and such
requests count in `partiallyPricedRequests`. While `partiallyPricedRequests` > 0 every spend
amount is a **lower bound**, and the dashboard says so next to the figures. Request-level spend
mirrors request tokens: only the winning serve attempt is projected, so a retried-elsewhere
request never double-counts its failed attempts; repair spend stays visible on the attempt rows.

The **Quota headroom** and **Cooldowns** panels are populated from live relay state (circuit
breaker observations, operator-declared limits, learned limits, target-fact conditions) plus the
local ledger — no provider is contacted for them. Every quota figure carries its basis:
`provider_stated` (read off this deployment's own response headers), `configured` (operator-declared
in config `limits`), `learned` (parsed from what the deployment stated when it refused), or
`published` (catalog-harvested). A `derived_*` remaining means the relay computed it as limit minus
local usage over the current period; period boundaries are UTC (minute/day/month). A row's RESET
carries its own basis too: `provider_stated` (a reset the response itself stated), `reviewed_rule`
(a reset resolved through an accepted refusal interpretation and stored with the learned
condition), or `derived_boundary` (the UTC period boundary the relay computed). A stored
condition's reset only answers a bucket that is measured-spent and whose own response stated no
reset — a credential-wide condition never invents a reset for a bucket with headroom, and only
the two spent-allowance conditions (`allowance-exhausted`, `rate-limited`) may answer at all.
`llm-relay candidates` prints the same basis in its `resets Ns (<basis>)` clause, so the terminal
and the panel cannot disagree about one cell. Unknown renders
as "Unavailable", never 0, and a negative remaining means the credential overshot its ceiling.
`learned` figures are display-only — routing acts on them only under the explicit opt-in
`routing.quota.enforceLearned` (spec decision M2). Cooldown rows show WHY a member is cooling (`rate_limit`, `auth_error`,
`provider_error`, or `manual` — a reached operator-set hard cap) and until when, with the real
observation time where one exists; a `manual` row carries no observation time, because config load
is not an observation.

The same accounting read model is available **without a running relay** as a terminal roll-up:
`llm-relay cost` reads `~/.llm-relay/usage/` directly and prints the four spend cells side by side
per provider/model/client/credential, with the same provenance rules as the dashboard. See the
CLI reference below.

**The window name is not the period, so the report prints the period.** Every rolling window ends
on a bucket boundary, which puts the newest partial bucket outside it — up to 15 minutes behind the
clock for `24h`, an hour for `7d`, and six hours for `30d`. The report therefore states its own
bounds and, when the window ends behind the clock, how many whole minutes are excluded:

```
llm-relay cost — 24h
Covering 2026-08-30T06:15:00.000Z → 2026-08-31T06:15:00.000Z (UTC).
The window ends on a bucket boundary, so the most recent 12 minutes are not counted.
```

The figure floors, so it never claims more is missing than the two timestamps prove, and a gap
under a whole minute prints nothing. ⚠ This is a separate effect from the flush note in the
footer: that one is about a running relay's unwritten deltas, while this applies to a stopped relay
whose ledger is fully committed.

---

## CLI reference

**Unrecognized commands and stray arguments are refused, not ignored.** A command name the CLI does
not know exits 1 naming it, rather than starting the proxy — so a typo reports itself instead of
launching a second relay. Every command also bounds how many positional arguments it takes, so an
argument that would have been silently discarded exits 1 before anything happens: `llm-relay cost
--window 1h 7d` no longer reports the 24h window while ignoring `7d`, and `llm-relay models nim` no
longer lists every provider while ignoring `nim` (it is `-p nim`).

Three details worth knowing. `--help` and `--version` still short-circuit, so `llm-relay <command>
--help` works even when the rest of the line is wrong — **except `keys` and `cooldowns`**, whose own
strict, fail-closed parsers run ABOVE that short-circuit and refuse the flag outright
(`llm-relay keys: unsupported option`; `llm-relay cooldowns: unknown option "--help"`). Use
`llm-relay help` for those two. `pools`, `routing` and `route` take an
unbounded list of specs and are deliberately unbounded here too. And the refusal names the command
and the count but never echoes the offending token — a stray argument can be anything you pasted,
and `keys` diagnostics have always refused to echo argv for that reason.

| Command | Description |
| :--- | :--- |
| `llm-relay` | Start the proxy |
| `llm-relay onboard [--import <file>] [--force]` | Set up or import provider keys |
| `llm-relay setup [<claude-cli\|claude-desktop>]` | Point a client at the relay (omitted target defaults to `claude-cli`) |
| `llm-relay keys [check\|add\|list\|rotate\|revoke\|remove\|disable\|enable\|export\|import\|unlock]` | Check or manage encrypted provider credentials; see [Key custody](#key-custody) |
| `llm-relay pools [list] [--json] [--probe]` | List pool names and members; `--probe` spends one completion per unique deployment through one serviceable slot |
| `llm-relay pools <name> [--json]` / `llm-relay pools show <name> [--json]` | Show one pool's effective members |
| `llm-relay pools <set\|add\|remove\|delete> <name> [spec...]` | Edit a pool |
| `llm-relay routing <show\|get\|default\|tier\|subagent\|sort\|benchmark\|set\|unset\|answered>` | Edit routing. `answered` retires the first-run notice (below) without changing anything. `route` is an alias for the whole command. |
| `llm-relay lanes [--probe]` | What each `cli` dispatch lane's own tool says it serves; `--probe` runs each lane's roster command. A roster older than 7 days is flagged `STALE` and stops counting as eviction evidence. Rosters are also refreshed by the background cadence (`routing.laneProbe`), so `--probe` is the on-demand form, no longer the only writer. |
| `llm-relay config <show\|get\|set\|unset> [path] [value]` | Edit any config field |
| `llm-relay models [-p <name>] [-r]` | List live provider catalogs |
| `llm-relay ping [-p <name>]` | Probe provider latency/health |
| `llm-relay dashboard` | Open the read-only dashboard of an already-running relay |
| `llm-relay cost [--window <w>] [--by <d>] [--include-repair] [--json]` | Summarise spend from the local accounting ledger; windows: 1h/24h/7d/30d/all (default 24h); group by provider/model/client/credential (default provider) |
| `llm-relay telemetry` | Print provider-health and runtime-observation telemetry JSON (not quota JSON) |
| `llm-relay offload [status \| <client> <on\|off> [--scope <scope>]]` | Show/toggle offload |
| `llm-relay cooldowns clear <provider>[/<model>] [--credential <label>] [--json]` | Clear scoped cooling state in the running relay; print grouped results or raw JSON |
| `llm-relay candidates [-p <name>]` | Compare deployment × credential-slot targets |
| `llm-relay eligibility [<propose\|accept\|reject> ...]` | Review or record backend eligibility refusals; `reject` records that no durable fact should be learned |
| `llm-relay dispatch [lane] [options]` | Choose the next dispatch lane |
| `llm-relay help` / `llm-relay version` | Help / version |

Config editors validate the complete JSON before writing and need a proxy restart; the offload
toggle, cooldown clear, and dispatch queries talk to a running proxy and apply immediately.

```bash
llm-relay pools set medium nim/z-ai/glm-5.2 openrouter/openai/gpt-5.2-codex
llm-relay pools set medium --free --effort medium     # dynamic free pool
llm-relay routing default nim/z-ai/glm-5.2
llm-relay routing tier sonnet pool/high
llm-relay config set routing.offload.claude.freeOnly true
```

### Clearing live cooldowns

`llm-relay cooldowns clear <provider>[/<model>] [--credential <label>] [--json]`

Retracts cooling state for a configured provider from the **running** relay. The provider is
required. Add `/model` to address one deployment, `--credential <label>` to address one configured
credential slot, or both to address one deployment × credential cell. The credential value is a
non-secret configured label, not an environment variable name or key. An unknown provider is an
error rather than a successful no-op. Model and syntactically valid credential selectors that match
no state, and a second clear of the same scope, are idempotent successes with zero counts.

Parsing is fail-closed. Apart from option values, the invocation must contain exactly the three
positionals `cooldowns`, `clear`, and one `<provider>[/<model>]` spec. The only accepted options are
`--credential <label>` and `--json`, plus the documented global `-c`/`--config <path>`,
`-p`/`--provider <name>`, and `-r`/`--refresh` flags. Unknown options, duplicate options (including
the short and long spelling of the same global), missing or empty option values, values supplied to
`--json` or `-r`/`--refresh`, and missing or extra positionals all exit 1 before any request is sent.
The clear selector itself still comes from the one required spec and optional `--credential`.

```bash
llm-relay cooldowns clear nim
llm-relay cooldowns clear nim/meta/llama-3.3-70b-instruct --credential primary
llm-relay cooldowns clear nim/meta/llama-3.3-70b-instruct --credential primary --json
```

The clear removes only state that currently demotes the addressed target:

- breaker cooldowns created by failures, 402s, 429 escalation, `Retry-After`, or quota demotion;
- the consecutive unexplained-429 counter, so the next unexplained 429 starts again at the
  2-minute rung rather than advancing the ladder;
- 401/403 credential-fault state; and
- active `allowance-exhausted`, `rate-limited`, and `credential-invalid` target facts.

It retains every non-cooling axis:

- breaker failure, status/ping, and measured-stability history (apart from the dedicated
  consecutive-429 escalation counter named above);
- configured and learned quota observations plus the `context-limit`, `max-output` and
  `rate-limit-rpm|rpd|tpm|tpd` measurement facts;
- the `not-servable` and `subscription-required` eviction facts; and
- all accounting-store state, including its usage history, windows, and roll-ups.

A clear is a retraction of cooling state, not a fabricated successful measurement; an underlying
condition can cool the target again through ordinary routing.

Breaker cells narrow by every supplied selector. A persisted fact is retracted only when its
entire atomic scope fits inside the requested scope; a narrow operator mutation is not evidence
that can disprove a broader condition, and facts are never fabricated into narrower rows:

| Stored fact scope | How the provider-qualified selector matches it |
| :--- | :--- |
| `attempt` | Provider plus each supplied model and credential |
| `group` | Provider; with a model selector every member must be that model, and with a credential selector the group must be bound to that credential |
| `deployment` | Provider plus a supplied model, but only when no credential selector would split the row |
| `credential` | Provider plus a supplied credential, but only when no model selector would split the row |
| `provider` | Provider only, and only when neither model nor credential narrows the request |
| cross-provider `model` | Never matched by this command |

A matching row is retracted as a whole and its original scope is returned. Broader and independent
rows remain untouched and can keep the selected target cooled; explicitly rerun the command with a
broader selector to retract those rows.

There is deliberately **no file fallback**. Breaker and credential-fault state exists only inside
the running process; editing `target-facts.json` from a separate CLI process would leave the live
breaker and persisted facts disagreeing. If the relay does not answer, the command exits 1 and says
that the relay must be running. No dashboard mutation is exposed; the analytics dashboard remains
read-only.

#### HTTP contract

`POST /cooldowns/clear` accepts this JSON body:

```json
{
  "provider": "nim",
  "model": "meta/llama-3.3-70b-instruct",
  "credential": "primary"
}
```

The body must be a non-null, non-array JSON object. Its only permitted own keys are `provider`,
`model`, `credential`, and `kinds`; every other own key, including a misspelled selector, is
rejected. `provider` is required, must be a non-empty string, and must name a configured provider.
`model` and `credential` are optional, but each must be a non-empty string when present and the
credential must match the configured-label shape `[A-Za-z0-9_.-]{1,32}`. `kinds` is also optional,
but its only accepted value is the exact one-element array `["credential-fault"]`. That form is
reserved for `keys rotate`: it narrows mutation to breaker credential faults and active
`credential-invalid` facts for the selector, leaving breaker cooldowns, the escalation ladder,
and every other fact kind untouched. The ordinary `cooldowns clear` CLI omits `kinds` and retains
the broad behaviour documented above. Non-object bodies, unknown keys, invalid values, unknown
providers, and every other `kinds` value return 400 before any breaker or fact mutation. A
successful response groups only the state actually cleared and reports each group as an exact
`count` plus `items`:

```json
{
  "target": {
    "provider": "nim",
    "model": "meta/llama-3.3-70b-instruct",
    "credential": "primary"
  },
  "cleared": {
    "breakerCells": {
      "count": 1,
      "items": [
        {
          "provider": "nim",
          "model": "meta/llama-3.3-70b-instruct",
          "credential": "primary"
        }
      ]
    },
    "credentialFaults": { "count": 0, "items": [] },
    "facts": {
      "count": 1,
      "items": [
        {
          "kind": "rate-limited",
          "scope": {
            "kind": "attempt",
            "provider": "nim",
            "credentialId": "nim#primary",
            "model": "meta/llama-3.3-70b-instruct"
          }
        }
      ]
    }
  }
}
```

The response contains identifiers only: provider/model names, credential labels or credential ids,
fact kinds, and fact scopes. It contains no refusal bodies, headers, keys, or other secrets. Normal
CLI output renders the same three group counts and identifiers; `--json` prints the raw response.

Neither form is rendered as success until its caller validates the complete response contract.
The broad `cooldowns clear` CLI validator rejects a `kinds` target; the narrowed `keys rotate`
validator requires the exact `kinds:["credential-fault"]` target it sent:

- the envelope has exactly `target` and `cleared`, and `target` has exactly the requested provider,
  optional model, optional credential, and, only for the narrowed rotation call, exact `kinds`,
  with the same optional-key presence as the request;
- `cleared` has exactly the breaker-cell, credential-fault, and fact groups; every `count` is a
  non-negative safe integer equal to its `items` array length;
- every breaker or credential-fault item has exactly the provider/model/credential cell shape and
  is contained by the requested target; and
- every fact item has an allowed cooling kind (`allowance-exhausted`, `rate-limited`, or
  `credential-invalid`) and a valid discriminated attempt/group/deployment/credential/provider
  scope wholly contained by the requested target. A cross-provider `model` scope cannot satisfy
  that containment rule.

A malformed or target-mismatched response exits 1 with an invalid-response error; the CLI does not
print a success heading, grouped summary, or raw JSON for it.

This mutation has the same admission boundary as `/offload` and `/dispatch`: the request's `Host`
must exactly match the bound listener authority; a present `Origin` must be the exact loopback
scheme, host, and effective port (`Origin: null` is rejected); the media type must be
`application/json`; and `x-llm-relay-control-token` must carry the per-install capability from
`~/.llm-relay/control-token`. An absent `Origin` is allowed intentionally for non-browser clients,
including this CLI, which attaches the token automatically. These shared admission checks and the
closed body validation complete before the mutation is reached; loopback alone is not authorization.

### Cost roll-up

`llm-relay cost [--window 1h|24h|7d|30d|all] [--by provider|model|client|credential] [--include-repair] [--json]`

Reads the LOCAL accounting ledger (`~/.llm-relay/usage/`) directly — it works whether or not the
proxy is running, and never talks HTTP. One row per dimension value plus a total: requests, priced
requests, the four spend cells rendered as USD with their basis (e.g. `$0.0123 (published,
reported)`), `-` for unpriced (never `$0.00`), and the `unpricedRequests` /
`partiallyPricedRequests` counts.

- The default window is **24h**, matching the dashboard's default view.
- Cells are never blended into one number. The only single-figure total is
  **published × reported**, printed with its basis.
- `--include-repair` folds role:"repair" attempts into the report AND prints their share as its own
  labelled table — the direct answer to "what did tool-call repair cost me". Without the flag,
  repair attempts are excluded from every row. Under `--window all` the lifetime rollups mix serve
  and repair spend in one figure, so the split cannot be proven: the command says so instead of
  claiming "repair included", and a day-bounded window gives the share.
- **Hedged attempts the relay abandoned get their own table**, printed only when one happened. When
  `routing.hedge` starts a second candidate beside a slow one, the loser is aborted — but the prompt
  really was sent, so it really was spent. That figure is **not** inside the totals above it: the
  totals are what the answers you received cost, and the two added are what those requests cost. The
  table says so in prose, so the two are never read as one number. The split is deliberate — an
  abandoned attempt is priced from an estimated input count, so folding it into the totals would
  mark every hedged request's amounts as a lower bound without any amount changing.
- `--json` emits the same numbers as a stable `dashboard.cost.v1` object, with the abandoned figure
  under `abandoned` beside `total`.
- A store with no data yet prints "No accounting data" and exits 0; only a corrupt or unreadable
  store reports failure; a malformed flag prints a usage line and exits 1.
- "Coverage: partial" means the store held (or should have held) data this report omits — never a
  request that simply carried no token kind. See the coverage note above.

### Endpoints

| Endpoint | Purpose |
| :--- | :--- |
| `POST /v1/messages` | Anthropic front; validates/repairs tool calls |
| `POST /v1/messages/count_tokens` | Local token count |
| `POST /v1/chat/completions`, `POST /chat/completions`, `POST /v1/responses`, `POST /responses` | OpenAI front (versioned and unversioned aliases) |
| `GET /v1/models`, `GET /models` | OpenAI-compatible model discovery |
| `GET /registry` | Provider/routing/capability and nested credential metadata |
| `GET /candidates` | Deployment × credential policy/state/quota/breaker data |
| `GET\|POST /offload` | Read/set offload rules |
| `GET\|POST /dispatch` | Read/advance the dispatch ladder |
| `POST /dispatch/telemetry` | Record lane-execution telemetry (lane stats for every kind; an accounting row for `cli`-kind lanes only) |
| `POST /cooldowns/clear` | Clear scoped live cooling state; identifiers-only grouped response |
| `GET /telemetry`, `GET /ping`, `GET /health`, `GET /health/stats` | Provider telemetry, probe, health (`/health/stats` is the protected `/health` alias) |
| `GET|HEAD /dashboard/`, `GET|HEAD /dashboard/assets/*` | Read-only dashboard SPA shell and static assets |
| `GET|HEAD /dashboard/api/v1/snapshot`, `GET|HEAD /dashboard/api/v1/requests/:requestId` | Session-authenticated dashboard reads |
| `POST /dashboard/api/v1/bootstrap`, `POST /dashboard/api/v1/session` | Mint and exchange a one-use dashboard bootstrap |
| `POST /dashboard/api/v1/logout` | Revoke the current dashboard session |

⚠ **Loopback is not authorization.** Mutating control endpoints and control reads that expose or
materialize provider state (`/registry`, `/candidates`, `/ping`, `/health/stats`, `/health`) require the per-install
256-bit capability token (`~/.llm-relay/control-token` — the CLI carries it automatically). Every
request's `Host` must exactly equal the bound listener authority; any present `Origin` must match
the exact scheme, host, and effective port, and `Origin: null` is rejected. An absent `Origin` is
allowed for non-browser clients such as the CLI. Writes also require `content-type:
application/json`; the capability travels in `x-llm-relay-control-token`. `POST
/dispatch/telemetry` joins that same boundary: it is a mutating control route, so it needs the
exact `Host`, the `Origin`/`content-type` rules, and the control token (the CLI carries it
automatically). `/telemetry` remains
tokenless provider-aggregate data. Response attribution and walk headers are documented under
Failover above.

---

## Using it from your projects

Point the `claude` CLI at the proxy with an **isolated `CLAUDE_CONFIG_DIR`** — without it, an
active claude.ai subscription session conflicts with the proxy token and claude fails
client-side (`Invalid API key`) before any request is sent. The bundled wrappers
(`scripts/claude-proxied.ps1` / `.sh`) set everything:

```bash
scripts/claude-proxied.sh -p "list the files here"
```

Or inline:

```bash
env -u CLAUDECODE -u ANTHROPIC_API_KEY \
  CLAUDE_CONFIG_DIR="$HOME/.llm-relay-claude" \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8791 \
  ANTHROPIC_AUTH_TOKEN=dummy \
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 CLAUDE_CODE_ATTRIBUTION_HEADER=0 \
  claude -p "list the files here"
```

`ANTHROPIC_AUTH_TOKEN` can be `dummy` — the proxy injects the real backend key from the selected
`authEnv` credential slot.
Weak backends still fail *reasoning* (repair fixes form, not judgment) — pick a strong
tool-caller.

### What Claude Code gives up behind ANY custom `ANTHROPIC_BASE_URL`

Not caused by, and not fixable by, llm-relay — Claude Code changes its own behaviour behind any
gateway. Verified against Claude Code 2.1.220; re-check after an upgrade.

| What breaks | Workaround |
|---|---|
| **1M context silently drops to 200k** (client omits the beta header) | Pin per-launch: `ANTHROPIC_MODEL='claude-opus-5[1m]' claude` (overrides the model picker) |
| **`/remote-control` disabled** (hard-gated to api.anthropic.com) | None — unset `ANTHROPIC_BASE_URL` to get it back |
| **MCP tool search off by default** | `ENABLE_TOOL_SEARCH=true` (llm-relay forwards `tool_reference` blocks) |

---

## Logging (metadata only)

Per request: `{ ts, path, servedProvider, servedModel, servedCredential, upstreamReportedModel?, attempts[], hadTools, streamed,
backendStatus, validated, toolUseCount, uncheckableCount, errorKinds[], repair, latencyMs }`.
`attempts` is capped at 64 status-only entries shaped as `{ provider, model, status, ms }`; a
normal HTTP attempt uses its status code, a lifecycle-only failure/cancellation uses
`"failed"`/`"cancelled"`, and a partially flushed response whose upstream body then dies uses
`"committed"`.

The list is an **allow-list applied at the sink** — a caller handing over a wider object cannot
leak a header, body, or key. Attempt entries are projected through their own nested allow-list too,
so an error string or credential identity attached by a caller is discarded. Query parameter
*values* are replaced by their lengths. `servedCredential` is the non-secret `provider#label` that
actually served, or `null`; credential identities on nested attempts remain sink-stripped.
`servedProvider`/`servedModel` are the deployment that actually answered (the id the client
asked for is deliberately not recorded — for a pool spec it is routinely not the model that
served). If the raw upstream response claims a different model, `upstreamReportedModel` records
that claim without replacing `servedModel`; matching or absent claims are omitted. A failed log
write is swallowed: a full disk is a logging problem, never a request
failure. File logging defaults to a 50 MiB cap; before the next line would exceed it, the relay
replaces `<file>.1` with the current file and starts a fresh `<file>`. Set `log.maxBytes` to tune
the cap (maximum 1 GiB); exactly one predecessor is retained.

Run in `detect` first, measure which models trip the validator on your traffic, then decide on
repair. `node scripts/nim-trip-rate.mjs` produces a per-model trip-rate dataset
([nim-trip-rate.md](nim-trip-rate.md)).

---

## Composing with headroom (optional)

headroom (a separate loopback proxy, `pip install headroom-ai`) compresses context; llm-relay
routes.
They chain in one order only — llm-relay innermost, because its backends speak OpenAI while
headroom only forwards Anthropic:

```
claude → headroom (:8787, compression) → llm-relay (:8791, route/repair/translate) → providers
```

Point headroom's upstream at the relay (`ANTHROPIC_TARGET_API_URL=http://127.0.0.1:8791`) and
give llm-relay an `anthropic` passthrough provider with every tier pointing at it: subscription
traffic reaches real Anthropic untouched, `pool/*` goes elsewhere, one instance of each.
**Do not route Codex through headroom** — headroom has a single OpenAI upstream; point Codex
directly at llm-relay's `/v1/responses` instead. The `claude-proxied` wrappers bypass headroom
by design (they are for testing the relay, not subscription use).

---

## Dev & release

```bash
npm run check          # both typechecks + suite — the one gate; CI runs exactly this
npm run build          # tsc -> dist/ (scripts/*.mjs read dist/ — rebuild before running them)
npm test               # vitest
```

`test/` is type-checked by `tsconfig.test.json` (vitest transpiles without type-checking).
Releases publish via npm Trusted Publishing from GitHub Actions — no npm token exists; push a
`v*` tag matching `package.json` on `main`. Architecture and invariants: [CLAUDE.md](../CLAUDE.md).
