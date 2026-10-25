import { test, expect, spyOn } from "bun:test";
import { listParticipants } from "../../src/repo/participants";
import { addIdentity, createPerson, ensureRosterDefaults } from "../../src/repo/roster";
import type { SourceParticipant } from "../../src/domain/roster";
import { openDb, migrate } from "../../src/db";
import { pollOnce } from "../../src/sources/poller";
import { getCursor } from "../../src/repo/sourceState";
import { findTaskBySource, deleteTask, updateTask } from "../../src/repo/tasks";
import { recordMergedSourceItem } from "../../src/repo/mergedSourceItems";
import type { LegacyTaskSource, LegacyRawItem } from "../../src/sources/types";
import type { Task } from "../../src/domain/task";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function fakeSource(pages: { items: LegacyRawItem[]; cursor: string | null }[]): LegacyTaskSource & {
  seen: (string | null)[];
} {
  let call = 0;
  return {
    id: "fake",
    seen: [],
    async poll(cursor: string | null) {
      this.seen.push(cursor);
      return pages[call++] ?? { items: [], cursor };
    },
  };
}

test("pollOnce ingests items, stores the cursor and calls back per task", async () => {
  const db = freshDb();
  const source = fakeSource([
    {
      items: [
        { externalId: "m1", title: "One", body: "first" },
        { externalId: "m2", title: "Two", body: "second" },
      ],
      cursor: "2026-01-01T10:00:00Z",
    },
  ]);
  const seen: Task[] = [];

  const created = await pollOnce(db, source, async (task) => {
    seen.push(task);
  });

  expect(created).toHaveLength(2);
  expect(seen.map((t) => t.title)).toEqual(["One", "Two"]);
  expect(getCursor(db, "fake")).toBe("2026-01-01T10:00:00Z");
  expect(source.seen).toEqual([null]);
});

test("pollOnce skips items already ingested and resumes from the stored cursor", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [{ externalId: "m1", title: "One", body: "first" }], cursor: "c1" },
    {
      items: [
        { externalId: "m1", title: "One", body: "first" },
        { externalId: "m2", title: "Two", body: "second" },
      ],
      cursor: "c2",
    },
  ]);

  await pollOnce(db, source, async () => {});
  const second = await pollOnce(db, source, async () => {});

  expect(second).toHaveLength(1);
  expect(second[0]?.externalId).toBe("m2");
  expect(source.seen).toEqual([null, "c1"]);
  expect(getCursor(db, "fake")).toBe("c2");
});

test("pollOnce does not re-create a task whose source item was merged away as a duplicate", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [{ externalId: "m1", title: "One", body: "first" }], cursor: "c1" },
    { items: [{ externalId: "m1", title: "One", body: "first" }], cursor: "c1" },
  ]);

  await pollOnce(db, source, async () => {});
  const task = findTaskBySource(db, "fake", "m1")!;
  deleteTask(db, task.id);
  recordMergedSourceItem(db, "fake", "m1");

  const second = await pollOnce(db, source, async () => {});

  expect(second).toHaveLength(0);
});

test("pollOnce calls onTaskChanged when a done task's revision changes, without re-creating it", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [{ externalId: "m1", title: "One", body: "first", revision: "rev-1" }], cursor: "c1" },
    { items: [{ externalId: "m1", title: "One (updated)", body: "second", revision: "rev-2" }], cursor: "c1" },
  ]);
  await pollOnce(db, source, async () => {});
  const task = findTaskBySource(db, "fake", "m1")!;
  updateTask(db, task.id, { state: "done" });

  const changed: { task: Task; item: LegacyRawItem }[] = [];
  const second = await pollOnce(db, source, async () => {}, async (t, item) => {
    changed.push({ task: t, item });
  });

  expect(second).toHaveLength(0);
  expect(changed).toHaveLength(1);
  expect(changed[0]?.task.id).toBe(task.id);
  expect(changed[0]?.item.revision).toBe("rev-2");
});

test("pollOnce does not call onTaskChanged when the revision is unchanged", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [{ externalId: "m1", title: "One", body: "first", revision: "rev-1" }], cursor: "c1" },
    { items: [{ externalId: "m1", title: "One", body: "first", revision: "rev-1" }], cursor: "c1" },
  ]);
  await pollOnce(db, source, async () => {});
  const task = findTaskBySource(db, "fake", "m1")!;
  updateTask(db, task.id, { state: "done" });

  let called = false;
  await pollOnce(db, source, async () => {}, async () => {
    called = true;
  });

  expect(called).toBe(false);
});

test("pollOnce does not call onTaskChanged for a task that is currently processing", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [{ externalId: "m1", title: "One", body: "first", revision: "rev-1" }], cursor: "c1" },
    { items: [{ externalId: "m1", title: "One", body: "second", revision: "rev-2" }], cursor: "c1" },
  ]);
  await pollOnce(db, source, async () => {});
  const task = findTaskBySource(db, "fake", "m1")!;
  updateTask(db, task.id, { state: "processing" });

  let called = false;
  await pollOnce(db, source, async () => {}, async () => {
    called = true;
  });

  expect(called).toBe(false);
});

test("pollOnce does not call onTaskChanged when the item carries no revision at all", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [{ externalId: "m1", title: "One", body: "first" }], cursor: "c1" },
    { items: [{ externalId: "m1", title: "One", body: "changed content" }], cursor: "c1" },
  ]);
  await pollOnce(db, source, async () => {});
  const task = findTaskBySource(db, "fake", "m1")!;
  updateTask(db, task.id, { state: "done" });

  let called = false;
  await pollOnce(db, source, async () => {}, async () => {
    called = true;
  });

  expect(called).toBe(false);
});

test("pollOnce calls onTaskChanged for an assigned_human task whose revision changed", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [{ externalId: "m1", title: "One", body: "first", revision: "rev-1" }], cursor: "c1" },
    { items: [{ externalId: "m1", title: "One", body: "second", revision: "rev-2" }], cursor: "c1" },
  ]);
  await pollOnce(db, source, async () => {});
  const task = findTaskBySource(db, "fake", "m1")!;
  updateTask(db, task.id, { state: "assigned_human", assignee: "human" });

  let called = false;
  await pollOnce(db, source, async () => {}, async () => {
    called = true;
  });

  expect(called).toBe(true);
});

test("pollOnce keeps the old cursor when the source throws", async () => {
  const db = freshDb();
  const source: LegacyTaskSource = {
    id: "fake",
    async poll() {
      throw new Error("network down");
    },
  };

  await expect(pollOnce(db, source, async () => {})).rejects.toThrow("network down");
  expect(getCursor(db, "fake")).toBeNull();
});

test("pollOnce calls onTaskChanged for a dismissed task whose revision changed, so it can be re-triaged", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [{ externalId: "m1", title: "One", body: "side chat", revision: "rev-1" }], cursor: "c1" },
    { items: [{ externalId: "m1", title: "One", body: "@you can you take this?", revision: "rev-2" }], cursor: "c1" },
  ]);
  await pollOnce(db, source, async () => {});
  updateTask(db, findTaskBySource(db, "fake", "m1")!.id, { state: "dismissed" });

  let called = false;
  await pollOnce(db, source, async () => {}, async () => {
    called = true;
  });

  expect(called).toBe(true);
});

test("pollOnce stores a new item's participants, normalized and resolved", async () => {
  const db = freshDb();
  ensureRosterDefaults(db);
  const bob = createPerson(db, { name: "Bob", orgId: null });
  addIdentity(db, bob.id, "email:bob@acme.test");
  const source = fakeSource([
    {
      items: [
        {
          externalId: "m1",
          title: "One",
          body: "first",
          participants: [
            { identity: "Email:Bob@Acme.TEST", name: "Bob S", role: "from" },
            { identity: "email:ana@acme.test", role: "cc" },
          ],
        },
      ],
      cursor: "c1",
    },
  ]);

  const [task] = await pollOnce(db, source, async () => {});

  const rows = listParticipants(db, task!.id);
  expect(rows.map((r) => [r.identity, r.role, r.sourceName])).toEqual([
    ["email:bob@acme.test", "from", "Bob S"],
    ["email:ana@acme.test", "cc", null],
  ]);
  expect(rows[0]?.person?.displayName).toBe("Bob");
});

test("pollOnce drops malformed participants with one warning and keeps the rest", async () => {
  const db = freshDb();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const source = fakeSource([
    {
      items: [
        {
          externalId: "m1",
          title: "One",
          body: "first",
          participants: [
            { identity: "bob", role: "from" },
            { identity: "email:x@y.test", role: "boss" } as unknown as SourceParticipant,
            { identity: "github:ok", role: "author" },
          ],
        },
      ],
      cursor: "c1",
    },
  ]);

  const [task] = await pollOnce(db, source, async () => {});

  expect(listParticipants(db, task!.id).map((r) => r.identity)).toEqual(["github:ok"]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain("fake");
  warn.mockRestore();
});

test("pollOnce merges participants for an item it already has, without duplicates", async () => {
  const db = freshDb();
  const item = { externalId: "m1", title: "One", body: "first" };
  const source = fakeSource([
    { items: [{ ...item, participants: [{ identity: "github:bob", role: "author" as const }] }], cursor: "c1" },
    {
      items: [
        {
          ...item,
          participants: [
            { identity: "github:bob", role: "author" as const },
            { identity: "github:carol", role: "commenter" as const },
          ],
        },
      ],
      cursor: "c2",
    },
  ]);

  const [task] = await pollOnce(db, source, async () => {});
  await pollOnce(db, source, async () => {});

  expect(listParticipants(db, task!.id).map((r) => r.identity)).toEqual(["github:bob", "github:carol"]);
});
