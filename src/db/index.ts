import { Database } from "bun:sqlite";
import { MIGRATIONS } from "./migrations";

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function migrate(db: Database): void {
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (error) {
      // ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite, and MIGRATIONS
      // re-runs on every startup against the same file, so a column added in
      // an earlier run throws here every time after.
      const duplicateColumn = error instanceof Error && /duplicate column name/i.test(error.message);
      if (!duplicateColumn) throw error;
    }
  }
}

export type { Database };
