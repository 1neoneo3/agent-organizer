import { NavLink } from "react-router";
import type { ReactNode } from "react";
import type { Flavor, TimeOfDay } from "../../hooks/useTheme.js";

type NavItem = { to: string; label: string; icon: ReactNode };

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Tasks", icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M5 8l2 2 4-4" /></svg> },
  { to: "/directives", label: "Directives", icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 2h8l2 3-6 9-6-9z" /></svg> },
  { to: "/office", label: "Office", icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="6" width="12" height="8" rx="1" /><path d="M4 6V4a4 4 0 018 0v2" /></svg> },
  { to: "/agents", label: "Agents", icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="5" r="3" /><path d="M2 14c0-3 2.5-5 6-5s6 2 6 5" /></svg> },
  { to: "/settings", label: "Settings", icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="2" /><path d="M8 1v2m0 10v2M1 8h2m10 0h2M2.9 2.9l1.4 1.4m7.4 7.4l1.4 1.4M13.1 2.9l-1.4 1.4M4.3 11.7l-1.4 1.4" /></svg> },
];

interface SidebarProps {
  connected: boolean;
  theme: "dark" | "light";
  toggleTheme: () => void;
  flavor: Flavor;
  setFlavor: (f: Flavor) => void;
  timeOfDay: TimeOfDay;
  toggleTimeOfDay: () => void;
  flavors: readonly Flavor[];
}

export function Sidebar({ connected, timeOfDay, toggleTimeOfDay }: SidebarProps) {
  return (
    <aside
      className="sidebar-gradient flex flex-col h-full"
      style={{
        width: "230px",
        borderRight: "1px solid var(--border-subtle)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
      }}
    >
      {/* Header */}
      <div style={{
        padding: "22px 18px 16px",
        display: "flex",
        alignItems: "center",
        gap: "12px",
      }}>
        <div className="logo-float" style={{
          width: "36px",
          height: "36px",
          borderRadius: "12px",
          background: "linear-gradient(135deg, #8b5cf6 0%, #6366f1 40%, #3b82f6 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 6px 20px rgba(139, 92, 246, 0.45), 0 0 32px rgba(139, 92, 246, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.2)",
        }}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2">
            <path d="M2 8l4 4 8-8" />
          </svg>
        </div>
        <span style={{
          fontSize: "15px",
          fontWeight: 700,
          letterSpacing: "-0.02em",
          background: "linear-gradient(135deg, var(--text-primary) 0%, var(--accent-primary) 60%, #6366f1 100%)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          backgroundClip: "text",
        }}>
          Agent Organizer
        </span>
      </div>

      {/* Connection status */}
      <div style={{
        padding: "0 18px 14px",
      }}>
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "11px",
          fontWeight: 500,
          color: "var(--text-tertiary)",
          padding: "4px 10px",
          borderRadius: "999px",
          background: connected ? "rgba(34, 197, 94, 0.08)" : "rgba(239, 68, 68, 0.08)",
        }}>
          <span
            className={connected ? "status-dot-pulse" : ""}
            style={{
              display: "inline-block",
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: connected ? "#22c55e" : "#ef4444",
            }}
          />
          {connected ? "Connected" : "Disconnected"}
        </span>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, padding: "0 10px" }}>
        <div className="sidebar-section-label">Navigation</div>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) => isActive ? "nav-active-glow" : ""}
            style={({ isActive }) => ({
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "9px 12px",
              fontSize: "13px",
              fontWeight: isActive ? 600 : 400,
              color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
              background: isActive ? undefined : "transparent",
              textDecoration: "none",
              borderRadius: "10px",
              transition: "all 0.2s ease",
              cursor: "pointer",
              marginBottom: "2px",
              borderLeft: isActive ? undefined : "3px solid transparent",
            })}
            onMouseEnter={(e) => {
              const link = e.currentTarget;
              if (!link.classList.contains("nav-active-glow")) {
                link.style.background = "var(--bg-hover)";
              }
            }}
            onMouseLeave={(e) => {
              const link = e.currentTarget;
              if (!link.classList.contains("nav-active-glow")) {
                link.style.background = "transparent";
              }
            }}
          >
            <span className="nav-icon" style={{ width: "20px", display: "flex", justifyContent: "center", color: "var(--text-tertiary)", transition: "color 0.2s ease" }}>{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Day/Night Toggle */}
      <div style={{ padding: "12px 16px 18px", borderTop: "1px solid var(--border-subtle)" }}>
        <button
          onClick={toggleTimeOfDay}
          className="eb-btn"
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            padding: "10px 12px",
            fontSize: "12px",
            fontWeight: 500,
            color: "var(--text-secondary)",
            background: "var(--glass-bg)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            border: "1px solid var(--glass-border)",
            borderRadius: "12px",
            cursor: "pointer",
            transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
            boxShadow: "0 2px 10px rgba(0, 0, 0, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.transform = "translateY(-1px)";
            e.currentTarget.style.boxShadow = "0 6px 16px rgba(0, 0, 0, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.08)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--glass-bg)";
            e.currentTarget.style.transform = "translateY(0)";
            e.currentTarget.style.boxShadow = "0 2px 10px rgba(0, 0, 0, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.05)";
          }}
        >
          <span style={{ fontSize: "14px" }}>{timeOfDay === "night" ? "\u2600" : "\u263E"}</span>
          {timeOfDay === "night" ? "Light Mode" : "Dark Mode"}
        </button>
      </div>
    </aside>
  );
}
