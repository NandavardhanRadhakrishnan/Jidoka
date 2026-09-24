import { test, expect } from "bun:test";
import { LANES, LANE_OF, filterByDateRange, groupByLane, daysUntil, deadlineUrgency } from "../../src/client/columns";
import type { Task, TaskState } from "../../src/domain/task";

function task(id: string, state: TaskState, createdAt = "2026-01-01T00:00:00.000Z"): Task {
  return {
    id,
    sourceId: "outlook",
    externalId: id,
    url: null,
    title: id,
    body: "",
    metadata: {},
    typeId: null,
    typeCandidates: null,
    state,
    assignee: null,
    deadline: null,
    dedupCandidateId: null,
    context: {},
    createdAt,
    updatedAt: createdAt,
  };
}

test("every task state maps to exactly one of the three lanes", () => {
  expect(LANES.map((l) => l.key)).toEqual(["needs", "running", "settled"]);
  const states: TaskState[] = [
    "ingested",
    "needs_type_confirmation",
    "needs_onboarding",
    "needs_dedup_confirmation",
    "processing",
    "assigned_ai",
    "assigned_human",
    "done",
    "failed",
  ];
  for (const state of states) {
    expect(["needs", "running", "settled"]).toContain(LANE_OF[state]);
  }
});

test("needs_dedup_confirmation lands in the needs lane specifically", () => {
  expect(LANE_OF.needs_dedup_confirmation).toBe("needs");
});

test("groupByLane buckets tasks and leaves empty lanes present", () => {
  const grouped = groupByLane([task("a", "ingested"), task("b", "assigned_human"), task("c", "ingested")]);

  expect(grouped.running.map((t) => t.id)).toEqual(["a", "c"]);
  expect(grouped.needs.map((t) => t.id)).toEqual(["b"]);
  expect(grouped.settled).toEqual([]);
});

test("filterByDateRange with no bounds returns tasks unchanged", () => {
  const tasks = [task("a", "done", "2026-01-05T00:00:00.000Z")];
  expect(filterByDateRange(tasks, "", "")).toEqual(tasks);
});

test("filterByDateRange keeps only tasks created within an inclusive [from, to] window", () => {
  const tasks = [
    task("early", "done", "2026-01-01T12:00:00.000Z"),
    task("mid", "done", "2026-01-05T12:00:00.000Z"),
    task("late", "done", "2026-01-10T12:00:00.000Z"),
  ];

  expect(filterByDateRange(tasks, "2026-01-03", "2026-01-07").map((t) => t.id)).toEqual(["mid"]);
  expect(filterByDateRange(tasks, "2026-01-05", "2026-01-05").map((t) => t.id)).toEqual(["mid"]);
  expect(filterByDateRange(tasks, "2026-01-05", "").map((t) => t.id)).toEqual(["mid", "late"]);
  expect(filterByDateRange(tasks, "", "2026-01-05").map((t) => t.id)).toEqual(["early", "mid"]);
});

test("daysUntil counts whole days between today and a yyyy-mm-dd deadline", () => {
  const today = new Date();
  const iso = (offsetDays: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };

  expect(daysUntil(iso(0))).toBe(0);
  expect(daysUntil(iso(3))).toBe(3);
  expect(daysUntil(iso(-2))).toBe(-2);
});

test("deadlineUrgency labels and tones an overdue, due-today, soon, and later deadline", () => {
  expect(deadlineUrgency(-2)).toEqual({ label: "2d overdue", cls: "deadline-overdue" });
  expect(deadlineUrgency(0)).toEqual({ label: "due today", cls: "deadline-today" });
  expect(deadlineUrgency(2)).toEqual({ label: "2d left", cls: "deadline-soon" });
  expect(deadlineUrgency(6)).toEqual({ label: "6d left", cls: "deadline-later" });
});
