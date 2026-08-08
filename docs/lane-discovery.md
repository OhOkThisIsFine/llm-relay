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

## Discovery per lane

⚠ **An earlier revision of this doc claimed Codex had no list command and that discovery would cost
one real API call per model.** That was wrong — it was read off `codex --help`'s subcommand list,
which does not mention it. `codex debug models` ("Render the raw model catalog as JSON") exists, is
free and offline. Both lanes are cheap to probe; the asymmetry that remains is about *arguments*,
and it runs the opposite way from what was written.

| Lane | Model list | Per-model argument support | Cost |
|---|---|---|---|
| Codex | `codex debug models` → JSON | **stated**: `supported_reasoning_levels` per model, plus `default_reasoning_level`, `visibility`, `supported_in_api`, `priority` | free, offline |
| AGY | `agy models` → `id<TAB>label`, nothing else (`--output-format` is not a flag it accepts) | **not stated** — `--effort is not supported for model X` is only observable by sending it | free, offline |

So model-id validation is fully solvable for both lanes from a cheap offline command, and can be
refreshed freely on any schedule. Argument validation splits:

- **Codex: read from the catalog.** `supported_reasoning_levels` is authoritative and per-model, so
  `model_reasoning_effort=<x>` can be validated before rendering — no probing, no failed call.
- **AGY: learn from rejection.** Its roster states nothing about flags. The signal has to come from
  an observed failure, which fits the existing "the relay never invents the signal" contract and the
  `POST /dispatch {"exhausted"}` reporting path — but it means the first bad invocation still fails
  once. Probing the flag×model cross-product is the alternative and is worse: it spends real calls
  to discover something the vendor could simply publish.

Verified 2026-08-08, and this is what the corrected ladder rests on:

```
gpt-5.6-sol          list  api=true   pri=1   low,medium,high,xhigh,max,ultra  default=low
gpt-5.6-terra        list  api=true   pri=2   low,medium,high,xhigh,max,ultra  default=medium
gpt-5.6-luna         list  api=true   pri=3   low,medium,high,xhigh,max        default=medium
gpt-5.3-codex-spark  list  api=false  pri=26  low,medium,high,xhigh            default=high
```

Two things fall out of it:

- **Every effort level the ladder emits is supported** by the model it is emitted for, so there was
  no second latent bug of the `--effort` kind on the Codex side.
- **Spark is not unassessed after all.** The capability snapshot has no row for it, but Codex's own
  catalogue ranks it `priority: 26` — below `gpt-5.4-mini` (23) and far below Luna (3). That is
  first-party vendor ordering, so its placement last among the Codex rungs is now positively
  supported rather than merely "no evidence either way". ⚠ It also carries `supported_in_api: false`
  while an actual `codex exec` run against it succeeds, so that flag evidently means something
  narrower than "unusable here" — do not evict on it.

## Open questions for the build

1. Does a removed rung disappear entirely from `GET /dispatch`, or remain visible as `evicted` with
   its reason? Visible-with-reason matches how a blocked `unreachable` rung already explains itself
   on an explicit `?lane=`, and "it silently vanished" is its own debugging problem.
2. Manifest TTL. Both rosters are cheap, so a short TTL is affordable; the question is whether a
   *learned* AGY argument rejection should expire at all, or persist until contradicted (it is an
   existence fact about a flag, not a temporal one — arguing for persist).
3. Should `xhigh` tiers use Codex's `max` / `ultra`? Sol and Terra support both, Luna supports `max`.
   The ladder currently stops at `xhigh`, leaving headroom unused on the top tier.

## Interim state

The ladder's ids and arguments were corrected by hand on 2026-08-08 and verified against both tools:
Codex ids and their effort levels read from `codex debug models` (`gpt-5.6-spark` does not exist;
the model is `gpt-5.3-codex-spark`); AGY ids from `agy models`; `--effort` removed from every AGY
rung. That is a point-in-time fix with no mechanism behind it — it will rot exactly as the last one
did, which is what this document exists to prevent.
