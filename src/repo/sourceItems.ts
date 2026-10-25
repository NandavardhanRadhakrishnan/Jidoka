import type { Database } from "bun:sqlite";
import type { SourceParticipant } from "../domain/roster";
import type { SourceItem } from "../sources/types";

interface Row {
  source_id: string;
  key: string;
  thread_key: string | null;
  version: string | null;
  occurred_at: string | null;
  title: string | null;
  body: string | null;
  url: string | null;
  metadata: string;
  participants: string;
  task_id: string | null;
  status: string;
  error: string | null;
  failed_window: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface SourceItemRow {
  sourceId: string;
  key: string;
  threadKey: string | null;
  version: string | null;
  occurredAt: string | null;
  title: string | null;
  body: string | null;
  url: string | null;
  metadata: Record<string, unknown>;
  participants: SourceParticipant[];
  taskId: string | null;
  status: "ingested" | "failed" | "dismissed";
  error: string | null;
  failedWindow: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

const now = () => new Date().toISOString();

function toRow(row: Row): SourceItemRow {
  return {
    sourceId: row.source_id,
    key: row.key,
    threadKey: row.thread_key,
    version: row.version,
    occurredAt: row.occurred_at,
    title: row.title,
    body: row.body,
    url: row.url,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    participants: JSON.parse(row.participants) as SourceParticipant[],
    taskId: row.task_id,
    status: row.status as SourceItemRow["status"],
    error: row.error,
    failedWindow: row.failed_window,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function getItemRow(db: Database, sourceId: string, key: string): SourceItemRow | null {
  const row = db.query("SELECT * FROM source_items WHERE source_id = ? AND key = ?").get(sourceId, key) as Row | null;
  return row ? toRow(row) : null;
}

/** Insert or update the item's content as ingested, clearing any earlier failure. */
export function fileIngested(db: Database, sourceId: string, item: SourceItem, taskId: string): void {
  const at = now();
  db.query(
    `INSERT INTO source_items (source_id, key, thread_key, version, occurred_at, title, body, url,
                               metadata, participants, task_id, status, error, failed_window,
                               first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ingested', NULL, NULL, ?, ?)
     ON CONFLICT (source_id, key) DO UPDATE SET
       thread_key = excluded.thread_key,
       version = excluded.version,
       occurred_at = excluded.occurred_at,
       title = excluded.title,
       body = excluded.body,
       url = excluded.url,
       metadata = excluded.metadata,
       participants = excluded.participants,
       task_id = excluded.task_id,
       status = 'ingested',
       error = NULL,
       failed_window = NULL,
       last_seen_at = excluded.last_seen_at`,
  ).run(
    sourceId,
    item.key,
    item.threadKey ?? null,
    item.version ?? null,
    item.occurredAt,
    item.title,
    item.body,
    item.url ?? null,
    JSON.stringify(item.metadata ?? {}),
    JSON.stringify(item.participants ?? []),
    taskId,
    at,
    at,
  );
}

export function touchSeen(db: Database, sourceId: string, key: string): void {
  db.query("UPDATE source_items SET last_seen_at = ? WHERE source_id = ? AND key = ?").run(now(), sourceId, key);
}

/** Records a failed item. Never downgrades a row that is already ingested,
 *  and never un-dismisses one: a dismissal is the user's decision, so a repeat
 *  failure only refreshes its error. */
export function fileFailure(
  db: Database,
  sourceId: string,
  key: string,
  error: string,
  window: string | null,
): "recorded" | "already_ingested" | "dismissed" {
  const existing = getItemRow(db, sourceId, key);
  if (existing?.status === "ingested") return "already_ingested";
  const at = now();
  if (existing?.status === "dismissed") {
    db.query("UPDATE source_items SET error = ?, last_seen_at = ? WHERE source_id = ? AND key = ?").run(
      error,
      at,
      sourceId,
      key,
    );
    return "dismissed";
  }
  db.query(
    `INSERT INTO source_items (source_id, key, status, error, failed_window, first_seen_at, last_seen_at)
     VALUES (?, ?, 'failed', ?, ?, ?, ?)
     ON CONFLICT (source_id, key) DO UPDATE SET
       status = 'failed', error = excluded.error, failed_window = excluded.failed_window,
       last_seen_at = excluded.last_seen_at`,
  ).run(sourceId, key, error, window, at, at);
  return "recorded";
}

export function dismissFailure(db: Database, sourceId: string, key: string): void {
  db.query("UPDATE source_items SET status = 'dismissed' WHERE source_id = ? AND key = ? AND status = 'failed'").run(
    sourceId,
    key,
  );
}

export function listFailures(db: Database, sourceId: string): SourceItemRow[] {
  const rows = db
    .query("SELECT * FROM source_items WHERE source_id = ? AND status = 'failed' ORDER BY last_seen_at DESC, rowid DESC")
    .all(sourceId) as Row[];
  return rows.map(toRow);
}

export function countFailures(db: Database, sourceId: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM source_items WHERE source_id = ? AND status = 'failed'")
    .get(sourceId) as { n: number };
  return row.n;
}

export function taskForThread(db: Database, sourceId: string, threadKey: string): string | null {
  const row = db
    .query("SELECT task_id FROM source_items WHERE source_id = ? AND thread_key = ? AND task_id IS NOT NULL LIMIT 1")
    .get(sourceId, threadKey) as { task_id: string } | null;
  return row?.task_id ?? null;
}

export function rowsForTask(db: Database, taskId: string): SourceItemRow[] {
  const rows = db
    .query("SELECT * FROM source_items WHERE task_id = ? AND status = 'ingested' ORDER BY occurred_at, rowid")
    .all(taskId) as Row[];
  return rows.map(toRow);
}

/** A task's row for an item key, from whichever source filed it — after a
 *  cross-source merge one task holds rows of several sources. */
export function rowForTaskKey(db: Database, taskId: string, key: string): SourceItemRow | null {
  const row = db
    .query("SELECT * FROM source_items WHERE task_id = ? AND key = ? ORDER BY rowid DESC LIMIT 1")
    .get(taskId, key) as Row | null;
  return row ? toRow(row) : null;
}

export function repointTask(db: Database, fromTaskId: string, toTaskId: string): void {
  db.query("UPDATE source_items SET task_id = ? WHERE task_id = ?").run(toTaskId, fromTaskId);
}

export function deleteSourceItems(db: Database, sourceId: string): void {
  db.query("DELETE FROM source_items WHERE source_id = ?").run(sourceId);
}
