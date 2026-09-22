# R1 gateway comparison: executable evidence checkpoint

Date: 2026-09-22 (Pacific). This completes an executable comparison slice, not the complete R1
dependency decision packet. Follow the [architecture refactor plan](../architecture-refactor-plan.md).
No production request/dispatch implementation, dependency, Node floor or release version changes here.

## Branch reconciliation

PR #74 was receiving concurrent R0 performance and SDK/SQLite probe work. PR #75 is deliberately
stacked on that branch rather than overwriting it. Its starting point was `ddab7b25`, which corrected
the runtime baseline's relative imports. The unrelated documentation PR #72 was not incorporated.

## Reproduction

[Commands and scope](../../scripts/refactor/gateway-contracts.md) accompany
[`gateway-contracts.mjs`](../../scripts/refactor/gateway-contracts.mjs). The script starts each real
candidate against synthetic local providers, with isolated state and fake credentials only.
External candidates run from an immutable Docker image ID resolved from an explicit release tag.
The comparison is a Linux container installation test, not a native Windows gateway installation test.

The 39 scenarios cover all three fronts against two synthetic providers: buffered, whole-stream and
fragmented-stream tool cycles; prior call/result identities; non-ASCII arguments; caller-credential
containment; one terminal event; incremental text before a controlled EOF; upstream cancellation;
native request/response opaque fields; native identity/cache usage; and disabled gateway retries.

The supplied OpenAI mock accepts both Chat and Responses upstream wires. The gateways selected
Responses for the Messages-to-OpenAI scenario, while the relay selected Chat. Success here does not
establish compatibility with a deployment that only supports Chat. Recorded upstream protocol is
part of each result; a provider-specific wire matrix is still required.

## Verified observations

The task-correlated checkpoint is `0fb34d6e33849f15306e7bc5bee3c06ba6d952ec`.
[Gateway comparison run 3](https://github.com/OhOkThisIsFine/llm-relay/actions/runs/35702737169)
used merge tree `81712ab0fda7483a9d3e867d37a86dd839092e22` against PR #74 head `5e8c260b`.
The preceding [run 2](https://github.com/OhOkThisIsFine/llm-relay/actions/runs/35702014131)
is retained as diagnostic evidence, not the final task-egress oracle.

| Candidate | Observed working contracts | Specific remaining discrepancy |
|---|---|---|
| Current relay, including locked llm-bridge 2.0.1 | All 39 task-correlated scenarios passed in run 3 | This small screen does not certify all existing adapters or lifecycle behavior |
| LiteLLM v1.101.0, unified endpoints | Tool cycles, streaming, cancellation, retry isolation, native response identity and supplied usage values passed | The native Messages request's synthetic opaque extension was absent at upstream; 38 of 39 scenarios passed in run 3 |
| Bifrost HTTP v2.2.1, standard integration endpoints | Tool cycles, streaming, cancellation and retry isolation passed in run 2 | Native Messages and Chat opaque extensions were dropped in both directions; the usage object was enriched, not stripped of the supplied cached-token value |

Bifrost's added Chat usage fields included `cached_read_tokens: 11` and `cache_write_tokens: 0` beside
`cached_tokens: 11`. The earlier strict nested-object equality check classified this as a mismatch.
The final oracle instead recursively checks every provided value and records the actual object for
provenance review. Missing or changed values still fail, with positive/negative self-tests. Do not
interpret added keys alone as loss of usage; whether an added zero is justified is a separate
unknown-versus-zero provenance question not resolved by this fixture.

The final script has 33 self-test assertions, including task-correlation and usage-oracle negative
controls. Final-head CI and the post-oracle-correction comparison are recorded on PR #75; the run
links and counts above identify specific checkpoints rather than predicting later results.

## Measurement corrections

Early runs attributed every concurrent provider POST to the currently executing case. One extra
relay POST therefore appeared alternately under buffered and streamed scenarios. After inserting a
unique marker into each synthetic task, all 39 task requests had exactly one egress, and the extra
markerless Chat request was recorded separately as auxiliary traffic. These early counts did not
establish a streaming, llm-bridge or retry defect and must not enter the defect backlog as such.

Completed cases remain in a bounded registry until candidate shutdown. Late calls retain their
original task attribution, and final counts are checked again after shutdown. Missing task text
cannot pass as auxiliary traffic: the original case then lacks its required correlated egress.
The fixture still reports auxiliary traffic; it does not hide it or infer its precise initiator.

## Exact candidate identities and installation evidence

| Candidate | Resolved image digest or package integrity | Observed installation artifact |
|---|---|---|
| LiteLLM | `ghcr.io/berriai/litellm@sha256:d295634e09c648dcdb72c4cc2dd226f5fb87823a73e88cbbed6f205e4deb044b` | Docker image size 1,173,517,741 bytes |
| Bifrost HTTP | `maximhq/bifrost@sha256:a8942692af7b4b89196cd8fc33653b7353488dfd58b24078fe793b8574a8084b` | Docker image size 267,927,188 bytes |
| llm-bridge | `2.0.1`, `sha512-LL/5lbRcB2Xmdyt8T5HoWImQMqykkmHHs8MP2qsj8vMFcjq5NDnNwMfdsw0/Upt+F8X1bBdHxniKyq1rFjxzMQ==` | Existing locked Node dependency, exercised inside the actual relay |

Docker image sizes are not compressed download sizes, resident memory, or native-binary sizes.
They are not comparable directly with the relay's npm tarball. The selected LiteLLM release's
[license](https://github.com/BerriAI/litellm/blob/v1.101.0/LICENSE) uses MIT terms outside its separately
licensed enterprise directory. Bifrost's selected HTTP release carries an
[Apache-2.0 license](https://github.com/maximhq/bifrost/blob/transports/v2.2.1/LICENSE). The locked bridge
package declares MIT. No enterprise functionality was needed by this screen.

## Decision boundary and next action

Neither tested gateway configuration is a drop-in replacement for the plan's native opaque-content
contract. Do not replace the current adapters with either unmodified configuration on this evidence.
This is not a finding that the products cannot support the contract through another documented path.

Before closing R1, test explicitly supported generic passthrough configuration for the failed native
cases, then compare the required bypass/adaptation code and extra runtime ownership with retaining
the current narrow adapters. Do not spoof a particular host's identity to activate special behavior.
Complete the actual configured-provider wire matrix, routing/accounting hooks, unknown/provenance
handling and installation comparison. Include the concurrent SDK/schema/SQLite results from PR #74
and write one final choice per responsibility before starting R2.

Do not reopen already measured stream/tool/cancellation questions without a changed fixture or
candidate. These common fixtures remain reusable acceptance evidence. This packet does not close
R0's broader performance/classification work, all of R1, or the live host/provider evidence gates.

## Verification limits

The source checkpoint above passed [normal CI run 799](https://github.com/OhOkThisIsFine/llm-relay/actions/runs/35702737150):
the full Linux build/check gate and targeted Windows process-boundary suite. Complete local checkout
and dependency access were unavailable; local validation was Node 22.16.0 syntax and fixture-oracle
checks, while repository and real candidate execution occurred in GitHub Actions on Node 22.23.2.

A green comparison job means the evidence was generated, not that every contract passed. Read the
per-case results and `allContractsPassed`. The screen does not test production prompts, full
backpressure ceilings, every opaque content block, arbitrary tool schemas, tool-form repair,
destructive-tool refusal, all provider flavors, admission, or complete accounting/health lifecycle.
Existing product regressions remain binding for the later RequestService cutover.
