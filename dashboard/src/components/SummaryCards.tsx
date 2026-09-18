import type { ReactElement } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  Gauge,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { SnapshotV1, SpendTotalsV1 } from "../../../src/dashboard-contract.js";
import { currencyMicrousd, duration, number, percent, stamp } from "../formatters.js";
import { PanelCoverage } from "./ProjectionMetadata.js";

function formatTokens(n: number | null): string {
  if (n === null) return "Unavailable";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  subtitle,
  className,
}: Readonly<{
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  subtitle?: ReactElement | string;
  className?: string;
}>): ReactElement {
  return (
    <article className={`card ${className ?? ""}`} title={hint}>
      <div className="card-header">
        <h2 className="card-label">{label}</h2>
        <span className="card-icon-pill">
          <Icon className="card-icon" aria-hidden="true" />
        </span>
      </div>
      <p className="card-value">{value}</p>
      {subtitle ? <small className="card-hint">{subtitle}</small> : null}
    </article>
  );
}

export function SummaryCards({ snapshot }: Readonly<{ snapshot: SnapshotV1 }>): ReactElement {
  const summary = snapshot.summary;
  const summaryCoverage = snapshot.panelCoverage.find((item) => item.panel === "summary");

  const inRep = summary.tokens.reported.reportedInput;
  const inEst = summary.tokens.estimated.estimatedInput;
  const inVal = inRep.value ?? inEst.value;
  const inHint = [
    `Reported: ${number(inRep.value)} (${inRep.source}; observed ${stamp(inRep.observedAt)})`,
    `Estimated: ${number(inEst.value)} (${inEst.source}; observed ${stamp(inEst.observedAt)}${inEst.method === null ? "" : `; ${inEst.method}`})`,
  ].join("\n");
  const inSubtitle = inRep.value !== null && inEst.value !== null && inRep.value !== inEst.value
    ? `Rep: ${formatTokens(inRep.value)} · Est: ${formatTokens(inEst.value)}`
    : inRep.value !== null
      ? "Provider reported"
      : inEst.value !== null
        ? "Relay estimated"
        : "No token counts";

  const outRep = summary.tokens.reported.reportedOutput;
  const outEst = summary.tokens.estimated.estimatedOutput;
  const outVal = outRep.value ?? outEst.value;
  const outHint = [
    `Reported: ${number(outRep.value)} (${outRep.source}; observed ${stamp(outRep.observedAt)})`,
    `Estimated: ${number(outEst.value)} (${outEst.source}; observed ${stamp(outEst.observedAt)}${outEst.method === null ? "" : `; ${outEst.method}`})`,
  ].join("\n");
  const outSubtitle = outRep.value !== null && outEst.value !== null && outRep.value !== outEst.value
    ? `Rep: ${formatTokens(outRep.value)} · Est: ${formatTokens(outEst.value)}`
    : outRep.value !== null
      ? "Provider reported"
      : outEst.value !== null
        ? "Relay estimated"
        : "No token counts";

  const spend: SpendTotalsV1 | null = summary.spend;
  const primaryAmount = spend === null
    ? null
    : spend.providerPublishedReported.amountMicrousd
      ?? spend.providerPublishedEstimated.amountMicrousd
      ?? spend.referenceReported.amountMicrousd
      ?? spend.referenceEstimated.amountMicrousd;

  const primaryBasis = spend === null ? null
    : spend.providerPublishedReported.amountMicrousd !== null ? "Provider reported"
    : spend.providerPublishedEstimated.amountMicrousd !== null ? "Provider estimated"
    : spend.referenceReported.amountMicrousd !== null ? "Reference reported"
    : spend.referenceEstimated.amountMicrousd !== null ? "Reference estimated"
    : null;

  const spendHint = spend === null ? "Spend details unavailable" : [
    `Provider reported: ${currencyMicrousd(spend.providerPublishedReported.amountMicrousd)}`,
    `Provider estimated: ${currencyMicrousd(spend.providerPublishedEstimated.amountMicrousd)}`,
    `Reference reported: ${currencyMicrousd(spend.referenceReported.amountMicrousd)}`,
    `Reference estimated: ${currencyMicrousd(spend.referenceEstimated.amountMicrousd)}`,
    `Unpriced requests: ${number(spend.unpricedRequests)}`,
    `Partially priced requests: ${number(spend.partiallyPricedRequests)}`,
  ].join("\n");

  const spendSubtitle = spend === null ? "Unavailable" : (
    <><span>Unpriced requests</span>: {number(spend.unpricedRequests)}{primaryBasis !== null ? ` · ${primaryBasis}` : ""}</>
  );

  return (
    <section className="summary" aria-label="Summary">
      <PanelCoverage label="Summary" value={summaryCoverage} />
      <div className="summary-grid">
        <StatCard
          icon={Activity}
          label="Requests"
          value={number(summary.requests)}
          subtitle={`${number(summary.attempts)} attempts · ${number(summary.served)} served`}
          hint={`${number(summary.attempts)} attempts; ${number(summary.served)} served; ${number(summary.errored)} errors; ${number(summary.cancelled)} cancelled`}
        />
        <StatCard
          icon={CheckCircle2}
          label="Success rate"
          value={percent(summary.successRate)}
          subtitle={summary.requests > 0 ? `${number(summary.served)} of ${number(summary.requests)} requests` : "No requests"}
        />
        <StatCard
          icon={ArrowDown}
          label="Input tokens"
          value={formatTokens(inVal)}
          subtitle={inSubtitle}
          hint={inHint}
        />
        <StatCard
          icon={ArrowUp}
          label="Output tokens"
          value={formatTokens(outVal)}
          subtitle={outSubtitle}
          hint={outHint}
        />
        <StatCard
          icon={Gauge}
          label="Avg latency"
          value={duration(summary.avgLatencyMs)}
          subtitle="Mean request duration"
        />
        <StatCard
          icon={Clock}
          label="P95 latency"
          value={duration(summary.p95LatencyMs)}
          subtitle="95th percentile"
        />
        <StatCard
          icon={Zap}
          label="Avg commit"
          value={duration(summary.avgCommitMs)}
          subtitle="Time to first byte"
        />
        <StatCard
          icon={CircleDollarSign}
          label="Spend"
          value={currencyMicrousd(primaryAmount)}
          subtitle={spendSubtitle}
          hint={spendHint}
          className="spend-card"
        />
      </div>
    </section>
  );
}

