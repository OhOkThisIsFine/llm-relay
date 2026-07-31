# Synthesize Remediation Intake

Read the source manifest:

`C:\Code\llm-relay\.audit-tools\remediation\intake\source-manifest.json`

Then read only the listed source files:

- structured_audit: `C:\Code\llm-relay\.audit-tools\audit-findings.json`

Create a launch brief for the remediation workflow. The goal is to eliminate
ambiguity before the normal remediation planner turns this into findings.

Write JSON to exactly:

`C:\Code\llm-relay\.audit-tools\remediation\intake\intake-summary.json`

```json
{
  "schema_version": "remediate-code-intake-summary/v1alpha1",
  "ready": false,
  "source_type": "documents",
  "goals": ["specific remediation goal"],
  "non_goals": ["explicitly out-of-scope change"],
  "constraints": ["compatibility, dependency, testing, timing, or style constraint"],
  "affected_files": [{ "path": "relative/path.ts", "reason": "why this file is implicated" }],
  "open_questions": [
    {
      "id": "Q-001",
      "category": "scope_of_fix",
      "question": "What needs to be clarified before code changes?",
      "blocking": true
    }
  ]
}
```

Set `ready` to `true` only when the goals, non-goals, affected areas, and
success criteria are clear enough that implementation choices will not depend
on another user decision. If any blocking ambiguity remains, set `ready` to
`false` and list the questions.

Use `source_type` of `structured_audit`, `documents`, `conversation`,
or `mixed`.

Also write a Markdown launch brief to exactly:

`C:\Code\llm-relay\.audit-tools\remediation\intake\remediation-brief.md`

The brief must include:

- source summary
- goals
- non-goals
- constraints
- affected files or discovery targets
- acceptance criteria
- open questions, if any

Also write a preliminary intent checkpoint to exactly:

`C:\Code\llm-relay\.audit-tools\remediation\intent_checkpoint.json`

```json
{
  "schema_version": "intent-checkpoint/v1",
  "confirmed_at": "<ISO-8601 timestamp for when this draft was created>",
  "confirmed_by": "draft",
  "scope_summary": "<pre-populated scope derived from the goals and affected_files above>",
  "intent_summary": "<pre-populated intent derived from the goals and source_type above>",
  "filters": {},
  "pre_draft_questions": [
    {
      "id": "Q-001",
      "question": "<question text from open_questions above>",
      "blocking": true
    }
  ],
  "closing_action": "commit"
}
```

Rules for the preliminary checkpoint:
- `confirmed_by` MUST be `"draft"` (sentinel for unconfirmed state).
- Pre-populate `scope_summary` from the goals and affected areas; pre-populate
  `intent_summary` from the overall purpose (e.g. "full remediation of security
  findings from the audit report").
- Copy ALL open_questions into `pre_draft_questions`, preserving their ids and
  blocking flags. Non-blocking questions are included as FYI context.
- Suggest `closing_action` as `"commit"` by default (valid options:
  `"commit"`, `"merge-to-base"` — land the run as one revertable `--no-ff`
  merge into the launch branch, aborting safely on conflict — or `"none"`).
- If a `free_form_intent` was interpreted (e.g. "prioritizing security
  findings"), record a brief explanation in `intent_interpretation`.
- Leave `filters` empty (`{}`) unless the source clearly implies specific
  severity/lens/package scope.

Do not edit source files.

Then run:

`remediate-code next-step`
