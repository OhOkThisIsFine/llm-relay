import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { consumeBootstrapFragment } from "./api.js";
import { DashboardApp, type DashboardTab } from "./app.js";
import "./styles.css";

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown): void {
    console.error("Dashboard uncaught render error:", error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="app dark" data-theme="dark" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
          <section className="panel error" role="alert" style={{ maxWidth: "600px", width: "100%", padding: "1.5rem" }}>
            <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>Dashboard Unavailable</h1>
            <p style={{ color: "var(--muted)", marginBottom: "1rem" }}>
              An unexpected error occurred while rendering the dashboard view:
            </p>
            <pre style={{ padding: "0.75rem", background: "var(--row-hover)", borderRadius: "0.5rem", overflowX: "auto", fontSize: "0.85rem", color: "var(--danger)" }}>
              {this.state.error.message || String(this.state.error)}
            </pre>
            <div style={{ marginTop: "1.25rem", display: "flex", gap: "0.75rem" }}>
              <button type="button" onClick={() => window.location.reload()}>
                Reload Page
              </button>
              <button
                type="button"
                onClick={() => {
                  sessionStorage.clear();
                  window.location.hash = "";
                  window.location.reload();
                }}
              >
                Reset Session &amp; Cache
              </button>
            </div>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

// Fragment handling intentionally precedes app construction and every network call.
const validTabs: readonly DashboardTab[] = ["routing", "playground", "keys", "agents", "analytics"];
const hashTab = window.location.hash.replace(/^#/, "");
const initialTab: DashboardTab = validTabs.includes(hashTab as DashboardTab) ? (hashTab as DashboardTab) : "routing";
const bootstrap = consumeBootstrapFragment(window.location, window.history);

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <DashboardApp bootstrap={bootstrap} initialTab={initialTab} />
  </ErrorBoundary>,
);

