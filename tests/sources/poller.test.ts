import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { pollOnce, startPoller } from "../../src/sources/poller";
import { getCursor } from "../../src/repo/sourceState";
import { findTaskBySource, deleteTask } from "../../src/repo/tasks";
import { recordMergedSourceItem } from "../../src/repo/mergedSourceItems";
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

test("startPoller merges a dynamic source's items into each tick", async () => {
  const db = freshDb();
  const dynamicSource: TaskSource = {
    id: "dyn",
    async poll() {
      return { items: [{ externalId: "d1", title: "Dynamic", body: "" }], cursor: "dyn-cursor" };
    },
  };
  let resolveSeen!: (task: Task) => void;
  const seenPromise = new Promise<Task>((resolve) => {
    resolveSeen = resolve;
  });

  const poller = startPoller(
    db,
    [],
    async (task) => {
      resolveSeen(task);
    },
    60_000,
    async () => [dynamicSource],
  );

  const task = await seenPromise;
  poller.stop();

  expect(task.title).toBe("Dynamic");
  expect(getCursor(db, "dyn")).toBe("dyn-cursor");
});

test("a failing loadDynamicSources does not stop the static sources from polling", async () => {
  const db = freshDb();
  const staticSource: TaskSource = {
    id: "static",
    async poll() {
      return { items: [{ externalId: "s1", title: "Static", body: "" }], cursor: "static-cursor" };
    },
  };
  let resolveSeen!: (task: Task) => void;
  const seenPromise = new Promise<Task>((resolve) => {
    resolveSeen = resolve;
  });

  const poller = startPoller(
    db,
    [staticSource],
    async (task) => {
      resolveSeen(task);
    },
    60_000,
    async () => {
      throw new Error("loader exploded");
    },
  );

  const task = await seenPromise;
  poller.stop();

  expect(task.title).toBe("Static");
});

test("a well-behaved static source still gets ingested even when a dynamic source hangs in the same tick", async () => {
  // Sources are merged as [...sources, ...dynamicSources] and polled
  // sequentially, so a source that never resolves only ever blocks sources
  // that come *after* it in that same tick — it can't undo work already
  // done for sources processed earlier. This is a baseline sanity check,
  // not itself a regression test for the `finally` fix (see Finding 1 test
  // below for that).
  const db = freshDb();
  const staticSource: TaskSource = {
    id: "static",
    async poll() {
      return { items: [{ externalId: "s1", title: "Static", body: "" }], cursor: "static-cursor" };
    },
  };
  const hangingDynamicSource: TaskSource = {
    id: "hanging",
    poll() {
      return new Promise(() => {});
    },
  };

  let resolveSeen!: (task: Task) => void;
  const seenPromise = new Promise<Task>((resolve) => {
    resolveSeen = resolve;
  });

  const poller = startPoller(
    db,
    [staticSource],
    async (task) => {
      resolveSeen(task);
    },
    60_000,
    async () => [hangingDynamicSource],
  );

  const task = await seenPromise;
  poller.stop();

  expect(task.title).toBe("Static");
});

test("running resets even after a tick throws outside the per-source loop, so the next tick still polls (regression for the finally fix)", async () => {
  // TypeScript's types stop a real caller from passing a loadDynamicSources
  // that resolves to a non-array, but startPoller must not corrupt its
  // internal `running` flag even if one ever did (it's a public parameter).
  // Before the fix, `[...sources, ...dynamicSources]` (now
  // `...uniqueDynamicSources`, but the same hazard applies to the filter
  // call on a non-array) would throw *outside* any try/catch, and because
  // `running = false` only ran on the successful-completion path, `running`
  // would stay stuck at `true` forever — every later tick's
  // `if (running) return;` would then silently skip polling the
  // well-behaved static source too.
  //
  // Only the first tick's loader misbehaves; if `running` is correctly
  // reset in the `finally`, the second tick (fired via a short intervalMs)
  // proceeds normally and ingests the static source's second item.
  const db = freshDb();
  let call = 0;
  const staticSource: TaskSource = {
    id: "static",
    async poll() {
      const n = ++call;
      return {
        items: [{ externalId: `s${n}`, title: `Static ${n}`, body: "" }],
        cursor: `static-cursor-${n}`,
      };
    },
  };

  let loadCall = 0;
  const seenTitles: string[] = [];
  let resolveFirst!: () => void;
  let resolveSecond!: () => void;
  const firstSeen = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const secondSeen = new Promise<void>((resolve) => {
    resolveSecond = resolve;
  });

  const poller = startPoller(
    db,
    [staticSource],
    async (task) => {
      seenTitles.push(task.title);
      if (seenTitles.length === 1) resolveFirst();
      if (seenTitles.length === 2) resolveSecond();
    },
    50,
    async () => {
      loadCall++;
      return (loadCall === 1 ? {} : []) as unknown as TaskSource[];
    },
  );

  await firstSeen;
  await secondSeen;
  poller.stop();

  // Tick 1's dynamicSources.filter call throws before the static source is
  // ever polled (it never gets a "Static 0"), so the first two items
  // actually ingested come from ticks 2 and 3 — proving `running` was
  // reset after tick 1's error and both later ticks ran normally.
  expect(seenTitles).toEqual(["Static 1", "Static 2"]);
});

test("startPoller ignores a dynamic source whose id collides with a static source", async () => {
  const db = freshDb();
  const staticSource: TaskSource = {
    id: "outlook",
    async poll() {
      return {
        items: [{ externalId: "static-item", title: "Static Outlook", body: "" }],
        cursor: "static-cursor",
      };
    },
  };
  let dynamicPollCalls = 0;
  const dynamicSource: TaskSource = {
    id: "outlook",
    async poll() {
      dynamicPollCalls++;
      return {
        items: [{ externalId: "dynamic-item", title: "Dynamic Outlook", body: "" }],
        cursor: "dynamic-cursor",
      };
    },
  };

  const seen: Task[] = [];
  let resolveSeen!: (task: Task) => void;
  const seenPromise = new Promise<Task>((resolve) => {
    resolveSeen = resolve;
  });

  const poller = startPoller(
    db,
    [staticSource],
    async (task) => {
      seen.push(task);
      resolveSeen(task);
    },
    60_000,
    async () => [dynamicSource],
  );

  await seenPromise;
  // The static and dynamic sources are polled sequentially within the same
  // tick, so if the collision guard failed to filter the dynamic source out,
  // its poll() (and a second onTask call for "dynamic-item") would run
  // immediately after the static source's, well within this tick and before
  // the 60s interval ever fires again. Flush pending microtasks/macrotasks
  // so a wrongly-included dynamic poll has had its chance to run before we
  // assert its absence.
  await new Promise((resolve) => setTimeout(resolve, 20));
  poller.stop();

  expect(dynamicPollCalls).toBe(0);
  expect(seen.map((t) => t.title)).toEqual(["Static Outlook"]);
  expect(getCursor(db, "outlook")).toBe("static-cursor");
});
