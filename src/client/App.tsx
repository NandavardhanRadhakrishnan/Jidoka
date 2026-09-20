import { useCallback, useEffect, useState } from "react";
import type { Task } from "../domain/task";
import { api, type TypeWithRules } from "./api";
import { Board } from "./Board";
import { TypeConfirm } from "./TypeConfirm";
import { Onboarding } from "./Onboarding";
import { NewTask } from "./NewTask";
import { SignIn } from "./SignIn";
import { TaskDetail } from "./TaskDetail";
import { Extensions } from "./Extensions";
import { Rules } from "./Rules";

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [types, setTypes] = useState<TypeWithRules[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);

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

  const selectedType = selected?.typeId ? types.find((t) => t.id === selected.typeId) : undefined;

  return (
    <main>
      <header>
        <h1>Jidoka</h1>
        <div className="actions">
          <SignIn />
          <Rules />
          <Extensions />
          <NewTask onCreated={refresh} />
          <button className="secondary" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </header>

      <Board tasks={tasks} onSelect={setSelected} />

      {selected?.state === "needs_type_confirmation" && (
        <TypeConfirm
          task={selected}
          types={types}
          onConfirm={async (typeId) => {
            await api.confirmType(selected.id, typeId);
            await refresh();
          }}
          onClose={() => setSelected(null)}
        />
      )}

      {selected?.state === "needs_onboarding" && selectedType && (
        <Onboarding
          task={selected}
          type={selectedType}
          onDone={refresh}
          onClose={() => setSelected(null)}
        />
      )}

      {selected &&
        selected.state !== "needs_type_confirmation" &&
        !(selected.state === "needs_onboarding" && selectedType) && (
          <TaskDetail task={selected} onChanged={refresh} onClose={() => setSelected(null)} />
        )}
    </main>
  );
}
