# Contributing to llm-relay

Start with [docs/architecture.md](docs/architecture.md) for the code map,
[docs/QUICKSTART.md](docs/QUICKSTART.md) for setup, or
[docs/reference.md](docs/reference.md) for commands and configuration.

## 1. Set up

Use **Node.js 22 or later**, npm, and Git for the checkout.

```bash
git clone https://github.com/OhOkThisIsFine/llm-relay.git
cd llm-relay
npm ci --ignore-scripts
npm run build
```

Run from source with an existing configuration:

```bash
npm run dev -- --config config.json
```

The default listener is `127.0.0.1:8791`. Configuration may select another valid port and one of
`127.0.0.1`, `localhost` or `::1`; other hosts are rejected.

## 2. The gate

Run the complete gate before opening a pull request:

```bash
npm run gate
```

This is `npm run build && npm run check`. Building first matters because package checks consume
`dist/`. The check phase runs:

| Command | Coverage |
|---|---|
| `npm run typecheck` | Source types. |
| `npm run typecheck:test` | Test types; vitest alone does not type-check tests. |
| `npm test` | Core test suite. |
| `npm run check:dashboard` | Dashboard types and tests. |
| `npm run check:package` | Bundle inventory and packed-package smoke test. |

CI runs the full gate on Ubuntu and separately checks that the postinstall hook is inert on a
non-global install. The `windows-process-boundary` job type-checks tests and exercises Windows
spawning, command shims, process lifecycle, broker recovery and concurrent persistence.

For a focused run:

```bash
npx vitest run test/repair.test.ts
npx vitest run -t "refuses to reshape a destructive"
```

`npm run analysis:run` is advisory and outside the gate. Review its findings against the project's
invariants; `eslint.config.mjs` explains intentionally disabled rules.

## 3. Rules a change must not break

[CLAUDE.md](CLAUDE.md) contains the detailed invariants and rationale.

1. **Repair protocol form, not judgment.** Correct malformed arguments without inventing intent.
   Routing uses configuration and deterministic classification, not a model's opinion.
2. **Preserve provenance.** Unknown is not zero. Keep measured, declared and estimated values
   distinguishable; never invent provider limits, prices or context ceilings.
3. **Health demotes, never drops.** Retain unhealthy candidates for failover and recovery.
4. **Never fabricate destructive tool calls.** Unrepairable calls fail cleanly.
5. **Loopback is not authorization.** Admission checks `Host` and any supplied `Origin` against
   the listener. Mutating requests require JSON. Protected control routes additionally require
   the per-install control token; data-plane requests do not use that token as client authentication.
6. **Log metadata only.** Never log request or response bodies, headers, or URL parameter values.
7. **Apply shared policy to both fronts.** Cover Anthropic Messages and OpenAI Chat/Responses.
   A rule enforced on only one front is incomplete.

## 4. Writing a test

- Use at least two candidates to prove failover; a single-candidate failure cannot demonstrate it.
- Give hand-built configs the required `repair` fields and each provider its `kind`. An omitted
  kind can exercise a different wire path than intended.
- Inject capability data instead of pinning a real model's pool band; synced rankings change.
- Reset process-global stores between tests so one test's facts or cooldowns cannot affect another.

Tests must not contact real providers or use the operator's credentials and state. Preserve the
existing guards, use temporary state and inject test seams where needed.

When a regression fails, verify the mechanism before weakening its assertion or raising its
timeout. A test can pin a defect rather than the intended property; update it with the source fix
only after establishing that distinction.

## 5. Commit and open a pull request

Branch from `main`, keep changes focused, and separate behavior changes from refactoring. Pin new
behavior with a regression and run `npm run gate` on the final tree. Process, spawning or
persistence changes also need the Windows boundary checks.

Write a commit message explaining what changed and why. For model-authored changes, include a
trailer naming the model and an appropriate attribution address:

```text
Co-Authored-By: <model name> <attribution email>
```

In the pull request, report checks actually run and their results. State which HTTP fronts were
covered when relevant, and distinguish local results from CI. Do not claim full coverage from a
focused test run.

## 6. Testing the relay and reporting a problem

### Collect the diagnosis

Useful diagnostics:

```bash
llm-relay version
llm-relay keys
llm-relay pools --probe
llm-relay candidates
llm-relay cost
```

`pools --probe` makes real model requests. The other outputs and relay diagnostic headers expose
metadata, which can still contain deployment names or other details you may wish to redact.

| Header | Meaning |
|---|---|
| `x-llm-relay-served-by` | Deployment that answered, or the attempted list. |
| `x-llm-relay-pool-attempts` | Candidate attempts and failures. |
| `x-llm-relay-degraded` | Response from below the requested capability band. |
| `x-llm-relay-quota-demoted` | Quota-based demotion. |
| `x-llm-relay-unknown-refusal` | Refusals without an accepted interpretation. |

Set `log.file` to capture the relay's metadata-only request log.

### Redact before you send

Never attach `.env`, `keystore.json` or `control-token`: they hold plaintext keys, encrypted
credentials or a control capability. Inspect `config.json` too; environment references are not
secrets, but literal credentials are. Replace literal values with `REDACTED`.

Inspect all attachments for secrets and account details. Key prefixes such as `sk-`, `nvapi-`,
`gsk_`, `hf_` and `AIza` are useful search hints, not an exhaustive detection method. Provider
error bodies may contain account or organization information even when relay logs do not.

The legacy state directory is `~/.llm-relay/`. XDG variables change preferred config/cache paths,
not existing files: when the preferred artifact is absent and a legacy copy exists, that legacy
path remains in use. Nothing is migrated automatically. An explicit config path also determines
its control-token directory. See [docs/reference.md](docs/reference.md) for the full mapping.

### Report a security problem privately

Do not publish credentials or vulnerabilities in an issue. Use the repository's private security
advisory flow under the **Security** tab.

## 7. Where documentation lives

| File | Purpose |
|---|---|
| [README.md](README.md) | Short project introduction. |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | Staged setup. |
| [docs/architecture.md](docs/architecture.md) | Code map. |
| [docs/reference.md](docs/reference.md) | Commands, configuration, APIs and caveats. |
| [docs/project-goals.md](docs/project-goals.md), [docs/project-philosophy.md](docs/project-philosophy.md) | Scope and design principles. |
| [docs/backlog.md](docs/backlog.md) | Unmet properties only. |
| [HANDOFF.md](HANDOFF.md) | Current state and the immediate next step. |
| [CLAUDE.md](CLAUDE.md) | Detailed agent guidance and invariants. |
| [docs/history/](docs/history/) | Dated designs, audits and measurements. |

Keep live guidance current when behavior changes. Put dated evidence in `docs/history/` rather
than appending a release diary to the live guides. Comments should explain contracts, boundaries
and non-obvious reasons, not repeat the implementation or narrate prior cleanup sessions.
