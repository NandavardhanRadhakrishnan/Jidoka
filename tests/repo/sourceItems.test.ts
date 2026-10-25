import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { insertTask, deleteTask } from "../../src/repo/tasks";
import {
  countFailures,
  dismissFailure,
  fileFailure,
  fileIngested,
  getItemRow,
  listFailures,
  repointTask,
  rowsForTask,
  taskForThread,
  touchSeen,
} from "../../src/repo/sourceItems";
import type { SourceItem } from "../../src/sources/types";

function setup() {
  const db = openDb(":memory:");
  migrate(db);
  const task = () => insertTask(db, { sourceId: "s", externalId: crypto.randomUUID(), title: "t", body: "b" }).id;
  return { db, task };
}

const item = (key: string, over: Partial<SourceItem> = {}): SourceItem => ({
  key,
  threadKey: "th1",
  version: "v1",
  occurredAt: "2026-10-01T10:00:00.000Z",
  title: "Hello",
  body: "Body",
  url: "http://x/" + key,
  metadata: { a: 1 },
  participants: [{ identity: "email:a@b.test", role: "from" }] as never,
  ...over,
});

test("fileIngested then getItemRow returns content and status ingested", () => {
  const { db, task } = setup();
  const t = task();
  fileIngested(db, "s", item("k1"), t);
  const row = getItemRow(db, "s", "k1")!;
  expect(row).toMatchObject({
    sourceId: "s",
    key: "k1",
    threadKey: "th1",
    version: "v1",
    occurredAt: "2026-10-01T10:00:00.000Z",
    title: "Hello",
    body: "Body",
    url: "http://x/k1",
    metadata: { a: 1 },
    taskId: t,
    status: "ingested",
    error: null,
    failedWindow: null,
  });
  expect(row.participants).toHaveLength(1);
  expect(getItemRow(db, "s", "nope")).toBeNull();
});

test("fileIngested updates content but keeps first_seen_at", async () => {
  const { db, task } = setup();
  const t = task();
  fileIngested(db, "s", item("k1"), t);
  const first = getItemRow(db, "s", "k1")!;
  await Bun.sleep(5);
  fileIngested(db, "s", item("k1", { title: "New", version: "v2", participants: undefined }), t);
  const row = getItemRow(db, "s", "k1")!;
  expect(row.title).toBe("New");
  expect(row.version).toBe("v2");
  expect(row.participants).toEqual([]);
  expect(row.firstSeenAt).toBe(first.firstSeenAt);
  expect(row.lastSeenAt > first.lastSeenAt).toBe(true);
});

test("touchSeen bumps last_seen_at only", async () => {
  const { db, task } = setup();
  fileIngested(db, "s", item("k1"), task());
  const a = getItemRow(db, "s", "k1")!;
  await Bun.sleep(5);
  touchSeen(db, "s", "k1");
  const b = getItemRow(db, "s", "k1")!;
  expect(b.lastSeenAt > a.lastSeenAt).toBe(true);
  expect(b.title).toBe(a.title);
});

test("fileFailure on a new key records failed with the window", () => {
  const { db } = setup();
  expect(fileFailure(db, "s", "k9", "boom", "2026-10-01T00:00:00.000Z")).toBe("recorded");
  const row = getItemRow(db, "s", "k9")!;
  expect(row).toMatchObject({ status: "failed", error: "boom", failedWindow: "2026-10-01T00:00:00.000Z", taskId: null });
  expect(countFailures(db, "s")).toBe(1);
  expect(listFailures(db, "s").map((r) => r.key)).toEqual(["k9"]);
});

test("fileFailure on an ingested key returns already_ingested and changes nothing", () => {
  const { db, task } = setup();
  fileIngested(db, "s", item("k1"), task());
  expect(fileFailure(db, "s", "k1", "boom", null)).toBe("already_ingested");
  expect(getItemRow(db, "s", "k1")!.status).toBe("ingested");
  expect(countFailures(db, "s")).toBe(0);
});

test("dismissFailure marks dismissed and drops the count", () => {
  const { db } = setup();
  fileFailure(db, "s", "k9", "boom", null);
  dismissFailure(db, "s", "k9");
  expect(getItemRow(db, "s", "k9")!.status).toBe("dismissed");
  expect(countFailures(db, "s")).toBe(0);
});

test("fileIngested on a failed key clears the error", () => {
  const { db, task } = setup();
  fileFailure(db, "s", "k1", "boom", "w");
  fileIngested(db, "s", item("k1"), task());
  expect(getItemRow(db, "s", "k1")).toMatchObject({ status: "ingested", error: null, failedWindow: null });
});

test("listFailures is newest last_seen_at first", async () => {
  const { db } = setup();
  fileFailure(db, "s", "a", "e", null);
  await Bun.sleep(5);
  fileFailure(db, "s", "b", "e", null);
  expect(listFailures(db, "s").map((r) => r.key)).toEqual(["b", "a"]);
});

test("taskForThread finds a task through any row of the thread", () => {
  const { db, task } = setup();
  const t = task();
  fileIngested(db, "s", item("k1"), t);
  fileIngested(db, "s", item("k2"), t);
  expect(taskForThread(db, "s", "th1")).toBe(t);
  expect(taskForThread(db, "s", "other")).toBeNull();
  expect(taskForThread(db, "z", "th1")).toBeNull();
});

test("rowsForTask orders by occurredAt and skips failures", () => {
  const { db, task } = setup();
  const t = task();
  fileIngested(db, "s", item("late", { occurredAt: "2026-10-03T00:00:00.000Z" }), t);
  fileIngested(db, "s", item("early", { occurredAt: "2026-10-02T00:00:00.000Z" }), t);
  expect(rowsForTask(db, t).map((r) => r.key)).toEqual(["early", "late"]);
});

test("repointTask moves rows; deleting the task nulls taskId", () => {
  const { db, task } = setup();
  const a = task();
  const b = task();
  fileIngested(db, "s", item("k1"), a);
  repointTask(db, a, b);
  expect(getItemRow(db, "s", "k1")!.taskId).toBe(b);
  deleteTask(db, b);
  expect(getItemRow(db, "s", "k1")!.taskId).toBeNull();
});
