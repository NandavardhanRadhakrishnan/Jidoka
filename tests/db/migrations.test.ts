import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";

test("migrate creates the rules table and drops the old pipelines table", () => {
  const db = openDb(":memory:");
  migrate(db);

  const names = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => (row as { name: string }).name);

  expect(names).toContain("rules");
  expect(names).not.toContain("pipelines");
});
