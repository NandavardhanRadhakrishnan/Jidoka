import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { insertTaskType } from "../../src/repo/taskTypes";
import {
  insertPipeline,
  getPipeline,
  getActivePipeline,
  activatePipeline,
  listPipelines,
} from "../../src/repo/pipelines";
import { PipelineDefinitionSchema } from "../../src/domain/pipeline";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

const definition = PipelineDefinitionSchema.parse({
  steps: [{ id: "s1", type: "assign", to: "human" }],
});

test("insertPipeline starts as a draft at version 1", () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Email query", description: "d" });

  const pipeline = insertPipeline(db, { typeId: type.id, definition });

  expect(pipeline.version).toBe(1);
  expect(pipeline.status).toBe("draft");
  expect(getActivePipeline(db, type.id)).toBeNull();
  expect(getPipeline(db, pipeline.id)?.definition).toEqual(definition);
});

test("activatePipeline makes it current and demotes the previous one", () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Email query", description: "d" });
  const v1 = activatePipeline(db, insertPipeline(db, { typeId: type.id, definition }).id);
  const v2 = insertPipeline(db, { typeId: type.id, definition });

  expect(v2.version).toBe(2);
  expect(getActivePipeline(db, type.id)?.id).toBe(v1.id);

  activatePipeline(db, v2.id);

  expect(getActivePipeline(db, type.id)?.id).toBe(v2.id);
  expect(getPipeline(db, v1.id)?.status).toBe("superseded");
  expect(listPipelines(db, type.id)).toHaveLength(2);
});
