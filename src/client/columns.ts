import type { Task, TaskState } from "../domain/task";

export const COLUMNS: { state: TaskState; label: string }[] = [
  { state: "ingested", label: "Ingested" },
  { state: "needs_type_confirmation", label: "Needs type confirmation" },
  { state: "needs_onboarding", label: "Needs onboarding" },
  { state: "processing", label: "Processing" },
  { state: "assigned_ai", label: "Assigned to AI" },
  { state: "assigned_human", label: "Assigned to human" },
  { state: "done", label: "Done" },
  { state: "failed", label: "Failed" },
];

export function groupByColumn(tasks: Task[]): Record<TaskState, Task[]> {
  const grouped = Object.fromEntries(COLUMNS.map((c) => [c.state, [] as Task[]])) as Record<
    TaskState,
    Task[]
  >;
  for (const task of tasks) grouped[task.state]?.push(task);
  return grouped;
}
