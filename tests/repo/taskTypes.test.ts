import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { insertTask, getTask } from "../../src/repo/tasks";
import {
  insertTaskType,
  getTaskType,
  listTaskTypes,
  updateTaskType,
  mergeTaskType,
} from "../../src/repo/taskTypes";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

test("insertTaskType stores a proposed type", () => {
  const db = freshDb();
  const type = insertTaskType(db, {
    name: "Email query",
    description: "A question arriving by email",
  });

  expect(type.status).toBe("proposed");
  expect(type.examples).toEqual([]);
  expect(getTaskType(db, type.id)).toEqual(type);
  expect(listTaskTypes(db)).toHaveLength(1);
});

test("updateTaskType renames, edits description, appends examples and activates", () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Email", description: "email" });

  const updated = updateTaskType(db, type.id, {
    name: "Customer email",
    description: "Question from an external customer",
    examples: ["Where is my order?"],
    status: "active",
  });

  expect(updated.name).toBe("Customer email");
  expect(updated.examples).toEqual(["Where is my order?"]);
  expect(updated.status).toBe("active");
});

test("mergeTaskType repoints tasks and deletes the merged type", () => {
  const db = freshDb();
  const keep = insertTaskType(db, { name: "Email query", description: "d1" });
  const dupe = insertTaskType(db, { name: "Mail question", description: "d2" });
  const task = insertTask(db, {
    sourceId: "outlook",
    externalId: "m1",
    title: "t",
    body: "b",
  });
  updateTaskType(db, dupe.id, { status: "active" });
  const moved = insertTask(db, {
    sourceId: "outlook",
    externalId: "m2",
    title: "t2",
    body: "b2",
  });
  db.query("UPDATE tasks SET type_id = ? WHERE id = ?").run(dupe.id, moved.id);

  mergeTaskType(db, dupe.id, keep.id);

  expect(getTaskType(db, dupe.id)).toBeNull();
  expect(getTask(db, moved.id)?.typeId).toBe(keep.id);
  expect(getTask(db, task.id)?.typeId).toBeNull();
});
