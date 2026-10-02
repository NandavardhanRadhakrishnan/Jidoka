import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import {
  insertTask,
  getTask,
  listTasks,
  findTaskBySource,
  updateTask,
  deleteTask,
} from "../../src/repo/tasks";
import { listAudit } from "../../src/repo/audit";

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

test("updateTask patches a dedup candidate id", () => {
  const db = freshDb();
  const task = insertTask(db, sample);
  const other = insertTask(db, { ...sample, externalId: "msg-2" });

  const updated = updateTask(db, task.id, {
    state: "needs_dedup_confirmation",
    dedupCandidateId: other.id,
  });

  expect(updated.state).toBe("needs_dedup_confirmation");
  expect(updated.dedupCandidateId).toBe(other.id);
  expect(getTask(db, task.id)?.dedupCandidateId).toBe(other.id);
});

test("insertTask stamps context.revision when the input carries one", () => {
  const db = freshDb();
  const task = insertTask(db, { ...sample, revision: "rev-1" });

  expect(task.context.revision).toBe("rev-1");
  expect(getTask(db, task.id)?.context.revision).toBe("rev-1");
});

test("insertTask leaves context empty when no revision is given", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  expect(task.context).toEqual({});
});

test("insertTask defaults dedupCandidateId to null", () => {
  const db = freshDb();
  const task = insertTask(db, sample);
  expect(task.dedupCandidateId).toBeNull();
});

test("deleteTask removes the row", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  deleteTask(db, task.id);

  expect(getTask(db, task.id)).toBeNull();
  expect(listTasks(db)).toHaveLength(0);
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

test("updateTask patches title, body and metadata", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  const updated = updateTask(db, task.id, {
    title: "Invoice question (updated)",
    body: "New body from a reopened source item",
    metadata: { from: "b@example.com" },
  });

  expect(updated.title).toBe("Invoice question (updated)");
  expect(updated.body).toBe("New body from a reopened source item");
  expect(updated.metadata).toEqual({ from: "b@example.com" });
  const fetched = getTask(db, task.id)!;
  expect(fetched.title).toBe("Invoice question (updated)");
  expect(fetched.body).toBe("New body from a reopened source item");
  expect(fetched.metadata).toEqual({ from: "b@example.com" });
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

test("a new task starts at normal priority", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  expect(task.priority).toBe("normal");
});

test("updateTask patches a priority", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  updateTask(db, task.id, { priority: "urgent" });

  expect(getTask(db, task.id)?.priority).toBe("urgent");
});

test("inserting a task records an ingested audit entry with its source reference", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  expect(listAudit(db, { taskId: task.id })).toMatchObject([
    { kind: "ingested", actor: "system", data: { sourceId: "outlook", externalId: "msg-1" } },
  ]);
});

test("every state change is audited with from and to, and a non-state patch is not", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  updateTask(db, task.id, { deadline: "2026-02-01" });
  updateTask(db, task.id, { state: "assigned_human", assignee: "human" });

  const changes = listAudit(db, { taskId: task.id }).filter((e) => e.kind === "state_changed");
  expect(changes).toHaveLength(1);
  expect(changes[0]!.data).toEqual({ from: "ingested", to: "assigned_human", assignee: "human" });
});
