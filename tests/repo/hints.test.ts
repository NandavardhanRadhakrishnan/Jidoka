import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import {
  insertHint,
  listHintsForRule,
  listHintsForStep,
  deleteHint,
} from "../../src/repo/hints";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

test("insertHint then listHintsForRule finds it", () => {
  const db = freshDb();
  const ruleId = crypto.randomUUID();

  const hint = insertHint(db, {
    ruleId,
    stepId: "summarize",
    text: "Use title case for partner names",
  });

  expect(listHintsForRule(db, ruleId)).toEqual([hint]);
  expect(listHintsForRule(db, crypto.randomUUID())).toEqual([]);
});

test("listHintsForStep filters by ruleId and stepId", () => {
  const db = freshDb();
  const ruleA = crypto.randomUUID();
  const ruleB = crypto.randomUUID();

  const onAStep1 = insertHint(db, { ruleId: ruleA, stepId: "step-1", text: "hint A1" });
  insertHint(db, { ruleId: ruleA, stepId: "step-2", text: "hint A2" });
  insertHint(db, { ruleId: ruleB, stepId: "step-1", text: "hint B1" });

  expect(listHintsForStep(db, ruleA, "step-1")).toEqual([onAStep1]);
  expect(listHintsForStep(db, ruleA, "step-2")).toHaveLength(1);
  expect(listHintsForStep(db, ruleB, "step-1")).toHaveLength(1);
  expect(listHintsForStep(db, ruleB, "step-2")).toEqual([]);
});

test("deleteHint removes the row", () => {
  const db = freshDb();
  const ruleId = crypto.randomUUID();

  const hint = insertHint(db, { ruleId, stepId: "s1", text: "temporary" });
  expect(listHintsForRule(db, ruleId)).toHaveLength(1);

  deleteHint(db, hint.id);

  expect(listHintsForRule(db, ruleId)).toEqual([]);
  expect(listHintsForStep(db, ruleId, "s1")).toEqual([]);
});

test("excerpt round-trips when set and when omitted", () => {
  const db = freshDb();
  const ruleId = crypto.randomUUID();

  const withExcerpt = insertHint(db, {
    ruleId,
    stepId: "s1",
    text: "fix casing",
    excerpt: "aditya birla",
  });
  const withoutExcerpt = insertHint(db, {
    ruleId,
    stepId: "s1",
    text: "no selection",
  });
  const explicitNull = insertHint(db, {
    ruleId,
    stepId: "s1",
    text: "explicit null",
    excerpt: null,
  });

  expect(withExcerpt.excerpt).toBe("aditya birla");
  expect(withoutExcerpt.excerpt).toBeNull();
  expect(explicitNull.excerpt).toBeNull();

  const listed = listHintsForStep(db, ruleId, "s1");
  expect(listed.find((h) => h.id === withExcerpt.id)?.excerpt).toBe("aditya birla");
  expect(listed.find((h) => h.id === withoutExcerpt.id)?.excerpt).toBeNull();
  expect(listed.find((h) => h.id === explicitNull.id)?.excerpt).toBeNull();
});
