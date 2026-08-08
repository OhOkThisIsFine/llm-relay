# Lane discovery — validating `cli` rung model ids and arguments

**Status: designed, not built.** Written 2026-08-08 after a live failure.

## The failure

The dispatch ladder handed an agent
`agy -p "<task>" --model claude-opus-5 --effort medium`, in which **both halves were independently
wrong**:

- `claude-opus-5` is not an AGY model. Its roster is `claude-opus-4-6-thinking`,
  `claude-sonnet-4-6`, `gemini-3.{6,5}-flash-{high,medium,low}`, `gemini-3.1-pro-{high,low}`,
  `gpt-oss-120b-medium`.
- `--effort` is **rejected outright** for AGY's Claude models
  (`--effort is not supported for model "claude-opus-4-6-thinking"`), and redundant for its Gemini
  models, which carry the effort in the model id.

Both were hand-typed into `~/.llm-relay/config.json` and had never been checked against the tool.
Nothing in the relay could catch it: a `cli` rung is opaque config, rendered verbatim into a command
the host runs. The lane looked healthy and completed nothing — the same shape as the
`--permission-mode plan` incident in [offload-agentic-capability.md](offload-agentic-capability.md).

## The rule

A model the vendor does not serve is **`not-servable`** — an existence fact, not a temporal one.
This repo already draws that line in `target-facts.ts`: `allowance-exhausted` and `rate-limited`
**demote**, while `subscription-required` and `not-servable` **remove**. Health demotes because a
sick backend may recover; a nonexistent model will not start existing, and demoting it only means
failing later instead of now.

So:

- A rung whose model is **known absent** from its lane's manifest is **removed from the ladder**.
- An argument the manifest records as **unsupported for that model** is **stripped from the rendered
  invocation** — `--effort` would never have been emitted for `claude-opus-4-6-thinking`.

⚠ **Eviction requires POSITIVE evidence.** "The manifest lists this lane's models and this one is not
among them" evicts. "No manifest, or this lane was never probed" is *unknown* and changes nothing —
the same fail-safe as a signature miss in `refusal-interpretation.ts`, and the same reasoning that
makes an unset `${ENV}` disable one provider rather than abort startup. A stale or missing manifest
must never be able to empty the ladder; this proxy fronts every session, so that would convert a
config-hygiene feature into a total outage.

## Where it lives

`llm-relay lanes --probe`, an **operator command**, parallel to the existing `llm-relay pools
--probe`. It writes `~/.llm-relay/lane-manifest.json`; config load and `/dispatch` then read the
**cache** and never spawn anything.

⚠ This is the one place the "**the relay never spawns a `cli` rung**" invariant is approached, so
state the boundary explicitly: that invariant is about the **request path** — a `cli` lane's quota is
client-bound, it runs its own tool loop, and it returns only final text, so a relay that shelled out
mid-request could never return the `tool_use` blocks an HTTP turn owes its caller. An operator
running a diagnostic is not the request path, exactly as `pools --probe` sends real completions that
the request path would never send. **Nothing on the request path may spawn a CLI.**

## Discovery is not uniform across lanes — the hard part

| Lane | Mechanism | Cost | Refresh |
|---|---|---|---|
| AGY | `agy models` — a real subcommand, lists id + label | ~1 cheap call | freely |
| Codex | **no list command.** Validity is only observable by *attempting* a model and reading `The '<id>' model is not supported when using Codex with a ChatGPT account.` | one real API call **per model** | sparingly |

This asymmetry is the main design constraint, and it is why a manifest is required rather than
probing on demand: Codex discovery **spends the quota the lane exists to conserve**. Consequences:

- The manifest must record **when** each lane was probed and by which mechanism, so a Codex entry is
  understood as a point-in-time attempt rather than a roster reading.
- Codex probing must be opt-in per run (`--lane codex`), never implied by a bare `lanes --probe`.
- Argument support is even harder: `--effort is not supported for model X` was discovered by
  *sending* it. There is no roster of valid flags for either tool, so argument facts can only be
  learned from a rejection — which argues for recording rejections observed in normal use rather
  than probing the cross-product of flags and models.

## Open questions for the build

1. Should argument facts be **learned from observed rejections** (the host reports a lane failure
   back, as `POST /dispatch {"exhausted"}` already does for availability) rather than probed? That
   fits the existing "the relay never invents the signal" contract and avoids a flag×model probe
   matrix — but it means the first invocation still fails once.
2. Does a removed rung disappear entirely from `GET /dispatch`, or remain visible as `evicted` with
   its reason? Visible-with-reason matches how a blocked `unreachable` rung already explains itself
   on an explicit `?lane=`, and "it silently vanished" is its own debugging problem.
3. Manifest TTL. A roster reading is cheap to refresh and can expire; a Codex attempt is expensive
   and should probably persist until contradicted.

## Interim state

The ladder's ids and arguments were corrected by hand on 2026-08-08 and verified against both tools:
all four Codex ids (`gpt-5.6-{sol,terra,luna}`, `gpt-5.3-codex-spark`) accepted by the account,
`gpt-5.6-spark` rejected; AGY ids taken from `agy models`; `--effort` removed from every AGY rung.
That is a point-in-time fix with no mechanism behind it — it will rot exactly as the last one did.
