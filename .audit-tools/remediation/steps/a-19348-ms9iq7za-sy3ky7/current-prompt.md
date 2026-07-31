# Confirm Remediation Scope and Intent

The intake worker has pre-populated the following proposal. Review each section
and adjust where needed, then confirm by writing the final `intent_checkpoint.json`.

## Proposed Scope

Full remediation of audit findings from C:\Code\llm-relay\.audit-tools\audit-findings.json

## Proposed Intent

Full remediation of security and quality findings from the audit report

## Proposed Filters

(none — remediating all findings)

## Open Questions

- None

## Suggested Closing Action

commit (valid options: `commit`, `merge-to-base` (land the run as one revertable `--no-ff` merge into the branch you launched from; safe — aborts and leaves the base untouched on any conflict), or `none`)

---

To confirm, write the final checkpoint to:

`C:\Code\llm-relay\.audit-tools\remediation\intent_checkpoint.json`

```json
{
  "schema_version": "intent-checkpoint/v1",
  "confirmed_at": "<ISO-8601 timestamp>",
  "confirmed_by": "host",
  "scope_summary": "Full remediation of audit findings from C:\Code\llm-relay\.audit-tools\audit-findings.json",
  "intent_summary": "Full remediation of security and quality findings from the audit report",
  "free_form_intent": "<optional: additional guidance>",
  "filters": {},
  "excluded_scope": [],
  "must_not_touch": []
}
```

Adjust `filters`, `excluded_scope`, `must_not_touch`, or `free_form_intent` to
narrow scope. Valid severities: `critical`, `high`, `medium`, `low`, `info`.
Valid lenses: `correctness`, `architecture`, `maintainability`, `security`, `reliability`, `performance`, `data_integrity`, `tests`, `operability`, `config_deployment`, `observability`.

Once written with `"confirmed_by": "host"`, run:

`remediate-code next-step`
