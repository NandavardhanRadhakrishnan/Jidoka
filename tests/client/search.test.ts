import { test, expect } from "bun:test";
import { matchesQuery } from "../../src/client/search";
import type { Task } from "../../src/domain/task";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    sourceId: "outlook",
    externalId: "t1",
    url: null,
    title: "aditya birla product config",
    body: "configure mph 2-91-26-0002264-000, male ABHDFCPH001 female ABHDFCPHC002",
    metadata: {},
    typeId: null,
    typeCandidates: null,
    state: "ingested",
    assignee: null,
    deadline: null,
    dedupCandidateId: null,
    context: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("an empty query matches every task", () => {
  expect(matchesQuery(task(), "")).toBe(true);
  expect(matchesQuery(task(), "   ")).toBe(true);
});

test("matches a substring in the title, case-insensitively", () => {
  expect(matchesQuery(task(), "ADITYA")).toBe(true);
  expect(matchesQuery(task(), "birla")).toBe(true);
});

test("matches an exact code in the body", () => {
  expect(matchesQuery(task(), "2-91-26-0002264-000")).toBe(true);
  expect(matchesQuery(task(), "ABHDFCPH001")).toBe(true);
});

test("matches a string value nested anywhere in context", () => {
  const t = task({
    context: {
      extracted_fields: '{"partnerName": "Aditya Birla", "mph": "2-91-26-0002264-000"}',
      nested: { list: ["devops.infra", { deep: "mongo_query_text" }] },
    },
  });
  expect(matchesQuery(t, "devops.infra")).toBe(true);
  expect(matchesQuery(t, "mongo_query_text")).toBe(true);
});

test("does not match text that isn't present anywhere", () => {
  expect(matchesQuery(task(), "invoice mismatch")).toBe(false);
});
