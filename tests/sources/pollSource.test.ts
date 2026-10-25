import { test, expect, spyOn } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { pollSource, retryFailure, rescanSource, type PollHooks } from "../../src/sources/poller";
import { deleteTask, findTaskBySource, getTask, insertTask, listTasks, updateTask } from "../../src/repo/tasks";
import { dismissFailure, fileFailure, getItemRow } from "../../src/repo/sourceItems";
import { getHorizon, nextWindow } from "../../src/repo/sourcePolls";
import { listParticipants } from "../../src/repo/participants";
import { addIdentity, createPerson, ensureRosterDefaults } from "../../src/repo/roster";
import type { SourceParticipant } from "../../src/domain/roster";
import type { ListResult, SourceItem, TaskSource } from "../../src/sources/types";
import type { Task } from "../../src/domain/task";

const FIVE_MIN = 5 * 60 * 1000;
const SEVEN_DAYS = 7 * 86_400_000;

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

type Step = ListResult | Error | (() => Promise<ListResult>);

/** A source that records every `since` it was asked for and plays back a script. */
function fakeSource(script: Step[]): TaskSource & { since: (string | null)[] } {
  const since: (string | null)[] = [];
  let call = 0;
  return {
    id: "fake",
    since,
    async list(window) {
      since.push(window.since);
      const next = script[call++] ?? { items: [] };
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next();
      return next;
    },
  };
}

function recorder(over: Partial<PollHooks> = {}) {
  const created: Task[] = [];
  const changed: { task: Task; items: SourceItem[] }[] = [];
  const hooks: PollHooks = {
    async onCreated(task) {
      created.push(task);
    },
    async onChanged(task, items) {
      changed.push({ task, items });
    },
    ...over,
  };
  return { created, changed, hooks };
}

const item = (key: string, over: Partial<SourceItem> = {}): SourceItem => ({
  key,
  occurredAt: "2026-10-20T10:00:00.000Z",
  title: `Title ${key}`,
  body: `Body ${key}`,
  ...over,
});

// ── Windows ──────────────────────────────────────────────────────────────────

test("first poll lists from now − 7 days, records the horizon, creates tasks", async () => {
  const db = freshDb();
  const source = fakeSource([{ items: [item("a"), item("b")] }]);
  const { created, hooks } = recorder();
  const now = new Date();

  const { poll } = await pollSource(db, source, hooks, { now });

  const since = new Date(now.getTime() - SEVEN_DAYS).toISOString();
  expect(source.since).toEqual([since]);
  expect(getHorizon(db, "fake")).toBe(since);
  expect(poll).toMatchObject({ kind: "poll", since, outcome: "ok", seen: 2, new: 2, changed: 0, failed: 0 });
  expect(listTasks(db)).toHaveLength(2);
  expect(created.map((t) => t.externalId).sort()).toEqual(["a", "b"]);
});

test("second poll lists from the first poll's start − 5 minutes", async () => {
  const db = freshDb();
  const source = fakeSource([{ items: [item("a")] }, { items: [] }]);
  const { hooks } = recorder();

  const first = await pollSource(db, source, hooks);
  await pollSource(db, source, hooks);

  expect(source.since[1]).toBe(new Date(Date.parse(first.poll.startedAt) - FIVE_MIN).toISOString());
});

test("a list that throws is an error poll and holds the window", async () => {
  const db = freshDb();
  const error = spyOn(console, "error").mockImplementation(() => {});
  const source = fakeSource([{ items: [] }, new Error("boom"), { items: [] }]);
  const { hooks } = recorder();

  await pollSource(db, source, hooks);
  const { poll } = await pollSource(db, source, hooks);
  await pollSource(db, source, hooks);

  expect(poll).toMatchObject({ outcome: "error", error: "boom" });
  expect(source.since[2]).toBe(source.since[1]);
  expect(error).toHaveBeenCalledTimes(1);
  expect(String(error.mock.calls[0]?.[0])).toBe("[poller] fake: boom");
  error.mockRestore();
});

test("a list slower than timeoutMs is an error poll", async () => {
  const db = freshDb();
  const error = spyOn(console, "error").mockImplementation(() => {});
  const source = fakeSource([() => new Promise<ListResult>(() => {})]);
  const { hooks } = recorder();

  const { poll } = await pollSource(db, source, hooks, { timeoutMs: 50 });

  expect(poll.outcome).toBe("error");
  expect(poll.error).toBe("list timed out after 50ms");
  expect(error).toHaveBeenCalledTimes(1);
  error.mockRestore();
});

test("the default list timeout is 60 seconds", async () => {
  const db = freshDb();
  const error = spyOn(console, "error").mockImplementation(() => {});
  const delays: number[] = [];
  // Fire the timer straight away so the test doesn't wait a minute.
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
  const source = fakeSource([() => new Promise<ListResult>(() => {})]);
  const { hooks } = recorder();

  const { poll } = await pollSource(db, source, hooks);
  timer.mockRestore();

  expect(delays).toContain(60_000);
  expect(poll.error).toBe("list timed out after 60s");
  error.mockRestore();
});

// ── Filing ───────────────────────────────────────────────────────────────────

test("a list that returns the same items again is skipped, with no hooks", async () => {
  const db = freshDb();
  const items = [item("a", { version: "1" }), item("b")];
  const source = fakeSource([{ items }, { items }]);
  const { created, changed, hooks } = recorder();

  await pollSource(db, source, hooks);
  const before = findTaskBySource(db, "fake", "a")!;
  const { poll } = await pollSource(db, source, hooks);

  expect(poll).toMatchObject({ outcome: "ok", seen: 2, new: 0, changed: 0 });
  expect(created).toHaveLength(2);
  expect(changed).toHaveLength(0);
  expect(listTasks(db)).toHaveLength(2);
  expect(getTask(db, before.id)!.updatedAt).toBe(before.updatedAt);
});

test("a new version updates the row and the task, and fires onChanged", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [item("a", { version: "1", body: "old body" })] },
    { items: [item("a", { version: "2", body: "new body", url: "http://x/a2" })] },
  ]);
  const { changed, hooks } = recorder();

  await pollSource(db, source, hooks);
  const { poll } = await pollSource(db, source, hooks);

  expect(poll).toMatchObject({ new: 0, changed: 1 });
  expect(getItemRow(db, "fake", "a")).toMatchObject({ version: "2", body: "new body" });
  const task = findTaskBySource(db, "fake", "a")!;
  expect(task.body).toContain("new body");
  expect(task.body).not.toContain("old body");
  expect(task.url).toBe("http://x/a2");
  expect(changed).toHaveLength(1);
  expect(changed[0]!.task.id).toBe(task.id);
  expect(changed[0]!.items.map((i) => [i.key, i.version])).toEqual([["a", "2"]]);
});

test("a known key that comes back with a different thread key is a failure; the task is untouched", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [item("a", { threadKey: "t1" })] },
    { items: [item("a", { threadKey: "t2", version: "2", body: "moved" })] },
  ]);
  const { changed, hooks } = recorder();

  await pollSource(db, source, hooks);
  const before = findTaskBySource(db, "fake", "t1")!;
  const { poll } = await pollSource(db, source, hooks);

  expect(poll).toMatchObject({ outcome: "ok", changed: 0, failed: 1 });
  expect(poll.unkeyedFailures).toHaveLength(1);
  expect(poll.unkeyedFailures[0]!.error).toContain("a");
  expect(poll.unkeyedFailures[0]!.error).toContain("thread key changed");
  expect(getItemRow(db, "fake", "a")).toMatchObject({ status: "ingested", threadKey: "t1" });
  expect(getTask(db, before.id)!.body).toBe(before.body);
  expect(changed).toHaveLength(0);
});

// ── Threads ──────────────────────────────────────────────────────────────────

test("two keys with one thread key give one task, body in occurredAt order", async () => {
  const db = freshDb();
  const source = fakeSource([
    {
      items: [
        item("reply", { threadKey: "th", occurredAt: "2026-10-20T11:00:00.000Z", title: "Re: Hi", body: "second" }),
        item("root", { threadKey: "th", occurredAt: "2026-10-20T10:00:00.000Z", title: "Hi", body: "first" }),
      ],
    },
  ]);
  const { created, changed, hooks } = recorder();

  await pollSource(db, source, hooks);

  const tasks = listTasks(db);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.externalId).toBe("th");
  expect(tasks[0]!.title).toBe("Hi");
  expect(tasks[0]!.body.indexOf("first")).toBeLessThan(tasks[0]!.body.indexOf("second"));
  expect(getItemRow(db, "fake", "reply")!.taskId).toBe(tasks[0]!.id);
  expect(getItemRow(db, "fake", "root")!.taskId).toBe(tasks[0]!.id);
  expect(created).toHaveLength(1);
  expect(changed).toHaveLength(0);
});

test("a reply before its root: still one task, retitled when the root arrives", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [item("reply", { threadKey: "th", occurredAt: "2026-10-20T11:00:00.000Z", title: "Re: Hi" })] },
    { items: [item("root", { threadKey: "th", occurredAt: "2026-10-20T10:00:00.000Z", title: "Hi" })] },
  ]);
  const { created, changed, hooks } = recorder();

  await pollSource(db, source, hooks);
  expect(listTasks(db)[0]!.title).toBe("Re: Hi");
  await pollSource(db, source, hooks);

  const tasks = listTasks(db);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.title).toBe("Hi");
  expect(created).toHaveLength(1);
  expect(changed).toHaveLength(1);
  expect(changed[0]!.items.map((i) => i.key)).toEqual(["root"]);
});

test("after a task is deleted, a new item for its thread creates a new task", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [item("a", { threadKey: "th" })] },
    { items: [item("b", { threadKey: "th" })] },
  ]);
  const { created, hooks } = recorder();

  await pollSource(db, source, hooks);
  const first = findTaskBySource(db, "fake", "th")!;
  deleteTask(db, first.id);
  const { poll } = await pollSource(db, source, hooks);

  expect(poll.outcome).toBe("ok");
  const second = findTaskBySource(db, "fake", "th")!;
  expect(second.id).not.toBe(first.id);
  expect(created.map((t) => t.id)).toEqual([first.id, second.id]);
  expect(getItemRow(db, "fake", "b")!.taskId).toBe(second.id);
});

test("a task that predates the item record is joined, not duplicated", async () => {
  const db = freshDb();
  const existing = insertTask(db, { sourceId: "fake", externalId: "th", title: "Old", body: "old" });
  const source = fakeSource([{ items: [item("a", { threadKey: "th" })] }]);
  const { created, changed, hooks } = recorder();

  await pollSource(db, source, hooks);

  expect(listTasks(db)).toHaveLength(1);
  expect(getItemRow(db, "fake", "a")!.taskId).toBe(existing.id);
  expect(created).toHaveLength(0);
  expect(changed).toHaveLength(0);
});

test("adopting a pre-record task rebuilds it without onChanged; a later item in its thread fires onChanged", async () => {
  const db = freshDb();
  const existing = insertTask(db, { sourceId: "fake", externalId: "th", title: "Old", body: "old" });
  updateTask(db, existing.id, { state: "done" });
  const source = fakeSource([
    {
      items: [
        item("a", { threadKey: "th", occurredAt: "2026-10-20T10:00:00.000Z", title: "Hi", body: "first" }),
        item("b", { threadKey: "th", occurredAt: "2026-10-20T11:00:00.000Z", title: "Re: Hi", body: "second" }),
      ],
    },
    { items: [item("c", { threadKey: "th", occurredAt: "2026-10-21T10:00:00.000Z", title: "Re: Hi", body: "third" })] },
  ]);
  const { created, changed, hooks } = recorder();

  await pollSource(db, source, hooks);

  expect(getItemRow(db, "fake", "a")!.taskId).toBe(existing.id);
  expect(getItemRow(db, "fake", "b")!.taskId).toBe(existing.id);
  const adopted = getTask(db, existing.id)!;
  expect(adopted.state).toBe("done");
  expect(adopted.title).toBe("Hi");
  expect(adopted.body).toContain("first");
  expect(adopted.body).toContain("second");
  expect(adopted.body).not.toContain("old");
  expect(created).toHaveLength(0);
  expect(changed).toHaveLength(0);

  await pollSource(db, source, hooks);

  expect(getItemRow(db, "fake", "c")!.taskId).toBe(existing.id);
  expect(listTasks(db)).toHaveLength(1);
  expect(changed).toHaveLength(1);
  expect(changed[0]!.task.id).toBe(existing.id);
  expect(changed[0]!.items.map((i) => i.key)).toEqual(["c"]);
});

test("a reply threaded onto an unthreaded item's key is a change, not an adoption", async () => {
  const db = freshDb();
  const source = fakeSource([{ items: [item("a")] }, { items: [item("b", { threadKey: "a" })] }]);
  const { created, changed, hooks } = recorder();

  await pollSource(db, source, hooks);
  await pollSource(db, source, hooks);

  expect(listTasks(db)).toHaveLength(1);
  expect(created).toHaveLength(1);
  expect(changed.map((c) => c.items.map((i) => i.key))).toEqual([["b"]]);
});

// ── Failures ─────────────────────────────────────────────────────────────────

test("failures are recorded, other items still file, and failures are not retried", async () => {
  const db = freshDb();
  const source = fakeSource([
    {
      items: [
        item("good"),
        item("bad-date", { occurredAt: "not a date" }),
        { title: "no key", occurredAt: "2026-10-20T10:00:00.000Z", body: "" } as unknown as SourceItem,
      ],
      failures: [{ key: "f1", error: "could not parse" }, { error: "unreadable message" }],
    },
    { items: [] },
  ]);
  const { hooks } = recorder();

  const { poll } = await pollSource(db, source, hooks);

  expect(poll).toMatchObject({ outcome: "ok", new: 1, failed: 4 });
  expect(getItemRow(db, "fake", "f1")).toMatchObject({
    status: "failed",
    error: "could not parse",
    failedWindow: source.since[0],
  });
  expect(getItemRow(db, "fake", "bad-date")).toMatchObject({ status: "failed", failedWindow: source.since[0] });
  expect(poll.unkeyedFailures.map((f) => f.error)).toEqual(["item has no key", "unreadable message"]);
  expect(findTaskBySource(db, "fake", "good")).not.toBeNull();

  const before = getItemRow(db, "fake", "f1");
  await pollSource(db, source, hooks);
  expect(getItemRow(db, "fake", "f1")).toEqual(before);
  expect(source.since).toHaveLength(2);
});

test("a failed or dismissed key that comes back valid is filed as ingested", async () => {
  const db = freshDb();
  fileFailure(db, "fake", "k1", "boom", null);
  fileFailure(db, "fake", "k2", "boom", null);
  dismissFailure(db, "fake", "k2");
  const source = fakeSource([{ items: [item("k1"), item("k2")] }]);
  const { created, hooks } = recorder();

  const outcome = await pollSource(db, source, hooks);

  expect(outcome.poll.new).toBe(2);
  expect(outcome.recovered).toBe(0);
  for (const key of ["k1", "k2"]) {
    const row = getItemRow(db, "fake", key)!;
    expect(row).toMatchObject({ status: "ingested", error: null });
    expect(row.taskId).toBe(findTaskBySource(db, "fake", key)!.id);
  }
  expect(created).toHaveLength(2);
});

test("retry lists from the row's failed window and doesn't move the normal window", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [], failures: [{ key: "k1", error: "boom" }] },
    { items: [] },
    { items: [item("k1")] },
  ]);
  const { hooks } = recorder();

  await pollSource(db, source, hooks);
  await Bun.sleep(5);
  const second = await pollSource(db, source, hooks);
  await Bun.sleep(5);
  const retry = await retryFailure(db, source, "k1", hooks);

  expect(source.since[2]).toBe(source.since[0]);
  expect(retry.poll).toMatchObject({ kind: "retry", since: source.since[0], outcome: "ok", new: 1 });
  expect(getItemRow(db, "fake", "k1")!.status).toBe("ingested");
  expect(nextWindow(db, "fake", new Date()).since).toBe(
    new Date(Date.parse(second.poll.startedAt) - FIVE_MIN).toISOString(),
  );
});

test("retry of a key that isn't failed throws", async () => {
  const db = freshDb();
  const source = fakeSource([]);
  const { hooks } = recorder();
  await expect(retryFailure(db, source, "nope", hooks)).rejects.toThrow("nope");
  expect(source.since).toHaveLength(0);
});

test("rescan lists from the horizon, counts only unseen keys and doesn't move the window", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [item("a")], failures: [{ key: "c", error: "boom" }] },
    { items: [item("a"), item("b"), item("c")] },
  ]);
  const { hooks } = recorder();

  const first = await pollSource(db, source, hooks);
  await Bun.sleep(5);
  const rescan = await rescanSource(db, source, hooks);

  expect(source.since[1]).toBe(getHorizon(db, "fake"));
  expect(rescan.poll).toMatchObject({ kind: "rescan", outcome: "ok", new: 2 });
  expect(rescan.recovered).toBe(1);
  expect(nextWindow(db, "fake", new Date()).since).toBe(
    new Date(Date.parse(first.poll.startedAt) - FIVE_MIN).toISOString(),
  );
});

// ── Crash safety ─────────────────────────────────────────────────────────────

test("a throwing onCreated is logged and doesn't stop filing or other hooks", async () => {
  const db = freshDb();
  const error = spyOn(console, "error").mockImplementation(() => {});
  const source = fakeSource([{ items: [item("a"), item("b")] }]);
  let calls = 0;
  const { hooks } = recorder({
    async onCreated() {
      calls++;
      if (calls === 1) throw new Error("hook broke");
    },
  });

  const { poll } = await pollSource(db, source, hooks);

  expect(poll.outcome).toBe("ok");
  expect(calls).toBe(2);
  expect(getItemRow(db, "fake", "a")!.status).toBe("ingested");
  expect(getItemRow(db, "fake", "b")!.status).toBe("ingested");
  expect(error).toHaveBeenCalledTimes(1);
  error.mockRestore();
});

test("a crash while filing one item rolls back only that item; a re-poll files it once", async () => {
  const db = freshDb();
  const error = spyOn(console, "error").mockImplementation(() => {});
  // Non-enumerable, so the list's duplicate check (which serializes items)
  // passes and the throw happens inside filing, as a Jidoka bug would.
  const broken = { role: "from" } as SourceParticipant;
  Object.defineProperty(broken, "identity", {
    get() {
      throw new Error("getter broke");
    },
  });
  const source = fakeSource([
    { items: [item("a"), item("b", { participants: [broken] })] },
    { items: [item("a"), item("b", { participants: [{ identity: "email:b@x.test", role: "from" }] })] },
  ]);
  const { created, hooks } = recorder();

  const first = await pollSource(db, source, hooks);

  expect(first.poll.outcome).toBe("error");
  expect(first.poll.error).toContain("getter broke");
  expect(getItemRow(db, "fake", "a")!.status).toBe("ingested");
  expect(getItemRow(db, "fake", "b")).toBeNull();
  expect(findTaskBySource(db, "fake", "b")).toBeNull();
  expect(error).toHaveBeenCalledTimes(1);

  const second = await pollSource(db, source, hooks);

  expect(source.since[1]).toBe(source.since[0]);
  expect(second.poll).toMatchObject({ outcome: "ok", new: 1 });
  expect(listTasks(db)).toHaveLength(2);
  expect(created.map((t) => t.externalId)).toEqual(["a", "b"]);
  expect(getItemRow(db, "fake", "b")!.status).toBe("ingested");
  error.mockRestore();
});

// ── Participants ─────────────────────────────────────────────────────────────

test("a new item's participants are stored on its task, normalized and resolved", async () => {
  const db = freshDb();
  ensureRosterDefaults(db);
  const bob = createPerson(db, { name: "Bob", orgId: null });
  addIdentity(db, bob.id, "email:bob@acme.test");
  const source = fakeSource([
    {
      items: [
        item("m1", {
          participants: [
            { identity: "Email:Bob@Acme.TEST", name: "Bob S", role: "from" },
            { identity: "email:ana@acme.test", role: "cc" },
          ],
        }),
      ],
    },
  ]);
  const { created, hooks } = recorder();

  await pollSource(db, source, hooks);

  const rows = listParticipants(db, created[0]!.id);
  expect(rows.map((r) => [r.identity, r.role, r.sourceName])).toEqual([
    ["email:bob@acme.test", "from", "Bob S"],
    ["email:ana@acme.test", "cc", null],
  ]);
  expect(rows[0]?.person?.displayName).toBe("Bob");
  expect(created[0]!.body).toContain("Bob S");
});

test("malformed participants are dropped with one warning; valid ones are kept", async () => {
  const db = freshDb();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const source = fakeSource([
    {
      items: [
        item("m1", {
          participants: [
            { identity: "bob", role: "from" },
            { identity: "email:x@y.test", role: "boss" } as unknown as SourceParticipant,
            { identity: "github:ok", role: "author" },
          ],
        }),
        item("m2", { participants: [{ identity: "nope", role: "from" }] }),
      ],
    },
  ]);
  const { created, hooks } = recorder();

  const { poll } = await pollSource(db, source, hooks);

  expect(poll.outcome).toBe("ok");
  const m1 = created.find((t) => t.externalId === "m1")!;
  expect(listParticipants(db, m1.id).map((r) => r.identity)).toEqual(["github:ok"]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain("fake");
  warn.mockRestore();
});

test("a known item that comes back with an extra participant has it merged without duplicates", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [item("m1", { version: "1", participants: [{ identity: "github:bob", role: "author" }] })] },
    {
      items: [
        item("m1", {
          version: "2",
          participants: [
            { identity: "github:bob", role: "author" },
            { identity: "github:carol", role: "commenter" },
          ],
        }),
      ],
    },
  ]);
  const { created, hooks } = recorder();

  await pollSource(db, source, hooks);
  await pollSource(db, source, hooks);

  expect(listParticipants(db, created[0]!.id).map((r) => r.identity)).toEqual(["github:bob", "github:carol"]);
});
