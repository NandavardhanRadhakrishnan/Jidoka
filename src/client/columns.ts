import type { Task, TaskState } from "../domain/task";

/** Which signal color a column reads as — mirrors an andon board: amber means a
 * person needs to decide something, blue means work is moving, green/red are terminal. */
export type ColumnTone = "attention" | "active" | "done" | "failed";

export const COLUMNS: { state: TaskState; label: string; tone: ColumnTone }[] = [
  { state: "ingested", label: "Ingested", tone: "active" },
  { state: "needs_type_confirmation", label: "Needs type confirmation", tone: "attention" },
  { state: "needs_onboarding", label: "Needs onboarding", tone: "attention" },
  { state: "processing", label: "Processing", tone: "active" },
  { state: "assigned_ai", label: "Assigned to AI", tone: "active" },
  { state: "assigned_human", label: "Assigned to human", tone: "active" },
  { state: "done", label: "Done", tone: "done" },
  { state: "failed", label: "Failed", tone: "failed" },
];

export function groupByColumn(tasks: Task[]): Record<TaskState, Task[]> {
  const grouped = Object.fromEntries(COLUMNS.map((c) => [c.state, [] as Task[]])) as Record<
    TaskState,
    Task[]
  >;
  for (const task of tasks) grouped[task.state]?.push(task);
  return grouped;
}
