import type { Task, TaskState } from "../domain/task";

export type LaneKey = "needs" | "running" | "settled";

export const LANE_OF: Record<TaskState, LaneKey> = {
  needs_type_confirmation: "needs",
  needs_onboarding: "needs",
  assigned_human: "needs",
  ingested: "running",
  processing: "running",
  assigned_ai: "running",
  done: "settled",
  failed: "settled",
};

export const LANES: { key: LaneKey; label: string; sub: string }[] = [
  { key: "needs", label: "Needs you", sub: "blocked on a person" },
  { key: "running", label: "Running itself", sub: "rules at work" },
  { key: "settled", label: "Settled", sub: "closed or failed" },
];

export function groupByLane(tasks: Task[]): Record<LaneKey, Task[]> {
  const grouped: Record<LaneKey, Task[]> = { needs: [], running: [], settled: [] };
  for (const task of tasks) grouped[LANE_OF[task.state]].push(task);
  return grouped;
}

export const STATE_LABEL: Record<TaskState, string> = {
  ingested: "ingested",
  needs_type_confirmation: "needs type confirmation",
  needs_onboarding: "needs onboarding",
  processing: "processing",
  assigned_ai: "assigned to AI",
  assigned_human: "assigned to human",
  done: "done",
  failed: "failed",
};

/** Keeps only tasks created on or after `from` and on or before `to` (both yyyy-mm-dd, either end optional). */
export function filterByDateRange(tasks: Task[], from: string, to: string): Task[] {
  if (!from && !to) return tasks;
  const fromMs = from ? new Date(from).getTime() : -Infinity;
  // `to` is a date with no time component; treat it as through the end of that day.
  const toMs = to ? new Date(to).getTime() + 24 * 60 * 60 * 1000 : Infinity;
  return tasks.filter((task) => {
    const createdMs = new Date(task.createdAt).getTime();
    return createdMs >= fromMs && createdMs < toMs;
  });
}

/** Whole days from today to a yyyy-mm-dd deadline; negative when overdue. */
export function daysUntil(deadline: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${deadline}T00:00:00`);
  return Math.round((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

/** Label + CSS tone for how urgent a deadline is, from days remaining (negative = overdue). */
export function deadlineUrgency(daysLeft: number): { label: string; cls: string } {
  if (daysLeft < 0) return { label: `${Math.abs(daysLeft)}d overdue`, cls: "deadline-overdue" };
  if (daysLeft === 0) return { label: "due today", cls: "deadline-today" };
  if (daysLeft <= 2) return { label: `${daysLeft}d left`, cls: "deadline-soon" };
  return { label: `${daysLeft}d left`, cls: "deadline-later" };
}

export function taskAge(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
