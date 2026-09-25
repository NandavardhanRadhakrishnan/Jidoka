import type { Database } from "bun:sqlite";
import type { Hint, NewHint } from "../domain/hint";

interface Row {
  id: string;
  rule_id: string;
  step_id: string;
  text: string;
  excerpt: string | null;
  created_at: string;
}

function toHint(row: Row): Hint {
  return {
    id: row.id,
    ruleId: row.rule_id,
    stepId: row.step_id,
    text: row.text,
    excerpt: row.excerpt,
    createdAt: row.created_at,
  };
}

export function insertHint(db: Database, input: NewHint): Hint {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.query(
    `INSERT INTO hints (id, rule_id, step_id, text, excerpt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.ruleId, input.stepId, input.text, input.excerpt ?? null, createdAt);
  const row = db.query("SELECT * FROM hints WHERE id = ?").get(id) as Row | null;
  if (!row) throw new Error(`insertHint: hint ${id} vanished`);
  return toHint(row);
}

export function listHintsForRule(db: Database, ruleId: string): Hint[] {
  const rows = db
    .query("SELECT * FROM hints WHERE rule_id = ? ORDER BY created_at")
    .all(ruleId) as Row[];
  return rows.map(toHint);
}

export function listHintsForStep(db: Database, ruleId: string, stepId: string): Hint[] {
  const rows = db
    .query("SELECT * FROM hints WHERE rule_id = ? AND step_id = ? ORDER BY created_at")
    .all(ruleId, stepId) as Row[];
  return rows.map(toHint);
}

export function deleteHint(db: Database, id: string): void {
  db.query("DELETE FROM hints WHERE id = ?").run(id);
}
