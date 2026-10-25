import type { Database } from "bun:sqlite";

interface Row {
  id: string;
  source_id: string;
  kind: string;
  since: string | null;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
  error: string | null;
  seen: number;
  new: number;
  changed: number;
  failed: number;
  unkeyed_failures: string;
}

export type PollKind = "poll" | "retry" | "rescan";

export interface PollRecord {
  id: string;
  sourceId: string;
  kind: PollKind;
  since: string | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: "ok" | "error" | null;
  error: string | null;
  seen: number;
  new: number;
  changed: number;
  failed: number;
  unkeyedFailures: { key?: string; error: string }[];
}

export interface PollResult {
  outcome: "ok" | "error";
  error?: string;
  seen: number;
  new: number;
  changed: number;
  failed: number;
  unkeyedFailures: { key?: string; error: string }[];
}

const FIRST_POLL_MS = 7 * 86_400_000;
const OVERLAP_MS = 5 * 60 * 1000;

function toRecord(row: Row): PollRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    kind: row.kind as PollKind,
    since: row.since,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome as PollRecord["outcome"],
    error: row.error,
    seen: row.seen,
    new: row.new,
    changed: row.changed,
    failed: row.failed,
    unkeyedFailures: JSON.parse(row.unkeyed_failures) as PollRecord["unkeyedFailures"],
  };
}

function getPoll(db: Database, id: string): PollRecord {
  return toRecord(db.query("SELECT * FROM source_polls WHERE id = ?").get(id) as Row);
}

export function startPoll(db: Database, sourceId: string, kind: PollKind, since: string | null): PollRecord {
  const id = crypto.randomUUID();
  db.query("INSERT INTO source_polls (id, source_id, kind, since, started_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    sourceId,
    kind,
    since,
    new Date().toISOString(),
  );
  return getPoll(db, id);
}

export function finishPoll(db: Database, id: string, result: PollResult): PollRecord {
  db.query(
    `UPDATE source_polls SET finished_at = ?, outcome = ?, error = ?, seen = ?, new = ?, changed = ?,
                             failed = ?, unkeyed_failures = ? WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    result.outcome,
    result.error ?? null,
    result.seen,
    result.new,
    result.changed,
    result.failed,
    JSON.stringify(result.unkeyedFailures),
    id,
  );
  return getPoll(db, id);
}

export function listPolls(db: Database, sourceId: string, limit = 50): PollRecord[] {
  const rows = db
    .query("SELECT * FROM source_polls WHERE source_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?")
    .all(sourceId, limit) as Row[];
  return rows.map(toRecord);
}

export function lastPoll(db: Database, sourceId: string): PollRecord | null {
  const row = db
    .query(
      "SELECT * FROM source_polls WHERE source_id = ? AND kind = 'poll' ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(sourceId) as Row | null;
  return row ? toRecord(row) : null;
}

export function getHorizon(db: Database, sourceId: string): string | null {
  const row = db.query("SELECT horizon FROM source_horizons WHERE source_id = ?").get(sourceId) as {
    horizon: string;
  } | null;
  return row?.horizon ?? null;
}

export function setHorizon(db: Database, sourceId: string, horizon: string): void {
  db.query(
    "INSERT INTO source_horizons (source_id, horizon) VALUES (?, ?) ON CONFLICT (source_id) DO UPDATE SET horizon = excluded.horizon",
  ).run(sourceId, horizon);
}

/** The window the next regular poll lists from. On a source's first poll this
 *  does not record the horizon; the poller does. */
export function nextWindow(db: Database, sourceId: string, now: Date): { since: string; isFirst: boolean } {
  const horizon = getHorizon(db, sourceId);
  if (!horizon) {
    return { since: new Date(now.getTime() - FIRST_POLL_MS).toISOString(), isFirst: true };
  }
  const row = db
    .query(
      `SELECT started_at FROM source_polls
        WHERE source_id = ? AND kind = 'poll' AND outcome = 'ok' AND started_at >= ?
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(sourceId, horizon) as { started_at: string } | null;
  if (!row) return { since: horizon, isFirst: false };
  return { since: new Date(new Date(row.started_at).getTime() - OVERLAP_MS).toISOString(), isFirst: false };
}

/** Drops a source poll history and horizon (used when its extension is deleted). */
export function deleteSourceHistory(db: Database, sourceId: string): void {
  db.query("DELETE FROM source_polls WHERE source_id = ?").run(sourceId);
  db.query("DELETE FROM source_horizons WHERE source_id = ?").run(sourceId);
}
