import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { consumeBootstrapFragment } from "./api.js";
import { DashboardApp } from "./app.js";
import "./styles.css";

// Fragment handling intentionally precedes app construction and every network call.
const bootstrap = consumeBootstrapFragment(window.location, window.history);
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 0 } } });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><DashboardApp bootstrap={bootstrap} /></QueryClientProvider>);
