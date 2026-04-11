import { useCallback, useEffect, useState } from "react";
import { Outlet } from "react-router";
import { PanelLeftOpen } from "lucide-react";
import { Sidebar } from "./Sidebar.js";
import type { Flavor, Palette, PaletteMeta, TimeOfDay } from "../../hooks/useTheme.js";

interface AppLayoutProps {
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
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = "ao:sidebar-collapsed";

/** Width of the invisible hot zone that reveals the show-sidebar button. */
const HOT_ZONE_WIDTH_PX = 56;

function loadCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
}

export function AppLayout({ connected, theme, toggleTheme, flavor, setFlavor, palette, setPalette, palettes, timeOfDay, toggleTimeOfDay, flavors }: AppLayoutProps) {
  const [collapsed, setCollapsedState] = useState<boolean>(loadCollapsed);
  const [nearLeftEdge, setNearLeftEdge] = useState(false);
  const [revealButtonFocused, setRevealButtonFocused] = useState(false);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
    }
  }, []);

  // While the sidebar is hidden, track the pointer position near the left
  // edge of the viewport so the reveal button fades in on hover-intent. We
  // skip the listener when the sidebar is visible to avoid unnecessary work.
  useEffect(() => {
    if (!collapsed) return;
    const handleMove = (event: MouseEvent) => {
      setNearLeftEdge(event.clientX < HOT_ZONE_WIDTH_PX);
    };
    const handleLeave = () => setNearLeftEdge(false);
    window.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseleave", handleLeave);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseleave", handleLeave);
      setNearLeftEdge(false);
    };
  }, [collapsed]);

  const revealButtonVisible = nearLeftEdge || revealButtonFocused;

  return (
    <div
      className="flex h-screen"
      style={{
        background: "var(--bg-primary)",
        color: "var(--text-primary)",
        // Exposes sidebar width to fixed-position children (e.g. the pinned
        // task detail panel) so they can offset themselves correctly when
        // the sidebar is hidden.
        ["--ao-sidebar-width" as string]: collapsed ? "0px" : "232px",
      }}
    >
      {!collapsed && (
        <Sidebar
          connected={connected}
          theme={theme}
          toggleTheme={toggleTheme}
          flavor={flavor}
          setFlavor={setFlavor}
          palette={palette}
          setPalette={setPalette}
          palettes={palettes}
          timeOfDay={timeOfDay}
          toggleTimeOfDay={toggleTimeOfDay}
          flavors={flavors}
          onCollapse={() => setCollapsed(true)}
        />
      )}
      <main className="flex-1 min-h-0 overflow-y-auto" style={{ padding: "24px 32px" }}>
        <Outlet />
      </main>
      {collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          onFocus={() => setRevealButtonFocused(true)}
          onBlur={() => setRevealButtonFocused(false)}
          title="Show sidebar"
          aria-label="Show sidebar"
          style={{
            position: "fixed",
            top: "12px",
            left: "12px",
            zIndex: 60,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "32px",
            height: "32px",
            padding: 0,
            background: "var(--bg-secondary)",
            color: "var(--text-secondary)",
            border: "1px solid var(--border-default)",
            borderRadius: "8px",
            cursor: "pointer",
            boxShadow: "var(--shadow-sm)",
            opacity: revealButtonVisible ? 1 : 0,
            transform: revealButtonVisible ? "translateX(0)" : "translateX(-4px)",
            pointerEvents: revealButtonVisible ? "auto" : "none",
            transition: "opacity 180ms ease, transform 180ms ease, color 0.15s ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-secondary)"; }}
        >
          <PanelLeftOpen size={16} />
        </button>
      )}
    </div>
  );
}
