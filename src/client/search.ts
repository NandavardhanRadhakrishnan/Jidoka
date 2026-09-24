import type { Task } from "../domain/task";

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

export function matchesQuery(task: Task, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [task.title, task.body];
  collectStrings(task.context, haystack);
  return haystack.some((s) => s.toLowerCase().includes(q));
}
