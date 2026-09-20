import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { insertTaskType } from "../../src/repo/taskTypes";
import {
  insertRule,
  getRule,
  getActiveRule,
  activateRule,
  listRules,
} from "../../src/repo/rules";
import { RuleDefinitionSchema } from "../../src/domain/rule";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

const definition = RuleDefinitionSchema.parse({
  steps: [{ id: "s1", type: "assign", to: "human" }],
});

test("insertRule starts as a draft at version 1", () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Email query", description: "d" });

  const rule = insertRule(db, { typeId: type.id, definition });

  expect(rule.version).toBe(1);
  expect(rule.status).toBe("draft");
  expect(getActiveRule(db, type.id)).toBeNull();
  expect(getRule(db, rule.id)?.definition).toEqual(definition);
});

test("activateRule makes it current and demotes the previous one", () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Email query", description: "d" });
  const v1 = activateRule(db, insertRule(db, { typeId: type.id, definition }).id);
  const v2 = insertRule(db, { typeId: type.id, definition });

  expect(v2.version).toBe(2);
  expect(getActiveRule(db, type.id)?.id).toBe(v1.id);

  activateRule(db, v2.id);

  expect(getActiveRule(db, type.id)?.id).toBe(v2.id);
  expect(getRule(db, v1.id)?.status).toBe("superseded");
  expect(listRules(db, type.id)).toHaveLength(2);
});
