import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import {
  insertTask,
  getTask,
  listTasks,
  findTaskBySource,
  updateTask,
} from "../../src/repo/tasks";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

const sample = {
  sourceId: "outlook",
  externalId: "msg-1",
  url: "https://outlook.office.com/mail/id/msg-1",
  title: "Invoice question",
  body: "Can you confirm the amount on invoice 42?",
  metadata: { from: "a@example.com" },
};

test("insertTask stores a task in the ingested state", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  expect(task.id).toMatch(/[0-9a-f-]{36}/);
  expect(task.state).toBe("ingested");
  expect(task.typeId).toBeNull();
  expect(task.assignee).toBeNull();
  expect(task.metadata).toEqual({ from: "a@example.com" });
  expect(getTask(db, task.id)).toEqual(task);
  expect(task.deadline).toBeNull();
});

test("updateTask patches a deadline", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  const updated = updateTask(db, task.id, { deadline: "2026-02-01" });

  expect(updated.deadline).toBe("2026-02-01");
  expect(getTask(db, task.id)?.deadline).toBe("2026-02-01");
});

test("findTaskBySource finds by source and external id", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  expect(findTaskBySource(db, "outlook", "msg-1")?.id).toBe(task.id);
  expect(findTaskBySource(db, "outlook", "msg-2")).toBeNull();
});

test("insertTask rejects a duplicate source item", () => {
  const db = freshDb();
  insertTask(db, sample);

  expect(() => insertTask(db, sample)).toThrow();
});

test("updateTask patches state, type, assignee and context", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  const updated = updateTask(db, task.id, {
    state: "assigned_human",
    typeId: "type-1",
    assignee: "human",
    context: { summary: "Asks about invoice 42" },
  });

  expect(updated.state).toBe("assigned_human");
  expect(updated.typeId).toBe("type-1");
  expect(updated.assignee).toBe("human");
  expect(updated.context).toEqual({ summary: "Asks about invoice 42" });
  expect(updated.updatedAt >= task.updatedAt).toBe(true);
  expect(listTasks(db)).toHaveLength(1);
});
