import { BrowserRouter, Routes, Route, useNavigate } from "react-router";
import { AppLayout } from "./components/layout/AppLayout.js";
import { TaskBoard } from "./components/tasks/TaskBoard.js";
import { AgentList } from "./components/agents/AgentList.js";
import { DirectivesPage } from "./components/directives/DirectivesPage.js";
import { SettingsPanel } from "./components/settings/SettingsPanel.js";
import { InteractivePromptToast } from "./components/layout/InteractivePromptToast.js";
import { useAppData } from "./hooks/useAppData.js";
import { useTheme } from "./hooks/useTheme.js";

function AppRoutes() {
  const { agents, tasks, directives, settings, cliStatus, interactivePrompts, loading, connected, reload, on } = useAppData();
  const { theme, toggleTheme, flavor, setFlavor, timeOfDay, toggleTimeOfDay, flavors } = useTheme();
  const navigate = useNavigate();

  const handleNavigateToTask = (taskId: string) => {
    void navigate(`/?task=${taskId}`);
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: "var(--eb-bg)", color: "var(--eb-text-sub)" }}>
        <span className="eb-heading" style={{ fontSize: "12px" }}>Loading...</span>
      </div>
    );
  }

  return (
    <>
      <Routes>
        <Route element={
          <AppLayout
            connected={connected}
            theme={theme}
            toggleTheme={toggleTheme}
            flavor={flavor}
            setFlavor={setFlavor}
            timeOfDay={timeOfDay}
            toggleTimeOfDay={toggleTimeOfDay}
            flavors={flavors}
          />
        }>
          <Route
            index
            element={<TaskBoard tasks={tasks} agents={agents} interactivePrompts={interactivePrompts} onReload={reload} />}
          />
          <Route
            path="directives"
            element={<DirectivesPage directives={directives} tasks={tasks} onReload={reload} onWsEvent={on} />}
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
      <InteractivePromptToast
        interactivePrompts={interactivePrompts}
        tasks={tasks}
        onNavigateToTask={handleNavigateToTask}
      />
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
