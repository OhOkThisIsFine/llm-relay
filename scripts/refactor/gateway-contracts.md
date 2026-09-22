# Gateway contract comparison

An executable R1 fidelity screen for the [architecture refactor](../../docs/architecture-refactor-plan.md).
It does not implement a second request service or add shipped dependencies.

```sh
node scripts/refactor/gateway-contracts.mjs --self-test
npm ci --ignore-scripts
npm run build:server
node scripts/refactor/gateway-contracts.mjs relay
node scripts/refactor/gateway-contracts.mjs litellm
node scripts/refactor/gateway-contracts.mjs bifrost
```

The external candidates require Docker on Linux. Release tags are explicit; each run records the
resolved image ID/digest and executes that immutable local image. The existing relay uses the
repository's locked dependency resolution. No live provider credentials or user configuration enter
the fixture. Docker receives only a disposable directory containing synthetic configuration/keys.
This is not evidence of native Windows installation or live provider/host support.

All candidates see the same prior tool call/result and the same next tool call with fragmented,
non-ASCII arguments. The screen checks Messages, Chat and Responses fronts against synthetic OpenAI
and Anthropic providers, buffered and streamed, plus tool-free incremental text delivery before a
barrier-controlled EOF and propagation of caller cancellation. Native Messages/Chat fixtures check
opaque field, response identity and cache-usage preservation. Zero-retry fixtures check one upstream
egress on failure; they do not claim multi-candidate failover coverage. The existing relay is a
control, not an oracle for any confirmed defect.

The program prints one JSON result record. `allContractsPassed` reports compatibility with this
screen. Individual assertion failures are recorded and testing continues: a green comparison job
means it generated evidence, not that a candidate passed. Setup/mock-server failures fail the job.
Inspect unexpected endpoints and zero-egress errors for fixture/configuration mistakes before
calling a failed assertion a dependency defect. The 20 positive/negative oracle checks run separately
and are also exercised by the normal test gate.

The fixture is deliberately small and bounded. It does not measure backpressure memory ceilings,
health/accounting provenance, tool-form repair/destructive-call safeguards, every configured provider,
license suitability, or upgrade cost. Those still belong in the R1 decision packet and subsequent
RequestService acceptance. A passing result alone is not permission to replace the implementation.
A verified failure of a required contract can reject an unmodified candidate without claiming its
other features were exhaustively tested.
