import type { ReactElement } from "react";

export type StatusKind = "outcome" | "failure";

export function statusTone(value: string | null | undefined): "success" | "error" | "warning" | "muted" {
  if (!value) return "muted";
  const normalized = value.toLowerCase().trim();
  switch (normalized) {
    case "success":
      return "success";
    case "error":
    case "provider_error":
    case "auth_error":
    case "protocol":
      return "error";
    case "cancelled":
    case "timeout":
    case "rate_limit":
    case "aborted":
      return "warning";
    default:
      return "muted";
  }
}

export function formatStatusLabel(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  return value.replace(/_/g, " ");
}

export function StatusBadge({
  value,
  className,
}: Readonly<{
  value: string | null | undefined;
  className?: string;
}>): ReactElement {
  if (!value) {
    return <span className="null-value">Unavailable</span>;
  }
  const tone = statusTone(value);
  const label = formatStatusLabel(value);
  return (
    <span className={`status-badge status-badge-${tone} ${className ?? ""}`}>
      {label}
    </span>
  );
}
