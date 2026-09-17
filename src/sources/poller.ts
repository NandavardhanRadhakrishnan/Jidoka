import type { Database } from "bun:sqlite";
import type { Task } from "../domain/task";
import { findTaskBySource, insertTask } from "../repo/tasks";
import { getCursor, setCursor } from "../repo/sourceState";
import type { TaskSource } from "./types";

export type OnTask = (task: Task) => Promise<void>;

export async function pollOnce(
  db: Database,
  source: TaskSource,
  onTask: OnTask,
): Promise<Task[]> {
  const cursor = getCursor(db, source.id);
  const result = await source.poll(cursor);

  const created: Task[] = [];
  for (const item of result.items) {
    if (findTaskBySource(db, source.id, item.externalId)) continue;
    created.push(
      insertTask(db, {
        sourceId: source.id,
        externalId: item.externalId,
        url: item.url ?? null,
        title: item.title,
        body: item.body,
        metadata: item.metadata ?? {},
      }),
    );
  }

  setCursor(db, source.id, result.cursor);

  for (const task of created) await onTask(task);
  return created;
}

export function startPoller(
  db: Database,
  sources: TaskSource[],
  onTask: OnTask,
  intervalMs: number,
): { stop(): void } {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    for (const source of sources) {
      try {
        await pollOnce(db, source, onTask);
      } catch (error) {
        console.error(`[poller] ${source.id} failed:`, error);
      }
    }
    running = false;
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
