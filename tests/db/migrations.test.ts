import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";

test("migrate creates the rules table and drops the old pipelines table", () => {
  const db = openDb(":memory:");
  db.query("CREATE TABLE pipelines (id TEXT)").run();
  migrate(db);

  const names = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => (row as { name: string }).name);

  expect(names).toContain("rules");
  expect(names).not.toContain("pipelines");
});

test("migrate can run twice against the same database without erroring", () => {
  const db = openDb(":memory:");
  migrate(db);

  expect(() => migrate(db)).not.toThrow();
});

test("roster tables and indexes exist and migrate() re-runs cleanly", () => {
  const db = openDb(":memory:");
  migrate(db);
  migrate(db);
  const names = (
    db.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as { name: string }[]
  ).map((r) => r.name);
  for (const name of [
    "orgs",
    "orgs_one_home",
    "org_domains",
    "people",
    "people_one_self",
    "person_identities",
    "task_participants",
    "task_participants_source",
    "task_participants_human",
    "task_participants_identity",
  ]) {
    expect(names).toContain(name);
  }
});
