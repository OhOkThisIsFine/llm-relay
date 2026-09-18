import { useEffect, useRef, useState, type ReactElement } from "react";
import { acquireSession, clearStoredSession, logout, readStoredSession, storeSession } from "./api.js";
import { AnalyticsDashboard } from "./pages/AnalyticsDashboard.js";

export function resolveLaunchSession(bootstrap: string | null, storage: Storage): string | null {
  // A launch fragment is stronger evidence than a previous tab's session. Clear
  // synchronously before the exchange so a stale value can never win a race.
  if (bootstrap !== null) { clearStoredSession(storage); return null; }
  return readStoredSession(storage);
}

export function DashboardApp({ bootstrap, storage = sessionStorage }: Readonly<{ bootstrap: string | null; storage?: Storage }>): ReactElement {
  const [session, setSession] = useState<string | null>(() => resolveLaunchSession(bootstrap, storage));
  const [failure, setFailure] = useState(false);
  const [relaunch, setRelaunch] = useState<"ended" | null>(null);
  const sessionStarted = useRef(false);

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
    <main className="app">
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
    <main className="app">
      <section className="panel error" role="alert">
        <h1>Dashboard session unavailable</h1>
        <p>Could not connect to the relay service. Ensure llm-relay is running and refresh the page.</p>
        <div style={{ marginTop: "1rem" }}>
          <button type="button" onClick={restartSession}>Retry</button>
        </div>
      </section>
    </main>
  );
  if (session === null) return <main className="app"><p className="status" role="status">Starting read-only dashboard session…</p></main>;
  return <AnalyticsDashboard session={session} onSessionExpired={endSession} onLogout={onLogout} />;
}

