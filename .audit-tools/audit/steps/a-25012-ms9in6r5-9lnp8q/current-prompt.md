# audit-code present report

The deterministic audit is complete.

Read the final audit report from: C:\Code\llm-relay\.audit-tools\audit-report.md

Present the completed audit with work blocks first.

## Run friction triage (BLOCKING close-out)

Write to the friction record at:
`C:\Code\llm-relay\.audit-tools\audit\friction\run.json`
### Per-category friction walk

All three categories covered (0 observation(s), 3 attestation(s)).

### Quota/billing messages the tool did NOT auto-classify (standing obligation)

If you encounter any quota/limit/billing-related provider message that was NOT already auto-captured as `credit_exhausted` or `quota_unclassified` friction, record it as a `tool_should_decide` `open_observations[]` entry (or in `free_form_notes`) so the pattern set in `errorParsing.ts` can be improved. Keep the exact wording of the error phrasing (that is what lets a new precise pattern be authored) — but you MUST REDACT any secret value first: replace any API key, token, Bearer credential, password, or key=value / `?key=…` secret with `[REDACTED]`. The pattern is authored from the message SHAPE, never from a live credential — a friction record may be shared or committed.

### Free-form notes (optional)

Anything that fits no category — set `free_form_notes` (a string) on the record.

Call next-step again after writing.

Do not run the orchestrator again for this completed audit.
