import type { ReactElement } from "react";
import type { PanelCoverageV1 } from "../../../src/dashboard-contract.js";
import { PanelCoverage } from "../components/ProjectionMetadata.js";
import { number } from "../formatters.js";
import "./MetricChart.css";

export type ChartColumn<Row extends Record<string, unknown>> = Readonly<{ key: keyof Row; label: string }>;
type ChartRow = Record<string, unknown> & { readonly id: string; readonly label: string };

const CHART_WIDTH = 960;
const CHART_HEIGHT = 230;
const PLOT_LEFT = 62;
const PLOT_RIGHT = 18;
const PLOT_TOP = 14;
const PLOT_BOTTOM = 42;
const Y_TICKS = 4;
const SERIES_COUNT = 5;

function plottedValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function chartMaximum<Row extends ChartRow>(rows: readonly Row[], columns: readonly ChartColumn<Row>[]): number {
  return Math.max(1, ...rows.flatMap((row) => columns.map((column) => plottedValue(row[column.key]) ?? 0)));
}

function ChartGraphic<Row extends ChartRow>({ rows, columns }: Readonly<{ rows: readonly Row[]; columns: readonly ChartColumn<Row>[] }>): ReactElement {
  const plotWidth = CHART_WIDTH - PLOT_LEFT - PLOT_RIGHT;
  const plotHeight = CHART_HEIGHT - PLOT_TOP - PLOT_BOTTOM;
  const maximum = chartMaximum(rows, columns);
  const groupWidth = plotWidth / rows.length;
  const barWidth = groupWidth * 0.8 / Math.max(1, columns.length);
  const labelStep = Math.max(1, Math.ceil(rows.length / 8));

  return <>
    <svg className="metric-chart-svg" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} width="100%" height={CHART_HEIGHT} focusable="false">
      {Array.from({ length: Y_TICKS + 1 }, (_, index) => {
        const ratio = index / Y_TICKS;
        const y = PLOT_TOP + ratio * plotHeight;
        const value = maximum * (1 - ratio);
        return <g key={`grid-${index}`}>
          <line className="chart-grid" x1={PLOT_LEFT} y1={y} x2={CHART_WIDTH - PLOT_RIGHT} y2={y} />
          <text className="chart-axis-label" x={PLOT_LEFT - 8} y={y + 4} textAnchor="end">{number(value)}</text>
        </g>;
      })}
      {rows.flatMap((row, rowIndex) => columns.map((column, columnIndex) => {
        const value = plottedValue(row[column.key]);
        if (value === null) return null;
        const height = value / maximum * plotHeight;
        const x = PLOT_LEFT + rowIndex * groupWidth + groupWidth * 0.1 + columnIndex * barWidth;
        return <rect key={`${row.id}-${String(column.key)}`} className={`chart-series-${columnIndex % SERIES_COUNT}`} x={x} y={PLOT_TOP + plotHeight - height} width={Math.max(1, barWidth - 1)} height={height} />;
      }))}
      {rows.map((row, index) => {
        if (index % labelStep !== 0 && index !== rows.length - 1) return null;
        return <text key={row.id} className="chart-axis-label" x={PLOT_LEFT + (index + 0.5) * groupWidth} y={CHART_HEIGHT - 12} textAnchor="middle">{row.label}</text>;
      })}
    </svg>
    <ul className="chart-legend">
      {columns.map((column, index) => <li key={String(column.key)}><span className={`chart-swatch chart-series-${index % SERIES_COUNT}`} />{column.label}</li>)}
    </ul>
  </>;
}

export function MetricChart<Row extends ChartRow>({ id, title, rows, columns, panelCoverage }: Readonly<{ id: string; title: string; rows: readonly Row[]; columns: readonly ChartColumn<Row>[]; panelCoverage: PanelCoverageV1 | undefined }>): ReactElement {
  const headingId = `chart-${id}-heading`;
  return <section className="panel chart-panel" aria-labelledby={headingId}>
    <h2 id={headingId}>{title}</h2><PanelCoverage label={title} value={panelCoverage} />
    {rows.length === 0 ? <p>No matching measurements.</p> : <>
      <div className="chart" aria-hidden="true"><ChartGraphic rows={rows} columns={columns} /></div>
      <div className="table-wrap"><table className="responsive-table"><caption>{title} table</caption><thead><tr><th scope="col">UTC bucket</th>{columns.map((column) => <th key={String(column.key)} scope="col">{column.label}</th>)}</tr></thead><tbody>
        {rows.map((row) => <tr key={row.id}><th scope="row" data-label="UTC bucket">{row.label}</th>{columns.map((column) => <td key={String(column.key)} data-label={column.label}>{typeof row[column.key] === "number" || row[column.key] === null ? number(row[column.key] as number | null) : String(row[column.key] ?? "Unavailable")}</td>)}</tr>)}
      </tbody></table></div>
    </>}
  </section>;
}
