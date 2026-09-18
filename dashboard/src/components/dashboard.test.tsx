import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { MetricChart } from "../charts/MetricChart.js";
import { DetailDialog } from "./DetailDialog.js";
import { SummaryCards } from "./SummaryCards.js";
import { detail, snapshot } from "../test-fixtures.js";
import { DASHBOARD_STATIC_CSP } from "../../../src/dashboard-static.js";

describe("analytics components", () => {
  it("renders exactly eight labelled cards without replacing null with zero", () => {
    render(<SummaryCards snapshot={snapshot} />); expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(8); expect(screen.getByText("Unavailable")).toBeInTheDocument(); expect(screen.getByText("Unpriced requests")).toBeInTheDocument(); expect(screen.getByText("$1.0000")).toBeInTheDocument(); expect(screen.queryByText("$6.0000")).not.toBeInTheDocument();
  });
  it("renders chart graphic with SVG and no inline styles", async () => {
    const { container } = render(<MetricChart id="requests-test" title="Requests" panelCoverage={undefined} rows={[{ id: "2026-08-20T12:00:00.000Z", label: "12:00 UTC", requests: 2, attempts: 3 }]} columns={[{ key: "requests", label: "Requests" }, { key: "attempts", label: "Attempts" }]} />);
    expect(screen.getByRole("heading", { name: "Requests" })).toBeInTheDocument(); expect(container.querySelector("svg")).toBeInTheDocument(); expect(container.querySelector("[style]")).toBeNull(); expect(DASHBOARD_STATIC_CSP).toContain("style-src 'self'"); expect(DASHBOARD_STATIC_CSP).not.toContain("'unsafe-inline'"); expect((await axe(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
  });
  it("supports focus, escape, and explicit repair detail", async () => {
    const user = userEvent.setup(); const close = vi.fn(); render(<DetailDialog detail={detail} onClose={close} />); expect(screen.getByRole("dialog")).toHaveTextContent("repair"); expect(screen.getByRole("button", { name: "Close details" })).toHaveFocus(); await user.keyboard("{Escape}"); expect(close).toHaveBeenCalledOnce();
  });
});
