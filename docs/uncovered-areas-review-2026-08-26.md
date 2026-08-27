# Uncovered-areas review — 2026-08-26

## What this is

[docs/complexity-review-2026-08-25.md](complexity-review-2026-08-25.md) §6 recorded two gaps in
its own coverage. This document closes both, and it records what the closure found.

1. **"Not covered at all."** The cross-cutting reviewer — assigned JSON-store persistence,
   auth-header construction, the vitest temp-dir guards, spec parsing, and fetch retry wrappers —
   failed before returning. That area was unexamined.
2. **"A class nobody proposed."** No reviewer proposed type-level simplifications: exhaustive
   switches over a closed union, or reshaping a type so an invalid state cannot be constructed.
   The review named it "likely the richest unexplored seam".

Both briefs were re-run on 2026-08-26 as read-only Codex lanes (GPT-5.6 Sol, effort ultra), each
told to verify every count against source and to check every proposal against the Invariants
section of `CLAUDE.md`. Raw lane output is in `analysis-reports/` (gitignored) and is **advisory**.
Only the findings below were checked first-hand against source by the orchestrating session; a
lane claim that is not in this document was either not checked or not confirmed.

The two lanes together produced 13 defect claims and 19 type-level findings. Six defects are
confirmed here. The rest stand as unverified lane material.

## The headline: quota demotion reads the wrong axis

**Severity: high. It changes routing decisions in shipped code.**

`src/quota-demotion.ts`, inside `resolveQuotaDemotion`, memoizes the local-ledger window read:

```ts
const windowCache = new Map<string, LocalUsedReading>();
const localUsedFor = (period, axis) => {
  let reading = windowCache.get(period);          // ← key: period ONLY
  if (reading === undefined) {
    const window = deps.accounting.usedInWindow({ ...period... });
    reading = window === null ? EMPTY_USED
      : { value: axis === "tokens" ? window.tokens : window.requests,   // ← already projected
          basis: window.basis };
    windowCache.set(period, reading);
  }
  return reading;
};
```

The stored value is already projected onto an axis, but the key carries no axis. The bucket loop
sorts by `bucketRank`, which ranks `requests` before `tokens` within a period
(`axis === "requests" ? 0 : 1`). So whenever one period carries **both** a requests bucket and a
tokens bucket, the tokens bucket reuses the **requests** count as its token usage.

Worked example — configured `{ rpm: 1000, tpm: 100 }`, ledger window
`{ requests: 1, tokens: 100, basis: "reported" }`:

| bucket | correct remaining | actual remaining | consequence |
|---|---|---|---|
| requests/minute | 1000 − 1 = 999 | 999 | correct |
| tokens/minute | 100 − 100 = **0** | 100 − 1 = **99** | **no demotion when the token allowance is spent** |

The mirror case over-demotes: a small request count against a large token window is harmless, but
a large request count against a small `tpm` demotes a deployment whose token allowance is intact.

**The same read has a second, independent defect.** `basis` is copied from `window.basis`, whose
declared meaning describes the **token** figure. A request count therefore wears token provenance.
A real window may return `{ requests: 2, tokens: null, basis: "mixed" }`, which renders an exact
request count as basis `mixed`; an `estimated` token basis can likewise be pinned onto a request
count. That is a guess wearing a measurement's label — the provenance invariant forbids it.

**The sibling module got it right, which is what makes this a defect rather than a design.**
`src/hard-cap.ts` memoizes the identical read as `${scope}:${period}:${axis}` and its comment
states why each key component is there. One of the two modules that ask the ledger the same
question keyed it correctly, and one did not.

Found by the type-level lane (its finding 1); confirmed first-hand against source before any
change was made.

## Confirmed defects

Each was checked first-hand against source. Severity is this session's judgement, not the lane's.

### D1 — quota demotion reads the wrong axis

Above. `src/quota-demotion.ts` `localUsedFor`. **High.**

### D2 — the OpenRouter quota probe sends a declared credential to an inferred origin

`src/ping/quota.ts:27-32`.

```ts
if (providerName.toLowerCase().includes("openrouter") || cfg.base.includes("openrouter.ai")) {
  const resp = await fetchFn("https://openrouter.ai/api/v1/auth/key", {
    headers: { Authorization: ... apiKey ... },
  });
```

The provider is identified by **substring match** on either its configured name or its base, and
the credential is then sent to a **hardcoded** origin that is not the configured one. Two ways in:
a provider named `openrouter-proxy` (or any name containing the substring) pointing at a different
host, and a base such as `https://openrouter.ai.example.test`, which `includes("openrouter.ai")`
accepts.

This is the credential-containment invariant read backwards. `buildForwardHeaders()` decides
containment from the config **declaration**, never from key presence — and here a provider's
declared credential leaves for an origin the declaration never named. It is also the
"Provider knowledge is data, not routing configuration" rule: a labelled provider fact in `src` is
allowed only where config can override it, and nothing here can.

**Severity: high.** It requires an operator-authored provider entry to trigger, so it is not
remotely reachable — but the whole point of declared containment is that an operator's config
cannot silently ship one provider's key to another's endpoint. **Medium-high.**

### D3 — `pool-health` overclaims both model absence and credential failure

`src/pool-health.ts:102-110`.

```ts
if (r.status === 401 || r.status === 403) return { ... verdict: "auth", ... };
if (r.status === 404 || r.status === 400) return { ... verdict: "missing",
                                                   detail: `HTTP ${r.status} — model not servable` };
```

The probe posts a completion for **one specific model**. So a 401/403 here is exactly the
entitlement-wall case `CLAUDE.md` names: "Free-tier rosters list premium models; a 401/403 on one
of them says nothing about the credential." `llm-relay pools --probe` then advises the operator on
that verdict, which is the false-bad-key harm the invariant exists to prevent.

The 400 half is the wider overclaim. A 400 is a request-validation error — mistral's 9-character
tool-call-id refusal is a 400, and so is any `max_tokens` complaint — and it is rendered as
"model not servable". The file already distinguishes carefully one branch away: it probes at 400
`max_tokens` precisely because "reasoning models return an empty 200 at a low cap", and it keeps
`empty` as a verdict distinct from `missing`. The care is present; it stops short of this branch.

**Severity: medium-high.** Operator-facing advice only — this verdict does not itself remove a
routing rung, so "health demotes, never drops" is not charged here.

### D4 — the authenticated key probe calls every 5xx a verified key

`src/key-checker.ts:161-163`.

```ts
if (r.status !== 401 && r.status !== 403) {
  // 2xx, or a 400/404 rejecting the request on its contents — either way it got past auth.
  return { status: "valid", httpStatus: r.status, message: "Key verified (authenticated probe)" };
}
```

The comment names 2xx, 400 and 404. The condition admits **everything** that is not 401/403/429 —
500, 502, 503, 504 included. A gateway error proves nothing about a credential, and reporting
"Key verified" from one is a guess labelled a measurement.

Note the direction. `unverified` already exists in this file for exactly this purpose, and the
adjacent `probeAuthenticated` 401/403 branch runs a careful anonymous differential rather than
concluding. The evidence discipline is present in the module and absent from this one condition.

**Severity: medium.** It produces a false PASS, which is quieter than a false failure but sends the
operator away from a real problem.

### D5 — six default artifact paths are not redirected under vitest

`CLAUDE.md` states, as an invariant: "Under vitest every default path redirects to a temp dir."
That is false today for at least these:

| artifact | default | vitest guard |
|---|---|---|
| `.env` | `src/dotenv.ts` `defaultEnvPath()` | **none** |
| `models-cache.json` | `src/catalog.ts` `DEFAULT_CACHE` | **none** |
| `update-check.json` | `src/self-update.ts` `cacheFile()` | **none** |
| relay config dir (`control-token`) | `src/control-authorization.ts` `defaultRelayConfigDir()` | partial, at one call site |
| hook script | `src/claude-hook.ts` | **none** |
| `config.json` | `src/cli.ts` | **none** |

The compliant ones — accounting, lane manifest, keystore, probe cache, runtime telemetry, refusal
interpretations, target facts — show the intended shape. `src/ping/probe-cache.ts` carries the
comment that explains why the rule exists at all: the suite was found writing `openai_mock`
entries into the developer's live health data, "test fixtures polluting live health data that the
router then ranks on".

The `.env` row is the sharpest. `loadEnvFile(defaultEnvPath())` **reads** the developer's real file
into `process.env`; on a machine that still keeps keys there, a test run imports live credentials
rather than merely overwriting a cache.

**Severity: medium.** It contradicts a stated invariant, which means either the code or the
statement is wrong; the probe-cache precedent says the code is.

### D6 — the catalog cap warning prints the configured base URL

`src/catalog.ts:552-554` writes the full `cfg.base` to `console.warn`. A configured base can carry
query values, and some providers put a key in one. The metadata-only rule covers URL *values*:
`logSafePath()` keeps a parameter's NAME and replaces its value with the value's length.

**Severity: low-medium**, and the fix is zero net lines — the provider identity and the two counts
say everything the warning needs to say. Recorded here because it is the cheapest of the six.

### D10 — an accepted refusal interpretation never reaches a running relay

`src/refusal-interpretation.ts:725`:

```ts
function load(path: string): InterpretationStore {
  if (_store && _path === path) return _store;   // no staleness check at all
```

The memo is a process global keyed on path alone. Compare `src/keystore.ts`, which memoizes "by
normalized path and the practical `mtimeMs` + `size` + `ino` stat token" so a changed file
invalidates immediately. This store has no such token.

The consequence follows the WRITER. For target facts the relay writes and the CLI reads; here it is
the other way round. `llm-relay eligibility accept` runs in a **CLI** process, writes the new
`confirmed` row and persists (`src/refusal-interpretation.ts:912-942`). The **relay** already holds
its own `_store` from its first load and never re-reads it, so the acceptance does not affect
routing until the relay restarts.

[docs/reference.md](reference.md) states the promise the code does not keep: "Only `accept` makes an
interpretation affect routing. That gate is deliberate…". It does not say "after a restart".

There is a second consequence on the same mechanism. The relay also WRITES this file — it queues
each newly-seen uninterpretable signature — and `persist(path)` serializes its whole snapshot. So a
relay write after a CLI acceptance can silently overwrite that acceptance with the stale snapshot.
A stat-keyed reload fixes visibility; the lost update needs a read-compare-merge before serialize.

**Severity: medium-high.** It is quiet, it defeats a documented operator workflow, and the
in-repo precedent for the fix already exists.

## Structural findings verified in-session

These were not produced by the two lanes. They came out of checking §5's deferred items and are
recorded here because each corrects a count in
[docs/complexity-review-2026-08-25.md](complexity-review-2026-08-25.md) §5.

### S1 — the quota bucket key is derived by hand in three places (§5 item 17, extended)

§5 item 17 read: "Make `mergeQuotaObservations` total so the private copy in `candidates` can go",
verdict PARTIAL — "the private copy is freshest-`observedAt`-wins, the exported helper is
last-set-wins; add a strategy variant, and switch the private key derivation to `bucketKey()`."

That verdict is correct, and it undercounts by one. The `${axis}:${period}` bucket key is derived
in **three** places, not two:

| site | function | key |
|---|---|---|
| `src/quota-observation.ts:176` | `bucketKey` (module-private) | `` `${axis}:${period}` `` |
| `src/candidates.ts:356` | `mergeCandidateQuota` | hand-written, identical |
| `src/availability.ts:80` | `collectQuotaBuckets` | hand-written, identical |

`collectQuotaBuckets` is the bucket builder that landed as §5 item 6's fix (`99eb472`) — so the
commit that gave quota-bucket **gathering** one home introduced a third copy of the **key** the
buckets are stored under.

Two facts bound the fix. The three key strings are byte-identical for the same inputs, so
exporting `bucketKey` and calling it at both other sites is behaviour-preserving. And
`test/availability.test.ts:70-75` asserts the literal key spellings
(`["requests:month", "requests:minute", "requests:day"]`), so the format is pinned and the
exported function must keep producing it.

The merge-strategy half stands as §5 recorded it: `mergeQuotaObservations` is last-set-wins and
copies (`{ ...observation }`); `mergeCandidateQuota` is freshest-`observedAt`-wins and does not
copy. They are different policies and must stay distinguishable — a strategy parameter, not a
silent merge.

Verified first-hand and independently corroborated by an AGY second lens (four questions, all
four answers matching source).

### S2 — §5 item 24's "six longhand copies" is two files, five walks

§5 item 24 named `src/accounting-store-schema.ts:659-701` as the primary site and claimed six
longhand copies of the seven-cell walk. Inside that file each of the seven cell names occurs
exactly four times — the type declaration, the `hasExactKeys` key list, and **two** walks
(`isAggregateTokens`, `isEmptyAggregateTokens`). The other three walks are in a different file:

| file | site | shape |
|---|---|---|
| `accounting-store-schema.ts` | `isAggregateTokens` | validator per cell |
| `accounting-store-schema.ts` | `isEmptyAggregateTokens` | emptiness per cell |
| `accounting-store.ts` | `emptyTokens()` | constructor per cell |
| `accounting-store.ts` | `addRawTokens` | add + `updateMethod` on the two estimated cells |
| `accounting-store.ts` | `addAggregateTokens` | add + `updateMethod` on the two estimated cells |

So the finding is real and **spans two files**, which the recorded primary site does not say. The
per-key association the §5 verdict required is wider than "which validator": three of the five
walks also treat the two `estimated*` cells differently from the five `reported*` ones, because
only the estimated cells carry `method`. A key table must therefore correlate each key with its
cell KIND, and the two kinds must stay distinct — the `method` rule the §5 verdict names.

## Advisory, not confirmed

The two lanes produced more than this document keeps. Everything below was reported by a lane and
**not** checked first-hand, so it carries no verdict here and must be verified before anyone acts
on it — the same treatment §5 itself asks for.

- **Cross-cutting lane, defects not confirmed here:** two unbounded provider fetches and a
  non-cancelling `Promise.race` budget (`pool-health.ts`, `ping/quota.ts`, `key-checker.ts`);
  shallow validation in two persisted evidence stores (`lane-manifest.ts`, `ping/probe-cache.ts`);
  refusal interpretations not coherent across processes, with a lost-update path; two debounced
  singleton stores that can write one path's state to another's; two spec-grammar mismatches in
  `config.ts`; catalog disk-cache sanitation admitting a non-finite `fetchedAt`; four best-effort
  atomic writers leaving temp files after an in-process failure; two TTL collections that expire
  rows logically but never prune them.
- **Cross-cutting lane, simplifications:** it proposed seven and rejected every generic
  consolidation it considered (one JSON loader, one auth-header builder, one bounded-array helper,
  one vitest helper, one timeout wrapper, one catch classifier), on the ground that each would
  "add code or conceal the invariants that differ between sites". That rejection is worth keeping
  even though the proposals it guards were not verified.
- **Type-level lane:** 19 findings over 35 closed-union contracts and 63 stale consumers. Only
  its finding 1 is confirmed above. Its next-ranked items — `AccountingSpend` admitting impossible
  basis/source/coverage combinations, `AccountingEvent`'s open dispatcher, the remaining-basis
  mapper defaulting a known provenance to null, `ContextWindowSource` labelling every future source
  provider-published — are unverified.

The raw reports are `analysis-reports/report-crosscutting.md` and
`analysis-reports/report-typelevel.md`. That directory is gitignored on purpose: a lane report is
a working artifact, and the durable conclusions belong here.

## Two more confirmed defects, found while pricing §5 item 22

§5 item 22 read "Define the served-response announcement set once, not once per front", with the
verdict PARTIAL. Pricing it produced a header-by-site matrix, and the matrix found **two
cross-front differences that no earlier pass recorded**. Both are the "two paths, one policy empty"
shape this repository already names as a defect class. Both were confirmed first-hand.

The two served-response announcement assemblers are the OpenAI front's inline block
(`src/server.ts:3808-3836`) and the Anthropic front's `responseHeadersForTarget`
(`src/server.ts:3976-3991`). `walkExitHeaders`, `respondAllCapped` and `recordFinalWalk` are
separate response classes and are correctly not part of this set.

### D8 — the Anthropic front omits `x-llm-relay-served-by` on a terminal HTTP error

`responseHeadersForTarget` writes it only `if (backendRes.status < 400)`
(`src/server.ts:3978`). The OpenAI front writes it for every status —
`upstream.status >= 400 ? tried.join(", ") : specOfTarget(target)` (`src/server.ts:3810-3811`).

The header's own declaration says the opposite of the Anthropic behaviour
(`src/backend.ts:72-80`): "When every candidate fails it carries the list that was tried instead,
so an exhausted pool is self-describing." So does the user-facing reference
([docs/reference.md](reference.md), the "Health demotes" paragraph): "Responses carry
`x-llm-relay-served-by`: the deployment that served, **or on error every deployment tried, in
order**."

So documented behaviour is delivered by one front and not the other. This is **distinct from** the
transport-exit omission that finding 2 already recorded as deliberate
(`src/server.ts:1474-1480`) — that one is a transport exhaustion with no HTTP response to describe;
this one is an ordinary served upstream error.

### D9 — the OpenAI front drops `x-llm-relay-unknown-refusal` when a later candidate succeeds

`unknownCount()` returns positive-or-null, never zero (`src/server.ts:2614-2617`), so a truthy test
is exact. The Anthropic front sets `poolUnknownRefusals: pool429.unknownCount()` unconditionally on
its response context (`src/server.ts:1662`) and emits the header whenever it is present
(`src/server.ts:3984`) — success included. The OpenAI front computes and writes the count **only
inside its `status >= 400` branch** (`src/server.ts:3833-3836`).

That defeats the header's stated purpose on that front. Its declaration
(`src/backend.ts:98-112`) calls it "the push half": "the caller … finds out at the moment it
matters that a NEW kind of refusal just appeared, and can run `llm-relay eligibility` while the
context is still in hand." A walk that met an uninterpretable refusal on one candidate and then
succeeded on another has exactly that news to deliver, and one front swallows it.

### Item 22's verdict, priced

A lane re-priced item 22 against HEAD: **IMPLEMENT-WITH-CONDITIONS, about −9 physical lines**. The
line saving is not the reason to do it — the two drifts above are. The condition is real: a naive
`responseHeadersForTarget(upstream, ctx)` call from the OpenAI front would supply no
`ctx.credentialHeaders` and the helper would silently skip the assignment (`src/server.ts:3988`),
losing `x-llm-relay-credential` and its attempt summary. The Anthropic front prepares that field
with the per-attempt argument `credentialTrace.headers(resolvedAttempt)` (`src/server.ts:1666-1668`),
which resolves the still-pending entry matching that exact `credentialId` (`src/server.ts:2025-2037`).
A shared helper therefore needs a small required context, not the whole Anthropic `Ctx`.

### Item 24's verdict, priced: REJECT

The same lane priced §5 item 24 (one key table for the seven token cells) and **rejects** it: the
schema file holds three runtime traversals, not the six claimed, and once the per-key validator
correlation and the derived exact-key arrays are made type-safe the target **grows** — measured at
about **+5 physical lines**, before the exhaustiveness guard a correct design would also need.
That supersedes the "~-20" in §5 and the "five walks across two files" framing in S2 above: the
five walks are real, but three of them (`emptyTokens`, `addRawTokens`, `addAggregateTokens` in
`src/accounting-store.ts`) carry different responsibilities — construction, raw addition with
`updateMethod`, aggregate addition with `updateMethod` — and are not candidates for one table.
**Do not implement item 24.**

## What landed

Seven packets, `2920365`..`8192b43`. Every packet was gate-verified twice — once by the
implementer, once by the orchestrating session on a clean tree — and every new test was confirmed
to FAIL against the pre-fix tree before its commit.

| commit | defect | implemented by |
|---|---|---|
| `2920365` | D1 — quota demotion read the requests count as the token usage | Codex (GPT-5.6 Sol, ultra) |
| `330f475` | D2 + D6 — credential to an inferred origin; base URL in a log | relay free-pool `pool/high` |
| `b7d2311` | D3 + D4 — probe verdicts claiming more than their evidence | relay free-pool `pool/high` |
| `5bbe788` | D8 + D9 — the two cross-front announcement drifts | main session |
| `6f8608b` | D7 + S1 — four drift seams in the availability vocabulary | relay free-pool `pool/medium` |
| `b34e731` | D5 — the vitest redirect invariant, made true and pinned | relay free-pool `pool/medium` |
| `8192b43` | D10 — an accepted interpretation reaching a running relay | relay free-pool `pool/medium` |

**Every packet needed correction in review, and each correction is in its own commit message.** The
recurring ones are worth naming, because they are what a reviewer should look for next time:
a lane's new code introducing the SAME seam the packet was closing (`mapLocalUsedBasis` shipped
with the open `default: return null` that packet 5 then had to fix; `persist` grew a second copy
of the store parser); a widened type quietly losing a guarantee (`ResetsAtResolution["basis"]`
imported WITH its null); an in-place mutation of a shared record; a test asserting
`expect(true).toBe(true)`; and `/`-separated regexes that can never match on Windows.

### Lane notes

- **A relay free-pool lane is a working WRITE lane for in-repo packets.** Five of the seven were
  implemented on one, with reports as good as Codex's. That was previously recorded as unproven.
- **Codex quota is MODEL-scoped.** `gpt-5.6-sol` hit a limit with a five-day reset while
  `gpt-5.3-codex-spark` still answered; Spark then hit its own. Probe the sibling model before
  declaring the lane dead.
- **Codex Spark ran out of CONTEXT** on the `server.ts` packet and left a half-done, mis-indented
  tree — discarded, and every later brief carries a context-discipline block.
- **D8/D9 was implemented in the main session, not delegated**, because both Codex lanes were spent
  and three free-pool attempts failed for lane reasons. Its independent review is the weakest of
  the seven: a compact free-pool pass returned a bare MERGE with no evidence. The real checks there
  are the two pre-fix failures and an AGY structural pass over the diff.

### Not fixed, and why

- **§5 item 24 — REJECT.** Priced at about +5 lines, not the claimed −20. See above.
- **§5 items 9, 11, 12, 13, 19-remainder, 23** — unchanged from the 2026-08-25 verdicts.
- **The `key-checker` initial-probe 401/403 → `invalid_key` branch** was left. That probe is a
  `/models` GET, not model-specific, so a 401/403 there is not the entitlement-wall case the
  invariant names. Recorded rather than changed.
- **An anthropic-kind provider WITH a key can now only report `unverified`** from
  `llm-relay keys check`: its initial probe is a GET returning 405, and the authenticated
  escalation is gated on a `/models` URL. Honest but unhelpful. No impact here — the only
  anthropic-kind provider is the keyless passthrough — so it is recorded, not fixed.
- **The pre-existing mis-indentation in `src/key-checker.ts`** (a `checkOne` body and the final
  `else` at column 0) predates this sprint; confirmed against HEAD before the packet. A
  whitespace-only reformat would have obscured the real diff, so it stands.
- **The 13 cross-cutting and 19 type-level lane findings not listed above remain advisory** and
  unverified. Do not treat them as a work queue.

## Friction hit during this sprint

Rewalked from the transcript, not from recall. Host-level items also live in agent memory.


1. **The relay has no autostart entry and went down mid-sprint.** `Startup/` holds `Ollama.lnk`,
   `freellmapi.vbs` and `headroom.vbs` — no `llm-relay.vbs`. The relay was up at session start and
   was gone by the time packet 2 retried; `llm-relay dispatch -x` reported "no proxy running", and
   every free-pool lane fails with it down. Restart used:
   `node C:/Users/ethan/AppData/Roaming/npm/node_modules/llm-relay/dist/cli.js`.
2. **A relay restart loses in-memory breaker state, so the first heavy walk burns the dead
   members.** Immediately after the restart, two packet-2 dispatches died on paid-gated 402s
   (Kilo, then ollama-cloud) that exhausted the whole walk. Three cheap `Reply with exactly: OK`
   probes across pool/high, xhigh and medium then all returned OK, and the next real dispatch
   proceeded. Mitigation: warm the pool with one trivial probe after any relay restart, before
   spending a long packet on it.
3. **`git diff` shows nothing when a Codex lane leaves its work STAGED.** The first adversarial
   review lane was dispatched with a brief telling it to run `git diff`, saw an empty diff, and had
   to be stopped and re-dispatched with `git diff HEAD`. Any brief that inspects a lane's output
   must say `git diff HEAD`.
4. **Codex quota is MODEL-scoped, not account-scoped.** `gpt-5.6-sol` hit its limit with a stated
   reset five days out while `gpt-5.3-codex-spark` still answered. Probing the sibling model before
   declaring the lane dead was worth doing. Spark then hit its own limit a few hours later.
5. **Codex Spark ran out of CONTEXT on a server.ts packet** and left a half-done, mis-indented tree
   with no tests and no gate run — discarded with `git checkout --`. The brief had not forbidden
   reading whole files. Every later brief carries a CONTEXT DISCIPLINE block (never read a large
   file whole; grep then `sed -n`; stop and revert rather than leave a half-done tree).
6. **A relay free-pool `pool/high` lane is a working WRITE lane for in-repo packets.** Memory said
   this was unproven. It implemented packet 3 end to end — two source files, a new test file, the
   pre-fix-failure confirmation, and a green gate — with a report as good as Codex's. Record it.
7. **`--model pool/high` makes Claude Code log `[claude-code:unrecognized_model]` for its session
   title generation** on every lane launch. Cosmetic, appears on stderr, harmless — but it is the
   first line of every lane log and reads like a failure.
8. **The lane review verdict must be judged, not taken.** The Codex adversarial review returned
   MERGE-WITH-FIXES over a "wire break" that is bounded: `index.html` is served `no-store` and the
   hashed assets are immutable, and this project had already documented the same additive
   vocabulary growth on 2026-08-22. Its two NITs were both real and were fixed.

9. **A slow-failing first candidate spends the whole walk budget, and the walk then gets exactly
   one more try.** Measured from `~/.llm-relay/relay-restart.log` during this sprint: healthy
   requests were served 200 by `nim/deepseek-ai/deepseek-v4-flash-0731`, but whenever that member
   answered **504** the walk showed only TWO attempts and surfaced the second one's error to the
   client — `402 <- nim:504 | ollama-cloud/kimi-k2.6:402`, `404 <- nim:504 | nim/kimi-k2.6:404`.
   One unaffected walk in the same log ran **60+** candidates, so the pool is deep.
   ⚠ **This is `DEFAULT_WALK_BUDGET_MS` (45 s) working exactly as documented**, not a defect: the
   budget bounds STARTING further attempts, and "the first TWO attempts are always allowed, so a
   slow-failing first candidate cannot starve the request of its one retry". A 504 that takes ~45 s
   consumes the budget, and the guaranteed second attempt is all that remains.
   Operationally this made free-pool lane dispatch fail intermittently for ~an hour. The lever, if
   the owner wants one, is that nim member's health rather than the budget — it is both the
   most-served member and the one producing the 504s, so the breaker's stability score stays mixed
   and it keeps being ranked first. Verified before concluding; recorded here so the next session
   does not re-diagnose it as a failover bug.

10. **A free-pool lane can return a two-word answer and exit 0.** One packet-6 dispatch replied
    "Let's look" and stopped, leaving a clean tree. Treat a short reply as a lane failure and
    retry, rather than reading it as "nothing to do".
