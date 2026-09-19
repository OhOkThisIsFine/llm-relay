import { useEffect, useRef, useState, type ReactElement } from "react";
import { Bot, ChartLine, KeyRound, Layers, MessageSquare, Moon, Search, Settings, Sun } from "lucide-react";
import { acquireSession, clearStoredSession, logout, readStoredSession, storeSession } from "./api.js";
import { AnalyticsDashboard } from "./pages/AnalyticsDashboard.js";
import { RoutingLadderPage } from "./pages/RoutingLadderPage.js";
import { PlaygroundPage } from "./pages/PlaygroundPage.js";
import { AgentSetupPage } from "./pages/AgentSetupPage.js";
import { KeysProvidersPage } from "./pages/KeysProvidersPage.js";
import { CommandPalette, type DashboardTab } from "./components/CommandPalette.js";
import { SettingsDialog } from "./components/SettingsDialog.js";

export type { DashboardTab };

const THEME_STORAGE_KEY = "llm-relay.dashboard.theme.v1";

function readStoredTheme(): "light" | "dark" {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "dark";
  } catch {
    return "dark";
  }
}

function storeTheme(value: "light" | "dark"): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    /* best-effort */
  }
}

export function resolveLaunchSession(bootstrap: string | null, storage: Storage): string | null {
  // A launch fragment is stronger evidence than a previous tab's session. Clear
  // synchronously before the exchange so a stale value can never win a race.
  if (bootstrap !== null) { clearStoredSession(storage); return null; }
  return readStoredSession(storage);
}

export function DashboardApp({
  bootstrap,
  storage = sessionStorage,
  showRecentTable = false,
  initialTab = "analytics",
}: Readonly<{
  bootstrap: string | null;
  storage?: Storage;
  showRecentTable?: boolean;
  initialTab?: DashboardTab;
}>): ReactElement {
  const [session, setSession] = useState<string | null>(() => resolveLaunchSession(bootstrap, storage));
  const [failure, setFailure] = useState(false);
  const [relaunch, setRelaunch] = useState<"ended" | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>(() => {
    if (showRecentTable) return "analytics";
    return initialTab;
  });
  const [playgroundModel, setPlaygroundModel] = useState<string>("auto");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [controlToken, setControlToken] = useState("");
  const [theme, setThemeState] = useState<"light" | "dark">(() => readStoredTheme());
  const sessionStarted = useRef(false);

  const changeTab = (tab: DashboardTab) => {
    setActiveTab(tab);
    if (typeof window !== "undefined") {
      window.location.hash = tab;
    }
  };

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace(/^#/, "") as DashboardTab;
      if (["routing", "playground", "keys", "agents", "analytics"].includes(hash)) {
        setActiveTab(hash);
      }
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setThemeState(next);
    storeTheme(next);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (session !== null || relaunch !== null || sessionStarted.current) return;
    sessionStarted.current = true;
    const controller = new AbortController();
    void acquireSession(bootstrap, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      storeSession(value.session, storage);
      setSession(value.session);
    }).catch((_error: unknown) => {
      if (!controller.signal.aborted) setFailure(true);
    });
    return () => controller.abort();
  }, [bootstrap, relaunch, session, storage]);

  const endSession = () => { clearStoredSession(storage); setSession(null); setRelaunch("ended"); };
  const onLogout = async (signal: AbortSignal) => { if (session === null) return; await logout(session, signal); endSession(); };
  const restartSession = () => {
    sessionStarted.current = false;
    setFailure(false);
    setRelaunch(null);
  };

  if (relaunch === "ended") return (
    <main className={`app ${theme}`} data-theme={theme}>
      <section className="panel" role="status">
        <h1>Dashboard session ended</h1>
        <p>Your read-only dashboard session has ended.</p>
        <div style={{ marginTop: "1rem" }}>
          <button type="button" onClick={restartSession}>Start new session</button>
        </div>
      </section>
    </main>
  );
  if (failure) return (
    <main className={`app ${theme}`} data-theme={theme}>
      <section className="panel error" role="alert">
        <h1>Dashboard session unavailable</h1>
        <p>Could not connect to the relay service. Ensure llm-relay is running and refresh the page.</p>
        <div style={{ marginTop: "1rem" }}>
          <button type="button" onClick={restartSession}>Retry</button>
        </div>
      </section>
    </main>
  );
  if (session === null) return <main className={`app ${theme}`} data-theme={theme}><p className="status" role="status">Starting read-only dashboard session…</p></main>;

  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

  return (
    <div className={`app-shell ${theme}`} data-theme={theme} style={{ minHeight: "100vh", backgroundColor: theme === "dark" ? "#0f1726" : "#f6f8fb" }}>
      <header
        style={{
          borderBottom: "1px solid var(--border)",
          backgroundColor: theme === "dark" ? "#172033" : "#ffffff",
          padding: "0.5rem 1.5rem",
          margin: 0,
          position: "sticky",
          top: 0,
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "1.5rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "9999px", backgroundColor: "#10b981", display: "inline-block" }} />
            <span style={{ fontWeight: 700, fontSize: "1rem", letterSpacing: "-0.02em" }}>llm-relay</span>
            <span style={{ fontSize: "0.75rem", padding: "0.15rem 0.4rem", borderRadius: "0.25rem", background: "var(--row-hover)", color: "var(--muted)", fontFamily: "monospace" }}>:8791</span>
          </div>

          <nav aria-label="Main sections" style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
            <button
              type="button"
              onClick={() => changeTab("routing")}
              style={{
                background: activeTab === "routing" ? "var(--row-hover)" : "transparent",
                color: activeTab === "routing" ? "var(--accent)" : "var(--muted)",
                border: "none",
                fontWeight: activeTab === "routing" ? 600 : 500,
                fontSize: "0.85rem",
                padding: "0.4rem 0.75rem",
                borderRadius: "0.375rem",
                display: "inline-flex",
                alignItems: "center",
                gap: "0.375rem",
              }}
            >
              <Layers size={15} /> Models &amp; Routing
            </button>
            <button
              type="button"
              onClick={() => changeTab("playground")}
              style={{
                background: activeTab === "playground" ? "var(--row-hover)" : "transparent",
                color: activeTab === "playground" ? "var(--accent)" : "var(--muted)",
                border: "none",
                fontWeight: activeTab === "playground" ? 600 : 500,
                fontSize: "0.85rem",
                padding: "0.4rem 0.75rem",
                borderRadius: "0.375rem",
                display: "inline-flex",
                alignItems: "center",
                gap: "0.375rem",
              }}
            >
              <MessageSquare size={15} /> Playground
            </button>
            <button
              type="button"
              onClick={() => changeTab("keys")}
              style={{
                background: activeTab === "keys" ? "var(--row-hover)" : "transparent",
                color: activeTab === "keys" ? "var(--accent)" : "var(--muted)",
                border: "none",
                fontWeight: activeTab === "keys" ? 600 : 500,
                fontSize: "0.85rem",
                padding: "0.4rem 0.75rem",
                borderRadius: "0.375rem",
                display: "inline-flex",
                alignItems: "center",
                gap: "0.375rem",
              }}
            >
              <KeyRound size={15} /> Keys &amp; Providers
            </button>
            <button
              type="button"
              onClick={() => changeTab("agents")}
              style={{
                background: activeTab === "agents" ? "var(--row-hover)" : "transparent",
                color: activeTab === "agents" ? "var(--accent)" : "var(--muted)",
                border: "none",
                fontWeight: activeTab === "agents" ? 600 : 500,
                fontSize: "0.85rem",
                padding: "0.4rem 0.75rem",
                borderRadius: "0.375rem",
                display: "inline-flex",
                alignItems: "center",
                gap: "0.375rem",
              }}
            >
              <Bot size={15} /> Agent Setup
            </button>
            <button
              type="button"
              onClick={() => changeTab("analytics")}
              style={{
                background: activeTab === "analytics" ? "var(--row-hover)" : "transparent",
                color: activeTab === "analytics" ? "var(--accent)" : "var(--muted)",
                border: "none",
                fontWeight: activeTab === "analytics" ? 600 : 500,
                fontSize: "0.85rem",
                padding: "0.4rem 0.75rem",
                borderRadius: "0.375rem",
                display: "inline-flex",
                alignItems: "center",
                gap: "0.375rem",
              }}
            >
              <ChartLine size={15} /> Fleet Analytics
            </button>
          </nav>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.35rem 0.65rem",
              fontSize: "0.8rem",
              background: "transparent",
              borderColor: "var(--border)",
              color: "var(--muted)",
            }}
          >
            <Search size={14} />
            <kbd style={{ fontSize: "0.7rem", fontFamily: "monospace", opacity: 0.8 }}>
              {isMac ? "⌘K" : "Ctrl K"}
            </kbd>
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0.35rem 0.5rem",
              borderRadius: "0.375rem",
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--muted)",
              cursor: "pointer",
            }}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
            title="Open settings"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0.35rem 0.5rem",
              borderRadius: "0.375rem",
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--muted)",
              cursor: "pointer",
            }}
          >
            <Settings size={15} />
          </button>
          <button
            type="button"
            onClick={() => void onLogout(new AbortController().signal)}
            aria-label="Logout"
            title="Logout"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0.35rem 0.65rem",
              borderRadius: "0.375rem",
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--muted)",
              cursor: "pointer",
              fontSize: "0.8rem",
            }}
          >
            Logout
          </button>
        </div>
      </header>

      <div style={{ display: activeTab === "analytics" ? "block" : "none" }}>
        <AnalyticsDashboard session={session} onSessionExpired={endSession} onLogout={onLogout} showRecentTable={showRecentTable} />
      </div>
      {activeTab === "routing" && (
        <main className={`app ${theme}`} data-theme={theme}>
          <RoutingLadderPage
            controlToken={controlToken}
            onSetControlToken={setControlToken}
            onTestInPlayground={(target) => {
              setPlaygroundModel(target);
              changeTab("playground");
            }}
          />
        </main>
      )}
      {activeTab === "playground" && (
        <main className={`app ${theme}`} data-theme={theme}>
          <PlaygroundPage initialModel={playgroundModel} />
        </main>
      )}
      {activeTab === "keys" && (
        <main className={`app ${theme}`} data-theme={theme}>
          <KeysProvidersPage />
        </main>
      )}
      {activeTab === "agents" && (
        <main className={`app ${theme}`} data-theme={theme}>
          <AgentSetupPage />
        </main>
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelectTab={(tab) => changeTab(tab)}
        onToggleTheme={toggleTheme}
        onRefresh={() => {
          // If in analytics tab, trigger a re-render or reload
          window.location.reload();
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        theme={theme}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        onToggleTheme={toggleTheme}
        controlToken={controlToken}
        onSetControlToken={setControlToken}
      />
    </div>
  );
}
