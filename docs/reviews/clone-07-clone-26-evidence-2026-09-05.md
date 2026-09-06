# CLONE-07 and CLONE-26 — the two owner-gated items, with their evidence

2026-09-05. Written for the owner during the Phase 1a lap, at their request.

The 2026-09-05 adversarial verification marked two catalog items as needing a ruling before
anything is specified, let alone changed:

- **CLONE-07** — REFINE, *"omitted `malformedProvenance` predicate divergence — inject policy,
  owner decision required."*
- **CLONE-26** — REFINE, gated, *"guard match confirmed but catch policy diverges (`return []` vs
  `continue`, 2v1 abort) — do not spec until decided."*

`item-p1-03-front-walk-candidate-runner.md` puts CLONE-07 explicitly out of its own scope for the
same reason. This document is the evidence, not a proposal to act.

---

## CLONE-07 — the `malformedProvenance` predicate

### The two expressions, verbatim

`src/routes/messages.ts` — both sites, the hedge offer and the post-header commit probe:

```ts
malformedProvenance: target.kind === "openai" ? "local" : "upstream",
```

`src/routes/openai-front.ts` — both sites:

```ts
malformedProvenance: target.kind === "openai" && ctx.protocol === "chat" ? "upstream" : "local",
```

Four call sites, two spellings. There is no third spelling.

### What the value decides

`provenance` on a stream-commit verdict decides who owns a malformed stream. `upstream` means the
provider produced it, so the outcome is RETRIABLE and the walk fails over to the next candidate.
`local` means the relay produced it, so the outcome is TERMINAL and the walk stops — the same line
`stream-commit.ts` draws for a relay-authored refusal, and the same line the hard cap draws when
`CLAUDE.md` says a cap "is config, not health".

### They do not conflict. They are one rule, spelled per front.

The rule is **did the relay AUTHOR these bytes?**

- The relay translated the response, so the wire shape is the relay's own work ⇒ `local`.
- The response is a byte-exact passthrough ⇒ `upstream`.

Each front then states its own passthrough condition, and the conditions genuinely differ:

| Front | Passthrough happens when | So the predicate reads |
|---|---|---|
| Anthropic `/v1/messages` | the target is `anthropic`-kind | `openai`-kind ⇒ translated ⇒ `local` |
| OpenAI Chat / Responses | the target is `openai`-kind **and** the protocol is `chat` | anything else ⇒ translated ⇒ `local` |

That asymmetry is already recorded twice in `CLAUDE.md`: the `backend.ts` row, and the mistral
`compat` gotcha, which states it in as many words — *"the OpenAI front's direct Chat passthrough
(openai-kind + Chat) is left alone… Every OTHER front combination runs through `fetchBackend`."*

### Truth table over every reachable combination

| target kind | front | protocol | value today | did the relay translate? |
|---|---|---|---|---|
| `anthropic` | anthropic | — | `upstream` | no — passthrough |
| `openai` | anthropic | — | `local` | yes |
| `openai` | openai | `chat` | `upstream` | no — passthrough |
| `openai` | openai | `responses` | `local` | yes |
| `anthropic` | openai | `chat` | `local` | yes |
| `anthropic` | openai | `responses` | `local` | yes |

Every row agrees with the rule. **No behaviour is in dispute.** The only question is whether one
rule stated once is better than one rule spelled twice.

### Options

| | Option | What it costs | What it buys |
|---|---|---|---|
| **A** | One named predicate — for example `relayAuthoredResponse(frontKind, targetKind, protocol)` — called at all four sites. | One new exported function, plus a truth-table test. Behaviour identical, so the change is provable by the table above. | A fifth call site cannot invent a seventh row. Today a new front, or a new protocol, has two places to get right and no compiler help. |
| **B** | Leave both expressions, add the rule as a comment at each of the four sites. | Four comments that can drift from four expressions. | No code moves at all. |
| **C** | Leave untouched and close CLONE-07 as benign. | The next reader re-derives the analysis in this document. | Nothing to review. |

**My recommendation is A**, and it is a small item: the rule is already proven total by the table,
and the risk the verification worried about — that the two predicates encode two different
POLICIES — turns out not to exist. If you prefer to hold the front pair untouched until P1-03
lands, C is honest and this document is the record.

---

## CLONE-26 — the dialect-parser catch policy

### A correction to the catalog's framing, first

Both the catalog and the verification describe this as an **abort** divergence, with a "2v1 abort"
count. That reading overstates it. `recoverToolCalls` CONCATENATES the four parsers:

```ts
const calls = [
  ...fromInvokeForm(text, schemas),
  ...fromDeepSeekForm(text),
  ...fromKimiTokenForm(text),
  ...fromTaggedJsonForms(text),
].filter((c) => c.name.length > 0);

if (calls.length === 0) return { status: "detected", dialect };
```

So a `return []` inside one parser discards only **that dialect's** contribution. The recovery
aborts only when every parser returns nothing, and then the caller fails clean to `detected`, which
is the documented behaviour: *"An unparseable envelope yields `detected`, and the caller fails clean
so failover reaches a host that parses."*

### There are three policies in this one file, not two

**Policy A — discard this dialect's whole contribution.** `src/tool-dialects.ts`,
`fromKimiTokenForm`:

```ts
const nameMatch = /^functions\.([A-Za-z0-9_.-]+):\d+$/.exec(idToken.trim());
if (!nameMatch) return [];
try {
  const parsed = JSON.parse(payload.trim()) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  calls.push({ name: nameMatch[1]!, input: parsed as Record<string, unknown> });
} catch {
  return [];
}
```

**Policy B — skip this match, keep the rest.** `fromInvokeForm` and `fromTaggedJsonForms`:

```ts
if (!name || bodyText === undefined) continue;
```
```ts
const c = fromJsonPayload(m[1]);
if (c) calls.push(c);
```

**Policy C — commit the call with degraded arguments.** `fromDeepSeekForm`:

```ts
let input: Record<string, unknown> = {};
try {
  const parsed = JSON.parse(payload.trim()) as unknown;
  if (typeof parsed === "object" && parsed !== null) input = parsed as Record<string, unknown>;
} catch { /* an unparseable body leaves `detected` to the caller */ return []; }
calls.push({ name: name.trim(), input });
```

### The concrete divergence, by payload

| The payload after `JSON.parse` | `fromDeepSeekForm` | `fromKimiTokenForm` |
|---|---|---|
| a JSON object — `{"path":"a.ts"}` | commit, arguments as parsed | commit, arguments as parsed |
| **throws** — `{oops` | discard this dialect | discard this dialect |
| **a scalar** — `42`, `"x"`, `true` | **commit with EMPTY arguments** | discard this dialect |
| **an array** — `[1,2]` | **commit, arguments ARE the array** | discard this dialect |
| a name token that does not match the expected shape | no equivalent check exists | discard this dialect |

The two shaded rows are the whole item. Everything else already agrees.

### What each choice actually does downstream

A committed call with wrong-shaped arguments is not silently served. It becomes a `tool_use` block,
the Ajv validator fails it against the tool's `input_schema`, and **repair engages**. A discarded
dialect leads to `detected`, the caller fails clean, and **failover** reaches a host that parses.

So the ruling is not "strict versus lenient". It is: *for a DeepSeek block whose arguments are not
an object, do you want the repair model, or do you want another provider?*

### Options

| | Option | Argument for | Argument against |
|---|---|---|---|
| **A** | Give DeepSeek Kimi's strictness: a non-object payload discards the dialect. | Matches the stated invariant — *"Parsing, not inference"*, and *"an unparseable envelope yields `detected`"*. An array read as an argument object is the relay deciding what the model meant. | One malformed block discards well-formed DeepSeek calls found earlier in the same message. |
| **B** | Give Kimi DeepSeek's leniency. | The repair model exists precisely to fix malformed arguments, and a recovered call carries more information than no call. | It commits a call the relay knows is wrong, and an array cast to `Record<string, unknown>` is a lie to the type system. Reverses the fail-clean rule. |
| **C** | Adopt Policy B everywhere: skip the bad match, keep the good ones. | Strictly the most information preserved, and it already governs two of the four parsers. | It is a real behaviour change on both dialects, and a partial recovery of a multi-call turn changes what the model asked for — the same reasoning under which a destructive refusal refuses WHOLE rather than partially. |
| **D** | Leave all three policies, and document them where they are. | Zero risk. Each was presumably written against a real observed payload. | Three policies in one file, none stating why, is how the next reader unifies them by accident. |

**My recommendation is A, narrowed**: make the non-object and array cases discard, exactly as Kimi
does, and leave the `continue` parsers alone. It brings the one outlier into line with the file's
own stated rule and needs no new vocabulary. I do not recommend C — a partial recovery is the
shape this repository already refused once, for the destructive filter.

⚠ Whatever you choose, it is a **behaviour change on the wire** and belongs in its own commit with
its own pinning test, not folded into a duplication cleanup. That is why the verification gated it,
and the gate was right.

---

---

## Owner verdicts, 2026-09-05

**CLONE-26 — option A.** Give `fromDeepSeekForm` the strictness `fromKimiTokenForm` already has: a
payload that parses to a scalar, or to an array, discards that dialect's contribution instead of
committing a call. The turn then fails clean to `detected` and failover reaches a host that parses.

⚠ This is a behaviour change on the wire and belongs in **its own commit with its own pinning
test**, not folded into a duplication cleanup. Two cases to pin, and one negative control: a scalar
payload yields no DeepSeek call; an array payload yields no DeepSeek call; a well-formed object
payload is unaffected. Mutation-check it — restoring the lenient branch must turn the new test red.
The accepted cost, stated so it is not rediscovered as a bug: one malformed block now discards
well-formed DeepSeek calls found EARLIER in the same message, which is the same whole-or-nothing
rule the destructive filter already follows.

**CLONE-07 — no behaviour decision needed**, as the analysis above shows. Whether to name the
predicate once (option A) stays open and is ordinary refactor work, not a ruling.

## What this document does not do

It specifies nothing and changes no code. Neither item was touched by the Phase 1a lap. Both remain
tracked in [`../backlog.md`](../backlog.md), CLONE-26 now carrying its verdict.
