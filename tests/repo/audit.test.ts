import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { recordAudit, listAudit, purgeAuditOlderThan, purgeExpiredAudit } from "../../src/repo/audit";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

test("recordAudit stores an entry that listAudit returns newest first", () => {
  const db = freshDb();
  recordAudit(db, { kind: "triaged", actor: "system", taskId: "t1", data: { outcome: "matched" } });
  recordAudit(db, { kind: "completed", actor: "human", taskId: "t1", data: { note: "sent" } });

  const entries = listAudit(db);

  expect(entries.map((e) => e.kind)).toEqual(["completed", "triaged"]);
  expect(entries[0]).toMatchObject({ actor: "human", taskId: "t1", typeId: null, ruleId: null, data: { note: "sent" } });
  expect(entries[0]!.id).toMatch(/[0-9a-f-]{36}/);
});

test("listAudit filters to one task", () => {
  const db = freshDb();
  recordAudit(db, { kind: "triaged", actor: "system", taskId: "t1", data: {} });
  recordAudit(db, { kind: "triaged", actor: "system", taskId: "t2", data: {} });

  expect(listAudit(db, { taskId: "t2" }).map((e) => e.taskId)).toEqual(["t2"]);
});

test("purgeAuditOlderThan deletes only entries before the cutoff and reports how many", () => {
  const db = freshDb();
  recordAudit(db, { kind: "triaged", actor: "system", data: {}, at: "2026-01-01T00:00:00.000Z" });
  recordAudit(db, { kind: "triaged", actor: "system", data: {}, at: "2026-06-01T00:00:00.000Z" });

  const removed = purgeAuditOlderThan(db, "2026-03-01T00:00:00.000Z");

  expect(removed).toBe(1);
  expect(listAudit(db).map((e) => e.at)).toEqual(["2026-06-01T00:00:00.000Z"]);
});

test("purgeExpiredAudit keeps everything when retention is 0 (forever)", () => {
  const db = freshDb();
  recordAudit(db, { kind: "triaged", actor: "system", data: {}, at: "2020-01-01T00:00:00.000Z" });

  expect(purgeExpiredAudit(db, 0, new Date("2026-10-02T00:00:00.000Z"))).toBe(0);
  expect(listAudit(db)).toHaveLength(1);
});

test("purgeExpiredAudit drops entries older than the retention window", () => {
  const db = freshDb();
  recordAudit(db, { kind: "triaged", actor: "system", data: {}, at: "2026-08-01T00:00:00.000Z" });
  recordAudit(db, { kind: "triaged", actor: "system", data: {}, at: "2026-09-25T00:00:00.000Z" });

  const removed = purgeExpiredAudit(db, 30, new Date("2026-10-02T00:00:00.000Z"));

  expect(removed).toBe(1);
  expect(listAudit(db).map((e) => e.at)).toEqual(["2026-09-25T00:00:00.000Z"]);
});
