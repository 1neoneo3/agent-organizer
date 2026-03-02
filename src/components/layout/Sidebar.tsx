import { NavLink } from "react-router";
import type { ReactNode } from "react";

function PixelHuman() {
  // 16x16 Mother 2 style party member (young adventurer)
  const B = "#1e293b";
  const SK = "#f8c8a0";
  const pixels: [number, number, string][] = [
    // Hair (brown, tousled)
    [6,0,B],[7,0,B],[8,0,B],[9,0,B],
    [5,1,B],[6,1,"#5c3a1e"],[7,1,"#5c3a1e"],[8,1,"#5c3a1e"],[9,1,"#5c3a1e"],[10,1,B],
    [4,2,B],[5,2,"#5c3a1e"],[6,2,"#5c3a1e"],[7,2,"#5c3a1e"],[8,2,"#5c3a1e"],[9,2,"#5c3a1e"],[10,2,"#5c3a1e"],[11,2,B],
    // Face
    [4,3,B],[5,3,SK],[6,3,SK],[7,3,SK],[8,3,SK],[9,3,SK],[10,3,SK],[11,3,B],
    [4,4,B],[5,4,SK],[6,4,B],[7,4,SK],[8,4,SK],[9,4,B],[10,4,SK],[11,4,B],
    [4,5,B],[5,5,SK],[6,5,SK],[7,5,SK],[8,5,SK],[9,5,SK],[10,5,SK],[11,5,B],
    [5,6,B],[6,6,SK],[7,6,SK],[8,6,SK],[9,6,SK],[10,6,B],
    // Purple outfit (party member)
    [4,7,B],[5,7,"#7c3aed"],[6,7,"#7c3aed"],[7,7,"#7c3aed"],[8,7,"#7c3aed"],[9,7,"#7c3aed"],[10,7,"#7c3aed"],[11,7,B],
    [3,8,B],[4,8,SK],[5,8,"#7c3aed"],[6,8,"#7c3aed"],[7,8,"#7c3aed"],[8,8,"#7c3aed"],[9,8,"#7c3aed"],[10,8,"#7c3aed"],[11,8,SK],[12,8,B],
    [5,9,B],[6,9,"#6b21a8"],[7,9,"#6b21a8"],[8,9,"#6b21a8"],[9,9,"#6b21a8"],[10,9,B],
    // Legs
    [5,10,B],[6,10,"#1e3a5f"],[7,10,B],[8,10,B],[9,10,"#1e3a5f"],[10,10,B],
    // Boots
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

type NavItem = { to: string; label: string; icon: ReactNode };

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Tasks", icon: "📋" },
  { to: "/directives", label: "Directives", icon: "📢" },
  { to: "/agents", label: "Agents", icon: <PixelHuman /> },
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
