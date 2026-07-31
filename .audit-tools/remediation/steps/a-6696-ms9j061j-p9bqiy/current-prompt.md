# Remediation Run Already In Progress

A remediation run is already in progress. Choose what to do:

- **Current state**: `implementing`
- **Plan**: `remediate-audit-findings-2026-07-31`
- **Started**: 2026-07-31T22:38:54.554Z

## Item Counts

- **pending**: 3
- **resolved**: 2

## Choices

1. **Resume** — continue the existing run. Write to the ack file:
   ```json
   { "choice": "resume" }
   ```
   Then re-run without `--input`:
   `remediate-code next-step`

2. **Restart from new input** — delete the existing run and start fresh.
   Write to the ack file:
   ```json
   { "choice": "restart" }
   ```
   Then delete `C:\Code\llm-relay\.audit-tools\remediation` and re-run with `--input <path>`.

3. **Merge new recommendations into existing plan** — carry the current plan
   forward with additional findings merged in. Write to the ack file:
   ```json
   { "choice": "merge" }
   ```
   Then re-run with `--input <path>` pointing at your new recommendations.

Write your choice to: `C:\Code\llm-relay\.audit-tools\remediation\confirm_resume_ack.json`