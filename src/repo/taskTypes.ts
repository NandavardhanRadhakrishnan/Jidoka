import type { Database } from "bun:sqlite";
import type { NewTaskType, TaskType, TaskTypePatch } from "../domain/taskType";

interface Row {
  id: string;
  name: string;
  description: string;
  examples: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function toType(row: Row): TaskType {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    examples: JSON.parse(row.examples) as string[],
    status: row.status as TaskType["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertTaskType(db: Database, input: NewTaskType): TaskType {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO task_types (id, name, description, examples, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'proposed', ?, ?)`,
  ).run(id, input.name, input.description, JSON.stringify(input.examples ?? []), now, now);
  const type = getTaskType(db, id);
  if (!type) throw new Error(`insertTaskType: type ${id} vanished`);
  return type;
}

export function getTaskType(db: Database, id: string): TaskType | null {
  const row = db.query("SELECT * FROM task_types WHERE id = ?").get(id) as Row | null;
  return row ? toType(row) : null;
}

export function listTaskTypes(db: Database): TaskType[] {
  const rows = db.query("SELECT * FROM task_types ORDER BY name").all() as Row[];
  return rows.map(toType);
}

export function updateTaskType(
  db: Database,
  id: string,
  patch: TaskTypePatch,
): TaskType {
  const current = getTaskType(db, id);
  if (!current) throw new Error(`updateTaskType: unknown type ${id}`);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  db.query(
    `UPDATE task_types SET name = ?, description = ?, examples = ?, status = ?, updated_at = ?
     WHERE id = ?`,
  ).run(next.name, next.description, JSON.stringify(next.examples), next.status, next.updatedAt, id);
  return next;
}

export function mergeTaskType(db: Database, fromId: string, intoId: string): void {
  if (fromId === intoId) throw new Error("mergeTaskType: cannot merge a type into itself");
  if (!getTaskType(db, intoId)) throw new Error(`mergeTaskType: unknown target ${intoId}`);
  db.transaction(() => {
    db.query("UPDATE tasks SET type_id = ? WHERE type_id = ?").run(intoId, fromId);
    db.query("DELETE FROM task_types WHERE id = ?").run(fromId);
  })();
}
