import { test, expect, spyOn } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { startPoller, type PollHooks } from "../../src/sources/poller";
import { listPolls } from "../../src/repo/sourcePolls";
import type { ListResult, SourceItem, TaskSource } from "../../src/sources/types";
import type { Task } from "../../src/domain/task";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

const item = (key: string, title: string): SourceItem => ({
  key,
  occurredAt: "2026-10-20T10:00:00.000Z",
  title,
  body: "",
});

function source(id: string, list: (window: { since: string | null }) => Promise<ListResult>): TaskSource {
  return { id, list };
}

function hooksFor(onCreated: (task: Task) => void): PollHooks {
  return {
    async onCreated(task) {
      onCreated(task);
    },
    async onChanged() {},
  };
}

test("startPoller merges a dynamic source's items into each tick", async () => {
  const db = freshDb();
  const dynamicSource = source("dyn", async () => ({ items: [item("d1", "Dynamic")] }));
  let resolveSeen!: (task: Task) => void;
  const seenPromise = new Promise<Task>((resolve) => {
    resolveSeen = resolve;
  });

  const poller = startPoller(db, [], hooksFor((task) => resolveSeen(task)), 60_000, async () => [dynamicSource]);

  const task = await seenPromise;
  poller.stop();

  expect(task.title).toBe("Dynamic");
  expect(task.sourceId).toBe("dyn");
  expect(listPolls(db, "dyn").map((p) => [p.kind, p.outcome])).toEqual([["poll", "ok"]]);
});

test("a failing loadDynamicSources does not stop the static sources from polling", async () => {
  const db = freshDb();
  const error = spyOn(console, "error").mockImplementation(() => {});
  const staticSource = source("static", async () => ({ items: [item("s1", "Static")] }));
  let resolveSeen!: (task: Task) => void;
  const seenPromise = new Promise<Task>((resolve) => {
    resolveSeen = resolve;
  });

  const poller = startPoller(db, [staticSource], hooksFor((task) => resolveSeen(task)), 60_000, async () => {
    throw new Error("loader exploded");
  });

  const task = await seenPromise;
  poller.stop();
  const logged = error.mock.calls.map((call) => String(call[0]));
  error.mockRestore();

  expect(task.title).toBe("Static");
  expect(logged.join(" | ")).toContain("loadDynamicSources failed");
});

test("a well-behaved static source still gets ingested even when a dynamic source hangs in the same tick", async () => {
  // Sources are polled sequentially as [...sources, ...dynamicSources], so a
  // source that never answers only ever blocks the sources after it in that
  // tick; it can't undo work already done for the ones before it. The hang is
  // released after the assertion so pollSource's 60s timeout never runs out.
  const db = freshDb();
  const staticSource = source("static", async () => ({ items: [item("s1", "Static")] }));
  let releaseHang!: (result: ListResult) => void;
  let hangStarted!: () => void;
  const hanging = new Promise<void>((resolve) => {
    hangStarted = resolve;
  });
  const hangingDynamicSource = source(
    "hanging",
    () =>
      new Promise<ListResult>((resolve) => {
        releaseHang = resolve;
        hangStarted();
      }),
  );

  let resolveSeen!: (task: Task) => void;
  const seenPromise = new Promise<Task>((resolve) => {
    resolveSeen = resolve;
  });

  const poller = startPoller(
    db,
    [staticSource],
    hooksFor((task) => resolveSeen(task)),
    60_000,
    async () => [hangingDynamicSource],
  );

  const task = await seenPromise;
  await hanging;
  poller.stop();

  expect(task.title).toBe("Static");
  expect(listPolls(db, "hanging").map((p) => p.outcome)).toEqual([null]);

  releaseHang({ items: [] });
});

test("running resets even after a tick throws outside the per-source loop, so the next tick still polls (regression for the finally fix)", async () => {
  // TypeScript stops a real caller from passing a loadDynamicSources that
  // resolves to a non-array, but it's a public parameter, so startPoller must
  // not leave its `running` flag stuck if one ever does. Only the first tick's
  // loader misbehaves: its filter call throws before the static source is
  // polled, and if `running` is reset in the `finally` the later ticks (fired
  // by a short interval) poll normally.
  const db = freshDb();
  const error = spyOn(console, "error").mockImplementation(() => {});
  let call = 0;
  const staticSource = source("static", async () => {
    const n = ++call;
    return { items: [item(`s${n}`, `Static ${n}`)] };
  });

  let loadCall = 0;
  const seenTitles: string[] = [];
  let resolveSecond!: () => void;
  const secondSeen = new Promise<void>((resolve) => {
    resolveSecond = resolve;
  });

  const poller = startPoller(
    db,
    [staticSource],
    hooksFor((task) => {
      seenTitles.push(task.title);
      if (seenTitles.length === 2) resolveSecond();
    }),
    50,
    async () => {
      loadCall++;
      return (loadCall === 1 ? {} : []) as unknown as TaskSource[];
    },
  );

  await secondSeen;
  poller.stop();
  const logged = error.mock.calls.map((call) => String(call[0]));
  error.mockRestore();

  // Tick 1 never reached the static source, so the first two tasks come from
  // ticks 2 and 3.
  expect(seenTitles).toEqual(["Static 1", "Static 2"]);
  expect(logged.join(" | ")).toContain("tick failed unexpectedly");
});

test("startPoller ignores a dynamic source whose id collides with a static source", async () => {
  const db = freshDb();
  const error = spyOn(console, "error").mockImplementation(() => {});
  const staticSource = source("outlook", async () => ({ items: [item("static-item", "Static Outlook")] }));
  let dynamicListCalls = 0;
  const dynamicSource = source("outlook", async () => {
    dynamicListCalls++;
    return { items: [item("dynamic-item", "Dynamic Outlook")] };
  });

  const seen: Task[] = [];
  let resolveSeen!: (task: Task) => void;
  const seenPromise = new Promise<Task>((resolve) => {
    resolveSeen = resolve;
  });

  const poller = startPoller(
    db,
    [staticSource],
    hooksFor((task) => {
      seen.push(task);
      resolveSeen(task);
    }),
    60_000,
    async () => [dynamicSource],
  );

  await seenPromise;
  // Both sources are polled sequentially within the same tick, so a dynamic
  // source that slipped past the collision guard would be listed right after
  // the static one. Give it that chance before asserting its absence.
  await new Promise((resolve) => setTimeout(resolve, 20));
  poller.stop();
  const logged = error.mock.calls.map((call) => String(call[0]));
  error.mockRestore();

  expect(dynamicListCalls).toBe(0);
  expect(seen.map((t) => t.title)).toEqual(["Static Outlook"]);
  expect(listPolls(db, "outlook")).toHaveLength(1);
  expect(logged.join(" | ")).toContain('ignoring dynamic source "outlook"');
});

test("startPoller hands a changed task and its new items to onChanged", async () => {
  const db = freshDb();
  let call = 0;
  const threaded = source("mail", async () => {
    call++;
    const first = { ...item("m1", "Hello"), threadKey: "t1" };
    const reply = { ...item("m2", "Re: Hello"), threadKey: "t1", occurredAt: "2026-10-20T11:00:00.000Z" };
    return { items: call === 1 ? [first] : [first, reply] };
  });

  let resolveChanged!: (value: { task: Task; keys: string[] }) => void;
  const changedPromise = new Promise<{ task: Task; keys: string[] }>((resolve) => {
    resolveChanged = resolve;
  });

  const poller = startPoller(
    db,
    [threaded],
    {
      async onCreated() {},
      async onChanged(task, newItems) {
        resolveChanged({ task, keys: newItems.map((i) => i.key) });
      },
    },
    50,
  );

  const { task, keys } = await changedPromise;
  poller.stop();

  expect(task.externalId).toBe("t1");
  expect(keys).toEqual(["m2"]);
});
