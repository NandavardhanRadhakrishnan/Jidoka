import type { Database } from "bun:sqlite";
import type { Task, TaskState } from "../domain/task";
import { findTaskBySource, insertTask } from "../repo/tasks";
import { wasMerged } from "../repo/mergedSourceItems";
import { getCursor, setCursor } from "../repo/sourceState";
import type { RawItem, TaskSource } from "./types";

export type OnTask = (task: Task) => Promise<void>;
/** Called when a source reports a revision change on a task that already
 *  passed through a rule at least once (done, or currently assigned). */
export type OnTaskChanged = (task: Task, item: RawItem) => Promise<void>;

/** States a revision change is allowed to reopen. Excludes `processing` (a
 *  rule is actively running) and every pre-triage state (no rule has run yet,
 *  so there's nothing to follow up on). */
const REOPENABLE_STATES = new Set<TaskState>(["done", "assigned_ai", "assigned_human"]);

export async function pollOnce(
  db: Database,
  source: TaskSource,
  onTask: OnTask,
  onTaskChanged?: OnTaskChanged,
): Promise<Task[]> {
  const cursor = getCursor(db, source.id);
  const result = await source.poll(cursor);

  const created: Task[] = [];
  const reopened: { task: Task; item: RawItem }[] = [];
  for (const item of result.items) {
    const existing = findTaskBySource(db, source.id, item.externalId);
    if (existing) {
      if (
        item.revision &&
        item.revision !== (existing.context.revision as string | undefined) &&
        REOPENABLE_STATES.has(existing.state)
      ) {
        reopened.push({ task: existing, item });
      }
      continue;
    }
    if (wasMerged(db, source.id, item.externalId)) continue;
    created.push(
      insertTask(db, {
        sourceId: source.id,
        externalId: item.externalId,
        url: item.url ?? null,
        title: item.title,
        body: item.body,
        metadata: item.metadata ?? {},
        revision: item.revision,
      }),
    );
  }

  setCursor(db, source.id, result.cursor);

  for (const task of created) await onTask(task);
  for (const { task, item } of reopened) await onTaskChanged?.(task, item);
  return created;
}

export function startPoller(
  db: Database,
  sources: TaskSource[],
  onTask: OnTask,
  intervalMs: number,
  loadDynamicSources?: () => Promise<TaskSource[]>,
  onTaskChanged?: OnTaskChanged,
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
          await pollOnce(db, source, onTask, onTaskChanged);
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
