import type { Database } from "bun:sqlite";
import type { NewPipeline, Pipeline } from "../domain/pipeline";
import { PipelineDefinitionSchema } from "../domain/pipeline";

interface Row {
  id: string;
  type_id: string;
  version: number;
  status: string;
  definition: string;
  created_at: string;
}

function toPipeline(row: Row): Pipeline {
  return {
    id: row.id,
    typeId: row.type_id,
    version: row.version,
    status: row.status as Pipeline["status"],
    definition: PipelineDefinitionSchema.parse(JSON.parse(row.definition)),
    createdAt: row.created_at,
  };
}

export function insertPipeline(db: Database, input: NewPipeline): Pipeline {
  const id = crypto.randomUUID();
  const row = db
    .query("SELECT COALESCE(MAX(version), 0) AS v FROM pipelines WHERE type_id = ?")
    .get(input.typeId) as { v: number };
  db.query(
    `INSERT INTO pipelines (id, type_id, version, status, definition, created_at)
     VALUES (?, ?, ?, 'draft', ?, ?)`,
  ).run(id, input.typeId, row.v + 1, JSON.stringify(input.definition), new Date().toISOString());
  const pipeline = getPipeline(db, id);
  if (!pipeline) throw new Error(`insertPipeline: pipeline ${id} vanished`);
  return pipeline;
}

export function getPipeline(db: Database, id: string): Pipeline | null {
  const row = db.query("SELECT * FROM pipelines WHERE id = ?").get(id) as Row | null;
  return row ? toPipeline(row) : null;
}

export function getActivePipeline(db: Database, typeId: string): Pipeline | null {
  const row = db
    .query("SELECT * FROM pipelines WHERE type_id = ? AND status = 'active'")
    .get(typeId) as Row | null;
  return row ? toPipeline(row) : null;
}

export function listPipelines(db: Database, typeId: string): Pipeline[] {
  const rows = db
    .query("SELECT * FROM pipelines WHERE type_id = ? ORDER BY version")
    .all(typeId) as Row[];
  return rows.map(toPipeline);
}

export function activatePipeline(db: Database, id: string): Pipeline {
  const pipeline = getPipeline(db, id);
  if (!pipeline) throw new Error(`activatePipeline: unknown pipeline ${id}`);
  db.transaction(() => {
    db.query(
      "UPDATE pipelines SET status = 'superseded' WHERE type_id = ? AND status = 'active'",
    ).run(pipeline.typeId);
    db.query("UPDATE pipelines SET status = 'active' WHERE id = ?").run(id);
  })();
  return { ...pipeline, status: "active" };
}
