import { useEffect, useRef, useState, type ReactElement } from "react";
import { clearStoredSession, exchangeBootstrap, logout, readStoredSession, storeSession } from "./api.js";
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
  const [relaunch, setRelaunch] = useState<"missing" | "ended" | null>(() => bootstrap === null && session === null ? "missing" : null);
  const bootstrapStarted = useRef(false);
  useEffect(() => {
    if (bootstrap === null || session !== null || relaunch !== null || bootstrapStarted.current) return;
    bootstrapStarted.current = true;
    const controller = new AbortController();
    void exchangeBootstrap(bootstrap, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      storeSession(value.session, storage); setSession(value.session);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFailure(true);
    });
    return () => controller.abort();
  }, [bootstrap, relaunch, session, storage]);
  const endSession = () => { clearStoredSession(storage); setSession(null); setRelaunch("ended"); };
  const onLogout = async (signal: AbortSignal) => { if (session === null) return; await logout(session, signal); endSession(); };
  if (relaunch !== null) return <main className="app"><section className="panel" role="status"><h1>{relaunch === "missing" ? "Dashboard relaunch required" : "Dashboard session ended"}</h1><p>Relaunch the dashboard from the relay CLI to start a new read-only session.</p></section></main>;
  if (failure) return <main className="app"><section className="panel error" role="alert"><h1>Dashboard session unavailable</h1><p>Relaunch the dashboard from the relay CLI to try again.</p></section></main>;
  if (session === null) return <main className="app"><p className="status" role="status">Starting read-only dashboard session…</p></main>;
  return <AnalyticsDashboard session={session} onSessionExpired={endSession} onLogout={onLogout} />;
}
