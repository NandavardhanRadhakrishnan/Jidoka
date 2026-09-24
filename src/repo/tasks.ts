import type { Database } from "bun:sqlite";
import type { NewTask, Task, TaskPatch } from "../domain/task";

interface Row {
  id: string;
  source_id: string;
  external_id: string;
  url: string | null;
  title: string;
  body: string;
  metadata: string;
  type_id: string | null;
  type_candidates: string | null;
  state: string;
  assignee: string | null;
  deadline: string | null;
  dedup_candidate_id: string | null;
  context: string;
  created_at: string;
  updated_at: string;
}

function toTask(row: Row): Task {
  return {
    id: row.id,
    sourceId: row.source_id,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    body: row.body,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    typeId: row.type_id,
    typeCandidates: row.type_candidates
      ? (JSON.parse(row.type_candidates) as string[])
      : null,
    state: row.state as Task["state"],
    assignee: row.assignee as Task["assignee"],
    deadline: row.deadline,
    dedupCandidateId: row.dedup_candidate_id,
    context: JSON.parse(row.context) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertTask(db: Database, input: NewTask): Task {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO tasks (id, source_id, external_id, url, title, body, metadata,
                        type_id, type_candidates, state, assignee, context, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'ingested', NULL, '{}', ?, ?)`,
  ).run(
    id,
    input.sourceId,
    input.externalId,
    input.url ?? null,
    input.title,
    input.body,
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );
  const task = getTask(db, id);
  if (!task) throw new Error(`insertTask: task ${id} vanished`);
  return task;
}

export function getTask(db: Database, id: string): Task | null {
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Row | null;
  return row ? toTask(row) : null;
}

export function listTasks(db: Database): Task[] {
  const rows = db
    .query("SELECT * FROM tasks ORDER BY created_at DESC")
    .all() as Row[];
  return rows.map(toTask);
}

export function findTaskBySource(
  db: Database,
  sourceId: string,
  externalId: string,
): Task | null {
  const row = db
    .query("SELECT * FROM tasks WHERE source_id = ? AND external_id = ?")
    .get(sourceId, externalId) as Row | null;
  return row ? toTask(row) : null;
}

export function updateTask(db: Database, id: string, patch: TaskPatch): Task {
  const current = getTask(db, id);
  if (!current) throw new Error(`updateTask: unknown task ${id}`);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  db.query(
    `UPDATE tasks SET state = ?, type_id = ?, type_candidates = ?, assignee = ?,
                      deadline = ?, dedup_candidate_id = ?, context = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.state,
    next.typeId,
    next.typeCandidates ? JSON.stringify(next.typeCandidates) : null,
    next.assignee,
    next.deadline,
    next.dedupCandidateId,
    JSON.stringify(next.context),
    next.updatedAt,
    id,
  );
  return next;
}

export function deleteTask(db: Database, id: string): void {
  db.query("DELETE FROM tasks WHERE id = ?").run(id);
}
