import type { Database } from "bun:sqlite";
import type { Task } from "../domain/task";
import { findTaskBySource, insertTask } from "../repo/tasks";
import { wasMerged } from "../repo/mergedSourceItems";
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
    if (wasMerged(db, source.id, item.externalId)) continue;
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
  loadDynamicSources?: () => Promise<TaskSource[]>,
): { stop(): void } {
  let running = false;

  const tick = async () => {
    if (running) {
      console.warn("[poller] previous tick still running — skipping");
      return;
    }
    running = true;

    try {
      let dynamicSources: TaskSource[] = [];
      if (loadDynamicSources) {
        try {
          dynamicSources = await loadDynamicSources();
        } catch (error) {
          console.error("[poller] loadDynamicSources failed:", error);
        }
      }

      const staticIds = new Set(sources.map((source) => source.id));
      const uniqueDynamicSources = dynamicSources.filter((source) => {
        if (staticIds.has(source.id)) {
          console.error(
            `[poller] ignoring dynamic source "${source.id}": id collides with a static source`,
          );
          return false;
        }
        return true;
      });

      for (const source of [...sources, ...uniqueDynamicSources]) {
        try {
          await pollOnce(db, source, onTask);
        } catch (error) {
          console.error(`[poller] ${source.id} failed:`, error);
        }
      }
    } finally {
      running = false;
    }
  };

  // tick() can still reject (e.g. if a caller-supplied loadDynamicSources
  // resolves to something other than an array — TypeScript prevents this,
  // but loadDynamicSources is a public parameter so we don't rely on that).
  // `running` is always reset via the `finally` above regardless, but
  // firing tick() with a bare `void` would otherwise leave that rejection
  // unhandled and able to crash the process; log it instead.
  const safeTick = () => {
    void tick().catch((error) => {
      console.error("[poller] tick failed unexpectedly:", error);
    });
  };

  safeTick();
  const timer = setInterval(safeTick, intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
