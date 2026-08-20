# Pool failover — what a pool actually does with a failing candidate

Written against the symptoms measured from the audit-tools side on 2026-07-30, where a batch of
~105 small `/v1/chat/completions` requests at `pool/coding` completed 31 and could not be made to
finish. Every claim below was reproduced locally before it was fixed, and re-measured after.

## The short version

Two independent defects, both on the OpenAI front (`/v1/chat/completions`):

1. **It never failed over.** `handle()` resolved the full candidate list, then passed
   `healthyTargets[0]` — one target — to `openAiFrontPath` and returned. The failover loop lived
   further down, on the Anthropic path only. The front had no loop at all.
2. **It never told the circuit breaker anything.** It called `recordCall()` (runtime telemetry) and
   not `globalCircuitBreaker.recordOutcome()`. So a candidate that had just 429'd was not demoted
   for the *next* request either — its breaker read `lastStatus: null` after 122 observed calls.

Together those produce exactly the reported table: the same rate-limited candidate chosen every
time, its 429 returned to the client, and thirteen healthy members never touched.

The pinning tests are in [`test/pool-failover.test.ts`](../test/pool-failover.test.ts). Every one
of them needs **at least two candidates** — which is why this went unseen: every pre-existing test
of these paths used a single-candidate config, and with one candidate "fails over correctly" and
"cannot fail over at all" are the same observation.

## Per symptom

### §1 — a pool does not fail over

Fixed. `openAiFrontPath` now takes the candidate list and loops, and both paths classify outcomes
through the *same* `classifyStatus()` / `recordAttempt()` helpers in `server.ts` — the bug being
prevented is precisely the two of them holding different policies.

Measured after, against the real 14-member `pool/coding`, the report's own reproduction:

| before | after |
|---|---|
| 6 of 6 → 429, all from one candidate | 8 of 8 → 200 |

And with a deliberately dead first member (real providers, `benchmarkSort: false` so config order
holds):

```
1  HTTP=200 t=0.24s  x-llm-relay-served-by: groq/openai/gpt-oss-120b
2  HTTP=200 t=0.12s  x-llm-relay-served-by: groq/openai/gpt-oss-120b
3  HTTP=200 t=0.12s  x-llm-relay-served-by: groq/openai/gpt-oss-120b
```

Request 1 steps past the dead member within the request; requests 2–3 never touch it, because the
breaker now demotes it. Both halves of the fix, visible in the timings.

**Candidate ordering changed from filtering to demotion.** `orderByUsability()` returns *all*
candidates, ordered live → credential-faulted → cooling, stable within each band so capability rank
still decides among equals. The old `filter(isHealthy)` **deleted** cooling candidates whenever any
healthy one remained, so a pool could be narrowed to a single member and then have nothing left when
that member failed too. A demoted target costs nothing — it is only reached after every better one
has actually failed on this request.

**401/403 now fails over when another candidate exists.** It did not before, and half of a real
14-member pool answers 401. With a single candidate nothing changes: there is nowhere to fail over
to, so the real error is returned exactly as before.

**Credential fleets fail over without poisoning sibling accounts.** Each deployment expands into
its serviceable credential slots, then the request-local walk is deterministic and breadth-first
across deployments: first slot of deployment A, first slot of B, then A's next slot. A
credential-attributable outcome such as 401/403 may unlock that deployment's sibling slot. One
slot's `AUTH` state does not invalidate its siblings or prove the deployment dead.

A provider transport failure suppresses the provider's remaining rows for that request. A 5xx,
timeout, or protocol/deployment failure closes only that deployment, so the walk may continue elsewhere.
Missing, disabled, and model-scoped-out slots never reach the backend and consume no egress budget.

**A genuine client 4xx (413, 422, …) still does not fail over.** Fourteen candidates would reject
it identically; retrying would just multiply one bad request by fourteen.

**402 is not one of those — it is quota exhaustion, a 429 with a monthly window.** Observed live
2026-08-04: HuggingFace's router answers `402 "You have depleted your monthly included credits"`
while other members of the same pool serve fine, and the relay returned it to the client because
402 fell into the "client" class. It now classifies as retriable (fails over, recorded on the
breaker) but trips a much longer cooldown — 1 hour, the same default `dispatch.ts` uses for a
host-reported `quota_exhausted` — because monthly credits do not reset inside the 2-minute 429
window. The member stays in the cooling band (demoted, never dropped) and any success clears it,
so a mid-month top-up recovers without a restart.

### §2 — half the pool is dead and nothing surfaces it

Three separate things were tangled here, and they have different answers.

**Credential faults are now their own dimension.** A 401 is deliberately not health data — recording
it as a failure would open the breaker on a *configuration* problem and hide the 401 the operator
must see behind a "target unhealthy" skip; recording it as a success would launder a permanently
broken member into a healthy one. So it is neither: `CircuitState.credentialFailures` /
`lastCredentialStatus` / `credentialFaultUntil`, surfaced in `/candidates` under
`breaker.credentialFault` and rendered as `AUTH 401` in the `llm-relay candidates` table where the
row previously read `closed`, identical to a healthy member. It **expires** (5 min), so a rotated key
recovers without restarting the proxy, and it clears immediately on any successful call.

**The pool was smaller than it looked — and that is why the *tenth* entry answered.** In the
historical single-slot incident, seven deployments had no serviceable key in the serving process,
so only **7** of the 14 configured `pool/coding` members could egress:

```
configured members: 14
candidates actually routed to: 7
  1 gemini/gemini-2.5-flash      5 codestral/codestral-latest
  2 nim/z-ai/glm-5.2             6 ollama/qwen2.5-coder:7b
  3 nim/deepseek-ai/deepseek-v4-flash   7 groq/openai/gpt-oss-120b
  4 mistral/devstral-medium-latest
```

After excluding those seven non-serviceable single-slot deployments, `benchmarkSort` put gemini
(str 83.7/3) ahead of glm-5.2 (83.3/4) — so the config's tenth entry was rank 1 of what actually
remained. Nothing was choosing strangely; the list being ranked was half the size it appeared to be.

`llm-relay candidates` now reports every configured deployment × credential cell. Missing-key,
disabled, and model-scoped-out cells remain visible but cannot start; auth-faulted or cooling cells
are demoted. Neither condition condemns an eligible sibling slot.

⚠ **Why those seven had no key — and the trap that hid it.** They were not unconfigured. All eleven
provider keys were set as **Windows User-scope environment variables**, and Windows only puts a
User-scope variable into a process's environment when that process **starts**. The relay is
long-running (launched from `Startup` at logon), so it predated the variables and never had them —
while a *freshly launched* shell did. That split is what makes this so easy to misdiagnose:

- `llm-relay keys` runs as a **new CLI process** and reports that process's environment, which is
  not necessarily the running relay's.
- `llm-relay candidates` prefers the running relay's protected `/candidates` view and attaches the
  per-install capability automatically. When that live view is available, its credential cells are
  authoritative for the process actually serving traffic.
- Direct `GET /registry` and `GET /candidates` requests are protected reads. They require
  `x-llm-relay-control-token` with the capability from `~/.llm-relay/control-token`; never print,
  copy, or log it. `/registry` aggregate `has_key` and nested slot state describe the serving relay.

The two disagreed: the relay reported `has_key=false` for six providers whose keys were sitting in
the registry the whole time. Relaunching the relay from an environment carrying those variables took
it from **6 providers without a key to 0**, and `pool/coding` from 5 live members to **11**. Seven
members that had been reported dead with `401 Wrong API Key` / `no api key supplied` answered
normally, several in under 400ms.

**Diagnose this through the protected running-relay view, not a fresh key-check process:**

```bash
llm-relay candidates     # CLI attaches the capability and prefers the running proxy
```

A `401` from a provider whose key you know is set is this, not a bad credential — check `has_key`
before rotating anything. (`~/.llm-relay/.env` is the durable alternative: `dotenv.ts` loads it at
startup and an already-set real environment variable always wins, so it composes safely.)

**What actually proves a member can serve is still `llm-relay pools --probe`.** Config validation
cannot see a model that is listed and dead, and `/candidates` reports evidence rather than
guaranteeing liveness.

### §3 — upstream error bodies reach the client in non-OpenAI shapes

Fixed for the shapes that break a client. `normalizeOpenAiErrorBody()` in `backend.ts`:

- already `{"error":{…}}` → returned **byte-exact**. A conforming provider's message, code and type
  are its own to state, and rewriting them loses detail.
- `[{"error":{…}}, …]` (gemini) → **unwrapped to the element**, so the same fields land at the top
  level. This is the shape that made a plain 429 read as "the model returned garbage": no `choices`,
  so `response.choices[0]` is `undefined`.
- anything else — an HTML gateway page, a bare string, an empty body → wrapped as
  `{"error":{"message":<original>,"type":"upstream_error","code":<status>}}`.

Responses also carry `x-llm-relay-served-by`. On success it names the one deployment that served; on
an error it names **every** deployment tried, in order, so an exhausted pool is self-describing.

### §4 — `retry-after` is present and nothing acts on it

Now honoured, in the place that actually helps: the **breaker's cooldown**, not a sleep in the
request path. `parseRetryAfterMs()` reads both RFC 9110 forms (delta-seconds, including the
fractional values providers really send, and HTTP-date). A 429 or a 503 carrying one cools that
candidate for exactly as long as the provider asked instead of a flat 120-second guess — which is as
likely to be far too long (a 20-second groq TPM window) as far too short. Clamped to 1s–15min,
because the value is attacker-adjacent input. Garbage parses to `null`, never `0`; treating garbage
as "retry immediately" would silently disable the backoff.

**The proxy deliberately does not sleep and retry.** For a pool the right answer to "retry in 20s" is
"use another candidate now" — that is §1. Blocking a batch job's request for 20 seconds would trade
one symptom for another.

`fetchBackend()` also now carries `Retry-After` onto the error Response it synthesizes. It builds a
*new* Response for an upstream error, so the one header stating when the provider will serve again
was being destroyed there, and neither the breaker nor the client could ever honour it.

### §5 — the rank-1 candidate is extremely slow

Informational, and confirmed: `nim/z-ai/glm-5.2` averages **63.4s** over this proxy's own traffic.

No ranking change. `str` ranks *capability* and health is used only to demote, never to promote —
two competing ranking passes mean neither decides the order, and live health would promote on
evidence that is often a single request's latency.

What changed is that the number is now **visible**. The report's "empty p95 column, so there is no
latency signal" was half right: the synthetic-probe p95 was indeed empty, but the proxy had already
measured 60+ seconds per call under `observed`, and the table never showed it. There is now an `obs`
column beside `p95` — kept separate, because a mean over real requests and a probe-loop p95 are
different statistics from different samples:

```
target                     str        verdict   p95     obs
nim/z-ai/glm-5.2           83.3/4     Pending   -       63.4s
groq/openai/gpt-oss-120b   37.6/4     Pending   -       187ms
```

That is the trade-off the report was pointing at, now legible at a glance: the top-ranked member of
`pool/coding` is ~340× slower than the bottom-ranked one. For mechanical batch work, point at a pool
whose ordering reflects that, or accept the latency knowingly.

## Invariants to keep true

- **Both request paths classify outcomes through the same helpers.** `classifyStatus()` and
  `recordAttempt()` in `server.ts` are the single policy. The original defect was two paths with
  two policies, one of which was "no policy at all".
- **Any test of failover needs ≥2 candidates.** A single-candidate test cannot distinguish working
  failover from absent failover, and that is exactly how this shipped.
- **Credential-scoped demotion or exclusion never removes a serviceable sibling.** A breadth-first
  integration test needs at least two deployments and two slots so it exercises both dimensions.
- **A credential fault is not health data, and not a success either.** It has its own axis. Do not
  "simplify" it into `recordOutcome`.
- **Demote, never drop, on health.** Missing, disabled, and model-scoped-out credential cells stay
  visible for diagnosis but cannot start an attempt; any serviceable sibling remains eligible.
- **A conforming error body is passed through byte-exact.** Normalization exists for the shapes that
  break an OpenAI client, not to reword providers.
