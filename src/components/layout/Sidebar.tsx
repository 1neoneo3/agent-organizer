import { NavLink } from "react-router";
import type { ReactNode } from "react";
import { CheckSquare, Compass, Users, Settings, Sun, Moon, Plus, UserPlus, PanelLeftClose } from "lucide-react";
import type { Flavor, Palette, PaletteMeta, TimeOfDay } from "../../hooks/useTheme.js";

type NavItem = { to: string; label: string; icon: ReactNode };

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Tasks", icon: <CheckSquare size={16} /> },
  { to: "/directives", label: "Directives", icon: <Compass size={16} /> },
  { to: "/agents", label: "Agents", icon: <Users size={16} /> },
  { to: "/settings", label: "Settings", icon: <Settings size={16} /> },
];

interface SidebarProps {
  connected: boolean;
  theme: "dark" | "light";
  toggleTheme: () => void;
  flavor: Flavor;
  setFlavor: (f: Flavor) => void;
  palette: Palette;
  setPalette: (p: Palette) => void;
  palettes: ReadonlyArray<PaletteMeta>;
  timeOfDay: TimeOfDay;
  toggleTimeOfDay: () => void;
  flavors: readonly Flavor[];
  onCollapse?: () => void;
}

export function Sidebar({ connected, palette, setPalette, palettes, timeOfDay, toggleTimeOfDay, onCollapse }: SidebarProps) {
  return (
    <aside
      className="flex flex-col h-full"
      style={{
        width: "232px",
        background: "var(--bg-secondary)",
        borderRight: "1px solid var(--border-default)",
      }}
    >
      {/* Header */}
      <div style={{
        padding: "20px 16px 16px",
        display: "flex",
        alignItems: "center",
        gap: "10px",
      }}>
        <div style={{
          width: "28px",
          height: "28px",
          borderRadius: "8px",
          background: "linear-gradient(135deg, var(--accent-primary), var(--accent-hover))",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 2px 8px var(--accent-glow)",
        }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 8l4 4 8-8" />
          </svg>
        </div>
        <span style={{
          flex: 1,
          fontSize: "14px",
          fontWeight: 600,
          color: "var(--text-primary)",
          letterSpacing: "-0.03em",
        }}>
          Agent Organizer
        </span>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title="Hide sidebar"
            aria-label="Hide sidebar"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "4px",
              background: "transparent",
              border: "none",
              borderRadius: "4px",
              color: "var(--text-tertiary)",
              cursor: "pointer",
              lineHeight: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}
          >
            <PanelLeftClose size={16} />
          </button>
        )}
      </div>

      {/* Connection status */}
      <div style={{
        padding: "0 16px 16px",
      }}>
        <span style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "11px",
          fontWeight: 500,
          color: "var(--text-tertiary)",
        }}>
          <span style={{
            display: "inline-block",
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: connected ? "#22c55e" : "#ef4444",
            boxShadow: connected ? "0 0 6px rgba(34, 197, 94, 0.4)" : "0 0 6px rgba(239, 68, 68, 0.4)",
          }} />
          {connected ? "Connected" : "Disconnected"}
        </span>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, padding: "0 8px", display: "flex", flexDirection: "column", gap: "1px" }}>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            style={({ isActive }) => ({
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "8px 10px",
              fontSize: "13px",
              fontWeight: isActive ? 500 : 400,
              color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
              background: isActive ? "var(--bg-hover)" : "transparent",
              textDecoration: "none",
              borderRadius: "8px",
              transition: "all 0.15s ease",
              cursor: "pointer",
            })}
            onMouseEnter={(e) => {
              const link = e.currentTarget;
              if (!link.style.background || link.style.background === "transparent") {
                link.style.background = "var(--bg-hover)";
              }
            }}
            onMouseLeave={(e) => {
              const link = e.currentTarget;
              if (link.style.fontWeight !== "500") {
                link.style.background = "transparent";
              }
            }}
          >
            <span style={{ width: "20px", display: "flex", justifyContent: "center", opacity: 0.5 }}>{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Action buttons */}
      <div style={{ padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: "6px" }}>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent("ao:new-task"))}
          className="eb-btn eb-btn--primary"
          style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", fontSize: "12px" }}
        >
          <Plus size={14} /> New Task
        </button>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent("ao:new-agent"))}
          className="eb-btn"
          style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", fontSize: "12px" }}
        >
          <UserPlus size={14} /> New Agent
        </button>
      </div>

      {/* Theme picker */}
      <div style={{ padding: "12px 16px 0", borderTop: "1px solid var(--border-subtle)" }}>
        <div style={{
          fontSize: "10px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-tertiary)",
          marginBottom: "8px",
        }}>
          Theme
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {palettes.map((p) => {
            const active = palette === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPalette(p.id)}
                title={p.label}
                aria-label={`Use ${p.label} theme`}
                aria-pressed={active}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "4px 8px 4px 4px",
                  background: active ? "var(--bg-tertiary)" : "transparent",
                  border: "1px solid " + (active ? "var(--accent-primary)" : "var(--border-subtle)"),
                  borderRadius: "999px",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    width: "16px",
                    height: "16px",
                    borderRadius: "50%",
                    // Two-tone split circle: left half = primary, right half = secondary
                    background: `linear-gradient(90deg, ${p.primary} 0 50%, ${p.secondary} 50% 100%)`,
                    border: "1px solid rgba(0,0,0,0.08)",
                    flexShrink: 0,
                  }}
                />
                <span style={{
                  fontSize: "11px",
                  fontWeight: active ? 600 : 500,
                  color: active ? "var(--text-primary)" : "var(--text-secondary)",
                }}>
                  {p.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Day/Night Toggle */}
      <div style={{ padding: "12px 16px 20px" }}>
        <button
          onClick={toggleTimeOfDay}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            padding: "8px 12px",
            fontSize: "12px",
            fontWeight: 500,
            color: "var(--text-secondary)",
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-default)",
            borderRadius: "8px",
            cursor: "pointer",
            boxShadow: "var(--shadow-sm)",
            transition: "all 0.15s ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.boxShadow = "var(--shadow-md)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "var(--shadow-sm)"; }}
        >
          {timeOfDay === "night" ? <Sun size={14} /> : <Moon size={14} />}
          {timeOfDay === "night" ? "Light Mode" : "Dark Mode"}
        </button>
      </div>
    </aside>
  );
}
