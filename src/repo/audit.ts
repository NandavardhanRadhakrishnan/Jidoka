import type { Database } from "bun:sqlite";
import type { AuditEntry, NewAuditEntry } from "../domain/audit";

interface Row {
  id: string;
  at: string;
  kind: string;
  actor: string;
  task_id: string | null;
  type_id: string | null;
  rule_id: string | null;
  data: string;
}

function toEntry(row: Row): AuditEntry {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind as AuditEntry["kind"],
    actor: row.actor as AuditEntry["actor"],
    taskId: row.task_id,
    typeId: row.type_id,
    ruleId: row.rule_id,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

/** Append-only: entries are never updated, only purged by retention. No
 *  foreign keys on purpose — the trail must outlive a merged-away task. */
export function recordAudit(db: Database, input: NewAuditEntry): void {
  db.query(
    `INSERT INTO audit_log (id, at, kind, actor, task_id, type_id, rule_id, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    input.at ?? new Date().toISOString(),
    input.kind,
    input.actor,
    input.taskId ?? null,
    input.typeId ?? null,
    input.ruleId ?? null,
    JSON.stringify(input.data),
  );
}

export function listAudit(db: Database, filter: { taskId?: string; limit?: number } = {}): AuditEntry[] {
  const limit = filter.limit ?? 500;
  const rows = filter.taskId
    ? (db
        .query("SELECT * FROM audit_log WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT ?")
        .all(filter.taskId, limit) as Row[])
    : (db.query("SELECT * FROM audit_log ORDER BY at DESC, rowid DESC LIMIT ?").all(limit) as Row[]);
  return rows.map(toEntry);
}

export function purgeAuditOlderThan(db: Database, cutoffIso: string): number {
  return db.query("DELETE FROM audit_log WHERE at < ?").run(cutoffIso).changes;
}

/** Applies the retention setting: 0 (the default) keeps the trail forever. */
export function purgeExpiredAudit(db: Database, retentionDays: number, now: Date = new Date()): number {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  return purgeAuditOlderThan(db, cutoff.toISOString());
}
