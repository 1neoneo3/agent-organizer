import { NavLink } from "react-router";
import type { ReactNode } from "react";
import type { Flavor, TimeOfDay } from "../../hooks/useTheme.js";

function PixelHuman() {
  const B = "#1e293b";
  const SK = "#f8c8a0";
  const pixels: [number, number, string][] = [
    [6,0,B],[7,0,B],[8,0,B],[9,0,B],
    [5,1,B],[6,1,"#5c3a1e"],[7,1,"#5c3a1e"],[8,1,"#5c3a1e"],[9,1,"#5c3a1e"],[10,1,B],
    [4,2,B],[5,2,"#5c3a1e"],[6,2,"#5c3a1e"],[7,2,"#5c3a1e"],[8,2,"#5c3a1e"],[9,2,"#5c3a1e"],[10,2,"#5c3a1e"],[11,2,B],
    [4,3,B],[5,3,SK],[6,3,SK],[7,3,SK],[8,3,SK],[9,3,SK],[10,3,SK],[11,3,B],
    [4,4,B],[5,4,SK],[6,4,B],[7,4,SK],[8,4,SK],[9,4,B],[10,4,SK],[11,4,B],
    [4,5,B],[5,5,SK],[6,5,SK],[7,5,SK],[8,5,SK],[9,5,SK],[10,5,SK],[11,5,B],
    [5,6,B],[6,6,SK],[7,6,SK],[8,6,SK],[9,6,SK],[10,6,B],
    [4,7,B],[5,7,"#7c3aed"],[6,7,"#7c3aed"],[7,7,"#7c3aed"],[8,7,"#7c3aed"],[9,7,"#7c3aed"],[10,7,"#7c3aed"],[11,7,B],
    [3,8,B],[4,8,SK],[5,8,"#7c3aed"],[6,8,"#7c3aed"],[7,8,"#7c3aed"],[8,8,"#7c3aed"],[9,8,"#7c3aed"],[10,8,"#7c3aed"],[11,8,SK],[12,8,B],
    [5,9,B],[6,9,"#6b21a8"],[7,9,"#6b21a8"],[8,9,"#6b21a8"],[9,9,"#6b21a8"],[10,9,B],
    [5,10,B],[6,10,"#1e3a5f"],[7,10,B],[8,10,B],[9,10,"#1e3a5f"],[10,10,B],
    [4,11,B],[5,11,"#4a2c0a"],[6,11,"#4a2c0a"],[9,11,"#4a2c0a"],[10,11,"#4a2c0a"],[11,11,B],
  ];

  return (
    <svg width="28" height="28" viewBox="0 0 16 14" shapeRendering="crispEdges" className="w-7 h-7">
      {pixels.map(([x, y, fill], i) => (
        <rect key={i} x={x} y={y} width={1} height={1} fill={fill} />
      ))}
    </svg>
  );
}

type NavItem = { to: string; label: string; rpgLabel: string; icon: ReactNode };

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Tasks", rpgLabel: "QUESTS", icon: <span style={{ fontFamily: "var(--eb-font-heading)", fontSize: "10px" }}>Q</span> },
  { to: "/directives", label: "Directives", rpgLabel: "ORDERS", icon: <span style={{ fontFamily: "var(--eb-font-heading)", fontSize: "10px" }}>O</span> },
  { to: "/agents", label: "Agents", rpgLabel: "PARTY", icon: <PixelHuman /> },
  { to: "/settings", label: "Settings", rpgLabel: "CONFIG", icon: <span style={{ fontFamily: "var(--eb-font-heading)", fontSize: "10px" }}>C</span> },
];

const FLAVOR_COLORS: Record<Flavor, string> = {
  mint: "#48d8a0",
  strawberry: "#f06888",
  banana: "#f0d848",
  peanut: "#d0a060",
  blueberry: "#60a8ff",
  plain: "#9898b0",
};

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

export function Sidebar({ connected, flavor, setFlavor, timeOfDay, toggleTimeOfDay, flavors }: SidebarProps) {
  return (
    <aside className="w-56 flex flex-col h-full eb-window" style={{ borderRadius: "0 8px 8px 0" }}>
      {/* Header */}
      <div className="eb-window-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>AGENT ORGANIZER</span>
      </div>

      {/* Connection status */}
      <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--eb-border-in)", background: "var(--eb-bg-deep)" }}>
        <span className="eb-label" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{
            display: "inline-block",
            width: "6px",
            height: "6px",
            borderRadius: "1px",
            background: connected ? "#48d8a0" : "#e04040",
            boxShadow: connected ? "0 0 4px #48d8a0" : "0 0 4px #e04040",
          }} />
          {connected ? "ONLINE" : "OFFLINE"}
        </span>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, padding: "4px 0" }}>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              isActive ? "eb-cursor" : ""
            }
            style={({ isActive }) => ({
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "8px 12px",
              fontFamily: "var(--eb-font-heading)",
              fontSize: "9px",
              letterSpacing: "1px",
              color: isActive ? "var(--eb-highlight)" : "var(--eb-text)",
              background: isActive ? "var(--eb-bg-deep)" : "transparent",
              textDecoration: "none",
              transition: "background 0.1s",
              cursor: "pointer",
            })}
            onMouseEnter={(e) => {
              if (!e.currentTarget.classList.contains("eb-cursor")) {
                e.currentTarget.style.background = "var(--eb-bg-deep)";
              }
            }}
            onMouseLeave={(e) => {
              if (!e.currentTarget.classList.contains("eb-cursor")) {
                e.currentTarget.style.background = "transparent";
              }
            }}
          >
            <span style={{ width: "28px", display: "flex", justifyContent: "center" }}>{item.icon}</span>
            {item.rpgLabel}
          </NavLink>
        ))}
      </nav>

      {/* Flavor Picker */}
      <div style={{ padding: "8px 12px", borderTop: "2px solid var(--eb-border-in)" }}>
        <div className="eb-label" style={{ marginBottom: "6px" }}>FLAVOR</div>
        <div style={{ display: "flex", gap: "6px" }}>
          {flavors.map((f) => (
            <button
              key={f}
              onClick={() => setFlavor(f)}
              className={`eb-swatch ${flavor === f ? "eb-swatch--active" : ""}`}
              style={{ background: FLAVOR_COLORS[f] }}
              title={f.charAt(0).toUpperCase() + f.slice(1)}
            />
          ))}
        </div>
      </div>

      {/* Day/Night Toggle */}
      <div style={{ padding: "8px 12px", borderTop: "1px solid var(--eb-border-in)" }}>
        <button
          onClick={toggleTimeOfDay}
          className="eb-btn"
          style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
        >
          <span style={{ fontSize: "14px", imageRendering: "pixelated" }}>
            {timeOfDay === "night" ? "☀" : "☾"}
          </span>
          {timeOfDay === "night" ? "DAY" : "NIGHT"}
        </button>
      </div>
    </aside>
  );
}
