import { useCallback, useEffect, useState } from "react";
import type { Task } from "../domain/task";
import { api, type EffectiveSettings, type TypeWithRules } from "./api";
import { Board, SettledDateFilter } from "./Board";
import { Onboarding } from "./Onboarding";
import { NewTask } from "./NewTask";
import { SignIn } from "./SignIn";
import { TaskDetail } from "./TaskDetail";
import { Extensions } from "./Extensions";
import { Rules } from "./Rules";
import { Settings } from "./Settings";
import { Icon } from "./icons";
import { LANE_OF } from "./columns";
import { taskUrl, readTaskId } from "./taskUrl";

type Screen = "board" | "types" | "extensions" | "settings";

const NAV: { key: Screen; label: string; icon: string }[] = [
  { key: "board", label: "Board", icon: "board" },
  { key: "types", label: "Types & rules", icon: "rules" },
  { key: "extensions", label: "Extensions", icon: "plug" },
  { key: "settings", label: "Settings", icon: "settings" },
];

const SCREEN_TITLE: Record<Screen, string> = {
  board: "Board",
  types: "Types & rules",
  extensions: "Extensions & sources",
  settings: "Settings",
};

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [types, setTypes] = useState<TypeWithRules[]>([]);
  const [settings, setSettings] = useState<EffectiveSettings | null>(null);
  const [screen, setScreen] = useState<Screen>("board");
  const [railOpen, setRailOpen] = useState(true);
  const [hoverNav, setHoverNav] = useState<Screen | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() =>
    readTaskId(window.location.search),
  );
  const [onboardingTaskId, setOnboardingTaskId] = useState<string | null>(null);
  const [modal, setModal] = useState<"newtask" | "signin" | null>(null);
  const [settledFrom, setSettledFrom] = useState("");
  const [settledTo, setSettledTo] = useState("");

  const refresh = useCallback(async () => {
    const [nextTasks, nextTypes] = await Promise.all([api.tasks(), api.types()]);
    setTasks(nextTasks);
    setTypes(nextTypes);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    void api.settingsGet().then((r) => setSettings(r.effective));
  }, []);

  useEffect(() => {
    const onPopState = () => setSelectedTaskId(readTaskId(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const openTask = useCallback((id: string | null) => {
    setSelectedTaskId(id);
    window.history.pushState(null, "", id ? taskUrl(id) : window.location.pathname);
  }, []);

  const selectedTask = selectedTaskId ? (tasks.find((t) => t.id === selectedTaskId) ?? null) : null;
  const onboardingTask = onboardingTaskId ? (tasks.find((t) => t.id === onboardingTaskId) ?? null) : null;
  const onboardingType = onboardingTask?.typeId ? types.find((t) => t.id === onboardingTask.typeId) : undefined;

  const needsCount = tasks.filter((t) => LANE_OF[t.state] === "needs").length;
  const runningCount = tasks.filter((t) => LANE_OF[t.state] === "running").length;

  async function confirmType(taskId: string, typeId: string) {
    await api.confirmType(taskId, typeId);
    await refresh();
  }

  async function resolveDuplicate(taskId: string, isDuplicate: boolean) {
    await api.resolveDuplicate(taskId, isDuplicate);
    await refresh();
  }

  async function markDuplicate(taskId: string, ofTaskId: string) {
    await api.markDuplicate(taskId, ofTaskId);
    await refresh();
  }

  const showingOnboarding = !!(onboardingTask && onboardingType);

  return (
    <div className="app-shell">
      <aside className="rail" style={{ width: railOpen ? 212 : 56 }}>
        <div className="rail-head">
          <button className="rail-toggle" title="Collapse or expand" onClick={() => setRailOpen((v) => !v)}>
            <Icon name="panel" size={17} />
          </button>
          {railOpen && (
            <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span className="rail-wordmark">JIDOKA</span>
              <span className="mono rail-badge">local</span>
            </span>
          )}
        </div>
        <nav className="rail-nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`rail-item ${railOpen ? "open" : ""} ${screen === n.key ? "on" : ""}`}
              onClick={() => setScreen(n.key)}
              onMouseEnter={() => setHoverNav(n.key)}
              onMouseLeave={() => setHoverNav(null)}
            >
              <Icon name={n.icon} />
              {railOpen && (
                <span style={{ flex: 1, textAlign: "left" }}>
                  {n.label}
                  {n.key === "board" && needsCount > 0 ? ` (${needsCount})` : ""}
                </span>
              )}
              {!railOpen && hoverNav === n.key && <span className="tip">{n.label}</span>}
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          {railOpen ? (
            <>
              <button className="btn btn-secondary btn-block" onClick={() => setModal("newtask")}>
                New task
              </button>
              <div className="rail-status">
                <div className="live">
                  <span className="dot" />
                  <span className="mono">
                    {settings ? `${settings.agent.runner}${settings.agent.model ? " · " + settings.agent.model : ""}` : "…"}
                  </span>
                </div>
                {settings && <div className="mono">polling every {Math.round(settings.pollIntervalMs / 1000)}s</div>}
              </div>
            </>
          ) : (
            <>
              <button className="rail-toggle" title="New task" onClick={() => setModal("newtask")} style={{ border: "1px solid var(--color-divider)" }}>
                <Icon name="plus" size={16} />
              </button>
              <span className="rail-closed-dot" title="live" />
            </>
          )}
        </div>
      </aside>

      <main className="app-main">
        <header className="app-header">
          <h4>{SCREEN_TITLE[screen]}</h4>
          {screen === "board" && (
            <span className="board-summary">
              <span className="mono need-pill">{needsCount} need you</span>
              <span className="mono sub">{runningCount} running itself</span>
            </span>
          )}
          {screen === "board" && (
            <SettledDateFilter
              from={settledFrom}
              to={settledTo}
              onFromChange={setSettledFrom}
              onToChange={setSettledTo}
              onClear={() => {
                setSettledFrom("");
                setSettledTo("");
              }}
            />
          )}
        </header>

        <div className="app-screen">
          {showingOnboarding ? (
            <Onboarding
              task={onboardingTask!}
              type={onboardingType!}
              onDone={refresh}
              onClose={() => setOnboardingTaskId(null)}
            />
          ) : screen === "board" ? (
            <Board
              tasks={tasks}
              types={types}
              onSelect={(t) => openTask(t.id)}
              onOnboard={(t) => setOnboardingTaskId(t.id)}
              onConfirmType={confirmType}
              onResolveDuplicate={resolveDuplicate}
              settledFrom={settledFrom}
              settledTo={settledTo}
            />
          ) : screen === "types" ? (
            <Rules />
          ) : screen === "extensions" ? (
            <Extensions />
          ) : (
            <Settings />
          )}
        </div>
      </main>

      {selectedTask && !showingOnboarding && (
        <TaskDetail
          task={selectedTask}
          allTasks={tasks}
          onChanged={refresh}
          onClose={() => openTask(null)}
          onMarkDuplicate={(ofTaskId) => markDuplicate(selectedTask.id, ofTaskId)}
        />
      )}

      {modal === "newtask" && <NewTask onCreated={refresh} onClose={() => setModal(null)} />}
      {modal === "signin" && <SignIn onClose={() => setModal(null)} />}
    </div>
  );
}
