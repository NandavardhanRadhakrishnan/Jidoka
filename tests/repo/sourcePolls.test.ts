import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import {
  finishPoll,
  getHorizon,
  lastPoll,
  listPolls,
  nextWindow,
  setHorizon,
  startPoll,
} from "../../src/repo/sourcePolls";

const db0 = () => {
  const db = openDb(":memory:");
  migrate(db);
  return db;
};
const ok = { outcome: "ok" as const, seen: 0, new: 0, changed: 0, failed: 0, unkeyedFailures: [] };
const NOW = new Date("2026-10-25T12:00:00.000Z");

/** Inserts a finished poll with a chosen start time. */
function poll(db: ReturnType<typeof db0>, kind: "poll" | "retry" | "rescan", startedAt: string, outcome: "ok" | "error") {
  db.query(
    "INSERT INTO source_polls (id, source_id, kind, since, started_at, finished_at, outcome) VALUES (?, 's', ?, NULL, ?, ?, ?)",
  ).run(crypto.randomUUID(), kind, startedAt, startedAt, outcome);
}

test("nextWindow on a new source is first, now minus 7 days, and writes no horizon", () => {
  const db = db0();
  expect(nextWindow(db, "s", NOW)).toEqual({ since: "2026-10-18T12:00:00.000Z", isFirst: true });
  expect(getHorizon(db, "s")).toBeNull();
});

test("horizon with no ok poll: since is the horizon", () => {
  const db = db0();
  setHorizon(db, "s", "2026-10-18T12:00:00.000Z");
  expect(getHorizon(db, "s")).toBe("2026-10-18T12:00:00.000Z");
  expect(nextWindow(db, "s", NOW)).toEqual({ since: "2026-10-18T12:00:00.000Z", isFirst: false });
});

test("after an ok poll started at T, since is T minus 5 minutes", () => {
  const db = db0();
  setHorizon(db, "s", "2026-10-18T12:00:00.000Z");
  poll(db, "poll", "2026-10-25T10:00:00.000Z", "ok");
  expect(nextWindow(db, "s", NOW).since).toBe("2026-10-25T09:55:00.000Z");
});

test("later ok rescan/retry and error polls do not move the window", () => {
  const db = db0();
  setHorizon(db, "s", "2026-10-18T12:00:00.000Z");
  poll(db, "poll", "2026-10-25T10:00:00.000Z", "ok");
  poll(db, "rescan", "2026-10-25T10:30:00.000Z", "ok");
  poll(db, "retry", "2026-10-25T10:40:00.000Z", "ok");
  poll(db, "poll", "2026-10-25T11:00:00.000Z", "error");
  expect(nextWindow(db, "s", NOW).since).toBe("2026-10-25T09:55:00.000Z");
});

test("ok polls before the horizon are ignored", () => {
  const db = db0();
  poll(db, "poll", "2026-10-01T10:00:00.000Z", "ok");
  setHorizon(db, "s", "2026-10-18T12:00:00.000Z");
  expect(nextWindow(db, "s", NOW).since).toBe("2026-10-18T12:00:00.000Z");
});

test("startPoll/finishPoll store counts and unkeyed failures; listPolls newest first", async () => {
  const db = db0();
  const a = startPoll(db, "s", "poll", "2026-10-18T12:00:00.000Z");
  expect(a).toMatchObject({ sourceId: "s", kind: "poll", since: "2026-10-18T12:00:00.000Z", finishedAt: null, outcome: null });
  const done = finishPoll(db, a.id, {
    outcome: "ok",
    seen: 5,
    new: 3,
    changed: 1,
    failed: 2,
    unkeyedFailures: [{ error: "bad" }, { key: "k", error: "worse" }],
  });
  expect(done).toMatchObject({ outcome: "ok", seen: 5, new: 3, changed: 1, failed: 2 });
  expect(done.finishedAt).not.toBeNull();
  expect(done.unkeyedFailures).toEqual([{ error: "bad" }, { key: "k", error: "worse" }]);
  await Bun.sleep(5);
  const b = startPoll(db, "s", "rescan", null);
  finishPoll(db, b.id, { ...ok, outcome: "error", error: "timeout" });
  expect(listPolls(db, "s").map((p) => p.id)).toEqual([b.id, a.id]);
  expect(listPolls(db, "s", 1)).toHaveLength(1);
  expect(listPolls(db, "s")[0]!.error).toBe("timeout");
});

test("lastPoll is the newest kind=poll of any outcome", async () => {
  const db = db0();
  expect(lastPoll(db, "s")).toBeNull();
  const a = startPoll(db, "s", "poll", null);
  finishPoll(db, a.id, ok);
  await Bun.sleep(5);
  const b = startPoll(db, "s", "poll", null);
  finishPoll(db, b.id, { ...ok, outcome: "error", error: "x" });
  await Bun.sleep(5);
  const c = startPoll(db, "s", "rescan", null);
  finishPoll(db, c.id, ok);
  expect(lastPoll(db, "s")!.id).toBe(b.id);
});
