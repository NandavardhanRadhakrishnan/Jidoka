import type { Database } from "bun:sqlite";
import {
  ROSTER_MESSAGES as M,
  RosterConflictError,
  RosterNotFoundError,
  type Person,
  type ResolvedParticipant,
  type SourceParticipant,
} from "../domain/roster";
import { addIdentity, createPerson, getPerson, listOrgs, listPeople } from "./roster";
import { getTask } from "./tasks";

interface Row {
  id: string;
  identity: string | null;
  person_id: string | null;
  name: string | null;
  role: string;
  added_by: "source" | "human";
  created_at: string;
  resolved_person_id: string | null;
}

const now = () => new Date().toISOString();

function requireTask(db: Database, taskId: string): void {
  if (!getTask(db, taskId)) throw new RosterNotFoundError(`unknown task ${taskId}`);
}

/** Idempotent: a naive source that reports the same people every poll writes nothing new. */
export function upsertSourceParticipants(db: Database, taskId: string, participants: SourceParticipant[]): void {
  const insert = db.query(
    `INSERT OR IGNORE INTO task_participants (id, task_id, identity, person_id, name, role, added_by, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, 'source', ?)`,
  );
  for (const p of participants) insert.run(crypto.randomUUID(), taskId, p.identity, p.name ?? null, p.role, now());
}

/** Source rows resolve through their identity, hand-added rows through their person.
 *  Resolution happens here, at read time, so people added later resolve old tasks. */
export function listParticipants(db: Database, taskId: string): ResolvedParticipant[] {
  const rows = db
    .query(
      `SELECT tp.*, COALESCE(tp.person_id, pi.person_id) AS resolved_person_id
         FROM task_participants tp
         LEFT JOIN person_identities pi ON pi.identity = tp.identity
        WHERE tp.task_id = ?
        ORDER BY tp.added_by = 'human', tp.created_at, tp.rowid`,
    )
    .all(taskId) as Row[];
  if (!rows.length) return [];

  const people = new Map(listPeople(db).map((p) => [p.id, p]));
  const orgs = new Map(listOrgs(db).map((o) => [o.id, o]));
  return rows.map((row) => {
    const person = row.resolved_person_id ? (people.get(row.resolved_person_id) ?? null) : null;
    const org = person?.orgId ? (orgs.get(person.orgId) ?? null) : null;
    return {
      id: row.id,
      role: row.role as ResolvedParticipant["role"],
      addedBy: row.added_by,
      identity: row.identity,
      sourceName: row.name,
      person: person
        ? {
            id: person.id,
            displayName: person.displayName,
            isSelf: person.isSelf,
            identities: person.identities,
            org: org ? { id: org.id, name: org.name, isHome: org.isHome } : null,
          }
        : null,
    };
  });
}

/** Puts a roster person on a task by hand — unless a row on this task already
 *  resolves to them, so adding a source's unknown sender never duplicates them. */
export function tagPerson(db: Database, taskId: string, personId: string): void {
  requireTask(db, taskId);
  if (!getPerson(db, personId)) throw new RosterNotFoundError(`unknown person ${personId}`);
  if (listParticipants(db, taskId).some((p) => p.person?.id === personId)) return;
  db.query(
    `INSERT OR IGNORE INTO task_participants (id, task_id, identity, person_id, name, role, added_by, created_at)
     VALUES (?, ?, NULL, ?, NULL, 'added', 'human', ?)`,
  ).run(crypto.randomUUID(), taskId, personId, now());
}

/** "Add to roster" and "Create" in one step. A taken identity rolls the new person back. */
export function createAndTagPerson(
  db: Database,
  taskId: string,
  input: { name: string; identity?: string; orgId?: string | null },
): Person {
  requireTask(db, taskId);
  return db.transaction(() => {
    const created = createPerson(db, { name: input.name, orgId: input.orgId ?? null });
    const person = input.identity ? addIdentity(db, created.id, input.identity) : created;
    tagPerson(db, taskId, person.id);
    return person;
  })();
}

export function removeHumanParticipant(db: Database, taskId: string, participantId: string): void {
  const row = db
    .query("SELECT added_by FROM task_participants WHERE id = ? AND task_id = ?")
    .get(participantId, taskId) as { added_by: string } | null;
  if (!row) throw new RosterNotFoundError(`unknown participant ${participantId}`);
  if (row.added_by !== "human") throw new RosterConflictError(M.sourceParticipantRemove);
  db.query("DELETE FROM task_participants WHERE id = ?").run(participantId);
}

/** For a task merge: the duplicate is about to be deleted, which would cascade its rows away. */
export function moveParticipants(db: Database, fromTaskId: string, toTaskId: string): void {
  const rows = db
    .query(
      "SELECT identity, person_id, name, role, added_by, created_at FROM task_participants WHERE task_id = ? ORDER BY rowid",
    )
    .all(fromTaskId) as Omit<Row, "id" | "resolved_person_id">[];
  const insert = db.query(
    `INSERT OR IGNORE INTO task_participants (id, task_id, identity, person_id, name, role, added_by, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, 'source', ?)`,
  );
  for (const row of rows) {
    if (row.added_by === "human" && row.person_id) tagPerson(db, toTaskId, row.person_id);
    else if (row.identity) insert.run(crypto.randomUUID(), toTaskId, row.identity, row.name, row.role, row.created_at);
  }
}
