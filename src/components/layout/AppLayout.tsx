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
    <div className="flex h-screen" style={{ background: "var(--bg-primary)", color: "var(--text-primary)" }}>
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
      <main
        className="animated-mesh-bg flex-1 min-h-0 overflow-y-auto"
        style={{
          padding: "28px 36px",
          backgroundImage: "linear-gradient(160deg, rgba(139, 92, 246, 0.025) 0%, transparent 40%, rgba(59, 130, 246, 0.02) 80%, rgba(168, 85, 247, 0.015) 100%)",
        }}
      >
        <Outlet />
      </main>
    </div>
  );
}
