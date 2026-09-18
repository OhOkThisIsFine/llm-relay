import { useEffect, useRef, type ReactElement } from "react";
import { Activity, X } from "lucide-react";
import type { DetailV1 } from "../../../src/dashboard-contract.js";
import { duration, stamp } from "../formatters.js";
import { PanelCoverage, SpendCells, TokenCells } from "./ProjectionMetadata.js";
import { PlatformDot } from "./PlatformDot.js";
import { StatusBadge } from "./StatusBadge.js";

function DetailField({
  label,
  value,
}: Readonly<{
  label: string;
  value: React.ReactNode;
}>): ReactElement {
  return (
    <div className="detail-item">
      <dt className="detail-label">{label}</dt>
      <dd className="detail-value">{value}</dd>
    </div>
  );
}

export function DetailDialog({ detail, onClose }: Readonly<{ detail: DetailV1; onClose(): void }>): ReactElement {
  const close = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    close.current?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
        ) ?? []),
      ].filter((node) => !node.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [onClose]);

  const request = detail.request;

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        aria-describedby="detail-description"
      >
        <div className="dialog-header">
          <div className="dialog-header-title">
            <Activity className="dialog-icon" aria-hidden="true" />
            <h2 id="detail-title">Request {request.requestId}</h2>
            <StatusBadge value={request.outcome} />
          </div>
          <button
            ref={close}
            type="button"
            className="dialog-close-btn"
            onClick={onClose}
            aria-label="Close details"
          >
            <X className="dialog-close-icon" aria-hidden="true" />
          </button>
        </div>

        <p id="detail-description" className="dialog-description">
          {request.attemptCount} recorded attempt{request.attemptCount === 1 ? "" : "s"} ({detail.attempts.map((attempt) => attempt.attemptId).join(", ") || "none"}). Coverage states include reason, provenance, and observed timestamp.
        </p>

        <section aria-labelledby="request-projection" className="dialog-section">
          <h3 id="request-projection" className="dialog-section-title">Request projection</h3>
          <dl className="detail-grid-v2">
            <DetailField label="Occurred" value={stamp(request.occurredAt)} />
            <DetailField
              label="Status"
              value={<StatusBadge value={request.outcome} />}
            />
            <DetailField
              label="Provider"
              value={
                request.provider ? (
                  <span className="inline-flex items-center">
                    <PlatformDot provider={request.provider} />
                    {request.provider}
                  </span>
                ) : (
                  "Unavailable"
                )
              }
            />
            <DetailField label="Model" value={request.model ?? "Unavailable"} />
            <DetailField label="Client" value={request.client ?? "Unavailable"} />
            <DetailField label="Attribution" value={request.attribution} />
            <DetailField label="Latency" value={duration(request.latencyMs)} />
            <DetailField label="Commit / TTFB" value={duration(request.commitMs)} />
            <DetailField
              label="Failure kind"
              value={request.failureKind ? <StatusBadge value={request.failureKind} /> : "None"}
            />
            <DetailField label="Credential" value={request.credentialId ?? "Unavailable"} />
            <DetailField label="Repair included" value={request.repairIncluded ? "Yes" : "No"} />
          </dl>

          <div className="detail-cards-row">
            <div className="detail-subcard">
              <h4>Request tokens</h4>
              <TokenCells tokens={request.tokens} />
            </div>
            <div className="detail-subcard">
              <h4>Request spend</h4>
              <SpendCells spend={request.spend} />
            </div>
          </div>
        </section>

        <section aria-labelledby="attempt-projection" className="dialog-section">
          <h3 id="attempt-projection" className="dialog-section-title">Attempts Ladder</h3>
          {detail.attempts.length === 0 ? (
            <p className="empty-row">No recorded attempts are available for this request.</p>
          ) : (
            <div className="table-wrap">
              <table className="responsive-table">
                <caption>Bounded request attempts</caption>
                <thead>
                  <tr>
                    <th scope="col">Attempt ID</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                    <th scope="col">Started</th>
                    <th scope="col">Ended</th>
                    <th scope="col">Latency</th>
                    <th scope="col">Commit</th>
                    <th scope="col">Provider</th>
                    <th scope="col">Model</th>
                    <th scope="col">Credential</th>
                    <th scope="col">Failure</th>
                    <th scope="col">Tokens</th>
                    <th scope="col">Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.attempts.map((attempt) => (
                    <tr key={attempt.attemptId}>
                      <th scope="row" data-label="Attempt ID">
                        {attempt.attemptId}
                      </th>
                      <td data-label="Role">{attempt.role}</td>
                      <td data-label="Status">
                        <StatusBadge value={attempt.status} />
                      </td>
                      <td data-label="Started">{stamp(attempt.startedAt)}</td>
                      <td data-label="Ended">{stamp(attempt.endedAt)}</td>
                      <td data-label="Latency">{duration(attempt.latencyMs)}</td>
                      <td data-label="Commit">{duration(attempt.commitMs)}</td>
                      <td data-label="Provider">
                        {attempt.provider ? (
                          <span className="inline-flex items-center">
                            <PlatformDot provider={attempt.provider} />
                            {attempt.provider}
                          </span>
                        ) : (
                          "Unavailable"
                        )}
                      </td>
                      <td data-label="Model">{attempt.model ?? "Unavailable"}</td>
                      <td data-label="Credential">{attempt.credentialId ?? "Unavailable"}</td>
                      <td data-label="Failure">
                        {attempt.failureKind ? <StatusBadge value={attempt.failureKind} /> : "None"}
                      </td>
                      <td data-label="Tokens">
                        <TokenCells tokens={attempt.tokens} />
                      </td>
                      <td data-label="Spend">
                        <SpendCells spend={attempt.spend} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section aria-labelledby="detail-coverage" className="dialog-section">
          <h3 id="detail-coverage" className="dialog-section-title">Detail coverage</h3>
          {detail.panelCoverage.length === 0 ? (
            <p className="null-value">No panel coverage record was supplied.</p>
          ) : (
            detail.panelCoverage.map((item) => (
              <PanelCoverage key={item.panel} label={`Detail ${item.panel}`} value={item} />
            ))
          )}
        </section>
      </section>
    </div>
  );
}

