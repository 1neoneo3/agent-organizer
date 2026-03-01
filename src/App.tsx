import { BrowserRouter, Routes, Route } from "react-router";
import { AppLayout } from "./components/layout/AppLayout.js";
import { TaskBoard } from "./components/tasks/TaskBoard.js";
import { AgentList } from "./components/agents/AgentList.js";
import { DirectivesPage } from "./components/directives/DirectivesPage.js";
import { SettingsPanel } from "./components/settings/SettingsPanel.js";
import { useAppData } from "./hooks/useAppData.js";
import { useTheme } from "./hooks/useTheme.js";

export default function App() {
  const { agents, tasks, directives, settings, cliStatus, loading, connected, reload } = useAppData();
  const { theme, toggleTheme } = useTheme();

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 text-gray-500 dark:text-gray-400">
        Loading...
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout connected={connected} theme={theme} toggleTheme={toggleTheme} />}>
          <Route
            index
            element={<TaskBoard tasks={tasks} agents={agents} onReload={reload} />}
          />
          <Route
            path="directives"
            element={<DirectivesPage directives={directives} tasks={tasks} onReload={reload} />}
          />
          <Route
            path="agents"
            element={<AgentList agents={agents} cliStatus={cliStatus} onReload={reload} />}
          />
          <Route
            path="settings"
            element={<SettingsPanel settings={settings} onReload={reload} />}
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
