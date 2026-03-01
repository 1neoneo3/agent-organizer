import { NavLink } from "react-router";
import type { ReactNode } from "react";

function PixelHuman() {
  // 16x16 pixel art RPG character
  const pixels: [number, number, string][] = [
    // Hat (purple wizard hat)
    [7,0,"#6b21a8"],[8,0,"#6b21a8"],
    [6,1,"#7c3aed"],[7,1,"#7c3aed"],[8,1,"#7c3aed"],[9,1,"#7c3aed"],
    [5,2,"#7c3aed"],[6,2,"#7c3aed"],[7,2,"#7c3aed"],[8,2,"#7c3aed"],[9,2,"#7c3aed"],[10,2,"#7c3aed"],
    // Hat brim
    [4,3,"#6b21a8"],[5,3,"#6b21a8"],[6,3,"#6b21a8"],[7,3,"#6b21a8"],[8,3,"#6b21a8"],[9,3,"#6b21a8"],[10,3,"#6b21a8"],[11,3,"#6b21a8"],
    // Face (skin)
    [6,4,"#f5c5a3"],[7,4,"#f5c5a3"],[8,4,"#f5c5a3"],[9,4,"#f5c5a3"],
    // Eyes
    [7,4,"#222"],[9,4,"#222"],
    // Beard (white)
    [6,5,"#e5e7eb"],[7,5,"#f5c5a3"],[8,5,"#f5c5a3"],[9,5,"#e5e7eb"],
    [7,6,"#e5e7eb"],[8,6,"#e5e7eb"],
    // Robe (purple)
    [5,6,"#7c3aed"],[6,6,"#7c3aed"],[9,6,"#7c3aed"],[10,6,"#7c3aed"],
    [5,7,"#7c3aed"],[6,7,"#7c3aed"],[7,7,"#7c3aed"],[8,7,"#7c3aed"],[9,7,"#7c3aed"],[10,7,"#7c3aed"],
    [5,8,"#6b21a8"],[6,8,"#6b21a8"],[7,8,"#6b21a8"],[8,8,"#6b21a8"],[9,8,"#6b21a8"],[10,8,"#6b21a8"],
    [5,9,"#7c3aed"],[6,9,"#7c3aed"],[7,9,"#7c3aed"],[8,9,"#7c3aed"],[9,9,"#7c3aed"],[10,9,"#7c3aed"],
    [5,10,"#6b21a8"],[6,10,"#6b21a8"],[7,10,"#6b21a8"],[8,10,"#6b21a8"],[9,10,"#6b21a8"],[10,10,"#6b21a8"],
    // Boots
    [6,11,"#4a2c0a"],[7,11,"#4a2c0a"],[8,11,"#4a2c0a"],[9,11,"#4a2c0a"],
    // Arms (skin)
    [4,7,"#f5c5a3"],[11,7,"#f5c5a3"],
    // Staff (right hand)
    [12,3,"#d4a017"],[12,4,"#92400e"],[12,5,"#92400e"],[12,6,"#92400e"],[12,7,"#92400e"],[12,8,"#92400e"],
    // Magic sparkle (left hand)
    [3,6,"#fbbf24"],[3,8,"#fbbf24"],[2,7,"#fbbf24"],[4,6,"#fbbf24"],
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
