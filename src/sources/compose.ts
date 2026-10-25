import type { SourceItemRow } from "../repo/sourceItems";

export interface ComposedTask {
  title: string;
  body: string;
  url: string | null;
  metadata: Record<string, unknown>;
}

function heading(row: SourceItemRow): string {
  const date = new Date(row.occurredAt ?? "").toLocaleString();
  const from = row.participants.find((p) => p.role === "from");
  if (!from) return `— ${date} —`;
  const who = from.name?.trim() ? from.name : from.identity.replace(/^[^:]*:/, "");
  return `— ${who} · ${date} —`;
}

/** Builds a task's content from a thread's items, oldest first. */
export function composeTask(rows: SourceItemRow[]): ComposedTask {
  const sorted = [...rows].sort((a, b) => Date.parse(a.occurredAt ?? "") - Date.parse(b.occurredAt ?? ""));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  return {
    title: first.title ?? "",
    body: sorted.map((r) => `${heading(r)}\n${(r.body ?? "").trim()}`).join("\n\n"),
    url: last.url,
    metadata: last.metadata,
  };
}
