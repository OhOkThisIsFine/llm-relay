# Gateway contract comparison

Executable R1 evidence for the [architecture refactor](../../docs/architecture-refactor-plan.md).
No production dependencies or parallel request service are added.

```sh
node scripts/refactor/gateway-contracts.mjs --self-test
node scripts/refactor/gateway-boundaries.mjs --self-test
npm ci --ignore-scripts
npm run build:server
node scripts/refactor/gateway-contracts.mjs relay
node scripts/refactor/gateway-contracts.mjs litellm
node scripts/refactor/gateway-contracts.mjs bifrost
node scripts/refactor/gateway-boundaries.mjs relay
node scripts/refactor/gateway-boundaries.mjs litellm
node scripts/refactor/gateway-boundaries.mjs bifrost
node scripts/refactor/gateway-boundaries.mjs litellm --chat-bridge
```

External candidates require Docker on Linux. The first screen records the immutable image resolved
from an explicit tag. The boundary screen pins the image digests from the recorded comparison.
The relay uses its locked dependency resolution. All requests, keys and state are synthetic; no
provider credentials or user configuration enter the fixture. Docker sees only a disposable fixture
directory. This is not evidence of native Windows gateway installation or live provider/host support.

## Screens and oracles

`gateway-contracts.mjs` runs 39 scenarios: all three fronts against OpenAI and Anthropic mocks,
buffered and whole/fragmented-stream tool cycles, identities/results, non-ASCII arguments,
credential containment, one terminal event, incremental delivery before a controlled EOF,
cancellation, native Messages/Chat opaque fields and supplied usage values, and disabled retries.
Its 33 positive/negative oracle assertions also run in the ordinary test gate.

`gateway-boundaries.mjs` runs 30 scenarios. Each of three provider instances supports **only one**
upstream wire (Messages, Chat or Responses), rejecting other endpoints. Each front is exercised
buffered/streamed, then four native cases use the candidate's explicit passthrough route: complete
JSON including unknown fields and usage, unchanged SSE bytes, cancellation plus request-field
preservation, and a native 503 error body. The relay uses its normal same-wire route as the control.
API-base prefixes follow each implementation's convention; they are not inferred from a mock that
accepts every suffix. Its 32 self-test assertions include wrong-path, repeated-egress, credential,
missing-field and Unicode-escaping controls. They also run in the normal test gate.

LiteLLM uses a configured `pass_through_endpoints` route with fixed synthetic auth headers and
`forward_headers: false`. Bifrost uses documented `anthropic_passthrough`/`openai_passthrough` routes
and configured keys. No special host identity, OAuth impersonation or private gateway patch is used.
The optional `--chat-bridge` profile adds LiteLLM's documented `use_chat_completions_api: true` and
reruns the ten Chat-only cases. Other gateway override combinations are not exhaustively searched.

## Reading results

Each program prints one JSON record. A green comparison job means evidence was generated, **not**
that a candidate qualified: read individual cases and `allContractsPassed`. Assertion failures remain
visible while testing continues. Setup/mock failures fail the job. Native SSE byte equality is a
stricter assertion than semantic equivalence; inspect the difference before diagnosing information
loss. Translated text is checked after JSON decoding so Unicode escapes are not false failures.

Task tokens correlate egresses to their original cases, including late calls until candidate shutdown.
Auxiliary markerless traffic is reported separately; a request that loses its task text still has zero
correlated egresses and cannot pass. Zero-retry tests do not certify multi-candidate failover.

The first screen recursively preserves supplied usage fields and records additional native fields
for provenance review. Added keys alone are not loss; an added zero is not thereby certified as known
zero. The native boundary screen checks the complete unchanged JSON instead.

The [initial evidence checkpoint](../../docs/history/refactor-r1-gateway-2026-09-22.md) records the first
screen and its measurement corrections. These screens do not certify every provider flavor, opaque
content block, arbitrary tool schema, repair/destructive refusal, accounting/health policy or memory
ceiling. Existing behavioral regressions remain binding during the service cutovers.
