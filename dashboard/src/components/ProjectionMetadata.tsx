import type { ReactElement } from "react";
import type { PanelCoverageV1, SpendTotalsV1, TokenTotalsV1 } from "../../../src/dashboard-contract.js";
import { basisLabel, coverage, currencyMicrousd, number, stamp } from "../formatters.js";
import { basisTone } from "../view-model.js";

/** A small pill for a provenance/basis value, tinted by `basisTone()` so a reader can tell a first-party figure from a derived or weaker one at a glance without reading the label text. */
export function BasisBadge({ value }: Readonly<{ value: string | null }>): ReactElement {
  return <span className={`basis-badge basis-${basisTone(value)}`}>{basisLabel(value)}</span>;
}

export function PanelCoverage({ value, label }: Readonly<{ value: PanelCoverageV1 | undefined; label: string }>): ReactElement {
  if (value === undefined) return <aside className="coverage unavailable" aria-label={`${label} data status`} aria-description="Unavailable; reason unavailable; provenance unavailable; observed unavailable"><strong>Unavailable</strong><span>State: unavailable. Reason: unavailable. Provenance: unavailable. Observed: unavailable.</span></aside>;
  const description = `${coverage(value.state)}; reason ${value.reason ?? "unavailable"}; provenance ${value.provenance.length === 0 ? "unavailable" : value.provenance.join(", ")}; observed ${stamp(value.observedAt)}.`;
  return <aside className={`coverage ${value.state}`} aria-label={`${label} data status`} aria-description={description}><strong>{coverage(value.state)}</strong><span>{description}</span></aside>;
}

export function TokenCells({ tokens }: Readonly<{ tokens: TokenTotalsV1 | null }>): ReactElement {
  if (tokens === null) return <p className="null-value">Token details unavailable.</p>;
  const cells = [
    ["Reported input", tokens.reported.reportedInput.value, tokens.reported.reportedInput.source, tokens.reported.reportedInput.observedAt, null],
    ["Reported output", tokens.reported.reportedOutput.value, tokens.reported.reportedOutput.source, tokens.reported.reportedOutput.observedAt, null],
    ["Reported cached input", tokens.reported.reportedCachedInput.value, tokens.reported.reportedCachedInput.source, tokens.reported.reportedCachedInput.observedAt, null],
    ["Estimated input", tokens.estimated.estimatedInput.value, tokens.estimated.estimatedInput.source, tokens.estimated.estimatedInput.observedAt, tokens.estimated.estimatedInput.method],
    ["Estimated output", tokens.estimated.estimatedOutput.value, tokens.estimated.estimatedOutput.source, tokens.estimated.estimatedOutput.observedAt, tokens.estimated.estimatedOutput.method],
  ] as const;
  return <dl className="cell-list">{cells.map(([label, value, source, observedAt, method]) => <div key={label}><dt>{label}</dt><dd>{number(value)} <small>({source}; observed {stamp(observedAt)}{method === null ? "" : `; ${method}`})</small></dd></div>)}</dl>;
}

export function SpendCells({ spend }: Readonly<{ spend: SpendTotalsV1 | null }>): ReactElement {
  if (spend === null) return <p className="null-value">Spend details unavailable.</p>;
  const cells = [
    ["Provider-published / reported", spend.providerPublishedReported],
    ["Provider-published / estimated", spend.providerPublishedEstimated],
    ["Reference / reported", spend.referenceReported],
    ["Reference / estimated", spend.referenceEstimated],
  ] as const;
  // A partially priced request leaves cache/unpublished token kinds out of the
  // amounts, so every figure here is a LOWER BOUND until that count is zero.
  const lowerBound = spend.partiallyPricedRequests > 0;
  return <dl className="cell-list spend-cells">{cells.map(([label, cell]) => <div key={label}><dt>{label}</dt><dd>{currencyMicrousd(cell.amountMicrousd)}{lowerBound ? " (lower bound)" : ""} <small>({cell.priceSource}; {cell.tokenBasis}; {cell.source}; observed {stamp(cell.observedAt)})</small></dd></div>)}<div><dt>Unpriced requests</dt><dd>{number(spend.unpricedRequests)}</dd></div><div><dt>Partially priced requests</dt><dd>{number(spend.partiallyPricedRequests)}</dd></div></dl>;
}
