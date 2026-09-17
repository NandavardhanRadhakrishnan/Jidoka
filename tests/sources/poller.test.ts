import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { pollOnce } from "../../src/sources/poller";
import { getCursor } from "../../src/repo/sourceState";
import type { TaskSource, RawItem } from "../../src/sources/types";
import type { Task } from "../../src/domain/task";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function fakeSource(pages: { items: RawItem[]; cursor: string | null }[]): TaskSource & {
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

test("pollOnce keeps the old cursor when the source throws", async () => {
  const db = freshDb();
  const source: TaskSource = {
    id: "fake",
    async poll() {
      throw new Error("network down");
    },
  };

  await expect(pollOnce(db, source, async () => {})).rejects.toThrow("network down");
  expect(getCursor(db, "fake")).toBeNull();
});
