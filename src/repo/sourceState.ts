import type { Database } from "bun:sqlite";

export function getCursor(db: Database, sourceId: string): string | null {
  const row = db
    .query("SELECT cursor FROM source_state WHERE source_id = ?")
    .get(sourceId) as { cursor: string | null } | null;
  return row?.cursor ?? null;
}

export function setCursor(db: Database, sourceId: string, cursor: string | null): void {
  db.query(
    `INSERT INTO source_state (source_id, cursor) VALUES (?, ?)
     ON CONFLICT (source_id) DO UPDATE SET cursor = excluded.cursor`,
  ).run(sourceId, cursor);
}

export function removeCursor(db: Database, sourceId: string): void {
  db.query("DELETE FROM source_state WHERE source_id = ?").run(sourceId);
}
