import { test, expect } from "bun:test";
import { COLUMNS, groupByColumn } from "../../src/client/columns";
import type { Task } from "../../src/domain/task";

function task(id: string, state: Task["state"]): Task {
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
    context: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("the board has one column per task state in flow order", () => {
  expect(COLUMNS.map((c) => c.state)).toEqual([
    "ingested",
    "needs_type_confirmation",
    "needs_onboarding",
    "processing",
    "assigned_ai",
    "assigned_human",
    "done",
    "failed",
  ]);
});

test("groupByColumn buckets tasks and leaves empty columns present", () => {
  const grouped = groupByColumn([task("a", "ingested"), task("b", "assigned_human"), task("c", "ingested")]);

  expect(grouped.ingested.map((t) => t.id)).toEqual(["a", "c"]);
  expect(grouped.assigned_human.map((t) => t.id)).toEqual(["b"]);
  expect(grouped.done).toEqual([]);
});
