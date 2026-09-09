# llm-relay — project philosophy

This document holds the standing convictions that settle a question before it reaches the owner.

<!-- BEGIN philosophy-brief -->
llm-relay steers one person's LLM traffic across providers and quotas, because reliability and transparency are the mission and everything else serves it.
Tool-call repair is one component, never the identity, because the project is a traffic control plane first.
The proxy fixes protocol form, never judgment, because no LLM opinion may enter the request path.
A guess is never labelled a measurement and unknown stays null, because provenance is what makes the numbers trustworthy.
Counting may only reorder, never refuse, because the ledger is accounting and not custody, with the single bounded hedge exception.
This installation first: a change earns its place by helping this setup, a fresh install, or a friend's, because hypothetical users do not count.
Every decision shaped by an invariant is stated aloud with the rule it applied, because a silent constraint cannot be overruled.
<!-- END philosophy-brief -->

## PRODUCT — what llm-relay is for, and what it refuses to be

- This installation first: a change earns its place by helping this setup, a fresh install on a new machine, or a friend's install, because features for hypothetical users fail. (docs/project-goals.md)
- A stranger with README plus onboard alone must succeed, because that pair is the supported install path and anything it requires that lives elsewhere is a bug. (docs/project-goals.md)
- Traffic steering is the mission — reliable, transparent, lightweight control of one person's traffic — because repair, metering, and every other piece serve that end, never the reverse. (CLAUDE.md)
- Tool-call repair is one small component, not the project's identity, because repair only keeps weaker models usable on tool-carrying requests while steering carries the project. (docs/project-goals.md)
- The repair boundary holds: the proxy fixes protocol form, never judgment, and no LLM opinion enters the request path, because routing comes from config and deterministic classification. (CLAUDE.md)
- Destructive tool calls are refused, never fabricated, because repair output may run with full permissions and inventing intent there is unsafe. (HANDOFF.md)
- Provenance is load-bearing: every reported number carries its basis, a total mixing bases shows its split, and unknown stays null rather than zero, because an estimate masquerading as a measurement destroys trust. (docs/project-goals.md)
- Counting may only reorder, never refuse or duplicate, because the ledger meters keys the operator already holds and is accounting rather than custody, with the one narrow hedge exception that is bounded to free deployments, aborts the loser, and announces itself. (docs/project-goals.md)
- Loopback only, and loopback is not authorization: startup refuses a non-loopback bind, yet mutating endpoints still carry admission checks, because the relay holds provider keys and performs no authentication of its own. (HANDOFF.md)
- No hosted relay and no pooled consumer accounts: each person runs their own instance with their own keys, because the relay never operates a login, never asks for another person's token, and never centrally proxies another person's subscription traffic. (docs/project-goals.md)
- Health demotes, never drops, because filtering unhealthy candidates once narrowed a pool to nothing when it was needed most. (HANDOFF.md)
- Toward boring: a proposal moves the project toward stable-and-boring or it does not ship, because structure-first enterprise shape is presumptively wrong here. (docs/project-goals.md)

## WORKING — how work gets done here

- Done means the build and the one gate green on a clean, committed tree, because the gate is exactly what CI runs and a local-only green proves nothing. (HANDOFF.md)
- Any new policy covers both request paths, because a policy enforced on one path while the other walks around it is not a policy. (HANDOFF.md)
- New behaviour is pinned by a test, because unpinned behaviour regresses silently and nobody notices. (HANDOFF.md)
- Failover tests use at least two candidates, because with one candidate "fails over correctly" and "cannot fail over" are the same observation. (HANDOFF.md)
- A red test that pinned a defect is fixed in the same commit as the source, because the test did the job it was written for and splitting them orphans the proof. (HANDOFF.md)
- Lane output is advisory and is verified by running something — the suite and a typecheck, or reading the exact source — because a lane follows a brief's shape while dropping its finest constraints. (HANDOFF.md)
- Findings, audits, and plans land in a file under the docs directory, never chat-only, because chat scrolls away and the file is what the next session actually reads. (HANDOFF.md)
- The backlog is the queue and holds unmet properties only, because closed work lives in history and restating it turns the queue into an archive. (HANDOFF.md)
- A manual step in a release or gate is a defect to turn into tooling, because a gate that needs a human is a gate that will be skipped under pressure. (docs/project-goals.md)
- Every decision shaped by an invariant is stated aloud with the rule, what it excluded, and the alternative used, because an invariant that silently shapes work is indistinguishable from being unhelpful and cannot be overruled. (docs/project-goals.md)
