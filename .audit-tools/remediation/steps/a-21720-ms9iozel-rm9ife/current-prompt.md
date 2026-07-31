# Confirm discovered remediation source(s)

No `--input`/`--guidance-file` was supplied. The following remediation
source(s) were auto-discovered on disk. Review them and decide with the user
which to use — the tool would otherwise auto-select the highest-priority one
(`C:\Code\llm-relay\.audit-tools\audit-findings.json`).

**Discovered sources:**
- `C:\Code\llm-relay\.audit-tools\audit-findings.json` — type: structured_audit, modified 2026-07-31T22:29:47.169Z, 173 finding(s)
- `C:\Code\llm-relay\.audit-tools\audit-report.md` — type: document, modified 2026-07-31T22:29:47.167Z

To proceed with the auto-selected source (`C:\Code\llm-relay\.audit-tools\audit-findings.json`), write to `C:\Code\llm-relay\.audit-tools\remediation\confirm_auto_discovered_input_ack.json`:

```json
{ "status": "confirmed" }
```

To use a DIFFERENT discovered source, or a file not listed, re-run with
`--input <path>` (it takes the lossless structured fast-path for a `.json`).

To reject all discovered defaults, write `{ "status": "declined" }` to `C:\Code\llm-relay\.audit-tools\remediation\confirm_auto_discovered_input_ack.json`
and re-run with an explicit `--input <path>`.

Then run: `remediate-code next-step`