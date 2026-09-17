# Historical records

**These files are evidence, not documentation. Do not read them as instructions.**

Each file here records what was true on the date in its name: a design decision and the
measurements behind it, an audit and its findings, or a lap closeout. The project moved on
afterwards. A statement in one of these files can be wrong today, and several are contradicted
on purpose by a later record.

## Where to read instead

| You want | Read |
|---|---|
| To install and use the relay | [`../QUICKSTART.md`](../QUICKSTART.md) |
| Configuration, routing, CLI, endpoints | [`../reference.md`](../reference.md) |
| How the code is laid out | [`../architecture.md`](../architecture.md) |
| To contribute a change | [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) |
| What is true right now | [`../../HANDOFF.md`](../../HANDOFF.md) |
| What is still open | [`../backlog.md`](../backlog.md) |
| Why a rule exists | [`../../CLAUDE.md`](../../CLAUDE.md) |

## Why these files stay

Two reasons.

1. `CLAUDE.md` and `reference.md` cite them. A rule in those files often states a measurement,
   and the record here is the measurement. Delete the record and the rule becomes an assertion
   nobody can check.
2. A reversed decision is easier to judge with the argument that produced it. Several rules in
   this project were reversed once. The record of both directions prevents a third reversal.

## How to use one

1. Read the date in the file name. Treat every claim as a claim about that date.
2. Check the claim against the source before you act on it.
3. If the record and the current code disagree, the code wins. Say so in your change.

## Naming

- `closeout-*` — the end of one lap of work: what shipped, what was verified, what was left.
- `design-*`, `*-design-*` — a design decision and its alternatives.
- `audit-*`, `*-review-*` — findings from a review, with verdicts.
- `*-lap-*`, `lap-plan-*` — a lap's plan or its record.
- `evidence-2026-08-16/` — machine-readable verdicts from one review.
- `reviews/` — duplication and complexity catalogues, and the refactor plans built from them.

## Paths in these files

Machine paths were replaced with `C:\Users\<user>\`. The original files named one developer's
home directory. Nothing in these records is required to reproduce a result; where a path
matters, the file names the artifact, not the machine.
