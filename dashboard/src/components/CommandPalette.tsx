import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Bot, ChartLine, Copy, KeyRound, Layers, MessageSquare, Moon, RefreshCw, Search, Settings, Sun, X } from "lucide-react";

export type DashboardTab = "analytics" | "routing" | "playground" | "keys" | "agents";

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSelectTab: (tab: DashboardTab) => void;
  readonly onToggleTheme: () => void;
  readonly onRefresh: () => void;
  readonly onOpenSettings?: (() => void) | undefined;
  readonly theme: "light" | "dark";
}

interface CommandItem {
  readonly id: string;
  readonly title: string;
  readonly category: "Navigation" | "Actions";
  readonly icon: typeof Search;
  readonly run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  onSelectTab,
  onToggleTheme,
  onRefresh,
  onOpenSettings,
  theme,
}: CommandPaletteProps): ReactElement | null {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<readonly CommandItem[]>(() => [
    {
      id: "tab-analytics",
      title: "View Fleet Analytics",
      category: "Navigation",
      icon: ChartLine,
      run: () => { onSelectTab("analytics"); onClose(); },
    },
    {
      id: "tab-routing",
      title: "View Routing Pools & Dispatch Ladder",
      category: "Navigation",
      icon: Layers,
      run: () => { onSelectTab("routing"); onClose(); },
    },
    {
      id: "tab-playground",
      title: "Open Interactive Playground",
      category: "Navigation",
      icon: MessageSquare,
      run: () => { onSelectTab("playground"); onClose(); },
    },
    {
      id: "tab-keys",
      title: "View Keys & Provider Management",
      category: "Navigation",
      icon: KeyRound,
      run: () => { onSelectTab("keys"); onClose(); },
    },
    {
      id: "tab-agents",
      title: "View Agent Connection Hub",
      category: "Navigation",
      icon: Bot,
      run: () => { onSelectTab("agents"); onClose(); },
    },
    {
      id: "action-theme",
      title: `Switch to ${theme === "light" ? "Dark" : "Light"} Theme`,
      category: "Actions",
      icon: theme === "light" ? Moon : Sun,
      run: () => { onToggleTheme(); onClose(); },
    },
    {
      id: "action-refresh",
      title: "Refresh Telemetry Snapshot",
      category: "Actions",
      icon: RefreshCw,
      run: () => { onRefresh(); onClose(); },
    },
    {
      id: "action-settings",
      title: "Open Dashboard Settings",
      category: "Actions",
      icon: Settings,
      run: () => { onOpenSettings?.(); onClose(); },
    },
    {
      id: "action-copy-url",
      title: "Copy Base URL (http://127.0.0.1:8791)",
      category: "Actions",
      icon: Copy,
      run: () => {
        void navigator.clipboard?.writeText("http://127.0.0.1:8791");
        onClose();
      },
    },
  ], [onClose, onOpenSettings, onRefresh, onSelectTab, onToggleTheme, theme]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((cmd) => cmd.title.toLowerCase().includes(q) || cmd.category.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((prev) => (filtered.length === 0 ? 0 : (prev + 1) % filtered.length));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((prev) => (filtered.length === 0 ? 0 : (prev - 1 + filtered.length) % filtered.length));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const selected = filtered[active];
        if (selected) selected.run();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, filtered, onClose, open]);

  if (!open) return null;

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Command Palette"
        style={{ maxWidth: "560px", padding: 0, overflow: "hidden" }}
      >
        <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)", padding: "0.75rem 1rem", gap: "0.5rem" }}>
          <Search size={18} style={{ color: "var(--muted-foreground)", flexShrink: 0 }} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Type a command or jump to page…"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "inherit",
              fontSize: "0.95rem",
            }}
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close command palette"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted-foreground)", display: "flex" }}
          >
            <X size={18} />
          </button>
        </div>
        <div style={{ maxHeight: "320px", overflowY: "auto", padding: "0.5rem" }}>
          {filtered.length === 0 ? (
            <p style={{ padding: "1.5rem", textAlign: "center", color: "var(--muted-foreground)", fontSize: "0.875rem" }}>
              No commands matching &ldquo;{query}&rdquo;
            </p>
          ) : (
            filtered.map((cmd, index) => {
              const Icon = cmd.icon;
              const isSelected = index === active;
              return (
                <div
                  key={cmd.id}
                  onClick={() => cmd.run()}
                  onMouseEnter={() => setActive(index)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                    padding: "0.5rem 0.75rem",
                    borderRadius: "0.375rem",
                    cursor: "pointer",
                    backgroundColor: isSelected ? "var(--accent)" : "transparent",
                    color: isSelected ? "var(--accent-foreground)" : "inherit",
                    fontSize: "0.875rem",
                  }}
                >
                  <Icon size={16} style={{ flexShrink: 0, opacity: 0.7 }} aria-hidden="true" />
                  <span style={{ flex: 1 }}>{cmd.title}</span>
                  <span style={{ fontSize: "0.75rem", opacity: 0.5 }}>{cmd.category}</span>
                </div>
              );
            })
          )}
        </div>
        <div style={{ borderTop: "1px solid var(--border)", padding: "0.5rem 1rem", fontSize: "0.75rem", color: "var(--muted-foreground)", display: "flex", justifyContent: "space-between" }}>
          <span>Navigate with &uarr; &darr;</span>
          <span>Execute with &crarr; &middot; Dismiss with Esc</span>
        </div>
      </div>
    </div>
  );
}
