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
      <main className="flex-1 min-h-0 overflow-y-auto" style={{ padding: "28px 36px" }}>
        <Outlet />
      </main>
    </div>
  );
}
