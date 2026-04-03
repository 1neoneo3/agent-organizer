import { Outlet } from "react-router";
import { Sidebar } from "./Sidebar.js";
import type { Flavor, TimeOfDay } from "../../hooks/useTheme.js";

interface AppLayoutProps {
  connected: boolean;
  theme: "dark" | "light";
  toggleTheme: () => void;
  flavor: Flavor;
  setFlavor: (f: Flavor) => void;
  timeOfDay: TimeOfDay;
  toggleTimeOfDay: () => void;
  flavors: readonly Flavor[];
}

export function AppLayout({ connected, theme, toggleTheme, flavor, setFlavor, timeOfDay, toggleTimeOfDay, flavors }: AppLayoutProps) {
  return (
    <div className="flex h-screen eb-overworld-bg" style={{ color: "var(--text-primary)" }}>
      <Sidebar
        connected={connected}
        theme={theme}
        toggleTheme={toggleTheme}
        flavor={flavor}
        setFlavor={setFlavor}
        timeOfDay={timeOfDay}
        toggleTimeOfDay={toggleTimeOfDay}
        flavors={flavors}
      />
      <main className="flex-1 min-h-0 overflow-y-auto animated-mesh-bg" style={{ padding: "28px 40px", backgroundImage: "linear-gradient(135deg, transparent 0%, rgba(139, 92, 246, 0.025) 25%, transparent 45%, rgba(59, 130, 246, 0.02) 65%, rgba(168, 85, 247, 0.015) 85%, transparent 100%)" }}>
        <Outlet />
      </main>
    </div>
  );
}
