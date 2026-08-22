import type { ReactElement } from "react";
import type { SnapshotV1 } from "../../../src/dashboard-contract.js";
import { duration, number, percent, stamp } from "../formatters.js";
import { PanelCoverage, SpendCells } from "./ProjectionMetadata.js";

function TokenPair({ label, reported, estimated }: Readonly<{ label: string; reported: Readonly<{ value: number | null; source: string; observedAt: string | null }>; estimated: Readonly<{ value: number | null; source: string; observedAt: string | null; method: string | null }> }>): ReactElement {
  return <article className="card"><h2>{label}</h2><p>Reported: {number(reported.value)}</p><small>{reported.source}; observed {stamp(reported.observedAt)}</small><p>Estimated: {number(estimated.value)}</p><small>{estimated.source}; observed {stamp(estimated.observedAt)}{estimated.method === null ? "" : `; ${estimated.method}`}</small></article>;
}

export function SummaryCards({ snapshot }: Readonly<{ snapshot: SnapshotV1 }>): ReactElement {
  const summary = snapshot.summary; const summaryCoverage = snapshot.panelCoverage.find((item) => item.panel === "summary");
  return <section className="summary" aria-label="Summary"><PanelCoverage label="Summary" value={summaryCoverage} /><div className="summary-grid">
    <article className="card"><h2>Requests</h2><p>{number(summary.requests)}</p><small>{number(summary.attempts)} attempts; {number(summary.served)} served; {number(summary.errored)} errors; {number(summary.cancelled)} cancelled</small></article>
    <article className="card"><h2>Success rate</h2><p>{percent(summary.successRate)}</p></article>
    <TokenPair label="Input tokens" reported={summary.tokens.reported.reportedInput} estimated={summary.tokens.estimated.estimatedInput} />
    <TokenPair label="Output tokens" reported={summary.tokens.reported.reportedOutput} estimated={summary.tokens.estimated.estimatedOutput} />
    <article className="card"><h2>Avg latency</h2><p>{duration(summary.avgLatencyMs)}</p></article><article className="card"><h2>P95 latency</h2><p>{duration(summary.p95LatencyMs)}</p></article><article className="card"><h2>Avg commit</h2><p>{duration(summary.avgCommitMs)}</p></article>
    <article className="card spend-card"><h2>Spend</h2><SpendCells spend={summary.spend} /></article>
  </div></section>;
}
