import { NavLink } from "react-router";

const NAV_ITEMS = [
  { to: "/", label: "Tasks", icon: "📋" },
  { to: "/agents", label: "Agents", icon: "🤖" },
  { to: "/settings", label: "Settings", icon: "⚙️" },
];

interface SidebarProps {
  connected: boolean;
  theme: "dark" | "light";
  toggleTheme: () => void;
}

export function Sidebar({ connected, theme, toggleTheme }: SidebarProps) {
  return (
    <aside className="w-56 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 border-r border-gray-200 dark:border-gray-800 flex flex-col h-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <h1 className="text-lg font-bold">Agent Organizer</h1>
        <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-500 dark:text-gray-400">
          <span
            className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`}
          />
          {connected ? "Connected" : "Disconnected"}
        </div>
      </div>
      <nav className="flex-1 py-2">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-2 px-4 py-2.5 text-sm transition-colors ${
                isActive
                  ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white border-l-2 border-blue-500 dark:border-blue-400"
                  : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white border-l-2 border-transparent"
              }`
            }
          >
            <span>{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="p-3 border-t border-gray-200 dark:border-gray-700">
        <button
          onClick={toggleTheme}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm rounded transition-colors text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white"
        >
          <span>{theme === "dark" ? "☀️" : "🌙"}</span>
          {theme === "dark" ? "Light Mode" : "Dark Mode"}
        </button>
      </div>
    </aside>
  );
}
