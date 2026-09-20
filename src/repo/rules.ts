import type { Database } from "bun:sqlite";
import type { NewRule, Rule } from "../domain/rule";
import { RuleDefinitionSchema } from "../domain/rule";

interface Row {
  id: string;
  type_id: string;
  version: number;
  status: string;
  definition: string;
  created_at: string;
}

function toRule(row: Row): Rule {
  return {
    id: row.id,
    typeId: row.type_id,
    version: row.version,
    status: row.status as Rule["status"],
    definition: RuleDefinitionSchema.parse(JSON.parse(row.definition)),
    createdAt: row.created_at,
  };
}

export function insertRule(db: Database, input: NewRule): Rule {
  const id = crypto.randomUUID();
  const row = db
    .query("SELECT COALESCE(MAX(version), 0) AS v FROM rules WHERE type_id = ?")
    .get(input.typeId) as { v: number };
  db.query(
    `INSERT INTO rules (id, type_id, version, status, definition, created_at)
     VALUES (?, ?, ?, 'draft', ?, ?)`,
  ).run(id, input.typeId, row.v + 1, JSON.stringify(input.definition), new Date().toISOString());
  const rule = getRule(db, id);
  if (!rule) throw new Error(`insertRule: rule ${id} vanished`);
  return rule;
}

export function getRule(db: Database, id: string): Rule | null {
  const row = db.query("SELECT * FROM rules WHERE id = ?").get(id) as Row | null;
  return row ? toRule(row) : null;
}

export function getActiveRule(db: Database, typeId: string): Rule | null {
  const row = db
    .query("SELECT * FROM rules WHERE type_id = ? AND status = 'active'")
    .get(typeId) as Row | null;
  return row ? toRule(row) : null;
}

export function listRules(db: Database, typeId: string): Rule[] {
  const rows = db
    .query("SELECT * FROM rules WHERE type_id = ? ORDER BY version")
    .all(typeId) as Row[];
  return rows.map(toRule);
}

export function activateRule(db: Database, id: string): Rule {
  const rule = getRule(db, id);
  if (!rule) throw new Error(`activateRule: unknown rule ${id}`);
  db.transaction(() => {
    db.query(
      "UPDATE rules SET status = 'superseded' WHERE type_id = ? AND status = 'active'",
    ).run(rule.typeId);
    db.query("UPDATE rules SET status = 'active' WHERE id = ?").run(id);
  })();
  return { ...rule, status: "active" };
}
