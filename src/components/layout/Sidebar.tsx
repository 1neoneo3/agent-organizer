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
        width: "220px",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
      }}
    >
      {/* Header */}
      <div style={{
        padding: "16px 16px 12px",
        display: "flex",
        alignItems: "center",
        gap: "10px",
      }}>
        <div className="logo-float" style={{
          width: "28px",
          height: "28px",
          borderRadius: "10px",
          background: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 0 16px rgba(139, 92, 246, 0.4)",
        }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2">
            <path d="M2 8l4 4 8-8" />
          </svg>
        </div>
        <span style={{
          fontSize: "15px",
          fontWeight: 700,
          letterSpacing: "-0.02em",
          background: "linear-gradient(135deg, #ececf4 0%, #a78bfa 100%)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
        }}>
          Agent Organizer
        </span>
      </div>

      {/* Connection status */}
      <div style={{
        padding: "0 16px 14px",
      }}>
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "11px",
          fontWeight: 500,
          padding: "4px 10px",
          borderRadius: "999px",
          background: connected ? "rgba(34, 197, 94, 0.1)" : "rgba(239, 68, 68, 0.1)",
          color: connected ? "#4ade80" : "#f87171",
        }}>
          <span className={connected ? "status-dot-pulse" : ""} style={{
            display: "inline-block",
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: connected ? "#22c55e" : "#ef4444",
            boxShadow: connected ? "0 0 8px rgba(34, 197, 94, 0.4)" : "none",
          }} />
          {connected ? "Connected" : "Disconnected"}
        </span>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, padding: "0 8px" }}>
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
              padding: "8px 10px",
              fontSize: "13px",
              fontWeight: isActive ? 500 : 400,
              color: isActive ? "#ececf4" : "var(--text-secondary)",
              textDecoration: "none",
              borderRadius: "8px",
              borderLeft: isActive ? undefined : "2px solid transparent",
              transition: "all 0.2s ease",
              cursor: "pointer",
              marginBottom: "2px",
            })}
            onMouseEnter={(e) => {
              const link = e.currentTarget;
              if (!link.classList.contains("nav-active-glow")) {
                link.style.background = "rgba(255, 255, 255, 0.04)";
                link.style.color = "var(--text-primary)";
              }
            }}
            onMouseLeave={(e) => {
              const link = e.currentTarget;
              if (!link.classList.contains("nav-active-glow")) {
                link.style.background = "transparent";
                link.style.color = "var(--text-secondary)";
              }
            }}
          >
            <span className="nav-icon">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Day/Night Toggle */}
      <div style={{ padding: "12px 16px 16px", borderTop: "1px solid rgba(255, 255, 255, 0.04)" }}>
        <button
          onClick={toggleTimeOfDay}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
            padding: "8px 12px",
            fontSize: "12px",
            fontWeight: 500,
            color: "var(--text-secondary)",
            background: "var(--glass-bg)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: "1px solid var(--glass-border)",
            borderRadius: "10px",
            cursor: "pointer",
            transition: "all 0.2s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(139, 92, 246, 0.1)";
            e.currentTarget.style.borderColor = "rgba(139, 92, 246, 0.3)";
            e.currentTarget.style.boxShadow = "0 0 12px rgba(139, 92, 246, 0.1)";
            e.currentTarget.style.transform = "translateY(-1px)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--glass-bg)";
            e.currentTarget.style.borderColor = "var(--glass-border)";
            e.currentTarget.style.boxShadow = "none";
            e.currentTarget.style.transform = "translateY(0)";
            e.currentTarget.style.color = "var(--text-secondary)";
          }}
        >
          {timeOfDay === "night" ? "Light Mode" : "Dark Mode"}
        </button>
      </div>
    </aside>
  );
}
