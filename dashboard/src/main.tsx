import { createRoot } from "react-dom/client";
import { consumeBootstrapFragment } from "./api.js";
import { DashboardApp } from "./app.js";
import "./styles.css";

// Fragment handling intentionally precedes app construction and every network call.
const bootstrap = consumeBootstrapFragment(window.location, window.history);
createRoot(document.getElementById("root")!).render(<DashboardApp bootstrap={bootstrap} />);
