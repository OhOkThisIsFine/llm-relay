# R1 implementation decisions and native-wire evidence

Date: 2026-09-22. This resolves the implementation choices required by the
[architecture refactor plan](../architecture-refactor-plan.md). It does not claim that the selected
services are implemented or that their full release acceptance matrix has passed. R2 is the next
implementation packet; another open-ended gateway survey is not a prerequisite.

## 1. Selected responsibilities

| Responsibility | Decision |
|---|---|
| Translation and provider egress | Keep in-process protocol adapters. Use the locked llm-bridge 2.0.1 for cross-protocol conversions it supports, with only necessary provider compatibility handling. Native same-wire traffic must not round-trip through another protocol. Do not introduce LiteLLM or Bifrost as a runtime gateway. |
| Request execution policy | One RequestService owns the candidate walk, credentials, deadlines, hedges, commitment, cancellation and terminal outcome. Translators must not independently retry or route. Delete the two old orchestration loops in R2. |
| MCP framing and negotiation | Official `@modelcontextprotocol/server` 2.0.0, stdio transport. Keep llm-relay's job/wait semantics rather than switching job APIs. |
| Owned structural contracts | Zod 4.3.6 with inferred TypeScript types; generated input JSON Schema consumed by existing Ajv 8.17.1 where appropriate. Use explicit strict/open objects, without coercion or validation-time mutation. |
| Operational job store | `node:sqlite` DatabaseSync in one bounded database worker, explicit SQL and migrations; no ORM or separately maintained native addon. Adopt a Node 22.13 minimum API floor with the real consumer, not in this evidence-only PR. |
| SQLite durability | DELETE rollback journal, `synchronous=EXTRA`, foreign keys enabled, extension loading disabled, short transactions and bounded worker-side contention handling. |

The SDK/schema/SQLite specimens and installation evidence are in the
[infrastructure decision record](refactor-baselines-and-dependencies-2026-09-22.md). Their exact
Linux/Windows API-floor probes pass. Commit production dependency locks and recheck installation
and advisories when real consumers adopt them. Node 22.13 is a minimum tested API level, not a
recommendation to install an old security patch; its SQLite API is experimental. Power-loss,
Windows ACL, macOS sync and full live-host checks remain explicit acceptance work.

These choices are not protection for the current implementation. In particular, the existing
native Responses path fails the new fidelity screen and must be replaced, as described below.

## 2. Executed native and single-wire comparison

The [comparison guide](../../scripts/refactor/gateway-contracts.md) documents both programs and
all reproduction commands. The original 39-case screen remains useful but did not exercise native
Responses-to-Responses fidelity. The new `gateway-boundaries.mjs` adds 30 cases: all three fronts
against three separate single-wire providers, then native JSON/SSE/cancellation/error preservation.
Its mock rejects any endpoint other than the configured wire. Each task retains an independent
egress identity until candidate shutdown.

The corrected three-candidate comparison ran at `f834cc9b` in
[run 6](https://github.com/OhOkThisIsFine/llm-relay/actions/runs/35747907017), merge commit
`6faae0d6ad23588cc466a221bb508509570c0dac` against PR #74 head `5e8c260b`.
The explicit LiteLLM Chat bridge was then tested at `8643463f` in
[run 7](https://github.com/OhOkThisIsFine/llm-relay/actions/runs/35748691043), merge commit
`b89309039a31616cc09375c1debd44a9d02fdc98`. Both comparison workflows completed successfully as
**evidence generation**; individual failed contracts are retained, not converted into passes.

| Screen / configuration | Relay | LiteLLM 1.101.0 | Bifrost HTTP 2.2.1 |
|---|---|---|---|
| Original tool/stream/cancellation screen | 39/39 | 38/39; unified Messages request extension lost | 35/39; unified Messages/Chat extensions lost in both directions |
| Native bypass screen, 12 cases | 8/12; all four native Responses cases fail | 12/12 with configured generic passthrough routes | 12/12 with documented provider passthrough routes |
| Single-wire translations, 18 text cases, default profile | 18/18; configured upstream wire retained | 12/18 | 12/18 |
| Explicit Chat-only override, 10 cases | Not applicable | 9/10; all egresses use Chat, but the buffered Messages case fails the decoded-answer assertion | Not tested |

The external native bypasses preserve the synthetic unknown request/response fields, complete
native usage/IDs, SSE bytes and native 503 body; cancellation reaches upstream and configured keys
replace caller credentials. The earlier unified-endpoint field losses therefore do **not** establish
that either gateway is incapable of native preservation.

Default single-wire failures are specific: Messages/Responses fronts choose `/v1/responses` against
a Chat-only OpenAI-configured provider; the Chat front chooses `/v1/chat/completions` against a
Responses-only provider. Native Messages providers work through all three fronts. LiteLLM's documented
`use_chat_completions_api: true` corrects Chat-only endpoint selection in all ten override cases.
The one remaining buffered-answer mismatch is an observed fixture failure, not a fully localized
vendor defect. Other model-prefix/custom-provider override combinations were not exhaustively tested.

The candidate versions, immutable image digests, licenses and installation artifact sizes are in the
[initial comparison record](refactor-r1-gateway-2026-09-22.md). The boundary test pins those digests.
The external installation proof is Docker on Linux, not native Windows installation. Synthetic wire
coverage is not evidence that the operator's private accounts or every provider-specific extension
were tested. The supported `kind`/`wire` boundaries come from `src/config-types.ts`; existing
DeepSeek, document, tool-ID, thought-signature and dialect regressions remain protected.

### Fixture corrections, not product defects

The first boundary run had incorrect API-base prefixes: some paths gained a second `/v1`, while
others omitted it. Its raw-text check also mistook JSON Unicode escaping for missing text. These
were corrected in the fixture; the mock still requires the exact endpoint and the assertion now
checks decoded text. Do not cite that first run's wrong-base or escaping failures as gateway defects.
The 32 boundary-oracle checks include API-base composition, escaped text and negative controls;
the original screen has 33 separate oracle checks. These tests run in the ordinary repository gate.

## 3. Why retain an in-process translation boundary

This is an ownership/integration decision, not a claim that the relay wins every fixture or that
external gateways have no useful functionality.

| Integration responsibility | With the selected adapters | With a tested gateway configuration |
|---|---|---|
| Native versus translated wire selection | Direct adapter choice inside RequestService; replace the defective Responses round-trip | Select native bypass versus unified endpoint and map provider/wire overrides; passthrough alone does not translate |
| Routing, health, quota, operator caps and credential binding | Existing focused policy functions feed the one lifecycle | Either port these contracts into gateway hooks or retain relay ownership while disabling overlapping gateway routing/retries |
| Stream commitment, repair and accounting provenance | Typed in-process outcome and bounded consumers; preserve opaque content beside any inspected tool form | Reconcile gateway output and errors with relay commitment, repair and provenance; generic forwarding alone removes none of these decisions |
| Dispatch and process lifetime | Same daemon calls RequestService directly for answer mode | Job/process ownership still needs its application service; adopting a separate gateway does not remove that work |
| Installation and configuration generations | One managed application and snapshot authority | Additional executable/runtime or embedded gateway integration, configuration synchronization, readiness, upgrade and failure ownership |

The executable comparisons demonstrate good gateway streaming/tool/cancellation behavior and working
native bypasses. They do not demonstrate removal of the product-specific policy responsibilities in
this table. Keeping those responsibilities while adding a gateway would retain much of the ownership
complexity this refactor is meant to delete. Porting the application into a gateway would also require
new implementations of these contracts rather than merely removing their duplicate owners.

Use the existing maintained-tool boundary where it earns its place: llm-bridge for supported
cross-protocol conversion, standard SDK/schema/SQL machinery for commodity responsibilities, and
narrow native/provider adapters for fidelity. No universal intermediate representation, second router
or private gateway fork is introduced. This choice may change on positive integration evidence, but
unknown alternate gateway support is not a reason to postpone R2 or storage work.

## 4. Confirmed relay defect: native Responses fidelity

A Responses client routed to an OpenAI provider configured with `wire: "responses"` still takes a
translation round-trip in the current implementation. In the new native fixtures:

- buffered success loses an opaque extension, changes an output-item ID and `created_at`, and emits
  Chat-style `prompt_tokens`/`completion_tokens` usage instead of the upstream Responses usage shape;
- streamed success rebuilds events and loses supplied item/sequence identity and native event fields;
- caller cancellation reaches upstream, but the same test fails because the native request extension
  was stripped before egress; this is **not** evidence of failed cancellation;
- the native 503 status survives, but the body is rewrapped and its opaque field is lost.

All four use one correctly targeted `/v1/responses` egress. The original 39-case screen passing does
not negate these failures. Record them as D (confirmed-defect) acceptance requirements, never as
snapshots of desirable current output. They remain unfixed in this evidence packet.

R2 must retain the original Responses request and response when the selected provider uses the same
wire. Inspect tools and observe usage without destructive normalization. Preserve existing form-repair
and destructive-call safeguards; native forwarding is not permission to bypass those checks. Add
regressions for native success/error/SSE fields, IDs and cache usage, and exercise the same pre-commit
failover, post-commit no-splicing and exactly-once accounting scenarios with at least two candidates.
The internal answer collector must consume RequestService directly, not fake HTTP objects.

## 5. Runtime budgets and next implementation

The [R0 measurements and contract map](refactor-baselines-and-dependencies-2026-09-22.md) remain the
baseline. The following are **prospective engineering budgets**, not measured candidate results or
statistically established confidence intervals. Their absolute allowances reflect the measured scale:
roughly 0.2–0.4 s startup, single-digit Linux millisecond requests/cancellation, coarser Windows timer
resolution, submillisecond-to-few-millisecond storage writes and tens-to-hundreds of MiB stream RSS.
They must be checked with matched controls, not by comparing unrelated historical CI machines.

| Measurement | Maximum increase over paired baseline |
|---|---|
| Median process start | Greater of 20% or 50 ms |
| Median and p95 warm response / first content / cancellation latency | Greater of 20% or 2 ms; for Windows timer-limited probes, one measured baseline timer quantum may replace the 2 ms allowance |
| Peak RSS for the same 1 MiB and 8 MiB workload | Greater of 20% or 16 MiB |
| State-write median and p95 at the same retained-data size | Greater of 25% or 1 ms; measure worker round-trip as well as transaction time after SQLite adoption |
| Package footprint | Existing package ceilings remain binding; intentional dependency growth needs a measured, reviewed same-commit baseline change |

Before editing the execution loops, run three alternating same-build baseline pairs on matched
Linux/Windows runners using the same Node patch, probe revision, front order and payload. If these
controls exceed the proposed allowances, diagnose and record measurement noise before setting the
final comparison threshold; do not silently relax it after observing a slower implementation.
Repeat baseline/candidate pairs at R2 acceptance and retain all raw samples. Three startup/cancel
samples per batch are not a reliable tail estimate; increase sample counts for any tail claim.
The current probe's first wire chunk is not necessarily first meaningful content: retain its metric
but measure the actual content boundary before claiming first-response improvement.

RSS samples at two payload sizes do not prove bounded buffering, and no numerical budget permits
whole-response buffering of a streaming request. Preserve explicit backpressure/cancellation/buffer
contracts and exercise maximum retained outputs while storage work is active. The unusually large
Responses wire/RSS workload is not evidence of a leak by itself and may not be improved by dropping
required terminal content. The paired-control calibration remains an R0 verification item; this
record fixes the policy and does not falsely claim those pairs have already run.

**Next packet:** calibrate those matched controls, then implement R2 against the selected in-process
boundary, including the native Responses defect. Preserve every unreviewed test as P until its
specific assertion is classified. R3 import/rollback work may proceed with the selected SQLite design,
but no unused parallel store lands without a real consumer or the atomic R4 cutover. MCP host,
production schema/inference, clean-install, privacy, migration and process-lifetime acceptance remain
with their corresponding integration packets. Do not repeat dependency selection as a substitute for
implementing the one request owner. Hard-cap continuation remains separately evidence-gated.

## Verification checkpoint

At source `8643463f83181be4c2455d400b090e1557f8e50b`,
[CI 803](https://github.com/OhOkThisIsFine/llm-relay/actions/runs/35748691192),
[refactor evidence 11](https://github.com/OhOkThisIsFine/llm-relay/actions/runs/35748691189) and
[gateway comparison 7](https://github.com/OhOkThisIsFine/llm-relay/actions/runs/35748691043) all completed
successfully. Repository/candidate execution was in GitHub Actions; local work only syntax-checked
and self-tested the standalone boundary fixture on Node 22.16.0. Final-head CI is recorded on PR #75.
PR #74's latest infrastructure tree is retained when this decision record is integrated. No main
merge, deployment, published dependency or release version change is represented by this packet.
