# Contributing to llm-relay

Thank you for helping. This page tells you how to set up, how to prove a change is correct, and
how to report a problem without leaking a credential.

- New to the project? Read [docs/architecture.md](docs/architecture.md) first. It explains what
  the relay does and how the code is laid out.
- Want to use the relay rather than change it? Read [docs/QUICKSTART.md](docs/QUICKSTART.md).
- Want the full option list? Read [docs/reference.md](docs/reference.md).

---

## 1. Set up

You need **Node.js 22 or later**. No other tool is required.

```bash
git clone https://github.com/OhOkThisIsFine/llm-relay.git
cd llm-relay
npm install
npm run build
```

Run the relay from source without building:

```bash
npm run dev -- --config config.json
```

The relay binds to `127.0.0.1:8791` only. It refuses to start on any other address.

---

## 2. The gate

One command proves a change. Run it before you open a pull request.

```bash
npm run gate
```

`npm run gate` is exactly `npm run build && npm run check`. Continuous integration runs that full
gate on Linux. A targeted Windows job separately type-checks the test suite and runs the lane
process/env/lifecycle tests, including a real local `.cmd` shim smoke test. `npm run check` runs five steps:

| Step | What it proves |
|---|---|
| `npm run typecheck` | `src/` compiles under `tsconfig.json` |
| `npm run typecheck:test` | `test/` compiles under `tsconfig.test.json` |
| `npm test` | the server suite passes (vitest) |
| `npm run check:dashboard` | the dashboard compiles and its own suite passes |
| `npm run check:package` | the published bundle inventory and a packed smoke test pass |

Build first. Several scripts read `dist/`, and a fresh clone has no `dist/`, so `npm run check`
alone fails on `check:package`.

Run one test file, or one test by name:

```bash
npx vitest run test/repair.test.ts
npx vitest run -t "refuses to reshape a destructive"
```

`npm run analysis:run` runs eslint, knip, madge, dependency-cruiser, ts-prune and jscpd. It is
**advisory**. It is not part of the gate and CI does not run it. Several of its default rules
contradict a documented decision in this project; `eslint.config.mjs` names the decision beside
each rule it disables.

---

## 3. Rules a change must not break

These are the project's invariants. A change that breaks one is rejected, however small it is.
[CLAUDE.md](CLAUDE.md) argues each one in full.

1. **The repair boundary.** The relay fixes protocol *form*, never *judgment*. It corrects a tool
   call whose arguments violate a schema. It never invents intent. No model opinion enters the
   request path. Routing comes from configuration and from deterministic classification.
2. **Provenance.** Never label a guess as a measurement. Unknown stays `null`, never `0`. A total
   that mixes two bases shows the split instead of one undifferentiated number. Do not invent an
   unpublished provider limit, price or context ceiling.
3. **Health demotes, never drops.** An unhealthy candidate moves down the order. It is never
   removed from the list. A pool that filtered unhealthy members once narrowed to nothing at the
   moment it was needed.
4. **Destructive tool calls are refused, never fabricated.** Repair output can run with full
   permissions. An unrepairable call fails clean.
5. **Loopback only, and loopback is not authorization.** Startup refuses a non-loopback bind.
   Mutating endpoints still check `Host`, `Origin`, content type, and a per-install control token.
6. **Logs hold metadata only.** Never a request body, a response body, a header, or a URL
   parameter *value*.
7. **Both request paths get every policy.** The Anthropic front (`/v1/messages`) and the OpenAI
   front (`/v1/chat/completions`, `/v1/responses`) must enforce the same rule. A policy on one
   path that the other walks around is not a policy.

---

## 4. Writing a test

Four conventions cause most review comments. Learn them once.

1. **A failover test needs at least two candidates.** With one candidate, "it failed over" and "it
   cannot fail over at all" produce the same observation. A real defect shipped past a suite that
   made this mistake.
2. **A hand-built `Config` object needs `repair: { maxAttempts, destructiveTools }`, and every
   provider entry needs its `kind`.** Loading defaults an absent `kind` to `"anthropic"`, so an
   OpenAI-kind fixture that omits it exercises a different code path than it claims to.
3. **Never pin a real model's pool band.** Capability scores are synced from live leaderboards, so
   a model's band moves when the population moves. Inject tier rows instead.
4. **Reset the process-global stores between tests** (`resetFacts`, `resetInterpretations`, the
   circuit breaker). Otherwise one test's refusal demotes another test's first candidate.

Some tests in this repository were written to pin a defect rather than to catch it. A correct fix
can therefore turn the suite red. Read the failing test's stated reasoning before you assume your
change is wrong, and change the test in the **same commit** as the source fix.

Tests never reach a real provider. Under vitest the credential store, the state directory and the
lane spawner all redirect or refuse. Do not add a code path that bypasses those guards.

---

## 5. Commit and open a pull request

1. Branch from `main`.
2. Keep the change focused. A behaviour change and a refactor belong in separate commits.
3. Pin new behaviour with a test. Unpinned behaviour regresses without anybody noticing.
4. Run `npm run gate` on a clean tree.
5. Write a commit message that states what changed and why.
6. If a language model authored the change, add a trailer naming that model:

   ```
   Co-Authored-By: <model name> <noreply@anthropic.com>
   ```

7. Open the pull request. Describe what you measured, not only what you wrote.

In the pull request body, say which of the two request paths you tested. If you tested one, say
so plainly. That is more useful than a claim of full coverage.

---

## 6. Testing the relay and reporting a problem

### Collect the diagnosis

Run these and attach the output. None of them prints a secret.

```bash
llm-relay version
llm-relay keys             # credential status, metadata only
llm-relay pools --probe    # does every configured model actually answer?
llm-relay candidates       # the routing decision table
llm-relay cost             # spend roll-up
```

For a failing request, the response headers carry the diagnosis. Every one is safe to share:

| Header | Tells you |
|---|---|
| `x-llm-relay-served-by` | which deployment answered, or the list that was tried |
| `x-llm-relay-pool-attempts` | how many candidates were tried, and how each failed |
| `x-llm-relay-degraded` | the answer came from below the requested capability band |
| `x-llm-relay-quota-demoted` | a candidate was passed over because its quota was spent |
| `x-llm-relay-unknown-refusal` | a refusal the relay could not interpret, with a count |

To capture a request log, set `log.file` in your configuration. The log is metadata only by
design: it never holds a request body, a response body, a header, or a parameter value.

### Redact before you send

**Never attach these files. They hold credentials.**

| File | Holds |
|---|---|
| `~/.llm-relay/.env` | provider API keys in plain text |
| `~/.llm-relay/keystore.json` | the encrypted credential store |
| `~/.llm-relay/control-token` | the token that authorizes control endpoints |

`~/.llm-relay/config.json` is usually safe, because a credential normally appears as an
environment reference such as `${NVIDIA_API_KEY}`. Check it anyway. If a literal key sits in the
file, replace it with `REDACTED` before you attach it.

Two more checks before you send anything:

1. **Scan for key-shaped strings.** Provider keys start with recognisable prefixes, such as `sk-`,
   `nvapi-`, `gsk_`, `hf_` or `AIza`. Search your attachment for each and replace the whole value.
2. **Read provider error bodies.** The relay passes a provider's error through unchanged, and some
   providers name your account or organization in it. Replace that text.

On this project, `~/.llm-relay/` is the default state directory. If you set `XDG_CONFIG_HOME` or
`XDG_CACHE_HOME`, the files move; [docs/reference.md](docs/reference.md) has the mapping.

### Report a security problem privately

Do not open a public issue for a vulnerability. Open a private security advisory on the
repository instead, under the **Security** tab.

---

## 7. Where documentation lives

| File | Holds |
|---|---|
| [README.md](README.md) | the short front door |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | staged setup for a new install |
| [docs/architecture.md](docs/architecture.md) | what the code does, and where |
| [docs/reference.md](docs/reference.md) | every option, endpoint and caveat |
| [docs/project-goals.md](docs/project-goals.md) | what this project is, and is not |
| [docs/project-philosophy.md](docs/project-philosophy.md) | the convictions that settle a question |
| [docs/backlog.md](docs/backlog.md) | open work, stated as unmet properties |
| [HANDOFF.md](HANDOFF.md) | current state and the immediate next step |
| [CLAUDE.md](CLAUDE.md) | the full source map and the reason behind each rule |
| [docs/history/](docs/history/) | dated records. Evidence, not instructions. |

`CLAUDE.md` is large and is written for an AI coding assistant. Read
[docs/architecture.md](docs/architecture.md) first, then open `CLAUDE.md` for the one module you
are changing.
