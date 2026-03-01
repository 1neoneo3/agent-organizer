import { Outlet } from "react-router";
import { Sidebar } from "./Sidebar.js";

interface AppLayoutProps {
  connected: boolean;
  theme: "dark" | "light";
  toggleTheme: () => void;
}

export function AppLayout({ connected, theme, toggleTheme }: AppLayoutProps) {
  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <Sidebar connected={connected} theme={theme} toggleTheme={toggleTheme} />
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
