import type { Database } from "bun:sqlite";

/** Tombstones a source item that was merged away as a duplicate, so a
 *  re-listing source (one that returns the same items on every poll,
 *  cursor or not) never resurrects it just because its task row is gone. */
export function recordMergedSourceItem(db: Database, sourceId: string, externalId: string): void {
  db.query(
    `INSERT INTO merged_source_items (source_id, external_id, merged_at) VALUES (?, ?, ?)
     ON CONFLICT (source_id, external_id) DO NOTHING`,
  ).run(sourceId, externalId, new Date().toISOString());
}

export function wasMerged(db: Database, sourceId: string, externalId: string): boolean {
  const row = db
    .query("SELECT 1 FROM merged_source_items WHERE source_id = ? AND external_id = ?")
    .get(sourceId, externalId);
  return row !== null;
}
