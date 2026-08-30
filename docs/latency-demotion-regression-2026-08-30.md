# The v0.65.0 latency term is inverted — measured live, 2026-08-30

> Lap goal: *"Measure the latency fix live: verify end to end whether `routing.latency` made
> offload faster, measure the request-sample warm-up rate, and decide whether the warm-up needs
> help."*
>
> **Answer: the term does the opposite of its purpose.** It cannot demote the glacial member it
> was built for, and it does demote the fast member that carries the traffic. Both halves are
> measured below.
>
> ⚠ **A claim made earlier in this lap and then DISPROVED, kept here so it is not repeated:** the
> first version of this document said the term had "stopped offload". It had not. Disabling
> `routing.latency` and restarting the relay did **not** restore service, which is what disproved
> it. The current offload failure is a provider-side outage on `nim`. See §5.

## 1. How this was measured

All figures come from the live daemon: `~/.llm-relay/probe-cache.json`,
`~/.llm-relay/usage/recent.json`, `llm-relay candidates --tier medium`, and real requests sent
through `127.0.0.1:8791`. At the start of the lap `routing.latency` was absent from
`~/.llm-relay/config.json`, so every default applied: enabled, `p95Ms` 30000, `msPerToken` 250,
`minSamples` 5.

## 2. Defect A — a healthy deployment is demoted by its own successful answer

`recordRequestSample` (v0.65.0) appends request latency into `entry.samples` — **the same array the
ABSOLUTE p95 reads**. The absolute ceiling of 30000 ms is calibrated on PROBE latency, and a probe
asks for one token (`ping.ts` posts one user message at `max_tokens: 1`). A real request generates.

`latency-demotion.ts` states that insight itself, and applies it to the per-token statistic only:

> absolute latency cannot compare a `max_tokens: 1` probe with a 500-token generation

Per-token exists to prevent this demotion, and a test pins it. But per-token engages only at
`minSamples` (5) **request** samples. Below that count the absolute fallback runs, on an array that
now mixes both kinds. **That gap — 1 to 4 request samples — is the defect.**

### The deployment it hit

`nim/nvidia/nemotron-3-ultra-550b-a55b` served **59 of the 62** successful requests in
`recent.json`. Its samples, before this investigation sent anything:

| time | code | ms | source | tokens |
|---|---|---|---|---|
| 2026-08-26T14:14:42Z | 200 | 23478 | probe | — |
| 2026-08-27T22:16:33Z | 200 | 748 | probe | — |
| 2026-08-30T00:14:26Z | 200 | 941 | probe | — |
| 2026-08-30T22:13:56Z | 200 | 2120 | **request** | 64 |
| 2026-08-30T22:14:23Z | 200 | 14634 | **request** | 274 |
| 2026-08-30T22:14:58Z | 200 | 34863 | **request** | 632 |

(Four 503 probe samples are omitted; they are not measurable.)

Its per-token rates are **33.1, 53.4 and 55.2 ms/token**, against a ceiling of 250. By the primary
signal it is healthy, and comfortably so.

- absolute p95 **as shipped** (probe + request): **34863 ms** → above 30000 → **DEMOTED**
- absolute p95 over **probe samples only**: **23478 ms** → below 30000 → not demoted

**The deployment demoted itself by succeeding.** Its third request was a correct 632-token answer
at a healthy 55.2 ms/token, and that answer is what demoted it.

### The amplifier: at these sample counts, "p95" is the maximum

`getP95` takes index `ceil(n * 0.95) - 1`. For any `n <= 20` that index is `n - 1`, the largest
sample. The window holds at most `MAX_SAMPLES` = 25. So one slow generation demotes a deployment
until it rolls out of the window.

### The trap

A demoted member needs five request samples to be judged on the fair statistic. It earns them more
slowly once demoted, because it is walked later. The term suppresses the evidence that would
retract it.

## 3. Defect B — the member the feature was built for cannot be demoted at all

`nim/deepseek-ai/deepseek-v4-flash-0731` is the glacial member named in the design evidence. Its
`candidates` p95 is **105611 ms**. Timed directly through the relay during this lap, it **hung past
65 seconds** and returned nothing.

It is **not demoted**, under the shipped code or under fix (a):

```
nim/deepseek-ai/deepseek-v4-flash-0731
   samples 19   measurable 2   probe-measurable 2   p95 105611
```

`MEASURABLE_CODES` is `{"200", "401"}`. Seventeen of its nineteen samples are error codes, so only
**2** are measurable — below `minSamples` of 5. The term therefore has no opinion.

**This is structural, not incidental.** A deployment that hangs or errors produces timeouts and
5xx, and those are exactly the codes that are not measurable. So the worse a deployment behaves,
the fewer qualifying samples it accumulates, and the less able the latency term is to demote it.
The term is weakest precisely where it is needed.

Taken with §2, the feature is **inverted**: it cannot demote the slow member, and it does demote
the fast one.

## 4. What else reads the polluted statistic

`getP95` has four consumers: the latency term, `getModelSummary` (the `llm-relay candidates` p95
column), `getStabilityScore`, and `getVerdict`. Measured on `nemotron-3-ultra`:

| statistic | as shipped | probe samples only |
|---|---|---|
| p95 | 34863 | 23478 |
| jitter | 12719 | 10670 |
| spike rate | 0.429 | 0.333 |
| uptime | 64 | 43 |
| **stability score** | **7** | **6** |
| verdict | Unstable | Unstable |

**Only the demotion term crosses a threshold.** The stability score moves by one point and the
verdict does not change, so the claim that this reshapes pool order is **not** supported and is not
made here. The `candidates` p95 column does silently change meaning — it now mixes probe and
generation latency — which is a transparency cost, not a routing one.

## 5. The current offload failure is a provider outage, not this defect

At 23:13 the mitigation was applied: `routing.latency` set to `false`, relay restarted, liveness
confirmed (`GET /telemetry` 200). A `pool/medium` request then still failed —
`2 tried, 0 served: 1x429, 1x504`, 120 seconds. **That disproved the claim that the term had
stopped offload.**

Timing each top live candidate individually, immediately afterwards:

| deployment | result | elapsed |
|---|---|---|
| gemini/models/gemini-3.6-flash | HTTP 502 | 18 s |
| mistral/mistral-medium-2505 | HTTP 402 | 1 s |
| gemini/models/gemini-3.5-flash | HTTP 503 | 2 s |
| nim/deepseek-ai/deepseek-v4-flash-0731 | **hung, no response** | 65 s (client cut) |
| nim/nvidia/nemotron-3-ultra-550b-a55b | HTTP 503 | 0 s |

`nemotron-3-ultra` answered **HTTP 200 in 1 second** forty minutes earlier and now returns 503. The
`nim` provider degraded during the lap. That, not the latency term, is why offload returns nothing
right now.

The owner's `walkBudgetMs` is **120000**, which is the 120–123 second wall on every failing row.
One hanging candidate consumes the whole budget, which is the condition defect B leaves unaddressed.

## 6. Options

Every option keeps the owner's 2026-08-30 decision that sustained latency should demote.

**For defect A — which samples the ABSOLUTE ceiling may read:**

- **(a) Probe samples only.** Each statistic reads the sample kind its ceiling was calibrated on:
  absolute over probes, per-token over requests. It applies the module's own reasoning
  consistently, restores the `candidates` p95 column to one meaning, and keeps the fallback's
  stated purpose — a probe still catches a deployment that is slow before it emits anything.
  Verified against live data: it changes exactly one verdict, and that verdict is the wrong one.
- **(b) No opinion while request samples number 1 to 4.** Smaller change, same window closed, and a
  deployment is unjudged during warm-up where today it is judged on probes.
- **(c) Lower `minSamples`.** Reintroduces what that floor was chosen to prevent.

**For defect B — a deployment that hangs or errors never qualifies:**

- **(B1) Leave it.** The breaker already reacts to timeouts and 5xx. Latency then covers only the
  narrow case of a deployment that answers successfully but slowly.
- **(B2) Count a timeout as evidence of latency.** A request that hit the timeout is a measurement
  of "at least this slow". It would need its own sample kind, because it is not a completed
  generation and has no token count.
- **(B3) Treat the walk budget as the lever instead.** Cap the time any single candidate may
  consume so one hang cannot eat the whole budget.

Recommendation: **(a)** for defect A; for defect B, decide before building, because B2 and B3 are
different mechanisms with different blast radii.

## 7. Status

Found at lap start on 2026-08-30, on `e01d510` (v0.65.1). No code is changed yet.
`routing.latency` is currently **false** in `~/.llm-relay/config.json` (backup:
`config.json.bak-2026-08-30-pre-latency-disable`), and the relay was restarted onto that setting.
Nothing depends on leaving it off; re-enable it once defect A is fixed.
